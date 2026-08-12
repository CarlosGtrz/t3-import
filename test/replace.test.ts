import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalTurn, TargetPaths } from "../src/core/types.js";
import { importConversations } from "../src/target/importer.js";
import { inspectConversationReplacement, replaceConversations, replacementThreadId } from "../src/target/replace.js";
import { inspectConversationSync, syncConversations } from "../src/target/sync.js";
import { canonicalConversation, canonicalThread, createMigration40Target, eventCount } from "./helpers.js";

let originalLedgerDir: string | undefined;

beforeEach(() => { originalLedgerDir = process.env.T3_IMPORT_DATA_DIR; });
afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

function caughtUp(paths: TargetPaths): void {
  const db = new Database(paths.dbPath);
  const last = (db.prepare("SELECT COALESCE(MAX(sequence), 0) value FROM orchestration_events").get() as { value: number }).value;
  db.prepare("INSERT INTO projection_state (projector, last_applied_sequence) VALUES ('test', ?) ON CONFLICT(projector) DO UPDATE SET last_applied_sequence=excluded.last_applied_sequence").run(last);
  db.close();
}

function nextTurn(): CanonicalTurn {
  return {
    id: "turn-2", startedAt: "2026-01-02T00:00:00.000Z", completedAt: "2026-01-02T00:00:03.000Z", status: "completed",
    user: { sourceId: "user-2", role: "user", text: "Continue", timestamp: "2026-01-02T00:00:00.000Z", attachments: [] },
    assistant: [{ sourceId: "assistant-2", role: "assistant", text: "Done", timestamp: "2026-01-02T00:00:02.000Z", attachments: [] }],
    activities: [], plans: [],
  };
}

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
  const paths = createMigration40Target(join(root, "t3"));
  const conversation = canonicalConversation(workspace);
  await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  caughtUp(paths);
  return { root, workspace, paths, conversation };
}

describe("canonical task replacement", () => {
  it("creates a complete canonical task, deletes the old stream, and transfers resume state", async () => {
    const { root, paths, conversation } = await fixture("t3-replace-");
    conversation.threads[0]!.title = "Latest provider title";
    conversation.summary.title = "Latest provider title";
    conversation.threads[0]!.turns.push(nextTurn());
    conversation.fingerprint = "replacement-fingerprint";
    const oldThreadId = conversation.threads[0]!.sourceSessionId;
    const expectedNew = replacementThreadId(conversation.threads[0]!.sourceKey, oldThreadId);
    const before = eventCount(paths.dbPath);

    const preview = await inspectConversationReplacement(conversation, paths);
    expect(preview).toMatchObject({ status: "replaceable", selectable: true, oldThreadId, newThreadId: expectedNew, turns: 2 });
    const result = await replaceConversations([{ conversation }], paths, { dryRun: false });
    expect(result.status).toBe("replaced");
    expect(result.backup).not.toBeNull();
    expect(result.results[0]).toMatchObject({ status: "replaced", oldThreadId, newThreadId: expectedNew, turns: 2, resumeTransferred: true });
    expect(eventCount(paths.dbPath)).toBe(before + result.results[0]!.events);

    const db = new Database(paths.dbPath, { readonly: true });
    const deleted = db.prepare("SELECT payload_json payload FROM orchestration_events WHERE stream_id=? AND event_type='thread.deleted'").get(oldThreadId) as { payload: string };
    expect(JSON.parse(deleted.payload)).toMatchObject({ threadId: oldThreadId });
    const created = db.prepare("SELECT payload_json payload, metadata_json metadata FROM orchestration_events WHERE stream_id=? AND event_type='thread.created'").get(expectedNew) as { payload: string; metadata: string };
    expect(JSON.parse(created.payload)).toMatchObject({ title: "Latest provider title", projectId: result.results[0]!.projectId });
    expect(JSON.parse(created.metadata).t3Import).toMatchObject({ canonical: true, replacesThreadId: oldThreadId, sourceSessionId: oldThreadId });
    const runtimes = db.prepare("SELECT thread_id threadId, resume_cursor_json cursor FROM provider_session_runtime").all() as Array<{ threadId: string; cursor: string }>;
    expect(runtimes).toEqual([{ threadId: expectedNew, cursor: JSON.stringify({ threadId: oldThreadId }) }]);
    db.close();

    const ledger = new Database(join(root, "ledger", "ledger.sqlite"), { readonly: true });
    const records = ledger.prepare("SELECT thread_id threadId, is_canonical canonical, superseded_by_thread_id supersededBy FROM imports ORDER BY imported_at").all();
    expect(records).toEqual([
      { threadId: oldThreadId, canonical: 0, supersededBy: expectedNew },
      { threadId: expectedNew, canonical: 1, supersededBy: null },
    ]);
    ledger.close();
  });

  it("is a no-op when the canonical replacement already contains the complete source", async () => {
    const { paths, conversation } = await fixture("t3-replace-repeat-");
    await replaceConversations([{ conversation }], paths, { dryRun: false });
    caughtUp(paths);
    const before = eventCount(paths.dbPath);
    const repeated = await replaceConversations([{ conversation }], paths, { dryRun: false });
    expect(repeated).toMatchObject({ status: "already-current", backup: null, hasConflicts: false });
    expect(repeated.results[0]!.status).toBe("already-current");
    expect(eventCount(paths.dbPath)).toBe(before);
  });

  it("creates a deterministic second replacement after provider history legitimately changes", async () => {
    const { paths, conversation } = await fixture("t3-replace-again-");
    const first = await replaceConversations([{ conversation }], paths, { dryRun: false });
    caughtUp(paths);
    const firstReplacement = first.results[0]!.newThreadId!;
    conversation.threads[0]!.turns.push(nextTurn());
    conversation.fingerprint = "changed-after-first-replacement";
    const second = await replaceConversations([{ conversation }], paths, { dryRun: false });
    expect(second.results[0]).toMatchObject({ status: "replaced", oldThreadId: firstReplacement });
    expect(second.results[0]!.newThreadId).toBe(replacementThreadId(conversation.threads[0]!.sourceKey, firstReplacement));
  });

  it("recovers replacement identity from event metadata when the external ledger is missing", async () => {
    const { root, paths, conversation } = await fixture("t3-replace-recover-");
    await replaceConversations([{ conversation }], paths, { dryRun: false });
    caughtUp(paths);
    process.env.T3_IMPORT_DATA_DIR = join(root, "fresh-ledger");
    const result = await replaceConversations([{ conversation }], paths, { dryRun: false });
    expect(result.results[0]!.status).toBe("already-current");
  });

  it("rejects active Codex sources and branched Claude sources without writes", async () => {
    const activeFixture = await fixture("t3-replace-active-");
    const active = nextTurn();
    active.status = "inProgress";
    delete active.completedAt;
    activeFixture.conversation.threads[0]!.turns.push(active);
    const before = eventCount(activeFixture.paths.dbPath);
    const activeResult = await replaceConversations([{ conversation: activeFixture.conversation }], activeFixture.paths, { dryRun: false });
    expect(activeResult.results[0]!.status).toBe("active-source");
    expect(activeResult.hasConflicts).toBe(true);
    expect(eventCount(activeFixture.paths.dbPath)).toBe(before);

    const root = await mkdtemp(join(tmpdir(), "t3-replace-claude-real-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createMigration40Target(join(root, "t3"));
    const thread = canonicalThread(workspace);
    thread.source = "claude"; thread.sourceSessionId = "claude-session";
    thread.sourceKey = "claude:claude-session:leaf-1"; thread.leafId = "leaf-1";
    thread.resumeCursor = { resume: "claude-session", resumeSessionAt: "leaf-1", turnCount: 1 };
    const branched = canonicalConversation(workspace, thread);
    branched.summary.source = "claude"; branched.summary.id = "claude-session"; branched.summary.branches = 2;
    await importConversations([{ conversation: branched, resume: true }], paths, { dryRun: false, resume: true });
    caughtUp(paths);
    const branchResult = await replaceConversations([{ conversation: branched }], paths, { dryRun: false });
    expect(branchResult.results[0]!.status).toBe("branch-replace-unsupported");
  });

  it("supports incremental synchronization after replacement", async () => {
    const { workspace, paths, conversation } = await fixture("t3-replace-sync-");
    await replaceConversations([{ conversation }], paths, { dryRun: false });
    caughtUp(paths);
    const advanced = canonicalConversation(workspace);
    advanced.threads[0]!.turns.push(nextTurn());
    advanced.fingerprint = "advanced-after-replacement";
    const preview = await inspectConversationSync(advanced, paths);
    expect(preview).toMatchObject({ status: "syncable", newTurns: 1, previouslyImported: true });
    const synced = await syncConversations([{ conversation: advanced }], paths, { dryRun: false });
    expect(synced.results[0]).toMatchObject({ status: "synced", turnsAdded: 1 });
  });

  it("does not change T3 when replacement attachment staging fails", async () => {
    const { root, paths, conversation } = await fixture("t3-replace-rollback-");
    conversation.threads[0]!.turns[0]!.user.attachments.push({
      sourceId: "missing-replacement-image", name: "missing.png", mimeType: "image/png", sizeBytes: 12,
      path: join(root, "missing.png"),
    });
    const before = eventCount(paths.dbPath);
    await expect(replaceConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 6 });
    expect(eventCount(paths.dbPath)).toBe(before);
    const db = new Database(paths.dbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) count FROM orchestration_events WHERE event_type='thread.deleted'").get() as { count: number }).count).toBe(0);
    db.close();
  });
});
