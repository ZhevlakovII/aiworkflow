#!/usr/bin/env bash
# setup.sh - ALL-IN-ONE installer for AI Workflow (linux/macos). POSIX twin of tools/setup.ps1.
#
# Wraps install.sh with four extra steps:
#   1) prereq detection (OMP/Node/git/ast-index; opt Claude/Java/codex) + INTERACTIVE install via
#      the platform package manager (brew on macos; apt/dnf/pacman/zypper on linux; npm for codex);
#   2) machine-head bootstrap - seed ~/.omp/agent/{models.yml, config.yml modelRoles} from tools/templates/
#      ONLY when absent (never overwrite a real machine-head);
#   2b) modelRoles bind - interactively pick a model per role from the REAL models.yml, validate,
#       notify on unset/unknown roles (setup_roles.ts). --default-roles = non-interactive defaults;
#   3) install.sh - deploy product (preserves machine-head);
#   4) post-install load-smoke (omp -p exit 0).
#
# Usage:
#   bash tools/setup.sh --check            # dry-run (writes nothing; lists what is installable)
#   bash tools/setup.sh                     # full install (prompts per missing installable prereq)
#   bash tools/setup.sh --yes               # non-interactive: install every installable missing prereq
#   bash tools/setup.sh --install=node,git  # install only the named prereqs (no prompt), skip the rest
#   bash tools/setup.sh --install-missing   # alias of --yes (back-compat)
#   bash tools/setup.sh --skip-smoke        # skip load-smoke
#   bash tools/setup.sh --default-roles     # bind modelRoles non-interactively (defaults from models.yml)
set -euo pipefail

CHECK=0; YES=0; SKIP_SMOKE=0; DEFAULT_ROLES=0; INSTALL_LIST=""
for a in "$@"; do
    case "$a" in
        --check)           CHECK=1 ;;
        --yes|-y)          YES=1 ;;
        --install-missing) YES=1 ;;            # back-compat: now = "yes to all installable"
        --install=*)       INSTALL_LIST="${a#--install=}" ;;
        --skip-smoke)      SKIP_SMOKE=1 ;;
        --default-roles)   DEFAULT_ROLES=1 ;;
        *) echo "unknown arg: $a" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
CANON="$REPO/.omp"
GLOBAL="$HOME/.omp/agent"
TEMPLATES="$SCRIPT_DIR/templates"

echo "=== AI Workflow setup ==="
echo "canon:  $CANON"
echo "global: $GLOBAL"
echo ""

# --- package manager detection ---
detect_pm() {
    case "$(uname -s)" in
        Darwin) command -v brew >/dev/null 2>&1 && echo brew ;;
        Linux)  for m in apt-get dnf pacman zypper; do command -v "$m" >/dev/null 2>&1 && { echo "$m"; return; }; done ;;
    esac
}
PM="$(detect_pm)"

# pkg_for <cmd> -> prints the concrete install command line for the detected PM (empty = no recipe).
# omp/ast-index/claude have no unattended package recipe -> hint only (printed in the loop).
pkg_for() {
    case "$1" in
        codex) command -v npm >/dev/null 2>&1 && echo "npm i -g @openai/codex"; return ;;  # needs node/npm, PM-agnostic
    esac
    [ -n "$PM" ] || return 0
    case "$1:$PM" in
        node:brew)     echo "brew install node" ;;
        node:apt-get)  echo "sudo apt-get update && sudo apt-get install -y nodejs npm" ;;
        node:dnf)      echo "sudo dnf install -y nodejs" ;;
        node:pacman)   echo "sudo pacman -S --noconfirm nodejs npm" ;;
        node:zypper)   echo "sudo zypper install -y nodejs npm" ;;
        git:brew)      echo "brew install git" ;;
        git:apt-get)   echo "sudo apt-get update && sudo apt-get install -y git" ;;
        git:dnf)       echo "sudo dnf install -y git" ;;
        git:pacman)    echo "sudo pacman -S --noconfirm git" ;;
        git:zypper)    echo "sudo zypper install -y git" ;;
        java:brew)     echo "brew install openjdk@21" ;;
        java:apt-get)  echo "sudo apt-get update && sudo apt-get install -y openjdk-21-jdk" ;;
        java:dnf)      echo "sudo dnf install -y java-21-openjdk-devel" ;;
        java:pacman)   echo "sudo pacman -S --noconfirm jdk21-openjdk" ;;
        java:zypper)   echo "sudo zypper install -y java-21-openjdk-devel" ;;
    esac
}

# --- 1. Prereqs ---
# fields: name|cmd|verargs|required|hint
prereqs=(
    "OMP (oh-my-pi)|omp|--version|1|https://omp.sh (native binary)"
    "Node.js >=24|node|--version|1|use nvm or distro pkg"
    "Claude CLI (opt)|claude|--version|0|https://claude.ai/code (not npm; ToS-safe worker; needed only for claude delegation backend)"
    "git|git|--version|1|apt/brew install git"
    "ast-index|ast-index|version|1|install ast-index CLI (Track A discovery)"
    "Java 21 (opt)|java|-version|0|only for KMP target (gradle test-cmd)"
    "codex (opt)|codex|--version|0|npm i -g @openai/codex + codex login"
)

echo "--- prereqs ---  (package manager: ${PM:-none detected})"
missing_required=""
for row in "${prereqs[@]}"; do
    IFS='|' read -r name cmd verarg required hint <<< "$row"
    if command -v "$cmd" >/dev/null 2>&1; then
        ver="$("$cmd" $verarg 2>&1 | head -n1 || true)"
        [ -z "$ver" ] && ver="(installed)"
        printf '  [ok]      %-16s %s\n' "$name" "$ver"
        continue
    fi

    # missing: decide whether to install it via the package manager
    if [ "$required" = "1" ]; then tag="[MISSING]"; else tag="[absent] "; fi
    cmdline="$(pkg_for "$cmd")"

    if [ -z "$cmdline" ]; then
        printf '  %s %-16s -> %s\n' "$tag" "$name" "$hint"       # no recipe: hint only
        [ "$required" = "1" ] && [ "$CHECK" = "0" ] && missing_required="$missing_required $name"
        continue
    fi

    if [ "$CHECK" = "1" ]; then
        printf '  %s %-16s -> installable: %s\n' "$tag" "$name" "$cmdline"
        continue
    fi

    printf '  %s %-16s -> %s\n' "$tag" "$name" "$hint"

    want=0
    if [ -n "$INSTALL_LIST" ]; then
        case ",$INSTALL_LIST," in *",$cmd,"*) want=1 ;; esac      # explicit list = install only these
    elif [ "$YES" = "1" ]; then
        want=1
    elif [ -t 0 ]; then
        printf '            install via [%s] ? [y/N] ' "$cmdline"
        read -r ans </dev/tty || ans=""
        case "$ans" in y|Y|yes|YES) want=1 ;; esac
    fi

    if [ "$want" = "1" ]; then
        echo "            \$ $cmdline"
        if sh -c "$cmdline"; then echo "            installed."; else echo "            install FAILED (do it manually: $hint)"; fi
        command -v "$cmd" >/dev/null 2>&1 || { [ "$required" = "1" ] && missing_required="$missing_required $name"; }
    elif [ "$required" = "1" ]; then
        missing_required="$missing_required $name"
    fi
done
echo ""
echo "  LM Studio (opt): cheap local lead - endpoint in ~/.omp/agent/models.yml (see bootstrap below)."
echo ""

if [ -n "$missing_required" ] && [ "$CHECK" = "0" ]; then
    echo "ABORT: missing required prereqs:$missing_required" >&2
    echo "Install them (hints above) and re-run. Use --yes to auto-install installable ones." >&2
    exit 1
fi

# --- 2. Machine-head bootstrap (seed ONLY when absent) ---
modelsDst="$GLOBAL/models.yml"
cfgDst="$GLOBAL/config.yml"
modelsTpl="$TEMPLATES/models.yml.example"
headTpl="$TEMPLATES/machine-head.yml.example"
MARKER='# ===== AIWORKFLOW PRODUCT'

has_model_roles() {
    # true if a modelRoles: line exists in the head (above MARKER) of $1.
    [ -f "$1" ] || return 1
    awk -v m="$MARKER" 'index($0,m)==1{exit} /^[[:space:]]*modelRoles[[:space:]]*:/{found=1; exit} END{exit !found}' "$1"
}

seedModels=0; [ -f "$modelsDst" ] || seedModels=1
seedHead=0;   has_model_roles "$cfgDst" || seedHead=1

echo "--- machine-head ---"
if [ "$CHECK" = "1" ]; then
    if [ "$seedModels" = "1" ]; then echo "  models.yml: ABSENT   -> would seed from template"; else echo "  models.yml: present  -> keep"; fi
    if [ "$seedHead" = "1" ];   then echo "  modelRoles: ABSENT   -> would seed from template"; else echo "  modelRoles: present  -> keep"; fi
    echo ""
else
    mkdir -p "$GLOBAL"
    if [ "$seedModels" = "1" ]; then
        cp "$modelsTpl" "$modelsDst"
        echo "  [seed] models.yml <- template (EDIT endpoint/model for your machine!)"
    else echo "  [keep] models.yml present - untouched"; fi
    if [ "$seedHead" = "1" ]; then
        if [ -f "$cfgDst" ]; then
            tmp="$(mktemp)"; { cat "$headTpl"; printf '\n'; cat "$cfgDst"; } > "$tmp"; mv "$tmp" "$cfgDst"
        else
            cp "$headTpl" "$cfgDst"
        fi
        echo "  [seed] config.yml modelRoles <- template (Qwen cheap-default)"
    else echo "  [keep] modelRoles present - untouched"; fi
    echo ""
fi

# --- 2b. modelRoles bind: pick per-role model from the REAL models.yml (interactive) + validate ---
rolesTool="$SCRIPT_DIR/setup_roles.ts"
echo "--- modelRoles ---"
if ! command -v node >/dev/null 2>&1; then
    echo "  [skip] node absent - cannot bind/validate modelRoles."
elif [ "$CHECK" = "1" ]; then
    node "$rolesTool" --check --config "$cfgDst" --models "$modelsDst"      # report only
elif [ "$DEFAULT_ROLES" = "1" ]; then
    node "$rolesTool" --defaults --config "$cfgDst" --models "$modelsDst"   # non-interactive defaults
else
    node "$rolesTool" --config "$cfgDst" --models "$modelsDst"             # interactive per-role pick
fi
echo ""

# --- 3. install.sh (deploy product; preserves machine-head) ---
echo "--- install.sh ---"
if [ "$CHECK" = "1" ]; then bash "$SCRIPT_DIR/install.sh" --check; else bash "$SCRIPT_DIR/install.sh"; fi
echo ""

# --- 4. Load-smoke ---
if [ "$CHECK" = "1" ]; then echo "CHECK done (nothing written; smoke skipped)."; exit 0; fi
if [ "$SKIP_SMOKE" = "1" ]; then echo "SETUP done (load-smoke skipped)."; exit 0; fi
echo "--- load-smoke (omp -p) ---"
if ! command -v omp >/dev/null 2>&1; then echo "omp absent - smoke skipped."; exit 0; fi
if omp -p "Reply exactly: LOADED" --yolo >/dev/null 2>&1; then
    echo "  [ok] omp loaded config+customTools+hooks (exit 0)."
    echo ""; echo "SETUP done."
else
    echo "  [warn] omp smoke non-zero - check config."
    echo ""; echo "SETUP done with warning."
fi
