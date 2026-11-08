#!/usr/bin/env bash
# Install AI Workflow flow-layer from canon into OMP — global (~/.omp/agent) or
# project-scoped (<target>/.omp), same unified --target interface as
# install-claude.sh / install-opencode.sh (A3). POSIX port of tools/install.ps1
# (see that file's header for full rationale) — same canon, same MARKER, same
# splice semantics -> both installers are idempotent and interoperable.
#
# Installer:
#   1) mirrors tools/ hooks/ (rsync --delete - removes stale files; copied .ts files
#      importing `(../)+core/src/...` get that rewritten to the absolute clone path
#      since core/ itself is not copied - phase-b1.1);
#   1b) agents/: renders `canon/roles` + `tools/adapters/omp.yml` into a fresh temp
#      dir (`node core/src/render/cli.ts render --out <tmp> --clients omp`) and
#      installs FROM THAT RENDER, never from a committed port copy (A3 req 2 - a
#      broken/missing node aborts the installer). Global mirrors (delete stale);
#      project OVERLAYS (never deletes a project's own extra agents/*.md;
#      --keep-agents freezes any file already present at the dest);
#   2) copies RULES.md AGENTS.md WATCHDOG.md WATCHDOG.yml (global: Force-sync all;
#      project: RULES.md seed-if-absent only — never Force-overwrite; others Force);
#   3) project-scoped ONLY: seeds zonemap.yml/delegation.yml from the canon
#      SKELETON, only if the project doesn't already have one (A3 req 3);
#   4) splices the PRODUCT block into config.yml (global: `./.omp/` -> `~/.omp/agent/`;
#      project: paths stay `./.omp/` as-is), PRESERVING any existing head.
#
# Usage: tools/install.sh [--check] [--target DIR] [--keep-agents]
#   --check         Dry-run: report divergences only, write nothing.
#   --target DIR    Project-scoped install into <DIR>/.omp (default: global ~/.omp/agent).
#   --keep-agents   Project-scoped only: never overwrite an agents/*.md already at dest.
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
CANON="$REPO/ports/omp"
CANON_ROLE_ROOT="$REPO/canon"
ADAPTERS_ROOT="$REPO/tools/adapters"
# MARKER byte-identical to install.ps1 so both installers cut/splice the same block.
MARKER="# ===== AIWORKFLOW PRODUCT - managed by tools/install.ps1 (do not edit below) ====="

if [ -n "$TARGET" ]; then DEST="$TARGET/.omp"; SCOPED=1; else DEST="$HOME/.omp/agent"; SCOPED=0; fi

# Tracked while walking the project agents-overlay loop below (A3b): canon-role file names
# rendered for this flavor (always ignored by the managed .gitignore block) and, among those,
# the subset --keep-agents froze because a project overlay already existed at dest (must be
# UN-ignored via a `!` exception - it's project data, not an installer artifact).
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
# <targetRoot>/.gitignore (project-scoped installs only). Idempotent: locates its own prior block
# by the exact marker lines and replaces just that span, leaving the rest of the file (and any
# other flavor's block) untouched. $4=check ("1"/"0") reports drift only, writes nothing.
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

# REPO_ABS: absolute clone path used to rewrite copied .ts imports (see rewrite_core_imports_tree
# below). On Windows git-bash, $REPO is MSYS-style (/c/Users/...) - fine for bash file ops, but the
# rewritten import string must be a real Windows path (C:/Users/..., forward slashes - Bun accepts
# it); cygpath -m gives exactly that. Elsewhere (linux/macos) cygpath is absent -> REPO_ABS = REPO.
if command -v cygpath >/dev/null 2>&1; then
  REPO_ABS="$(cygpath -m "$REPO")"
else
  REPO_ABS="$REPO"
fi

[ -d "$CANON" ] || { echo "canon not found: $CANON" >&2; exit 1; }
[ "$CHECK" -eq 1 ] || mkdir -p "$DEST"

echo "canon:  $CANON"
echo "dest:   $DEST  ($([ $SCOPED -eq 1 ] && echo project-scoped || echo global))"
echo ""

have_rsync=0
command -v rsync >/dev/null 2>&1 && have_rsync=1

# rsync-free tree dry-run (git-bash / minimal hosts): count add/del/change between src and dst.
# Mirror semantics = rsync -a --delete: added (src-only) + deleted (dst-only) + changed (cmp differs).
# Prints "<n> file(s) would change" to match the rsync -i branch's count line.
tree_diff_count() {
    local src="$1" dst="$2" srcList dstList n=0 rel
    srcList="$(cd "$src" && find . -type f | sed 's#^\./##' | LC_ALL=C sort)"
    dstList=""
    [ -d "$dst" ] && dstList="$(cd "$dst" && find . -type f | sed 's#^\./##' | LC_ALL=C sort)"
    # added (src-only) + deleted (dst-only). grep '[^[:space:]]' skips comm's tab-only phantom
    # line that an empty dstList would inject (real paths always have non-space chars).
    n=$(comm -3 <(printf '%s\n' "$srcList") <(printf '%s\n' "$dstList") | grep -c '[^[:space:]]' || true)
    # changed among common paths (content differs)
    while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        cmp -s "$src/$rel" "$dst/$rel" || n=$((n + 1))
    done < <(comm -12 <(printf '%s\n' "$srcList") <(printf '%s\n' "$dstList"))
    echo "$n"
}

# Rewrite copied .ts imports of `(../)+core/src/...` -> absolute clone `$REPO_ABS/core/src/...`
# (precedent: tools/install-claude.sh). core/ is not copied, so relative imports in the deployed
# tools/_lib/*.ts would otherwise point into a void. Applied to a temp SHADOW of the canon tree
# before mirroring, so --check (diffed against the shadow) and the real copy always agree post-
# rewrite - no perpetual false drift (contract L-3).
CORE_RE='(\.\./)+core/src/'
CORE_ABS="$REPO_ABS/core/src/"
rewrite_core_imports_tree() { # $1 = dir; rewrite *.ts matching CORE_RE in place
    local d="$1" f rewritten origEpoch
    [ -d "$d" ] || return 0
    while IFS= read -r -d '' f; do
        if grep -qE "$CORE_RE" "$f" 2>/dev/null; then
            # Preserve the ORIGINAL (pre-rewrite) mtime: a plain `> "$f"` write stamps "now", which
            # would make an mtime-aware diff (rsync's default quick check) flag this file as
            # "changed" forever - both at real-install time and at every later --check - even when
            # the rewritten content is byte-identical to what's already installed - perpetual false
            # drift (contract L-3). Restoring the source's own mtime keeps it deterministic instead.
            origEpoch="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || true)"
            rewritten="$(sed -E "s#$CORE_RE#$CORE_ABS#g" "$f")"
            printf '%s\n' "$rewritten" > "$f"
            [ -n "$origEpoch" ] && touch -d "@$origEpoch" "$f" 2>/dev/null
        fi
    done < <(find "$d" -name '*.ts' -print0)
}

SHADOW_ROOT="$(mktemp -d)"
trap 'rm -rf "$SHADOW_ROOT"' EXIT

# --- 1. Mirror tools/hooks (agents are handled separately in 1b, from canon render) ---
for t in tools hooks; do
    src="$CANON/$t"
    dst="$DEST/$t"
    [ -d "$src" ] || continue
    shadow="$SHADOW_ROOT/$t"
    mkdir -p "$shadow"; cp -Rp "$src/." "$shadow/"
    rewrite_core_imports_tree "$shadow"
    if [ "$CHECK" -eq 1 ]; then
        if [ "$have_rsync" -eq 1 ]; then
            n=$(rsync -a --delete -n -i "$shadow/" "$dst/" 2>/dev/null | grep -c . || true)
            echo "[check] $t: $n file(s) would change"
        else
            n=$(tree_diff_count "$shadow" "$dst")
            echo "[check] $t: $n file(s) would change (rsync-free diff)"
        fi
    else
        if [ "$have_rsync" -eq 1 ]; then
            rsync -a --delete "$shadow/" "$dst/"
        else
            rm -rf "$dst"; mkdir -p "$dst"; cp -R "$shadow/." "$dst/"
        fi
        echo "[sync] $t/ mirrored"
    fi
done

# --- 1b. Agents: render canon fresh (A3 req 2 - never install from a committed port copy) ---
command -v node >/dev/null 2>&1 || { echo "node not found on PATH - required to render canon agents (core/src/render/cli.ts)" >&2; exit 1; }

RENDER_TMP="$(mktemp -d)"
if ! RENDER_OUT="$(node "$REPO/core/src/render/cli.ts" render --out "$RENDER_TMP" --clients omp --canon "$CANON_ROLE_ROOT" --adapters "$ADAPTERS_ROOT" 2>&1)"; then
    rm -rf "$RENDER_TMP"
    echo "canon render failed: $RENDER_OUT" >&2
    exit 1
fi

AGENTS_SRC="$RENDER_TMP/.omp/agents"
AGENTS_DST="$DEST/agents"
if [ -d "$AGENTS_SRC" ]; then
    if [ "$SCOPED" -eq 0 ]; then
        # Global: full mirror (delete stale) - same semantics install.sh always had.
        if [ "$CHECK" -eq 1 ]; then
            if [ "$have_rsync" -eq 1 ]; then
                n=$(rsync -a --delete -n -i "$AGENTS_SRC/" "$AGENTS_DST/" 2>/dev/null | grep -c . || true)
                echo "[check] agents: $n file(s) would change"
            else
                n=$(tree_diff_count "$AGENTS_SRC" "$AGENTS_DST")
                echo "[check] agents: $n file(s) would change (rsync-free diff)"
            fi
        else
            if [ "$have_rsync" -eq 1 ]; then
                rsync -a --delete "$AGENTS_SRC/" "$AGENTS_DST/"
            else
                rm -rf "$AGENTS_DST"; mkdir -p "$AGENTS_DST"; cp -R "$AGENTS_SRC/." "$AGENTS_DST/"
            fi
            echo "[sync] agents/ mirrored (rendered from canon)"
        fi
    else
        # Project: OVERLAY - never delete a project's own extra agents/*.md (A3 req 4).
        # --keep-agents freezes ANY file already present at dest (canon-named or not).
        [ "$CHECK" -eq 1 ] || mkdir -p "$AGENTS_DST"
        changed=0
        for f in "$AGENTS_SRC"/*.md; do
            [ -e "$f" ] || continue
            base="$(basename "$f")"
            out="$AGENTS_DST/$base"
            CANON_AGENT_NAMES+=("$base")
            if [ -f "$out" ] && [ "$KEEP_AGENTS" -eq 1 ]; then
                same_agent_content "$f" "$out" || KEPT_AGENT_OVERLAY_NAMES+=("$base")
                continue
            fi
            if [ "$CHECK" -eq 1 ]; then
                if [ -f "$out" ] && cmp -s "$f" "$out"; then :; else changed=$((changed + 1)); fi
            else
                cp -f "$f" "$out"
            fi
        done
        if [ "$CHECK" -eq 1 ]; then echo "[check] agents/ (project overlay): $changed file(s) would change"
        else echo "[sync] agents/ overlaid from rendered canon (project extras kept)"; fi
    fi
fi
rm -rf "$RENDER_TMP"

# --- 2. Copy md files ---
# RULES.md: global Force-sync (sole protocol copy). Project: seed-if-absent only
# (no cp -f) so an existing project RULES is kept — avoids dual-load overwrite.
for f in RULES.md AGENTS.md WATCHDOG.md WATCHDOG.yml; do
    src="$CANON/$f"
    [ -f "$src" ] || continue
    dst="$DEST/$f"
    if [ "$SCOPED" -eq 1 ] && [ "$f" = "RULES.md" ]; then
        if [ -f "$dst" ]; then
            if [ "$CHECK" -eq 1 ]; then echo "[check] $f: exists - kept (no Force overwrite)"
            else echo "[keep] $f: exists - kept (no Force overwrite)"; fi
        elif [ "$CHECK" -eq 1 ]; then
            echo "[check] $f: ABSENT -> would seed once"
        else
            cp "$src" "$dst"
            echo "[sync] $f (seeded once)"
        fi
        continue
    fi
    if [ "$CHECK" -eq 1 ]; then
        if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
            echo "[check] $f: would change"
        else
            echo "[check] $f: in sync"
        fi
    else
        cp -f "$src" "$dst"
        echo "[sync] $f"
    fi
done

# --- 3. Project config seed: zonemap.yml / delegation.yml (project-scoped ONLY, A3 req 3) ---
# Seeded from the canon SKELETON, NEVER from this repo's own filled
# `.omp/{zonemap,delegation}.yml` (FinManage's product data, not installer payload).
# An existing project file is NEVER overwritten. Global mode installs neither.
if [ "$SCOPED" -eq 1 ]; then
    for cfgName in zonemap delegation; do
        src="$CANON_ROLE_ROOT/$cfgName.yml"
        dst="$DEST/$cfgName.yml"
        if [ -f "$dst" ]; then
            if [ "$CHECK" -eq 1 ]; then echo "[check] $cfgName.yml: exists - kept (never overwritten)"
            else echo "[keep] $cfgName.yml: exists - kept (never overwritten)"; fi
        elif [ "$CHECK" -eq 1 ]; then
            echo "[check] $cfgName.yml: ABSENT -> would seed from canon skeleton"
        else
            cp "$src" "$dst"
            echo "[sync] $cfgName.yml <- canon skeleton (seeded; fill in-project)"
        fi
    done
fi

# --- 4. Splice PRODUCT block into config.yml ---
canonCfg="$CANON/config.yml"
destCfg="$DEST/config.yml"
[ -f "$canonCfg" ] || { echo "canon config.yml not found" >&2; exit 1; }

grep -q '^extensions:' "$canonCfg" || { echo "canon config.yml has no 'extensions:'" >&2; exit 1; }

# product body = canon from first 'extensions:' line to EOF. Global: tilde paths
# (`./.omp/` -> `~/.omp/agent/`). Project: paths stay `./.omp/` as-is (A3 req 1).
if [ "$SCOPED" -eq 1 ]; then
    productBody="$(awk '/^extensions:/{f=1} f' "$canonCfg")"
else
    productBody="$(awk '/^extensions:/{f=1} f' "$canonCfg" | sed 's#\./\.omp/#~/.omp/agent/#g')"
fi

# head = dest config up to first of {MARKER, top-level 'extensions:'}, then strip
# trailing blank/divider lines (mirror ps1 TrimEnd + divider trim). $() drops trailing NLs.
headText=""
if [ -f "$destCfg" ]; then
    headText="$(awk -v m="$MARKER" '$0==m || /^extensions:/{exit} {print}' "$destCfg" \
        | awk '{a[NR]=$0} END{n=NR; while(n>0 && (a[n] ~ /^[[:space:]]*$/ || a[n] ~ /^#[[:space:]]*={3,}/)) n--; for(i=1;i<=n;i++) print a[i]}')"
fi

if [ -n "$headText" ]; then
    newCfg="$(printf '%s\n\n%s\n%s' "$headText" "$MARKER" "$productBody")"
else
    newCfg="$(printf '%s\n%s' "$MARKER" "$productBody")"
fi

if [ "$CHECK" -eq 1 ]; then
    cur="$(cat "$destCfg" 2>/dev/null || true)"
    if [ "$cur" != "$newCfg" ]; then
        echo "[check] config.yml: would change (product block rebuilt)"
    else
        echo "[check] config.yml: in sync"
    fi
else
    # UTF-8 as-is, single trailing newline, no BOM (YAML parsers dislike BOM).
    printf '%s\n' "$newCfg" > "$destCfg"
    echo "[sync] config.yml: product block rebuilt (head preserved)"
fi

# --- 5. Project .gitignore managed block (A3b, project-scoped ONLY) ---
# Ignores installed FLAVOR artifacts (tools/hooks/RULES/AGENTS/WATCHDOG/config.yml + canon-named
# agents/*.md); never ignores project data (zonemap.yml/delegation.yml, non-canon agent overlays,
# or a canon-named overlay --keep-agents froze - that gets an explicit `!` exception above).
if [ "$SCOPED" -eq 1 ]; then
    IGNORE_LINES=(".omp/tools/" ".omp/hooks/" ".omp/RULES.md" ".omp/AGENTS.md" ".omp/WATCHDOG.md" ".omp/WATCHDOG.yml" ".omp/config.yml")
    if [ "${#CANON_AGENT_NAMES[@]}" -gt 0 ]; then
        for n in "${CANON_AGENT_NAMES[@]}"; do IGNORE_LINES+=(".omp/agents/$n"); done
    fi
    BODY=""
    for l in "${IGNORE_LINES[@]}"; do BODY="$BODY$l"$'\n'; done
    if [ "${#KEPT_AGENT_OVERLAY_NAMES[@]}" -gt 0 ]; then
        for n in "${KEPT_AGENT_OVERLAY_NAMES[@]}"; do BODY="$BODY!.omp/agents/$n"$'\n'; done
    fi
    BODY="${BODY%$'\n'}"
    write_gitignore_block "$TARGET" "omp" "$BODY" "$CHECK"
fi

echo ""
if [ "$CHECK" -eq 1 ]; then
    echo "CHECK done (nothing written)."
elif [ "$SCOPED" -eq 1 ]; then
    echo "INSTALL done. Verify: run omp from inside the project - it sees <target>/.omp."
else
    echo "INSTALL done. Verify: omp in a project sees the global tools."
fi
