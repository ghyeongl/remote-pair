#!/bin/bash
# lib.sh — reversibility engine. It records every action that install performs into a manifest,
#          and uninstall precisely undoes those records in reverse order. Source-only.
#
# One manifest line = one action (TAB-separated):
#   FILE       <path>                  → file newly created by install. uninstall deletes it.
#   TREE       <path>                  → directory bundle created by install (.app/.workflow). uninstall does rm -rf.
#   BACKUP     <path> <backup>         → existing file that was overwritten. uninstall restores backup→path.
#   MKDIR      <path>                  → directory created by install. uninstall deletes it if empty.
#   GITIGNORE  <line>                  → line added to ~/.claude/.gitignore. uninstall removes it.
#   LAUNCHCTL  <label> <plist>         → bootstrapped agent. uninstall does bootout + deletes plist.
#   GITREMOTE  <name>                  → git remote that was added. uninstall removes it (only when other remotes exist).
#   NOTE       <text>                  → for logging. uninstall ignores it.

# ── manifest recording ──
manifest_init() { mkdir -p "$(dirname "$MANIFEST")"; : > "$MANIFEST"; }
record() { printf '%s\t%s\t%s\n' "$1" "${2:-}" "${3:-}" >> "$MANIFEST"; }

# ── idempotent directory creation + recording (only when we created it) ──
mk_dir() {
  local d="$1"
  [ -d "$d" ] && return 0
  mkdir -p "$d" && record MKDIR "$d"
}

# ── file install: src→dst. If dst already exists, back it up and record BACKUP; otherwise record FILE ──
install_file() {
  local src="$1" dst="$2" mode="${3:-}"
  mk_dir "$(dirname "$dst")"
  if [ -e "$dst" ]; then
    mk_dir "$BACKUP_DIR"
    local bak="$BACKUP_DIR/$(echo "$dst" | sed 's#/#_#g').bak"
    cp -p "$dst" "$bak"
    record BACKUP "$dst" "$bak"
  else
    record FILE "$dst"
  fi
  cp "$src" "$dst"
  if [ -n "$mode" ]; then chmod "$mode" "$dst"; fi
}

# ── create a file by writing content directly (e.g. template-substitution output). Reads from stdin ──
write_file() {
  local dst="$1" mode="${2:-}"
  mk_dir "$(dirname "$dst")"
  if [ -e "$dst" ]; then
    mk_dir "$BACKUP_DIR"
    local bak="$BACKUP_DIR/$(echo "$dst" | sed 's#/#_#g').bak"
    cp -p "$dst" "$bak"; record BACKUP "$dst" "$bak"
  else
    record FILE "$dst"
  fi
  cat > "$dst"
  if [ -n "$mode" ]; then chmod "$mode" "$dst"; fi
}

# ── client-runtime split migration helpers ──
_migrate_map_client_of() { printf '%s' "${1%%::*}"; }
_migrate_map_host_of() {
  local p="$1" h="${1#*::}"
  [ "$h" = "$p" ] && h="$p"
  printf '%s' "$h"
}

_migrate_default_mountpoint() {
  local host_path="$2" share
  share="$(basename "$host_path")"
  [ -n "$share" ] || return 1
  printf '/Volumes/%s' "$share"
}

_migrate_rewrite_client_bin_paths() {
  local file="$1" tmp home_pat home_repl
  [ -f "$file" ] || return 0
  tmp="$file.tmp.$$"
  home_pat="$(printf '%s' "$HOME" | sed 's/[&]/\\&/g')"
  home_repl="$home_pat"
  sed \
    -e 's#\$HOME/\.xpair/host/bin/#$HOME/.xpair/client/bin/#g' \
    -e 's#~/\.xpair/host/bin/#~/.xpair/client/bin/#g' \
    -e "s#${home_pat}/\\.xpair/host/bin/#${home_repl}/.xpair/client/bin/#g" \
    "$file" > "$tmp" && mv "$tmp" "$file"
}

_migrate_mode_for_client() {
  local client_path="$1" modes="$2" e c IFS=';'
  for e in $modes; do
    [ -n "$e" ] || continue
    c="$(_migrate_map_client_of "$e")"
    [ "$c" = "$client_path" ] && { _migrate_map_host_of "$e"; return; }
  done
  return 1
}

_migrate_legacy_mount_root() {
  local client_path="$1" host_dir="$2" client_dir="$3" root
  for root in "$host_dir/mounts" "$client_dir/mounts"; do
    case "$client_path" in "$root"|"$root"/*) printf '%s' "$root"; return 0 ;; esac
  done
  return 1
}

_migrate_is_mounted() {
  local mp="${1%/}"
  mount 2>/dev/null | grep -qF " on ${mp} " || mount 2>/dev/null | grep -qF " on ${mp}("
}

_migrate_cleanup_legacy_mountpoint() {
  local mp="$1" root="$2" d
  [ -n "$mp" ] && [ -n "$root" ] || return 0
  if _migrate_is_mounted "$mp"; then
    umount "$mp" >/dev/null 2>&1 || true
    _migrate_note "best-effort unmounted legacy mountpoint $mp"
  fi
  d="$mp"
  while [ "$d" != "$root" ] && [ "$d" != "/" ] && [ -n "$d" ]; do
    rmdir "$d" >/dev/null 2>&1 || break
    d="$(dirname "$d")"
  done
  rmdir "$root" >/dev/null 2>&1 || true
}

_migrate_cleanup_legacy_mount_roots() {
  local host_dir="$1" client_dir="$2" root mp
  for root in "$host_dir/mounts" "$client_dir/mounts"; do
    [ -d "$root" ] || continue
    while IFS= read -r mp; do
      [ -n "$mp" ] || continue
      if _migrate_is_mounted "$mp"; then
        umount "$mp" >/dev/null 2>&1 || diskutil unmount "$mp" >/dev/null 2>&1 || true
        _migrate_note "best-effort unmounted legacy mountpoint $mp"
      fi
    done <<EOF
$(mount 2>/dev/null | awk -v r="$root" 'index($0, " on "r){s=index($0," on ")+4; e=index($0," (")-1; print substr($0,s,e-s+1)}')
EOF
    rmdir "$root"/* "$root" >/dev/null 2>&1 || true
  done
}

_migrate_rewrite_lookup() {
  local old="$1" rewrites="$2" from to
  while IFS="$(printf '\t')" read -r from to; do
    [ -n "$from" ] || continue
    [ "$from" = "$old" ] && { printf '%s' "$to"; return 0; }
  done <<EOF
$rewrites
EOF
  return 1
}

_migrate_line_contains() {
  local needle="$1" haystack="$2" line
  while IFS= read -r line; do
    [ "$line" = "$needle" ] && return 0
  done <<EOF
$haystack
EOF
  return 1
}

_migrate_env_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$file.tmp.$$"
  { grep -v "^$key=" "$file" 2>/dev/null || true; printf '%s=%q\n' "$key" "$value"; } > "$tmp" && mv "$tmp" "$file"
}

_migrate_env_key_nonempty() {
  local file="$1" key="$2" value
  [ -f "$file" ] || return 1
  value="$( ( unset "$key"; set -a; . "$file" >/dev/null 2>&1 || true; eval "printf '%s' \"\${$key:-}\"" ) )"
  [ -n "$value" ]
}

# Materialize build-baked telemetry keys (PostHog project key / Sentry DSN, both publishable
# client keys) from a bundled telemetry.build.env into telemetry.env. Upserts ONLY the baked
# keys via _migrate_env_set, leaving consent / anon-id / install-ts lines untouched. Idempotent.
# Values are never echoed (secret-safe). No-op when the bundle carries no baked file.
_seed_telemetry_env() {
  local src="$1" dst="$2" line key val
  [ -f "$src" ] || return 0
  mkdir -p "$(dirname "$dst")" 2>/dev/null || true
  [ -f "$dst" ] || : > "$dst"
  while IFS= read -r line; do
    case "$line" in
      POSTHOG_KEY=*|SENTRY_DSN=*) key="${line%%=*}"; val="${line#*=}" ;;
      *) continue ;;
    esac
    [ -n "$val" ] && _migrate_env_set "$dst" "$key" "$val"
  done < "$src"
  chmod 600 "$dst" 2>/dev/null || true
}

_migrate_client_env_has_real_config() {
  local file="$1"
  _migrate_env_key_nonempty "$file" REMOTE_HOST || _migrate_env_key_nonempty "$file" FOLDER_MAPS
}

_migrate_telemetry_key_list() {
  printf '%s\n' "TELEMETRY_ANON_ID TELEMETRY_CONSENT CRASH_REPORT_CONSENT TELEMETRY_INSTALL_TS POSTHOG_KEY POSTHOG_HOST SENTRY_DSN TELEMETRY_HOST_CONNECTED_AT"
}

_migrate_client_env_telemetry_keys() {
  local src="$1" dst="$2" keys tmp_dst tmp_src
  [ -f "$src" ] || return 0
  keys="$(_migrate_telemetry_key_list)"
  mkdir -p "$(dirname "$dst")" 2>/dev/null || true
  [ -f "$dst" ] || : > "$dst"
  tmp_dst="$dst.tmp.$$"
  tmp_src="$src.tmp.$$"
  awk -v keys="$keys" '
    BEGIN {
      split(keys, k, " ")
      for (i in k) want[k[i]] = 1
    }
    FNR == NR {
      print
      key = $0
      sub(/^[[:space:]]*/, "", key)
      sub(/[[:space:]]*=.*/, "", key)
      if (want[key]) seen[key] = 1
      next
    }
    {
      key = $0
      sub(/^[[:space:]]*/, "", key)
      sub(/[[:space:]]*=.*/, "", key)
      if (want[key]) {
        if (!seen[key]) {
          print
          seen[key] = 1
        }
        next
      }
    }
  ' "$dst" "$src" > "$tmp_dst" && mv "$tmp_dst" "$dst" || { rm -f "$tmp_dst"; return 0; }
  awk -v keys="$keys" '
    BEGIN {
      split(keys, k, " ")
      for (i in k) want[k[i]] = 1
    }
    {
      key = $0
      sub(/^[[:space:]]*/, "", key)
      sub(/[[:space:]]*=.*/, "", key)
      if (want[key]) next
      print
    }
  ' "$src" > "$tmp_src" && mv "$tmp_src" "$src" || rm -f "$tmp_src"
}

_migrate_merge_legacy_client_env() {
  local legacy="$1" dst="$2" tmp
  [ -f "$legacy" ] || return 0
  mkdir -p "$(dirname "$dst")" 2>/dev/null || true
  [ -f "$dst" ] || : > "$dst"
  tmp="$dst.tmp.$$"
  awk '
    FNR == NR {
      print
      key = $0
      sub(/^[[:space:]]*/, "", key)
      sub(/=.*/, "", key)
      if (key ~ /^[A-Z_][A-Z0-9_]*$/) seen[key] = 1
      next
    }
    {
      key = $0
      sub(/^[[:space:]]*/, "", key)
      sub(/=.*/, "", key)
      if (key ~ /^[A-Z_][A-Z0-9_]*$/ && !seen[key]) {
        print
        seen[key] = 1
      }
    }
  ' "$dst" "$legacy" > "$tmp" && mv "$tmp" "$dst" && rm -f "$legacy"
}

_migrate_client_mount_maps() {
  local client_env="$1" host_dir="$2" client_dir="$3"
  [ -f "$client_env" ] || return 0

  local remote_host folder_maps folder_map_modes
  remote_host="$( ( unset REMOTE_HOST; . "$client_env" >/dev/null 2>&1 || true; printf '%s' "${REMOTE_HOST:-}" ) )"
  folder_maps="$( ( unset FOLDER_MAPS SYNC_ROOTS; . "$client_env" >/dev/null 2>&1 || true; printf '%s' "${FOLDER_MAPS:-${SYNC_ROOTS:-}}" ) )"
  folder_map_modes="$( ( unset FOLDER_MAP_MODES; . "$client_env" >/dev/null 2>&1 || true; printf '%s' "${FOLDER_MAP_MODES:-}" ) )"

  [ -n "$folder_maps" ] || return 0

  local new_maps="" rewrites="" force_mount_rewrites="" pair client_path host_path mode legacy_root new_client_path IFS=';'
  for pair in $folder_maps; do
    [ -n "$pair" ] || continue
    client_path="$(_migrate_map_client_of "$pair")"
    host_path="$(_migrate_map_host_of "$pair")"
    mode="$(_migrate_mode_for_client "$client_path" "$folder_map_modes" 2>/dev/null || true)"
    legacy_root="$(_migrate_legacy_mount_root "$client_path" "$host_dir" "$client_dir" 2>/dev/null || true)"
    new_client_path="$client_path"

    if { [ "$mode" = "mount" ] || [ -n "$legacy_root" ]; } && [ "${client_path#/Volumes/}" = "$client_path" ]; then
      if [ -n "$remote_host" ] && [ -n "$host_path" ]; then
        if new_client_path="$(_migrate_default_mountpoint "$remote_host" "$host_path" 2>/dev/null)"; then
          rewrites="${rewrites}${client_path}	${new_client_path}
"
          [ -n "$legacy_root" ] && force_mount_rewrites="${force_mount_rewrites}${client_path}
"
          [ -n "$legacy_root" ] && _migrate_cleanup_legacy_mountpoint "$client_path" "$legacy_root"
          _migrate_note "rewrote mount mapping $client_path -> $new_client_path"
        else
          new_client_path="$client_path"
          _migrate_note "skip mount mapping rewrite for $client_path: cannot compute /Volumes share mountpoint"
        fi
      else
        _migrate_note "skip mount mapping rewrite for $client_path: REMOTE_HOST or host path missing"
      fi
    fi

    new_maps="${new_maps:+$new_maps;}$new_client_path::$host_path"
  done

  [ "$new_maps" != "$folder_maps" ] || return 0

  local new_modes="" entry mode_client mode_value rewritten_client
  IFS=';'
  for entry in $folder_map_modes; do
    [ -n "$entry" ] || continue
    mode_client="$(_migrate_map_client_of "$entry")"
    mode_value="$(_migrate_map_host_of "$entry")"
    rewritten_client="$(_migrate_rewrite_lookup "$mode_client" "$rewrites" 2>/dev/null || true)"
    if [ -n "$rewritten_client" ] && _migrate_line_contains "$mode_client" "$force_mount_rewrites"; then
      mode_value="mount"
    fi
    [ -n "$rewritten_client" ] || rewritten_client="$mode_client"
    new_modes="${new_modes:+$new_modes;}$rewritten_client::$mode_value"
  done
  while IFS= read -r mode_client; do
    [ -n "$mode_client" ] || continue
    rewritten_client="$(_migrate_rewrite_lookup "$mode_client" "$rewrites" 2>/dev/null || true)"
    [ -n "$rewritten_client" ] || continue
    _migrate_mode_for_client "$rewritten_client" "$new_modes" >/dev/null 2>&1 && continue
    new_modes="${new_modes:+$new_modes;}$rewritten_client::mount"
  done <<EOF
$force_mount_rewrites
EOF

  _migrate_env_set "$client_env" FOLDER_MAPS "$new_maps" || return 0
  [ "$new_modes" = "$folder_map_modes" ] || _migrate_env_set "$client_env" FOLDER_MAP_MODES "$new_modes" || true
}

_manifest_is_shared_cli() {
  local p="$1" name
  [ -n "${XPAIR_PRESERVE_SHARED_CLI:-}" ] || return 1
  [ -n "${LOCAL_BIN:-}" ] || return 1
  case "$p" in "$LOCAL_BIN"/*) : ;; *) return 1 ;; esac
  name="$(basename "$p")"
  case "$name" in xpair|xpair-askpass|xpair-desktop|xpair-editor|xpair-mount|xpair-launch) return 0 ;; esac
  return 1
}

# ── add a line to .gitignore (only if absent) + record ──
add_gitignore() {
  local line="$1" gi="$CLAUDE_DIR/.gitignore"
  [ -f "$gi" ] || { record FILE "$gi"; : > "$gi"; }
  grep -qxF "$line" "$gi" 2>/dev/null && return 0
  printf '%s\n' "$line" >> "$gi"
  record GITIGNORE "$line"
}

# ── uninstall: process the manifest in reverse order ──
manifest_revert() {
  [ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST"; return 1; }
  # Reverse the manifest portably. `tail -r` is BSD-only and fails on GNU/Linux/WSL with
  # `tail: invalid option -- 'r'`, which aborted uninstall mid-run on non-macOS clients;
  # awk reverses identically on both BSD and GNU.
  awk '{ lines[NR] = $0 } END { for (i = NR; i >= 1; i--) print lines[i] }' "$MANIFEST" | while IFS=$'\t' read -r action a b; do
    case "$action" in
      FILE)      if _manifest_is_shared_cli "$a"; then echo "  keep shared CLI $a"; else [ -e "$a" ] && rm -f "$a" && echo "  rm   $a"; fi ;;
      TREE)      [ -e "$a" ] && rm -rf "$a" && echo "  rm -rf $a" ;;
      BACKUP)    if _manifest_is_shared_cli "$a"; then echo "  keep shared CLI $a"; else [ -e "$b" ] && cp -p "$b" "$a" && rm -f "$b" && echo "  restore $a"; fi ;;
      MKDIR)     rmdir "$a" 2>/dev/null && echo "  rmdir $a" || true ;;
      GITIGNORE) local gi="$CLAUDE_DIR/.gitignore"
                 if [ -f "$gi" ]; then
                   { grep -vxF "$a" "$gi" || true; } > "$gi.tmp" && mv "$gi.tmp" "$gi" && echo "  gitignore- $a"
                 fi ;;
      LAUNCHCTL) launchctl bootout "gui/$(id -u)/$a" 2>/dev/null || true
                 [ -n "$b" ] && [ -e "$b" ] && rm -f "$b"; echo "  bootout $a" ;;
      GITREMOTE) ( cd "$CLAUDE_DIR" && git remote remove "$a" 2>/dev/null ) && echo "  remote- $a" || true ;;
      # HOOKS: we modified settings.json (the user's existing file) in place → surgical removal (only our entries).
      #   a=settings.json path, b=hook command (identifier = installed hook cmd path). The manage script is
      #   installed via FILE in the same manifest, and since reverse processing removes it after this HOOKS
      #   entry, it can still be called here.
      #   manage-claude-hooks.py changed to 4-arg (remove <settings> <approve_cmd> <notify_cmd>), passing the
      #   same path in two positions to remove "all of our entries containing that path" (paths are unique →
      #   the HOOKS lines recorded one each for approve/notify safely delete only their own).
      HOOKS)     [ -f "$a" ] && python3 "$RP_DIR/bin/manage-claude-hooks.py" remove "$a" "$b" "$b" >/dev/null 2>&1 \
                   && echo "  hook- $b" || true ;;
      NOTE)      : ;;
    esac
  done
}

# ── one-time layout migration: host/client runtime split + IDE dir rename ──
migrate_layout() {
  local base host_dir client_dir ide_dir ide_server_dir old_ide old_server
  base="$HOME/.xpair"
  host_dir="${RP_HOST_DIR:-$base/host}"
  client_dir="${RP_CLIENT_DIR:-$base/client}"
  ide_dir="${RP_IDE_DIR:-$base/ide}"
  ide_server_dir="${RP_IDE_SERVER_DIR:-$base/ide-server}"
  old_ide="$base/client"
  old_server="$base/client-server"

  _migrate_note() { printf 'migrate_layout: %s\n' "$*" >&2; }
  _move_if_present() {
    local src="$1" dst="$2"
    [ -e "$src" ] || return 0
    [ -e "$dst" ] && { _migrate_note "skip $(basename "$src"): target exists ($dst)"; return 0; }
    mkdir -p "$(dirname "$dst")" 2>/dev/null || true
    if mv "$src" "$dst" 2>/dev/null; then
      _migrate_note "moved $src -> $dst"
    else
      _migrate_note "skip $src: move failed"
    fi
  }

  # 1. IDE data rename first, freeing ~/.xpair/client for client runtime.
  if [ -d "$old_ide" ] && [ ! -e "$old_ide/client.env" ] && [ ! -e "$ide_dir" ]; then
    if mv "$old_ide" "$ide_dir" 2>/dev/null; then
      _migrate_note "renamed IDE user-data $old_ide -> $ide_dir"
    else
      _migrate_note "skip IDE user-data rename: move failed"
    fi
  fi
  if [ -d "$old_server" ] && [ ! -e "$ide_server_dir" ]; then
    if mv "$old_server" "$ide_server_dir" 2>/dev/null; then
      _migrate_note "renamed IDE server-data $old_server -> $ide_server_dir"
    else
      _migrate_note "skip IDE server-data rename: move failed"
    fi
  fi

  # Telemetry is now decoupled from client.env. Move the frozen telemetry key set into
  # telemetry.env before deciding whether client.env contains real client runtime config.
  _migrate_client_env_telemetry_keys "$host_dir/client.env" "$client_dir/telemetry.env" || true
  _migrate_client_env_telemetry_keys "$client_dir/client.env" "$client_dir/telemetry.env" || true

  # 2. Move legacy client runtime state out of ~/.xpair/host. A telemetry-only
  # ~/.xpair/client/client.env is not a real runtime marker; merge legacy config into it.
  if [ -d "$host_dir" ]; then
    local did_move=0 f name legacy_client_env_mode=""
    if [ -e "$host_dir/client.env" ]; then
      if [ ! -e "$client_dir/client.env" ]; then
        legacy_client_env_mode=move; did_move=1
      elif ! _migrate_client_env_has_real_config "$client_dir/client.env"; then
        legacy_client_env_mode=merge; did_move=1
      fi
    fi
    for f in \
      "$host_dir/session-names" \
      "$host_dir/.force-onboarding" \
      "$host_dir/bin/xpair-launch" \
      "$host_dir/bin/hangul-romanize" \
      "$host_dir/.manifest-client"; do
      [ -e "$f" ] && did_move=1
    done
    for name in xpair.log code-server.log claude-launch.err.log cli.log; do
      [ -e "$host_dir/logs/$name" ] && did_move=1
    done
    if [ "$did_move" = 1 ]; then
      mkdir -p "$client_dir" 2>/dev/null && chmod 700 "$client_dir" 2>/dev/null || true
      case "$legacy_client_env_mode" in
        move) _move_if_present "$host_dir/client.env" "$client_dir/client.env" ;;
        merge) _migrate_merge_legacy_client_env "$host_dir/client.env" "$client_dir/client.env" && _migrate_note "merged legacy client.env into $client_dir/client.env" ;;
      esac
      _move_if_present "$host_dir/session-names" "$client_dir/session-names"
      _move_if_present "$host_dir/.force-onboarding" "$client_dir/.force-onboarding"
      _move_if_present "$host_dir/.manifest-client" "$client_dir/.manifest-client"
      _move_if_present "$host_dir/bin/xpair-launch" "$client_dir/bin/xpair-launch"
      _move_if_present "$host_dir/bin/hangul-romanize" "$client_dir/bin/hangul-romanize"
      for name in xpair.log code-server.log claude-launch.err.log cli.log; do
        _move_if_present "$host_dir/logs/$name" "$client_dir/logs/$name"
      done
    fi
  fi

  # 3. Client helper paths: moved client CLIs now live under ~/.xpair/client/bin.
  _migrate_rewrite_client_bin_paths "$client_dir/client.env" || true

  # 4. Mount maps: retired ~/.xpair/{host,client}/mounts paths now canonicalize to /Volumes/<share>.
  _migrate_client_mount_maps "$client_dir/client.env" "$host_dir" "$client_dir" || true
  _migrate_cleanup_legacy_mount_roots "$host_dir" "$client_dir" || true
}
