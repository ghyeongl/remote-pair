//! `xpair install-host` command construction and bootstrap orchestration.
//!
//! C1 divergence from `client/cli/xpair:1824-1831`: bash multiplexes the whole install over
//! one SSH master (`ControlMaster`/`ControlPath`/`ControlPersist`). Win32-OpenSSH cannot use
//! that model, so this Rust port intentionally runs every host step as an independent
//! [`Transport::ssh_exec`] call. The real transport passes
//! [`platform::Os::ssh_mux_neutralizer_args`] on Windows so ambient mux config cannot leak in.
//!
//! Deferred, by design: the non-bootstrap signed `.app` scp staging path, askpass/password-pipe
//! authentication, and onboarding recovery. Those paths must not be faked in the native port.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config;
use crate::platform::{self, Os};
use crate::remote_quote;
use crate::transport::{Output, Transport};

const USAGE: &str =
    "install-host [--host <addr>] [--account <user>] [--force] [--bootstrap --sha256 <hex> --ref <r>]";
const DEFAULT_APP_NAME: &str = "XpairHost";
const DEFAULT_BUNDLE_PREFIX: &str = "com.x10lab.xpair-host";
const DEFAULT_GH_REPO: &str = "x10lab/xpair";
const DEFAULT_REF: &str = "main";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallReq {
    pub host: String,
    pub account: Option<String>,
    pub bootstrap: bool,
    pub sha256: Option<String>,
    pub git_ref: String,
    pub force: bool,
}

impl InstallReq {
    pub fn target(&self) -> String {
        match self
            .account
            .as_deref()
            .filter(|account| !account.is_empty())
        {
            Some(account) => format!("{account}@{}", self.host),
            None => self.host.clone(),
        }
    }
}

/// Parse `install-host` args with the bash exit-code contract.
///
/// `--host` defaults from `REMOTE_HOST`, matching the sourced-env bash command path.
pub fn parse_install_args(args: &[String]) -> Result<InstallReq, (String, u8)> {
    parse_install_args_with_default_host(args, non_empty_env("REMOTE_HOST").as_deref())
}

fn parse_install_args_with_default_host(
    args: &[String],
    default_host: Option<&str>,
) -> Result<InstallReq, (String, u8)> {
    let mut host = default_host.unwrap_or_default().to_string();
    let mut account = None;
    let mut bootstrap = false;
    let mut sha256 = None;
    let mut git_ref = DEFAULT_REF.to_string();
    let mut force = false;
    let mut idx = 0;

    while idx < args.len() {
        match args[idx].as_str() {
            "--host" => {
                let Some(value) = args.get(idx + 1) else {
                    return Err((USAGE.to_string(), 2));
                };
                host = value.clone();
                idx += 2;
            }
            "--account" => {
                let Some(value) = args.get(idx + 1) else {
                    return Err((USAGE.to_string(), 2));
                };
                account = if value.is_empty() {
                    None
                } else {
                    Some(value.clone())
                };
                idx += 2;
            }
            "--bootstrap" => {
                bootstrap = true;
                idx += 1;
            }
            "--sha256" => {
                let Some(value) = args.get(idx + 1) else {
                    return Err((USAGE.to_string(), 2));
                };
                sha256 = Some(value.clone());
                idx += 2;
            }
            "--ref" => {
                let Some(value) = args.get(idx + 1) else {
                    return Err((USAGE.to_string(), 2));
                };
                git_ref = if value.is_empty() {
                    DEFAULT_REF.to_string()
                } else {
                    value.clone()
                };
                idx += 2;
            }
            "--force" => {
                force = true;
                idx += 1;
            }
            _ => return Err((USAGE.to_string(), 2)),
        }
    }

    if host.is_empty() {
        return Err((
            "install-host requires --host (or a configured REMOTE_HOST)".to_string(),
            2,
        ));
    }
    normalize_user_qualified_host(&mut host, &mut account);
    if bootstrap && sha256.as_deref().unwrap_or_default().is_empty() {
        return Err((
            "--bootstrap requires --sha256 <hex> (no unverified curl|bash)".to_string(),
            2,
        ));
    }

    Ok(InstallReq {
        host,
        account,
        bootstrap,
        sha256,
        git_ref,
        force,
    })
}

pub fn build_idempotency_probe_cmd(app: &str) -> String {
    format!("[ -d ~/Applications/{app}.app ] || [ -d /Applications/{app}.app ]")
}

pub fn build_reregister_cmd(bundle: &str, app: &str) -> String {
    format!("pkill -f /{app}.app/Contents/MacOS/{app} 2>/dev/null; sleep 1; launchctl kickstart -k gui/$(id -u)/{bundle} 2>/dev/null || open -a {app} 2>/dev/null || true")
}

pub fn build_bootstrap_remote_invocation(git_ref: &str) -> String {
    let branch = if shell_assignment_safe(git_ref) {
        git_ref.to_string()
    } else {
        remote_quote::posix_single_quote(git_ref)
    };
    format!("ROLE=host BRANCH={branch} bash -s")
}

pub fn build_authorize_key_cmd() -> String {
    r#"umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys; key=$(cat); grep -qxF "$key" ~/.ssh/authorized_keys || printf "%s\n" "$key" >> ~/.ssh/authorized_keys"#.to_string()
}

pub fn build_ssh_config_block(host: &str, hostname: &str, user: &str, identity: &str) -> String {
    format!(
        concat!(
            "# >>> xpair: {host} >>>\n",
            "Host {host}\n",
            "  HostName {hostname}\n",
            "  User {user}\n",
            "  IdentityFile {identity}\n",
            "  AddKeysToAgent yes\n",
            "  UseKeychain yes\n",
            "  HostKeyAlgorithms ssh-ed25519\n",
            "# <<< xpair: {host} <<<\n"
        ),
        host = host,
        hostname = hostname,
        user = user,
        identity = identity
    )
}

pub fn verify_sha256(expected: &str, actual: &str) -> bool {
    !expected.trim().is_empty() && expected.trim().eq_ignore_ascii_case(actual.trim())
}

pub fn build_bootstrap_url(repo: &str, git_ref: &str) -> String {
    format!("https://raw.githubusercontent.com/{repo}/{git_ref}/shared/bootstrap.sh")
}

/// Runtime shims for local I/O that the pure command core must not hide.
pub trait InstallIo {
    fn fetch_bootstrap_to(&self, url: &str, dest: &Path) -> io::Result<()>;
    fn sha256_file(&self, path: &Path) -> io::Result<String>;
    fn ensure_pubkey(&self, home: &Path) -> io::Result<String>;
    fn write_ssh_config_block(&self, path: &Path, host: &str, block: &str) -> io::Result<()>;
}

pub struct LocalInstallIo;

impl InstallIo for LocalInstallIo {
    fn fetch_bootstrap_to(&self, url: &str, dest: &Path) -> io::Result<()> {
        // Thin fetch shim: std has no HTTPS client and the crate is dependency-free.
        let status = Command::new("curl")
            .arg("-fsSL")
            .arg(url)
            .arg("-o")
            .arg(dest)
            .stdin(Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other("curl failed"))
        }
    }

    fn sha256_file(&self, path: &Path) -> io::Result<String> {
        // Thin hash shim: keep the port dependency-free instead of adding a SHA256 crate.
        sha256_file_via_command(path)
    }

    fn ensure_pubkey(&self, home: &Path) -> io::Result<String> {
        let ssh_dir = home.join(".ssh");
        let key = ssh_dir.join("id_ed25519");
        let pubkey = ssh_dir.join("id_ed25519.pub");

        if !pubkey.is_file() {
            fs::create_dir_all(&ssh_dir)?;
            let status = Command::new("ssh-keygen")
                .arg("-t")
                .arg("ed25519")
                .arg("-f")
                .arg(&key)
                .arg("-N")
                .arg("")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()?;
            if !status.success() {
                return Err(io::Error::other("ssh-keygen failed"));
            }
        }

        let pubdata = fs::read_to_string(&pubkey)?;
        let pubdata = pubdata.trim_end_matches(['\r', '\n']).to_string();
        if pubdata.is_empty() {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("empty client pubkey: {}", path_string(pubkey)),
            ))
        } else {
            Ok(pubdata)
        }
    }

    fn write_ssh_config_block(&self, path: &Path, host: &str, block: &str) -> io::Result<()> {
        upsert_ssh_config_block(path, host, block)
    }
}

/// CLI entrypoint for `xpair install-host`.
pub fn run(args: &[String]) -> ExitCode {
    let client_env_path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair install-host: {err}");
            return ExitCode::from(2);
        }
    };

    let os = Os::current();
    let transport = SshTransport { os };
    let io = LocalInstallIo;
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();

    run_with_transport(
        args,
        &client_env_path,
        &transport,
        &io,
        &mut stdout,
        &mut stderr,
    )
}

pub fn run_with_transport<T, I, W, E>(
    args: &[String],
    client_env_path: &Path,
    transport: &T,
    io: &I,
    out: &mut W,
    err: &mut E,
) -> ExitCode
where
    T: Transport + ?Sized,
    I: InstallIo + ?Sized,
    W: Write,
    E: Write,
{
    let default_host = match resolve_host(client_env_path) {
        Ok(host) => host,
        Err(error) => {
            let _ = writeln!(err, "xpair install-host: {error}");
            return ExitCode::from(1);
        }
    };
    let req = match parse_install_args_with_default_host(args, Some(&default_host)) {
        Ok(req) => req,
        Err((message, code)) => {
            let _ = writeln!(err, "{message}");
            return ExitCode::from(code);
        }
    };

    let settings = RuntimeSettings::load(client_env_path);
    let target = req.target();

    if !req.force {
        let probe_cmd = build_idempotency_probe_cmd(&settings.app_name);
        let installed = match transport.ssh_exec(&target, &probe_cmd) {
            Ok(output) => output.code == 0,
            Err(error) => {
                let _ = writeln!(err, "xpair install-host: idempotency probe failed: {error}");
                return ExitCode::from(1);
            }
        };

        if installed {
            let reregister_cmd = build_reregister_cmd(&settings.bundle_prefix, &settings.app_name);
            let _ = transport.ssh_exec(&target, &reregister_cmd);
            return finish_install(&req, &settings, client_env_path, transport, io, out, err);
        }
    }

    if req.bootstrap {
        if let Err(code) = run_bootstrap_install(&req, &settings, &target, transport, io, err) {
            return code;
        }
    } else {
        // DEFERRED: the bash path at `client/cli/xpair:1934-1961` stages a signed `.app`
        // with scp plus shared install resources. The native port has no portable signed-app
        // staging flow yet, and must not fake a host install.
        let _ = writeln!(
            err,
            "install-host: non-bootstrap signed-app install is not ported in the native client; use --bootstrap --sha256 <hex> on this platform"
        );
        return ExitCode::from(1);
    }

    finish_install(&req, &settings, client_env_path, transport, io, out, err)
}

fn run_bootstrap_install<T, I, E>(
    req: &InstallReq,
    settings: &RuntimeSettings,
    target: &str,
    transport: &T,
    io: &I,
    err: &mut E,
) -> Result<(), ExitCode>
where
    T: Transport + ?Sized,
    I: InstallIo + ?Sized,
    E: Write,
{
    let expected = req.sha256.as_deref().unwrap_or_default();
    let url = build_bootstrap_url(&settings.gh_repo, &req.git_ref);
    let path = temp_bootstrap_path();

    let cleanup = |path: &Path| {
        let _ = fs::remove_file(path);
    };

    if let Err(error) = io.fetch_bootstrap_to(&url, &path) {
        cleanup(&path);
        let _ = writeln!(err, "bootstrap fetch failed: {error}");
        return Err(ExitCode::from(1));
    }

    let actual = match io.sha256_file(&path) {
        Ok(actual) => actual,
        Err(error) => {
            cleanup(&path);
            let _ = writeln!(err, "SHA256 computation failed: {error}");
            return Err(ExitCode::from(1));
        }
    };

    if !verify_sha256(expected, &actual) {
        cleanup(&path);
        let _ = writeln!(
            err,
            "SHA256 mismatch - aborting before remote bootstrap exec (expected {expected}, got {actual})"
        );
        return Err(ExitCode::from(1));
    }

    let script = match fs::read_to_string(&path) {
        Ok(script) => script,
        Err(error) => {
            cleanup(&path);
            let _ = writeln!(err, "bootstrap read failed: {error}");
            return Err(ExitCode::from(1));
        }
    };
    cleanup(&path);

    let remote_cmd = build_bootstrap_remote_script_cmd(&req.git_ref, &script);
    match transport.ssh_exec(target, &remote_cmd) {
        Ok(Output { code: 0, .. }) => Ok(()),
        Ok(Output { code, .. }) => {
            let _ = writeln!(err, "remote bootstrap failed (exit={code})");
            Err(ExitCode::from(1))
        }
        Err(error) => {
            let _ = writeln!(err, "remote bootstrap failed: {error}");
            Err(ExitCode::from(1))
        }
    }
}

fn finish_install<T, I, W, E>(
    req: &InstallReq,
    settings: &RuntimeSettings,
    client_env_path: &Path,
    transport: &T,
    io: &I,
    out: &mut W,
    err: &mut E,
) -> ExitCode
where
    T: Transport + ?Sized,
    I: InstallIo + ?Sized,
    W: Write,
    E: Write,
{
    let target = req.target();
    let pubkey = match io.ensure_pubkey(&settings.home_dir) {
        Ok(pubkey) => pubkey,
        Err(error) => {
            let _ = writeln!(err, "could not resolve client pubkey: {error}");
            return ExitCode::from(1);
        }
    };

    let auth_cmd = build_authorize_key_pipe_cmd(&pubkey);
    match transport.ssh_exec(&target, &auth_cmd) {
        Ok(Output { code: 0, .. }) => {}
        Ok(Output { code, .. }) => {
            let _ = writeln!(
                err,
                "failed to authorize client key on {target} (exit={code})"
            );
            return ExitCode::from(1);
        }
        Err(error) => {
            let _ = writeln!(err, "failed to authorize client key on {target}: {error}");
            return ExitCode::from(1);
        }
    }

    let cfg_user = match req.account.as_deref().filter(|account| !account.is_empty()) {
        Some(account) => Some(account.to_string()),
        None => resolve_remote_user(transport, &target),
    };

    if let Some(user) = cfg_user.filter(|user| !user.is_empty()) {
        let identity = path_string(&settings.identity_path);
        let block = build_ssh_config_block(&req.host, &req.host, &user, &identity);
        if let Err(error) = io.write_ssh_config_block(&settings.ssh_config_path, &req.host, &block)
        {
            let _ = writeln!(
                err,
                "managed SSH config update failed for {}: {error}",
                req.host
            );
        }
    } else {
        let _ = writeln!(
            err,
            "could not determine host user; managed SSH config was not updated"
        );
    }

    if let Err(error) = config::set(client_env_path, "REMOTE_HOST", &req.host) {
        let _ = writeln!(err, "failed to persist REMOTE_HOST: {error}");
        return ExitCode::from(1);
    }

    let _ = writeln!(out, "host set: {}", req.host);
    ExitCode::SUCCESS
}

fn resolve_remote_user<T: Transport + ?Sized>(transport: &T, target: &str) -> Option<String> {
    transport
        .ssh_exec(target, "id -un 2>/dev/null || whoami")
        .ok()
        .filter(|output| output.code == 0)
        .map(|output| output.stdout.trim_matches(['\r', '\n']).to_string())
        .filter(|user| !user.is_empty())
}

fn build_authorize_key_pipe_cmd(pubkey: &str) -> String {
    format!(
        "printf '%s\\n' {} | {{ {}; }}",
        remote_quote::posix_single_quote(pubkey),
        build_authorize_key_cmd()
    )
}

fn build_bootstrap_remote_script_cmd(git_ref: &str, script: &str) -> String {
    let delimiter = heredoc_delimiter(script);
    let mut cmd = build_bootstrap_remote_invocation(git_ref);
    cmd.push_str(" <<'");
    cmd.push_str(&delimiter);
    cmd.push_str("'\n");
    cmd.push_str(script);
    if !script.ends_with('\n') {
        cmd.push('\n');
    }
    cmd.push_str(&delimiter);
    cmd.push('\n');
    cmd
}

fn heredoc_delimiter(script: &str) -> String {
    let base = "__XPAIR_BOOTSTRAP__";
    if !script.contains(base) {
        return base.to_string();
    }

    for idx in 0.. {
        let candidate = format!("{base}_{idx}");
        if !script.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("unbounded delimiter search always returns")
}

fn shell_assignment_safe(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
}

fn normalize_user_qualified_host(host: &mut String, account: &mut Option<String>) {
    let Some((user, bare_host)) = host.split_once('@') else {
        return;
    };
    if account.as_deref().unwrap_or_default().is_empty() {
        *account = Some(user.to_string());
    }
    *host = bare_host.to_string();
}

fn resolve_host(client_env_path: &Path) -> io::Result<String> {
    if let Some(host) = non_empty_env("REMOTE_HOST") {
        return Ok(host);
    }
    Ok(config::get(client_env_path, "REMOTE_HOST")?.unwrap_or_default())
}

struct RuntimeSettings {
    app_name: String,
    bundle_prefix: String,
    gh_repo: String,
    home_dir: PathBuf,
    identity_path: PathBuf,
    ssh_config_path: PathBuf,
}

impl RuntimeSettings {
    fn load(client_env_path: &Path) -> RuntimeSettings {
        let home_dir = home_dir().unwrap_or_else(|| PathBuf::from("."));
        let identity_path = home_dir.join(".ssh").join("id_ed25519");
        let ssh_config_path = non_empty_value(client_env_path, "RP_SSH_CFG")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join(".ssh").join("config"));

        RuntimeSettings {
            app_name: setting(client_env_path, "APP_NAME", DEFAULT_APP_NAME),
            bundle_prefix: setting(client_env_path, "BUNDLE_PREFIX", DEFAULT_BUNDLE_PREFIX),
            gh_repo: setting(client_env_path, "GH_REPO", DEFAULT_GH_REPO),
            home_dir,
            identity_path,
            ssh_config_path,
        }
    }
}

fn setting(client_env_path: &Path, key: &str, default: &str) -> String {
    non_empty_value(client_env_path, key).unwrap_or_else(|| default.to_string())
}

fn non_empty_value(client_env_path: &Path, key: &str) -> Option<String> {
    non_empty_env(key).or_else(|| {
        config::get(client_env_path, key)
            .ok()
            .flatten()
            .filter(|value| !value.is_empty())
    })
}

fn temp_bootstrap_path() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("xpair-bootstrap-{}-{nonce}.sh", std::process::id()))
}

fn upsert_ssh_config_block(path: &Path, host: &str, block: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let begin = format!("# >>> xpair: {host} >>>");
    let end = format!("# <<< xpair: {host} <<<");
    let existing = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };

    let mut out = String::new();
    let mut skip = false;
    for line in existing.lines() {
        if line == begin {
            skip = true;
            continue;
        }
        if line == end {
            skip = false;
            continue;
        }
        if !skip {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push_str(block);
    fs::write(path, out)
}

#[cfg(windows)]
fn sha256_file_via_command(path: &Path) -> io::Result<String> {
    let output = Command::new("certutil")
        .arg("-hashfile")
        .arg(path)
        .arg("SHA256")
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other("certutil failed"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| line.len() == 64 && line.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_string)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "could not parse certutil SHA256",
            )
        })
}

#[cfg(not(windows))]
fn sha256_file_via_command(path: &Path) -> io::Result<String> {
    let output = Command::new("shasum")
        .arg("-a")
        .arg("256")
        .arg(path)
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other("shasum failed"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .split_whitespace()
        .next()
        .map(str::to_string)
        .filter(|hash| hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "could not parse shasum SHA256"))
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

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

struct SshTransport {
    os: platform::Os,
}

impl Transport for SshTransport {
    fn ssh_exec(&self, host: &str, remote_cmd: &str) -> io::Result<Output> {
        let output = Command::new("ssh")
            .args(self.os.ssh_mux_neutralizer_args())
            .args([
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=8",
                "-o",
                "ConnectionAttempts=1",
                "-o",
                "StrictHostKeyChecking=accept-new",
            ])
            .arg(host)
            .arg(remote_cmd)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()?;

        Ok(Output {
            code: output.status.code().unwrap_or(255),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MockTransport;
    use std::cell::RefCell;
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "xpair-install-host-test-{}-{id}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir(&path).unwrap();
            TestDir { path }
        }

        fn client_env_path(&self) -> PathBuf {
            self.path.join("client.env")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

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
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = EnvGuard::set(values);
        f()
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[derive(Default)]
    struct FakeInstallIo {
        script: String,
        hash: String,
        pubkey: String,
        fetched_urls: RefCell<Vec<String>>,
        ssh_config_writes: RefCell<Vec<(String, String, String)>>,
    }

    impl FakeInstallIo {
        fn new(script: &str, hash: &str, pubkey: &str) -> FakeInstallIo {
            FakeInstallIo {
                script: script.to_string(),
                hash: hash.to_string(),
                pubkey: pubkey.to_string(),
                fetched_urls: RefCell::new(Vec::new()),
                ssh_config_writes: RefCell::new(Vec::new()),
            }
        }
    }

    impl InstallIo for FakeInstallIo {
        fn fetch_bootstrap_to(&self, url: &str, dest: &Path) -> io::Result<()> {
            self.fetched_urls.borrow_mut().push(url.to_string());
            fs::write(dest, &self.script)
        }

        fn sha256_file(&self, _path: &Path) -> io::Result<String> {
            Ok(self.hash.clone())
        }

        fn ensure_pubkey(&self, _home: &Path) -> io::Result<String> {
            Ok(self.pubkey.clone())
        }

        fn write_ssh_config_block(&self, path: &Path, host: &str, block: &str) -> io::Result<()> {
            self.ssh_config_writes.borrow_mut().push((
                path_string(path),
                host.to_string(),
                block.to_string(),
            ));
            Ok(())
        }
    }

    #[test]
    fn parse_all_flags() {
        with_env(&[("REMOTE_HOST", None)], || {
            let req = parse_install_args(&strings(&[
                "--host",
                "mac-mini",
                "--account",
                "alice",
                "--bootstrap",
                "--sha256",
                "abc123",
                "--ref",
                "release/v1",
                "--force",
            ]))
            .unwrap();

            assert_eq!(
                req,
                InstallReq {
                    host: "mac-mini".to_string(),
                    account: Some("alice".to_string()),
                    bootstrap: true,
                    sha256: Some("abc123".to_string()),
                    git_ref: "release/v1".to_string(),
                    force: true,
                }
            );
        });
    }

    #[test]
    fn parse_defaults_host_from_remote_host() {
        with_env(&[("REMOTE_HOST", Some("env-host"))], || {
            let req = parse_install_args(&strings(&["--bootstrap", "--sha256", "abc"])).unwrap();

            assert_eq!(req.host, "env-host");
            assert_eq!(req.git_ref, DEFAULT_REF);
        });
    }

    #[test]
    fn parse_bootstrap_without_sha_exits_2() {
        with_env(&[("REMOTE_HOST", None)], || {
            assert_eq!(
                parse_install_args(&strings(&["--host", "mac", "--bootstrap"])),
                Err((
                    "--bootstrap requires --sha256 <hex> (no unverified curl|bash)".to_string(),
                    2
                ))
            );
        });
    }

    #[test]
    fn parse_no_host_exits_2() {
        with_env(&[("REMOTE_HOST", None)], || {
            assert_eq!(
                parse_install_args(&[]),
                Err((
                    "install-host requires --host (or a configured REMOTE_HOST)".to_string(),
                    2
                ))
            );
        });
    }

    #[test]
    fn target_uses_account_when_present() {
        let req = InstallReq {
            host: "mac".to_string(),
            account: Some("alice".to_string()),
            bootstrap: false,
            sha256: None,
            git_ref: DEFAULT_REF.to_string(),
            force: false,
        };
        assert_eq!(req.target(), "alice@mac");

        let mut without_account = req.clone();
        without_account.account = None;
        assert_eq!(without_account.target(), "mac");
    }

    #[test]
    fn parse_splits_user_qualified_host_into_account() {
        with_env(&[("REMOTE_HOST", None)], || {
            let req = parse_install_args(&strings(&[
                "--host",
                "alice@mac-mini",
                "--bootstrap",
                "--sha256",
                "abc",
            ]))
            .unwrap();

            assert_eq!(req.host, "mac-mini");
            assert_eq!(req.account.as_deref(), Some("alice"));
            assert_eq!(req.target(), "alice@mac-mini");
        });
    }

    #[test]
    fn explicit_account_wins_over_user_qualified_host() {
        with_env(&[("REMOTE_HOST", None)], || {
            let req = parse_install_args(&strings(&[
                "--host",
                "alice@mac-mini",
                "--account",
                "bob",
                "--bootstrap",
                "--sha256",
                "abc",
            ]))
            .unwrap();

            assert_eq!(req.host, "mac-mini");
            assert_eq!(req.account.as_deref(), Some("bob"));
            assert_eq!(req.target(), "bob@mac-mini");
        });
    }

    #[test]
    fn builds_commands_and_config_block_exactly() {
        assert_eq!(
            build_idempotency_probe_cmd("XpairHost"),
            "[ -d ~/Applications/XpairHost.app ] || [ -d /Applications/XpairHost.app ]"
        );
        assert_eq!(
            build_reregister_cmd("com.x10lab.xpair-host", "XpairHost"),
            "pkill -f /XpairHost.app/Contents/MacOS/XpairHost 2>/dev/null; sleep 1; launchctl kickstart -k gui/$(id -u)/com.x10lab.xpair-host 2>/dev/null || open -a XpairHost 2>/dev/null || true"
        );
        assert_eq!(
            build_bootstrap_remote_invocation("main"),
            "ROLE=host BRANCH=main bash -s"
        );
        assert_eq!(
            build_authorize_key_cmd(),
            r#"umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys; key=$(cat); grep -qxF "$key" ~/.ssh/authorized_keys || printf "%s\n" "$key" >> ~/.ssh/authorized_keys"#
        );
        assert_eq!(
            build_ssh_config_block(
                "mac-mini",
                "192.0.2.10",
                "alice",
                "/Users/me/.ssh/id_ed25519"
            ),
            "# >>> xpair: mac-mini >>>\nHost mac-mini\n  HostName 192.0.2.10\n  User alice\n  IdentityFile /Users/me/.ssh/id_ed25519\n  AddKeysToAgent yes\n  UseKeychain yes\n  HostKeyAlgorithms ssh-ed25519\n# <<< xpair: mac-mini <<<\n"
        );
    }

    #[test]
    fn verify_sha256_trims_and_ignores_case() {
        assert!(verify_sha256("ABCDEF\n", "abcdef"));
        assert!(!verify_sha256("abcdef", "123456"));
        assert!(!verify_sha256("", ""));
    }

    #[test]
    fn installed_path_reregisters_authorizes_and_writes_config() {
        with_env(
            &[
                ("REMOTE_HOST", None),
                ("GH_REPO", None),
                ("APP_NAME", None),
                ("BUNDLE_PREFIX", None),
                ("RP_SSH_CFG", None),
                ("HOME", Some("C:/Users/tester")),
                ("USERPROFILE", None),
            ],
            || {
                let tmp = TestDir::new("installed");
                let transport = MockTransport::new();
                transport.push_response(0, "");
                transport.push_response(0, "");
                transport.push_response(0, "");
                let io = FakeInstallIo::new("", "", "ssh-ed25519 AAAATEST tester");
                let mut out = Vec::new();
                let mut err = Vec::new();

                let code = run_with_transport(
                    &strings(&["--host", "mac-mini", "--account", "alice"]),
                    &tmp.client_env_path(),
                    &transport,
                    &io,
                    &mut out,
                    &mut err,
                );

                assert_eq!(code, ExitCode::SUCCESS);
                assert_eq!(String::from_utf8(err).unwrap(), "");
                assert_eq!(String::from_utf8(out).unwrap(), "host set: mac-mini\n");
                let calls = transport.calls();
                assert_eq!(calls.len(), 3);
                assert_eq!(calls[0].host, "alice@mac-mini");
                assert_eq!(
                    calls[0].remote_cmd,
                    build_idempotency_probe_cmd(DEFAULT_APP_NAME)
                );
                assert_eq!(
                    calls[1].remote_cmd,
                    build_reregister_cmd(DEFAULT_BUNDLE_PREFIX, DEFAULT_APP_NAME)
                );
                assert_eq!(
                    calls[2].remote_cmd,
                    build_authorize_key_pipe_cmd("ssh-ed25519 AAAATEST tester")
                );
                assert_eq!(
                    io.ssh_config_writes.borrow().as_slice(),
                    [(
                        path_string(PathBuf::from("C:/Users/tester").join(".ssh").join("config")),
                        "mac-mini".to_string(),
                        build_ssh_config_block(
                            "mac-mini",
                            "mac-mini",
                            "alice",
                            &path_string(
                                PathBuf::from("C:/Users/tester")
                                    .join(".ssh")
                                    .join("id_ed25519")
                            ),
                        )
                    )]
                );
                assert_eq!(
                    config::get(tmp.client_env_path(), "REMOTE_HOST").unwrap(),
                    Some("mac-mini".to_string())
                );
            },
        );
    }

    #[test]
    fn not_installed_bootstrap_path_fetches_verifies_runs_and_authorizes() {
        with_env(
            &[
                ("REMOTE_HOST", None),
                ("GH_REPO", None),
                ("APP_NAME", None),
                ("BUNDLE_PREFIX", None),
                ("RP_SSH_CFG", None),
                ("HOME", Some("C:/Users/tester")),
                ("USERPROFILE", None),
            ],
            || {
                let tmp = TestDir::new("bootstrap");
                let expected_hash =
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
                let script = "echo bootstrap\n";
                let transport = MockTransport::new();
                transport.push_response(1, "");
                transport.push_response(0, "");
                transport.push_response(0, "");
                let io = FakeInstallIo::new(script, expected_hash, "ssh-ed25519 AAAATEST tester");
                let mut out = Vec::new();
                let mut err = Vec::new();

                let code = run_with_transport(
                    &strings(&[
                        "--host",
                        "mac-mini",
                        "--account",
                        "alice",
                        "--bootstrap",
                        "--sha256",
                        expected_hash,
                    ]),
                    &tmp.client_env_path(),
                    &transport,
                    &io,
                    &mut out,
                    &mut err,
                );

                assert_eq!(code, ExitCode::SUCCESS);
                assert_eq!(String::from_utf8(err).unwrap(), "");
                assert_eq!(
                    io.fetched_urls.borrow().as_slice(),
                    ["https://raw.githubusercontent.com/x10lab/xpair/main/shared/bootstrap.sh"]
                );
                let calls = transport.calls();
                assert_eq!(calls.len(), 3);
                assert_eq!(
                    calls[0].remote_cmd,
                    build_idempotency_probe_cmd(DEFAULT_APP_NAME)
                );
                assert_eq!(
                    calls[1].remote_cmd,
                    "ROLE=host BRANCH=main bash -s <<'__XPAIR_BOOTSTRAP__'\necho bootstrap\n__XPAIR_BOOTSTRAP__\n"
                );
                assert_eq!(
                    calls[2].remote_cmd,
                    build_authorize_key_pipe_cmd("ssh-ed25519 AAAATEST tester")
                );
                assert_eq!(String::from_utf8(out).unwrap(), "host set: mac-mini\n");
            },
        );
    }

    #[test]
    fn sha_mismatch_aborts_before_remote_bootstrap() {
        with_env(
            &[
                ("REMOTE_HOST", None),
                ("GH_REPO", None),
                ("HOME", Some("C:/Users/tester")),
                ("USERPROFILE", None),
            ],
            || {
                let tmp = TestDir::new("sha-mismatch");
                let transport = MockTransport::new();
                transport.push_response(1, "");
                let io = FakeInstallIo::new("echo bootstrap\n", "bad", "ssh-ed25519 AAAATEST");
                let mut out = Vec::new();
                let mut err = Vec::new();

                let code = run_with_transport(
                    &strings(&[
                        "--host",
                        "mac-mini",
                        "--account",
                        "alice",
                        "--bootstrap",
                        "--sha256",
                        "good",
                    ]),
                    &tmp.client_env_path(),
                    &transport,
                    &io,
                    &mut out,
                    &mut err,
                );

                assert_eq!(code, ExitCode::from(1));
                assert_eq!(transport.calls().len(), 1);
                assert_eq!(String::from_utf8(out).unwrap(), "");
                assert!(String::from_utf8(err)
                    .unwrap()
                    .contains("SHA256 mismatch - aborting before remote bootstrap exec"));
            },
        );
    }

    #[test]
    fn non_bootstrap_uninstalled_path_is_deferred() {
        with_env(
            &[("REMOTE_HOST", None), ("HOME", Some("C:/Users/tester"))],
            || {
                let tmp = TestDir::new("deferred");
                let transport = MockTransport::new();
                transport.push_response(1, "");
                let io = FakeInstallIo::new("", "", "ssh-ed25519 AAAATEST");
                let mut out = Vec::new();
                let mut err = Vec::new();

                let code = run_with_transport(
                    &strings(&["--host", "mac-mini", "--account", "alice"]),
                    &tmp.client_env_path(),
                    &transport,
                    &io,
                    &mut out,
                    &mut err,
                );

                assert_eq!(code, ExitCode::from(1));
                assert_eq!(transport.calls().len(), 1);
                assert_eq!(
                    transport.calls()[0].remote_cmd,
                    build_idempotency_probe_cmd(DEFAULT_APP_NAME)
                );
                assert_eq!(String::from_utf8(out).unwrap(), "");
                assert!(String::from_utf8(err)
                    .unwrap()
                    .contains("use --bootstrap --sha256 <hex> on this platform"));
            },
        );
    }
}
