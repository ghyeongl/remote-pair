#!/usr/bin/env bash
# t_04_target — verifies the uniform-host launch contract.
#
# Observation method: judged from MLOG's mock call log.
#   configured host -> ssh reach/setup and mosh attach
#   no host         -> guidance error, no tmux/ssh/mosh
cd "$(dirname "$0")"; . ./lib.sh

# ────────────────────────────────────────────────────────────
# Scenario 1: REMOTE_HOST set -> remote path (ssh + mosh), no target prompt
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ RP_YES=1 \
  run_launcher "$SBX"

it "target/configured-host->remote"
assert_rc "$RP_RC" 0 "configured host launch succeeds"
assert_contains "$MLOG" "ssh|"  "ssh reach/setup called (remote path)"
assert_contains "$MLOG" "mosh|" "mosh attach called (remote path)"
assert_absent   "$RP_OUT" "select" "no target-selection prompt emitted"

cleanup_sandbox

# ────────────────────────────────────────────────────────────
# Scenario 2: REMOTE_HOST empty -> fail with guidance, no tmux/ssh/mosh
# ────────────────────────────────────────────────────────────
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks
run_launcher "$SBX"

it "target/empty-remote-host->error"
assert_rc "$RP_RC" 1 "empty host is a configuration error"
assert_contains "$RP_ERR" "no host configured" "guidance is printed"
assert_absent "$MLOG" "tmux-aqua" "tmux-aqua not called without a host"
assert_absent "$MLOG" "ssh|" "ssh not called without a host"
assert_absent "$MLOG" "mosh|" "mosh not called without a host"

cleanup_sandbox

# ────────────────────────────────────────────────────────────
# Scenario 3: removed --local flag -> unknown option, exit 2
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
run_launcher --local "$SBX"

it "target/removed-local-flag"
assert_rc "$RP_RC" 2 "--local is rejected"
assert_contains "$RP_ERR" "unknown option: --local" "unknown-option error is printed"
assert_absent "$MLOG" "tmux-aqua" "tmux-aqua not called for rejected option"
assert_absent "$MLOG" "ssh|" "ssh not called for rejected option"
assert_absent "$MLOG" "mosh|" "mosh not called for rejected option"

cleanup_sandbox

# ────────────────────────────────────────────────────────────
# Scenario 4: _remote_next_n via MLOG — _remote_next_n reused in RN loop
# No live mosh-clients -> RN=1 -> remote session created as _1
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ RP_YES=1 \
  run_launcher "$SBX"

it "target/remote-rn-1-no-mosh-clients"
assert_contains "$MLOG" "mosh|" "mosh invoked (remote path)"
# The SSH setup script contains SESSION=..._1 (RN=1)
SSH_SCRIPT="$(cat "$SSH_CAPTURE" 2>/dev/null)"
assert_contains "$SSH_SCRIPT" "_1" "remote setup script targets session _1"

cleanup_sandbox

finish
