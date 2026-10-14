import Database from "better-sqlite3";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importConversations } from "../src/target/importer.js";
import { importDestination } from "../src/target/destination.js";
import { replaceConversations } from "../src/target/replace.js";
import { syncConversations } from "../src/target/sync.js";
import { SUPPORTED_MIGRATIONS } from "../src/target/schema.js";
import { canonicalConversation, createTarget, eventCount } from "./helpers.js";

let originalLedgerDir: string | undefined;
const roots: string[] = [];
beforeEach(() => { originalLedgerDir = process.env.T3_IMPORT_DATA_DIR; });
afterEach(async () => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(migration = 54, scratch = false) {
  const root = await mkdtemp(join(tmpdir(), "t3-destination-"));
  roots.push(root);
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
  const paths = createTarget(join(root, "t3"), migration);
  const workspace = scratch ? join(paths.t3Home, "scratch", "2026-01-01-source-thread") : join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { root, paths, workspace, conversation: canonicalConversation(workspace) };
}
function catchUp(path: string) {
  const db = new Database(path);
  try { db.exec(`INSERT INTO projection_state (projector,last_applied_sequence,updated_at)
    SELECT 'test',MAX(sequence),'2026-01-01T00:00:00.000Z' FROM orchestration_events WHERE 1
    ON CONFLICT(projector) DO UPDATE SET last_applied_sequence=excluded.last_applied_sequence`); }
  finally { db.close(); }
}

describe.each(SUPPORTED_MIGRATIONS)("migration-%i import destination", (migration) => {
  it("reuses an explicitly selected matching project and keeps cwd", async () => {
    const { paths, workspace, conversation } = await fixture(migration);
    const db = new Database(paths.dbPath);
    db.prepare(`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('selected','Chosen project',?,'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run(workspace);
    db.close();
    const result = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true, targetProject: "selected" });
    expect(result.results[0]).toMatchObject({ projectId: "selected", sourceWorkspace: workspace, workingDirectory: workspace });
    const check = new Database(paths.dbPath, { readonly: true });
    try {
      expect(check.prepare("SELECT COUNT(*) n FROM orchestration_events WHERE event_type='project.created'").get()).toEqual({ n: 0 });
      const created = check.prepare("SELECT payload_json p FROM orchestration_events WHERE event_type='thread.created'").get() as { p: string };
      expect(JSON.parse(created.p)).toMatchObject({ projectId: "selected", worktreePath: null });
    } finally { check.close(); }
  });

  it("uses the native scratch layout without moving files, and preserves it through repeat, sync and replacement", async () => {
    const { paths, workspace, conversation } = await fixture(migration, true);
    const before = readFileSync(paths.dbPath);
    const preview = await importConversations([{ conversation, resume: true }], paths, { dryRun: true, resume: true, noProject: true });
    expect(preview.results[0]).toMatchObject({ workingDirectory: workspace, sourceWorkspace: workspace });
    expect(readFileSync(paths.dbPath)).toEqual(before);
    const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true, noProject: true });
    const projectId = imported.results[0]!.projectId;
    const db = new Database(paths.dbPath, { readonly: true });
    try {
      const project = db.prepare("SELECT payload_json p FROM orchestration_events WHERE event_type='project.created'").get() as { p: string };
      expect(JSON.parse(project.p)).toMatchObject({ title: "No project", workspaceRoot: join(paths.t3Home, "scratch") });
      const created = db.prepare("SELECT payload_json p FROM orchestration_events WHERE event_type='thread.created'").get() as { p: string };
      expect(JSON.parse(created.p)).toMatchObject({ projectId, worktreePath: workspace });
    } finally { db.close(); }
    catchUp(paths.dbPath);
    const count = eventCount(paths.dbPath);
    expect((await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true, noProject: true })).results[0]!.status).toBe("already-imported");
    expect(eventCount(paths.dbPath)).toBe(count);
    const turn = structuredClone(conversation.threads[0]!.turns[0]!);
    turn.id = "turn-2"; turn.user.sourceId = "user-2"; turn.assistant[0]!.sourceId = "assistant-2";
    conversation.threads[0]!.turns.push(turn);
    conversation.fingerprint = "next";
    expect((await syncConversations([{ conversation }], paths, { dryRun: false })).results[0]).toMatchObject({ projectId, turnsAdded: 1 });
    catchUp(paths.dbPath);
    conversation.threads[0]!.turns[0]!.assistant[0]!.text = "Changed source";
    conversation.fingerprint = "replacement";
    const replaced = await replaceConversations([{ conversation }], paths, { dryRun: false });
    const check = new Database(paths.dbPath, { readonly: true });
    try {
      const created = check.prepare("SELECT payload_json p FROM orchestration_events WHERE event_type='thread.created' AND stream_id=?").get(replaced.results[0]!.newThreadId) as { p: string };
      expect(JSON.parse(created.p)).toMatchObject({ projectId, worktreePath: workspace });
      const runtime = check.prepare("SELECT runtime_payload_json p FROM provider_session_runtime WHERE thread_id=?").get(replaced.results[0]!.newThreadId) as { p: string };
      expect(JSON.parse(runtime.p).cwd).toBe(workspace);
    } finally { check.close(); }
  });
});

describe("destination validation", () => {
  it("rejects incompatible, missing or deleted projects before writing", async () => {
    const { paths, root, workspace } = await fixture();
    const db = new Database(paths.dbPath);
    try {
      db.prepare(`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES ('other','Other',?,'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run(root);
      expect(() => importDestination(db, paths, workspace, { targetProject: "other" })).toThrow("would change the working directory");
      expect(() => importDestination(db, paths, workspace, { targetProject: "absent" })).toThrow("does not exist or is deleted");
      db.prepare("UPDATE projection_projects SET deleted_at='deleted' WHERE project_id='other'").run();
      expect(() => importDestination(db, paths, workspace, { targetProject: "other" })).toThrow("does not exist or is deleted");
      expect(() => importDestination(db, paths, workspace, { targetProject: "other", noProject: true })).toThrow("mutually exclusive");
      expect(() => importDestination(db, paths, workspace, { targetProject: "" })).toThrow("non-empty");
      expect(eventCount(paths.dbPath)).toBe(0);
    } finally { db.close(); }
  });
  it("reuses a scratch project from canonical events before its project projection exists", async () => {
    const { paths, conversation } = await fixture(54, true);
    const db = new Database(paths.dbPath);
    try {
      db.prepare(`INSERT INTO orchestration_events
        (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
        VALUES ('native-project','project','native-scratch',0,'project.created','2026-01-01T00:00:00.000Z','client',?,'{}')`)
        .run(JSON.stringify({ projectId: "native-scratch", title: "No project", workspaceRoot: join(paths.t3Home, "scratch") }));
    } finally { db.close(); }
    // Exercise event fallback independently of the backlog guard.
    catchUp(paths.dbPath);
    const result = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true, noProject: true });
    expect(result.results[0]!.projectId).toBe("native-scratch");
    const check = new Database(paths.dbPath, { readonly: true });
    try { expect(check.prepare("SELECT COUNT(*) n FROM orchestration_events WHERE event_type='project.created'").get()).toEqual({ n: 1 }); }
    finally { check.close(); }
  });
  it("refuses to move an imported thread to another same-root project", async () => {
    const { paths, workspace, conversation } = await fixture();
    await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    catchUp(paths.dbPath);
    const db = new Database(paths.dbPath);
    db.prepare(`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('another','Same root',?,'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run(workspace);
    db.close();
    const before = eventCount(paths.dbPath);
    await expect(importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true, targetProject: "another" })).rejects.toThrow("already imported into another destination");
    expect(eventCount(paths.dbPath)).toBe(before);
  });
  it("refuses external or symlink-escaped No project paths and Git scratch folders", async () => {
    const { paths, root, workspace } = await fixture();
    const scratch = join(paths.t3Home, "scratch");
    mkdirSync(scratch);
    const escaped = join(scratch, "linked");
    symlinkSync(workspace, escaped);
    const db = new Database(paths.dbPath);
    try {
      for (const path of [workspace, escaped]) expect(() => importDestination(db, paths, path, { noProject: true })).toThrow("managed scratch layout");
      const git = join(scratch, "git-folder");
      mkdirSync(join(git, ".git"), { recursive: true });
      expect(() => importDestination(db, paths, git, { noProject: true })).toThrow("inside a Git checkout");
      expect(() => importDestination(db, paths, join(root, "missing"), { noProject: true })).toThrow("unavailable");
    } finally { db.close(); }
  });
});
