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
# (`../../core/src/...`), and core/ itself is NOT copied here -> those get rewritten to the
# absolute clone path on copy (same precedent as tools/install-claude.sh; phase-b1.1). opencode.json
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

# REPO_ABS: absolute clone path used to rewrite copied .ts imports (see rewrite_core_imports_tree
# below). On Windows git-bash $REPO is MSYS-style (/c/Users/...) - fine for bash file ops, but the
# rewritten import string must be a real Windows path (C:/Users/..., forward slashes - Bun accepts
# it); cygpath -m gives exactly that. Elsewhere (linux/macos) cygpath is absent -> REPO_ABS = REPO.
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

# --- 1. mirror .opencode tree (OVERLAY: copy our files, never delete the whole dir) ---
# Subtrees clearly ours -> full sync (delete stale inside them); agents/ is rendered fresh
# from canon (A3 req 2, see render_agents_overlay below), not mirrored from a committed copy.
OURS_DIRS="tools plugins lib commands"     # our namespaces (safe to delete stale within)
TOP_FILES="AGENTS.md"                        # zonemap.yml/delegation.yml are project-scoped-only seeds (below)

# Rewrite copied .ts imports of `(../)+core/src/...` -> absolute clone `$REPO_ABS/core/src/...`
# (precedent: tools/install-claude.sh). core/ is not copied, so relative imports in the deployed
# .opencode/lib/*.ts would otherwise point into a void. Applied to a temp SHADOW of the source
# subtree before copying, so --check (diffed against the shadow) and the real copy always agree
# post-rewrite - no perpetual false drift (contract L-3).
CORE_RE='(\.\./)+core/src/'
CORE_ABS="$REPO_ABS/core/src/"
rewrite_core_imports_tree() { # $1 = dir; rewrite *.ts matching CORE_RE in place
  local d="$1" f rewritten origEpoch
  [ -d "$d" ] || return 0
  while IFS= read -r -d '' f; do
    if grep -qE "$CORE_RE" "$f" 2>/dev/null; then
      # Preserve the ORIGINAL (pre-rewrite) mtime (see install.sh for the mtime-diff-tool rationale;
      # this script's own --check uses content diff, not mtime, but keep behaviour consistent/robust).
      origEpoch="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || true)"
      rewritten="$(sed -E "s#$CORE_RE#$CORE_ABS#g" "$f")"
      printf '%s\n' "$rewritten" > "$f"
      [ -n "$origEpoch" ] && touch -d "@$origEpoch" "$f" 2>/dev/null
    fi
  done < <(find "$d" -name '*.ts' -print0)
}

sync_dir_full() { # $1 = subdir; mirror with stale-delete inside our namespace
  local sub="$1" s="$SRC/$1" d="$DEST/$1"
  [ -d "$s" ] || return 0
  local shadow; shadow="$(mktemp -d)"
  cp -Rp "$s/." "$shadow/"; rewrite_core_imports_tree "$shadow"
  if [ $CHECK -eq 1 ]; then
    local n
    if [ ! -d "$d" ]; then n=$(find "$shadow" -type f | wc -l | tr -d ' ')
    else n=$( { diff -rq "$shadow" "$d" 2>/dev/null || true; } | wc -l | tr -d ' '); fi
    echo "[check] $sub/: $n file(s) would change"
  else
    rm -rf "$d"; mkdir -p "$d"; cp -R "$shadow/." "$d/"
    echo "[sync] $sub/ mirrored"
  fi
  rm -rf "$shadow"
}

# render_agents_overlay: A3 req 2 - agents/*.md come from a fresh canon render
# (`node core/src/render/cli.ts render --out <tmp> --clients opencode`), never from
# ports/opencode/agents - a broken/missing node aborts the installer.
# OVERLAY semantics preserved (never delete a user's/project's own extra agents/*.md);
# --keep-agents freezes any file already present at dest (A3 req 4).
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

for sub in $OURS_DIRS; do sync_dir_full "$sub"; done
render_agents_overlay

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

# --- 1e. Project config seed: zonemap.yml / delegation.yml (project-scoped ONLY, A3 req 3) ---
# Seeded from the canon SKELETON, NEVER from this repo's own filled
# `.opencode/{zonemap,delegation}.yml` (FinManage's product data, not installer payload).
# An existing project file is NEVER overwritten. Global mode installs neither.
if [ $SCOPED -eq 1 ]; then
  for cfgName in zonemap delegation; do
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
