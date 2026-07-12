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
booted_label() { grep -q "bootout.*$1$" "$MOCKLOG"; }
booted_base() { booted_label com.x10lab.remote-pair && booted_label com.x10lab.remote-pair-watchdog; }
booted_host() { booted_label com.x10lab.remote-pair-host && booted_label com.x10lab.remote-pair-host-watchdog; }
booted_all() { booted_base && booted_host; }

# 1) standalone 0.4.x host (~/Applications) → preserved (app + service)
new_sandbox; make_mocks; make_app "$HOME/Applications" RemotePairHost.app 0.4.12
run_install --role host --no-native --no-sync
it "host-0.4.x/rc-ok"; assert_rc "$RP_RC" 0 "install rc=0 :: stderr=[$RP_ERR]"
it "host-0.4.x/preserved"
if [ -d "$HOME/Applications/RemotePairHost.app" ] && booted_base && ! booted_host; then
  _pass "0.4.x host preserved; stale unified agents reclaimed"
else
  _fail "0.4.x host deleted/stopped or stale unified agents preserved"
fi

# 2) standalone 0.4.x cask-installed in /Applications (2nd probe dir) → preserved
new_sandbox; make_mocks; make_app "$HOME/Applications2" RemotePairHost.app 0.4.9
run_install --role host --no-native --no-sync
it "applications-dir-0.4.x/preserved"
if [ -d "$HOME/Applications2/RemotePairHost.app" ] && booted_base && ! booted_host; then
  _pass "/Applications 0.4.x host preserved; stale unified agents reclaimed"
else
  _fail "/Applications 0.4.x host deleted/stopped or stale unified agents preserved"
fi

# 3) client-only RemotePair.app 0.4.x (no host app) → preserved
new_sandbox; make_mocks; make_app "$HOME/Applications" RemotePair.app 0.4.12
run_install --role host --no-native --no-sync
it "client-only-0.4.x/preserved"
if [ -d "$HOME/Applications/RemotePair.app" ] && booted_all; then
  _pass "client-only 0.4.x app preserved; stale host agents reclaimed"
else
  _fail "client-only 0.4.x deleted or stale host agents preserved"
fi

# 4) present-but-unreadable version → preserved (fail-safe)
new_sandbox; make_mocks; make_app "$HOME/Applications" RemotePairHost.app ""
run_install --role host --no-native --no-sync
it "unreadable/preserved"
if [ -d "$HOME/Applications/RemotePairHost.app" ] && booted_base && ! booted_host; then
  _pass "unreadable host app preserved fail-safe; stale unified agents reclaimed"
else
  _fail "unreadable host app deleted/stopped or stale unified agents preserved"
fi

# 5) no app anywhere → reclaimed (labels booted)
new_sandbox; make_mocks
run_install --role host --no-native --no-sync
it "noapp/reclaimed"
booted_all && _pass "labels reclaimed when no app present" || _fail "labels not reclaimed when no app"

# 6) old-xpair (0.5.0a) in /Applications → reclaimed FROM /Applications (both-dirs removal) + labels booted
new_sandbox; make_mocks; make_app "$HOME/Applications2" RemotePairHost.app 0.5.0a37
run_install --role host --no-native --no-sync
it "old-xpair-cask/removed"
[ ! -d "$HOME/Applications2/RemotePairHost.app" ] && booted_all && _pass "old-xpair reclaimed from /Applications + labels booted" || _fail "old-xpair /Applications not reclaimed"

# 7) mixed: preserve 0.4.x host + its host labels; remove old-xpair bundle + stale unified labels
new_sandbox; make_mocks
make_app "$HOME/Applications" RemotePairHost.app 0.4.12
make_app "$HOME/Applications2" RemotePairHost.app 0.5.0a37
run_install --role host --no-native --no-sync
it "mixed/0.4.x-kept"
[ -d "$HOME/Applications/RemotePairHost.app" ] && _pass "mixed: 0.4.x preserved" || _fail "mixed: 0.4.x deleted"
it "mixed/old-xpair-removed-stale-labels-cleaned"
if [ ! -d "$HOME/Applications2/RemotePairHost.app" ] && booted_base && ! booted_host; then
  _pass "mixed: old-xpair removed, stale unified agents reclaimed, 0.4.12 host kept"
else
  _fail "mixed: old-xpair/stale agents left or 0.4.12 host stopped"
fi

# 8) mixed client-only standalone + old-xpair host: keep client, remove old host, reclaim every host agent
new_sandbox; make_mocks
make_app "$HOME/Applications" RemotePair.app 0.4.12
make_app "$HOME/Applications2" RemotePairHost.app 0.5.0a37
run_install --role host --no-native --no-sync
it "mixed-client/standalone-kept-old-host-cleaned"
if [ -d "$HOME/Applications/RemotePair.app" ] && [ ! -d "$HOME/Applications2/RemotePairHost.app" ] && booted_all; then
  _pass "mixed client-only: client preserved, old host bundle and all agents reclaimed"
else
  _fail "mixed client-only: client deleted or old host bundle/agents preserved"
fi

# 9) unreadable client-only app is preserved fail-safe but cannot own/suppress host agents
new_sandbox; make_mocks; make_app "$HOME/Applications" RemotePair.app ""
run_install --role host --no-native --no-sync
it "unreadable-client/preserved-agents-cleaned"
if [ -d "$HOME/Applications/RemotePair.app" ] && booted_all; then
  _pass "unreadable client app preserved fail-safe; all stale host agents reclaimed"
else
  _fail "unreadable client app deleted or stale host agents preserved"
fi

finish
