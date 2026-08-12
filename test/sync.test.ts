import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalConversation, CanonicalThread, CanonicalTurn, TargetPaths } from "../src/core/types.js";
import { importConversations } from "../src/target/importer.js";
import { inspectConversationSync, syncConversations } from "../src/target/sync.js";
import { canonicalConversation, canonicalThread, createMigration40Target, eventCount } from "./helpers.js";
import { legacyTurnSemanticHash } from "../src/core/checkpoint.js";

let originalLedgerDir: string | undefined;

beforeEach(() => { originalLedgerDir = process.env.T3_IMPORT_DATA_DIR; });
afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

function secondTurn(): CanonicalTurn {
  return {
    id: "turn-2",
    startedAt: "2026-01-02T00:00:00.000Z",
    completedAt: "2026-01-02T00:00:03.000Z",
    status: "completed",
    user: { sourceId: "user-2", role: "user", text: "Continue", timestamp: "2026-01-02T00:00:00.000Z", attachments: [] },
    assistant: [{ sourceId: "assistant-2", role: "assistant", text: "Done", timestamp: "2026-01-02T00:00:02.000Z", attachments: [] }],
    activities: [],
    plans: [],
  };
}

function caughtUp(paths: TargetPaths): void {
  const db = new Database(paths.dbPath);
  const last = (db.prepare("SELECT COALESCE(MAX(sequence), 0) value FROM orchestration_events").get() as { value: number }).value;
  db.prepare("INSERT INTO projection_state (projector, last_applied_sequence) VALUES ('test', ?) ON CONFLICT(projector) DO UPDATE SET last_applied_sequence=excluded.last_applied_sequence").run(last);
  db.close();
}

async function importedFixture(prefix: string): Promise<{ root: string; workspace: string; paths: TargetPaths; conversation: CanonicalConversation }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
  const paths = createMigration40Target(join(root, "t3"));
  const conversation = canonicalConversation(workspace);
  await importConversations([{ conversation, duplicate: false, resume: true }], paths, { dryRun: false, duplicate: false, resume: true });
  caughtUp(paths);
  return { root, workspace, paths, conversation };
}

function advancedConversation(workspace: string, sourceThread = canonicalThread(workspace)): CanonicalConversation {
  sourceThread.turns.push(secondTurn());
  sourceThread.updatedAt = "2026-01-02T00:00:03.000Z";
  const conversation = canonicalConversation(workspace, sourceThread);
  conversation.summary.updatedAt = sourceThread.updatedAt;
  conversation.fingerprint = "fixture-fingerprint-2";
  return conversation;
}

describe("incremental synchronization", () => {
  it("appends a Codex suffix and a repeated sync is a no-op", async () => {
    const { workspace, paths } = await importedFixture("t3-sync-codex-");
    const conversation = advancedConversation(workspace);
    const before = eventCount(paths.dbPath);

    const preview = await inspectConversationSync(conversation, paths);
    expect(preview).toMatchObject({ status: "syncable", newTurns: 1, adoptedTurns: 0, selectable: true, previouslyImported: true });

    const first = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(first.status).toBe("synced");
    expect(first.results[0]).toMatchObject({ status: "synced", turnsAdded: 1, turnsAdopted: 0 });
    expect(first.results[0]!.events).toBeGreaterThan(0);
    expect(eventCount(paths.dbPath)).toBe(before + first.results[0]!.events);

    caughtUp(paths);
    const second = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(second.status).toBe("up-to-date");
    expect(second.backup).toBeNull();
    expect(second.results[0]).toMatchObject({ status: "up-to-date", turnsAdded: 0, events: 0 });
  });

  it("rejects changed imported history without modifying T3", async () => {
    const { workspace, paths } = await importedFixture("t3-sync-diverged-");
    const thread = canonicalThread(workspace);
    thread.turns[0]!.user.text = "Edited old prompt";
    thread.turns.push(secondTurn());
    const conversation = canonicalConversation(workspace, thread);
    const before = eventCount(paths.dbPath);

    const result = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(result.hasConflicts).toBe(true);
    expect(result.results[0]!.status).toBe("history-diverged");
    expect(result.backup).toBeNull();
    expect(eventCount(paths.dbPath)).toBe(before);
  });

  it("syncs safe items in a batch while reporting every conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-sync-mixed-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createMigration40Target(join(root, "t3"));
    const first = canonicalThread(workspace);
    const second = structuredClone(first);
    second.sourceSessionId = "22222222-2222-4222-8222-222222222222";
    second.sourceKey = `codex:${second.sourceSessionId}`;
    second.resumeCursor = { threadId: second.sourceSessionId };
    second.title = "Second fixture";
    second.turns[0]!.id = "second-turn-1";
    second.turns[0]!.user.sourceId = "second-user-1";
    second.turns[0]!.assistant[0]!.sourceId = "second-assistant-1";
    await importConversations([
      { conversation: canonicalConversation(workspace, first), duplicate: false, resume: true },
      { conversation: canonicalConversation(workspace, second), duplicate: false, resume: true },
    ], paths, { dryRun: false, duplicate: false, resume: true });
    caughtUp(paths);

    const safe = advancedConversation(workspace, structuredClone(first));
    const divergedThread = structuredClone(second);
    divergedThread.turns[0]!.user.text = "Changed history";
    const diverged = canonicalConversation(workspace, divergedThread);
    const result = await syncConversations([{ conversation: safe }, { conversation: diverged }], paths, { dryRun: false });

    expect(result.status).toBe("mixed");
    expect(result.hasConflicts).toBe(true);
    expect(result.results.map((item) => item.status)).toEqual(["synced", "history-diverged"]);
  });

  it("ignores an incomplete final turn until it is completed", async () => {
    const { workspace, paths } = await importedFixture("t3-sync-incomplete-");
    const thread = canonicalThread(workspace);
    const incomplete = secondTurn();
    incomplete.status = "inProgress";
    delete incomplete.completedAt;
    thread.turns.push(incomplete);
    const conversation = canonicalConversation(workspace, thread);

    const result = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(result.results[0]).toMatchObject({ status: "up-to-date", turnsAdded: 0, events: 0 });
    expect(result.backup).toBeNull();
  });

  it("appends interrupted and failed terminal turns and then becomes a no-op", async () => {
    const { workspace, paths } = await importedFixture("t3-sync-terminal-");
    const thread = canonicalThread(workspace);
    const interrupted = secondTurn();
    interrupted.status = "interrupted";
    interrupted.terminalReason = "interrupted";
    const failed = structuredClone(secondTurn());
    failed.id = "turn-3";
    failed.user.sourceId = "user-3";
    failed.assistant[0]!.sourceId = "assistant-3";
    failed.status = "failed";
    failed.terminalError = "provider failed";
    thread.turns.push(interrupted, failed);
    const conversation = canonicalConversation(workspace, thread);

    const preview = await inspectConversationSync(conversation, paths);
    expect(preview).toMatchObject({ status: "syncable", newTurns: 2, newInterruptedTurns: 1, newFailedTurns: 1 });
    const result = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(result.results[0]).toMatchObject({ status: "synced", turnsAdded: 2 });
    const db = new Database(paths.dbPath, { readonly: true });
    const sessions = db.prepare("SELECT payload_json payload FROM orchestration_events WHERE stream_id=? AND event_type='thread.session-set' ORDER BY sequence DESC LIMIT 4").all(thread.sourceSessionId) as Array<{ payload: string }>;
    const settled = sessions.map((row) => JSON.parse(row.payload).session).filter((session) => session.activeTurnId === null);
    expect(settled.map((session) => session.status)).toEqual(["error", "interrupted"]);
    db.close();
    caughtUp(paths);
    const repeat = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(repeat.results[0]).toMatchObject({ status: "up-to-date", turnsAdded: 0 });
  });

  it("validates a version-1 completed-turn checkpoint and upgrades it to version 2", async () => {
    const { root, workspace, paths } = await importedFixture("t3-sync-v1-");
    const original = canonicalThread(workspace);
    const v1 = { version: 1, turns: [{ id: original.turns[0]!.id, hash: legacyTurnSemanticHash(original.turns[0]!) }] };
    const ledger = new Database(join(root, "ledger", "ledger.sqlite"));
    ledger.prepare("UPDATE imports SET checkpoint_version=1, checkpoint_json=?").run(JSON.stringify(v1));
    ledger.close();
    const thread = canonicalThread(workspace);
    const next = secondTurn();
    next.status = "interrupted";
    next.terminalReason = "review_ended";
    thread.turns.push(next);
    const result = await syncConversations([{ conversation: canonicalConversation(workspace, thread) }], paths, { dryRun: false });
    expect(result.results[0]).toMatchObject({ status: "synced", turnsAdded: 1 });
    const upgraded = new Database(join(root, "ledger", "ledger.sqlite"), { readonly: true });
    const row = upgraded.prepare("SELECT checkpoint_version version, checkpoint_json checkpoint FROM imports").get() as { version: number; checkpoint: string };
    expect(row.version).toBe(2);
    expect(JSON.parse(row.checkpoint).turns.at(-1)).toMatchObject({ status: "interrupted", terminalReason: "review_ended" });
    upgraded.close();
  });

  it("treats a stale ledger target as new in the TUI but conflicts in sync", async () => {
    const { workspace, paths } = await importedFixture("t3-sync-stale-");
    const conversation = advancedConversation(workspace);
    const db = new Database(paths.dbPath);
    db.prepare("DELETE FROM orchestration_events WHERE aggregate_kind = 'thread'").run();
    db.prepare("UPDATE projection_state SET last_applied_sequence = (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)").run();
    db.close();

    const preview = await inspectConversationSync(conversation, paths);
    expect(preview).toMatchObject({ status: "new", selectable: true, previouslyImported: true });
    const result = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(result.results[0]!.status).toBe("not-imported");
    expect(result.hasConflicts).toBe(true);
  });

  it("bootstraps a legacy 0.1 checkpoint from deterministic events", async () => {
    const { root, workspace, paths } = await importedFixture("t3-sync-legacy-");
    const ledger = new Database(join(root, "ledger", "ledger.sqlite"));
    ledger.prepare("UPDATE imports SET checkpoint_json = NULL, checkpoint_version = NULL, identity_seed = NULL, source_title = NULL").run();
    ledger.close();

    const conversation = advancedConversation(workspace);
    const result = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(result.results[0]).toMatchObject({ status: "synced", turnsAdded: 1 });
  });

  it("recovers from a missing external ledger using the canonical import marker", async () => {
    const { root, workspace, paths } = await importedFixture("t3-sync-ledgerless-");
    process.env.T3_IMPORT_DATA_DIR = join(root, "empty-ledger");
    const conversation = advancedConversation(workspace);

    const result = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(result.results[0]).toMatchObject({ status: "synced", turnsAdded: 1 });
  });

  it("adopts an exact Codex provider turn already written through T3", async () => {
    const { workspace, paths } = await importedFixture("t3-sync-adopt-");
    const conversation = advancedConversation(workspace);
    const db = new Database(paths.dbPath);
    const threadId = conversation.threads[0]!.sourceSessionId;
    const version = (db.prepare("SELECT MAX(stream_version) value FROM orchestration_events WHERE stream_id = ?").get(threadId) as { value: number }).value + 1;
    db.prepare(`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (?, 'thread', ?, ?, 'thread.session-set', ?, 'provider', ?, ?)`)
      .run("native-provider-turn-2", threadId, version, secondTurn().completedAt, JSON.stringify({ threadId, session: { status: "ready" } }), JSON.stringify({ providerTurnId: "turn-2" }));
    db.close();
    caughtUp(paths);

    const result = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(result.results[0]).toMatchObject({ status: "synced", turnsAdded: 0, turnsAdopted: 1, events: 0 });
    expect(result.backup).not.toBeNull();
  });

  it("syncs a linear Claude lineage and rejects a later branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-sync-claude-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createMigration40Target(join(root, "t3"));
    const initial = canonicalThread(workspace) as CanonicalThread;
    initial.source = "claude";
    initial.sourceSessionId = "claude-session";
    initial.sourceKey = "claude:claude-session:leaf-1";
    initial.leafId = "leaf-1";
    initial.resumeCursor = { resume: "claude-session", resumeSessionAt: "leaf-1", turnCount: 1 };
    const original = canonicalConversation(workspace, initial);
    original.summary.source = "claude";
    original.summary.id = "claude-session";
    await importConversations([{ conversation: original, duplicate: false, resume: true }], paths, { dryRun: false, duplicate: false, resume: true });
    caughtUp(paths);

    const advanced = structuredClone(initial);
    advanced.turns.push(secondTurn());
    advanced.sourceKey = "claude:claude-session:leaf-2";
    advanced.leafId = "leaf-2";
    advanced.resumeCursor = { resume: "claude-session", resumeSessionAt: "leaf-2", turnCount: 2 };
    const linear = canonicalConversation(workspace, advanced);
    linear.summary.source = "claude";
    linear.summary.id = "claude-session";
    linear.fingerprint = "claude-fingerprint-2";
    const synced = await syncConversations([{ conversation: linear }], paths, { dryRun: false });
    expect(synced.results[0]).toMatchObject({ status: "synced", turnsAdded: 1 });

    caughtUp(paths);
    const branched = structuredClone(linear);
    branched.summary.branches = 2;
    const conflict = await syncConversations([{ conversation: branched }], paths, { dryRun: false });
    expect(conflict.hasConflicts).toBe(true);
    expect(conflict.results[0]!.status).toBe("branch-sync-unsupported");
  });

  it("never selects a duplicate Claude transcript as a synchronization target", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-sync-claude-duplicate-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createMigration40Target(join(root, "t3"));
    const thread = canonicalThread(workspace);
    thread.source = "claude";
    thread.sourceSessionId = "claude-duplicate-session";
    thread.sourceKey = "claude:claude-duplicate-session:leaf-1";
    thread.leafId = "leaf-1";
    thread.resumeCursor = { resume: thread.sourceSessionId, resumeSessionAt: "leaf-1", turnCount: 1 };
    const conversation = canonicalConversation(workspace, thread);
    conversation.summary.source = "claude";
    conversation.summary.id = thread.sourceSessionId;
    await importConversations([{ conversation, duplicate: true, resume: false }], paths, { dryRun: false, duplicate: true, resume: false });
    caughtUp(paths);

    const result = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(result.results[0]!.status).toBe("not-imported");
  });

  it("updates an untouched title and preserves a local T3 rename", async () => {
    const { workspace, paths } = await importedFixture("t3-sync-title-");
    const providerRenamed = canonicalConversation(workspace);
    providerRenamed.threads[0]!.title = "Provider title";
    providerRenamed.summary.title = "Provider title";
    const updated = await syncConversations([{ conversation: providerRenamed }], paths, { dryRun: false });
    expect(updated.results[0]).toMatchObject({ status: "synced", titleAction: "updated", turnsAdded: 0 });

    caughtUp(paths);
    const db = new Database(paths.dbPath);
    const threadId = providerRenamed.threads[0]!.sourceSessionId;
    const version = (db.prepare("SELECT MAX(stream_version) value FROM orchestration_events WHERE stream_id = ?").get(threadId) as { value: number }).value + 1;
    db.prepare(`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (?, 'thread', ?, ?, 'thread.meta-updated', ?, 'client', ?, '{}')`)
      .run("local-title-event", threadId, version, "2026-01-03T00:00:00.000Z", JSON.stringify({ threadId, title: "My local title" }));
    db.close();
    caughtUp(paths);

    const renamedAgain = structuredClone(providerRenamed);
    renamedAgain.threads[0]!.title = "Another provider title";
    renamedAgain.summary.title = "Another provider title";
    const preserved = await syncConversations([{ conversation: renamedAgain }], paths, { dryRun: false });
    expect(preserved.results[0]).toMatchObject({ status: "up-to-date", titleAction: "preserved-local" });
    expect(preserved.results[0]!.warnings[0]).toContain("Preserved locally edited T3 title");
  });
});
