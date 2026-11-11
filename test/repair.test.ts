import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repairImportedThreads } from "../src/target/repair.js";
import { createTarget } from "./helpers.js";
import { upgradeFixtureToV2 } from "./support/v2-fixture.js";

const threadId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";

function seedBrokenImport(paths: { dbPath: string }): void {
  upgradeFixtureToV2(paths.dbPath);
  const db = new Database(paths.dbPath);
  try {
    const thread = {
      createdBy: "user",
      creationSource: "import",
      id: threadId,
      projectId,
      title: "Imported chat",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/tmp/workspace",
      pullRequests: [],
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      archivedAt: null,
      deletedAt: null,
    };
    db.prepare(`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json, provider_instance_id)
      VALUES (?, ?, ?, 'codex', 'full-access', 'default', NULL, ?, ?, NULL, NULL, ?, 'codex')
    `).run(threadId, projectId, thread.title, thread.createdAt, thread.updatedAt, JSON.stringify(thread));
    const insertMessage = db.prepare(`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (?, ?, NULL, NULL, ?, 0, ?, ?, ?)
    `);
    insertMessage.run("m-1", threadId, "user", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", JSON.stringify({ id: "m-1", text: "Hello", role: "user", attachments: [] }));
    insertMessage.run("m-2", threadId, "assistant", "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:02.000Z", JSON.stringify({ id: "m-2", text: "Hi", role: "assistant", attachments: [] }));
  } finally { db.close(); }
}

describe("repair imported threads", () => {
  it("restores the v1 tables T3 migrates from and drops synthetic v2 rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-repair-"));
    mkdirSync(join(root, "workspace"));
    const paths = createTarget(join(root, "t3"), 53);
    seedBrokenImport(paths);

    const result = await repairImportedThreads(paths);
    expect(result.status).toBe("repaired");
    expect(result.threads).toBe(1);
    expect(result.fixedSources).toBe(1);
    expect(result.backup && existsSync(result.backup)).toBe(true);

    const db = new Database(paths.dbPath, { readonly: true });
    try {
      const thread = db.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(threadId) as { payload_json: string };
      expect(JSON.parse(thread.payload_json).creationSource).toBe("server");
      const legacy = db.prepare("SELECT title, model_selection_json FROM projection_threads WHERE thread_id = ?").get(threadId) as { title: string; model_selection_json: string };
      expect(legacy.title).toBe("Imported chat");
      expect(JSON.parse(legacy.model_selection_json).instanceId).toBe("codex");
      const messages = db.prepare("SELECT role, text FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at").all(threadId) as Array<{ role: string; text: string }>;
      expect(messages).toEqual([{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi" }]);
      const remaining = db.prepare("SELECT COUNT(*) count FROM orchestration_v2_projection_messages WHERE thread_id = ?").get(threadId) as { count: number };
      expect(remaining.count).toBe(0);
    } finally { db.close(); }
  });

  it("is a no-op when there is nothing to repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-repair-noop-"));
    const paths = createTarget(join(root, "t3"), 53);
    upgradeFixtureToV2(paths.dbPath);
    const result = await repairImportedThreads(paths);
    expect(result.status).toBe("noop");
    expect(result.threads).toBe(0);
  });
});
