#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS="${RUNS:-3}"
COOLDOWN="${COOLDOWN:-20}"
CONTENT="${CONTENT:-motion}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-${ROOT}/out/baseline-score-${STAMP}.json}"

if ! [[ "${RUNS}" =~ ^[0-9]+$ ]] || [[ "${RUNS}" -lt 1 ]]; then
  echo "RUNS must be a positive integer, got ${RUNS}" >&2
  exit 64
fi

mkdir -p "${ROOT}/out"

SCORE_FILES=()
for ((i = 1; i <= RUNS; i += 1)); do
  SCORE_OUT="${ROOT}/out/score-baseline-${CONTENT}-${STAMP}-run${i}.json"
  echo "baseline score run ${i}/${RUNS}: ${SCORE_OUT}" >&2
  PROFILE=passthrough CONTENT="${CONTENT}" SCORE_OUT="${SCORE_OUT}" "${ROOT}/evaluate.sh" >/dev/null
  SCORE_FILES+=("${SCORE_OUT}")

  if [[ "${i}" -lt "${RUNS}" && "${COOLDOWN}" -gt 0 ]]; then
    echo "cooldown ${COOLDOWN}s" >&2
    sleep "${COOLDOWN}"
  fi
done

node "${ROOT}/score/baseline-aggregate.js" "${OUT}" "${SCORE_FILES[@]}"
