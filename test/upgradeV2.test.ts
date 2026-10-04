import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTarget } from "./helpers.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { upgradeLegacyToV2 } from "../src/target/upgradeV2.js";
import { validateTargetDatabase } from "../src/target/schema.js";

const roots: string[] = [];
const at = "2026-01-01T00:00:00.000Z";
const selection = { instanceId: "codex", model: "gpt-test" };
function seed(db: Database.Database, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t3-v2-bridge-")); roots.push(root);
  const legacy = createTarget(join(root, "v1"), 53);
  const db = new Database(legacy.dbPath);
  const project = { project_id: "p", title: "Synthetic", workspace_root: "/synthetic/project", scripts_json: "[]", created_at: at, updated_at: at, deleted_at: null };
  seed(db, "projection_projects", project);
  seed(db, "projection_threads", { thread_id: "t", project_id: "p", title: "Synthetic history", created_at: at, updated_at: at, model_selection_json: JSON.stringify(selection), runtime_mode: "full-access", interaction_mode: "default" });
  seed(db, "projection_thread_messages", { thread_id: "t", message_id: "u", turn_id: null, role: "user", text: "Synthetic question", is_streaming: 0, created_at: at, updated_at: at, attachments_json: "[]" });
  seed(db, "projection_thread_messages", { thread_id: "t", message_id: "a", turn_id: "turn", role: "assistant", text: "Synthetic answer", is_streaming: 0, created_at: "2026-01-01T00:00:03.000Z", updated_at: "2026-01-01T00:00:03.000Z", attachments_json: "[]" });
  seed(db, "projection_turns", { thread_id: "t", turn_id: "turn", pending_message_id: "u", state: "completed", requested_at: at, started_at: at, completed_at: "2026-01-01T00:00:03.000Z", checkpoint_files_json: "[]" });
  for (let i = 0; i < 4; i++) seed(db, "projection_thread_activities", { activity_id: `tool-${i}`, thread_id: "t", turn_id: "turn", tone: i % 2 ? "error" : "tool", kind: "tool.completed", summary: `Tool ${i}`, payload_json: JSON.stringify({ status: i % 2 ? "failed" : "completed", unknownProviderField: { nested: [i, "unaltered"] } }), created_at: `2026-01-01T00:00:01.00${i}Z`, sequence: i });
  seed(db, "projection_thread_proposed_plans", { plan_id: "plan", thread_id: "t", turn_id: "turn", plan_markdown: "Synthetic plan", created_at: "2026-01-01T00:00:02.000Z", updated_at: "2026-01-01T00:00:02.000Z" });
  seed(db, "provider_session_runtime", { thread_id: "t", provider_name: "codex", provider_instance_id: "codex", adapter_key: "codex", runtime_mode: "full-access", status: "stopped", last_seen_at: at, resume_cursor_json: JSON.stringify({ threadId: "11111111-1111-4111-8111-111111111111" }), runtime_payload_json: "{}" });
  db.close();
  const paths = resolveTargetPaths({ t3Home: join(root, "v2"), dbPath: join(root, "v2", "userdata", "statev2.sqlite") });
  mkdirSync(paths.stateDir, { recursive: true });
  const target = new Database(paths.dbPath);
  const schema = JSON.parse(readFileSync(new URL("./fixtures/t3-v2-schema-56.json", import.meta.url), "utf8")) as { ddl: string[]; migrations: Record<string, unknown>[] };
  target.exec(schema.ddl.join(";\n"));
  for (const migration of schema.migrations) seed(target, "effect_sql_migrations", migration);
  seed(target, "projection_projects", project);
  target.close();
  return { root, legacy, paths };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("native V2 legacy bridge", () => {
  it("previews complete content without changing either database", async () => {
    const { legacy, paths } = fixture();
    const before = readFileSync(paths.dbPath), source = readFileSync(legacy.dbPath);
    const result = await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: true });
    expect(result).toMatchObject({ status: "dry-run", threads: 1, messages: 2, activities: 4, failedActivities: 2, plans: 1, resumeBindings: 1 });
    expect(readFileSync(paths.dbPath)).toEqual(before); expect(readFileSync(legacy.dbPath)).toEqual(source);
  });
  it("backs up, retains exact unknown and failed activity payloads, restores resume identity, and is idempotent", async () => {
    const { legacy, paths } = fixture();
    const first = await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false });
    expect(first.status).toBe("upgraded"); expect(existsSync(first.backup!)).toBe(true);
    const db = new Database(paths.dbPath, { readonly: true });
    const events = db.prepare("SELECT event_type,payload_json,application_event_version FROM orchestration_events ORDER BY sequence").all() as Array<{ event_type: string; payload_json: string; application_event_version: number }>;
    expect(events.every(row => row.application_event_version === 2)).toBe(true);
    const items = events.filter(row => row.event_type === "turn-item.updated").map(row => JSON.parse(row.payload_json));
    const activities = items.filter(item => item.type === "dynamic_tool");
    expect(activities.map(item => item.input.legacyActivity.payload.unknownProviderField.nested)).toEqual([[0, "unaltered"], [1, "unaltered"], [2, "unaltered"], [3, "unaltered"]]);
    expect(activities.filter(item => item.status === "failed")).toHaveLength(2);
    expect(items.map(item => item.type)).toEqual(["user_message", "dynamic_tool", "dynamic_tool", "dynamic_tool", "dynamic_tool", "proposed_plan", "assistant_message"]);
    expect(items.every(item => item.runId === "migration:v1:run:t:turn")).toBe(true);
    expect(events.find(row => row.event_type === "provider-thread.updated")?.payload_json).toContain('"nativeId":"11111111-1111-4111-8111-111111111111"');
    const count = events.length; db.close();
    expect(await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false })).toMatchObject({ status: "already-upgraded", unchangedThreads: 1, events: 0, assets: 0 });
    const unchanged = new Database(paths.dbPath, { readonly: true }); expect((unchanged.prepare("SELECT COUNT(*) n FROM orchestration_events").get() as { n: number }).n).toBe(count); unchanged.close();
  });
  it("refuses a changed snapshot after native continuation and rolls back all events", async () => {
    const { legacy, paths } = fixture();
    await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false });
    const db = new Database(paths.dbPath);
    seed(db, "orchestration_v2_projection_runs", { run_id: "native-run", thread_id: "t", ordinal: 2, provider: "codex", provider_instance_id: "codex", status: "completed", requested_at: at, payload_json: "{}" });
    const before = (db.prepare("SELECT COUNT(*) n FROM orchestration_events").get() as { n: number }).n; db.close();
    const source = new Database(legacy.dbPath); source.prepare("UPDATE projection_thread_messages SET text='Later source change' WHERE message_id='a'").run(); source.close();
    await expect(upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false })).rejects.toThrow("must not overwrite continued work");
    const after = new Database(paths.dbPath, { readonly: true }); expect((after.prepare("SELECT COUNT(*) n FROM orchestration_events").get() as { n: number }).n).toBe(before); after.close();
  });
  it("refuses live targets and unknown migrations", async () => {
    const { legacy, paths } = fixture();
    writeFileSync(paths.runtimeStatePath, JSON.stringify({ pid: process.pid }));
    await expect(upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: true })).rejects.toThrow("T3 is running");
    rmSync(paths.runtimeStatePath);
    const target = new Database(paths.dbPath); target.prepare("UPDATE effect_sql_migrations SET migration_id=57 WHERE migration_id=56").run(); target.close();
    await expect(upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: true })).rejects.toThrow("Unsupported V2 migration 57");
  });
  it("copies verified images, rejects missing originals and conflicts, and rolls back partial writes", async () => {
    const { legacy, paths } = fixture();
    const image = Buffer.from("synthetic image bytes");
    const source = new Database(legacy.dbPath);
    source.prepare("UPDATE projection_thread_messages SET attachments_json=? WHERE message_id='u'").run(JSON.stringify([{ id: "image", name: "image.png", mimeType: "image/png", sizeBytes: image.length }])); source.close();
    await expect(upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false })).rejects.toThrow("Missing original attachment");
    mkdirSync(legacy.attachmentsDir, { recursive: true }); writeFileSync(join(legacy.attachmentsDir, "image.png"), image);
    mkdirSync(paths.attachmentsDir, { recursive: true }); writeFileSync(join(paths.attachmentsDir, "image.png"), "conflicting bytes");
    await expect(upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false })).rejects.toThrow("Attachment conflict");
    expect(readFileSync(join(paths.attachmentsDir, "image.png"), "utf8")).toBe("conflicting bytes");
    const db = new Database(paths.dbPath, { readonly: true }); expect((db.prepare("SELECT COUNT(*) n FROM orchestration_events").get() as { n: number }).n).toBe(0); db.close();
    rmSync(join(paths.attachmentsDir, "image.png"));
    expect(await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false })).toMatchObject({ assets: 1 });
    expect(readFileSync(join(paths.attachmentsDir, "image.png"))).toEqual(image);
  });
  it("updates historical source content without duplicating items and preserves native visit metadata", async () => {
    const { legacy, paths } = fixture();
    await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false });
    const target = new Database(paths.dbPath);
    const row = target.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'").get() as { payload_json: string };
    target.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id='t'").run(JSON.stringify({ ...JSON.parse(row.payload_json), lastVisitedAt: "2026-02-01T00:00:00.000Z" })); target.close();
    const source = new Database(legacy.dbPath); source.prepare("UPDATE projection_thread_messages SET text='Repaired historical answer' WHERE message_id='a'").run(); source.close();
    expect(await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false })).toMatchObject({ status: "upgraded", threads: 1 });
    const db = new Database(paths.dbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) n FROM orchestration_v2_projection_turn_items").get() as { n: number }).n).toBe(7);
    expect(JSON.parse((db.prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id='a'").get() as { payload_json: string }).payload_json).text).toBe("Repaired historical answer");
    expect(JSON.parse((db.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'").get() as { payload_json: string }).payload_json).lastVisitedAt).toBe("2026-02-01T00:00:00.000Z"); db.close();
  });
  it("blocks ordinary V1 imports into a retired database in a V2 home", () => {
    const { legacy } = fixture(); writeFileSync(join(legacy.stateDir, "statev2.sqlite"), "marker");
    const db = new Database(legacy.dbPath, { readonly: true });
    expect(() => validateTargetDatabase(db)).toThrow("retired state.sqlite"); db.close();
  });
  it("reorders runs and item positions safely when an earlier historical user message appears", async () => {
    const { legacy, paths } = fixture();
    await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false });
    const source = new Database(legacy.dbPath);
    seed(source, "projection_thread_messages", { thread_id: "t", message_id: "earlier", turn_id: null, role: "user", text: "Earlier recovered prompt", is_streaming: 0, created_at: "2025-12-31T00:00:00.000Z", updated_at: "2025-12-31T00:00:00.000Z", attachments_json: "[]" }); source.close();
    await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false });
    const target = new Database(paths.dbPath, { readonly: true });
    const runs = target.prepare("SELECT run_id,ordinal FROM orchestration_v2_projection_runs ORDER BY ordinal").all();
    expect(runs).toEqual([{ run_id: "migration:v1:run:t:earlier", ordinal: 1 }, { run_id: "migration:v1:run:t:turn", ordinal: 2 }]);
    expect((target.prepare("SELECT COUNT(*) n FROM orchestration_v2_turn_item_positions").get() as { n: number }).n).toBe(8);
    expect((target.prepare("SELECT COUNT(*) n FROM orchestration_v2_projection_turn_items").get() as { n: number }).n).toBe(8);
    // Event replay must preserve uniqueness at every intermediate position,
    // rather than relying on changes made only to the persisted read model.
    for (const type of ["run.updated", "turn-item.updated"]) {
      const positions = new Map<string, number>();
      for (const event of target.prepare("SELECT payload_json FROM orchestration_events WHERE event_type=? ORDER BY sequence").all(type) as { payload_json: string }[]) {
        const payload = JSON.parse(event.payload_json) as { id: string; ordinal: number };
        for (const [id, ordinal] of positions) if (id !== payload.id) expect(ordinal).not.toBe(payload.ordinal);
        positions.set(payload.id, payload.ordinal);
      }
      const table = type === "run.updated" ? "orchestration_v2_projection_runs" : "orchestration_v2_projection_turn_items";
      const key = type === "run.updated" ? "run_id" : "turn_item_id";
      const expected = target.prepare(`SELECT ${key} id,ordinal FROM ${table}`).all() as { id: string; ordinal: number }[];
      expect(positions).toEqual(new Map(expected.map(row => [row.id, row.ordinal])));
    }
    target.close();
    expect(await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false })).toMatchObject({ events: 0, unchangedThreads: 1 });
  });
  it("preserves timeline order when recovered turns interleave older synthetic user timestamps", async () => {
    const { legacy, paths } = fixture();
    const source = new Database(legacy.dbPath);
    const recoveredAt = "2026-01-01T00:00:00.500Z";
    seed(source, "projection_thread_messages", { thread_id: "t", message_id: "recovered", turn_id: null, role: "user", text: "Recovered prompt", is_streaming: 0, created_at: recoveredAt, updated_at: recoveredAt, attachments_json: "[]" });
    seed(source, "projection_turns", { thread_id: "t", turn_id: "recovered-turn", pending_message_id: "recovered", state: "completed", requested_at: recoveredAt, started_at: recoveredAt, completed_at: "2026-01-01T00:00:00.900Z", checkpoint_files_json: "[]" });
    seed(source, "projection_thread_activities", { activity_id: "recovered-tool", thread_id: "t", turn_id: "recovered-turn", tone: "tool", kind: "tool.completed", summary: "Recovered tool", payload_json: "{}", created_at: "2026-01-01T00:00:00.750Z", sequence: 0 }); source.close();
    await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false });
    const target = new Database(paths.dbPath, { readonly: true });
    const activities = target.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE type='dynamic_tool' ORDER BY ordinal").all() as { payload_json: string }[];
    expect(activities.map(row => JSON.parse(row.payload_json).input.legacyActivity.id)).toEqual(["recovered-tool", "tool-0", "tool-1", "tool-2", "tool-3"]);
    target.close();
  });
  it("records existing native coverage without replaying historical failed or interrupted prompts", async () => {
    for (const state of ["error", "interrupted"]) {
      const { legacy, paths } = fixture();
      const source = new Database(legacy.dbPath); source.prepare("UPDATE projection_turns SET state=?").run(state); source.close();
      await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false });
      const target = new Database(paths.dbPath, { readonly: true });
      const run = target.prepare("SELECT status FROM orchestration_v2_projection_runs").get() as { status: string };
      expect(run.status).toBe(state === "error" ? "failed" : "interrupted");
      const handoff = JSON.parse((target.prepare("SELECT payload_json FROM orchestration_v2_projection_context_handoffs").get() as { payload_json: string }).payload_json);
      expect(handoff.delivery.nativeThreadId).toBe("11111111-1111-4111-8111-111111111111");
      expect(handoff.delivery.status).toBe("inline");
      const covered = new Set(handoff.delivery.itemIds);
      const historical = target.prepare("SELECT turn_item_id FROM orchestration_v2_projection_turn_items").all() as { turn_item_id: string }[];
      expect(historical.every(row => covered.has(row.turn_item_id))).toBe(true);
      expect((target.prepare("SELECT COUNT(*) n FROM orchestration_v2_projection_run_attempts").get() as { n: number }).n).toBe(0);
      target.close();
    }
  });
});
