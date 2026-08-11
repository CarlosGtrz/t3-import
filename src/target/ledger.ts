import Database from "better-sqlite3";
import envPaths from "env-paths";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
        first_sequence, last_sequence, resumable, backup_path, warnings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const row of records) insert.run(row.targetId, row.source, row.sourceSessionId, row.sourceKey, row.sourceFingerprint, row.projectId, row.threadId, row.importedAt, row.importerVersion, row.migration, row.firstSequence, row.lastSequence, row.resumable ? 1 : 0, row.backupPath, JSON.stringify(row.warnings));
    })();
  } finally { db.close(); }
}
