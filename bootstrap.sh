#!/usr/bin/env bash
# bootstrap.sh - one-liner installer for AI Workflow (macos/linux).
#
#   curl -fsSL https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.sh | bash
#   curl -fsSL .../bootstrap.sh | bash -s -- --yes
#   curl -fsSL .../bootstrap.sh | bash -s -- --install=node,git
#   curl -fsSL .../bootstrap.sh | bash -s -- --flow claude
#   curl -fsSL .../bootstrap.sh | bash -s -- --flow cursor
#   curl -fsSL .../bootstrap.sh | bash -s -- --flow dsh
#   curl -fsSL .../bootstrap.sh | bash -s -- --target /proj
#   curl -fsSL .../bootstrap.sh | bash -s -- --what-if
#   curl -fsSL .../bootstrap.sh | bash -s -- -h
#
# Lifecycle (AD-bootstrap-download-delete):
#   1) Resolve release pin from AIWF_RELEASE (empty|latest|tag|https zip URL)
#   2) Download aiworkflow-install.zip + neighbor .sha256 over HTTPS (GitHub host allowlist)
#   3) Verify SHA-256 of the zip BEFORE extract / stamp; on fail retain partial + print path
#   4) Extract to a temp install cache (not flavor dest, not ~/.config/aiwf, not ~/.aiworkflow)
#   5) Run tools/setup.sh from that cache with forwarded flags
#   6) On setup success ONLY: delete zip + extracted cache tree
#   7) On failure: retain cache and print its path
# Existing ~/.aiworkflow is NEVER deleted (may be a developer working copy).
# No git clone as install runtime root.
#
# Pin (AIWF_RELEASE):
#   empty or "latest"  -> GitHub Releases latest assets
#   tag (no scheme)    -> same two assets for that release tag
#   https URL          -> zip URL; host allowlist only; SHA from same-release neighbor .sha256
#
# Flow set matches live setup: omp|claude|opencode|cursor|dsh|all|both
#   default all includes cursor + dsh; both = omp+claude+opencode (no cursor).
# Setup flags are forwarded (parsed here only for --help / --what-if).
set -euo pipefail

OWNER_REPO="ZhevlakovII/aiworkflow"
ZIP_NAME="aiworkflow-install.zip"
SHA_NAME="aiworkflow-install.zip.sha256"

show_help() {
  cat <<'EOF'
bootstrap.sh - download + verify + setup AI Workflow (macos/linux)

Usage:
  bootstrap.sh [setup-flags...] [--what-if] [-h|--help]

Flow (parity with tools/setup.sh), via --flow:
  omp | claude | opencode | cursor | dsh | all | both
  default: all  (includes cursor and dsh)
  both = omp+claude+opencode only (no cursor)

Forwarded setup flags (examples):
  --yes / -y, --skip-smoke, --install=node,git, --flow <name>,
  --target <dir>, --keep-agents, --default-roles, --check

Release pin via env AIWF_RELEASE:
  (empty) | latest     latest GitHub Release assets
  <tag>                release tag assets (no URL scheme)
  https://.../aiworkflow-install.zip
                       HTTPS zip URL; host must be GitHub allowlist;
                       SHA from neighbor .sha256 asset (same release)

Lifecycle:
  download zip+sha256 -> verify SHA-256 -> extract cache -> setup from cache
  -> delete cache only on success; on failure retain + print path
  Does not delete existing ~/.aiworkflow. No git-clone install root.

--what-if: print resolved URLs and cache plan; do not download or stamp.
EOF
}

WHAT_IF=0
SETUP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      show_help
      exit 0
      ;;
    --what-if|--whatif|-WhatIf)
      WHAT_IF=1
      ;;
    *)
      SETUP_ARGS+=("$1")
      ;;
  esac
  shift
done

host_allowed() {
  case "$1" in
    github.com|release-assets.githubusercontent.com|objects.githubusercontent.com|github-releases.githubusercontent.com)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Sets ZIP_URL SHA_URL LABEL MODE
resolve_release_urls() {
  local pin="${AIWF_RELEASE:-}"
  pin="${pin#"${pin%%[![:space:]]*}"}"
  pin="${pin%"${pin##*[![:space:]]}"}"

  if [ -z "$pin" ] || [ "$pin" = "latest" ]; then
    local base="https://github.com/${OWNER_REPO}/releases/latest/download"
    ZIP_URL="${base}/${ZIP_NAME}"
    SHA_URL="${base}/${SHA_NAME}"
    LABEL="latest"
    MODE="latest"
    return 0
  fi

  case "$pin" in
    *://*)
      case "$pin" in
        https://*) ;;
        *)
          echo "ERROR: AIWF_RELEASE URL must be https (refused: $pin)" >&2
          return 2
          ;;
      esac
      # parse host + path without requiring Python
      local rest="${pin#https://}"
      local host="${rest%%/*}"
      local path_qs="/${rest#*/}"
      local path="${path_qs%%\?*}"
      if ! host_allowed "$host"; then
        echo "ERROR: AIWF_RELEASE host '$host' not in allowlist (github.com, release-assets.githubusercontent.com, objects.githubusercontent.com, github-releases.githubusercontent.com)" >&2
        return 2
      fi
      case "$path" in
        */aiworkflow-install.zip|*/aiworkflow-install.zip/)
          ;;
        *)
          echo "ERROR: AIWF_RELEASE path must name ${ZIP_NAME} (got: $path)" >&2
          return 2
          ;;
      esac
      case "$pin" in
        *.sha256|*.sha256\?*|*.sha256\#*)
          echo "ERROR: AIWF_RELEASE must point at ${ZIP_NAME}, not the .sha256 asset" >&2
          return 2
          ;;
      esac
      ZIP_URL="$pin"
      # neighbor .sha256: insert before query string if present
      if [[ "$pin" == *"?"* ]]; then
        local base_u="${pin%%\?*}"
        local qs="${pin#*\?}"
        SHA_URL="${base_u}.sha256?${qs}"
      else
        SHA_URL="${pin}.sha256"
      fi
      LABEL="$pin"
      MODE="url"
      return 0
      ;;
  esac

  # tag pin (no scheme)
  case "$pin" in
    *[[:space:]]*|*/*|*\\*)
      echo "ERROR: AIWF_RELEASE tag looks invalid: $pin" >&2
      return 2
      ;;
  esac
  local base="https://github.com/${OWNER_REPO}/releases/download/${pin}"
  ZIP_URL="${base}/${ZIP_NAME}"
  SHA_URL="${base}/${SHA_NAME}"
  LABEL="tag:${pin}"
  MODE="tag"
}

sha256_file() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$f" | awk '{print tolower($NF)}'
  else
    echo "ERROR: need sha256sum, shasum, or openssl to verify download" >&2
    return 1
  fi
}

published_sum() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo "ERROR: missing sha256 sidecar: $f" >&2
    return 1
  fi
  local line
  line="$(tr -d '\r' <"$f" | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [ -z "$line" ]; then
    echo "ERROR: empty sha256 sidecar: $f" >&2
    return 1
  fi
  local hex
  hex="$(printf '%s\n' "$line" | awk '{print tolower($1)}')"
  if ! printf '%s' "$hex" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "ERROR: sha256 sidecar is not 64 hex: $f" >&2
    return 1
  fi
  printf '%s\n' "$hex"
}

download_file() {
  local url="$1" out="$2"
  echo "  GET $url" >&2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --location --retry 3 --retry-delay 1 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$out" "$url"
  else
    echo "ERROR: need curl or wget to download install assets" >&2
    return 1
  fi
  if [ ! -f "$out" ]; then
    echo "ERROR: download produced no file: $out" >&2
    return 1
  fi
}

find_payload_root() {
  local extract_dir="$1"
  if [ -f "$extract_dir/tools/setup.sh" ]; then
    printf '%s\n' "$extract_dir"
    return 0
  fi
  local d
  for d in "$extract_dir"/*; do
    if [ -d "$d" ] && [ -f "$d/tools/setup.sh" ]; then
      printf '%s\n' "$d"
      return 0
    fi
  done
  echo "ERROR: extracted zip has no tools/setup.sh under $extract_dir" >&2
  return 1
}

cache_root() {
  if [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s\n' "${XDG_CACHE_HOME}/aiwf-install"
  else
    printf '%s\n' "${HOME}/.cache/aiwf-install"
  fi
}

ZIP_URL=""; SHA_URL=""; LABEL=""; MODE=""
if ! resolve_release_urls; then
  exit 2
fi

CACHE_ROOT="$(cache_root)"
CACHE_ID="$(date +%Y%m%d%H%M%S)-$$-${RANDOM:-0}"
CACHE_DIR="${CACHE_ROOT}/${CACHE_ID}"
ZIP_PATH="${CACHE_DIR}/${ZIP_NAME}"
SHA_PATH="${CACHE_DIR}/${SHA_NAME}"
EXTRACT_DIR="${CACHE_DIR}/extract"

# Best-effort flow label for logs (setup still owns validation)
FLOW_LOG="all"
i=0
while [ $i -lt ${#SETUP_ARGS[@]} ]; do
  a="${SETUP_ARGS[$i]}"
  case "$a" in
    --flow=*) FLOW_LOG="${a#--flow=}" ;;
    --flow)
      i=$((i + 1))
      FLOW_LOG="${SETUP_ARGS[$i]:-all}"
      ;;
  esac
  i=$((i + 1))
done

echo "== AI Workflow bootstrap =="
echo "release: ${LABEL}"
echo "flow:    ${FLOW_LOG} (setup args forwarded as-is)"
echo "cache:   ${CACHE_DIR}"
echo "zip:     ${ZIP_URL}"
echo "sha256:  ${SHA_URL}"

if [ "$WHAT_IF" -eq 1 ]; then
  echo ""
  echo "WhatIf: would download zip+sha256, verify SHA-256, extract to cache,"
  echo "        run tools/setup.sh from cache with forwarded flags, then"
  echo "        delete cache only on setup success; retain+print path on failure."
  echo "        Existing ~/.aiworkflow is never deleted. No git clone."
  exit 0
fi

mkdir -p "$CACHE_DIR"
STAMP_OK=0

cleanup_msg() {
  if [ "$STAMP_OK" -ne 1 ]; then
    echo "setup/stamp failed or interrupted; retained cache: ${CACHE_DIR}" >&2
  fi
}
trap cleanup_msg EXIT

echo "== downloading install assets =="
if ! download_file "$ZIP_URL" "$ZIP_PATH"; then
  echo "retained cache (partial): ${CACHE_DIR}" >&2
  exit 1
fi
if ! download_file "$SHA_URL" "$SHA_PATH"; then
  echo "retained cache (partial): ${CACHE_DIR}" >&2
  exit 1
fi

echo "== verifying SHA-256 =="
EXPECTED="$(published_sum "$SHA_PATH")" || {
  echo "refusing extract/stamp; retained: ${CACHE_DIR}" >&2
  echo "  zip: ${ZIP_PATH}" >&2
  exit 1
}
ACTUAL="$(sha256_file "$ZIP_PATH")" || {
  echo "refusing extract/stamp; retained: ${CACHE_DIR}" >&2
  echo "  zip: ${ZIP_PATH}" >&2
  exit 1
}
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "ERROR: SHA-256 mismatch: expected ${EXPECTED}, got ${ACTUAL}" >&2
  echo "refusing extract/stamp; retained: ${CACHE_DIR}" >&2
  echo "  zip: ${ZIP_PATH}" >&2
  exit 1
fi
echo "SHA-256 OK (${ACTUAL})"

echo "== extracting to cache =="
mkdir -p "$EXTRACT_DIR"
if command -v unzip >/dev/null 2>&1; then
  unzip -q -o "$ZIP_PATH" -d "$EXTRACT_DIR"
elif command -v bsdtar >/dev/null 2>&1; then
  bsdtar -xf "$ZIP_PATH" -C "$EXTRACT_DIR"
elif command -v tar >/dev/null 2>&1 && tar -tf "$ZIP_PATH" >/dev/null 2>&1; then
  tar -xf "$ZIP_PATH" -C "$EXTRACT_DIR"
else
  # python fallback (stdlib zipfile)
  python - "$ZIP_PATH" "$EXTRACT_DIR" <<'PY'
import sys, zipfile
z, d = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(z) as zf:
    zf.extractall(d)
PY
fi

PAYLOAD_ROOT="$(find_payload_root "$EXTRACT_DIR")"
SETUP_SH="${PAYLOAD_ROOT}/tools/setup.sh"
echo "payload: ${PAYLOAD_ROOT}"

if [ ! -f "$SETUP_SH" ]; then
  echo "ERROR: missing ${SETUP_SH}" >&2
  echo "retained cache: ${CACHE_DIR}" >&2
  exit 1
fi
chmod +x "$SETUP_SH" 2>/dev/null || true

echo "== running tools/setup.sh from cache =="
# Prereq prompts still work under curl|bash when setup reads /dev/tty.
set +e
bash "$SETUP_SH" "${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "ERROR: setup exited with code ${rc}" >&2
  echo "retained cache: ${CACHE_DIR}" >&2
  exit "$rc"
fi

STAMP_OK=1
trap - EXIT

echo "== stamp OK; deleting install cache =="
if rm -rf "$CACHE_DIR"; then
  echo "cache removed: ${CACHE_DIR}"
else
  echo "WARN: could not fully delete cache at ${CACHE_DIR}" >&2
fi
echo "bootstrap done (flow: ${FLOW_LOG})."
exit 0
