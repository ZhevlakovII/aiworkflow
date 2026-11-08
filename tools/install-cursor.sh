#!/usr/bin/env bash
# install-cursor.sh - install the AI Workflow CURSOR flavor (POSIX twin of install-cursor.ps1).
#
# Deploys the .cursor layer (subagents + skills + hooks.json + short lead-rule include).
# Root AGENTS.md = SSOT (project-scoped seed if-absent); rule must not duplicate body.
# Default target = user-global ~/.cursor; --target <dir> stamps <dir>/.cursor.
# Templates keep literal <clone>; install rewrites to absolute clone path.
# Agents rendered fresh: node core/src/render/cli.ts render --out <tmp> --clients cursor.
#
#   bash tools/install-cursor.sh --check
#   bash tools/install-cursor.sh
#   bash tools/install-cursor.sh --target /path/proj
#   bash tools/install-cursor.sh --target /path/proj --keep-agents
set -euo pipefail

CHECK=0; TARGET=""; KEEP_AGENTS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --target=*) TARGET="${1#*=}" ;;
    --target) shift; TARGET="${1:-}" ;;
    --keep-agents) KEEP_AGENTS=1 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO/ports/cursor"
CANON_ROLE_ROOT="$REPO/canon"
ADAPTERS_ROOT="$REPO/tools/adapters"
LEAD_TPL="$REPO/tools/templates/lead-protocol.md"
AGENTS_MD_SRC="$REPO/AGENTS.md"
[ -d "$SRC" ] || { echo "canon ports/cursor not found: $SRC" >&2; exit 1; }

if [ -n "$TARGET" ]; then DEST="$TARGET/.cursor"; SCOPED=1; else DEST="$HOME/.cursor"; SCOPED=0; fi

CANON_AGENT_NAMES=()
KEPT_AGENT_OVERLAY_NAMES=()

same_agent_content() {
    [ -f "$2" ] || return 1
    diff -q <(tr -d '\r' < "$1") <(tr -d '\r' < "$2") >/dev/null 2>&1
}

rewrite_clone() {
    # stdin -> stdout, replace <clone> with absolute REPO
    sed "s|<clone>|$REPO|g"
}

write_gitignore_block() {
    local targetRoot="$1" flavor="$2" bodyText="$3" check="$4"
    local ignPath="$targetRoot/.gitignore"
    local begin="# >>> aiworkflow $flavor (managed) >>>"
    local end="# <<< aiworkflow $flavor (managed) <<<"

    local -a lines=()
    if [ -f "$ignPath" ]; then
        while IFS= read -r ln || [ -n "$ln" ]; do lines+=("$ln"); done < "$ignPath"
    fi

    local -a block=("$begin")
    if [ -n "$bodyText" ]; then
        while IFS= read -r bl; do block+=("$bl"); done <<< "$bodyText"
    fi
    block+=("$end")

    local startIdx=-1 endIdx=-1 i
    for ((i = 0; i < ${#lines[@]}; i++)); do
        if [ "$startIdx" -lt 0 ] && [ "${lines[$i]}" = "$begin" ]; then startIdx=$i; fi
        if [ "$startIdx" -ge 0 ] && [ "$endIdx" -lt 0 ] && [ "${lines[$i]}" = "$end" ]; then endIdx=$i; fi
    done

    local -a newLines=()
    if [ "$startIdx" -ge 0 ] && [ "$endIdx" -ge "$startIdx" ]; then
        if [ "$startIdx" -gt 0 ]; then newLines+=("${lines[@]:0:$startIdx}"); fi
        newLines+=("${block[@]}")
        local afterStart=$((endIdx + 1))
        if [ "$afterStart" -lt "${#lines[@]}" ]; then newLines+=("${lines[@]:$afterStart}"); fi
    elif [ "${#lines[@]}" -gt 0 ]; then
        newLines=("${lines[@]}" "" "${block[@]}")
    else
        newLines=("${block[@]}")
    fi

    local newText="" l
    for l in "${newLines[@]}"; do newText="$newText$l"$'\n'; done
    while [[ "$newText" == *$'\n\n' ]]; do newText="${newText%$'\n'}"; done

    if [ "$check" -eq 1 ]; then
        local cur=""
        [ -f "$ignPath" ] && cur="$(cat "$ignPath")"
        if [ "$cur" != "${newText%$'\n'}" ]; then echo "[check] .gitignore ($flavor block): would change"
        else echo "[check] .gitignore ($flavor block): in sync"; fi
    else
        printf '%s' "$newText" > "$ignPath"
        echo "[sync] .gitignore ($flavor managed block)"
    fi
}

echo "flavor: cursor"
echo "canon:  $SRC"
echo "dest:   $DEST  ($([ $SCOPED -eq 1 ] && echo project-scoped || echo global))"

command -v node >/dev/null 2>&1 || { echo "node not found on PATH - required to render canon agents and by hooks/rails at run time." >&2; exit 1; }
echo "node:   $(node --version)"
echo

[ $CHECK -eq 0 ] && mkdir -p "$DEST"

# --- 1. agents/: render canon fresh ---
RENDER_TMP="$(mktemp -d)"
if ! RENDER_OUT="$(node "$REPO/core/src/render/cli.ts" render --out "$RENDER_TMP" --clients cursor --canon "$CANON_ROLE_ROOT" --adapters "$ADAPTERS_ROOT" 2>&1)"; then
    rm -rf "$RENDER_TMP"
    echo "canon render failed: $RENDER_OUT" >&2
    exit 1
fi
AGENTS_SRC="$RENDER_TMP/.cursor/agents"
if [ -d "$AGENTS_SRC" ]; then
  if [ $SCOPED -eq 0 ]; then
    if [ $CHECK -eq 1 ]; then
      n=$( { diff -rq "$AGENTS_SRC" "$DEST/agents" 2>/dev/null || true; } | wc -l | tr -d ' ')
      echo "[check] agents: $n file(s) would change"
    else
      rm -rf "$DEST/agents"; mkdir -p "$DEST/agents"
      for f in "$AGENTS_SRC"/*.md; do
        [ -e "$f" ] || continue
        base="$(basename "$f")"
        rewrite_clone < "$f" > "$DEST/agents/$base"
      done
      echo "[sync] agents/ mirrored (rendered from canon)"
    fi
  else
    [ $CHECK -eq 1 ] || mkdir -p "$DEST/agents"
    changed=0
    for f in "$AGENTS_SRC"/*.md; do
      [ -e "$f" ] || continue
      base="$(basename "$f")"
      out="$DEST/agents/$base"
      CANON_AGENT_NAMES+=("$base")
      rewritten="$(rewrite_clone < "$f")"
      if [ -f "$out" ] && [ "$KEEP_AGENTS" -eq 1 ]; then
        same_agent_content "$f" "$out" || KEPT_AGENT_OVERLAY_NAMES+=("$base")
        continue
      fi
      if [ $CHECK -eq 1 ]; then
        if [ -f "$out" ] && [ "$rewritten" = "$(cat "$out")" ]; then :; else changed=$((changed + 1)); fi
      else
        printf '%s' "$rewritten" > "$out"
      fi
    done
    if [ $CHECK -eq 1 ]; then echo "[check] agents/ (project overlay): $changed file(s) would change"
    else echo "[sync] agents/ overlaid from rendered canon (project extras kept)"; fi
  fi
fi
rm -rf "$RENDER_TMP"

# --- 2. skills/ ---
if [ -d "$SRC/skills" ]; then
  [ $CHECK -eq 0 ] && mkdir -p "$DEST/skills"
  for d in "$SRC/skills"/*/; do
    [ -d "$d" ] || continue
    base="$(basename "$d")"
    skill="$d/SKILL.md"
    [ -f "$skill" ] || continue
    rewritten="$(rewrite_clone < "$skill")"
    out="$DEST/skills/$base/SKILL.md"
    if [ $CHECK -eq 1 ]; then
      if [ -f "$out" ] && [ "$rewritten" = "$(cat "$out")" ]; then st="in sync"; else st="would change"; fi
      echo "[check] skills/$base/SKILL.md: $st"
    else
      mkdir -p "$DEST/skills/$base"
      printf '%s' "$rewritten" > "$out"
    fi
  done
  [ $CHECK -eq 0 ] && echo "[sync] skills/ (<clone> -> absolute)"
fi

# --- 3. hooks.json ---
if [ -f "$SRC/hooks.json" ]; then
  rewritten="$(rewrite_clone < "$SRC/hooks.json")"
  out="$DEST/hooks.json"
  if [ $CHECK -eq 1 ]; then
    if [ -f "$out" ] && [ "$(echo "$rewritten" | tr -d '\r')" = "$(tr -d '\r' < "$out")" ]; then st="in sync"; else st="would change"; fi
    echo "[check] hooks.json: $st"
  else
    printf '%s' "$rewritten" > "$out"
    echo "[sync] hooks.json (<clone> -> absolute)"
  fi
fi

# --- 4. Lead: root AGENTS.md = SSOT (project-scoped if-absent); rule is short include, must not duplicate body ---
if [ $SCOPED -eq 1 ] && [ -f "$AGENTS_MD_SRC" ]; then
  AGENTS_MD_DST="$TARGET/AGENTS.md"
  if [ $CHECK -eq 1 ]; then
    echo "[check] AGENTS.md: $([ -f "$AGENTS_MD_DST" ] && echo 'exists (will NOT overwrite)' || echo 'would create')"
  elif [ -f "$AGENTS_MD_DST" ]; then
    echo "[keep] AGENTS.md exists in target - not overwritten"
  else
    cp "$AGENTS_MD_SRC" "$AGENTS_MD_DST"; echo "[sync] AGENTS.md -> target project"
  fi
fi

if [ -f "$LEAD_TPL" ]; then
  lead_dst="$DEST/rules/aiwf-lead.mdc"
  if [ $CHECK -eq 1 ]; then
    echo "[check] rules/aiwf-lead.mdc: $([ -f "$lead_dst" ] && echo 'exists (will NOT overwrite)' || echo 'would create')"
  elif [ -f "$lead_dst" ]; then
    echo "[keep] rules/aiwf-lead.mdc exists - not overwritten"
  else
    mkdir -p "$DEST/rules"
    rewrite_clone < "$LEAD_TPL" > "$lead_dst"
    echo "[sync] rules/aiwf-lead.mdc (short AGENTS.md include, if-absent)"
  fi
fi

# --- 5. Project .gitignore managed block ---
if [ $SCOPED -eq 1 ]; then
  IGNORE_LINES=(".cursor/skills/" ".cursor/hooks.json")
  if [ "${#CANON_AGENT_NAMES[@]}" -gt 0 ]; then
    for n in "${CANON_AGENT_NAMES[@]}"; do IGNORE_LINES+=(".cursor/agents/$n"); done
  fi
  BODY=""
  for l in "${IGNORE_LINES[@]}"; do BODY="$BODY$l"$'\n'; done
  if [ "${#KEPT_AGENT_OVERLAY_NAMES[@]}" -gt 0 ]; then
    for n in "${KEPT_AGENT_OVERLAY_NAMES[@]}"; do BODY="$BODY!.cursor/agents/$n"$'\n'; done
  fi
  BODY="${BODY%$'\n'}"
  write_gitignore_block "$TARGET" "cursor" "$BODY" "$CHECK"
fi

echo
if [ $CHECK -eq 1 ]; then
  echo "CHECK done (nothing written)."
else
  echo "CURSOR flavor installed."
  [ $SCOPED -eq 0 ] && echo "  Global: agents+skills+hooks live in ~/.cursor."
  [ $SCOPED -eq 0 ] && echo "  Per-project lead protocol: copy $REPO/AGENTS.md into a project as AGENTS.md (opt-in); rule is a short include."
  echo "  Governance: hook/rails read <target-project-cwd>/policy.yml."
  echo "  Reload Cursor (restart Agent session) for hooks.json to take effect."
fi
