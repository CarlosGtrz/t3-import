import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SourceName, TargetPaths } from "../core/types.js";
import { isObject, stringValue } from "../core/util.js";

export interface TargetOverrides {
  t3Home?: string;
  dbPath?: string;
  attachmentsDir?: string;
  providerInstance?: string;
}

export function resolveTargetPaths(overrides: TargetOverrides = {}): TargetPaths {
  const explicitHome = overrides.t3Home ?? process.env.T3CODE_HOME;
  const defaultHome = explicitHome ? resolve(explicitHome) : join(homedir(), ".t3");
  const dbPath = overrides.dbPath ? resolve(overrides.dbPath) : join(defaultHome, "userdata", "state.sqlite");
  const stateDir = dirname(dbPath);
  const t3Home = overrides.dbPath && !explicitHome ? dirname(stateDir) : defaultHome;
  return {
    t3Home,
    stateDir,
    dbPath,
    attachmentsDir: overrides.attachmentsDir ? resolve(overrides.attachmentsDir) : join(stateDir, "attachments"),
    runtimeStatePath: join(stateDir, "server-runtime.json"),
    settingsPath: join(stateDir, "settings.json"),
  };
}

export interface ProviderSelection {
  instanceId: string;
  providerName: "codex" | "claudeAgent";
  adapterKey: "codex" | "claudeAgent";
  model: string;
  options: Array<{ id: string; value: string | boolean }>;
  warning?: string;
}

function configuredInstances(paths: TargetPaths): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(paths.settingsPath)) return result;
  try {
    const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8")) as unknown;
    if (!isObject(settings) || !isObject(settings.providerInstances)) return result;
    for (const [id, value] of Object.entries(settings.providerInstances)) {
      if (!isObject(value) || value.enabled === false) continue;
      const driver = stringValue(value.driver);
      if (driver) result.set(id, driver);
    }
  } catch {
    // Defaults remain valid when settings are absent or unreadable.
  }
  return result;
}

export function listProviderInstances(paths: TargetPaths, source: SourceName): string[] {
  const driver = source === "codex" ? "codex" : "claudeAgent";
  const configured = [...configuredInstances(paths)].filter(([, value]) => value === driver).map(([id]) => id);
  return [...new Set([driver, ...configured])];
}

function cacheModels(paths: TargetPaths, instanceId: string): string[] {
  const cache = join(paths.t3Home, "caches", `${instanceId}.json`);
  if (!existsSync(cache)) return [];
  try {
    const parsed = JSON.parse(readFileSync(cache, "utf8")) as unknown;
    if (!isObject(parsed) || !Array.isArray(parsed.models)) return [];
    return parsed.models.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (!isObject(entry)) return [];
      return [stringValue(entry.id) ?? stringValue(entry.model) ?? stringValue(entry.value)].filter((value): value is string => Boolean(value));
    });
  } catch {
    return [];
  }
}

export function resolveProviderSelection(
  paths: TargetPaths,
  source: SourceName,
  requestedModel: string,
  effort: string | undefined,
  overrideInstance?: string,
): ProviderSelection {
  const providerName = source === "codex" ? "codex" : "claudeAgent";
  const instanceId = overrideInstance ?? providerName;
  const models = cacheModels(paths, instanceId);
  const requested = requestedModel && requestedModel !== "default" ? requestedModel : undefined;
  const model = requested && (models.length === 0 || models.includes(requested)) ? requested : models[0] ?? requested ?? "default";
  const warning = requested && models.length > 0 && !models.includes(requested)
    ? `Source model '${requested}' is unavailable in T3 instance '${instanceId}'; using '${model}'.`
    : undefined;
  return {
    instanceId,
    providerName,
    adapterKey: providerName,
    model,
    options: [
      ...(effort ? [{ id: "reasoningEffort", value: effort }] : []),
      ...(source === "codex" ? [{ id: "serviceTier", value: "default" }] : []),
    ],
    ...(warning ? { warning } : {}),
  };
}
