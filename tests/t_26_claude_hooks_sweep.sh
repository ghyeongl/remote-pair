#!/usr/bin/env bash
# t_26_claude_hooks_sweep — manage-claude-hooks.py `sweep` purges ALL xpair hook entries from
# settings.json while preserving non-xpair hooks + other keys; and the host uninstaller invokes it.
cd "$(dirname "$0")"; . ./lib.sh

MGR="$_REPO_ROOT/host/hooks/manage-claude-hooks.py"

# ── Part A: sweep unit on a rich fixture ──────────────────────────────────────
TMP="$(mktemp -d -t rphooks.XXXXXX)"
S="$TMP/settings.json"
# Mix: xpair-notify (6 events) + xpair-approve-reminder (2 events) + non-xpair hooks that MUST
# survive (gstack, oh-my-claudecode, claude-notify, legacy remote-pair-notify.sh) + non-hooks keys.
# Several entries share an event (Stop) to prove per-entry filtering, not per-event deletion.
cat > "$S" <<'JSON'
{
  "model": "sonnet",
  "permissions": { "allow": [] },
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "/root/.xpair/host/bin/xpair-notify.sh Stop" } ] },
      { "hooks": [ { "type": "command", "command": "/root/.gstack/hooks/gstack-stop.sh" } ] },
      { "hooks": [ { "type": "command", "command": "/root/.remote-pair/remote-pair-notify.sh Stop" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command", "command": "/root/.xpair/host/bin/xpair-notify.sh Notification" } ] },
      { "hooks": [ { "type": "command", "command": "/root/.claude/hooks/claude-notify.sh" } ] }
    ],
    "SubagentStop": [
      { "hooks": [ { "type": "command", "command": "/root/.xpair/host/bin/xpair-notify.sh SubagentStop" } ] }
    ],
    "PermissionRequest": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/root/.xpair/host/bin/xpair-notify.sh PermissionRequest" } ] }
    ],
    "PermissionDenied": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/root/.claude/hooks/xpair-approve-reminder.sh PermissionDenied" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/root/.xpair/host/bin/xpair-notify.sh PermissionDenied" } ] }
    ],
    "PostToolUseFailure": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/root/.claude/hooks/xpair-approve-reminder.sh PostToolUseFailure" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/root/.xpair/host/bin/xpair-notify.sh PostToolUseFailure" } ] },
      { "hooks": [ { "type": "command", "command": "/root/.oh-my-claudecode/hooks/omc.sh" } ] }
    ]
  }
}
JSON

out="$(python3 "$MGR" sweep "$S" 2>&1)"; rc=$?
body="$(cat "$S")"

it "sweep/rc-zero"
assert_rc "$rc" 0 "sweep exits 0 :: out=[$out]"

it "sweep/removes-all-xpair"
assert_absent "$body" "xpair-notify.sh" "no orphaned notify hook remains"
assert_absent "$body" "xpair-approve-reminder.sh" "no orphaned approve-reminder hook remains"

it "sweep/preserves-non-xpair"
assert_contains "$body" "gstack-stop.sh" "gstack hook preserved"
assert_contains "$body" "oh-my-claudecode" "omc hook preserved"
assert_contains "$body" "claude-notify.sh" "claude-notify hook preserved"
assert_contains "$body" "remote-pair-notify.sh" "legacy remote-pair hook preserved (not matched by xpair markers)"

it "sweep/preserves-other-keys"
assert_contains "$body" "\"model\"" "top-level model key preserved"
assert_contains "$body" "\"permissions\"" "top-level permissions key preserved"

it "sweep/valid-json"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$S" 2>/dev/null
assert_rc "$?" 0 "result is valid JSON"

it "sweep/idempotent"
before="$(cat "$S")"
out2="$(python3 "$MGR" sweep "$S" 2>&1)"; rc2=$?
after="$(cat "$S")"
assert_rc "$rc2" 0 "second sweep exits 0 :: out=[$out2]"
[ "$before" = "$after" ] && _pass "second sweep is a byte-identical no-op" || _fail "second sweep changed the file"

rm -rf "$TMP"

# ── Part B: uninstall wiring (host uninstaller invokes the sweep) ──────────────
new_sandbox
mkdir -p "$HOME/.claude/hooks" "$HOME/.xpair/host/bin"
cat > "$HOME/.claude/settings.json" <<'JSON'
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "$HOME/.xpair/host/bin/xpair-notify.sh Stop" } ] } ] } }
JSON
cp "$_REPO_ROOT/host/hooks/manage-claude-hooks.py" "$HOME/.xpair/host/bin/manage-claude-hooks.py"
printf 'host\n' > "$HOME/.xpair/host/role"
printf 'HOST_ONLY=1\n' > "$HOME/.xpair/host/host.env"

RP_OUT="$(HOME="$HOME" bash "$_REPO_ROOT/host/uninstall-host.sh" -y --dry-run --force 2>"$RP_ERRFILE")"; RP_RC=$?
RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"

it "uninstall/invokes-sweep"
assert_rc "$RP_RC" 0 "host uninstall dry-run rc=0 :: stderr=[$RP_ERR]"
assert_contains "$RP_OUT" "sweep" "uninstall invokes the hook sweep"
assert_contains "$RP_OUT" "settings.json" "sweep targets settings.json"
cleanup_sandbox

finish
