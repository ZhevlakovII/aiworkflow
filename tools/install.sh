#!/usr/bin/env bash
# Install AI Workflow flow-layer from canon (<repo>/.omp) into global OMP (~/.omp/agent).
#
# POSIX port of tools/install.ps1 (linux/macos). Same canon, same MARKER, same splice
# semantics -> re-running either installer is idempotent and interoperable.
#
# Prod layout (P9 2026-08-29): product ships as GLOBAL OMP config, not a per-repo junction.
# Canon = <repo>/.omp (git). Installer:
#   1) mirrors tools/ hooks/ agents/ (rsync --delete - removes stale files);
#   2) copies RULES.md AGENTS.md WATCHDOG.md WATCHDOG.yml;
#   3) splices the PRODUCT block into ~/.omp/agent/config.yml (paths ./.omp/ -> ~/.omp/agent/,
#      tilde because relative paths resolve against CWD not the config file), PRESERVING the
#      machine-head (modelRoles/theme/...).
# Project <repo>/.omp/config.yml + zonemap.yml are untouched (OMP merges them per-key on top).
#
# Usage: tools/install.sh [--check]
#   --check   Dry-run: report divergences only, write nothing.
set -euo pipefail

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
CANON="$REPO/.omp"
GLOBAL="$HOME/.omp/agent"
# MARKER byte-identical to install.ps1 so both installers cut/splice the same block.
MARKER="# ===== AIWORKFLOW PRODUCT - managed by tools/install.ps1 (do not edit below) ====="

[ -d "$CANON" ] || { echo "canon not found: $CANON" >&2; exit 1; }
mkdir -p "$GLOBAL"

echo "canon:  $CANON"
echo "global: $GLOBAL"
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

# --- 1. Mirror trees (tools/hooks/agents) ---
for t in tools hooks agents; do
    src="$CANON/$t"
    dst="$GLOBAL/$t"
    [ -d "$src" ] || continue
    if [ "$CHECK" -eq 1 ]; then
        if [ "$have_rsync" -eq 1 ]; then
            n=$(rsync -a --delete -n -i "$src/" "$dst/" 2>/dev/null | grep -c . || true)
            echo "[check] $t: $n file(s) would change"
        else
            n=$(tree_diff_count "$src" "$dst")
            echo "[check] $t: $n file(s) would change (rsync-free diff)"
        fi
    else
        if [ "$have_rsync" -eq 1 ]; then
            rsync -a --delete "$src/" "$dst/"
        else
            rm -rf "$dst"; mkdir -p "$dst"; cp -R "$src/." "$dst/"
        fi
        echo "[sync] $t/ mirrored"
    fi
done

# --- 2. Copy md files ---
for f in RULES.md AGENTS.md WATCHDOG.md WATCHDOG.yml; do
    src="$CANON/$f"
    [ -f "$src" ] || continue
    dst="$GLOBAL/$f"
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

# --- 3. Splice PRODUCT block into global config.yml ---
canonCfg="$CANON/config.yml"
globalCfg="$GLOBAL/config.yml"
[ -f "$canonCfg" ] || { echo "canon config.yml not found" >&2; exit 1; }

grep -q '^extensions:' "$canonCfg" || { echo "canon config.yml has no 'extensions:'" >&2; exit 1; }

# product body = canon from first 'extensions:' line to EOF, with tilde paths.
productBody="$(awk '/^extensions:/{f=1} f' "$canonCfg" | sed 's#\./\.omp/#~/.omp/agent/#g')"

# machine-head = global up to first of {MARKER, top-level 'extensions:'}, then strip
# trailing blank/divider lines (mirror ps1 TrimEnd + divider trim). $() drops trailing NLs.
headText=""
if [ -f "$globalCfg" ]; then
    headText="$(awk -v m="$MARKER" '$0==m || /^extensions:/{exit} {print}' "$globalCfg" \
        | awk '{a[NR]=$0} END{n=NR; while(n>0 && (a[n] ~ /^[[:space:]]*$/ || a[n] ~ /^#[[:space:]]*={3,}/)) n--; for(i=1;i<=n;i++) print a[i]}')"
fi

if [ -n "$headText" ]; then
    newCfg="$(printf '%s\n\n%s\n%s' "$headText" "$MARKER" "$productBody")"
else
    newCfg="$(printf '%s\n%s' "$MARKER" "$productBody")"
fi

if [ "$CHECK" -eq 1 ]; then
    cur="$(cat "$globalCfg" 2>/dev/null || true)"
    if [ "$cur" != "$newCfg" ]; then
        echo "[check] config.yml: would change (product block rebuilt)"
    else
        echo "[check] config.yml: in sync"
    fi
else
    # UTF-8 as-is, single trailing newline, no BOM (YAML parsers dislike BOM).
    printf '%s\n' "$newCfg" > "$globalCfg"
    echo "[sync] config.yml: product block rebuilt (machine-head preserved)"
fi

echo ""
if [ "$CHECK" -eq 1 ]; then
    echo "CHECK done (nothing written)."
else
    echo "INSTALL done. Verify: omp in a project sees the global tools."
fi
