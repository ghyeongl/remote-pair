#!/usr/bin/env bash
# t_19_uninstall_safety — client/host uninstallers only wipe their own runtime dirs.
cd "$(dirname "$0")"; . ./lib.sh

CLIENT_UNINSTALL="${CLIENT_UNINSTALL:-$_REPO_ROOT/client/cli/uninstall-client.sh}"
HOST_UNINSTALL="${HOST_UNINSTALL:-$_REPO_ROOT/host/uninstall-host.sh}"

run_client_uninstall() {
  RP_OUT="$(HOME="$HOME" bash "$CLIENT_UNINSTALL" -y --dry-run 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}

run_host_uninstall() {
  RP_OUT="$(HOME="$HOME" bash "$HOST_UNINSTALL" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}

make_fake_app() {
  local app="$1" ver="$2"
  mkdir -p "$app/Contents"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>$ver</string>
</dict></plist>
EOF
}

new_sandbox
mkdir -p "$HOME/.xpair/client" "$HOME/.xpair/ide" "$HOME/.xpair/ide-server" "$HOME/.xpair/host"
printf 'REMOTE_HOST=test-host\n' > "$HOME/.xpair/client/client.env"
run_client_uninstall
it "client/dry-run-rc"
assert_rc "$RP_RC" 0 "client uninstall dry-run rc=0 :: stderr=[$RP_ERR]"
it "client/removes-client-dirs"
assert_contains "$RP_OUT" "$HOME/.xpair/client" "client runtime removed"
assert_contains "$RP_OUT" "$HOME/.xpair/ide" "IDE user-data removed"
assert_contains "$RP_OUT" "$HOME/.xpair/ide-server" "IDE server-data removed"
it "client/never-removes-host"
assert_absent "$RP_OUT" "rm -rf $HOME/.xpair/host" "client dry-run does not wipe host runtime"
cleanup_sandbox

new_sandbox
mkdir -p "$HOME/.xpair/client" "$HOME/.local/bin"
printf 'client\n' > "$HOME/.xpair/client/role"
printf 'NOTE\tclient remains\t\n' > "$HOME/.xpair/client/.manifest-client"
printf 'cli\n' > "$HOME/.local/bin/xpair"
run_host_uninstall -y --dry-run --force
it "host/keeps-shared-cli-when-client-remains"
assert_rc "$RP_RC" 0 "host uninstall dry-run rc=0 :: stderr=[$RP_ERR]"
assert_contains "$RP_OUT" "Keeping shared client CLIs" "host wipe detects remaining client install"
assert_absent "$RP_OUT" "rm -f $HOME/.local/bin/xpair" "host wipe does not remove shared xpair CLI"
cleanup_sandbox

if [ "$(uname)" != Darwin ]; then
  it "host/protected-legacy-skip"
  _pass "skipped on non-macOS (PlistBuddy/app bundle version scan)"
  it "host/force-legacy-skip"
  _pass "skipped on non-macOS (PlistBuddy/app bundle version scan)"
else
  new_sandbox
  make_fake_app "$HOME/Applications/RemotePairHost.app" "0.4.9"
  run_host_uninstall -y --dry-run
  it "host/protected-legacy-refuses"
  assert_rc "$RP_RC" 3 "legacy RemotePairHost.app 0.4.x refuses without --force"
  cleanup_sandbox

  new_sandbox
  make_fake_app "$HOME/Applications/RemotePairHost.app" "0.4.9"
  run_host_uninstall -y --dry-run --force
  it "host/force-removes-legacy"
  assert_rc "$RP_RC" 0 "forced host uninstall dry-run rc=0 :: stderr=[$RP_ERR]"
  assert_contains "$RP_OUT" "$HOME/Applications/RemotePairHost.app" "forced dry-run removes legacy bundle"
  cleanup_sandbox
fi

finish
