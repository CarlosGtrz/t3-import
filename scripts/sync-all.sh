#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Keep the native SQLite addon on the Node 24 ABI used by this checkout.
if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  set +u
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use --silent 24 >/dev/null
  set -u
fi
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  printf '%s\n' 'This checkout needs Node 24. Select an installed Node 24 with nvm and retry.' >&2
  exit 2
fi
cd -- "$repo_dir"
node -e 'const Database = require("better-sqlite3"); new Database(":memory:").close()' >/dev/null
exec node --import tsx src/cli.ts sync --source codex --all --yes --summary "$@"
