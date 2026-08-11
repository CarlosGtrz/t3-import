import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importConversations } from "../src/target/importer.js";
import { canonicalConversation, canonicalThread, createMigration40Target, eventCount } from "./helpers.js";

let originalLedgerDir: string | undefined;

beforeEach(() => { originalLedgerDir = process.env.T3_IMPORT_DATA_DIR; });
afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

describe("migration-40 writer", () => {
  it("backs up, appends canonical events, binds resume, and skips a re-import", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-target-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createMigration40Target(join(root, "t3"));
    const selection = { conversation: canonicalConversation(workspace), duplicate: false, resume: true };

    const first = await importConversations([selection], paths, { dryRun: false, duplicate: false, resume: true });
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

    const second = await importConversations([selection], paths, { dryRun: false, duplicate: false, resume: true });
    expect(second.status).toBe("already-imported");
    expect(second.backup).toBeNull();
    expect(eventCount(paths.dbPath)).toBe(inserted);

    const duplicate = await importConversations([{ ...selection, duplicate: true, resume: false }], paths, { dryRun: false, duplicate: true, resume: false });
    expect(duplicate.status).toBe("imported");
    expect(duplicate.results[0]!.resumable).toBe(false);
    const afterDuplicate = new Database(paths.dbPath, { readonly: true });
    expect((afterDuplicate.prepare("SELECT COUNT(*) count FROM provider_session_runtime").get() as { count: number }).count).toBe(1);
    afterDuplicate.close();
  });

  it("fails closed on unknown migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-schema-"));
    const paths = createMigration40Target(join(root, "t3"), 41);
    await expect(importConversations([], paths, { dryRun: true, duplicate: false, resume: true }))
      .rejects.toMatchObject({ exitCode: 3 });
  });

  it("leaves events unchanged when attachment staging fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-rollback-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = createMigration40Target(join(root, "t3"));
    const thread = canonicalThread(workspace);
    thread.turns[0]!.user.attachments.push({ sourceId: "missing", name: "missing.png", mimeType: "image/png", sizeBytes: 10, path: join(root, "does-not-exist.png") });

    await expect(importConversations([{ conversation: canonicalConversation(workspace, thread), duplicate: false, resume: true }], paths, { dryRun: false, duplicate: false, resume: true }))
      .rejects.toMatchObject({ exitCode: 6 });
    expect(eventCount(paths.dbPath)).toBe(0);
  });
});
