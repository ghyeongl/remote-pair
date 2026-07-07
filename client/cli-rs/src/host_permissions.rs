//! `xpair host-permissions` advisory JSON.
//!
//! Ports `cmd_host_permissions()` from `client/cli/xpair:2034-2063`: resolve a host,
//! read the host app's `status.json` over the transport seam, and always emit compact
//! JSON with exit 0. The remote command is fixed and contains no user input; it relies on
//! the remote POSIX shell for `~` expansion and stderr redirection.

use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};

use crate::config;
use crate::platform::{self, Os};
use crate::session;
use crate::status;
use crate::transport::{Output, Transport};

const REMOTE_STATUS_CMD: &str = "cat ~/.xpair/host/logs/status.json 2>/dev/null";
const NO_HOST_ERR: &str = "no host";
const NO_STATUS_ERR: &str = "no status.json (host app not running?)";
const BAD_STATUS_ERR: &str = "bad status.json";

/// Real SSH transport for this advisory command.
///
/// The Windows C1 multiplexing neutralizer stays in the process-spawn seam, so callers only
/// exercise [`Transport::ssh_exec`]. Tests use [`crate::transport::MockTransport`] instead.
struct SshTransport {
    os: Os,
}

impl Transport for SshTransport {
    fn ssh_exec(&self, host: &str, remote_cmd: &str) -> io::Result<Output> {
        let argv = build_ssh_argv(self.os, host, remote_cmd);
        let out = Command::new(&argv[0])
            .args(&argv[1..])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()?;

        Ok(Output {
            code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        })
    }
}

/// Pure liveness rule: pid is present and the timestamp is less than 10 seconds old.
pub fn alive(pid: Option<i64>, ts: Option<i64>, now_ts: i64) -> bool {
    pid.is_some() && ts.is_some_and(|ts| now_ts.saturating_sub(ts) < 10)
}

/// Render exact compact JSON in bash-compatible key order.
pub fn render_json(
    alive: bool,
    ax: bool,
    sr: bool,
    fda: bool,
    sharing: bool,
    serving: Option<bool>,
    err: &str,
) -> String {
    let mut out = String::new();
    out.push_str("{\"alive\":");
    out.push_str(bool_json(alive));
    out.push_str(",\"ax\":");
    out.push_str(bool_json(ax));
    out.push_str(",\"sr\":");
    out.push_str(bool_json(sr));
    out.push_str(",\"fda\":");
    out.push_str(bool_json(fda));
    out.push_str(",\"sharing\":");
    out.push_str(bool_json(sharing));
    if let Some(serving) = serving {
        out.push_str(",\"serving\":");
        out.push_str(bool_json(serving));
    }
    out.push_str(",\"err\":\"");
    push_json_string_body(&mut out, err);
    out.push_str("\"}");
    out
}

/// Extract numeric `pid` from the app's flat status payload.
pub fn parse_pid(status_json: &str) -> Option<i64> {
    scalar_field(status_json, "pid").and_then(|value| value.parse::<i64>().ok())
}

/// Build the exact remote POSIX payload used to read the host status file.
pub fn build_status_remote_cmd() -> &'static str {
    REMOTE_STATUS_CMD
}

/// CLI entrypoint for `xpair host-permissions`.
pub fn run(args: &[String]) -> ExitCode {
    let client_env_path = config::default_client_env_path().ok();
    let transport = SshTransport { os: Os::current() };
    let mut stdout = io::stdout();

    run_with_transport(
        args,
        client_env_path.as_deref(),
        status::now_ts(),
        &transport,
        &mut stdout,
    )
}

/// Testable runner; every outcome is advisory JSON with a success exit code.
pub fn run_with_transport<T: Transport + ?Sized, W: Write>(
    args: &[String],
    client_env_path: Option<&Path>,
    now_ts: i64,
    transport: &T,
    out: &mut W,
) -> ExitCode {
    let host = resolve_host(args, client_env_path);
    let rendered = if host.is_empty() {
        render_json(false, false, false, false, false, None, NO_HOST_ERR)
    } else {
        render_host_permissions(transport, &host, now_ts)
    };

    let _ = writeln!(out, "{rendered}");
    ExitCode::SUCCESS
}

fn render_host_permissions<T: Transport + ?Sized>(
    transport: &T,
    host: &str,
    now_ts: i64,
) -> String {
    let raw = transport
        .ssh_exec(host, build_status_remote_cmd())
        .map(|out| out.stdout)
        .unwrap_or_default();

    if command_substitution_empty(&raw) {
        return render_json(false, false, false, false, false, None, NO_STATUS_ERR);
    }

    render_status_json(&raw, now_ts)
}

fn render_status_json(raw: &str, now_ts: i64) -> String {
    if !valid_json_object(raw) {
        return render_json(false, false, false, false, false, None, BAD_STATUS_ERR);
    }

    let parsed = status::parse_status_json(raw);
    render_json(
        alive(parse_pid(raw), parsed.ts, now_ts),
        parsed.ax,
        parsed.sr,
        parsed.fda,
        parsed.sharing,
        parsed.serving,
        "",
    )
}

fn resolve_host(args: &[String], client_env_path: Option<&Path>) -> String {
    if let Some(host) = parse_host_arg(args) {
        return host;
    }
    if let Some(host) = non_empty_env("REMOTE_HOST") {
        return host;
    }
    client_env_path
        .and_then(|path| config::get_cli(path, "host").ok())
        .unwrap_or_default()
}

fn parse_host_arg(args: &[String]) -> Option<String> {
    let mut host = None;
    let mut idx = 0;
    while idx < args.len() {
        if args[idx] == "--host" {
            host = Some(args.get(idx + 1).cloned().unwrap_or_default());
            idx += 2;
        } else {
            idx += 1;
        }
    }
    host
}

fn build_ssh_argv(os: platform::Os, host: &str, remote_cmd: &str) -> Vec<String> {
    let mut argv = vec!["ssh".to_string()];
    argv.extend(session::pairing_identity_args());
    argv.extend([
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=6".to_string(),
        "-o".to_string(),
        "ConnectionAttempts=1".to_string(),
    ]);
    argv.extend(
        os.ssh_mux_neutralizer_args()
            .iter()
            .map(|arg| arg.to_string()),
    );
    argv.extend([
        "-o".to_string(),
        "PreferredAuthentications=publickey".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=0".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-T".to_string(),
        "-n".to_string(),
        host.to_string(),
        remote_cmd.to_string(),
    ]);
    argv
}

fn command_substitution_empty(raw: &str) -> bool {
    raw.trim_end_matches(['\r', '\n']).is_empty()
}

fn bool_json(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn scalar_field(s: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = s.rfind(&needle)?;
    let after_key = &s[start + needle.len()..];
    let colon = after_key.find(':')?;
    let mut value = after_key[colon + 1..].trim_start();

    if let Some(rest) = value.strip_prefix('"') {
        value = rest;
        let end = value.find(['"', ',', '}']).unwrap_or(value.len());
        return Some(value[..end].trim().to_string());
    }

    let end = value
        .find(|c: char| matches!(c, ',' | '}') || c.is_whitespace())
        .unwrap_or(value.len());
    Some(value[..end].trim().to_string())
}

fn push_json_string_body(out: &mut String, value: &str) {
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch <= '\u{1f}' => {
                out.push_str("\\u00");
                let byte = ch as u8;
                out.push(hex_digit(byte >> 4));
                out.push(hex_digit(byte & 0x0f));
            }
            ch => out.push(ch),
        }
    }
}

fn hex_digit(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'a' + (n - 10)) as char,
        _ => unreachable!("hex nibble is always <= 15"),
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn valid_json_object(s: &str) -> bool {
    let mut parser = JsonParser::new(s);
    parser.parse_object() && parser.finished()
}

struct JsonParser<'a> {
    s: &'a str,
    idx: usize,
}

impl<'a> JsonParser<'a> {
    fn new(s: &'a str) -> Self {
        Self { s, idx: 0 }
    }

    fn finished(&mut self) -> bool {
        self.skip_ws();
        self.idx == self.s.len()
    }

    fn parse_value(&mut self) -> bool {
        self.skip_ws();
        match self.peek_byte() {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => self.parse_string(),
            Some(b'-' | b'0'..=b'9') => self.parse_number(),
            Some(b't') => self.consume_keyword("true"),
            Some(b'f') => self.consume_keyword("false"),
            Some(b'n') => self.consume_keyword("null"),
            _ => false,
        }
    }

    fn parse_object(&mut self) -> bool {
        self.skip_ws();
        if !self.consume_byte(b'{') {
            return false;
        }
        self.skip_ws();
        if self.consume_byte(b'}') {
            return true;
        }

        loop {
            self.skip_ws();
            if !self.parse_string() {
                return false;
            }
            self.skip_ws();
            if !self.consume_byte(b':') {
                return false;
            }
            if !self.parse_value() {
                return false;
            }
            self.skip_ws();
            if self.consume_byte(b'}') {
                return true;
            }
            if !self.consume_byte(b',') {
                return false;
            }
        }
    }

    fn parse_array(&mut self) -> bool {
        if !self.consume_byte(b'[') {
            return false;
        }
        self.skip_ws();
        if self.consume_byte(b']') {
            return true;
        }

        loop {
            if !self.parse_value() {
                return false;
            }
            self.skip_ws();
            if self.consume_byte(b']') {
                return true;
            }
            if !self.consume_byte(b',') {
                return false;
            }
        }
    }

    fn parse_string(&mut self) -> bool {
        if !self.consume_byte(b'"') {
            return false;
        }

        while self.idx < self.s.len() {
            let Some(ch) = self.next_char() else {
                return false;
            };
            match ch {
                '"' => return true,
                '\\' => {
                    let Some(escaped) = self.next_byte() else {
                        return false;
                    };
                    match escaped {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {}
                        b'u' => {
                            for _ in 0..4 {
                                let Some(hex) = self.next_byte() else {
                                    return false;
                                };
                                if !hex.is_ascii_hexdigit() {
                                    return false;
                                }
                            }
                        }
                        _ => return false,
                    }
                }
                ch if ch <= '\u{1f}' => return false,
                _ => {}
            }
        }

        false
    }

    fn parse_number(&mut self) -> bool {
        let start = self.idx;
        let _ = self.consume_byte(b'-');

        match self.peek_byte() {
            Some(b'0') => {
                self.idx += 1;
            }
            Some(b'1'..=b'9') => {
                self.idx += 1;
                while matches!(self.peek_byte(), Some(b'0'..=b'9')) {
                    self.idx += 1;
                }
            }
            _ => return false,
        }

        if self.consume_byte(b'.') {
            if !matches!(self.peek_byte(), Some(b'0'..=b'9')) {
                return false;
            }
            while matches!(self.peek_byte(), Some(b'0'..=b'9')) {
                self.idx += 1;
            }
        }

        if matches!(self.peek_byte(), Some(b'e' | b'E')) {
            self.idx += 1;
            if matches!(self.peek_byte(), Some(b'+' | b'-')) {
                self.idx += 1;
            }
            if !matches!(self.peek_byte(), Some(b'0'..=b'9')) {
                return false;
            }
            while matches!(self.peek_byte(), Some(b'0'..=b'9')) {
                self.idx += 1;
            }
        }

        self.idx > start
    }

    fn consume_keyword(&mut self, keyword: &str) -> bool {
        if self.s[self.idx..].starts_with(keyword) {
            self.idx += keyword.len();
            true
        } else {
            false
        }
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek_byte(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.idx += 1;
        }
    }

    fn consume_byte(&mut self, byte: u8) -> bool {
        if self.peek_byte() == Some(byte) {
            self.idx += 1;
            true
        } else {
            false
        }
    }

    fn next_byte(&mut self) -> Option<u8> {
        let byte = self.peek_byte()?;
        self.idx += 1;
        Some(byte)
    }

    fn next_char(&mut self) -> Option<char> {
        let ch = self.s.get(self.idx..)?.chars().next()?;
        self.idx += ch.len_utf8();
        Some(ch)
    }

    fn peek_byte(&self) -> Option<u8> {
        self.s.as_bytes().get(self.idx).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MockTransport;
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct TestPath {
        path: PathBuf,
    }

    impl TestPath {
        fn new(name: &str) -> TestPath {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "xpair-host-permissions-test-{}-{id}-{name}.env",
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

    struct EnvGuard {
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvGuard {
        fn set(vars: &[(&'static str, Option<&str>)]) -> EnvGuard {
            let saved = vars
                .iter()
                .map(|(key, _)| (*key, std::env::var_os(key)))
                .collect::<Vec<_>>();
            for (key, value) in vars {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
            EnvGuard { saved }
        }

        fn remove(keys: &[&'static str]) -> EnvGuard {
            let saved = keys
                .iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect::<Vec<_>>();
            for key in keys {
                std::env::remove_var(key);
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

    fn without_env<T>(keys: &[&'static str], f: impl FnOnce() -> T) -> T {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = EnvGuard::remove(keys);
        f()
    }

    fn with_env<T>(vars: &[(&'static str, Option<&str>)], f: impl FnOnce() -> T) -> T {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = EnvGuard::set(vars);
        f()
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn alive_requires_pid_and_fresh_timestamp() {
        assert!(alive(Some(123), Some(95), 100));
        assert!(!alive(Some(123), Some(90), 100));
        assert!(!alive(None, Some(95), 100));
        assert!(!alive(Some(123), None, 100));
    }

    #[test]
    fn renders_compact_json_exactly() {
        assert_eq!(
            render_json(false, false, false, false, false, None, "no host"),
            "{\"alive\":false,\"ax\":false,\"sr\":false,\"fda\":false,\"sharing\":false,\"err\":\"no host\"}"
        );
        assert_eq!(
            render_json(true, true, false, true, true, Some(true), ""),
            "{\"alive\":true,\"ax\":true,\"sr\":false,\"fda\":true,\"sharing\":true,\"serving\":true,\"err\":\"\"}"
        );
    }

    #[test]
    fn parse_pid_present_and_absent() {
        assert_eq!(parse_pid(r#"{"pid":321,"ts":90}"#), Some(321));
        assert_eq!(parse_pid(r#"{"ts":90}"#), None);
        assert_eq!(parse_pid(r#"{"pid":null,"ts":90}"#), None);
    }

    #[test]
    fn status_json_render_reuses_status_fields_and_pid() {
        assert_eq!(
            render_status_json(
                r#"{"pid":123,"ts":95,"ax":true,"sr":false,"fda":true}"#,
                100
            ),
            "{\"alive\":true,\"ax\":true,\"sr\":false,\"fda\":true,\"sharing\":false,\"err\":\"\"}"
        );
        assert_eq!(
            render_status_json(r#"{"ts":95,"ax":true,"sr":true,"fda":false,"sharing":true,"serving":true}"#, 100),
            "{\"alive\":false,\"ax\":true,\"sr\":true,\"fda\":false,\"sharing\":true,\"serving\":true,\"err\":\"\"}"
        );
    }

    #[test]
    fn bad_status_json_renders_advisory_error() {
        assert_eq!(
            render_status_json(r#"{"pid":123,"ts":"#, 100),
            "{\"alive\":false,\"ax\":false,\"sr\":false,\"fda\":false,\"sharing\":false,\"err\":\"bad status.json\"}"
        );
    }

    #[test]
    fn host_query_uses_mock_transport_and_exact_remote_cmd() {
        let transport = MockTransport::new();
        transport.push_response(
            0,
            r#"{"pid":123,"ts":95,"ax":true,"sr":false,"fda":true,"sharing":true,"serving":false}"#,
        );
        let mut out = Vec::new();

        let code = run_with_transport(
            &args(&["--host", "mac-mini"]),
            None,
            100,
            &transport,
            &mut out,
        );

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "{\"alive\":true,\"ax\":true,\"sr\":false,\"fda\":true,\"sharing\":true,\"serving\":false,\"err\":\"\"}\n"
        );
        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].host, "mac-mini");
        assert_eq!(calls[0].remote_cmd, build_status_remote_cmd());
    }

    #[test]
    fn empty_host_stdout_renders_no_status_json() {
        let transport = MockTransport::new();
        transport.push_response(0, "");
        let mut out = Vec::new();

        let code = run_with_transport(
            &args(&["--host", "mac-mini"]),
            None,
            100,
            &transport,
            &mut out,
        );

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "{\"alive\":false,\"ax\":false,\"sr\":false,\"fda\":false,\"sharing\":false,\"err\":\"no status.json (host app not running?)\"}\n"
        );
        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].remote_cmd, build_status_remote_cmd());
    }

    #[test]
    fn no_host_renders_json_and_does_not_call_transport() {
        without_env(&["REMOTE_HOST"], || {
            let transport = MockTransport::new();
            let mut out = Vec::new();

            let code = run_with_transport(&args(&["--host", ""]), None, 100, &transport, &mut out);

            assert_eq!(code, ExitCode::SUCCESS);
            assert_eq!(
                String::from_utf8(out).unwrap(),
                "{\"alive\":false,\"ax\":false,\"sr\":false,\"fda\":false,\"sharing\":false,\"err\":\"no host\"}\n"
            );
            assert!(transport.calls().is_empty());
        });
    }

    #[test]
    fn host_falls_back_to_config_when_env_is_absent() {
        without_env(&["REMOTE_HOST"], || {
            let tmp = TestPath::new("config-host");
            tmp.write("REMOTE_HOST=mac-from-config\n");
            let transport = MockTransport::new();
            transport.push_response(0, r#"{"pid":1,"ts":99,"ax":false,"sr":true,"fda":false,"sharing":true,"serving":false}"#);
            let mut out = Vec::new();

            let code = run_with_transport(&[], Some(&tmp.path), 100, &transport, &mut out);

            assert_eq!(code, ExitCode::SUCCESS);
            assert_eq!(
                String::from_utf8(out).unwrap(),
                "{\"alive\":true,\"ax\":false,\"sr\":true,\"fda\":false,\"sharing\":true,\"serving\":false,\"err\":\"\"}\n"
            );
            let calls = transport.calls();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].host, "mac-from-config");
        });
    }

    #[test]
    fn windows_ssh_argv_includes_mux_neutralizer() {
        let rp_host_dir = std::env::temp_dir().join(format!(
            "xpair-host-permissions-test-{}-no-key",
            std::process::id()
        ));
        let rp_host_dir_s = rp_host_dir.to_string_lossy().into_owned();

        with_env(
            &[("RP_HOST_DIR", Some(&rp_host_dir_s)), ("RP_DIR", None)],
            || {
                assert_eq!(
                    build_ssh_argv(Os::Windows, "mac-mini", build_status_remote_cmd()),
                    vec![
                        "ssh",
                        "-o",
                        "BatchMode=yes",
                        "-o",
                        "ConnectTimeout=6",
                        "-o",
                        "ConnectionAttempts=1",
                        "-o",
                        "ControlMaster=no",
                        "-o",
                        "ControlPath=none",
                        "-o",
                        "PreferredAuthentications=publickey",
                        "-o",
                        "NumberOfPasswordPrompts=0",
                        "-o",
                        "StrictHostKeyChecking=yes",
                        "-T",
                        "-n",
                        "mac-mini",
                        "cat ~/.xpair/host/logs/status.json 2>/dev/null",
                    ]
                );
            },
        );
    }

    #[test]
    fn ssh_argv_offers_shared_pairing_identity_when_present() {
        let rp_host_dir = std::env::temp_dir().join(format!(
            "xpair-host-permissions-test-{}-pairing-key",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&rp_host_dir);
        fs::create_dir_all(&rp_host_dir).unwrap();
        let pairing_key = rp_host_dir.join("pairing_ed25519");
        fs::write(&pairing_key, "pairing-private").unwrap();
        let rp_host_dir_s = rp_host_dir.to_string_lossy().into_owned();
        let pairing_key_s = pairing_key.to_string_lossy().into_owned();

        with_env(
            &[("RP_HOST_DIR", Some(&rp_host_dir_s)), ("RP_DIR", None)],
            || {
                let argv = build_ssh_argv(Os::Linux, "mac-mini", build_status_remote_cmd());
                assert_eq!(argv[0], "ssh");
                assert_eq!(argv[1], "-i");
                assert_eq!(argv[2], pairing_key_s);
            },
        );

        let _ = fs::remove_dir_all(rp_host_dir);
    }
}
