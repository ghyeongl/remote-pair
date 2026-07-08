//! Session listing for `xpair ls`.
//!
//! Ports `cmd_ls_json()` and `cmd_ls()` from `client/cli/xpair:494-549`: a configured
//! host is queried for tmux-aqua sessions over SSH, `_keeper` sessions are hidden, and
//! JSON is compact with stable key order.

use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::config;
use crate::platform::Os;
use crate::remote_quote;
use crate::transport::{Output, Transport};

/// Bash default from `shared/config.sh:138` and `client/cli/xpair:78`.
pub const DEFAULT_AQUA_SOCK: &str = "/tmp/aqua-tmux.sock";

/// One tmux session parsed from `list-sessions -F '#S\t#{session_attached}'`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub name: String,
    pub attached: i64,
}

/// Real SSH transport used by the CLI binary.
///
/// All remote session listing still flows through [`Transport::ssh_exec`], keeping the
/// command construction and output handling testable with [`crate::transport::MockTransport`].
pub struct SshTransport;

impl Transport for SshTransport {
    fn ssh_exec(&self, host: &str, remote_cmd: &str) -> io::Result<Output> {
        let os = Os::current();
        let out = Command::new("ssh")
            .args(pairing_identity_args())
            .args(os.ssh_mux_neutralizer_args())
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"])
            .arg(host)
            .arg(remote_cmd)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()?;

        Ok(Output {
            code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        })
    }
}

/// SSH identity arguments for the restricted host pairing key.
///
/// Bash offers `$RP_HOST_DIR/pairing_ed25519` with `-i` only, deliberately without
/// `IdentitiesOnly`, so an unproven pairing key does not suppress the user's normal keys.
pub fn pairing_identity_args() -> Vec<String> {
    match pairing_key_path() {
        Ok(path) if path.is_file() => vec!["-i".to_string(), path.to_string_lossy().into_owned()],
        _ => Vec::new(),
    }
}

fn pairing_key_path() -> io::Result<PathBuf> {
    Ok(config::default_rp_dir()?.join("pairing_ed25519"))
}

/// Parse tab-separated `name<TAB>attached` rows.
///
/// Empty rows are ignored, rows whose names start with `_keeper` are skipped, and missing
/// or non-numeric attached fields default to zero.
pub fn parse_sessions(raw: &str) -> Vec<Session> {
    raw.lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let (name, attached_raw) = line.split_once('\t').unwrap_or((line, "0"));
            if name.starts_with("_keeper") {
                return None;
            }
            let attached = attached_raw.parse::<i64>().unwrap_or(0);
            Some(Session {
                name: name.to_string(),
                attached,
            })
        })
        .collect()
}

/// Render the compact JSON shape emitted by bash via `json.dumps(..., separators=(",", ":"))`.
pub fn render_json(target: &str, host: &str, sessions: &[Session]) -> String {
    let mut out = String::new();
    out.push_str("{\"target\":\"");
    push_json_string_body(&mut out, target);
    out.push_str("\",\"host\":\"");
    push_json_string_body(&mut out, host);
    out.push_str("\",\"sessions\":[");
    for (idx, session) in sessions.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        out.push_str("{\"name\":\"");
        push_json_string_body(&mut out, &session.name);
        out.push_str("\",\"attached\":");
        out.push_str(&session.attached.to_string());
        out.push('}');
    }
    out.push_str("]}");
    out
}

/// Render the human `xpair ls` report from an already-rendered map list and raw tmux stdout.
pub fn render_text(target: &str, host: &str, raw_session_stdout: &str, map_list: &str) -> String {
    let remote = target == "host" || target == "remote";
    let fallback = if remote {
        "  (none or unreachable)"
    } else {
        "  (none)"
    };

    let mut out = String::new();
    out.push_str(map_list.trim_end_matches(['\r', '\n']));
    out.push_str("\n\n");
    if remote && !host.is_empty() {
        out.push('[');
        out.push_str(host);
        out.push_str("] tmux-aqua sessions:\n");
    } else if remote {
        out.push_str("[no host configured] tmux-aqua sessions:\n");
        out.push_str("  (set one in Xpair.app or: xpair config set host <ssh-host>)\n");
        return out;
    } else {
        out.push_str("[local] tmux-aqua sessions:\n");
    }

    let mut wrote_session = false;
    for line in raw_session_stdout.lines() {
        if line.is_empty() || line.starts_with("_keeper") {
            continue;
        }
        out.push_str("  ");
        out.push_str(line);
        out.push('\n');
        wrote_session = true;
    }

    if !wrote_session {
        out.push_str(fallback);
        out.push('\n');
    }

    out
}

/// Render remote JSON by asking the host through the transport seam.
pub fn render_remote_json<T: Transport>(transport: &T, host: &str, aqua_sock: &str) -> String {
    render_remote_json_checked(transport, host, aqua_sock)
        .unwrap_or_else(|_| render_json("host", host, &[]))
}

/// Render remote JSON, preserving bash's distinction between "no sessions" and
/// ssh transport failure. Exit 255 means the state is unknown, not empty.
pub fn render_remote_json_checked<T: Transport>(
    transport: &T,
    host: &str,
    aqua_sock: &str,
) -> Result<String, RemoteListError> {
    match transport.ssh_exec(host, &remote_list_sessions_cmd(aqua_sock, true)) {
        Ok(out) if out.code == 255 => Err(RemoteListError::Transport),
        Ok(out) => Ok(render_json("host", host, &parse_sessions(&out.stdout))),
        Err(_) => Err(RemoteListError::Transport),
    }
}

/// Render remote human output by asking the host through the transport seam.
pub fn render_remote_text<T: Transport>(
    transport: &T,
    host: &str,
    aqua_sock: &str,
    map_list: &str,
) -> String {
    let raw = remote_stdout(transport, host, &remote_list_sessions_cmd(aqua_sock, false));
    render_text("host", host, &raw, map_list)
}

/// Render local JSON using a tiny `tmux` spawn shim.
pub fn render_local_json(aqua_sock: &str) -> String {
    let raw = local_list_sessions_stdout(aqua_sock, true);
    render_json("local", "", &parse_sessions(&raw))
}

/// Render local human output using a tiny `tmux` spawn shim.
pub fn render_local_text(aqua_sock: &str, map_list: &str) -> String {
    let raw = local_list_sessions_stdout(aqua_sock, false);
    render_text("local", "", &raw, map_list)
}

/// Match the bash `LOCAL_MODE` truth table (`1|true|TRUE|yes|YES|on|ON|local`).
pub fn local_mode_on_value(value: &str) -> bool {
    matches!(
        value,
        "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON" | "local"
    )
}

fn remote_stdout<T: Transport>(transport: &T, host: &str, remote_cmd: &str) -> String {
    match transport.ssh_exec(host, remote_cmd) {
        Ok(out) if out.code == 0 => out.stdout,
        _ => String::new(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteListError {
    Transport,
}

fn remote_list_sessions_cmd(aqua_sock: &str, json: bool) -> String {
    let sock = remote_quote::posix_single_quote(aqua_sock);
    if json {
        let format = remote_quote::posix_single_quote("#S\t#{session_attached}");
        format!("$HOME/.local/bin/tmux-aqua -S {sock} list-sessions -F {format} 2>/dev/null")
    } else {
        format!("$HOME/.local/bin/tmux-aqua -S {sock} list-sessions 2>/dev/null")
    }
}

fn local_list_sessions_stdout(aqua_sock: &str, json: bool) -> String {
    let mut command = Command::new("tmux");
    command
        .arg("-S")
        .arg(aqua_sock)
        .arg("list-sessions")
        .stdin(Stdio::null())
        .stderr(Stdio::null());

    if json {
        command.arg("-F").arg("#S\t#{session_attached}");
    }

    match command.output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MockTransport;

    #[test]
    fn parses_tsv_sessions_and_filters_keeper_rows() {
        assert_eq!(
            parse_sessions("alpha\t1\n_keeper\t1\nbeta\t0\ngamma\twat\ndelta\nmulti\t2\n"),
            vec![
                Session {
                    name: "alpha".to_string(),
                    attached: 1,
                },
                Session {
                    name: "beta".to_string(),
                    attached: 0,
                },
                Session {
                    name: "gamma".to_string(),
                    attached: 0,
                },
                Session {
                    name: "delta".to_string(),
                    attached: 0,
                },
                Session {
                    name: "multi".to_string(),
                    attached: 2,
                },
            ]
        );
    }

    #[test]
    fn renders_empty_json_exactly() {
        assert_eq!(
            render_json("local", "", &[]),
            "{\"target\":\"local\",\"host\":\"\",\"sessions\":[]}"
        );
    }

    #[test]
    fn renders_multi_session_json_with_escaped_names() {
        let sessions = vec![
            Session {
                name: "a\"b\\c\n\t\u{01}".to_string(),
                attached: 3,
            },
            Session {
                name: "plain".to_string(),
                attached: 0,
            },
        ];

        assert_eq!(
            render_json("host", "host", &sessions),
            "{\"target\":\"host\",\"host\":\"host\",\"sessions\":[{\"name\":\"a\\\"b\\\\c\\n\\t\\u0001\",\"attached\":3},{\"name\":\"plain\",\"attached\":0}]}"
        );
    }

    #[test]
    fn renders_remote_text_with_map_list_and_filtered_sessions() {
        assert_eq!(
            render_text(
                "host",
                "mac.local",
                "alpha: 1 windows\n_keeper: hidden\nbeta: 2 windows\n",
                "C:/work::/Users/me/work\nD:/repo::/Users/me/repo",
            ),
            "C:/work::/Users/me/work\nD:/repo::/Users/me/repo\n\n[mac.local] tmux-aqua sessions:\n  alpha: 1 windows\n  beta: 2 windows\n"
        );
    }

    #[test]
    fn renders_local_text_with_map_list_and_filtered_sessions() {
        assert_eq!(
            render_text("local", "", "_keeper: hidden\nalpha: 1 windows\n", "(none)",),
            "(none)\n\n[local] tmux-aqua sessions:\n  alpha: 1 windows\n"
        );
    }

    #[test]
    fn renders_remote_and_local_empty_fallbacks() {
        assert_eq!(
            render_text("host", "mac.local", "_keeper: hidden\n", "(none)"),
            "(none)\n\n[mac.local] tmux-aqua sessions:\n  (none or unreachable)\n"
        );
        assert_eq!(
            render_text("local", "", "", "(none)"),
            "(none)\n\n[local] tmux-aqua sessions:\n  (none)\n"
        );
        assert_eq!(
            render_text("host", "", "", "(none)"),
            "(none)\n\n[no host configured] tmux-aqua sessions:\n  (set one in Xpair.app or: xpair config set host <ssh-host>)\n"
        );
    }

    #[test]
    fn remote_text_uses_transport_and_quotes_aqua_sock() {
        let transport = MockTransport::new();
        transport.push_response(0, "alpha: 1 windows\n_keeper: hidden\n");

        let rendered = render_remote_text(
            &transport,
            "mac.local",
            "/tmp/aqua 'sock.sock",
            "C:/work::/Users/me/work",
        );

        assert_eq!(
            rendered,
            "C:/work::/Users/me/work\n\n[mac.local] tmux-aqua sessions:\n  alpha: 1 windows\n"
        );
        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].host, "mac.local");
        assert_eq!(
            calls[0].remote_cmd,
            r"$HOME/.local/bin/tmux-aqua -S '/tmp/aqua '\''sock.sock' list-sessions 2>/dev/null"
        );
    }

    #[test]
    fn remote_json_reports_transport_failure_instead_of_empty_list() {
        let transport = MockTransport::new();
        transport.push_response(255, "");

        assert_eq!(
            render_remote_json_checked(&transport, "mac.local", "/tmp/aqua"),
            Err(RemoteListError::Transport)
        );
    }

    #[test]
    fn remote_json_treats_non_transport_nonzero_as_empty_sessions() {
        let transport = MockTransport::new();
        transport.push_response(1, "");

        assert_eq!(
            render_remote_json_checked(&transport, "mac.local", "/tmp/aqua").unwrap(),
            "{\"target\":\"host\",\"host\":\"mac.local\",\"sessions\":[]}"
        );
    }
}
