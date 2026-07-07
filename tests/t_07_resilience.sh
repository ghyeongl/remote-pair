#!/usr/bin/env bash
# t_07_resilience — remote-first resilience: reach failure / dir-check robustness.
#
# Decision 6 (docs/verification/decisions-round1.md, round 2): REMOTE-FIRST, NO auto local fallback.
#   On a remote reach/dir-check failure WITHOUT explicit local mode the launcher MUST:
#     • NOT silently launch a local tmux session (no tmux-aqua/tmux `new-session`)
#     • NOT mutate Tailscale (no `tailscale set --exit-node`); in fact it never calls tailscale at all
#     • surface a connect-required / "please connect" message on stderr and exit non-zero
#   Local is allowed ONLY via an EXPLICIT local mode (--local). These scenarios run WITHOUT --local,
#   so the contract is: surface, don't fall back.
cd "$(dirname "$0")"; . ./lib.sh

# ── Common helper: sleep mock (shortens dir-check retry sleep 1) ──
_install_sleep_mock() {
  printf '#!/bin/bash\nexit 0\n' > "$MOCKBIN/sleep"
  chmod +x "$MOCKBIN/sleep"
}

# ─────────────────────────────────────────────────────────────────────────────
# Scenario 1: reach failure, tailscale CLI absent, no explicit local mode
#   → connect-required message, NO local fallback, NO tailscale mutation. (decision 6)
# ─────────────────────────────────────────────────────────────────────────────
SBX_ROLE=both new_sandbox
# Exclude tailscale from the mock set — proves the launcher never shells out to tailscale.
make_all_mocks ssh mosh tmux tmux-aqua claude hangul-romanize launchctl open tput
_install_sleep_mock
mkdir -p "$SBX/myproject"
MOCK_REACH=fail MOCK_HASSESSION=0 \
  run_launcher "$SBX/myproject"

it "s1/reach-fail: connect-required message on stderr"
assert_contains "$RP_ERR" "please connect" "stderr asks the user to (re)connect"

it "s1/reach-fail: NO silent local fallback (no new-session)"
assert_absent "$MLOG" "new-session" "no local tmux/tmux-aqua session created"

it "s1/reach-fail: tailscale CLI is never invoked"
assert_absent "$MLOG" "tailscale|" "no tailscale call at all"

it "s1/reach-fail: mosh not called (remote attach never reached)"
assert_absent "$MLOG" "mosh|" "confirm mosh not called"

it "s1/reach-fail: exits non-zero (remote unreachable, rc=20)"
assert_rc "$RP_RC" 20 "reach failure exit code"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# Scenario 2: reach failure WITH tailscale present (online exit-node available)
#   → launcher still must NOT mutate tailscale and must NOT fall back to local. (decision 6)
#   This is the explicit anti-regression of the old "set exit-node + local fallback" behavior.
# ─────────────────────────────────────────────────────────────────────────────
SBX_ROLE=both new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude tailscale hangul-romanize launchctl open tput
_install_sleep_mock
# An online, selectable exit-node is available — the OLD code would have set it; the new code must not.
MOCK_TS_JSON='{"Peer":{"k":{"ExitNodeOption":true,"Online":true,"DNSName":"exit.example.ts.net."}}}'
mkdir -p "$SBX/myproject"

MOCK_REACH=fail MOCK_HASSESSION=0 \
  run_launcher "$SBX/myproject"

it "s2/reach-fail-with-tailscale: NO 'tailscale set --exit-node' mutation"
assert_absent "$MLOG" "tailscale|set" "exit-node is never configured"

it "s2/reach-fail-with-tailscale: stderr states tailscale won't be changed"
assert_contains "$RP_ERR" "Tailscale" "stderr explains it won't touch Tailscale settings"

it "s2/reach-fail-with-tailscale: NO silent local fallback (no new-session)"
assert_absent "$MLOG" "new-session" "no local session created"

it "s2/reach-fail-with-tailscale: mosh not called"
assert_absent "$MLOG" "mosh|" "confirm mosh not called"

it "s2/reach-fail-with-tailscale: exits non-zero (rc=20)"
assert_rc "$RP_RC" 20 "reach failure exit code"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# Scenario 3: reach ok + dir-check ok → proceed remotely (mosh). (still-valid happy path)
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude hangul-romanize launchctl open tput
_install_sleep_mock
mkdir -p "$SBX/myproject"

MOCK_REACH=ok MOCK_DIRCHECK=__YES__ \
  run_launcher "$SBX/myproject"

it "s3/reach-ok: proceeds remotely (mosh call)"
assert_contains "$MLOG" "mosh|" "confirm mosh call (remote attach)"

# Note: the remote tmux session IS created via the ssh setup script (which legitimately contains
# `tm new-session` on the host), so we do NOT assert absence of new-session here — that would conflate
# the remote host-side create with a local fallback. The decision-6 "no local fallback" invariant is
# asserted on the FAILURE paths (s1/s2/s4) where ssh setup is never reached.

it "s3/reach-ok: never falls back to a LOCAL tmux-aqua session (no local new-session call)"
assert_absent "$MLOG" "tmux-aqua|-S|/tmp/aqua-tmux.sock|new-session" "no local aqua session created"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# Scenario 4: dir-check ssherr (3 failures), no explicit local mode
#   → connect-required message, NO local fallback, NO tailscale mutation. (decision 6)
# ─────────────────────────────────────────────────────────────────────────────
SBX_ROLE=both new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude tailscale hangul-romanize launchctl open tput
_install_sleep_mock
mkdir -p "$SBX/myproject"

MOCK_REACH=ok MOCK_DIRCHECK=ssherr MOCK_HASSESSION=0 \
  run_launcher "$SBX/myproject"

it "s4/dir-ssherr: NO silent local fallback (no new-session)"
assert_absent "$MLOG" "new-session" "no local session created"

it "s4/dir-ssherr: tailscale set --exit-node never called"
assert_absent "$MLOG" "tailscale|set" "no exit-node mutation"

it "s4/dir-ssherr: mosh not called"
assert_absent "$MLOG" "mosh|" "confirm mosh not called"

it "s4/dir-ssherr: connect-required message on stderr"
assert_contains "$RP_ERR" "please connect" "stderr asks the user to (re)connect"

it "s4/dir-ssherr: stderr mentions the 3 ssh retries"
assert_contains "$RP_ERR" "3" "confirm 3-retry mention"

it "s4/dir-ssherr: exits non-zero (dir-check failure, rc=21)"
assert_rc "$RP_RC" 21 "dir-check ssh failure exit code"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# Scenario 5: dir missing + RP_YES=1 → ssh mkdir then proceed remotely (still-valid)
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude tailscale hangul-romanize launchctl open tput
_install_sleep_mock
mkdir -p "$SBX/myproject"

MOCK_REACH=ok MOCK_DIRCHECK=__NO__ RP_YES=1 \
  run_launcher "$SBX/myproject"

it "s5/dir-missing-yes: ssh mkdir call"
assert_contains "$MLOG" "mkdir" "confirm ssh mkdir call"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# Scenario 6: dir missing + non-interactive (no tty, no RP_YES) → ask="" → n → die rc=5 (still-valid)
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude tailscale hangul-romanize launchctl open tput
_install_sleep_mock
mkdir -p "$SBX/myproject"

MOCK_REACH=ok MOCK_DIRCHECK=__NO__ \
  run_launcher "$SBX/myproject"

it "s6/dir-missing-decline: rc=5 (directory creation declined)"
assert_rc "$RP_RC" 5 "decline → exit 5"

cleanup_sandbox

finish
