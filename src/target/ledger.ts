import Database from "better-sqlite3";
import envPaths from "env-paths";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseCheckpoint, type ImportCheckpoint } from "../core/checkpoint.js";

export interface LedgerRecord {
  targetId: string;
  source: string;
  sourceSessionId: string;
  sourceKey: string;
  sourceFingerprint: string;
  projectId: string;
  threadId: string;
  importedAt: string;
  importerVersion: string;
  migration: number;
  firstSequence: number;
  lastSequence: number;
  resumable: boolean;
  backupPath: string;
  warnings: string[];
  identitySeed: string;
  currentSourceKey: string;
  sourceLeafId?: string;
  sourceTitle: string;
  checkpoint: ImportCheckpoint;
  syncedAt?: string;
}

export interface StoredLedgerRecord extends Omit<LedgerRecord, "checkpoint"> {
  checkpoint?: ImportCheckpoint;
}

function openLedger(): Database.Database {
  const directory = process.env.T3_IMPORT_DATA_DIR?.trim() || envPaths("t3-import").data;
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, "ledger.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS imports (
      target_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      importer_version TEXT NOT NULL,
      migration INTEGER NOT NULL,
      first_sequence INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      resumable INTEGER NOT NULL,
      backup_path TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      PRIMARY KEY (target_id, source_key, thread_id)
    )
  `);
  const columns = new Set((db.prepare("PRAGMA table_info(imports)").all() as Array<{ name: string }>).map((row) => row.name));
  const additions: Array<[string, string]> = [
    ["identity_seed", "TEXT"],
    ["current_source_key", "TEXT"],
    ["source_leaf_id", "TEXT"],
    ["source_title", "TEXT"],
    ["checkpoint_version", "INTEGER"],
    ["checkpoint_json", "TEXT"],
    ["synced_at", "TEXT"],
  ];
  for (const [name, type] of additions) if (!columns.has(name)) db.exec(`ALTER TABLE imports ADD COLUMN ${name} ${type}`);
  return db;
}

export function recordImports(records: LedgerRecord[]): void {
  if (!records.length) return;
  const db = openLedger();
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO imports (
        target_id, source, source_session_id, source_key, source_fingerprint,
        project_id, thread_id, imported_at, importer_version, migration,
        first_sequence, last_sequence, resumable, backup_path, warnings_json,
        identity_seed, current_source_key, source_leaf_id, source_title,
        checkpoint_version, checkpoint_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const row of records) insert.run(
        row.targetId, row.source, row.sourceSessionId, row.sourceKey, row.sourceFingerprint,
        row.projectId, row.threadId, row.importedAt, row.importerVersion, row.migration,
        row.firstSequence, row.lastSequence, row.resumable ? 1 : 0, row.backupPath,
        JSON.stringify(row.warnings), row.identitySeed, row.currentSourceKey,
        row.sourceLeafId ?? null, row.sourceTitle, row.checkpoint.version,
        JSON.stringify(row.checkpoint), row.syncedAt ?? null,
      );
    })();
  } finally { db.close(); }
}

interface RawLedgerRow {
  target_id: string;
  source: string;
  source_session_id: string;
  source_key: string;
  source_fingerprint: string;
  project_id: string;
  thread_id: string;
  imported_at: string;
  importer_version: string;
  migration: number;
  first_sequence: number;
  last_sequence: number;
  resumable: number;
  backup_path: string;
  warnings_json: string;
  identity_seed: string | null;
  current_source_key: string | null;
  source_leaf_id: string | null;
  source_title: string | null;
  checkpoint_json: string | null;
  synced_at: string | null;
}

function decodeRow(row: RawLedgerRow): StoredLedgerRecord {
  let warnings: string[] = [];
  let checkpoint: ImportCheckpoint | undefined;
  try { warnings = JSON.parse(row.warnings_json) as string[]; } catch { /* legacy row */ }
  checkpoint = parseCheckpoint(row.checkpoint_json);
  return {
    targetId: row.target_id,
    source: row.source,
    sourceSessionId: row.source_session_id,
    sourceKey: row.source_key,
    sourceFingerprint: row.source_fingerprint,
    projectId: row.project_id,
    threadId: row.thread_id,
    importedAt: row.imported_at,
    importerVersion: row.importer_version,
    migration: row.migration,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    resumable: row.resumable === 1,
    backupPath: row.backup_path,
    warnings,
    identitySeed: row.identity_seed ?? row.source_key,
    currentSourceKey: row.current_source_key ?? row.source_key,
    ...(row.source_leaf_id ? { sourceLeafId: row.source_leaf_id } : {}),
    sourceTitle: row.source_title ?? "",
    ...(checkpoint ? { checkpoint } : {}),
    ...(row.synced_at ? { syncedAt: row.synced_at } : {}),
  };
}

export function listImports(targetId: string, source?: string): StoredLedgerRecord[] {
  const db = openLedger();
  try {
    const rows = db.prepare(`
      SELECT * FROM imports WHERE target_id = ? ${source ? "AND source = ?" : ""}
      ORDER BY imported_at DESC
    `).all(...(source ? [targetId, source] : [targetId])) as RawLedgerRow[];
    return rows.map(decodeRow);
  } finally { db.close(); }
}
