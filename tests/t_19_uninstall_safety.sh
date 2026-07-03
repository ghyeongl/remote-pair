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
mkdir -p "$HOME/.xpair/client" "$HOME/.xpair/host" "$HOME/.local/bin"
printf 'REMOTE_HOST=test-host\n' > "$HOME/.xpair/client/client.env"
printf 'HOST_ONLY=1\n' > "$HOME/.xpair/host/host.env"
printf 'NOTE\thost remains\t\n' > "$HOME/.xpair/host/.manifest-host"
printf 'key\n' > "$HOME/.xpair/host/pairing_ed25519"
printf 'cli\n' > "$HOME/.local/bin/xpair"
run_client_uninstall
it "client/keeps-shared-cli-when-host-remains"
assert_rc "$RP_RC" 0 "client uninstall dry-run rc=0 :: stderr=[$RP_ERR]"
assert_contains "$RP_OUT" "Keeping shared CLIs (host install remains)" "client wipe detects remaining host install"
assert_absent "$RP_OUT" "rm -f $HOME/.local/bin/xpair" "client wipe does not remove shared xpair CLI"
assert_absent "$RP_OUT" "rm -f $HOME/.xpair/host/pairing_ed25519" "client wipe leaves pairing key when host remains"
cleanup_sandbox

new_sandbox
mkdir -p "$HOME/.xpair/client/User" "$HOME/.xpair/host"
rm -f "$HOME/.xpair/client/client.env"
rm -f "$HOME/.xpair/host/host.env" "$HOME/.xpair/host/.manifest-host"
printf 'legacy ide data\n' > "$HOME/.xpair/client/User/settings.json"
printf 'REMOTE_HOST=legacy-host\n' > "$HOME/.xpair/host/client.env"
run_client_uninstall
it "client/legacy-detection-by-client-env"
assert_rc "$RP_RC" 0 "pre-split client uninstall dry-run rc=0 :: stderr=[$RP_ERR]"
assert_contains "$RP_OUT" "Removing legacy pre-split client-only state" "legacy client-only cleanup is detected without client/client.env"
assert_contains "$RP_OUT" "rm -rf $HOME/.xpair/host" "legacy host/client.env cleanup runs despite IDE data dir"
cleanup_sandbox

new_sandbox
rm -rf "$HOME/.xpair/host"
mkdir -p "$HOME/.xpair/client" "$HOME/.xpair/host"
rm -f "$HOME/.xpair/host/host.env"
printf 'REMOTE_HOST=test-host\n' > "$HOME/.xpair/client/client.env"
printf 'key\n' > "$HOME/.xpair/host/pairing_ed25519"
run_client_uninstall
it "client/removes-orphaned-pairing-key"
assert_rc "$RP_RC" 0 "client uninstall dry-run rc=0 :: stderr=[$RP_ERR]"
assert_contains "$RP_OUT" "Removing client pairing key" "client-only wipe detects orphaned pairing key"
assert_contains "$RP_OUT" "rm -f $HOME/.xpair/host/pairing_ed25519" "client-only wipe removes pairing key"
assert_contains "$RP_OUT" "rmdir $HOME/.xpair/host" "client-only wipe cleans host dir when it only held the key"
cleanup_sandbox

new_sandbox
mkdir -p "$HOME/.xpair/client" "$HOME/.xpair/host/bin" "$HOME/.xpair/host/logs" "$HOME/.local/bin"
printf 'client\n' > "$HOME/.xpair/client/role"
printf 'NOTE\tclient remains\t\n' > "$HOME/.xpair/client/.manifest-client"
printf 'both\n' > "$HOME/.xpair/host/role"
printf 'HOST_ONLY=1\n' > "$HOME/.xpair/host/host.env"
printf 'LOCAL_BIN=%q\n' "$HOME/.local/bin" > "$HOME/.xpair/host/common.env"
printf 'key\n' > "$HOME/.xpair/host/pairing_ed25519"
printf 'host bin\n' > "$HOME/.xpair/host/bin/xpair-host-helper"
printf 'host log\n' > "$HOME/.xpair/host/logs/xpair.log"
printf 'cli\n' > "$HOME/.local/bin/xpair"
run_host_uninstall -y --dry-run --force
it "host/keeps-shared-cli-when-client-remains"
assert_rc "$RP_RC" 0 "host uninstall dry-run rc=0 :: stderr=[$RP_ERR]"
assert_contains "$RP_OUT" "Keeping shared client CLIs" "host wipe detects remaining client install"
assert_absent "$RP_OUT" "rm -f $HOME/.local/bin/xpair" "host wipe does not remove shared xpair CLI"
assert_contains "$RP_OUT" "pkill -f RemotePairHost" "host wipe stops legacy RemotePairHost process"
it "host/preserves-client-shared-host-state"
if printf '%s\n' "$RP_OUT" | grep -Fx "DRY: rm -rf $HOME/.xpair/host" >/dev/null 2>&1; then
  _fail "host wipe should not remove entire host dir when client remains"
else
  _pass "host wipe does not remove entire host dir when client remains"
fi
assert_absent "$RP_OUT" "rm -f $HOME/.xpair/host/pairing_ed25519" "host wipe preserves client pairing key"
assert_absent "$RP_OUT" "rm -f $HOME/.xpair/host/common.env" "host wipe preserves shared common.env"
assert_contains "$RP_OUT" "rm -rf $HOME/.xpair/host/bin" "host wipe removes host bin"
assert_contains "$RP_OUT" "$HOME/.xpair/host/logs" "host wipe removes host logs"
assert_contains "$RP_OUT" "set $HOME/.xpair/host/role to client" "host role marker is downgraded for remaining client"
cleanup_sandbox

new_sandbox
ORIG_HOST_UNINSTALL="$HOST_UNINSTALL"
mkdir -p "$SBX/standalone/host" "$HOME/.xpair/host"
cp "$ORIG_HOST_UNINSTALL" "$SBX/standalone/host/uninstall-host.sh"
HOST_UNINSTALL="$SBX/standalone/host/uninstall-host.sh"
LEGACY_BOTH_FILE="$HOME/.local/bin/legacy-both-host"
mkdir -p "$(dirname "$LEGACY_BOTH_FILE")"
printf 'legacy both\n' > "$LEGACY_BOTH_FILE"
printf 'FILE\t%s\t\n' "$LEGACY_BOTH_FILE" > "$HOME/.xpair/host/.manifest-both"
run_host_uninstall -y --dry-run --force
HOST_UNINSTALL="$ORIG_HOST_UNINSTALL"
it "host/inline-reverts-legacy-manifest-both"
assert_rc "$RP_RC" 0 "standalone host uninstall dry-run rc=0 :: stderr=[$RP_ERR]"
assert_contains "$RP_OUT" "using inline manifest revert" "standalone host wipe uses inline fallback"
assert_contains "$RP_OUT" "rm -f $LEGACY_BOTH_FILE" "inline fallback consumes .manifest-both actions"
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
