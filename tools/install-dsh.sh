#!/usr/bin/env bash
# install-dsh.sh — stamp AI Workflow DSH Cordis plugin + project overlay (.dsh-aiwf/).
#
#   bash tools/install-dsh.sh --check
#   bash tools/install-dsh.sh --profile headless --target /path/proj
#   bash tools/install-dsh.sh --with-xai-oauth   # documents oauth patch stanza only
set -euo pipefail

CHECK=0
PROFILE="headless"
TARGET=""
WITH_XAI_OAUTH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --profile=*) PROFILE="${1#*=}" ;;
    --profile) shift; PROFILE="${1:-headless}" ;;
    --target=*) TARGET="${1#*=}" ;;
    --target) shift; TARGET="${1:-}" ;;
    --with-xai-oauth) WITH_XAI_OAUTH=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO/ports/dsh"
FRAG="$SRC/cordis.patch.fragment.yml"
CANON_ROLE_ROOT="$REPO/canon"
ADAPTERS_ROOT="$REPO/tools/adapters"

[ -d "$SRC" ] || { echo "ports/dsh not found: $SRC" >&2; exit 1; }

if command -v cygpath >/dev/null 2>&1; then
  REPO_ABS="$(cygpath -m "$REPO")"
else
  REPO_ABS="$REPO"
fi

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_DEST="$PROFILE_DIR/plugins/aiwf"
PATCH_DST="$PROFILE_DIR/cordis.patch.yml"
OVERLAY=""
if [ -n "$TARGET" ]; then
  OVERLAY="$TARGET/.dsh-aiwf"
fi

RUNTIME_TS="$REPO/tools/install-runtime.ts"
invoke_install_runtime() {
  node "$RUNTIME_TS" "$@" || { echo "install-runtime failed: $*" >&2; exit 1; }
}

echo "flavor: dsh"
echo "SRC:     $SRC"
echo "plugin:  $PLUGIN_DEST"
echo "patch:   $PATCH_DST"
echo "overlay: ${OVERLAY:-<none> (pass --target for project overlay)}"
echo

new_import_rewritten_shadow() {
  local srcDir="$1" shadowRoot
  shadowRoot="$(mktemp -d)"
  cp -Rp "$srcDir/." "$shadowRoot/"
  invoke_install_runtime rewrite-imports --dest "$shadowRoot" --under "$shadowRoot" >&2
  printf '%s' "$shadowRoot"
}

mirror_plugin() {
  local shadow
  shadow="$(new_import_rewritten_shadow "$SRC")"
  if [ "$CHECK" -eq 1 ]; then
    echo "[check] would vendor core/src -> $PLUGIN_DEST/core/src"
    if [ -d "$PLUGIN_DEST" ]; then
      echo "[check] plugin: $(diff -rq "$shadow" "$PLUGIN_DEST" 2>/dev/null | wc -l) diff lines"
    else
      echo "[check] plugin: would create $PLUGIN_DEST"
    fi
  else
    mkdir -p "$PLUGIN_DEST"
    invoke_install_runtime vendor --repo "$REPO_ABS" --dest "$PLUGIN_DEST"
    cp -Rp "$shadow/." "$PLUGIN_DEST/"
    invoke_install_runtime rewrite-imports --dest "$PLUGIN_DEST" --under "$PLUGIN_DEST"
    echo "[sync] plugin -> $PLUGIN_DEST"
  fi
  rm -rf "$shadow"
}

merge_patch_fragment() {
  local tmp merged
  tmp="$(mktemp)"
  cp "$FRAG" "$tmp"
  if [ "$WITH_XAI_OAUTH" -eq 1 ]; then
    cat >> "$tmp" <<'OAUTH'

# optional (install flag --with-xai-oauth): third-party provider plugin; operator runs login separately
oauth_plugin_hint:
  npm: dsh-llm-xai-oauth@0.2.0
OAUTH
  fi
  if [ "$CHECK" -eq 1 ]; then
    if [ -f "$PATCH_DST" ] && grep -q 'aiwf-dsh' "$PATCH_DST" 2>/dev/null; then
      echo "[check] cordis.patch.yml: aiwf block present"
    else
      echo "[check] cordis.patch.yml: would merge aiwf fragment"
    fi
  else
    mkdir -p "$PROFILE_DIR"
    if [ -f "$PATCH_DST" ]; then
      if ! grep -q 'aiwf-dsh' "$PATCH_DST" 2>/dev/null; then
        printf '\n# --- aiworkflow dsh (managed) ---\n' >> "$PATCH_DST"
        cat "$tmp" >> "$PATCH_DST"
      fi
    else
      cp "$tmp" "$PATCH_DST"
    fi
    echo "[sync] cordis.patch.yml merged ($PATCH_DST)"
  fi
  rm -f "$tmp"
}

render_agents_overlay() {
  [ -n "$OVERLAY" ] || return 0
  local tmp out="$OVERLAY"
  tmp="$(mktemp -d)"
  if ! node "$REPO/core/src/render/cli.ts" render --out "$tmp" --clients dsh --canon "$CANON_ROLE_ROOT" --adapters "$ADAPTERS_ROOT" 2>/dev/null; then
    echo "render failed (node core/src/render/cli.ts)" >&2
    exit 1
  fi
  if [ "$CHECK" -eq 1 ]; then
    echo "[check] overlay: would render agents into $out"
    rm -rf "$tmp"
    return 0
  fi
  mkdir -p "$out"
  for f in AGENTS.md RULES.md WATCHDOG.md WATCHDOG.yml; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$out/$f"
  done
  if [ -d "$tmp/agents" ]; then
    mkdir -p "$out/agents"
    cp -Rp "$tmp/agents/." "$out/agents/"
  fi
  for seed in delegation.yml; do
    dst="$out/$seed"
    if [ ! -f "$dst" ]; then
      src_seed="$REPO/canon/${seed}"
      [ -f "$src_seed" ] && cp "$src_seed" "$dst" || cp "$SRC/$seed" "$dst"
      echo "[seed] $dst"
    fi
  done
  rm -rf "$tmp"
  echo "[sync] overlay -> $out"
}

mirror_plugin
merge_patch_fragment
render_agents_overlay

echo "done (check=$CHECK)"
