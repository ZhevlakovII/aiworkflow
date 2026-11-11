#!/usr/bin/env bash
# install-opencode.sh - install the AI Workflow OPENCODE flavor (POSIX; twin of install-claude.sh).
#
# Deploys the .opencode layer (TS custom-tools + plugins + subagents + slash-commands + AGENTS.md
# + delegation.yml/zonemap.yml) plus opencode.json so OpenCode (TUI/Desktop) auto-discovers them.
# Default target = user-global ~/.config/opencode; --target <dir> stamps <dir>/.opencode
# (project-scoped) and writes <dir>/opencode.json.
#
# TS tools use PATH binaries (git/gh/claude/opencode/codex/ast-index) at run time -> no rewrite
# needed for those. BUT `.opencode/lib/*.ts` re-export from `core/src/...` via relative imports
# (`(../)+core/src/...`). Install vendors core/src into <dest>/core/src and rewrites those
# imports file-relative via tools/install-runtime.ts (not absolute clone). opencode.json
# is MERGED (permission + instructions spliced, existing user keys preserved) via python.
#
# agents/*.md are NOT copied verbatim from `ports/opencode/agents` (A3 req 2):
# every install renders `canon/roles` + `tools/adapters/opencode.yml` into a fresh temp dir (`node
# core/src/render/cli.ts render --out <tmp> --clients opencode`) and installs FROM THAT RENDER - a
# broken/missing node aborts the installer, no silent fallback. Copy is an OVERLAY (no dir-wide
# delete) because the global config dir shares its namespace with the user's own agents;
# --keep-agents freezes any file already present at dest (A3 req 4).
#
# zonemap.yml/delegation.yml are project-scoped ONLY (A3 req 3): seeded from the canon SKELETON
# (`canon/{zonemap,delegation}.yml`) ONLY if the project doesn't already have one - an existing
# file is NEVER overwritten. Global mode installs neither (this repo's own filled
# `.opencode/{zonemap,delegation}.yml` are FinManage's product data, never copied by this installer).
#
#   bash tools/install-opencode.sh --check              # dry-run
#   bash tools/install-opencode.sh                       # global ~/.config/opencode
#   bash tools/install-opencode.sh --target /path/proj   # project-scoped <proj>/.opencode
#   bash tools/install-opencode.sh --target /path/proj --keep-agents   # never overwrite existing agents/*.md
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
SRC="$REPO/ports/opencode"
SRC_JSON="$REPO/ports/opencode/opencode.json"
CANON_ROLE_ROOT="$REPO/canon"
ADAPTERS_ROOT="$REPO/tools/adapters"
[ -d "$SRC" ] || { echo "ports/opencode not found: $SRC" >&2; exit 1; }
[ -f "$SRC_JSON" ] || { echo "ports/opencode/opencode.json not found: $SRC_JSON" >&2; exit 1; }

# DEST_ABS / REPO_ABS for install-runtime (cygpath on git-bash when present).
if command -v cygpath >/dev/null 2>&1; then
  REPO_ABS="$(cygpath -m "$REPO")"
else
  REPO_ABS="$REPO"
fi

if [ -n "$TARGET" ]; then
  DEST="$TARGET/.opencode"; JSON_DST="$TARGET/opencode.json"; SCOPED=1
else
  DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"; JSON_DST="$DEST/opencode.json"; SCOPED=0
fi
AGENTS_DST="$DEST/AGENTS.md"
PY="$(command -v python3 || command -v python)"

# Tracked by render_agents_overlay below (A3b): see install.sh for rationale. Not `local` -
# render_agents_overlay is a function but these two names are deliberately global so the
# gitignore step (project-scoped only) can read them after the call.
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

echo "flavor: opencode"
echo "ports/opencode SRC:  $SRC"
echo "dest:   $DEST  ($([ $SCOPED -eq 1 ] && echo project-scoped || echo global))"
echo

[ $CHECK -eq 0 ] && mkdir -p "$DEST"

if command -v cygpath >/dev/null 2>&1; then
  DEST_ABS="$(cygpath -m "$DEST")"
else
  DEST_ABS="$DEST"
fi
RUNTIME_TS="$REPO/tools/install-runtime.ts"

invoke_install_runtime() {
  node "$RUNTIME_TS" "$@" || { echo "install-runtime failed: $*" >&2; exit 1; }
}

invoke_aiwf_vendor() {
  if [ "$CHECK" -eq 1 ]; then
    echo "[check] would vendor core/src -> $DEST_ABS/core/src"
  else
    invoke_install_runtime vendor --repo "$REPO_ABS" --dest "$DEST_ABS"
  fi
}

new_import_rewritten_shadow() {
  local srcDir="$1" relUnder="$2" shadowRoot shadowSub parent
  shadowRoot="$(mktemp -d)"
  shadowSub="$shadowRoot/$relUnder"
  parent="$(dirname "$shadowSub")"
  mkdir -p "$parent"
  cp -Rp "$srcDir/." "$shadowSub/"
  invoke_install_runtime rewrite-imports --dest "$shadowRoot" --under "$shadowSub"
  printf '%s' "$shadowRoot"
}

# --- 1. mirror .opencode tree (OVERLAY: copy our files, never delete the whole dir) ---
OURS_DIRS="tools plugins lib commands"
TOP_FILES="AGENTS.md"

sync_dir_full() {
  local sub="$1" s="$SRC/$1" d="$DEST/$1" shaped_root shadow
  [ -d "$s" ] || return 0
  shaped_root="$(new_import_rewritten_shadow "$s" "$sub")"
  shadow="$shaped_root/$sub"
  if [ $CHECK -eq 1 ]; then
    local n
    if [ ! -d "$d" ]; then n=$(find "$shadow" -type f | wc -l | tr -d ' ')
    else n=$( { diff -rq "$shadow" "$d" 2>/dev/null || true; } | wc -l | tr -d ' '); fi
    echo "[check] $sub/: $n file(s) would change"
  else
    rm -rf "$d"; mkdir -p "$d"; cp -R "$shadow/." "$d/"
    echo "[sync] $sub/ mirrored"
  fi
  rm -rf "$shaped_root"
}

# render_agents_overlay: A3 req 2 - agents/*.md from fresh canon render.
render_agents_overlay() {
  command -v node >/dev/null 2>&1 || { echo "node not found on PATH - required to render canon agents (core/src/render/cli.ts)" >&2; exit 1; }
  local renderTmp; renderTmp="$(mktemp -d)"
  local renderOut
  if ! renderOut="$(node "$REPO/core/src/render/cli.ts" render --out "$renderTmp" --clients opencode --canon "$CANON_ROLE_ROOT" --adapters "$ADAPTERS_ROOT" 2>&1)"; then
    rm -rf "$renderTmp"
    echo "canon render failed: $renderOut" >&2
    exit 1
  fi
  local agentsSrc="$renderTmp/.opencode/agents" d="$DEST/agents"
  if [ -d "$agentsSrc" ]; then
    [ $CHECK -eq 1 ] || mkdir -p "$d"
    local chg=0 f base out
    for f in "$agentsSrc"/*.md; do
      [ -e "$f" ] || continue
      base="$(basename "$f")"
      out="$d/$base"
      CANON_AGENT_NAMES+=("$base")
      if [ -f "$out" ] && [ "$KEEP_AGENTS" -eq 1 ]; then
        same_agent_content "$f" "$out" || KEPT_AGENT_OVERLAY_NAMES+=("$base")
        continue
      fi
      if [ $CHECK -eq 1 ]; then
        if [ -f "$out" ] && cmp -s "$f" "$out"; then :; else chg=$((chg+1)); fi
      else
        cp -f "$f" "$out"
      fi
    done
    if [ $CHECK -eq 1 ]; then echo "[check] agents/ (overlay): $chg file(s) would change"
    else echo "[sync] agents/ overlaid from rendered canon (user/project files kept)"; fi
  fi
  rm -rf "$renderTmp"
}

# Port-static oneshot agents after live render (AD-opencode-native-oneshot).
stamp_oneshot_agents() {
  local d="$DEST/agents" name s out chg=0
  for name in aiwf-oneshot.md aiwf-reason.md; do
    s="$SRC/agents/$name"
    [ -f "$s" ] || continue
    out="$d/$name"
    if [ -f "$out" ] && [ "$KEEP_AGENTS" -eq 1 ]; then
      same_agent_content "$s" "$out" || KEPT_AGENT_OVERLAY_NAMES+=("$name")
      continue
    fi
    if [ $CHECK -eq 1 ]; then
      if [ -f "$out" ] && cmp -s "$s" "$out"; then :; else chg=$((chg+1)); fi
    else
      mkdir -p "$d"
      cp -f "$s" "$out"
    fi
  done
  if [ $CHECK -eq 1 ]; then echo "[check] agents/ (oneshot static): $chg file(s) would change"
  else echo "[sync] agents/ oneshot static (aiwf-oneshot, aiwf-reason)"; fi
}

invoke_aiwf_vendor
for sub in $OURS_DIRS; do sync_dir_full "$sub"; done
if [ "$CHECK" -eq 0 ]; then
  ri_args=(rewrite-imports --dest "$DEST_ABS")
  for sub in $OURS_DIRS; do
    [ -d "$DEST/$sub" ] && ri_args+=(--under "$DEST_ABS/$sub")
  done
  if [ "${#ri_args[@]}" -gt 3 ]; then
    invoke_install_runtime "${ri_args[@]}"
  fi
fi
render_agents_overlay
stamp_oneshot_agents

# top-level files (AGENTS.md; zonemap/delegation are project-scoped-only seeds, below)
for f in $TOP_FILES; do
  [ -f "$SRC/$f" ] || continue
  if [ $CHECK -eq 1 ]; then
    if [ -f "$DEST/$f" ] && diff -q "$SRC/$f" "$DEST/$f" >/dev/null 2>&1; then st="in sync"; else st="would change"; fi
    echo "[check] $f: $st"
  else
    cp "$SRC/$f" "$DEST/$f"
  fi
done
[ $CHECK -eq 0 ] && echo "[sync] AGENTS.md"

# --- 1e. Project config seed: delegation.yml only (zonemap NOT seeded) (project-scoped ONLY, A3 req 3) ---
# Seeded from the canon SKELETON, NEVER from this repo's own filled
# `.opencode/{zonemap,delegation}.yml` (FinManage's product data, not installer payload).
# An existing project file is NEVER overwritten. Global mode installs neither.
if [ $SCOPED -eq 1 ]; then
  for cfgName in delegation; do
    s="$CANON_ROLE_ROOT/$cfgName.yml"
    d="$DEST/$cfgName.yml"
    if [ -f "$d" ]; then
      if [ $CHECK -eq 1 ]; then echo "[check] $cfgName.yml: exists - kept (never overwritten)"
      else echo "[keep] $cfgName.yml: exists - kept (never overwritten)"; fi
    elif [ $CHECK -eq 1 ]; then
      echo "[check] $cfgName.yml: ABSENT -> would seed from canon skeleton"
    else
      cp "$s" "$d"
      echo "[sync] $cfgName.yml <- canon skeleton (seeded; fill in-project)"
    fi
  done
fi

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

# --- 3. Project .gitignore managed block (A3b, project-scoped ONLY) ---
# Ignores installed FLAVOR artifacts (tools/plugins/lib/commands, AGENTS.md, opencode.json, canon-
# named agents/*.md); never ignores project data (zonemap.yml/delegation.yml, non-canon agent
# overlays, or a canon-named overlay --keep-agents froze - explicit `!` exception above).
if [ $SCOPED -eq 1 ]; then
  IGNORE_LINES=(".opencode/tools/" ".opencode/plugins/" ".opencode/lib/" ".opencode/commands/" ".opencode/AGENTS.md" "opencode.json")
  if [ "${#CANON_AGENT_NAMES[@]}" -gt 0 ]; then
    for n in "${CANON_AGENT_NAMES[@]}"; do IGNORE_LINES+=(".opencode/agents/$n"); done
  fi
  BODY=""
  for l in "${IGNORE_LINES[@]}"; do BODY="$BODY$l"$'\n'; done
  if [ "${#KEPT_AGENT_OVERLAY_NAMES[@]}" -gt 0 ]; then
    for n in "${KEPT_AGENT_OVERLAY_NAMES[@]}"; do BODY="$BODY!.opencode/agents/$n"$'\n'; done
  fi
  BODY="${BODY%$'\n'}"
  write_gitignore_block "$TARGET" "opencode" "$BODY" "$CHECK"
fi

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
