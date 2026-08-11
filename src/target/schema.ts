import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import type { TargetPaths } from "../core/types.js";
import { compatibilityError, safetyError } from "../core/errors.js";
import { isObject, stringValue } from "../core/util.js";

export const SUPPORTED_MIGRATION = 40;

const REQUIRED_COLUMNS: Record<string, string[]> = {
  orchestration_events: ["sequence", "event_id", "aggregate_kind", "stream_id", "stream_version", "event_type", "occurred_at", "actor_kind", "payload_json", "metadata_json"],
  projection_projects: ["project_id", "workspace_root", "deleted_at"],
  projection_state: ["projector", "last_applied_sequence"],
  provider_session_runtime: ["thread_id", "provider_name", "provider_instance_id", "adapter_key", "runtime_mode", "status", "last_seen_at", "resume_cursor_json", "runtime_payload_json"],
};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function originResponds(origin: string): Promise<boolean> {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(700) });
    return response.status > 0;
  } catch {
    return false;
  }
}

export interface RuntimeState {
  exists: boolean;
  live: boolean;
  pid?: number;
  origin?: string;
  stale: boolean;
}

export async function inspectRuntime(paths: TargetPaths): Promise<RuntimeState> {
  if (!existsSync(paths.runtimeStatePath)) return { exists: false, live: false, stale: false };
  try {
    const value = JSON.parse(readFileSync(paths.runtimeStatePath, "utf8")) as unknown;
    if (!isObject(value)) return { exists: true, live: false, stale: true };
    const pid = typeof value.pid === "number" ? value.pid : undefined;
    const origin = stringValue(value.origin);
    const live = (pid !== undefined && pidAlive(pid)) || (origin !== undefined && await originResponds(origin));
    return { exists: true, live, ...(pid !== undefined ? { pid } : {}), ...(origin ? { origin } : {}), stale: !live };
  } catch {
    return { exists: true, live: false, stale: true };
  }
}

export async function assertT3Closed(paths: TargetPaths): Promise<RuntimeState> {
  const runtime = await inspectRuntime(paths);
  if (runtime.live) throw safetyError(`T3 is running${runtime.pid ? ` (PID ${runtime.pid})` : ""}. Close T3 before importing.`);
  return runtime;
}

export interface SchemaInfo {
  migration: number;
  integrity: string;
  eventCount: number;
  maxSequence: number;
}

export function validateTargetDatabase(db: Database.Database): SchemaInfo {
  const integrity = String(db.pragma("integrity_check", { simple: true }) ?? "unknown");
  if (integrity !== "ok") throw compatibilityError(`T3 database integrity check failed: ${integrity}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const names = new Set(tables.map((entry) => entry.name));
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!names.has(table)) throw compatibilityError(`Not a compatible T3 database: missing table '${table}'.`);
    const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((entry) => entry.name));
    for (const column of columns) if (!available.has(column)) throw compatibilityError(`Unsupported T3 schema: ${table}.${column} is missing.`);
  }
  if (!names.has("effect_sql_migrations")) throw compatibilityError("Not a compatible T3 database: missing migrations table.");
  const migrationRow = db.prepare("SELECT COALESCE(MAX(migration_id), 0) migration FROM effect_sql_migrations").get() as { migration: number };
  if (migrationRow.migration !== SUPPORTED_MIGRATION) throw compatibilityError(`Unsupported T3 schema migration ${migrationRow.migration}; expected ${SUPPORTED_MIGRATION}.`);
  const events = db.prepare("SELECT COUNT(*) count, COALESCE(MAX(sequence), 0) maxSequence FROM orchestration_events").get() as { count: number; maxSequence: number };
  return { migration: migrationRow.migration, integrity, eventCount: events.count, maxSequence: events.maxSequence };
}
