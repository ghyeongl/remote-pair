#!/usr/bin/env bash
# t_08 — error logging / die / stderr tee / zombie-cleanup safety (US-8).
cd "$(dirname "$0")"; . ./lib.sh

# ── s1: LAUNCH_LOG header written ──
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks
MOCK_HASSESSION=0 run_launcher "$SBX"
it "s1/launch-log-header"
LOGTXT="$(cat "$RP_CLIENT_DIR/logs/claude-launch.err.log" 2>/dev/null)"
assert_contains "$LOGTXT" "launch" "launch header written to LAUNCH_LOG"
assert_contains "$LOGTXT" "=====" "header separator present"
cleanup_sandbox

# ── s2: die — nonexistent project folder → rc=1 ──
new_sandbox
make_all_mocks
RP_YES=1 run_launcher "$SBX/does-not-exist-xyz"
it "s2/die-missing-dir"
assert_rc "$RP_RC" 1 "missing folder → die rc=1"
assert_contains "$RP_ERR$(cat "$RP_CLIENT_DIR/logs/claude-launch.err.log" 2>/dev/null)" "directory not found" "die message printed"
cleanup_sandbox

# ── s3: stderr tee → stderr warning lands in LAUNCH_LOG ──
# reach failure + tailscale absent → stderr warning → via tee it must also remain in LAUNCH_LOG.
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude hangul-romanize launchctl open tput
MOCK_REACH=fail MOCK_HASSESSION=0 run_launcher "$SBX"
it "s3/stderr-tee-to-log"
LOGTXT="$(cat "$RP_CLIENT_DIR/logs/claude-launch.err.log" 2>/dev/null)"
assert_contains "$LOGTXT" "tailscale" "stderr warning tee'd into LAUNCH_LOG"
cleanup_sandbox

# ── s4: zombie-cleanup safety — no mosh-client → no-op, remote proceeds ──
# (the actual kill path needs a matching mosh-client process, so it is unverified headless — limitation noted)
new_sandbox
make_all_mocks
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher "$SBX"
it "s4/zombie-cleanup-noop-safe"
assert_contains "$MLOG" "list-sessions" "zombie cleanup: queries host attach list (ssh list-sessions)"
assert_contains "$MLOG" "mosh|" "no matching mosh-client → remote attach proceeds normally"
cleanup_sandbox

finish
