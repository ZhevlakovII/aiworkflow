#!/usr/bin/env bash
# install-claude.sh - install the AI Workflow CLAUDE-CODE flavor (POSIX twin of install-claude.ps1).
#
# Deploys the .claude layer (subagents + slash-commands + enforcement hooks) so Claude Code
# sees them. Default target = user-global ~/.claude; --target <dir> stamps <dir>/.claude
# (project-scoped) and copies root AGENTS.md if-absent (never overwrites). Tool/hook paths rewritten to absolute clone paths;
# hooks are cwd-aware so one global copy serves every project. settings.json is MERGED
# (hooks + permissions.deny spliced, existing keys preserved) via node (core/src/ops/merge-settings.ts).
#
# The enforcement PreToolUse hook is the TS command-hook shim (core/src/shim/command-hook.ts);
# the L1-L3 rails (core/src/rails/cli.ts) are invoked by the copied slash-commands. Both run
# on Node's native TS strip (Node >=22.6 or >=23) - the old python zone-guard.py / gated_*.py /
# zone_check.py rails are retired (zone-check ported to core/src/zone/zone-check-cli.ts), and
# so is the design-stage driver (design_stage.py/gate_setup.py/claude_worker.py/gate_lint.py,
# ported to core/src/design/*-cli.ts) - no copied slash-command shells out to python anymore.
# The PostToolUse telemetry hook is also TS now (core/src/ops/telemetry-hook.ts, ported from
# .claude/hooks/telemetry.py); the settings.json merge step below also runs on node now
# (core/src/ops/merge-settings.ts) - this installer needs no python at all (T7-6 L-3).
#
#   bash tools/install-claude.sh --check              # dry-run
#   bash tools/install-claude.sh                       # global ~/.claude
#   bash tools/install-claude.sh --target /path/proj   # project-scoped
#   bash tools/install-claude.sh --target /path/proj --keep-agents   # never overwrite existing agents/*.md
#
# Agents/*.md are NOT copied verbatim from the committed `.claude/agents` port copy
# (A3 req 2): every install renders `canon/roles` + `tools/adapters/claude.yml` into a
# fresh temp dir (`node core/src/render/cli.ts render --out <tmp> --clients claude`) and
# installs FROM THAT RENDER - a broken/missing node aborts the installer, no silent
# fallback. Global mirrors (delete stale); project OVERLAYS (never deletes a project's
# own extra agents/*.md; --keep-agents freezes any file already present at dest - A3 req 4).
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
SRC="$REPO/ports/claude"
CANON_ROLE_ROOT="$REPO/canon"
ADAPTERS_ROOT="$REPO/tools/adapters"
[ -d "$SRC" ] || { echo "canon .claude not found: $SRC" >&2; exit 1; }

if [ -n "$TARGET" ]; then DEST="$TARGET/.claude"; SCOPED=1; else DEST="$HOME/.claude"; SCOPED=0; fi

# Tracked while walking the project agents-overlay loop below (A3b): see install.sh for rationale.
CANON_AGENT_NAMES=()
KEPT_AGENT_OVERLAY_NAMES=()

# A3b fix: a --keep-agents-frozen canon-named file is a REAL project overlay (needs the `!`
# un-ignore exception) only if its content actually differs from the freshly rendered canon
# file - a byte-identical (CRLF/LF-insensitive) kept file is just a plain canon copy from a
# prior install and should stay ignored.
same_agent_content() { # $1 src $2 dst
    [ -f "$2" ] || return 1
    diff -q <(tr -d '\r' < "$1") <(tr -d '\r' < "$2") >/dev/null 2>&1
}

# A3b: writes/replaces the managed `# >>> aiworkflow <flavor> (managed) >>> ... <<<` block in
# <targetRoot>/.gitignore (project-scoped installs only). See install.sh for full rationale.
write_gitignore_block() { # $1 targetRoot $2 flavor $3 bodyText (no begin/end markers) $4 check
    local targetRoot="$1" flavor="$2" bodyText="$3" check="$4"
    local ignPath="$targetRoot/.gitignore"
    local begin="# >>> aiworkflow $flavor (managed) >>>"
    local end="# <<< aiworkflow $flavor (managed) <<<"

    # Read the existing file into an array of lines (line-array reconstruction, NOT string
    # concat via `$(...)` - command substitution silently eats leading/trailing blank lines,
    # which made an earlier string-based version of this function grow an extra blank line
    # between blocks on every re-run when this flavor's block wasn't the last one in the file
    # - a perpetual-drift bug, contract L-3). Every line (incl. blanks) becomes one array slot.
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
    while [[ "$newText" == *$'\n\n' ]]; do newText="${newText%$'\n'}"; done   # TrimEnd -> exactly one trailing \n

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

echo "flavor: claude-code"
echo "canon:  $SRC"
echo "dest:   $DEST  ($([ $SCOPED -eq 1 ] && echo project-scoped || echo global))"

# node is required at run time by the PreToolUse hook (command-hook.ts) and the L1-L3
# rails (rails/cli.ts) - both run via `node <script>.ts` (native TS strip, Node >=22.6/23) -
# and now ALSO at install-time to render canon agents (A3 req 2) - hard requirement, no
# silent fallback (a missing/broken node must abort the installer, not skip agents).
command -v node >/dev/null 2>&1 || { echo "node not found on PATH - required to render canon agents (core/src/render/cli.ts) and by the PreToolUse hook/rails at run time (native TS strip, Node >=22.6 or >=23)." >&2; exit 1; }
echo "node:   $(node --version)"
echo

[ $CHECK -eq 0 ] && mkdir -p "$DEST"

# --- 1. agents/: render canon fresh (A3 req 2 - never install from a committed port copy) ---
RENDER_TMP="$(mktemp -d)"
if ! RENDER_OUT="$(node "$REPO/core/src/render/cli.ts" render --out "$RENDER_TMP" --clients claude --canon "$CANON_ROLE_ROOT" --adapters "$ADAPTERS_ROOT" 2>&1)"; then
    rm -rf "$RENDER_TMP"
    echo "canon render failed: $RENDER_OUT" >&2
    exit 1
fi
AGENTS_SRC="$RENDER_TMP/.claude/agents"
if [ -d "$AGENTS_SRC" ]; then
  if [ $SCOPED -eq 0 ]; then
    # Global: full mirror (delete stale) - same semantics this installer always had.
    if [ $CHECK -eq 1 ]; then
      n=$( { diff -rq "$AGENTS_SRC" "$DEST/agents" 2>/dev/null || true; } | wc -l | tr -d ' ')
      echo "[check] agents: $n file(s) would change"
    else
      rm -rf "$DEST/agents"; mkdir -p "$DEST/agents"; cp -R "$AGENTS_SRC/." "$DEST/agents/"
      echo "[sync] agents/ mirrored (rendered from canon)"
    fi
  else
    # Project: OVERLAY - never delete a project's own extra agents/*.md (A3 req 4).
    # --keep-agents freezes ANY file already present at dest (canon-named or not).
    [ $CHECK -eq 1 ] || mkdir -p "$DEST/agents"
    changed=0
    for f in "$AGENTS_SRC"/*.md; do
      [ -e "$f" ] || continue
      base="$(basename "$f")"
      out="$DEST/agents/$base"
      CANON_AGENT_NAMES+=("$base")
      if [ -f "$out" ] && [ "$KEEP_AGENTS" -eq 1 ]; then
        same_agent_content "$f" "$out" || KEPT_AGENT_OVERLAY_NAMES+=("$base")
        continue
      fi
      if [ $CHECK -eq 1 ]; then
        if [ -f "$out" ] && cmp -s "$f" "$out"; then :; else changed=$((changed + 1)); fi
      else
        cp -f "$f" "$out"
      fi
    done
    if [ $CHECK -eq 1 ]; then echo "[check] agents/ (project overlay): $changed file(s) would change"
    else echo "[sync] agents/ overlaid from rendered canon (project extras kept)"; fi
  fi
fi
rm -rf "$RENDER_TMP"

# --- 2. commands/ (rewrite `python tools/X.py` and `$CLAUDE_PROJECT_DIR/core/` -> absolute clone path) ---
if [ -d "$SRC/commands" ]; then
  [ $CHECK -eq 0 ] && mkdir -p "$DEST/commands"
  for f in "$SRC/commands"/*.md; do
    base="$(basename "$f")"
    rewritten="$(sed -E "s|python tools/([^ ]+\.py)|python \"$REPO/tools/\1\"|g" "$f" | sed "s|\$CLAUDE_PROJECT_DIR/core/|$REPO/core/|g")"
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

# --- 3. settings.json MERGE (hooks + permissions.deny; preserve existing keys) via node ---
# (core/src/ops/merge-settings.ts - dedupe by tag substrings so re-run REPLACES a stale
# entry instead of duplicating: "zone-guard" catches the old python hook, "command-hook"
# catches a prior TS install; "telemetry" likewise for PostToolUse.)
SET_DST="$DEST/settings.json"
HOOK_CMD="node \"$REPO/core/src/shim/command-hook.ts\" claude"
TEL="node \"$REPO/core/src/ops/telemetry-hook.ts\""
MERGE_ARGS=("$SET_DST" "$HOOK_CMD" "$TEL")
[ $CHECK -eq 1 ] && MERGE_ARGS+=(--check)
node "$REPO/core/src/ops/merge-settings.ts" "${MERGE_ARGS[@]}"

# --- 4. AGENTS.md (project-scoped only; global skips to avoid ambient rules) ---
if [ $SCOPED -eq 1 ] && [ -f "$REPO/AGENTS.md" ]; then
  AGENTS_MD_DST="$TARGET/AGENTS.md"
  if [ $CHECK -eq 1 ]; then
    echo "[check] AGENTS.md: $([ -f "$AGENTS_MD_DST" ] && echo 'exists (will NOT overwrite)' || echo 'would create')"
  elif [ -f "$AGENTS_MD_DST" ]; then
    echo "[keep] AGENTS.md exists in target - not overwritten"
  else
    cp "$REPO/AGENTS.md" "$AGENTS_MD_DST"; echo "[sync] AGENTS.md -> target project"
  fi
fi

# --- 5. Project .gitignore managed block (A3b, project-scoped ONLY) ---
# Ignores installed FLAVOR artifacts (commands/, settings.json + canon-named agents/*.md); never
# ignores project data (a canon-named overlay --keep-agents froze gets an explicit `!` exception;
# AGENTS.md is a project-owned seed, never touched here).
if [ $SCOPED -eq 1 ]; then
  IGNORE_LINES=(".claude/commands/" ".claude/settings.json")
  if [ "${#CANON_AGENT_NAMES[@]}" -gt 0 ]; then
    for n in "${CANON_AGENT_NAMES[@]}"; do IGNORE_LINES+=(".claude/agents/$n"); done
  fi
  BODY=""
  for l in "${IGNORE_LINES[@]}"; do BODY="$BODY$l"$'\n'; done
  if [ "${#KEPT_AGENT_OVERLAY_NAMES[@]}" -gt 0 ]; then
    for n in "${KEPT_AGENT_OVERLAY_NAMES[@]}"; do BODY="$BODY!.claude/agents/$n"$'\n'; done
  fi
  BODY="${BODY%$'\n'}"
  write_gitignore_block "$TARGET" "claude" "$BODY" "$CHECK"
fi

echo
if [ $CHECK -eq 1 ]; then
  echo "CHECK done (nothing written)."
else
  echo "CLAUDE-CODE flavor installed."
  [ $SCOPED -eq 0 ] && echo "  Per-project lead protocol: copy $REPO/AGENTS.md into a project as AGENTS.md (opt-in)."
  echo "  Governance: the hook/rails read <target-project-cwd>/policy.yml (git-tracked, per-project)."
  echo "  No policy.yml in a target project -> NOT deny-all: falls back to profile 'assist' (interactive) or 'guarded' (headless/CI)."
  echo "  That default is a reasonable fail-closed floor, not a copy of this repo's own policy.yml (repo-specific quality_gate.cmd/protected paths) -"
  echo "  copy $REPO/policy.yml into a target project yourself and adjust it if you want the guarded-with-protected-extras profile this repo runs."
  echo "  Reload Claude Code (restart session) for settings.json hooks to take effect."
fi
