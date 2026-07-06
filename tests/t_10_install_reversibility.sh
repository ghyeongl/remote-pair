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

it "install/manifest-skips-shared-cli"
MAN="$(MANIFEST_CLIENT)"
if [ -f "$MAN" ]; then _pass "manifest exists: $MAN"
else _fail "manifest missing: $MAN"; fi
MAN_TXT="$(cat "$MAN" 2>/dev/null)"
assert_absent "$MAN_TXT" "$HOME/.local/bin/xpair" "shared CLI is not role-manifest recorded"

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

# ────────────────────────────────────────────────────────────────────────────
# SHARED CLI OVERWRITE: backup is kept but not role-manifest recorded
# ────────────────────────────────────────────────────────────────────────────
new_sandbox
make_client_mocks
mkdir -p "$HOME/.local/bin"
printf 'previous cli\n' > "$HOME/.local/bin/xpair"
chmod +x "$HOME/.local/bin/xpair"
run_install --role client --no-sync

it "install/shared-cli-overwrite-backed-up"
assert_rc "$RP_RC" 0 "client install over existing shared CLI rc=0 :: stderr=[$RP_ERR]"
BACKUP_MATCH="$(find "$RP_CLIENT_DIR/backups" -type f -name '*xpair.bak' -print 2>/dev/null | head -1)"
[ -n "$BACKUP_MATCH" ] && _pass "backup created for overwritten shared CLI" \
  || _fail "backup missing for overwritten shared CLI"
[ -n "$BACKUP_MATCH" ] && assert_contains "$(cat "$BACKUP_MATCH" 2>/dev/null)" "previous cli" "backup contains previous shared CLI"
CLIENT_MAN_TXT="$(cat "$RP_CLIENT_DIR/.manifest-client" 2>/dev/null)"
assert_absent "$CLIENT_MAN_TXT" "$HOME/.local/bin/xpair" "shared xpair CLI backup is not recorded in role manifest"
cleanup_sandbox

# ────────────────────────────────────────────────────────────────────────────
# UPGRADE: legacy host/client.env survives the split migration + write_config
# ────────────────────────────────────────────────────────────────────────────
new_sandbox
make_client_mocks
rm -rf "$RP_CLIENT_DIR"
mkdir -p "$RP_HOST_DIR"
cat > "$RP_HOST_DIR/client.env" <<EOF
REMOTE_HOST=legacy-host
FOLDER_MAPS=$HOME/sync::/Users/alice/sync
FOLDER_MAP_MODES=$HOME/sync::sync
EOF
run_install --role client --no-sync

it "upgrade-preserves-config/rc-ok"
assert_rc "$RP_RC" 0 "client reinstall from legacy layout rc=0 :: stderr=[$RP_ERR]"
UPGRADED_ENV="$(cat "$HOME/.xpair/client/client.env" 2>/dev/null)"
it "upgrade-preserves-config/remote-host"
assert_contains "$UPGRADED_ENV" "REMOTE_HOST=legacy-host" "migrated REMOTE_HOST survives write_config"
it "upgrade-preserves-config/folder-maps"
assert_contains "$UPGRADED_ENV" "FOLDER_MAPS=$HOME/sync::/Users/alice/sync" "migrated FOLDER_MAPS survives write_config"
it "upgrade-preserves-config/folder-map-modes"
assert_contains "$UPGRADED_ENV" "FOLDER_MAP_MODES=$HOME/sync::sync" "migrated FOLDER_MAP_MODES survives write_config"
cleanup_sandbox

# ────────────────────────────────────────────────────────────────────────────
# MANIFEST ATTRIBUTION: both installs record by target runtime dir
# ────────────────────────────────────────────────────────────────────────────
new_sandbox
make_client_mocks
rm -f "$RP_HOST_DIR/common.env" "$RP_HOST_DIR/host.env" "$RP_HOST_DIR/role" \
      "$RP_CLIENT_DIR/common.env" "$RP_CLIENT_DIR/client.env" "$RP_CLIENT_DIR/role"
run_install --role both --no-native --no-sync

it "both-install/rc-ok"
assert_rc "$RP_RC" 0 "install.sh --role both rc=0 :: stderr=[$RP_ERR]"
HOST_MAN_TXT="$(cat "$RP_HOST_DIR/.manifest-host" 2>/dev/null)"
CLIENT_MAN_TXT="$(cat "$RP_CLIENT_DIR/.manifest-client" 2>/dev/null)"
it "both-install/host-files-in-host-manifest"
assert_contains "$HOST_MAN_TXT" "FILE	$RP_HOST_DIR/host.env" "host.env recorded in host manifest"
assert_contains "$HOST_MAN_TXT" "FILE	$RP_HOST_DIR/common.env" "host common.env recorded in host manifest"
assert_contains "$HOST_MAN_TXT" "FILE	$RP_HOST_DIR/role" "host role recorded in host manifest"
it "both-install/client-files-in-client-manifest"
assert_contains "$CLIENT_MAN_TXT" "FILE	$RP_CLIENT_DIR/client.env" "client.env recorded in client manifest"
assert_contains "$CLIENT_MAN_TXT" "FILE	$RP_CLIENT_DIR/common.env" "client common.env recorded in client manifest"
assert_contains "$CLIENT_MAN_TXT" "FILE	$RP_CLIENT_DIR/role" "client role recorded in client manifest"
assert_absent "$CLIENT_MAN_TXT" "$RP_HOST_DIR/host.env" "client manifest does not own host.env"
assert_absent "$CLIENT_MAN_TXT" "$HOME/.local/bin/xpair" "shared xpair CLI is not recorded in client manifest"

run_uninstall --role client
it "both-install/client-uninstall-keeps-shared-cli"
assert_rc "$RP_RC" 0 "client-role uninstall after both install rc=0 :: stderr=[$RP_ERR]"
[ -x "$HOME/.local/bin/xpair" ] && _pass "shared xpair CLI remains for host role" \
  || _fail "shared xpair CLI removed while host role remains"
assert_contains "$RP_OUT" "Keeping shared CLIs (other role remains)" "shared uninstaller guard preserves shared CLIs"
assert_absent "$RP_OUT" "rm   $HOME/.local/bin/xpair" "manifest/manual cleanup did not remove shared xpair CLI"
cleanup_sandbox

# ────────────────────────────────────────────────────────────────────────────
# ROLE MARKER: client-only install still writes the host-side role gate
# ────────────────────────────────────────────────────────────────────────────
new_sandbox
make_client_mocks
rm -f "$RP_HOST_DIR/role"
run_install --role client --no-sync

it "client-install/host-role-written"
assert_rc "$RP_RC" 0 "client install rc=0 :: stderr=[$RP_ERR]"
ROLE_TXT="$(cat "$RP_HOST_DIR/role" 2>/dev/null)"
assert_eq "$ROLE_TXT" "client" "host role marker written for access-only app gating"
CLIENT_MAN_TXT="$(cat "$RP_CLIENT_DIR/.manifest-client" 2>/dev/null)"
assert_contains "$CLIENT_MAN_TXT" "FILE	$RP_HOST_DIR/role" "client-only host role marker owned by client manifest"
cleanup_sandbox

new_sandbox
make_client_mocks
mkdir -p "$RP_HOST_DIR"
printf 'host\n' > "$RP_HOST_DIR/role"
printf 'HOST_ONLY=1\n' > "$RP_HOST_DIR/host.env"
run_install --role client --no-sync

it "client-install/existing-host-role-writes-both"
assert_rc "$RP_RC" 0 "client install over existing host rc=0 :: stderr=[$RP_ERR]"
assert_eq "$(cat "$RP_HOST_DIR/role" 2>/dev/null)" "both" "host role marker is not downgraded to client"
assert_eq "$(cat "$RP_CLIENT_DIR/role" 2>/dev/null)" "both" "client role marker records co-located both role"
cleanup_sandbox

new_sandbox
make_client_mocks
mkdir -p "$RP_HOST_DIR" "$RP_CLIENT_DIR"
rm -f "$RP_HOST_DIR/host.env"
printf 'client\n' > "$RP_CLIENT_DIR/role"
printf 'REMOTE_HOST=client-host\n' > "$RP_CLIENT_DIR/client.env"
printf 'NOTE\tclient existing\t\n' > "$RP_CLIENT_DIR/.manifest-client"
run_install --role host --no-native --no-sync

it "host-install/existing-client-runtime-stays-host-manifest"
assert_rc "$RP_RC" 0 "host install over existing client runtime rc=0 :: stderr=[$RP_ERR]"
assert_eq "$(cat "$RP_HOST_DIR/role" 2>/dev/null)" "both" "host role marker records co-located both role"
assert_eq "$(cat "$RP_CLIENT_DIR/role" 2>/dev/null)" "both" "host install updates client role marker to co-located both role"
HOST_MAN_TXT="$(cat "$RP_HOST_DIR/.manifest-host" 2>/dev/null)"
CLIENT_MAN_TXT="$(cat "$RP_CLIENT_DIR/.manifest-client" 2>/dev/null)"
assert_contains "$HOST_MAN_TXT" "FILE	$RP_HOST_DIR/host.env" "host env recorded in host manifest"
assert_absent "$CLIENT_MAN_TXT" "$RP_HOST_DIR/host.env" "host install does not record host env in client manifest"
cleanup_sandbox

new_sandbox
cat > "$MOCKBIN/curl" <<'EOS'
#!/bin/bash
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; break; fi
  prev="$a"
done
[ -n "$out" ] || exit 2
case "$out" in
  */xpair|*/xpair-launch|*/hangul-romanize|*/xpair-askpass|*/xpair-mount|*/xpair-desktop|*/xpair-editor|*/logging.sh)
    printf 'updated %s\n' "$(basename "$out")" > "$out"
    ;;
  *) exit 22 ;;
esac
EOS
chmod +x "$MOCKBIN/curl"
printf 'old cli\n' > "$MOCKBIN/xpair"; chmod +x "$MOCKBIN/xpair"
RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" bash "$_REPO_ROOT/client/cli/xpair" self-update testref 2>"$RP_ERRFILE")"; RP_RC=$?
RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"

it "self-update/refreshes-client-helper-siblings"
assert_rc "$RP_RC" 0 "xpair self-update rc=0 :: stderr=[$RP_ERR]"
assert_contains "$(cat "$MOCKBIN/xpair-mount" 2>/dev/null)" "updated xpair-mount" "self-update refreshes xpair-mount"
assert_contains "$(cat "$MOCKBIN/xpair-desktop" 2>/dev/null)" "updated xpair-desktop" "self-update refreshes xpair-desktop"
assert_contains "$(cat "$MOCKBIN/xpair-editor" 2>/dev/null)" "updated xpair-editor" "self-update refreshes xpair-editor"
assert_contains "$(cat "$MOCKBIN/xpair-askpass" 2>/dev/null)" "updated xpair-askpass" "self-update refreshes askpass helper"
cleanup_sandbox

new_sandbox
make_client_mocks
mkdir -p "$RP_HOST_DIR" "$RP_CLIENT_DIR" "$SBX/host-bin" "$SBX/client-bin"
printf 'LOCAL_BIN=%q\nAQUA_SOCK=/tmp/host-aqua.sock\n' "$SBX/host-bin" > "$RP_HOST_DIR/common.env"
printf 'LOCAL_BIN=%q\nAQUA_SOCK=/tmp/client-aqua.sock\n' "$SBX/client-bin" > "$RP_CLIENT_DIR/common.env"
run_install --role host --no-native --no-sync

it "host-install/uses-host-common-env"
assert_rc "$RP_RC" 0 "host install rc=0 :: stderr=[$RP_ERR]"
[ -x "$SBX/host-bin/xpair" ] && _pass "host install wrote shared CLI under host LOCAL_BIN" \
  || _fail "host install did not use host LOCAL_BIN"
[ ! -e "$SBX/client-bin/xpair" ] && _pass "host install did not inherit client LOCAL_BIN" \
  || _fail "host install incorrectly used client LOCAL_BIN"
cleanup_sandbox

it "install/migration-before-remote-host-prompt"
INSTALL_TXT="$(cat "$INSTALL_SRC")"
MIGRATE_LINE="$(printf '%s\n' "$INSTALL_TXT" | grep -n '^migrate_layout || warn "layout migration skipped some steps; continuing"$' | head -1 | cut -d: -f1)"
PROMPT_LINE="$(printf '%s\n' "$INSTALL_TXT" | grep -n 'read -r -p "Remote host' | head -1 | cut -d: -f1)"
if [ -n "$MIGRATE_LINE" ] && [ -n "$PROMPT_LINE" ] && [ "$MIGRATE_LINE" -lt "$PROMPT_LINE" ]; then
  _pass "migrate_layout runs before interactive REMOTE_HOST prompt"
else
  _fail "migrate_layout must run before interactive REMOTE_HOST prompt (migrate=$MIGRATE_LINE prompt=$PROMPT_LINE)"
fi

new_sandbox
mkdir -p "$RP_HOST_DIR"
printf 'client\n' > "$RP_HOST_DIR/role"
XPAIR_DEFS="$SBX/xpair-defs.sh"
sed '/^case "${1:-help}"/,$d' "$_REPO_ROOT/client/cli/xpair" > "$XPAIR_DEFS"
# shellcheck disable=SC1090
. "$XPAIR_DEFS"

it "client-cli/legacy-host-role-fallback"
assert_eq "$(client_role_marker)" "client" "client CLI falls back to legacy host role marker"
cleanup_sandbox

new_sandbox
mkdir -p "$RP_HOST_DIR" "$RP_CLIENT_DIR" "$SBX/host-bin" "$SBX/client-bin"
printf 'LOCAL_BIN=%q\n' "$SBX/host-bin" > "$RP_HOST_DIR/common.env"
printf 'LOCAL_BIN=%q\n' "$SBX/client-bin" > "$RP_CLIENT_DIR/common.env"
printf 'host cli\n' > "$SBX/host-bin/xpair"; chmod +x "$SBX/host-bin/xpair"
printf 'client cli\n' > "$SBX/client-bin/xpair"; chmod +x "$SBX/client-bin/xpair"
printf 'FILE\t%s\t\nNOTE\thost\t\n' "$RP_HOST_DIR/common.env" > "$RP_HOST_DIR/.manifest-host"
printf 'FILE\t%s\t\nNOTE\tclient\t\n' "$RP_CLIENT_DIR/common.env" > "$RP_CLIENT_DIR/.manifest-client"
run_uninstall --role all

it "uninstall-all/removes-each-role-local-bin"
assert_rc "$RP_RC" 0 "uninstall --role all with different role LOCAL_BIN rc=0 :: stderr=[$RP_ERR]"
[ -e "$SBX/host-bin/xpair" ] && _fail "host LOCAL_BIN xpair remaining" || _pass "host LOCAL_BIN xpair removed"
[ -e "$SBX/client-bin/xpair" ] && _fail "client LOCAL_BIN xpair remaining" || _pass "client LOCAL_BIN xpair removed"
[ -e "$RP_HOST_DIR/common.env" ] && _fail "host common.env remaining after FILE revert" || _pass "host common.env reverted before shared CLI cleanup"
[ -e "$RP_CLIENT_DIR/common.env" ] && _fail "client common.env remaining after FILE revert" || _pass "client common.env reverted before shared CLI cleanup"
cleanup_sandbox

# ────────────────────────────────────────────────────────────────────────────
# LEGACY MANIFEST ARMS: role-scoped uninstall sees pre-split manifests
# ────────────────────────────────────────────────────────────────────────────
new_sandbox
LEGACY_CLIENT_TOOL="$HOME/.local/bin/legacy-client-tool"
printf 'legacy\n' > "$LEGACY_CLIENT_TOOL"
printf 'FILE\t%s\t\n' "$LEGACY_CLIENT_TOOL" > "$RP_HOST_DIR/.manifest-client"
run_uninstall --role client

it "uninstall-role-client/legacy-host-manifest"
assert_rc "$RP_RC" 0 "client role uninstaller rc=0 :: stderr=[$RP_ERR]"
[ -e "$LEGACY_CLIENT_TOOL" ] && _fail "legacy client file remaining" || _pass "legacy host/.manifest-client reverted"
[ -e "$RP_HOST_DIR/.manifest-client" ] && _fail "legacy client manifest remaining" || _pass "legacy client manifest consumed"
cleanup_sandbox

new_sandbox
LEGACY_BOTH_FILE="$HOME/.local/bin/legacy-both-tool"
printf 'legacy\n' > "$LEGACY_BOTH_FILE"
printf 'FILE\t%s\t\n' "$LEGACY_BOTH_FILE" > "$RP_HOST_DIR/.manifest-both"
run_uninstall --role host

it "uninstall-role-host/legacy-both-manifest"
assert_rc "$RP_RC" 0 "host role uninstaller rc=0 :: stderr=[$RP_ERR]"
[ -e "$LEGACY_BOTH_FILE" ] && _fail "legacy both file remaining" || _pass "legacy host/.manifest-both reverted"
[ -e "$RP_HOST_DIR/.manifest-both" ] && _fail "legacy both manifest remaining" || _pass "legacy both manifest consumed"
cleanup_sandbox

finish
