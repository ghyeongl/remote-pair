#!/bin/bash
# remote-pair-approve-router.sh — 떠있는(또는 곧 뜰) 승인창을 감지 → 허용 → 닫혔는지 검증.
#
# RemotePairHost(메뉴바앱, AX+화면기록+PostEvent granted)가 트리거 시 자식으로 호출 → 권한 상속.
# claude/스킬은 "막히면 트리거"만 하고, 어떤 창을 어떻게 허용할지는 전부 여기가 라우팅.
#
# 개선점(v3):
#   1) 적응형 폴링 — 트리거 직후 창이 아직 없어도(에이전트가 수 초 뒤 띄움) WAIT 동안 기다린다.
#   2) 검증 루프 — 클릭/키 후 재캡처해 "마커가 사라졌나" 확인. 안 닫혔으면 재시도. exit 0=성공 / 1=실패.
#   3) 하이브리드 비전 — OCR 룰 우선(빠름). 미스 시 haiku 가 "어떤 알려진 창인가"만 분류(좌표는 못 줌).
#        분류 결과를 룰 action(OCR 버튼텍스트→좌표 / 키)으로 실행. UNKNOWN 이면 일반 승인 라벨로 폴백.
#
# rules.txt v2 (탭 구분):  id <TAB> marker <TAB> action
#   marker = 감지/검증용 OCR 텍스트(부분일치, 소문자무관) — haiku 분류 시 설명으로도 쓰임
#   action = ocr:<라벨|라벨..> (버튼텍스트 찾아 클릭) | key:<콤보> (cmd+return, return, esc …)
set -u
# claude·screencapture·cliclick 가 PATH 에 있도록 (앱이 직접 스폰하는 PATH 는 빈약)
export PATH="/usr/sbin:/usr/bin:/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SCAP="${RP_SCREENCAPTURE:-/usr/sbin/screencapture}"
OSASCRIPT="${RP_OSASCRIPT:-/usr/bin/osascript}"
RP_DIR="${RP_DIR:-$HOME/.remote-pair}"

OCR="$(command -v ocr-find 2>/dev/null || true)"
[ -n "$OCR" ] || for _c in "$RP_DIR/bin/ocr-find" "$HOME/.claude/bin/ocr-find"; do [ -x "$_c" ] && { OCR="$_c"; break; }; done
CLICK="${RP_CLICK:-$(command -v cliclick 2>/dev/null || echo /opt/homebrew/bin/cliclick)}"
CLAUDE="$(command -v claude 2>/dev/null || true)"

RULES="${RULES_FILE:-$RP_DIR/rules.txt}"; [ -f "$RULES" ] || RULES="$HOME/.claude/auto-approve/rules.txt"
LOG="${LOG_FILE:-$RP_DIR/logs/remote-pair.log}"; mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
# size-cap rotation (5MB → .1) at startup — shared remote-pair.log, append-only writers tolerate it
{ _sz="$(stat -f %z "$LOG" 2>/dev/null || echo 0)"; [ "$_sz" -gt 5000000 ] && mv -f "$LOG" "$LOG.1" 2>/dev/null; } || true
SHOT="${RP_SHOT:-/tmp/rp-router.png}"          # RP_SHOT 지정 시 그 이미지 사용(테스트, 단발)
DRY="${RP_DRY:-0}"                             # RP_DRY=1 = 실제 클릭/키 안 함(의도만)

# 적응형 폴링/검증 튜너블
WAIT_SECS="${RP_WAIT_SECS:-${1:-18}}"          # 승인창 출현을 기다리는 총 윈도우(초)
INTERVAL="${RP_INTERVAL:-1.2}"                 # 폴링 간격
CLICK_VERIFY_DELAY="${RP_CLICK_VERIFY_DELAY:-0.8}" # 클릭 직후 1회만 결과 확인(재시도 중 timeout 오판 방지)
METHOD_GAP="${RP_METHOD_GAP:-0.4}"             # 1Password 승인 방식별 결과 확인 전 대기
OUTCOME_FILE="${RP_OUTCOME_FILE:-}"            # 선택: 호출자가 쓰는 ok|fail 실제 결과 채널
OUTCOME_WAIT="${RP_OUTCOME_WAIT:-5}"           # 창 닫힘 후 실제 호출 결과 대기
REQUEST_ID="${RP_REQUEST_ID:-}"
# 비전(haiku) — 구독 claude CLI 재사용, best-effort
VISION="${RP_VISION:-auto}"                    # auto(룰 미스 시) | on | off
VISION_MODEL="${RP_VISION_MODEL:-claude-haiku-4-5}"
VISION_TIMEOUT="${RP_VISION_TIMEOUT:-12}"      # 비전 호출 1회 상한(헤드리스 claude 가 느리거나 막혀도 OCR 폴링 회복)
VISION_EVERY="${RP_VISION_EVERY:-2}"           # N 사이클마다 1회만 비전 호출(지연/비용 제한)
VISION_MAX_FAILS="${RP_VISION_MAX_FAILS:-2}"   # 연속 claude 실패 N회 → 그 실행 동안 비전 자동 비활성
VISION_FAILS=0; LAST_VISION_RC=0
GENERIC_LABELS="Allow|Authorize|Authorize Once|Always Allow|Approve|Confirm|Continue|OK|허용|승인|확인|한 번 승인"

log(){ printf '%s router: %s%s\n' "$(date '+%H:%M:%S')" "${REQUEST_ID:+[request=$REQUEST_ID] }" "$1" >> "$LOG"; }
[ -n "$OCR" ] || { log "ocr-find 없음 — 중단"; exit 1; }

# 힌트: 에이전트가 "어떤 승인인지"(룰 id 또는 자유문구) 미리 알려주면 해당 룰을 우선 시도 +
#   haiku 분류 prior 로 사용. 없어도 됨. (CLI 가 .label 파일로 전달, 또는 RP_FOR 환경변수)
HINT_FILE="${RP_HINT_FILE:-/tmp/remote-pair.approve-request.label}"
TYPE_FILE="${RP_TYPE_FILE:-/tmp/remote-pair.approve-request.type}"
HINT="${RP_FOR:-}"
[ -z "$HINT" ] && [ -f "$HINT_FILE" ] && HINT="$(head -1 "$HINT_FILE" 2>/dev/null)"
# --type: 에이전트가 "어떻게 승인할지"(key:<combo> | ocr:<라벨>)를 직접 지정 → 힌트 경로에서 룰 action override
HINT_TYPE="${RP_TYPE:-}"
[ -z "$HINT_TYPE" ] && [ -f "$TYPE_FILE" ] && HINT_TYPE="$(head -1 "$TYPE_FILE" 2>/dev/null)"
rm -f "$HINT_FILE" "$TYPE_FILE" 2>/dev/null || true
[ -n "$HINT_TYPE" ] && log "type(에이전트 지정): $HINT_TYPE"
HINT_ID=""
if [ -n "$HINT" ]; then
  # 별칭 관대: 브라우저명/변형을 룰 id 로 정규화 (예: Google Chrome/Chrome → Claude for Chrome)
  case "$(printf '%s' "$HINT" | tr '[:upper:]' '[:lower:]')" in
    *chrome*) HINT="Claude for Chrome" ;;
    *1password*|*"1 password"*) HINT="1Password" ;;
  esac
  log "hint: $HINT"
  HINT_ID="$(awk -F'\t' -v h="$(printf '%s' "$HINT" | tr '[:upper:]' '[:lower:]')" '
    $0!~/^[[:space:]]*#/ && NF>=3 { lid=tolower($1); if (index(lid,h)>0 || index(h,lid)>0) { print $1; exit } }' "$RULES")"
  [ -n "$HINT_ID" ] && log "hint → rule '$HINT_ID' 우선 시도"
fi
[ "$VISION" != off ] && [ -z "$CLAUDE" ] && { log "claude CLI 없음 → 비전 비활성(OCR 룰만)"; VISION=off; }

capture(){ [ -n "${RP_SHOT:-}" ] && return 0; $SCAP -x "$SHOT" 2>/tmp/rp-scap.err || { log "screencapture 실패: $(tr '\n' ' ' </tmp/rp-scap.err 2>/dev/null)"; return 1; }; }

# 키 전송은 osascript(System Events)로 — cliclick(CGEvent 합성 키)은 Chrome 확장 등 웹 UI 팝업에
# 안 먹히는 반면(실측 확인), System Events key code 는 먹힌다. 좌표 클릭(OCR 오매칭 위험) 회피.
# "cmd+return" → key code 36 using {command down}  /  "return" → key code 36
sendkey(){
  local combo="$1" key mods="" m kc parts=""
  local -a M=()
  key="${combo##*+}"; [ "$combo" != "$key" ] && mods="${combo%+*}"
  case "$key" in
    return|enter) kc=36 ;; esc|escape) kc=53 ;; space) kc=49 ;; tab) kc=48 ;; *) kc="" ;;
  esac
  if [ -n "$mods" ]; then
    IFS='+' read -ra M <<< "$mods"
    for m in "${M[@]}"; do case "$m" in
      cmd|command) parts="$parts command down," ;; shift) parts="$parts shift down," ;;
      ctrl|control) parts="$parts control down," ;; alt|option) parts="$parts option down," ;;
    esac; done
  fi
  local mod=""; [ -n "$parts" ] && mod=" using {${parts%,}}"
  if [ -n "$kc" ]; then
    "$OSASCRIPT" -e "tell application \"System Events\" to key code $kc$mod"
  else
    "$OSASCRIPT" -e "tell application \"System Events\" to keystroke \"$key\"$mod"
  fi
}

system_click(){
  local x="$1" y="$2"
  "$OSASCRIPT" -e "tell application \"System Events\" to click at {$x, $y}"
}

focus_1password(){
  "$OSASCRIPT" -e 'tell application "1Password" to activate'
}

outcome_confirmed(){
  [ -n "$OUTCOME_FILE" ] || return 1
  local deadline=$(( $(date +%s) + OUTCOME_WAIT )) verdict=""
  while [ "$(date +%s)" -le "$deadline" ]; do
    [ -f "$OUTCOME_FILE" ] && verdict="$(head -1 "$OUTCOME_FILE" 2>/dev/null)"
    case "$verdict" in ok) return 0 ;; fail) return 1 ;; esac
    sleep 0.1
  done
  return 1
}

outcome_now(){
  local raw=""
  [ -n "$OUTCOME_FILE" ] && [ -f "$OUTCOME_FILE" ] && raw="$(head -1 "$OUTCOME_FILE" 2>/dev/null)"
  if [ -n "$REQUEST_ID" ]; then
    case "$raw" in "ok:$REQUEST_ID") echo ok ;; "fail:$REQUEST_ID") echo fail ;; esac
  else
    case "$raw" in ok) echo ok ;; fail) echo fail ;; esac
  fi
}

# Give the blocked caller time to publish the result of the method just sent.
# This wait happens even while an identical marker remains visible: that marker
# may be a second queued request, not proof that the first method failed.
outcome_after_method(){
  [ -n "$OUTCOME_FILE" ] || { echo pending; return; }
  local deadline verdict="$(outcome_now)"
  case "$verdict" in ok|fail) echo "$verdict"; return ;; esac
  [ "$OUTCOME_WAIT" -gt 0 ] 2>/dev/null || { echo pending; return; }
  deadline=$(( $(date +%s) + OUTCOME_WAIT ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    verdict="$(outcome_now)"
    case "$verdict" in ok|fail) echo "$verdict"; return ;; esac
    sleep 0.1
  done
  echo pending
}

ax_press(){
  local labels="$1"
  "$OSASCRIPT" - "$labels" <<'APPLESCRIPT'
on run argv
  set AppleScript's text item delimiters to "|"
  set wanted to text items of item 1 of argv
  tell application "System Events"
    repeat with proc in (application processes whose visible is true)
      if (name of proc as text) contains "1Password" then
        repeat with win in windows of proc
          try
            repeat with elem in entire contents of win
              try
                if role of elem is "AXButton" and (name of elem as text) is in wanted then
                  perform action "AXPress" of elem
                  return "pressed"
                end if
              end try
            end repeat
          end try
        end repeat
      end if
    end repeat
  end tell
  return "not-found"
end run
APPLESCRIPT
}

# 1Password CLI-access dialog: exhaust semantically approving keys and all
# available button activation mechanisms. Each method is followed immediately
# by the same marker check; only a declared approve method that closes the
# approval dialog is accepted as success.
approve_1password(){
  local marker="$1" labels="$2" combo C x y method verdict
  if [ "$DRY" = 1 ]; then
    echo "WOULD try return|cmd+return|space|cliclick|system-events|axpress [1Password]"
    return 0
  fi
  "$OCR" "$SHOT" --has "$marker" 2>/dev/null || {
    log "[1Password] dialog marker not present yet"; return 1
  }
  verdict="$(outcome_now)"
  case "$verdict" in
    ok) log "success [1Password] (호출 결과가 승인 방식 전 이미 확인됨)"; return 0 ;;
    fail) log "click-outcome-unconfirmed [1Password] (호출 실패가 승인 방식 전 이미 확인됨)"; return 2 ;;
  esac
  for combo in return cmd+return space; do
    verdict="$(outcome_now)"
    case "$verdict" in ok) log "success [1Password] (호출 결과 확인)"; return 0 ;; fail) log "click-outcome-unconfirmed [1Password] (호출 실패 확인)"; return 2 ;; esac
    focus_1password >/dev/null 2>&1
    sendkey "$combo" >/dev/null 2>&1
    log "[1Password] method key:$combo"
    sleep "$METHOD_GAP"
    verdict="$(outcome_after_method)"
    case "$verdict" in
      ok) log "success [1Password] (method=key:$combo, 호출 결과 확인)"; return 0 ;;
      fail) log "click-outcome-unconfirmed [1Password] (method=key:$combo, 호출 실패 확인)"; return 2 ;;
      pending) log "click-outcome-unconfirmed [1Password] (method=key:$combo, 호출 결과 미확인 — 다음 방식 중단)"; return 2 ;;
    esac
    if dialog_gone "$marker"; then
      if outcome_confirmed; then
        log "success [1Password] (method=key:$combo, 호출 결과 확인)"; return 0
      fi
      log "click-outcome-unconfirmed [1Password] (method=key:$combo, 창 닫힘이나 호출 결과 미확인)"
      return 2
    fi
  done
  for method in cliclick system-events; do
    C="$("$OCR" "$SHOT" "$labels" 2>/dev/null)"
    if [ -n "$C" ]; then
      x="${C%%,*}"; y="${C#*,}"
      verdict="$(outcome_now)"
      case "$verdict" in ok) log "success [1Password] (호출 결과 확인)"; return 0 ;; fail) log "click-outcome-unconfirmed [1Password] (호출 실패 확인)"; return 2 ;; esac
      if [ "$method" = cliclick ]; then "$CLICK" c:"$C" >/dev/null 2>&1
      else system_click "$x" "$y" >/dev/null 2>&1; fi
      log "[1Password] method $method:$C"
      sleep "$METHOD_GAP"
      verdict="$(outcome_after_method)"
      case "$verdict" in
        ok) log "success [1Password] (method=$method:$C, 호출 결과 확인)"; return 0 ;;
        fail) log "click-outcome-unconfirmed [1Password] (method=$method:$C, 호출 실패 확인)"; return 2 ;;
        pending) log "click-outcome-unconfirmed [1Password] (method=$method:$C, 호출 결과 미확인 — 다음 방식 중단)"; return 2 ;;
      esac
      if dialog_gone "$marker"; then
        if outcome_confirmed; then
          log "success [1Password] (method=$method:$C, 호출 결과 확인)"; return 0
        fi
        log "click-outcome-unconfirmed [1Password] (method=$method:$C, 창 닫힘이나 호출 결과 미확인)"
        return 2
      fi
    else
      log "[1Password] approve 버튼 좌표 못찾음 (labels=$labels)"
      break
    fi
  done
  verdict="$(outcome_now)"
  case "$verdict" in ok) log "success [1Password] (호출 결과 확인)"; return 0 ;; fail) log "click-outcome-unconfirmed [1Password] (호출 실패 확인)"; return 2 ;; esac
  ax_press "$labels" >/dev/null 2>&1
  log "[1Password] method axpress"
  sleep "$METHOD_GAP"
  verdict="$(outcome_after_method)"
  case "$verdict" in
    ok) log "success [1Password] (method=axpress, 호출 결과 확인)"; return 0 ;;
    fail) log "click-outcome-unconfirmed [1Password] (method=axpress, 호출 실패 확인)"; return 2 ;;
    pending) log "click-outcome-unconfirmed [1Password] (method=axpress, 호출 결과 미확인 — 다음 방식 중단)"; return 2 ;;
  esac
  if dialog_gone "$marker"; then
    if outcome_confirmed; then
      log "success [1Password] (method=axpress, 호출 결과 확인)"; return 0
    fi
    log "click-outcome-unconfirmed [1Password] (method=axpress, 창 닫힘이나 호출 결과 미확인)"
    return 2
  fi
  log "click-outcome-unconfirmed [1Password] (모든 승인 방식 소진, 실제 승인 결과 미확인)"
  return 2
}

approve_1password_explicit(){
  local marker="$1" action="$2" combo verdict
  if [ "$DRY" = 1 ]; then do_action "1Password" "$action"; return $?; fi
  "$OCR" "$SHOT" --has "$marker" 2>/dev/null || {
    log "[1Password] dialog marker not present yet"; return 1
  }
  verdict="$(outcome_now)"
  case "$verdict" in
    ok) log "success [1Password] (호출 결과가 승인 방식 전 이미 확인됨)"; return 0 ;;
    fail) log "click-outcome-unconfirmed [1Password] (호출 실패가 승인 방식 전 이미 확인됨)"; return 2 ;;
  esac
  case "$action" in
    key:*)
      IFS='|' read -ra _EXPLICIT_KEYS <<< "${action#key:}"
      for combo in "${_EXPLICIT_KEYS[@]}"; do
        verdict="$(outcome_now)"
        case "$verdict" in ok) log "success [1Password] (호출 결과 확인)"; return 0 ;; fail) log "click-outcome-unconfirmed [1Password] (호출 실패 확인)"; return 2 ;; esac
        focus_1password >/dev/null 2>&1
        sendkey "$combo" >/dev/null 2>&1
        log "[1Password] explicit method key:$combo"
        sleep "$METHOD_GAP"
        verdict="$(outcome_after_method)"
        case "$verdict" in
          ok) log "success [1Password] (explicit method=key:$combo, 호출 결과 확인)"; return 0 ;;
          fail) log "click-outcome-unconfirmed [1Password] (explicit method=key:$combo, 호출 실패 확인)"; return 2 ;;
          pending) log "click-outcome-unconfirmed [1Password] (explicit method=key:$combo, 호출 결과 미확인 — 다음 방식 중단)"; return 2 ;;
        esac
        if dialog_gone "$marker"; then
          if outcome_confirmed; then
            log "success [1Password] (explicit method=key:$combo, 호출 결과 확인)"; return 0
          fi
          log "click-outcome-unconfirmed [1Password] (explicit method=key:$combo, 창 닫힘이나 호출 결과 미확인)"
          return 2
        fi
      done ;;
    ocr:*)
      verdict="$(outcome_now)"
      case "$verdict" in ok) log "success [1Password] (호출 결과 확인)"; return 0 ;; fail) log "click-outcome-unconfirmed [1Password] (호출 실패 확인)"; return 2 ;; esac
      do_action "1Password" "$action" || return 1
      sleep "$METHOD_GAP"
      verdict="$(outcome_after_method)"
      case "$verdict" in
        ok) log "success [1Password] (explicit method=ocr, 호출 결과 확인)"; return 0 ;;
        fail) log "click-outcome-unconfirmed [1Password] (explicit method=ocr, 호출 실패 확인)"; return 2 ;;
        pending) log "click-outcome-unconfirmed [1Password] (explicit method=ocr, 호출 결과 미확인 — 다음 방식 중단)"; return 2 ;;
      esac
      if dialog_gone "$marker"; then
        if outcome_confirmed; then
          log "success [1Password] (explicit method=ocr, 호출 결과 확인)"; return 0
        fi
        log "click-outcome-unconfirmed [1Password] (explicit method=ocr, 창 닫힘이나 호출 결과 미확인)"
        return 2
      fi ;;
    *) log "[1Password] unsupported explicit action: $action"; return 1 ;;
  esac
  log "click-outcome-unconfirmed [1Password] (명시적 승인 방식 소진, 실제 승인 결과 미확인)"
  return 2
}

# 한 action 실행 (성공적으로 "뭔가 했으면" 0). $1=id $2=action
do_action(){
  local id="$1" action="$2" labels C
  case "$action" in
    ocr:*) labels="${action#ocr:}"; C="$("$OCR" "$SHOT" "$labels" 2>/dev/null)"
           if [ -n "$C" ]; then
             if [ "$DRY" = 1 ]; then echo "WOULD click ($C) [$id]"; else "$CLICK" c:"$C" >/dev/null 2>&1; fi
             log "[$id] click $C"; return 0
           fi
           log "[$id] 버튼 못찾음 (labels=$labels)"; return 1 ;;
    key:*) local combo="${action#key:}"
           if [ "$DRY" = 1 ]; then echo "WOULD key '$combo' [$id]"; else sendkey "$combo" >/dev/null 2>&1; fi
           log "[$id] key $combo"; return 0 ;;
    *)     log "[$id] unknown action: $action"; return 1 ;;
  esac
}

# 검증: 창이 닫혔나? $1=marker(빈값이면 일반 라벨로 판단). 닫혔으면 0.
dialog_gone(){
  local marker="$1"
  [ -n "${RP_SHOT:-}" ] && return 0       # 테스트(단발): 재캡처 불가 → 성공 간주
  capture || return 1
  if [ -n "$marker" ]; then
    "$OCR" "$SHOT" --has "$marker" 2>/dev/null && return 1 || return 0
  else
    [ -z "$("$OCR" "$SHOT" "$GENERIC_LABELS" 2>/dev/null)" ] && return 0 || return 1
  fi
}

# 키 후보가 현재 창에서 승인 동작임을 확인한다. 창이 닫힌 것만으로는 Decline 과 구분할 수 없으므로,
# 화면에 표시된 승인 단축키 계약을 확인할 수 없는 키는 성공으로 간주하지 않는다.
key_targets_approval(){
  local id="$1" combo="$2" labels="" declared="" candidate
  case "$id:$combo" in
    "Claude for Chrome:cmd+return"|"Claude for Chrome:command+return")
      labels="Always Allow|Always Approve|항상 허용|항상 승인" ;;
    "Claude for Chrome:return"|"Claude for Chrome:enter")
      labels="Allow Once|Approve Once|Authorize Once|한 번 허용|한 번 승인" ;;
    *)
      # 사용자 지정 --type 또는 rules.txt 의 key action 자체가 승인 의도를 명시한다.
      if [ -n "$HINT_TYPE" ]; then
        declared="${HINT_TYPE#key:}"
      else
        declared="$(rule_by_id "$id")"; declared="${declared#*$'\t'}"; declared="${declared#key:}"
      fi
      IFS='|' read -ra _DECLARED_KEYS <<< "$declared"
      for candidate in "${_DECLARED_KEYS[@]}"; do
        [ "$candidate" = "$combo" ] && { log "[$id] key=$combo 승인 action 명시 확인"; return 0; }
      done
      log "[$id] key=$combo 승인 동작 매핑 없음"; return 1 ;;
  esac
  [ -n "$("$OCR" "$SHOT" "$labels" 2>/dev/null)" ] || {
    log "[$id] key=$combo 승인 라벨 미확인 (labels=$labels)"; return 1
  }
}

# 액션 + 검증 + 재시도. $1=id $2=marker $3=action. 승인 결과가 확인되면 0, 실패 1.
# key 후보는 승인 단축키임을 먼저 확인하고 순차 시도한다. 확인된 키가 창을 닫은 경우에만 성공.
#   (Claude-for-Chrome 처럼 사이트마다 승인키가 cmd+return / return 으로 갈리는 창 대응)
act_and_verify(){
  local id="$1" marker="$2" action="$3"
  if [ "$id" = "1Password" ]; then
    if [ -n "$HINT_TYPE" ] || [[ "$action" = key:* ]]; then
      approve_1password_explicit "$marker" "$action"; return $?
    elif [[ "$action" = ocr:* ]]; then
      approve_1password "$marker" "${action#ocr:}"; return $?
    fi
  fi
  case "$action" in
    key:*)
      # 각 후보 키를 짧은 간격으로 다회 연타(매번 닫힘 확인 → 닫히면 즉시 멈춰 부작용 방지).
      # 팝업 출현 타이밍과 트리거가 어긋나도 단시간 다회로 명중 확률을 높인다.
      local combo t tries="${RP_KEY_TRIES:-5}" gap="${RP_KEY_GAP:-0.3}"
      IFS='|' read -ra _KC <<< "${action#key:}"
      for combo in "${_KC[@]}"; do
        [ -z "$combo" ] && continue
        key_targets_approval "$id" "$combo" || continue
        if [ "$DRY" = 1 ]; then echo "WOULD key '$combo' x$tries [$id]"; return 0; fi
        for t in $(seq 1 "$tries"); do
          sendkey "$combo" >/dev/null 2>&1
          sleep "$gap"
          if dialog_gone "$marker"; then log "success [$id] (key=$combo #$t, 승인 단축키 확인)"; return 0; fi
        done
        log "[$id] key=$combo ${tries}회 후 미확인 → 다음 후보 키"
      done
      log "[$id] 모든 후보 키 ${tries}회씩 시도했으나 닫힘 미확인"; return 1 ;;
    *)
      do_action "$id" "$action" || return 1
      [ "$DRY" = 1 ] && return 0
      # OCR/click에는 호출 결과(op read 등)를 관찰할 채널이 없다. 창 닫힘은
      # timeout/Decline/잘못된 좌표와도 구분되지 않으므로 성공 근거로 쓰지 않는다.
      sleep "$CLICK_VERIFY_DELAY"
      if dialog_gone "$marker"; then
        log "click-outcome-unconfirmed [$id] (창 닫힘, 실제 승인 결과 미확인)"
      else
        log "click-outcome-unconfirmed [$id] (창 열림, 실제 승인 결과 미확인)"
      fi
      return 2 ;;
  esac
}

# 2=click outcome unconfirmed. Dialog disappearance alone cannot prove approval,
# so terminate this router attempt without reporting success.
attempt_and_route(){
  act_and_verify "$@"; local rc=$?
  [ "$rc" -eq 2 ] && exit 1
  return "$rc"
}

# haiku 분류: 화면에 어떤 "알려진 승인창"이 떴는지 ID 한 토큰. (좌표 안 줌 — 분류 전용)
#   출력: <id> | UNKNOWN(승인창인데 룰에 없음) | NONE(승인창 아님)
vision_classify(){
  [ "$VISION" = off ] && { echo NONE; return; }
  local ids; ids="$(awk -F'\t' '$0!~/^[[:space:]]*#/ && NF>=3 {printf "  %s\t%s\n",$1,$2}' "$RULES")"
  local hintline=""; [ -n "$HINT" ] && hintline="The caller expects roughly a \"$HINT\" approval dialog — use this as a hint, but verify against the screenshot.
"
  local prompt="A screenshot of a macOS screen is saved at this file path: $SHOT
Read that image file. Determine whether a permission / approval / authorization DIALOG that a user must approve is currently visible.
${hintline}Known approval dialogs (ID<tab>marker):
$ids
Reply with EXACTLY ONE token, nothing else:
- the matching ID (verbatim) if the visible approval dialog is one of the known ones
- UNKNOWN if an approval dialog is visible but matches none of them
- NONE if no approval dialog is visible"
  local out err; out="$(mktemp)"; err="$(mktemp)"
  # 프롬프트는 positional 로 '먼저' — --allowed-tools 는 variadic 이라 뒤에 두면 prompt 를 삼킨다.
  ( "$CLAUDE" -p "$prompt" --model "$VISION_MODEL" --allowed-tools Read >"$out" 2>"$err" ) & local pp=$!
  ( sleep "$VISION_TIMEOUT"; kill -9 "$pp" 2>/dev/null ) & local kk=$!
  wait "$pp" 2>/dev/null; local rc=$?; kill "$kk" 2>/dev/null
  LAST_VISION_RC=$rc                            # 0=정상(NONE 포함), ≠0=에러/타임아웃(137)
  [ "$rc" -ne 0 ] && log "vision claude rc=$rc: $(tr '\n' ' ' <"$err" 2>/dev/null | tail -c 160)"
  local tok; tok="$(tr -s '[:space:]' '\n' < "$out" | grep -v '^$' | tail -1)"; rm -f "$out" "$err"
  [ -n "$tok" ] && echo "$tok" || echo NONE
}

# id 로 룰 라인 찾기 → "marker<TAB>action" echo (없으면 빈값)
rule_by_id(){
  awk -F'\t' -v want="$1" '$0!~/^[[:space:]]*#/ && NF>=3 && $1==want {print $2"\t"$3; exit}' "$RULES"
}

# ── 메인: 적응형 폴링 ──
deadline=$(( $(date +%s) + WAIT_SECS ))
cycle=0
while :; do
  cycle=$((cycle+1))
  capture || { sleep "$INTERVAL"; [ "$(date +%s)" -ge "$deadline" ] && break || continue; }

  # 0) 힌트 룰 우선 시도 (에이전트가 어떤 승인인지 알려준 경우)
  handled=0
  # --type 만 제공됐더라도 실제 결과 채널이 있으면, 보이는 1Password
  # 마커를 먼저 식별해 포커스+결과확인 경로를 우회하지 않게 한다.
  if [ -z "$HINT_ID" ] && [ -n "$HINT_TYPE" ] && [ -n "$OUTCOME_FILE" ]; then
    _onepass="$(rule_by_id "1Password")"
    _onemarker="${_onepass%%$'\t'*}"
    [ -n "$_onemarker" ] && "$OCR" "$SHOT" --has "$_onemarker" 2>/dev/null && HINT_ID="1Password"
    if [ -z "$HINT_ID" ]; then
      [ "$(date +%s)" -ge "$deadline" ] && break
      sleep "$INTERVAL"
      continue
    fi
  fi
  # 설계철학: 에이전트가 --for 로 "이 승인이 떴다"고 명시하면 그 판단을 신뢰한다 →
  # OCR 매칭 없이도 룰 action(예: key:return)을 바로 실행. vision/OCR 은 힌트가 없을 때의 fallback 일 뿐.
  # key:<combo> 는 OCR 0% 의존(키만 전송)이라, 화면을 못 읽어도 동작한다. act_and_verify 가 '창 닫힘'으로
  # 결과를 검증하므로, 안 닫히면(엉뚱하면) 에이전트에게 실패로 보고되어 에이전트가 다시 판단한다.
  if [ -n "$HINT_ID" ] || [ -n "$HINT_TYPE" ]; then
    hra="$(rule_by_id "$HINT_ID")"
    hmarker=""; haction=""
    [ -n "$hra" ] && { hmarker="${hra%%$'\t'*}"; haction="${hra#*$'\t'}"; }
    [ -n "$HINT_TYPE" ] && haction="$HINT_TYPE"          # --type: 에이전트가 방식 직접 지정 → 룰 action override
    [ -z "$haction" ] && haction="ocr:$GENERIC_LABELS"   # for/type 둘 다 모호 → 범용 승인 버튼
    if attempt_and_route "${HINT_ID:-agent-type}" "$hmarker" "$haction"; then exit 0; fi
    handled=1
  fi

  # 1) OCR 룰 (전체)
  while IFS=$'\t' read -r id marker action; do
    case "$id" in ''|\#*) continue;; esac
    { [ -z "${marker:-}" ] || [ -z "${action:-}" ]; } && continue
    "$OCR" "$SHOT" --has "$marker" 2>/dev/null || continue
    if attempt_and_route "$id" "$marker" "$action"; then exit 0; fi
    handled=1   # 시도는 했음(검증 실패) → 다음 사이클 재시도
  done < "$RULES"

  # 2) 룰 미스 → haiku 분류 폴백 (사이클 게이트로 빈도 제한)
  if [ "$handled" = 0 ] && [ "$VISION" != off ] && [ $(( cycle % VISION_EVERY )) -eq 0 ]; then
    vid="$(vision_classify)"
    if [ "$LAST_VISION_RC" -ne 0 ]; then
      VISION_FAILS=$((VISION_FAILS+1))
      if [ "$VISION_FAILS" -ge "$VISION_MAX_FAILS" ]; then
        VISION=off; log "vision 연속 실패 ${VISION_FAILS}회 → 이 실행 동안 비활성(OCR 룰만)"
      fi
    else
      VISION_FAILS=0                              # 정상 응답이면 카운터 리셋
    fi
    log "vision → $vid"
    case "$vid" in
      NONE|none|"") : ;;
      UNKNOWN|unknown) if attempt_and_route "vision-unknown" "" "ocr:$GENERIC_LABELS"; then exit 0; fi ;;
      *) ra="$(rule_by_id "$vid")"
         if [ -n "$ra" ]; then
           vmarker="${ra%%$'\t'*}"; vaction="${ra#*$'\t'}"
           if attempt_and_route "$vid" "$vmarker" "$vaction"; then exit 0; fi
         else
           # haiku 가 임의 토큰 반환 → 일반 라벨로 시도
           if attempt_and_route "vision:$vid" "" "ocr:$GENERIC_LABELS"; then exit 0; fi
         fi ;;
    esac
  fi

  [ -n "${RP_SHOT:-}" ] && break               # 테스트(단발)
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep "$INTERVAL"
done

log "no dialog handled within ${WAIT_SECS}s"
exit 1
