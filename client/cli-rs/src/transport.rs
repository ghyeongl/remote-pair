//! The transport seam.
//!
//! All host interaction goes through [`Transport`] so the CLI's logic (path mapping, session
//! naming, attach decisions, onboarding) is testable without a real macOS host. The real impl
//! (P2) spawns native OpenSSH `ssh.exe`; tests use [`MockTransport`], which records the exact
//! argv it was asked to run — mirroring the bash `tests/lib.sh` MOCKLOG argv-capture approach.

use std::cell::RefCell;
use std::io;
use std::process::{Command, Stdio};

/// Run `command`, capturing stdout, discarding stderr, with stdin closed.
///
/// Returns `(process exit code, captured stdout)`; the code is `None` only when the
/// child was killed without a code (rare), so callers keep their own fallback.
///
/// Why this exists: on Windows, Win32 OpenSSH's `ssh.exe` does **not** terminate when
/// its stdout is an anonymous pipe — which is exactly what `Command::output()` hands it.
/// The remote command finishes but `ssh.exe` stays alive holding the pipe, so `.output()`
/// blocks forever (observed: `xpair ls`/`doctor`/`launch` hanging >20s). Redirecting
/// stdout to a temp file instead makes `ssh.exe` exit promptly (observed: ~0.1s). On Unix
/// `.output()` is correct and avoids the temp-file round-trip.
pub fn capture_stdout(mut command: Command) -> io::Result<(Option<i32>, String)> {
    command.stdin(Stdio::null()).stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        // Unique per call so concurrent ssh_exec's don't clobber each other's capture.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp =
            std::env::temp_dir().join(format!("xpair-ssh-{}-{}.out", std::process::id(), seq));
        let file = std::fs::File::create(&tmp)?;
        let status = command.stdout(file).status()?;
        let stdout = std::fs::read_to_string(&tmp).unwrap_or_default();
        let _ = std::fs::remove_file(&tmp);
        Ok((status.code(), stdout))
    }

    #[cfg(not(windows))]
    {
        let out = command.output()?;
        Ok((
            out.status.code(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        ))
    }
}

/// Result of running a remote command: process exit code + captured stdout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
}

/// Result of an auth-sensitive SSH command where stderr matters for recovery codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Abstraction over "run things against the host". P0 defines `ssh_exec`; `attach`, `reach`,
/// and `dir_check` are added in P2 as the launch/attach path is ported.
pub trait Transport {
    /// Run `remote_cmd` (already a POSIX-safe payload — see [`crate::remote_quote`]) on `host`.
    fn ssh_exec(&self, host: &str, remote_cmd: &str) -> std::io::Result<Output>;

    /// Run the one password-bootstrap auth probe. Implementors that do not need special
    /// auth handling can fall back to `ssh_exec`.
    fn ssh_auth_probe(&self, host: &str, remote_cmd: &str) -> std::io::Result<AuthOutput> {
        self.ssh_exec(host, remote_cmd).map(|out| AuthOutput {
            code: out.code,
            stdout: out.stdout,
            stderr: String::new(),
        })
    }

    /// Retire one-shot password wiring after the bootstrap auth succeeds.
    fn retire_password_auth(&self) {}

    /// Best-effort cleanup hook for transports that opened a ControlMaster.
    fn cleanup(&self, _host: &str) {}
}

/// A record of one transport call, for assertions in tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub host: String,
    pub remote_cmd: String,
}

/// Test transport: returns canned [`Output`]s and records every call's argv.
#[derive(Default)]
pub struct MockTransport {
    calls: RefCell<Vec<Call>>,
    responses: RefCell<Vec<Output>>,
}

impl MockTransport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue a canned response (FIFO). When exhausted, `ssh_exec` returns `(0, "")`.
    pub fn push_response(&self, code: i32, stdout: &str) {
        self.responses.borrow_mut().push(Output {
            code,
            stdout: stdout.to_string(),
        });
    }

    /// The calls recorded so far, in order.
    pub fn calls(&self) -> Vec<Call> {
        self.calls.borrow().clone()
    }
}

impl Transport for MockTransport {
    fn ssh_exec(&self, host: &str, remote_cmd: &str) -> std::io::Result<Output> {
        self.calls.borrow_mut().push(Call {
            host: host.to_string(),
            remote_cmd: remote_cmd.to_string(),
        });
        let mut resp = self.responses.borrow_mut();
        Ok(if resp.is_empty() {
            Output {
                code: 0,
                stdout: String::new(),
            }
        } else {
            resp.remove(0)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_records_calls_and_returns_canned_output() {
        let t = MockTransport::new();
        t.push_response(0, "session-exists");
        let out = t
            .ssh_exec("host.local", "'tmux-aqua' 'has-session'")
            .unwrap();
        assert_eq!(
            out,
            Output {
                code: 0,
                stdout: "session-exists".into()
            }
        );
        let calls = t.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].host, "host.local");
        assert_eq!(calls[0].remote_cmd, "'tmux-aqua' 'has-session'");
    }

    #[cfg(unix)]
    #[test]
    fn capture_stdout_reads_child_output() {
        let mut c = Command::new("echo");
        c.arg("hello");
        let (code, out) = capture_stdout(c).unwrap();
        assert_eq!(code, Some(0));
        assert_eq!(out.trim(), "hello");
    }

    #[cfg(windows)]
    #[test]
    fn capture_stdout_reads_child_output_via_tempfile() {
        let mut c = Command::new("cmd");
        c.args(["/c", "echo hello"]);
        let (code, out) = capture_stdout(c).unwrap();
        assert_eq!(code, Some(0));
        assert_eq!(out.trim(), "hello");
    }

    #[test]
    fn mock_defaults_to_zero_when_responses_exhausted() {
        let t = MockTransport::new();
        let out = t.ssh_exec("h", "echo hi").unwrap();
        assert_eq!(
            out,
            Output {
                code: 0,
                stdout: String::new()
            }
        );
    }
}
