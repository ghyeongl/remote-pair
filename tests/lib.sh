#!/usr/bin/env bash
# tests/lib.sh — xpair-launch test harness (mock PATH-shim + assert + runner).
#
# Core trick: on startup the launcher prepends PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH".
# So in the tests we swap HOME for a temporary directory and place all mocks
# under $HOME/.local/bin, where they shadow the real ssh/tmux/mosh/tmux-aqua/claude/tailscale
# → behavior is verified deterministically without ever touching the real m1/network/GUI.
#
# Each mock records its call argv to $MOCKLOG as a single line "name|arg1|arg2|...". Behavior is controlled via env.
# Use bash 3.2-compatible constructs only (no associative arrays, no `${x^^}`, etc.).

# Target under test / reference paths — relative to the repo root (works on any machine/CI checkout path; never hardcode absolute paths)
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REPO_ROOT="$(cd "$_LIB_DIR/.." && pwd)"
LAUNCHER_SRC="${LAUNCHER_SRC:-$_REPO_ROOT/client/cli/xpair-launch}"
REFERENCE_SRC="${REFERENCE_SRC:-${HOME_REAL:-$HOME}/.claude/bin/claude-iterm-launch}"

# Aggregate counters
T_PASS=0; T_FAIL=0; T_NAME=""
_fail() { T_FAIL=$((T_FAIL+1)); printf '  \033[31mFAIL\033[0m %s: %s\n' "$T_NAME" "$*"; }
_pass() { T_PASS=$((T_PASS+1)); printf '  \033[32mok\033[0m   %s: %s\n' "$T_NAME" "$*"; }

it() { T_NAME="$1"; }   # set the current case name

# finish — call at the end of a test file. Prints the summary + exits non-zero on failure.
finish() {
  printf '__SUMMARY__ pass=%s fail=%s\n' "$T_PASS" "$T_FAIL"
  [ "$T_FAIL" = 0 ]
}

assert_rc()       { [ "$1" = "$2" ] && _pass "rc=$2 ($3)" || _fail "rc expected $2 got $1 ($3)"; }
assert_contains() { case "$1" in *"$2"*) _pass "contains '$2' ($3)";; *) _fail "missing '$2' ($3) :: in=[$1]";; esac; }
assert_absent()   { case "$1" in *"$2"*) _fail "should NOT contain '$2' ($3) :: in=[$1]";; *) _pass "absent '$2' ($3)";; esac; }
assert_eq()       { [ "$1" = "$2" ] && _pass "eq '$2' ($3)" || _fail "expected '$2' got '$1' ($3)"; }

# ── sandbox + mock environment ──
# new_sandbox: creates a temporary HOME/runtime dirs, sets up MOCKBIN/MOCKLOG. After calling, install the mocks and run_launcher.
# $HOME_REAL is preserved for resolving the reference path.
HOME_REAL="${HOME_REAL:-$HOME}"

new_sandbox() {
  SBX="$(mktemp -d -t rpltest.XXXXXX)"
  export HOME="$SBX"
  RP_HOST_DIR="$SBX/.xpair/host"
  RP_CLIENT_DIR="$SBX/.xpair/client"
  RP_DIR="$RP_HOST_DIR"
  MOCKBIN="$SBX/.local/bin"
  MOCKLOG="$SBX/mocklog"
  RP_ERRFILE="$SBX/launch.err"
  SSH_CAPTURE="$SBX/ssh-capture"     # stores the remote script received by the mock ssh
  mkdir -p "$RP_HOST_DIR/logs" "$RP_HOST_DIR/bin" "$RP_CLIENT_DIR/logs" "$RP_CLIENT_DIR/bin" "$MOCKBIN"
  # must export so the mocks (launched as children of the launcher) can see them
  export HOME RP_DIR RP_HOST_DIR RP_CLIENT_DIR MOCKBIN MOCKLOG SSH_CAPTURE SBX
  : > "$MOCKLOG"
  # default config (client role). Tests may override it.
  : > "$RP_CLIENT_DIR/common.env"
  : > "$RP_HOST_DIR/host.env"
  # single-dash default — so a test can set SBX_REMOTE_HOST="" to an empty value (forcing local)
  cat > "$RP_CLIENT_DIR/client.env" <<EOF
REMOTE_HOST=${SBX_REMOTE_HOST-test-host}
FOLDER_MAPS=${SBX_FOLDER_MAPS-}
EOF
  # Role marker (SSOT) — ensure_local_host only takes the local tmux-aqua path on a host/both role.
  # Tests exercising the local-aqua path set SBX_ROLE=both; default leaves no marker (client-ish).
  [ -n "${SBX_ROLE:-}" ] && printf '%s\n' "$SBX_ROLE" > "$RP_CLIENT_DIR/role"
  return 0
}

cleanup_sandbox() { [ -n "${SBX:-}" ] && rm -rf "$SBX"; HOME="$HOME_REAL"; }

# make_mock NAME — creates a standard mock. Control behavior via env MOCK_*. Every mock logs its argv.
# To omit one (e.g. a test for a missing claude), simply don't call it.
_emit_logger() { # common preamble: log argv
  cat <<'LOG'
#!/bin/bash
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
LOG
}

make_all_mocks() {
  # which mocks: the names passed as arguments. If none, the standard full set.
  local set="${*:-ssh mosh tmux tmux-aqua claude tailscale hangul-romanize launchctl open tput}"
  local m
  for m in $set; do make_mock "$m"; done
}

make_mock() {
  local name="$1" f="$MOCKBIN/$1"
  _emit_logger > "$f"
  case "$name" in
    ssh)
      cat >> "$f" <<'EOS'
last=""; for a in "$@"; do last="$a"; done
case "$last" in
  true) # reach check
    case "${MOCK_REACH:-ok}" in
      ok) exit 0 ;;
      fail) exit 1 ;;
      fail-then-ok)
        c="$SBX/.reachn"; n=0; [ -f "$c" ] && n=$(cat "$c"); n=$((n+1)); echo "$n" > "$c"
        [ "$n" -ge "${MOCK_REACH_OKAT:-2}" ] && exit 0 || exit 1 ;;
    esac ;;
  *__YES__*) # dir-check
    case "${MOCK_DIRCHECK:-__YES__}" in
      __YES__) echo __YES__; exit 0 ;;
      __NO__)  echo __NO__;  exit 0 ;;
      ssherr)  exit 255 ;;
    esac ;;
  *__SESSION__*|*RESPAWN_B64*) # remote setup script
    printf '%s' "$last" > "$SSH_CAPTURE"
    echo "__SESSION__:${MOCK_REMOTE_SESSION:-rp_remote_1}"
    # Emit the remote user's home (login shell would expand $HOME remotely). Default to a path
    # distinct from the client $HOME so tests prove the differing-account fix (option A).
    echo "__HOME__:${MOCK_REMOTE_HOME:-$SBX/remote-home}"; exit 0 ;;
  *detach-client*) exit 0 ;;
  *'cat ~/.xpair/host/logs/status.json'*) echo '{"ts":1,"pid":123}'; exit 0 ;;
  *'status.json'*) echo fresh; exit 0 ;;
  *list-sessions*) printf '%s\n' "${MOCK_ATT:-}"; exit 0 ;;
  *mkdir*) exit 0 ;;
esac
exit 0
EOS
      ;;
    tmux-aqua|tmux)
      cat >> "$f" <<'EOS'
# treat the first non-option token as the subcommand (skip -S and its argument)
sub=""
for a in "$@"; do
  case "$a" in
    -S) skip=1; continue ;;
  esac
  if [ "${skip:-0}" = 1 ]; then skip=0; continue; fi
  sub="$a"; break
done
case "$sub" in
  has-session)
    # if a target (-t =X) is present, existence of that session = match against the MOCK_SESS_EXISTS list; otherwise whether the server is running
    tgt=""; nx=0; for a in "$@"; do [ "$nx" = 1 ] && { tgt="$a"; nx=0; }; [ "$a" = "-t" ] && nx=1; done
    if [ -n "$tgt" ]; then
      case " ${MOCK_SESS_EXISTS:-} " in *" ${tgt#=} "*) exit 0 ;; *) exit 1 ;; esac
    fi
    exit "${MOCK_HASSESSION:-0}" ;;   # server: 0=present
  list-clients)
    tgt=""; nx=0; for a in "$@"; do [ "$nx" = 1 ] && { tgt="$a"; nx=0; }; [ "$a" = "-t" ] && nx=1; done
    case " ${MOCK_CLIENTS:-} " in *" ${tgt#=} "*) echo x; exit 0 ;; *) exit 0 ;; esac ;;
  list-sessions) printf '%s\n' "${MOCK_ATT:-}"; exit 0 ;;
  *) exit 0 ;;
esac
EOS
      ;;
    claude)
      cat >> "$f" <<'EOS'
# claude -p --model haiku "...prompt..."  → prints a slug. --remote-control etc. just exit.
case " $* " in
  *" -p "*) printf '%s\n' "${MOCK_CLAUDE_SLUG:-translated-slug}" ;;
  *) : ;;
esac
exit 0
EOS
      ;;
    tailscale)
      cat >> "$f" <<'EOS'
case "$1" in
  status) ts="${MOCK_TS_JSON}"; [ -z "$ts" ] && ts='{"Peer":{}}'; printf '%s' "$ts" ;;
  set) : ;;
esac
exit 0
EOS
      ;;
    hangul-romanize)
      cat >> "$f" <<'EOS'
printf '%s' "${MOCK_HROMANIZE:-romanized}"
exit 0
EOS
      ;;
    mosh|launchctl|open)
      echo 'exit 0' >> "$f" ;;
    tput)
      cat >> "$f" <<'EOS'
case "$1" in cols) echo "${MOCK_COLS:-200}";; lines) echo "${MOCK_LINES:-50}";; *) echo 0;; esac
exit 0
EOS
      ;;
    *) echo 'exit 0' >> "$f" ;;
  esac
  chmod +x "$f"
}

# run_launcher [args...] — run the target launcher in the isolated sandbox. Sets RP_OUT/RP_ERR/RP_RC/MLOG.
run_launcher() {
  RP_OUT="$(bash "$LAUNCHER_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  sleep 0.2   # wait for the stderr tee (process-sub) to drain
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
  MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
}

# run_reference [args...] — run the reference under the same sandbox rules (for equivalence comparison).
# The reference uses ~/.claude paths / old names, so the caller must prepare the matching mock/env.
run_reference() {
  RP_OUT="$(printf '%s' "" | bash "$REFERENCE_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  sleep 0.2
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
  MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
}
