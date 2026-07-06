#!/bin/bash
# xpair-approve-router.sh — detect an approval dialog that is up (or about to appear) → allow it → verify it closed.
#
# XpairHost (menu-bar app, AX+screen-recording+PostEvent granted) invokes this as a child on trigger → permissions inherited.
# claude/skills only "trigger when blocked"; which dialog to allow and how is entirely routed here.
#
# Improvements (v3):
#   1) Adaptive polling — even if the dialog isn't up yet right after the trigger (the agent raises it a few seconds later), wait during WAIT.
#   2) Verification loop — re-capture after a click/key to confirm "the marker is gone." If not closed, retry. exit 0=success / 1=failure.
#   3) Hybrid vision — OCR rules first (fast). On a miss, haiku only classifies "which known dialog is this" (it can't give coordinates).
#        Execute the classification result via the rule's action (OCR button text→coordinates / key). On UNKNOWN, fall back to generic approve labels.
#
# rules.txt v2 (tab-separated):  id <TAB> marker <TAB> action
#   marker = OCR text for detection/verification (substring match, case-insensitive) — also used as the description for haiku classification
#   action = ocr:<label|label..> (find the button text and click) | key:<combo> (cmd+return, return, esc …)
set -u
# Make sure claude·screencapture·cliclick are on PATH (the PATH an app spawns with directly is sparse)
export PATH="/usr/sbin:/usr/bin:/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SCAP=/usr/sbin/screencapture
RP_DIR="${RP_DIR:-$HOME/.xpair/host}"

OCR="$(command -v ocr-find 2>/dev/null || true)"
[ -n "$OCR" ] || for _c in "$RP_DIR/bin/ocr-find" "$HOME/.claude/bin/ocr-find"; do [ -x "$_c" ] && { OCR="$_c"; break; }; done
CLICK="$(command -v cliclick 2>/dev/null || echo /opt/homebrew/bin/cliclick)"
CLAUDE="$(command -v claude 2>/dev/null || true)"

RULES="${RULES_FILE:-$RP_DIR/rules.txt}"; [ -f "$RULES" ] || RULES="$HOME/.claude/auto-approve/rules.txt"
LOG="${LOG_FILE:-$RP_DIR/logs/xpair.log}"; mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
SHOT="${RP_SHOT:-/tmp/rp-router.png}"          # when RP_SHOT is set, use that image (test, one-shot)
DRY="${RP_DRY:-0}"                             # RP_DRY=1 = don't actually click/press keys (intent only)

# adaptive polling / verification tunables
WAIT_SECS="${RP_WAIT_SECS:-${1:-18}}"          # total window (seconds) to wait for the approval dialog to appear
INTERVAL="${RP_INTERVAL:-1.2}"                 # polling interval
VERIFY_RETRY="${RP_VERIFY_RETRY:-3}"           # retries to confirm "is it closed" after a click
# vision (haiku) — reuse the subscription claude CLI, best-effort
VISION="${RP_VISION:-auto}"                    # auto (on rule miss) | on | off
VISION_MODEL="${RP_VISION_MODEL:-claude-haiku-4-5}"
VISION_TIMEOUT="${RP_VISION_TIMEOUT:-12}"      # cap per vision call (so OCR polling recovers even if headless claude is slow or stuck)
VISION_EVERY="${RP_VISION_EVERY:-2}"           # call vision only once every N cycles (limit latency/cost)
VISION_MAX_FAILS="${RP_VISION_MAX_FAILS:-2}"   # N consecutive claude failures → auto-disable vision for this run
VISION_FAILS=0; LAST_VISION_RC=0
GENERIC_LABELS="Allow|Authorize|Authorize Once|Always Allow|Approve|Confirm|Continue|OK|허용|승인|확인|한 번 승인"

log(){ printf '%s router: %s\n' "$(date '+%H:%M:%S')" "$1" >> "$LOG"; }
[ -n "$OCR" ] || { log "ocr-find missing — aborting"; exit 1; }

# hint: if the agent tells us in advance "which approval this is" (rule id or free text), try that rule first +
#   use it as the prior for haiku classification. Optional. (passed by the CLI via a .label file, or the RP_FOR env var)
HINT_FILE="${RP_HINT_FILE:-/tmp/xpair.approve-request.label}"
TYPE_FILE="${RP_TYPE_FILE:-/tmp/xpair.approve-request.type}"
HINT="${RP_FOR:-}"
[ -z "$HINT" ] && [ -f "$HINT_FILE" ] && HINT="$(head -1 "$HINT_FILE" 2>/dev/null)"
# --type: the agent directly specifies "how to approve" (key:<combo> | ocr:<label>) → overrides the rule action on the hint path
HINT_TYPE="${RP_TYPE:-}"
[ -z "$HINT_TYPE" ] && [ -f "$TYPE_FILE" ] && HINT_TYPE="$(head -1 "$TYPE_FILE" 2>/dev/null)"
rm -f "$HINT_FILE" "$TYPE_FILE" 2>/dev/null || true
[ -n "$HINT_TYPE" ] && log "type (agent-specified): $HINT_TYPE"
HINT_ID=""
if [ -n "$HINT" ]; then
  # alias-tolerant: normalize browser names/variants to a rule id (e.g. Google Chrome/Chrome → Claude for Chrome)
  case "$(printf '%s' "$HINT" | tr '[:upper:]' '[:lower:]')" in
    *chrome*) HINT="Claude for Chrome" ;;
    *1password*|*"1 password"*) HINT="1Password" ;;
  esac
  log "hint: $HINT"
  HINT_ID="$(awk -F'\t' -v h="$(printf '%s' "$HINT" | tr '[:upper:]' '[:lower:]')" '
    $0!~/^[[:space:]]*#/ && NF>=3 { lid=tolower($1); if (index(lid,h)>0 || index(h,lid)>0) { print $1; exit } }' "$RULES")"
  [ -n "$HINT_ID" ] && log "hint → trying rule '$HINT_ID' first"
fi
[ "$VISION" != off ] && [ -z "$CLAUDE" ] && { log "claude CLI missing → vision disabled (OCR rules only)"; VISION=off; }

capture(){ [ -n "${RP_SHOT:-}" ] && return 0; $SCAP -x "$SHOT" 2>/tmp/rp-scap.err || { log "screencapture failed: $(tr '\n' ' ' </tmp/rp-scap.err 2>/dev/null)"; return 1; }; }

# Key presses go through osascript (System Events) — cliclick (synthetic CGEvent keys) doesn't work on web-UI popups like
# Chrome extensions (confirmed empirically), whereas System Events key code does. Avoids coordinate clicks (risk of OCR mismatch).
# "cmd+return" → key code 36 using {command down}  /  "return" → key code 36
sendkey(){
  local combo="$1" key mods="" m kc parts="" M
  key="${combo##*+}"; [ "$combo" != "$key" ] && mods="${combo%+*}"
  case "$key" in
    return|enter) kc=36 ;; esc|escape) kc=53 ;; space) kc=49 ;; tab) kc=48 ;; *) kc="" ;;
  esac
  IFS='+' read -ra M <<< "$mods"
  for m in ${M[@]+"${M[@]}"}; do case "$m" in
    cmd|command) parts="$parts command down," ;; shift) parts="$parts shift down," ;;
    ctrl|control) parts="$parts control down," ;; alt|option) parts="$parts option down," ;;
  esac; done
  local mod=""; [ -n "$parts" ] && mod=" using {${parts%,}}"
  if [ -n "$kc" ]; then
    osascript -e "tell application \"System Events\" to key code $kc$mod"
  else
    osascript -e "tell application \"System Events\" to keystroke \"$key\"$mod"
  fi
}

# Run one action (0 if it "did something" successfully). $1=id $2=action
do_action(){
  local id="$1" action="$2" labels C
  case "$action" in
    ocr:*) labels="${action#ocr:}"; C="$("$OCR" "$SHOT" "$labels" 2>/dev/null)"
           if [ -n "$C" ]; then
             if [ "$DRY" = 1 ]; then echo "WOULD click ($C) [$id]"; else "$CLICK" c:"$C" >/dev/null 2>&1; fi
             log "[$id] click $C"; return 0
           fi
           log "[$id] button not found (labels=$labels)"; return 1 ;;
    key:*) local combo="${action#key:}"
           if [ "$DRY" = 1 ]; then echo "WOULD key '$combo' [$id]"; else sendkey "$combo" >/dev/null 2>&1; fi
           log "[$id] key $combo"; return 0 ;;
    *)     log "[$id] unknown action: $action"; return 1 ;;
  esac
}

# Verify: is the dialog closed? $1=marker (empty → judge by generic labels). 0 if closed.
dialog_gone(){
  local marker="$1"
  [ -n "${RP_SHOT:-}" ] && return 0       # test (one-shot): can't re-capture → treat as success
  capture || return 1
  if [ -n "$marker" ]; then
    "$OCR" "$SHOT" --has "$marker" 2>/dev/null && return 1 || return 0
  else
    [ -z "$("$OCR" "$SHOT" "$GENERIC_LABELS" 2>/dev/null)" ] && return 0 || return 1
  fi
}

# Action + verify + retry. $1=id $2=marker $3=action. Success (closed) 0, failure 1.
# If the action is 'key:A|B|...', try each candidate key in turn (verify dialog closed after each press) — success if any closes it.
#   (handles dialogs like Claude-for-Chrome where the approve key differs per site between cmd+return / return)
act_and_verify(){
  local id="$1" marker="$2" action="$3" i
  case "$action" in
    key:*\|*)
      # Tap each candidate key several times at short intervals (check for close each time → stop immediately once closed to avoid side effects).
      # Even if popup-appearance timing is out of sync with the trigger, many taps over a short window raise the hit probability.
      local combo t tries="${RP_KEY_TRIES:-5}" gap="${RP_KEY_GAP:-0.3}"
      IFS='|' read -ra _KC <<< "${action#key:}"
      for combo in "${_KC[@]}"; do
        [ -z "$combo" ] && continue
        if [ "$DRY" = 1 ]; then echo "WOULD key '$combo' x$tries [$id]"; return 0; fi
        for t in $(seq 1 "$tries"); do
          sendkey "$combo" >/dev/null 2>&1
          sleep "$gap"
          if dialog_gone "$marker"; then log "success [$id] (key=$combo #$t, dialog closed)"; return 0; fi
        done
        log "[$id] key=$combo unconfirmed after ${tries} tries → next candidate key"
      done
      log "[$id] tried all candidate keys ${tries} times each but close unconfirmed"; return 1 ;;
    *)
      do_action "$id" "$action" || return 1
      [ "$DRY" = 1 ] && return 0
      for i in $(seq 1 "$VERIFY_RETRY"); do
        sleep 0.8
        if dialog_gone "$marker"; then log "success [$id] (verified: dialog closed)"; return 0; fi
        log "[$id] still not closed — re-clicking ($i/$VERIFY_RETRY)"
        do_action "$id" "$action" || break
      done
      log "[$id] clicked but close unconfirmed"; return 1 ;;
  esac
}

# haiku classification: a single token ID for which "known approval dialog" is on screen. (no coordinates — classification only)
#   output: <id> | UNKNOWN (it's an approval dialog but not in the rules) | NONE (not an approval dialog)
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
  # The prompt goes 'first' as positional — --allowed-tools is variadic, so placing it after would swallow the prompt.
  ( "$CLAUDE" -p "$prompt" --model "$VISION_MODEL" --allowed-tools Read >"$out" 2>"$err" ) & local pp=$!
  ( sleep "$VISION_TIMEOUT"; kill -9 "$pp" 2>/dev/null ) & local kk=$!
  wait "$pp" 2>/dev/null; local rc=$?; kill "$kk" 2>/dev/null
  LAST_VISION_RC=$rc                            # 0=normal (incl. NONE), ≠0=error/timeout (137)
  [ "$rc" -ne 0 ] && log "vision claude rc=$rc: $(tr '\n' ' ' <"$err" 2>/dev/null | tail -c 160)"
  local tok; tok="$(tr -s '[:space:]' '\n' < "$out" | grep -v '^$' | tail -1)"; rm -f "$out" "$err"
  [ -n "$tok" ] && echo "$tok" || echo NONE
}

# Find the rule line by id → echo "marker<TAB>action" (empty if not found)
rule_by_id(){
  awk -F'\t' -v want="$1" '$0!~/^[[:space:]]*#/ && NF>=3 && $1==want {print $2"\t"$3; exit}' "$RULES"
}

# ── Main: adaptive polling ──
deadline=$(( $(date +%s) + WAIT_SECS ))
cycle=0
while :; do
  cycle=$((cycle+1))
  capture || { sleep "$INTERVAL"; [ "$(date +%s)" -ge "$deadline" ] && break || continue; }

  # 0) Try the hint rule first (when the agent told us which approval it is)
  handled=0
  # Design philosophy: when the agent states via --for "this approval came up," we trust that judgment →
  # run the rule action (e.g. key:return) directly without OCR matching. vision/OCR are just the fallback when there's no hint.
  # key:<combo> depends 0% on OCR (keys only), so it works even when the screen can't be read. Since act_and_verify
  # verifies the result by "dialog closed," if it doesn't close (wrong guess) it's reported as a failure to the agent, which then re-judges.
  if [ -n "$HINT_ID" ] || [ -n "$HINT_TYPE" ]; then
    hra="$(rule_by_id "$HINT_ID")"
    hmarker=""; haction=""
    [ -n "$hra" ] && { hmarker="${hra%%$'\t'*}"; haction="${hra#*$'\t'}"; }
    [ -n "$HINT_TYPE" ] && haction="$HINT_TYPE"          # --type: agent specifies the method directly → overrides the rule action
    [ -z "$haction" ] && haction="ocr:$GENERIC_LABELS"   # both for/type ambiguous → generic approve button
    if act_and_verify "${HINT_ID:-agent-type}" "$hmarker" "$haction"; then exit 0; fi
    handled=1
  fi

  # 1) OCR rules (all)
  while IFS=$'\t' read -r id marker action; do
    case "$id" in ''|\#*) continue;; esac
    { [ -z "${marker:-}" ] || [ -z "${action:-}" ]; } && continue
    "$OCR" "$SHOT" --has "$marker" 2>/dev/null || continue
    if act_and_verify "$id" "$marker" "$action"; then exit 0; fi
    handled=1   # we did try (verification failed) → retry next cycle
  done < "$RULES"

  # 2) Rule miss → haiku classification fallback (rate-limited by cycle gate)
  if [ "$handled" = 0 ] && [ "$VISION" != off ] && [ $(( cycle % VISION_EVERY )) -eq 0 ]; then
    vid="$(vision_classify)"
    if [ "$LAST_VISION_RC" -ne 0 ]; then
      VISION_FAILS=$((VISION_FAILS+1))
      if [ "$VISION_FAILS" -ge "$VISION_MAX_FAILS" ]; then
        VISION=off; log "vision failed ${VISION_FAILS} times in a row → disabled for this run (OCR rules only)"
      fi
    else
      VISION_FAILS=0                              # reset the counter on a normal response
    fi
    log "vision → $vid"
    case "$vid" in
      NONE|none|"") : ;;
      UNKNOWN|unknown) if act_and_verify "vision-unknown" "" "ocr:$GENERIC_LABELS"; then exit 0; fi ;;
      *) ra="$(rule_by_id "$vid")"
         if [ -n "$ra" ]; then
           vmarker="${ra%%$'\t'*}"; vaction="${ra#*$'\t'}"
           if act_and_verify "$vid" "$vmarker" "$vaction"; then exit 0; fi
         else
           # haiku returned an arbitrary token → try with generic labels
           if act_and_verify "vision:$vid" "" "ocr:$GENERIC_LABELS"; then exit 0; fi
         fi ;;
    esac
  fi

  [ -n "${RP_SHOT:-}" ] && break               # test (one-shot)
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep "$INTERVAL"
done

log "no dialog handled within ${WAIT_SECS}s"
exit 1
