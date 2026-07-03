#!/bin/bash
# uninstall.sh — reverts every action install.sh performed, in reverse manifest order.
#
#   Delete created files · restore backups · remove gitignore lines · LaunchAgent bootout+delete · remove git remote.
#   * Does NOT touch ~/.claude/.git itself or user data (skills/settings/memory) — data protection.
#
# Usage:  ./uninstall.sh                         (revert every manifest across host/client dirs)
#         ./uninstall.sh --role host|client|both  (revert only selected role manifests)
#         ./uninstall.sh --purge                  (also delete selected runtime dir(s))
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/config.sh"
. "$HERE/lib.sh"

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }

PURGE=0
ROLE=all
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --role) ROLE="${2:-all}"; shift 2 ;;
    --role=*) ROLE="${1#*=}"; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
case "$ROLE" in host|client|both|all) : ;; *) echo "invalid --role: $ROLE (host|client|both|all)" >&2; exit 2 ;; esac
export XPAIR_CONFIG_ROLE="$ROLE"
. "$HERE/config.sh"

other_role_remains=0
case "$ROLE" in
  host)
    client_role_marker="$(cat "$RP_CLIENT_DIR/role" 2>/dev/null || true)"
    if [ -f "$RP_CLIENT_DIR/.manifest-client" ] || [ "$client_role_marker" = client ] || [ "$client_role_marker" = both ] || [ -f "$RP_CLIENT_DIR/client.env" ]; then
      other_role_remains=1
    fi
    ;;
  client)
    host_role_marker="$(cat "$RP_HOST_DIR/role" 2>/dev/null || true)"
    if [ -f "$RP_HOST_DIR/.manifest-host" ] || [ "$host_role_marker" = host ] || [ "$host_role_marker" = both ] || [ -f "$RP_HOST_DIR/host.env" ]; then
      other_role_remains=1
    fi
    ;;
esac
if [ "$other_role_remains" = 1 ]; then
  export XPAIR_PRESERVE_SHARED_CLI=1
else
  unset XPAIR_PRESERVE_SHARED_CLI
fi

# Collect selected role manifest(s). all = every manifest across both runtime dirs.
shopt -s nullglob 2>/dev/null || true
case "$ROLE" in
  host)
    mans=("$RP_HOST_DIR/.manifest-host" "$RP_HOST_DIR/.manifest-both" "$RP_HOST_DIR/.install-manifest")
    ;;
  client)
    mans=("$RP_CLIENT_DIR/.manifest-client")
    if [ ! -f "$RP_CLIENT_DIR/.manifest-client" ]; then
      mans+=("$RP_HOST_DIR/.manifest-client")
    fi
    ;;
  both)
    mans=("$RP_HOST_DIR/.manifest-host" "$RP_HOST_DIR/.manifest-both" "$RP_HOST_DIR/.install-manifest" "$RP_CLIENT_DIR/.manifest-client")
    ;;
  all)
    mans=("$RP_HOST_DIR"/.manifest-* "$RP_HOST_DIR/.install-manifest" "$RP_CLIENT_DIR"/.manifest-* "$RP_CLIENT_DIR/.install-manifest")
    ;;
esac
found=0
for m in "${mans[@]}"; do
  [ -f "$m" ] || continue
  found=1
  say "Removing: $(basename "$m") (reverse-order revert)"
  MANIFEST="$m"; manifest_revert
  rm -f "$m"
done
[ "$found" = 0 ] && { say "No installed manifest found for role=$ROLE — already removed."; }

if [ -n "${XPAIR_PRESERVE_SHARED_CLI:-}" ]; then
  say "Keeping shared CLIs (other role remains)"
else
  say "Removing shared CLIs"
  for p in \
    "$LOCAL_BIN/xpair" \
    "$LOCAL_BIN/xpair-askpass" \
    "$LOCAL_BIN/xpair-desktop" \
    "$LOCAL_BIN/xpair-editor" \
    "$LOCAL_BIN/xpair-mount" \
    "$LOCAL_BIN/xpair-launch"; do
    [ -e "$p" ] && rm -f "$p" && echo "  rm   $p"
  done
fi

if [ "$PURGE" = 1 ]; then
  case "$ROLE" in
    host) say "--purge: deleting $RP_HOST_DIR"; rm -rf "$RP_HOST_DIR" ;;
    client) say "--purge: deleting $RP_CLIENT_DIR"; rm -rf "$RP_CLIENT_DIR" ;;
    both|all)
      say "--purge: deleting $RP_HOST_DIR and $RP_CLIENT_DIR"
      rm -rf "$RP_HOST_DIR" "$RP_CLIENT_DIR"
      ;;
  esac
else
  # notify.conf is intentionally preserved here alongside *.env files and backups.
  # It holds user-edited ENABLED_TYPES and must survive non-purge uninstall/reinstall
  # cycles (install.sh stash/restore keeps user edits, but the manifest 'create only
  # if absent' guard means notify.conf is NOT re-recorded on reinstall, so uninstall
  # would otherwise leak it). Matching this comment to that behavior makes it explicit.
  say "Done. (config env files·notify.conf·backups under selected runtime dir(s) are kept — use --purge for full deletion)"
fi
say "(~/.claude/.git and user settings are preserved)"
