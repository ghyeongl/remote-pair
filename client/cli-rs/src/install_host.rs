//! `xpair install-host` command construction and bootstrap orchestration.
//!
//! C1 divergence from `client/cli/xpair:1824-1831`: bash multiplexes the whole install over
//! one SSH master (`ControlMaster`/`ControlPath`/`ControlPersist`). Win32-OpenSSH cannot use
//! that model, so this Rust port intentionally runs every host step as an independent
//! [`Transport::ssh_exec`] call. The real transport passes
//! [`platform::Os::ssh_mux_neutralizer_args`] on Windows so ambient mux config cannot leak in.
//!
//! Divergence from bash's non-bootstrap path: a native client may not have a bundled signed
//! macOS `.app` to stage, so the host downloads the release `XpairHost.zip` artifact itself and
//! installs it over SSH. The `--bootstrap` path remains the pinned script path.

use std::cell::Cell;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config;
use crate::platform::{self, Os};
use crate::remote_quote;
use crate::transport::{AuthOutput, Output, Transport};

const USAGE: &str =
    "install-host [--host <addr>] [--account <user>] [--password-stdin] [--force] [--bootstrap --sha256 <hex> --ref <r>]";
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
    pub password_stdin: bool,
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
    let mut password_stdin = false;
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
            "--password-stdin" => {
                password_stdin = true;
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
    let target = match account.as_deref().filter(|account| !account.is_empty()) {
        Some(account) => format!("{account}@{host}"),
        None => host.clone(),
    };
    if !config::valid_host(&target) {
        return Err((format!("invalid host: {target}"), 2));
    }
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
        password_stdin,
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
    build_ssh_config_block_for_os(Os::Mac, host, hostname, user, identity)
}

pub fn build_ssh_config_block_for_os(
    os: Os,
    host: &str,
    hostname: &str,
    user: &str,
    identity: &str,
) -> String {
    let keychain = if os == Os::Mac {
        "  IgnoreUnknown UseKeychain\n  UseKeychain yes\n"
    } else {
        ""
    };
    let identity = quote_ssh_config_path(identity);
    format!(
        concat!(
            "# >>> xpair: {host} >>>\n",
            "Host {host}\n",
            "  HostName {hostname}\n",
            "  User {user}\n",
            "  IdentityFile {identity}\n",
            "  AddKeysToAgent yes\n",
            "{keychain}",
            "  HostKeyAlgorithms ssh-ed25519\n",
            "# <<< xpair: {host} <<<\n"
        ),
        host = host,
        hostname = hostname,
        user = user,
        identity = identity,
        keychain = keychain
    )
}

fn quote_ssh_config_path(path: &str) -> String {
    let mut out = String::from("\"");
    for ch in path.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
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
    let default_host = match resolve_host(&client_env_path) {
        Ok(host) => host,
        Err(error) => {
            eprintln!("xpair install-host: {error}");
            return ExitCode::from(1);
        }
    };
    let req = match parse_install_args_with_default_host(args, Some(&default_host)) {
        Ok(req) => req,
        Err((message, code)) => {
            eprintln!("{message}");
            return ExitCode::from(code);
        }
    };
    let settings = RuntimeSettings::load(&client_env_path);
    let askpass = if req.password_stdin {
        let password = match read_password_line() {
            Ok(password) if !password.is_empty() => password,
            Ok(_) => {
                eprintln!("empty password on stdin");
                return ExitCode::from(2);
            }
            Err(error) => {
                eprintln!("failed to read password from stdin: {error}");
                return ExitCode::from(2);
            }
        };
        let preflight_io = LocalInstallIo;
        if let Err(error) = preflight_io.ensure_pubkey(&settings.home_dir) {
            eprintln!("could not ensure client pubkey: {error}");
            return ExitCode::from(1);
        }
        match AskpassTemp::create(&password) {
            Ok(helper) => Some(helper),
            Err(error) => {
                eprintln!("install-host: askpass setup failed: {error}");
                return ExitCode::from(1);
            }
        }
    } else {
        None
    };

    let os = Os::current();
    let transport = SshTransport::new(os, &settings, askpass.as_ref());
    let io = LocalInstallIo;
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();

    let code = run_parsed_with_transport(
        &req,
        &settings,
        &client_env_path,
        &transport,
        &io,
        &mut stdout,
        &mut stderr,
    );
    transport.cleanup(&req.target());
    code
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
    run_parsed_with_transport(&req, &settings, client_env_path, transport, io, out, err)
}

fn run_parsed_with_transport<T, I, W, E>(
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
    if req.password_stdin {
        let _ = writeln!(
            out,
            "authenticating to {target} with the supplied account password …"
        );
        match transport.ssh_auth_probe(&target, "true") {
            Ok(AuthOutput {
                code: 0,
                stdout: _,
                stderr: _,
            }) => transport.retire_password_auth(),
            Ok(AuthOutput {
                code: _,
                stdout,
                stderr,
            }) => {
                let combined = format!("{stdout}\n{stderr}");
                if contains_auth_denied(&combined) {
                    let _ = writeln!(err, "PASSWORD_DENIED: account password denied for {target}");
                    return ExitCode::from(7);
                }
                let detail = combined.trim();
                if detail.is_empty() {
                    let _ = writeln!(err, "password bootstrap failed for {target}: ssh failed");
                } else {
                    let _ = writeln!(err, "password bootstrap failed for {target}: {detail}");
                }
                return ExitCode::from(1);
            }
            Err(error) => {
                let _ = writeln!(err, "password bootstrap failed for {target}: {error}");
                return ExitCode::from(1);
            }
        }
    }

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
            return finish_install(req, settings, client_env_path, transport, io, out, err);
        }
    }

    if req.bootstrap {
        if let Err(code) = run_bootstrap_install(req, settings, &target, transport, io, err) {
            return code;
        }
    } else {
        if let Err(code) = run_release_download_install(settings, &target, transport, err) {
            return code;
        }
    }

    finish_install(req, settings, client_env_path, transport, io, out, err)
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

fn run_release_download_install<T, E>(
    settings: &RuntimeSettings,
    target: &str,
    transport: &T,
    err: &mut E,
) -> Result<(), ExitCode>
where
    T: Transport + ?Sized,
    E: Write,
{
    let remote_cmd = build_release_download_install_remote_cmd(settings);
    match transport.ssh_exec(target, &remote_cmd) {
        Ok(Output { code: 0, .. }) => Ok(()),
        Ok(Output { code, stdout }) => {
            let detail = stdout.trim();
            if detail.is_empty() {
                let _ = writeln!(err, "release install failed (exit={code})");
            } else {
                let _ = writeln!(err, "release install failed (exit={code})\n{detail}");
            }
            Err(ExitCode::from(1))
        }
        Err(error) => {
            let _ = writeln!(err, "release install failed: {error}");
            Err(ExitCode::from(1))
        }
    }
}

fn build_release_download_install_remote_cmd(settings: &RuntimeSettings) -> String {
    let script = release_download_install_script();
    let delimiter = heredoc_delimiter(script);
    let mut cmd = format!(
        "APP_NAME={} BUNDLE_PREFIX={} GH_REPO={}",
        remote_quote::posix_single_quote(&settings.app_name),
        remote_quote::posix_single_quote(&settings.bundle_prefix),
        remote_quote::posix_single_quote(&settings.gh_repo),
    );
    if let Some(channel) = &settings.update_channel {
        cmd.push_str(" RP_UPDATE_CHANNEL=");
        cmd.push_str(&remote_quote::posix_single_quote(channel));
    }
    cmd.push_str(" /bin/bash -s <<'");
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

fn release_download_install_script() -> &'static str {
    r#"set -euo pipefail
app="${APP_NAME:-XpairHost}"
bundle="${BUNDLE_PREFIX:-com.x10lab.xpair-host}"
repo="${GH_REPO:-x10lab/xpair}"
tmp="${TMPDIR:-/tmp}/xpair-host-release-install.$$"
rm -rf "$tmp"
mkdir -p "$tmp/extract"
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/${app}.zip"

channel="${RP_UPDATE_CHANNEL:-}"
if [ -z "$channel" ] && command -v defaults >/dev/null 2>&1; then
  channel="$(defaults read "$bundle" RPUpdateChannel 2>/dev/null || true)"
fi
channel="$(printf '%s' "$channel" | tr '[:upper:]' '[:lower:]')"

if [ "$channel" = alpha ]; then
  api="https://api.github.com/repos/${repo}/releases?per_page=30"
  if command -v python3 >/dev/null 2>&1; then
    py=python3
  elif [ -x /usr/bin/python3 ]; then
    py=/usr/bin/python3
  else
    printf 'alpha release lookup requires python3 on the host\n' >&2
    exit 1
  fi
  url="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H "User-Agent: ${app}/install-host" "$api" | "$py" -c '
import json, re, sys
app = sys.argv[1].lower()
data = json.load(sys.stdin)
def key(tag):
    tag = tag[1:] if tag.startswith("v") else tag
    parts = tag.split(".")
    if len(parts) != 3:
        return (-1, -1, -1, -1)
    match = re.match(r"^([0-9]+)(?:a([0-9]+))?$", parts[2])
    if not match:
        return (-1, -1, -1, -1)
    alpha = int(match.group(2)) if match.group(2) else 2147483647
    return (int(parts[0]), int(parts[1]), int(match.group(1)), alpha)
best = None
for rel in data:
    tag = str(rel.get("tag_name") or "")
    zips = []
    for asset in rel.get("assets") or []:
        name = str(asset.get("name") or "")
        url = str(asset.get("browser_download_url") or "")
        if name.endswith(".zip") and url:
            zips.append((name, url))
    if not zips:
        continue
    preferred = [asset for asset in zips if app in asset[0].lower()]
    name, url = (preferred or zips)[0]
    candidate = (key(tag), url)
    if best is None or candidate[0] > best[0]:
        best = candidate
if best is None:
    sys.exit(2)
print(best[1])
' "$app")" || { printf 'could not resolve alpha release asset for %s\n' "$app" >&2; exit 1; }
else
  url="https://github.com/${repo}/releases/latest/download/${app}.zip"
fi

[ -n "$url" ] || { printf 'release asset URL not resolved\n' >&2; exit 1; }
curl -fsSL "$url" -o "$zip"
[ -s "$zip" ] || { printf 'downloaded release artifact is empty: %s\n' "$url" >&2; exit 1; }
/usr/bin/ditto -x -k "$zip" "$tmp/extract"
src="$tmp/extract/${app}.app"
[ -d "$src" ] || { printf 'release zip did not contain %s.app\n' "$app" >&2; exit 1; }

copy_app() {
  _src="$1"; _dest="$2"
  rm -rf "$_dest" 2>/dev/null || true
  /usr/bin/ditto "$_src" "$_dest"
}

install_root="/Applications"
if mkdir -p "$install_root" 2>/dev/null && touch "$install_root/.xpair-write-test" 2>/dev/null; then
  rm -f "$install_root/.xpair-write-test"
else
  install_root="$HOME/Applications"
  mkdir -p "$install_root"
fi
dest="$install_root/${app}.app"
if ! copy_app "$src" "$dest"; then
  if [ "$install_root" = /Applications ]; then
    install_root="$HOME/Applications"
    mkdir -p "$install_root"
    dest="$install_root/${app}.app"
    copy_app "$src" "$dest"
  else
    exit 1
  fi
fi

[ -x "$dest/Contents/MacOS/$app" ] || { printf 'installed app executable missing: %s\n' "$dest/Contents/MacOS/$app" >&2; exit 1; }
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
pkill -f "/${app}.app/Contents/MacOS/${app}" 2>/dev/null || true
sleep 1
/bin/launchctl kickstart -k "gui/$(id -u)/${bundle}" 2>/dev/null || /usr/bin/open "$dest" 2>/dev/null || /usr/bin/open -a "$app" 2>/dev/null || true
for _i in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$HOME/.xpair/host/host.env" ] && break
  sleep 0.5
done
printf '__XPAIR_HOST_APP__:%s\n' "$dest"
"#
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
    if settings.pairing_key_path.is_file() && !req.password_stdin {
        let _ = writeln!(
            out,
            "paired host (key auth): skipping personal-key authorization (restricted pairing key already grants access)"
        );
    } else {
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
    }

    let cfg_user = match req.account.as_deref().filter(|account| !account.is_empty()) {
        Some(account) => Some(account.to_string()),
        None => resolve_remote_user(transport, &target),
    };

    if let Some(user) = cfg_user.filter(|user| !user.is_empty()) {
        let identity = path_string(&settings.identity_path);
        let block = build_ssh_config_block_for_os(
            settings.client_os,
            &req.host,
            &req.host,
            &user,
            &identity,
        );
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

fn read_password_line() -> io::Result<String> {
    let mut line = String::new();
    let mut stdin = io::BufReader::new(io::stdin().lock());
    stdin.read_line(&mut line)?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

fn contains_auth_denied(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("permission denied") || lower.contains("authentication failed")
}

struct AskpassTemp {
    path: PathBuf,
    data_path: Option<PathBuf>,
    fifo_path: Option<PathBuf>,
    writer: Option<Child>,
}

impl AskpassTemp {
    fn create(password: &str) -> io::Result<AskpassTemp> {
        let dir = std::env::temp_dir().join(format!(
            "xpair-askpass-{}-{}",
            std::process::id(),
            timestamp_nanos()
        ));
        fs::create_dir_all(&dir)?;
        chmod_best_effort(&dir, 0o700);
        #[cfg(windows)]
        let path = dir.join("askpass.cmd");
        #[cfg(not(windows))]
        let path = dir.join("askpass.sh");

        #[cfg(windows)]
        let data_path = {
            // Windows has no portable FIFO primitive for SSH_ASKPASS. Keep the secret in a
            // private temp file only on this platform and scrub it aggressively on drop.
            let data_path = dir.join(WINDOWS_ASKPASS_DATA_FILE);
            if let Err(error) = fs::write(&data_path, windows_askpass_data(password)) {
                let _ = fs::remove_dir_all(&dir);
                return Err(error);
            }
            chmod_best_effort(&data_path, 0o600);
            Some(data_path)
        };
        #[cfg(not(windows))]
        let data_path = None;
        #[cfg(not(windows))]
        let fifo_path = {
            let fifo_path = dir.join("pw.fifo");
            let status = Command::new("mkfifo")
                .arg("-m")
                .arg("600")
                .arg(&fifo_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            match status {
                Ok(status) if status.success() => {}
                Ok(_) => {
                    let _ = fs::remove_dir_all(&dir);
                    return Err(io::Error::other("mkfifo failed"));
                }
                Err(error) => {
                    let _ = fs::remove_dir_all(&dir);
                    return Err(error);
                }
            }
            Some(fifo_path)
        };
        #[cfg(windows)]
        let fifo_path = None;

        #[cfg(windows)]
        let body = windows_askpass_cmd_body().to_string();
        #[cfg(not(windows))]
        let body = unix_askpass_sh_body(fifo_path.as_ref().expect("unix fifo path is set"));

        if let Err(error) = fs::write(&path, body) {
            #[cfg(windows)]
            if let Some(data_path) = &data_path {
                let _ = fs::remove_file(data_path);
            }
            if let Some(fifo_path) = &fifo_path {
                let _ = fs::remove_file(fifo_path);
            }
            let _ = fs::remove_dir_all(&dir);
            return Err(error);
        }
        chmod_best_effort(&path, 0o700);
        #[cfg(not(windows))]
        let writer = match spawn_unix_fifo_writer(
            fifo_path.as_ref().expect("unix fifo path is set"),
            password,
        ) {
            Ok(writer) => Some(writer),
            Err(error) => {
                if let Some(fifo_path) = &fifo_path {
                    let _ = fs::remove_file(fifo_path);
                }
                let _ = fs::remove_file(&path);
                let _ = fs::remove_dir_all(&dir);
                return Err(error);
            }
        };
        #[cfg(windows)]
        let writer = None;
        Ok(AskpassTemp {
            path,
            data_path,
            fifo_path,
            writer,
        })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn fifo_path(&self) -> Option<&Path> {
        self.fifo_path.as_deref()
    }
}

impl Drop for AskpassTemp {
    fn drop(&mut self) {
        if let Some(mut writer) = self.writer.take() {
            match writer.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => {
                    let _ = writer.kill();
                    let _ = writer.wait();
                }
                Err(_) => {}
            }
        }
        chmod_best_effort(&self.path, 0o600);
        if let Some(data_path) = &self.data_path {
            chmod_best_effort(data_path, 0o600);
            let _ = fs::remove_file(data_path);
        }
        if let Some(fifo_path) = &self.fifo_path {
            let _ = fs::remove_file(fifo_path);
        }
        let _ = fs::remove_file(&self.path);
        if let Some(parent) = self.path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}

#[cfg(not(windows))]
fn spawn_unix_fifo_writer(fifo_path: &Path, password: &str) -> io::Result<Child> {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("cat > \"$1\"")
        .arg("xpair-askpass-fifo-writer")
        .arg(fifo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    let write_result = child.stdin.as_mut().map_or_else(
        || {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "writer stdin unavailable",
            ))
        },
        |stdin| {
            stdin.write_all(password.as_bytes())?;
            stdin.write_all(b"\n")
        },
    );
    child.stdin.take();

    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    Ok(child)
}

#[cfg(not(windows))]
fn unix_askpass_sh_body(fifo_path: &Path) -> String {
    format!(
        concat!(
            "#!/bin/sh\n",
            "fifo=${{RP_ASKPASS_FIFO:-{fifo}}}\n",
            "[ -p \"$fifo\" ] || exit 2\n",
            "_secret=\n",
            "IFS= read -r _secret < \"$fifo\" || exit 3\n",
            "[ -n \"$_secret\" ] || exit 3\n",
            "printf '%s\\n' \"$_secret\"\n"
        ),
        fifo = remote_quote::posix_single_quote(&path_string(fifo_path)),
    )
}

#[cfg(any(windows, test))]
const WINDOWS_ASKPASS_DATA_FILE: &str = "pw.dat";

#[cfg(any(windows, test))]
fn windows_askpass_cmd_body() -> &'static str {
    "@echo off\r\ntype \"%~dp0pw.dat\"\r\n"
}

#[cfg(any(windows, test))]
fn windows_askpass_data(password: &str) -> &[u8] {
    password.as_bytes()
}

fn chmod_best_effort(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(mode);
            let _ = fs::set_permissions(path, permissions);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

fn timestamp_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

struct RuntimeSettings {
    app_name: String,
    bundle_prefix: String,
    gh_repo: String,
    home_dir: PathBuf,
    identity_path: PathBuf,
    ssh_config_path: PathBuf,
    pairing_key_path: PathBuf,
    client_os: Os,
    update_channel: Option<String>,
}

impl RuntimeSettings {
    fn load(client_env_path: &Path) -> RuntimeSettings {
        let home_dir = home_dir().unwrap_or_else(|| PathBuf::from("."));
        let identity_path = home_dir.join(".ssh").join("id_ed25519");
        let ssh_config_path = non_empty_value(client_env_path, "RP_SSH_CFG")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join(".ssh").join("config"));
        let pairing_key_path = non_empty_env("PAIRING_KEY")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                config::default_rp_dir()
                    .unwrap_or_else(|_| home_dir.join(".xpair").join("host"))
                    .join("pairing_ed25519")
            });

        RuntimeSettings {
            app_name: setting(client_env_path, "APP_NAME", DEFAULT_APP_NAME),
            bundle_prefix: setting(client_env_path, "BUNDLE_PREFIX", DEFAULT_BUNDLE_PREFIX),
            gh_repo: setting(client_env_path, "GH_REPO", DEFAULT_GH_REPO),
            home_dir,
            identity_path,
            ssh_config_path,
            pairing_key_path,
            client_os: Os::current(),
            update_channel: non_empty_value(client_env_path, "RP_UPDATE_CHANNEL")
                .map(|channel| channel.to_ascii_lowercase()),
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
    control_path: Option<PathBuf>,
    askpass: Option<PathBuf>,
    askpass_fifo: Option<PathBuf>,
    password_phase: Cell<bool>,
    pairing_key: Option<PathBuf>,
}

impl SshTransport {
    fn new(
        os: platform::Os,
        settings: &RuntimeSettings,
        askpass: Option<&AskpassTemp>,
    ) -> SshTransport {
        let control_path = if os.supports_multiplexing() {
            Some(temp_control_path())
        } else {
            None
        };
        let pairing_key = if askpass.is_none() && settings.pairing_key_path.is_file() {
            Some(settings.pairing_key_path.clone())
        } else {
            None
        };
        SshTransport {
            os,
            control_path,
            askpass: askpass.map(|helper| helper.path().to_path_buf()),
            askpass_fifo: askpass.and_then(|helper| helper.fifo_path().map(Path::to_path_buf)),
            password_phase: Cell::new(askpass.is_some()),
            pairing_key,
        }
    }

    fn ssh_command(&self, password_phase: bool) -> Command {
        let mut command = Command::new("ssh");
        self.apply_ssh_options(&mut command, password_phase);
        if password_phase {
            if let Some(askpass) = &self.askpass {
                command.env("SSH_ASKPASS", askpass);
                command.env("SSH_ASKPASS_REQUIRE", "force");
                if let Some(fifo) = &self.askpass_fifo {
                    command.env("RP_ASKPASS_FIFO", fifo);
                }
                if std::env::var_os("DISPLAY").is_none() {
                    command.env("DISPLAY", ":0");
                }
            }
        }
        command
    }

    fn apply_ssh_options(&self, command: &mut Command, password_phase: bool) {
        command.args(["-o", "ConnectTimeout=8"]);
        command.args(["-o", "ConnectionAttempts=1"]);
        command.args(["-o", "StrictHostKeyChecking=accept-new"]);
        if let Some(control_path) = &self.control_path {
            command.args(["-o", "ControlMaster=auto"]);
            command.arg("-o");
            command.arg(format!("ControlPath={}", path_string(control_path)));
            command.args(["-o", "ControlPersist=120"]);
        } else {
            command.args(self.os.ssh_mux_neutralizer_args());
        }
        if password_phase {
            command.args([
                "-o",
                "PreferredAuthentications=password,keyboard-interactive",
            ]);
            command.args(["-o", "PubkeyAuthentication=no"]);
            command.args(["-o", "PasswordAuthentication=yes"]);
            command.args(["-o", "KbdInteractiveAuthentication=yes"]);
            command.args(["-o", "BatchMode=no"]);
            command.args(["-o", "NumberOfPasswordPrompts=1"]);
        } else {
            command.args(["-o", "BatchMode=yes"]);
            if let Some(pairing_key) = &self.pairing_key {
                command.arg("-i");
                command.arg(pairing_key);
            }
        }
    }
}

impl Transport for SshTransport {
    fn ssh_exec(&self, host: &str, remote_cmd: &str) -> io::Result<Output> {
        let output = self
            .ssh_command(self.password_phase.get())
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

    fn ssh_auth_probe(&self, host: &str, remote_cmd: &str) -> io::Result<AuthOutput> {
        let output = self
            .ssh_command(self.password_phase.get())
            .arg(host)
            .arg(remote_cmd)
            .stdin(Stdio::null())
            .output()?;

        Ok(AuthOutput {
            code: output.status.code().unwrap_or(255),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    fn retire_password_auth(&self) {
        if self.control_path.is_some() {
            self.password_phase.set(false);
        }
    }

    fn cleanup(&self, host: &str) {
        if let Some(control_path) = &self.control_path {
            let _ = Command::new("ssh")
                .arg("-O")
                .arg("exit")
                .arg("-o")
                .arg(format!("ControlPath={}", path_string(control_path)))
                .arg(host)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = fs::remove_file(control_path);
        }
    }
}

fn temp_control_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "xpair-cm-{}-{}",
        std::process::id(),
        timestamp_nanos()
    ))
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
                "--password-stdin",
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
                    password_stdin: true,
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
            password_stdin: false,
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
            "# >>> xpair: mac-mini >>>\nHost mac-mini\n  HostName 192.0.2.10\n  User alice\n  IdentityFile \"/Users/me/.ssh/id_ed25519\"\n  AddKeysToAgent yes\n  IgnoreUnknown UseKeychain\n  UseKeychain yes\n  HostKeyAlgorithms ssh-ed25519\n# <<< xpair: mac-mini <<<\n"
        );
        assert_eq!(
            build_ssh_config_block_for_os(
                Os::Linux,
                "mac-mini",
                "192.0.2.10",
                "alice",
                "/Users/me/.ssh/id_ed25519"
            ),
            "# >>> xpair: mac-mini >>>\nHost mac-mini\n  HostName 192.0.2.10\n  User alice\n  IdentityFile \"/Users/me/.ssh/id_ed25519\"\n  AddKeysToAgent yes\n  HostKeyAlgorithms ssh-ed25519\n# <<< xpair: mac-mini <<<\n"
        );
    }

    #[test]
    fn ssh_config_quotes_identity_paths_with_spaces() {
        let block = build_ssh_config_block_for_os(
            Os::Linux,
            "mac-mini",
            "192.0.2.10",
            "alice",
            r#"C:\Users\Alice Smith\.ssh\id "work"_ed25519"#,
        );

        assert!(
            block.contains(r#"  IdentityFile "C:\\Users\\Alice Smith\\.ssh\\id \"work\"_ed25519""#)
        );
    }

    #[test]
    fn windows_askpass_reads_literal_data_file() {
        assert_eq!(WINDOWS_ASKPASS_DATA_FILE, "pw.dat");
        for password in [
            "on",
            "off",
            "",
            "has spaces",
            "a&b",
            r#"quote""#,
            "100%done",
        ] {
            assert_eq!(
                windows_askpass_cmd_body(),
                "@echo off\r\ntype \"%~dp0pw.dat\"\r\n"
            );
            assert_eq!(windows_askpass_data(password), password.as_bytes());
        }
    }

    #[test]
    fn askpass_drop_removes_script_and_data_files() {
        let tmp = TestDir::new("askpass-cleanup");
        let script = tmp.path.join("askpass.cmd");
        let data = tmp.path.join("pw.dat");
        fs::write(&script, "script").unwrap();
        fs::write(&data, "secret").unwrap();

        let helper = AskpassTemp {
            path: script.clone(),
            data_path: Some(data.clone()),
            fifo_path: None,
            writer: None,
        };
        drop(helper);

        assert!(!script.exists());
        assert!(!data.exists());
    }

    #[cfg(unix)]
    #[test]
    fn unix_askpass_script_reads_fifo_without_embedding_secret() {
        let fifo = PathBuf::from("/tmp/xpair-test-fifo");
        let body = unix_askpass_sh_body(&fifo);

        assert!(body.contains("RP_ASKPASS_FIFO"));
        assert!(body.contains("/tmp/xpair-test-fifo"));
        assert!(!body.contains("correct horse battery staple"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_askpass_create_uses_fifo_without_password_file() {
        use std::os::unix::fs::FileTypeExt;

        let password = "correct horse battery staple";
        let helper = AskpassTemp::create(password).unwrap();
        let script = helper.path.clone();
        let fifo = helper.fifo_path.clone().unwrap();
        let parent = script.parent().unwrap().to_path_buf();

        assert!(script.is_file());
        assert!(fs::metadata(&fifo).unwrap().file_type().is_fifo());
        assert!(helper.data_path.is_none());
        assert!(!fs::read_to_string(&script).unwrap().contains(password));

        drop(helper);

        assert!(!script.exists());
        assert!(!fifo.exists());
        assert!(!parent.exists());
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
                ("RP_OS", Some("mac")),
                ("PAIRING_KEY", None),
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
                        build_ssh_config_block_for_os(
                            Os::Mac,
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
    fn paired_key_auth_skips_personal_key_authorization() {
        with_env(
            &[
                ("REMOTE_HOST", None),
                ("GH_REPO", None),
                ("APP_NAME", None),
                ("BUNDLE_PREFIX", None),
                ("RP_SSH_CFG", None),
                ("HOME", Some("C:/Users/tester")),
                ("RP_OS", Some("linux")),
                ("USERPROFILE", None),
            ],
            || {
                let tmp = TestDir::new("paired");
                let pairing_key = tmp.path.join("pairing_ed25519");
                fs::write(&pairing_key, "pairing-private").unwrap();
                let pairing_key_s = path_string(&pairing_key);
                let _guard = EnvGuard::set(&[("PAIRING_KEY", Some(&pairing_key_s))]);
                let transport = MockTransport::new();
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
                let out = String::from_utf8(out).unwrap();
                assert!(out.contains("skipping personal-key authorization"));
                assert!(out.ends_with("host set: mac-mini\n"));
                let calls = transport.calls();
                assert_eq!(calls.len(), 2);
                assert_eq!(
                    calls[0].remote_cmd,
                    build_idempotency_probe_cmd(DEFAULT_APP_NAME)
                );
                assert_eq!(
                    calls[1].remote_cmd,
                    build_reregister_cmd(DEFAULT_BUNDLE_PREFIX, DEFAULT_APP_NAME)
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
    fn non_bootstrap_uninstalled_path_downloads_release_on_host() {
        with_env(
            &[("REMOTE_HOST", None), ("HOME", Some("C:/Users/tester"))],
            || {
                let tmp = TestDir::new("release-install");
                let transport = MockTransport::new();
                transport.push_response(1, "");
                transport.push_response(0, "__XPAIR_HOST_APP__:/Applications/XpairHost.app\n");
                transport.push_response(0, "");
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

                assert_eq!(code, ExitCode::SUCCESS);
                assert_eq!(String::from_utf8(err).unwrap(), "");
                assert_eq!(String::from_utf8(out).unwrap(), "host set: mac-mini\n");
                let calls = transport.calls();
                assert_eq!(calls.len(), 3);
                assert_eq!(
                    calls[0].remote_cmd,
                    build_idempotency_probe_cmd(DEFAULT_APP_NAME)
                );
                assert!(calls[1]
                    .remote_cmd
                    .contains("https://github.com/${repo}/releases/latest/download/${app}.zip"));
                assert!(calls[1].remote_cmd.contains("/usr/bin/ditto -x -k"));
                assert!(calls[1]
                    .remote_cmd
                    .contains("install_root=\"/Applications\""));
                assert!(calls[1]
                    .remote_cmd
                    .contains("install_root=\"$HOME/Applications\""));
                assert!(calls[1].remote_cmd.contains("/bin/launchctl kickstart -k"));
                assert_eq!(
                    calls[2].remote_cmd,
                    build_authorize_key_pipe_cmd("ssh-ed25519 AAAATEST")
                );
            },
        );
    }

    #[test]
    fn force_non_bootstrap_skips_probe_and_reinstalls_release() {
        with_env(
            &[("REMOTE_HOST", None), ("HOME", Some("C:/Users/tester"))],
            || {
                let tmp = TestDir::new("force-release-install");
                let transport = MockTransport::new();
                transport.push_response(0, "__XPAIR_HOST_APP__:/Applications/XpairHost.app\n");
                transport.push_response(0, "");
                let io = FakeInstallIo::new("", "", "ssh-ed25519 AAAATEST");
                let mut out = Vec::new();
                let mut err = Vec::new();

                let code = run_with_transport(
                    &strings(&["--host", "mac-mini", "--account", "alice", "--force"]),
                    &tmp.client_env_path(),
                    &transport,
                    &io,
                    &mut out,
                    &mut err,
                );

                assert_eq!(code, ExitCode::SUCCESS);
                assert_eq!(String::from_utf8(err).unwrap(), "");
                let calls = transport.calls();
                assert_eq!(calls.len(), 2);
                assert!(calls[0].remote_cmd.contains("releases/latest/download"));
                assert_eq!(
                    calls[1].remote_cmd,
                    build_authorize_key_pipe_cmd("ssh-ed25519 AAAATEST")
                );
            },
        );
    }

    #[test]
    fn release_install_honors_alpha_update_channel() {
        with_env(
            &[
                ("REMOTE_HOST", None),
                ("HOME", Some("C:/Users/tester")),
                ("USERPROFILE", None),
                ("RP_UPDATE_CHANNEL", None),
            ],
            || {
                let tmp = TestDir::new("alpha-release-channel");
                fs::write(tmp.client_env_path(), "RP_UPDATE_CHANNEL=alpha\n").unwrap();
                let settings = RuntimeSettings::load(&tmp.client_env_path());

                let cmd = build_release_download_install_remote_cmd(&settings);

                assert!(cmd.contains("RP_UPDATE_CHANNEL='alpha'"));
                assert!(cmd.contains("releases?per_page=30"));
                assert!(cmd.contains("browser_download_url"));
            },
        );
    }
}
