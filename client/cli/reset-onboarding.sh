#!/usr/bin/env bash
# reset-onboarding.sh — revert this client to a fresh, pre-onboarding state.
#
# Philosophy: the onboarding app (and the launcher gate) always reflect REAL config state — there is
# no dev "force onboarding" flag. To test the onboarding flow from scratch you reset to a genuinely
# empty state with this script, then launch the app, which will behave exactly as a clean install.
#
# What it does (client-side only — never touches the host):
#   1. Unmounts any Xpair mounts under ~/.xpair/client/mounts and removes the leftover dirs.
#   2. Clears the onboarding-produced keys in ~/.xpair/client/client.env (REMOTE_HOST, FOLDER_MAPS,
#      SYNC_BACKEND, MOUNT_BACKEND) while preserving install-level keys (LAUNCHER, TERMINAL_APP).
#   3. Leaves the SSH key (~/.ssh/id_ed25519) in place by default — onboarding reuses it. Pass
#      --keys to also remove it for a truly bare state.
#
# Usage: reset-onboarding.sh [-y|--yes] [--keys]
set -euo pipefail

RP_DIR="$HOME/.xpair/client"
CLIENT_ENV="$RP_DIR/client.env"
MOUNTS_ROOT="$RP_DIR/mounts"
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

# Resolve xpair-mount (installed or on PATH) for backend-correct unmounts.
RPM=""
if command -v xpair-mount >/dev/null 2>&1; then RPM="$(command -v xpair-mount)"
elif [ -x "$HOME/.local/bin/xpair-mount" ]; then RPM="$HOME/.local/bin/xpair-mount"; fi

if [ "$YES" != 1 ]; then
  printf 'Reset this client to a fresh, pre-onboarding state (unmount + clear host/maps/backends)? [y/N]: '
  read -r ans </dev/tty 2>/dev/null || ans=""
  case "${ans:-n}" in [yY]*) ;; *) echo "Aborted."; exit 1 ;; esac
fi

# 1) Unmount anything currently mounted under the mounts root.
if [ -d "$MOUNTS_ROOT" ]; then
  while IFS= read -r mp; do
    [ -n "$mp" ] || continue
    echo "unmounting $mp"
    { [ -n "$RPM" ] && "$RPM" unmount "$mp" >/dev/null 2>&1; } \
      || umount "$mp" >/dev/null 2>&1 \
      || diskutil unmount force "$mp" >/dev/null 2>&1 \
      || echo "  (could not unmount $mp — may already be detached)"
  done < <(/sbin/mount | awk -v r="$MOUNTS_ROOT" 'index($0, " on "r){s=index($0," on ")+4; e=index($0," (")-1; print substr($0,s,e-s+1)}')
  rm -rf "${MOUNTS_ROOT:?}/"* 2>/dev/null || true
  echo "cleared $MOUNTS_ROOT"
fi

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
