import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as zlib from "node:zlib";
import { afterAll, afterEach, expect, it } from "vitest";
import { normalizeCodexHistory } from "../src/sources/codexHistory.js";
import { recoverCodexImages } from "../src/sources/codexImages.js";
import type { SourceSummary } from "../src/core/types.js";
import { canonicalConversation, createTarget } from "./helpers.js";
import { importConversations } from "../src/target/importer.js";

const root = mkdtempSync(join(tmpdir(), "codex-images-"));
afterAll(() => rmSync(root, {recursive:true,force:true}));
afterEach(() => { for (const suffix of [".jsonl", ".jsonl.zst"]) rmSync(join(root, `archive${suffix}`), { force: true }); });
const path = join(root, "archive.jsonl");
const missing = join(root, "deleted", "photo.png");
const bytes = Buffer.from("89504e470d0a1a0a", "hex");
const message = (imagePath = missing, data = bytes) => ({ type:"message", role:"user", content:[
  {type:"input_text",text:`<image name=[Image #1] path="${imagePath}">`},
  {type:"input_image",image_url:`data:image/png;base64,${data.toString("base64")}`},
  {type:"input_text",text:"</image>"},
] });
function archive(extra: unknown[], compressed = false, id = "chat") {
  const text = [{type:"session_meta",payload:{id,cwd:"/workspace"}},...extra].map(row=>JSON.stringify(row)).join("\n");
  writeFileSync(path+(compressed?".zst":""),compressed?zlib.zstdCompressSync(Buffer.from(text)):text);
}
const summary: SourceSummary = { source:"codex", id:"chat", title:"Chat", workspace:"/workspace", path, createdAt:"2026-01-01T00:00:00Z", updatedAt:"2026-01-01T00:00:02Z",status:"complete",branches:1 };

it.each([false,true])("recovers an expired API image path from an exact embedded wrapper (compressed=%s)", async compressed => {
  archive([{type:"response_item",payload:message()}],compressed);
  const thread = await normalizeCodexHistory({turns:[{id:"turn",status:"completed",items:[
    {type:"userMessage",id:"user",content:[{type:"text",text:"Look\u2028here"},{type:"localImage",path:missing}]},
    {type:"agentMessage",id:"answer",text:"Answer"},
  ]}]},summary);
  expect(thread.turns[0]!.user.text).toBe("Look\u2028here");
  expect(thread.turns[0]!.user.attachments[0]).toMatchObject({sourceId:"user:image:1",name:"photo.png",data:bytes});
  expect(thread.warnings).toContain(`Recovered local image from Codex archive: ${missing}`);
  expect(thread.warnings.some(w=>w.startsWith("Missing local image:"))).toBe(false);
});

it("recovers compaction replacement images without trusting another path or assistant images", async () => {
  archive([
    {type:"response_item",payload:message(join(root,"elsewhere","photo.png"))},
    {type:"response_item",payload:{...message(),role:"assistant"}},
    {type:"compacted",payload:{replacement_history:[message()]}},
  ]);
  expect((await recoverCodexImages(path,"chat",new Set([missing]))).get(missing)?.data).toEqual(bytes);
});

it("rejects wrong-thread and conflicting image copies instead of guessing", async () => {
  archive([{type:"response_item",payload:message()}],false,"another-chat");
  await expect(recoverCodexImages(path,"chat",new Set([missing]))).rejects.toThrow("different Codex thread");
  archive([{type:"response_item",payload:message()},{type:"response_item",payload:message(missing,Buffer.from("different"))}]);
  await expect(recoverCodexImages(path,"chat",new Set([missing]))).rejects.toThrow("Conflicting");
});

it("keeps missing-image warnings when only a basename matches or the archive is unavailable", async () => {
  archive([{type:"response_item",payload:message(join(root,"elsewhere","photo.png"))}]);
  expect((await recoverCodexImages(path,"chat",new Set([missing]))).size).toBe(0);
  expect((await recoverCodexImages(join(root,"absent.jsonl"),"chat",new Set([missing]))).size).toBe(0);
});

it("retains all recovered images when merged user input contains more than eight",async()=>{
  const paths=Array.from({length:9},(_,i)=>join(root,"deleted",`photo-${i}.png`));
  archive(paths.map(p=>({type:"response_item",payload:message(p)})));
  const thread=await normalizeCodexHistory({turns:[{id:"turn",status:"completed",items:[{type:"userMessage",id:"user",content:paths.map(path=>({type:"localImage",path}))}]}]},summary);
  expect(thread.turns[0]!.user.attachments).toHaveLength(9);
  const target=createTarget(join(root,"target"));
  const result=await importConversations([{conversation:canonicalConversation("/workspace",thread),resume:true}],target,{dryRun:true,resume:true});
  expect(result.results[0]!.attachments).toBe(9);
});
