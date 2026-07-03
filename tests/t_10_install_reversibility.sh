#!/usr/bin/env bash
# t_10_install_reversibility — white-box: install/uninstall reversibility (CLI + launcher + manifest).
#
# Under test:
#   install.sh --role client  →  installs the xpair CLI + launcher and records them in the
#                                manifest (.manifest-client) as FILE/BACKUP.
#   uninstall.sh              →  removes all of it precisely by replaying the manifest in reverse (no --purge needed).
#
# Isolation: HOME is a tempdir. All config.sh-derived paths (RP_HOST_DIR/RP_CLIENT_DIR/LOCAL_BIN/...) land
#   inside the sandbox. External commands (ssh/mosh/pbs/brew/osascript/launchctl) are dropped into MOCKBIN
#   (on PATH) so the real system is never touched. SERVICES_DIR is overridden to the sandbox to skip the
#   pbs(-flush) branch entirely. REMOTE_HOST=dummy + RP_YES=1 + non-tty → no onboard prompt / real connection
#   (doctor uses the mock ssh).
#
# Uses only bash 3.2-compatible constructs.

cd "$(dirname "$0")"; . ./lib.sh

INSTALL_SRC="${INSTALL_SRC:-$_REPO_ROOT/shared/install.sh}"
UNINSTALL_SRC="${UNINSTALL_SRC:-$_REPO_ROOT/shared/uninstall.sh}"

# mock the external commands the client install path may invoke (real system untouched)
make_client_mocks() {
  local m
  for m in ssh mosh pbs brew osascript launchctl open; do make_mock "$m"; done
}

# run_install [args...] — run install.sh in the sandbox. MOCKBIN-on-PATH.
#   SERVICES_DIR is overridden to the sandbox to skip the absolute-path pbs(-flush) branch.
run_install() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" RP_DIR="$RP_DIR" \
            SERVICES_DIR="$SBX/Services" REMOTE_HOST="${SBX_REMOTE_HOST-dummy}" RP_YES=1 \
            bash "$INSTALL_SRC" "$@" </dev/null 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}

run_uninstall() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" RP_DIR="$RP_DIR" \
            SERVICES_DIR="$SBX/Services" \
            bash "$UNINSTALL_SRC" "$@" </dev/null 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}

CLIENT_RUNTIME_DIR() { printf '%s' "$HOME/.xpair/client"; }
MANIFEST_CLIENT() { printf '%s' "$(CLIENT_RUNTIME_DIR)/.manifest-client"; }

# ────────────────────────────────────────────────────────────────────────────
# INSTALL (role=client)
# ────────────────────────────────────────────────────────────────────────────
new_sandbox
make_client_mocks
run_install --role client --no-sync

it "install/rc-ok"
assert_rc "$RP_RC" 0 "install.sh --role client rc=0 :: stderr=[$RP_ERR]"

it "install/cli-installed"
[ -x "$HOME/.local/bin/xpair" ] && _pass "xpair CLI installed" \
  || _fail "xpair CLI missing: $HOME/.local/bin/xpair"

it "install/launcher-installed"
[ -x "$(CLIENT_RUNTIME_DIR)/bin/xpair-launch" ] && _pass "launcher installed" \
  || _fail "launcher missing: $(CLIENT_RUNTIME_DIR)/bin/xpair-launch"

it "install/manifest-records-cli"
MAN="$(MANIFEST_CLIENT)"
if [ -f "$MAN" ]; then _pass "manifest exists: $MAN"
else _fail "manifest missing: $MAN"; fi
MAN_TXT="$(cat "$MAN" 2>/dev/null)"
# CLI FILE record (fresh install, so FILE rather than BACKUP)
assert_contains "$MAN_TXT" "FILE	$HOME/.local/bin/xpair" "CLI recorded as FILE in manifest"

# ────────────────────────────────────────────────────────────────────────────
# UNINSTALL (no --purge) → reverse-order restore from manifest
# ────────────────────────────────────────────────────────────────────────────
run_uninstall

it "uninstall/rc-ok"
assert_rc "$RP_RC" 0 "uninstall.sh rc=0 :: stderr=[$RP_ERR]"

it "uninstall/cli-and-launcher-removed"
[ -e "$HOME/.local/bin/xpair" ] && _fail "CLI remaining" || _pass "CLI removed"
[ -e "$(CLIENT_RUNTIME_DIR)/bin/xpair-launch" ] && _fail "launcher remaining" || _pass "launcher removed"

it "uninstall/manifest-consumed"
# uninstall rm's the manifest file itself after restoring
[ -e "$(MANIFEST_CLIENT)" ] && _fail "manifest remaining" || _pass "manifest consumed (rm)"

cleanup_sandbox

finish
