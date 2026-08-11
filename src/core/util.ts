import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const parsed = typeof value === "number" && value < 10_000_000_000
    ? new Date(value * 1_000)
    : new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function canonicalPath(input: string): string {
  const absolute = isAbsolute(input) ? normalize(input) : resolve(input);
  let result = absolute;
  try {
    result = realpathSync.native(absolute);
  } catch {
    // Historical source workspaces can be missing; keep the normalized path.
  }
  result = result.replace(/[\\/]+$/u, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? result.toLowerCase()
    : result;
}

export function pathContains(parent: string, child: string): boolean {
  const normalizedParent = canonicalPath(parent);
  const normalizedChild = canonicalPath(child);
  if (normalizedParent === normalizedChild) return true;
  const separator = process.platform === "win32" ? "\\" : "/";
  return normalizedChild.startsWith(`${normalizedParent}${separator}`);
}

export function truncate(value: string, limit = 180): string {
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

export function deriveTitle(text: string, fallback = "Imported conversation"): string {
  const line = text.split(/\r?\n/u).find((entry) => entry.trim().length > 0)?.trim() ?? fallback;
  return truncate(line, 72);
}

export function sortStable<T extends { timestamp: string; sourceId: string }>(items: T[]): T[] {
  return items.sort(
    (left, right) => left.timestamp.localeCompare(right.timestamp) || left.sourceId.localeCompare(right.sourceId),
  );
}
