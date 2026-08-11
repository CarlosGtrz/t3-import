import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSource } from "../src/sources/claude.js";
import { CodexSource } from "../src/sources/codex.js";

const originalClaudeHome = process.env.CLAUDE_CONFIG_DIR;
const originalCodexHome = process.env.CODEX_HOME;
const originalCodexBin = process.env.CODEX_BIN;

afterEach(() => {
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = originalCodexBin;
});

function jsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("source adapters", () => {
  it("keeps Claude's originating workspace, separates real branches, and ignores parallel tool-result leaves", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-claude-"));
    const workspace = join(root, "workspace");
    const project = join(root, "projects", "fixture");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(workspace, "nested"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = root;
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const base = { sessionId, version: "test" };
    jsonl(join(project, `${sessionId}.jsonl`), [
      { ...base, uuid: "u", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00Z", cwd: workspace, isSidechain: false, message: { role: "user", content: "Build it" } },
      { ...base, uuid: "metadata", parentUuid: "u", type: "attachment", timestamp: "2026-01-01T00:00:00.100Z", cwd: workspace, attachment: { type: "metadata" } },
      { ...base, uuid: "a1", parentUuid: "metadata", type: "assistant", timestamp: "2026-01-01T00:00:01Z", cwd: join(workspace, "nested"), isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Working" }], stop_reason: "tool_use" } },
      { ...base, uuid: "t1", parentUuid: "a1", type: "assistant", timestamp: "2026-01-01T00:00:02Z", cwd: join(workspace, "nested"), isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "one" } }], stop_reason: "tool_use" } },
      { ...base, uuid: "t2", parentUuid: "t1", type: "assistant", timestamp: "2026-01-01T00:00:03Z", cwd: join(workspace, "nested"), isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: "call-2", name: "Bash", input: { command: "two" } }], stop_reason: "tool_use" } },
      { ...base, uuid: "r1", parentUuid: "t1", type: "user", timestamp: "2026-01-01T00:00:04Z", cwd: workspace, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "one-result" }] } },
      { ...base, uuid: "r2", parentUuid: "t2", type: "user", timestamp: "2026-01-01T00:00:05Z", cwd: workspace, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-2", content: "two-result" }] } },
      { ...base, uuid: "alternate", parentUuid: "metadata", type: "assistant", timestamp: "2026-01-01T00:00:05.500Z", cwd: workspace, isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Historical answer" }], stop_reason: "end_turn" } },
      { ...base, type: "last-prompt", leafUuid: "r2", lastPrompt: "Build it" },
      { ...base, uuid: "done", parentUuid: "r2", type: "assistant", timestamp: "2026-01-01T00:00:06Z", cwd: workspace, isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } },
    ]);

    const adapter = new ClaudeSource();
    const summaries = await adapter.discover({ workspace });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ workspace, branches: 2 });
    const conversation = await adapter.load(summaries[0]!, {});
    expect(conversation.threads).toHaveLength(2);
    const current = conversation.threads.find((thread) => thread.currentBranch)!;
    const historical = conversation.threads.find((thread) => !thread.currentBranch)!;
    expect(current.turns[0]!.activities.map((item) => item.sourceId)).toEqual(expect.arrayContaining(["call-1", "call-2"]));
    expect(current.resumeCursor).toMatchObject({ resume: sessionId, resumeSessionAt: "done", turnCount: 1 });
    expect(historical.resumeCursor).toBeUndefined();
    expect(historical.title).toContain("historical");
    expect(historical.warnings[0]).toContain("Historical Claude branch");
  });

  it("parses a Codex rollout without app-server data", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-codex-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions", "2026", "01", "01");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    process.env.CODEX_HOME = root;
    process.env.CODEX_BIN = join(root, "missing-codex-executable");
    const sessionId = "33333333-3333-4333-8333-333333333333";
    jsonl(join(sessions, `rollout-${sessionId}.jsonl`), [
      { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: workspace, timestamp: "2026-01-01T00:00:00Z" } },
      { timestamp: "2026-01-01T00:00:00Z", type: "turn_context", payload: { model: "gpt-test", effort: "high", cwd: workspace } },
      { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", id: "user-1", content: [{ type: "input_text", text: "Hello" }] } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "shell_command", arguments: "{\"command\":\"pwd\"}" } },
      { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "ok" } },
      { timestamp: "2026-01-01T00:00:02.500Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 }, total_token_usage: { total_tokens: 20 }, model_context_window: 1000 } } },
      { timestamp: "2026-01-01T00:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", id: "assistant-1", content: [{ type: "output_text", text: "Hi" }] } },
      { timestamp: "2026-01-01T00:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ]);

    const adapter = new CodexSource();
    const summaries = await adapter.discover({ workspace });
    expect(summaries).toHaveLength(1);
    const conversation = await adapter.load(summaries[0]!, {});
    expect(conversation.threads[0]).toMatchObject({ sourceSessionId: sessionId, workspace, model: "gpt-test" });
    expect(conversation.threads[0]!.turns[0]!.activities[0]).toMatchObject({ sourceId: "call-1", kind: "tool.completed" });
    expect(conversation.threads[0]!.turns[0]!.activities).toContainEqual(expect.objectContaining({ kind: "context-window.updated", payload: expect.objectContaining({ usedTokens: 13, maxTokens: 1000 }) }));
  });
});
