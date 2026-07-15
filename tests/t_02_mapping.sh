#!/usr/bin/env bash
# t_02_mapping — verifies map_to_host path mapping.
# Since map_to_host is an internal function, it is observed indirectly via the
# "cd '<HOST_DIR>'" line in the remote setup script ($SSH_CAPTURE).
#
# NOTE: claude-iterm-launch (the reference) had no path mapping — it assumes identical paths.
#       map_to_host is a new feature of xpair-launch (an intentional divergence).
#       An equivalence comparison test against the reference is unnecessary.
cd "$(dirname "$0")"; . ./lib.sh

# ────────────────────────────────────────────────────────────────────────────
# Scenario 1: FOLDER_MAPS unset → identity (HOST_DIR == PROJECT_DIR)
# ────────────────────────────────────────────────────────────────────────────
SBX_FOLDER_MAPS="" new_sandbox
CLIENT_DIR="$SBX/myproject"
mkdir -p "$CLIENT_DIR"
make_all_mocks
MOCK_DIRCHECK=__YES__ run_launcher "$CLIENT_DIR"

it "mapping/identity-no-maps"
assert_rc "$RP_RC" 0 "no FOLDER_MAPS → remote launch succeeds"
assert_contains "$(cat "$SSH_CAPTURE")" "cd '${CLIENT_DIR}'" \
  "HOST_DIR == CLIENT_DIR (identity mapping)"

cleanup_sandbox

# ────────────────────────────────────────────────────────────────────────────
# Scenario 2: single map clientroot::hostroot → subpath preserved
#   FOLDER_MAPS="$SBX/proj::/host/proj"
#   input: $SBX/proj/sub  →  expected: /host/proj/sub
# ────────────────────────────────────────────────────────────────────────────
# Call new_sandbox only once, then patch client.env directly.
new_sandbox
CLIENT_ROOT="$SBX/proj"
CLIENT_SUBDIR="$CLIENT_ROOT/sub"
mkdir -p "$CLIENT_SUBDIR"
# Inject the mapping into client.env (overwrites the FOLDER_MAPS="" written by new_sandbox)
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS=%s::/host/proj\n' "$CLIENT_ROOT" > "$RP_CLIENT_DIR/client.env"
make_all_mocks
MOCK_DIRCHECK=__YES__ run_launcher "$CLIENT_SUBDIR"

it "mapping/single-map-subpath"
assert_rc "$RP_RC" 0 "single map → remote launch succeeds"
assert_contains "$(cat "$SSH_CAPTURE")" "cd '/host/proj/sub'" \
  "subpath preserved after prefix substitution → /host/proj/sub"

cleanup_sandbox

# ────────────────────────────────────────────────────────────────────────────
# Scenario 3: longest-prefix wins — two overlapping maps
#   FOLDER_MAPS="$SBX/a::/x;$SBX/a/b::/y"
#   input: $SBX/a/b/c  →  expected: /y/c  (the longer /a/b wins, not the shorter /a)
# ────────────────────────────────────────────────────────────────────────────
new_sandbox
NESTED_DIR="$SBX/a/b/c"
mkdir -p "$NESTED_DIR"
# FOLDER_MAPS contains a semicolon — wrapped in quotes so the shell does not interpret ; as a command separator
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS="%s/a::/x;%s/a/b::/y"\n' "$SBX" "$SBX" > "$RP_CLIENT_DIR/client.env"
make_all_mocks
MOCK_DIRCHECK=__YES__ run_launcher "$NESTED_DIR"

it "mapping/longest-prefix-wins"
assert_rc "$RP_RC" 0 "longest-prefix → remote launch succeeds"
assert_contains "$(cat "$SSH_CAPTURE")" "cd '/y/c'" \
  "longer prefix $SBX/a/b::/y beats shorter $SBX/a::/x → /y/c"

cleanup_sandbox

# ────────────────────────────────────────────────────────────────────────────
# Scenario 4: an entry without '::' is an identity mapping (host == client)
#   FOLDER_MAPS="$SBX/plain" (no separator)
#   input: $SBX/plain  →  expected: $SBX/plain (identical path)
# ────────────────────────────────────────────────────────────────────────────
new_sandbox
PLAIN_DIR="$SBX/plain"
mkdir -p "$PLAIN_DIR"
printf 'REMOTE_HOST=test-host\nFOLDER_MAPS=%s\n' "$PLAIN_DIR" > "$RP_CLIENT_DIR/client.env"
make_all_mocks
MOCK_DIRCHECK=__YES__ run_launcher "$PLAIN_DIR"

it "mapping/no-separator-identity"
assert_rc "$RP_RC" 0 "entry without '::' → remote launch succeeds"
assert_contains "$(cat "$SSH_CAPTURE")" "cd '${PLAIN_DIR}'" \
  "entry without '::' is identity → HOST_DIR == CLIENT_DIR"

cleanup_sandbox

finish
