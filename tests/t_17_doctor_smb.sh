#!/usr/bin/env bash
# t_17_doctor_smb — `xpair doctor` reports host File Sharing (SMB) readiness when a mount-method
# mapping exists, and stays silent for sync-only setups (no false SMB gate). The host probe is
# stubbed via a fake `ssh` that echoes on/off.
cd "$(dirname "$0")"; . ./lib.sh

CLI_SRC="${CLI_SRC:-$_REPO_ROOT/client/cli/xpair}"
run_doctor() {  # $1 = what the stubbed ssh should echo (on|off)
  printf '#!/bin/bash\necho %s\n' "$1" > "$MOCKBIN/ssh"; chmod +x "$MOCKBIN/ssh"
  RP_OUT="$(PATH="$MOCKBIN:$PATH" RP_DIR="$RP_DIR" HOME="$HOME" bash "$CLI_SRC" doctor 2>&1)"
}

# ── mount-method mapping + host File Sharing OFF → doctor surfaces the cause + guidance ──
new_sandbox
mkdir -p "$SBX/proj"
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS=%s::/host/proj\nFOLDER_MAP_MODES=%s::mount\nSYNC_BACKEND=mount\nMOUNT_BACKEND=smb\n' "$SBX/proj" "$SBX/proj" > "$RP_CLIENT_DIR/client.env"
run_doctor off
it "doctor_smb/off-surfaced"
assert_contains "$RP_OUT" "host File Sharing" "doctor reports host File Sharing for a mount mapping"
assert_contains "$RP_OUT" "OFF" "File Sharing OFF is surfaced as the cause"

# ── same mapping, File Sharing ON → reported as connectable ──
run_doctor on
it "doctor_smb/on-reported"
assert_contains "$RP_OUT" "on (SMB mounts can connect)" "File Sharing ON reported"
cleanup_sandbox

# ── sync-only setup (no mount mapping) → NO SMB gate/line at all ──
new_sandbox
mkdir -p "$SBX/syncproj"
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS=%s::/host/s\nFOLDER_MAP_MODES=%s::sync\nSYNC_BACKEND=syncthing\n' "$SBX/syncproj" "$SBX/syncproj" > "$RP_CLIENT_DIR/client.env"
run_doctor off
it "doctor_smb/sync-only-no-gate"
assert_absent "$RP_OUT" "host File Sharing" "sync-only setup never triggers an SMB gate"
cleanup_sandbox
