#!/usr/bin/env bash
# maplib.sh - shared client-side mapping and SMB mount helpers.

map_client_of() { printf '%s' "${1%%::*}"; }
map_host_of() { local p="$1" h="${1#*::}"; [ "$h" = "$p" ] && h="$p"; printf '%s' "$h"; }

map_to_host() {
  local d="$1" best_c="" best_h="" c h pair IFS=';'
  for pair in ${FOLDER_MAPS:-}; do
    [ -n "$pair" ] || continue
    c="$(map_client_of "$pair")"; h="$(map_host_of "$pair")"
    case "$d" in "$c"|"$c"/*) [ "${#c}" -gt "${#best_c}" ] && { best_c="$c"; best_h="$h"; } ;; esac
  done
  [ -n "$best_c" ] && printf '%s%s' "$best_h" "${d#"$best_c"}" || printf '%s' "$d"
}
resolve_host() { map_to_host "$1"; }

valid_host() {
  local target="${1:-}" user="" host=""
  case "$target" in ''|-*) return 1 ;; esac
  case "$target" in
    *@*)
      case "$target" in *@*@*|@*|*@) return 1 ;; esac
      user="${target%@*}"; host="${target#*@}"
      case "$user" in ''|-*|*[!A-Za-z0-9._-]*) return 1 ;; esac
      ;;
    *) host="$target" ;;
  esac
  case "$host" in ''|-*|*[!A-Za-z0-9._-]*) return 1 ;; *) return 0 ;; esac
}

smb_host() {
  case "${REMOTE_HOST:-}" in *@*) printf '%s' "${REMOTE_HOST#*@}" ;; *) printf '%s' "${REMOTE_HOST:-}" ;; esac
}

map_mode_infer() {
  local d="$1" host="${REMOTE_HOST:-}" inferred=""
  case "$d" in /Volumes/*) : ;; *) printf 'sync'; return ;; esac
  [ -n "$host" ] || { printf 'sync'; return; }
  host="${host#*@}"
  inferred="$(mount 2>/dev/null | awk -v d="$d" -v h="$host" '
    index($0, " (smbfs") {
      start = index($0, " on "); if (!start) next
      src = substr($0, 1, start - 1)
      rest = substr($0, start + 4)
      idx = index(rest, " (smbfs"); if (!idx) next
      mp = substr(rest, 1, idx - 1)
      if (!(index(src, "@" h "/") || index(src, "//" h "/") == 1)) next
      if (d == mp || index(d, mp "/") == 1) { print "mount"; exit }
    }
  ' || true)"
  [ "$inferred" = mount ] && printf 'mount' || printf 'sync'
}

smb_user() {
  ssh -n -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_HOST" whoami 2>/dev/null || id -un 2>/dev/null || printf 'user'
}

share_name_for_hostpath() {
  basename "$1"
}

expected_mountpoint() {
  printf '%s/%s' "${MOUNTS_ROOT:-/Volumes}" "$(share_name_for_hostpath "$1")"
}

smb_mount_url() {
  local user="$1" host="$2" share="$3"
  printf 'smb://%s@%s/%s' "$user" "$host" "$share"
}

smb_mount_source() {
  local user="$1" host="$2" share="$3"
  printf '//%s@%s/%s' "$user" "$host" "$share"
}

discover_mountpoint_for_share() {
  local user="$1" host="$2" share="$3" exact fallback
  exact=""
  [ -n "$user" ] && exact="$(smb_mount_source "$user" "$host" "$share") on "
  fallback="@${host}/${share} on "
  mount 2>/dev/null | awk -v exact="$exact" -v fallback="$fallback" '
    length(exact) && index($0, exact) == 1 && index($0, " (smbfs") {
      rest = substr($0, length(exact) + 1)
      idx = index(rest, " (smbfs")
      if (idx) { print substr(rest, 1, idx - 1); found = 1; exit }
    }
    index($0, fallback) && index($0, " (smbfs") {
      start = index($0, " on ")
      rest = substr($0, start + 4)
      idx = index(rest, " (smbfs")
      if (idx && fallback_mp == "") fallback_mp = substr(rest, 1, idx - 1)
    }
    END {
      if (!found && fallback_mp != "") print fallback_mp
    }
  ' || true
}

discover_mountpoint_for_hostpath() {
  local hostpath="$1" user="${2:-}" share
  share="$(share_name_for_hostpath "$hostpath")"
  [ -n "$user" ] || user="$(smb_user)"
  discover_mountpoint_for_share "$user" "$(smb_host)" "$share"
}

host_smb_status() {
  valid_host "${REMOTE_HOST:-}" || { printf 'unknown'; return; }
  ssh -o BatchMode=yes -o ConnectTimeout=6 "$REMOTE_HOST" '
    v=$(launchctl print-disabled system 2>/dev/null | sed -n "s/.*\"com.apple.smbd\" => \(.*\)/\1/p")
    case "$v" in
      *true*|*disabled*)  echo off;  exit 0 ;;
      *false*|*enabled*)  echo on;   exit 0 ;;
    esac
    case "$(defaults read /System/Library/LaunchDaemons/com.apple.smbd Disabled 2>/dev/null)" in
      0) echo on ;; *) echo unknown ;;
    esac
  ' 2>/dev/null || printf 'unknown'
}
