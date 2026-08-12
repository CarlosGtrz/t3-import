import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function cli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

describe("replace CLI", () => {
  it("exposes only the supported replacement options", () => {
    const result = cli("replace", "--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--thread <id>");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).not.toContain("--all");
    expect(result.stdout).not.toContain("--duplicate");
    expect(result.stdout).not.toContain("--include-incomplete");
  });

  it("rejects the removed duplicate import option", () => {
    const result = cli("import", "--duplicate");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--duplicate'");
  });

  it("requires explicit confirmation for non-interactive replacement", () => {
    const result = cli("replace", "--source", "codex", "--workspace", root, "--thread", "fixture", "--non-interactive");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Non-interactive replacement requires --yes");
  });
});
