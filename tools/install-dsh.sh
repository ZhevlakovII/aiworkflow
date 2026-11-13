#!/usr/bin/env bash
# install-dsh.sh - thin delegate: node tools/aiwf.ts install dsh
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ARGS=(install dsh)
while [ $# -gt 0 ]; do
  case "$1" in
    --check) ARGS+=(--check) ;;
    --profile) export AIWF_DSH_PROFILE="${2:-}"; shift ;;
    --profile=*) export AIWF_DSH_PROFILE="${1#*=}" ;;
    --target) ARGS+=(--target "${2:-}"); shift ;;
    --target=*) ARGS+=(--target "${1#*=}") ;;
    --with-xai-oauth) ;; # retired hint-only flag
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
exec node "$SCRIPT_DIR/aiwf.ts" "${ARGS[@]}"
