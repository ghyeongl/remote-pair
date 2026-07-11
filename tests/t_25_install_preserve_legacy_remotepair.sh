#!/usr/bin/env bash
# t_25_install_preserve_legacy_remotepair — install.sh must not uninstall/stop a deliberately-kept
# standalone remotepair 0.4.12, but MUST reclaim an old-xpair pre-rename install (its "old self") on
# upgrade. Both live under ~/.remote-pair with com.x10lab.remote-pair-host, so the discriminator is the
# app's CFBundleShortVersionString: standalone = 0.4.x (preserve); pre-rename old-xpair = 0.5.0a… (clean).
cd "$(dirname "$0")"; . ./lib.sh

INSTALL_SRC="${INSTALL_SRC:-$_REPO_ROOT/shared/install.sh}"
make_mocks() { local m; for m in ssh mosh pbs brew osascript launchctl open; do make_mock "$m"; done; }
run_install() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" RP_DIR="$RP_DIR" SERVICES_DIR="$SBX/Services" RP_YES=1 \
            bash "$INSTALL_SRC" "$@" </dev/null 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}
make_remotepair_app() {  # $1 = CFBundleShortVersionString
  mkdir -p "$HOME/Applications/RemotePairHost.app/Contents"
  printf '<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key><string>%s</string>\n</dict></plist>\n' "$1" \
    > "$HOME/Applications/RemotePairHost.app/Contents/Info.plist"
}

# 1) Standalone 0.4.12 coexisting → app + service preserved, but pre-0.4.12 auto-approve still cleaned.
new_sandbox; make_mocks
make_remotepair_app 0.4.12; mkdir -p "$HOME/Applications/AutoApprove.app" "$HOME/.remote-pair"
run_install --role host --no-native --no-sync
it "standalone/rc-ok"; assert_rc "$RP_RC" 0 "install rc=0 :: stderr=[$RP_ERR]"
it "standalone/app-kept"
[ -d "$HOME/Applications/RemotePairHost.app" ] && _pass "standalone 0.4.12 RemotePairHost.app preserved" \
  || _fail "install deleted a coexisting standalone 0.4.12 RemotePairHost.app"
it "standalone/service-not-booted"
grep -q 'bootout.*com\.x10lab\.remote-pair' "$MOCKLOG" \
  && _fail "install stopped the coexisting 0.4.12 service (com.x10lab.remote-pair*)" \
  || _pass "0.4.12 service labels left running"
it "standalone/auto-approve-still-cleaned"
[ -d "$HOME/Applications/AutoApprove.app" ] && _fail "pre-0.4.12 AutoApprove.app left behind" \
  || _pass "AutoApprove.app cleaned regardless"

# 2) Old-xpair pre-rename (0.5.0a…) being upgraded → its old self IS reclaimed.
new_sandbox; make_mocks
make_remotepair_app 0.5.0a37; mkdir -p "$HOME/.remote-pair"
run_install --role host --no-native --no-sync
it "upgrade/old-self-app-removed"
[ -d "$HOME/Applications/RemotePairHost.app" ] && _fail "old-xpair RemotePairHost.app not reclaimed on upgrade" \
  || _pass "old-xpair (0.5.0a) RemotePairHost.app removed on upgrade"
it "upgrade/old-self-service-booted"
grep -q 'bootout.*com\.x10lab\.remote-pair' "$MOCKLOG" \
  && _pass "old-xpair com.x10lab.remote-pair* labels booted out" \
  || _fail "old-xpair labels not reclaimed on upgrade"

# 3) No app present → clean (rm is a no-op; labels still booted).
new_sandbox; make_mocks
run_install --role host --no-native --no-sync
it "noapp/labels-booted"
grep -q 'bootout.*com\.x10lab\.remote-pair' "$MOCKLOG" \
  && _pass "labels reclaimed when no RemotePairHost.app present" \
  || _fail "labels not reclaimed when no app present"

finish
