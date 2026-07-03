#!/usr/bin/env bash
# t_22_logs — local logs include host logs when this machine has a host install.
cd "$(dirname "$0")"; . ./lib.sh

XPAIR_SRC="${XPAIR_SRC:-$_REPO_ROOT/client/cli/xpair}"

run_xpair_logs() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" bash "$XPAIR_SRC" logs "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}

new_sandbox
printf 'HOST_ONLY=1\n' > "$RP_HOST_DIR/host.env"
printf 'NOTE\thost install\t\n' > "$RP_HOST_DIR/.manifest-host"
printf 'client log line\n' > "$RP_CLIENT_DIR/logs/client.log"
printf 'host app log line\n' > "$RP_HOST_DIR/logs/host.log"

run_xpair_logs -n 5
it "logs/local-includes-host-logs"
assert_rc "$RP_RC" 0 "xpair logs rc=0 :: stderr=[$RP_ERR]"
assert_contains "$RP_OUT" "client log line" "local logs include client log dir"
assert_contains "$RP_OUT" "host app log line" "local logs include host log dir on host-capable machine"

run_xpair_logs --collect
BUNDLE="$(printf '%s\n' "$RP_OUT" | tail -1)"
CONTENTS="$(tar -tzf "$BUNDLE" 2>/dev/null || true)"
it "logs/collect-includes-host-and-client"
assert_rc "$RP_RC" 0 "xpair logs --collect rc=0 :: stderr=[$RP_ERR]"
assert_contains "$CONTENTS" "client/logs/client.log" "collect archive includes client logs"
assert_contains "$CONTENTS" "host/logs/host.log" "collect archive includes host logs on host-capable machine"
cleanup_sandbox

finish
