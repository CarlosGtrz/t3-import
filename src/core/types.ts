export type SourceName = "codex" | "claude";
export type ActivityTone = "info" | "tool" | "approval" | "error";

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
  complete: boolean;
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
  duplicate: boolean;
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
  results: ImportItemResult[];
  warnings: string[];
}
