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
import type { ImportRunResult, SourceName, SourceSummary } from "./core/types.js";
import { disposeSourceAdapters, sourceAdapter } from "./sources/index.js";
import { resolveTargetPaths, type TargetOverrides } from "./target/config.js";
import { IMPORTER_VERSION, importConversations } from "./target/importer.js";
import { inspectRuntime, validateTargetDatabase } from "./target/schema.js";
import { inspectConversationSync, syncConversations } from "./target/sync.js";

const sourceSchema = z.enum(["codex", "claude"]);
const program = new Command();

function collect(value: string, previous: string[]): string[] { return [...previous, value]; }
function globalOverrides(): TargetOverrides {
  const values = program.opts<{ t3Home?: string; db?: string; attachmentsDir?: string; providerInstance?: string }>();
  return { ...(values.t3Home ? { t3Home: values.t3Home } : {}), ...(values.db ? { dbPath: values.db } : {}), ...(values.attachmentsDir ? { attachmentsDir: values.attachmentsDir } : {}), ...(values.providerInstance ? { providerInstance: values.providerInstance } : {}) };
}
function isJson(): boolean { return Boolean(program.opts<{ json?: boolean }>().json); }
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
  try { return /^(y|yes)$/iu.test((await prompt.question(`Import ${count} conversation${count === 1 ? "" : "s"} into T3? [y/N] `)).trim()); }
  finally { prompt.close(); }
}

async function confirmSync(count: number): Promise<boolean> {
  const prompt = createInterface({ input, output });
  try { return /^(y|yes)$/iu.test((await prompt.question(`Synchronize ${count} conversation${count === 1 ? "" : "s"} with T3? [y/N] `)).trim()); }
  finally { prompt.close(); }
}

program
  .name("t3-import")
  .description("Import and incrementally sync Codex and Claude Code conversations into T3 Code")
  .version(IMPORTER_VERSION)
  .option("--t3-home <path>", "T3 home directory")
  .option("--db <path>", "T3 state.sqlite path")
  .option("--attachments-dir <path>", "T3 attachments directory")
  .option("--provider-instance <id>", "T3 provider instance")
  .option("--json", "write machine-readable JSON to stdout")
  .option("--no-color", "disable color output")
  .action(async () => {
    const paths = resolveTargetPaths(globalOverrides());
    const provider = globalOverrides().providerInstance;
    const instance = render(React.createElement(ImportTui, { paths, ...(provider ? { initialProvider: provider } : {}) }));
    await instance.waitUntilExit();
  });

program.command("list")
  .description("List source conversations")
  .requiredOption("--source <source>", "codex or claude")
  .option("--workspace <path>")
  .option("--since <date>", "ISO date/time")
  .action(async (options: { source: string; workspace?: string; since?: string }) => {
    const since = parseSince(options.since);
    const summaries = await sourceAdapter(sourceName(options.source)).discover({ ...(options.workspace ? { workspace: options.workspace } : {}), ...(since ? { since } : {}) });
    if (isJson()) print({ schemaVersion: 1, conversations: summaries });
    else if (!summaries.length) print("No conversations found.");
    else print(summaries.map((item) => `${item.id}\t${item.updatedAt}\t${item.branches}\t${item.workspace}\t${item.title}`).join("\n"));
  });

program.command("show")
  .description("Show an import preview")
  .requiredOption("--source <source>", "codex or claude")
  .requiredOption("--thread <id>")
  .option("--workspace <path>")
  .option("--include-incomplete")
  .action(async (options: { source: string; thread: string; workspace?: string; includeIncomplete?: boolean }) => {
    const adapter = sourceAdapter(sourceName(options.source));
    const summaries = await adapter.discover(options.workspace ? { workspace: options.workspace } : {});
    const summary = summaries.find((item) => item.id === options.thread);
    if (!summary) throw usageError(`Conversation not found: ${options.thread}`);
    const conversation = await adapter.load(summary, { ...(options.includeIncomplete !== undefined ? { includeIncomplete: options.includeIncomplete } : {}) });
    print({ schemaVersion: 1, source: conversation.summary, fingerprint: conversation.fingerprint, tasks: conversation.threads.map((thread) => ({ sourceKey: thread.sourceKey, title: thread.title, currentBranch: thread.currentBranch, resumable: Boolean(thread.resumeCursor), turns: thread.turns.length, messages: thread.turns.reduce((sum, turn) => sum + 1 + turn.assistant.length, 0), activities: thread.turns.reduce((sum, turn) => sum + turn.activities.length, 0), plans: thread.turns.reduce((sum, turn) => sum + turn.plans.length, 0), attachments: thread.turns.reduce((sum, turn) => sum + turn.user.attachments.length, 0), warnings: thread.warnings })) });
  });

program.command("doctor")
  .description("Check source and T3 readiness without changing anything")
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
    print({ schemaVersion: 1, target: paths, runtime, database, sources, stagingDirectories: staging });
  });

program.command("import")
  .description("Import selected conversations")
  .addOption(new Option("--source <source>", "codex or claude"))
  .option("--workspace <path>")
  .option("--thread <id>", "source conversation id (repeatable)", collect, [])
  .option("--all", "select every matching conversation")
  .option("--since <date>", "ISO date/time")
  .option("--include-incomplete")
  .option("--dry-run")
  .option("--yes")
  .option("--non-interactive")
  .option("--no-resume")
  .option("--duplicate", "create transcript-only copies")
  .action(async (options: { source?: string; workspace?: string; thread: string[]; all?: boolean; since?: string; includeIncomplete?: boolean; dryRun?: boolean; yes?: boolean; nonInteractive?: boolean; resume: boolean; duplicate?: boolean }) => {
    if (!options.source || !options.workspace || (!options.all && options.thread.length === 0)) {
      if (process.stdout.isTTY && !options.nonInteractive && !isJson()) {
        const paths = resolveTargetPaths(globalOverrides());
        const source = options.source ? sourceName(options.source) : undefined;
        const provider = globalOverrides().providerInstance;
        const instance = render(React.createElement(ImportTui, {
          paths,
          ...(source ? { initialSource: source } : {}),
          ...(options.workspace ? { initialWorkspace: options.workspace } : {}),
          ...(provider ? { initialProvider: provider } : {}),
        }));
        await instance.waitUntilExit();
        return;
      }
      throw usageError("Non-interactive import requires --source, --workspace, and either --thread or --all.");
    }
    if (options.all && options.thread.length) throw usageError("--all and --thread are mutually exclusive.");
    if (!options.dryRun && !options.yes) {
      if (!process.stdout.isTTY || options.nonInteractive || isJson()) throw usageError("Non-interactive imports require --yes.");
      if (!await confirmImport(options.all ? 1 : options.thread.length)) return;
    }
    const source = sourceName(options.source);
    const adapter = sourceAdapter(source);
    const since = parseSince(options.since);
    const summaries = await adapter.discover({ workspace: options.workspace, ...(since ? { since } : {}), ...(options.includeIncomplete !== undefined ? { includeIncomplete: options.includeIncomplete } : {}) });
    const selected: SourceSummary[] = options.all ? summaries : options.thread.map((id) => {
      const summary = summaries.find((item) => item.id === id);
      if (!summary) throw usageError(`Conversation not found in workspace: ${id}`);
      return summary;
    });
    const loaded = await Promise.all(selected.map(async (summary) => ({ conversation: await adapter.load(summary, { workspace: options.workspace!, ...(since ? { since } : {}), ...(options.includeIncomplete !== undefined ? { includeIncomplete: options.includeIncomplete } : {}) }), duplicate: Boolean(options.duplicate), resume: options.resume && !options.duplicate })));
    const paths = resolveTargetPaths(globalOverrides());
    const result: ImportRunResult = await importConversations(loaded, paths, { ...globalOverrides(), dryRun: Boolean(options.dryRun), duplicate: Boolean(options.duplicate), resume: options.resume && !options.duplicate });
    print(result);
  });

program.command("sync")
  .description("Append new completed, interrupted, or failed turns to previously imported conversations")
  .addOption(new Option("--source <source>", "codex or claude"))
  .option("--workspace <path>")
  .option("--thread <id>", "source conversation id (repeatable)", collect, [])
  .option("--all", "synchronize every previously imported matching conversation")
  .option("--since <date>", "ISO date/time")
  .option("--dry-run")
  .option("--yes")
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
