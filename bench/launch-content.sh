#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: launch-content.sh <user-data-dir> <url>" >&2
  exit 64
fi

USER_DATA_DIR="$1"
URL="$2"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "${CHROME_BIN}" ]]; then
  echo "Google Chrome not found at ${CHROME_BIN}" >&2
  exit 69
fi

mkdir -p "${USER_DATA_DIR}"

exec "${CHROME_BIN}" \
  --user-data-dir="${USER_DATA_DIR}" \
  --kiosk \
  --new-window \
  "${URL}"
