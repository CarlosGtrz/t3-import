import Database from "better-sqlite3";
import type { SourceAdapter, SyncItemResult, SyncRunResult, TargetPaths } from "../core/types.js";
import { isObject, stringValue } from "../core/util.js";
import { usageError } from "../core/errors.js";
import { listImports } from "./ledger.js";
import { createEvent, currentTitle, readEvents, syncConversations, targetId, validRecord, type SyncOptions } from "./sync.js";
import { validateTargetDatabase } from "./schema.js";

interface LinkedThread {
  sourceId: string;
  threadId: string;
  title: string;
}

/** Discover by persisted provider identity, across projects and scratch cwd's. */
function linkedCodexThreads(paths: TargetPaths): LinkedThread[] {
  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    validateTargetDatabase(db);
    const linked = new Map<string, LinkedThread>();
    const add = (sourceId: string, threadId: string) => {
      const events = readEvents(db, threadId);
      const created = createEvent(events);
      if (!created || events.some((event) => event.type === "thread.deleted")) return;
      linked.set(sourceId, { sourceId, threadId, title: currentTitle(db, threadId, events) });
    };
    const rows = db.prepare(`SELECT thread_id threadId, resume_cursor_json cursor
      FROM provider_session_runtime WHERE provider_name='codex' AND adapter_key='codex'`).all() as Array<{ threadId: string; cursor: string | null }>;
    for (const row of rows) {
      try {
        const cursor: unknown = row.cursor ? JSON.parse(row.cursor) : undefined;
        const sourceId = isObject(cursor) ? stringValue(cursor.threadId) : undefined;
        if (sourceId) add(sourceId, row.threadId);
      } catch { /* malformed bindings are not guessed from titles or paths */ }
    }
    for (const record of listImports(targetId(paths), "codex")) {
      if (record.isCanonical !== false && validRecord(db, record) && !linked.has(record.sourceSessionId)) {
        add(record.sourceSessionId, record.threadId);
      }
    }
    return [...linked.values()];
  } finally { db.close(); }
}

/** Synchronize only already-linked conversations. Unrelated rollouts stay out. */
export async function syncAllLinkedConversations(
  adapter: SourceAdapter, paths: TargetPaths, options: SyncOptions,
): Promise<SyncRunResult> {
  if (adapter.name !== "codex") throw usageError("Synchronization across all workspaces currently supports --source codex only.");
  const links = linkedCodexThreads(paths);
  const summaries = new Map((await adapter.discover({})).map((summary) => [summary.id, summary]));
  const unavailable: SyncItemResult[] = [];
  const loaded = await Promise.all(links.map(async (link) => {
    const summary = summaries.get(link.sourceId);
    try {
      if (!summary) throw new Error("The linked Codex rollout is unavailable locally or is excluded from source discovery.");
      return { conversation: await adapter.load(summary, {}) };
    } catch (error) {
      unavailable.push({
        source: "codex", sourceId: link.sourceId, sourceKey: `codex:${link.sourceId}`,
        status: "not-imported", threadId: link.threadId, title: link.title,
        turnsAdded: 0, turnsAdopted: 0, events: 0, attachments: 0,
        titleAction: "unchanged", resumable: false,
        warnings: [error instanceof Error ? error.message : String(error)],
      });
      return undefined;
    }
  }));
  const result = await syncConversations(loaded.filter((item) => item !== undefined), paths, options);
  for (const item of result.results) {
    const link = links.find((candidate) => candidate.threadId === item.threadId);
    if (link) item.title = link.title;
  }
  result.results.push(...unavailable.sort((a, b) => a.sourceId.localeCompare(b.sourceId)));
  if (unavailable.length) {
    result.hasConflicts = true;
    if (result.status === "synced") result.status = "mixed";
    else if (result.status === "up-to-date") result.status = "conflict";
  }
  return result;
}
