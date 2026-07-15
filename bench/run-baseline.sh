#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Honor an exported HOST_BIN (custom serve-webrtc build) like run-impaired.sh/grid.sh,
# so the baseline/variance side of an experiment uses the SAME binary under test rather
# than silently falling back to the deployed ~/.xpair/host/bin/screen.
HOST_BIN="${HOST_BIN:-${HOME}/.xpair/host/bin/screen}"

PORT="${PORT:-8890}"
DURATION="${DURATION:-60}"
FPS="${FPS:-30}"
BITRATE="${BITRATE:-4000000}"
SCALE="${SCALE:-1}"
CONTENT="${CONTENT:-motion}"
CONTENT_SETTLE="${CONTENT_SETTLE:-3}"
SEED="${SEED:-$(date +%s)}"
OUT="${OUT:-${ROOT}/out/baseline-$(date -u +%Y%m%dT%H%M%SZ).json}"

case "${CONTENT}" in
  static|motion) ;;
  *)
    echo "CONTENT must be static or motion, got ${CONTENT}" >&2
    exit 64
    ;;
esac

TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/xpair-rd-bench-token.XXXXXX")"
CONTENT_PROFILE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/xpair-rd-bench-chrome.XXXXXX")"
HOST_PID=""
CONTENT_PID=""

cleanup() {
  if [[ -n "${HOST_PID}" ]] && kill -0 "${HOST_PID}" 2>/dev/null; then
    kill "${HOST_PID}" 2>/dev/null || true
    wait "${HOST_PID}" 2>/dev/null || true
  fi
  if [[ -n "${CONTENT_PID}" ]] && kill -0 "${CONTENT_PID}" 2>/dev/null; then
    kill "${CONTENT_PID}" 2>/dev/null || true
    wait "${CONTENT_PID}" 2>/dev/null || true
  fi
  rm -f "${TOKEN_FILE}"
  rm -rf "${CONTENT_PROFILE_DIR}"
}
trap cleanup EXIT INT TERM

chmod 600 "${TOKEN_FILE}"
if command -v openssl >/dev/null 2>&1; then
  openssl rand -hex 32 >"${TOKEN_FILE}"
else
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' >"${TOKEN_FILE}"
  printf '\n' >>"${TOKEN_FILE}"
fi
TOKEN="$(tr -d '\n\r' <"${TOKEN_FILE}")"

mkdir -p "$(dirname "${OUT}")"

CONTENT_URL="$(node -e 'const path = require("node:path"); const { pathToFileURL } = require("node:url"); const root = process.argv[1]; const mode = process.argv[2]; const file = path.join(root, "content", "pattern.html"); const url = pathToFileURL(file); url.searchParams.set("mode", mode); console.log(url.href);' "${ROOT}" "${CONTENT}")"
"${ROOT}/launch-content.sh" "${CONTENT_PROFILE_DIR}" "${CONTENT_URL}" &
CONTENT_PID="$!"
sleep "${CONTENT_SETTLE}"
# launch-content.sh is backgrounded, so `set -e` cannot catch it exiting during the
# settle (e.g. Google Chrome missing at the default path). Without this guard the host
# would start and record whatever is on screen instead of the deterministic pattern,
# corrupting the baseline/variance numbers. Fail fast if the content window died.
if ! kill -0 "${CONTENT_PID}" 2>/dev/null; then
  echo "content launcher exited during settle (launch-content.sh) — is Chrome installed?" >&2
  exit 1
fi

"${HOST_BIN}" serve-webrtc \
  --port "${PORT}" \
  --token "@${TOKEN_FILE}" \
  --fps "${FPS}" \
  --bitrate "${BITRATE}" \
  --scale "${SCALE}" &
HOST_PID="$!"

TOKEN="${TOKEN}" \
PORT="${PORT}" \
DURATION="${DURATION}" \
FPS="${FPS}" \
BITRATE="${BITRATE}" \
SCALE="${SCALE}" \
CONTENT="${CONTENT}" \
SEED="${SEED}" \
OUT="${OUT}" \
node "${ROOT}/client/index.js"
