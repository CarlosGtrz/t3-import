# Native Codex synchronization validation

## Supported workflow

Continue an existing T3 Codex conversation in Codex Desktop or CLI, close T3, run the synchronization command, then reopen T3:

```sh
t3-import sync --source codex --all --yes --summary
```

Omitting `--workspace` scans existing Codex bindings and canonical import checkpoints across projects. It does not import unrelated rollouts. Add `--dry-run` for a preview. The development checkout also provides `bash scripts/sync-all.sh`, which selects an installed Node 24 through nvm and checks the native SQLite addon.

The sync requires a unique stopped provider binding and a verified settled transcript prefix. It preserves the native thread ID and T3 title, reconstructs streamed assistant deltas and steered inputs by provider identity, and appends missing terminal turns as historical events. These events do not request provider turns or start sessions.

Scratch workspaces can match the exact runtime cwd even when the containing project root differs. A title or a parent directory alone cannot establish a match. Native continuation after an import checkpoint uses the same transcript comparison, including events that lack provider identity in their metadata.

## Automated validation

The implementation was checked with Node 24.19.0:

```sh
npm run typecheck --silent
npm test -- --reporter=dot
npm run build --silent
git diff --check
```

Type checking and build passed. All 618 tests in 11 files passed. The focused sync, ledger, and global sync suite passed 318 tests. Native adoption tests cover supported T3 migrations 40 through 54, streamed deltas, steering identity, scratch cwd matching, title preservation, and continuation without duplicate events.

Global sync tests cover linked conversations across workspaces, an unrelated source, unavailable sources, divergent histories, safe updates in a mixed batch, backups, and repeat synchronization. Ledger tests check that preview reads do not create or migrate the ledger.

## Review follow-up on ledger safety

On 12 October 2026, regression coverage was added in response to the review on PR #6:

- Read committed, uncheckpointed WAL rows while the writer connection remains open. Check that the database and WAL bytes do not change.
- Read a consistent database/WAL copy with no `-shm` file. Check that pending WAL data remains visible and persistent bytes stay unchanged.
- Run both sync and replacement dry-run engines, plus the inspection functions used by the TUI conversation views, against missing and legacy ledgers. Check that no ledger directory is created, the legacy ledger files remain unchanged, no target events are added, and no backup is created. These tests call the TUI's inspection functions directly rather than rendering the interactive UI.
- Exercise real `SQLITE_NOTADB` and `SQLITE_CORRUPT` failures through ledger reads, inspection, and both dry-run engines. Check that the importer returns a safety error with the ledger path and recovery guidance, while preserving existing persistent data.

The focused ledger suites passed 8 tests. The full suite passed 624 tests across 12 files. Type checking, build, and `git diff --check` passed.

Read-only refers to the database data and schema. SQLite may create or rebuild `-shm`; on a WAL-mode corrupt database it may also create an empty WAL before detecting the corruption. The tests do not promise an unchanged shared-memory index. The reader deliberately avoids immutable mode so it can see committed WAL transactions. Corruption errors use safety exit code 4 and do not attempt repairs. They ask the user to preserve the ledger and sidecars. Automatic backups do not include the external ledger; recovery requires a verified user-maintained backup if available, or further investigation before writes. Deleting the ledger can lose replacement history and is not recommended.

## Database copy experiment

A consistent SQLite backup of the target and a separate copy of the import ledger were used. The ledger target was remapped only in the copy. Source loading used local rollouts without launching the Codex app-server.

The scan found ten linked conversations. It appended five settled turns to one conversation, found four already current, skipped four histories that could not be verified, and reported one unavailable rollout. The append produced 34 historical events.

Checks confirmed that all original event rows stayed unchanged, only the intended thread received new events, no new threads were created, and no turn-start requests were written. A repeated sync added no events or turns and created no further backup. SQLite `integrity_check` returned `ok`. The actual Node 24 launcher also ran successfully against the copy.

## Live application confirmation

On 11 October 2026, the user closed T3 and ran the launcher against the live target. It reported six new settled turns, four current threads, and five skipped cases. The additional sixth turn had completed after the copied-database experiment. The command created the normal pre-import SQLite backup.

After reopening T3, the user confirmed that the conversation appeared synchronized. This is user confirmation of the UI result; the detailed event invariants above were checked on the copy. An earlier migration-54 native adoption experiment separately verified projection replay and the absence of `provider.turn.start.failed` activities after reopening T3.

## Limits and transcript artifacts

### Explicit import destination checks

The destination options preserve the source execution directory. `--target-project` accepts only an existing project rooted at that cwd. `--no-project` accepts only an existing direct child of the target home's native scratch directory, outside Git. External folders, escaped symlinks, missing/deleted projects, and conflicting flags fail before writes. These options select destinations for new imports; they do not move an already imported thread or relocate source files.

Scratch threads retain their folder in `thread.created.worktreePath`, rather than relying on runtime payload `cwd` to override T3's workspace policy. Replacement retains that field, and repeat import reports the existing destination. Tests cover these paths across migrations 40–54, including dry-run persistence, repeat import, sync, replacement, and cwd agreement.

The implementation was checked against upstream `RuntimePolicy.ts`, `ThreadLaunchService.ts`, `ManagedProjectFolders.ts`, and the native scratch launch tests. No GUI claim is made for the new destination options; their event and runtime invariants are covered by fixtures.

Destination tests passed 34 cases; together with CLI checks, the focused run passed 37 tests. The full run passed 658 tests across 13 files, plus type checking, build, and diff checks. Additional cases verify canonical project-event fallback before projection materialization, refusal to move an existing import to another destination, and preservation of path spelling while canonical paths are used only for comparison.

This is an explicit one-shot sync. T3 must be closed for writes and reopened to rebuild projections. Active source turns wait until they reach a terminal state.

Exit code 7 means some linked conversations need review. Safe updates can succeed in the same batch, producing a `mixed` result. Divergent or ambiguous histories and unavailable rollouts remain untouched. The implementation does not merge branches, replace conversations, or create separate branch copies automatically.

The unresolved sample cases include steering boundaries that still fail strict comparison, attachment context wrappers, different provider turn identities with similar prompts, a possible source rebinding, and a missing local rollout. They have not all been established as genuine forks. Further normalization needs evidence and dedicated tests before those cases can be adopted.

Codex can include `<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>` in stored user input context. The importer preserves it as transcript text; it does not dispatch an action. Cosmetic filtering is separate from transcript identity checks.

Private conversation contents, identifiers, local backup paths, and copied databases are excluded from this report.
