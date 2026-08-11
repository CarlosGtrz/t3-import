import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

async function withClient<T>(operation: (client: CodexRpcClient) => Promise<T>): Promise<T> {
  const executable = process.env.CODEX_BIN?.trim() || "codex";
  const child = spawn(executable, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Global npm commands on Windows are .cmd shims. cmd.exe performs the
    // PATHEXT lookup that a direct CreateProcess-style spawn does not.
    shell: process.platform === "win32",
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const client = new CodexRpcClient(child);
  try {
    await client.request("initialize", {
      clientInfo: { name: "t3_import", title: "T3 Import", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return await operation(client);
  } catch (error) {
    if (stderr.trim() && error instanceof Error) error.message += `\n${stderr.trim()}`;
    throw error;
  } finally {
    try { child.stdin.end(); } catch { /* process never started */ }
    if (child.exitCode === null) child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 1_000);
      timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
}

export interface CodexThreadMetadata {
  id: string;
  preview?: string;
  cwd?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
  parentThreadId?: string;
  raw?: Record<string, unknown>;
}

export async function listFromCodexAppServer(workspace?: string): Promise<CodexThreadMetadata[]> {
  return withClient(async (client) => {
    const output: CodexThreadMetadata[] = [];
    let cursor: string | null = null;
    do {
      const result = await client.request("thread/list", {
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
  });
}

export async function readFromCodexAppServer(threadId: string): Promise<Record<string, unknown> | null> {
  return withClient(async (client) => {
    const result = await client.request("thread/read", { threadId, includeTurns: true }, 12_000);
    return isObject(result) && isObject(result.thread) ? result.thread : null;
  });
}
