import { homedir } from "node:os";
import { basename, join } from "node:path";
import { stat } from "node:fs/promises";
import type {
  CanonicalActivity,
  CanonicalConversation,
  CanonicalMessage,
  CanonicalPlan,
  CanonicalThread,
  CanonicalTurn,
  DiscoveryOptions,
  SourceAdapter,
  SourceAttachment,
  SourceSummary,
} from "../core/types.js";
import { readStableJsonl } from "../core/jsonl.js";
import {
  canonicalPath,
  deriveTitle,
  isObject,
  isoTimestamp,
  pathContains,
  stringValue,
  truncate,
  type JsonObject,
} from "../core/util.js";
import { sourceError } from "../core/errors.js";
import { walkFiles } from "./files.js";
import { listFromCodexAppServer, readFromCodexAppServer, type CodexThreadMetadata } from "./codexAppServer.js";

const SYNTHETIC_PREFIXES = ["<recommended_plugins>", "<environment_context>", "<app-context>", "<permissions instructions>"];

interface PendingTurn {
  id: string;
  startedAt: string;
  completedAt?: string;
  complete: boolean;
  users: CanonicalMessage[];
  assistant: CanonicalMessage[];
  activities: CanonicalActivity[];
  plans: CanonicalPlan[];
  toolCalls: Map<string, { name: string; input: unknown; timestamp: string }>;
}

function codexRoot(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function textParts(content: unknown, role: "user" | "assistant"): { text: string; attachments: SourceAttachment[] } {
  if (!Array.isArray(content)) return { text: "", attachments: [] };
  const text: string[] = [];
  const attachments: SourceAttachment[] = [];
  for (const [index, raw] of content.entries()) {
    if (!isObject(raw)) continue;
    const value = stringValue(raw.text) ?? stringValue(raw[role === "user" ? "input_text" : "output_text"]);
    if (value) text.push(value);
    const url = stringValue(raw.image_url) ?? stringValue(raw.url);
    if (!url || role !== "user") continue;
    if (url.startsWith("data:image/")) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/iu.exec(url);
      if (!match) continue;
      const data = Buffer.from(match[2]!, "base64");
      attachments.push({
        sourceId: `image:${index}`,
        name: `image-${index + 1}`,
        mimeType: match[1]!,
        sizeBytes: data.length,
        data,
      });
    } else {
      attachments.push({
        sourceId: `image:${index}`,
        name: `image-${index + 1}`,
        mimeType: "image/unknown",
        sizeBytes: 0,
        remoteUrl: url,
      });
    }
  }
  return { text: text.join("\n\n").trim(), attachments };
}

function newPending(id: string, timestamp: string): PendingTurn {
  return {
    id,
    startedAt: timestamp,
    complete: false,
    users: [],
    assistant: [],
    activities: [],
    plans: [],
    toolCalls: new Map(),
  };
}

function contentString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.flatMap((part) => {
      if (typeof part === "string") return [part];
      if (!isObject(part)) return [];
      return typeof part.text === "string" ? [part.text] : [];
    }).join("\n").trim();
  }
  return value === undefined ? "" : JSON.stringify(value);
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function codexUsageActivity(info: unknown, sourceId: string, timestamp: string): CanonicalActivity | undefined {
  if (!isObject(info) || !isObject(info.last_token_usage)) return undefined;
  const last = info.last_token_usage;
  const total = isObject(info.total_token_usage) ? info.total_token_usage : undefined;
  const usedTokens = nonNegativeInt(last.total_tokens);
  if (!usedTokens || usedTokens <= 0) return undefined;
  const inputTokens = nonNegativeInt(last.input_tokens);
  const cachedInputTokens = nonNegativeInt(last.cached_input_tokens);
  const outputTokens = nonNegativeInt(last.output_tokens);
  const reasoningOutputTokens = nonNegativeInt(last.reasoning_output_tokens);
  const totalProcessedTokens = total ? nonNegativeInt(total.total_tokens) : undefined;
  const maxTokens = nonNegativeInt(info.model_context_window);
  return {
    sourceId,
    timestamp,
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: {
      usedTokens,
      lastUsedTokens: usedTokens,
      ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
      ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
      ...(inputTokens !== undefined ? { inputTokens, lastInputTokens: inputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens, lastOutputTokens: outputTokens } : {}),
      ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens } : {}),
      compactsAutomatically: true,
    },
  };
}

function classifyTool(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("mcp")) return "mcp_tool_call";
  if (lower.includes("web") || lower.includes("search")) return "web_search";
  if (lower.includes("image") || lower.includes("view")) return "image_view";
  if (lower.includes("patch") || lower.includes("edit") || lower.includes("write")) return "file_change";
  if (lower.includes("shell") || lower.includes("exec") || lower.includes("command")) return "command_execution";
  if (lower.includes("agent") || lower.includes("collab")) return "collab_agent_tool_call";
  return "dynamic_tool_call";
}

function toolActivity(
  sourceId: string,
  timestamp: string,
  name: string,
  input: unknown,
  output: unknown,
): CanonicalActivity {
  const itemType = classifyTool(name);
  const outputText = contentString(output);
  const failed = isObject(output) && (output.is_error === true || output.success === false);
  return {
    sourceId,
    timestamp,
    tone: failed ? "error" : "tool",
    kind: "tool.completed",
    summary: truncate(name || "Tool", 120),
    payload: {
      itemType,
      status: failed ? "failed" : "completed",
      title: name || "Tool",
      ...(outputText ? { detail: truncate(outputText) } : {}),
      ...(itemType === "collab_agent_tool_call" ? { agentId: sourceId } : {}),
      data: { toolCallId: sourceId, item: { name, input, output } },
    },
  };
}

function reasoningText(payload: JsonObject): string {
  const direct = stringValue(payload.text) ?? stringValue(payload.message) ?? stringValue(payload.reasoning);
  if (direct) return direct;
  const summary = payload.summary;
  if (Array.isArray(summary)) {
    return summary.flatMap((entry) => isObject(entry) && typeof entry.text === "string" ? [entry.text] : []).join("\n").trim();
  }
  return "";
}

function parseRows(
  rows: unknown[],
  filePath: string,
  fallbackTime: string,
  includeIncomplete: boolean,
  appThread?: Record<string, unknown> | null,
): CanonicalThread {
  let sessionId: string | undefined;
  let workspace: string | undefined;
  let startedAt = fallbackTime;
  let model = "default";
  let effort: string | undefined;
  let gitBranch: string | undefined;
  let active: PendingTurn | undefined;
  const turns: PendingTurn[] = [];
  let recordIndex = 0;
  let lastUsageSignature: string | undefined;

  const ensureTurn = (timestamp: string, id?: string): PendingTurn => {
    if (!active) active = newPending(id ?? `turn-${recordIndex}`, timestamp);
    return active;
  };

  for (const raw of rows) {
    recordIndex += 1;
    if (!isObject(raw) || !isObject(raw.payload)) continue;
    const payload = raw.payload;
    const timestamp = isoTimestamp(raw.timestamp, fallbackTime);
    const type = stringValue(raw.type);
    if (type === "session_meta") {
      sessionId = stringValue(payload.id) ?? stringValue(payload.session_id) ?? sessionId;
      workspace = stringValue(payload.cwd) ?? workspace;
      startedAt = isoTimestamp(payload.timestamp, timestamp);
      gitBranch = stringValue(payload.git_branch) ?? stringValue(payload.gitBranch) ?? gitBranch;
      continue;
    }
    if (type === "turn_context") {
      model = stringValue(payload.model) ?? model;
      effort = stringValue(payload.effort) ?? effort;
      workspace = stringValue(payload.cwd) ?? workspace;
      continue;
    }
    if (type === "event_msg") {
      const eventType = stringValue(payload.type) ?? "";
      const turnId = stringValue(payload.turn_id);
      if (eventType === "task_started") {
        if (active?.users.length) turns.push(active);
        active = newPending(turnId ?? `turn-${recordIndex}`, isoTimestamp(payload.started_at, timestamp));
      } else if (eventType === "task_complete" && active) {
        active.complete = true;
        active.completedAt = timestamp;
        turns.push(active);
        active = undefined;
      } else if (eventType === "agent_reasoning" && active) {
        const detail = reasoningText(payload);
        if (detail) active.activities.push({ sourceId: `event:${recordIndex}`, timestamp, tone: "info", kind: "reasoning.summary", summary: "Reasoning", payload: { detail } });
      } else if ((eventType === "context_compacted" || eventType === "context_compaction") && active) {
        active.activities.push({ sourceId: `event:${recordIndex}`, timestamp, tone: "info", kind: "context-compaction", summary: "Context compacted", payload: { state: "compacted" } });
      } else if (eventType === "token_count" && active && isObject(payload.info) && isObject(payload.info.last_token_usage)) {
        const signature = JSON.stringify(payload.info.last_token_usage);
        if (signature !== lastUsageSignature) {
          lastUsageSignature = signature;
          const usage = codexUsageActivity(payload.info, `usage:${recordIndex}`, timestamp);
          if (usage) active.activities.push(usage);
        }
      } else if ((eventType.endsWith("_end") || eventType.endsWith("_completed")) && active && !["agent_message"].includes(eventType)) {
        const itemType = eventType.includes("patch") ? "file_change" : eventType.includes("web_search") ? "web_search" : eventType.includes("mcp") ? "mcp_tool_call" : undefined;
        if (itemType) active.activities.push({
          sourceId: `event:${recordIndex}`,
          timestamp,
          tone: payload.success === false ? "error" : "tool",
          kind: "tool.completed",
          summary: truncate(eventType.replaceAll("_", " "), 120),
          payload: { itemType, status: payload.success === false ? "failed" : "completed", data: { item: payload } },
        });
      }
      continue;
    }
    if (type !== "response_item") continue;
    const itemType = stringValue(payload.type) ?? "";
    if (itemType === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const parsed = textParts(payload.content, role);
      if (!parsed.text && parsed.attachments.length === 0) continue;
      if (role === "user" && SYNTHETIC_PREFIXES.some((prefix) => parsed.text.startsWith(prefix))) continue;
      const turn = ensureTurn(timestamp, stringValue(payload.turn_id));
      const message: CanonicalMessage = {
        sourceId: stringValue(payload.id) ?? `message:${recordIndex}`,
        role,
        text: parsed.text || "[Image attachment]",
        timestamp,
        attachments: parsed.attachments.map((attachment) => ({ ...attachment, sourceId: `${recordIndex}:${attachment.sourceId}` })),
      };
      if (role === "user") turn.users.push(message); else turn.assistant.push(message);
    } else if (itemType === "reasoning" && active) {
      const detail = reasoningText(payload);
      if (detail) active.activities.push({ sourceId: stringValue(payload.id) ?? `reasoning:${recordIndex}`, timestamp, tone: "info", kind: "reasoning.summary", summary: "Reasoning", payload: { detail } });
    } else if (["custom_tool_call", "function_call", "local_shell_call"].includes(itemType)) {
      const turn = ensureTurn(timestamp);
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `call:${recordIndex}`;
      const name = stringValue(payload.name) ?? (itemType === "local_shell_call" ? "Command" : "Tool");
      const input = parseToolInput(payload.input ?? payload.arguments ?? payload.command);
      turn.toolCalls.set(callId, { name, input, timestamp });
      if (classifyTool(name) === "collab_agent_tool_call" && name.toLowerCase().includes("spawn")) {
        const record = isObject(input) ? input : {};
        const title = stringValue(record.task_name) ?? stringValue(record.message) ?? stringValue(record.prompt) ?? "Subagent task";
        turn.activities.push({ sourceId: `${callId}:task-started`, timestamp, tone: "info", kind: "task.started", summary: "Task started", payload: { taskId: callId, title: truncate(title, 120), detail: truncate(title), role: stringValue(record.role) ?? "agent", agentKind: "agent", toolUseId: callId } });
      }
      if (name === "update_plan" && isObject(input) && Array.isArray(input.plan)) {
        turn.activities.push({ sourceId: `plan-update:${callId}`, timestamp, tone: "info", kind: "turn.plan.updated", summary: "Plan updated", payload: { plan: input.plan, ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}) } });
      }
    } else if (["custom_tool_call_output", "function_call_output", "local_shell_call_output"].includes(itemType)) {
      const turn = ensureTurn(timestamp);
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `call:${recordIndex}`;
      const call = turn.toolCalls.get(callId) ?? { name: "Tool", input: undefined, timestamp };
      turn.activities.push(toolActivity(callId, timestamp, call.name, call.input, payload.output ?? payload.content ?? payload));
      if (classifyTool(call.name) === "collab_agent_tool_call" && call.name.toLowerCase().includes("spawn")) {
        const failed = isObject(payload.output) && (payload.output.is_error === true || payload.output.success === false);
        turn.activities.push({ sourceId: `${callId}:task-finished`, timestamp, tone: failed ? "error" : "info", kind: "task.updated", summary: failed ? "Task failed" : "Task completed", payload: { taskId: callId, status: failed ? "failed" : "completed", agentKind: "agent", toolUseId: callId } });
      }
    }
  }
  if (active?.users.length && includeIncomplete) turns.push(active);
  if (!sessionId) throw sourceError(`Codex rollout has no session id: ${filePath}`);
  workspace = workspace ?? (appThread ? stringValue(appThread.cwd) : undefined);
  if (!workspace) throw sourceError(`Codex rollout has no workspace: ${filePath}`);

  const canonicalTurns: CanonicalTurn[] = turns.flatMap((turn) => {
    if (!turn.complete && !includeIncomplete) return [];
    if (turn.users.length === 0) return [];
    const [first, ...rest] = turn.users;
    const user: CanonicalMessage = {
      ...first!,
      text: [first!.text, ...rest.map((entry) => entry.text)].filter(Boolean).join("\n\n"),
      attachments: turn.users.flatMap((entry) => entry.attachments).slice(0, 8),
    };
    return [{ id: turn.id, startedAt: turn.startedAt, ...(turn.completedAt ? { completedAt: turn.completedAt } : {}), complete: turn.complete, user, assistant: turn.assistant, activities: turn.activities, plans: turn.plans }];
  });
  if (canonicalTurns.length === 0) throw sourceError(`No importable Codex turns in ${filePath}`);
  const first = canonicalTurns[0]!;
  const last = canonicalTurns.at(-1)!;
  const preview = appThread && stringValue(appThread.preview);
  return {
    source: "codex",
    sourceSessionId: sessionId,
    sourceKey: `codex:${sessionId}`,
    currentBranch: true,
    title: preview ? deriveTitle(preview) : deriveTitle(first.user.text),
    workspace,
    ...(gitBranch ? { gitBranch } : {}),
    model: appThread && stringValue(appThread.model) || model,
    ...(effort ? { effort } : {}),
    createdAt: startedAt,
    updatedAt: last.completedAt ?? last.assistant.at(-1)?.timestamp ?? last.user.timestamp,
    turns: canonicalTurns,
    resumeCursor: { threadId: sessionId },
    warnings: [],
  };
}

async function rawSummaries(options: DiscoveryOptions): Promise<{ summaries: SourceSummary[]; rowsById: Map<string, string> }> {
  const files = await walkFiles(join(codexRoot(), "sessions"), ".jsonl");
  const summaries: SourceSummary[] = [];
  const rowsById = new Map<string, string>();
  for (const path of files) {
    try {
      const fileStat = await stat(path);
      const fallback = fileStat.mtime.toISOString();
      const snapshot = await readStableJsonl(path);
      const thread = parseRows(snapshot.rows, path, fallback, true);
      if (options.workspace && canonicalPath(thread.workspace) !== canonicalPath(options.workspace)) continue;
      if (options.since && new Date(thread.updatedAt) < options.since) continue;
      summaries.push({
        source: "codex",
        id: thread.sourceSessionId,
        title: thread.title,
        workspace: thread.workspace,
        path,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        status: thread.turns.at(-1)?.complete ? "complete" : "incomplete",
        branches: 1,
      });
      rowsById.set(thread.sourceSessionId, path);
    } catch {
      // Discovery is best effort; load reports a selected file's exact error.
    }
  }
  return { summaries, rowsById };
}

export class CodexSource implements SourceAdapter {
  readonly name = "codex" as const;
  private appMetadata = new Map<string, CodexThreadMetadata>();

  async discover(options: DiscoveryOptions): Promise<SourceSummary[]> {
    const raw = await rawSummaries(options);
    try {
      const app = await listFromCodexAppServer(options.workspace);
      this.appMetadata = new Map(app.map((entry) => [entry.id, entry]));
      for (const summary of raw.summaries) {
        const metadata = this.appMetadata.get(summary.id);
        if (metadata?.preview) summary.title = deriveTitle(metadata.preview);
        if (metadata?.parentThreadId) summary.parentId = metadata.parentThreadId;
      }
    } catch {
      this.appMetadata.clear();
    }
    return raw.summaries
      .filter((summary) => !summary.parentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async load(summary: SourceSummary, options: DiscoveryOptions): Promise<CanonicalConversation> {
    try {
      const fileStat = await stat(summary.path);
      const snapshot = await readStableJsonl(summary.path);
      let appThread: Record<string, unknown> | null = this.appMetadata.get(summary.id)?.raw ?? null;
      try { appThread = await readFromCodexAppServer(summary.id) ?? appThread; } catch { /* raw fallback */ }
      const thread = parseRows(snapshot.rows, summary.path, fileStat.mtime.toISOString(), options.includeIncomplete ?? false, appThread);
      return { summary: { ...summary, title: thread.title, status: thread.turns.at(-1)?.complete ? "complete" : "incomplete" }, threads: [thread], fingerprint: snapshot.fingerprint };
    } catch (error) {
      if (error instanceof Error && error.name === "ImporterError") throw error;
      throw sourceError(`Unable to load Codex conversation ${summary.id}`, error);
    }
  }
}

export function inferCurrentWorkspace(summaries: SourceSummary[], cwd = process.cwd()): string | undefined {
  return summaries
    .map((summary) => summary.workspace)
    .filter((workspace, index, all) => all.findIndex((entry) => canonicalPath(entry) === canonicalPath(workspace)) === index)
    .filter((workspace) => pathContains(workspace, cwd))
    .sort((left, right) => canonicalPath(right).length - canonicalPath(left).length)[0];
}
