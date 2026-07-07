//! `xpair logs` command construction and thin process shims.
//!
//! Ports `cmd_logs()` from `client/cli/xpair:1255-1307`: bash-compatible argument
//! parsing, local log collection, host log tailing, and local log tailing. The pure
//! builders below are the parity surface; the process-spawning functions are intentionally
//! small and uncovered.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config;
use crate::platform::{self, Os};
use crate::remote_quote;
use crate::session;
use crate::transport::{Output, Transport};

const HOST_LOG_GLOB: &str = "$HOME/.xpair/host/logs/*.log";
const NO_HOST_LOGS: &str = "(no host logs at ~/.xpair/host/logs)";
const DEFAULT_APP_NAME: &str = "XpairHost";
const FORWARD_APP: &str = "Xpair";

/// Parsed `xpair logs` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogsReq {
    pub host: bool,
    pub follow: bool,
    pub n: u32,
    pub collect: bool,
}

/// Parse the bash-compatible `logs` flags.
///
/// Unknown args are ignored, matching `client/cli/xpair:1262`.
pub fn parse_logs_args(args: &[String]) -> LogsReq {
    let mut req = LogsReq {
        host: false,
        follow: false,
        n: 200,
        collect: false,
    };

    let mut idx = 0;
    while idx < args.len() {
        match args[idx].as_str() {
            "--host" => {
                req.host = true;
                idx += 1;
            }
            "-f" | "--follow" => {
                req.follow = true;
                idx += 1;
            }
            "-n" => {
                req.n = args
                    .get(idx + 1)
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(200);
                idx += 2;
            }
            "--collect" => {
                req.collect = true;
                idx += 1;
            }
            _ => idx += 1,
        }
    }

    req
}

/// Build `tar -czf <out> -C <parent> logs`.
///
/// `stamp` is supplied by the caller so this stays deterministic and testable.
pub fn build_collect_tar_argv(rp_dir: impl AsRef<Path>, stamp: &str) -> (Vec<String>, String) {
    build_collect_tar_argv_in(rp_dir, stamp, std::env::temp_dir())
}

fn build_collect_tar_argv_in(
    rp_dir: impl AsRef<Path>,
    stamp: &str,
    temp_root: impl AsRef<Path>,
) -> (Vec<String>, String) {
    let log_dir = rp_dir.as_ref().join("logs");
    let out_parent = temp_root
        .as_ref()
        .join(format!("xpair-logs-{stamp}.{}", std::process::id()));
    let out = out_parent.join(format!("xpair-logs-{stamp}.tgz"));
    let parent = log_dir.parent().unwrap_or_else(|| Path::new("."));
    let basename = log_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("logs");

    let out = path_string(out);
    (
        vec![
            "tar".to_string(),
            "-czf".to_string(),
            out.clone(),
            "-C".to_string(),
            path_string(parent),
            basename.to_string(),
        ],
        out,
    )
}

fn build_collect_tar_argv_for_log_dirs(
    log_dirs: &[PathBuf],
    stamp: &str,
    temp_root: impl AsRef<Path>,
) -> (Vec<String>, String) {
    let out_parent = temp_root
        .as_ref()
        .join(format!("xpair-logs-{stamp}.{}", std::process::id()));
    let out = out_parent.join(format!("xpair-logs-{stamp}.tgz"));
    let out = path_string(out);

    let mut argv = vec!["tar".to_string(), "-czf".to_string(), out.clone()];
    let mut current_root = None::<PathBuf>;
    for log_dir in log_dirs {
        let (root, rel) = tar_root_and_rel(log_dir);
        if current_root.as_ref() != Some(&root) {
            argv.push("-C".to_string());
            argv.push(path_string(&root));
            current_root = Some(root);
        }
        argv.push(rel);
    }
    (argv, out)
}

/// Build the remote POSIX command used by `xpair logs --host`.
pub fn build_host_tail_remote_cmd(n: u32, follow: bool) -> String {
    if follow {
        format!("tail -n {n} -F {HOST_LOG_GLOB} 2>/dev/null")
    } else {
        format!(
            "tail -n {n} {HOST_LOG_GLOB} 2>/dev/null || echo {}",
            remote_quote::posix_single_quote(NO_HOST_LOGS)
        )
    }
}

/// Build the local `ssh` argv for host log tailing.
///
/// Windows includes the C1 multiplexing neutralizer args. Interactive follow forces a PTY
/// with `-tt`.
pub fn build_host_ssh_argv(
    os: platform::Os,
    host: &str,
    remote_cmd: &str,
    follow: bool,
) -> Vec<String> {
    build_host_ssh_argv_with_identity(os, host, remote_cmd, follow, &[])
}

fn build_host_ssh_argv_with_identity(
    os: platform::Os,
    host: &str,
    remote_cmd: &str,
    follow: bool,
    identity_args: &[String],
) -> Vec<String> {
    let mut argv = vec!["ssh".to_string()];
    argv.extend(identity_args.iter().cloned());
    if follow {
        argv.push("-tt".to_string());
    }
    argv.extend(
        os.ssh_mux_neutralizer_args()
            .iter()
            .map(|arg| arg.to_string()),
    );
    argv.push(host.to_string());
    argv.push(remote_cmd.to_string());
    argv
}

/// Build the bash-shaped local tail argv.
///
/// Bash relies on the shell to expand `*.log`; the runtime shim in this Rust port expands
/// the wildcard via `std::fs::read_dir` before spawning `tail` so local execution remains
/// shell-free.
pub fn build_local_tail_argv(log_dir: impl AsRef<Path>, n: u32, follow: bool) -> Vec<String> {
    let mut argv = vec!["tail".to_string(), "-n".to_string(), n.to_string()];
    if follow {
        argv.push("-F".to_string());
    }
    argv.push(path_string(log_dir.as_ref().join("*.log")));
    argv
}

/// CLI entrypoint for `xpair logs`.
pub fn run(args: &[String]) -> ExitCode {
    let client_env_path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair logs: {err}");
            return ExitCode::from(2);
        }
    };

    let os = Os::current();
    let transport = SshTransport { os };
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();

    run_with_transport(
        args,
        &client_env_path,
        os,
        &transport,
        &mut stdout,
        &mut stderr,
    )
}

/// Testable runner for non-interactive paths.
///
/// The `--host` non-follow path uses `Transport` so tests can assert the exact remote
/// command without touching a real SSH server. Follow, collect, and local tailing delegate
/// to process shims.
pub fn run_with_transport<T: Transport + ?Sized, W: Write, E: Write>(
    args: &[String],
    client_env_path: &Path,
    os: Os,
    transport: &T,
    out: &mut W,
    err: &mut E,
) -> ExitCode {
    let req = parse_logs_args(args);
    let settings = RuntimeSettings::load(client_env_path);

    if req.collect {
        let stamp = current_stamp();
        return match collect_logs(&settings.local_log_dirs, &stamp, out, err) {
            Ok(()) => ExitCode::SUCCESS,
            Err(()) => ExitCode::from(1),
        };
    }

    if req.host {
        let Some(host) = settings
            .remote_host
            .as_deref()
            .filter(|host| !host.is_empty())
        else {
            let _ = writeln!(
                err,
                "no REMOTE_HOST configured — 'xpair config set host <ssh-host>'"
            );
            return ExitCode::from(1);
        };

        let remote_cmd = build_host_tail_remote_cmd(req.n, req.follow);
        if req.follow {
            return run_host_follow(os, host, &remote_cmd);
        }

        return match transport.ssh_exec(host, &remote_cmd) {
            Ok(Output { code, stdout }) => {
                let _ = write!(out, "{stdout}");
                exit_code_from_i32(code)
            }
            Err(error) => {
                let _ = writeln!(err, "xpair logs: {error}");
                ExitCode::from(1)
            }
        };
    }

    match run_local_tail(&settings.local_log_dirs, req.n, req.follow, out, err) {
        Ok(code) => code,
        Err(error) => {
            let _ = writeln!(err, "xpair logs: {error}");
            ExitCode::from(1)
        }
    }
}

struct RuntimeSettings {
    local_log_dirs: Vec<PathBuf>,
    remote_host: Option<String>,
}

impl RuntimeSettings {
    fn load(client_env_path: &Path) -> RuntimeSettings {
        let client_dir = client_dir(client_env_path);
        let host_dir = host_dir(client_env_path);
        let app_name =
            non_empty_value(client_env_path, "APP_NAME").unwrap_or_else(|| DEFAULT_APP_NAME.into());
        let mut local_log_dirs = vec![client_dir.join("logs")];
        if local_host_capable(&host_dir, &app_name, FORWARD_APP) {
            local_log_dirs.push(host_dir.join("logs"));
        }
        let remote_host = non_empty_value(client_env_path, "REMOTE_HOST");

        RuntimeSettings {
            local_log_dirs,
            remote_host,
        }
    }
}

fn collect_logs<W: Write, E: Write>(
    log_dirs: &[PathBuf],
    stamp: &str,
    out: &mut W,
    err: &mut E,
) -> Result<(), ()> {
    let existing = log_dirs
        .iter()
        .filter(|dir| dir.is_dir())
        .cloned()
        .collect::<Vec<_>>();
    if existing.is_empty() {
        let _ = writeln!(err, "collect: no log dirs yet");
        return Err(());
    }

    let (argv, out_path) =
        build_collect_tar_argv_for_log_dirs(&existing, stamp, std::env::temp_dir());
    if let Some(parent) = Path::new(&out_path).parent() {
        fs::create_dir_all(parent).map_err(|_| ())?;
    }
    let status = Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| ())?;

    if status.success() {
        let _ = writeln!(out, "{out_path}");
        Ok(())
    } else {
        let _ = writeln!(err, "collect: tar failed");
        Err(())
    }
}

fn run_host_follow(os: Os, host: &str, remote_cmd: &str) -> ExitCode {
    let argv = build_host_ssh_argv_with_identity(
        os,
        host,
        remote_cmd,
        true,
        &session::pairing_identity_args(),
    );
    match Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
    {
        Ok(status) => exit_code_from_i32(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("xpair logs: {error}");
            ExitCode::from(1)
        }
    }
}

fn run_local_tail<W: Write, E: Write>(
    log_dirs: &[PathBuf],
    n: u32,
    follow: bool,
    out: &mut W,
    err: &mut E,
) -> io::Result<ExitCode> {
    let (files, label) = local_log_files(log_dirs)?;
    if files.is_empty() {
        let _ = writeln!(out, "(no local logs at {label})");
        return Ok(ExitCode::SUCCESS);
    }

    let mut argv = vec!["tail".to_string(), "-n".to_string(), n.to_string()];
    if follow {
        argv.push("-F".to_string());
    }
    argv.extend(files.into_iter().map(path_string));

    if follow {
        let status = Command::new(&argv[0])
            .args(&argv[1..])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        return Ok(exit_code_from_i32(status.code().unwrap_or(1)));
    }

    let output = Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;

    if output.status.success() {
        out.write_all(&output.stdout).map_err(io::Error::other)?;
        Ok(ExitCode::SUCCESS)
    } else {
        let _ = writeln!(out, "(no local logs at {label})");
        let _ = err;
        Ok(ExitCode::SUCCESS)
    }
}

fn local_log_files(log_dirs: &[PathBuf]) -> io::Result<(Vec<PathBuf>, String)> {
    let mut files = Vec::new();
    let mut labels = Vec::new();
    for log_dir in log_dirs {
        let entries = match fs::read_dir(log_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        labels.push(path_string(log_dir));
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("log") {
                files.push(path);
            }
        }
    }
    files.sort();
    let label = if labels.is_empty() {
        log_dirs
            .first()
            .map(path_string)
            .unwrap_or_else(|| "logs".to_string())
    } else {
        labels.join(", ")
    };
    Ok((files, label))
}

fn client_dir(client_env_path: &Path) -> PathBuf {
    if let Some(value) = non_empty_env("RP_CLIENT_DIR") {
        return PathBuf::from(value);
    }

    client_env_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_client_dir().unwrap_or_else(|| PathBuf::from(".")))
}

fn host_dir(client_env_path: &Path) -> PathBuf {
    if let Some(value) = non_empty_env("RP_HOST_DIR").or_else(|| non_empty_env("RP_DIR")) {
        return PathBuf::from(value);
    }
    if let Some(value) = config::get(client_env_path, "RP_HOST_DIR")
        .ok()
        .flatten()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            config::get(client_env_path, "RP_DIR")
                .ok()
                .flatten()
                .filter(|value| !value.is_empty())
        })
    {
        return PathBuf::from(value);
    }

    default_rp_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn local_host_capable(host_dir: &Path, app_name: &str, forward_app: &str) -> bool {
    if host_dir.join(".manifest-host").is_file() || host_dir.join("host.env").is_file() {
        return true;
    }
    if let Ok(role) = fs::read_to_string(host_dir.join("role")) {
        if matches!(role.trim(), "host" | "both") {
            return true;
        }
    }
    for app_root in app_roots() {
        if app_root.join(format!("{app_name}.app")).is_dir()
            || app_root.join(format!("{forward_app}.app")).is_dir()
        {
            return true;
        }
    }
    false
}

fn app_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
}

fn tar_root_and_rel(log_dir: &Path) -> (PathBuf, String) {
    let Some(parent) = log_dir.parent() else {
        return (PathBuf::from("."), path_string(log_dir));
    };
    let Some(role_dir) = parent.file_name().and_then(|name| name.to_str()) else {
        return (parent.to_path_buf(), log_dir_name(log_dir));
    };
    if log_dir.file_name().and_then(|name| name.to_str()) == Some("logs")
        && matches!(role_dir, "client" | "host")
    {
        if let Some(root) = parent.parent() {
            return (root.to_path_buf(), format!("{role_dir}/logs"));
        }
    }

    (parent.to_path_buf(), log_dir_name(log_dir))
}

fn log_dir_name(log_dir: &Path) -> String {
    log_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("logs")
        .to_string()
}

fn default_rp_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".xpair").join("host"))
}

fn default_client_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".xpair").join("client"))
}

fn home_dir() -> Option<PathBuf> {
    if let Some(home) = non_empty_env("HOME") {
        return Some(PathBuf::from(home));
    }
    if let Some(home) = non_empty_env("USERPROFILE") {
        return Some(PathBuf::from(home));
    }
    match (non_empty_env("HOMEDRIVE"), non_empty_env("HOMEPATH")) {
        (Some(drive), Some(path)) => {
            let mut home = PathBuf::from(drive);
            home.push(path);
            Some(home)
        }
        _ => None,
    }
}

fn non_empty_value(client_env_path: &Path, key: &str) -> Option<String> {
    non_empty_env(key).or_else(|| {
        config::get(client_env_path, key)
            .ok()
            .flatten()
            .filter(|value| !value.is_empty())
    })
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn current_stamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    utc_stamp(seconds)
}

fn utc_stamp(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let mut secs_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3_600;
    secs_of_day %= 3_600;
    let minute = secs_of_day / 60;
    let second = secs_of_day % 60;
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

fn exit_code_from_i32(code: i32) -> ExitCode {
    if code == 0 {
        ExitCode::SUCCESS
    } else if (1..=255).contains(&code) {
        ExitCode::from(code as u8)
    } else {
        ExitCode::from(1)
    }
}

struct SshTransport {
    os: Os,
}

impl Transport for SshTransport {
    fn ssh_exec(&self, host: &str, remote_cmd: &str) -> io::Result<Output> {
        let argv = build_host_ssh_argv_with_identity(
            self.os,
            host,
            remote_cmd,
            false,
            &session::pairing_identity_args(),
        );
        let output = Command::new(&argv[0])
            .args(&argv[1..])
            .stdin(Stdio::null())
            .output()?;

        Ok(Output {
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MockTransport;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestPath {
        path: PathBuf,
    }

    impl TestPath {
        fn new(name: &str) -> TestPath {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "xpair-logs-test-{}-{id}-{name}.env",
                std::process::id()
            ));
            let _ = fs::remove_file(&path);
            TestPath { path }
        }

        fn write(&self, body: &str) {
            fs::write(&self.path, body).unwrap();
        }
    }

    impl Drop for TestPath {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parse_defaults() {
        assert_eq!(
            parse_logs_args(&[]),
            LogsReq {
                host: false,
                follow: false,
                n: 200,
                collect: false,
            }
        );
    }

    #[test]
    fn parse_n_value() {
        assert_eq!(parse_logs_args(&args(&["-n", "50"])).n, 50);
        assert_eq!(parse_logs_args(&args(&["-n"])).n, 200);
        assert_eq!(parse_logs_args(&args(&["-n", "nope"])).n, 200);
    }

    #[test]
    fn parse_flags_and_ignores_unknown() {
        assert_eq!(
            parse_logs_args(&args(&["wat", "--host", "-f", "--collect", "--other"])),
            LogsReq {
                host: true,
                follow: true,
                n: 200,
                collect: true,
            }
        );
    }

    #[test]
    fn build_collect_tar_argv_exact_shape() {
        let rp_dir = PathBuf::from("C:/Users/me/.xpair/host");
        let temp_root = PathBuf::from("C:/Temp");
        let (argv, out) = build_collect_tar_argv_in(&rp_dir, "20260102-030405", &temp_root);
        let expected_out = path_string(
            temp_root
                .join(format!("xpair-logs-20260102-030405.{}", std::process::id()))
                .join("xpair-logs-20260102-030405.tgz"),
        );

        assert_eq!(out, expected_out);
        assert!(!out.starts_with(&path_string(rp_dir.join("logs"))));
        assert_eq!(
            argv,
            vec![
                "tar".to_string(),
                "-czf".to_string(),
                expected_out,
                "-C".to_string(),
                path_string(&rp_dir),
                "logs".to_string(),
            ]
        );
    }

    #[test]
    fn build_collect_tar_argv_includes_client_and_host_log_roots() {
        let log_dirs = vec![
            PathBuf::from("C:/Users/me/.xpair/client/logs"),
            PathBuf::from("C:/Users/me/.xpair/host/logs"),
        ];
        let temp_root = PathBuf::from("C:/Temp");
        let (argv, out) =
            build_collect_tar_argv_for_log_dirs(&log_dirs, "20260102-030405", &temp_root);
        let expected_out = path_string(
            temp_root
                .join(format!("xpair-logs-20260102-030405.{}", std::process::id()))
                .join("xpair-logs-20260102-030405.tgz"),
        );

        assert_eq!(out, expected_out);
        assert_eq!(
            argv,
            vec![
                "tar".to_string(),
                "-czf".to_string(),
                expected_out,
                "-C".to_string(),
                path_string(PathBuf::from("C:/Users/me/.xpair")),
                "client/logs".to_string(),
                "host/logs".to_string(),
            ]
        );
    }

    #[test]
    fn build_host_tail_remote_cmd_has_fallback_only_when_not_following() {
        assert_eq!(
            build_host_tail_remote_cmd(25, false),
            "tail -n 25 $HOME/.xpair/host/logs/*.log 2>/dev/null || echo '(no host logs at ~/.xpair/host/logs)'"
        );
        assert_eq!(
            build_host_tail_remote_cmd(25, true),
            "tail -n 25 -F $HOME/.xpair/host/logs/*.log 2>/dev/null"
        );
    }

    #[test]
    fn build_host_ssh_argv_windows_has_pty_and_mux_neutralizer() {
        assert_eq!(
            build_host_ssh_argv(Os::Windows, "mac-mini", "tail logs", true),
            vec![
                "ssh",
                "-tt",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "mac-mini",
                "tail logs",
            ]
        );
    }

    #[test]
    fn build_host_ssh_argv_non_windows_has_no_mux_neutralizer() {
        assert_eq!(
            build_host_ssh_argv(Os::Mac, "mac-mini", "tail logs", false),
            vec!["ssh", "mac-mini", "tail logs"]
        );
    }

    #[test]
    fn build_local_tail_argv_uses_wildcard_shape() {
        let log_dir = PathBuf::from("/tmp/xpair/logs");
        assert_eq!(
            build_local_tail_argv(&log_dir, 10, false),
            vec![
                "tail".to_string(),
                "-n".to_string(),
                "10".to_string(),
                path_string(log_dir.join("*.log")),
            ]
        );
        assert_eq!(
            build_local_tail_argv(&log_dir, 10, true),
            vec![
                "tail".to_string(),
                "-n".to_string(),
                "10".to_string(),
                "-F".to_string(),
                path_string(log_dir.join("*.log")),
            ]
        );
    }

    #[test]
    fn host_non_follow_runs_through_mock_transport_and_prints_stdout() {
        let tmp = TestPath::new("client");
        tmp.write("REMOTE_HOST=mac-mini\n");
        let transport = MockTransport::new();
        transport.push_response(0, "alpha log\nbeta log\n");
        let mut out = Vec::new();
        let mut err = Vec::new();

        let code = run_with_transport(
            &args(&["--host", "-n", "7"]),
            &tmp.path,
            Os::Linux,
            &transport,
            &mut out,
            &mut err,
        );

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(String::from_utf8(out).unwrap(), "alpha log\nbeta log\n");
        assert_eq!(String::from_utf8(err).unwrap(), "");
        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].host, "mac-mini");
        assert_eq!(
            calls[0].remote_cmd,
            "tail -n 7 $HOME/.xpair/host/logs/*.log 2>/dev/null || echo '(no host logs at ~/.xpair/host/logs)'"
        );
    }

    #[test]
    fn local_log_files_include_co_located_host_logs() {
        let root = std::env::temp_dir().join(format!("xpair-logs-local-{}", std::process::id()));
        let client_logs = root.join("client").join("logs");
        let host_logs = root.join("host").join("logs");
        fs::create_dir_all(&client_logs).unwrap();
        fs::create_dir_all(&host_logs).unwrap();
        fs::write(client_logs.join("client.log"), "client").unwrap();
        fs::write(host_logs.join("host.log"), "host").unwrap();

        let (files, label) = local_log_files(&[client_logs.clone(), host_logs.clone()]).unwrap();

        assert_eq!(files.len(), 2);
        assert!(files.contains(&client_logs.join("client.log")));
        assert!(files.contains(&host_logs.join("host.log")));
        assert!(label.contains(&path_string(&client_logs)));
        assert!(label.contains(&path_string(&host_logs)));

        let _ = fs::remove_file(client_logs.join("client.log"));
        let _ = fs::remove_file(host_logs.join("host.log"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn utc_stamp_formats_fixed_epoch_seconds() {
        assert_eq!(utc_stamp(0), "19700101-000000");
        assert_eq!(utc_stamp(1_704_112_445), "20240101-123405");
    }
}
