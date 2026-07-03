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
      FILE)      [ -e "$a" ] && rm -f "$a" && echo "  rm   $a" ;;
      TREE)      [ -e "$a" ] && rm -rf "$a" && echo "  rm -rf $a" ;;
      BACKUP)    [ -e "$b" ] && cp -p "$b" "$a" && rm -f "$b" && echo "  restore $a" ;;
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

  # 2. Move legacy client runtime state out of ~/.xpair/host when the new marker is absent.
  if [ -d "$host_dir" ] && [ ! -e "$client_dir/client.env" ]; then
    local did_move=0 f name
    for f in \
      "$host_dir/client.env" \
      "$host_dir/session-names" \
      "$host_dir/.force-onboarding" \
      "$host_dir/bin/xpair-launch" \
      "$host_dir/bin/hangul-romanize" \
      "$host_dir/bin/logging.sh" \
      "$host_dir/.manifest-client"; do
      [ -e "$f" ] && did_move=1
    done
    for name in xpair.log code-server.log claude-launch.err.log cli.log; do
      [ -e "$host_dir/logs/$name" ] && did_move=1
    done
    if [ "$did_move" = 1 ]; then
      mkdir -p "$client_dir" 2>/dev/null && chmod 700 "$client_dir" 2>/dev/null || true
      _move_if_present "$host_dir/client.env" "$client_dir/client.env"
      _move_if_present "$host_dir/session-names" "$client_dir/session-names"
      _move_if_present "$host_dir/.force-onboarding" "$client_dir/.force-onboarding"
      _move_if_present "$host_dir/.manifest-client" "$client_dir/.manifest-client"
      _move_if_present "$host_dir/bin/xpair-launch" "$client_dir/bin/xpair-launch"
      _move_if_present "$host_dir/bin/hangul-romanize" "$client_dir/bin/hangul-romanize"
      _move_if_present "$host_dir/bin/logging.sh" "$client_dir/bin/logging.sh"
      for name in xpair.log code-server.log claude-launch.err.log cli.log; do
        _move_if_present "$host_dir/logs/$name" "$client_dir/logs/$name"
      done
    fi
  fi

  # 3. Mounts: do not move live/non-empty mounts; FOLDER_MAPS rewrite is deferred.
  # ponytail: Phase 1 only installs a compat symlink for empty mounts; live FOLDER_MAPS rewrites wait for the mount phase.
  local host_mounts client_mounts
  host_mounts="$host_dir/mounts"
  client_mounts="$client_dir/mounts"
  if [ -d "$host_mounts" ] && [ ! -L "$host_mounts" ]; then
    if [ -z "$(find "$host_mounts" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      mkdir -p "$client_mounts" 2>/dev/null || true
      if rmdir "$host_mounts" 2>/dev/null && ln -s "$client_mounts" "$host_mounts" 2>/dev/null; then
        _migrate_note "linked empty mounts $host_mounts -> $client_mounts"
      else
        _migrate_note "skip empty mounts compat symlink: update failed"
      fi
    else
      _migrate_note "left non-empty mounts in place at $host_mounts"
    fi
  fi
}
