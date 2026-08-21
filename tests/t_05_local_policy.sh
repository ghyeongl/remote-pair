#!/usr/bin/env bash
# t_05_local_policy — LOCAL 3-way session policy:
#   _N numbering, attach -d take-over, fresh conversation creation, plain-tmux fallback.
cd "$(dirname "$0")"; . ./lib.sh

# ── helper: extract respawn file path from MLOG ──
# MLOG has a line like: tmux-aqua|...|new-session|-d|-s|NAME|-c|DIR|bash /tmp/claude-respawn.XXX
# or for plain tmux: tmux|new|-s|NAME|bash /tmp/claude-respawn.XXX
# The last field is "bash /path/to/claude-respawn.XXX" — strip "bash " prefix.
_respawn_path() {
  printf '%s\n' "$1" \
    | grep 'claude-respawn' \
    | sed 's/.*|bash //' \
    | head -1
}

# ── helper: extract _1 session name from MLOG new-session line ──
# new-session line: tmux-aqua|-S|sock|new-session|-d|-s|SESSNAME|-c|DIR|bash /tmp/...
_sess_from_mlog() {
  # find the token after "-s" in the line containing "new-session"
  printf '%s\n' "$1" | grep 'new-session' | while IFS='|' read -r line; do
    prev=""
    IFS='|' read -ra toks <<< "$line"
    for tok in "${toks[@]}"; do
      [ "$prev" = "-s" ] && { printf '%s' "$tok"; break 2; }
      prev="$tok"
    done
  done
}

# Simpler extractor using sed: grab token immediately after -s in new-session line
_sess_name() {
  local mlog="$1"
  printf '%s\n' "$mlog" \
    | grep 'new-session' \
    | sed 's/.*|-s|\([^|]*\)|.*/\1/' \
    | head -1
}

# ══════════════════════════════════════════════════════════════
# Scenario 1: No session exists → new-session + attach -d, fresh Claude conversation
# ══════════════════════════════════════════════════════════════
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks
MOCK_HASSESSION=0 MOCK_SESS_EXISTS="" MOCK_CLIENTS="" \
  run_launcher --local "$SBX"

it "s1/new-session created detached"
assert_rc "$RP_RC" 0 "launcher exits 0"
assert_contains "$MLOG" "new-session|-d" "new-session -d called"

it "s1/attach-d take-over"
assert_contains "$MLOG" "attach|-d" "attach -d called"

it "s1/no ssh"
assert_absent "$MLOG" "ssh|" "no ssh in local path"

# Extract the session name created in scenario 1 for reuse in scenarios 2/3
SESS1="$(_sess_name "$MLOG")"

it "s1/session name ends in _1"
assert_contains "$SESS1" "_1" "session name ends with _1"

# Extract and verify respawn file
RFILE1="$(_respawn_path "$MLOG")"
it "s1/respawn file exists"
[ -n "$RFILE1" ] && [ -f "$RFILE1" ] && _pass "respawn file found: $RFILE1" || _fail "respawn file not found (path='$RFILE1')"

it "s1/respawn has no automatic resume"
RBODY1=""
[ -n "$RFILE1" ] && [ -f "$RFILE1" ] && RBODY1="$(cat "$RFILE1")"
assert_absent "$RBODY1" "CL_CONTINUE" "no CL_CONTINUE in respawn"
assert_contains "$RBODY1" "FIRST_LAUNCH=1" "first invocation is explicitly fresh"
assert_contains "$RBODY1" '"$RESTART_SID" != "$BASE_SID"' "crash retry rejects the pre-launch stale pointer"

it "s1/respawn CLAUDE_WARP_RC=session name"
assert_contains "$RBODY1" "export CLAUDE_WARP_RC=$SESS1" "CLAUDE_WARP_RC set to session name"

cleanup_sandbox

# ══════════════════════════════════════════════════════════════
# Scenario 2: Detached session exists → NO new-session, attach -d take-over
# We reuse SESS1 (the base name without _1 suffix stripped, we use the full name).
# MOCK_SESS_EXISTS must match the name without the leading '=' that has-session uses.
# has-session -t =NAME → mock strips '=' prefix → checks MOCK_SESS_EXISTS list.
# ══════════════════════════════════════════════════════════════
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks

# Recompute what the session name will be for $SBX (same formula, new SBX dir)
# We run a fresh launcher with MOCK_HASSESSION=0 MOCK_SESS_EXISTS="" first to learn the name,
# then do the real assertion run. Actually: SESS1 came from a different SBX dir, so its hash differs.
# Strategy: run once to discover the name, then run again with SESS_EXISTS set.
MOCK_HASSESSION=0 MOCK_SESS_EXISTS="" MOCK_CLIENTS="" \
  run_launcher --local "$SBX"
SESS2_NAME="$(_sess_name "$MLOG")"
# Reset mocklog for the real test
: > "$MOCKLOG"

# Now run with the session marked as existing (detached — no client attached)
MOCK_HASSESSION=0 MOCK_SESS_EXISTS="$SESS2_NAME" MOCK_CLIENTS="" \
  run_launcher --local "$SBX"

it "s2/no new-session when detached exists"
assert_absent "$MLOG" "new-session" "no new-session created"

it "s2/attach-d take-over of existing session"
assert_contains "$MLOG" "attach|-d" "attach -d called"

it "s2/correct session targeted"
assert_contains "$MLOG" "$SESS2_NAME" "session name appears in attach call"

cleanup_sandbox

# ══════════════════════════════════════════════════════════════
# Scenario 3: Client attached to _1 → launcher creates _2 fresh
# ══════════════════════════════════════════════════════════════
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks

# Discover _1 name first
MOCK_HASSESSION=0 MOCK_SESS_EXISTS="" MOCK_CLIENTS="" \
  run_launcher --local "$SBX"
SESS3_1="$(_sess_name "$MLOG")"
# Derive _2 name by replacing trailing _1 with _2
SESS3_2="${SESS3_1%_1}_2"
: > "$MOCKLOG"

# _1 has a client attached → launcher must skip to _2
MOCK_HASSESSION=0 MOCK_SESS_EXISTS="" MOCK_CLIENTS="$SESS3_1" \
  run_launcher --local "$SBX"

it "s3/new _2 session created"
assert_contains "$MLOG" "new-session|-d|-s|$SESS3_2" "_2 session created"

it "s3/attach to _2"
assert_contains "$MLOG" "attach|-d" "attach -d called"

# Check respawn file for _2 → no automatic resume (fresh)
RFILE3="$(_respawn_path "$MLOG")"
it "s3/respawn file for _2 exists"
[ -n "$RFILE3" ] && [ -f "$RFILE3" ] && _pass "respawn file found" || _fail "respawn file not found (path='$RFILE3')"

it "s3/no automatic resume for _2 (fresh)"
RBODY3=""
[ -n "$RFILE3" ] && [ -f "$RFILE3" ] && RBODY3="$(cat "$RFILE3")"
assert_absent "$RBODY3" "CL_CONTINUE" "no CL_CONTINUE for _2"
assert_contains "$RBODY3" "FIRST_LAUNCH=1" "_2 first invocation is fresh"

it "s3/CLAUDE_WARP_RC=_2 session name"
assert_contains "$RBODY3" "export CLAUDE_WARP_RC=$SESS3_2" "CLAUDE_WARP_RC set to _2"

cleanup_sandbox

# ══════════════════════════════════════════════════════════════
# Scenario 4: --fresh flag still creates a fresh _1
# ══════════════════════════════════════════════════════════════
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks
MOCK_HASSESSION=0 MOCK_SESS_EXISTS="" MOCK_CLIENTS="" \
  run_launcher --local --fresh "$SBX"

it "s4/new-session created"
assert_contains "$MLOG" "new-session|-d" "new-session created with --fresh"

RFILE4="$(_respawn_path "$MLOG")"
it "s4/respawn file exists"
[ -n "$RFILE4" ] && [ -f "$RFILE4" ] && _pass "respawn file found" || _fail "respawn file not found (path='$RFILE4')"

it "s4/--fresh has no automatic resume"
RBODY4=""
[ -n "$RFILE4" ] && [ -f "$RFILE4" ] && RBODY4="$(cat "$RFILE4")"
assert_absent "$RBODY4" "CL_CONTINUE" "no CL_CONTINUE with --fresh"
assert_contains "$RBODY4" "FIRST_LAUNCH=1" "--fresh first invocation is fresh"

cleanup_sandbox

# ══════════════════════════════════════════════════════════════
# Scenario 5: Plain-tmux fallback
# MOCK_HASSESSION=1 → ensure_local_host: has-session (no -t) returns 1 (server not up)
# open/launchctl succeed but retries also return 1 → ensure_local_host returns 1
# → launcher falls through to plain tmux path
# ══════════════════════════════════════════════════════════════
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks
MOCK_HASSESSION=1 MOCK_SESS_EXISTS="" MOCK_CLIENTS="" \
  run_launcher --local "$SBX"

it "s5/plain-tmux fallback: launcher exits 0"
assert_rc "$RP_RC" 0 "exits 0 via plain tmux"

it "s5/plain tmux called (not tmux-aqua) for new/attach"
# plain tmux lines in MLOG start with "tmux|" (not "tmux-aqua|")
assert_contains "$MLOG" "tmux|" "plain tmux was invoked"

it "s5/plain tmux new-session or new"
# plain-tmux fallback uses: exec tmux new -s SESS "bash $T"  or  exec tmux attach -d -t =SESS
# The mock logs argv as tmux|new|-s|... or tmux|attach|-d|-t|...
case "$MLOG" in
  *"tmux|new|"*|*"tmux|new-session"*|*"tmux|attach"*)
    _pass "plain tmux new/attach present" ;;
  *)
    _fail "plain tmux new/attach missing :: MLOG=[$MLOG]" ;;
esac

it "s5/plain tmux new-session (no existing session)"
# MOCK_SESS_EXISTS="" → tmux has-session -t =NAME exits 1 → NEED_CREATE path → exec tmux new
assert_contains "$MLOG" "tmux|new|-s|" "plain tmux new -s called"

it "s5/tmux-aqua server path failed (ensure_local_host returned 1)"
# tmux-aqua should only appear in has-session calls (server probe), not in new-session/attach
# The aqua path: ensure_local_host calls tm_local has-session (no -t) → MOCK_HASSESSION=1 → fail → return 1
# So tmux-aqua must NOT have a new-session call
AQUA_NEWSESS="$(printf '%s\n' "$MLOG" | grep 'tmux-aqua' | grep 'new-session' || true)"
[ -z "$AQUA_NEWSESS" ] && _pass "tmux-aqua did not create session (fell back to plain tmux)" \
  || _fail "tmux-aqua new-session appeared unexpectedly: $AQUA_NEWSESS"

cleanup_sandbox

finish
