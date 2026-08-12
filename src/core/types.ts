export type SourceName = "codex" | "claude";
export type ActivityTone = "info" | "tool" | "approval" | "error";
export type CanonicalTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type CanonicalTerminalTurnStatus = Exclude<CanonicalTurnStatus, "inProgress">;

export interface SourceSummary {
  source: SourceName;
  id: string;
  title: string;
  workspace: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  status: "complete" | "incomplete";
  branches: number;
  parentId?: string;
}

export interface SourceAttachment {
  sourceId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  path?: string;
  data?: Buffer;
  remoteUrl?: string;
}

export interface CanonicalMessage {
  sourceId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  attachments: SourceAttachment[];
}

export interface CanonicalActivity {
  sourceId: string;
  tone: ActivityTone;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface CanonicalPlan {
  sourceId: string;
  markdown: string;
  timestamp: string;
}

export interface CanonicalTurn {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: CanonicalTurnStatus;
  terminalReason?: string;
  terminalError?: string;
  user: CanonicalMessage;
  assistant: CanonicalMessage[];
  activities: CanonicalActivity[];
  plans: CanonicalPlan[];
}

export interface CanonicalThread {
  source: SourceName;
  sourceSessionId: string;
  sourceKey: string;
  leafId?: string;
  currentBranch: boolean;
  title: string;
  workspace: string;
  gitBranch?: string;
  model: string;
  effort?: string;
  createdAt: string;
  updatedAt: string;
  turns: CanonicalTurn[];
  ignoredInProgressTurns?: number;
  resumeCursor?: Record<string, unknown>;
  warnings: string[];
}

export interface CanonicalConversation {
  summary: SourceSummary;
  threads: CanonicalThread[];
  fingerprint: string;
}

export interface DiscoveryOptions {
  workspace?: string;
  since?: Date;
  includeIncomplete?: boolean;
}

export interface SourceAdapter {
  readonly name: SourceName;
  discover(options: DiscoveryOptions): Promise<SourceSummary[]>;
  load(summary: SourceSummary, options: DiscoveryOptions): Promise<CanonicalConversation>;
  dispose?(): Promise<void>;
}

export interface TargetPaths {
  t3Home: string;
  stateDir: string;
  dbPath: string;
  attachmentsDir: string;
  runtimeStatePath: string;
  settingsPath: string;
}

export interface ImportSelection {
  conversation: CanonicalConversation;
  resume: boolean;
}

export interface ImportItemResult {
  source: SourceName;
  sourceId: string;
  sourceKey: string;
  status: "imported" | "already-imported" | "dry-run";
  threadId: string;
  projectId: string;
  title: string;
  turns: number;
  messages: number;
  activities: number;
  events: number;
  attachments: number;
  resumable: boolean;
  warnings: string[];
  sequence?: { first: number; last: number };
}

export interface ImportRunResult {
  schemaVersion: 1;
  status: "imported" | "dry-run" | "already-imported" | "mixed";
  target: string;
  migration: number;
  backup: string | null;
  cache?: CacheResetResult;
  results: ImportItemResult[];
  warnings: string[];
}

export type SyncItemStatus =
  | "synced"
  | "up-to-date"
  | "history-diverged"
  | "branch-sync-unsupported"
  | "target-missing"
  | "not-imported"
  | "dry-run";

export type SyncTitleAction = "updated" | "unchanged" | "preserved-local";

export interface SyncItemResult {
  source: SourceName;
  sourceId: string;
  sourceKey: string;
  status: SyncItemStatus;
  threadId?: string;
  projectId?: string;
  title: string;
  turnsAdded: number;
  turnsAdopted: number;
  events: number;
  attachments: number;
  titleAction: SyncTitleAction;
  resumable: boolean;
  warnings: string[];
  sequence?: { first: number; last: number };
}

export interface SyncRunResult {
  schemaVersion: 1;
  status: "synced" | "up-to-date" | "dry-run" | "mixed" | "conflict";
  target: string;
  migration: number;
  backup: string | null;
  cache?: CacheResetResult;
  results: SyncItemResult[];
  warnings: string[];
  hasConflicts: boolean;
}

export interface CacheResetResult {
  status: "reset" | "not-found";
  backup: string | null;
  profile: string | null;
  entries: string[];
  warnings: string[];
}

export interface ReplaceSelection {
  conversation: CanonicalConversation;
}

export type ReplaceItemStatus =
  | "replaced"
  | "already-current"
  | "not-imported"
  | "active-source"
  | "branch-replace-unsupported"
  | "target-missing"
  | "dry-run";

export interface ReplaceItemResult {
  source: SourceName;
  sourceId: string;
  sourceKey: string;
  status: ReplaceItemStatus;
  oldThreadId?: string;
  newThreadId?: string;
  projectId?: string;
  title: string;
  turns: number;
  events: number;
  attachments: number;
  resumeTransferred: boolean;
  warnings: string[];
  sequence?: { first: number; last: number };
}

export interface ReplaceRunResult {
  schemaVersion: 1;
  status: "replaced" | "already-current" | "dry-run" | "mixed" | "conflict";
  target: string;
  migration: number;
  backup: string | null;
  cache?: CacheResetResult;
  results: ReplaceItemResult[];
  warnings: string[];
  hasConflicts: boolean;
}

export interface ConversationReplacePreview {
  sourceId: string;
  status: Exclude<ReplaceItemStatus, "replaced" | "dry-run"> | "replaceable";
  selectable: boolean;
  previouslyImported: boolean;
  turns: number;
  events: number;
  attachments: number;
  oldThreadId?: string;
  newThreadId?: string;
  warnings: string[];
}

export interface SyncSelection {
  conversation: CanonicalConversation;
}

export interface ConversationSyncPreview {
  sourceId: string;
  status: "new" | "active-only" | "syncable" | "up-to-date" | "history-diverged" | "branch-sync-unsupported" | "target-missing";
  newTurns: number;
  newCompletedTurns: number;
  newInterruptedTurns: number;
  newFailedTurns: number;
  ignoredActiveTurns: number;
  adoptedTurns: number;
  titleChanged: boolean;
  selectable: boolean;
  previouslyImported: boolean;
  threadId?: string;
  warnings: string[];
}

export function isTerminalTurn(turn: CanonicalTurn): boolean {
  return turn.status !== "inProgress";
}
