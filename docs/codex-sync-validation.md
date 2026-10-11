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

## Database copy experiment

A consistent SQLite backup of the target and a separate copy of the import ledger were used. The ledger target was remapped only in the copy. Source loading used local rollouts without launching the Codex app-server.

The scan found ten linked conversations. It appended five settled turns to one conversation, found four already current, skipped four histories that could not be verified, and reported one unavailable rollout. The append produced 34 historical events.

Checks confirmed that all original event rows stayed unchanged, only the intended thread received new events, no new threads were created, and no turn-start requests were written. A repeated sync added no events or turns and created no further backup. SQLite `integrity_check` returned `ok`. The actual Node 24 launcher also ran successfully against the copy.

## Live application confirmation

On 11 October 2026, the user closed T3 and ran the launcher against the live target. It reported six new settled turns, four current threads, and five skipped cases. The additional sixth turn had completed after the copied-database experiment. The command created the normal pre-import SQLite backup.

After reopening T3, the user confirmed that the conversation appeared synchronized. This is user confirmation of the UI result; the detailed event invariants above were checked on the copy. An earlier migration-54 native adoption experiment separately verified projection replay and the absence of `provider.turn.start.failed` activities after reopening T3.

## Limits and transcript artifacts

This is an explicit one-shot sync. T3 must be closed for writes and reopened to rebuild projections. Active source turns wait until they reach a terminal state.

Exit code 7 means some linked conversations need review. Safe updates can succeed in the same batch, producing a `mixed` result. Divergent or ambiguous histories and unavailable rollouts remain untouched. The implementation does not merge branches, replace conversations, or create separate branch copies automatically.

The unresolved sample cases include steering boundaries that still fail strict comparison, attachment context wrappers, different provider turn identities with similar prompts, a possible source rebinding, and a missing local rollout. They have not all been established as genuine forks. Further normalization needs evidence and dedicated tests before those cases can be adopted.

Codex can include `<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>` in stored user input context. The importer preserves it as transcript text; it does not dispatch an action. Cosmetic filtering is separate from transcript identity checks.

Private conversation contents, identifiers, local backup paths, and copied databases are excluded from this report.
