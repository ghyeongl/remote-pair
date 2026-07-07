//! `xpair notify` host notification queue rendering.
//!
//! Ports `cmd_notify()` from `client/cli/xpair:2091-2154`: bash-compatible `-n`
//! parsing, local `notify.conf` `ENABLED_TYPES` semantics, best-effort host queue
//! tailing, and the python pretty-printer shape without adding a JSON dependency.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config;
use crate::session::SshTransport;
use crate::transport::{Output, Transport};

pub const DEFAULT_ENABLED_TYPES: &[&str] = &[
    "Stop",
    "Notification",
    "SubagentStop",
    "approve-wait",
    "approve",
];

const QUEUE_PATH: &str = "$HOME/.xpair/host/notifications/queue.jsonl";
const NO_RECENT: &str = "no recent host notifications (host unreachable, or queue empty)";

/// Parsed `xpair notify` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyReq {
    pub n: u32,
}

/// Parse `notify` flags.
///
/// Unknown args are ignored, matching `client/cli/xpair:2093-2098`. Invalid or
/// non-positive `-n` values fall back to 20.
pub fn parse_notify_args(args: &[String]) -> NotifyReq {
    let mut req = NotifyReq { n: 20 };
    let mut idx = 0;

    while idx < args.len() {
        match args[idx].as_str() {
            "-n" => {
                req.n = args
                    .get(idx + 1)
                    .and_then(|value| value.parse::<u32>().ok())
                    .filter(|n| *n > 0)
                    .unwrap_or(20);
                idx += 2;
            }
            _ => idx += 1,
        }
    }

    req
}

/// Parse the optional `ENABLED_TYPES=` assignment from `notify.conf`.
///
/// `None` means the key is absent and the caller should use the default set.
/// `Some(vec![])` means the key is present but empty, which disables all types.
/// Literal spaces are stripped from the value, mirroring bash `${v// /}`.
pub fn parse_enabled_types(conf_text: Option<&str>) -> Option<Vec<String>> {
    let conf_text = conf_text?;
    let mut last_value = None;

    for line in conf_text.lines() {
        if let Some(value) = enabled_types_value(line) {
            last_value = Some(value.to_string());
        }
    }

    last_value.map(|value| {
        value
            .replace(' ', "")
            .split(',')
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect()
    })
}

/// Extract a flat JSON string or scalar field without `serde`.
///
/// This is intentionally small and tolerant: it scans top-level-looking
/// `"key": value` pairs, understands JSON string escapes, and returns the last
/// matching key to mirror common JSON parser duplicate-key behavior.
pub fn extract_field(json_line: &str, key: &str) -> Option<String> {
    let mut idx = 0;
    let mut found = None;

    while idx < json_line.len() {
        if json_line.as_bytes().get(idx) != Some(&b'"') {
            idx += 1;
            continue;
        }

        let Some((candidate_key, after_key)) = parse_json_string_at(json_line, idx) else {
            idx += 1;
            continue;
        };

        let mut value_idx = skip_json_ws(json_line, after_key);
        if json_line.as_bytes().get(value_idx) != Some(&b':') {
            idx = after_key;
            continue;
        }
        value_idx = skip_json_ws(json_line, value_idx + 1);

        if let Some((value, after_value)) = parse_json_value_at(json_line, value_idx) {
            if candidate_key == key {
                found = Some(value);
            }
            idx = after_value;
        } else {
            idx = value_idx.saturating_add(1);
        }
    }

    found
}

/// Filter JSONL notification events and render bash-shaped rows.
///
/// This wrapper keeps the requested public shape. The clock-aware implementation
/// is split out for deterministic unit tests.
pub fn filter_and_render(
    raw_jsonl: &str,
    enabled: Option<&[String]>,
    default_types: &[&str],
) -> String {
    filter_and_render_at(raw_jsonl, enabled, default_types, now_ts())
}

/// Build the remote POSIX payload used to tail the host notification queue.
pub fn build_queue_tail_remote_cmd(n: u32) -> String {
    format!("tail -n {n} {QUEUE_PATH} 2>/dev/null")
}

/// CLI entrypoint for `xpair notify`.
pub fn run(args: &[String]) -> ExitCode {
    let client_env_path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair notify: {err}");
            return ExitCode::from(2);
        }
    };

    let transport = SshTransport;
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();

    run_with_transport(args, &client_env_path, &transport, &mut stdout, &mut stderr)
}

/// Testable runner: all host interaction flows through [`Transport`].
pub fn run_with_transport<T: Transport + ?Sized, W: Write, E: Write>(
    args: &[String],
    client_env_path: &Path,
    transport: &T,
    out: &mut W,
    err: &mut E,
) -> ExitCode {
    let settings = RuntimeSettings::load(client_env_path);
    run_with_transport_and_settings(args, &settings, transport, out, err)
}

fn run_with_transport_and_settings<T: Transport + ?Sized, W: Write, E: Write>(
    args: &[String],
    settings: &RuntimeSettings,
    transport: &T,
    out: &mut W,
    err: &mut E,
) -> ExitCode {
    let req = parse_notify_args(args);

    let Some(host) = settings
        .remote_host
        .as_deref()
        .filter(|host| !host.is_empty())
    else {
        let _ = writeln!(
            err,
            "no REMOTE_HOST configured — notify pulls from the host ('xpair config set host <ssh-host>')"
        );
        return ExitCode::SUCCESS;
    };

    let conf_text = fs::read_to_string(settings.host_dir.join("notify.conf")).ok();
    let enabled = parse_enabled_types(conf_text.as_deref());
    let remote_cmd = build_queue_tail_remote_cmd(req.n);
    let raw = match transport.ssh_exec(host, &remote_cmd) {
        Ok(Output { stdout, .. }) => stdout,
        Err(_) => String::new(),
    };

    if raw.is_empty() {
        let _ = writeln!(out, "{NO_RECENT}");
        return ExitCode::SUCCESS;
    }

    let rendered = filter_and_render(&raw, enabled.as_deref(), DEFAULT_ENABLED_TYPES);
    let _ = write!(out, "{rendered}");
    ExitCode::SUCCESS
}

fn filter_and_render_at(
    raw_jsonl: &str,
    enabled: Option<&[String]>,
    default_types: &[&str],
    now_ts: i64,
) -> String {
    let enabled_types = effective_enabled_types(enabled, default_types);
    if enabled_types.is_empty() {
        return String::new();
    }

    let mut rows = Vec::new();
    for line in raw_jsonl.lines() {
        let Some(event) = parse_event(line) else {
            continue;
        };

        if enabled_types.iter().any(|enabled| enabled == &event.typ) {
            rows.push(event);
        }
    }

    if rows.is_empty() {
        return no_match_line(&enabled_types);
    }

    let mut out = String::new();
    for event in rows {
        out.push_str(&render_event(&event, now_ts));
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NotifyEvent {
    typ: String,
    title: String,
    message: String,
    ts: Option<String>,
}

impl NotifyEvent {
    fn has_any_field(&self) -> bool {
        !self.typ.is_empty()
            || !self.title.is_empty()
            || !self.message.is_empty()
            || self.ts.is_some()
    }
}

struct RuntimeSettings {
    host_dir: PathBuf,
    remote_host: Option<String>,
}

impl RuntimeSettings {
    fn load(client_env_path: &Path) -> RuntimeSettings {
        RuntimeSettings::load_with_home(client_env_path, home_dir())
    }

    fn load_with_home(client_env_path: &Path, home: Option<PathBuf>) -> RuntimeSettings {
        RuntimeSettings {
            host_dir: host_dir(client_env_path, home.as_deref()),
            remote_host: non_empty_value(client_env_path, "REMOTE_HOST")
                .filter(|host| config::valid_host(host)),
        }
    }
}

fn enabled_types_value(line: &str) -> Option<&str> {
    let mut rest = line.trim_start();
    rest = rest.strip_prefix("ENABLED_TYPES")?;
    rest = rest.trim_start_matches(char::is_whitespace);
    rest = rest.strip_prefix('=')?;
    Some(rest.trim_start_matches(char::is_whitespace))
}

fn effective_enabled_types(enabled: Option<&[String]>, default_types: &[&str]) -> Vec<String> {
    let values: Vec<String> = match enabled {
        Some(values) => values.to_vec(),
        None => default_types
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
    };

    let mut out = Vec::new();
    for value in values {
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

fn parse_event(line: &str) -> Option<NotifyEvent> {
    let line = line.trim();
    if line.is_empty() || !line.starts_with('{') || !line.ends_with('}') {
        return None;
    }

    let event = NotifyEvent {
        typ: extract_field(line, "type").unwrap_or_default(),
        title: extract_field(line, "title").unwrap_or_default(),
        message: extract_field(line, "message").unwrap_or_default(),
        ts: extract_field(line, "ts").or_else(|| extract_field(line, "time")),
    };

    if event.has_any_field() {
        Some(event)
    } else {
        None
    }
}

fn render_event(event: &NotifyEvent, now_ts: i64) -> String {
    let typ = if event.typ.is_empty() {
        "?"
    } else {
        event.typ.as_str()
    };
    let age = match event.ts.as_deref() {
        Some(raw) => raw.parse::<i64>().map(|ts| now_ts - ts).unwrap_or(0),
        None => now_ts,
    };
    let message = compact_message(&event.message);

    let mut out = format!(
        "\x1b[1;33m[{typ:<12}]\x1b[0m {} ago  {}\n",
        format_age(age),
        event.title
    );
    if !message.is_empty() {
        out.push_str("                ");
        out.push_str(&message);
        out.push('\n');
    }
    out
}

fn compact_message(message: &str) -> String {
    let message = message.replace('\n', " ");
    if message.chars().count() <= 100 {
        return message;
    }

    let mut out = message.chars().take(99).collect::<String>();
    out.push('…');
    out
}

fn format_age(age: i64) -> String {
    if age < 90 {
        format!("{age}s")
    } else if age < 3600 {
        format!("{}m", age / 60)
    } else {
        format!("{}h", age / 3600)
    }
}

fn no_match_line(enabled_types: &[String]) -> String {
    let mut sorted = enabled_types.to_vec();
    sorted.sort();
    format!(
        "\x1b[1;36m▸ no notifications match ENABLED_TYPES={}\x1b[0m\n",
        sorted.join(",")
    )
}

fn parse_json_value_at(s: &str, start: usize) -> Option<(String, usize)> {
    match s.as_bytes().get(start) {
        Some(b'"') => parse_json_string_at(s, start),
        Some(b'{' | b'[') | None => None,
        Some(_) => parse_json_scalar_at(s, start),
    }
}

fn parse_json_string_at(s: &str, start: usize) -> Option<(String, usize)> {
    if s.as_bytes().get(start) != Some(&b'"') {
        return None;
    }

    let mut out = String::new();
    let mut idx = start + 1;
    while idx < s.len() {
        let ch = next_char(s, idx)?;
        idx += ch.len_utf8();
        match ch {
            '"' => return Some((out, idx)),
            '\\' => {
                let escaped = next_char(s, idx)?;
                idx += escaped.len_utf8();
                match escaped {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    '/' => out.push('/'),
                    'b' => out.push('\u{08}'),
                    'f' => out.push('\u{0c}'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'u' => {
                        if let Some((decoded, after_escape)) = parse_unicode_escape(s, idx) {
                            out.push(decoded);
                            idx = after_escape;
                        } else {
                            out.push('u');
                        }
                    }
                    other => out.push(other),
                }
            }
            other => out.push(other),
        }
    }

    None
}

fn parse_json_scalar_at(s: &str, start: usize) -> Option<(String, usize)> {
    let mut end = start;
    while end < s.len() {
        let ch = next_char(s, end)?;
        if ch == ',' || ch == '}' || ch.is_whitespace() {
            break;
        }
        end += ch.len_utf8();
    }

    let value = s[start..end].trim();
    if value.is_empty() {
        None
    } else {
        Some((value.to_string(), end))
    }
}

fn parse_unicode_escape(s: &str, start: usize) -> Option<(char, usize)> {
    let mut idx = start;
    let mut value = 0_u32;

    for _ in 0..4 {
        let ch = next_char(s, idx)?;
        let digit = ch.to_digit(16)?;
        value = (value << 4) | digit;
        idx += ch.len_utf8();
    }

    Some((char::from_u32(value).unwrap_or('\u{fffd}'), idx))
}

fn skip_json_ws(s: &str, mut idx: usize) -> usize {
    while idx < s.len() {
        let Some(ch) = next_char(s, idx) else {
            break;
        };
        if !ch.is_whitespace() {
            break;
        }
        idx += ch.len_utf8();
    }
    idx
}

fn next_char(s: &str, idx: usize) -> Option<char> {
    s.get(idx..)?.chars().next()
}

fn host_dir(client_env_path: &Path, home: Option<&Path>) -> PathBuf {
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

    default_rp_dir(home).unwrap_or_else(|| PathBuf::from("."))
}

fn default_rp_dir(home: Option<&Path>) -> Option<PathBuf> {
    home.map(|home| home.join(".xpair").join("host"))
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

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MockTransport;
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
            let nonce = now_ts();
            let path = std::env::temp_dir().join(format!(
                "xpair-notify-test-{}-{nonce}-{id}-{name}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            TestDir { path }
        }

        fn client_env_path(&self) -> PathBuf {
            self.path.join("client.env")
        }

        fn host_dir(&self) -> PathBuf {
            self.path.join("host")
        }

        fn write_client_env(&self, body: &str) {
            fs::write(self.client_env_path(), body).unwrap();
        }

        fn write_notify_conf(&self, body: &str) {
            fs::create_dir_all(self.host_dir()).unwrap();
            fs::write(self.host_dir().join("notify.conf"), body).unwrap();
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_file(self.client_env_path());
            let _ = fs::remove_file(self.path.join("notify.conf"));
            let _ = fs::remove_file(self.host_dir().join("notify.conf"));
            let _ = fs::remove_dir(self.host_dir());
            let _ = fs::remove_dir(&self.path);
        }
    }

    struct EnvGuard {
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvGuard {
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
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let _guard = EnvGuard::remove(keys);
        f()
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn enabled(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parse_args_default() {
        assert_eq!(parse_notify_args(&[]), NotifyReq { n: 20 });
    }

    #[test]
    fn parse_args_n_value() {
        assert_eq!(parse_notify_args(&args(&["-n", "7"])), NotifyReq { n: 7 });
    }

    #[test]
    fn parse_args_invalid_n_falls_back_to_default() {
        assert_eq!(
            parse_notify_args(&args(&["-n", "nope"])),
            NotifyReq { n: 20 }
        );
        assert_eq!(parse_notify_args(&args(&["-n", "0"])), NotifyReq { n: 20 });
        assert_eq!(parse_notify_args(&args(&["-n"])), NotifyReq { n: 20 });
    }

    #[test]
    fn parse_enabled_types_absent_is_none() {
        assert_eq!(parse_enabled_types(Some("OTHER=1\n")), None);
        assert_eq!(parse_enabled_types(None), None);
    }

    #[test]
    fn parse_enabled_types_empty_is_some_empty() {
        assert_eq!(
            parse_enabled_types(Some("  ENABLED_TYPES =   \n")),
            Some(Vec::new())
        );
    }

    #[test]
    fn parse_enabled_types_list_strips_spaces_and_uses_last_assignment() {
        assert_eq!(
            parse_enabled_types(Some(
                "ENABLED_TYPES=Stop, Notification\nENABLED_TYPES = approve-wait, approve \n"
            )),
            Some(vec!["approve-wait".to_string(), "approve".to_string()])
        );
    }

    #[test]
    fn extract_field_reads_string_scalar_missing_and_escaped_values() {
        let line = r#"{"type":"Stop","ts":123,"message":"a \"quoted\"\nline \u263a"}"#;
        assert_eq!(extract_field(line, "type"), Some("Stop".to_string()));
        assert_eq!(extract_field(line, "ts"), Some("123".to_string()));
        assert_eq!(
            extract_field(line, "message"),
            Some("a \"quoted\"\nline ☺".to_string())
        );
        assert_eq!(extract_field(line, "missing"), None);
    }

    #[test]
    fn filter_and_render_keeps_enabled_types_and_drops_others() {
        let enabled = enabled(&["Stop"]);
        let raw = concat!(
            r#"{"type":"Stop","title":"Done","message":"kept","ts":90}"#,
            "\n",
            r#"{"type":"Notification","title":"Drop","message":"dropped","ts":90}"#,
            "\n",
        );

        assert_eq!(
            filter_and_render_at(raw, Some(&enabled), DEFAULT_ENABLED_TYPES, 100),
            "\x1b[1;33m[Stop        ]\x1b[0m 10s ago  Done\n                kept\n"
        );
    }

    #[test]
    fn filter_and_render_empty_enabled_set_is_all_off() {
        let enabled = Vec::new();
        let raw = r#"{"type":"Stop","title":"Done","message":"hidden","ts":90}"#;

        assert_eq!(
            filter_and_render_at(raw, Some(&enabled), DEFAULT_ENABLED_TYPES, 100),
            ""
        );
    }

    #[test]
    fn filter_and_render_skips_invalid_lines_and_uses_default_types_when_absent() {
        let raw = concat!(
            "not-json\n",
            r#"{"type":"approve","title":"Approval","message":"kept","ts":70}"#,
            "\n",
            r#"{"type":"Other","title":"Drop","message":"dropped","ts":70}"#,
            "\n",
        );

        assert_eq!(
            filter_and_render_at(raw, None, DEFAULT_ENABLED_TYPES, 100),
            "\x1b[1;33m[approve     ]\x1b[0m 30s ago  Approval\n                kept\n"
        );
    }

    #[test]
    fn filter_and_render_public_wrapper_is_deterministic_for_invalid_ts() {
        let enabled = enabled(&["Stop"]);
        let raw = r#"{"type":"Stop","title":"Done","message":"line\nbreak","ts":"bad"}"#;

        assert_eq!(
            filter_and_render(raw, Some(&enabled), DEFAULT_ENABLED_TYPES),
            "\x1b[1;33m[Stop        ]\x1b[0m 0s ago  Done\n                line break\n"
        );
    }

    #[test]
    fn filter_and_render_reports_no_match_for_non_empty_filter() {
        let enabled = enabled(&["approve", "Stop"]);
        let raw = r#"{"type":"Notification","title":"Drop","message":"dropped","ts":90}"#;

        assert_eq!(
            filter_and_render_at(raw, Some(&enabled), DEFAULT_ENABLED_TYPES, 100),
            "\x1b[1;36m▸ no notifications match ENABLED_TYPES=Stop,approve\x1b[0m\n"
        );
    }

    #[test]
    fn filter_and_render_truncates_long_messages_like_bash() {
        let enabled = enabled(&["Stop"]);
        let long = "x".repeat(101);
        let raw = format!(r#"{{"type":"Stop","title":"Done","message":"{long}","ts":90}}"#);
        let expected_msg = format!("{}…", "x".repeat(99));

        assert_eq!(
            filter_and_render_at(&raw, Some(&enabled), DEFAULT_ENABLED_TYPES, 100),
            format!(
                "\x1b[1;33m[Stop        ]\x1b[0m 10s ago  Done\n                {expected_msg}\n"
            )
        );
    }

    #[test]
    fn build_queue_tail_remote_cmd_exact() {
        assert_eq!(
            build_queue_tail_remote_cmd(7),
            "tail -n 7 $HOME/.xpair/host/notifications/queue.jsonl 2>/dev/null"
        );
    }

    #[test]
    fn host_pull_uses_mock_transport_and_renders_canned_jsonl() {
        without_env(&["REMOTE_HOST", "RP_DIR", "RP_HOST_DIR"], || {
            let tmp = TestDir::new("host-pull");
            tmp.write_client_env("REMOTE_HOST=mac-mini\n");
            let transport = MockTransport::new();
            transport.push_response(
                0,
                concat!(
                    r#"{"type":"Stop","title":"Done","message":"hello\nworld","ts":"bad"}"#,
                    "\n"
                ),
            );
            let mut out = Vec::new();
            let mut err = Vec::new();

            let code = run_with_transport(
                &args(&["-n", "7"]),
                &tmp.client_env_path(),
                &transport,
                &mut out,
                &mut err,
            );

            assert_eq!(code, ExitCode::SUCCESS);
            assert_eq!(
                String::from_utf8(out).unwrap(),
                "\x1b[1;33m[Stop        ]\x1b[0m 0s ago  Done\n                hello world\n"
            );
            assert_eq!(String::from_utf8(err).unwrap(), "");
            let calls = transport.calls();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].host, "mac-mini");
            assert_eq!(calls[0].remote_cmd, build_queue_tail_remote_cmd(7));
        });
    }

    #[test]
    fn host_pull_empty_stdout_prints_no_recent_line() {
        without_env(&["REMOTE_HOST", "RP_DIR", "RP_HOST_DIR"], || {
            let tmp = TestDir::new("empty");
            tmp.write_client_env("REMOTE_HOST=mac-mini\n");
            let transport = MockTransport::new();
            transport.push_response(0, "");
            let mut out = Vec::new();
            let mut err = Vec::new();

            let code = run_with_transport(
                &args(&[]),
                &tmp.client_env_path(),
                &transport,
                &mut out,
                &mut err,
            );

            assert_eq!(code, ExitCode::SUCCESS);
            assert_eq!(
                String::from_utf8(out).unwrap(),
                "no recent host notifications (host unreachable, or queue empty)\n"
            );
            assert_eq!(String::from_utf8(err).unwrap(), "");
            let calls = transport.calls();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].remote_cmd, build_queue_tail_remote_cmd(20));
        });
    }

    #[test]
    fn run_honors_empty_notify_conf_as_all_off() {
        without_env(&["REMOTE_HOST", "RP_DIR", "RP_HOST_DIR"], || {
            let tmp = TestDir::new("all-off");
            tmp.write_client_env(&format!(
                "REMOTE_HOST=mac-mini\nRP_HOST_DIR={}\n",
                tmp.host_dir().to_string_lossy()
            ));
            tmp.write_notify_conf("ENABLED_TYPES=\n");
            let settings =
                RuntimeSettings::load_with_home(&tmp.client_env_path(), Some(tmp.path.clone()));
            let transport = MockTransport::new();
            transport.push_response(
                0,
                concat!(
                    r#"{"type":"Stop","title":"Done","message":"hidden","ts":"bad"}"#,
                    "\n"
                ),
            );
            let mut out = Vec::new();
            let mut err = Vec::new();

            let code = run_with_transport_and_settings(
                &args(&[]),
                &settings,
                &transport,
                &mut out,
                &mut err,
            );

            assert_eq!(code, ExitCode::SUCCESS);
            assert_eq!(String::from_utf8(out).unwrap(), "");
            assert_eq!(String::from_utf8(err).unwrap(), "");
        });
    }

    #[test]
    fn run_reads_notify_conf_from_host_dir_not_client_dir() {
        without_env(&["REMOTE_HOST", "RP_DIR", "RP_HOST_DIR"], || {
            let tmp = TestDir::new("host-conf");
            tmp.write_client_env(&format!(
                "REMOTE_HOST=mac-mini\nRP_HOST_DIR={}\n",
                tmp.host_dir().to_string_lossy()
            ));
            fs::write(tmp.path.join("notify.conf"), "ENABLED_TYPES=\n").unwrap();
            let settings =
                RuntimeSettings::load_with_home(&tmp.client_env_path(), Some(tmp.path.clone()));
            let transport = MockTransport::new();
            transport.push_response(
                0,
                concat!(
                    r#"{"type":"Stop","title":"Done","message":"visible","ts":"bad"}"#,
                    "\n"
                ),
            );
            let mut out = Vec::new();
            let mut err = Vec::new();

            let code = run_with_transport_and_settings(
                &args(&[]),
                &settings,
                &transport,
                &mut out,
                &mut err,
            );

            assert_eq!(code, ExitCode::SUCCESS);
            assert_eq!(
                String::from_utf8(out).unwrap(),
                "\x1b[1;33m[Stop        ]\x1b[0m 0s ago  Done\n                visible\n"
            );
            assert_eq!(String::from_utf8(err).unwrap(), "");
        });
    }
}
