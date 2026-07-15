#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PROFILE="${PROFILE:-passthrough}"
CLIENT_OUT="${OUT:-${ROOT}/out/impaired-${PROFILE}-${STAMP}.json}"
PROXY_OUT="${PROXY_STATS:-${ROOT}/out/proxy-${PROFILE}-${STAMP}.json}"
SCORE_OUT="${SCORE_OUT:-${ROOT}/out/score-${STAMP}.json}"

mkdir -p "${ROOT}/out"

OUT="${CLIENT_OUT}" PROXY_STATS="${PROXY_OUT}" "${ROOT}/run-impaired.sh" >&2

SCORE_ARGS=(--client "${CLIENT_OUT}" --proxy "${PROXY_OUT}" --out "${SCORE_OUT}")
if [[ -n "${BASELINE_VARIANCE:-}" ]]; then
  SCORE_ARGS+=(--baseline "${BASELINE_VARIANCE}")
fi

SCORE_JSON="$(node "${ROOT}/score/score.js" "${SCORE_ARGS[@]}")"

printf '%s\n' "${SCORE_JSON}" >&2
node -e '
  const fs = require("node:fs");
  const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log(record.score);
' "${SCORE_OUT}"
