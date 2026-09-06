#!/usr/bin/env bash
# install-claude.sh - install the AI Workflow CLAUDE-CODE flavor (POSIX twin of install-claude.ps1).
#
# Deploys the .claude layer (subagents + slash-commands + enforcement hooks) so Claude Code
# sees them. Default target = user-global ~/.claude; --target <dir> stamps <dir>/.claude
# (project-scoped) and copies CLAUDE.md. Tool/hook paths rewritten to absolute clone paths;
# hooks are cwd-aware so one global copy serves every project. settings.json is MERGED
# (hooks + permissions.deny spliced, existing keys preserved) via python.
#
#   bash tools/install-claude.sh --check              # dry-run
#   bash tools/install-claude.sh                       # global ~/.claude
#   bash tools/install-claude.sh --target /path/proj   # project-scoped
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
SRC="$REPO/.claude"
[ -d "$SRC" ] || { echo "canon .claude not found: $SRC" >&2; exit 1; }

if [ -n "$TARGET" ]; then DEST="$TARGET/.claude"; SCOPED=1; else DEST="$HOME/.claude"; SCOPED=0; fi
PY="$(command -v python3 || command -v python)"

echo "flavor: claude-code"
echo "canon:  $SRC"
echo "dest:   $DEST  ($([ $SCOPED -eq 1 ] && echo project-scoped || echo global))"
echo

[ $CHECK -eq 0 ] && mkdir -p "$DEST"

# --- 1. agents/ (verbatim mirror) ---
if [ -d "$SRC/agents" ]; then
  if [ $CHECK -eq 1 ]; then
    n=$(diff -rq "$SRC/agents" "$DEST/agents" 2>/dev/null | wc -l | tr -d ' ')
    echo "[check] agents: $n file(s) would change"
  else
    rm -rf "$DEST/agents"; mkdir -p "$DEST/agents"; cp -R "$SRC/agents/." "$DEST/agents/"
    echo "[sync] agents/ mirrored"
  fi
fi

# --- 2. commands/ (rewrite `python tools/X.py` -> absolute clone path) ---
if [ -d "$SRC/commands" ]; then
  [ $CHECK -eq 0 ] && mkdir -p "$DEST/commands"
  for f in "$SRC/commands"/*.md; do
    base="$(basename "$f")"
    rewritten="$(sed -E "s|python tools/([^ ]+\.py)|python \"$REPO/tools/\1\"|g" "$f")"
    out="$DEST/commands/$base"
    if [ $CHECK -eq 1 ]; then
      if [ -f "$out" ] && [ "$rewritten" = "$(cat "$out")" ]; then st="in sync"; else st="would change"; fi
      echo "[check] commands/$base: $st"
    else
      printf '%s' "$rewritten" > "$out"
    fi
  done
  [ $CHECK -eq 0 ] && echo "[sync] commands/ (tool paths -> clone)"
fi

# --- 3. settings.json MERGE (hooks + permissions.deny; preserve existing keys) via python ---
SET_DST="$DEST/settings.json"
ZG="python \"$REPO/.claude/hooks/zone-guard.py\""
TEL="python \"$REPO/.claude/hooks/telemetry.py\""
"$PY" - "$SET_DST" "$ZG" "$TEL" "$CHECK" <<'PYEOF'
import json, sys, os
set_dst, zg, tel, check = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
cfg = {}
if os.path.exists(set_dst):
    try: cfg = json.load(open(set_dst, encoding="utf-8"))
    except Exception: cfg = {}
perm = cfg.setdefault("permissions", {})
deny = perm.setdefault("deny", [])
for d in ["Bash(rm -rf:*)", "Bash(nc:*)", "Bash(ssh:*)", "PowerShell(Remove-Item -Recurse -Force:*)"]:
    if d not in deny: deny.append(d)
hooks = cfg.setdefault("hooks", {})
def set_group(event, matcher, cmd, tag):
    arr = [g for g in hooks.get(event, []) if not any(tag in h.get("command", "") for h in g.get("hooks", []))]
    arr.append({"matcher": matcher, "hooks": [{"type": "command", "command": cmd}]})
    hooks[event] = arr
set_group("PreToolUse", "Bash|Write|Edit|MultiEdit|NotebookEdit", zg, "zone-guard")
set_group("PostToolUse", "", tel, "telemetry")
out = json.dumps(cfg, indent=2, ensure_ascii=False)
if check:
    cur = open(set_dst, encoding="utf-8").read() if os.path.exists(set_dst) else ""
    print("[check] settings.json: " + ("would change (hooks/deny merged)" if cur.strip() != out.strip() else "in sync"))
else:
    open(set_dst, "w", encoding="utf-8").write(out + "\n")
    print("[sync] settings.json (hooks + permissions.deny merged, existing keys preserved)")
PYEOF

# --- 4. CLAUDE.md (project-scoped only; global skips to avoid ambient rules) ---
if [ $SCOPED -eq 1 ] && [ -f "$REPO/CLAUDE.md" ]; then
  CLAUDE_DST="$TARGET/CLAUDE.md"
  if [ $CHECK -eq 1 ]; then
    echo "[check] CLAUDE.md: $([ -f "$CLAUDE_DST" ] && echo 'exists (will NOT overwrite)' || echo 'would create')"
  elif [ -f "$CLAUDE_DST" ]; then
    echo "[keep] CLAUDE.md exists in target - not overwritten"
  else
    cp "$REPO/CLAUDE.md" "$CLAUDE_DST"; echo "[sync] CLAUDE.md -> target project"
  fi
fi

echo
if [ $CHECK -eq 1 ]; then
  echo "CHECK done (nothing written)."
else
  echo "CLAUDE-CODE flavor installed."
  [ $SCOPED -eq 0 ] && echo "  Per-project lead protocol: copy $REPO/CLAUDE.md into a project as CLAUDE.md (opt-in)."
  echo "  Reload Claude Code (restart session) for settings.json hooks to take effect."
fi
