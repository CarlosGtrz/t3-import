import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type {
  CanonicalConversation,
  CanonicalThread,
  ConversationReplacePreview,
  ReplaceItemResult,
  ReplaceRunResult,
  ReplaceSelection,
  TargetPaths,
} from "../core/types.js";
import { isTerminalTurn } from "../core/types.js";
import { checkpointForThread } from "../core/checkpoint.js";
import { deterministicUuid, isObject, stringValue } from "../core/util.js";
import { safetyError, writeError } from "../core/errors.js";
import type { TargetOverrides } from "./config.js";
import { recordReplacement, type LedgerRecord, type StoredLedgerRecord } from "./ledger.js";
import { assertT3Closed, SUPPORTED_MIGRATION, validateTargetDatabase } from "./schema.js";
import {
  IMPORTER_VERSION,
  MAX_SAFE_IMPORT_EVENTS,
  acquireLock,
  compactThreadForImport,
  createBackup,
  event,
  materializeAssets,
  modelSelection,
  planThread,
  projectionBacklog,
  type PlannedThread,
} from "./importer.js";
import { bootstrapCheckpoint, createEvent, existingProvider, findRecord, readEvents, targetId } from "./sync.js";

export interface ReplaceOptions extends TargetOverrides {
  dryRun: boolean;
}

interface RuntimeRow {
  providerName: "codex" | "claudeAgent";
  instanceId: string;
  adapterKey: "codex" | "claudeAgent";
  runtimeMode: string;
  status: string;
  lastSeenAt: string;
  resumeCursorJson: string | null;
  runtimePayloadJson: string | null;
}

interface ReplacePlan {
  conversation: CanonicalConversation;
  thread: CanonicalThread;
  oldRecord?: StoredLedgerRecord;
  planned?: PlannedThread;
  deleteEvent?: ReturnType<typeof event>;
  runtime?: RuntimeRow;
  result: ReplaceItemResult;
}

const conflictStatuses = new Set<ReplaceItemResult["status"]>([
  "not-imported", "active-source", "branch-replace-unsupported", "target-missing",
]);

export function replacementThreadId(sourceKey: string, oldThreadId: string): string {
  return deterministicUuid(`t3-import:replacement:${sourceKey}:${oldThreadId}`);
}

export function replacementIdentitySeed(sourceKey: string, oldThreadId: string): string {
  return `replacement:${sourceKey}:${oldThreadId}`;
}

function selectedThread(conversation: CanonicalConversation): CanonicalThread | undefined {
  return conversation.threads.find((thread) => thread.currentBranch) ?? conversation.threads[0];
}

function runtimeRow(db: Database.Database, threadId: string): RuntimeRow | undefined {
  return db.prepare(`
    SELECT provider_name providerName, provider_instance_id instanceId, adapter_key adapterKey,
      runtime_mode runtimeMode, status, last_seen_at lastSeenAt,
      resume_cursor_json resumeCursorJson, runtime_payload_json runtimePayloadJson
    FROM provider_session_runtime WHERE thread_id = ?
  `).get(threadId) as RuntimeRow | undefined;
}

function isDeleted(db: Database.Database, threadId: string, events: ReturnType<typeof readEvents>): boolean {
  if (events.some((row) => row.type === "thread.deleted")) return true;
  const table = db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='projection_threads'").get();
  if (!table) return false;
  const row = db.prepare("SELECT deleted_at deletedAt FROM projection_threads WHERE thread_id = ?").get(threadId) as { deletedAt: string | null } | undefined;
  return Boolean(row?.deletedAt);
}

function replacementMarker(events: ReturnType<typeof readEvents>): Record<string, unknown> | undefined {
  const metadata = createEvent(events)?.metadata.t3Import;
  return isObject(metadata) ? metadata : undefined;
}

function checkpointMatches(record: StoredLedgerRecord, thread: CanonicalThread, events: ReturnType<typeof readEvents>): boolean {
  const checkpoint = record.checkpoint ?? bootstrapCheckpoint(thread, record, events)?.checkpoint;
  if (!checkpoint || checkpoint.version !== 2 || checkpoint.turns.length !== thread.turns.length) return false;
  return JSON.stringify(checkpoint) === JSON.stringify(checkpointForThread(thread));
}

function item(
  thread: CanonicalThread,
  status: ReplaceItemResult["status"],
  warning: string | undefined,
  record?: StoredLedgerRecord,
): ReplaceItemResult {
  return {
    source: thread.source, sourceId: thread.sourceSessionId, sourceKey: thread.sourceKey,
    status, ...(record ? { oldThreadId: record.threadId, projectId: record.projectId } : {}),
    title: thread.title, turns: thread.turns.length, events: 0, attachments: 0,
    resumeTransferred: false, warnings: [...thread.warnings, ...(warning ? [warning] : [])],
  };
}

function buildPlan(db: Database.Database, paths: TargetPaths, conversation: CanonicalConversation, dryRun: boolean): ReplacePlan {
  const source = selectedThread(conversation);
  if (!source) throw writeError(`Conversation ${conversation.summary.id} has no importable task.`);
  const active = source.turns.some((turn) => !isTerminalTurn(turn)) || (source.ignoredInProgressTurns ?? 0) > 0;
  const thread = compactThreadForImport({ ...source, turns: source.turns.filter(isTerminalTurn) });
  const match = findRecord(db, paths, thread);
  if (!match.record) {
    return { conversation, thread, result: item(thread, match.stale ? "target-missing" : "not-imported", match.stale ? "The canonical ledger entry is stale because its T3 task is missing." : "Conversation has not been imported into this T3 database.") };
  }
  const record = match.record;
  const oldEvents = readEvents(db, record.threadId);
  if (!createEvent(oldEvents) || isDeleted(db, record.threadId, oldEvents)) {
    return { conversation, thread, oldRecord: record, result: item(thread, "target-missing", "The canonical T3 task is missing or deleted.", record) };
  }
  if (active) return { conversation, thread, oldRecord: record, result: item(thread, "active-source", "The provider conversation has an active or indeterminate turn. Retry replacement after it settles.", record) };
  if (thread.source === "claude" && conversation.summary.branches !== 1) {
    return { conversation, thread, oldRecord: record, result: item(thread, "branch-replace-unsupported", "Claude replacement requires exactly one non-sidechain leaf.", record) };
  }
  const marker = replacementMarker(oldEvents);
  if (marker?.canonical === true && typeof marker.replacesThreadId === "string" && checkpointMatches(record, thread, oldEvents)) {
    return { conversation, thread, oldRecord: record, result: item(thread, "already-current", undefined, record) };
  }

  const newThreadId = replacementThreadId(thread.sourceKey, record.threadId);
  const seed = replacementIdentitySeed(thread.sourceKey, record.threadId);
  const provider = existingProvider(db, thread, record, oldEvents);
  const runtime = runtimeRow(db, record.threadId);
  const resumable = record.resumable && Boolean(runtime?.resumeCursorJson ?? thread.resumeCursor);
  const metadata = {
    t3Import: {
      schemaVersion: 1,
      source: thread.source,
      sourceSessionId: thread.sourceSessionId,
      sourceKey: thread.sourceKey,
      identitySeed: seed,
      canonical: true,
      replacesThreadId: record.threadId,
    },
  };
  const planned = planThread(thread, newThreadId, record.projectId, paths, provider, seed, undefined, resumable, conversation.fingerprint, 0, true, metadata);
  const deletedAt = new Date().toISOString();
  const deletion = event(seed, "replaced-thread.deleted", "thread", record.threadId, "thread.deleted", deletedAt, "client", {
    threadId: record.threadId, deletedAt,
  }, { replacedByThreadId: newThreadId, source: "t3-import" });
  const result: ReplaceItemResult = {
    ...item(thread, dryRun ? "dry-run" : "replaced", undefined, record),
    newThreadId, events: planned.events.length + 1, attachments: planned.assets.length,
    resumeTransferred: resumable,
  };
  return { conversation, thread, oldRecord: record, planned, deleteEvent: deletion, ...(runtime ? { runtime } : {}), result };
}

function aggregate(results: ReplaceItemResult[], dryRun: boolean): ReplaceRunResult["status"] {
  if (dryRun && results.some((result) => result.status === "dry-run")) return "dry-run";
  const conflict = results.some((result) => conflictStatuses.has(result.status));
  const replaced = results.some((result) => result.status === "replaced");
  if (conflict && replaced) return "mixed";
  if (conflict) return "conflict";
  if (replaced) return "replaced";
  return "already-current";
}

export async function inspectConversationReplacement(conversation: CanonicalConversation, paths: TargetPaths): Promise<ConversationReplacePreview> {
  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    validateTargetDatabase(db);
    const plan = buildPlan(db, paths, conversation, false);
    const status: ConversationReplacePreview["status"] = plan.result.status === "replaced" ? "replaceable" : plan.result.status as ConversationReplacePreview["status"];
    return {
      sourceId: plan.result.sourceId, status,
      selectable: status === "replaceable", previouslyImported: status !== "not-imported",
      turns: plan.result.turns, events: plan.result.events, attachments: plan.result.attachments,
      ...(plan.result.oldThreadId ? { oldThreadId: plan.result.oldThreadId } : {}),
      ...(plan.result.newThreadId ? { newThreadId: plan.result.newThreadId } : {}),
      warnings: plan.result.warnings,
    };
  } finally { db.close(); }
}

export async function replaceConversations(selections: ReplaceSelection[], paths: TargetPaths, options: ReplaceOptions): Promise<ReplaceRunResult> {
  if (!existsSync(paths.dbPath)) throw safetyError(`T3 database not found: ${paths.dbPath}`);
  await assertT3Closed(paths);
  const releaseLock = options.dryRun ? () => {} : acquireLock(paths);
  const db = new Database(paths.dbPath, { readonly: options.dryRun, fileMustExist: true });
  let backup: string | null = null;
  const warnings: string[] = [];
  try {
    const schema = validateTargetDatabase(db);
    const plans = selections.map((selection) => buildPlan(db, paths, selection.conversation, options.dryRun));
    const writable = plans.filter((plan) => plan.planned && plan.deleteEvent && plan.oldRecord);
    if (writable.length > 0) {
      const backlog = projectionBacklog(db);
      if (backlog.backlog > 0) throw safetyError(`T3 has ${backlog.backlog} unprojected event${backlog.backlog === 1 ? "" : "s"}. Open T3 and let it finish loading before replacing conversations.`);
      const count = writable.reduce((sum, plan) => sum + plan.planned!.events.length + 1, 0);
      if (count > MAX_SAFE_IMPORT_EVENTS) throw safetyError(`Replacement would append ${count} events, exceeding the safe one-launch limit of ${MAX_SAFE_IMPORT_EVENTS}. Replace fewer conversations at a time.`);
    }
    if (options.dryRun || writable.length === 0) {
      const results = plans.map((plan) => plan.result);
      return { schemaVersion: 1, status: aggregate(results, options.dryRun), target: paths.dbPath, migration: schema.migration, backup: null, results, warnings, hasConflicts: results.some((result) => conflictStatuses.has(result.status)) };
    }

    backup = createBackup(db, paths);
    mkdirSync(paths.attachmentsDir, { recursive: true });
    const assets = materializeAssets(writable.map((plan) => plan.planned!), paths, randomUUID());
    const ledgerUpdates: Array<{ old: StoredLedgerRecord; next: LedgerRecord }> = [];
    try {
      const nextVersion = db.prepare("SELECT COALESCE(MAX(stream_version), -1) + 1 nextVersion FROM orchestration_events WHERE aggregate_kind = ? AND stream_id = ?");
      const insert = db.prepare(`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`);
      const deleteRuntime = db.prepare("DELETE FROM provider_session_runtime WHERE thread_id = ?");
      const upsertRuntime = db.prepare(`
        INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json)
        VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET provider_name=excluded.provider_name, provider_instance_id=excluded.provider_instance_id, adapter_key=excluded.adapter_key, runtime_mode=excluded.runtime_mode, status='stopped', last_seen_at=excluded.last_seen_at, resume_cursor_json=excluded.resume_cursor_json, runtime_payload_json=excluded.runtime_payload_json
      `);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const plan of writable) {
          const planned = plan.planned!;
          const old = plan.oldRecord!;
          let first = Number.MAX_SAFE_INTEGER;
          let last = 0;
          let newVersion = (nextVersion.get("thread", planned.threadId) as { nextVersion: number }).nextVersion;
          for (const row of planned.events) {
            const inserted = insert.run(row.eventId, row.aggregateKind, row.streamId, newVersion++, row.type, row.occurredAt, row.actorKind, JSON.stringify(row.payload), JSON.stringify(row.metadata));
            const sequence = Number(inserted.lastInsertRowid);
            first = Math.min(first, sequence); last = Math.max(last, sequence);
          }
          const deletion = plan.deleteEvent!;
          const oldVersion = (nextVersion.get("thread", old.threadId) as { nextVersion: number }).nextVersion;
          const deleted = insert.run(deletion.eventId, deletion.aggregateKind, deletion.streamId, oldVersion, deletion.type, deletion.occurredAt, deletion.actorKind, JSON.stringify(deletion.payload), JSON.stringify(deletion.metadata));
          const deleteSequence = Number(deleted.lastInsertRowid);
          first = Math.min(first, deleteSequence); last = Math.max(last, deleteSequence);

          if (plan.result.resumeTransferred) {
            const runtime = plan.runtime;
            let cursor: Record<string, unknown> | undefined;
            try { cursor = runtime?.resumeCursorJson ? JSON.parse(runtime.resumeCursorJson) as Record<string, unknown> : planned.thread.resumeCursor; } catch { cursor = planned.thread.resumeCursor; }
            if (cursor && planned.thread.source === "claude") cursor = { ...cursor, threadId: planned.threadId };
            upsertRuntime.run(
              planned.threadId, runtime?.providerName ?? planned.provider.providerName,
              runtime?.instanceId ?? planned.provider.instanceId, runtime?.adapterKey ?? planned.provider.adapterKey,
              runtime?.runtimeMode ?? "full-access", planned.thread.updatedAt,
              cursor ? JSON.stringify(cursor) : null,
              runtime?.runtimePayloadJson ?? JSON.stringify({ cwd: planned.thread.workspace, model: planned.provider.model, activeTurnId: null, lastError: null, modelSelection: modelSelection(planned.provider), lastRuntimeEvent: `t3-import.replace.${planned.thread.source}`, lastRuntimeEventAt: planned.thread.updatedAt }),
            );
          }
          deleteRuntime.run(old.threadId);
          plan.result.sequence = { first, last };
          const replacedAt = new Date().toISOString();
          ledgerUpdates.push({ old, next: {
            targetId: targetId(paths), source: planned.thread.source, sourceSessionId: planned.thread.sourceSessionId,
            sourceKey: planned.thread.sourceKey, sourceFingerprint: plan.conversation.fingerprint,
            projectId: planned.projectId, threadId: planned.threadId, importedAt: replacedAt,
            importerVersion: IMPORTER_VERSION, migration: SUPPORTED_MIGRATION, firstSequence: first,
            lastSequence: last, resumable: plan.result.resumeTransferred, backupPath: backup!,
            warnings: plan.result.warnings, identitySeed: replacementIdentitySeed(planned.thread.sourceKey, old.threadId),
            currentSourceKey: planned.thread.sourceKey, ...(planned.thread.leafId ? { sourceLeafId: planned.thread.leafId } : {}),
            sourceTitle: planned.thread.title, checkpoint: checkpointForThread(planned.thread), syncedAt: replacedAt,
            isCanonical: true, replacedAt,
          } });
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      assets.cleanup();
    } catch (error) {
      for (const path of assets.created) rmSync(path, { force: true });
      assets.cleanup();
      throw error;
    }
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw writeError(`Post-replacement integrity check failed: ${integrity}`);
    for (const update of ledgerUpdates) {
      try { recordReplacement(update.old, update.next); }
      catch (error) { warnings.push(`Replacement succeeded, but the external ledger could not be updated: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const results = plans.map((plan) => plan.result);
    return { schemaVersion: 1, status: aggregate(results, false), target: paths.dbPath, migration: schema.migration, backup, results, warnings, hasConflicts: results.some((result) => conflictStatuses.has(result.status)) };
  } catch (error) {
    if (error instanceof Error && error.name === "ImporterError") throw error;
    throw writeError(`Replacement failed: ${error instanceof Error ? error.message : String(error)}`, error);
  } finally {
    db.close();
    releaseLock();
  }
}
