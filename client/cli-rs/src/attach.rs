//! Attach an existing tmux-aqua session.
//!
//! Ports the testable core of `cmd_attach()` from `client/cli/xpair:963-1033`.
//! The interactive terminal handoff remains a small process-spawn shim; argument parsing,
//! target selection, SSH argv construction, and remote session probing stay pure/testable.

use std::fs;
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
const MOSH_SERVER: &str = "$HOME/.local/bin/mosh-server";
const MOSH_TMUX_AQUA: &str = "$HOME/.local/bin/tmux-aqua";

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoshCommand {
    pub program: String,
    pub client_arg: Option<String>,
}

pub fn build_mosh_attach_argv(
    mosh: &MoshCommand,
    host: &str,
    session: &str,
    aqua_sock: &str,
    identity_args: &[String],
    remote_home: &str,
) -> Vec<String> {
    let remote_home = remote_home.trim_end_matches('/');
    let server = non_empty_env("MOSH_SERVER").unwrap_or_else(|| match remote_home {
        home if !home.is_empty() => format!("{home}/.local/bin/mosh-server"),
        _ => MOSH_SERVER.to_string(),
    });
    let tmux_aqua = match remote_home {
        home if !home.is_empty() => format!("{home}/.local/bin/tmux-aqua"),
        _ => MOSH_TMUX_AQUA.to_string(),
    };

    let mut argv = vec![
        mosh.program.clone(),
        format!("--ssh={}", ssh_command_for_mosh(identity_args)),
    ];
    if let Some(client_arg) = &mosh.client_arg {
        argv.push(format!("--client={client_arg}"));
    }
    argv.extend([
        format!("--server={server}"),
        host.to_string(),
        "--".to_string(),
        tmux_aqua,
        "-S".to_string(),
        aqua_sock.to_string(),
        "attach".to_string(),
        "-d".to_string(),
        "-t".to_string(),
        format!("={session}"),
    ]);
    argv
}

pub fn build_mosh_attach_cleanup_argv(
    mosh_argv: &[String],
    host: &str,
    session: &str,
    aqua_sock: &str,
    identity_args: &[String],
) -> Vec<String> {
    let mosh = mosh_argv
        .iter()
        .map(|arg| local_shell_word(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let cleanup = build_local_ssh_detach_shell_cmd(host, session, aqua_sock, identity_args);
    vec![
        "sh".to_string(),
        "-c".to_string(),
        format!(
            concat!(
                "on_tab_close() {{ ",
                "( trap '' HUP; {cleanup} >/dev/null 2>&1 || true ) </dev/null >/dev/null 2>&1 & ",
                "exit 129; ",
                "}}; ",
                "trap on_tab_close HUP TERM; ",
                "{mosh}; rc=$?; ",
                "trap - HUP TERM; ",
                "exit \"$rc\""
            ),
            cleanup = cleanup,
            mosh = mosh,
        ),
    ]
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
    format!(
        concat!(
            "TMUXB=\"{remote_bin}/{tmux_aqua}\"; SOCK={sock}; TARGET={target}; ",
            "cleanup() {{ \"$TMUXB\" -S \"$SOCK\" detach-client -s \"$TARGET\" >/dev/null 2>&1 || true; }}; ",
            "trap 'cleanup; exit 129' HUP TERM; ",
            "\"$TMUXB\" -S \"$SOCK\" attach -d -t \"$TARGET\"; ",
            "rc=$?; trap - HUP TERM; if [ \"$rc\" -ne 0 ]; then cleanup; fi; exit \"$rc\""
        ),
        remote_bin = REMOTE_BIN,
        tmux_aqua = TMUX_AQUA,
        sock = sock,
        target = target,
    )
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
    run_remote_attach_handoff(
        path,
        Os::current(),
        host,
        session,
        aqua_sock,
        &session::pairing_identity_args(),
        None,
    )
}

pub(crate) fn run_remote_attach_handoff(
    path: &Path,
    os: Os,
    host: &str,
    session: &str,
    aqua_sock: &str,
    identity_args: &[String],
    remote_home: Option<&str>,
) -> ExitCode {
    if os == Os::Windows {
        // Win32 stays SSH-only: there is no supported bundled mosh-client/mosh-server story
        // for the native Windows client yet, and SSH mux is neutralized separately.
        return spawn_and_wait(&build_remote_attach_argv_with_identity(
            os,
            host,
            session,
            aqua_sock,
            identity_args,
        ));
    }

    if let Some(mosh) = probe_mosh(path) {
        let remote_home = match resolve_mosh_remote_home(host, remote_home) {
            Some(remote_home) => remote_home,
            None => {
                eprintln!("could not resolve remote HOME for mosh -> falling back to ssh -t ...");
                return spawn_and_wait(&build_remote_attach_argv_with_identity(
                    os,
                    host,
                    session,
                    aqua_sock,
                    identity_args,
                ));
            }
        };
        let argv =
            build_mosh_attach_argv(&mosh, host, session, aqua_sock, identity_args, &remote_home);
        let argv = build_mosh_attach_cleanup_argv(&argv, host, session, aqua_sock, identity_args);
        let code = spawn_and_wait_code(&argv);
        if code == 0 {
            return ExitCode::SUCCESS;
        }
        eprintln!("mosh attach failed (rc={code}) -> falling back to ssh -t ...");
    } else {
        println!("mosh not found -> falling back to ssh -t (attach tmux \"{session}\") ...");
    }

    spawn_and_wait(&build_remote_attach_argv_with_identity(
        os,
        host,
        session,
        aqua_sock,
        identity_args,
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
    ExitCode::from(exit_code_from_i32(spawn_and_wait_code(argv)))
}

fn spawn_and_wait_code(argv: &[String]) -> i32 {
    let Some((program, args)) = argv.split_first() else {
        return 1;
    };
    match Command::new(program).args(args).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            eprintln!("{program}: {err}");
            1
        }
    }
}

fn exit_code_from_i32(code: i32) -> u8 {
    if code == 0 {
        0
    } else if (1..=255).contains(&code) {
        code as u8
    } else {
        1
    }
}

fn emit_terminal_title(session: &str) {
    print!("\x1b]2;{session}\x07");
}

fn resolve_host(path: &Path) -> std::io::Result<String> {
    if let Some(host) = non_empty_env("REMOTE_HOST") {
        config::require_valid_host(&host)?;
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

fn resolve_local_bin(path: &Path) -> std::io::Result<PathBuf> {
    if let Some(local_bin) = non_empty_env("LOCAL_BIN") {
        return Ok(PathBuf::from(local_bin));
    }
    if let Some(local_bin) = config::get(path, "LOCAL_BIN")?.filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(local_bin));
    }
    Ok(home_dir()?.join(".local").join("bin"))
}

fn probe_mosh(path: &Path) -> Option<MoshCommand> {
    let mosh = find_on_path("mosh")?;
    let local_bin = resolve_local_bin(path).ok()?;
    let client_arg = if let Some(client) = non_empty_env("MOSH_CLIENT") {
        Some(client)
    } else {
        let local_mosh = local_bin.join("mosh");
        let local_client = local_bin.join("mosh-client");
        let local_mosh_s = path_string(&local_mosh);
        if !is_symlink(&local_mosh) && mosh == local_mosh_s && program_present(&local_client) {
            Some(path_string(local_client))
        } else {
            None
        }
    };

    Some(MoshCommand {
        program: mosh,
        client_arg,
    })
}

fn find_on_path(program: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(program);
        if program_present(&candidate) {
            return Some(path_string(candidate));
        }
        #[cfg(windows)]
        {
            let exe = candidate.with_extension("exe");
            if program_present(&exe) {
                return Some(path_string(exe));
            }
        }
    }
    None
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn ssh_command_for_mosh(identity_args: &[String]) -> String {
    let mut parts = vec!["ssh".to_string()];
    parts.extend(identity_args.iter().map(|arg| local_shell_word(arg)));
    parts.join(" ")
}

fn resolve_mosh_remote_home(host: &str, remote_home: Option<&str>) -> Option<String> {
    let transport = SshTransport;
    resolve_mosh_remote_home_with_transport(&transport, host, remote_home)
}

fn resolve_mosh_remote_home_with_transport(
    transport: &dyn Transport,
    host: &str,
    remote_home: Option<&str>,
) -> Option<String> {
    if let Some(home) = remote_home
        .map(str::trim)
        .filter(|home| !home.is_empty())
        .map(str::to_string)
    {
        return Some(home);
    }

    query_remote_home(transport, host)
}

fn query_remote_home(transport: &dyn Transport, host: &str) -> Option<String> {
    transport
        .ssh_exec(host, remote_home_cmd())
        .ok()
        .filter(|output| output.code == 0)
        .map(|output| output.stdout.trim_matches(['\r', '\n']).to_string())
        .filter(|home| !home.is_empty())
}

fn remote_home_cmd() -> &'static str {
    "printf '%s\\n' \"$HOME\""
}

fn build_local_ssh_detach_shell_cmd(
    host: &str,
    session: &str,
    aqua_sock: &str,
    identity_args: &[String],
) -> String {
    let mut parts = vec!["ssh".to_string()];
    parts.extend(identity_args.iter().map(|arg| local_shell_word(arg)));
    parts.extend(
        ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3"]
            .iter()
            .map(|arg| (*arg).to_string()),
    );
    parts.push(local_shell_word(host));
    parts.push(local_shell_word(&remote_detach_cmd(aqua_sock, session)));
    parts.join(" ")
}

fn remote_detach_cmd(aqua_sock: &str, session: &str) -> String {
    let sock = remote_quote::posix_single_quote(aqua_sock);
    let target = remote_quote::posix_single_quote(&format!("={session}"));
    format!("{REMOTE_BIN}/{TMUX_AQUA} -S {sock} detach-client -s {target}")
}

fn local_shell_word(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-' | '='))
    {
        return value.to_string();
    }
    remote_quote::posix_single_quote(value)
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
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
    use std::ffi::OsString;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvGuard {
        fn set(values: &[(&'static str, Option<&str>)]) -> EnvGuard {
            let saved = values
                .iter()
                .map(|(key, _)| (*key, std::env::var_os(key)))
                .collect::<Vec<_>>();
            for (key, value) in values {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
            EnvGuard { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    fn with_env<T>(values: &[(&'static str, Option<&str>)], f: impl FnOnce() -> T) -> T {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let _guard = EnvGuard::set(values);
        f()
    }

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
        let argv =
            build_remote_attach_argv(Os::Windows, "mac.local", "alpha.1", "/tmp/aqua sock's.sock");
        assert_eq!(
            &argv[..7],
            strings(&[
                "ssh",
                "-tt",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "mac.local",
            ])
            .as_slice()
        );
        let cmd = argv.last().unwrap();
        assert!(cmd.contains(r#"SOCK='/tmp/aqua sock'\''s.sock'"#));
        assert!(cmd.contains("TARGET='=alpha.1'"));
        assert!(cmd.contains("detach-client -s \"$TARGET\""));
        assert!(cmd.contains("attach -d -t \"$TARGET\""));
    }

    #[test]
    fn builds_non_windows_remote_attach_argv_without_mux_neutralizer() {
        let argv = build_remote_attach_argv(Os::Mac, "mac.local", "alpha-1", "/tmp/aqua-tmux.sock");
        assert_eq!(&argv[..3], strings(&["ssh", "-tt", "mac.local"]).as_slice());
        let cmd = argv.last().unwrap();
        assert!(cmd.contains("SOCK='/tmp/aqua-tmux.sock'"));
        assert!(cmd.contains("TARGET='=alpha-1'"));
        assert!(cmd.contains("detach-client -s \"$TARGET\""));
        assert!(cmd.contains("attach -d -t \"$TARGET\""));
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

    #[test]
    fn builds_mosh_attach_argv_with_remote_home_and_identity() {
        with_env(&[("MOSH_SERVER", None)], || {
            let mosh = MoshCommand {
                program: "/opt/xpair/bin/mosh".to_string(),
                client_arg: Some("/opt/xpair/bin/mosh-client".to_string()),
            };
            let argv = build_mosh_attach_argv(
                &mosh,
                "alice@mac.local",
                "alpha_1",
                "/tmp/aqua sock",
                &strings(&["-i", "/Users/me/.xpair/host/pairing key"]),
                "/Users/alice/",
            );

            assert_eq!(
                argv,
                strings(&[
                    "/opt/xpair/bin/mosh",
                    "--ssh=ssh -i '/Users/me/.xpair/host/pairing key'",
                    "--client=/opt/xpair/bin/mosh-client",
                    "--server=/Users/alice/.local/bin/mosh-server",
                    "alice@mac.local",
                    "--",
                    "/Users/alice/.local/bin/tmux-aqua",
                    "-S",
                    "/tmp/aqua sock",
                    "attach",
                    "-d",
                    "-t",
                    "=alpha_1",
                ])
            );
            assert!(!argv[6].contains("$HOME"));
        });
    }

    #[test]
    fn resolves_mosh_remote_home_from_launch_plumbing_without_ssh_probe() {
        let transport = MockTransport::new();

        assert_eq!(
            resolve_mosh_remote_home_with_transport(&transport, "mac.local", Some("/Users/launch")),
            Some("/Users/launch".to_string())
        );
        assert!(transport.calls().is_empty());
    }

    #[test]
    fn resolves_mosh_remote_home_over_ssh_when_attach_has_no_plumbed_home() {
        let transport = MockTransport::new();
        transport.push_response(0, "/Users/remote\n");

        assert_eq!(
            resolve_mosh_remote_home_with_transport(&transport, "mac.local", None),
            Some("/Users/remote".to_string())
        );
        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].host, "mac.local");
        assert_eq!(calls[0].remote_cmd, remote_home_cmd());
    }

    #[test]
    fn wraps_mosh_attach_with_tab_close_detach_trap() {
        let mosh_argv = strings(&[
            "mosh",
            "--ssh=ssh -i /Users/me/.xpair/host/pairing_ed25519",
            "--server=/Users/alice/.local/bin/mosh-server",
            "alice@mac.local",
            "--",
            "/Users/alice/.local/bin/tmux-aqua",
            "-S",
            "/tmp/aqua sock",
            "attach",
            "-d",
            "-t",
            "=alpha",
        ]);
        let argv = build_mosh_attach_cleanup_argv(
            &mosh_argv,
            "alice@mac.local",
            "alpha",
            "/tmp/aqua sock",
            &strings(&["-i", "/Users/me/.xpair/host/pairing_ed25519"]),
        );

        assert_eq!(&argv[..2], strings(&["sh", "-c"]).as_slice());
        let script = &argv[2];
        assert!(script.contains("trap on_tab_close HUP TERM"));
        assert!(script.contains("exit 129"));
        assert!(script.contains("ssh -i /Users/me/.xpair/host/pairing_ed25519 -n -o BatchMode=yes -o ConnectTimeout=3 'alice@mac.local'"));
        assert!(script.contains("$HOME/.local/bin/tmux-aqua -S '\\''/tmp/aqua sock'\\'' detach-client -s '\\''=alpha'\\''"));
        assert!(script.contains("/Users/alice/.local/bin/tmux-aqua -S"));
    }
}
