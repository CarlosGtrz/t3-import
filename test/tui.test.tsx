import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { conversationStatusText, escapeDestination, helpTextForScreen, ImportTui, replacementStatusText, ReplacementReview, selectionMarker, StartT3Prompt } from "../src/tui.js";
import type { ConversationReplacePreview, ConversationSyncPreview, TargetPaths } from "../src/core/types.js";
import { canonicalConversation } from "./helpers.js";

const paths: TargetPaths = {
  t3Home: "C:\\fixture\\.t3",
  stateDir: "C:\\fixture\\.t3\\userdata",
  dbPath: "C:\\fixture\\.t3\\userdata\\state.sqlite",
  attachmentsDir: "C:\\fixture\\.t3\\userdata\\attachments",
  runtimeStatePath: "C:\\fixture\\.t3\\userdata\\server-runtime.json",
  settingsPath: "C:\\fixture\\.t3\\userdata\\settings.json",
};

async function waitForFrame(
  tui: { lastFrame(): string | undefined },
  expected: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = tui.lastFrame() ?? "";
    if (frame.includes(expected)) {
      // Ink writes the frame during commit, before useInput's passive effect
      // refreshes its listener. Let that effect settle before tests send input.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const settledFrame = tui.lastFrame() ?? "";
      if (settledFrame.includes(expected)) return settledFrame;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for '${expected}'. Last frame:\n${tui.lastFrame() ?? "<none>"}`);
}

describe("interactive TUI", () => {
  it("uses related circle symbols for selectable, selected, and disabled rows", () => {
    expect(selectionMarker(false, false)).toBe("○");
    expect(selectionMarker(true, false)).toBe("◉");
    expect(selectionMarker(false, true)).toBe("⊘");
    expect(selectionMarker(true, true)).toBe("⊘");
  });

  it("advertises only controls supported by each screen", () => {
    expect(helpTextForScreen("source")).toBe("↑/↓ 或 j/k 移动  Enter 选择  Esc 返回/退出  q 退出");
    expect(helpTextForScreen("workspace")).not.toContain("空格 选择");
    expect(helpTextForScreen("provider")).not.toContain("/ 搜索");
    expect(helpTextForScreen("threads")).toContain("空格 选择/取消  a 全选  h 展开/折叠归档  / 搜索");
    expect(helpTextForScreen("threads", true)).toBe("输入关键字搜索  Backspace 删除  Enter 确认  Esc 取消");
    expect(helpTextForScreen("review")).toBe("Enter 确认执行  Esc 返回  q 退出");
    expect(helpTextForScreen("result")).toBe("↑/↓ 或 j/k 移动  Enter 确认  q 退出");
    expect(helpTextForScreen("running")).toBeUndefined();
  });

  it("only returns to option screens that were actually visited", () => {
    expect(escapeDestination("threads", ["source"])).toBe("source");
    expect(escapeDestination("threads", ["source", "workspace"])).toBe("workspace");
    expect(escapeDestination("threads", [])).toBeUndefined();
    expect(escapeDestination("review", ["source", "threads", "provider"])).toBe("provider");
  });

  it("uses the documented reconciliation status labels", () => {
    const preview = (status: ConversationSyncPreview["status"], newTurns = 0): ConversationSyncPreview => ({
      sourceId: "fixture", status, newTurns, newCompletedTurns: newTurns, newInterruptedTurns: 0, newFailedTurns: 0, ignoredActiveTurns: 0, adoptedTurns: 0, titleChanged: false,
      selectable: status === "new" || status === "syncable", previouslyImported: status !== "new", warnings: [],
    });
    expect(conversationStatusText(preview("new"), false)).toBe("新会话");
    expect(conversationStatusText(preview("syncable", 3), false)).toBe("3 个新轮次");
    expect(conversationStatusText(preview("up-to-date"), false)).toBe("已是最新");
    expect(conversationStatusText(preview("history-diverged"), false)).toBe("历史已变更");
    expect(conversationStatusText(preview("branch-sync-unsupported"), false)).toBe("不支持分支同步");
    expect(conversationStatusText({ ...preview("syncable", 1), newCompletedTurns: 0, newInterruptedTurns: 1 }, false)).toBe("1 个新轮次 · 已中断");
    expect(conversationStatusText({ ...preview("syncable", 3), newCompletedTurns: 1, newInterruptedTurns: 1, newFailedTurns: 1 }, false)).toBe("3 个新轮次 · 1 个中断, 1 个失败");
    expect(conversationStatusText({ ...preview("up-to-date"), ignoredActiveTurns: 1 }, false)).toBe("已是最新 · 忽略 1 个进行中轮次");
    expect(conversationStatusText(preview("active-only"), false)).toBe("仅有进行中轮次");
    const replacement = (status: ConversationReplacePreview["status"]): ConversationReplacePreview => ({
      sourceId: "fixture", status, selectable: status === "replaceable", previouslyImported: status !== "not-imported",
      turns: 2, events: 12, attachments: 0, warnings: [],
    });
    expect(replacementStatusText(replacement("replaceable"), false)).toBe("可替换");
    expect(replacementStatusText(replacement("already-current"), false)).toBe("已是最新版本");
    expect(replacementStatusText(replacement("active-source"), false)).toBe("源处于活跃中");
    expect(replacementStatusText(replacement("branch-replace-unsupported"), false)).toBe("不支持分支替换");
  });

  it("selects starting T3 Code by default on the completion prompt", () => {
    const tui = render(<StartT3Prompt index={0} />);
    expect(tui.lastFrame()).toContain("现在启动 T3 Code 吗？");
    expect(tui.lastFrame()).toContain("›  是 (Yes)");
    expect(tui.lastFrame()).toContain("   否 (No)");
    tui.unmount();
  });

  it("shows a replacement-only review without unrelated import and sync counters", () => {
    const conversation = canonicalConversation("C:\\fixtures\\sample-workspace");
    conversation.summary.title = "Synthetic replacement conversation";
    const preview: ConversationReplacePreview = {
      sourceId: conversation.summary.id,
      status: "replaceable",
      selectable: true,
      previouslyImported: true,
      turns: 4,
      events: 36,
      attachments: 2,
      oldThreadId: "old-thread-id",
      newThreadId: "new-thread-id",
      warnings: [],
    };
    const tui = render(<ReplacementReview
      workspace="C:\fixtures\sample-workspace"
      selections={[{ conversation }]}
      previews={new Map([[conversation.summary.id, preview]])}
      counts={{ tasks: 1, turns: 4, events: 36, attachments: 2 }}
      resetCache
    />);
    const frame = tui.lastFrame()!;
    expect(frame).toContain("确认会话替换");
    expect(frame).toContain("旧 T3 任务 ID：old-thread-id");
    expect(frame).toContain("新 T3 任务 ID：new-thread-id");
    expect(frame).toContain("4 轮对话 · 36 个事件 · 2 个附件");
    expect(frame).toContain("确认后，t3-import 将自动执行：");
    expect(frame).toContain("创建已校验的 T3 数据库安全备份");
    expect(frame).toContain("备份并重置 T3 UI 缓存");
    expect(frame).toContain("按 Enter 确认替换，按 Esc 取消。");
    expect(frame).not.toContain("新增任务数：");
    expect(frame).not.toContain("同步任务数：");
    tui.unmount();
  });

  it("supports arrow and vim-style source navigation", async () => {
    const tui = render(<ImportTui paths={paths} />);
    const initialFrame = await waitForFrame(tui, "›  Codex");
    expect(initialFrame).toContain("选择会话来源");
    expect(initialFrame).toContain("Enter 选择");
    expect(initialFrame).not.toContain("空格 选择");
    expect(initialFrame).not.toContain("/ 搜索");

    tui.stdin.write("j");
    await waitForFrame(tui, "›  Claude Code");

    tui.stdin.write("k");
    await waitForFrame(tui, "›  Codex");
    tui.unmount();
  });

  it("blocks at startup while the target T3 runtime is live", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-tui-live-"));
    const stateDir = join(root, "userdata");
    mkdirSync(stateDir, { recursive: true });
    const livePaths: TargetPaths = {
      t3Home: root,
      stateDir,
      dbPath: join(stateDir, "state.sqlite"),
      attachmentsDir: join(stateDir, "attachments"),
      runtimeStatePath: join(stateDir, "server-runtime.json"),
      settingsPath: join(stateDir, "settings.json"),
    };
    writeFileSync(livePaths.runtimeStatePath, JSON.stringify({ version: 1, pid: process.pid, origin: "http://127.0.0.1:1" }));
    const tui = render(<ImportTui paths={livePaths} />);
    const frame = await waitForFrame(tui, `PID ${process.pid}`);
    expect(frame).toContain("检测到 T3 Code 正在运行");
    expect(frame).not.toContain("选择会话来源");
    tui.unmount();
  });
});
