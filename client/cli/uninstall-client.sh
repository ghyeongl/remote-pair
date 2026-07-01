#!/usr/bin/env bash
# uninstall-client.sh — fully wipe the Xpair client from this Mac for a clean reinstall.
#
# Reverts manifest-recorded install actions when run from a repo checkout, then removes
# the local xpair namespace, installed CLIs, legacy app symlinks, client Quick
# Action, app bundle, and the xpair Homebrew cask.
#
# Usage: uninstall-client.sh [-y|--yes] [--dry-run]
set -euo pipefail

YES=0
DRY_RUN=0

usage() { awk 'NR == 1 { next } /^set -euo pipefail$/ { exit } { print }' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠︎ %s\033[0m\n' "$*" >&2; }

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'DRY:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@" || true
}

run_quiet() {
  if [ "$DRY_RUN" = 1 ]; then
    run "$@"
    return 0
  fi
  "$@" >/dev/null 2>&1 || true
}

confirm() {
  [ "$YES" = 1 ] && return 0
  printf '%s [y/N]: ' "$1" >/dev/tty 2>/dev/null || true
  read -r ans </dev/tty 2>/dev/null || ans=""
  case "${ans:-n}" in
    [yY]|[yY][eE][sS]) ;;
    *) say "Aborted."; exit 1 ;;
  esac
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHARED="$REPO_ROOT/shared"

recorded_repo_root() {
  local env_file value
  for env_file in \
    "$HOME/.xpair/client/client.env" \
    "$HOME/.xpair/client/host.env" \
    "$HOME/.xpair/host/host.env" \
    "$HOME/.xpair/host/client.env"; do
    [ -f "$env_file" ] || continue
    value="$(set -a; RP_REPO_ROOT=''; . "$env_file" >/dev/null 2>&1; printf '%s' "${RP_REPO_ROOT:-}")"
    [ -n "$value" ] || continue
    printf '%s\n' "$value"
    return 0
  done
  return 1
}

find_shared_uninstaller() {
  local candidate rp_repo_root
  candidate="$SHARED/uninstall.sh"
  if [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  rp_repo_root="$(recorded_repo_root || true)"
  if [ -n "$rp_repo_root" ]; then
    candidate="$rp_repo_root/shared/uninstall.sh"
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  candidate="$HOME/.local/share/xpair/shared/uninstall.sh"
  if [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

remove_xpair_app_symlink() {
  local p target
  p="$1"
  [ -L "$p" ] || return 0
  target="$(readlink "$p" 2>/dev/null || true)"
  case "$target" in
    *XpairHost.app*|*RemotePairHost.app*) run rm -f "$p" ;;
  esac
}

remove_client_app() {
  local app_path
  app_path="$1"
  [ -d "$app_path" ] || return 0
  run rm -rf "$app_path"
  if [ "$DRY_RUN" != 1 ] && [ -d "$app_path" ]; then
    warn "$app_path needs admin permissions and was left in place."
  fi
}

confirm "Wipe xpair client state, binaries, Quick Action, and cask from this Mac?"

UNINSTALLER="$(find_shared_uninstaller || true)"
if [ -n "$UNINSTALLER" ]; then
  say "Reverting manifest-recorded install actions"
  run bash "$UNINSTALLER"
else
  say "No shared manifest reverter found; continuing with known paths."
fi

say "Removing xpair state"
run rm -rf "$HOME/.xpair"

say "Removing installed CLIs"
for p in \
  "$HOME/.local/bin/xpair" \
  "$HOME/.local/bin/xpair-askpass" \
  "$HOME/.local/bin/xpair-desktop" \
  "$HOME/.local/bin/xpair-editor" \
  "$HOME/.local/bin/xpair-mount" \
  "$HOME/.local/bin/xpair-launch" \
  "$HOME/.local/bin/mosh" \
  "$HOME/.local/bin/mosh-client"; do
  run rm -f "$p"
done
remove_xpair_app_symlink "$HOME/.local/bin/tmux-aqua"
remove_xpair_app_symlink "$HOME/.local/bin/mosh-server"

say "Removing client Quick Action"
run rm -rf "$HOME/Library/Services/Launch Xpair.workflow"

say "Removing Homebrew cask"
run_quiet brew uninstall --cask --force xpair

say "Removing directly installed app bundle"
remove_client_app "/Applications/Xpair.app"
remove_client_app "$HOME/Applications/Xpair.app"

say "Refreshing Finder Quick Action cache"
run_quiet /System/Library/CoreServices/pbs -flush

say "client wiped — re-run xpair onboarding to reinstall."
