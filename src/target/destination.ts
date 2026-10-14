import type Database from "better-sqlite3";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TargetPaths } from "../core/types.js";
import { canonicalPath, deterministicUuid } from "../core/util.js";
import { safetyError, usageError } from "../core/errors.js";

export interface DestinationOptions { targetProject?: string; noProject?: boolean }
export interface ImportDestination {
  projectId: string;
  projectRoot: string;
  workingDirectory: string;
  worktreePath: string | null;
  createProject: boolean;
}

export function validateDestinationOptions(options: DestinationOptions): void {
  if (options.targetProject !== undefined && !options.targetProject.trim()) throw usageError("--target-project requires a non-empty T3 project ID.");
  if (options.targetProject && options.noProject) throw usageError("--target-project and --no-project are mutually exclusive.");
}

function project(db: Database.Database, id: string): { root: string; deleted: string | null } | undefined {
  let value = db.prepare("SELECT workspace_root root, deleted_at deleted FROM projection_projects WHERE project_id = ?").get(id) as { root: string; deleted: string | null } | undefined;
  const events = db.prepare("SELECT event_type type, payload_json payload FROM orchestration_events WHERE stream_id=? AND aggregate_kind='project' ORDER BY sequence").all(id) as Array<{ type: string; payload: string }>;
  for (const event of events) {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    if (event.type === "project.created" && typeof payload.workspaceRoot === "string") value = { root: payload.workspaceRoot, deleted: null };
    else if (value && typeof payload.workspaceRoot === "string") value.root = payload.workspaceRoot;
    if (value && event.type === "project.deleted") value.deleted = "deleted";
  }
  return value;
}

/** Explicit destinations preserve source cwd; assigning a sidebar project is not cosmetic. */
export function importDestination(db: Database.Database, paths: TargetPaths, sourceWorkspace: string, options: DestinationOptions): ImportDestination | undefined {
  validateDestinationOptions(options);
  if (!options.targetProject && !options.noProject) return undefined;
  if (!existsSync(sourceWorkspace) || !statSync(sourceWorkspace).isDirectory()) throw safetyError(`Source working directory is unavailable: ${sourceWorkspace}. Destination selection never moves or recreates source files.`);
  const source = realpathSync(sourceWorkspace);
  if (options.targetProject) {
    const target = project(db, options.targetProject);
    if (!target || target.deleted) throw usageError(`Target T3 project does not exist or is deleted: ${options.targetProject}. Use the project ID from the target database.`);
    if (canonicalPath(target.root) !== canonicalPath(source)) throw safetyError(`Target project root ${target.root} differs from source cwd ${sourceWorkspace}. T3 would change the working directory. Choose a project rooted at the source cwd; no files were moved.`);
    return { projectId: options.targetProject, projectRoot: target.root, workingDirectory: sourceWorkspace, worktreePath: null, createProject: false };
  }
  const scratch = join(paths.t3Home, "scratch");
  // Native scratch threads use direct child directories. External directories
  // are not assigned as scratch worktrees merely to hide their project label.
  if (canonicalPath(dirname(source)) !== canonicalPath(scratch)) throw safetyError(`--no-project can preserve cwd only for an existing direct child of ${scratch}. Source cwd ${sourceWorkspace} is outside T3's managed scratch layout. Import into its matching project instead; no files were moved.`);
  for (let parent = source; ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) throw safetyError("T3 scratch import is unavailable inside a Git checkout.");
    if (parent === dirname(parent)) break;
  }
  const ids = db.prepare(`SELECT project_id id FROM projection_projects
    UNION SELECT stream_id id FROM orchestration_events WHERE aggregate_kind='project' AND event_type='project.created'`).all() as Array<{ id: string }>;
  const candidates = ids.filter((row) => {
    const value = project(db, row.id);
    return value && !value.deleted && canonicalPath(value.root) === canonicalPath(scratch);
  });
  if (candidates.length > 1) throw safetyError("Multiple T3 projects claim the scratch root; destination is ambiguous.");
  return { projectId: candidates[0]?.id ?? deterministicUuid(`t3-import:project:${canonicalPath(scratch)}`), projectRoot: scratch, workingDirectory: sourceWorkspace, worktreePath: sourceWorkspace, createProject: candidates.length === 0 };
}

/** Preserve the effective workspace through sync/replacement, using durable thread events. */
export function threadWorkingDirectory(db: Database.Database, threadId: string, fallback: string): { cwd: string; worktreePath: string | null } {
  const rows = db.prepare("SELECT payload_json payload FROM orchestration_events WHERE stream_id=? AND event_type IN ('thread.created', 'thread.meta-updated') ORDER BY sequence").all(threadId) as Array<{ payload: string }>;
  let worktreePath: string | null = null;
  let projectId: string | undefined;
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (typeof payload.projectId === "string") projectId = payload.projectId;
    if (payload.worktreePath === null || typeof payload.worktreePath === "string") worktreePath = payload.worktreePath;
  }
  const root = projectId ? project(db, projectId)?.root : undefined;
  return { cwd: worktreePath ?? root ?? fallback, worktreePath };
}
