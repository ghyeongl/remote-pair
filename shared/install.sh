#!/bin/bash
# install.sh — Xpair installer (role-based, reversible).
#
# Roles (--role):
#   host    Machine where claude runs with computer-use. XpairHost.app + LaunchAgent + approve (skill/rules) + watchdog.
#   client  Machine you sit at. Service "Launch Xpair" + launcher + xpair CLI. (No app/permissions/build needed.)
#   both    Both roles on one machine (default).
#
# All runtime state lives under ~/.xpair/host (self-contained). ~/.claude only receives the
# Claude harness (approve skill) — Xpair behavior does not depend on ~/.claude being synced.
#
# Sync is OFF by default (opt-in). ~/.claude git backbone is set up only with --with-sync or SYNC_URL set.
# Every action is recorded in the manifest so uninstall.sh can precisely reverse it.
#
# Usage:
#   ./install.sh                      # role=both (interactive REMOTE_HOST prompt)
#   ./install.sh --role client        # Laptop: Service + launcher only (no build/permissions needed)
#   ./install.sh --role host          # Server: app + approve (requires a built build/XpairHost.app)
#   ./install.sh --with-sync          # + ~/.claude git backbone
#   REMOTE_HOST=my-mac ./install.sh --role client      # Non-interactive
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/config.sh"
. "$HERE/lib.sh"

ROLE=both; DO_NATIVE=1; DO_SYNC=0
[ -n "${SYNC_URL:-}" ] && DO_SYNC=1
while [ $# -gt 0 ]; do case "$1" in
  --role) ROLE="${2:-both}"; shift 2 ;;
  --role=*) ROLE="${1#*=}"; shift ;;
  --with-sync) DO_SYNC=1; shift ;;
  --no-sync) DO_SYNC=0; shift ;;
  --no-native) DO_NATIVE=0; shift ;;
  -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac; done
case "$ROLE" in host|client|both) : ;; *) echo "invalid --role: $ROLE (host|client|both)" >&2; exit 2 ;; esac
MANIFEST="$RP_DIR/.manifest-$ROLE"

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }
is_host()   { [ "$ROLE" = host ] || [ "$ROLE" = both ]; }
is_client() { [ "$ROLE" = client ] || [ "$ROLE" = both ]; }

_write_env() {
  local f="$1"; shift
  [ -e "$f" ] || record FILE "$f"
  { echo "# Xpair config ($(basename "$f")) — written by install.sh. Safe to edit manually."
    local k; for k in "$@"; do printf '%s=%q\n' "$k" "${!k}"; done
  } > "$f"
}
write_config() {
  mk_dir "$RP_DIR"; chmod 700 "$RP_DIR"
  _write_env "$COMMON_ENV" "${COMMON_KEYS[@]}"
  if is_host;   then _write_env "$HOST_ENV"   "${HOST_KEYS[@]}"; fi
  if is_client; then _write_env "$CLIENT_ENV" "${CLIENT_KEYS[@]}"; fi
  # role marker — read as the SSOT when the app Installer refuses host self-install on a client machine.
  [ -e "$RP_DIR/role" ] || record FILE "$RP_DIR/role"
  printf '%s\n' "$ROLE" > "$RP_DIR/role"
}

# ── 0. Input ──
say "Xpair install — role=$ROLE, sync=$([ "$DO_SYNC" = 1 ] && echo on || echo off) (bundle=$BUNDLE_PREFIX, app=$APP_NAME)"
if is_client && [ -z "${REMOTE_HOST:-}" ] && [ -t 0 ] && [ "${RP_YES:-0}" != 1 ]; then
  read -r -p "Remote host (mosh/ssh target; leave blank for local-only): " REMOTE_HOST || true
fi
[ -n "${REMOTE_HOST:-}" ] && say "Remote host = $REMOTE_HOST" || say "REMOTE_HOST not set (local-only mode)"

# ── Revert existing install before re-installing (idempotent) ──
# notify.conf is a config file that may hold user edits (ENABLED_TYPES). Since we recorded it as
# FILE on first install, a revert would delete it and reinstall would reset to defaults → user edits lost.
# Stash it just before revert and restore it right after, so the "create only if absent" guard below sees the preserved copy.
_RP_NOTIFY_STASH=""
if [ -f "$MANIFEST" ]; then
  say "Existing install detected — reverting before reinstall"
  if [ -f "$RP_DIR/notify.conf" ]; then _RP_NOTIFY_STASH="$(mktemp)" && cp -p "$RP_DIR/notify.conf" "$_RP_NOTIFY_STASH"; fi
  manifest_revert >/dev/null 2>&1 || true
  if [ -n "$_RP_NOTIFY_STASH" ] && [ ! -e "$RP_DIR/notify.conf" ]; then
    mkdir -p "$RP_DIR" && cp -p "$_RP_NOTIFY_STASH" "$RP_DIR/notify.conf"
  fi
  [ -n "$_RP_NOTIFY_STASH" ] && rm -f "$_RP_NOTIFY_STASH"
fi
manifest_init
write_config
record NOTE "installed role=$ROLE at $(date '+%F %T') on $(hostname -s)"

# ── Common: umbrella CLI → PATH + log directory ──
say "xpair CLI → $LOCAL_BIN"
install_file "$CLIENT_DIR/xpair" "$LOCAL_BIN/xpair" 755
case ":$PATH:" in *":$LOCAL_BIN:"*) : ;; *) warn "$LOCAL_BIN is not in PATH — add it to your shell rc" ;; esac
mk_dir "$LOG_DIR"; chmod 700 "$LOG_DIR"

# ── Common: ensure mosh (resilient UDP attach; ssh fallback if absent) ──
# CLIENT: ship a self-contained STATIC mosh + mosh-client inside Xpair.app (built against protobuf
# 3.21.12, pre-abseil → 0 Homebrew dylib deps; see host/build-mosh.sh), bundled into this repo-shaped
# CLI tree by client/ide/build.sh. Install them to ~/.local/bin the same way the xpair CLI is installed,
# so a client install is fully brew-free. A dev checkout (no client build → no bundle) falls back to any
# system mosh on PATH, else to `ssh -t` at attach time. HOST: needs only mosh-server, shipped INSIDE
# XpairHost.app and symlinked to ~/.local/bin by the app's self-installer — so a host install is brew-free too.
if is_client && [ -x "$CLIENT_DIR/bin/mosh" ] && [ -x "$CLIENT_DIR/bin/mosh-client" ]; then
  say "mosh (bundled static) → $LOCAL_BIN (brew-free client attach)"
  install_file "$CLIENT_DIR/bin/mosh"        "$LOCAL_BIN/mosh"        755
  install_file "$CLIENT_DIR/bin/mosh-client" "$LOCAL_BIN/mosh-client" 755
elif command -v mosh >/dev/null 2>&1; then
  say "mosh present ($(command -v mosh))"
elif is_client; then
  warn "no bundled mosh in this build and none on PATH — attach falls back to ssh (dev checkout)"
else
  say "mosh-server provided by XpairHost.app bundle (host needs no Homebrew mosh)"
fi

# ── HOST: app + approve (skill/rules) + watchdog + LaunchAgent ──
if is_host; then
  say "[host] approve rules → $RULES_FILE"
  install_file "$HOST_DIR/rules.txt" "$RULES_FILE"
  if [ -d "$HOST_DIR/skills" ]; then
    say "[host] approve skill → $CLAUDE_DIR/skills (Claude harness location)"
    while IFS= read -r src; do
      rel="${src#"$HOST_DIR/skills/"}"; install_file "$src" "$CLAUDE_DIR/skills/$rel"
    done < <(find "$HOST_DIR/skills" -type f)
  fi

  # notify hook → ~/.xpair/host/bin/xpair-notify.sh (Claude Code events → append to queue).
  # Together with the approve hook, manage-claude-hooks.py (4-arg) idempotently merges it into settings.json.
  # notify.conf defaults are laid down only on first install (preserving user edits), and recorded reversibly in the manifest.
  notify_cmd="$RP_DIR/bin/xpair-notify.sh"
  if [ -f "$HOST_DIR/hooks/xpair-notify.sh" ]; then
    say "[host] notify hook → $notify_cmd"
    install_file "$HOST_DIR/hooks/xpair-notify.sh" "$notify_cmd" 755
    # notify.conf — first-run defaults (create only if absent, preserving user edits). manifest-record on creation.
    if [ ! -e "$RP_DIR/notify.conf" ] && [ -f "$HOST_DIR/hooks/notify.conf.example" ]; then
      mk_dir "$RP_DIR"; record FILE "$RP_DIR/notify.conf"
      cp "$HOST_DIR/hooks/notify.conf.example" "$RP_DIR/notify.conf"
      say "  notify.conf defaults created (editable: $RP_DIR/notify.conf)"
    fi
  else
    warn "host/hooks/xpair-notify.sh not found — skipping notify hook (notifications unavailable)"
  fi

  # approve reminder hook → ~/.claude/settings.json (PermissionDenied/PostToolUseFailure).
  # When a tool is denied on a headless host because it's blocked by a GUI approval dialog (Chrome permissions, 1Password, system prompts),
  # deterministically remind the model of the approve skill (instead of relying on the skill description alone). Idempotent merge — preserves existing hooks.
  # manage-claude-hooks.py is 4-arg: add <settings> <approve_cmd> <notify_cmd>. It merges approve+notify
  # in one pass, so the notify hook file is laid down above before this call.
  if [ -f "$HOST_DIR/hooks/approve-reminder.sh" ] && [ -f "$HOST_DIR/hooks/manage-claude-hooks.py" ]; then
    if command -v python3 >/dev/null 2>&1; then
      install_file "$HOST_DIR/hooks/manage-claude-hooks.py" "$RP_DIR/bin/manage-claude-hooks.py" 755
      install_file "$HOST_DIR/hooks/approve-reminder.sh"    "$CLAUDE_DIR/hooks/xpair-approve-reminder.sh" 755
      settings="$CLAUDE_DIR/settings.json"
      approve_cmd='$HOME/.claude/hooks/xpair-approve-reminder.sh'
      existed=0; [ -f "$settings" ] && existed=1
      say "[host] approve+notify hook → $settings (idempotent merge)"
      python3 "$RP_DIR/bin/manage-claude-hooks.py" add "$settings" "$approve_cmd" "$notify_cmd" || warn "approve/notify hook merge failed — manual check required"
      # HOOKS rollback must remove both the approve_cmd and notify_cmd identifiers separately → record two lines.
      if [ "$existed" = 1 ]; then
        record HOOKS "$settings" "$approve_cmd"   # pre-existing file → roll back via surgical removal (approve)
        record HOOKS "$settings" "$notify_cmd"    # pre-existing file → roll back via surgical removal (notify)
      else
        record FILE "$settings"                   # file we newly created → roll back via full deletion
      fi
    else
      warn "python3 not found — skipping approve/notify hook install (skill is installed). After installing the CLT, re-running install.sh --role host is recommended"
    fi
  fi

  # Remove legacy label names — idempotent, best-effort
  U=$(id -u)
  for L in com.ghyeong.remote-pair com.ghyeong.remote-pair-watchdog com.ghyeong.auto-approve com.ghyeong.auto-approve-watchdog com.x10lab.remote-pair com.x10lab.remote-pair-watchdog com.x10lab.remote-pair-host com.x10lab.remote-pair-host-watchdog; do
    launchctl bootout "gui/$U/$L" 2>/dev/null || true
  done
  rm -rf "$HOME/Applications/RemotePairHost.app" "$HOME/Applications/RemotePair.app" "$HOME/Applications/AutoApprove.app" 2>/dev/null || true

  # watchdog
  install -d "$RP_DIR/bin" 2>/dev/null || mkdir -p "$RP_DIR/bin"
  write_file "$RP_DIR/bin/xpair-watchdog.sh" 755 <<W
#!/bin/bash
# xpair-watchdog.sh — Restart $APP_NAME when heartbeat goes stale. (generated by install.sh)
set -u
HB="$HEARTBEAT_FILE"; LOG="$LOG_FILE"
STALE=90; LABEL="gui/\$(id -u)/${APP_LABEL}"; now=\$(date +%s)
if [ -f "\$HB" ]; then
  age=\$(( now - \$(stat -f %m "\$HB" 2>/dev/null || echo 0) ))
  [ "\$age" -gt "\$STALE" ] && { launchctl kickstart -k "\$LABEL" >/dev/null 2>&1; printf '%s watchdog: stale %ss\n' "\$(date '+%F %T')" "\$age" >> "\$LOG"; }
else launchctl kickstart -k "\$LABEL" >/dev/null 2>&1; fi
W

  if [ "$DO_NATIVE" = 1 ]; then
    if [ -d "$REPO_ROOT/build/${APP_NAME}.app" ]; then
      say "[host] Installing app → $APP_PATH"
      [ -e "$APP_PATH" ] && rm -rf "$APP_PATH"
      mk_dir "$(dirname "$APP_PATH")"; record TREE "$APP_PATH"
      cp -R "$REPO_ROOT/build/${APP_NAME}.app" "$APP_PATH"
      xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
      if [ -x "$APP_PATH/Contents/Helpers/tmux-aqua" ]; then
        mk_dir "$LOCAL_BIN"; record FILE "$LOCAL_BIN/tmux-aqua"
        ln -sf "$APP_PATH/Contents/Helpers/tmux-aqua" "$LOCAL_BIN/tmux-aqua"
      fi
      app_plist="$LAUNCH_AGENTS/${APP_LABEL}.plist"; wd_plist="$LAUNCH_AGENTS/${WATCHDOG_LABEL}.plist"
      write_file "$app_plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${APP_LABEL}</string>
  <key>ProgramArguments</key><array><string>${APP_EXEC}</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/xpair.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/xpair.err.log</string>
</dict></plist>
P
      write_file "$wd_plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>${RP_DIR}/bin/xpair-watchdog.sh</string></array>
  <key>RunAtLoad</key><true/><key>StartInterval</key><integer>30</integer>
  <key>StandardErrorPath</key><string>${LOG_DIR}/xpair-watchdog.err.log</string>
</dict></plist>
P
      U=$(id -u)
      # Replace any already-running instance — INCLUDING a Finder/Dock (`open -a`) launch that launchd
      # does not manage — so the (re)started LaunchAgent binds THIS freshly-installed on-disk bundle.
      # `bootstrap`/`kickstart` alone restart only the *service*; a GUI-launched process keeps holding
      # the socket and its older in-memory version, so an on-disk upgrade silently never takes effect
      # (running version stays old, the client keeps gating it as below-floor → "update host" loop).
      pkill -f "/${APP_NAME}.app/Contents/MacOS/${APP_NAME}" 2>/dev/null || true
      sleep 1
      launchctl bootstrap "gui/$U" "$app_plist" 2>/dev/null || launchctl kickstart -k "gui/$U/${APP_LABEL}" 2>/dev/null || true
      record LAUNCHCTL "$APP_LABEL" "$app_plist"
      launchctl bootstrap "gui/$U" "$wd_plist" 2>/dev/null || true
      record LAUNCHCTL "$WATCHDOG_LABEL" "$wd_plist"
      warn "One-time permission grant: System Settings → Privacy & Security → turn $APP_NAME ON for Accessibility + Screen Recording (required), and Full Disk Access (recommended for a headless host — silences unanswerable folder prompts). Then 'Restart tmux host'."
    else
      warn "No build artifact: $REPO_ROOT/build/${APP_NAME}.app — run host/build-host.sh first (skipping app install)"
    fi
  fi
fi

# ── CLIENT: launcher + Service "Launch Xpair" ──
if is_client; then
  say "[client] launcher + Service"
  install -d "$RP_DIR/bin" 2>/dev/null || mkdir -p "$RP_DIR/bin"
  [ -f "$CLIENT_DIR/hangul-romanize" ] && install_file "$CLIENT_DIR/hangul-romanize" "$RP_DIR/bin/hangul-romanize" 755
  say "[client] shared logger → $RP_DIR/bin/logging.sh"
  install_file "$HERE/logging.sh" "$RP_DIR/bin/logging.sh" 644
  install_file "$CLIENT_DIR/xpair-launch" "$LAUNCHER" 755

  # ── Web-tab launchers: editor (M4 code-server) + desktop (M5 Screen Sharing). manifest-recorded → reversible. ──
  if [ -f "$CLIENT_DIR/xpair-editor" ]; then
    say "[client] editor launcher → $LOCAL_BIN/xpair-editor"
    install_file "$CLIENT_DIR/xpair-editor" "$LOCAL_BIN/xpair-editor" 755
  else
    warn "client/cli/xpair-editor not found — skipping ('xpair editor' unavailable)"
  fi
  if [ -f "$CLIENT_DIR/xpair-desktop" ]; then
    say "[client] desktop launcher → $LOCAL_BIN/xpair-desktop"
    install_file "$CLIENT_DIR/xpair-desktop" "$LOCAL_BIN/xpair-desktop" 755
  else
    warn "client/cli/xpair-desktop not found — skipping ('xpair desktop' unavailable)"
  fi
  # ── Mount-based file access (alternative to Syncthing — see docs/m-mount.md). manifest-recorded → reversible. ──
  if [ -f "$CLIENT_DIR/xpair-mount" ]; then
    say "[client] mount launcher → $LOCAL_BIN/xpair-mount"
    install_file "$CLIENT_DIR/xpair-mount" "$LOCAL_BIN/xpair-mount" 755
  else
    warn "client/cli/xpair-mount not found — skipping ('xpair mount' unavailable)"
  fi
  # ── askpass helper (sibling launcher used by 'xpair install-host' over SSH). ──
  if [ -f "$CLIENT_DIR/xpair-askpass" ]; then
    say "[client] askpass helper → $LOCAL_BIN/xpair-askpass"
    install_file "$CLIENT_DIR/xpair-askpass" "$LOCAL_BIN/xpair-askpass" 755
  else
    warn "client/cli/xpair-askpass not found — skipping (SSH askpass prompts unavailable)"
  fi
  svc_src="$CLIENT_DIR/Launch Xpair.workflow"
  svc_dst="$SERVICES_DIR/Launch Xpair.workflow"
  if [ -d "$svc_src" ]; then
    [ -e "$svc_dst" ] && rm -rf "$svc_dst"
    mk_dir "$SERVICES_DIR"; record TREE "$svc_dst"
    cp -R "$svc_src" "$svc_dst"
    [ "$SERVICES_DIR" = "$HOME/Library/Services" ] && /System/Library/CoreServices/pbs -flush 2>/dev/null || true
    say "  Service registered — Finder: right-click folder → Quick Actions → Launch Xpair"
  else
    warn "Service template not found: $svc_src (skipping Service install)"
  fi
fi

# ── SYNC (opt-in): ~/.claude git backbone (personal convenience — unrelated to Xpair behavior) ──
if [ "$DO_SYNC" = 1 ]; then
  say "[sync] gitignore whitelist + git backbone"
  while IFS= read -r line; do
    [ -z "$line" ] && continue; case "$line" in \#*) continue ;; esac
    add_gitignore "$line"
  done < "$HERE/claude.gitignore"
  "$HERE/sync-setup.sh"
else
  say "sync off — ~/.claude not synced (enable with --with-sync)"
fi

say "Done. To uninstall:  $HERE/uninstall.sh"
record NOTE "install finished"

# ── client: SSH connectivity check (non-blocking advisory) ──
if is_client && [ -n "${REMOTE_HOST:-}" ]; then
  echo; say "[client] SSH connectivity check (xpair doctor)"
  "$LOCAL_BIN/xpair" doctor || warn "doctor reported issues — see above (install itself succeeded)"
fi

# ── client: host handshake poll (best-effort, non-fatal, max 30s) ──
# Confirms the host side is alive and its status.json is fresh (age ≤ 15s = app is heartbeating).
if is_client && [ -n "${REMOTE_HOST:-}" ]; then
  echo; say "[client] host handshake poll (max 30s)"
  _hs_ok=0
  for _hs_i in 1 2 3 4 5 6 7 8 9 10; do
    printf '  attempt %d/10 — ' "$_hs_i"
    if ssh -o BatchMode=yes -o ConnectTimeout=4 "$REMOTE_HOST" true 2>/dev/null; then
      _sj="$(ssh -o BatchMode=yes -o ConnectTimeout=4 "$REMOTE_HOST" 'cat ~/.xpair/host/logs/status.json 2>/dev/null' 2>/dev/null || true)"
      if [ -n "$_sj" ]; then
        # Check freshness: status.json mtime age ≤ 15s means app is heartbeating
        _fresh="$(ssh -o BatchMode=yes -o ConnectTimeout=4 "$REMOTE_HOST" \
          'python3 -c "import os,time; f=os.path.expanduser(\"~/.xpair/host/logs/status.json\"); print(\"fresh\" if os.path.exists(f) and (time.time()-os.path.getmtime(f))<=15 else \"stale\")" 2>/dev/null' 2>/dev/null || true)"
        if [ "$_fresh" = "fresh" ]; then
          echo "host reachable + status.json fresh — handshake OK"; _hs_ok=1; break
        else
          echo "host reachable, status.json stale or absent (app may be starting)"
        fi
      else
        echo "host reachable, no status.json yet (host app not running?)"
      fi
    else
      echo "SSH not yet reachable"
    fi
    [ "$_hs_i" -lt 10 ] && sleep 3
  done
  if [ "$_hs_ok" = 0 ]; then
    warn "handshake timed out — host may not be running XpairHost.app yet (install succeeded; start the app on the host)"
  fi
fi

# ── client: interactive onboarding (tty only) ──
if is_client && [ -t 0 ]; then
  echo
  "$LOCAL_BIN/xpair" onboard || true
fi
