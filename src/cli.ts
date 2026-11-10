#!/usr/bin/env node
import { Command, Option } from "commander";
import { render } from "ink";
import React from "react";
import Database from "better-sqlite3";
import { createInterface } from "node:readline/promises";
import { existsSync, readdirSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { z } from "zod";
import { ImportTui } from "./tui.js";
import { ImporterError, usageError } from "./core/errors.js";
import type { ImportRunResult, ReplaceRunResult, SourceName, SourceSummary, SyncRunResult } from "./core/types.js";
import { disposeSourceAdapters, sourceAdapter } from "./sources/index.js";
import { resolveTargetPaths, type TargetOverrides } from "./target/config.js";
import { IMPORTER_VERSION, importConversations, listActiveT3Projects } from "./target/importer.js";
import { inspectRuntime, validateTargetDatabase } from "./target/schema.js";
import { inspectConversationSync, syncConversations } from "./target/sync.js";
import { replaceConversations } from "./target/replace.js";
import { discoverT3CacheProfiles, formatCacheResetResult, resetT3RebuildableCache } from "./target/cache.js";

const sourceSchema = z.enum(["codex", "claude"]);
const program = new Command();

function collect(value: string, previous: string[]): string[] { return [...previous, value]; }
function globalOverrides(): TargetOverrides {
  const values = program.opts<{ t3Home?: string; db?: string; attachmentsDir?: string; providerInstance?: string }>();
  return { ...(values.t3Home ? { t3Home: values.t3Home } : {}), ...(values.db ? { dbPath: values.db } : {}), ...(values.attachmentsDir ? { attachmentsDir: values.attachmentsDir } : {}), ...(values.providerInstance ? { providerInstance: values.providerInstance } : {}) };
}
function isJson(): boolean { return Boolean(program.opts<{ json?: boolean }>().json); }
function shouldResetCache(): boolean { return program.opts<{ cacheReset?: boolean }>().cacheReset !== false; }
function print(value: unknown): void { console.log(isJson() ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2)); }
function parseSince(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw usageError(`Invalid ISO date: ${value}`);
  return parsed;
}
function sourceName(value: string): SourceName { return sourceSchema.parse(value); }

async function confirmImport(count: number): Promise<boolean> {
  const prompt = createInterface({ input, output });
  try { return /^(y|yes)$/iu.test((await prompt.question(`确认将 ${count} 个会话导入到 T3 中吗？[y/N] `)).trim()); }
  finally { prompt.close(); }
}

async function confirmSync(count: number): Promise<boolean> {
  const prompt = createInterface({ input, output });
  try { return /^(y|yes)$/iu.test((await prompt.question(`确认将 ${count} 个会话同步到 T3 中吗？[y/N] `)).trim()); }
  finally { prompt.close(); }
}

async function confirmReplace(count: number): Promise<boolean> {
  const prompt = createInterface({ input, output });
  try { return /^(y|yes)$/iu.test((await prompt.question(`确认替换 ${count} 个 T3 任务吗？旧任务将被软删除标记。[y/N] `)).trim()); }
  finally { prompt.close(); }
}

async function confirmCacheReset(): Promise<boolean> {
  const prompt = createInterface({ input, output });
  try { return /^(y|yes)$/iu.test((await prompt.question("确认重置 T3 的 IndexedDB 缓存吗？操作前会自动创建经过验证的备份。[y/N] ")).trim()); }
  finally { prompt.close(); }
}

async function attachCacheReset<T extends ImportRunResult | SyncRunResult | ReplaceRunResult>(
  result: T,
  paths: ReturnType<typeof resolveTargetPaths>,
  changed: boolean,
): Promise<T> {
  if (!changed || !shouldResetCache()) return result;
  try {
    result.cache = await resetT3RebuildableCache(paths);
    result.warnings.push(...result.cache.warnings);
  } catch (error) {
    result.warnings.push(`T3 数据已更新，但未能重置其 IndexedDB 缓存: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

program
  .name("t3-import")
  .description("将 Codex 和 Claude Code 的会话记录导入、同步并安全替换至 T3 Code 中（Erico：中文汉化）")
  .version(IMPORTER_VERSION)
  .option("--t3-home <path>", "T3 安装/数据根目录 (默认 ~/.t3)")
  .option("--db <path>", "T3 数据库文件路径 (默认 ~/.t3/userdata/statev2.sqlite)")
  .option("--attachments-dir <path>", "T3 附件存放目录")
  .option("--provider-instance <id>", "目标 T3 provider 实例 ID")
  .option("--json", "以 JSON 格式输出结果")
  .option("--no-color", "禁用彩色终端输出")
  .option("--no-cache-reset", "写入数据后保留 T3 现有的 IndexedDB 缓存")
  .action(async () => {
    const paths = resolveTargetPaths(globalOverrides());
    const provider = globalOverrides().providerInstance;
    const instance = render(React.createElement(ImportTui, { paths, resetCache: shouldResetCache(), ...(provider ? { initialProvider: provider } : {}) }));
    await instance.waitUntilExit();
  });

program.command("list")
  .description("列出源会话历史列表")
  .requiredOption("--source <source>", "数据源: codex 或 claude")
  .option("--project <name>", "按项目/文件夹筛选 (如: Campus项目)")
  .option("--workspace <path>", "筛选指定工作区路径")
  .option("--since <date>", "仅列出指定 ISO 日期之后的会话")
  .option("--include-archived", "包含已归档的会话")
  .action(async (options: { source: string; project?: string; workspace?: string; since?: string; includeArchived?: boolean }) => {
    const since = parseSince(options.since);
    const summaries = await sourceAdapter(sourceName(options.source)).discover({
      ...(options.project ? { project: options.project } : {}),
      ...(options.workspace ? { workspace: options.workspace } : {}),
      includeArchived: Boolean(options.includeArchived),
      ...(since ? { since } : {}),
    });
    if (isJson()) print({ schemaVersion: 1, conversations: summaries });
    else if (!summaries.length) print("未找到任何会话记录。");
    else print(summaries.map((item) => `${item.id}\t${item.updatedAt}\t${item.archived ? "[已归档]" : "[活跃]"}\t📁 ${item.projectName ?? "未分类"}\t${item.title}`).join("\n"));
  });

program.command("show")
  .description("展示单个会话的导入预览与详细指标")
  .requiredOption("--source <source>", "数据源: codex 或 claude")
  .requiredOption("--thread <id>", "会话 ID")
  .option("--workspace <path>", "工作区路径")
  .option("--include-incomplete", "包含未完成的轮次")
  .action(async (options: { source: string; thread: string; workspace?: string; includeIncomplete?: boolean }) => {
    const adapter = sourceAdapter(sourceName(options.source));
    const summaries = await adapter.discover(options.workspace ? { workspace: options.workspace } : {});
    const summary = summaries.find((item) => item.id === options.thread);
    if (!summary) throw usageError(`Conversation not found: ${options.thread}`);
    const conversation = await adapter.load(summary, { ...(options.includeIncomplete !== undefined ? { includeIncomplete: options.includeIncomplete } : {}) });
    print({ schemaVersion: 1, source: conversation.summary, fingerprint: conversation.fingerprint, tasks: conversation.threads.map((thread) => ({ sourceKey: thread.sourceKey, title: thread.title, currentBranch: thread.currentBranch, resumable: Boolean(thread.resumeCursor), turns: thread.turns.length, messages: thread.turns.reduce((sum, turn) => sum + 1 + turn.assistant.length, 0), activities: thread.turns.reduce((sum, turn) => sum + turn.activities.length, 0), plans: thread.turns.reduce((sum, turn) => sum + turn.plans.length, 0), attachments: thread.turns.reduce((sum, turn) => sum + turn.user.attachments.length, 0), warnings: thread.warnings })) });
  });

program.command("doctor")
  .description("检查源数据与 T3 数据库就绪状态（只读无侵入）")
  .action(async () => {
    const paths = resolveTargetPaths(globalOverrides());
    const runtime = await inspectRuntime(paths);
    let database: Record<string, unknown> = { exists: existsSync(paths.dbPath) };
    if (existsSync(paths.dbPath)) {
      const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
      try { database = { exists: true, ...validateTargetDatabase(db) }; }
      catch (error) { database = { exists: true, compatible: false, error: error instanceof Error ? error.message : String(error) }; }
      finally { db.close(); }
    }
    const staging = existsSync(paths.attachmentsDir) ? readdirSync(paths.attachmentsDir).filter((name) => name.startsWith(".t3-import-staging-")) : [];
    const sources: Record<string, unknown> = {};
    for (const name of ["codex", "claude"] as const) {
      try { const items = await sourceAdapter(name).discover({}); sources[name] = { available: true, conversations: items.length, workspaces: new Set(items.map((item) => item.workspace)).size }; }
      catch (error) { sources[name] = { available: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    print({ schemaVersion: 1, target: paths, runtime, database, sources, indexedDbCaches: discoverT3CacheProfiles(), stagingDirectories: staging });
  });

const cacheCommand = program.command("cache").description("检查或重置 T3 的可重建 IndexedDB 缓存");
cacheCommand.command("reset")
  .description("备份并重置最近使用的 T3 IndexedDB 缓存")
  .option("--yes", "跳过交互式确认")
  .action(async (options: { yes?: boolean }) => {
    if (!options.yes) {
      if (!process.stdout.isTTY || isJson()) throw usageError("非交互模式重置缓存必须指定 --yes。");
      if (!await confirmCacheReset()) return;
    }
    const result = await resetT3RebuildableCache(resolveTargetPaths(globalOverrides()));
    print(isJson() ? { schemaVersion: 1, ...result } : formatCacheResetResult(result));
  });

program.command("import")
  .description("导入选定的会话记录")
  .addOption(new Option("--source <source>", "数据源: codex 或 claude"))
  .option("--project <name>", "按项目/文件夹名称导入 (例如: Campus项目)")
  .option("--workspace <path>", "工作区路径")
  .option("--thread <id>", "会话 ID (可多次指定)", collect, [])
  .option("--all", "选择匹配的所有会话")
  .option("--include-archived", "包含已归档的会话")
  .option("--since <date>", "仅导入指定 ISO 日期之后的记录")
  .option("--include-incomplete", "包含未完成的轮次")
  .option("--dry-run", "预演运行，不写入数据库")
  .option("--yes", "自动确认执行")
  .option("--non-interactive", "以非交互模式运行")
  .option("--no-resume", "不创建续聊会话绑定")
  .option("--no-project", "作为独立对话导入 (无项目 / No project)")
  .option("--target-project <nameOrId>", "导入到指定的已存在 T3 项目 (名称或 ID)")
  .action(async (options: {
    source?: string;
    project?: string;
    workspace?: string;
    thread: string[];
    all?: boolean;
    includeArchived?: boolean;
    since?: string;
    includeIncomplete?: boolean;
    dryRun?: boolean;
    yes?: boolean;
    nonInteractive?: boolean;
    resume: boolean;
    noProject?: boolean;
    targetProject?: string;
  }) => {
    if (!options.source || (!options.workspace && !options.project) || (!options.all && options.thread.length === 0)) {
      if (process.stdout.isTTY && !options.nonInteractive && !isJson()) {
        const paths = resolveTargetPaths(globalOverrides());
        const source = options.source ? sourceName(options.source) : undefined;
        const provider = globalOverrides().providerInstance;
        const instance = render(React.createElement(ImportTui, {
          paths,
          ...(source ? { initialSource: source } : {}),
          ...(options.workspace ? { initialWorkspace: options.workspace } : {}),
          ...(provider ? { initialProvider: provider } : {}),
          resetCache: shouldResetCache(),
        }));
        await instance.waitUntilExit();
        return;
      }
      throw usageError("非交互模式导入需要指定 --source、(--project 或 --workspace) 以及 --thread 或 --all。");
    }
    if (options.all && options.thread.length) throw usageError("--all 和 --thread 参数互斥。");
    if (!options.dryRun && !options.yes) {
      if (!process.stdout.isTTY || options.nonInteractive || isJson()) throw usageError("非交互模式导入需要指定 --yes。");
      if (!await confirmImport(options.all ? 1 : options.thread.length)) return;
    }
    const source = sourceName(options.source);
    const adapter = sourceAdapter(source);
    const since = parseSince(options.since);
    const summaries = await adapter.discover({
      ...(options.project ? { project: options.project } : {}),
      ...(options.workspace ? { workspace: options.workspace } : {}),
      includeArchived: Boolean(options.includeArchived),
      ...(since ? { since } : {}),
      ...(options.includeIncomplete !== undefined ? { includeIncomplete: options.includeIncomplete } : {}),
    });
    const selected: SourceSummary[] = options.all ? summaries : options.thread.map((id) => {
      const summary = summaries.find((item) => item.id === id);
      if (!summary) throw usageError(`未找到指定会话: ${id}`);
      return summary;
    });
    const loaded = await Promise.all(selected.map(async (summary) => ({ conversation: await adapter.load(summary, { workspace: summary.workspace, ...(since ? { since } : {}), ...(options.includeIncomplete !== undefined ? { includeIncomplete: options.includeIncomplete } : {}) }), resume: options.resume })));
    const paths = resolveTargetPaths(globalOverrides());
    let targetProjectId: string | undefined;
    if (options.targetProject) {
      const activeProjects = listActiveT3Projects(paths);
      const match = activeProjects.find((p) => p.id === options.targetProject || p.title.toLowerCase() === options.targetProject!.toLowerCase());
      if (match) {
        targetProjectId = match.id;
      } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.targetProject)) {
        targetProjectId = options.targetProject;
      } else {
        throw usageError(`未找到指定的 T3 目标项目: ${options.targetProject}。当前可用项目: ${activeProjects.map((p) => p.title).join(", ") || "无"}`);
      }
    }
    const result: ImportRunResult = await importConversations(loaded, paths, {
      ...globalOverrides(),
      dryRun: Boolean(options.dryRun),
      resume: options.resume,
      noProject: Boolean(options.noProject),
      targetProjectId,
    });
    await attachCacheReset(result, paths, result.results.some((item) => item.status === "imported"));
    print(result);
  });

program.command("replace")
  .description("使用完整的 Provider 会话内容替换旧的 T3 任务")
  .addOption(new Option("--source <source>", "数据源: codex 或 claude"))
  .option("--workspace <path>", "工作区路径")
  .option("--thread <id>", "会话 ID (可多次指定)", collect, [])
  .option("--dry-run", "预演运行")
  .option("--yes", "自动确认")
  .option("--non-interactive", "非交互模式")
  .action(async (options: { source?: string; workspace?: string; thread: string[]; dryRun?: boolean; yes?: boolean; nonInteractive?: boolean }) => {
    if (!options.source || !options.workspace || options.thread.length === 0) {
      if (process.stdout.isTTY && !options.nonInteractive && !isJson()) {
        const paths = resolveTargetPaths(globalOverrides());
        const source = options.source ? sourceName(options.source) : undefined;
        const instance = render(React.createElement(ImportTui, {
          paths, mode: "replace",
          ...(source ? { initialSource: source } : {}),
          ...(options.workspace ? { initialWorkspace: options.workspace } : {}),
          resetCache: shouldResetCache(),
        }));
        await instance.waitUntilExit();
        return;
      }
      throw usageError("Non-interactive replacement requires --source, --workspace, and --thread.");
    }
    if (!options.yes && (!process.stdout.isTTY || options.nonInteractive || isJson())) throw usageError("Non-interactive replacement requires --yes.");
    if (!options.dryRun && !options.yes && !await confirmReplace(options.thread.length)) return;
    const source = sourceName(options.source);
    const adapter = sourceAdapter(source);
    const summaries = await adapter.discover({ workspace: options.workspace });
    const selected = [...new Set(options.thread)].map((id) => {
      const summary = summaries.find((item) => item.id === id);
      if (!summary) throw usageError(`Conversation not found in workspace: ${id}`);
      return summary;
    });
    const loaded = await Promise.all(selected.map(async (summary) => ({ conversation: await adapter.load(summary, { workspace: options.workspace! }) })));
    const paths = resolveTargetPaths(globalOverrides());
    const result = await replaceConversations(loaded, paths, { ...globalOverrides(), dryRun: Boolean(options.dryRun) });
    await attachCacheReset(result, paths, result.results.some((item) => item.status === "replaced"));
    print(result);
    if (result.hasConflicts) process.exitCode = 7;
  });

program.command("sync")
  .description("将新完成、中断或失败的轮次追加同步到之前已导入的会话中")
  .addOption(new Option("--source <source>", "数据源: codex 或 claude"))
  .option("--workspace <path>", "工作区路径")
  .option("--thread <id>", "会话 ID (可多次指定)", collect, [])
  .option("--all", "同步之前已导入的所有匹配会话")
  .option("--since <date>", "仅同步指定 ISO 日期之后的轮次")
  .option("--dry-run", "预演运行")
  .option("--yes", "自动确认")
  .option("--non-interactive")
  .action(async (options: { source?: string; workspace?: string; thread: string[]; all?: boolean; since?: string; dryRun?: boolean; yes?: boolean; nonInteractive?: boolean }) => {
    if (!options.source || !options.workspace || (!options.all && options.thread.length === 0)) {
      if (process.stdout.isTTY && !options.nonInteractive && !isJson()) {
        const paths = resolveTargetPaths(globalOverrides());
        const source = options.source ? sourceName(options.source) : undefined;
        const provider = globalOverrides().providerInstance;
        const instance = render(React.createElement(ImportTui, {
          paths, mode: "sync",
          ...(source ? { initialSource: source } : {}),
          ...(options.workspace ? { initialWorkspace: options.workspace } : {}),
          ...(provider ? { initialProvider: provider } : {}),
          resetCache: shouldResetCache(),
        }));
        await instance.waitUntilExit();
        return;
      }
      throw usageError("Non-interactive sync requires --source, --workspace, and either --thread or --all.");
    }
    if (options.all && options.thread.length) throw usageError("--all and --thread are mutually exclusive.");
    if (!options.yes && (!process.stdout.isTTY || options.nonInteractive || isJson())) {
      throw usageError("Non-interactive synchronization requires --yes.");
    }
    if (!options.dryRun && !options.yes) {
      if (!await confirmSync(options.all ? 1 : options.thread.length)) return;
    }
    const source = sourceName(options.source);
    const adapter = sourceAdapter(source);
    const since = parseSince(options.since);
    const summaries = await adapter.discover({ workspace: options.workspace, ...(since ? { since } : {}) });
    const selected = options.all ? summaries : options.thread.map((id) => {
      const summary = summaries.find((item) => item.id === id);
      if (!summary) throw usageError(`Conversation not found in workspace: ${id}`);
      return summary;
    });
    const paths = resolveTargetPaths(globalOverrides());
    const loaded = await Promise.all(selected.map(async (summary) => ({ conversation: await adapter.load(summary, { workspace: options.workspace! }) })));
    const eligible = options.all
      ? (await Promise.all(loaded.map(async (selection) => ({ selection, preview: await inspectConversationSync(selection.conversation, paths) })))).filter((item) => item.preview.previouslyImported).map((item) => item.selection)
      : loaded;
    const result = await syncConversations(eligible, paths, { ...globalOverrides(), dryRun: Boolean(options.dryRun) });
    await attachCacheReset(result, paths, result.results.some((item) => item.status === "synced"));
    print(result);
    if (result.hasConflicts) process.exitCode = 7;
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (isJson()) console.log(JSON.stringify({ schemaVersion: 1, status: "error", error: error instanceof Error ? error.message : String(error) }));
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof ImporterError ? error.exitCode : error instanceof z.ZodError ? 2 : 6;
} finally {
  await disposeSourceAdapters();
}
