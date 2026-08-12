import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type {
  CanonicalActivity,
  CanonicalMessage,
  CanonicalThread,
  ImportItemResult,
  ImportRunResult,
  ImportSelection,
  TargetPaths,
} from "../core/types.js";
import { canonicalPath, deterministicUuid, sha256, truncate } from "../core/util.js";
import { checkpointForThread } from "../core/checkpoint.js";
import { safetyError, writeError } from "../core/errors.js";
import { resolveProviderSelection, type TargetOverrides } from "./config.js";
import { assertT3Closed, SUPPORTED_MIGRATION, validateTargetDatabase } from "./schema.js";
import { recordImports, type LedgerRecord } from "./ledger.js";

const EVENT_TYPES = [
  "project.created",
  "thread.created",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.meta-updated",
  "thread.deleted",
] as const;

const plannedEventSchema = z.object({
  eventId: z.string().min(1),
  aggregateKind: z.enum(["project", "thread"]),
  streamId: z.string().min(1),
  type: z.enum(EVENT_TYPES),
  occurredAt: z.iso.datetime(),
  actorKind: z.enum(["client", "server", "provider"]),
  payload: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
});

export interface PlannedEvent extends z.infer<typeof plannedEventSchema> {
  key: string;
}

export interface PlannedAsset {
  descriptor: { type: "image"; id: string; name: string; mimeType: string; sizeBytes: number };
  data?: Buffer;
  sourcePath?: string;
  finalPath: string;
}

export interface PlannedThread {
  thread: CanonicalThread;
  threadId: string;
  projectId: string;
  provider: ReturnType<typeof resolveProviderSelection>;
  events: PlannedEvent[];
  assets: PlannedAsset[];
  resumable: boolean;
  warnings: string[];
  alreadyImported: boolean;
  fingerprint: string;
}

export const MAX_SAFE_IMPORT_EVENTS = 900;
export const IMPORTER_VERSION = "0.3.0";
const MAX_LAST_ERROR_LENGTH = 500;

function settledSession(turn: CanonicalThread["turns"][number]): { status: "ready" | "interrupted" | "error"; lastError: string | null } {
  if (turn.status === "completed") return { status: "ready", lastError: null };
  if (turn.status === "failed") return { status: "error", lastError: truncate(turn.terminalError ?? turn.terminalReason ?? "Imported provider turn failed.", MAX_LAST_ERROR_LENGTH) };
  return { status: "interrupted", lastError: null };
}

function activityPriority(activity: CanonicalActivity): number {
  if (activity.tone === "error" || activity.payload.status === "failed") return 100;
  switch (activity.payload.itemType) {
    case "file_change": return 90;
    case "mcp_tool_call":
    case "dynamic_tool_call": return 80;
    case "command_execution": return 70;
    case "web_search": return 60;
    case "image_view": return 50;
    default: return 40;
  }
}

function compactTurnActivities(activities: CanonicalActivity[]): CanonicalActivity[] {
  if (activities.length === 0) return activities;
  const selected = new Set<number>();
  let latestReasoning = -1;
  let latestPlan = -1;
  let representativeTool = -1;
  const latestOtherByKind = new Map<string, number>();

  activities.forEach((activity, index) => {
    if (activity.kind === "context-window.updated") return;
    if (activity.kind === "reasoning.summary") {
      latestReasoning = index;
      return;
    }
    if (activity.kind === "turn.plan.updated") {
      latestPlan = index;
      return;
    }
    if (activity.kind === "tool.completed") {
      if (
        representativeTool < 0 ||
        activityPriority(activity) >= activityPriority(activities[representativeTool]!)
      ) representativeTool = index;
      return;
    }
    if (
      activity.kind === "context-compaction" ||
      activity.tone === "error" ||
      activity.tone === "approval"
    ) {
      selected.add(index);
      return;
    }
    latestOtherByKind.set(activity.kind, index);
  });

  if (latestReasoning >= 0) selected.add(latestReasoning);
  if (latestPlan >= 0) selected.add(latestPlan);
  if (representativeTool >= 0) selected.add(representativeTool);
  for (const index of latestOtherByKind.values()) selected.add(index);
  return activities.filter((_activity, index) => selected.has(index));
}

export function compactThreadForImport(thread: CanonicalThread): CanonicalThread {
  const turns = thread.turns.map((turn) => ({
    ...turn,
    activities: compactTurnActivities(turn.activities),
  }));
  const before = thread.turns.reduce((sum, turn) => sum + turn.activities.length, 0);
  const after = turns.reduce((sum, turn) => sum + turn.activities.length, 0);
  if (after === before) return { ...thread, turns };
  return {
    ...thread,
    turns,
    warnings: [
      ...thread.warnings,
      `Compacted ${before} source activities to ${after} import activities for T3 startup compatibility.`,
    ],
  };
}

export interface ImportOptions extends TargetOverrides {
  dryRun: boolean;
  resume: boolean;
}

export function projectionBacklog(db: Database.Database): { latestSequence: number; projectedSequence: number; backlog: number } {
  const latestSequence = Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) value FROM orchestration_events").get() as { value: number }).value);
  const projected = db.prepare("SELECT MIN(last_applied_sequence) value FROM projection_state").get() as { value: number | null };
  const projectedSequence = projected.value ?? 0;
  return {
    latestSequence,
    projectedSequence,
    backlog: Math.max(0, latestSequence - projectedSequence),
  };
}

function safeAttachmentSegment(threadId: string): string {
  return threadId.trim().toLowerCase().replace(/[^a-z0-9_-]+/giu, "-").replace(/-+/gu, "-").replace(/^[-_]+|[-_]+$/gu, "").slice(0, 80).replace(/[-_]+$/gu, "");
}

const imageExtension: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function attachmentName(name: string, extension: string): string {
  const clean = basename(name).replace(/[\u0000-\u001f]/gu, "").slice(0, 240) || "image";
  return extname(clean) ? clean : `${clean}${extension}`;
}

function planMessageAttachments(
  message: CanonicalMessage,
  threadId: string,
  paths: TargetPaths,
  warnings: string[],
): { descriptors: PlannedAsset["descriptor"][]; assets: PlannedAsset[]; text: string } {
  const descriptors: PlannedAsset["descriptor"][] = [];
  const assets: PlannedAsset[] = [];
  const notes: string[] = [];
  for (const attachment of message.attachments.slice(0, 8)) {
    const extension = imageExtension[attachment.mimeType];
    if (!extension || attachment.sizeBytes > 10 * 1024 * 1024 || attachment.remoteUrl) {
      const reason = attachment.remoteUrl ? "remote images are not downloaded" : !extension ? `unsupported MIME type ${attachment.mimeType}` : "image exceeds 10 MB";
      warnings.push(`Skipped ${attachment.name}: ${reason}.`);
      notes.push(`[Attachment not imported: ${attachment.remoteUrl ?? attachment.name}]`);
      continue;
    }
    const id = `${safeAttachmentSegment(threadId)}-${deterministicUuid(`t3-import:attachment:${threadId}:${attachment.sourceId}`)}`;
    const descriptor = { type: "image" as const, id, name: attachmentName(attachment.name, extension), mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes };
    descriptors.push(descriptor);
    assets.push({ descriptor, ...(attachment.data ? { data: attachment.data } : {}), ...(attachment.path ? { sourcePath: attachment.path } : {}), finalPath: join(paths.attachmentsDir, `${id}${extension}`) });
  }
  if (message.attachments.length > 8) warnings.push(`Message ${message.sourceId} has more than eight images; extras were skipped.`);
  return { descriptors, assets, text: [message.text, ...notes].filter(Boolean).join("\n\n") };
}

export function event(
  seed: string,
  key: string,
  aggregateKind: "project" | "thread",
  streamId: string,
  type: PlannedEvent["type"],
  occurredAt: string,
  actorKind: PlannedEvent["actorKind"],
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): PlannedEvent {
  const value = { key, eventId: deterministicUuid(`t3-import:event:${seed}:${key}`), aggregateKind, streamId, type, occurredAt, actorKind, payload, metadata };
  plannedEventSchema.parse(value);
  return value;
}

export function modelSelection(provider: PlannedThread["provider"]): Record<string, unknown> {
  return { instanceId: provider.instanceId, model: provider.model, options: provider.options };
}

export function planThread(
  thread: CanonicalThread,
  threadId: string,
  projectId: string,
  paths: TargetPaths,
  provider: PlannedThread["provider"],
  seed: string,
  projectEvent: PlannedEvent | undefined,
  resumable: boolean,
  fingerprint: string,
  turnOffset = 0,
  includeThreadCreated = true,
  threadCreatedMetadata: Record<string, unknown> = {},
): PlannedThread {
  const events: PlannedEvent[] = projectEvent ? [projectEvent] : [];
  const assets: PlannedAsset[] = [];
  const warnings = [...thread.warnings, ...(provider.warning ? [provider.warning] : [])];
  if (thread.turns.some((turn) => turn.status === "inProgress")) warnings.push("Included an active provider snapshot as an interrupted historical turn; it will not be treated as pending in T3.");
  const selection = modelSelection(provider);
  const latestAt = thread.updatedAt;
  if (includeThreadCreated) events.push(event(seed, "thread.created", "thread", threadId, "thread.created", thread.createdAt, "server", {
    threadId, projectId, title: thread.title, modelSelection: selection, runtimeMode: "full-access", interactionMode: "default", branch: thread.gitBranch ?? null, worktreePath: null, createdAt: thread.createdAt, updatedAt: thread.createdAt,
  }, threadCreatedMetadata));
  if (includeThreadCreated && !thread.currentBranch) {
    const activityId = deterministicUuid(`t3-import:activity:${seed}:historical-branch`);
    events.push(event(seed, "historical-branch", "thread", threadId, "thread.activity-appended", thread.createdAt, "provider", {
      threadId,
      activity: { id: activityId, tone: "info", kind: "import.historical-branch", summary: "Historical Claude branch", payload: { detail: warnings[0] }, turnId: null, createdAt: thread.createdAt },
    }, { adapterKey: provider.adapterKey }));
  }

  thread.turns.forEach((turn, turnIndex) => {
    const turnNumber = turnOffset + turnIndex;
    const attachmentPlan = planMessageAttachments(turn.user, threadId, paths, warnings);
    assets.push(...attachmentPlan.assets);
    const userMessageId = deterministicUuid(`t3-import:message:${seed}:${turn.id}:user:${turn.user.sourceId}`);
    events.push(event(seed, `turn.${turnNumber}.user`, "thread", threadId, "thread.message-sent", turn.user.timestamp, "client", {
      threadId, messageId: userMessageId, role: "user", text: attachmentPlan.text, attachments: attachmentPlan.descriptors, turnId: null, streaming: false, createdAt: turn.user.timestamp, updatedAt: turn.user.timestamp,
    }));
    events.push(event(seed, `turn.${turnNumber}.start`, "thread", threadId, "thread.turn-start-requested", turn.startedAt, "client", {
      threadId, messageId: userMessageId, modelSelection: selection, titleSeed: truncate(turn.user.text, 120), runtimeMode: "full-access", interactionMode: "default", createdAt: turn.startedAt,
    }));
    events.push(event(seed, `turn.${turnNumber}.running`, "thread", threadId, "thread.session-set", turn.startedAt, "provider", {
      threadId,
      session: { threadId, status: "running", providerName: provider.providerName, providerInstanceId: provider.instanceId, runtimeMode: "full-access", activeTurnId: turn.id, lastError: null, updatedAt: turn.startedAt },
    }, { adapterKey: provider.adapterKey, providerTurnId: turn.id }));

    const timeline: Array<{ timestamp: string; sourceId: string; type: "message" | "activity" | "plan"; value: CanonicalMessage | CanonicalActivity | { sourceId: string; markdown: string; timestamp: string } }> = [
      ...turn.assistant.map((value) => ({ timestamp: value.timestamp, sourceId: value.sourceId, type: "message" as const, value })),
      ...turn.activities.map((value) => ({ timestamp: value.timestamp, sourceId: value.sourceId, type: "activity" as const, value })),
      ...turn.plans.map((value) => ({ timestamp: value.timestamp, sourceId: value.sourceId, type: "plan" as const, value })),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sourceId.localeCompare(b.sourceId));
    timeline.forEach((entry, entryIndex) => {
      if (entry.type === "message") {
        const message = entry.value as CanonicalMessage;
        const messageId = deterministicUuid(`t3-import:message:${seed}:${turn.id}:assistant:${message.sourceId}`);
        events.push(event(seed, `turn.${turnNumber}.entry.${entryIndex}.message`, "thread", threadId, "thread.message-sent", message.timestamp, "provider", {
          threadId, messageId, role: "assistant", text: message.text, turnId: turn.id, streaming: false, createdAt: message.timestamp, updatedAt: message.timestamp,
        }, { adapterKey: provider.adapterKey, providerTurnId: turn.id }));
      } else if (entry.type === "activity") {
        const activity = entry.value as CanonicalActivity;
        const activityId = deterministicUuid(`t3-import:activity:${seed}:${turn.id}:${activity.sourceId}`);
        events.push(event(seed, `turn.${turnNumber}.entry.${entryIndex}.activity`, "thread", threadId, "thread.activity-appended", activity.timestamp, "provider", {
          threadId,
          activity: { id: activityId, tone: activity.tone, kind: activity.kind, summary: activity.summary || "Activity", payload: activity.payload, turnId: turn.id, sequence: entryIndex, createdAt: activity.timestamp },
        }, { adapterKey: provider.adapterKey, providerTurnId: turn.id, providerItemId: activity.sourceId }));
      } else {
        const plan = entry.value as { sourceId: string; markdown: string; timestamp: string };
        const planId = deterministicUuid(`t3-import:plan:${seed}:${turn.id}:${plan.sourceId}`);
        events.push(event(seed, `turn.${turnNumber}.entry.${entryIndex}.plan`, "thread", threadId, "thread.proposed-plan-upserted", plan.timestamp, "provider", {
          threadId,
          proposedPlan: { id: planId, turnId: turn.id, planMarkdown: plan.markdown, implementedAt: null, implementationThreadId: null, createdAt: plan.timestamp, updatedAt: plan.timestamp },
        }, { adapterKey: provider.adapterKey, providerTurnId: turn.id, providerItemId: plan.sourceId }));
      }
    });
    const settledAt = turn.completedAt ?? turn.assistant.at(-1)?.timestamp ?? turn.user.timestamp;
    const settled = settledSession(turn);
    events.push(event(seed, `turn.${turnNumber}.settled`, "thread", threadId, "thread.session-set", settledAt, "provider", {
      threadId,
      session: { threadId, status: settled.status, providerName: provider.providerName, providerInstanceId: provider.instanceId, runtimeMode: "full-access", activeTurnId: null, lastError: settled.lastError, updatedAt: settledAt },
    }, { adapterKey: provider.adapterKey, providerTurnId: turn.id }));
  });
  return { thread, threadId, projectId, provider, events, assets, resumable, warnings, alreadyImported: false, fingerprint };
}

function existingProjectId(db: Database.Database, workspace: string): string | undefined {
  const normalized = canonicalPath(workspace);
  const rows = db.prepare("SELECT project_id projectId, workspace_root workspaceRoot FROM projection_projects WHERE deleted_at IS NULL").all() as Array<{ projectId: string; workspaceRoot: string }>;
  const projected = rows.find((row) => canonicalPath(row.workspaceRoot) === normalized)?.projectId;
  if (projected) return projected;
  const pending = db.prepare("SELECT stream_id streamId, payload_json payload FROM orchestration_events WHERE event_type = 'project.created'").all() as Array<{ streamId: string; payload: string }>;
  return pending.find((row) => {
    try { const value = JSON.parse(row.payload) as { workspaceRoot?: string }; return value.workspaceRoot ? canonicalPath(value.workspaceRoot) === normalized : false; } catch { return false; }
  })?.streamId;
}

function isImported(db: Database.Database, sourceKey: string, thread: CanonicalThread, threadId: string): boolean {
  const marker = deterministicUuid(`t3-import:event:${sourceKey}:thread.created`);
  const found = db.prepare("SELECT 1 found FROM orchestration_events WHERE event_id = ? OR (stream_id = ? AND event_type = 'thread.created') LIMIT 1").get(marker, threadId);
  if (found) return true;
  if (thread.source === "codex") {
    const legacy = deterministicUuid(`t3-import:event:${thread.sourceSessionId}:thread.created`);
    return Boolean(db.prepare("SELECT 1 found FROM orchestration_events WHERE event_id = ? OR (stream_id = ? AND event_type = 'thread.created') LIMIT 1").get(legacy, thread.sourceSessionId));
  }
  return false;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireLock(paths: TargetPaths): () => void {
  const lockPath = join(paths.stateDir, ".t3-import.lock");
  if (existsSync(lockPath)) {
    try {
      const value = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (typeof value.pid === "number" && pidAlive(value.pid)) throw safetyError(`Another t3-import process is running (PID ${value.pid}).`);
      unlinkSync(lockPath);
    } catch (error) {
      if (error instanceof Error && error.name === "ImporterError") throw error;
      try { unlinkSync(lockPath); } catch { throw safetyError(`Cannot acquire importer lock: ${lockPath}`); }
    }
  }
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx");
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(descriptor);
  } catch (error) { throw safetyError(`Cannot acquire importer lock: ${error instanceof Error ? error.message : String(error)}`); }
  return () => { try { unlinkSync(lockPath); } catch { /* best effort */ } };
}

export function createBackup(db: Database.Database, paths: TargetPaths): string {
  const directory = join(paths.stateDir, "t3-import-backups");
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const destination = join(directory, `state-before-import-${stamp}.sqlite`);
  db.prepare("VACUUM INTO ?").run(destination);
  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(backup.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw writeError(`Backup integrity check failed: ${destination}`);
  } finally { backup.close(); }
  return destination;
}

export function materializeAssets(plans: PlannedThread[], paths: TargetPaths, runId: string): { created: string[]; cleanup(): void } {
  const staging = join(paths.attachmentsDir, `.t3-import-staging-${runId}`);
  mkdirSync(staging, { recursive: true });
  const created: string[] = [];
  try {
    for (const asset of plans.flatMap((plan) => plan.assets)) {
      if (existsSync(asset.finalPath)) continue;
      const temporary = join(staging, basename(asset.finalPath));
      if (asset.data) writeFileSync(temporary, asset.data);
      else if (asset.sourcePath) copyFileSync(asset.sourcePath, temporary);
      else throw writeError(`Attachment ${asset.descriptor.name} has no local data.`);
      renameSync(temporary, asset.finalPath);
      created.push(asset.finalPath);
    }
    return { created, cleanup: () => rmSync(staging, { recursive: true, force: true }) };
  } catch (error) {
    for (const path of created) rmSync(path, { force: true });
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function aggregateStatus(results: ImportItemResult[], dryRun: boolean): ImportRunResult["status"] {
  if (dryRun) return "dry-run";
  const statuses = new Set(results.map((result) => result.status));
  if (statuses.size > 1) return "mixed";
  return statuses.has("already-imported") ? "already-imported" : "imported";
}

export async function importConversations(
  selections: ImportSelection[],
  paths: TargetPaths,
  options: ImportOptions,
): Promise<ImportRunResult> {
  if (!existsSync(paths.dbPath)) throw safetyError(`T3 database not found: ${paths.dbPath}`);
  await assertT3Closed(paths);
  const releaseLock = options.dryRun ? () => {} : acquireLock(paths);
  const db = new Database(paths.dbPath, { readonly: options.dryRun, fileMustExist: true });
  let backup: string | null = null;
  const runWarnings: string[] = [];
  try {
    const schema = validateTargetDatabase(db);
    const planned: PlannedThread[] = [];
    const projectIds = new Map<string, string>();
    const plannedProjectEvents = new Set<string>();
    for (const selection of selections) {
      for (const sourceThread of selection.conversation.threads) {
        const thread = compactThreadForImport(sourceThread);
        if (thread.turns.length === 0) throw writeError(`Conversation ${thread.sourceSessionId} has no terminal turns to import. Use --include-incomplete to import an active snapshot as interrupted history.`);
        const threadId = thread.source === "codex" && /^[0-9a-f-]{36}$/iu.test(thread.sourceSessionId)
          ? thread.sourceSessionId
          : deterministicUuid(`t3-import:thread:${thread.sourceKey}`);
        const imported = isImported(db, thread.sourceKey, thread, threadId);
        const workspaceKey = canonicalPath(thread.workspace);
        let projectId = projectIds.get(workspaceKey) ?? existingProjectId(db, thread.workspace);
        if (!projectId) projectId = deterministicUuid(`t3-import:project:${workspaceKey}`);
        projectIds.set(workspaceKey, projectId);
        const provider = resolveProviderSelection(paths, thread.source, thread.model, thread.effort, options.providerInstance);
        const seed = thread.sourceKey;
        const projectEvent = !imported && !existingProjectId(db, thread.workspace) && !plannedProjectEvents.has(projectId)
          ? event(`project:${workspaceKey}`, "project.created", "project", projectId, "project.created", thread.createdAt, "client", {
              projectId, title: basename(thread.workspace), workspaceRoot: thread.workspace, defaultModelSelection: modelSelection(provider), scripts: [], createdAt: thread.createdAt, updatedAt: thread.updatedAt,
            })
          : undefined;
        if (projectEvent) plannedProjectEvents.add(projectId);
        const resumable = options.resume && selection.resume && thread.currentBranch && Boolean(thread.resumeCursor);
        const plan = planThread(thread, threadId, projectId, paths, provider, seed, projectEvent, resumable, selection.conversation.fingerprint);
        plan.alreadyImported = imported;
        planned.push(plan);
      }
    }

    const results: ImportItemResult[] = planned.map((plan) => ({
      source: plan.thread.source,
      sourceId: plan.thread.sourceSessionId,
      sourceKey: plan.thread.sourceKey,
      status: plan.alreadyImported ? "already-imported" : options.dryRun ? "dry-run" : "imported",
      threadId: plan.threadId,
      projectId: plan.projectId,
      title: plan.thread.title,
      turns: plan.thread.turns.length,
      messages: plan.thread.turns.reduce((sum, turn) => sum + 1 + turn.assistant.length, 0),
      activities: plan.thread.turns.reduce((sum, turn) => sum + turn.activities.length, 0) + (plan.thread.currentBranch ? 0 : 1),
      events: plan.events.length,
      attachments: plan.assets.length,
      resumable: plan.resumable,
      warnings: plan.warnings,
    }));
    const toWrite = planned.filter((plan) => !plan.alreadyImported);
    if (toWrite.length > 0) {
      const projection = projectionBacklog(db);
      if (projection.backlog > 0) {
        throw safetyError(
          `T3 has ${projection.backlog} unprojected event${projection.backlog === 1 ? "" : "s"} ` +
          `(event sequence ${projection.latestSequence}, projection sequence ${projection.projectedSequence}). ` +
          "Open T3 and let it finish loading before importing more conversations.",
        );
      }
      const plannedEventCount = toWrite.reduce((sum, plan) => sum + plan.events.length, 0);
      if (plannedEventCount > MAX_SAFE_IMPORT_EVENTS) {
        throw safetyError(
          `The compact import would append ${plannedEventCount} events, exceeding the safe one-launch limit of ${MAX_SAFE_IMPORT_EVENTS}. ` +
          "Import fewer conversations at a time or select shorter histories.",
        );
      }
    }
    if (options.dryRun || toWrite.length === 0) {
      return { schemaVersion: 1, status: aggregateStatus(results, options.dryRun), target: paths.dbPath, migration: schema.migration, backup: null, results, warnings: runWarnings };
    }

    backup = createBackup(db, paths);
    mkdirSync(paths.attachmentsDir, { recursive: true });
    const assets = materializeAssets(toWrite, paths, randomUUID());
    const ledger: LedgerRecord[] = [];
    try {
      const nextVersion = db.prepare("SELECT COALESCE(MAX(stream_version), -1) + 1 nextVersion FROM orchestration_events WHERE aggregate_kind = ? AND stream_id = ?");
      const insert = db.prepare(`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
      `);
      const upsertRuntime = db.prepare(`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (?, ?, ?, ?, 'full-access', 'stopped', ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          provider_name=excluded.provider_name,
          provider_instance_id=excluded.provider_instance_id,
          adapter_key=excluded.adapter_key,
          runtime_mode=excluded.runtime_mode,
          status=excluded.status,
          last_seen_at=excluded.last_seen_at,
          resume_cursor_json=excluded.resume_cursor_json,
          runtime_payload_json=excluded.runtime_payload_json
      `);
      const streamVersions = new Map<string, number>();
      db.transaction(() => {
        for (const plan of toWrite) {
          let firstSequence = Number.MAX_SAFE_INTEGER;
          let lastSequence = 0;
          for (const plannedEvent of plan.events) {
            const streamKey = `${plannedEvent.aggregateKind}:${plannedEvent.streamId}`;
            const version = streamVersions.get(streamKey) ?? (nextVersion.get(plannedEvent.aggregateKind, plannedEvent.streamId) as { nextVersion: number }).nextVersion;
            const result = insert.run(plannedEvent.eventId, plannedEvent.aggregateKind, plannedEvent.streamId, version, plannedEvent.type, plannedEvent.occurredAt, plannedEvent.actorKind, JSON.stringify(plannedEvent.payload), JSON.stringify(plannedEvent.metadata));
            const sequence = Number(result.lastInsertRowid);
            firstSequence = Math.min(firstSequence, sequence);
            lastSequence = Math.max(lastSequence, sequence);
            streamVersions.set(streamKey, version + 1);
          }
          if (plan.resumable && plan.thread.resumeCursor) {
            const cursor = plan.thread.source === "claude" ? { threadId: plan.threadId, ...plan.thread.resumeCursor } : plan.thread.resumeCursor;
            upsertRuntime.run(plan.threadId, plan.provider.providerName, plan.provider.instanceId, plan.provider.adapterKey, plan.thread.updatedAt, JSON.stringify(cursor), JSON.stringify({ cwd: plan.thread.workspace, model: plan.provider.model, activeTurnId: null, lastError: null, modelSelection: modelSelection(plan.provider), lastRuntimeEvent: `t3-import.${plan.thread.source}`, lastRuntimeEventAt: plan.thread.updatedAt }));
          }
          const result = results.find((entry) => entry.threadId === plan.threadId)!;
          result.sequence = { first: firstSequence, last: lastSequence };
          ledger.push({
            targetId: sha256(canonicalPath(paths.dbPath)), source: plan.thread.source,
            sourceSessionId: plan.thread.sourceSessionId, sourceKey: plan.thread.sourceKey,
            sourceFingerprint: plan.fingerprint, projectId: plan.projectId, threadId: plan.threadId,
            importedAt: new Date().toISOString(), importerVersion: IMPORTER_VERSION,
            migration: SUPPORTED_MIGRATION, firstSequence, lastSequence,
            resumable: plan.resumable, backupPath: backup!, warnings: plan.warnings,
            identitySeed: plan.thread.sourceKey, currentSourceKey: plan.thread.sourceKey,
            ...(plan.thread.leafId ? { sourceLeafId: plan.thread.leafId } : {}),
            sourceTitle: plan.thread.title, checkpoint: checkpointForThread(plan.thread),
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
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw writeError(`Post-import integrity check failed: ${integrity}`);
    try { recordImports(ledger); } catch (error) { runWarnings.push(`Import succeeded, but the external ledger could not be updated: ${error instanceof Error ? error.message : String(error)}`); }
    return { schemaVersion: 1, status: aggregateStatus(results, false), target: paths.dbPath, migration: schema.migration, backup, results, warnings: runWarnings };
  } catch (error) {
    if (error instanceof Error && error.name === "ImporterError") throw error;
    throw writeError(`Import failed: ${error instanceof Error ? error.message : String(error)}`, error);
  } finally {
    db.close();
    releaseLock();
  }
}
