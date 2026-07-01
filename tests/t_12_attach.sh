#!/usr/bin/env bash
cd "$(dirname "$0")"; . ./lib.sh

CLI_SRC="${CLI_SRC:-$_REPO_ROOT/client/cli/xpair}"

run_cli() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" RP_DIR="$RP_DIR" HOME="$HOME" bash "$CLI_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
  MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
}

new_sandbox
make_all_mocks
SESSION="gh_proj_1"
run_cli attach --local "$SESSION"

it "attach/removed-local-flag"
assert_rc "$RP_RC" 2 "--local is rejected"
assert_contains "$RP_ERR" "unknown attach option: --local" "unknown-option error is reported"
assert_absent "$MLOG" "ssh|" "rejected option does not probe ssh"
assert_absent "$MLOG" "tmux-aqua" "rejected option does not invoke tmux-aqua"
cleanup_sandbox

new_sandbox
make_all_mocks
SESSION="test-host_proj_1"
run_cli attach "$SESSION"

it "attach/remote-existing-session"
assert_rc "$RP_RC" 0 "remote attach succeeds"
assert_contains "$MLOG" "ssh|-n|-o|BatchMode=yes|-o|ConnectTimeout=4|test-host" "checks remote session existence over ssh"
assert_contains "$MLOG" "has-session -t '=$SESSION'" "checks exact remote session name"
assert_contains "$MLOG" "mosh|" "uses mosh for remote attach"
assert_contains "$MLOG" "--client=$HOME/.local/bin/mosh-client" "mosh uses the bundled static mosh-client"
assert_contains "$MLOG" "--server=$HOME/.local/bin/mosh-server" "mosh points at the bundled remote mosh-server"
assert_contains "$MLOG" "test-host" "mosh targets the configured remote host"
assert_contains "$MLOG" "attach|-d|-t|=$SESSION" "attaches exact remote session"
cleanup_sandbox

new_sandbox
make_all_mocks
run_cli attach "bad/name"

it "attach/invalid-session-name"
assert_rc "$RP_RC" 2 "invalid session name returns usage error"
assert_contains "$RP_ERR" "invalid session name: bad/name" "invalid name is reported"
assert_absent "$MLOG" "ssh|" "invalid name does not probe ssh"
assert_absent "$MLOG" "tmux-aqua" "invalid name does not invoke tmux-aqua"
cleanup_sandbox

finish
