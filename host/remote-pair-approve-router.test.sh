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
if [[ "$count" -ge "${GONE_AT:-999}" ]]; then
  printf 'gone\n' >"${OCR_PHASE_FILE:?}"
  [[ -n "${OUTCOME_WRITE_FILE:-}" ]] && printf '%s\n' "${OUTCOME_VERDICT:-fail}" >"$OUTCOME_WRITE_FILE"
fi
touch "${@: -1}"
EOF
cat >"$TMP/bin/cliclick" <<'EOF'
#!/bin/bash
:
EOF
cat >"$TMP/bin/osascript" <<'EOF'
#!/bin/bash
:
EOF
chmod +x "$TMP/bin/screencapture" "$TMP/bin/cliclick" "$TMP/bin/osascript"
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

# 1Password's declared Return action may report success when it closes the
# detected approval dialog.
printf '1Password\tAccess Requested\tocr:Authorize\n' >"$TMP/rules.txt"
[[ "$(run_router decline 1Password)" == \
  "WOULD try return|cmd+return|space|cliclick|system-events|axpress [1Password]" ]]
[[ "$(run_router always 1Password 'ocr:Authorize|Always Allow')" == \
  "WOULD click (10,10) [1Password]" ]]
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/capture-count"
PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=0 \
  OUTCOME_WRITE_FILE="$TMP/outcome" OUTCOME_VERDICT=ok \
  GONE_AT=2 "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1
[[ "$(cat "$TMP/capture-count")" == 2 ]]
grep -q 'router: success \[1Password\] (method=key:return' "$TMP/logs/router.log"

# Marker loss without a positive caller result preserves #124's unconfirmed
# verdict; closure alone is never success.
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/capture-count"
if PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=0 \
  OUTCOME_WRITE_FILE="$TMP/outcome" OUTCOME_VERDICT=fail \
  GONE_AT=2 "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1; then
  echo "router accepted marker loss without a successful caller outcome" >&2
  exit 1
fi
grep -q 'router: click-outcome-unconfirmed \[1Password\] (method=key:return' "$TMP/logs/router.log"

# If no method closes the dialog, exhaust the full ladder and preserve #124's
# unconfirmed failure verdict.
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/capture-count"
if PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE= RP_OUTCOME_WAIT=0 \
  GONE_AT=999 "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1; then
  echo "router accepted an exhausted 1Password method ladder" >&2
  exit 1
fi
[[ "$(cat "$TMP/capture-count")" == 7 ]]
grep -q 'router: \[1Password\] method key:return' "$TMP/logs/router.log"
grep -q 'router: \[1Password\] method key:cmd+return' "$TMP/logs/router.log"
grep -q 'router: \[1Password\] method key:space' "$TMP/logs/router.log"
grep -q 'router: \[1Password\] method cliclick:1700,1000' "$TMP/logs/router.log"
grep -q 'router: \[1Password\] method system-events:1700,1000' "$TMP/logs/router.log"
grep -q 'router: \[1Password\] method axpress' "$TMP/logs/router.log"
grep -q 'router: click-outcome-unconfirmed \[1Password\] (모든 승인 방식 소진' "$TMP/logs/router.log"
