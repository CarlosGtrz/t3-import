import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { basename } from "node:path";
import type {
  CanonicalConversation,
  ConversationReplacePreview,
  ConversationSyncPreview,
  ImportRunResult,
  ImportSelection,
  ReplaceRunResult,
  ReplaceSelection,
  SourceName,
  SourceSummary,
  SyncRunResult,
  SyncSelection,
  TargetPaths,
} from "./core/types.js";
import { sourceAdapter } from "./sources/index.js";
import { inferCurrentWorkspace } from "./sources/codex.js";
import { compactThreadForImport, importConversations, listActiveT3Projects, type T3ProjectInfo } from "./target/importer.js";
import { fastCheckImportedSessionIds, inspectConversationSync, syncConversations } from "./target/sync.js";
import { listProviderInstances } from "./target/config.js";
import { inspectRuntime, type RuntimeState } from "./target/schema.js";
import { launchT3Code } from "./target/launch.js";
import { resetT3RebuildableCache } from "./target/cache.js";
import { inspectConversationReplacement, replaceConversations } from "./target/replace.js";

export type Screen = "preflight" | "blocked" | "source" | "workspace" | "target-project" | "provider" | "threads" | "review" | "running" | "result" | "launching" | "launch-error" | "error";

export function escapeDestination(screen: Screen, history: Screen[]): Screen | undefined {
  if (["source", "blocked", "result", "launch-error", "error"].includes(screen)) return undefined;
  return history.at(-1);
}

interface TuiProps {
  paths: TargetPaths;
  initialSource?: SourceName;
  initialWorkspace?: string;
  initialProvider?: string;
  mode?: "auto" | "sync" | "replace";
  resetCache?: boolean;
  maxEvents?: number;
  force?: boolean;
}

export function helpTextForScreen(screen: Screen, searching = false): string | undefined {
  if (searching) return "输入关键字搜索  Backspace 删除  Enter 确认  Esc 取消";
  if (screen === "threads") return "↑/↓ 或 j/k 移动  空格 选择/取消  a 全选  h 展开/折叠归档  / 搜索  v 切换显示模式  Enter 继续  Esc 返回  q 退出";
  if (screen === "workspace") return "↑/↓ 或 j/k 移动  Enter 选择  Tab 切换分组模式  Esc 返回/退出  q 退出";
  if (screen === "source" || screen === "provider" || screen === "target-project") return "↑/↓ 或 j/k 移动  Enter 选择  Esc 返回/退出  q 退出";
  if (screen === "review") return "Enter 确认执行  Esc 返回  q 退出";
  if (screen === "result") return "↑/↓ 或 j/k 移动  Enter 确认  q 退出";
  return undefined;
}

function Help({ screen, searching }: { screen: Screen; searching: boolean }): React.JSX.Element | null {
  const text = helpTextForScreen(screen, searching);
  return text ? <Text dimColor>{text}</Text> : null;
}

export function selectionMarker(isSelected: boolean, isDisabled: boolean): string {
  if (isDisabled) return "⊘";
  return isSelected ? "◉" : "○";
}

function Menu({ items, index, selected, disabled }: { items: string[]; index: number; selected?: Set<number>; disabled?: Set<number> }): React.JSX.Element {
  return <Box flexDirection="column">{items.map((item, itemIndex) => {
    const isDisabled = disabled?.has(itemIndex) ?? false;
    return <Text key={`${itemIndex}:${item}`} dimColor={isDisabled} {...(itemIndex === index && !isDisabled ? { color: "cyan" as const } : {})}>
      {itemIndex === index ? "›" : " "} {selected ? selectionMarker(selected.has(itemIndex), isDisabled) : ""} {item}
    </Text>;
  })}</Box>;
}

export function StartT3Prompt({ index }: { index: number }): React.JSX.Element {
  return <>
    <Text bold>现在启动 T3 Code 吗？</Text>
    <Menu items={["是 (Yes)", "否 (No)"]} index={index} />
    <Text dimColor>按 Enter 键确认。</Text>
  </>;
}

export function ReplacementReview({
  workspace,
  selections,
  previews,
  counts,
  resetCache,
}: {
  workspace: string | undefined;
  selections: ReplaceSelection[];
  previews: Map<string, ConversationReplacePreview>;
  counts: { tasks: number; turns: number; events: number; attachments: number };
  resetCache: boolean;
}): React.JSX.Element {
  const taskWord = "个任务";
  return <>
    <Text bold>确认会话替换</Text>
    <Text>工作区：{workspace}</Text>
    <Box marginTop={1} flexDirection="column">
      {selections.map((selection) => {
        const preview = previews.get(selection.conversation.summary.id);
        return <Box key={`replacement-review:${selection.conversation.summary.id}`} flexDirection="column">
          <Text bold>{selection.conversation.summary.title}</Text>
          <Text>旧 T3 任务 ID：{preview?.oldThreadId}</Text>
          <Text>新 T3 任务 ID：{preview?.newThreadId}</Text>
        </Box>;
      })}
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text>新任务将包含：</Text>
      <Text>  {counts.turns} 轮对话 · {counts.events} 个事件 · {counts.attachments} 个附件</Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text>Provider 模型与续聊连接将迁移至新任务。</Text>
      <Text>旧任务将从 T3 界面隐藏，但保留在事件审计记录中。</Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text>确认后，t3-import 将自动执行：</Text>
      <Text>  • 创建已校验的 T3 数据库安全备份</Text>
      <Text>  {resetCache ? "• 备份并重置 T3 UI 缓存" : "• 保留 T3 现有 UI 缓存 (--no-cache-reset)"}</Text>
    </Box>
    <Text color="yellow">【注意】T3 Code 必须保持关闭状态。</Text>
    <Text bold>按 Enter 确认替换，按 Esc 取消。</Text>
  </>;
}

export function conversationStatusText(preview: ConversationSyncPreview | undefined, checking: boolean): string {
  if (!preview) return checking ? "检测中…" : "不可用";
  if (preview.status === "new") return "新会话";
  if (preview.status === "active-only") return "仅有进行中轮次";
  if (preview.status === "syncable") {
    const added = `${preview.newTurns} 个新轮次`;
    const statuses: string[] = [];
    if (preview.newInterruptedTurns) statuses.push(preview.newTurns === 1 ? "已中断" : `${preview.newInterruptedTurns} 个中断`);
    if (preview.newFailedTurns) statuses.push(preview.newTurns === 1 ? "失败" : `${preview.newFailedTurns} 个失败`);
    const detail = statuses.length ? ` · ${statuses.join(", ")}` : "";
    return preview.adoptedTurns ? `${added}${detail}，已采纳 ${preview.adoptedTurns}` : `${added}${detail}`;
  }
  if (preview.status === "up-to-date") return `已是最新${preview.ignoredActiveTurns ? ` · 忽略 ${preview.ignoredActiveTurns} 个进行中轮次` : ""}`;
  if (preview.status === "history-diverged") return "历史已变更";
  if (preview.status === "branch-sync-unsupported") return "不支持分支同步";
  return "目标丢失";
}

export function replacementStatusText(preview: ConversationReplacePreview | undefined, checking: boolean): string {
  if (!preview) return checking ? "检测中…" : "不可用";
  if (preview.status === "replaceable") return "可替换";
  if (preview.status === "already-current") return "已是最新版本";
  if (preview.status === "active-source") return "源处于活跃中";
  if (preview.status === "branch-replace-unsupported") return "不支持分支替换";
  if (preview.status === "not-imported") return "尚未导入";
  return "目标丢失";
}

export function ImportTui({ paths, initialSource, initialWorkspace, initialProvider, mode = "auto", resetCache = false, maxEvents, force }: TuiProps): React.JSX.Element {
  const app = useApp();
  const [screen, setScreen] = useState<Screen>("preflight");
  const [screenHistory, setScreenHistory] = useState<Screen[]>([]);
  const [runtime, setRuntime] = useState<RuntimeState>();
  const [source, setSource] = useState<SourceName>(initialSource ?? "codex");
  const [summaries, setSummaries] = useState<SourceSummary[]>([]);
  const [workspace, setWorkspace] = useState<string>();
  const [selectedProject, setSelectedProject] = useState<string>();
  const [groupByProject, setGroupByProject] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [displayMode, setDisplayMode] = useState<"name" | "detail" | "path">("name");
  const [provider, setProvider] = useState<string | undefined>(initialProvider);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(new Set<string>());
  const [conversations, setConversations] = useState(new Map<string, CanonicalConversation>());
  const [syncPreviews, setSyncPreviews] = useState(new Map<string, ConversationSyncPreview>());
  const [replacePreviews, setReplacePreviews] = useState(new Map<string, ConversationReplacePreview>());
  const [pendingStatuses, setPendingStatuses] = useState(0);
  const [preparedImports, setPreparedImports] = useState<ImportSelection[]>([]);
  const [preparedSync, setPreparedSync] = useState<SyncSelection[]>([]);
  const [preparedReplacements, setPreparedReplacements] = useState<ReplaceSelection[]>([]);
  const [t3Projects, setT3Projects] = useState<T3ProjectInfo[]>([]);
  const [targetProjectChoice, setTargetProjectChoice] = useState<{ mode: "auto" | "no-project" | "existing"; projectId?: string; projectTitle?: string }>({ mode: "auto" });
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ImportRunResult>();
  const [syncResult, setSyncResult] = useState<SyncRunResult>();
  const [replaceResult, setReplaceResult] = useState<ReplaceRunResult>();
  const [error, setError] = useState<string>();
  const [launchError, setLaunchError] = useState<string>();
  const [cacheWarning, setCacheWarning] = useState<string>();
  const checkingStatuses = pendingStatuses > 0;

  const navigate = useCallback((next: Screen) => {
    setScreenHistory((history) => [...history, screen]);
    setScreen(next);
    setIndex(0);
  }, [screen]);

  interface GroupOption {
    key: string;
    name: string;
    workspace: string;
    isProject: boolean;
    label: string;
  }

  const groups = useMemo<GroupOption[]>(() => {
    if (source === "codex" && groupByProject) {
      const byProject = new Map<string, { active: number; archived: number; workspace: string }>();
      for (const summary of summaries) {
        const proj = summary.projectName || "未分类会话";
        if (!byProject.has(proj)) {
          byProject.set(proj, { active: 0, archived: 0, workspace: summary.workspace });
        }
        const stat = byProject.get(proj)!;
        if (summary.archived) stat.archived += 1;
        else stat.active += 1;
      }
      const list: GroupOption[] = [];
      for (const [name, stat] of byProject.entries()) {
        const total = stat.active + stat.archived;
        const archivedNote = stat.archived > 0 ? ` · ${stat.active} 活跃, ${stat.archived} 归档` : "";
        list.push({
          key: `proj:${name}`,
          name,
          workspace: stat.workspace,
          isProject: true,
          label: `${name === "未分类会话" ? "📂" : "📁"} ${name} (${total} 个会话${archivedNote})`,
        });
      }
      list.sort((a, b) => {
        if (a.name === "未分类会话") return 1;
        if (b.name === "未分类会话") return -1;
        return a.name.localeCompare(b.name, "zh");
      });
      return list;
    }
    const byWorkspace = new Map<string, { count: number; workspace: string }>();
    for (const summary of summaries) {
      const key = summary.workspace.toLowerCase();
      if (!byWorkspace.has(key)) byWorkspace.set(key, { count: 0, workspace: summary.workspace });
      byWorkspace.get(key)!.count += 1;
    }
    return [...byWorkspace.values()].map((item) => ({
      key: `ws:${item.workspace}`,
      name: item.workspace,
      workspace: item.workspace,
      isProject: false,
      label: `📂 ${item.workspace} (${item.count} 个会话)`,
    }));
  }, [groupByProject, source, summaries]);

  const workspaces = useMemo(() => groups.map((g) => g.label), [groups]);
  const providers = useMemo(() => listProviderInstances(paths, source), [paths, source]);

  const currentGroupThreads = useMemo(() => {
    return summaries.filter((summary) => {
      if (selectedProject) return summary.projectName === selectedProject;
      return !workspace || summary.workspace.toLowerCase() === workspace.toLowerCase();
    });
  }, [selectedProject, summaries, workspace]);

  const currentGroupArchivedCount = useMemo(() => {
    return currentGroupThreads.filter((t) => t.archived).length;
  }, [currentGroupThreads]);

  const visibleThreads = useMemo(() => currentGroupThreads
    .filter((summary) => showArchived || !summary.archived)
    .filter((summary) => mode !== "replace" || !replacePreviews.has(summary.id) || replacePreviews.get(summary.id)?.previouslyImported)
    .filter((summary) => !query || summary.title.toLowerCase().includes(query.toLowerCase()) || summary.id.includes(query)),
    [currentGroupThreads, mode, query, replacePreviews, showArchived]);
  const operationFor = useCallback((summary: SourceSummary): "replace" | "regular" | undefined => {
    const preview = syncPreviews.get(summary.id);
    const replacement = replacePreviews.get(summary.id);
    if (mode === "replace") return replacement?.selectable ? "replace" : undefined;
    if (mode === "sync") return preview?.status === "syncable" ? "regular" : undefined;
    if (replacement?.selectable && preview?.status === "history-diverged") return "replace";
    if (preview) return preview.selectable ? "regular" : undefined;
    if (mode === "auto") return "regular";
    return undefined;
  }, [mode, replacePreviews, syncPreviews]);
  const canSelect = useCallback((summary: SourceSummary) => {
    const operation = operationFor(summary);
    if (!operation) return false;
    const selectedOperation = [...selected].map((id) => summaries.find((item) => item.id === id)).filter((item): item is SourceSummary => Boolean(item)).map(operationFor).find(Boolean);
    return !selectedOperation || selectedOperation === operation;
  }, [operationFor, selected, summaries]);
  const selectedVisible = useMemo(
    () => new Set(visibleThreads.flatMap((summary, itemIndex) => selected.has(summary.id) ? [itemIndex] : [])),
    [selected, visibleThreads],
  );
  const disabledVisible = useMemo(
    () => new Set(visibleThreads.flatMap((summary, itemIndex) => canSelect(summary) ? [] : [itemIndex])),
    [canSelect, visibleThreads],
  );
  const importPreview = useMemo(() => preparedImports.reduce((counts, selection) => {
    for (const sourceThread of selection.conversation.threads) {
      const thread = compactThreadForImport(sourceThread);
      counts.tasks += 1;
      counts.turns += thread.turns.length;
      counts.messages += thread.turns.reduce((sum, turn) => sum + 1 + turn.assistant.length, 0);
      counts.activities += thread.turns.reduce((sum, turn) => sum + turn.activities.length, 0) + (thread.currentBranch ? 0 : 1);
      counts.attachments += thread.turns.reduce((sum, turn) => sum + turn.user.attachments.length, 0);
    }
    return counts;
  }, { tasks: 0, turns: 0, messages: 0, activities: 0, attachments: 0 }), [preparedImports]);
  const syncPreview = useMemo(() => preparedSync.reduce((counts, selection) => {
    const preview = syncPreviews.get(selection.conversation.summary.id);
    counts.tasks += 1;
    counts.turns += preview?.newTurns ?? 0;
    counts.adopted += preview?.adoptedTurns ?? 0;
    counts.titles += preview?.titleChanged ? 1 : 0;
    return counts;
  }, { tasks: 0, turns: 0, adopted: 0, titles: 0 }), [preparedSync, syncPreviews]);
  const replacementPreview = useMemo(() => preparedReplacements.reduce((counts, selection) => {
    const preview = replacePreviews.get(selection.conversation.summary.id);
    counts.tasks += 1;
    counts.turns += preview?.turns ?? 0;
    counts.events += preview?.events ?? 0;
    counts.attachments += preview?.attachments ?? 0;
    return counts;
  }, { tasks: 0, turns: 0, events: 0, attachments: 0 }), [preparedReplacements, replacePreviews]);

  const checkRuntime = useCallback(() => {
    setScreenHistory([]);
    setScreen("preflight");
    inspectRuntime(paths)
      .then((state) => {
        setRuntime(state);
        setScreen(state.live ? "blocked" : (initialWorkspace ? "threads" : initialSource ? "workspace" : "source"));
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
      if (initialWorkspace) {
        const selected = items.find((item) => item.workspace.toLowerCase() === initialWorkspace.toLowerCase())?.workspace;
        if (selected) {
          setWorkspace(selected);
          setProvider(initialProvider ?? providers[0]);
          setScreen("threads");
        }
      }
    }).catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setScreen("error"); });
  }, [screen, source]);

  const activeGroupKey = selectedProject ? `proj:${selectedProject}` : workspace ? `ws:${workspace}` : "";

  useEffect(() => {
    if (screen !== "threads" || !activeGroupKey) return;
    let cancelled = false;

    let importedSet = new Set<string>();
    try {
      importedSet = fastCheckImportedSessionIds(paths, source);
    } catch {}

    const items = summaries.filter((summary) => {
      if (selectedProject) return summary.projectName === selectedProject;
      return !workspace || summary.workspace.toLowerCase() === workspace.toLowerCase();
    });

    const initialPreviews = new Map<string, ConversationSyncPreview>();
    const queueToReconcile: SourceSummary[] = [];

    for (const item of items) {
      if (!importedSet.has(item.id)) {
        initialPreviews.set(item.id, {
          sourceId: item.id,
          status: "new",
          newTurns: 0,
          newCompletedTurns: 0,
          newInterruptedTurns: 0,
          newFailedTurns: 0,
          ignoredActiveTurns: 0,
          adoptedTurns: 0,
          titleChanged: false,
          selectable: true,
          previouslyImported: false,
          warnings: [],
        });
      } else {
        queueToReconcile.push(item);
      }
    }

    setSyncPreviews(initialPreviews);
    setPendingStatuses(queueToReconcile.length);
    setSelected(new Set());
    setConversations(new Map());
    setReplacePreviews(new Map());

    if (queueToReconcile.length === 0) return;

    const worker = async () => {
      while (!cancelled) {
        const summary = queueToReconcile.shift();
        if (!summary) return;
        try {
          const conversation = await sourceAdapter(source).load(summary, { workspace: summary.workspace });
          const preview = mode === "replace" ? undefined : await inspectConversationSync(conversation, paths);
          const replacement = mode === "replace" || preview?.status === "history-diverged"
            ? await inspectConversationReplacement(conversation, paths)
            : undefined;
          if (cancelled) return;
          setConversations((current) => new Map(current).set(summary.id, conversation));
          if (preview) setSyncPreviews((current) => new Map(current).set(summary.id, preview));
          if (replacement) setReplacePreviews((current) => new Map(current).set(summary.id, replacement));
        } catch {
        } finally {
          if (!cancelled) setPendingStatuses((count) => Math.max(0, count - 1));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(2, queueToReconcile.length) }, () => worker()));
    return () => { cancelled = true; };
  }, [activeGroupKey, mode, paths, screen, source]);

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
    const listLength = screen === "source" || screen === "result"
      ? 2
      : screen === "workspace"
      ? groups.length
      : screen === "provider"
      ? providers.length
      : screen === "target-project"
      ? 2 + t3Projects.length
      : visibleThreads.length;
    if (key.upArrow || input === "k") {
      move(-1, listLength);
      return;
    }
    if (key.downArrow || input === "j") {
      move(1, listLength);
      return;
    }
    if (key.escape) {
      const previous = escapeDestination(screen, screenHistory);
      if (!previous) { app.exit(); return; }
      if ((screen === "provider" || screen === "target-project") && previous === "threads") { setPreparedImports([]); setPreparedSync([]); setPreparedReplacements([]); }
      setScreenHistory((history) => history.slice(0, -1));
      setScreen(previous);
      setIndex(0);
      return;
    }
    if (screen === "source" && key.return) {
      setSource(index === 0 ? "codex" : "claude"); setSelected(new Set()); setPreparedImports([]); setPreparedSync([]); setPreparedReplacements([]); navigate("workspace"); return;
    }
    if (screen === "workspace") {
      if (key.tab || input === "t") {
        setGroupByProject((v) => !v);
        setIndex(0);
        return;
      }
      if (key.return && groups[index]) {
        const g = groups[index]!;
        if (g.isProject) {
          setSelectedProject(g.name);
          setWorkspace(g.workspace);
        } else {
          setSelectedProject(undefined);
          setWorkspace(g.workspace);
        }
        setProvider(initialProvider ?? providers[0]);
        setShowArchived(false);
        navigate("threads");
        return;
      }
    }
    if (screen === "target-project" && key.return) {
      if (index === 0) {
        setTargetProjectChoice({ mode: "auto" });
      } else if (index === 1) {
        setTargetProjectChoice({ mode: "no-project" });
      } else {
        const proj = t3Projects[index - 2];
        if (proj) {
          setTargetProjectChoice({ mode: "existing", projectId: proj.id, projectTitle: proj.title });
        }
      }
      navigate(!initialProvider && providers.length > 1 ? "provider" : "review");
      return;
    }
    if (screen === "provider" && key.return && providers[index]) {
      setProvider(providers[index]); navigate("review"); return;
    }
    if (screen === "threads") {
      if (input === "v") {
        setDisplayMode((v) => v === "name" ? "detail" : v === "detail" ? "path" : "name");
        return;
      }
      if (input === "h") {
        setShowArchived((v) => !v);
        return;
      }
      if (input === "/") { setSearching(true); return; }
      if (input === "a") {
        const currentOperation = visibleThreads[index] ? operationFor(visibleThreads[index]!) : undefined;
        const operation = currentOperation ?? visibleThreads.map(operationFor).find(Boolean);
        const selectable = visibleThreads.filter((summary) => canSelect(summary) && operationFor(summary) === operation);
        setSelected((value) => selectable.every((summary) => value.has(summary.id))
          ? new Set([...value].filter((id) => !selectable.some((summary) => summary.id === id)))
          : new Set([...value, ...selectable.map((summary) => summary.id)]));
        return;
      }
      if (input === " " && visibleThreads[index] && canSelect(visibleThreads[index]!)) {
        const id = visibleThreads[index]!.id;
        setSelected((value) => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); return next; }); return;
      }
      if (key.return && selected.size > 0) {
        const chosen = summaries.filter((summary) => selected.has(summary.id));
        setScreen("running");
        const prepareAndProceed = async () => {
          const loadedChosen: Array<{ summary: SourceSummary; conversation: CanonicalConversation }> = [];
          for (const summary of chosen) {
            let conv = conversations.get(summary.id);
            if (!conv) {
              conv = await sourceAdapter(source).load(summary, { workspace: summary.workspace });
              setConversations((current) => new Map(current).set(summary.id, conv!));
            }
            loadedChosen.push({ summary, conversation: conv });
          }
          const imports: ImportSelection[] = [];
          const syncs: SyncSelection[] = [];
          const replacements: ReplaceSelection[] = [];
          for (const { summary, conversation } of loadedChosen) {
            const preview = syncPreviews.get(summary.id);
            if (operationFor(summary) === "replace") replacements.push({ conversation });
            else if (preview?.status === "syncable") syncs.push({ conversation });
            else imports.push({ conversation, resume: true });
          }
          setPreparedImports(imports); setPreparedSync(syncs); setPreparedReplacements(replacements);
          if (imports.length > 0) {
            try {
              const activeProjects = listActiveT3Projects(paths).filter(
                (p) => p.title !== "No project" && p.title !== "无项目"
              );
              setT3Projects(activeProjects);
            } catch {
              setT3Projects([]);
            }
            navigate("target-project");
          } else {
            navigate("review");
          }
        };
        prepareAndProceed().catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setScreen("error");
        });
        return;
      }
    }
    if (screen === "review" && key.return) {
      setScreen("running");
      const run = async () => {
        const imported = preparedImports.length
          ? await importConversations(preparedImports, paths, {
              dryRun: false,
              resume: true,
              ...(provider ? { providerInstance: provider } : {}),
              noProject: targetProjectChoice.mode === "no-project",
              targetProjectId: targetProjectChoice.mode === "existing" ? targetProjectChoice.projectId : undefined,
              ...(maxEvents ? { maxEvents } : {}),
              ...(force ? { force } : {}),
            })
          : undefined;
        const synced = preparedSync.length
          ? await syncConversations(preparedSync, paths, {
              dryRun: false,
              allowProjectionBacklog: Boolean(imported?.results.some((item) => item.status === "imported")),
              ...(maxEvents ? { maxEvents } : {}),
              ...(force ? { force } : {}),
            })
          : undefined;
        const replaced = preparedReplacements.length
          ? await replaceConversations(preparedReplacements, paths, {
              dryRun: false,
              ...(maxEvents ? { maxEvents } : {}),
              ...(force ? { force } : {}),
            })
          : undefined;
        const changed = Boolean(imported?.results.some((item) => item.status === "imported")) || Boolean(synced?.results.some((item) => item.status === "synced")) || Boolean(replaced?.results.some((item) => item.status === "replaced"));
        if (resetCache && changed) {
          try {
            const cache = await resetT3RebuildableCache(paths);
            const holder = replaced ?? synced ?? imported;
            if (holder) {
              holder.cache = cache;
              holder.warnings.push(...cache.warnings);
            }
          } catch (cause) {
            setCacheWarning(`T3 data was updated, but its IndexedDB cache could not be reset: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }
        setResult(imported); setSyncResult(synced); setReplaceResult(replaced); setIndex(0); setScreen("result");
      };
      run().catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setScreen("error"); });
    }
    if (screen === "result" && key.return) {
      if (index === 1) { app.exit(); return; }
      setScreen("launching");
      launchT3Code().then(() => app.exit()).catch((cause) => {
        setLaunchError(cause instanceof Error ? cause.message : String(cause)); setScreen("launch-error");
      });
      return;
    }
    if ((screen === "launch-error" || screen === "error") && key.return) app.exit();
  });

  return <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">t3-import · T3 Code 对话导入工具 <Text dimColor>（Erico：中文汉化）</Text></Text>
    <Text dimColor>目标数据库：{paths.dbPath}</Text>
    <Box marginTop={1} flexDirection="column">
      {screen === "preflight" && <Text>正在检测 T3 Code 运行状态…</Text>}
      {screen === "blocked" && <><Text bold color="red">检测到 T3 Code 正在运行</Text><Text>在执行导入、同步或替换之前，请先完全退出 T3 客户端{runtime?.pid ? ` (检测到 PID ${runtime.pid})` : ""}。</Text>{runtime?.origin ? <Text dimColor>运行端口：{runtime.origin}</Text> : null}<Text>关闭 T3 后，按 r 或 Enter 重新检测，按 q 退出。</Text></>}
      {screen === "source" && <><Text bold>选择会话来源</Text><Menu items={["Codex", "Claude Code"]} index={index} /></>}
      {screen === "workspace" && <>
        <Text bold>选择会话分组 ({source === "codex" ? (groupByProject ? "项目文件夹模式 · 按 Tab 切换物理路径" : "物理路径模式 · 按 Tab 切换项目文件夹") : "工作区 Workspace"})</Text>
        {summaries.length === 0 ? <Text>正在扫描 {source} 历史会话…</Text> : <Menu items={workspaces} index={index} />}
      </>}
      {screen === "provider" && <><Text bold>选择目标 T3 Provider 实例</Text><Menu items={providers} index={index} /></>}
      {screen === "target-project" && <>
        <Text bold>选择导入目标（T3 Code 项目归属）</Text>
        <Text dimColor>请选择将选中的 {preparedImports.length} 个对话导入到哪个 T3 项目：</Text>
        <Box marginTop={1} flexDirection="column">
          <Menu
            items={[
              `📁 自动创建/归入同名项目：${selectedProject ?? (workspace ? basename(workspace) : "自动识别")}（默认）`,
              `📄 作为独立对话导入（无项目 / No project）`,
              ...t3Projects.map((p) => `🔗 放入已有项目：${p.title}`),
            ]}
            index={index}
          />
        </Box>
      </>}
      {screen === "threads" && <>
        <Text bold>{mode === "sync" ? "选择要同步的会话" : mode === "replace" ? "选择要替换的会话" : "选择要导入的会话"} — 📁 {selectedProject ?? workspace}</Text>
        <Box flexDirection="row">
          <Text dimColor>显示模式：{displayMode === "name" ? "大标题（默认）" : displayMode === "detail" ? "详细时间" : "物理路径"} (按 'v' 切换)</Text>
          {currentGroupArchivedCount > 0 ? (
            <Box marginLeft={2}>
              <Text color={showArchived ? "gray" : "yellow"}>
                {showArchived
                  ? `📁 [已展开归档会话 · 按 'h' 键折叠已归档 (${currentGroupArchivedCount} 个)]`
                  : `📁 [已折叠 ${currentGroupArchivedCount} 个已归档会话 · 按 'h' 键展开]`}
              </Text>
            </Box>
          ) : null}
        </Box>
        {searching || query ? <Text color="yellow">搜索：{query}<Text dimColor>_</Text></Text> : null}
        <Menu items={visibleThreads.map((item) => {
          const syncText = conversationStatusText(syncPreviews.get(item.id), checkingStatuses);
          const replacement = replacePreviews.get(item.id);
          const status = mode === "replace"
            ? replacementStatusText(replacement, checkingStatuses)
            : syncPreviews.get(item.id)?.status === "history-diverged" && replacement?.selectable
              ? "历史已变更 · 支持替换"
              : syncText;
          const archivedTag = item.archived ? "[已归档] " : "";
          let label = item.title;
          if (displayMode === "detail") {
            const time = item.updatedAt ? item.updatedAt.slice(5, 16).replace("T", " ") : "";
            label = `${item.title} (${time})`;
          } else if (displayMode === "path") {
            label = `${item.title} [${item.workspace}]`;
          }
          return `${archivedTag}${label}  [${status}]`;
        })} index={index} selected={selectedVisible} disabled={disabledVisible} />
        {pendingStatuses > 0 ? <Text dimColor>正在比对状态（剩余 {pendingStatuses} 个会话）…</Text> : null}
        {visibleThreads.length === 0 && <Text color="yellow">没有找到匹配的会话记录。</Text>}
      </>}
      {screen === "review" && <>
        {preparedReplacements.length ? <>
          <ReplacementReview workspace={selectedProject ?? workspace} selections={preparedReplacements} previews={replacePreviews} counts={replacementPreview} resetCache={resetCache} />
        </> : <>
          <Text bold>确认导入变更</Text>
          <Text>来源：{source} · 分组/项目：{selectedProject ?? workspace}</Text>
          {preparedImports.length ? <Text>目标项目：{targetProjectChoice.mode === "no-project" ? "独立对话（无项目 / No project）" : targetProjectChoice.mode === "existing" ? `已有项目：${targetProjectChoice.projectTitle}` : `自动同名项目：${selectedProject ?? (workspace ? basename(workspace) : "自动识别")}`}</Text> : null}
          <Text>新增任务数：{importPreview.tasks} · 同步任务数：{syncPreview.tasks}</Text>
          <Text>导入轮次：{importPreview.turns} · 新增轮次：{syncPreview.turns} · 采纳轮次：{syncPreview.adopted}</Text>
          <Text>消息总数：{importPreview.messages} · 工具行为：{importPreview.activities} · 附件图片：{importPreview.attachments}</Text>
          <Text>标题更新数：{syncPreview.titles}</Text>
          {preparedImports.length ? <Text>目标 Provider 实例：{provider}</Text> : null}
          {resetCache ? <Text>T3 IndexedDB 缓存：操作完成后自动备份并重置缓存</Text> : <Text>T3 IndexedDB 缓存：保留现有缓存</Text>}
          <Text color="yellow">【提示】操作前已自动创建数据库安全快照备份。</Text>
          <Text bold>按 Enter 开始执行导入，按 Esc 返回上一步。</Text>
        </>}
      </>}
      {screen === "running" && <Text>{preparedImports.length || preparedSync.length || preparedReplacements.length ? "正在备份数据库并导入会话数据，请稍候…" : "正在加载选中的会话数据，请稍候…"}</Text>}
      {screen === "result" && (result || syncResult || replaceResult) && <>
        <Text bold color="green">✔ 操作完成！</Text>
        {result ? <Text>导入备份文件：{result.backup ?? "无需备份"}</Text> : null}
        {result?.results.map((item) => <Text key={`import:${item.threadId}`}>{item.status === "imported" ? "✓" : "•"} {item.title} — {item.status === "imported" ? "已导入" : item.status}，{item.turns} 轮对话，{item.events} 个事件</Text>)}
        {syncResult ? <Text>同步备份文件：{syncResult.backup ?? "无需备份"}</Text> : null}
        {syncResult?.results.map((item) => <Text key={`sync:${item.sourceKey}`}>{item.status === "synced" ? "✓" : "•"} {item.title} — {item.status === "synced" ? "已同步" : item.status}，新增 {item.turnsAdded} 轮，采纳 {item.turnsAdopted} 轮，{item.events} 个事件</Text>)}
        {replaceResult ? <Text>替换备份文件：{replaceResult.backup ?? "无需备份"}</Text> : null}
        {replaceResult?.results.map((item) => <Text key={`replace:${item.sourceKey}`}>{item.status === "replaced" ? "✓" : "•"} {item.title} — {item.status === "replaced" ? "已替换" : item.status}{item.oldThreadId ? `，原 ID ${item.oldThreadId}` : ""}{item.newThreadId ? `，新 ID ${item.newThreadId}` : ""}，{item.turns} 轮对话，{item.events} 个事件</Text>)}
        {(replaceResult?.cache ?? syncResult?.cache ?? result?.cache) ? <Text>缓存备份路径：{(replaceResult?.cache ?? syncResult?.cache ?? result?.cache)?.backup ?? "未找到缓存"}</Text> : null}
        {cacheWarning ? <Text color="yellow">{cacheWarning}</Text> : null}
        <StartT3Prompt index={index} />
      </>}
      {screen === "launching" && <Text>正在启动 T3 Code…</Text>}
      {screen === "launch-error" && <><Text bold color="red">无法自动启动 T3 Code</Text><Text>{launchError}</Text><Text dimColor>请按 Enter 退出，然后手动打开 T3 客户端。</Text></>}
      {screen === "error" && <><Text bold color="red">执行失败</Text><Text>{error}</Text><Text dimColor>按 Enter 键退出。</Text></>}
    </Box>
    {helpTextForScreen(screen, searching) ? <Box marginTop={1}><Help screen={screen} searching={searching} /></Box> : null}
    <Box marginTop={1}><Text dimColor>原作者: CarlosGtrz · 本地适配与中文汉化: Erico</Text></Box>
  </Box>;
}
