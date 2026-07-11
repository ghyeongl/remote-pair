#!/usr/bin/env bash
# t_25_install_preserve_legacy_remotepair — install.sh must preserve a deliberately-kept standalone
# remotepair 0.4.x (app + com.x10lab.remote-pair* service), reclaim an old-xpair pre-rename install
# (0.5.0a…) on upgrade, and — fail-safe — preserve any present-but-unreadable RemotePairHost.app rather
# than delete an app it cannot identify. The app may be a cask install in /Applications, so both dirs are
# probed (LEGACY_APP_DIRS overrides them to sandbox paths here). Version read via `defaults` (binary+XML).
cd "$(dirname "$0")"; . ./lib.sh

INSTALL_SRC="${INSTALL_SRC:-$_REPO_ROOT/shared/install.sh}"
make_mocks() { local m; for m in ssh mosh pbs brew osascript launchctl open; do make_mock "$m"; done; }
run_install() {  # LEGACY_APP_DIRS points the app probe at two sandbox dirs (stand-in for ~/Applications + /Applications)
  RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" RP_DIR="$RP_DIR" SERVICES_DIR="$SBX/Services" RP_YES=1 \
            LEGACY_APP_DIRS="$HOME/Applications $HOME/Applications2" \
            bash "$INSTALL_SRC" "$@" </dev/null 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}
make_app() {  # $1=dir $2=version   (empty version → plist with no CFBundleShortVersionString key = unreadable)
  mkdir -p "$1/RemotePairHost.app/Contents"
  if [ -n "$2" ]; then
    printf '<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key><string>%s</string>\n</dict></plist>\n' "$2" > "$1/RemotePairHost.app/Contents/Info.plist"
  else
    printf '<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>CFBundleName</key><string>RemotePairHost</string>\n</dict></plist>\n' > "$1/RemotePairHost.app/Contents/Info.plist"
  fi
}
booted() { grep -q 'bootout.*com\.x10lab\.remote-pair' "$MOCKLOG"; }

# 1) Standalone 0.4.12, BINARY plist, in ~/Applications → preserved (app + service).
new_sandbox; make_mocks
make_app "$HOME/Applications" 0.4.12; plutil -convert binary1 "$HOME/Applications/RemotePairHost.app/Contents/Info.plist"
run_install --role host --no-native --no-sync
it "binary-0.4.x/rc-ok"; assert_rc "$RP_RC" 0 "install rc=0 :: stderr=[$RP_ERR]"
it "binary-0.4.x/preserved"
[ -d "$HOME/Applications/RemotePairHost.app" ] && ! booted && _pass "binary-plist 0.4.12 preserved (app+service)" \
  || _fail "binary-plist 0.4.12 app deleted or service booted"

# 2) Standalone 0.4.x cask-installed in /Applications (2nd probe dir) → preserved (labels not booted).
new_sandbox; make_mocks
make_app "$HOME/Applications2" 0.4.9
run_install --role host --no-native --no-sync
it "applications-dir-0.4.x/preserved"
[ -d "$HOME/Applications2/RemotePairHost.app" ] && ! booted && _pass "/Applications 0.4.x preserved (service left running)" \
  || _fail "/Applications 0.4.x not preserved"

# 3) App present but version UNREADABLE → preserved (fail-safe; never delete an unidentified app).
new_sandbox; make_mocks
make_app "$HOME/Applications" ""
run_install --role host --no-native --no-sync
it "unreadable/preserved"
[ -d "$HOME/Applications/RemotePairHost.app" ] && ! booted && _pass "unreadable-version app preserved (fail-safe)" \
  || _fail "unreadable-version app deleted/booted — must fail safe to preservation"

# 4) No app anywhere → clean (labels booted).
new_sandbox; make_mocks
run_install --role host --no-native --no-sync
it "noapp/reclaimed"
booted && _pass "labels reclaimed when no RemotePairHost.app present" \
  || _fail "labels not reclaimed when no app present"

# 5) Old-xpair pre-rename (0.5.0a…) → reclaimed (app removed + labels booted).
new_sandbox; make_mocks
make_app "$HOME/Applications" 0.5.0a37
run_install --role host --no-native --no-sync
it "old-xpair/reclaimed"
[ ! -d "$HOME/Applications/RemotePairHost.app" ] && booted && _pass "old-xpair 0.5.0a app removed + labels booted" \
  || _fail "old-xpair 0.5.0a not reclaimed"

finish
