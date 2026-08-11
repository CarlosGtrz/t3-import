import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ImportTui } from "../src/tui.js";
import type { TargetPaths } from "../src/core/types.js";

const paths: TargetPaths = {
  t3Home: "C:\\fixture\\.t3",
  stateDir: "C:\\fixture\\.t3\\userdata",
  dbPath: "C:\\fixture\\.t3\\userdata\\state.sqlite",
  attachmentsDir: "C:\\fixture\\.t3\\userdata\\attachments",
  runtimeStatePath: "C:\\fixture\\.t3\\userdata\\server-runtime.json",
  settingsPath: "C:\\fixture\\.t3\\userdata\\settings.json",
};

describe("interactive TUI", () => {
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
