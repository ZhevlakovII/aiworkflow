#!/usr/bin/env bash
# install-opencode.sh - install the AI Workflow OPENCODE flavor (POSIX; twin of install-claude.sh).
#
# Deploys the .opencode layer (TS custom-tools + plugins + subagents + slash-commands + AGENTS.md
# + delegation.yml/zonemap.yml) plus opencode.json so OpenCode (TUI/Desktop) auto-discovers them.
# Default target = user-global ~/.config/opencode; --target <dir> stamps <dir>/.opencode
# (project-scoped) and writes <dir>/opencode.json.
#
# Unlike the claude flavor: TS tools are self-contained (relative `../lib` imports + PATH binaries
# git/gh/claude/opencode/codex/ast-index) -> NO path rewrite needed. opencode.json is MERGED
# (permission + instructions spliced, existing user keys preserved) via python. Copy is an OVERLAY
# (no dir-wide delete) because the global config dir shares its namespace with the user's own agents.
#
#   bash tools/install-opencode.sh --check              # dry-run
#   bash tools/install-opencode.sh                       # global ~/.config/opencode
#   bash tools/install-opencode.sh --target /path/proj   # project-scoped <proj>/.opencode
set -euo pipefail

CHECK=0; TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --target=*) TARGET="${1#*=}" ;;
    --target) shift; TARGET="${1:-}" ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO/.opencode"
SRC_JSON="$REPO/opencode.json"
[ -d "$SRC" ] || { echo "canon .opencode not found: $SRC" >&2; exit 1; }
[ -f "$SRC_JSON" ] || { echo "canon opencode.json not found: $SRC_JSON" >&2; exit 1; }

if [ -n "$TARGET" ]; then
  DEST="$TARGET/.opencode"; JSON_DST="$TARGET/opencode.json"; SCOPED=1
else
  DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"; JSON_DST="$DEST/opencode.json"; SCOPED=0
fi
AGENTS_DST="$DEST/AGENTS.md"
PY="$(command -v python3 || command -v python)"

echo "flavor: opencode"
echo "canon:  $SRC"
echo "dest:   $DEST  ($([ $SCOPED -eq 1 ] && echo project-scoped || echo global))"
echo

[ $CHECK -eq 0 ] && mkdir -p "$DEST"

# --- 1. mirror .opencode tree (OVERLAY: copy our files, never delete the whole dir) ---
# Subtrees clearly ours -> full sync (delete stale inside them); shared roots -> overlay only.
OURS_DIRS="tools plugins lib commands"     # our namespaces (safe to delete stale within)
OVERLAY_DIRS="agents"                        # shared with user agents -> overlay, no delete
TOP_FILES="AGENTS.md delegation.yml zonemap.yml"

sync_dir_full() { # $1 = subdir; mirror with stale-delete inside our namespace
  local sub="$1" s="$SRC/$1" d="$DEST/$1"
  [ -d "$s" ] || return 0
  if [ $CHECK -eq 1 ]; then
    local n
    if [ ! -d "$d" ]; then n=$(find "$s" -type f | wc -l | tr -d ' ')
    else n=$( { diff -rq "$s" "$d" 2>/dev/null || true; } | wc -l | tr -d ' '); fi
    echo "[check] $sub/: $n file(s) would change"
  else
    rm -rf "$d"; mkdir -p "$d"; cp -R "$s/." "$d/"
    echo "[sync] $sub/ mirrored"
  fi
}

sync_dir_overlay() { # $1 = subdir; copy our files, keep user's others
  local sub="$1" s="$SRC/$1" d="$DEST/$1"
  [ -d "$s" ] || return 0
  [ $CHECK -eq 0 ] && mkdir -p "$d"
  local chg=0 f base
  for f in "$s"/*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    if [ $CHECK -eq 1 ]; then
      if [ -e "$d/$base" ] && diff -rq "$f" "$d/$base" >/dev/null 2>&1; then :; else chg=$((chg+1)); fi
    else
      rm -rf "$d/$base"; cp -R "$f" "$d/$base"
    fi
  done
  [ $CHECK -eq 1 ] && echo "[check] $sub/ (overlay): $chg file(s) would change" || echo "[sync] $sub/ overlaid (user files kept)"
}

for sub in $OURS_DIRS;    do sync_dir_full    "$sub"; done
for sub in $OVERLAY_DIRS; do sync_dir_overlay "$sub"; done

# top-level files (AGENTS.md / delegation.yml / zonemap.yml)
for f in $TOP_FILES; do
  [ -f "$SRC/$f" ] || continue
  if [ $CHECK -eq 1 ]; then
    if [ -f "$DEST/$f" ] && diff -q "$SRC/$f" "$DEST/$f" >/dev/null 2>&1; then st="in sync"; else st="would change"; fi
    echo "[check] $f: $st"
  else
    cp "$SRC/$f" "$DEST/$f"
  fi
done
[ $CHECK -eq 0 ] && echo "[sync] AGENTS.md + delegation.yml + zonemap.yml"

# --- 2. opencode.json MERGE (permission + instructions; preserve existing user keys) via python ---
# instr path: project-scoped -> relative (портируемо между клонами); global -> absolute deployed AGENTS.md.
if [ $SCOPED -eq 1 ]; then INSTR=".opencode/AGENTS.md"; else INSTR="$AGENTS_DST"; fi
"$PY" - "$SRC_JSON" "$JSON_DST" "$INSTR" "$CHECK" <<'PYEOF'
import json, sys, os
src_json, json_dst, agents_dst, check = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
canon = json.load(open(src_json, encoding="utf-8"))
cfg = {}
if os.path.exists(json_dst):
    try: cfg = json.load(open(json_dst, encoding="utf-8"))
    except Exception: cfg = {}
# permission: overlay canon keys (edit/webfetch/bash-patterns), preserve any extra user keys
perm = cfg.setdefault("permission", {})
cperm = canon.get("permission", {})
for k, v in cperm.items():
    if k == "bash" and isinstance(v, dict) and isinstance(perm.get("bash"), dict):
        perm["bash"].update(v)          # merge bash pattern-map, keep user's other patterns
    else:
        perm[k] = v
# instructions: ensure our deployed AGENTS.md is referenced (absolute, deduped)
instr = cfg.get("instructions")
if not isinstance(instr, list): instr = []
ap = agents_dst.replace("\\", "/")
if ap not in instr and "./AGENTS.md" not in instr and ".opencode/AGENTS.md" not in instr:
    instr.append(ap)
cfg["instructions"] = instr
if "$schema" not in cfg and "$schema" in canon: cfg["$schema"] = canon["$schema"]
out = json.dumps(cfg, indent=2, ensure_ascii=False)
if check:
    cur = open(json_dst, encoding="utf-8").read() if os.path.exists(json_dst) else ""
    print("[check] opencode.json: " + ("would change (permission/instructions merged)" if cur.strip() != out.strip() else "in sync"))
else:
    os.makedirs(os.path.dirname(json_dst) or ".", exist_ok=True)
    open(json_dst, "w", encoding="utf-8").write(out + "\n")
    print("[sync] opencode.json (permission + instructions merged, existing keys preserved)")
PYEOF

echo
if [ $CHECK -eq 1 ]; then
  echo "CHECK done (nothing written)."
else
  echo "OPENCODE flavor installed."
  if [ $SCOPED -eq 0 ]; then
    echo "  Global: tools/plugins/commands/agents in $DEST (visible in every project)."
    echo "  NOTE: driver-tools (design_worker/execute_worker) читают .opencode/{agents,delegation.yml,zonemap.yml}"
    echo "        ОТ cwd проекта — для полного флоу держи проектный .opencode/ ИЛИ ставь project-scoped (--target)."
  else
    echo "  Project-scoped: <target>/.opencode + <target>/opencode.json (tools резолвят всё cwd-relative — робастно)."
  fi
  echo "  Открой проект в OpenCode: флоу идёт без команды (AGENTS.md → build-агент) или /aiwf-* командами."
fi
