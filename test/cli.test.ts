import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createTarget, eventCount } from "./helpers.js";

const root = process.cwd();

function cli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

describe("replace CLI", () => {
  it("exposes only the supported replacement options", () => {
    const result = cli("replace", "--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--thread <id>");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).not.toContain("--all");
    expect(result.stdout).not.toContain("--duplicate");
    expect(result.stdout).not.toContain("--include-incomplete");
  });

  it("rejects the removed duplicate import option", () => {
    const result = cli("import", "--duplicate");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--duplicate'");
  });

  it("requires explicit confirmation for non-interactive replacement", () => {
    const result = cli("replace", "--source", "codex", "--workspace", root, "--thread", "fixture", "--non-interactive");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Non-interactive replacement requires --yes");
  });
});

const sessionId = "77777777-7777-4777-8777-777777777777";

interface Sandbox {
  workspace: string;
  dbPath: string;
  transcript: string;
  watched: Record<string, string>;
  run(args: string[], options?: { tty?: boolean; input?: string }): { status: number | null; stdout: string; stderr: string };
}

function claudeTurn(index: number, workspace: string, parentUuid: string | null, id = sessionId): unknown[] {
  const base = { sessionId: id, cwd: workspace, isSidechain: false };
  const minute = String(index).padStart(2, "0");
  return [
    { ...base, uuid: `u${index}`, parentUuid, type: "user", timestamp: `2026-01-01T00:${minute}:00Z`, message: { content: `prompt ${index}` } },
    { ...base, uuid: `a${index}`, parentUuid: `u${index}`, type: "assistant", timestamp: `2026-01-01T00:${minute}:30Z`, message: { model: "claude-test", content: [{ type: "text", text: `answer ${index}` }], stop_reason: "end_turn" } },
  ];
}

function appendRows(path: string, rows: unknown[]): void {
  appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

/** Every source, target, ledger, and cache location lives under one temporary directory; nothing resolves to the real home. */
async function createSandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "t3-import-cli-safety-"));
  const workspace = join(dir, "workspace");
  const project = join(dir, "claude", "projects", "fixture");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(project, { recursive: true });
  const transcript = join(project, `${sessionId}.jsonl`);
  appendRows(transcript, claudeTurn(1, workspace, null));
  const t3Home = join(dir, "t3");
  const paths = createTarget(t3Home, 53);
  mkdirSync(paths.attachmentsDir, { recursive: true });
  writeFileSync(join(paths.attachmentsDir, "existing.bin"), "attachment");
  mkdirSync(join(paths.stateDir, "t3-import-backups"), { recursive: true });
  writeFileSync(join(paths.stateDir, "t3-import-backups", "existing.sqlite"), "backup");
  const profile = join(dir, "electron-profile");
  mkdirSync(join(profile, "IndexedDB", "t3code_app_0.indexeddb.leveldb"), { recursive: true });
  writeFileSync(join(profile, "IndexedDB", "t3code_app_0.indexeddb.leveldb", "000001.log"), "cache");
  const ledger = join(dir, "ledger");
  const tty = join(dir, "tty.mjs");
  // A terminal for Ink: TTY output and a raw-mode-capable stdin fed from the pipe.
  writeFileSync(tty, "process.stdout.isTTY = true;\nprocess.stdin.isTTY = true;\nprocess.stdin.setRawMode = () => process.stdin;\n");
  const home = { APPDATA: join(dir, "appdata"), LOCALAPPDATA: join(dir, "localappdata"), XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data") };
  const env = {
    ...process.env, NO_COLOR: "1", HOME: dir, USERPROFILE: dir, ...home,
    CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex"), T3CODE_HOME: t3Home, T3_IMPORT_DATA_DIR: ledger, T3_CODE_USER_DATA: profile,
  };
  return {
    workspace,
    dbPath: paths.dbPath,
    transcript,
    // The redirected per-user directories catch writes that would land in a default ledger or profile location.
    watched: { t3Home, ledger, cacheProfile: profile, ...home },
    run: (args, options = {}) => spawnSync(process.execPath, [
      ...(options.tty ? ["--import", pathToFileURL(tty).href] : []),
      "--import", "tsx", join(root, "src", "cli.ts"), "--t3-home", t3Home, ...args,
    ], { cwd: root, encoding: "utf8", env, input: options.input ?? "", timeout: 30_000 }),
  };
}

/** Stands in for T3 projecting the imported events on its next launch. */
function caughtUp(dbPath: string): void {
  const db = new Database(dbPath);
  const last = (db.prepare("SELECT COALESCE(MAX(sequence), 0) value FROM orchestration_events").get() as { value: number }).value;
  db.prepare("INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES ('test', ?, '2026-01-01T00:00:00.000Z') ON CONFLICT(projector) DO UPDATE SET last_applied_sequence=excluded.last_applied_sequence").run(last);
  db.close();
}

function entries(path: string, key: string): Array<[string, string]> {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [[key, createHash("sha256").update(readFileSync(path)).digest("hex")]];
  return [[`${key}/`, "directory"], ...readdirSync(path).flatMap((name) => entries(join(path, name), `${key}/${name}`))];
}

/** Directories and file hashes of every watched root, keyed by root name, so created directories and files show up too. */
function snapshot(sandbox: Sandbox): Record<string, string> {
  return Object.fromEntries(Object.entries(sandbox.watched).flatMap(([name, path]) => entries(path, name)));
}

const commands = ["import", "sync", "replace"] as const;

describe("CLI selection safety", () => {
  it.each(commands)("%s rejects --dry-run instead of opening the interactive TUI", async (command) => {
    const sandbox = await createSandbox();
    const before = snapshot(sandbox);
    const result = sandbox.run([command, "--source", "claude", "--dry-run"], { tty: true });
    expect(result.stderr).toContain("--dry-run requires a complete selection");
    expect(result.stderr).toContain("not available in the interactive TUI");
    expect(result.status).toBe(2);
    expect(snapshot(sandbox)).toEqual(before);
  }, 60_000);

  it("explains an incomplete selection without referring to the TUI when none of its options were given", async () => {
    const sandbox = await createSandbox();
    const result = sandbox.run(["import", "--source", "claude", "--non-interactive"]);
    expect(result.stderr).toContain("Non-interactive import requires --source and either --thread or --workspace with --all.");
    expect(result.stderr).not.toContain("TUI");
    expect(result.status).toBe(2);
  }, 60_000);

  it.each(commands)("%s rejects an explicit --thread without --source instead of opening the interactive TUI", async (command) => {
    const sandbox = await createSandbox();
    const result = sandbox.run([command, "--thread", sessionId], { tty: true });
    expect(result.stderr).toContain("--source");
    expect(result.stderr).toContain("--thread");
    expect(result.status).toBe(2);
  }, 60_000);

  it.each(["import", "sync"] as const)("%s requires --workspace with --all instead of opening the interactive TUI", async (command) => {
    const sandbox = await createSandbox();
    const before = snapshot(sandbox);
    const result = sandbox.run([command, "--source", "claude", "--all", "--yes"], { tty: true });
    expect(result.stderr).toContain("--all");
    expect(result.stderr).toContain("--workspace");
    expect(result.status).toBe(2);
    expect(snapshot(sandbox)).toEqual(before);
  }, 60_000);

  it.each([false, true])("previews an explicit thread without --workspace (tty: %s)", async (tty) => {
    const sandbox = await createSandbox();
    const before = snapshot(sandbox);
    const result = sandbox.run(["import", "--source", "claude", "--thread", sessionId, "--dry-run"], { tty });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "dry-run", results: [expect.objectContaining({ sourceId: sessionId, status: "dry-run" })] });
    expect(snapshot(sandbox)).toEqual(before);
  }, 60_000);

  it("selects every explicit thread across workspaces without --workspace", async () => {
    const sandbox = await createSandbox();
    const otherId = "88888888-8888-4888-8888-888888888888";
    const other = join(sandbox.workspace, "..", "other-workspace");
    const transcript = join(sandbox.transcript, "..", "..", "other", `${otherId}.jsonl`);
    mkdirSync(other, { recursive: true });
    mkdirSync(join(transcript, ".."), { recursive: true });
    appendRows(transcript, claudeTurn(1, other, null, otherId));
    const before = snapshot(sandbox);
    const result = sandbox.run(["import", "--source", "claude", "--thread", sessionId, "--thread", otherId, "--dry-run"]);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as { status: string; results: Array<{ sourceId: string; status: string }> };
    expect(output.status).toBe("dry-run");
    expect(output.results.map((item) => [item.sourceId, item.status]).sort()).toEqual([[sessionId, "dry-run"], [otherId, "dry-run"]].sort());
    expect(snapshot(sandbox)).toEqual(before);
  }, 60_000);

  it("asks for --workspace when an explicit thread id exists in several workspaces", async () => {
    const sandbox = await createSandbox();
    const other = join(sandbox.workspace, "..", "other-workspace");
    const copy = join(sandbox.transcript, "..", "..", "other", `${sessionId}.jsonl`);
    mkdirSync(other, { recursive: true });
    mkdirSync(join(copy, ".."), { recursive: true });
    appendRows(copy, claudeTurn(1, other, null));
    const ambiguous = sandbox.run(["import", "--source", "claude", "--thread", sessionId, "--dry-run"]);
    expect(ambiguous.stderr).toContain("pass --workspace");
    expect(ambiguous.status).toBe(2);
    const chosen = sandbox.run(["import", "--source", "claude", "--workspace", other, "--thread", sessionId, "--dry-run"]);
    expect(chosen.stderr).toBe("");
    expect(JSON.parse(chosen.stdout)).toMatchObject({ status: "dry-run" });
  }, 60_000);

  it("still opens the interactive TUI when only --source and --workspace are given", async () => {
    const sandbox = await createSandbox();
    const before = snapshot(sandbox);
    const result = sandbox.run(["import", "--source", "claude", "--workspace", sandbox.workspace], { tty: true, input: "q" });
    expect(result.stdout).toContain("t3-import");
    expect(result.stdout).toContain("Target:");
    expect(result.status).toBe(0);
    expect(snapshot(sandbox)).toEqual(before);
  }, 60_000);
});

describe("dry-run filesystem safety", () => {
  it.each([true, false])("leaves the database, attachments, backups, ledger, and IndexedDB cache untouched for import, sync, and replace (--workspace: %s)", async (withWorkspace) => {
    const sandbox = await createSandbox();
    const selection = ["--source", "claude", ...(withWorkspace ? ["--workspace", sandbox.workspace] : []), "--thread", sessionId];
    const initial = snapshot(sandbox);
    const preview = sandbox.run(["import", ...selection, "--dry-run"]);
    expect(preview.stderr).toBe("");
    expect(JSON.parse(preview.stdout)).toMatchObject({ status: "dry-run" });
    expect(snapshot(sandbox)).toEqual(initial);

    const imported = sandbox.run(["--no-cache-reset", "import", "--source", "claude", "--workspace", sandbox.workspace, "--thread", sessionId, "--yes"]);
    expect(imported.stderr).toBe("");
    expect(JSON.parse(imported.stdout)).toMatchObject({ status: "imported" });
    caughtUp(sandbox.dbPath);
    appendRows(sandbox.transcript, claudeTurn(2, sandbox.workspace, "a1"));
    const events = eventCount(sandbox.dbPath);
    const afterImport = snapshot(sandbox);
    expect(afterImport).not.toEqual(initial);

    for (const command of ["sync", "replace"]) {
      const result = sandbox.run([command, ...selection, "--dry-run", "--yes"]);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "dry-run" });
      expect(eventCount(sandbox.dbPath)).toBe(events);
      expect(snapshot(sandbox)).toEqual(afterImport);
    }
  }, 120_000);
});
