import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverT3CacheProfiles, formatCacheResetResult, resetT3RebuildableCache } from "../src/target/cache.js";
import { resolveTargetPaths } from "../src/target/config.js";

describe("T3 IndexedDB cache reset", () => {
  it("formats reset results for interactive output", () => {
    expect(formatCacheResetResult({
      status: "reset",
      profile: "C:\\Users\\test\\AppData\\Roaming\\T3 Code (Alpha)",
      backup: "C:\\Users\\test\\.t3\\userdata\\t3-import-backups\\cache",
      entries: ["t3code_app_0.indexeddb.leveldb", "t3code_app_0.indexeddb.blob"],
      warnings: [],
    })).toBe([
      "T3 界面缓存（IndexedDB）已重置。",
      "配置目录：C:\\Users\\test\\AppData\\Roaming\\T3 Code (Alpha)",
      "备份：C:\\Users\\test\\.t3\\userdata\\t3-import-backups\\cache",
      "清除条目：2",
      "  - t3code_app_0.indexeddb.leveldb",
      "  - t3code_app_0.indexeddb.blob",
      "",
      "说明：这里只清本地界面缓存（标签页、草稿、连接快照）。",
      "聊天记录保存在 statev2.sqlite，不在这个目录；重置缓存既不会删除也不会恢复消息。",
      "如果聊天记录缺失或导入后正文为空，请运行 `t3-import repair`。",
    ].join("\n"));
    expect(formatCacheResetResult({ status: "not-found", profile: null, backup: null, entries: [], warnings: [] }))
      .toBe("没有找到 T3 的 IndexedDB 界面缓存，未做任何修改。");
  });

  it("discovers the most recently used T3 profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-cache-discovery-"));
    const appData = join(root, "AppData");
    const alpha = join(appData, "T3 Code (Alpha)", "IndexedDB", "t3code_app_0.indexeddb.leveldb");
    mkdirSync(alpha, { recursive: true });
    writeFileSync(join(alpha, "CURRENT"), "MANIFEST-000001");

    const profiles = discoverT3CacheProfiles({
      environment: { APPDATA: appData },
      platform: "win32",
      userHome: root,
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.profilePath).toBe(join(appData, "T3 Code (Alpha)"));
  });

  it("backs up, verifies, and removes the rebuildable origin cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-cache-reset-"));
    const appData = join(root, "AppData");
    const profile = join(appData, "T3 Code (Alpha)");
    const indexedDb = join(profile, "IndexedDB");
    const levelDb = join(indexedDb, "t3code_app_0.indexeddb.leveldb");
    const blob = join(indexedDb, "t3code_app_0.indexeddb.blob", "1", "00");
    mkdirSync(levelDb, { recursive: true });
    mkdirSync(blob, { recursive: true });
    writeFileSync(join(levelDb, "CURRENT"), "MANIFEST-000001\n");
    writeFileSync(join(blob, "1"), "cached attachment");
    const paths = resolveTargetPaths({ t3Home: join(root, ".t3") });
    mkdirSync(paths.stateDir, { recursive: true });

    const result = await resetT3RebuildableCache(paths, {
      environment: { APPDATA: appData },
      platform: "win32",
      userHome: root,
    });

    expect(result.status).toBe("reset");
    expect(result.profile).toBe(profile);
    expect(result.entries).toEqual([
      "t3code_app_0.indexeddb.leveldb",
      "t3code_app_0.indexeddb.blob",
    ]);
    expect(existsSync(levelDb)).toBe(false);
    expect(existsSync(join(indexedDb, "t3code_app_0.indexeddb.blob"))).toBe(false);
    expect(result.backup).not.toBeNull();
    const backupProfile = join(result.backup!, basename(profile));
    expect(readFileSync(join(backupProfile, "t3code_app_0.indexeddb.leveldb", "CURRENT"), "utf8")).toBe("MANIFEST-000001\n");
    expect(readFileSync(join(backupProfile, "t3code_app_0.indexeddb.blob", "1", "00", "1"), "utf8")).toBe("cached attachment");
  });

  it("is a no-op when no rebuildable cache exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-cache-missing-"));
    const paths = resolveTargetPaths({ t3Home: join(root, ".t3") });
    mkdirSync(paths.stateDir, { recursive: true });

    await expect(resetT3RebuildableCache(paths, {
      environment: { APPDATA: join(root, "empty") },
      platform: "win32",
      userHome: root,
    })).resolves.toMatchObject({ status: "not-found", backup: null, entries: [] });
  });
});
