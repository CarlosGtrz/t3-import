# t3-import

`t3-import` is an independent, local-only CLI for importing Codex and Claude Code conversation history into [T3 Code](https://github.com/pingdotgg/t3code). It writes canonical orchestration events while T3 is closed; T3 rebuilds its own projections on the next launch. The original provider session is bound so the current branch can resume when the source history is still available.

The first compatibility profile is intentionally strict: **T3 migration 40 only**, Node.js 22 or newer, and local files only. Unknown T3 schemas fail closed.

## Install and run

```text
npm install --global @carlosgtrz/t3-import
t3-import
```

Running without a command opens the interactive TUI. It guides you through source, workspace, provider instance, conversation selection, review, confirmation, and results.

Non-interactive examples:

```text
t3-import list --source codex --workspace C:\src\my-project
t3-import show --source claude --thread <session-id>
t3-import import --source codex --workspace C:\src\my-project --thread <thread-id> --yes --non-interactive
t3-import import --source claude --workspace C:\src\my-project --all --since 2026-01-01 --yes --non-interactive
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
--duplicate               Create a transcript-only copy
```

When `--json` is active, stdout contains one versioned JSON value and diagnostics use stderr. Exit codes are `2` usage, `3` T3 compatibility, `4` live-T3 safety, `5` source parsing, and `6` write failure.

## Safety and storage

- Close T3 before every real import. There is deliberately no force bypass.
- Every write creates and verifies a timestamped SQLite backup under `<state-dir>/t3-import-backups/`.
- The importer appends `orchestration_events` and writes resumable rows to `provider_session_runtime`; it never writes `projection_*` tables or `projection_state`.
- Imports are idempotent. A second import reports `already-imported`; `--duplicate` creates a non-resumable transcript copy.
- Supported local image attachments are copied atomically. Remote images are referenced but not downloaded.
- An external ledger is stored in the platform application-data directory. Event IDs provide the fallback idempotency check if the ledger is missing.

`doctor` reports database compatibility and integrity, live/stale runtime state, source availability, and attachment staging leftovers without changing anything.

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
