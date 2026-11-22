#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${ROSETTA_NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "[Rosetta] Node.js (>= 20.0.0) is required. Please install Node.js or set ROSETTA_NODE_BIN." >&2
  exit 1
fi
exec "$NODE_BIN" "$SCRIPT_DIR/src/desktop/launcher.cjs" "$@"
