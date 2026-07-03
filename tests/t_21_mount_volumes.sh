#!/usr/bin/env bash
# t_21_mount_volumes — SMB-only mount conventions:
# NetFS mountpoints are discovered from mount(8), sshfs is rejected, and
# xpair-launch best-effort ensures mount-method mappings before attach.
cd "$(dirname "$0")"; . ./lib.sh

MOUNT_SRC="${MOUNT_SRC:-$_REPO_ROOT/client/cli/xpair-mount}"

run_mount() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" RP_DIR="$RP_DIR" HOME="$HOME" bash "$MOUNT_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}

# ── xpair-mount discovers the system-chosen /Volumes/<share> mountpoint ──
new_sandbox
printf 'REMOTE_HOST=user@office-mac.local\n' > "$RP_CLIENT_DIR/client.env"
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
echo '//alice@office-mac.local/foo on /Volumes/foo (smbfs, nodev, nosuid, mounted by alice)'
EOF
chmod +x "$MOCKBIN/mount"
run_mount mount /Users/alice/Projects/foo
it "mount/discover-volumes-share-path"
assert_contains "$RP_OUT" "Mountpoint: /Volumes/foo" "mountpoint is discovered from the smbfs mount table"
cleanup_sandbox

# ── fresh mount uses NetFS, creates no /Volumes directories, then discovers the mountpoint ──
new_sandbox
printf 'REMOTE_HOST=user@office-mac.local\n' > "$RP_CLIENT_DIR/client.env"
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
[ -f "$SBX/mounted" ] && echo '//alice@office-mac.local/foo on /Volumes/foo-1 (smbfs, nodev, nosuid, mounted by alice)'
EOF
cat > "$MOCKBIN/ssh" <<'EOF'
#!/bin/bash
case "$*" in *" whoami") echo alice; exit 0 ;; esac
exit 1
EOF
cat > "$MOCKBIN/osascript" <<'EOF'
#!/bin/bash
{ printf 'osascript'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
touch "$SBX/mounted"
exit 0
EOF
cat > "$MOCKBIN/mkdir" <<'EOF'
#!/bin/bash
{ printf 'mkdir'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
exit 99
EOF
chmod +x "$MOCKBIN/mount" "$MOCKBIN/ssh" "$MOCKBIN/osascript" "$MOCKBIN/mkdir"
run_mount mount /Users/alice/Projects/foo
MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
it "mount/netfs-no-volumes-mkdir"
assert_rc "$RP_RC" 0 "NetFS mount succeeds after discovery"
assert_contains "$MLOG" 'osascript|-e|mount volume "smb://alice@office-mac.local/foo"' "mount uses osascript NetFS URL"
assert_absent "$MLOG" "mkdir" "xpair-mount does not mkdir under /Volumes"
assert_contains "$RP_OUT" "Mountpoint: /Volumes/foo-1" "system-suffixed mountpoint is discovered and printed"
cleanup_sandbox

# ── sshfs backend is rejected for new mounts, but tolerated for legacy cleanup/status ──
new_sandbox
printf 'REMOTE_HOST=test-host\n' > "$RP_CLIENT_DIR/client.env"
run_mount --backend sshfs mount /Users/alice/proj
it "mount/sshfs-rejected-for-mount"
assert_rc "$RP_RC" 2 "sshfs backend rejected for mount"
assert_contains "$RP_ERR" "SMB is the only supported mount backend" "clear smb-only error for mount"
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$MOCKBIN/mount"
run_mount --backend sshfs status
it "mount/sshfs-status-tolerated"
assert_rc "$RP_RC" 0 "legacy sshfs backend tolerated for status"
assert_contains "$RP_OUT" "(none)" "status still reports SMB table"
run_mount --backend sshfs unmount /Volumes/proj
it "mount/sshfs-unmount-tolerated"
assert_rc "$RP_RC" 0 "legacy sshfs backend tolerated for unmount"
assert_contains "$RP_ERR" "Nothing appears to be mounted at /Volumes/proj" "unmount reaches cleanup path"
printf 'REMOTE_HOST=test-host\nMOUNT_BACKEND=sshfs\n' > "$RP_CLIENT_DIR/client.env"
run_mount status
it "mount/persisted-sshfs-status-tolerated"
assert_rc "$RP_RC" 0 "persisted MOUNT_BACKEND=sshfs tolerated for status"
cleanup_sandbox

# ── custom mountpoints are rejected; NetFS chooses the /Volumes path ──
new_sandbox
printf 'REMOTE_HOST=test-host\n' > "$RP_CLIENT_DIR/client.env"
run_mount mount /Users/alice/proj "$SBX/not-canonical"
it "mount/custom-mountpoint-rejected"
assert_rc "$RP_RC" 2 "noncanonical mountpoint rejected"
assert_contains "$RP_ERR" "custom mountpoints are not supported" "custom mountpoint rejected"
cleanup_sandbox

load_launch_guard() {
  sed -n '/^# ── path mapping:/,/^# ── human-readable deterministic session name ──/p' "$LAUNCHER_SRC" | sed '$d' > "$SBX/launch-guard.sh"
  # shellcheck disable=SC1090
  . "$SBX/launch-guard.sh"
}

# ── launch guard inference also excludes non-SMB /Volumes paths ──
new_sandbox
REMOTE_HOST=test-host
FOLDER_MAPS=""
FOLDER_MAP_MODES=""
PATH="$MOCKBIN:$PATH"
export REMOTE_HOST FOLDER_MAPS FOLDER_MAP_MODES PATH
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
echo '/dev/disk4s1 on /Volumes/ExternalSSD (apfs, local, nodev)'
echo '//alice@test-host/proj on /Volumes/proj (smbfs, nodev, nosuid, mounted by alice)'
EOF
chmod +x "$MOCKBIN/mount"
load_launch_guard
it "launch/infer-non-smb-volumes-sync"
assert_eq "$(map_mode_infer /Volumes/ExternalSSD/work)" "sync" "xpair-launch treats external disks under /Volumes as sync"
it "launch/infer-remote-smb-volumes-mount"
assert_eq "$(map_mode_infer /Volumes/proj/subdir)" "mount" "xpair-launch treats REMOTE_HOST smbfs /Volumes paths as mount"
cleanup_sandbox

# ── launch guard calls xpair-mount for missing mount-method mappings, but failures do not block attach ──
new_sandbox
SYNC_DIR="$SBX/syncproj"; mkdir -p "$SYNC_DIR"
REMOTE_HOST=test-host
LOCAL_BIN="$MOCKBIN"
FOLDER_MAPS="/Volumes/proj::/Users/alice/proj;$SYNC_DIR::/Users/alice/sync"
FOLDER_MAP_MODES="/Volumes/proj::mount;$SYNC_DIR::sync"
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
assert_contains "$RP_ERR" "could not mount /Users/alice/proj at /Volumes/proj before attach" "launch guard warns on mount failure"
cleanup_sandbox

# ── launch guard skips xpair-mount when the canonical /Volumes path is already mounted ──
new_sandbox
SYNC_DIR="$SBX/syncproj"; mkdir -p "$SYNC_DIR"
REMOTE_HOST=test-host
LOCAL_BIN="$MOCKBIN"
FOLDER_MAPS="/Volumes/proj::/Users/alice/proj;$SYNC_DIR::/Users/alice/sync"
FOLDER_MAP_MODES="/Volumes/proj::mount;$SYNC_DIR::sync"
PATH="$MOCKBIN:$PATH"
export REMOTE_HOST LOCAL_BIN FOLDER_MAPS FOLDER_MAP_MODES PATH
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
echo '//alice@test-host/proj on /Volumes/proj (smbfs, nodev, nosuid, mounted by alice)'
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
TARGET="/Volumes/proj/subdir"
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS="/Volumes/proj::/Users/alice/proj"\nFOLDER_MAP_MODES="/Volumes/proj::mount"\nLAUNCHER=%q\n' "$MOCKBIN/xpair-launch" > "$RP_CLIENT_DIR/client.env"
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

# ── reset-onboarding unmounts real mount-method FOLDER_MAPS entries before clearing config ──
new_sandbox
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS="/Volumes/proj::/Users/alice/proj;%s::/Users/alice/sync"\nFOLDER_MAP_MODES="/Volumes/proj::mount;%s::sync"\n' "$SBX/syncproj" "$SBX/syncproj" > "$RP_CLIENT_DIR/client.env"
cat > "$MOCKBIN/xpair-mount" <<'EOF'
#!/bin/bash
{ printf 'xpair-mount'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
exit 0
EOF
chmod +x "$MOCKBIN/xpair-mount"
RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" bash "$_REPO_ROOT/client/cli/reset-onboarding.sh" --yes 2>"$RP_ERRFILE")"; RP_RC=$?
MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
it "reset-onboarding/unmounts-folder-maps"
assert_rc "$RP_RC" 0 "reset onboarding succeeds"
assert_contains "$MLOG" "xpair-mount|unmount|/Users/alice/proj" "reset unmounts mount-method host path through xpair-mount"
assert_absent "$MLOG" "xpair-mount|unmount|/Users/alice/sync" "reset skips sync mapping"
assert_contains "$(cat "$RP_CLIENT_DIR/client.env")" "REMOTE_HOST=" "reset clears REMOTE_HOST"
cleanup_sandbox

# ── reset-onboarding must not infer a plain external drive under /Volumes as mount ──
new_sandbox
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS="/Volumes/ExternalSSD/work::/Users/alice/work"\nFOLDER_MAP_MODES=\n' > "$RP_CLIENT_DIR/client.env"
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
echo '/dev/disk4s1 on /Volumes/ExternalSSD (apfs, local, nodev)'
EOF
cat > "$MOCKBIN/xpair-mount" <<'EOF'
#!/bin/bash
{ printf 'xpair-mount'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
exit 0
EOF
chmod +x "$MOCKBIN/mount" "$MOCKBIN/xpair-mount"
RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" bash "$_REPO_ROOT/client/cli/reset-onboarding.sh" --yes 2>"$RP_ERRFILE")"; RP_RC=$?
MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
it "reset-onboarding/non-smb-volumes-sync"
assert_rc "$RP_RC" 0 "reset onboarding succeeds for non-SMB /Volumes mapping"
assert_absent "$MLOG" "xpair-mount|unmount|/Users/alice/work" "reset does not unmount non-SMB /Volumes mapping"
cleanup_sandbox

# ── hot self-update compatibility: client CLIs fall back to legacy host/client.env ──
new_sandbox
rm -f "$RP_CLIENT_DIR/client.env"
printf 'REMOTE_HOST=legacy-host\nEDITOR_PORT=9090\n' > "$RP_HOST_DIR/client.env"
printf 'LEGACY_COMMON=1\n' > "$RP_HOST_DIR/common.env"
RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" bash "$_REPO_ROOT/client/cli/xpair" config get host 2>"$RP_ERRFILE")"; RP_RC=$?
it "legacy-config-fallback/xpair"
assert_rc "$RP_RC" 0 "xpair reads legacy client env"
assert_eq "$RP_OUT" "legacy-host" "xpair gets host from ~/.xpair/host/client.env when client env is absent"

cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
echo '//alice@legacy-host/proj on /Volumes/proj (smbfs, nodev, nosuid, mounted by alice)'
EOF
chmod +x "$MOCKBIN/mount"
RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" bash "$MOUNT_SRC" status 2>"$RP_ERRFILE")"; RP_RC=$?
it "legacy-config-fallback/xpair-mount"
assert_rc "$RP_RC" 0 "xpair-mount status reads legacy client env"
assert_contains "$RP_OUT" "//alice@legacy-host/proj" "xpair-mount filters using legacy REMOTE_HOST"

cat > "$MOCKBIN/open" <<'EOF'
#!/bin/bash
{ printf 'open'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
exit 0
EOF
chmod +x "$MOCKBIN/open"
RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" bash "$_REPO_ROOT/client/cli/xpair-desktop" open 2>"$RP_ERRFILE")"; RP_RC=$?
MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
it "legacy-config-fallback/xpair-desktop"
assert_rc "$RP_RC" 0 "xpair-desktop reads legacy client env"
assert_contains "$MLOG" "open|vnc://legacy-host" "desktop opens legacy REMOTE_HOST"

cat > "$MOCKBIN/lsof" <<'EOF'
#!/bin/bash
{ printf 'lsof'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
exit 1
EOF
chmod +x "$MOCKBIN/lsof"
RP_OUT="$(PATH="$MOCKBIN:$PATH" HOME="$HOME" bash "$_REPO_ROOT/client/cli/xpair-editor" status 2>"$RP_ERRFILE")"; RP_RC=$?
MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
it "legacy-config-fallback/xpair-editor"
assert_rc "$RP_RC" 1 "xpair-editor status reports no listener"
assert_contains "$MLOG" "lsof|-nP|-iTCP:9090" "editor reads legacy EDITOR_PORT"
cleanup_sandbox

for cli in xpair xpair-launch xpair-mount xpair-desktop xpair-editor; do
  src="$_REPO_ROOT/client/cli/$cli"
  body="$(sed -n '1,130p' "$src")"
  it "legacy-config-fallback/static-$cli"
  assert_contains "$body" 'if [ -f "$RP_CLIENT_DIR/client.env" ]' "$cli gates fallback on missing client env"
  assert_contains "$body" '[ -f "$RP_HOST_DIR/$_f.env" ]' "$cli sources legacy host/{common,client}.env"
done

# ── remote tmux respawn keeps its host-side session log under ~/.xpair/host/logs ──
RESPAWN_BLOCK="$(sed -n '/^respawn_body_claude()/,/^}$/p' "$LAUNCHER_SRC")"
it "launch/remote-session-log-host-dir"
assert_contains "$RESPAWN_BLOCK" '_rplog="$HOME/.xpair/host/logs/xpair.log"' "remote respawn log path stays under host runtime"
assert_absent "$RESPAWN_BLOCK" '_rplog="$HOME/.xpair/client/logs/xpair.log"' "remote respawn log path is not client runtime"

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
