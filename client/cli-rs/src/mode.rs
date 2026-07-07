//! Mode command (`xpair mode`).
//!
//! Legacy native-client helper retained for tests and embedders. The current bash CLI no
//! longer exposes an `xpair mode` dispatch entry.

use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

use crate::{config, session};

const ENABLED_MESSAGE: &str =
    "local mode enabled — launch/attach will use local only until the host is reachable again";
const CLEARED_MESSAGE: &str = "local mode cleared";

/// Return the bash `mode_label()` string for resolved mode inputs.
pub fn mode_label(local_mode: bool, host: &str) -> String {
    if local_mode {
        "local (transient)".to_string()
    } else if !host.is_empty() {
        "auto (remote)".to_string()
    } else {
        "auto (local)".to_string()
    }
}

/// Run `xpair mode [status|local|auto]` against an explicit client env path.
pub fn run(args: &[String], path: impl AsRef<Path>) -> ExitCode {
    let result = {
        let stdout = io::stdout();
        let stderr = io::stderr();
        let mut stdout = stdout.lock();
        let mut stderr = stderr.lock();
        run_with_writers(args, path.as_ref(), &mut stdout, &mut stderr)
    };

    match result {
        Ok(code) => ExitCode::from(code),
        Err(err) => {
            eprintln!("xpair mode: {err}");
            ExitCode::from(1)
        }
    }
}

fn run_with_writers(
    args: &[String],
    path: &Path,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> io::Result<u8> {
    match args.first().map(String::as_str).unwrap_or("status") {
        "status" | "" => {
            let host = resolve_host(path)?;
            let local_mode = resolve_local_mode(path)?;
            writeln!(stdout, "Xpair mode")?;
            writeln!(stdout, "{:<12} {}", "mode", mode_label(local_mode, &host))?;
            writeln!(
                stdout,
                "{:<12} {}",
                "host",
                if host.is_empty() { "(none)" } else { &host }
            )?;
            Ok(0)
        }
        "local" => {
            config::set(path, "LOCAL_MODE", "1")?;
            writeln!(stdout, "{ENABLED_MESSAGE}")?;
            Ok(0)
        }
        "auto" | "remote" | "off" => {
            config::set(path, "LOCAL_MODE", "0")?;
            writeln!(stdout, "{CLEARED_MESSAGE}")?;
            Ok(0)
        }
        _ => {
            writeln!(stderr, "mode [status|local|auto]")?;
            Ok(2)
        }
    }
}

fn resolve_host(path: &Path) -> io::Result<String> {
    if let Some(host) = non_empty_env("REMOTE_HOST") {
        return Ok(host);
    }
    config::get_cli(path, "host")
}

fn resolve_local_mode(path: &Path) -> io::Result<bool> {
    if let Ok(value) = std::env::var("LOCAL_MODE") {
        return Ok(session::local_mode_on_value(&value));
    }
    Ok(config::get(path, "LOCAL_MODE")?
        .as_deref()
        .is_some_and(session::local_mode_on_value))
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestPath {
        path: PathBuf,
    }

    impl TestPath {
        fn new(name: &str) -> TestPath {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "xpair-mode-test-{}-{nonce}-{id}-{name}.env",
                std::process::id()
            ));
            let _ = fs::remove_file(&path);
            TestPath { path }
        }
    }

    impl Drop for TestPath {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    fn run_for_test(args: &[&str], path: &Path) -> (u8, String, String) {
        let args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run_with_writers(&args, path, &mut stdout, &mut stderr).unwrap();
        (
            code,
            String::from_utf8(stdout).unwrap(),
            String::from_utf8(stderr).unwrap(),
        )
    }

    #[test]
    fn mode_label_reports_local_transient_when_local_mode_is_on() {
        assert_eq!(mode_label(true, "test-host"), "local (transient)");
    }

    #[test]
    fn mode_label_reports_auto_remote_when_host_is_set() {
        assert_eq!(mode_label(false, "test-host"), "auto (remote)");
    }

    #[test]
    fn mode_label_reports_auto_local_without_host() {
        assert_eq!(mode_label(false, ""), "auto (local)");
    }

    #[test]
    fn local_persists_local_mode_one() {
        let tmp = TestPath::new("local");

        let (code, stdout, stderr) = run_for_test(&["local"], &tmp.path);

        assert_eq!(code, 0);
        assert_eq!(stdout, format!("{ENABLED_MESSAGE}\n"));
        assert!(stderr.is_empty());
        assert_eq!(
            config::get(&tmp.path, "LOCAL_MODE").unwrap(),
            Some("1".to_string())
        );
    }

    #[test]
    fn auto_persists_local_mode_zero() {
        let tmp = TestPath::new("auto");

        let (code, stdout, stderr) = run_for_test(&["auto"], &tmp.path);

        assert_eq!(code, 0);
        assert_eq!(stdout, format!("{CLEARED_MESSAGE}\n"));
        assert!(stderr.is_empty());
        assert_eq!(
            config::get(&tmp.path, "LOCAL_MODE").unwrap(),
            Some("0".to_string())
        );
    }

    #[test]
    fn unknown_argument_returns_usage_and_exit_two() {
        let tmp = TestPath::new("unknown");

        let (code, stdout, stderr) = run_for_test(&["bad"], &tmp.path);

        assert_eq!(code, 2);
        assert!(stdout.is_empty());
        assert_eq!(stderr, "mode [status|local|auto]\n");
    }
}
