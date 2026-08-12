import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalConversation, CanonicalThread, TargetPaths } from "../src/core/types.js";
import { resolveTargetPaths } from "../src/target/config.js";

export function createMigration40Target(root: string, migration = 40): TargetPaths {
  const paths = resolveTargetPaths({ t3Home: root });
  mkdirSync(paths.stateDir, { recursive: true });
  const db = new Database(paths.dbPath);
  db.exec(`
    CREATE TABLE effect_sql_migrations (migration_id INTEGER NOT NULL);
    INSERT INTO effect_sql_migrations VALUES (${migration});
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      UNIQUE (aggregate_kind, stream_id, stream_version)
    );
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL
    );
    CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT NOT NULL
    );
  `);
  db.close();
  return paths;
}

export function canonicalThread(workspace: string): CanonicalThread {
  return {
    source: "codex",
    sourceSessionId: "11111111-1111-4111-8111-111111111111",
    sourceKey: "codex:11111111-1111-4111-8111-111111111111",
    currentBranch: true,
    title: "Fixture task",
    workspace,
    model: "gpt-test",
    effort: "high",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    turns: [{
      id: "turn-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
      status: "completed",
      user: { sourceId: "user-1", role: "user", text: "Hello", timestamp: "2026-01-01T00:00:00.000Z", attachments: [] },
      assistant: [{ sourceId: "assistant-1", role: "assistant", text: "Hi", timestamp: "2026-01-01T00:00:02.000Z", attachments: [] }],
      activities: [{ sourceId: "tool-1", tone: "tool", kind: "tool.completed", summary: "Command", timestamp: "2026-01-01T00:00:01.000Z", payload: { itemType: "command_execution", status: "completed", data: { item: { command: "pwd" } } } }],
      plans: [],
    }],
    resumeCursor: { threadId: "11111111-1111-4111-8111-111111111111" },
    warnings: [],
  };
}

export function canonicalConversation(workspace: string, thread = canonicalThread(workspace)): CanonicalConversation {
  return {
    summary: { source: thread.source, id: thread.sourceSessionId, title: thread.title, workspace, path: "fixture.jsonl", createdAt: thread.createdAt, updatedAt: thread.updatedAt, status: "complete", branches: 1 },
    threads: [thread],
    fingerprint: "fixture-fingerprint",
  };
}

export function eventCount(path: string): number {
  const db = new Database(path, { readonly: true });
  try { return (db.prepare("SELECT COUNT(*) count FROM orchestration_events").get() as { count: number }).count; }
  finally { db.close(); }
}
