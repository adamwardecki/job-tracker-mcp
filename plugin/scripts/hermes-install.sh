#!/usr/bin/env bash
# Install the job-hunt plugin into Hermes from this checkout (dev install; edits apply on restart).
# Usage: scripts/hermes-install.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_DIR="${HERMES_HOME:-$HOME/.hermes}"

command -v hermes >/dev/null || { echo "hermes not found on PATH" >&2; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node >= 22.18 not found on PATH" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || { echo "node >= 22.18 required (node:sqlite, TypeScript type stripping)" >&2; exit 1; }

mkdir -p "$HERMES_DIR/plugins"
# The plugin was called job-hunt before 0.2.0 and j-hunt before 0.3.0; drop the old links so it does not load twice.
for old in job-hunt j-hunt; do if [ -L "$HERMES_DIR/plugins/$old" ]; then rm "$HERMES_DIR/plugins/$old"; fi; done
ln -sfn "$ROOT" "$HERMES_DIR/plugins/job-tracker"
hermes plugins enable job-tracker

TRACKER="$ROOT/servers/tracker/src/index.ts"
# `hermes mcp add` asks "Enable all N tools? [Y/n/select]" and cancels (exit 0) on end of input, so answer Y:
# the skills call every tracker tool. Then check the config, since a cancel still exits 0.
printf 'Y\n' | hermes mcp add job_hunt_tracker --command "$NODE" --args --no-warnings "$TRACKER"
hermes config get mcp_servers.job_hunt_tracker.args 2>/dev/null | grep -qF -- "$TRACKER" \
  || { echo "hermes mcp add did not save the job_hunt_tracker server; run it again by hand and answer Y:" >&2
       echo "  hermes mcp add job_hunt_tracker --command \"$NODE\" --args --no-warnings \"$TRACKER\"" >&2; exit 1; }

echo "Done. Restart Hermes, then run /job-tracker:setup"
