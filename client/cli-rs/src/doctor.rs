//! `xpair doctor` diagnostics.
//!
//! Ports the row-oriented shape of `cmd_doctor` from the bash CLI while keeping host probes
//! behind [`crate::transport::Transport`] so tests never need a real SSH server.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use crate::config;
use crate::mapping::parse_maps;
use crate::platform::Os;
use crate::remote_quote;
use crate::session;
use crate::status;
use crate::transport::{Output, Transport};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_AQUA_SOCK: &str = "/tmp/aqua-tmux.sock";
const DEFAULT_APP_NAME: &str = "XpairHost";
const HOST_TMUX_AQUA: &str = "$HOME/.local/bin/tmux-aqua";
const REMOTE_STATUS_CMD: &str = "cat ~/.xpair/host/logs/status.json 2>/dev/null";

/// One aligned doctor report row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub label: String,
    pub value: String,
    pub fail: bool,
}

impl Row {
    fn new(label: impl Into<String>, value: impl Into<String>, fail: bool) -> Row {
        Row {
            label: label.into(),
            value: value.into(),
            fail,
        }
    }
}

/// Render rows using the bash `printf '%-22s %s\n'` alignment and append the final verdict.
pub fn render_report(rows: &[Row]) -> String {
    let mut out = String::new();
    for row in rows {
        out.push_str(&format!("{:<22} {}\n", row.label, row.value));
    }
    if verdict(rows) {
        out.push_str("all good — xpair launch ready\n");
    } else {
        out.push_str("check the items above\n");
    }
    out
}

/// True when no row is marked as a required-check failure.
pub fn verdict(rows: &[Row]) -> bool {
    !rows.iter().any(|row| row.fail)
}

/// Build the client-local doctor rows from explicit inputs so status mapping is deterministic.
pub fn client_local_rows(
    launcher_path: &str,
    launcher_present: bool,
    ssh_on_path: bool,
    folder_maps: &str,
) -> Vec<Row> {
    vec![
        launcher_row(launcher_path, launcher_present),
        folder_mappings_row(folder_maps),
        ssh_row(ssh_on_path),
    ]
}

fn launcher_row(launcher_path: &str, present: bool) -> Row {
    if present {
        Row::new("launcher", format!("OK ({launcher_path})"), false)
    } else {
        Row::new("launcher", "absent (native CLI active)", false)
    }
}

fn folder_mappings_row(folder_maps: &str) -> Row {
    let count = parse_maps(folder_maps).len();
    let value = if count == 0 {
        "none (registered on first launch)".to_string()
    } else {
        format!("{count} entries")
    };
    Row::new("folder mappings", value, false)
}

fn ssh_row(on_path: bool) -> Row {
    if on_path {
        Row::new("ssh", "OK", false)
    } else {
        Row::new("ssh", "missing", true)
    }
}

/// Probe the configured host through the transport seam.
pub fn probe_host(t: &dyn Transport, host: &str, aqua_sock: &str) -> Vec<Row> {
    probe_host_with_app(t, host, aqua_sock, DEFAULT_APP_NAME)
}

/// Probe the configured host with an explicit app name for tests/configured hosts.
pub fn probe_host_with_app(
    t: &dyn Transport,
    host: &str,
    aqua_sock: &str,
    app_name: &str,
) -> Vec<Row> {
    let ssh = t
        .ssh_exec(host, &ssh_auth_command())
        .unwrap_or_else(failed_output);
    let mut rows = vec![ssh_auth_row(host, ssh.code)];
    if ssh.code != 0 {
        return rows;
    }

    let tmux_aqua = t
        .ssh_exec(host, &host_tmux_aqua_command())
        .unwrap_or_else(failed_output);
    let host_app = t
        .ssh_exec(host, &host_app_command(app_name))
        .unwrap_or_else(failed_output);
    let server = t
        .ssh_exec(host, &host_server_command(aqua_sock))
        .unwrap_or_else(failed_output);
    let approve_skill = t
        .ssh_exec(host, &host_approve_skill_command())
        .unwrap_or_else(failed_output);
    let approve_hook = t
        .ssh_exec(host, &host_approve_hook_command())
        .unwrap_or_else(failed_output);
    let notify_hook = t
        .ssh_exec(host, &host_notify_hook_command())
        .unwrap_or_else(failed_output);
    let status_json = t
        .ssh_exec(host, REMOTE_STATUS_CMD)
        .unwrap_or_else(failed_output);

    rows.extend([
        host_tmux_aqua_row(tmux_aqua.code),
        host_app_row(app_name, host_app.code),
        host_server_row(server.code),
        host_approve_skill_row(approve_skill.code),
        host_approve_hook_row(approve_hook.code),
        host_notify_hook_row(notify_hook.code),
        host_permission_grants_row(&status_json.stdout),
    ]);
    rows
}

pub fn ssh_auth_row(host: &str, code: i32) -> Row {
    if code == 0 {
        Row::new(format!("SSH ({host})"), "OK (key auth passed)", false)
    } else {
        Row::new(format!("SSH ({host})"), "FAILED", true)
    }
}

pub fn host_tmux_aqua_row(code: i32) -> Row {
    if code == 0 {
        Row::new("host tmux-aqua", "OK", false)
    } else {
        Row::new(
            "host tmux-aqua",
            "missing — run install.sh --role host on the host",
            true,
        )
    }
}

pub fn host_server_row(code: i32) -> Row {
    if code == 0 {
        Row::new("host server", "up", false)
    } else {
        Row::new("host server", "down (check app launch/permissions)", false)
    }
}

pub fn host_app_row(app_name: &str, code: i32) -> Row {
    if code == 0 {
        Row::new("host app", format!("OK ({app_name}.app)"), false)
    } else {
        Row::new("host app", "missing", true)
    }
}

pub fn host_approve_skill_row(code: i32) -> Row {
    if code == 0 {
        Row::new("host approve skill", "OK", false)
    } else {
        Row::new(
            "host approve skill",
            "missing — install.sh --role host",
            true,
        )
    }
}

pub fn host_approve_hook_row(code: i32) -> Row {
    if code == 0 {
        Row::new("host approve hook", "OK", false)
    } else {
        Row::new(
            "host approve hook",
            "missing — install.sh --role host (or python3 absent)",
            true,
        )
    }
}

pub fn host_notify_hook_row(code: i32) -> Row {
    if code == 0 {
        Row::new("host notify hook", "OK (forwarding installed)", false)
    } else {
        Row::new(
            "host notify hook",
            "not detected (install.sh --role host on the host)",
            false,
        )
    }
}

pub fn host_permission_grants_row(status_json: &str) -> Row {
    if status_json.trim().is_empty() {
        return Row::new(
            "host AX+SR grant",
            "unknown (status.json absent — update the host app)",
            false,
        );
    }

    let parsed = status::parse_status_json(status_json);
    let all_granted = parsed.ax && parsed.sr && parsed.fda && parsed.sharing;
    let serving = parsed.serving.unwrap_or(parsed.ax && parsed.sr);

    if all_granted && serving {
        Row::new("host AX+SR grant", "OK (AX✓ SR✓ FDA✓ Sharing✓)", false)
    } else if parsed.serving == Some(false) {
        Row::new(
            "host AX+SR grant",
            format!(
                "NOT serving (AX {} SR {} FDA {} Sharing {}) — turn these ON in System Settings for computer-use/approve to work; Remote Login and File Sharing are required",
                status::mark(parsed.ax),
                status::mark(parsed.sr),
                status::mark(parsed.fda),
                status::mark(parsed.sharing)
            ),
            true,
        )
    } else {
        Row::new(
            "host AX+SR grant",
            format!(
                "NOT granted (AX {} SR {} FDA {} Sharing {}) — turn these ON in System Settings for computer-use/approve to work; Remote Login and File Sharing are required",
                status::mark(parsed.ax),
                status::mark(parsed.sr),
                status::mark(parsed.fda),
                status::mark(parsed.sharing)
            ),
            true,
        )
    }
}

fn ssh_auth_command() -> String {
    remote_quote::posix_join(&["true"])
}

fn host_tmux_aqua_command() -> String {
    remote_shell_script(&format!("[ -x \"{HOST_TMUX_AQUA}\" ]"))
}

fn host_app_command(app_name: &str) -> String {
    remote_shell_script(&format!(
        "[ -d /Applications/{app_name}.app ] || [ -d ~/Applications/{app_name}.app ]"
    ))
}

fn host_server_command(aqua_sock: &str) -> String {
    let aqua_sock = remote_quote::posix_single_quote(aqua_sock);
    remote_shell_script(&format!("\"{HOST_TMUX_AQUA}\" -S {aqua_sock} has-session"))
}

fn host_approve_skill_command() -> String {
    remote_shell_script("[ -f ~/.claude/skills/approve/SKILL.md ]")
}

fn host_approve_hook_command() -> String {
    remote_shell_script("grep -q xpair-approve-reminder ~/.claude/settings.json 2>/dev/null")
}

fn host_notify_hook_command() -> String {
    remote_shell_script("grep -q xpair-notify ~/.claude/settings.json 2>/dev/null")
}

fn remote_shell_script(script: &str) -> String {
    remote_quote::posix_join(&["sh", "-lc", script])
}

fn failed_output(_: io::Error) -> Output {
    Output {
        code: 255,
        stdout: String::new(),
    }
}

/// CLI entrypoint for `xpair doctor`.
pub fn run(args: &[String]) -> ExitCode {
    let _ = args;

    let os = Os::current();
    let settings = RuntimeSettings::load();
    let launcher_present = launcher_present(&settings.launcher_path);
    let ssh_present = ssh_on_path();

    let mut rows = client_local_rows(
        &settings.launcher_path.to_string_lossy(),
        launcher_present,
        ssh_present,
        &settings.folder_maps,
    );

    let no_host_configured = settings.remote_host.is_none();
    if let Some(host) = settings.remote_host.as_deref() {
        let transport = SshTransport { os };
        rows.extend(probe_host_with_app(
            &transport,
            host,
            &settings.aqua_sock,
            &settings.app_name,
        ));
    }

    println!("xpair {VERSION}");
    println!("os: {os}");
    println!("ssh multiplexing: {}", os.supports_multiplexing());
    if !os.supports_multiplexing() {
        println!(
            "  (windows: independent ssh.exe per connection; {})",
            os.ssh_mux_neutralizer_args().join(" ")
        );
    }
    if no_host_configured {
        println!("no host configured — set one in Xpair.app or: xpair config set host <ssh-host> (skipping host checks)");
    }
    print!("{}", render_report(&rows));

    if verdict(&rows) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

struct RuntimeSettings {
    launcher_path: PathBuf,
    folder_maps: String,
    remote_host: Option<String>,
    aqua_sock: String,
    app_name: String,
}

impl RuntimeSettings {
    fn load() -> RuntimeSettings {
        let config_path = config::default_client_env_path().ok();
        let config_path = config_path.as_deref();

        let folder_maps = non_empty_value(config_path, "FOLDER_MAPS")
            .or_else(|| non_empty_value(config_path, "SYNC_ROOTS"))
            .unwrap_or_default();
        let remote_host =
            non_empty_value(config_path, "REMOTE_HOST").filter(|host| config::valid_host(host));
        let aqua_sock =
            non_empty_value(config_path, "AQUA_SOCK").unwrap_or_else(|| DEFAULT_AQUA_SOCK.into());
        let app_name =
            non_empty_value(config_path, "APP_NAME").unwrap_or_else(|| DEFAULT_APP_NAME.into());
        let launcher_path = non_empty_value(config_path, "LAUNCHER")
            .map(PathBuf::from)
            .unwrap_or_else(default_launcher_path);

        RuntimeSettings {
            launcher_path,
            folder_maps,
            remote_host,
            aqua_sock,
            app_name,
        }
    }
}

fn non_empty_value(config_path: Option<&Path>, key: &str) -> Option<String> {
    value(config_path, key).filter(|value| !value.is_empty())
}

fn value(config_path: Option<&Path>, key: &str) -> Option<String> {
    if let Some(value) = std::env::var_os(key) {
        return Some(value.to_string_lossy().into_owned());
    }

    config_path.and_then(|path| config::get(path, key).ok().flatten())
}

fn default_launcher_path() -> PathBuf {
    client_dir().join("bin").join("xpair-launch")
}

fn client_dir() -> PathBuf {
    if let Some(value) = std::env::var_os("RP_CLIENT_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(value);
    }

    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".xpair")
        .join("client")
}

fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }
    if let Some(home) = std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }
    match (
        std::env::var_os("HOMEDRIVE").filter(|value| !value.is_empty()),
        std::env::var_os("HOMEPATH").filter(|value| !value.is_empty()),
    ) {
        (Some(drive), Some(path)) => {
            let mut home = PathBuf::from(drive);
            home.push(path);
            Some(home)
        }
        _ => None,
    }
}

fn launcher_present(path: &Path) -> bool {
    executable_file(path)
}

fn ssh_on_path() -> bool {
    #[cfg(windows)]
    const SSH_NAMES: &[&str] = &["ssh.exe", "ssh"];
    #[cfg(not(windows))]
    const SSH_NAMES: &[&str] = &["ssh"];

    program_on_path(SSH_NAMES)
}

fn program_on_path(names: &[&str]) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };

    for dir in std::env::split_paths(&path) {
        for name in names {
            if executable_file(&dir.join(name)) {
                return true;
            }
        }
    }
    false
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

struct SshTransport {
    os: Os,
}

impl Transport for SshTransport {
    fn ssh_exec(&self, host: &str, remote_cmd: &str) -> io::Result<Output> {
        let output = Command::new("ssh")
            .args(session::pairing_identity_args())
            .args(self.os.ssh_mux_neutralizer_args())
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=6"])
            .arg(host)
            .arg(remote_cmd)
            .output()?;

        Ok(Output {
            code: output.status.code().unwrap_or(255),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        })
    }
}

// deferred (P2): mosh fallback visibility from the bash local rows.
// deferred (P2): file-access backend (mount/syncthing).
// deferred (P2): in-host-session status block.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MockTransport;

    #[test]
    fn render_report_aligns_rows_and_reports_success() {
        let rows = vec![
            Row::new("launcher", "OK (/tmp/xpair-launch)", false),
            Row::new("ssh", "OK", false),
        ];

        assert_eq!(
            render_report(&rows),
            format!(
                "launcher{}OK (/tmp/xpair-launch)\nssh{}OK\nall good — xpair launch ready\n",
                " ".repeat(15),
                " ".repeat(20)
            )
        );
        assert!(verdict(&rows));
    }

    #[test]
    fn render_report_aligns_rows_and_reports_failure() {
        let rows = vec![
            Row::new("launcher", "OK (/tmp/xpair-launch)", false),
            Row::new("ssh", "missing", true),
        ];

        assert_eq!(
            render_report(&rows),
            format!(
                "launcher{}OK (/tmp/xpair-launch)\nssh{}missing\ncheck the items above\n",
                " ".repeat(15),
                " ".repeat(20)
            )
        );
        assert!(!verdict(&rows));
    }

    #[test]
    fn folder_mappings_row_counts_zero_one_and_many() {
        assert_eq!(
            folder_mappings_row("").value,
            "none (registered on first launch)"
        );
        assert_eq!(folder_mappings_row("/client::/host").value, "1 entries");
        assert_eq!(
            folder_mappings_row("/a::/b;/same;/c::/d").value,
            "3 entries"
        );
    }

    #[test]
    fn client_local_rows_map_launcher_and_ssh_status() {
        let rows = client_local_rows("/tmp/xpair-launch", true, true, "");
        assert_eq!(
            rows[0],
            Row::new("launcher", "OK (/tmp/xpair-launch)", false)
        );
        assert_eq!(rows[2], Row::new("ssh", "OK", false));

        let rows = client_local_rows("/tmp/xpair-launch", false, false, "");
        assert_eq!(
            rows[0],
            Row::new("launcher", "absent (native CLI active)", false)
        );
        assert_eq!(rows[2], Row::new("ssh", "missing", true));
    }

    #[test]
    fn probe_host_maps_success_codes_and_records_remote_commands() {
        let t = MockTransport::new();
        t.push_response(0, "");
        t.push_response(0, "");
        t.push_response(0, "");
        t.push_response(0, "");
        t.push_response(0, "");
        t.push_response(0, "");
        t.push_response(0, "");
        t.push_response(
            0,
            r#"{"ax":true,"sr":true,"fda":true,"sharing":true,"serving":true}"#,
        );

        let rows = probe_host(&t, "mac-mini", "/tmp/aqua sock");

        assert_eq!(
            rows,
            vec![
                Row::new("SSH (mac-mini)", "OK (key auth passed)", false),
                Row::new("host tmux-aqua", "OK", false),
                Row::new("host app", "OK (XpairHost.app)", false),
                Row::new("host server", "up", false),
                Row::new("host approve skill", "OK", false),
                Row::new("host approve hook", "OK", false),
                Row::new("host notify hook", "OK (forwarding installed)", false),
                Row::new("host AX+SR grant", "OK (AX✓ SR✓ FDA✓ Sharing✓)", false),
            ]
        );

        let calls = t.calls();
        assert_eq!(calls.len(), 8);
        assert_eq!(calls[0].host, "mac-mini");
        assert_eq!(calls[0].remote_cmd, "'true'");
        assert_eq!(
            calls[1].remote_cmd,
            "'sh' '-lc' '[ -x \"$HOME/.local/bin/tmux-aqua\" ]'"
        );
        assert_eq!(
            calls[2].remote_cmd,
            "'sh' '-lc' '[ -d /Applications/XpairHost.app ] || [ -d ~/Applications/XpairHost.app ]'"
        );
        assert_eq!(
            calls[3].remote_cmd,
            "'sh' '-lc' '\"$HOME/.local/bin/tmux-aqua\" -S '\\''/tmp/aqua sock'\\'' has-session'"
        );
        assert_eq!(
            calls[4].remote_cmd,
            "'sh' '-lc' '[ -f ~/.claude/skills/approve/SKILL.md ]'"
        );
        assert_eq!(
            calls[5].remote_cmd,
            "'sh' '-lc' 'grep -q xpair-approve-reminder ~/.claude/settings.json 2>/dev/null'"
        );
        assert_eq!(
            calls[6].remote_cmd,
            "'sh' '-lc' 'grep -q xpair-notify ~/.claude/settings.json 2>/dev/null'"
        );
        assert_eq!(calls[7].remote_cmd, REMOTE_STATUS_CMD);
    }

    #[test]
    fn probe_host_maps_missing_host_rows() {
        let t = MockTransport::new();
        t.push_response(0, "");
        t.push_response(1, "");
        t.push_response(1, "");
        t.push_response(1, "");
        t.push_response(1, "");
        t.push_response(1, "");
        t.push_response(1, "");
        t.push_response(0, "");

        let rows = probe_host(&t, "mac-mini", DEFAULT_AQUA_SOCK);

        assert_eq!(
            rows[0],
            Row::new("SSH (mac-mini)", "OK (key auth passed)", false)
        );
        assert_eq!(
            rows[1],
            Row::new(
                "host tmux-aqua",
                "missing — run install.sh --role host on the host",
                true
            )
        );
        assert_eq!(rows[2], Row::new("host app", "missing", true));
        assert_eq!(
            rows[3],
            Row::new("host server", "down (check app launch/permissions)", false)
        );
        assert_eq!(
            rows[4],
            Row::new(
                "host approve skill",
                "missing — install.sh --role host",
                true
            )
        );
        assert_eq!(
            rows[5],
            Row::new(
                "host approve hook",
                "missing — install.sh --role host (or python3 absent)",
                true
            )
        );
        assert_eq!(
            rows[6],
            Row::new(
                "host notify hook",
                "not detected (install.sh --role host on the host)",
                false
            )
        );
        assert_eq!(
            rows[7],
            Row::new(
                "host AX+SR grant",
                "unknown (status.json absent — update the host app)",
                false
            )
        );
    }

    #[test]
    fn failing_ssh_probe_flips_verdict() {
        let t = MockTransport::new();
        t.push_response(255, "");

        let rows = probe_host(&t, "mac-mini", DEFAULT_AQUA_SOCK);

        assert_eq!(rows[0], Row::new("SSH (mac-mini)", "FAILED", true));
        assert_eq!(rows.len(), 1);
        assert_eq!(t.calls().len(), 1);
        assert!(!verdict(&rows));
    }

    #[test]
    fn host_permission_grants_require_all_four_grants() {
        assert_eq!(
            host_permission_grants_row(r#"{"ax":true,"sr":true,"fda":false,"sharing":false}"#),
            Row::new(
                "host AX+SR grant",
                "NOT granted (AX ✓ SR ✓ FDA ✗ Sharing ✗) — turn these ON in System Settings for computer-use/approve to work; Remote Login and File Sharing are required",
                true
            )
        );
    }

    #[test]
    fn host_permission_grants_reports_serving_false() {
        assert_eq!(
            host_permission_grants_row(
                r#"{"ax":true,"sr":true,"fda":true,"sharing":true,"serving":false}"#
            ),
            Row::new(
                "host AX+SR grant",
                "NOT serving (AX ✓ SR ✓ FDA ✓ Sharing ✓) — turn these ON in System Settings for computer-use/approve to work; Remote Login and File Sharing are required",
                true
            )
        );
    }

    #[test]
    fn malformed_status_json_is_not_granted() {
        assert_eq!(
            host_permission_grants_row("{not json"),
            Row::new(
                "host AX+SR grant",
                "NOT granted (AX ✗ SR ✗ FDA ✗ Sharing ✗) — turn these ON in System Settings for computer-use/approve to work; Remote Login and File Sharing are required",
                true
            )
        );
    }
}
