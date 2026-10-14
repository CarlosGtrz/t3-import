import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importConversations } from "../src/target/importer.js";
import { listImports } from "../src/target/ledger.js";
import { inspectConversationReplacement, replaceConversations } from "../src/target/replace.js";
import { inspectConversationSync, syncConversations, targetId } from "../src/target/sync.js";
import { canonicalConversation, createTarget, eventCount } from "./helpers.js";

let originalLedgerDir: string | undefined;
const roots: string[] = [];
beforeEach(() => { originalLedgerDir = process.env.T3_IMPORT_DATA_DIR; });
afterEach(async () => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "t3-ledger-safety-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const ledgerDir = join(root, "ledger");
  process.env.T3_IMPORT_DATA_DIR = ledgerDir;
  const paths = createTarget(join(root, "t3"), 54);
  const conversation = canonicalConversation(workspace);
  await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const db = new Database(paths.dbPath);
  try {
    db.exec(`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
      SELECT 'test', MAX(sequence), '2026-01-01T00:00:00.000Z' FROM orchestration_events`);
  } finally { db.close(); }
  const added = structuredClone(conversation.threads[0]!.turns[0]!);
  added.id = "turn-2";
  added.user.sourceId = "user-2";
  added.assistant[0]!.sourceId = "assistant-2";
  conversation.threads[0]!.turns.push(added);
  conversation.fingerprint = "advanced";
  return { root, paths, conversation, ledgerDir, ledgerPath: join(ledgerDir, "ledger.sqlite") };
}

function snapshot(directory: string): Record<string, Buffer> {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))]));
}

describe("ledger inspection safety", () => {
  it("reads uncheckpointed committed WAL rows without changing database or WAL bytes", async () => {
    const { ledgerPath, paths } = await fixture();
    const writer = new Database(ledgerPath);
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer.pragma("wal_checkpoint(TRUNCATE)");
      writer.prepare("UPDATE imports SET source_title = ?").run("Pending WAL title");
      const before = readFileSync(ledgerPath);
      const walBefore = readFileSync(`${ledgerPath}-wal`);
      expect(walBefore.length).toBeGreaterThan(0);
      expect(listImports(targetId(paths), "codex")[0]!.sourceTitle).toBe("Pending WAL title");
      expect(readFileSync(ledgerPath)).toEqual(before);
      expect(readFileSync(`${ledgerPath}-wal`)).toEqual(walBefore);
    } finally { writer.close(); }
  });

  it("reads a consistent WAL copy without a shared-memory index", async () => {
    const { root, ledgerPath, paths } = await fixture();
    const writer = new Database(ledgerPath);
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer.pragma("wal_checkpoint(TRUNCATE)");
      writer.prepare("UPDATE imports SET source_title = ?").run("WAL-only title");
      const copyDir = join(root, "wal-copy");
      mkdirSync(copyDir);
      const copyPath = join(copyDir, "ledger.sqlite");
      // The writer is idle here, so these two files represent one consistent state.
      copyFileSync(ledgerPath, copyPath);
      copyFileSync(`${ledgerPath}-wal`, `${copyPath}-wal`);
      expect(existsSync(`${copyPath}-shm`)).toBe(false);
      const before = readFileSync(copyPath);
      const walBefore = readFileSync(`${copyPath}-wal`);
      process.env.T3_IMPORT_DATA_DIR = copyDir;
      expect(listImports(targetId(paths), "codex")[0]!.sourceTitle).toBe("WAL-only title");
      expect(readFileSync(copyPath)).toEqual(before);
      expect(readFileSync(`${copyPath}-wal`)).toEqual(walBefore);
      // SQLite may rebuild -shm; it is not authoritative database content.
    } finally { writer.close(); }
  });

  it.each(["missing", "legacy"])("keeps a %s ledger unchanged through dry-runs and TUI inspection functions", async (kind) => {
    const { root, paths, conversation, ledgerPath } = await fixture();
    const inspectionDir = join(root, "inspection-ledger");
    process.env.T3_IMPORT_DATA_DIR = inspectionDir;
    if (kind === "legacy") {
      mkdirSync(inspectionDir);
      const legacy = new Database(join(inspectionDir, "ledger.sqlite"));
      try {
        legacy.prepare("ATTACH DATABASE ? AS original").run(ledgerPath);
        legacy.exec(`CREATE TABLE imports AS SELECT target_id, source, source_session_id,
          source_key, source_fingerprint, project_id, thread_id, imported_at,
          importer_version, migration, first_sequence, last_sequence, resumable,
          backup_path, warnings_json FROM original.imports`);
      } finally { legacy.close(); }
    }
    const before = snapshot(inspectionDir);
    const count = eventCount(paths.dbPath);
    // These are the inspection functions invoked by the TUI conversation views.
    const syncPreview = await inspectConversationSync(conversation, paths);
    expect(syncPreview.previouslyImported).toBe(true);
    expect(snapshot(inspectionDir)).toEqual(before);
    const replacePreview = await inspectConversationReplacement(conversation, paths);
    expect(replacePreview.selectable).toBe(true);
    expect(snapshot(inspectionDir)).toEqual(before);
    const sync = await syncConversations([{ conversation }], paths, { dryRun: true });
    expect(sync.status).toBe("dry-run");
    expect(sync.backup).toBeNull();
    expect(snapshot(inspectionDir)).toEqual(before);
    const replace = await replaceConversations([{ conversation }], paths, { dryRun: true });
    expect(replace.status).toBe("dry-run");
    expect(replace.backup).toBeNull();
    expect(snapshot(inspectionDir)).toEqual(before);
    expect(eventCount(paths.dbPath)).toBe(count);
    if (kind === "missing") expect(existsSync(inspectionDir)).toBe(false);
  });

  it.each(["SQLITE_NOTADB", "SQLITE_CORRUPT"])("reports an actionable %s error and preserves the existing ledger", async (code) => {
    const { ledgerDir, ledgerPath, paths, conversation } = await fixture();
    if (code === "SQLITE_NOTADB") writeFileSync(ledgerPath, "This is not a SQLite database");
    else {
      const bytes = readFileSync(ledgerPath);
      bytes[100] = 0; // Invalid page-one b-tree type, with a valid SQLite header.
      writeFileSync(ledgerPath, bytes);
    }
    const before = snapshot(ledgerDir);
    const checkError = (error: unknown) => {
      expect(error).toMatchObject({ name: "ImporterError", exitCode: 4 });
      expect((error as Error).message).toContain(ledgerPath);
      expect((error as Error).message).toContain(code);
      expect((error as Error).message).toContain("Automatic T3 backups do not include this external ledger");
      expect((error as Error).message).toContain("If you have a verified user-maintained ledger backup");
      expect((error as Error).message).toContain("otherwise investigate recovery before further writes");
      expect((error as Error).message).toContain("Do not delete the ledger");
    };
    try { listImports(targetId(paths)); throw new Error("Expected corruption error"); }
    catch (error) { checkError(error); }
    await expect(inspectConversationSync(conversation, paths)).rejects.toSatisfy((error: unknown) => { checkError(error); return true; });
    await expect(inspectConversationReplacement(conversation, paths)).rejects.toSatisfy((error: unknown) => { checkError(error); return true; });
    await expect(syncConversations([{ conversation }], paths, { dryRun: true })).rejects.toSatisfy((error: unknown) => { checkError(error); return true; });
    await expect(replaceConversations([{ conversation }], paths, { dryRun: true })).rejects.toSatisfy((error: unknown) => { checkError(error); return true; });
    expect(readFileSync(ledgerPath)).toEqual(before["ledger.sqlite"]);
    // SQLite may create its WAL-mode sidecars before detecting page corruption.
    // Existing WAL content must remain intact; a newly created WAL must be empty.
    const walPath = `${ledgerPath}-wal`;
    if (existsSync(walPath)) expect(readFileSync(walPath)).toEqual(before["ledger.sqlite-wal"] ?? Buffer.alloc(0));
  });
});
