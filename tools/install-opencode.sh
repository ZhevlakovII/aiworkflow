#!/usr/bin/env bash
# install-opencode.sh - thin delegate: node tools/aiwf.ts install opencode
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ARGS=(install opencode)
while [ $# -gt 0 ]; do
  case "$1" in
    --check) ARGS+=(--check) ;;
    --keep-agents) ARGS+=(--keep-agents) ;;
    --target) ARGS+=(--target "${2:-}"); shift ;;
    --target=*) ARGS+=(--target "${1#*=}") ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
exec node "$SCRIPT_DIR/aiwf.ts" "${ARGS[@]}"
