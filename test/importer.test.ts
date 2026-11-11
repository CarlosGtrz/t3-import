import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importConversations, listActiveT3Projects } from "../src/target/importer.js";
import { canonicalConversation, canonicalThread, createTarget, eventCount } from "./helpers.js";
import { upgradeFixtureToV2 } from "./support/v2-fixture.js";

import { SUPPORTED_MIGRATIONS } from "../src/target/schema.js";

let fixtureMigration = 40;
const createFixture = (root: string, migration = fixtureMigration) => createTarget(root, migration);

let originalLedgerDir: string | undefined;

beforeEach(() => { originalLedgerDir = process.env.T3_IMPORT_DATA_DIR; });
afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

describe.each(SUPPORTED_MIGRATIONS)("migration-%i writer", (migration) => {
  beforeEach(() => { fixtureMigration = migration; });
  it("writes completed, interrupted, failed, and included active snapshots as settled T3 sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-terminal-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createFixture(join(root, "t3"));
    const thread = canonicalThread(workspace);
    const fixture = thread.turns[0]!;
    const { completedAt: _completedAt, ...activeFixture } = structuredClone(fixture);
    thread.turns = [
      fixture,
      { ...structuredClone(fixture), id: "turn-interrupted", status: "interrupted", terminalReason: "budget_limited" },
      { ...structuredClone(fixture), id: "turn-failed", status: "failed", terminalError: "provider exploded" },
      { ...activeFixture, id: "turn-active", status: "inProgress" },
    ];
    const result = await importConversations([{ conversation: canonicalConversation(workspace, thread), resume: true }], paths, { dryRun: false, resume: true });
    expect(result.results[0]!.warnings).toContainEqual(expect.stringContaining("active provider snapshot"));
    const db = new Database(paths.dbPath, { readonly: true });
    const rows = db.prepare("SELECT payload_json payload FROM orchestration_events WHERE event_type='thread.session-set' ORDER BY sequence").all() as Array<{ payload: string }>;
    const settled = rows.map((row) => JSON.parse(row.payload).session).filter((session) => session.activeTurnId === null);
    expect(settled.map((session) => session.status)).toEqual(["ready", "interrupted", "error", "interrupted"]);
    expect(settled[2]!.lastError).toBe("provider exploded");
    db.close();
  });

  it("backs up, appends canonical events, binds resume, and skips a re-import", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-target-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createFixture(join(root, "t3"));
    const selection = { conversation: canonicalConversation(workspace), resume: true };

    const first = await importConversations([selection], paths, { dryRun: false, resume: true });
    expect(first.status).toBe("imported");
    expect(first.backup && existsSync(first.backup)).toBe(true);
    const inserted = eventCount(paths.dbPath);
    expect(inserted).toBeGreaterThan(0);
    const db = new Database(paths.dbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) count FROM projection_state").get() as { count: number }).count).toBe(0);
    const runtime = db.prepare("SELECT status, resume_cursor_json cursor FROM provider_session_runtime").get() as { status: string; cursor: string };
    expect(runtime.status).toBe("stopped");
    expect(JSON.parse(runtime.cursor)).toEqual({ threadId: "11111111-1111-4111-8111-111111111111" });
    db.close();

    const second = await importConversations([selection], paths, { dryRun: false, resume: true });
    expect(second.status).toBe("already-imported");
    expect(second.backup).toBeNull();
    expect(eventCount(paths.dbPath)).toBe(inserted);

  });

  it("writes the v1 legacy tables T3 0.1.6 migrates from", async () => {
    if (migration < 53) return;
    const root = await mkdtemp(join(tmpdir(), "t3-import-legacy-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createFixture(join(root, "t3"));
    upgradeFixtureToV2(paths.dbPath);
    await importConversations([{ conversation: canonicalConversation(workspace), resume: true }], paths, { dryRun: false, resume: true });
    const db = new Database(paths.dbPath, { readonly: true });
    try {
      const thread = db.prepare("SELECT thread_id, title FROM projection_threads").all() as Array<{ thread_id: string; title: string }>;
      expect(thread).toHaveLength(1);
      const messages = db.prepare("SELECT role, text FROM projection_thread_messages ORDER BY created_at").all() as Array<{ role: string; text: string }>;
      expect(messages).toEqual([{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi" }]);
      // v2 rows are left to the T3 migration bridge; writing them directly produced empty transcripts.
      const v2 = db.prepare("SELECT COUNT(*) count FROM orchestration_v2_projection_threads").get() as { count: number };
      expect(v2.count).toBe(0);
    } finally { db.close(); }
  });

  it("fails closed on unknown migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-schema-"));
    const paths = createFixture(join(root, "t3"), 39);
    await expect(importConversations([], paths, { dryRun: true, resume: true }))
      .rejects.toMatchObject({ exitCode: 3 });
  });

  it("leaves events unchanged when attachment staging fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-rollback-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createFixture(join(root, "t3"));
    const thread = canonicalThread(workspace);
    thread.turns[0]!.user.attachments.push({ sourceId: "missing", name: "missing.png", mimeType: "image/png", sizeBytes: 10, path: join(root, "does-not-exist.png") });

    await expect(importConversations([{ conversation: canonicalConversation(workspace, thread), resume: true }], paths, { dryRun: false, resume: true }))
      .rejects.toMatchObject({ exitCode: 6 });
    expect(eventCount(paths.dbPath)).toBe(0);
  });

  it("compacts repetitive activity telemetry before planning events", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-compact-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const paths = createFixture(join(root, "t3"));
    const thread = canonicalThread(workspace);
    thread.turns[0]!.activities = [
      ...Array.from({ length: 12 }, (_, index) => ({ sourceId: `usage-${index}`, tone: "info" as const, kind: "context-window.updated", summary: "Usage", timestamp: `2026-01-01T00:00:01.${String(index).padStart(3, "0")}Z`, payload: { usedTokens: index } })),
      ...Array.from({ length: 8 }, (_, index) => ({ sourceId: `reasoning-${index}`, tone: "info" as const, kind: "reasoning.summary", summary: "Reasoning", timestamp: `2026-01-01T00:00:02.${String(index).padStart(3, "0")}Z`, payload: { detail: `step ${index}` } })),
      ...Array.from({ length: 6 }, (_, index) => ({ sourceId: `tool-${index}`, tone: "tool" as const, kind: "tool.completed", summary: "Command", timestamp: `2026-01-01T00:00:03.${String(index).padStart(3, "0")}Z`, payload: { itemType: index === 5 ? "file_change" : "command_execution", status: "completed" } })),
      { sourceId: "compaction", tone: "info", kind: "context-compaction", summary: "Compacted", timestamp: "2026-01-01T00:00:04.000Z", payload: { state: "compacted" } },
    ];

    const result = await importConversations(
      [{ conversation: canonicalConversation(workspace, thread), resume: true }],
      paths,
      { dryRun: true, resume: true },
    );
    expect(result.results[0]!.activities).toBe(3);
    expect(result.results[0]!.warnings).toContainEqual(expect.stringContaining("Compacted 27 source activities to 3"));
    expect(eventCount(paths.dbPath)).toBe(0);
  });

  it("rejects an import that cannot fit in one safe projection batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-limit-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const paths = createFixture(join(root, "t3"));
    const thread = canonicalThread(workspace);
    const fixtureTurn = thread.turns[0]!;
    thread.turns = Array.from({ length: 160 }, (_, index) => ({
      ...fixtureTurn,
      id: `turn-${index}`,
      user: { ...fixtureTurn.user, sourceId: `user-${index}` },
      assistant: fixtureTurn.assistant.map((message) => ({ ...message, sourceId: `${message.sourceId}-${index}` })),
      activities: fixtureTurn.activities.map((activity) => ({ ...activity, sourceId: `${activity.sourceId}-${index}` })),
    }));

    await expect(importConversations(
      [{ conversation: canonicalConversation(workspace, thread), resume: true }],
      paths,
      { dryRun: true, resume: true },
    )).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("safe one-launch limit") });
    expect(eventCount(paths.dbPath)).toBe(0);

    const forcedResult = await importConversations(
      [{ conversation: canonicalConversation(workspace, thread), resume: true }],
      paths,
      { dryRun: true, resume: true, force: true },
    );
    expect(forcedResult.status).toBe("dry-run");

    const customLimitResult = await importConversations(
      [{ conversation: canonicalConversation(workspace, thread), resume: true }],
      paths,
      { dryRun: true, resume: true, maxEvents: 5000 },
    );
    expect(customLimitResult.status).toBe("dry-run");
  });

  it("rejects new writes while T3 projections are behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-backlog-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createFixture(join(root, "t3"));
    const selection = { conversation: canonicalConversation(workspace), resume: true };
    await importConversations([selection], paths, { dryRun: false, resume: true });

    const another = canonicalThread(workspace);
    another.sourceSessionId = "22222222-2222-4222-8222-222222222222";
    another.sourceKey = `codex:${another.sourceSessionId}`;
    another.resumeCursor = { threadId: another.sourceSessionId };
    await expect(importConversations(
      [{ conversation: canonicalConversation(workspace, another), resume: true }],
      paths,
      { dryRun: true, resume: true },
    )).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("unprojected event") });
  });

  it("imports threads into No project when noProject option is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-no-project-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const paths = createFixture(join(root, "t3"));
    const thread = canonicalThread(workspace);
    const result = await importConversations(
      [{ conversation: canonicalConversation(workspace, thread), resume: false }],
      paths,
      { dryRun: false, resume: false, noProject: true },
    );
    expect(result.results[0]!.status).toBe("imported");
    const db = new Database(paths.dbPath, { readonly: true });
    const threadEvent = db.prepare("SELECT payload_json payload FROM orchestration_events WHERE event_type='thread.created'").get() as { payload: string };
    const payload = JSON.parse(threadEvent.payload);
    expect(payload.projectId).toBe("038044f3-eb38-49e9-a28e-5668f1420b6b");
    const projectEvents = db.prepare("SELECT COUNT(*) count FROM orchestration_events WHERE event_type='project.created'").get() as { count: number };
    expect(projectEvents.count).toBe(0);
    db.close();
  });

  it("imports threads into specified targetProjectId", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-target-project-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const paths = createFixture(join(root, "t3"));
    const customProjectId = "99999999-9999-4999-8999-999999999999";
    const thread = canonicalThread(workspace);
    const result = await importConversations(
      [{ conversation: canonicalConversation(workspace, thread), resume: false }],
      paths,
      { dryRun: false, resume: false, targetProjectId: customProjectId },
    );
    expect(result.results[0]!.status).toBe("imported");
    const db = new Database(paths.dbPath, { readonly: true });
    const threadEvent = db.prepare("SELECT payload_json payload FROM orchestration_events WHERE event_type='thread.created'").get() as { payload: string };
    const payload = JSON.parse(threadEvent.payload);
    expect(payload.projectId).toBe(customProjectId);
    const projectEvents = db.prepare("SELECT COUNT(*) count FROM orchestration_events WHERE event_type='project.created'").get() as { count: number };
    expect(projectEvents.count).toBe(0);
    db.close();
  });

  it("lists active T3 projects from projection_projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-list-projects-"));
    const paths = createFixture(join(root, "t3"));
    const db = new Database(paths.dbPath);
    db.prepare("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "test-proj-id-1", "测试项目1", "/tmp/ws1", "[]", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
    );
    db.prepare("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "test-proj-id-del", "已删除项目", "/tmp/wsdel", "[]", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"
    );
    db.close();
    const projects = listActiveT3Projects(paths);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toEqual({
      id: "test-proj-id-1",
      title: "测试项目1",
      workspaceRoot: "/tmp/ws1",
    });
  });
});
