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
      "T3 IndexedDB cache reset successfully.",
      "Profile: C:\\Users\\test\\AppData\\Roaming\\T3 Code (Alpha)",
      "Backup: C:\\Users\\test\\.t3\\userdata\\t3-import-backups\\cache",
      "Entries removed: 2",
      "  - t3code_app_0.indexeddb.leveldb",
      "  - t3code_app_0.indexeddb.blob",
    ].join("\n"));
    expect(formatCacheResetResult({ status: "not-found", profile: null, backup: null, entries: [], warnings: [] }))
      .toBe("No T3 IndexedDB cache was found. Nothing was changed.");
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
