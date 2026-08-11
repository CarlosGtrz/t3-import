import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ImportRunResult, ImportSelection, SourceName, SourceSummary, TargetPaths } from "./core/types.js";
import { sourceAdapter } from "./sources/index.js";
import { inferCurrentWorkspace } from "./sources/codex.js";
import { importConversations } from "./target/importer.js";
import { listProviderInstances } from "./target/config.js";
import { inspectRuntime, type RuntimeState } from "./target/schema.js";

type Screen = "preflight" | "blocked" | "source" | "workspace" | "provider" | "threads" | "review" | "running" | "result" | "error";

interface TuiProps {
  paths: TargetPaths;
  initialSource?: SourceName;
  initialWorkspace?: string;
  initialProvider?: string;
}

function Help(): React.JSX.Element {
  return <Text dimColor>↑/↓ or j/k move  Space select  a all  / search  Enter continue  Esc back/quit  q quit  ? help</Text>;
}

function Menu({ items, index, selected }: { items: string[]; index: number; selected?: Set<number> }): React.JSX.Element {
  return <Box flexDirection="column">{items.map((item, itemIndex) => (
    <Text key={`${itemIndex}:${item}`} {...(itemIndex === index ? { color: "cyan" as const } : {})}>
      {itemIndex === index ? "›" : " "} {selected ? (selected.has(itemIndex) ? "◉" : "○") : ""} {item}
    </Text>
  ))}</Box>;
}

export function ImportTui({ paths, initialSource, initialWorkspace, initialProvider }: TuiProps): React.JSX.Element {
  const app = useApp();
  const [screen, setScreen] = useState<Screen>("preflight");
  const [runtime, setRuntime] = useState<RuntimeState>();
  const [source, setSource] = useState<SourceName>(initialSource ?? "codex");
  const [summaries, setSummaries] = useState<SourceSummary[]>([]);
  const [workspace, setWorkspace] = useState<string>();
  const [provider, setProvider] = useState<string | undefined>(initialProvider);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(new Set<string>());
  const [prepared, setPrepared] = useState<ImportSelection[]>([]);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [result, setResult] = useState<ImportRunResult>();
  const [error, setError] = useState<string>();

  const workspaces = useMemo(() => [...new Map(summaries.map((summary) => [summary.workspace.toLowerCase(), summary.workspace])).values()], [summaries]);
  const providers = useMemo(() => listProviderInstances(paths, source), [paths, source]);
  const visibleThreads = useMemo(() => summaries
    .filter((summary) => !workspace || summary.workspace.toLowerCase() === workspace.toLowerCase())
    .filter((summary) => !query || summary.title.toLowerCase().includes(query.toLowerCase()) || summary.id.includes(query)), [summaries, workspace, query]);
  const selectedVisible = useMemo(
    () => new Set(visibleThreads.flatMap((summary, itemIndex) => selected.has(summary.id) ? [itemIndex] : [])),
    [selected, visibleThreads],
  );
  const preview = useMemo(() => prepared.reduce((counts, selection) => {
    for (const thread of selection.conversation.threads) {
      counts.tasks += 1;
      counts.turns += thread.turns.length;
      counts.messages += thread.turns.reduce((sum, turn) => sum + 1 + turn.assistant.length, 0);
      counts.activities += thread.turns.reduce((sum, turn) => sum + turn.activities.length, 0) + (thread.currentBranch ? 0 : 1);
      counts.plans += thread.turns.reduce((sum, turn) => sum + turn.plans.length, 0);
      counts.attachments += thread.turns.reduce((sum, turn) => sum + turn.user.attachments.length, 0);
      if (thread.currentBranch && thread.resumeCursor) counts.resumable += 1;
    }
    return counts;
  }, { tasks: 0, turns: 0, messages: 0, activities: 0, plans: 0, attachments: 0, resumable: 0 }), [prepared]);

  const checkRuntime = useCallback(() => {
    setScreen("preflight");
    inspectRuntime(paths)
      .then((state) => {
        setRuntime(state);
        setScreen(state.live ? "blocked" : initialSource ? "workspace" : "source");
      })
      .catch((cause) => {
        setError(`Unable to check T3 runtime: ${cause instanceof Error ? cause.message : String(cause)}`);
        setScreen("error");
      });
  }, [initialSource, paths]);

  useEffect(() => { checkRuntime(); }, [checkRuntime]);

  useEffect(() => {
    if (screen !== "workspace") return;
    setIndex(0);
    sourceAdapter(source).discover({}).then((items) => {
      setSummaries(items);
      const selectedWorkspace = initialWorkspace
        ? items.find((item) => item.workspace.toLowerCase() === initialWorkspace.toLowerCase())?.workspace
        : inferCurrentWorkspace(items);
      if (selectedWorkspace) {
        setWorkspace(selectedWorkspace);
        setProvider(initialProvider ?? providers[0]);
        setScreen(initialProvider || providers.length <= 1 ? "threads" : "provider");
      }
    }).catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setScreen("error"); });
  }, [screen, source]);

  const move = (delta: number, length: number) => setIndex((current) => length === 0 ? 0 : (current + delta + length) % length);
  useInput((input, key) => {
    if (screen === "running") return;
    if (searching) {
      if (key.escape || key.return) setSearching(false);
      else if (key.backspace || key.delete) setQuery((value) => value.slice(0, -1));
      else if (!key.ctrl && !key.meta && input) setQuery((value) => value + input);
      return;
    }
    if (input === "q") { app.exit(); return; }
    if (screen === "blocked" && (input === "r" || key.return)) { checkRuntime(); return; }
    if (input === "?") { setShowHelp((value) => !value); return; }
    if (key.upArrow || input === "k") {
      move(-1, screen === "source" ? 2 : screen === "workspace" ? workspaces.length : screen === "provider" ? providers.length : visibleThreads.length);
      return;
    }
    if (key.downArrow || input === "j") {
      move(1, screen === "source" ? 2 : screen === "workspace" ? workspaces.length : screen === "provider" ? providers.length : visibleThreads.length);
      return;
    }
    if (key.escape) {
      if (screen === "source" || screen === "blocked") { app.exit(); return; }
      if (screen === "threads") {
        if (initialWorkspace && (initialProvider || providers.length <= 1)) { app.exit(); return; }
        setScreen(providers.length > 1 ? "provider" : "workspace");
      }
      else if (screen === "provider") {
        if (initialWorkspace) { app.exit(); return; }
        setScreen("workspace");
      }
      else if (screen === "workspace") {
        if (initialSource) { app.exit(); return; }
        setScreen("source");
      }
      else if (screen === "review") setScreen("threads");
      setIndex(0);
      return;
    }
    if (screen === "source" && key.return) {
      setSource(index === 0 ? "codex" : "claude"); setSelected(new Set()); setPrepared([]); setScreen("workspace"); setIndex(0); return;
    }
    if (screen === "workspace" && key.return && workspaces[index]) {
      setWorkspace(workspaces[index]); setProvider(initialProvider ?? providers[0]); setScreen(initialProvider || providers.length <= 1 ? "threads" : "provider"); setIndex(0); return;
    }
    if (screen === "provider" && key.return && providers[index]) {
      setProvider(providers[index]); setScreen("threads"); setIndex(0); return;
    }
    if (screen === "threads") {
      if (input === "/") { setSearching(true); return; }
      if (input === "a") {
        setSelected((value) => visibleThreads.every((summary) => value.has(summary.id))
          ? new Set([...value].filter((id) => !visibleThreads.some((summary) => summary.id === id)))
          : new Set([...value, ...visibleThreads.map((summary) => summary.id)]));
        return;
      }
      if (input === " " && visibleThreads[index]) {
        const id = visibleThreads[index]!.id;
        setSelected((value) => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); return next; }); return;
      }
      if (key.return && selected.size > 0) {
        const chosen = summaries.filter((summary) => selected.has(summary.id));
        setScreen("running");
        Promise.all(chosen.map(async (summary): Promise<ImportSelection> => ({ conversation: await sourceAdapter(source).load(summary, {}), duplicate: false, resume: true })))
          .then((loaded) => { setPrepared(loaded); setScreen("review"); setIndex(0); })
          .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setScreen("error"); });
        return;
      }
    }
    if (screen === "review" && key.return) {
      setScreen("running");
      importConversations(prepared, paths, { dryRun: false, duplicate: false, resume: true, ...(provider ? { providerInstance: provider } : {}) })
        .then((value) => { setResult(value); setScreen("result"); })
        .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setScreen("error"); });
    }
    if ((screen === "result" || screen === "error") && key.return) app.exit();
  });

  return <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">t3-import</Text>
    <Text dimColor>Target: {paths.dbPath}</Text>
    <Box marginTop={1} flexDirection="column">
      {screen === "preflight" && <Text>Checking whether T3 is running…</Text>}
      {screen === "blocked" && <>
        <Text bold color="red">T3 is running</Text>
        <Text>Close T3 before importing{runtime?.pid ? ` (detected PID ${runtime.pid})` : ""}.</Text>
        {runtime?.origin ? <Text dimColor>Runtime: {runtime.origin}</Text> : null}
        <Text>Press r or Enter to check again, or q to quit.</Text>
      </>}
      {screen === "source" && <><Text bold>Choose a source</Text><Menu items={["Codex", "Claude Code"]} index={index} /></>}
      {screen === "workspace" && <><Text bold>Choose a workspace</Text>{summaries.length === 0 ? <Text>Discovering {source} conversations…</Text> : <Menu items={workspaces} index={index} />}</>}
      {screen === "provider" && <><Text bold>Choose a T3 provider instance</Text><Menu items={providers} index={index} /></>}
      {screen === "threads" && <>
        <Text bold>Select conversations — {workspace}</Text>
        {searching || query ? <Text color="yellow">Search: {query}<Text dimColor>_</Text></Text> : null}
        <Menu items={visibleThreads.map((item) => `${item.title}  ${new Date(item.updatedAt).toLocaleDateString()}  ${item.branches > 1 ? `${item.branches} branches` : item.status}`)} index={index} selected={selectedVisible} />
        {visibleThreads.length === 0 && <Text color="yellow">No matching conversations.</Text>}
      </>}
      {screen === "review" && <>
        <Text bold>Review import</Text>
        <Text>Source: {source} · Workspace: {workspace}</Text>
        <Text>Conversations: {prepared.length} · T3 tasks: {preview.tasks} · branches: {preview.tasks}</Text>
        <Text>Turns: {preview.turns} · messages: {preview.messages} · activities: {preview.activities}</Text>
        <Text>Plans: {preview.plans} · attachments: {preview.attachments} · resumable: {preview.resumable}</Text>
        <Text>Provider: {provider}</Text>
        <Text color="yellow">T3 must remain closed. A verified backup will be created.</Text>
        <Text bold>Press Enter to import, Escape to go back.</Text>
      </>}
      {screen === "running" && <Text>{prepared.length === 0 ? "Preparing import preview…" : "Backing up and importing…"}</Text>}
      {screen === "result" && result && <>
        <Text bold color="green">Import complete: {result.status}</Text>
        <Text>Backup: {result.backup ?? "not needed"}</Text>
        {result.results.map((item) => <Text key={item.threadId}>{item.status === "imported" ? "✓" : "•"} {item.title} — {item.turns} turns, {item.messages} messages, {item.activities} activities{item.resumable ? ", resumable" : ""}</Text>)}
        <Text dimColor>Open T3 to rebuild projections. Press Enter to exit.</Text>
      </>}
      {screen === "error" && <><Text bold color="red">Import failed</Text><Text>{error}</Text><Text dimColor>Press Enter to exit.</Text></>}
    </Box>
    {showHelp || !["preflight", "blocked", "running", "result", "error"].includes(screen) ? <Box marginTop={1}><Help /></Box> : null}
  </Box>;
}
