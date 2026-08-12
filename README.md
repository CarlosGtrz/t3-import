# t3-import

`t3-import` is an independent, local-only CLI for importing Codex and Claude Code conversation history into [T3 Code](https://github.com/pingdotgg/t3code). It writes canonical orchestration events while T3 is closed; T3 rebuilds its own projections on the next launch. The original provider session is bound so the current branch can resume when the source history is still available.

The first compatibility profile is intentionally strict: **T3 migration 40 only**, Node.js 22 or newer, and local files only. Unknown T3 schemas fail closed.

## How it works

`t3-import` reads local Codex conversations through `codex app-server` and Codex rollout JSONL files. It reads Claude Code sessions from the JSONL files under `~/.claude/projects/`. The source data is normalized into conversations, turns, messages, tool activity, plans, usage, and supported image attachments.

To keep T3 startup bounded, imports preserve every message, turn boundary, plan, image, error or approval, context compaction, and resume binding while compacting repetitive activity telemetry. Context-window snapshots are omitted, and long turns retain the latest visible reasoning summary plus a representative significant tool activity. The importer rejects any write that would exceed T3's safe one-launch projection budget.

With T3 Code closed, the importer validates the local migration-40 database and creates a verified backup. It then appends canonical events to `orchestration_events` and adds provider-session bindings for conversations that can be resumed. It does not modify T3's projection tables: T3 Code rebuilds them from the imported events the next time it starts. After a successful write, the importer also backs up and resets T3's rebuildable IndexedDB origin cache so stale task snapshots cannot hide newly imported history.

After an initial import, `t3-import` can append newly settled Codex turns and newly settled turns from linear Claude conversations. Completed, interrupted, and failed turns are preserved; only genuinely active or indeterminate turns are ignored during synchronization. It verifies that the imported checkpoint is still an exact prefix, adopts exact turns already created by resuming through T3, and never replaces edited or deleted history. Claude sessions with multiple non-sidechain leaves are reported as conflicts rather than guessed.

If an imported task has diverged or was created by an older importer, `replace` can create a fresh, complete canonical task from the provider transcript. The old task is soft-deleted with a `thread.deleted` event, while its immutable event stream remains available for audit. The provider instance, model, resume cursor, project, and synchronization identity move to the new task atomically. Replacement is available for Codex and for Claude sessions with one non-sidechain leaf, and it refuses to snapshot an active provider turn.

## Install and run

> [!WARNING]
> `t3-import` is experimental and writes directly to T3 Code's local database. Future T3 Code versions may be incompatible even if the tool works today. Close T3 Code before importing, keep the generated backup, and use this tool at your own risk.

```text
npm install --global @carlosgtrz/t3-import
t3-import
```

Running without a command opens the interactive TUI. It guides you through source, workspace, provider instance, conversation selection, review, confirmation, and results, then offers to start T3 Code with Yes selected by default.

## Interactive demo

The example below installs the package, launches `t3-import` without parameters, selects Codex, and imports two simulated conversations into T3 Code.

![Animated t3-import interactive Codex import](https://raw.githubusercontent.com/CarlosGtrz/t3-import/main/assets/t3-import-tui-demo.gif)

Non-interactive examples:

```text
t3-import list --source codex --workspace C:\src\my-project
t3-import show --source claude --thread <session-id>
t3-import import --source codex --workspace C:\src\my-project --thread <thread-id> --yes --non-interactive
t3-import import --source claude --workspace C:\src\my-project --all --since 2026-01-01 --yes --non-interactive
t3-import sync --source codex --workspace C:\src\my-project --thread <thread-id> --yes --non-interactive
t3-import sync --source claude --workspace C:\src\my-project --all --yes --non-interactive
t3-import replace --source codex --workspace C:\src\my-project --thread <thread-id> --yes --non-interactive
t3-import cache reset --yes
t3-import doctor --json
```

Global target options can be placed before or after a subcommand:

```text
--t3-home <path>
--db <state.sqlite>
--attachments-dir <path>
--provider-instance <id>
--json
--no-color
--no-cache-reset            Keep the existing IndexedDB cache after writes
```

Import options:

```text
--thread <id>             Repeatable; mutually exclusive with --all
--all
--since <ISO date>
--include-incomplete
--dry-run
--yes
--non-interactive
--no-resume
```

Sync options:

```text
--thread <id>             Repeatable; mutually exclusive with --all
--all                     Sync previously imported conversations only
--since <ISO date>
--dry-run
--yes
--non-interactive
```

Replace options:

```text
--thread <id>             Repeatable and required for non-interactive use
--dry-run
--yes
--non-interactive
```

The normal TUI labels conversations as new, syncable, up to date, active-only, or conflicted. Interrupted and failed additions are called out in the status text, and ignored active turns are shown without enabling them for synchronization. A history conflict is labeled `history changed · replace available` when it can be replaced. Replacement choices cannot be mixed with imports or ordinary syncs. The dedicated `sync` and `replace` commands open focused TUI flows when required arguments are omitted on a terminal.

When `--json` is active, stdout contains one versioned JSON value and diagnostics use stderr. Exit codes are `2` usage, `3` T3 compatibility, `4` live-T3 safety, `5` source parsing, `6` write failure, and `7` reconciliation conflict.

## Safety and storage

- Close T3 before every real import. There is deliberately no force bypass.
- Every write creates and verifies a timestamped SQLite backup under `<state-dir>/t3-import-backups/`.
- Successful imports, syncs, and replacements reset T3's rebuildable IndexedDB origin cache by default. The cache is moved aside, copied and verified under the same backup directory before removal; use `--no-cache-reset` to opt out.
- The importer appends `orchestration_events` and writes resumable rows to `provider_session_runtime`; it never writes `projection_*` tables or `projection_state`.
- Imports are idempotent. A second import reports `already-imported`. `sync` only appends completed, interrupted, or failed turns after an unchanged checkpoint, and repeated syncs are no-ops. `replace` promotes one complete new task as the sole synchronization target and soft-deletes the old canonical task; repeating it against that unchanged replacement is also a no-op.
- New imports are rejected when T3 has an existing projection backlog or when the compact event plan exceeds the safe 900-event startup budget.
- Supported local image attachments are copied atomically. Remote images are referenced but not downloaded.
- An external ledger is stored in the platform application-data directory. Event IDs provide the fallback idempotency check if the ledger is missing.

`doctor` reports database compatibility and integrity, live/stale runtime state, discovered IndexedDB caches, source availability, and attachment staging leftovers without changing anything. `t3-import cache reset` can perform the same recoverable cache reset without importing, synchronizing, or replacing anything. Both operations require T3 to be closed.

## Source behavior

Codex discovery prefers the normalized `codex app-server` API and augments it with rollout JSONL; it falls back to rollout files when app-server is unavailable. Claude discovery streams project JSONL and reconstructs its UUID graph. Genuine alternate Claude leaves become separate historical T3 tasks; only the current leaf receives a resume binding.

Injected system/developer/environment envelopes and encrypted reasoning blobs are excluded. Visible messages, reasoning summaries, plans, tools, usage, compaction, resolved approvals/input, and supported images are mapped to T3-compatible events.

## Development

The repositories under `repos/` are references and are not runtime dependencies.

```text
npm install
npm run typecheck
npm test
npm run build
npm pack
```

The end-to-end fixture is deliberately local and uncommitted. To validate against a real nightly, copy a migration-40 database to an isolated T3 home, import a task there, and launch T3's server with that home. Never use the development validation flow against the live `~/.t3` database.
