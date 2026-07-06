#!/usr/bin/env bash
# t_16_map_method — per-mapping access method (FOLDER_MAP_MODES) round-trips through
# `xpair map add … <method>` → `xpair map list --json` ("method" field), survives in
# client.env, falls back to path-convention inference when unrecorded, and is dropped on rm.
cd "$(dirname "$0")"; . ./lib.sh

CLI_SRC="${CLI_SRC:-$_REPO_ROOT/client/cli/xpair}"
run_cli() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" RP_DIR="$RP_DIR" HOME="$HOME" bash "$CLI_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
}
# method recorded in `map list --json` for a given client path
json_method() { RP_JSON="$RP_OUT" python3 - "$1" <<'PY'
import json, os, sys
client = sys.argv[1]
for m in json.loads(os.environ["RP_JSON"]):
    if m.get("client") == client:
        print(m.get("method", "")); break
PY
}

# ── explicit method persists + round-trips (add → list --json) ──
new_sandbox
MNT="$SBX/proj-mount"; SYN="$SBX/proj-sync"; mkdir -p "$MNT" "$SYN"
run_cli map add "$MNT" /host/m mount
run_cli map add "$SYN" /host/s sync
run_cli map list --json

it "map_method/explicit-mount"
assert_eq "$(json_method "$MNT")" "mount" "mount method round-trips to list --json"
it "map_method/explicit-sync"
assert_eq "$(json_method "$SYN")" "sync" "sync method round-trips to list --json"

it "map_method/persisted-in-client-env"
assert_contains "$(cat "$RP_CLIENT_DIR/client.env")" "FOLDER_MAP_MODES=" "FOLDER_MAP_MODES written to client.env"
assert_contains "$(cat "$RP_CLIENT_DIR/client.env")" "$MNT::mount" "mount entry persisted"

# ── invalid method rejected ──
mkdir -p "$SBX/proj-bad"
run_cli map add "$SBX/proj-bad" /host/b weird
it "map_method/invalid-rejected"
assert_rc "$RP_RC" 2 "unknown method → rc 2"

# ── rm drops the method record (falls back to inference) ──
run_cli map rm "$MNT"
run_cli map list --json
it "map_method/rm-clears"
assert_absent "$(cat "$RP_CLIENT_DIR/client.env")" "$MNT::mount" "method record removed on rm"

cleanup_sandbox

# ── inference fallback when FOLDER_MAP_MODES has no record for the entry ──
# A /Volumes clientPath infers mount only when mount(8) shows an smbfs mount from REMOTE_HOST.
new_sandbox
MOUNTSPATH="/Volumes/proj"; PLAIN="$SBX/plainproj"; EXTERNAL="/Volumes/ExternalSSD/proj"; mkdir -p "$PLAIN"
cat > "$MOCKBIN/mount" <<'EOF'
#!/bin/bash
echo '/dev/disk4s1 on /Volumes/ExternalSSD (apfs, local, nodev)'
echo '//alice@test-host/proj on /Volumes/proj (smbfs, nodev, nosuid, mounted by alice)'
EOF
chmod +x "$MOCKBIN/mount"
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS="%s::/host/v;%s::/host/p;%s::/host/e"\nFOLDER_MAP_MODES=\n' "$MOUNTSPATH" "$PLAIN" "$EXTERNAL" > "$RP_CLIENT_DIR/client.env"
run_cli map list --json
it "map_method/infer-remote-smb-volumes"
assert_eq "$(json_method "$MOUNTSPATH")" "mount" "REMOTE_HOST smbfs /Volumes path infers mount"
it "map_method/infer-plain"
assert_eq "$(json_method "$PLAIN")" "sync" "plain path infers sync"
it "map_method/infer-non-smb-volumes-sync"
assert_eq "$(json_method "$EXTERNAL")" "sync" "non-SMB /Volumes path infers sync"

cleanup_sandbox

finish
