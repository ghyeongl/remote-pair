#!/usr/bin/env bash
# uninstall-host.sh — remove XpairHost from a target Mac over SSH using the canonical host uninstaller.
#
# SAFETY (deliberate, to protect the production 0.4.x host):
#   * Requires an explicit --host; it never defaults to REMOTE_HOST.
#   * Refuses to remove a 0.4.x install unless --force is passed.
#   * Confirms locally before streaming the host uninstaller unless -y/--yes.
#
# Usage: uninstall-host.sh --host <ssh-target> [-y|--yes] [--dry-run] [--force]
set -euo pipefail

HOST=""
YES=0
DRY_RUN=0
FORCE=0
APP_NAME="XpairHost"
LEGACY_APP_NAME="RemotePairHost"
RP_CLIENT_DIR="${RP_CLIENT_DIR:-$HOME/.xpair/client}"

usage() { awk 'NR == 1 { next } /^set -euo pipefail$/ { exit } { print }' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      [ $# -ge 2 ] || { echo "uninstall-host requires --host <ssh-target>" >&2; exit 2; }
      HOST="${2:-}"
      shift 2
      ;;
    --host=*) HOST="${1#*=}"; shift ;;
    -y|--yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$HOST" ] || { echo "uninstall-host requires --host <ssh-target> (never defaults to REMOTE_HOST)" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_canonical_uninstaller() {
  local candidate
  candidate="$RP_CLIENT_DIR/share/uninstall-host.sh"
  if [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$SCRIPT_DIR/../../host/uninstall-host.sh"
  if [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

confirm() {
  [ "$YES" = 1 ] && return 0
  printf '%s [y/N]: ' "$1" >/dev/tty 2>/dev/null || true
  read -r ans </dev/tty 2>/dev/null || ans=""
  case "${ans:-n}" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
}

ssh_t() {
  ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$HOST" "$@"
}

CANONICAL="$(find_canonical_uninstaller || true)"
[ -n "$CANONICAL" ] || { echo "cannot locate canonical host uninstaller (expected $RP_CLIENT_DIR/share/uninstall-host.sh or repo host/uninstall-host.sh)" >&2; exit 1; }

APP_INFO="$(ssh_t '
  for app_name in XpairHost RemotePairHost; do
    for p in "/Applications/$app_name.app" "$HOME/Applications/$app_name.app"; do
      [ -d "$p" ] || continue
      v="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$p/Contents/Info.plist" 2>/dev/null || true)"
      [ -n "$v" ] && printf "%s\t%s\n" "$p" "$(printf "%s" "$v" | tr -d "[:space:]")"
    done
  done
' 2>/dev/null || true)"

PROTECTED_LINE="$(printf '%s\n' "$APP_INFO" | awk -F'\t' '$2 ~ /^0\.4/ { print; exit }')"
if [ -n "$PROTECTED_LINE" ] && [ "$FORCE" != 1 ]; then
  protected_path="${PROTECTED_LINE%%$'\t'*}"
  protected_ver="${PROTECTED_LINE#*$'\t'}"
  echo "REFUSING: $protected_path is a protected 0.4.x install ($protected_ver). Re-run with --force only if you really mean it." >&2
  exit 3
fi

FIRST_LINE="$(printf '%s\n' "$APP_INFO" | sed -n '1p')"
if [ -n "$FIRST_LINE" ]; then
  app_path="${FIRST_LINE%%$'\t'*}"
  app_ver="${FIRST_LINE#*$'\t'}"
  confirm "Remove $APP_NAME $app_ver from $HOST ($app_path) and wipe host leftovers?"
else
  confirm "Wipe stray xpair host state and leftovers from $HOST?"
fi

REMOTE_ARGS=(--yes)
[ "$DRY_RUN" = 1 ] && REMOTE_ARGS+=(--dry-run)
[ "$FORCE" = 1 ] && REMOTE_ARGS+=(--force)

ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$HOST" 'bash -s --' "${REMOTE_ARGS[@]}" < "$CANONICAL"
