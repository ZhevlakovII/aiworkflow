#!/usr/bin/env bash
# setup.sh - thin delegate to node tools/aiwf.ts setup (linux/macos).
# Maps --yes/-y to --mode yolo. Live flavors: omp|opencode|cursor|dsh|all (no claude/codex/both).
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
CLI="$SCRIPT_DIR/aiwf.ts"

ARGS=(setup)
MODE=""
FLOW="all"
TARGET=""
CHECK=0
SKIP_SMOKE=0
KEEP_AGENTS=0
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --yes|-y|--install-missing) YES=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --keep-agents) KEEP_AGENTS=1 ;;
    --default-roles) ;; # implied by yolo/key/soft
    --mode) MODE="${2:-}"; shift ;;
    --mode=*) MODE="${1#*=}" ;;
    --flow) FLOW="${2:-}"; shift ;;
    --flow=*) FLOW="${1#*=}" ;;
    --target) TARGET="${2:-}"; shift ;;
    --target=*) TARGET="${1#*=}" ;;
    --install|--install=*) ;; # retired: no mid-flight package install
    -h|--help) exec node "$CLI" --help ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$YES" -eq 1 ]; then ARGS+=(--mode yolo)
elif [ -n "$MODE" ]; then ARGS+=(--mode "$MODE")
fi
[ "$CHECK" -eq 1 ] && ARGS+=(--check)
[ "$SKIP_SMOKE" -eq 1 ] && ARGS+=(--skip-smoke)
[ "$KEEP_AGENTS" -eq 1 ] && ARGS+=(--keep-agents)
ARGS+=(--flow "$FLOW")
[ -n "$TARGET" ] && ARGS+=(--target "$TARGET")

exec node "$CLI" "${ARGS[@]}"
