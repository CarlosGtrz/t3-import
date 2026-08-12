import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { canonicalPath, deterministicUuid, pathContains } from "../src/core/util.js";
import { resolveT3Launch } from "../src/target/launch.js";

describe("core utilities", () => {
  it("honors the explicit T3 Code executable override", () => {
    expect(resolveT3Launch({ T3_CODE_BIN: "/opt/t3/T3 Code" }, "linux", "/home/test")).toEqual({
      command: "/opt/t3/T3 Code",
      args: [],
    });
  });

  it("creates stable RFC 4122 UUIDs", () => {
    expect(deterministicUuid("same")).toBe(deterministicUuid("same"));
    expect(deterministicUuid("same")).not.toBe(deterministicUuid("different"));
    expect(deterministicUuid("same")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("matches canonical workspace descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-path-"));
    const child = join(root, "a", "b");
    mkdirSync(child, { recursive: true });
    expect(canonicalPath(root)).toBe(canonicalPath(realpathSync(root)));
    expect(pathContains(root, child)).toBe(true);
    expect(pathContains(child, root)).toBe(false);
  });
});
