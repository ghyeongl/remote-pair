#!/usr/bin/env bash
# t_11_engine — verifies agent engine selection and respawn dispatch.
cd "$(dirname "$0")"; . ./lib.sh

CLI_SRC="${CLI_SRC:-$_REPO_ROOT/client/cli/xpair}"

run_cli() {
  RP_OUT="$(PATH="$MOCKBIN:$PATH" RP_DIR="$RP_DIR" HOME="$HOME" bash "$CLI_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
  MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
}

extract_respawn() {
  printf '%s\n' "$MLOG" | awk -F'|' '
    /new-session/ {
      for (i=1;i<=NF;i++) if ($i ~ /^bash /) { sub(/^bash /, "", $i); print $i; exit }
    }
    /^tmux\|new\|-s\|/ {
      for (i=1;i<=NF;i++) if ($i ~ /^bash /) { sub(/^bash /, "", $i); print $i; exit }
    }'
}

extract_remote_respawn_body() {
  local b64
  b64="$(grep "^RESPAWN_B64='" "$SSH_CAPTURE" | sed "s/^RESPAWN_B64='//;s/'$//")"
  printf '%s' "$b64" | base64 -d 2>/dev/null
}

# ────────────────────────────────────────────────────────────
# Scenario 1: --engine codex writes a Codex respawn body.
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude codex opencode tailscale hangul-romanize launchctl open tput
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher --engine codex "$SBX"
BODY1="$(extract_remote_respawn_body)"

it "engine/codex-respawn"
assert_rc "$RP_RC" 0 "codex remote launch succeeds"
assert_contains "$BODY1" "command -v codex" "codex availability check is injected"
assert_contains "$BODY1" "codex --dangerously-bypass-approvals-and-sandbox" "codex command is injected"
assert_absent "$BODY1" "claude --dangerously-skip-permissions" "claude command is not injected"
cleanup_sandbox

# ────────────────────────────────────────────────────────────
# Scenario 2: --engine opencode writes an OpenCode respawn body.
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude codex opencode tailscale hangul-romanize launchctl open tput
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher --engine opencode "$SBX"
BODY2="$(extract_remote_respawn_body)"

it "engine/opencode-respawn"
assert_rc "$RP_RC" 0 "opencode remote launch succeeds"
assert_contains "$BODY2" "command -v opencode" "opencode availability check is injected"
assert_contains "$BODY2" "OPENCODE_CONFIG_CONTENT" "opencode auto-approve config is injected"
assert_contains "$BODY2" "opencode --continue" "opencode continue command is injected"
assert_absent "$BODY2" "claude --dangerously-skip-permissions" "claude command is not injected"
cleanup_sandbox

# ────────────────────────────────────────────────────────────
# Scenario 3: claudecode alias canonicalizes to Claude Code.
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude codex opencode tailscale hangul-romanize launchctl open tput
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher --engine claudecode "$SBX"
BODY3="$(extract_remote_respawn_body)"

it "engine/claudecode-alias"
assert_rc "$RP_RC" 0 "claudecode alias remote launch succeeds"
assert_contains "$BODY3" "claude --dangerously-skip-permissions" "claudecode alias dispatches to claude"
cleanup_sandbox

# ────────────────────────────────────────────────────────────
# Scenario 4: remote setup checks the selected engine on the host.
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude codex opencode tailscale hangul-romanize launchctl open tput
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher --engine opencode "$SBX"
SSH_SCRIPT="$(cat "$SSH_CAPTURE" 2>/dev/null)"

it "engine/remote-opencode-check"
assert_rc "$RP_RC" 0 "opencode remote launch setup succeeds"
assert_contains "$SSH_SCRIPT" "command -v opencode" "remote setup checks opencode, not claude"
assert_absent "$SSH_SCRIPT" "command -v claude" "remote setup does not hardcode claude availability"
cleanup_sandbox

# ────────────────────────────────────────────────────────────
# Scenario 5: xpair launch canonicalizes claudecode and passes explicit engine env.
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude codex opencode tailscale hangul-romanize launchctl open tput
cat > "$RP_CLIENT_DIR/bin/xpair-launch" <<'EOF'
#!/bin/bash
printf 'engine=%s explicit=%s args=%s\n' "${RP_ENGINE:-}" "${RP_ENGINE_EXPLICIT:-}" "$*" >> "$MOCKLOG"
EOF
chmod +x "$RP_CLIENT_DIR/bin/xpair-launch"
# Unmapped dir + --yes on the uniform host path must still reach the launcher (regression:
# mapping_for_dir returns non-zero for an unmapped dir; under set -e that used to abort rc 1).
run_cli launch --engine claudecode --yes "$SBX"

it "engine/xpair-launch-claudecode-alias"
assert_rc "$RP_RC" 0 "unmapped --yes launch reaches the launcher (no silent set -e abort)"
assert_rc "$RP_RC" 0 "xpair launch claudecode alias succeeds"
assert_contains "$MLOG" "engine=claude explicit=1" "xpair passes canonical claude engine explicitly"
assert_contains "$MLOG" "--yes" "xpair preserves supported launch flags"
assert_absent "$MLOG" "--local" "xpair does not pass removed local flag"
cleanup_sandbox

# ────────────────────────────────────────────────────────────
# Scenario 6: xpair config set engine accepts claudecode alias and stores claude.
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks ssh mosh tmux tmux-aqua claude codex opencode tailscale hangul-romanize launchctl open tput
run_cli config set engine claudecode
CFG6="$(cat "$RP_CLIENT_DIR/client.env" 2>/dev/null)"
run_cli config get engine

it "engine/xpair-config-claudecode-alias"
assert_rc "$RP_RC" 0 "xpair config get engine succeeds after claudecode set"
assert_contains "$CFG6" "ENGINE=claude" "config stores canonical claude engine"
assert_eq "$RP_OUT" "claude" "config get returns canonical claude engine"
cleanup_sandbox

finish
