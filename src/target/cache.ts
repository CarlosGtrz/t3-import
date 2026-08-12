import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { CacheResetResult, TargetPaths } from "../core/types.js";
import { safetyError, writeError } from "../core/errors.js";
import { assertT3Closed } from "./schema.js";

const PROFILE_NAMES = ["T3 Code (Alpha)", "T3 Code (Nightly)", "T3 Code", "t3code"];
const CACHE_NAMES = ["t3code_app_0.indexeddb.leveldb", "t3code_app_0.indexeddb.blob"];

export interface CacheDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  userHome?: string;
}

export interface T3CacheProfile {
  profilePath: string;
  cachePaths: string[];
  modifiedAt: number;
}

export function formatCacheResetResult(result: CacheResetResult): string {
  if (result.status === "not-found") {
    return "No T3 IndexedDB cache was found. Nothing was changed.";
  }
  return [
    "T3 IndexedDB cache reset successfully.",
    `Profile: ${result.profile}`,
    `Backup: ${result.backup}`,
    `Entries removed: ${result.entries.length}`,
    ...result.entries.map((entry) => `  - ${entry}`),
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
}

function profileBase(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  userHome: string,
): string | undefined {
  if (platform === "win32") return environment.APPDATA;
  if (platform === "darwin") return join(userHome, "Library", "Application Support");
  return environment.XDG_CONFIG_HOME?.trim() || join(userHome, ".config");
}

function newestModification(path: string): number {
  if (!existsSync(path)) return 0;
  const details = lstatSync(path);
  if (!details.isDirectory()) return details.mtimeMs;
  let newest = details.mtimeMs;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestModification(join(path, name)));
  return newest;
}

export function discoverT3CacheProfiles(options: CacheDiscoveryOptions = {}): T3CacheProfile[] {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();
  const override = environment.T3_CODE_USER_DATA?.trim();
  const base = profileBase(environment, platform, userHome);
  const candidates = override
    ? [resolve(override)]
    : base
      ? PROFILE_NAMES.map((name) => join(base, name))
      : [];
  return candidates.flatMap((profilePath) => {
    const indexedDb = join(profilePath, "IndexedDB");
    const cachePaths = CACHE_NAMES.map((name) => join(indexedDb, name)).filter(existsSync);
    if (cachePaths.length === 0) return [];
    return [{
      profilePath,
      cachePaths,
      modifiedAt: Math.max(...cachePaths.map(newestModification)),
    }];
  }).sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function files(path: string, root = path): Array<{ relative: string; hash: string; size: number }> {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) throw writeError(`Refusing to back up a symbolic link in the T3 cache: ${path}`);
  if (details.isFile()) {
    return [{
      relative: path.slice(root.length).replace(/^[/\\]+/u, ""),
      hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
      size: details.size,
    }];
  }
  return readdirSync(path).flatMap((name) => files(join(path, name), root));
}

function verifiedCopy(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  const sourceFiles = files(source).sort((a, b) => a.relative.localeCompare(b.relative));
  const destinationFiles = files(destination).sort((a, b) => a.relative.localeCompare(b.relative));
  if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles)) {
    throw writeError(`T3 cache backup verification failed: ${destination}`);
  }
}

function restoreMoved(staging: string, indexedDb: string, names: string[]): void {
  for (const name of [...names].reverse()) {
    const staged = join(staging, name);
    const original = join(indexedDb, name);
    if (!existsSync(staged)) continue;
    if (existsSync(original)) rmSync(original, { recursive: true, force: true });
    renameSync(staged, original);
  }
  rmSync(staging, { recursive: true, force: true });
}

export async function resetT3RebuildableCache(
  paths: TargetPaths,
  options: CacheDiscoveryOptions = {},
): Promise<CacheResetResult> {
  await assertT3Closed(paths);
  const profiles = discoverT3CacheProfiles(options);
  if (profiles.length === 0) {
    return { status: "not-found", backup: null, profile: null, entries: [], warnings: [] };
  }

  const profile = profiles[0]!;
  const indexedDb = join(profile.profilePath, "IndexedDB");
  const resolvedIndexedDb = resolve(indexedDb);
  const entryNames = profile.cachePaths.map((cachePath) => basename(cachePath));
  for (const cachePath of profile.cachePaths) {
    const resolvedCache = resolve(cachePath);
    if (!resolvedCache.startsWith(`${resolvedIndexedDb}${process.platform === "win32" ? "\\" : "/"}`)) {
      throw safetyError(`Refusing to reset a cache outside T3's IndexedDB directory: ${cachePath}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backup = join(paths.stateDir, "t3-import-backups", `indexeddb-before-cache-reset-${stamp}`);
  const backupProfile = join(backup, basename(profile.profilePath));
  const staging = join(profile.profilePath, `.t3-import-cache-reset-${randomUUID()}`);
  mkdirSync(staging, { recursive: false });
  const moved: string[] = [];
  try {
    for (const cachePath of profile.cachePaths) {
      const name = basename(cachePath);
      renameSync(cachePath, join(staging, name));
      moved.push(name);
    }
    mkdirSync(backupProfile, { recursive: true });
    for (const name of moved) verifiedCopy(join(staging, name), join(backupProfile, name));
    rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    let restoreError: unknown;
    try { restoreMoved(staging, indexedDb, moved); } catch (cause) { restoreError = cause; }
    if (!restoreError) rmSync(backup, { recursive: true, force: true });
    const detail = restoreError
      ? ` Cache restoration also failed; recovery files were preserved at ${existsSync(backup) ? backup : staging}.`
      : "";
    throw writeError(`Unable to reset T3's IndexedDB cache: ${error instanceof Error ? error.message : String(error)}.${detail}`, error);
  }

  const warnings = profiles.length > 1
    ? [`Reset the most recently used T3 profile; ${profiles.length - 1} older profile cache${profiles.length === 2 ? " was" : "s were"} left untouched.`]
    : [];
  return {
    status: "reset",
    backup,
    profile: profile.profilePath,
    entries: entryNames,
    warnings,
  };
}
