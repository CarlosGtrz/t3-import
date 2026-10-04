import { createReadStream, statSync } from "node:fs";
import * as zlib from "node:zlib";
import { sha256 } from "./util.js";

export interface JsonlSnapshot {
  rows: unknown[];
  fingerprint: string;
  mtimeMs: number;
  size: number;
}

/** Stream plain or Zstandard-compressed JSONL; closing a prefix read also closes the file. */
export async function* readJsonlLines(path: string): AsyncGenerator<string> {
  const compressed = path.endsWith(".zst");
  if (compressed && typeof zlib.createZstdDecompress !== "function") {
    throw new Error("Compressed Codex archives require Node.js 22.15 or newer.");
  }
  const source = createReadStream(path);
  const decoder = compressed ? zlib.createZstdDecompress() : undefined;
  const input = decoder ?? source;
  if (decoder) {
    source.on("error", (error) => input.destroy(error));
    input.once("close", () => source.destroy());
    source.pipe(decoder);
  }
  input.setEncoding("utf8");
  let pending = "";
  try {
    // JSON strings may contain literal U+2028/U+2029. readline treats these as
    // separators, but JSONL records are delimited only by LF (or CRLF).
    for await (const chunk of input) {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
      }
    }
    if (pending) yield pending;
  } finally {
    input.destroy();
    source.destroy();
  }
}

async function readOnce(path: string): Promise<JsonlSnapshot> {
  const before = statSync(path);
  const rows: unknown[] = [];
  const hashParts: string[] = [];
  for await (const line of readJsonlLines(path)) {
    if (!line.trim()) continue;
    hashParts.push(line, "\n");
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
  return { rows, fingerprint: sha256(hashParts.join("")), mtimeMs: after.mtimeMs, size: after.size };
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
