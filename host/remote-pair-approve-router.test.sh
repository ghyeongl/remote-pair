#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/logs"
touch "$TMP/shot.png"
cat >"$TMP/bin/ocr-find" <<'EOF'
#!/bin/bash
if [[ -f "${OCR_PHASE_FILE:-}" ]]; then
  phase="$(cat "$OCR_PHASE_FILE")"
  if [[ "$2" == "--has" ]]; then
    [[ "$phase" == present ]]
  elif [[ "$phase" == present ]]; then
    echo 1700,1000
  fi
  exit
fi
case "${OCR_RESULT:-}" in
  always) [[ "$2" == *"Always Allow"* ]] && echo 10,10 ;;
  once) [[ "$2" == *"Allow Once"* ]] && echo 10,10 ;;
esac
EOF
chmod +x "$TMP/bin/ocr-find"
cat >"$TMP/bin/screencapture" <<'EOF'
#!/bin/bash
count_file="${CAPTURE_COUNT_FILE:?}"
count=0
[[ -f "$count_file" ]] && count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
if [[ "$count" -ge 2 ]]; then printf 'gone\n' >"${OCR_PHASE_FILE:?}"; fi
touch "${@: -1}"
EOF
cat >"$TMP/bin/cliclick" <<'EOF'
#!/bin/bash
:
EOF
chmod +x "$TMP/bin/screencapture" "$TMP/bin/cliclick"
printf 'Claude for Chrome\tNew permissions required\tkey:cmd+return|return\n' >"$TMP/rules.txt"

run_router() {
  PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
    LOG_FILE="$TMP/logs/router.log" RP_SHOT="$TMP/shot.png" RP_DRY=1 \
    RP_FOR="${2-Claude for Chrome}" RP_TYPE="${3:-}" OCR_RESULT="$1" \
    "$ROOT/host/remote-pair-approve-router.sh"
}

[[ "$(run_router always)" == "WOULD key 'cmd+return' x5 [Claude for Chrome]" ]]
[[ "$(run_router once)" == "WOULD key 'return' x5 [Claude for Chrome]" ]]
if run_router decline >/dev/null 2>&1; then
  echo "router accepted an unconfirmed key outcome" >&2
  exit 1
fi

printf 'Some Dialog\tConfirm action\tkey:return\n' >"$TMP/rules.txt"
[[ "$(run_router decline 'Some Dialog')" == "WOULD key 'return' x5 [Some Dialog]" ]]
[[ "$(run_router decline '' 'key:return')" == "WOULD key 'return' x5 [agent-type]" ]]

# OCR/click regression: even immediate dialog disappearance does not prove the
# blocked operation succeeded (it may be timeout/decline/a stray click).
printf '1Password\tAccess Requested\tocr:Authorize\n' >"$TMP/rules.txt"
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/capture-count"
if PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_VISION=off \
  RP_WAIT_SECS=0 RP_CLICK_VERIFY_DELAY=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1; then
  echo "router accepted a click after the dialog merely disappeared" >&2
  exit 1
fi
[[ "$(cat "$TMP/capture-count")" == 2 ]]
grep -q 'router: click-outcome-unconfirmed \[1Password\]' "$TMP/logs/router.log"
