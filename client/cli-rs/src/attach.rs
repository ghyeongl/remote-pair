//! Attach an existing tmux-aqua session.
//!
//! Ports the testable core of `cmd_attach()` from `client/cli/xpair:963-1033`.
//! The interactive terminal handoff remains a small process-spawn shim; argument parsing,
//! target selection, SSH argv construction, and remote session probing stay pure/testable.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use crate::config;
use crate::platform::Os;
use crate::remote_quote;
use crate::session::{self, SshTransport};
use crate::transport::Transport;

const USAGE: &str = "attach <session-name>";
const REMOTE_BIN: &str = "$HOME/.local/bin";
const TMUX_AQUA: &str = "tmux-aqua";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachReq {
    pub target_pref: Option<Target>,
    pub session: String,
}

/// Parse `xpair attach` args with the bash exit-code contract.
pub fn parse_attach_args(args: &[String]) -> Result<AttachReq, (String, u8)> {
    let target_pref = None;
    let mut session = None;

    for arg in args {
        match arg.as_str() {
            "-h" | "--help" => return Err((USAGE.to_string(), 0)),
            opt if opt.starts_with("--") => {
                return Err((format!("unknown attach option: {opt}"), 2));
            }
            _ => {
                if session.is_some() {
                    return Err(("attach requires exactly one session name".to_string(), 2));
                }
                session = Some(arg.clone());
            }
        }
    }

    let Some(session) = session else {
        return Err(("attach requires a session name".to_string(), 2));
    };
    if !valid_session_name(&session) {
        return Err((format!("invalid session name: {session}"), 2));
    }

    Ok(AttachReq {
        target_pref,
        session,
    })
}

/// Resolve the attach target. Current bash attach is a single configured-host path.
pub fn resolve_target(pref: Option<Target>, local_mode: bool, host: &str) -> Target {
    match pref {
        Some(target) => target,
        None => {
            let _ = (local_mode, host);
            Target::Remote
        }
    }
}

/// Build the local argv for the interactive SSH attach handoff.
pub fn build_remote_attach_argv(os: Os, host: &str, session: &str, aqua_sock: &str) -> Vec<String> {
    build_remote_attach_argv_with_identity(os, host, session, aqua_sock, &[])
}

pub(crate) fn build_remote_attach_argv_with_identity(
    os: Os,
    host: &str,
    session: &str,
    aqua_sock: &str,
    identity_args: &[String],
) -> Vec<String> {
    let mut argv = vec!["ssh".to_string(), "-tt".to_string()];
    argv.extend(identity_args.iter().cloned());
    argv.extend(
        os.ssh_mux_neutralizer_args()
            .iter()
            .map(|arg| (*arg).to_string()),
    );
    argv.push(host.to_string());
    argv.push(remote_attach_cmd(aqua_sock, session));
    argv
}

/// Build the local tmux-aqua argv for attach.
pub fn build_local_attach_argv(tmux_aqua_bin: &str, aqua_sock: &str, session: &str) -> Vec<String> {
    vec![
        tmux_aqua_bin.to_string(),
        "-S".to_string(),
        aqua_sock.to_string(),
        "attach".to_string(),
        "-d".to_string(),
        "-t".to_string(),
        format!("={session}"),
    ]
}

/// Probe the remote tmux-aqua server for an exact session name.
pub fn has_remote_session(
    transport: &dyn Transport,
    host: &str,
    aqua_sock: &str,
    session: &str,
) -> bool {
    let remote_cmd = remote_has_session_cmd(aqua_sock, session);
    transport
        .ssh_exec(host, &remote_cmd)
        .map(|out| out.code == 0)
        .unwrap_or(false)
}

/// Impure CLI entrypoint: resolve environment/config, precheck, then hand over the tty.
pub fn run(args: &[String]) -> ExitCode {
    let req = match parse_attach_args(args) {
        Ok(req) => req,
        Err((msg, code)) => {
            if code == 0 {
                println!("{msg}");
            } else {
                eprintln!("{msg}");
            }
            return ExitCode::from(code);
        }
    };

    let path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair attach: {err}");
            return ExitCode::from(2);
        }
    };
    let host = match resolve_host(&path) {
        Ok(host) => host,
        Err(err) => {
            eprintln!("xpair attach: {err}");
            return ExitCode::from(1);
        }
    };
    let local_mode = match resolve_local_mode(&path) {
        Ok(local_mode) => local_mode,
        Err(err) => {
            eprintln!("xpair attach: {err}");
            return ExitCode::from(1);
        }
    };
    let aqua_sock = match resolve_aqua_sock(&path) {
        Ok(aqua_sock) => aqua_sock,
        Err(err) => {
            eprintln!("xpair attach: {err}");
            return ExitCode::from(1);
        }
    };

    match resolve_target(req.target_pref, local_mode, &host) {
        Target::Local => run_local_attach(&path, &aqua_sock, &req.session),
        Target::Remote => run_remote_attach(&path, &host, local_mode, &aqua_sock, &req.session),
    }
}

fn valid_session_name(session: &str) -> bool {
    !session.is_empty()
        && session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn remote_attach_cmd(aqua_sock: &str, session: &str) -> String {
    let sock = remote_quote::posix_single_quote(aqua_sock);
    let target = remote_quote::posix_single_quote(&format!("={session}"));
    format!("{REMOTE_BIN}/{TMUX_AQUA} -S {sock} attach -d -t {target}")
}

fn remote_has_session_cmd(aqua_sock: &str, session: &str) -> String {
    let sock = remote_quote::posix_single_quote(aqua_sock);
    let target = remote_quote::posix_single_quote(&format!("={session}"));
    format!("{REMOTE_BIN}/{TMUX_AQUA} -S {sock} has-session -t {target}")
}

fn run_local_attach(path: &Path, aqua_sock: &str, session: &str) -> ExitCode {
    let tmux_aqua_bin = match resolve_tmux_aqua_bin(path) {
        Ok(tmux_aqua_bin) => tmux_aqua_bin,
        Err(err) => {
            eprintln!("xpair attach: {err}");
            return ExitCode::from(1);
        }
    };
    if !program_present(Path::new(&tmux_aqua_bin)) {
        eprintln!("tmux-aqua missing: {tmux_aqua_bin}");
        return ExitCode::from(1);
    }
    if !has_local_session(&tmux_aqua_bin, aqua_sock, session) {
        eprintln!("session not found: {session}");
        return ExitCode::from(4);
    }

    emit_terminal_title(session);
    spawn_and_wait(&build_local_attach_argv(&tmux_aqua_bin, aqua_sock, session))
}

fn run_remote_attach(
    path: &Path,
    host: &str,
    local_mode: bool,
    aqua_sock: &str,
    session: &str,
) -> ExitCode {
    if host.is_empty() {
        eprintln!("no host configured — set one in Xpair.app or: xpair config set host <ssh-host>");
        return ExitCode::from(1);
    }

    let transport = SshTransport;
    if !has_remote_session(&transport, host, aqua_sock, session) {
        eprintln!("session not found on {host}: {session}");
        return ExitCode::from(4);
    }
    if local_mode {
        let _ = config::set(path, "LOCAL_MODE", "0");
    }

    emit_terminal_title(session);
    spawn_and_wait(&build_remote_attach_argv_with_identity(
        Os::current(),
        host,
        session,
        aqua_sock,
        &session::pairing_identity_args(),
    ))
}

fn has_local_session(tmux_aqua_bin: &str, aqua_sock: &str, session: &str) -> bool {
    Command::new(tmux_aqua_bin)
        .arg("-S")
        .arg(aqua_sock)
        .arg("has-session")
        .arg("-t")
        .arg(format!("={session}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn spawn_and_wait(argv: &[String]) -> ExitCode {
    let Some((program, args)) = argv.split_first() else {
        return ExitCode::from(1);
    };
    match Command::new(program).args(args).status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(err) => {
            eprintln!("{program}: {err}");
            ExitCode::from(1)
        }
    }
}

fn emit_terminal_title(session: &str) {
    print!("\x1b]2;{session}\x07");
}

fn resolve_host(path: &Path) -> std::io::Result<String> {
    if let Some(host) = non_empty_env("REMOTE_HOST") {
        return Ok(host);
    }
    config::get_cli(path, "host")
}

fn resolve_local_mode(path: &Path) -> std::io::Result<bool> {
    let _ = path;
    Ok(false)
}

fn resolve_aqua_sock(path: &Path) -> std::io::Result<String> {
    if let Some(aqua_sock) = non_empty_env("AQUA_SOCK") {
        return Ok(aqua_sock);
    }
    Ok(config::get(path, "AQUA_SOCK")?
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| session::DEFAULT_AQUA_SOCK.to_string()))
}

fn resolve_tmux_aqua_bin(path: &Path) -> std::io::Result<String> {
    if let Some(tmux_b) = non_empty_env("TMUXB") {
        return Ok(normalize_windows_exe(PathBuf::from(tmux_b))
            .to_string_lossy()
            .into_owned());
    }

    let local_bin = if let Some(local_bin) = non_empty_env("LOCAL_BIN") {
        PathBuf::from(local_bin)
    } else if let Some(local_bin) =
        config::get(path, "LOCAL_BIN")?.filter(|value| !value.is_empty())
    {
        PathBuf::from(local_bin)
    } else {
        home_dir()?.join(".local").join("bin")
    };

    Ok(normalize_windows_exe(local_bin.join(TMUX_AQUA))
        .to_string_lossy()
        .into_owned())
}

fn normalize_windows_exe(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if !path.is_file() {
            let exe = path.with_extension("exe");
            if exe.is_file() {
                return exe;
            }
        }
    }
    path
}

#[cfg(unix)]
fn program_present(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn program_present(path: &Path) -> bool {
    path.is_file() || path.with_extension("exe").is_file()
}

#[cfg(not(any(unix, windows)))]
fn program_present(path: &Path) -> bool {
    path.is_file()
}

fn home_dir() -> std::io::Result<PathBuf> {
    if let Some(home) = non_empty_env("HOME") {
        return Ok(PathBuf::from(home));
    }
    if let Some(home) = non_empty_env("USERPROFILE") {
        return Ok(PathBuf::from(home));
    }
    match (non_empty_env("HOMEDRIVE"), non_empty_env("HOMEPATH")) {
        (Some(drive), Some(path)) => {
            let mut home = PathBuf::from(drive);
            home.push(path);
            Ok(home)
        }
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "HOME is not set; cannot resolve ~/.local/bin/tmux-aqua",
        )),
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MockTransport;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    fn parse(args: &[&str]) -> Result<AttachReq, (String, u8)> {
        parse_attach_args(&strings(args))
    }

    #[test]
    fn parses_session_without_target_preference() {
        assert_eq!(
            parse(&["alpha"]).unwrap(),
            AttachReq {
                target_pref: None,
                session: "alpha".to_string(),
            }
        );
    }

    #[test]
    fn parse_rejects_removed_local_remote_flags() {
        assert_eq!(
            parse(&["--local", "alpha"]),
            Err(("unknown attach option: --local".to_string(), 2))
        );
        assert_eq!(
            parse(&["--remote", "alpha"]),
            Err(("unknown attach option: --remote".to_string(), 2))
        );
    }

    #[test]
    fn parse_help_returns_usage_with_exit_zero() {
        assert_eq!(parse(&["--help"]), Err((USAGE.to_string(), 0)));
        assert_eq!(parse(&["-h"]), Err((USAGE.to_string(), 0)));
    }

    #[test]
    fn parse_rejects_unknown_long_option_with_exit_two() {
        assert_eq!(
            parse(&["--wat", "alpha"]),
            Err(("unknown attach option: --wat".to_string(), 2))
        );
    }

    #[test]
    fn parse_rejects_missing_and_extra_session_names_with_exit_two() {
        assert_eq!(
            parse(&[]),
            Err(("attach requires a session name".to_string(), 2))
        );
        assert_eq!(
            parse(&["alpha", "beta"]),
            Err(("attach requires exactly one session name".to_string(), 2))
        );
    }

    #[test]
    fn validates_session_names() {
        assert_eq!(parse(&["azAZ09_.-"]).unwrap().session, "azAZ09_.-");
        assert_eq!(parse(&[""]), Err(("invalid session name: ".to_string(), 2)));
        assert_eq!(
            parse(&["bad/name"]),
            Err(("invalid session name: bad/name".to_string(), 2))
        );
        assert_eq!(
            parse(&["bad name"]),
            Err(("invalid session name: bad name".to_string(), 2))
        );
    }

    #[test]
    fn resolves_target_precedence() {
        assert_eq!(
            resolve_target(Some(Target::Local), false, "mac"),
            Target::Local
        );
        assert_eq!(
            resolve_target(Some(Target::Remote), true, ""),
            Target::Remote
        );
        assert_eq!(resolve_target(None, true, "mac"), Target::Remote);
        assert_eq!(resolve_target(None, false, "mac"), Target::Remote);
        assert_eq!(resolve_target(None, false, ""), Target::Remote);
    }

    #[test]
    fn builds_windows_remote_attach_argv_with_mux_neutralizer_and_forced_pty() {
        assert_eq!(
            build_remote_attach_argv(Os::Windows, "mac.local", "alpha.1", "/tmp/aqua sock's.sock"),
            vec![
                "ssh",
                "-tt",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "mac.local",
                r"$HOME/.local/bin/tmux-aqua -S '/tmp/aqua sock'\''s.sock' attach -d -t '=alpha.1'",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn builds_non_windows_remote_attach_argv_without_mux_neutralizer() {
        assert_eq!(
            build_remote_attach_argv(Os::Mac, "mac.local", "alpha-1", "/tmp/aqua-tmux.sock"),
            vec![
                "ssh",
                "-tt",
                "mac.local",
                "$HOME/.local/bin/tmux-aqua -S '/tmp/aqua-tmux.sock' attach -d -t '=alpha-1'",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn builds_local_attach_argv() {
        assert_eq!(
            build_local_attach_argv("/opt/xpair/tmux-aqua", "/tmp/aqua-tmux.sock", "alpha"),
            vec![
                "/opt/xpair/tmux-aqua",
                "-S",
                "/tmp/aqua-tmux.sock",
                "attach",
                "-d",
                "-t",
                "=alpha",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn has_remote_session_maps_exit_code_and_records_exact_remote_command() {
        let transport = MockTransport::new();
        transport.push_response(0, "");
        transport.push_response(1, "");

        assert!(has_remote_session(
            &transport,
            "mac.local",
            "/tmp/aqua sock",
            "alpha"
        ));
        assert!(!has_remote_session(
            &transport,
            "mac.local",
            "/tmp/aqua sock",
            "alpha"
        ));

        let calls = transport.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].host, "mac.local");
        assert_eq!(
            calls[0].remote_cmd,
            "$HOME/.local/bin/tmux-aqua -S '/tmp/aqua sock' has-session -t '=alpha'"
        );
        assert_eq!(calls[1], calls[0]);
    }
}
