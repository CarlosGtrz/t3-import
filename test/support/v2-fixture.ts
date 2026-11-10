import Database from "better-sqlite3";

/**
 * The pinned fixture schemas stop at the v1 (<= 0.1.5) layout. T3 0.1.6 adds
 * the orchestration-v2 projection tables plus the v1->v2 migration bridge, so
 * tests that exercise the current writer upgrade the fixture in place.
 */
export function upgradeFixtureToV2(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const eventColumns = new Set((db.prepare("PRAGMA table_info(orchestration_events)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!eventColumns.has("application_event_version")) {
      db.exec("ALTER TABLE orchestration_events ADD COLUMN application_event_version INTEGER NOT NULL DEFAULT 1");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
        active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT
      );
      CREATE TABLE IF NOT EXISTS orchestration_v2_projection_messages (
        message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT,
        role TEXT NOT NULL, streaming INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orchestration_v2_legacy_imports (
        thread_id TEXT PRIMARY KEY, source_updated_at TEXT NOT NULL, shell_imported_at TEXT NOT NULL,
        transcript_imported_at TEXT, imported_message_count INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS orchestration_v2_projection_turn_items (
        turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT,
        provider_thread_id TEXT, provider_turn_id TEXT, parent_item_id TEXT, ordinal INTEGER NOT NULL,
        type TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orchestration_v2_projection_runs (
        run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, provider TEXT NOT NULL,
        provider_thread_id TEXT, status TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT,
        payload_json TEXT NOT NULL, provider_instance_id TEXT
      );
      CREATE TABLE IF NOT EXISTS orchestration_v2_projection_run_attempts (
        attempt_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
        attempt_ordinal INTEGER NOT NULL, root_node_id TEXT NOT NULL, provider TEXT NOT NULL,
        provider_thread_id TEXT NOT NULL, provider_turn_id TEXT, status TEXT NOT NULL,
        payload_json TEXT NOT NULL, provider_instance_id TEXT
      );
      CREATE TABLE IF NOT EXISTS orchestration_v2_projection_nodes (
        node_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, parent_node_id TEXT,
        root_node_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, provider_thread_id TEXT,
        provider_turn_id TEXT, runtime_request_id TEXT, checkpoint_scope_id TEXT, started_at TEXT,
        completed_at TEXT, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orchestration_v2_turn_item_positions (
        thread_id TEXT NOT NULL, turn_item_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_item_id), UNIQUE (thread_id, ordinal)
      );
    `);
  } finally { db.close(); }
}
