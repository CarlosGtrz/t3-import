import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalConversation, SourceAdapter, TargetPaths } from "../src/core/types.js";
import { importConversations } from "../src/target/importer.js";
import { syncAllLinkedConversations } from "../src/target/syncAll.js";
import { canonicalConversation, canonicalThread, createTarget, eventCount } from "./helpers.js";

let originalLedger: string | undefined;
beforeEach(() => { originalLedger = process.env.T3_IMPORT_DATA_DIR; });
afterEach(() => {
  if (originalLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedger;
});

function caughtUp(paths: TargetPaths): void {
  const db = new Database(paths.dbPath);
  const last = db.prepare("SELECT MAX(sequence) value FROM orchestration_events").get() as { value: number };
  db.prepare("INSERT INTO projection_state (projector,last_applied_sequence,updated_at) VALUES ('test',?,'2026-01-01') ON CONFLICT(projector) DO UPDATE SET last_applied_sequence=excluded.last_applied_sequence").run(last.value);
  db.close();
}

function adapter(conversations: CanonicalConversation[]): SourceAdapter & { load: ReturnType<typeof vi.fn> } {
  return {
    name: "codex", discover: async () => conversations.map((item) => item.summary),
    load: vi.fn(async (summary) => conversations.find((item) => item.summary.id === summary.id)!),
  };
}

describe("synchronization across all linked workspaces", () => {
  it("updates safe histories, preserves conflicts, reports missing rollouts, and ignores unrelated sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-sync-all-"));
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createTarget(join(root, "t3"), 54);
    const conversations = Array.from({ length: 5 }, (_, index) => {
      const workspace = join(root, `workspace-${index}`);
      mkdirSync(workspace);
      const thread = canonicalThread(workspace);
      thread.sourceSessionId = `${index + 1}1111111-1111-4111-8111-111111111111`;
      thread.sourceKey = `codex:${thread.sourceSessionId}`;
      thread.resumeCursor = { threadId: thread.sourceSessionId };
      thread.title = `Conversation ${index}`;
      return canonicalConversation(workspace, thread);
    });
    await importConversations(conversations.slice(0, 4).map((conversation) => ({ conversation, resume: true })), paths, { dryRun: false, resume: true });
    caughtUp(paths);
    const turn = structuredClone(conversations[0]!.threads[0]!.turns[0]!);
    turn.id = "additional-turn";
    turn.user.text = "New prompt";
    conversations[0]!.threads[0]!.turns.push(turn);
    conversations[1]!.threads[0]!.turns[0]!.user.text = "Edited old prompt";
    const source = adapter([conversations[0]!, conversations[1]!, conversations[2]!, conversations[4]!]);
    const before = eventCount(paths.dbPath);
    const preview = await syncAllLinkedConversations(source, paths, { dryRun: true });
    expect(eventCount(paths.dbPath)).toBe(before);
    expect(preview.results).toHaveLength(4);
    expect(source.load.mock.calls.map(([summary]) => summary.id)).not.toContain(conversations[4]!.summary.id);
    expect(preview.results.find((item) => item.sourceId === conversations[3]!.summary.id)?.status).toBe("not-imported");
    const first = await syncAllLinkedConversations(source, paths, { dryRun: false });
    expect(first.status).toBe("mixed");
    expect(first.backup).not.toBeNull();
    expect(first.results.map((item) => item.status)).toEqual(expect.arrayContaining(["synced", "history-diverged", "up-to-date", "not-imported"]));
    expect(first.results.find((item) => item.sourceId === conversations[0]!.summary.id)?.turnsAdded).toBe(1);
    const after = eventCount(paths.dbPath);
    expect(after).toBeGreaterThan(before);
    caughtUp(paths);
    const second = await syncAllLinkedConversations(source, paths, { dryRun: false });
    expect(second.results.every((item) => item.turnsAdded === 0)).toBe(true);
    expect(second.backup).toBeNull();
    expect(eventCount(paths.dbPath)).toBe(after);
  });
});
