import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { isObject } from "../core/util.js";

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class CodexRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRpc>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const rejectPending = (error: Error) => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as unknown;
        if (!isObject(message) || typeof message.id !== "number") return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } catch {
        // Notifications and non-JSON diagnostics are irrelevant to read-only discovery.
      }
    });
    child.once("exit", (code) => {
      rejectPending(new Error(`codex app-server exited with code ${String(code)}`));
    });
    child.once("error", (cause) => {
      rejectPending(new Error(`Unable to start codex app-server: ${cause.message}`, { cause }));
    });
    // A failed or abruptly closed child can also surface EPIPE on stdin.
    child.stdin.on("error", () => {});
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 8_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }
}

function launchCommand(): { executable: string; shell: boolean } {
  const configured = process.env.CODEX_BIN?.trim();
  if (configured) return { executable: configured, shell: process.platform === "win32" && [".cmd", ".bat"].includes(extname(configured).toLowerCase()) };
  if (process.platform === "win32") {
    const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const executable = directories.map((directory) => join(directory.replace(/^"|"$/gu, ""), "codex.exe")).find(existsSync);
    if (executable) return { executable, shell: false };
    const shim = directories.map((directory) => join(directory.replace(/^"|"$/gu, ""), "codex.cmd")).find(existsSync);
    if (shim) return { executable: shim, shell: true };
  }
  return { executable: "codex", shell: false };
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

export class CodexAppServerSession {
  private closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly client: CodexRpcClient,
    private readonly stderr: { value: string },
  ) {}

  static async connect(): Promise<CodexAppServerSession> {
    const command = launchCommand();
    const child = spawn(command.executable, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: command.shell,
    });
    const stderr = { value: "" };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr.value += chunk; });
    const session = new CodexAppServerSession(child, new CodexRpcClient(child), stderr);
    try {
      await session.client.request("initialize", {
        clientInfo: { name: "t3_import", title: "T3 Import", version: "0.2.1" },
        capabilities: { experimentalApi: true },
      });
      session.client.notify("initialized", {});
      return session;
    } catch (error) {
      if (stderr.value.trim() && error instanceof Error) error.message += `\n${stderr.value.trim()}`;
      await session.close();
      throw error;
    }
  }

  async list(workspace?: string): Promise<CodexThreadMetadata[]> {
    const output: CodexThreadMetadata[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.client.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "updated_at",
        ...(workspace ? { cwd: [workspace] } : {}),
      }, 30_000);
      if (!isObject(result) || !Array.isArray(result.data)) break;
      for (const value of result.data) {
        if (!isObject(value) || typeof value.id !== "string") continue;
        output.push({
          id: value.id,
          ...(typeof value.name === "string" && value.name.trim() ? { name: value.name } : {}),
          ...(typeof value.preview === "string" ? { preview: value.preview } : {}),
          ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
          ...(typeof value.model === "string" ? { model: value.model } : {}),
          ...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
          ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
          ...(typeof value.parentThreadId === "string" ? { parentThreadId: value.parentThreadId } : {}),
          raw: value,
        });
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor);
    return output;
  }

  async read(threadId: string): Promise<Record<string, unknown> | null> {
    const result = await this.client.request("thread/read", { threadId, includeTurns: true }, 12_000);
    return isObject(result) && isObject(result.thread) ? result.thread : null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch { /* process never started */ }
    if (!await waitForExit(this.child, 750) && this.child.exitCode === null) this.child.kill();
    if (!await waitForExit(this.child, 750) && this.child.exitCode === null) this.child.kill("SIGKILL");
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.unref();
  }
}

async function withSession<T>(operation: (session: CodexAppServerSession) => Promise<T>): Promise<T> {
  const session = await CodexAppServerSession.connect();
  try { return await operation(session); }
  finally { await session.close(); }
}

export interface CodexThreadMetadata {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
  parentThreadId?: string;
  raw?: Record<string, unknown>;
}

export async function listFromCodexAppServer(workspace?: string): Promise<CodexThreadMetadata[]> {
  return withSession((session) => session.list(workspace));
}

export async function readFromCodexAppServer(threadId: string): Promise<Record<string, unknown> | null> {
  return withSession((session) => session.read(threadId));
}
