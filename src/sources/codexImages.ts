import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as zlib from "node:zlib";
import { isObject, stringValue } from "../core/util.js";

export interface EmbeddedCodexImage { mimeType: string; data: Buffer }

// Image recovery also works when an indexed .jsonl has been compressed in place.
// Split only LF: JSON strings may legally contain literal U+2028/U+2029.
async function* imageLines(path: string): AsyncGenerator<string> {
  const source = createReadStream(path);
  const decoder = path.endsWith(".zst") ? zlib.createZstdDecompress?.() : undefined;
  if (path.endsWith(".zst") && !decoder) { source.destroy(); throw new Error("Compressed image recovery requires Node.js 22.15 or newer."); }
  const input = decoder ?? source;
  if (decoder) { source.on("error", error => input.destroy(error)); source.pipe(decoder); }
  input.setEncoding("utf8");
  let pending = "";
  try {
    for await (const chunk of input) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) { yield pending.slice(0, end); pending = pending.slice(end + 1); }
    }
    if (pending) yield pending;
  } finally { input.destroy(); source.destroy(); }
}

/** Match an exact original path, never a basename, adjacent turn, or tool image. */
export async function recoverCodexImages(path: string, threadId: string, wanted: ReadonlySet<string>): Promise<Map<string, EmbeddedCodexImage>> {
  let selected: string | undefined;
  for (const candidate of path.endsWith(".zst") ? [path] : [path, `${path}.zst`]) {
    try { if ((await stat(candidate)).isFile()) { selected = candidate; break; } }
    catch (error) { if (!isObject(error) || error.code !== "ENOENT") throw error; }
  }
  const images = new Map<string, EmbeddedCodexImage>();
  if (!selected || !wanted.size) return images;
  const before = await stat(selected);
  let verifiedThread = false;
  const inspectMessage = (value: unknown): void => {
    if (!isObject(value) || value.role !== "user" || !Array.isArray(value.content)) return;
    let originalPath: string | undefined;
    for (const part of value.content) {
      if (!isObject(part)) continue;
      if (part.type === "input_text" && typeof part.text === "string") {
        const wrapper = /^<image\b[^>]*\bpath="([^"]+)"[^>]*>$/u.exec(part.text.trim());
        if (wrapper) originalPath = wrapper[1];
        else if (part.text.trim() === "</image>") originalPath = undefined;
      } else if (part.type === "input_image" && originalPath && wanted.has(originalPath)) {
        const encoded = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/iu.exec(stringValue(part.image_url) ?? "");
        if (!encoded) continue;
        const image = { mimeType: encoded[1]!, data: Buffer.from(encoded[2]!, "base64") };
        const previous = images.get(originalPath);
        if (previous && (previous.mimeType !== image.mimeType || !previous.data.equals(image.data))) throw new Error("Conflicting archived copies of one image path.");
        images.set(originalPath, image);
      }
    }
  };
  for await (const line of imageLines(selected)) {
    if (!line.trim()) continue;
    const row: unknown = JSON.parse(line);
    if (!isObject(row) || !isObject(row.payload)) continue;
    if (row.type === "session_meta") {
      if ((stringValue(row.payload.id) ?? stringValue(row.payload.session_id)) !== threadId) throw new Error("Image archive belongs to a different Codex thread.");
      verifiedThread = true;
    } else if (verifiedThread && row.type === "response_item") inspectMessage(row.payload);
    else if (verifiedThread && row.type === "compacted" && Array.isArray(row.payload.replacement_history)) row.payload.replacement_history.forEach(inspectMessage);
  }
  const after = await stat(selected);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Image archive changed during recovery.");
  return images;
}
