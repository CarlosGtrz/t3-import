import type { CanonicalTerminalTurnStatus, CanonicalThread, CanonicalTurn } from "./types.js";
import { isTerminalTurn } from "./types.js";
import { sha256 } from "./util.js";

export interface TurnCheckpointV1 {
  id: string;
  hash: string;
}

export interface ImportCheckpointV1 {
  version: 1;
  turns: TurnCheckpointV1[];
}

export interface TurnCheckpointV2 {
  id: string;
  status: CanonicalTerminalTurnStatus;
  terminalReason?: string;
  terminalError?: string;
  hash: string;
}

export interface ImportCheckpointV2 {
  version: 2;
  turns: TurnCheckpointV2[];
}

export type ImportCheckpoint = ImportCheckpointV1 | ImportCheckpointV2;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function turnHashPayload(turn: CanonicalTurn): Record<string, unknown> {
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt ?? null,
    user: {
      sourceId: turn.user.sourceId,
      text: turn.user.text,
      timestamp: turn.user.timestamp,
      attachments: turn.user.attachments.map((attachment) => ({
        sourceId: attachment.sourceId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        remoteUrl: attachment.remoteUrl ?? null,
        contentHash: attachment.data ? sha256(attachment.data) : null,
      })),
    },
    assistant: turn.assistant.map((message) => ({ sourceId: message.sourceId, text: message.text, timestamp: message.timestamp })),
    activities: turn.activities.map((activity) => ({ sourceId: activity.sourceId, kind: activity.kind, tone: activity.tone, summary: activity.summary, timestamp: activity.timestamp, payload: activity.payload })),
    plans: turn.plans.map((plan) => ({ sourceId: plan.sourceId, markdown: plan.markdown, timestamp: plan.timestamp })),
  };
}

export function legacyTurnSemanticHash(turn: CanonicalTurn): string {
  return sha256(canonicalJson({
    ...turnHashPayload(turn),
    complete: true,
  }));
}

export function turnSemanticHash(turn: CanonicalTurn): string {
  return sha256(canonicalJson({
    ...turnHashPayload(turn),
    status: turn.status,
    terminalReason: turn.terminalReason ?? null,
    terminalError: turn.terminalError ?? null,
  }));
}

export function checkpointForThread(thread: CanonicalThread): ImportCheckpointV2 {
  return {
    version: 2,
    turns: thread.turns.filter(isTerminalTurn).map((turn) => ({
      id: turn.id,
      status: turn.status as CanonicalTerminalTurnStatus,
      ...(turn.terminalReason ? { terminalReason: turn.terminalReason } : {}),
      ...(turn.terminalError ? { terminalError: turn.terminalError } : {}),
      hash: turnSemanticHash(turn),
    })),
  };
}

export function parseCheckpoint(value: string | null | undefined): ImportCheckpoint | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ImportCheckpoint;
    if (!Array.isArray(parsed.turns)) return undefined;
    if (!parsed.turns.every((turn) => typeof turn.id === "string" && typeof turn.hash === "string")) return undefined;
    if (parsed.version === 1) return parsed;
    if (parsed.version !== 2) return undefined;
    if (!parsed.turns.every((turn) => ["completed", "interrupted", "failed"].includes(turn.status))) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
