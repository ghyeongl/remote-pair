#!/usr/bin/env bash
# t_20_layout_migration — migrate_layout renames IDE data and moves client runtime state.
cd "$(dirname "$0")"; . ./lib.sh

new_sandbox
rm -rf "$RP_CLIENT_DIR"
mkdir -p "$HOME/.xpair/client/User"
printf 'legacy ide data\n' > "$HOME/.xpair/client/User/settings.json"
LEGACY_MOUNT="$HOME/.xpair/host/mounts/legacy-host/old-proj"
SYNC_MAP="$HOME/sync-copy"
VOLUMES_MAP="/Volumes/legacy-host/already"
printf 'REMOTE_HOST=user@office-mac.local\nLAUNCHER=$HOME/.xpair/host/bin/xpair-launch\nFOLDER_MAPS="%s::/Users/alice/Projects/old-proj;%s::/Users/alice/sync;%s::/Users/alice/already"\nFOLDER_MAP_MODES="%s::mount;%s::sync;%s::mount"\n' \
  "$LEGACY_MOUNT" "$SYNC_MAP" "$VOLUMES_MAP" \
  "$LEGACY_MOUNT" "$SYNC_MAP" "$VOLUMES_MAP" > "$HOME/.xpair/host/client.env"
printf 'HOST_ONLY=1\n' > "$HOME/.xpair/host/host.env"
printf 'host manifest\n' > "$HOME/.xpair/host/.manifest-host"

. "$_REPO_ROOT/shared/config.sh"
. "$_REPO_ROOT/shared/lib.sh"
migrate_layout >/dev/null 2>&1 || true

it "migration/ide-renamed"
[ -f "$HOME/.xpair/ide/User/settings.json" ] && _pass "IDE user-data moved to ~/.xpair/ide" \
  || _fail "IDE user-data not moved"
[ ! -e "$HOME/.xpair/client/User/settings.json" ] && _pass "old IDE user-data path gone" \
  || _fail "old IDE user-data path still present"

it "migration/client-env-moved"
[ -f "$HOME/.xpair/client/client.env" ] && _pass "client.env moved to client runtime dir" \
  || _fail "client.env missing from client runtime dir"
[ ! -e "$HOME/.xpair/host/client.env" ] && _pass "legacy host/client.env moved out" \
  || _fail "legacy host/client.env still present"

it "migration/mount-maps-rewritten-to-volumes"
unset REMOTE_HOST LAUNCHER FOLDER_MAPS FOLDER_MAP_MODES
. "$HOME/.xpair/client/client.env"
assert_contains "$FOLDER_MAPS" "/Volumes/old-proj::/Users/alice/Projects/old-proj" "legacy mount map rewrites to expected /Volumes share path"
assert_absent "$FOLDER_MAPS" "$LEGACY_MOUNT::/Users/alice/Projects/old-proj" "legacy mount clientPath removed from FOLDER_MAPS"
assert_contains "$FOLDER_MAP_MODES" "/Volumes/old-proj::mount" "FOLDER_MAP_MODES key rewritten with mount method"
assert_absent "$FOLDER_MAP_MODES" "$LEGACY_MOUNT::mount" "legacy mount clientPath removed from FOLDER_MAP_MODES"
assert_contains "$FOLDER_MAPS" "$SYNC_MAP::/Users/alice/sync" "sync mapping left unchanged"
assert_contains "$FOLDER_MAP_MODES" "$SYNC_MAP::sync" "sync mode left unchanged"
assert_contains "$FOLDER_MAPS" "$VOLUMES_MAP::/Users/alice/already" "already-/Volumes mapping left unchanged"
assert_contains "$FOLDER_MAP_MODES" "$VOLUMES_MAP::mount" "already-/Volumes mode left unchanged"

it "migration/client-bin-paths-rewritten"
assert_eq "$LAUNCHER" "$HOME/.xpair/client/bin/xpair-launch" "migrated LAUNCHER resolves to client bin"
assert_contains "$(cat "$HOME/.xpair/client/client.env")" 'LAUNCHER=$HOME/.xpair/client/bin/xpair-launch' "migrated client.env rewrites literal HOME launcher path"

it "migration/host-files-untouched"
[ -f "$HOME/.xpair/host/host.env" ] && _pass "host.env left in host runtime dir" \
  || _fail "host.env missing from host runtime dir"
[ -f "$HOME/.xpair/host/.manifest-host" ] && _pass ".manifest-host left in host runtime dir" \
  || _fail ".manifest-host missing from host runtime dir"

cleanup_sandbox

CONFIG_SWIFT="$(cat "$_REPO_ROOT/host/app/Config.swift")"
INSTALLER_SWIFT="$(cat "$_REPO_ROOT/host/app/Installer.swift")"
it "config/legacy-client-env-fallback"
assert_contains "$CONFIG_SWIFT" 'let LEGACY_CLIENT_ENV_FILE = "\(RP_DIR)/client.env"' "Config defines legacy pre-split client.env path"
assert_contains "$CONFIG_SWIFT" 'func clientEnvFileExists() -> Bool' "Config exposes split+legacy client env existence helper"
assert_contains "$INSTALLER_SWIFT" 'clientEnvFileExists() && !fm.fileExists(atPath: HOST_ENV)' "self-install guard checks split+legacy client.env"

finish
