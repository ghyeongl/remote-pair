#!/bin/bash
# config.sh — Single source of tunables. Source-only (do not execute directly).
#
# Xpair runtime state is split by role:
#   ~/.xpair/host    HOST runtime — host app, approve router, rules, host logs.
#   ~/.xpair/client  CLIENT runtime — launcher, client.env, client logs.
#   ~/.xpair/ide     IDE user-data.
#   ~/.xpair/ide-server  IDE remote-server data.
#
# Config is split by role so client and host files never overwrite each other:
#   ~/.xpair/host/common.env     LOCAL_BIN, AQUA_SOCK          (host-side shared values)
#   ~/.xpair/host/host.env       BUNDLE_PREFIX, APP_NAME, …     (host-only — app/approve/update identity)
#   ~/.xpair/client/common.env   LOCAL_BIN, AQUA_SOCK          (client-side shared values)
#   ~/.xpair/client/client.env   REMOTE_HOST, FOLDER_MAPS, …    (client-only — attach target, path mappings)
# Each role install writes only its own file → no cross-role contamination.
#
# Priority: environment variable > role env file > derived default.
# Personal values (hostname, sync paths) are not hard-coded here.

_XPAIR_ENV_KEYS=(
  RP_HOST_DIR RP_CLIENT_DIR RP_IDE_DIR RP_IDE_SERVER_DIR RP_DIR CLAUDE_DIR
  HOST_COMMON_ENV CLIENT_COMMON_ENV COMMON_ENV HOST_ENV CLIENT_ENV MANIFEST BACKUP_DIR
  LOG_DIR CLIENT_LOG_DIR RP_ORG BUNDLE_PREFIX APP_NAME SIGN_CN GH_REPO
  APPROVE_TRIGGER LOG_FILE HEARTBEAT_FILE REMOTEPAIR_LOG LOG_LEVEL RULES_FILE
  REMOTE_HOST FOLDER_MAPS FOLDER_MAP_MODES SYNC_ROOTS LAUNCHER TERMINAL_APP
  EDITOR_PORT SYNC_BACKEND MOUNT_BACKEND LOCAL_BIN AQUA_SOCK LAUNCH_AGENTS
  SERVICES_DIR RP_REPO_ROOT
)
_xpair_capture_env_snapshot() {
  local _k
  for _k in "${_XPAIR_ENV_KEYS[@]}"; do
    if [ "${!_k+x}" ]; then
      printf -v "_XPAIR_ENV_SNAPSHOT_${_k}" '%s' "${!_k}"
      printf -v "_XPAIR_ENV_SNAPSHOT_SET_${_k}" '%s' 1
    else
      unset "_XPAIR_ENV_SNAPSHOT_${_k}" "_XPAIR_ENV_SNAPSHOT_SET_${_k}"
    fi
  done
}
_xpair_reapply_env_snapshot() {
  local _k _set _value
  for _k in "${_XPAIR_ENV_KEYS[@]}"; do
    _set="_XPAIR_ENV_SNAPSHOT_SET_${_k}"
    if [ "${!_set:-}" = 1 ]; then
      _value="_XPAIR_ENV_SNAPSHOT_${_k}"
      printf -v "$_k" '%s' "${!_value}"
      export "$_k"
    fi
  done
}
_xpair_reset_to_env_snapshot() {
  local _k _set _value
  for _k in "${_XPAIR_ENV_KEYS[@]}"; do
    _set="_XPAIR_ENV_SNAPSHOT_SET_${_k}"
    if [ "${!_set:-}" = 1 ]; then
      _value="_XPAIR_ENV_SNAPSHOT_${_k}"
      printf -v "$_k" '%s' "${!_value}"
      export "$_k"
    else
      unset "$_k"
    fi
  done
}
[ -n "${_XPAIR_ENV_SNAPSHOT:-}" ] || { _xpair_capture_env_snapshot; _XPAIR_ENV_SNAPSHOT=1; }
_xpair_reset_to_env_snapshot

# ── Paths (role namespaces) ──
RP_HOST_DIR="${RP_HOST_DIR:-$HOME/.xpair/host}"
RP_CLIENT_DIR="${RP_CLIENT_DIR:-$HOME/.xpair/client}"
RP_IDE_DIR="${RP_IDE_DIR:-$HOME/.xpair/ide}"
RP_IDE_SERVER_DIR="${RP_IDE_SERVER_DIR:-$HOME/.xpair/ide-server}"
RP_DIR="$RP_HOST_DIR"                                  # legacy alias: host runtime dir.
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"               # Claude harness (skills). Xpair only installs here; does not depend on it.
HOST_COMMON_ENV="${HOST_COMMON_ENV:-$RP_HOST_DIR/common.env}"; CLIENT_COMMON_ENV="${CLIENT_COMMON_ENV:-$RP_CLIENT_DIR/common.env}"
COMMON_ENV="${COMMON_ENV:-$HOST_COMMON_ENV}"; HOST_ENV="${HOST_ENV:-$RP_HOST_DIR/host.env}"; CLIENT_ENV="${CLIENT_ENV:-$RP_CLIENT_DIR/client.env}"
MANIFEST="${MANIFEST:-$RP_HOST_DIR/.install-manifest}"; BACKUP_DIR="${BACKUP_DIR:-$RP_HOST_DIR/backups}"
LOG_DIR="${LOG_DIR:-$RP_HOST_DIR/logs}"
CLIENT_LOG_DIR="${CLIENT_LOG_DIR:-$RP_CLIENT_DIR/logs}"

# Load role files (only those that exist). Host-role tooling sources the host common file last so
# shared keys such as LOCAL_BIN/AQUA_SOCK are not inherited from a co-located client install.
case "${XPAIR_CONFIG_ROLE:-}" in
  host) _role_env_files=("$CLIENT_COMMON_ENV" "$CLIENT_ENV" "$HOST_COMMON_ENV" "$HOST_ENV") ;;
  *)    _role_env_files=("$HOST_COMMON_ENV" "$HOST_ENV" "$CLIENT_COMMON_ENV" "$CLIENT_ENV") ;;
esac
for _f in "${_role_env_files[@]}"; do
  # shellcheck disable=SC1090
  [ -f "$_f" ] && { set -a; . "$_f"; set +a; _xpair_reapply_env_snapshot; }
done
unset _role_env_files
_xpair_reapply_env_snapshot

# ── Host identity (org-level defaults, no personal values) ──
RP_ORG="${RP_ORG:-com.x10lab}"
BUNDLE_PREFIX="${BUNDLE_PREFIX:-${RP_ORG}.xpair-host}"
APP_NAME="${APP_NAME:-XpairHost}"
SIGN_CN="${SIGN_CN:-RemotePair Local Signing}"
GH_REPO="${GH_REPO:-x10lab/xpair}"             # Updater (GitHub Releases) target owner/repo
APP_LABEL="$BUNDLE_PREFIX"; WATCHDOG_LABEL="${BUNDLE_PREFIX}-watchdog"
APP_PATH="/Applications/${APP_NAME}.app"; APP_EXEC="$APP_PATH/Contents/MacOS/${APP_NAME}"   # aligned to the Homebrew cask default location (/Applications)
APPROVE_TRIGGER="${APPROVE_TRIGGER:-/tmp/xpair.approve-request}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/xpair.log}"
HEARTBEAT_FILE="${HEARTBEAT_FILE:-$LOG_DIR/xpair.heartbeat}"
# Unified logging contract — see docs/logging.md. Single file-level knob: default INFO,
# REMOTEPAIR_LOG overrides (trace|debug|info|warn|error). Per-component files live under $LOG_DIR.
LOG_LEVEL="${REMOTEPAIR_LOG:-${LOG_LEVEL:-info}}"
RULES_FILE="${RULES_FILE:-$RP_DIR/rules.txt}"           # approve router rules (formerly ~/.claude/auto-approve/rules.txt)

# ── Client config (no personal path defaults) ──
REMOTE_HOST="${REMOTE_HOST:-}"          # Empty = no host configured (onboarding sets one; may be localhost for a local host)
# Folder mappings for directories whose content is the same on both machines
# but may live at different absolute paths (synced via Google Drive / Syncthing / etc.).
#   Format: "clientPath::hostPath;clientPath2::hostPath2"  (identical path → use clientPath==hostPath)
#   No default — registered on first launch. (generalises legacy SYNC_ROOTS)
FOLDER_MAPS="${FOLDER_MAPS:-${SYNC_ROOTS:-}}"
# Per-mapping access method, keyed by clientPath: "clientPath::mount;clientPath2::sync".
# FOLDER_MAPS itself stays client::host (no method), so an entry missing here falls back to
# path-convention inference (a clientPath under /Volumes/ ⇒ mount, else sync).
# method ∈ {mount, sync}; mount transport is SMB-only.
FOLDER_MAP_MODES="${FOLDER_MAP_MODES:-}"
LAUNCHER="${LAUNCHER:-$RP_CLIENT_DIR/bin/xpair-launch}"

# Terminal app used by the Quick Action / open-gui subcommand.
# Derived default: iterm2 if iTerm.app is installed, otherwise terminal.
TERMINAL_APP="${TERMINAL_APP:-$( [ -d /Applications/iTerm.app ] && echo iterm2 || echo terminal )}"

EDITOR_PORT="${EDITOR_PORT:-8080}"       # code-server (xpair editor / M4) loopback port

# ── File-access backend (Syncthing vs Mount — see docs/m-mount.md) ──
# How the client sees host files: syncthing (local synced copy, default) or mount (single
# source of truth on the host, no sync daemon). Wired into xpair doctor + the wizard.
SYNC_BACKEND="${SYNC_BACKEND:-syncthing}"   # syncthing | mount
# Mount transport when SYNC_BACKEND=mount: SMB (macOS-native, no kext).
MOUNT_BACKEND="${MOUNT_BACKEND:-smb}"

# ── Common ──
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"
AQUA_SOCK="${AQUA_SOCK:-/tmp/aqua-tmux.sock}"
LAUNCH_AGENTS="${LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
SERVICES_DIR="${SERVICES_DIR:-$HOME/Library/Services}"

# ── Repository root + role dirs (host/ client/ shared/ layout) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$REPO_ROOT/client/cli"   # laptop-side artifacts: xpair CLI, launcher, Service, hangul-romanize
HOST_DIR="$REPO_ROOT/host"       # computer-use machine: app sources, build scripts, approve rules, skills
# Recorded into client.env so the INSTALLED CLI (a COPY in ~/.local/bin, with no repo beside it) can
# still locate the repo tree for `install-host` staging — onboarding always runs the installed copy.
RP_REPO_ROOT="${RP_REPO_ROOT:-$REPO_ROOT}"

# Per-role persistence key groups (install writes only to its own file)
COMMON_KEYS=(LOCAL_BIN AQUA_SOCK)
HOST_KEYS=(RP_ORG BUNDLE_PREFIX APP_NAME SIGN_CN GH_REPO APPROVE_TRIGGER LOG_FILE HEARTBEAT_FILE RULES_FILE)
CLIENT_KEYS=(REMOTE_HOST FOLDER_MAPS FOLDER_MAP_MODES LAUNCHER TERMINAL_APP EDITOR_PORT SYNC_BACKEND MOUNT_BACKEND RP_REPO_ROOT)
