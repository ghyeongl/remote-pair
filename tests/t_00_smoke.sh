#!/usr/bin/env bash
# t_00_smoke — harness self-check (US-1) + minimal verification of the uniform host path.
cd "$(dirname "$0")"; . ./lib.sh

# Scenario: configured host, reachable SSH, existing mapped directory -> ssh setup + mosh attach.
new_sandbox
make_all_mocks
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ \
  run_launcher "$SBX"

it "harness/remote-launch"
assert_rc "$RP_RC" 0 "remote launch succeeds"
assert_contains "$MLOG" "ssh|" "ssh invoked on the configured host path"
assert_contains "$MLOG" "mosh|" "mosh attach invoked"
assert_absent "$MLOG" "tmux-aqua|-S|/tmp/aqua-tmux.sock|new-session" "no client-side local tmux session"

cleanup_sandbox
finish
