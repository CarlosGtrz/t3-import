import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { conversationStatusText, escapeDestination, ImportTui, StartT3Prompt } from "../src/tui.js";
import type { ConversationSyncPreview, TargetPaths } from "../src/core/types.js";

const paths: TargetPaths = {
  t3Home: "C:\\fixture\\.t3",
  stateDir: "C:\\fixture\\.t3\\userdata",
  dbPath: "C:\\fixture\\.t3\\userdata\\state.sqlite",
  attachmentsDir: "C:\\fixture\\.t3\\userdata\\attachments",
  runtimeStatePath: "C:\\fixture\\.t3\\userdata\\server-runtime.json",
  settingsPath: "C:\\fixture\\.t3\\userdata\\settings.json",
};

describe("interactive TUI", () => {
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
    expect(conversationStatusText(preview("new"), false)).toBe("new");
    expect(conversationStatusText(preview("syncable", 3), false)).toBe("3 new turns");
    expect(conversationStatusText(preview("up-to-date"), false)).toBe("up to date");
    expect(conversationStatusText(preview("history-diverged"), false)).toBe("history changed");
    expect(conversationStatusText(preview("branch-sync-unsupported"), false)).toBe("branch sync unsupported");
    expect(conversationStatusText({ ...preview("syncable", 1), newCompletedTurns: 0, newInterruptedTurns: 1 }, false)).toBe("1 new turn · interrupted");
    expect(conversationStatusText({ ...preview("syncable", 3), newCompletedTurns: 1, newInterruptedTurns: 1, newFailedTurns: 1 }, false)).toBe("3 new turns · 1 interrupted, 1 failed");
    expect(conversationStatusText({ ...preview("up-to-date"), ignoredActiveTurns: 1 }, false)).toBe("up to date · 1 active turn ignored");
    expect(conversationStatusText(preview("active-only"), false)).toBe("active turn only");
  });

  it("selects starting T3 Code by default on the completion prompt", () => {
    const tui = render(<StartT3Prompt index={0} />);
    expect(tui.lastFrame()).toContain("Start T3 Code now?");
    expect(tui.lastFrame()).toContain("›  Yes");
    expect(tui.lastFrame()).toContain("   No");
    tui.unmount();
  });

  it("supports arrow and vim-style source navigation", async () => {
    const tui = render(<ImportTui paths={paths} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tui.lastFrame()).toContain("Choose a source");
    expect(tui.lastFrame()).toContain("›  Codex");

    tui.stdin.write("j");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tui.lastFrame()).toContain("›  Claude Code");

    tui.stdin.write("k");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tui.lastFrame()).toContain("›  Codex");
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tui.lastFrame()).toContain("T3 is running");
    expect(tui.lastFrame()).toContain(`detected PID ${process.pid}`);
    expect(tui.lastFrame()).not.toContain("Choose a source");
    tui.unmount();
  });
});
