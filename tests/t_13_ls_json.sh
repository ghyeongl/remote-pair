#!/usr/bin/env bash
cd "$(dirname "$0")"; . ./lib.sh

CLI_SRC="${CLI_SRC:-$_REPO_ROOT/client/cli/xpair}"

run_cli() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" RP_DIR="$RP_DIR" HOME="$HOME" bash "$CLI_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
  MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
}

assert_json_contains() {
  RP_JSON="$RP_OUT" python3 - "$1" <<'PY'
import json
import os
import sys

expected = sys.argv[1]
doc = json.loads(os.environ["RP_JSON"])
names = [session.get("name") for session in doc.get("sessions", [])]
if expected not in names:
    raise SystemExit(f"missing session {expected!r} in {names!r}")
PY
  [ $? = 0 ] && _pass "json contains session '$1' ($2)" || _fail "json missing session '$1' ($2) :: out=[$RP_OUT]"
}

assert_json_absent() {
  RP_JSON="$RP_OUT" python3 - "$1" <<'PY'
import json
import os
import sys

blocked = sys.argv[1]
doc = json.loads(os.environ["RP_JSON"])
names = [session.get("name") for session in doc.get("sessions", [])]
if blocked in names:
    raise SystemExit(f"unexpected session {blocked!r} in {names!r}")
PY
  [ $? = 0 ] && _pass "json omits session '$1' ($2)" || _fail "json unexpectedly contains session '$1' ($2) :: out=[$RP_OUT]"
}

assert_json_field() {
  RP_JSON="$RP_OUT" python3 - "$1" "$2" <<'PY'
import json
import os
import sys

name = sys.argv[1]
attached = int(sys.argv[2])
doc = json.loads(os.environ["RP_JSON"])
for session in doc.get("sessions", []):
    if session.get("name") == name:
        if session.get("attached") != attached:
            raise SystemExit(f"attached for {name!r}: expected {attached}, got {session.get('attached')!r}")
        raise SystemExit(0)
raise SystemExit(f"missing session {name!r}")
PY
  [ $? = 0 ] && _pass "json session '$1' attached=$2 ($3)" || _fail "json bad attached for '$1' ($3) :: out=[$RP_OUT]"
}

new_sandbox
make_all_mocks
MOCK_ATT=$'remote_one\t1\nremote_two\t0\n_keeper\t1' run_cli ls --json

it "ls-json/remote-sessions"
assert_rc "$RP_RC" 0 "remote ls json succeeds"
assert_contains "$MLOG" "ssh|-o|BatchMode=yes|-o|ConnectTimeout=5|test-host" "remote json queries configured host"
assert_contains "$MLOG" "list-sessions -F '#S" "remote json asks for formatted sessions"
assert_contains "$MLOG" $'list-sessions -F '\''#S	#{session_attached}'\''' "remote json asks tmux for real-tab session format"
assert_json_contains "remote_one" "remote attached session is listed"
assert_json_contains "remote_two" "remote detached session is listed"
assert_json_absent "_keeper" "remote keeper session is excluded"
assert_json_field "remote_one" 1 "remote attached count preserved"
assert_json_field "remote_two" 0 "remote detached count preserved"
cleanup_sandbox

new_sandbox
make_all_mocks
MOCK_ATT=$'plain_one: 1 windows (attached)\n_keeper: 1 windows\nplain_two: 1 windows' run_cli ls

it "ls-json/plain-human-output"
assert_rc "$RP_RC" 0 "plain ls succeeds"
assert_contains "$RP_OUT" "Folder mappings" "plain ls keeps human mapping header"
assert_contains "$RP_OUT" "[test-host] tmux-aqua sessions:" "plain ls keeps human session header"
assert_contains "$RP_OUT" "plain_one" "plain ls lists normal sessions"
assert_contains "$RP_OUT" "plain_two" "plain ls lists later sessions"
assert_absent "$RP_OUT" "_keeper" "plain ls filters keeper session"
assert_absent "$RP_OUT" '"sessions"' "plain ls is not json output"
cleanup_sandbox

finish
