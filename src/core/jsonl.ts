import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

export interface JsonlSnapshot {
  rows: unknown[];
  fingerprint: string;
  mtimeMs: number;
  size: number;
}

async function readOnce(path: string): Promise<JsonlSnapshot> {
  const before = statSync(path);
  const rows: unknown[] = [];
  const hasher = createHash("sha256");
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    hasher.update(line);
    hasher.update("\n");
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid JSONL in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const after = statSync(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("SOURCE_CHANGED_DURING_READ");
  }
  return { rows, fingerprint: hasher.digest("hex"), mtimeMs: after.mtimeMs, size: after.size };
}

export async function readStableJsonl(path: string): Promise<JsonlSnapshot> {
  try {
    return await readOnce(path);
  } catch (error) {
    if (error instanceof Error && error.message === "SOURCE_CHANGED_DURING_READ") {
      return readOnce(path);
    }
    throw error;
  }
}
