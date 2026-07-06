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
run_cli config set host "-oProxyCommand=touch-pwn"

it "security/config-rejects-ssh-option-host"
assert_rc "$RP_RC" 2 "ssh-option-looking host is rejected"
assert_contains "$RP_ERR" "invalid host" "invalid host reported"
assert_absent "$MLOG" "ssh|" "invalid host is not probed with ssh"
cleanup_sandbox

SBX_REMOTE_HOST="-oProxyCommand=touch-pwn" new_sandbox
make_all_mocks
run_cli ls --json

it "security/configured-invalid-host-ignored"
assert_rc "$RP_RC" 0 "invalid configured host is ignored (treated as no host configured)"
assert_contains "$RP_ERR" "invalid REMOTE_HOST ignored" "invalid configured host warning is emitted"
assert_absent "$MLOG" "touch-pwn" "poisoned host string never reaches any command"
assert_absent "$MLOG" "ssh|" "invalid configured host is not passed to ssh"
cleanup_sandbox

SBX_REMOTE_HOST="-oProxyCommand=touch-pwn" new_sandbox
make_all_mocks
run_launcher --yes "$PWD"

it "security/invalid-host-does-not-ssh-empty-host"
assert_rc "$RP_RC" 1 "invalid configured host fails before ssh"
assert_contains "$RP_ERR" "no host configured" "missing valid host is reported"
assert_absent "$MLOG" "ssh|" "invalid configured host is not passed to ssh"
cleanup_sandbox

new_sandbox
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS=%q\n' "$PWD::/tmp/xpair path'quote" > "$RP_CLIENT_DIR/client.env"
make_all_mocks
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher --yes "$PWD"

it "security/remote-host-path-is-posix-quoted"
assert_rc "$RP_RC" 0 "remote launch with quoted host path succeeds in mock harness"
remote_script="$(cat "$SSH_CAPTURE" 2>/dev/null)"
assert_contains "$MLOG" "[ -d '/tmp/xpair path'\\''quote' ]" "dir check quotes host path"
assert_contains "$remote_script" "cd '/tmp/xpair path'\\''quote'" "remote setup quotes cd path"
assert_contains "$remote_script" "-c '/tmp/xpair path'\\''quote'" "remote tmux cwd is quoted"
cleanup_sandbox

new_sandbox
unsafe_dir="$SBX/bad'quote\"name"
mkdir -p "$unsafe_dir"
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS=%q\n' "$unsafe_dir::$unsafe_dir" > "$RP_CLIENT_DIR/client.env"
make_all_mocks ssh mosh tmux tmux-aqua tailscale open launchctl tput
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher --yes "$unsafe_dir"

it "security/raw-folder-name-cannot-break-remote-session-script"
assert_rc "$RP_RC" 0 "remote launch with unsafe raw folder basename succeeds in mock harness"
remote_script="$(cat "$SSH_CAPTURE" 2>/dev/null)"
if bash -n "$SSH_CAPTURE" 2>"$RP_ERRFILE"; then _pass "captured remote script parses"; else _fail "captured remote script syntax error :: $(cat "$RP_ERRFILE")"; fi
assert_absent "$remote_script" "bad'quote\"name" "raw unsafe basename is not injected into remote SESSION assignment"
assert_contains "$remote_script" "SESSION='test-host_bad-quote-name_" "sanitized session base is shell-quoted"
cleanup_sandbox

finish
