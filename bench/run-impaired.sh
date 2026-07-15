#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_BIN="${HOST_BIN:-${HOME}/.xpair/host/bin/screen}"

PORT="${PORT:-8890}"
PROXY_PORT="${PROXY_PORT:-8891}"
DURATION="${DURATION:-60}"
FPS="${FPS:-30}"
BITRATE="${BITRATE:-4000000}"
SCALE="${SCALE:-1}"
CONTENT="${CONTENT:-motion}"
CONTENT_SETTLE="${CONTENT_SETTLE:-3}"
SEED="${SEED:-$(date +%s)}"
PROFILE="${PROFILE:-passthrough}"
OUT="${OUT:-${ROOT}/out/impaired-${PROFILE}-$(date -u +%Y%m%dT%H%M%SZ).json}"
PROXY_STATS="${PROXY_STATS:-${ROOT}/out/proxy-${PROFILE}-$(date -u +%Y%m%dT%H%M%SZ).json}"
PACKETS_LOST_MAX="${PACKETS_LOST_MAX:-0}"

case "${CONTENT}" in
  static|motion) ;;
  *)
    echo "CONTENT must be static or motion, got ${CONTENT}" >&2
    exit 64
    ;;
esac

case "${PROFILE}" in
  passthrough|latency|loss|burst|fragment|marked-burst) ;;
  *)
    echo "PROFILE must be passthrough, latency, loss, burst, fragment, or marked-burst; got ${PROFILE}" >&2
    exit 64
    ;;
esac

TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/xpair-rd-bench-token.XXXXXX")"
CONTENT_PROFILE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/xpair-rd-bench-chrome.XXXXXX")"
RELAY_LOG="$(mktemp "${TMPDIR:-/tmp}/xpair-rd-bench-relay.XXXXXX")"
HOST_PID=""
CONTENT_PID=""
RELAY_PID=""

cleanup() {
  if [[ -n "${RELAY_PID}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
    kill "${RELAY_PID}" 2>/dev/null || true
    wait "${RELAY_PID}" 2>/dev/null || true
  fi
  if [[ -n "${HOST_PID}" ]] && kill -0 "${HOST_PID}" 2>/dev/null; then
    kill "${HOST_PID}" 2>/dev/null || true
    wait "${HOST_PID}" 2>/dev/null || true
  fi
  if [[ -n "${CONTENT_PID}" ]] && kill -0 "${CONTENT_PID}" 2>/dev/null; then
    kill "${CONTENT_PID}" 2>/dev/null || true
    wait "${CONTENT_PID}" 2>/dev/null || true
  fi
  rm -f "${TOKEN_FILE}" "${RELAY_LOG}"
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

mkdir -p "$(dirname "${OUT}")" "$(dirname "${PROXY_STATS}")"

CONTENT_URL="$(node -e 'const path = require("node:path"); const { pathToFileURL } = require("node:url"); const root = process.argv[1]; const mode = process.argv[2]; const file = path.join(root, "content", "pattern.html"); const url = pathToFileURL(file); url.searchParams.set("mode", mode); console.log(url.href);' "${ROOT}" "${CONTENT}")"
"${ROOT}/launch-content.sh" "${CONTENT_PROFILE_DIR}" "${CONTENT_URL}" &
CONTENT_PID="$!"
sleep "${CONTENT_SETTLE}"
# launch-content.sh is backgrounded, so `set -e` cannot catch it exiting during the
# settle (e.g. Google Chrome missing at the default path). Without this guard the host
# would start and record whatever is on screen instead of the deterministic pattern,
# silently corrupting the run. Fail fast if the content window died.
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

PROFILE="${PROFILE}" \
SEED="${SEED}" \
PROXY_PORT="${PROXY_PORT}" \
PROXY_STATS="${PROXY_STATS}" \
LOSS="${LOSS:-}" \
LAT_MS="${LAT_MS:-}" \
JIT_MS="${JIT_MS:-}" \
GE_P="${GE_P:-}" \
GE_R="${GE_R:-}" \
GE_LOSS_BAD="${GE_LOSS_BAD:-}" \
FRAG_BYTES="${FRAG_BYTES:-}" \
FRAG_LOSS="${FRAG_LOSS:-}" \
RTCP_LOSS="${RTCP_LOSS:-}" \
RETX_LOSS="${RETX_LOSS:-}" \
BW_KBPS="${BW_KBPS:-}" \
BW_BUFFER_MS="${BW_BUFFER_MS:-}" \
BURST_SCHEDULE="${BURST_SCHEDULE:-}" \
node "${ROOT}/proxy/relay.js" 2>"${RELAY_LOG}" &
RELAY_PID="$!"

# Wait until OUR spawned relay confirms it bound the UDP port before launching the
# client. The relay prints "relay listening on <addr>:<port> ..." to stderr only on a
# successful bind, so we poll that log for OUR port. The old "try to bind it and treat
# EADDRINUSE as ready" probe had a false-positive race: if PROXY_PORT was already held
# by a stale relay, the probe saw the bind fail while our just-spawned relay had not
# yet reported its own EADDRINUSE, so it declared ready and the client trickled ICE to
# the wrong (stale) relay. Keying on our relay's own listening line removes that race —
# if our relay can't get the port it exits with EADDRINUSE and the PID check trips.
RELAY_READY=0
for _ in $(seq 1 25); do
  if ! kill -0 "${RELAY_PID}" 2>/dev/null; then
    echo "relay process ${RELAY_PID} exited before binding ${PROXY_PORT}:" >&2
    cat "${RELAY_LOG}" >&2 || true
    break
  fi
  if grep -q "relay listening on .*:${PROXY_PORT} " "${RELAY_LOG}" 2>/dev/null; then
    RELAY_READY=1
    break
  fi
  sleep 0.2
done
if [[ "${RELAY_READY}" -ne 1 ]]; then
  echo "relay did not become ready on ${PROXY_PORT} within timeout" >&2
  exit 1
fi
sleep 0.5

TOKEN="${TOKEN}" \
PORT="${PORT}" \
DURATION="${DURATION}" \
FPS="${FPS}" \
BITRATE="${BITRATE}" \
SCALE="${SCALE}" \
CONTENT="${CONTENT}" \
SEED="${SEED}" \
PROFILE="${PROFILE}" \
USE_PROXY=1 \
PROXY_PORT="${PROXY_PORT}" \
PROXY_STATS="${PROXY_STATS}" \
OUT="${OUT}" \
node "${ROOT}/client/index.js"

# Axis-A falsification gate: a *truly* unimpaired passthrough run must observe ~0
# loss. Skip it when a bandwidth cap is active — there the relay intentionally
# drops RTP, so nonzero loss is expected and the gate would (correctly) fail,
# which would block scoring legitimate congestion experiments.
if [[ "${PROFILE}" == "passthrough" && ( -z "${BW_KBPS:-}" || "${BW_KBPS:-0}" == "0" ) ]]; then
  node -e '
    const fs = require("node:fs");
    const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const max = Number(process.argv[2]);
    const lost = record && record.summary ? record.summary.packetsLost : null;
    if (typeof lost !== "number" || lost > max) {
      console.error(`passthrough packetsLost gate failed: packetsLost=${lost}, max=${max}`);
      process.exit(1);
    }
  ' "${OUT}" "${PACKETS_LOST_MAX}"
fi
