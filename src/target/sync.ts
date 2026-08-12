import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type {
  CanonicalConversation,
  CanonicalThread,
  ConversationSyncPreview,
  SyncItemResult,
  SyncRunResult,
  SyncSelection,
  TargetPaths,
  CanonicalTerminalTurnStatus,
} from "../core/types.js";
import { isTerminalTurn } from "../core/types.js";
import { checkpointForThread, legacyTurnSemanticHash, turnSemanticHash, type ImportCheckpoint, type ImportCheckpointV2 } from "../core/checkpoint.js";
import { canonicalPath, deterministicUuid, isObject, sha256, stringValue } from "../core/util.js";
import { safetyError, writeError } from "../core/errors.js";
import type { ProviderSelection, TargetOverrides } from "./config.js";
import { assertT3Closed, SUPPORTED_MIGRATION, validateTargetDatabase } from "./schema.js";
import { listImports, recordImports, type LedgerRecord, type StoredLedgerRecord } from "./ledger.js";
import {
  IMPORTER_VERSION,
  MAX_SAFE_IMPORT_EVENTS,
  acquireLock,
  compactThreadForImport,
  createBackup,
  event,
  materializeAssets,
  planThread,
  projectionBacklog,
  type PlannedThread,
} from "./importer.js";

export interface SyncOptions extends TargetOverrides {
  dryRun: boolean;
  /** Internal TUI bridge: a preceding import in this process created the backlog. */
  allowProjectionBacklog?: boolean;
}

interface SyncPlan {
  conversation: CanonicalConversation;
  thread: CanonicalThread;
  record?: StoredLedgerRecord;
  result: SyncItemResult;
  planned?: PlannedThread;
  checkpoint?: ImportCheckpoint;
  titleEvent: boolean;
  previouslyImported: boolean;
  adoptionSequence?: number;
}

export interface EventRow {
  sequence: number;
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export function targetId(paths: TargetPaths): string {
  return sha256(canonicalPath(paths.dbPath));
}

export function readEvents(db: Database.Database, threadId: string): EventRow[] {
  const rows = db.prepare(`
    SELECT sequence, event_id eventId, event_type type, payload_json payload, metadata_json metadata
    FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ? ORDER BY sequence
  `).all(threadId) as Array<{ sequence: number; eventId: string; type: string; payload: string; metadata: string }>;
  return rows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload) as unknown;
      const metadata = JSON.parse(row.metadata) as unknown;
      return isObject(payload) && isObject(metadata) ? [{ ...row, payload, metadata }] : [];
    } catch { return []; }
  });
}

export function createEvent(events: EventRow[]): EventRow | undefined {
  return events.find((row) => row.type === "thread.created");
}

export function currentTitle(db: Database.Database, threadId: string, events: EventRow[]): string {
  const table = db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='projection_threads'").get();
  if (table) {
    const row = db.prepare("SELECT title FROM projection_threads WHERE thread_id = ? AND deleted_at IS NULL").get(threadId) as { title: string } | undefined;
    if (row?.title) return row.title;
  }
  for (const row of [...events].reverse()) {
    if (row.type === "thread.meta-updated") {
      const title = stringValue(row.payload.title);
      if (title) return title;
    }
  }
  return stringValue(createEvent(events)?.payload.title) ?? "Imported conversation";
}

export function existingProvider(db: Database.Database, thread: CanonicalThread, record: StoredLedgerRecord, events: EventRow[]): ProviderSelection {
  const runtime = db.prepare(`
    SELECT provider_name providerName, provider_instance_id instanceId, adapter_key adapterKey
    FROM provider_session_runtime WHERE thread_id = ?
  `).get(record.threadId) as { providerName: "codex" | "claudeAgent"; instanceId: string; adapterKey: "codex" | "claudeAgent" } | undefined;
  const createdSelection = createEvent(events)?.payload.modelSelection;
  const selection = isObject(createdSelection) ? createdSelection : {};
  const options = Array.isArray(selection.options)
    ? selection.options.filter((value): value is { id: string; value: string | boolean } => isObject(value) && typeof value.id === "string" && (typeof value.value === "string" || typeof value.value === "boolean"))
    : [];
  const providerName = runtime?.providerName ?? (thread.source === "codex" ? "codex" : "claudeAgent");
  return {
    providerName,
    instanceId: runtime?.instanceId ?? stringValue(selection.instanceId) ?? providerName,
    adapterKey: runtime?.adapterKey ?? providerName,
    model: stringValue(selection.model) ?? thread.model,
    options,
  };
}

function canonicalMarker(seed: string): string {
  return deterministicUuid(`t3-import:event:${seed}:thread.created`);
}

export function validRecord(db: Database.Database, record: StoredLedgerRecord): boolean {
  return Boolean(db.prepare(`
    SELECT 1 found FROM orchestration_events
    WHERE stream_id = ? AND event_type = 'thread.created' AND event_id = ? LIMIT 1
  `).get(record.threadId, canonicalMarker(record.identitySeed)));
}

export function fallbackRecord(db: Database.Database, paths: TargetPaths, thread: CanonicalThread): StoredLedgerRecord | undefined {
  let threadId: string | undefined;
  let seed = thread.sourceKey;
  if (thread.source === "codex") {
    threadId = thread.sourceSessionId;
  } else {
    const candidates = db.prepare("SELECT thread_id threadId, resume_cursor_json cursor FROM provider_session_runtime WHERE provider_name = 'claudeAgent'").all() as Array<{ threadId: string; cursor: string | null }>;
    for (const candidate of candidates) {
      try {
        const cursor = candidate.cursor ? JSON.parse(candidate.cursor) as Record<string, unknown> : {};
        if (cursor.resume !== thread.sourceSessionId) continue;
        threadId = candidate.threadId;
        const leaf = stringValue(cursor.resumeSessionAt);
        if (leaf) seed = `claude:${thread.sourceSessionId}:${leaf}`;
        break;
      } catch { /* continue */ }
    }
  }
  if (!threadId) return undefined;
  const events = readEvents(db, threadId);
  // Early 0.1 builds used the bare Codex session ID as their deterministic
  // event seed. Discovery now exposes `codex:<session-id>`, but the imported
  // stream and provider thread ID remain the bare UUID. Accept both markers
  // and retain the marker's original seed so checkpoint IDs can be rebuilt.
  const seeds = thread.source === "codex"
    ? [thread.sourceKey, thread.sourceSessionId]
    : [seed];
  const matched = seeds
    .map((candidate) => ({ candidate, created: events.find((row) => row.eventId === canonicalMarker(candidate)) }))
    .find((candidate) => candidate.created);
  const created = matched?.created;
  if (!created) return undefined;
  seed = matched!.candidate;
  const projectId = stringValue(created.payload.projectId);
  if (!projectId) return undefined;
  return {
    targetId: targetId(paths), source: thread.source, sourceSessionId: thread.sourceSessionId,
    sourceKey: seed, sourceFingerprint: "", projectId, threadId,
    importedAt: stringValue(created.payload.createdAt) ?? thread.createdAt,
    importerVersion: "legacy", migration: SUPPORTED_MIGRATION,
    firstSequence: created.sequence, lastSequence: events.at(-1)?.sequence ?? created.sequence,
    resumable: true, backupPath: "", warnings: [], identitySeed: seed,
    currentSourceKey: seed, sourceTitle: stringValue(created.payload.title) ?? thread.title,
    isCanonical: true,
  };
}

function replacementMetadataRecord(db: Database.Database, paths: TargetPaths, thread: CanonicalThread): StoredLedgerRecord | undefined {
  const rows = db.prepare(`
    SELECT stream_id threadId, sequence, payload_json payload, metadata_json metadata
    FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND event_type = 'thread.created'
    ORDER BY sequence DESC
  `).all() as Array<{ threadId: string; sequence: number; payload: string; metadata: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as unknown;
      const metadata = JSON.parse(row.metadata) as unknown;
      if (!isObject(payload) || !isObject(metadata) || !isObject(metadata.t3Import)) continue;
      const marker = metadata.t3Import;
      if (marker.canonical !== true || marker.source !== thread.source || marker.sourceSessionId !== thread.sourceSessionId) continue;
      const events = readEvents(db, row.threadId);
      if (events.some((candidate) => candidate.type === "thread.deleted")) continue;
      const projectId = stringValue(payload.projectId);
      const identitySeed = stringValue(marker.identitySeed);
      const sourceKey = stringValue(marker.sourceKey) ?? thread.sourceKey;
      if (!projectId || !identitySeed) continue;
      return {
        targetId: targetId(paths), source: thread.source, sourceSessionId: thread.sourceSessionId,
        sourceKey, sourceFingerprint: "", projectId, threadId: row.threadId,
        importedAt: stringValue(payload.createdAt) ?? thread.createdAt, importerVersion: "metadata-recovered",
        migration: SUPPORTED_MIGRATION, firstSequence: row.sequence,
        lastSequence: events.at(-1)?.sequence ?? row.sequence, resumable: true, backupPath: "",
        warnings: ["Recovered canonical replacement identity from T3 event metadata."], identitySeed,
        currentSourceKey: sourceKey, sourceTitle: stringValue(payload.title) ?? thread.title,
        isCanonical: true,
      };
    } catch { /* continue */ }
  }
  return undefined;
}

export function findRecord(db: Database.Database, paths: TargetPaths, thread: CanonicalThread): { record?: StoredLedgerRecord; stale: boolean } {
  const candidates = listImports(targetId(paths), thread.source).filter((row) => row.sourceSessionId === thread.sourceSessionId);
  const canonicalCandidates = candidates.filter((row) => row.isCanonical === true || (row.isCanonical === undefined && validRecord(db, row) && row.identitySeed === row.sourceKey));
  const valid = canonicalCandidates.filter((row) => validRecord(db, row));
  if (thread.source === "codex") {
    const record = valid.find((row) =>
      (row.sourceKey === thread.sourceKey || row.currentSourceKey === thread.sourceKey),
    ) ?? replacementMetadataRecord(db, paths, thread) ?? fallbackRecord(db, paths, thread);
    return { ...(record ? { record } : {}), stale: canonicalCandidates.length > 0 && valid.length === 0 };
  }
  const resumable = valid.find((row) => row.resumable);
  const record = resumable ?? (valid.length === 1 ? valid[0] : undefined) ?? replacementMetadataRecord(db, paths, thread) ?? fallbackRecord(db, paths, thread);
  return { ...(record ? { record } : {}), stale: canonicalCandidates.length > 0 && valid.length === 0 };
}

export function bootstrapCheckpoint(thread: CanonicalThread, record: StoredLedgerRecord, events: EventRow[]): { checkpoint: ImportCheckpoint; lastSequence: number } | undefined {
  const byId = new Map(events.map((row) => [row.eventId, row]));
  const importedEvent = (...keys: string[]): EventRow | undefined => keys
    .map((key) => byId.get(deterministicUuid(`t3-import:event:${record.identitySeed}:${key}`)))
    .find((row) => row !== undefined);
  const turns: ImportCheckpointV2["turns"] = [];
  let lastSequence = record.firstSequence;
  for (const [index, turn] of thread.turns.entries()) {
    // The initial one-off Codex importer used longer event-key suffixes. Its
    // payloads and provider IDs are canonical, so validate them identically
    // while accepting either deterministic layout.
    const user = importedEvent(`turn.${index}.user`, `turn.${index}.user-message`);
    const start = importedEvent(`turn.${index}.start`, `turn.${index}.start-requested`);
    const running = importedEvent(`turn.${index}.running`, `turn.${index}.session-running`);
    const settled = importedEvent(`turn.${index}.settled`, `turn.${index}.session-ready`);
    if (!user || !start || !running || !settled) break;
    if (stringValue(user.payload.text) !== turn.user.text || stringValue(running.metadata.providerTurnId) !== turn.id) return undefined;
    const assistant = events
      .filter((row) => row.sequence > user.sequence && row.sequence < settled.sequence && row.type === "thread.message-sent" && row.payload.role === "assistant")
      .map((row) => stringValue(row.payload.text) ?? "");
    if (assistant.join("\n\u0000\n") !== turn.assistant.map((message) => message.text).join("\n\u0000\n")) return undefined;
    const status = terminalStatusFromEvent(settled);
    if (!status || status !== turn.status) return undefined;
    turns.push({ id: turn.id, status, ...(turn.terminalReason ? { terminalReason: turn.terminalReason } : {}), ...(turn.terminalError ? { terminalError: turn.terminalError } : {}), hash: turnSemanticHash(turn) });
    lastSequence = Math.max(lastSequence, settled.sequence);
  }
  return turns.length > 0 ? { checkpoint: { version: 2, turns }, lastSequence } : undefined;
}

function verifiedSourcePrefixLength(thread: CanonicalThread, checkpoint: ImportCheckpoint): number | undefined {
  if (checkpoint.version === 1) {
    let sourceIndex = 0;
    for (const saved of checkpoint.turns) {
      while (thread.turns[sourceIndex] && thread.turns[sourceIndex]!.status !== "completed") sourceIndex += 1;
      const current = thread.turns[sourceIndex];
      if (!current || current.id !== saved.id || legacyTurnSemanticHash(current) !== saved.hash) return undefined;
      sourceIndex += 1;
    }
    return sourceIndex;
  }
  if (thread.turns.length < checkpoint.turns.length) return undefined;
  const valid = checkpoint.turns.every((saved, index) => {
    const current = thread.turns[index];
    return Boolean(current && current.id === saved.id && current.status === saved.status && current.terminalReason === saved.terminalReason && current.terminalError === saved.terminalError && turnSemanticHash(current) === saved.hash);
  });
  return valid ? checkpoint.turns.length : undefined;
}

function terminalStatusFromEvent(row: EventRow | undefined): CanonicalTerminalTurnStatus | undefined {
  if (!row || row.type !== "thread.session-set" || !isObject(row.payload.session)) return undefined;
  switch (stringValue(row.payload.session.status)) {
    case "ready":
    case "idle": return "completed";
    case "interrupted":
    case "stopped": return "interrupted";
    case "error": return "failed";
    default: return undefined;
  }
}

function settledProviderTurns(events: EventRow[], afterSequence: number): Array<{ id: string; status: CanonicalTerminalTurnStatus }> {
  return events.flatMap((row) => {
    if (row.sequence <= afterSequence) return [];
    const id = stringValue(row.metadata.providerTurnId);
    const status = terminalStatusFromEvent(row);
    return id && status ? [{ id, status }] : [];
  });
}

function codexAdoptedTurns(thread: CanonicalThread, start: number, events: EventRow[], afterSequence: number): number {
  const settled = settledProviderTurns(events, afterSequence);
  const byId = new Map(settled.map((entry) => [entry.id, entry.status]));
  let adopted = 0;
  while (thread.turns[start + adopted] && byId.has(thread.turns[start + adopted]!.id)) {
    const turn = thread.turns[start + adopted]!;
    if (byId.get(turn.id) !== turn.status) return -1;
    adopted += 1;
  }
  if (thread.turns.slice(start + adopted + 1).some((turn) => byId.has(turn.id))) return -1;
  return adopted;
}

function sourceAttachments(turn: CanonicalThread["turns"][number]): Array<{ name: string; mimeType: string; sizeBytes: number }> {
  return turn.user.attachments.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }));
}

function eventAttachments(row: EventRow | undefined): Array<{ name: string; mimeType: string; sizeBytes: number }> | undefined {
  if (!row) return undefined;
  if (!Array.isArray(row.payload.attachments)) return [];
  const attachments = row.payload.attachments.flatMap((value) => {
    if (!isObject(value)) return [];
    const name = stringValue(value.name);
    const mimeType = stringValue(value.mimeType);
    const sizeBytes = typeof value.sizeBytes === "number" ? value.sizeBytes : undefined;
    return name && mimeType && sizeBytes !== undefined ? [{ name, mimeType, sizeBytes }] : [];
  });
  return attachments.length === row.payload.attachments.length ? attachments : undefined;
}

function claudeAdoptedTurns(thread: CanonicalThread, start: number, events: EventRow[], afterSequence: number): number {
  const messages = events.filter((row) => row.sequence > afterSequence && row.type === "thread.message-sent" && (row.payload.role === "user" || row.payload.role === "assistant"));
  let cursor = 0;
  let adopted = 0;
  const settled = settledProviderTurns(events, afterSequence);
  for (const turn of thread.turns.slice(start)) {
    const expected = [{ role: "user", text: turn.user.text }, ...turn.assistant.map((message) => ({ role: "assistant", text: message.text }))];
    const rows = messages.slice(cursor, cursor + expected.length);
    if (rows.length === 0) break;
    const actual = rows.map((row) => ({ role: row.payload.role, text: stringValue(row.payload.text) ?? "" }));
    const attachments = eventAttachments(rows[0]);
    if (JSON.stringify(actual) !== JSON.stringify(expected) || attachments === undefined || JSON.stringify(attachments) !== JSON.stringify(sourceAttachments(turn))) return -1;
    if (!settled[adopted] || settled[adopted]!.status !== turn.status) return -1;
    cursor += expected.length;
    adopted += 1;
  }
  return cursor === messages.length ? adopted : -1;
}

function conflictResult(thread: CanonicalThread, status: SyncItemResult["status"], warning: string, record?: StoredLedgerRecord): SyncItemResult {
  return {
    source: thread.source, sourceId: thread.sourceSessionId, sourceKey: thread.sourceKey,
    status, ...(record ? { threadId: record.threadId, projectId: record.projectId } : {}),
    title: thread.title, turnsAdded: 0, turnsAdopted: 0, events: 0, attachments: 0,
    titleAction: "unchanged", resumable: Boolean(record?.resumable), warnings: [warning],
  };
}

function buildPlan(db: Database.Database, paths: TargetPaths, conversation: CanonicalConversation, dryRun: boolean): SyncPlan {
  const sourceThread = conversation.threads.find((thread) => thread.currentBranch) ?? conversation.threads[0];
  if (!sourceThread) throw writeError(`Conversation ${conversation.summary.id} has no importable task.`);
  const thread = compactThreadForImport({ ...sourceThread, turns: sourceThread.turns.filter(isTerminalTurn) });
  if (thread.turns.length === 0 && (thread.ignoredInProgressTurns ?? 0) > 0) {
    const result = conflictResult(thread, "not-imported", "Conversation has no terminal turns; its active turn was ignored.");
    return { conversation, thread, result, titleEvent: false, previouslyImported: false };
  }
  const match = findRecord(db, paths, thread);
  if (!match.record) {
    const result = conflictResult(thread, "not-imported", match.stale ? "The ledger entry is stale because its T3 task is missing." : "Conversation has not been imported into this T3 database.");
    return { conversation, thread, result, titleEvent: false, previouslyImported: match.stale };
  }
  const record = match.record;
  const events = readEvents(db, record.threadId);
  if (!createEvent(events)) return { conversation, thread, record, result: conflictResult(thread, "target-missing", "The imported T3 task no longer exists.", record), titleEvent: false, previouslyImported: true };
  if (thread.source === "claude" && conversation.summary.branches !== 1) {
    return { conversation, thread, record, result: conflictResult(thread, "branch-sync-unsupported", "Claude synchronization currently requires exactly one non-sidechain leaf.", record), titleEvent: false, previouslyImported: true };
  }
  const bootstrapped = record.checkpoint ? undefined : bootstrapCheckpoint(thread, record, events);
  const checkpoint = record.checkpoint ?? bootstrapped?.checkpoint;
  const sourcePrefixLength = checkpoint ? verifiedSourcePrefixLength(thread, checkpoint) : undefined;
  if (!checkpoint || sourcePrefixLength === undefined) {
    return { conversation, thread, record, result: conflictResult(thread, "history-diverged", "Previously imported history is no longer an unchanged source prefix.", record), titleEvent: false, previouslyImported: true };
  }
  const adopted = thread.source === "codex"
    ? codexAdoptedTurns(thread, sourcePrefixLength, events, bootstrapped?.lastSequence ?? record.lastSequence)
    : claudeAdoptedTurns(thread, sourcePrefixLength, events, bootstrapped?.lastSequence ?? record.lastSequence);
  if (adopted < 0) return { conversation, thread, record, result: conflictResult(thread, "history-diverged", "T3 contains an ambiguous or partial provider turn suffix.", record), titleEvent: false, previouslyImported: true };
  const newTurns = thread.turns.slice(sourcePrefixLength + adopted);
  const t3Title = currentTitle(db, record.threadId, events);
  const baselineTitle = record.sourceTitle || stringValue(createEvent(events)?.payload.title) || thread.title;
  let titleAction: SyncItemResult["titleAction"] = "unchanged";
  const warnings = [...thread.warnings];
  if (thread.title !== baselineTitle) {
    if (t3Title === baselineTitle) titleAction = "updated";
    else if (t3Title !== thread.title) {
      titleAction = "preserved-local";
      warnings.push(`Preserved locally edited T3 title '${t3Title}' instead of provider title '${thread.title}'.`);
    }
  }
  const provider = existingProvider(db, thread, record, events);
  const syncThread = { ...thread, turns: newTurns, warnings };
  const planned = planThread(syncThread, record.threadId, record.projectId, paths, provider, record.identitySeed, undefined, record.resumable && Boolean(thread.resumeCursor), conversation.fingerprint, checkpoint.turns.length + adopted, false);
  if (titleAction === "updated") {
    planned.events.push(event(
      record.identitySeed, `sync.title.${events.filter((row) => row.type === "thread.meta-updated").length}`, "thread", record.threadId,
      "thread.meta-updated", thread.updatedAt, "provider",
      { threadId: record.threadId, title: thread.title, updatedAt: thread.updatedAt },
      { adapterKey: provider.adapterKey },
    ));
  }
  const changed = planned.events.length > 0 || adopted > 0 || !record.checkpoint || record.currentSourceKey !== thread.sourceKey;
  const status = dryRun && changed ? "dry-run" : planned.events.length > 0 || adopted > 0 ? "synced" : "up-to-date";
  const result: SyncItemResult = {
    source: thread.source, sourceId: thread.sourceSessionId, sourceKey: thread.sourceKey,
    status, threadId: record.threadId, projectId: record.projectId, title: thread.title,
    turnsAdded: newTurns.length, turnsAdopted: adopted, events: planned.events.length,
    attachments: planned.assets.length, titleAction, resumable: planned.resumable, warnings: planned.warnings,
  };
  return {
    conversation, thread, record, result, planned, checkpoint: checkpointForThread(thread),
    titleEvent: titleAction === "updated", previouslyImported: true,
    ...(adopted > 0 && events.at(-1) ? { adoptionSequence: events.at(-1)!.sequence } : {}),
  };
}

function hasConflict(status: SyncItemResult["status"]): boolean {
  return ["history-diverged", "branch-sync-unsupported", "target-missing", "not-imported"].includes(status);
}

function aggregate(results: SyncItemResult[], dryRun: boolean): SyncRunResult["status"] {
  if (dryRun && results.some((result) => result.status === "dry-run")) return "dry-run";
  const conflicts = results.some((result) => hasConflict(result.status));
  const synced = results.some((result) => result.status === "synced");
  if (conflicts && synced) return "mixed";
  if (conflicts) return "conflict";
  return synced ? "synced" : "up-to-date";
}

export async function inspectConversationSync(conversation: CanonicalConversation, paths: TargetPaths): Promise<ConversationSyncPreview> {
  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    validateTargetDatabase(db);
    const plan = buildPlan(db, paths, conversation, false);
    const result = plan.result;
    const activeOnly = plan.thread.turns.length === 0 && (plan.thread.ignoredInProgressTurns ?? 0) > 0;
    const status: ConversationSyncPreview["status"] = activeOnly
      ? "active-only"
      : result.status === "not-imported" ? "new"
      : result.status === "synced" || result.status === "dry-run" ? "syncable"
      : result.status === "up-to-date" ? "up-to-date"
      : result.status;
    const newTurns = plan.thread.turns.slice(Math.max(0, plan.thread.turns.length - result.turnsAdded));
    return {
      sourceId: result.sourceId, status, newTurns: result.turnsAdded,
      newCompletedTurns: newTurns.filter((turn) => turn.status === "completed").length,
      newInterruptedTurns: newTurns.filter((turn) => turn.status === "interrupted").length,
      newFailedTurns: newTurns.filter((turn) => turn.status === "failed").length,
      ignoredActiveTurns: plan.thread.ignoredInProgressTurns ?? 0,
      adoptedTurns: result.turnsAdopted, titleChanged: result.titleAction === "updated",
      selectable: status === "new" || status === "syncable", previouslyImported: plan.previouslyImported,
      ...(result.threadId ? { threadId: result.threadId } : {}), warnings: result.warnings,
    };
  } finally { db.close(); }
}

export async function syncConversations(selections: SyncSelection[], paths: TargetPaths, options: SyncOptions): Promise<SyncRunResult> {
  await assertT3Closed(paths);
  const releaseLock = options.dryRun ? () => {} : acquireLock(paths);
  const db = new Database(paths.dbPath, { readonly: options.dryRun, fileMustExist: true });
  let backup: string | null = null;
  const warnings: string[] = [];
  try {
    const schema = validateTargetDatabase(db);
    const plans = selections.map((selection) => buildPlan(db, paths, selection.conversation, options.dryRun));
    const writable = plans.filter((plan) => plan.planned && !hasConflict(plan.result.status));
    const eventPlans = writable.filter((plan) => plan.planned!.events.length > 0);
    const t3Plans = writable.filter((plan) => plan.planned!.events.length > 0 || plan.result.turnsAdopted > 0);
    if (t3Plans.length > 0) {
      const backlog = projectionBacklog(db);
      if (backlog.backlog > 0 && !options.allowProjectionBacklog) throw safetyError(`T3 has ${backlog.backlog} unprojected event${backlog.backlog === 1 ? "" : "s"}. Open T3 and let it finish loading before synchronizing.`);
      const count = eventPlans.reduce((sum, plan) => sum + plan.planned!.events.length, 0);
      if (count > MAX_SAFE_IMPORT_EVENTS) throw safetyError(`Synchronization would append ${count} events, exceeding the safe one-launch limit of ${MAX_SAFE_IMPORT_EVENTS}. Sync fewer conversations at a time.`);
    }
    if (options.dryRun) return { schemaVersion: 1, status: aggregate(plans.map((plan) => plan.result), true), target: paths.dbPath, migration: schema.migration, backup: null, results: plans.map((plan) => plan.result), warnings, hasConflicts: plans.some((plan) => hasConflict(plan.result.status)) };
    if (t3Plans.length > 0) backup = createBackup(db, paths);
    const assets = eventPlans.length > 0 ? materializeAssets(eventPlans.map((plan) => plan.planned!), paths, randomUUID()) : { created: [] as string[], cleanup: () => {} };
    const ledgerRecords: LedgerRecord[] = [];
    try {
      const nextVersion = db.prepare("SELECT COALESCE(MAX(stream_version), -1) + 1 nextVersion FROM orchestration_events WHERE aggregate_kind = ? AND stream_id = ?");
      const insert = db.prepare(`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`);
      const upsertRuntime = db.prepare(`
        INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json)
        VALUES (?, ?, ?, ?, 'full-access', 'stopped', ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET provider_name=excluded.provider_name, provider_instance_id=excluded.provider_instance_id, adapter_key=excluded.adapter_key, runtime_mode=excluded.runtime_mode, status=excluded.status, last_seen_at=excluded.last_seen_at, resume_cursor_json=excluded.resume_cursor_json, runtime_payload_json=excluded.runtime_payload_json
      `);
      db.transaction(() => {
        for (const plan of writable) {
          const record = plan.record!;
          const planned = plan.planned!;
          let first = Number.MAX_SAFE_INTEGER;
          let last = Math.max(record.lastSequence, plan.adoptionSequence ?? record.lastSequence);
          let version = (nextVersion.get("thread", record.threadId) as { nextVersion: number }).nextVersion;
          for (const row of planned.events) {
            const inserted = insert.run(row.eventId, row.aggregateKind, row.streamId, version++, row.type, row.occurredAt, row.actorKind, JSON.stringify(row.payload), JSON.stringify(row.metadata));
            const sequence = Number(inserted.lastInsertRowid);
            first = Math.min(first, sequence);
            last = Math.max(last, sequence);
          }
          if ((planned.events.length > 0 || plan.result.turnsAdopted > 0) && planned.resumable && plan.thread.resumeCursor) {
            const cursor = plan.thread.source === "claude" ? { threadId: record.threadId, ...plan.thread.resumeCursor } : plan.thread.resumeCursor;
            upsertRuntime.run(record.threadId, planned.provider.providerName, planned.provider.instanceId, planned.provider.adapterKey, plan.thread.updatedAt, JSON.stringify(cursor), JSON.stringify({ cwd: plan.thread.workspace, model: planned.provider.model, activeTurnId: null, lastError: null, modelSelection: { instanceId: planned.provider.instanceId, model: planned.provider.model, options: planned.provider.options }, lastRuntimeEvent: `t3-import.sync.${plan.thread.source}`, lastRuntimeEventAt: plan.thread.updatedAt }));
          }
          if (planned.events.length > 0) plan.result.sequence = { first, last };
          ledgerRecords.push({
            ...record, sourceFingerprint: plan.conversation.fingerprint,
            currentSourceKey: plan.thread.sourceKey,
            ...(plan.thread.leafId ? { sourceLeafId: plan.thread.leafId } : {}),
            sourceTitle: plan.thread.title, checkpoint: plan.checkpoint!, syncedAt: new Date().toISOString(),
            importerVersion: IMPORTER_VERSION, migration: SUPPORTED_MIGRATION,
            lastSequence: last, backupPath: backup ?? record.backupPath, warnings: plan.result.warnings,
            isCanonical: true,
          });
        }
      })();
      assets.cleanup();
    } catch (error) {
      for (const path of assets.created) rmSync(path, { force: true });
      assets.cleanup();
      throw error;
    }
    if (ledgerRecords.length) recordImports(ledgerRecords);
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw writeError(`Post-sync integrity check failed: ${integrity}`);
    return { schemaVersion: 1, status: aggregate(plans.map((plan) => plan.result), false), target: paths.dbPath, migration: schema.migration, backup, results: plans.map((plan) => plan.result), warnings, hasConflicts: plans.some((plan) => hasConflict(plan.result.status)) };
  } catch (error) {
    if (error instanceof Error && error.name === "ImporterError") throw error;
    throw writeError(`Synchronization failed: ${error instanceof Error ? error.message : String(error)}`, error);
  } finally {
    db.close();
    releaseLock();
  }
}
