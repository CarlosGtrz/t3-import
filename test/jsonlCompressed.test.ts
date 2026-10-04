import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readStableJsonl } from "../src/core/jsonl.js";
import { CodexSource } from "../src/sources/codex.js";
import { CodexAppServerSession } from "../src/sources/codexAppServer.js";

let root: string;
let originalHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-zstd-"));
  originalHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  vi.spyOn(CodexAppServerSession, "connect").mockRejectedValue(new Error("Offline fixture"));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});
function fixture(id: string, child = false): unknown[] {
  return [
    {timestamp:"2026-01-01T00:00:00Z",type:"session_meta",payload:{id,cwd:"/workspace",...(child ? {thread_source:"subagent"} : {})}},
    {timestamp:"2026-01-01T00:00:01Z",type:"event_msg",payload:{type:"task_started",turn_id:"t1"}},
    {timestamp:"2026-01-01T00:00:01Z",type:"response_item",payload:{type:"message",role:"user",id:"u1",content:[{type:"input_text",text:"Question"}]}},
    {timestamp:"2026-01-01T00:00:02Z",type:"response_item",payload:{type:"message",role:"assistant",id:"a1",content:[{type:"output_text",text:"Answer"}]}},
    {timestamp:"2026-01-01T00:00:03Z",type:"event_msg",payload:{type:"task_complete",turn_id:"t1"}},
  ];
}
function archive(path: string, rows: unknown[]): void {
  writeFileSync(path, zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join("\n")+"\n")));
}

it("decodes chunked Unicode JSONL with the same rows and fingerprint as plain JSONL", async () => {
  const text = JSON.stringify({text:"שלום 🌍 \u2028\u2029".repeat(20000)})+"\n\n"+JSON.stringify({second:true})+"\n";
  const plain = join(root,"plain.jsonl");
  const compressed = plain+".zst";
  writeFileSync(plain,text);
  writeFileSync(compressed,zstdCompressSync(Buffer.from(text)));
  const a = await readStableJsonl(plain);
  const b = await readStableJsonl(compressed);
  expect(b.rows).toEqual(a.rows);
  expect(b.fingerprint).toBe(a.fingerprint);
});

it("preserves agent input, assistant-only continuations, and source order across tied timestamps", async () => {
  mkdirSync(join(root,"sessions"));
  const rows = fixture("agent");
  rows[2] = {timestamp:"2026-01-01T00:00:01Z",type:"response_item",payload:{type:"agent_message",id:"incoming",content:[{type:"input_text",text:"Agent directive"},{type:"encrypted_content",encrypted_content:"opaque"}]}};
  rows.push(
    {timestamp:"2026-01-01T00:00:02Z",type:"event_msg",payload:{type:"task_started",turn_id:"continuation"}},
    {timestamp:"2026-01-01T00:00:02Z",type:"response_item",payload:{type:"message",role:"assistant",id:"z-first",content:[{type:"output_text",text:"First"}]}},
    {timestamp:"2026-01-01T00:00:02Z",type:"response_item",payload:{type:"message",role:"assistant",id:"a-second",content:[{type:"output_text",text:"Second"}]}},
    {timestamp:"2026-01-01T00:00:03Z",type:"event_msg",payload:{type:"task_complete",turn_id:"continuation"}},
  );
  archive(join(root,"sessions","agent.jsonl.zst"),rows);
  const source = new CodexSource();
  try {
    const found = await source.discover({});
    const {threads:[thread]} = await source.load(found[0]!,{});
    expect(thread!.turns).toHaveLength(2);
    expect(thread!.turns[0]!.user.text).toBe("Agent directive");
    expect(thread!.turns[1]!.user.text).toContain("continuation without a recorded user message");
    expect(thread!.turns[1]!.assistant.map(item=>item.text)).toEqual(["First","Second"]);
    const times=thread!.turns.flatMap(turn=>[turn.user,...turn.assistant]).map(item=>item.timestamp);
    expect(times.every((time,index)=>index === 0 || time > times[index-1]!)).toBe(true);
    expect(thread!.warnings).toContainEqual(expect.stringContaining("encrypted"));
    expect(thread!.warnings).toContainEqual(expect.stringContaining("placeholder"));
  } finally { await source.dispose(); }
});

it.each(["invalid","truncated"])("rejects a %s compressed stream", async (kind) => {
  const path = join(root,"bad.jsonl.zst");
  const bytes = zstdCompressSync(Buffer.from(JSON.stringify({text:"payload"})+"\n"));
  writeFileSync(path,kind === "invalid" ? Buffer.from("not a zstd frame") : bytes.subarray(0,bytes.length-3));
  await expect(readStableJsonl(path)).rejects.toThrow();
});

it("rejects malformed JSON inside a valid compressed frame", async () => {
  const path = join(root,"bad.jsonl.zst");
  writeFileSync(path,zstdCompressSync(Buffer.from("{bad json}\n")));
  await expect(readStableJsonl(path)).rejects.toThrow("Invalid JSONL");
});

it("discovers compressed active and archived files and prefers a duplicate plain rollout", async () => {
  mkdirSync(join(root,"sessions"));
  mkdirSync(join(root,"archived_sessions"));
  const duplicate = join(root,"sessions","duplicate.jsonl");
  writeFileSync(duplicate,fixture("duplicate").map(row=>JSON.stringify(row)).join("\n"));
  archive(duplicate+".zst",fixture("duplicate"));
  archive(join(root,"sessions","active.jsonl.zst"),fixture("active"));
  archive(join(root,"archived_sessions","archived.jsonl.zst"),fixture("archived"));
  archive(join(root,"sessions","child.jsonl.zst"),fixture("child",true));
  const source = new CodexSource();
  try {
    const found = await source.discover({workspace:"/workspace"});
    expect(found.map(row=>row.id).sort()).toEqual(["active","archived","duplicate"]);
    expect(found.find(row=>row.id === "duplicate")!.path).toBe(duplicate);
  } finally { await source.dispose(); }
});

it("loads a compressed legacy conversation without an app-server", async () => {
  mkdirSync(join(root,"sessions"));
  archive(join(root,"sessions","chat.jsonl.zst"),fixture("chat"));
  const source = new CodexSource();
  try {
    const found = await source.discover({});
    const conversation = await source.load(found[0]!,{});
    expect(conversation.threads[0]!.turns.map(turn=>[turn.id,turn.status,turn.user.text,turn.assistant[0]?.text])).toEqual([["t1","completed","Question","Answer"]]);
  } finally { await source.dispose(); }
});
