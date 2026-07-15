#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONTENT="${CONTENT:-motion}"
RUNS="${RUNS:-3}"
COOLDOWN="${COOLDOWN:-20}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-${ROOT}/out/variance-${CONTENT}-${STAMP}.json}"

case "${CONTENT}" in
  static|motion) ;;
  *)
    echo "CONTENT must be static or motion, got ${CONTENT}" >&2
    exit 64
    ;;
esac

if ! [[ "${RUNS}" =~ ^[0-9]+$ ]] || [[ "${RUNS}" -lt 1 ]]; then
  echo "RUNS must be a positive integer, got ${RUNS}" >&2
  exit 64
fi

if ! [[ "${COOLDOWN}" =~ ^[0-9]+$ ]]; then
  echo "COOLDOWN must be a non-negative integer, got ${COOLDOWN}" >&2
  exit 64
fi

mkdir -p "${ROOT}/out"

RUN_OUTS=()
for ((i = 1; i <= RUNS; i += 1)); do
  RUN_OUT="${ROOT}/out/baseline-${CONTENT}-${STAMP}-run${i}.json"
  echo "run ${i}/${RUNS}: ${RUN_OUT}"
  CONTENT="${CONTENT}" OUT="${RUN_OUT}" "${ROOT}/run-baseline.sh"
  RUN_OUTS+=("${RUN_OUT}")

  if [[ "${i}" -lt "${RUNS}" && "${COOLDOWN}" -gt 0 ]]; then
    echo "cooldown ${COOLDOWN}s"
    sleep "${COOLDOWN}"
  fi
done

node "${ROOT}/client/variance.js" "${CONTENT}" "${OUT}" "${RUN_OUTS[@]}"
