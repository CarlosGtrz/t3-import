import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { TargetPaths } from "../core/types.js";
import { compatibilityError } from "../core/errors.js";
import { canonicalPath, sanitizeMessageText, sha256 } from "../core/util.js";
import { assertT3Closed } from "./schema.js";
import { createBackup } from "./importer.js";
import { listImportedThreadIds } from "./ledger.js";

/** Creation sources T3 accepts. Anything else fails its projection schema. */
const VALID_CREATION_SOURCES = new Set(["web", "mobile", "mcp", "provider", "server"]);

export interface RepairThreadReport {
  threadId: string;
  title: string;
  actions: string[];
}

export interface RepairRunResult {
  schemaVersion: 1;
  status: "repaired" | "noop" | "dry-run";
  target: string;
  backup: string | null;
  threads: number;
  legacyThreads: number;
  legacyMessages: number;
  fixedSources: number;
  clearedWorktrees: number;
  sanitizedMessages: number;
  droppedProjectionRows: number;
  details: RepairThreadReport[];
  warnings: string[];
}

function tableNames(db: Database.Database): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
}

function hasV2ThreadCreatedEvent(db: Database.Database, threadId: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM orchestration_events
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND stream_id = ?
      AND event_type = 'thread.created'
    LIMIT 1
  `).get(threadId));
}

interface LegacyMessageRow {
  message_id: string;
  role: string;
  created_at: string;
  updated_at: string;
  payload_json: string;
}

/**
 * Repairs conversations imported by t3-import <= 0.5.2.
 *
 * Those versions wrote only the orchestration-v2 projection, which T3 0.1.6
 * never renders: its timeline is built by the v1 migration bridge from
 * `projection_threads` / `projection_thread_messages`. They also wrote
 * `creationSource: "import"`, an enum value T3 rejects, which breaks the
 * entire shell snapshot (empty sidebar).
 */
export async function repairImportedThreads(paths: TargetPaths, options: { dryRun?: boolean; force?: boolean } = {}): Promise<RepairRunResult> {
  if (!existsSync(paths.dbPath)) throw compatibilityError(`T3 database not found: ${paths.dbPath}`);
  // A dry run is read-only: it stays usable while T3 is open.
  if (!options.dryRun && !options.force) await assertT3Closed(paths);
  const db = new Database(paths.dbPath, { fileMustExist: true });
  try {
    const names = tableNames(db);
    for (const table of ["orchestration_v2_projection_threads", "orchestration_v2_projection_messages", "projection_threads", "projection_thread_messages", "orchestration_events", "orchestration_v2_legacy_imports"]) {
      if (!names.has(table)) throw compatibilityError(`此 T3 版本缺少表 ${table}，无法执行修复（可能不是 0.1.6 或更新版本）。`);
    }

    const hasRuntimeTable = names.has("provider_session_runtime");

    const targetId = sha256(canonicalPath(paths.dbPath));
    const ledgerIds = listImportedThreadIds(targetId);
    const orphanRows = db.prepare(`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.creationSource') = 'import'
         OR (
           EXISTS (SELECT 1 FROM orchestration_v2_projection_messages m WHERE m.thread_id = orchestration_v2_projection_threads.thread_id)
           AND NOT EXISTS (
             SELECT 1 FROM orchestration_events e
             WHERE e.application_event_version = 2
               AND e.aggregate_kind = 'thread'
               AND e.stream_id = orchestration_v2_projection_threads.thread_id
               AND e.event_type = 'thread.created'
           )
         )
    `).all() as Array<{ thread_id: string }>;

    const citationMessageRows = db.prepare(`
      SELECT DISTINCT thread_id FROM projection_thread_messages
      WHERE text LIKE '%<oai-mem-citation>%'
         OR text LIKE '%<external_codex_apps_open_page>%'
         OR text LIKE '%## My request:%'
    `).all() as Array<{ thread_id: string }>;

    const candidates = [...new Set([
      ...ledgerIds,
      ...orphanRows.map((row) => row.thread_id),
      ...citationMessageRows.map((row) => row.thread_id),
    ])];

    const threadRow = db.prepare("SELECT title, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?");
    const legacyThreadRow = db.prepare("SELECT thread_id, project_id, title, worktree_path FROM projection_threads WHERE thread_id = ?");
    const legacyThread = db.prepare(`
      INSERT INTO projection_threads (
        thread_id, project_id, title, worktree_path, created_at, updated_at,
        runtime_mode, interaction_mode, model_selection_json,
        latest_user_message_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'full-access', 'default', ?, ?, NULL)
      ON CONFLICT(thread_id) DO UPDATE SET
        title = excluded.title,
        worktree_path = excluded.worktree_path,
        updated_at = excluded.updated_at,
        model_selection_json = excluded.model_selection_json,
        latest_user_message_at = excluded.latest_user_message_at,
        deleted_at = NULL
    `);
    const legacyMessage = db.prepare(`
      INSERT OR REPLACE INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming,
        created_at, updated_at, attachments_json, context_json
      ) VALUES (?, ?, NULL, ?, ?, 0, ?, ?, ?, ?)
    `);
    const v2Messages = db.prepare(`
      SELECT message_id, role, created_at, updated_at, payload_json
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, message_id ASC
    `);
    const dropChildRows = [
      "orchestration_v2_projection_turn_items",
      "orchestration_v2_projection_run_attempts",
      "orchestration_v2_projection_runs",
      "orchestration_v2_projection_nodes",
      "orchestration_v2_projection_messages",
      "orchestration_v2_turn_item_positions",
    ];

    const details: RepairThreadReport[] = [];
    let legacyThreads = 0;
    let legacyMessages = 0;
    let fixedSources = 0;
    let clearedWorktrees = 0;
    let sanitizedMessages = 0;
    let droppedRows = 0;

    const run = db.transaction(() => {
      for (const threadId of candidates) {
        const row = threadRow.get(threadId) as { title: string; payload_json: string } | undefined;
        let payload: Record<string, unknown> = {};
        if (row) {
          try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { payload = {}; }
        }
        const legacyRow = legacyThreadRow.get(threadId) as { thread_id: string; project_id: string; title: string; worktree_path: string | null } | undefined;
        if (!row && !legacyRow) continue;

        const actions: string[] = [];
        const threadTitle = String(payload.title ?? row?.title ?? legacyRow?.title ?? "Untitled thread");
        const projectId = String(payload.projectId ?? legacyRow?.project_id ?? "");

        if (row) {
          const source = typeof payload.creationSource === "string" ? payload.creationSource : "";
          if (!VALID_CREATION_SOURCES.has(source)) {
            actions.push(`creationSource ${source || "(missing)"} -> server`);
            fixedSources += 1;
            if (!options.dryRun) {
              payload.creationSource = "server";
              db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json = ? WHERE thread_id = ?").run(JSON.stringify(payload), threadId);
            }
          }
        }

        if (!legacyRow && !hasV2ThreadCreatedEvent(db, threadId)) {
          const messages = v2Messages.all(threadId) as LegacyMessageRow[];
          if (messages.length > 0) {
            const modelSelection = payload.modelSelection ?? { instanceId: String(payload.providerInstanceId ?? "codex") };
            const latestUser = [...messages].reverse().find((message) => message.role === "user");
            const rawWorktree = typeof payload.worktreePath === "string" ? payload.worktreePath : null;
            const validWorktree = rawWorktree && existsSync(rawWorktree) ? rawWorktree : null;
            if (!options.dryRun) {
              legacyThread.run(
                threadId,
                projectId,
                threadTitle,
                validWorktree,
                String(payload.createdAt ?? messages[0]!.created_at),
                String(payload.updatedAt ?? messages[messages.length - 1]!.updated_at),
                JSON.stringify(modelSelection),
                latestUser?.created_at ?? null,
              );
              for (const message of messages) {
                let messagePayload: Record<string, unknown> = {};
                try { messagePayload = JSON.parse(message.payload_json) as Record<string, unknown>; } catch { /* keep empty */ }
                const rawText = typeof messagePayload.text === "string" ? messagePayload.text : "";
                legacyMessage.run(
                  message.message_id,
                  threadId,
                  message.role,
                  sanitizeMessageText(rawText),
                  message.created_at,
                  message.updated_at,
                  JSON.stringify(messagePayload.attachments ?? []),
                  messagePayload.context ? JSON.stringify(messagePayload.context) : null,
                );
              }
            }
            actions.push(`legacy thread + ${messages.length} messages`);
            legacyThreads += 1;
            legacyMessages += messages.length;
          }
        }

        // Repair non-existent worktree path
        const currentWorktree = (typeof payload.worktreePath === "string" ? payload.worktreePath : null)
          ?? legacyRow?.worktree_path
          ?? null;
        if (currentWorktree && !existsSync(currentWorktree)) {
          if (!options.dryRun) {
            if (legacyRow?.worktree_path) {
              db.prepare("UPDATE projection_threads SET worktree_path = NULL WHERE thread_id = ?").run(threadId);
            }
            if (row && payload.worktreePath) {
              payload.worktreePath = null;
              db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json = ? WHERE thread_id = ?").run(JSON.stringify(payload), threadId);
            }
            if (hasRuntimeTable) {
              const runtimeRow = db.prepare("SELECT runtime_payload_json FROM provider_session_runtime WHERE thread_id = ?").get(threadId) as { runtime_payload_json: string } | undefined;
              if (runtimeRow) {
                try {
                  const runtimePayload = JSON.parse(runtimeRow.runtime_payload_json) as Record<string, unknown>;
                  if (typeof runtimePayload.cwd === "string" && !existsSync(runtimePayload.cwd)) {
                    let fallbackCwd = "";
                    if (projectId) {
                      const proj = db.prepare("SELECT workspace_root FROM projection_projects WHERE project_id = ?").get(projectId) as { workspace_root: string } | undefined;
                      if (proj?.workspace_root && existsSync(proj.workspace_root)) {
                        fallbackCwd = proj.workspace_root;
                      }
                    }
                    runtimePayload.cwd = fallbackCwd || homedir();
                    db.prepare("UPDATE provider_session_runtime SET runtime_payload_json = ? WHERE thread_id = ?").run(JSON.stringify(runtimePayload), threadId);
                  }
                } catch {}
              }
            }
          }
          actions.push(`cleared dead worktree (${currentWorktree})`);
          clearedWorktrees += 1;
        }

        // Sanitize legacy messages
        const dirtyLegacyMsgs = db.prepare(`
          SELECT message_id, text FROM projection_thread_messages
          WHERE thread_id = ?
            AND (text LIKE '%<oai-mem-citation>%' OR text LIKE '%<external_codex_apps_open_page>%' OR text LIKE '%## My request:%')
        `).all(threadId) as Array<{ message_id: string; text: string }>;
        if (dirtyLegacyMsgs.length > 0) {
          if (!options.dryRun) {
            const updateLegacy = db.prepare("UPDATE projection_thread_messages SET text = ? WHERE message_id = ?");
            for (const msg of dirtyLegacyMsgs) {
              updateLegacy.run(sanitizeMessageText(msg.text), msg.message_id);
            }
          }
          actions.push(`sanitized ${dirtyLegacyMsgs.length} messages`);
          sanitizedMessages += dirtyLegacyMsgs.length;
        }

        // Sanitize v2 projection messages if any
        const dirtyV2Msgs = db.prepare(`
          SELECT message_id, payload_json FROM orchestration_v2_projection_messages
          WHERE thread_id = ?
            AND (payload_json LIKE '%<oai-mem-citation>%' OR payload_json LIKE '%<external_codex_apps_open_page>%' OR payload_json LIKE '%## My request:%')
        `).all(threadId) as Array<{ message_id: string; payload_json: string }>;
        if (dirtyV2Msgs.length > 0 && !options.dryRun) {
          const updateV2 = db.prepare("UPDATE orchestration_v2_projection_messages SET payload_json = ? WHERE message_id = ?");
          for (const msg of dirtyV2Msgs) {
            try {
              const p = JSON.parse(msg.payload_json) as Record<string, unknown>;
              if (typeof p.text === "string") {
                p.text = sanitizeMessageText(p.text);
                updateV2.run(JSON.stringify(p), msg.message_id);
              }
            } catch {}
          }
        }

        if (!hasV2ThreadCreatedEvent(db, threadId)) {
          let dropped = 0;
          if (!options.dryRun) {
            for (const table of dropChildRows) {
              dropped += db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId).changes;
            }
          }
          if (dropped > 0) {
            actions.push("cleared synthetic v2 projection rows");
            droppedRows += dropped;
          }
        }

        if (actions.length === 0) continue;
        details.push({ threadId, title: threadTitle, actions });
      }
    });
    run();

    if (details.length === 0) {
      return { schemaVersion: 1, status: "noop", target: paths.dbPath, backup: null, threads: 0, legacyThreads: 0, legacyMessages: 0, fixedSources: 0, clearedWorktrees: 0, sanitizedMessages: 0, droppedProjectionRows: 0, details, warnings: [] };
    }
    const backup = options.dryRun ? null : createBackup(db, paths);
    return {
      schemaVersion: 1,
      status: options.dryRun ? "dry-run" : "repaired",
      target: paths.dbPath,
      backup,
      threads: details.length,
      legacyThreads,
      legacyMessages,
      fixedSources,
      clearedWorktrees,
      sanitizedMessages,
      droppedProjectionRows: droppedRows,
      details,
      warnings: [],
    };
  } finally {
    db.close();
  }
}
