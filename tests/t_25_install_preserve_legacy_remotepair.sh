#!/usr/bin/env bash
# t_20_install_preserve_legacy_remotepair — install.sh must not uninstall a deliberately-kept standalone
# remotepair 0.4.12 (repo ghyeongl/remote-pair), which installs to the same RemotePairHost.app but keeps
# its runtime under ~/.remote-pair. When ~/.remote-pair is absent, genuinely-orphaned pre-rename cruft is
# still reclaimed.
cd "$(dirname "$0")"; . ./lib.sh

INSTALL_SRC="${INSTALL_SRC:-$_REPO_ROOT/shared/install.sh}"
make_mocks() { local m; for m in ssh mosh pbs brew osascript launchctl open; do make_mock "$m"; done; }
run_install() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" RP_DIR="$RP_DIR" SERVICES_DIR="$SBX/Services" RP_YES=1 \
            bash "$INSTALL_SRC" "$@" </dev/null 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}

# Coexisting 0.4.12 present (~/.remote-pair) → its RemotePairHost.app + service preserved, but the
# pre-0.4.12 auto-approve cruft (com.ghyeong.*) is STILL cleaned.
new_sandbox; make_mocks
mkdir -p "$HOME/Applications/RemotePairHost.app" "$HOME/Applications/AutoApprove.app" "$HOME/.remote-pair"
run_install --role host --no-native --no-sync
it "preserve/rc-ok"; assert_rc "$RP_RC" 0 "install rc=0 :: stderr=[$RP_ERR]"
it "preserve/legacy-remotepair-app-kept"
[ -d "$HOME/Applications/RemotePairHost.app" ] && _pass "0.4.12 RemotePairHost.app preserved" \
  || _fail "install deleted a coexisting remotepair 0.4.12 RemotePairHost.app"
it "preserve/service-labels-not-booted"
grep -q 'bootout.*com\.x10lab\.remote-pair' "$MOCKLOG" \
  && _fail "install booted out a com.x10lab.remote-pair* label (stops the coexisting 0.4.12 service)" \
  || _pass "0.4.12 service labels (com.x10lab.remote-pair*) left running"
it "preserve/auto-approve-still-cleaned"
[ -d "$HOME/Applications/AutoApprove.app" ] && _fail "pre-0.4.12 AutoApprove.app left behind" \
  || _pass "AutoApprove.app cleaned even with ~/.remote-pair present"
it "preserve/ghyeong-auto-approve-booted"
grep -q 'bootout.*com\.ghyeong\.auto-approve' "$MOCKLOG" \
  && _pass "pre-0.4.12 com.ghyeong.auto-approve* booted out unconditionally" \
  || _fail "com.ghyeong.auto-approve* not cleaned"

# No 0.4.12 present → genuinely-orphaned pre-rename RemotePairHost.app is still reclaimed.
new_sandbox; make_mocks
mkdir -p "$HOME/Applications/RemotePairHost.app"
run_install --role host --no-native --no-sync
it "reclaim/orphaned-app-removed"
[ -d "$HOME/Applications/RemotePairHost.app" ] && _fail "orphaned RemotePairHost.app not removed" \
  || _pass "orphaned pre-rename RemotePairHost.app removed"
it "reclaim/orphaned-labels-booted"
grep -q 'bootout.*com\.x10lab\.remote-pair' "$MOCKLOG" \
  && _pass "orphaned com.x10lab.remote-pair* labels booted out" \
  || _fail "orphaned com.x10lab.remote-pair* labels not reclaimed when no 0.4.12 present"

finish
