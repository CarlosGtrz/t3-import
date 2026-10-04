import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import type { TargetPaths } from "../core/types.js";
import { compatibilityError, safetyError } from "../core/errors.js";
import { assertT3Closed } from "./schema.js";

type Row = Record<string, any>;
type Payload = Record<string, unknown>;
const PREFIX = "t3-import:v2";
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const parse = <T = any>(value: string | null, fallback: T): T => value === null ? fallback : JSON.parse(value) as T;

export interface UpgradeV2Options {
  legacyDbPath?: string;
  dryRun: boolean;
  threadIds?: string[];
}
export interface UpgradeV2Result {
  status: "dry-run" | "upgraded" | "already-upgraded";
  threads: number;
  unchangedThreads: number;
  messages: number;
  activities: number;
  failedActivities: number;
  plans: number;
  resumeBindings: number;
  events: number;
  assets: number;
  backup?: string;
  warnings: string[];
}

/** The new orchestrator uses a different database and event protocol, despite retaining V1 tables. */
export function validateV2Database(db: Database.Database): void {
  const migration = (db.prepare("SELECT MAX(migration_id) n FROM effect_sql_migrations").get() as Row).n;
  if (migration !== 56) throw compatibilityError(`Unsupported V2 migration ${migration}; this bridge is pinned to migration 56.`);
  for (const table of ["orchestration_v2_projection_threads", "orchestration_v2_projection_runs", "orchestration_v2_projection_turn_items", "orchestration_v2_projection_metadata", "orchestration_v2_turn_item_positions"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw compatibilityError(`Missing native V2 table '${table}'.`);
  }
  if (!(db.prepare("PRAGMA table_info(orchestration_events)").all() as Row[]).some(row => row.name === "application_event_version")) throw compatibilityError("Missing V2 event version column.");
  if (db.pragma("quick_check", { simple: true }) !== "ok") throw compatibilityError("V2 database integrity check failed.");
}

function threadPayload(row: Row): Payload {
  return {
    createdBy: "system", creationSource: "server", id: row.thread_id, projectId: row.project_id,
    title: row.title?.trim() || "Untitled thread", providerInstanceId: parse(row.model_selection_json, { instanceId: "codex" }).instanceId,
    modelSelection: parse(row.model_selection_json, { instanceId: "codex", model: "gpt-6-astra" }),
    runtimeMode: row.runtime_mode ?? "full-access", interactionMode: row.interaction_mode ?? "default",
    branch: row.branch || null, worktreePath: row.worktree_path || null,
    linkedPullRequest: parse(row.linked_pull_request_json, null), branchPullRequest: parse(row.branch_pull_request_json, null),
    activeOrderKey: row.active_order_key ?? null, activeProviderThreadId: null, historyOrigin: "v1_import",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: row.thread_id }, forkedFrom: null,
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at ?? null,
    settledOverride: row.settled_override ?? null, settledAt: row.settled_at ?? null, unsettledAt: row.unsettled_at ?? null,
    snoozedUntil: row.snoozed_until ?? null, snoozedAt: row.snoozed_at ?? null, pinnedAt: row.pinned_at ?? null,
    autoSettleDisabledAt: row.auto_settle_disabled_at ?? null, pinOrderKey: row.pin_order_key ?? null,
    lastVisitedAt: null, deletedAt: row.deleted_at ?? null,
  };
}

/** Preserve the entire old activity, including failed outputs and unknown provider payloads. */
export function legacyActivityItem(row: Row, base: Payload): Payload {
  const original = {
    id: row.activity_id, turnId: row.turn_id, tone: row.tone, kind: row.kind,
    summary: row.summary, payload: parse<Row>(row.payload_json, {}), createdAt: row.created_at, sequence: row.sequence,
  };
  return {
    ...base, type: "dynamic_tool", title: row.summary || row.kind,
    toolName: row.kind || "legacy_activity", input: { legacyActivity: original },
    output: original.payload, status: row.tone === "error" || original.payload.status === "failed" ? "failed" : "completed",
  };
}

/** Saved native bindings already own their historical inputs, including failed turns. */
export function nativeHistoryCoverage(input: { threadId: string; nativeId: string; providerThreadId: string; lastRunId: string; runCount: number; itemIds: string[]; createdAt: string; updatedAt: string }): Payload {
  return {
    id: `${PREFIX}:native-history:${input.threadId}:${encodeURIComponent(input.nativeId)}`,
    threadId: input.threadId, targetRunId: input.lastRunId,
    fromProviderThreadIds: [input.providerThreadId], toProviderThreadId: input.providerThreadId,
    coveredRunOrdinals: { from: 1, to: input.runCount }, strategy: "full_thread_summary", status: "ready",
    summaryMessageId: null, summaryText: "Legacy records belong to the existing saved native conversation; this records historical coverage, not a new T3 execution or history injection.",
    delivery: { nativeThreadId: input.nativeId, status: "inline", itemIds: input.itemIds },
    createdByProviderInstanceId: null, createdAt: input.createdAt, updatedAt: input.updatedAt,
  };
}

/**
 * Offline, additive bridge into the official V2 event log and its persisted read models.
 * V2 does not replay an offline event backlog on startup, so both are committed together.
 * Source snapshots are read-only, writes are atomic, and continued native chats are protected.
 */
export async function upgradeLegacyToV2(paths: TargetPaths, options: UpgradeV2Options): Promise<UpgradeV2Result> {
  await assertT3Closed(paths);
  const legacyPath = resolve(options.legacyDbPath ?? join(paths.stateDir, "state.sqlite"));
  if (legacyPath === resolve(paths.dbPath)) throw safetyError("V1 source and V2 target must be different database files.");
  const source = new Database(legacyPath, { readonly: true, fileMustExist: true });
  const target = new Database(paths.dbPath, { readonly: options.dryRun, fileMustExist: true });
  const result: UpgradeV2Result = { status: options.dryRun ? "dry-run" : "already-upgraded", threads: 0, unchangedThreads: 0, messages: 0, activities: 0, failedActivities: 0, plans: 0, resumeBindings: 0, events: 0, assets: 0, warnings: [] };
  const newAssets: string[] = [];
  let targetTransaction = false;
  try {
    validateV2Database(target);
    if (source.pragma("quick_check", { simple: true }) !== "ok") throw compatibilityError("V1 source integrity check failed.");
    source.exec("BEGIN");
    if (!options.dryRun) {
      const backupDir = join(paths.stateDir, "t3-import-backups", `before-v2-bridge-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`);
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      result.backup = join(backupDir, "statev2.sqlite");
      await target.backup(result.backup);
      target.exec("BEGIN IMMEDIATE"); targetTransaction = true;
      target.exec("CREATE TABLE IF NOT EXISTS t3_import_v2_checkpoints (thread_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)");
    }
    const hasCheckpoints = Boolean(target.prepare("SELECT 1 FROM sqlite_master WHERE name='t3_import_v2_checkpoints'").get());
    const exists = target.prepare("SELECT 1 FROM orchestration_events WHERE event_id=?");
    const latest = target.prepare("SELECT COALESCE(MAX(stream_version),-1) n FROM orchestration_events WHERE aggregate_kind=? AND stream_id=?");
    const insert = options.dryRun ? undefined : target.prepare("INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?,?,?,?,?,?,NULL,NULL,NULL,'server',?,?,2)");
    const versions = new Map<string, number>();
    let snapshotKey = "";
    const upsert = (table: string, key: string, values: Row): void => {
      const columns = Object.keys(values);
      target.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(${key}) DO UPDATE SET ${columns.filter(column => column !== key).map(column => `${column}=excluded.${column}`).join(",")}`).run(...Object.values(values));
    };
    const project = (type: string, p: Row, json: string): void => {
      switch (type) {
        case "project.created": upsert("projection_projects", "project_id", { project_id: p.projectId, title: p.title, workspace_root: p.workspaceRoot, scripts_json: JSON.stringify(p.scripts), default_model_selection_json: JSON.stringify(p.defaultModelSelection), created_at: p.createdAt, updated_at: p.updatedAt, deleted_at: null }); break;
        case "thread.created":
        case "thread.metadata-updated": upsert("orchestration_v2_projection_threads", "thread_id", { thread_id: p.id, project_id: p.projectId, title: p.title, default_provider: p.providerInstanceId, provider_instance_id: p.providerInstanceId, runtime_mode: p.runtimeMode, interaction_mode: p.interactionMode, active_provider_thread_id: p.activeProviderThreadId, created_at: p.createdAt, updated_at: p.updatedAt, archived_at: p.archivedAt, deleted_at: p.deletedAt, payload_json: json }); break;
        case "run.updated": upsert("orchestration_v2_projection_runs", "run_id", { run_id: p.id, thread_id: p.threadId, ordinal: p.ordinal, provider: p.providerInstanceId, provider_instance_id: p.providerInstanceId, provider_thread_id: p.providerThreadId, status: p.status, requested_at: p.requestedAt, completed_at: p.completedAt, payload_json: json }); break;
        case "provider-thread.updated": upsert("orchestration_v2_projection_provider_threads", "provider_thread_id", { provider_thread_id: p.id, thread_id: p.appThreadId, owner_node_id: p.ownerNodeId, provider: p.providerInstanceId, provider_instance_id: p.providerInstanceId, driver: p.driver, provider_session_id: p.providerSessionId, status: p.status, first_run_ordinal: p.firstRunOrdinal, last_run_ordinal: p.lastRunOrdinal, updated_at: p.updatedAt, payload_json: json }); break;
        case "message.updated": upsert("orchestration_v2_projection_messages", "message_id", { message_id: p.id, thread_id: p.threadId, run_id: p.runId, node_id: p.nodeId, role: p.role, streaming: p.streaming ? 1 : 0, created_at: p.createdAt, updated_at: p.updatedAt, payload_json: json }); break;
        case "turn-item.updated":
          upsert("orchestration_v2_projection_turn_items", "turn_item_id", { turn_item_id: p.id, thread_id: p.threadId, run_id: p.runId, node_id: p.nodeId, provider_thread_id: p.providerThreadId, provider_turn_id: p.providerTurnId, parent_item_id: p.parentItemId, ordinal: p.ordinal, type: p.type, status: p.status, updated_at: p.updatedAt, payload_json: json });
          target.prepare("INSERT INTO orchestration_v2_turn_item_positions VALUES (?,?,?) ON CONFLICT(thread_id,turn_item_id) DO UPDATE SET ordinal=excluded.ordinal").run(p.threadId, p.id, p.ordinal); break;
        case "plan.updated": upsert("orchestration_v2_projection_plans", "plan_id", { plan_id: p.id, thread_id: p.threadId, run_id: p.runId, node_id: p.nodeId, kind: p.kind, status: p.status, payload_json: json }); break;
        case "context-handoff.updated": upsert("orchestration_v2_projection_context_handoffs", "context_handoff_id", { context_handoff_id: p.id, thread_id: p.threadId, target_run_id: p.targetRunId, to_provider_thread_id: p.toProviderThreadId, strategy: p.strategy, status: p.status, updated_at: p.updatedAt, payload_json: json }); break;
      }
    };
    const append = (threadId: string, type: string, at: string, payload: Payload, aggregate = "thread"): void => {
      const json = JSON.stringify(payload);
      const id = `${PREFIX}:${type}:${hash(`${threadId}:${snapshotKey}:${json}`)}`;
      if (exists.get(id)) { if (insert) project(type, payload, json); return; }
      result.events++;
      if (insert) {
        const key = `${aggregate}:${threadId}`;
        const version = (versions.get(key) ?? (latest.get(aggregate, threadId) as Row).n) + 1;
        versions.set(key, version);
        insert.run(id, aggregate, threadId, version, type, at, json, JSON.stringify({ importer: PREFIX }));
        project(type, payload, json);
      }
    };
    const requested = options.threadIds ? new Set(options.threadIds) : undefined;
    for (const row of source.prepare("SELECT * FROM projection_threads ORDER BY created_at,thread_id").iterate() as Iterable<Row>) {
      if (requested && !requested.has(row.thread_id)) continue;
      const messages = source.prepare("SELECT * FROM projection_thread_messages WHERE thread_id=? ORDER BY created_at,message_id").all(row.thread_id) as Row[];
      const turns = source.prepare("SELECT * FROM projection_turns WHERE thread_id=? ORDER BY requested_at,row_id").all(row.thread_id) as Row[];
      const activities = source.prepare("SELECT * FROM projection_thread_activities WHERE thread_id=? ORDER BY created_at,sequence,activity_id").all(row.thread_id) as Row[];
      const plans = source.prepare("SELECT * FROM projection_thread_proposed_plans WHERE thread_id=? ORDER BY created_at,plan_id").all(row.thread_id) as Row[];
      const runtime = source.prepare("SELECT * FROM provider_session_runtime WHERE thread_id=?").get(row.thread_id) as Row | undefined;
      const pullRequests = source.prepare("SELECT 1 FROM sqlite_master WHERE name='projection_thread_pull_requests'").get()
        ? source.prepare("SELECT * FROM projection_thread_pull_requests WHERE thread_id=? ORDER BY host,repository,number").all(row.thread_id) as Row[] : [];
      const fingerprint = hash(JSON.stringify([row, messages, turns, activities, plans, runtime, pullRequests]));
      const checkpoint = hasCheckpoints ? target.prepare("SELECT fingerprint FROM t3_import_v2_checkpoints WHERE thread_id=?").get(row.thread_id) as Row | undefined : undefined;
      if (checkpoint?.fingerprint === fingerprint) { result.unchangedThreads++; continue; }
      snapshotKey = hash(`timeline-order:1:${fingerprint}`);
      // A source snapshot must never overwrite work performed after native continuation.
      if (target.prepare("SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=? AND run_id NOT LIKE 'migration:v1:run:%' LIMIT 1").get(row.thread_id)) throw safetyError(`Thread '${row.thread_id}' has native V2 runs; its V1 snapshot must not overwrite continued work.`);
      const currentRow = target.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?").get(row.thread_id) as Row | undefined;
      const current = currentRow ? parse<Payload>(currentRow.payload_json, {}) : undefined;
      if (current && current.historyOrigin !== "v1_import") throw safetyError(`Thread '${row.thread_id}' is not an imported V1 history.`);
      if (!options.dryRun && current) {
        // An earlier user message can shift every historical run/item ordinal.
        // Free their unique positions before assigning the complete new order.
        // Readers cannot observe these temporary values inside this transaction.
        const runMax = (target.prepare("SELECT COALESCE(MAX(ordinal),0) n FROM orchestration_v2_projection_runs WHERE thread_id=?").get(row.thread_id) as Row).n as number;
        const itemMax = (target.prepare("SELECT COALESCE(MAX(ordinal),0) n FROM orchestration_v2_projection_turn_items WHERE thread_id=?").get(row.thread_id) as Row).n as number;
        const runOffset = runMax + messages.length + 1;
        const itemOffset = itemMax + (messages.length + 1) * 1_000_000 + activities.length + plans.length + 1;
        if (!Number.isSafeInteger(runMax + runOffset) || !Number.isSafeInteger(itemMax + itemOffset)) throw compatibilityError("Historical ordinal range exceeds safe integer storage.");
        // Record the temporary positions too, so native event replay can safely
        // reconstruct the same transition without unique-ordinal collisions.
        const previousRuns = target.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=? ORDER BY ordinal DESC").all(row.thread_id) as Row[];
        const previousItems = target.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=? ORDER BY ordinal DESC").all(row.thread_id) as Row[];
        for (const previous of previousRuns) {
          const payload = parse<Payload>(previous.payload_json, {});
          append(row.thread_id, "run.updated", row.updated_at, { ...payload, ordinal: (payload.ordinal as number) + runOffset });
        }
        for (const previous of previousItems) {
          const payload = parse<Payload>(previous.payload_json, {});
          append(row.thread_id, "turn-item.updated", row.updated_at, { ...payload, ordinal: (payload.ordinal as number) + itemOffset });
        }
      }
      if (!target.prepare("SELECT 1 FROM projection_projects WHERE project_id=?").get(row.project_id)) {
        const project = source.prepare("SELECT payload_json,occurred_at FROM orchestration_events WHERE aggregate_kind='project' AND stream_id=? AND event_type='project.created' ORDER BY sequence DESC LIMIT 1").get(row.project_id) as Row | undefined;
        if (!project) throw compatibilityError(`Missing project creation event for '${row.project_id}'.`);
        append(row.project_id, "project.created", project.occurred_at, parse(project.payload_json, {}), "project");
      }
      const appThread: Payload = { ...current, ...threadPayload(row), lastVisitedAt: current?.lastVisitedAt ?? null };
      appThread.pullRequests = pullRequests.map(pr => ({ host: pr.host, repository: pr.repository, number: pr.number, url: pr.url, source: pr.source, linkedAt: pr.linked_at, snapshot: parse(pr.snapshot_json, null), stack: parse(pr.stack_json, null) }));
      if (!current) append(row.thread_id, "thread.created", row.created_at, appThread);
      const resume = runtime ? parse<Row>(runtime.resume_cursor_json, {}) : {};
      const driver = runtime?.provider_name;
      const nativeId = driver === "codex" ? resume.threadId : driver === "claudeAgent" ? resume.resume : undefined;
      let providerThreadId: string | null = null;
      if (typeof nativeId === "string" && nativeId && (driver === "codex" || driver === "claudeAgent")) {
        providerThreadId = `provider-thread:provider:${driver}:native-thread:${encodeURIComponent(nativeId)}`;
        appThread.activeProviderThreadId = providerThreadId;
        result.resumeBindings++;
      } else if (runtime) result.warnings.push(`Thread '${row.thread_id}' has no supported native resume identity.`);
      if (providerThreadId) append(row.thread_id, "provider-thread.updated", row.updated_at, {
        id: providerThreadId, driver, providerInstanceId: runtime?.provider_instance_id ?? driver,
        providerSessionId: null, appThreadId: row.thread_id, ownerNodeId: null,
        nativeThreadRef: { driver, nativeId, strength: "strong" }, nativeConversationHeadRef: null,
        status: "idle", firstRunOrdinal: null, lastRunOrdinal: null, handoffIds: [], forkedFrom: null,
        pendingBackgroundTasks: [], createdAt: row.created_at, updatedAt: row.updated_at,
      });
      const actualByUser = new Map(turns.map(turn => [turn.pending_message_id, turn]));
      const runsByTurn = new Map<string, Row>();
      const runsByUser = new Map<string, Row>();
      let runOrdinal = 0;
      for (const message of messages.filter(message => message.role === "user")) {
        const turn = actualByUser.get(message.message_id);
        const id = `migration:v1:run:${row.thread_id}:${turn?.turn_id ?? message.message_id}`;
        const run = { id, threadId: row.thread_id, ordinal: ++runOrdinal,
          providerInstanceId: appThread.providerInstanceId, modelSelection: appThread.modelSelection, providerThreadId,
          userMessageId: message.message_id, rootNodeId: null, activeAttemptId: null,
          status: turn?.state === "error" ? "failed" : turn && turn.state !== "completed" ? "interrupted" : "completed",
          requestedAt: turn?.requested_at ?? message.created_at, startedAt: turn?.started_at ?? message.created_at,
          completedAt: turn ? turn.completed_at : message.updated_at, checkpointId: null, contextHandoffId: null };
        runsByUser.set(message.message_id, run);
        if (turn) runsByTurn.set(turn.turn_id, run);
        append(row.thread_id, "run.updated", (run.completedAt ?? run.requestedAt) as string, run);
      }
      let lastRun: Row | undefined;
      const timeline: Array<{ kind: "message" | "activity" | "plan"; row: Row; run?: Row }> = [];
      for (const message of messages) {
        if (message.role === "user") lastRun = runsByUser.get(message.message_id);
        const run = runsByTurn.get(message.turn_id) ?? lastRun;
        timeline.push({ kind: "message", row: message, ...(run ? { run } : {}) });
      }
      for (const activity of activities) {
        const run = runsByTurn.get(activity.turn_id);
        timeline.push({ kind: "activity", row: activity, ...(run ? { run } : {}) });
      }
      for (const plan of plans) {
        const run = runsByTurn.get(plan.turn_id);
        timeline.push({ kind: "plan", row: plan, ...(run ? { run } : {}) });
      }
      timeline.sort((a, b) => a.row.created_at.localeCompare(b.row.created_at) || (a.kind === "message" && a.row.role === "user" ? -1 : b.kind === "message" && b.row.role === "user" ? 1 : 0));
      const ordinals = new Map<string, number>();
      let previousOrdinal = 0;
      const historicalItemIds: string[] = [];
      for (const item of timeline) {
        const itemRow = item.row;
        const runKey = item.run?.id ?? "unassigned";
        const inRun = (ordinals.get(runKey) ?? 0) + 1; ordinals.set(runKey, inRun);
        if (inRun >= 1_000_000) throw compatibilityError(`Thread '${row.thread_id}' exceeds the native per-run item limit.`);
        // Recovered turns can interleave with older synthetic user timestamps.
        // Keep source timeline order even when their run ordinals go backwards.
        const ordinal = Math.max(previousOrdinal + 1, (item.run?.ordinal ?? 0) * 1_000_000 + inRun);
        previousOrdinal = ordinal;
        const itemId = item.kind === "message" ? `migration:v1:turn-item:${itemRow.message_id}` : `${PREFIX}:${item.kind}:${itemRow.activity_id ?? itemRow.plan_id}`;
        historicalItemIds.push(itemId);
        const base = { id: itemId, threadId: row.thread_id, runId: item.run?.id ?? null, nodeId: null,
          providerThreadId, providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal,
          status: "completed", title: null, startedAt: itemRow.created_at, completedAt: itemRow.updated_at ?? itemRow.created_at,
          updatedAt: itemRow.updated_at ?? itemRow.created_at };
        let payload: Payload;
        if (item.kind === "message") {
          const attachments = parse<Row[]>(itemRow.attachments_json, []);
          for (const attachment of attachments) {
            const extension = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" } as Record<string, string>)[attachment.mimeType];
            if (!extension || basename(attachment.id) !== attachment.id) throw safetyError("Invalid legacy image descriptor.");
            const fileName = attachment.id + extension;
            const from = join(dirname(legacyPath), "attachments", fileName), to = join(paths.attachmentsDir, fileName);
            if (!existsSync(from)) throw safetyError(`Missing original attachment '${fileName}'.`);
            const original = readFileSync(from);
            if (original.length !== attachment.sizeBytes) throw safetyError(`Original attachment size mismatch for '${fileName}'.`);
            if (existsSync(to)) { if (hash(readFileSync(to)) !== hash(original)) throw safetyError(`Attachment conflict for '${fileName}'.`); }
            else { result.assets++; if (!options.dryRun) { mkdirSync(paths.attachmentsDir, { recursive: true }); copyFileSync(from, to); newAssets.push(to); } }
          }
          const message = { createdBy: itemRow.role === "user" ? "user" : "agent", creationSource: "server", id: itemRow.message_id,
            threadId: row.thread_id, runId: base.runId, nodeId: null, role: itemRow.role, text: itemRow.text,
            attachments, streaming: false, createdAt: itemRow.created_at, updatedAt: itemRow.updated_at,
            ...(itemRow.context_json ? { context: parse(itemRow.context_json, {}) } : {}) };
          append(row.thread_id, "message.updated", itemRow.updated_at, message);
          payload = itemRow.role === "user" ? { ...base, ...message, id: itemId, type: "user_message", messageId: itemRow.message_id, inputIntent: "turn_start" }
            : { ...base, type: "assistant_message", messageId: itemRow.message_id, text: itemRow.text, attachments, streaming: false };
          result.messages++;
        } else if (item.kind === "activity") {
          payload = legacyActivityItem(itemRow, base); result.activities++;
          if (payload.status === "failed") result.failedActivities++;
        } else {
          const nodeId = `${PREFIX}:plan-node:${itemRow.plan_id}`;
          append(row.thread_id, "plan.updated", itemRow.updated_at, { id: itemRow.plan_id, threadId: row.thread_id, runId: base.runId,
            nodeId, status: itemRow.implemented_at ? "completed" : "draft", kind: "proposed_plan", markdown: itemRow.plan_markdown });
          payload = { ...base, nodeId, type: "proposed_plan", planId: itemRow.plan_id, markdown: itemRow.plan_markdown, streaming: false }; result.plans++;
        }
        append(row.thread_id, "turn-item.updated", base.updatedAt, payload);
      }
      if (providerThreadId && typeof nativeId === "string" && runOrdinal > 0) {
        const last = [...runsByUser.values()].at(-1)!;
        append(row.thread_id, "context-handoff.updated", row.updated_at, nativeHistoryCoverage({
          threadId: row.thread_id, nativeId, providerThreadId, lastRunId: last.id,
          runCount: runOrdinal, itemIds: historicalItemIds, createdAt: row.created_at, updatedAt: row.updated_at,
        }));
      }
      // Native reducers advance thread.updatedAt for each content event. Restore
      // authoritative legacy metadata last so a rebuild matches the saved view.
      append(row.thread_id, "thread.metadata-updated", row.updated_at, appThread);
      if (!options.dryRun) target.prepare("INSERT INTO t3_import_v2_checkpoints VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET fingerprint=excluded.fingerprint").run(row.thread_id, fingerprint);
      result.threads++;
    }
    if (requested && result.threads + result.unchangedThreads !== requested.size) throw compatibilityError("One or more requested V1 thread IDs were not found.");
    if (targetTransaction) {
      if (result.events > 0) target.prepare("INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections',2,?,?) ON CONFLICT(projection_name) DO UPDATE SET schema_version=2,last_sequence=excluded.last_sequence,updated_at=excluded.updated_at").run((target.prepare("SELECT MAX(sequence) n FROM orchestration_events WHERE aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread')").get() as Row).n, new Date().toISOString());
      target.exec("COMMIT"); targetTransaction = false;
    }
    if (!options.dryRun && result.events > 0) result.status = "upgraded";
    return result;
  } catch (error) {
    if (targetTransaction) target.exec("ROLLBACK");
    for (const asset of newAssets) unlinkSync(asset);
    throw error;
  } finally {
    source.close(); target.close();
  }
}
