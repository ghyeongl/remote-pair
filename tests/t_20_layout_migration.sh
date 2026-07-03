#!/usr/bin/env bash
# t_20_layout_migration — migrate_layout renames IDE data and moves client runtime state.
cd "$(dirname "$0")"; . ./lib.sh

new_sandbox
rm -rf "$RP_CLIENT_DIR"
mkdir -p "$HOME/.xpair/client/User"
printf 'legacy ide data\n' > "$HOME/.xpair/client/User/settings.json"
printf 'REMOTE_HOST=legacy-host\n' > "$HOME/.xpair/host/client.env"
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

it "migration/host-files-untouched"
[ -f "$HOME/.xpair/host/host.env" ] && _pass "host.env left in host runtime dir" \
  || _fail "host.env missing from host runtime dir"
[ -f "$HOME/.xpair/host/.manifest-host" ] && _pass ".manifest-host left in host runtime dir" \
  || _fail ".manifest-host missing from host runtime dir"

cleanup_sandbox
finish
