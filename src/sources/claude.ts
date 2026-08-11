import { homedir } from "node:os";
import { join } from "node:path";
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
import { canonicalPath, deriveTitle, isObject, isoTimestamp, stringValue, truncate, type JsonObject } from "../core/util.js";
import { sourceError } from "../core/errors.js";
import { walkFiles } from "./files.js";

interface ClaudeNode {
  uuid: string;
  parentUuid?: string;
  type: string;
  timestamp: string;
  row: JsonObject;
  sidechain: boolean;
}

interface ClaudeMetadata {
  sessionId: string;
  workspace: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: Map<string, ClaudeNode>;
  leaves: ClaudeNode[];
  currentLeaf: ClaudeNode;
  model: string;
  effort?: string;
  gitBranch?: string;
}

function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

function readBlocks(content: unknown): JsonObject[] {
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  return readBlocks(content)
    .flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : [])
    .join("\n\n")
    .trim();
}

function attachmentsFromContent(content: unknown, nodeId: string): SourceAttachment[] {
  const output: SourceAttachment[] = [];
  for (const [index, block] of readBlocks(content).entries()) {
    if (block.type !== "image" || !isObject(block.source)) continue;
    const mimeType = stringValue(block.source.media_type) ?? "image/unknown";
    const dataValue = stringValue(block.source.data);
    if (block.source.type === "base64" && dataValue) {
      const data = Buffer.from(dataValue, "base64");
      output.push({ sourceId: `${nodeId}:image:${index}`, name: `image-${index + 1}`, mimeType, sizeBytes: data.length, data });
    } else {
      const url = stringValue(block.source.url);
      if (url) output.push({ sourceId: `${nodeId}:image:${index}`, name: `image-${index + 1}`, mimeType, sizeBytes: 0, remoteUrl: url });
    }
  }
  return output;
}

function messageContent(row: JsonObject): unknown {
  return isObject(row.message) ? row.message.content : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function claudeUsageActivity(row: JsonObject, nodeId: string, timestamp: string): CanonicalActivity | undefined {
  if (!isObject(row.message) || !isObject(row.message.usage)) return undefined;
  const usage = row.message.usage;
  const iterations = Array.isArray(usage.iterations) ? usage.iterations.filter(isObject) : [];
  const active = iterations.at(-1) ?? usage;
  const inputTokens = (nonNegativeInt(active.input_tokens) ?? 0)
    + (nonNegativeInt(active.cache_creation_input_tokens) ?? 0)
    + (nonNegativeInt(active.cache_read_input_tokens) ?? 0);
  const outputTokens = nonNegativeInt(active.output_tokens) ?? 0;
  const usedTokens = nonNegativeInt(active.total_tokens) ?? inputTokens + outputTokens;
  if (usedTokens <= 0) return undefined;
  const cachedInputTokens = nonNegativeInt(active.cache_read_input_tokens);
  return {
    sourceId: `${nodeId}:usage`,
    timestamp,
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: {
      usedTokens,
      lastUsedTokens: usedTokens,
      ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    },
  };
}

function isConversationEndpoint(node: ClaudeNode): boolean {
  if (node.sidechain || (node.type !== "user" && node.type !== "assistant")) return false;
  const content = messageContent(node.row);
  if (textFromContent(content)) return true;
  return node.type === "user" && attachmentsFromContent(content, node.uuid).length > 0;
}

function nearestConversationEndpoint(
  nodes: Map<string, ClaudeNode>,
  start: ClaudeNode,
): ClaudeNode | undefined {
  const visited = new Set<string>();
  let node: ClaudeNode | undefined = start;
  while (node && !visited.has(node.uuid)) {
    visited.add(node.uuid);
    if (isConversationEndpoint(node)) return node;
    node = node.parentUuid ? nodes.get(node.parentUuid) : undefined;
  }
  return undefined;
}

function isAncestor(nodes: Map<string, ClaudeNode>, ancestorId: string, node: ClaudeNode): boolean {
  const visited = new Set<string>();
  let current: ClaudeNode | undefined = node;
  while (current && !visited.has(current.uuid)) {
    if (current.uuid === ancestorId) return true;
    visited.add(current.uuid);
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
  }
  return false;
}

function analyze(rows: unknown[], fallbackTime: string): ClaudeMetadata {
  const nodes = new Map<string, ClaudeNode>();
  const referenced = new Set<string>();
  let sessionId: string | undefined;
  let workspace: string | undefined;
  let title: string | undefined;
  let model = "default";
  let effort: string | undefined;
  let gitBranch: string | undefined;
  let currentLeafId: string | undefined;
  let createdAt = fallbackTime;
  let updatedAt = fallbackTime;

  for (const raw of rows) {
    if (!isObject(raw)) continue;
    sessionId = stringValue(raw.sessionId) ?? sessionId;
    // Claude can change cwd while executing tools. The first cwd is the session's
    // workspace; later values are often inspected subdirectories.
    workspace = workspace ?? stringValue(raw.cwd);
    effort = stringValue(raw.effort) ?? effort;
    gitBranch = stringValue(raw.gitBranch) ?? gitBranch;
    if (raw.type === "custom-title") title = stringValue(raw.customTitle) ?? title;
    else if (raw.type === "ai-title" && !title) title = stringValue(raw.aiTitle) ?? title;
    else if (raw.type === "last-prompt") currentLeafId = stringValue(raw.leafUuid) ?? currentLeafId;
    const uuid = stringValue(raw.uuid);
    const type = raw.type;
    if (!uuid || typeof type !== "string") continue;
    const timestamp = isoTimestamp(raw.timestamp, fallbackTime);
    const parentUuid = stringValue(raw.parentUuid);
    if (parentUuid) referenced.add(parentUuid);
    nodes.set(uuid, {
      uuid,
      ...(parentUuid ? { parentUuid } : {}),
      type,
      timestamp,
      row: raw,
      sidechain: raw.isSidechain === true,
    });
    if (timestamp < createdAt) createdAt = timestamp;
    if (timestamp > updatedAt) updatedAt = timestamp;
    if (type === "assistant" && isObject(raw.message)) model = stringValue(raw.message.model) ?? model;
  }
  if (!sessionId) throw sourceError("Claude transcript has no sessionId");
  if (!workspace) throw sourceError(`Claude transcript ${sessionId} has no cwd`);
  const mainNodes = [...nodes.values()].filter((node) => !node.sidechain);
  const physicalLeaves = mainNodes.filter((node) => !referenced.has(node.uuid));
  const endpointById = new Map<string, ClaudeNode>();
  for (const leaf of physicalLeaves) {
    const endpoint = nearestConversationEndpoint(nodes, leaf);
    if (endpoint) endpointById.set(endpoint.uuid, endpoint);
  }
  const endpoints = [...endpointById.values()];
  const leaves = endpoints.filter(
    (candidate) => !endpoints.some(
      (other) => other.uuid !== candidate.uuid && isAncestor(nodes, candidate.uuid, other),
    ),
  );
  if (leaves.length === 0) throw sourceError(`Claude transcript ${sessionId} has no conversation leaf`);
  let currentLeaf = currentLeafId
    ? leaves
        .filter((leaf) => isAncestor(nodes, currentLeafId!, leaf))
        .toSorted((a, b) => b.timestamp.localeCompare(a.timestamp))[0]
    : undefined;
  currentLeaf ??= leaves.toSorted((a, b) => b.timestamp.localeCompare(a.timestamp))[0]!;
  const firstUser = mainNodes.find((node) => node.type === "user" && isConversationEndpoint(node));
  title = title ?? deriveTitle(firstUser ? textFromContent(messageContent(firstUser.row)) : "Claude conversation");
  return { sessionId, workspace, title, createdAt, updatedAt, nodes, leaves, currentLeaf, model, ...(effort ? { effort } : {}), ...(gitBranch ? { gitBranch } : {}) };
}

function lineage(metadata: ClaudeMetadata, leaf: ClaudeNode): ClaudeNode[] {
  const result: ClaudeNode[] = [];
  const visited = new Set<string>();
  let node: ClaudeNode | undefined = leaf;
  while (node && !visited.has(node.uuid)) {
    visited.add(node.uuid);
    if (!node.sidechain) result.push(node);
    node = node.parentUuid ? metadata.nodes.get(node.parentUuid) : undefined;
  }
  return result.reverse();
}

function classifyClaudeTool(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower.includes("shell") || lower.includes("command")) return "command_execution";
  if (["edit", "write", "multiedit", "notebookedit"].some((part) => lower.includes(part))) return "file_change";
  if (lower.includes("web") || lower.includes("search")) return "web_search";
  if (lower.includes("mcp")) return "mcp_tool_call";
  if (lower === "task" || lower.includes("agent")) return "collab_agent_tool_call";
  if (lower.includes("image") || lower === "read") return "image_view";
  return "dynamic_tool_call";
}

function normalizePlan(input: JsonObject): Array<{ step: string; status: "pending" | "inProgress" | "completed" }> {
  const raw = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : [];
  return raw.flatMap((value) => {
    if (!isObject(value)) return [];
    const step = stringValue(value.content) ?? stringValue(value.step) ?? stringValue(value.subject);
    if (!step) return [];
    const statusValue = stringValue(value.status);
    const status = statusValue === "completed" ? "completed" : statusValue === "in_progress" || statusValue === "inProgress" ? "inProgress" : "pending";
    return [{ step, status }];
  });
}

function buildThread(metadata: ClaudeMetadata, leaf: ClaudeNode, branchIndex: number): CanonicalThread {
  const chain = lineage(metadata, leaf);
  const turns: CanonicalTurn[] = [];
  let active: CanonicalTurn | undefined;
  const toolResults = new Map<string, { output: unknown; failed: boolean; timestamp: string }>();
  for (const node of metadata.nodes.values()) {
    if (node.type !== "user") continue;
    for (const block of readBlocks(messageContent(node.row))) {
      if (block.type !== "tool_result") continue;
      const callId = stringValue(block.tool_use_id);
      if (callId) toolResults.set(callId, { output: block.content, failed: block.is_error === true, timestamp: node.timestamp });
    }
  }
  let lastAssistantUuid: string | undefined;
  let lastUsageSignature: string | undefined;

  const appendActivity = (activity: CanonicalActivity) => {
    if (active) active.activities.push(activity);
  };

  for (const node of chain) {
    const content = messageContent(node.row);
    const blocks = readBlocks(content);
    if (node.type === "user") {
      const text = textFromContent(content);
      const attachments = attachmentsFromContent(content, node.uuid);
      if (text || attachments.length > 0) {
        if (active) turns.push(active);
        active = {
          id: node.uuid,
          startedAt: node.timestamp,
          complete: false,
          user: { sourceId: node.uuid, role: "user", text: text || "[Image attachment]", timestamp: node.timestamp, attachments },
          assistant: [], activities: [], plans: [],
        };
      }
    } else if (node.type === "assistant" && active) {
      lastAssistantUuid = node.uuid;
      const usage = claudeUsageActivity(node.row, node.uuid, node.timestamp);
      if (usage) {
        const signature = JSON.stringify(usage.payload);
        if (signature !== lastUsageSignature) {
          lastUsageSignature = signature;
          active.activities.push(usage);
        }
      }
      for (const [blockIndex, block] of blocks.entries()) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          active.assistant.push({ sourceId: `${node.uuid}:text:${blockIndex}`, role: "assistant", text: block.text.trim(), timestamp: node.timestamp, attachments: [] });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          active.activities.push({ sourceId: `${node.uuid}:thinking:${blockIndex}`, timestamp: node.timestamp, tone: "info", kind: "reasoning.summary", summary: "Reasoning", payload: { detail: block.thinking.trim() } });
        } else if (block.type === "tool_use") {
          const callId = stringValue(block.id) ?? `${node.uuid}:tool:${blockIndex}`;
          const name = stringValue(block.name) ?? "Tool";
          const input = block.input;
          const isAgent = classifyClaudeTool(name) === "collab_agent_tool_call";
          if (isAgent) {
            const inputRecord = isObject(input) ? input : {};
            const description = stringValue(inputRecord.description) ?? stringValue(inputRecord.prompt) ?? "Subagent task";
            active.activities.push({ sourceId: `${callId}:started`, timestamp: node.timestamp, tone: "info", kind: "task.started", summary: "Task started", payload: { taskId: callId, title: truncate(description, 120), detail: truncate(description), role: stringValue(inputRecord.subagent_type) ?? "general-purpose", agentKind: "agent", toolUseId: callId } });
          }
          if (name === "TodoWrite" && isObject(input)) {
            const plan = normalizePlan(input);
            if (plan.length) active.activities.push({ sourceId: `${callId}:plan`, timestamp: node.timestamp, tone: "info", kind: "turn.plan.updated", summary: "Plan updated", payload: { explanation: "Claude Tasks", plan } });
          }
          if (name === "ExitPlanMode" && isObject(input)) {
            const markdown = stringValue(input.plan);
            if (markdown) active.plans.push({ sourceId: callId, markdown, timestamp: node.timestamp });
          }
          const result = toolResults.get(callId);
          const output = result?.output;
          const detail = typeof output === "string" ? output : textFromContent(output);
          active.activities.push({
            sourceId: callId,
            timestamp: result?.timestamp ?? node.timestamp,
            tone: result?.failed ? "error" : "tool",
            kind: "tool.completed",
            summary: truncate(name, 120),
            payload: {
              itemType: classifyClaudeTool(name),
              status: result?.failed ? "failed" : "completed",
              title: name,
              ...(detail ? { detail: truncate(detail) } : !result ? { detail: "Historical tool call has no recorded result." } : {}),
              ...(isAgent ? { agentId: callId } : {}),
              data: { toolCallId: callId, item: { name, input, output } },
            },
          });
          if (isAgent) {
            active.activities.push({
              sourceId: `${callId}:finished`,
              timestamp: result?.timestamp ?? node.timestamp,
              tone: result?.failed ? "error" : "info",
              kind: "task.updated",
              summary: result?.failed ? "Task failed" : result ? "Task completed" : "Task interrupted",
              payload: { taskId: callId, status: result?.failed ? "failed" : result ? "completed" : "interrupted", agentKind: "agent", toolUseId: callId },
            });
          }
        }
      }
      const stop = isObject(node.row.message) ? node.row.message.stop_reason : undefined;
      if (stop === "end_turn" || stop === "stop_sequence") {
        active.complete = true;
        active.completedAt = node.timestamp;
      }
    }
  }
  if (active) turns.push(active);
  const currentBranch = leaf.uuid === metadata.currentLeaf.uuid;
  const branchSuffix = currentBranch || metadata.leaves.length === 1 ? "" : ` · historical ${branchIndex + 1}`;
  const warnings = currentBranch ? [] : ["Historical Claude branch: new prompts will not resume this branch's provider context."];
  if (!turns.length) throw sourceError(`Claude branch ${leaf.uuid} contains no user turns`);
  return {
    source: "claude",
    sourceSessionId: metadata.sessionId,
    sourceKey: `claude:${metadata.sessionId}:${leaf.uuid}`,
    leafId: leaf.uuid,
    currentBranch,
    title: `${metadata.title}${branchSuffix}`,
    workspace: metadata.workspace,
    ...(metadata.gitBranch ? { gitBranch: metadata.gitBranch } : {}),
    model: metadata.model,
    ...(metadata.effort ? { effort: metadata.effort } : {}),
    createdAt: turns[0]!.startedAt,
    updatedAt: turns.at(-1)!.completedAt ?? turns.at(-1)!.assistant.at(-1)?.timestamp ?? turns.at(-1)!.user.timestamp,
    turns,
    ...(currentBranch ? { resumeCursor: { resume: metadata.sessionId, ...(lastAssistantUuid ? { resumeSessionAt: lastAssistantUuid } : {}), turnCount: turns.length } } : {}),
    warnings,
  };
}

export class ClaudeSource implements SourceAdapter {
  readonly name = "claude" as const;

  async discover(options: DiscoveryOptions): Promise<SourceSummary[]> {
    const files = await walkFiles(join(claudeRoot(), "projects"), ".jsonl");
    const summaries: SourceSummary[] = [];
    for (const path of files) {
      try {
        const fileStat = await stat(path);
        const snapshot = await readStableJsonl(path);
        const metadata = analyze(snapshot.rows, fileStat.mtime.toISOString());
        if (options.workspace && canonicalPath(metadata.workspace) !== canonicalPath(options.workspace)) continue;
        if (options.since && new Date(metadata.updatedAt) < options.since) continue;
        summaries.push({ source: "claude", id: metadata.sessionId, title: metadata.title, workspace: metadata.workspace, path, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt, status: metadata.currentLeaf.type === "assistant" ? "complete" : "incomplete", branches: metadata.leaves.length });
      } catch {
        // Ignore malformed/unrelated history during discovery.
      }
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async load(summary: SourceSummary, options: DiscoveryOptions): Promise<CanonicalConversation> {
    try {
      const fileStat = await stat(summary.path);
      const snapshot = await readStableJsonl(summary.path);
      const metadata = analyze(snapshot.rows, fileStat.mtime.toISOString());
      const threads = metadata.leaves.map((leaf, index) => buildThread(metadata, leaf, index));
      if (!options.includeIncomplete) {
        for (const thread of threads) thread.turns = thread.turns.filter((turn) => turn.complete);
      }
      const importable = threads.filter((thread) => thread.turns.length > 0);
      if (!importable.length) throw sourceError(`No completed turns in Claude conversation ${summary.id}`);
      return { summary: { ...summary, branches: importable.length }, threads: importable, fingerprint: snapshot.fingerprint };
    } catch (error) {
      if (error instanceof Error && error.name === "ImporterError") throw error;
      throw sourceError(`Unable to load Claude conversation ${summary.id}`, error);
    }
  }
}
