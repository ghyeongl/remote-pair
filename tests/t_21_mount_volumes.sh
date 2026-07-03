#!/usr/bin/env bash
# t_21_mount_volumes — SMB-only mount conventions:
# default mountpoints land at /Volumes/<device>/<sanitized-full-hostpath>, sshfs is rejected, and
# xpair-launch best-effort ensures mount-method mappings before attach.
cd "$(dirname "$0")"; . ./lib.sh

MOUNT_SRC="${MOUNT_SRC:-$_REPO_ROOT/client/cli/xpair-mount}"

run_mount() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" RP_DIR="$RP_DIR" HOME="$HOME" bash "$MOUNT_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}

# ── xpair-mount default mountpoint is /Volumes/<sanitized-remote-host>/<sanitized-full-hostpath> ──
new_sandbox
printf 'REMOTE_HOST=user@office-mac.local\n' > "$RP_CLIENT_DIR/client.env"
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
echo '//alice@office-mac.local/foo on /Volumes/user_office-mac.local/Users_alice_Projects_foo (smbfs, nodev, nosuid, mounted by alice)'
EOF
chmod +x "$MOCKBIN/mount"
run_mount mount /Users/alice/Projects/foo
it "mount/default-volumes-path"
assert_contains "$RP_OUT" "Mountpoint: /Volumes/user_office-mac.local/Users_alice_Projects_foo" "default mountpoint uses /Volumes device/full-hostpath scheme"
cleanup_sandbox

# ── sshfs backend is rejected everywhere ──
new_sandbox
printf 'REMOTE_HOST=test-host\n' > "$RP_CLIENT_DIR/client.env"
run_mount --backend sshfs status
it "mount/sshfs-rejected"
assert_rc "$RP_RC" 2 "sshfs backend rejected"
assert_contains "$RP_ERR" "SMB is the only supported mount backend" "clear smb-only error"
cleanup_sandbox

# ── custom mountpoints are rejected; there is one canonical /Volumes path ──
new_sandbox
printf 'REMOTE_HOST=test-host\n' > "$RP_CLIENT_DIR/client.env"
run_mount mount /Users/alice/proj "$SBX/not-canonical"
it "mount/custom-mountpoint-rejected"
assert_rc "$RP_RC" 2 "noncanonical mountpoint rejected"
assert_contains "$RP_ERR" "custom mountpoints are not supported" "single canonical path enforced"
cleanup_sandbox

load_launch_guard() {
  sed -n '/^# ── path mapping:/,/^# ── human-readable deterministic session name ──/p' "$LAUNCHER_SRC" | sed '$d' > "$SBX/launch-guard.sh"
  # shellcheck disable=SC1090
  . "$SBX/launch-guard.sh"
}

# ── launch guard calls xpair-mount for missing mount-method mappings, but failures do not block attach ──
new_sandbox
SYNC_DIR="$SBX/syncproj"; mkdir -p "$SYNC_DIR"
REMOTE_HOST=test-host
LOCAL_BIN="$MOCKBIN"
FOLDER_MAPS="/Volumes/test-host/Users_alice_proj::/Users/alice/proj;$SYNC_DIR::/Users/alice/sync"
FOLDER_MAP_MODES="/Volumes/test-host/Users_alice_proj::mount;$SYNC_DIR::sync"
PATH="$MOCKBIN:$PATH"
export REMOTE_HOST LOCAL_BIN FOLDER_MAPS FOLDER_MAP_MODES PATH
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$MOCKBIN/xpair-mount" <<'EOF'
#!/bin/bash
{ printf 'xpair-mount'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
echo "simulated mount failure" >&2
exit 42
EOF
chmod +x "$MOCKBIN/mount" "$MOCKBIN/xpair-mount"
load_launch_guard
RP_OUT="$(ensure_mount_mappings_best_effort 2>"$RP_ERRFILE")"; RP_RC=$?
RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
it "launch/ensure-mount-best-effort"
assert_rc "$RP_RC" 0 "mount ensure failure does not block attach"
assert_contains "$MLOG" "xpair-mount|--backend|smb|mount|/Users/alice/proj" "launch guard invokes xpair-mount for mount mapping"
assert_contains "$RP_ERR" "could not mount /Users/alice/proj at /Volumes/test-host/Users_alice_proj before attach" "launch guard warns on mount failure"
cleanup_sandbox

# ── launch guard skips xpair-mount when the canonical /Volumes path is already mounted ──
new_sandbox
SYNC_DIR="$SBX/syncproj"; mkdir -p "$SYNC_DIR"
REMOTE_HOST=test-host
LOCAL_BIN="$MOCKBIN"
FOLDER_MAPS="/Volumes/test-host/Users_alice_proj::/Users/alice/proj;$SYNC_DIR::/Users/alice/sync"
FOLDER_MAP_MODES="/Volumes/test-host/Users_alice_proj::mount;$SYNC_DIR::sync"
PATH="$MOCKBIN:$PATH"
export REMOTE_HOST LOCAL_BIN FOLDER_MAPS FOLDER_MAP_MODES PATH
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
echo '//alice@test-host/proj on /Volumes/test-host/Users_alice_proj (smbfs, nodev, nosuid, mounted by alice)'
EOF
cat > "$MOCKBIN/xpair-mount" <<'EOF'
#!/bin/bash
{ printf 'xpair-mount'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
exit 0
EOF
chmod +x "$MOCKBIN/mount" "$MOCKBIN/xpair-mount"
load_launch_guard
RP_OUT="$(ensure_mount_mappings_best_effort 2>"$RP_ERRFILE")"; RP_RC=$?
MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
it "launch/ensure-mount-skip-mounted"
assert_rc "$RP_RC" 0 "already-mounted guard does not block attach"
assert_absent "$MLOG" "xpair-mount|--backend|smb|mount|/Users/alice/proj" "already mounted path is not remounted"
cleanup_sandbox

# ── wrapper launch attempts a matching /Volumes remount before its initial cd can fail ──
new_sandbox
TARGET="/Volumes/test-host/Users_alice_proj/subdir"
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS="/Volumes/test-host/Users_alice_proj::/Users/alice/proj"\nFOLDER_MAP_MODES="/Volumes/test-host/Users_alice_proj::mount"\nLAUNCHER=%q\n' "$MOCKBIN/xpair-launch" > "$RP_CLIENT_DIR/client.env"
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$MOCKBIN/xpair-mount" <<'EOF'
#!/bin/bash
{ printf 'xpair-mount'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
echo "simulated mount failure" >&2
exit 42
EOF
cat > "$MOCKBIN/xpair-launch" <<'EOF'
#!/bin/bash
{ printf 'xpair-launch'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
exit 0
EOF
chmod +x "$MOCKBIN/mount" "$MOCKBIN/xpair-mount" "$MOCKBIN/xpair-launch"
RP_OUT="$(PATH="$MOCKBIN:$PATH" RP_YES=1 bash "$_REPO_ROOT/client/cli/xpair" launch "$TARGET" 2>"$RP_ERRFILE")"; RP_RC=$?
RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
it "wrapper/ensure-mount-before-launch-cd"
assert_rc "$RP_RC" 1 "wrapper still fails when the directory remains absent after best-effort remount"
assert_contains "$MLOG" "xpair-mount|--backend|smb|mount|/Users/alice/proj" "wrapper invokes xpair-mount before failing cd"
assert_absent "$MLOG" "xpair-launch|" "wrapper does not reach launcher after failed cd"
assert_contains "$RP_ERR" "folder not found" "wrapper reports the cd failure after remount attempt"
cleanup_sandbox

# ── launch ordering: ensure missing mount mappings before the initial project cd ──
ENSURE_LINE="$(awk '/^ensure_mount_mappings_best_effort$/ { print NR; exit }' "$LAUNCHER_SRC")"
PROJECT_CD_LINE="$(awk 'index($0, "PROJECT_DIR=\"$(cd ") == 1 { print NR; exit }' "$LAUNCHER_SRC")"
it "launch/ensure-before-project-cd"
if [ -n "$ENSURE_LINE" ] && [ -n "$PROJECT_CD_LINE" ] && [ "$ENSURE_LINE" -lt "$PROJECT_CD_LINE" ]; then
  _pass "ensure guard call appears before project-dir cd ($ENSURE_LINE < $PROJECT_CD_LINE)"
else
  _fail "ensure guard call must appear before project-dir cd (ensure=$ENSURE_LINE project_cd=$PROJECT_CD_LINE)"
fi

finish
