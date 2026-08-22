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
    if [[ -n "${OCR_COORD_FILE:-}" ]]; then cat "$OCR_COORD_FILE"; else echo 1700,1000; fi
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
[[ -n "${MOVE_COORD_FILE:-}" ]] && printf '1800,1000\n' >"$MOVE_COORD_FILE"
:
EOF
cat >"$TMP/bin/osascript" <<'EOF'
#!/bin/bash
[[ -n "${OSASCRIPT_LOG:-}" ]] && printf '%s\n' "$*" >>"$OSASCRIPT_LOG"
if [[ "$*" == *"key code"* && -n "${OUTCOME_ON_KEY_FILE:-}" ]]; then
  if [[ -n "${REQUIRE_PHASE_ON_KEY:-}" && "$(cat "${OCR_PHASE_FILE:?}")" != present ]]; then
    : >"${KEY_BEFORE_MARKER_FILE:?}"
  fi
  if [[ -n "${OUTCOME_ON_KEY_DELAY:-}" ]]; then
    ( sleep "$OUTCOME_ON_KEY_DELAY"; printf '%s\n' "${OUTCOME_ON_KEY_VERDICT:-ok}" >"$OUTCOME_ON_KEY_FILE" ) &
  else
    printf '%s\n' "${OUTCOME_ON_KEY_VERDICT:-ok}" >"$OUTCOME_ON_KEY_FILE"
  fi
fi
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
: >"$TMP/outcome"
: >"$TMP/capture-count"
PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  RP_OSASCRIPT="$TMP/bin/osascript" RP_CLICK="$TMP/bin/cliclick" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=0 \
  OUTCOME_ON_KEY_FILE="$TMP/outcome" OUTCOME_ON_KEY_VERDICT=ok \
  GONE_AT=999 "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1
[[ "$(cat "$TMP/capture-count")" == 1 ]]
grep -q 'router: success \[1Password\] (method=key:return' "$TMP/logs/router.log"

# Once the per-method outcome wait expires, an outcome-confirmed request stops
# instead of applying the next method to a possibly queued dialog.
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/outcome"
: >"$TMP/capture-count"
: >"$TMP/osascript.log"
if PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  RP_OSASCRIPT="$TMP/bin/osascript" RP_CLICK="$TMP/bin/cliclick" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=0 OSASCRIPT_LOG="$TMP/osascript.log" \
  GONE_AT=999 "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1; then
  echo "router advanced after a bounded outcome wait" >&2
  exit 1
fi
[[ "$(grep -c 'key code' "$TMP/osascript.log")" == 1 ]]
grep -q 'router: click-outcome-unconfirmed \[1Password\] (method=key:return, 호출 결과 대기 한도 초과)' "$TMP/logs/router.log"

# Marker loss without a positive caller result preserves #124's unconfirmed
# verdict; closure alone is never success.
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/outcome"
: >"$TMP/capture-count"
if PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  RP_OSASCRIPT="$TMP/bin/osascript" RP_CLICK="$TMP/bin/cliclick" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=0 \
  OUTCOME_ON_KEY_FILE="$TMP/outcome" OUTCOME_ON_KEY_VERDICT=fail \
  GONE_AT=999 "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1; then
  echo "router accepted marker loss without a successful caller outcome" >&2
  exit 1
fi
grep -q 'router: click-outcome-unconfirmed \[1Password\] (method=key:return' "$TMP/logs/router.log"

# Explicit 1Password keys keep exact-action semantics while still focusing the
# app and requiring caller ground truth.
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/outcome"
: >"$TMP/capture-count"
: >"$TMP/osascript.log"
PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR=1Password RP_TYPE=key:return RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  RP_OSASCRIPT="$TMP/bin/osascript" RP_CLICK="$TMP/bin/cliclick" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=0 \
  OUTCOME_ON_KEY_FILE="$TMP/outcome" OUTCOME_ON_KEY_VERDICT=ok OSASCRIPT_LOG="$TMP/osascript.log" \
  GONE_AT=999 "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1
grep -q 'tell application.*1Password.*activate' "$TMP/osascript.log"
grep -q 'key code 36' "$TMP/osascript.log"
grep -q 'router: success \[1Password\] (explicit method=key:return' "$TMP/logs/router.log"

# A delayed result for the first method wins before the ladder can send a
# second method to an identical queued dialog.
printf '1Password\tAccess Requested\tocr:Authorize\n' >"$TMP/rules.txt"
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/outcome"
: >"$TMP/capture-count"
: >"$TMP/osascript.log"
PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  RP_OSASCRIPT="$TMP/bin/osascript" RP_CLICK="$TMP/bin/cliclick" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=2 \
  OUTCOME_ON_KEY_FILE="$TMP/outcome" OUTCOME_ON_KEY_VERDICT=ok OUTCOME_ON_KEY_DELAY=0.5 \
  OSASCRIPT_LOG="$TMP/osascript.log" GONE_AT=999 \
  "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1
[[ "$(grep -c 'key code' "$TMP/osascript.log")" == 1 ]]
grep -q 'router: success \[1Password\] (method=key:return' "$TMP/logs/router.log"

# Type-only requests with a real outcome channel preserve an early caller
# verdict without dispatching a key to a queued dialog.
printf 'present\n' >"$TMP/ocr-phase"
printf 'ok\n' >"$TMP/outcome"
: >"$TMP/capture-count"
: >"$TMP/osascript.log"
PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_TYPE=key:return RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  RP_OSASCRIPT="$TMP/bin/osascript" RP_CLICK="$TMP/bin/cliclick" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=0 OSASCRIPT_LOG="$TMP/osascript.log" \
  GONE_AT=999 "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1
[[ "$(cat "$TMP/capture-count")" == 1 ]]
! grep -q 'key code' "$TMP/osascript.log"
grep -q 'router: success \[1Password\] (호출 결과가 승인 방식 전 이미 확인됨)' "$TMP/logs/router.log"

# A type-only request waits for the 1Password marker instead of sending its
# key generically to the currently focused app on the first polling cycle.
printf 'absent\n' >"$TMP/ocr-phase"
: >"$TMP/outcome"
: >"$TMP/capture-count"
: >"$TMP/osascript.log"
rm -f "$TMP/key-before-marker"
( sleep 0.4; printf 'present\n' >"$TMP/ocr-phase" ) &
PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_TYPE=key:return RP_VISION=off \
  RP_WAIT_SECS=2 RP_INTERVAL=0.1 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  RP_OSASCRIPT="$TMP/bin/osascript" RP_CLICK="$TMP/bin/cliclick" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=0 \
  OUTCOME_ON_KEY_FILE="$TMP/outcome" OUTCOME_ON_KEY_VERDICT=ok \
  REQUIRE_PHASE_ON_KEY=1 KEY_BEFORE_MARKER_FILE="$TMP/key-before-marker" \
  OSASCRIPT_LOG="$TMP/osascript.log" GONE_AT=999 \
  "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1
[[ ! -e "$TMP/key-before-marker" ]]
grep -q 'router: success \[1Password\] (explicit method=key:return' "$TMP/logs/router.log"

# A rule-defined 1Password key also stays on the focused/outcome-confirmed
# path. An ok outcome stops immediately even if another matching dialog is
# already visible (queued request).
printf '1Password\tAccess Requested\tkey:return\n' >"$TMP/rules.txt"
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/outcome"
: >"$TMP/capture-count"
: >"$TMP/osascript.log"
PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR=1Password RP_TYPE= RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  RP_OSASCRIPT="$TMP/bin/osascript" RP_CLICK="$TMP/bin/cliclick" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  RP_OUTCOME_FILE="$TMP/outcome" RP_OUTCOME_WAIT=0 \
  OUTCOME_ON_KEY_FILE="$TMP/outcome" OUTCOME_ON_KEY_VERDICT=ok OSASCRIPT_LOG="$TMP/osascript.log" \
  GONE_AT=999 "$ROOT/host/remote-pair-approve-router.sh" >/dev/null 2>&1
[[ "$(cat "$TMP/capture-count")" == 1 ]]
grep -q 'tell application.*1Password.*activate' "$TMP/osascript.log"
grep -q 'router: success \[1Password\] (explicit method=key:return' "$TMP/logs/router.log"

# If no method closes the dialog, exhaust the full ladder and preserve #124's
# unconfirmed failure verdict.
printf '1Password\tAccess Requested\tocr:Authorize\n' >"$TMP/rules.txt"
printf 'present\n' >"$TMP/ocr-phase"
: >"$TMP/capture-count"
: >"$TMP/osascript.log"
printf '1700,1000\n' >"$TMP/ocr-coordinate"
if PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
  LOG_FILE="$TMP/logs/router.log" RP_FOR= RP_VISION=off \
  RP_WAIT_SECS=0 RP_METHOD_GAP=0 RP_SCREENCAPTURE="$TMP/bin/screencapture" \
  RP_OSASCRIPT="$TMP/bin/osascript" RP_CLICK="$TMP/bin/cliclick" \
  OCR_PHASE_FILE="$TMP/ocr-phase" CAPTURE_COUNT_FILE="$TMP/capture-count" \
  OCR_COORD_FILE="$TMP/ocr-coordinate" MOVE_COORD_FILE="$TMP/ocr-coordinate" OSASCRIPT_LOG="$TMP/osascript.log" \
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
grep -q 'router: \[1Password\] method system-events:1800,1000' "$TMP/logs/router.log"
grep -q 'click at {1800, 1000}' "$TMP/osascript.log"
grep -q 'router: \[1Password\] method axpress' "$TMP/logs/router.log"
grep -q 'router: click-outcome-unconfirmed \[1Password\] (모든 승인 방식 소진' "$TMP/logs/router.log"
