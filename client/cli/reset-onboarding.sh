#!/usr/bin/env bash
# reset-onboarding.sh — revert this client to a fresh, pre-onboarding state.
#
# Philosophy: the onboarding app (and the launcher gate) always reflect REAL config state — there is
# no dev "force onboarding" flag. To test the onboarding flow from scratch you reset to a genuinely
# empty state with this script, then launch the app, which will behave exactly as a clean install.
#
# What it does (client-side only — never touches the host):
#   1. Unmounts mount-method folder mappings under /Volumes/<share>.
#   2. Clears the onboarding-produced keys in ~/.xpair/client/client.env (REMOTE_HOST, FOLDER_MAPS,
#      SYNC_BACKEND, MOUNT_BACKEND) while preserving install-level keys (LAUNCHER, TERMINAL_APP).
#   3. Leaves the SSH key (~/.ssh/id_ed25519) in place by default — onboarding reuses it. Pass
#      --keys to also remove it for a truly bare state.
#
# Usage: reset-onboarding.sh [-y|--yes] [--keys]
set -euo pipefail

RP_DIR="$HOME/.xpair/client"
RP_CLIENT_DIR="${RP_CLIENT_DIR:-$RP_DIR}"
RP_HOST_DIR="$HOME/.xpair/host"
CLIENT_ENV="$RP_CLIENT_DIR/client.env"
SSH_KEY="$HOME/.ssh/id_ed25519"

YES=0
DROP_KEYS=0
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    --keys)   DROP_KEYS=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

if [ -f "$RP_CLIENT_DIR/bin/maplib.sh" ]; then
  # shellcheck disable=SC1090
  . "$RP_CLIENT_DIR/bin/maplib.sh"
else
  echo "maplib.sh missing — run: xpair self-update" >&2
  exit 1
fi

# Resolve xpair-mount (installed or on PATH) for backend-correct unmounts.
RPM=""
if command -v xpair-mount >/dev/null 2>&1; then RPM="$(command -v xpair-mount)"
elif [ -x "$HOME/.local/bin/xpair-mount" ]; then RPM="$HOME/.local/bin/xpair-mount"; fi

if [ "$YES" != 1 ]; then
  printf 'Reset this client to a fresh, pre-onboarding state (unmount + clear host/maps/backends)? [y/N]: '
  read -r ans </dev/tty 2>/dev/null || ans=""
  case "${ans:-n}" in [yY]*) ;; *) echo "Aborted."; exit 1 ;; esac
fi

map_mode_for() {
  local client="$1" e c IFS=';'
  for e in ${FOLDER_MAP_MODES:-}; do
    [ -n "$e" ] || continue
    c="$(map_client_of "$e")"
    [ "$c" = "$client" ] && { map_host_of "$e"; return; }
  done
  map_mode_infer "$client"
}

unmount_path() {
  local mp="$1"
  [ -n "$mp" ] || return 0
  echo "unmounting $mp"
  diskutil unmount "$mp" >/dev/null 2>&1 \
    || umount "$mp" >/dev/null 2>&1 \
    || diskutil unmount force "$mp" >/dev/null 2>&1 \
    || echo "  (could not unmount $mp — may already be detached)"
}

# 1) Unmount real mount-method mappings before clearing config.
if [ -f "$CLIENT_ENV" ]; then
  unset FOLDER_MAPS FOLDER_MAP_MODES
  # shellcheck disable=SC1090
  . "$CLIENT_ENV" >/dev/null 2>&1 || true
  IFS=';'
  for pair in ${FOLDER_MAPS:-}; do
    [ -n "$pair" ] || continue
    client_path="$(map_client_of "$pair")"
    host_path="$(map_host_of "$pair")"
    [ "$(map_mode_for "$client_path")" = mount ] || continue
    if [ -n "$RPM" ]; then
      "$RPM" unmount "$host_path" >/dev/null 2>&1 \
        || "$RPM" unmount "$client_path" >/dev/null 2>&1 \
        || unmount_path "$client_path"
    else
      unmount_path "$client_path"
    fi
  done
  unset IFS
fi

# Legacy pre-split mount roots are retired, but clean up any still-attached volumes.
for legacy_root in "$RP_HOST_DIR/mounts" "$RP_DIR/mounts"; do
  while IFS= read -r mp; do
    [ -n "$mp" ] || continue
    unmount_path "$mp"
  done < <(/sbin/mount | awk -v r="$legacy_root" 'index($0, " on "r){s=index($0," on ")+4; e=index($0," (")-1; print substr($0,s,e-s+1)}')
  [ -d "$legacy_root" ] && rmdir "$legacy_root"/* "$legacy_root" >/dev/null 2>&1 || true
done

# 2) Clear onboarding keys in client.env (preserve install-level keys + the file itself).
if [ -f "$CLIENT_ENV" ]; then
  tmp="$(mktemp)"
  awk '
    /^[[:space:]]*REMOTE_HOST=/   { print "REMOTE_HOST="; next }
    /^[[:space:]]*FOLDER_MAPS=/   { print "FOLDER_MAPS="; next }
    /^[[:space:]]*SYNC_BACKEND=/  { print "SYNC_BACKEND="; next }
    /^[[:space:]]*MOUNT_BACKEND=/ { print "MOUNT_BACKEND="; next }
    { print }
  ' "$CLIENT_ENV" > "$tmp" && mv "$tmp" "$CLIENT_ENV"
  echo "cleared onboarding keys in $CLIENT_ENV (REMOTE_HOST, FOLDER_MAPS, SYNC_BACKEND, MOUNT_BACKEND)"
else
  echo "$CLIENT_ENV absent — already bare"
fi

# 3) Optionally remove the SSH key for a truly bare state.
if [ "$DROP_KEYS" = 1 ]; then
  rm -f "$SSH_KEY" "$SSH_KEY.pub" && echo "removed $SSH_KEY(.pub)"
fi

echo "✅ onboarding reset — next launch of the Xpair app will show onboarding from scratch."
