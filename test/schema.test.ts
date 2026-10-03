import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUPPORTED_MIGRATIONS, validateTargetDatabase } from "../src/target/schema.js";
import { importConversations, projectionBacklog } from "../src/target/importer.js";
import { syncConversations, fallbackRecord } from "../src/target/sync.js";
import { replaceConversations } from "../src/target/replace.js";
import { canonicalConversation, createTarget } from "./helpers.js";

let root: string;
let previousLedger: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-schema-"));
  previousLedger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
});
afterEach(() => {
  if (previousLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = previousLedger;
  rmSync(root, { recursive: true, force: true });
});

describe.each(SUPPORTED_MIGRATIONS)("migration %i compatibility", (migration) => {
  it("validates the generated upstream schema and doctor reports its actual migration", () => {
    const paths = createTarget(join(root, "t3"), migration);
    const db = new Database(paths.dbPath, { readonly: true });
    try { expect(validateTargetDatabase(db)).toMatchObject({ migration, integrity: "ok", eventCount: 0 }); }
    finally { db.close(); }
    const before = readFileSync(paths.dbPath);
    const doctor = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", "--t3-home", paths.t3Home, "--json"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 15_000,
      env: { ...process.env, CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_BIN: join(root, "absent-codex.exe") },
    });
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ schemaVersion: 1, database: { migration, integrity: "ok" } });
    expect(readFileSync(paths.dbPath)).toEqual(before);
  });

  it("rejects missing required columns without changing any target or ledger data", async () => {
    const paths = createTarget(join(root, "t3"), migration);
    const db = new Database(paths.dbPath);
    db.exec("ALTER TABLE provider_session_runtime DROP COLUMN resume_cursor_json");
    db.close();
    mkdirSync(paths.attachmentsDir);
    writeFileSync(join(paths.attachmentsDir, "keep.png"), "sentinel");
    const before = readFileSync(paths.dbPath);
    for (const operation of [
      () => importConversations([], paths, { dryRun: false, resume: true }),
      () => syncConversations([], paths, { dryRun: false }),
      () => replaceConversations([], paths, { dryRun: false }),
    ]) await expect(operation()).rejects.toMatchObject({ exitCode: 3 });
    expect(readFileSync(paths.dbPath)).toEqual(before);
    expect(readdirSync(paths.attachmentsDir)).toEqual(["keep.png"]);
    expect(existsSync(join(root, "ledger"))).toBe(false);
  });

  it("honors disabled resume and records the actual migration", async () => {
    const paths = createTarget(join(root, "t3"), migration);
    const conversation = canonicalConversation(root);
    const result = await importConversations([{ conversation, resume: false }], paths, { dryRun: false, resume: false });
    expect(result.migration).toBe(migration);
    const db = new Database(paths.dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT * FROM provider_session_runtime").all()).toEqual([]);
      expect(fallbackRecord(db, paths, conversation.threads[0]!)?.migration).toBe(migration);
    } finally { db.close(); }
    const ledger = new Database(join(root, "ledger/ledger.sqlite"), { readonly: true });
    try { expect(ledger.prepare("SELECT migration FROM imports").all()).toEqual([{ migration }]); }
    finally { ledger.close(); }
  });
});

it.each([39, 55])("rejects unsupported migration %i without writes", async (migration) => {
  const paths = createTarget(join(root, "t3"), migration);
  const before = readFileSync(paths.dbPath);
  for (const operation of [
    () => importConversations([], paths, { dryRun: false, resume: true }),
    () => syncConversations([], paths, { dryRun: false }),
    () => replaceConversations([], paths, { dryRun: false }),
  ]) await expect(operation()).rejects.toMatchObject({ exitCode: 3, message: `Unsupported T3 schema migration ${migration}; supported migrations are 40–54.` });
  expect(readFileSync(paths.dbPath)).toEqual(before);
  expect(existsSync(join(root, "ledger"))).toBe(false);
  expect(existsSync(paths.attachmentsDir)).toBe(false);
});

it("distinguishes a maintenance cursor from a real projection backlog", async () => {
  const paths = createTarget(join(root, "t3"), 50);
  await importConversations([{ conversation: canonicalConversation(root), resume: true }], paths, { dryRun: false, resume: true });
  const db = new Database(paths.dbPath);
  try {
    const insert = db.prepare("INSERT INTO projection_state VALUES (?, ?, '2026-01-01T00:00:00.000Z')");
    const latest = projectionBacklog(db).latestSequence;
    insert.run("projection.attachment-cleanup", 0);
    expect(projectionBacklog(db).backlog).toBe(latest);
    insert.run("projection.threads", latest);
    expect(projectionBacklog(db).backlog).toBe(0);
    insert.run("projection.thread-messages", latest - 1);
    expect(projectionBacklog(db).backlog).toBe(1);
  } finally { db.close(); }
});
