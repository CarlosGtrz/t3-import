# T3 compatibility validation

The importer supports database migrations 40–54 explicitly. A supported number
must also pass integrity and required-column checks. This is not a promise that
every future T3 commit retaining the same migration number will remain compatible.

## Pinned references

Each historical reference below has the stated migration as its latest migration.
Full commit IDs and matching Effect versions live in
[`references.json`](../scripts/compatibility/references.json).

| Migration | Reference commit | Migration change |
|---|---|---|
| 40 | `076e9048dc57` | Project favicon path |
| 41 | `11f051373e79` | Auth session client connection |
| 42 | `3c75eb1132bb` | Thread-linked pull request |
| 43 | `3b86ef941c21` | Unsettled thread timestamp |
| 44 | `5392c9bb99c4` | Clear automatic project model defaults |
| 45 | `ba3cb0773859` | Project auto-pull |
| 46 | `2971ec3209d7` | Repair automatic settlement timestamps |
| 47 | `f6c04c552c20` | Project icons |
| 48 | `223ff4490f76` | Branch pull request |
| 49 | `2d645df474f0` | Active thread ordering |
| 50 | `b7b3ef1e6fcb` | Multiple thread pull requests |
| 51 | `4fed6cfb3517` | Message context |
| 52 | `719a76ca1dbf` | Thread title state (stable v0.0.42) |
| 53 | `adcd90858c3b` | Pull request files viewed (nightly 20260920.2031) |
| 54 | `451afcb22d93` | Per-thread auto-settle switch (stable v0.0.44) |

The migration-50 reference is nightly `v0.0.41-nightly.20260910.1473`.
The migration-52 reference is stable `v0.0.42`; migration 53 is nightly
`v0.0.43-nightly.20260920.2031`. References 40–49 use Effect
`4.0.0-beta.103`, references 50–52 use `4.0.0-rc.112`, and references 53–54 use
`4.0.0-rc.115`.

## Compatibility findings

- The importer-facing event payloads and provider binding fields work across all
  fifteen references, so they use one shared writer. Additional project metadata
  in newer contracts is optional. T3 remains responsible for projection defaults
  and migration repairs; the importer does not write projection rows.
- Bootstrap processes projectors independently. A turn projector can see the
  session projector's final state while replaying older messages. Imported turns
  therefore emit their terminal session event before their assistant messages.
  This preserves interrupted/error turn states and terminal timestamps without
  inventing checkpoint events or leaving messages marked as streaming. Event IDs,
  original content timestamps, and the number of emitted events remain stable.
- Checkpoint recovery recognizes both the older settlement-last layout and the
  new layout. Newly written/recovered ledger entries record the actual database
  migration. Upgrading T3 does not rewrite existing ledger entries or event IDs.
- The migration-50 reference adds `projection.attachment-cleanup`, a bootstrap-only
  maintenance cursor. Backlog checks exclude that cursor but still require the
  read-model projectors to catch up. A database containing only the maintenance
  cursor is still considered unprojected when it has events.
- Migrations 51 and 52 add nullable message-context and title-state columns.
  Their event fields are optional, so existing imported events retain their
  meaning without adding synthetic context or title metadata. Migration 53 adds
  independent pull-request file-view tracking. The shared event writer and
  provider bindings pass the same checks on stable 0.0.42 and the pinned nightly.
- Migration 54 adds nullable `projection_threads.auto_settle_disabled_at`.
  Imported threads retain T3's default auto-settle behavior; the shared event
  writer and provider bindings are validated against stable v0.0.44.

## Reproduce validation

Use a checkout containing the pinned commits at `repos/t3code`, or set
`T3_REFERENCE_REPO` to another local checkout. Preparation uses `git archive` and
does not switch or edit that checkout. Git, tar, Node.js 22.21.1 or newer, and npm
are required. Dependency installation requires network access.

```text
npm run compat:prepare
npm run test:compatibility
```

The first command is optional because the second includes it. Dependencies and
source snapshots live under the gitignored `artifacts/compatibility` directory.
The harness pins Effect and its platform packages together, including transitive
platform-node-shared, to avoid mixing incompatible prereleases.

For a focused rerun after preparation:

```text
npx tsx scripts/compatibility/run.ts 54
```

Each full run executes 58 scenarios: both sources at all fifteen versions, plus
both sources upgrading from each version 40–53 to 54. Each scenario covers real
migration execution, event decoding, startup projection, custom instance binding,
idempotent import/sync/replace, ledger recovery, title updates, changed-history
conflicts, attachments, plans, activities, terminal states, replacement visibility,
resume dispatch, and adoption of a controlled continuation without duplicate events.

The real T3 ProviderService restores persisted cwd/resume state and routes it to
controlled adapters. Those doubles check the original provider cursor and receive
a subsequent turn on the imported/replacement task. Controlled continuation events
are then appended and projected through T3's real event store and projector.
This tests persistence and routing, not provider CLI execution, credentials, network
services, browser rendering, or the orchestration reactor's provider-event translation.

Results are written incrementally to a new
`artifacts/compatibility/run-*/results.json`; the command prints the final path.
A successful full run must report all 54 scenarios. A failed scenario stops the
command with a nonzero exit code; partial reports are not evidence of a full pass.

## Regenerate schema fixtures

```text
npm run compat:prepare
npm run compat:schemas
npm test
npm run typecheck
npm run build
```

Fixture generation runs each historical migration runner on a fresh, marked
synthetic T3 home and exports its complete DDL and migration records. Execution
timestamps are normalized to keep the committed JSON reproducible. Ordinary tests
use that JSON without downloading or importing the T3 reference repository.

Synthetic homes are retained under `artifacts/compatibility` for diagnosis. The
runner refuses homes without its fixture marker. It never snapshots or opens the
installed application's database, starts a live T3 application, or invokes paid
provider processes. Reference sources, integration dependencies, and synthetic
data are excluded from the published npm package.
