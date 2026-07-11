#!/usr/bin/env bash
# t_25_install_preserve_legacy_remotepair — install.sh preserves a deliberately-kept standalone remotepair
# 0.4.x (host OR client-only, either dir, incl. present-but-unreadable → fail-safe), and reclaims an
# old-xpair pre-rename install (>=0.5.0a) — from either dir, even alongside a coexisting 0.4.x. `defaults`
# is stubbed (a per-app .mockver sidecar) so the version assertions are deterministic and don't depend on
# the real system's defaults. LEGACY_APP_DIRS overrides the probe dirs to sandbox paths.
cd "$(dirname "$0")"; . ./lib.sh

INSTALL_SRC="${INSTALL_SRC:-$_REPO_ROOT/shared/install.sh}"
make_mocks() {
  local m; for m in ssh mosh pbs brew osascript launchctl open; do make_mock "$m"; done
  # stub `defaults read <app>/Contents/Info.plist CFBundleShortVersionString` → the app's .mockver, else fail
  cat > "$MOCKBIN/defaults" <<'DEF'
#!/usr/bin/env bash
[ "$1" = read ] || exit 1
_app="$(dirname "$(dirname "$2")")"
[ -f "$_app/.mockver" ] && exec cat "$_app/.mockver"
exit 1
DEF
  chmod +x "$MOCKBIN/defaults"
}
run_install() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" RP_DIR="$RP_DIR" SERVICES_DIR="$SBX/Services" RP_YES=1 \
            LEGACY_APP_DIRS="$HOME/Applications $HOME/Applications2" \
            bash "$INSTALL_SRC" "$@" </dev/null 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}
make_app() {  # $1=dir $2=app-bundle $3=version  (empty version → no .mockver = unreadable)
  mkdir -p "$1/$2/Contents"
  [ -n "$3" ] && printf '%s\n' "$3" > "$1/$2/.mockver"
  return 0
}
booted() { grep -q 'bootout.*com\.x10lab\.remote-pair' "$MOCKLOG"; }

# 1) standalone 0.4.x host (~/Applications) → preserved (app + service)
new_sandbox; make_mocks; make_app "$HOME/Applications" RemotePairHost.app 0.4.12
run_install --role host --no-native --no-sync
it "host-0.4.x/rc-ok"; assert_rc "$RP_RC" 0 "install rc=0 :: stderr=[$RP_ERR]"
it "host-0.4.x/preserved"
[ -d "$HOME/Applications/RemotePairHost.app" ] && ! booted && _pass "0.4.x host preserved (app+service)" || _fail "0.4.x host deleted/booted"

# 2) standalone 0.4.x cask-installed in /Applications (2nd probe dir) → preserved
new_sandbox; make_mocks; make_app "$HOME/Applications2" RemotePairHost.app 0.4.9
run_install --role host --no-native --no-sync
it "applications-dir-0.4.x/preserved"
[ -d "$HOME/Applications2/RemotePairHost.app" ] && ! booted && _pass "/Applications 0.4.x preserved" || _fail "/Applications 0.4.x not preserved"

# 3) client-only RemotePair.app 0.4.x (no host app) → preserved
new_sandbox; make_mocks; make_app "$HOME/Applications" RemotePair.app 0.4.12
run_install --role host --no-native --no-sync
it "client-only-0.4.x/preserved"
[ -d "$HOME/Applications/RemotePair.app" ] && ! booted && _pass "client-only 0.4.x RemotePair.app preserved" || _fail "client-only 0.4.x deleted/booted"

# 4) present-but-unreadable version → preserved (fail-safe)
new_sandbox; make_mocks; make_app "$HOME/Applications" RemotePairHost.app ""
run_install --role host --no-native --no-sync
it "unreadable/preserved"
[ -d "$HOME/Applications/RemotePairHost.app" ] && ! booted && _pass "unreadable-version app preserved (fail-safe)" || _fail "unreadable app deleted/booted"

# 5) no app anywhere → reclaimed (labels booted)
new_sandbox; make_mocks
run_install --role host --no-native --no-sync
it "noapp/reclaimed"
booted && _pass "labels reclaimed when no app present" || _fail "labels not reclaimed when no app"

# 6) old-xpair (0.5.0a) in /Applications → reclaimed FROM /Applications (both-dirs removal) + labels booted
new_sandbox; make_mocks; make_app "$HOME/Applications2" RemotePairHost.app 0.5.0a37
run_install --role host --no-native --no-sync
it "old-xpair-cask/removed"
[ ! -d "$HOME/Applications2/RemotePairHost.app" ] && booted && _pass "old-xpair reclaimed from /Applications + labels booted" || _fail "old-xpair /Applications not reclaimed"

# 7) mixed: 0.4.x host in ~/Applications + old-xpair host in /Applications → keep 0.4.x, remove old-xpair, labels NOT booted
new_sandbox; make_mocks
make_app "$HOME/Applications" RemotePairHost.app 0.4.12
make_app "$HOME/Applications2" RemotePairHost.app 0.5.0a37
run_install --role host --no-native --no-sync
it "mixed/0.4.x-kept"
[ -d "$HOME/Applications/RemotePairHost.app" ] && _pass "mixed: 0.4.x preserved" || _fail "mixed: 0.4.x deleted"
it "mixed/old-xpair-removed-labels-kept"
[ ! -d "$HOME/Applications2/RemotePairHost.app" ] && ! booted && _pass "mixed: old-xpair removed, 0.4.12 service kept" || _fail "mixed: old-xpair left or 0.4.12 service booted"

finish
