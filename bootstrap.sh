#!/usr/bin/env bash
# bootstrap.sh - one-liner installer for AI Workflow (macos/linux).
#
#   curl -fsSL https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.sh | bash
#   curl -fsSL .../bootstrap.sh | bash -s -- --yes          # non-interactive prereq install
#   curl -fsSL .../bootstrap.sh | bash -s -- --install=node,git
#   curl -fsSL .../bootstrap.sh | bash -s -- --flow claude  # only the Claude Code flavor (~/.claude)
#
# Clones (or updates) the public repo into ~/.aiworkflow, then runs tools/setup.sh, forwarding
# any flags. Prereq prompts read from /dev/tty, so they still work under the curl|bash pipe.
# Override target dir / source with AIWORKFLOW_HOME / AIWORKFLOW_REPO env vars.
set -euo pipefail

REPO_URL="${AIWORKFLOW_REPO:-https://github.com/ZhevlakovII/aiworkflow.git}"
DEST="${AIWORKFLOW_HOME:-$HOME/.aiworkflow}"

if ! command -v git >/dev/null 2>&1; then
    echo "git is required to fetch AI Workflow. Install git (mac: 'brew install git') and re-run." >&2
    exit 1
fi

if [ -d "$DEST/.git" ]; then
    echo "== updating $DEST =="
    git -C "$DEST" fetch --depth 1 origin main
    git -C "$DEST" reset --hard origin/main
else
    echo "== cloning $REPO_URL -> $DEST =="
    git clone --depth 1 "$REPO_URL" "$DEST"
fi

cd "$DEST"
echo "== running tools/setup.sh =="
exec bash tools/setup.sh "$@"
