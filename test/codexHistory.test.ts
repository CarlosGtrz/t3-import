import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CodexSource } from "../src/sources/codex.js";
import { normalizeCodexHistory } from "../src/sources/codexHistory.js";
import type { SourceSummary } from "../src/core/types.js";
import { createTarget } from "./helpers.js";
import { importConversations } from "../src/target/importer.js";
import { syncConversations } from "../src/target/sync.js";

let root: string;
let originalHome: string | undefined;
let originalBin: string | undefined;
const adapters: CodexSource[] = [];
const summary: SourceSummary = { source: "codex", id: "db-chat", title: "Database chat", workspace: "/workspace", path: "codex-api:db-chat", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", status: "complete", branches: 1 };
const user = { type: "userMessage", id: "u1", content: [{ type: "text", text: "Hello" }] };
const answer = { type: "agentMessage", id: "a1", text: "World" };
const turn = { id: "t1", status: "completed", startedAt: 1767225600, completedAt: 1767225602, items: [user, answer] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-codex-api-"));
  originalHome = process.env.CODEX_HOME;
  originalBin = process.env.CODEX_BIN;
  process.env.CODEX_HOME = root;
});
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  if (originalBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = originalBin;
  rmSync(root, { recursive: true, force: true });
});

function server(repeatCursor = false, paginated = true, emptyHistory = false): CodexSource {
  const path = join(root, "codex.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const metadata = {id:"db-chat", cwd:"/workspace", name:"Database chat", createdAt:1767225600, updatedAt:1767312000, historyMode:${JSON.stringify(paginated ? "paginated" : "legacy")}};
const user = ${JSON.stringify(user)};
const answer = ${JSON.stringify(answer)};
for await (const line of createInterface({input:process.stdin})) {
 const {id, method, params:p} = JSON.parse(line); if(id === undefined) continue;
 let result = {};
 if(method === "thread/list") result = p.archived ? {data:[{...metadata,id:"archived-chat"}],nextCursor:null} : {data:[metadata,...(p.sourceKinds ? [{...metadata,id:"child-chat",parentThreadId:"db-chat"}] : [])],nextCursor:null};
 if(method === "thread/read") result = {thread:{...metadata, turns:p.includeTurns ? [${JSON.stringify(turn)}] : []}};
 if(method === "thread/turns/list") result = p.cursor ? {data:[{id:"t2",status:"interrupted",startedAt:1767225603,completedAt:1767225604}],nextCursor:null} : {data:[{id:"t1",status:"completed",startedAt:1767225600,completedAt:1767225602}],nextCursor:"next-turn"};
 if(method === "thread/items/list") result = p.cursor ? {data:[{turnId:p.turnId,item:{...answer,id:p.turnId+":answer"},completedAtMs:1767225602000}],nextCursor:${repeatCursor ? '"next-item"' : 'null'}} : {data:[{turnId:p.turnId,item:{...user,id:p.turnId+":user"},startedAtMs:1767225600000}],nextCursor:"next-item"};
 if(method === "thread/turns/list" && ${emptyHistory}) result = {data:[],nextCursor:null};
 process.stdout.write(JSON.stringify({id,result})+"\\n");
}
`);
  if (process.platform === "win32") {
    const cmd = join(root, "codex.cmd"); writeFileSync(cmd, '@echo off\r\nnode "%~dp0codex.mjs" %*\r\n'); process.env.CODEX_BIN = cmd;
  } else { chmodSync(path, 0o755); process.env.CODEX_BIN = path; }
  const adapter = new CodexSource(); adapters.push(adapter); return adapter;
}

it("discovers API-only and archived chats and reads every turn and item page without rollouts", async () => {
  const adapter = server();
  const found = await adapter.discover({ workspace: "/workspace" });
  expect(found.map((value) => value.id).sort()).toEqual(["archived-chat", "db-chat"]);
  expect(found.find((value) => value.id === "archived-chat")?.archived).toBe(true);
  const loaded = await adapter.load(found.find((value) => value.id === "db-chat")!, {});
  expect(loaded.threads[0]!.turns.map((value) => [value.id, value.status, value.user.text, value.assistant[0]?.text])).toEqual([
    ["t1", "completed", "Hello", "World"], ["t2", "interrupted", "Hello", "World"],
  ]);
  expect(loaded.threads[0]!.turns[0]!.assistant[0]!.timestamp).toBe("2026-01-01T00:00:02.000Z");
  expect((await adapter.load(found[0]!, {})).fingerprint).toBe(loaded.fingerprint);
  expect(await adapter.discover({ workspace: "/another" })).toEqual([]);
  expect(await adapter.discover({ since: new Date("2026-02-01") })).toEqual([]);
  const all = await adapter.discover({includeSubagents:true});
  expect(all.find((value) => value.id === "child-chat")?.parentId).toBe("db-chat");
});

it("uses paginated API history even when an existing rollout body is damaged", async () => {
  const adapter = server();
  mkdirSync(join(root,"sessions"));
  writeFileSync(join(root,"sessions","rollout.jsonl"), JSON.stringify({type:"session_meta",payload:{id:"db-chat",cwd:"/workspace"}})+"\nmalformed body\n");
  const found = await adapter.discover({});
  const loaded = await adapter.load(found.find((value)=>value.id === "db-chat")!,{});
  expect(loaded.threads[0]!.turns).toHaveLength(2);
});

it("hydrates older API threads when no rollout file is available", async () => {
  const adapter = server(false,false);
  const found = await adapter.discover({});
  const loaded = await adapter.load(found.find((value)=>value.id === "db-chat")!,{});
  expect(loaded.threads[0]!.turns[0]!.assistant[0]!.text).toBe("World");
});

it("uses a readable rollout when paginated API history is explicitly empty", async () => {
  const adapter = server(false,true,true);
  mkdirSync(join(root,"sessions"));
  const rows = [
    {timestamp:"2026-01-01T00:00:00Z",type:"session_meta",payload:{id:"db-chat",cwd:"/workspace"}},
    {timestamp:"2026-01-01T00:00:01Z",type:"event_msg",payload:{type:"task_started",turn_id:"legacy-turn"}},
    {timestamp:"2026-01-01T00:00:01Z",type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Legacy question"}]}},
    {timestamp:"2026-01-01T00:00:02Z",type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"Legacy answer"}]}},
    {timestamp:"2026-01-01T00:00:03Z",type:"event_msg",payload:{type:"task_complete",turn_id:"legacy-turn"}},
  ];
  writeFileSync(join(root,"sessions","rollout.jsonl"),rows.map(row=>JSON.stringify(row)).join("\n"));
  const found = await adapter.discover({});
  const loaded = await adapter.load(found.find(value=>value.id === "db-chat")!,{});
  expect(loaded.threads[0]!.turns.map(value=>[value.id,value.user.text,value.assistant[0]?.text])).toEqual([["legacy-turn","Legacy question","Legacy answer"]]);
});

it("imports API history idempotently and appends a settled turn without duplicates", async () => {
  const adapter = server();
  const found = await adapter.discover({});
  const conversation = await adapter.load(found.find((value)=>value.id === "db-chat")!,{});
  const paths = createTarget(join(root,"target"));
  const previousLedger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root,"ledger");
  try {
    const initial = {...conversation,threads:[{...conversation.threads[0]!,turns:conversation.threads[0]!.turns.slice(0,1)}]};
    expect((await importConversations([{conversation:initial,resume:true}],paths,{dryRun:false,resume:true})).status).toBe("imported");
    expect((await importConversations([{conversation:initial,resume:true}],paths,{dryRun:false,resume:true})).status).toBe("already-imported");
    // Existing fixture helper leaves projectors unbootstrapped; this test covers
    // the canonical writer and reconciliation, not upstream projection startup.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(paths.dbPath);
    db.prepare("INSERT INTO projection_state (projector,last_applied_sequence,updated_at) SELECT 'projection.threads',MAX(sequence),'2026-01-01' FROM orchestration_events").run();
    db.close();
    const synced = await syncConversations([{conversation}],paths,{dryRun:false});
    expect(synced.results[0]!.turnsAdded).toBe(1);
    expect((await syncConversations([{conversation}],paths,{dryRun:true})).results[0]!.turnsAdded).toBe(0);
  } finally {
    if(previousLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR; else process.env.T3_IMPORT_DATA_DIR = previousLedger;
  }
});

it("rejects repeated item cursors instead of silently importing partial history", async () => {
  const adapter = server(true);
  const found = await adapter.discover({});
  await expect(adapter.load(found[0]!, {})).rejects.toMatchObject({exitCode:5});
});

it("preserves message ids, plans, tool output, images and terminal states while excluding active turns", async () => {
  const data = { turns: [{ ...turn, status: "failed", error: {message:"Provider failed"}, items: [
    {...user, content:[{type:"text",text:"Hello"},{type:"image",url:"data:image/png;base64,aGk="}]}, answer,
    {type:"plan",id:"p1",text:"# Plan"}, {type:"mcpToolCall",id:"m1",tool:"search",status:"completed",result:{content:[{type:"text",text:"Tool result"}]}},
    {type:"contextCompaction",id:"c1"},
  ] }, { ...turn, id:"active",status:"inProgress" }] };
  const parsed = await normalizeCodexHistory(data, summary);
  expect(parsed.turns).toHaveLength(1);
  expect(parsed.ignoredInProgressTurns).toBe(1);
  expect(parsed.turns[0]!.terminalError).toBe("Provider failed");
  expect(parsed.turns[0]!.user.sourceId).toBe("u1");
  expect(parsed.turns[0]!.user.attachments[0]!.data?.toString()).toBe("hi");
  expect(parsed.turns[0]!.plans[0]!.markdown).toBe("# Plan");
  expect(parsed.turns[0]!.activities[0]!.payload.data).toEqual({toolCallId:"m1",item:data.turns[0]!.items[3]});
  expect((await normalizeCodexHistory(data, summary, true)).turns).toHaveLength(2);
});

it("fails on unknown terminal status and duplicate item ids", async () => {
  await expect(normalizeCodexHistory({turns:[{...turn,status:"unknown"}]},summary)).rejects.toMatchObject({exitCode:5});
  await expect(normalizeCodexHistory({turns:[{...turn,items:[user,user]}]},summary)).rejects.toMatchObject({exitCode:5});
});

it("preserves automatic continuations and item order when timestamps are missing", async () => {
  const parsed = await normalizeCodexHistory({turns:[{...turn,items:[{...answer,id:"z-first",text:"First"},{...answer,id:"a-second",text:"Second"}]}]},summary);
  expect(parsed.turns[0]!.user.text).toBe("[Codex continuation without a recorded user message]");
  expect(parsed.turns[0]!.assistant.map((message)=>message.text)).toEqual(["First","Second"]);
  expect(parsed.turns[0]!.assistant[0]!.timestamp < parsed.turns[0]!.assistant[1]!.timestamp).toBe(true);
  expect(parsed.turns[0]!.user.timestamp < parsed.turns[0]!.assistant[0]!.timestamp).toBe(true);
  expect(parsed.warnings).toEqual([expect.stringContaining("continuation placeholder")]);
  const adjacent = await normalizeCodexHistory({turns:[{...turn,startedAt:null,completedAt:null},{...turn,id:"t2",startedAt:null,completedAt:null}]},summary);
  expect(adjacent.turns[0]!.assistant[0]!.timestamp < adjacent.turns[1]!.user.timestamp).toBe(true);
});

it("reports unsupported inputs and missing local images without losing the rest of a chat", async () => {
  const parsed = await normalizeCodexHistory({turns:[{...turn,items:[{...user,content:[{type:"audio",url:"https://example.test/audio"}]},answer]}]},summary);
  expect(parsed.warnings).toEqual([expect.stringContaining("audio")]);
  const missing = await normalizeCodexHistory({turns:[{...turn,items:[{...user,content:[{type:"localImage",path:join(root,"missing.png")}]},answer]}]},summary);
  expect(missing.warnings).toEqual([expect.stringContaining("Missing local image")]);
  expect(missing.turns[0]!.user.text).toContain("Missing image:");
  expect(missing.turns[0]!.assistant[0]!.text).toBe("World");
});
