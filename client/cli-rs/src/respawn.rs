//! Host-side respawn script templates for `xpair launch`.
//!
//! These bodies are emitted by the Rust client and executed by POSIX bash on the host.

use crate::remote_quote;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Claude,
    Shell,
    Codex,
    Opencode,
    Unknown,
}

impl Engine {
    pub fn from_canonical(engine: &str) -> Self {
        match engine {
            "claude" => Self::Claude,
            "shell" => Self::Shell,
            "codex" => Self::Codex,
            "opencode" => Self::Opencode,
            _ => Self::Unknown,
        }
    }

    pub fn command_name(self) -> &'static str {
        match self {
            Self::Claude | Self::Unknown => "claude",
            Self::Shell => "shell",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }
}

const SHELL_RESPAWN: &str = r#"trap 'kill -- -$$ 2>/dev/null' EXIT

SHELL_BIN="${SHELL:-/bin/zsh}"
[ -x "$SHELL_BIN" ] || SHELL_BIN="/bin/bash"
exec "$SHELL_BIN" -l
"#;

const CLAUDE_RESPAWN: &str = r#"# Clean up claude child processes when tmux/bash exits — bash has huponexit OFF by default,
# so children don't receive SIGHUP on normal exit and claude may survive as an orphan (reparented to init).
# EXIT trap kills the entire process group → prevents accumulation of orphan claude --remote-control instances.
trap 'kill -- -$$ 2>/dev/null' EXIT

# RC = CLAUDE_WARP_RC (injected by launcher). Fallback computed only if env is missing.
RC="${CLAUDE_WARP_RC:-$(hostname -s)_$(basename "$PWD")}"
RC="${RC//[.:]/_}"
export CLAUDE_WARP_RC="$RC"
# Resume STRICTLY by the REAL session id that claude itself used — recorded by the Stop hook at
# ~/.claude/.git/last-session/<sha16(cwd)> (claude's actual id, even under --remote-control). On any
# miss → brand-NEW conversation. We NEVER use `claude --continue`.
#
# ⚠ Why NOT `claude --continue`: it is NOT id-based — it resumes "the most recent conversation in this
# cwd", and claude encodes cwd → project-dir by replacing every non-[A-Za-z0-9] char (incl. ALL
# non-ASCII, e.g. Korean) with '-'. Folders differing only by non-ASCII segments collapse to the SAME
# project dir, so --continue pulls a *sibling project's* transcript → cross-session pollution
# (two differently-named sessions sharing one conversation). Resuming the exact recorded id avoids this;
# on a miss we start blank rather than risk grabbing the wrong project's conversation.
_LSD="$HOME/.claude/.git/last-session"
_K="$(printf '%s' "$PWD" | shasum -a 256 | cut -c1-16)"
_rplog="$HOME/.xpair/host/logs/xpair.log"; mkdir -p "$(dirname "$_rplog")" 2>/dev/null
while :; do
  # Re-read inside the loop so a crash-respawn picks up the latest recorded id.
  RESUME_SID=""
  [ "${CL_CONTINUE:-0}" = 1 ] && [ -f "$_LSD/$_K" ] && RESUME_SID="$(cat "$_LSD/$_K" 2>/dev/null | head -1)"
  if [ -n "$RESUME_SID" ]; then
    printf '%s SESSION: resume %s (rc=%s)\n' "$(date '+%FT%T%z')" "$RESUME_SID" "$RC" >> "$_rplog" 2>/dev/null || true
    # If the recorded id is stale/unresumable → NEW blank (never --continue: would grab a colliding transcript).
    claude --dangerously-skip-permissions --resume "$RESUME_SID" --remote-control "$RC" || claude --dangerously-skip-permissions --remote-control "$RC"
  else
    [ "${CL_CONTINUE:-0}" = 1 ] && printf '%s SESSION: new blank (no recorded id, key=%s, rc=%s)\n' "$(date '+%FT%T%z')" "$_K" "$RC" >> "$_rplog" 2>/dev/null || true
    claude --dangerously-skip-permissions --remote-control "$RC"
  fi
  [ $? -eq 0 ] && break
  printf '\n[claude crashed — restarting in 3s, Ctrl+C to abort]\n'
  sleep 3 || break
done
"#;

const CODEX_RESPAWN: &str = r#"# Reap codex children when tmux/bash exits — bash has huponexit OFF by default, so without this
# the EXIT trap (process-group kill) the agent CLI could survive as an orphan reparented to init.
trap 'kill -- -$$ 2>/dev/null' EXIT

# codex must be present on the host (resolved on the host, not the client).
command -v codex >/dev/null 2>&1 || {
  printf '\n[codex not found on host — install it with the native Codex installer or use --engine claude]\n' >&2
  exit 11
}
while :; do
  codex --dangerously-bypass-approvals-and-sandbox
  [ $? -eq 0 ] && break
  printf '\n[codex crashed — restarting in 3s, Ctrl+C to abort]\n'
  sleep 3 || break
done
"#;

const OPENCODE_RESPAWN: &str = r#"# Reap opencode children when tmux/bash exits — bash has huponexit OFF by default, so without this
# EXIT trap (process-group kill) the agent CLI could survive as an orphan reparented to init.
trap 'kill -- -$$ 2>/dev/null' EXIT

# opencode must be present on the host (resolved on the host, not the client).
command -v opencode >/dev/null 2>&1 || {
  printf '\n[opencode not found on host — install it with the native OpenCode installer or use --engine claude]\n' >&2
  exit 11
}
# Auto-approve via inline config merge (TUI has no skip-permissions flag). Merges with existing config.
export OPENCODE_CONFIG_CONTENT='{"permission":{"edit":"allow","bash":"allow","webfetch":"allow"}}'
while :; do
  opencode
  [ $? -eq 0 ] && break
  printf '\n[opencode crashed — restarting in 3s, Ctrl+C to abort]\n'
  sleep 3 || break
done
"#;

pub fn respawn_body(engine: Engine) -> &'static str {
    match engine {
        Engine::Shell => SHELL_RESPAWN,
        Engine::Codex => CODEX_RESPAWN,
        Engine::Opencode => OPENCODE_RESPAWN,
        Engine::Claude | Engine::Unknown => CLAUDE_RESPAWN,
    }
}

pub fn build_respawn_script(engine: Engine, rc: &str, cl_continue: bool) -> String {
    format!(
        "export CLAUDE_WARP_RC={}\nexport CL_CONTINUE={}\n{}",
        remote_quote::posix_single_quote(rc),
        u8::from(cl_continue),
        respawn_body(engine)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED_SHELL: &str = r#"trap 'kill -- -$$ 2>/dev/null' EXIT

SHELL_BIN="${SHELL:-/bin/zsh}"
[ -x "$SHELL_BIN" ] || SHELL_BIN="/bin/bash"
exec "$SHELL_BIN" -l
"#;

    const EXPECTED_CLAUDE: &str = r#"# Clean up claude child processes when tmux/bash exits — bash has huponexit OFF by default,
# so children don't receive SIGHUP on normal exit and claude may survive as an orphan (reparented to init).
# EXIT trap kills the entire process group → prevents accumulation of orphan claude --remote-control instances.
trap 'kill -- -$$ 2>/dev/null' EXIT

# RC = CLAUDE_WARP_RC (injected by launcher). Fallback computed only if env is missing.
RC="${CLAUDE_WARP_RC:-$(hostname -s)_$(basename "$PWD")}"
RC="${RC//[.:]/_}"
export CLAUDE_WARP_RC="$RC"
# Resume STRICTLY by the REAL session id that claude itself used — recorded by the Stop hook at
# ~/.claude/.git/last-session/<sha16(cwd)> (claude's actual id, even under --remote-control). On any
# miss → brand-NEW conversation. We NEVER use `claude --continue`.
#
# ⚠ Why NOT `claude --continue`: it is NOT id-based — it resumes "the most recent conversation in this
# cwd", and claude encodes cwd → project-dir by replacing every non-[A-Za-z0-9] char (incl. ALL
# non-ASCII, e.g. Korean) with '-'. Folders differing only by non-ASCII segments collapse to the SAME
# project dir, so --continue pulls a *sibling project's* transcript → cross-session pollution
# (two differently-named sessions sharing one conversation). Resuming the exact recorded id avoids this;
# on a miss we start blank rather than risk grabbing the wrong project's conversation.
_LSD="$HOME/.claude/.git/last-session"
_K="$(printf '%s' "$PWD" | shasum -a 256 | cut -c1-16)"
_rplog="$HOME/.xpair/host/logs/xpair.log"; mkdir -p "$(dirname "$_rplog")" 2>/dev/null
while :; do
  # Re-read inside the loop so a crash-respawn picks up the latest recorded id.
  RESUME_SID=""
  [ "${CL_CONTINUE:-0}" = 1 ] && [ -f "$_LSD/$_K" ] && RESUME_SID="$(cat "$_LSD/$_K" 2>/dev/null | head -1)"
  if [ -n "$RESUME_SID" ]; then
    printf '%s SESSION: resume %s (rc=%s)\n' "$(date '+%FT%T%z')" "$RESUME_SID" "$RC" >> "$_rplog" 2>/dev/null || true
    # If the recorded id is stale/unresumable → NEW blank (never --continue: would grab a colliding transcript).
    claude --dangerously-skip-permissions --resume "$RESUME_SID" --remote-control "$RC" || claude --dangerously-skip-permissions --remote-control "$RC"
  else
    [ "${CL_CONTINUE:-0}" = 1 ] && printf '%s SESSION: new blank (no recorded id, key=%s, rc=%s)\n' "$(date '+%FT%T%z')" "$_K" "$RC" >> "$_rplog" 2>/dev/null || true
    claude --dangerously-skip-permissions --remote-control "$RC"
  fi
  [ $? -eq 0 ] && break
  printf '\n[claude crashed — restarting in 3s, Ctrl+C to abort]\n'
  sleep 3 || break
done
"#;

    const EXPECTED_CODEX: &str = r#"# Reap codex children when tmux/bash exits — bash has huponexit OFF by default, so without this
# the EXIT trap (process-group kill) the agent CLI could survive as an orphan reparented to init.
trap 'kill -- -$$ 2>/dev/null' EXIT

# codex must be present on the host (resolved on the host, not the client).
command -v codex >/dev/null 2>&1 || {
  printf '\n[codex not found on host — install it with the native Codex installer or use --engine claude]\n' >&2
  exit 11
}
while :; do
  codex --dangerously-bypass-approvals-and-sandbox
  [ $? -eq 0 ] && break
  printf '\n[codex crashed — restarting in 3s, Ctrl+C to abort]\n'
  sleep 3 || break
done
"#;

    const EXPECTED_OPENCODE: &str = r#"# Reap opencode children when tmux/bash exits — bash has huponexit OFF by default, so without this
# EXIT trap (process-group kill) the agent CLI could survive as an orphan reparented to init.
trap 'kill -- -$$ 2>/dev/null' EXIT

# opencode must be present on the host (resolved on the host, not the client).
command -v opencode >/dev/null 2>&1 || {
  printf '\n[opencode not found on host — install it with the native OpenCode installer or use --engine claude]\n' >&2
  exit 11
}
# Auto-approve via inline config merge (TUI has no skip-permissions flag). Merges with existing config.
export OPENCODE_CONFIG_CONTENT='{"permission":{"edit":"allow","bash":"allow","webfetch":"allow"}}'
while :; do
  opencode
  [ $? -eq 0 ] && break
  printf '\n[opencode crashed — restarting in 3s, Ctrl+C to abort]\n'
  sleep 3 || break
done
"#;

    #[test]
    fn returns_the_verbatim_body_for_each_engine() {
        assert_eq!(respawn_body(Engine::Claude), EXPECTED_CLAUDE);
        assert_eq!(respawn_body(Engine::Shell), EXPECTED_SHELL);
        assert_eq!(respawn_body(Engine::Codex), EXPECTED_CODEX);
        assert_eq!(respawn_body(Engine::Opencode), EXPECTED_OPENCODE);
        assert_eq!(respawn_body(Engine::Unknown), EXPECTED_CLAUDE);
    }

    #[test]
    fn builds_claude_respawn_script_with_exact_exports() {
        assert_eq!(
            build_respawn_script(Engine::Claude, "mac project_1", true),
            format!(
                "export CLAUDE_WARP_RC='mac project_1'\nexport CL_CONTINUE=1\n{}",
                EXPECTED_CLAUDE
            )
        );
        assert_eq!(
            build_respawn_script(Engine::Claude, "mac project_1", false),
            format!(
                "export CLAUDE_WARP_RC='mac project_1'\nexport CL_CONTINUE=0\n{}",
                EXPECTED_CLAUDE
            )
        );
    }

    #[test]
    fn builds_respawn_script_for_each_non_claude_engine() {
        assert_eq!(
            build_respawn_script(Engine::Shell, "mac'project_1", true),
            format!(
                "export CLAUDE_WARP_RC='mac'\\''project_1'\nexport CL_CONTINUE=1\n{}",
                EXPECTED_SHELL
            )
        );
        assert_eq!(
            build_respawn_script(Engine::Codex, "mac_project_1", false),
            format!(
                "export CLAUDE_WARP_RC='mac_project_1'\nexport CL_CONTINUE=0\n{}",
                EXPECTED_CODEX
            )
        );
        assert_eq!(
            build_respawn_script(Engine::Opencode, "mac_project_1", false),
            format!(
                "export CLAUDE_WARP_RC='mac_project_1'\nexport CL_CONTINUE=0\n{}",
                EXPECTED_OPENCODE
            )
        );
    }
}
