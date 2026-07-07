//! `xpair discover` — peer discovery for the onboarding bridge.
//!
//! Ports `cmd_discover()` (`client/cli/xpair:1469-1758`): emit a normalized JSON peer
//! list on stdout (the Electron `onboarding-bridge.js` consumes it). Two modes:
//!
//!   - `--fingerprint <host>`: fetch ONE host's ed25519 key fingerprint
//!     (`ssh-keyscan | ssh-keygen -lf -`) for the manual-entry TOFU path →
//!     `{"fp":"SHA256:…"}` or `{"fp":null,"err":"…"}` (compact, matching the bash printf).
//!   - default: discover peers from **Tailscale** (`tailscale status --json`), cross-reference
//!     `~/.ssh/config` + `REMOTE_HOST`, dedup by host-key fingerprint, and emit a JSON array
//!     (spaced, matching the bash `python -c 'json.dumps(...)'` emitter).
//!
//! **LAN/Bonjour (`dns-sd`) discovery is intentionally not implemented here.** It is a
//! macOS-runtime-only path (decision **D6**: "mDNS dropped on Windows"); the bash already gates
//! it on `command -v dns-sd`, so a client without `dns-sd` contributes no LAN peers — which is
//! every non-macOS client. Surfacing it as deferred (not faked) keeps the peer list honest.
//!
//! Decomposition mirrors the other ported verbs: the JSON parse/merge/render core is pure and
//! unit-tested; the process spawns (`ssh -G`, `ssh-keyscan`, `ssh-keygen`, `tailscale`, and the
//! per-peer `host_app_present` SSH probe) are thin, uncovered shims.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};

use crate::platform::Os;

/// Roles that mark a peer as advertising the Xpair service (key-auth `connect`, not plain `setup`).
const XPAIR_ROLES: &[&str] = &["host", "both", "client"];

/// macOS install layouts for the Tailscale CLI (App Store sandbox, brew arm64, brew x86_64).
/// Ported from `rp_tailscale_bin()` (`client/cli/xpair:1457-1467`); harmless on non-macOS (the
/// absolute paths simply won't exist), where the PATH lookup for `tailscale[.exe]` takes over.
const MAC_TAILSCALE_PATHS: &[&str] = &[
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
];

// ─────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────────────

/// Parsed `discover` invocation. `--json` is accepted but a no-op (JSON is the only output mode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoverArgs {
    pub timeout: u32,
    pub fingerprint_host: Option<String>,
}

/// Parse `discover` args (`client/cli/xpair:1472-1479`). Default timeout 4; a non-numeric
/// `--timeout` resets to 4. Unknown tokens are ignored, matching the bash `*) shift` arm.
pub fn parse_args(args: &[String]) -> DiscoverArgs {
    let mut timeout_raw = String::from("4");
    let mut fingerprint_host = None;
    let mut idx = 0;
    while idx < args.len() {
        match args[idx].as_str() {
            "--json" => idx += 1,
            "--timeout" => {
                timeout_raw = args.get(idx + 1).cloned().unwrap_or_default();
                idx += 2;
            }
            "--fingerprint" => {
                fingerprint_host = Some(args.get(idx + 1).cloned().unwrap_or_default());
                idx += 2;
            }
            _ => idx += 1,
        }
    }
    let timeout = if !timeout_raw.is_empty() && timeout_raw.bytes().all(|b| b.is_ascii_digit()) {
        timeout_raw.parse::<u32>().unwrap_or(4)
    } else {
        4
    };
    DiscoverArgs {
        timeout,
        fingerprint_host,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// --fingerprint mode (compact JSON, matching the bash printf)
// ─────────────────────────────────────────────────────────────────────────────

/// Normalize a fingerprint to the canonical `SHA256:…` form (accept bare base64).
/// Ports `rp_norm_fp()` (`client/cli/xpair:1445-1446`).
pub fn normalize_fp(s: &str) -> String {
    if s.starts_with("SHA256:") {
        s.to_string()
    } else {
        format!("SHA256:{s}")
    }
}

/// Extract a single field value from `ssh -G <host>` output (e.g. `hostname` / `port`).
/// `ssh -G` prints lowercase `key value` lines; we return the first match's first token.
pub fn parse_ssh_g_field(output: &str, key: &str) -> Option<String> {
    for line in output.lines() {
        let mut it = line.split_whitespace();
        if it.next() == Some(key) {
            if let Some(value) = it.next() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Extract the fingerprint from `ssh-keygen -lf -` output (`<bits> SHA256:… host (TYPE)`):
/// field 2 of the first line, mirroring the bash `awk '{print $2}' | head -1`.
pub fn keygen_fp_field(keygen_output: &str) -> Option<String> {
    let first = keygen_output.lines().next()?;
    first.split_whitespace().nth(1).map(str::to_string)
}

/// Render the `--fingerprint` result exactly as the bash printf does (compact, no spaces).
pub fn render_fingerprint_json(fp: Option<&str>, host: &str) -> String {
    match fp {
        Some(fp) if !fp.is_empty() => {
            let mut out = String::from("{\"fp\":\"");
            push_json_string_body(&mut out, fp);
            out.push_str("\"}");
            out
        }
        _ => {
            let mut out = String::from("{\"fp\":null,\"err\":\"could not fetch host key for ");
            push_json_string_body(&mut out, host);
            out.push_str("\"}");
            out
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery records
// ─────────────────────────────────────────────────────────────────────────────

/// One discovered record before dedup: tab-separated `name addr source fp role` in the bash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub name: String,
    pub addr: String,
    pub source: String,
    pub fp: String,
    pub role: String,
}

/// A deduped/merged peer as emitted to the bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutPeer {
    pub name: String,
    pub addrs: Vec<String>,
    pub target: String,
    pub source: String,
    pub sources: Vec<String>,
    pub fp: Option<String>,
    pub status: String,
}

/// Parse `tailscale status --json` into discovery records (`client/cli/xpair:1578-1619`).
///
/// Iterates `Peer` values in order; skips devices whose `OS` is KNOWN-non-macOS (XpairHost is a
/// macOS app — keep unknown/empty OS to avoid dropping a real Mac with missing metadata). Name is
/// `DNSName` (trailing dot stripped) falling back to `HostName`; addr is the first `TailscaleIPs`
/// entry (else the name); role column carries the online/offline hint. A parse failure yields an
/// empty list (the bash swallows it via `except: sys.exit(0)`).
pub fn parse_tailscale_peers(json: &str) -> Vec<Record> {
    let mut records = Vec::new();
    let Some(root) = JsonValue::parse(json) else {
        return records;
    };
    let Some(peers) = root.get("Peer").and_then(JsonValue::as_object) else {
        return records;
    };
    for (_key, peer) in peers {
        let os = peer
            .get("OS")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !os.is_empty() && os != "macos" {
            continue;
        }
        let name = peer
            .get("DNSName")
            .and_then(JsonValue::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| peer.get("HostName").and_then(JsonValue::as_str))
            .unwrap_or("")
            .trim_end_matches('.')
            .to_string();
        if name.is_empty() {
            continue;
        }
        let addr = peer
            .get("TailscaleIPs")
            .and_then(JsonValue::as_array)
            .and_then(|ips| ips.first())
            .and_then(JsonValue::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| name.clone());
        let online = peer
            .get("Online")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        records.push(Record {
            name,
            addr,
            source: "tailscale".to_string(),
            fp: String::new(),
            role: if online { "online" } else { "offline" }.to_string(),
        });
    }
    records
}

/// Parse all `Host` alias tokens from an `ssh_config` body (`client/cli/xpair:1627-1639`).
pub fn parse_ssh_config_aliases(cfg_text: &str) -> BTreeSet<String> {
    let mut aliases = BTreeSet::new();
    for line in cfg_text.lines() {
        let trimmed = line.trim_start();
        // Case-insensitive `Host` keyword, separated by whitespace or `=`.
        let rest = strip_keyword_ci(trimmed, "host");
        if let Some(rest) = rest {
            for tok in rest.split_whitespace() {
                aliases.insert(tok.to_string());
            }
        }
    }
    aliases
}

/// Strip a leading case-insensitive keyword followed by whitespace or `=`; return the remainder.
fn strip_keyword_ci<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let bytes = line.as_bytes();
    let kw = keyword.as_bytes();
    if bytes.len() <= kw.len() {
        return None;
    }
    if !line[..kw.len()].eq_ignore_ascii_case(keyword) {
        return None;
    }
    let sep = bytes[kw.len()];
    if sep == b' ' || sep == b'\t' || sep == b'=' {
        Some(line[kw.len() + 1..].trim_start())
    } else {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedup + cross-reference + status (the python emitter, `client/cli/xpair:1621-1757`)
// ─────────────────────────────────────────────────────────────────────────────

struct PeerAcc {
    name: String,
    addrs: Vec<String>,
    sources: Vec<String>,
    fp: Option<String>,
    role: String,
}

/// Merge records into deduped peers and resolve each peer's connect `status`.
///
/// `present` is the injected `host_app_present` probe (real impl = SSH; tests pass a stub), so the
/// reconnect-vs-setup decision is unit-testable without a host. Dedup key is the fingerprint when
/// present, else `name:<name>`; insertion order is preserved (bash uses an ordered `order` list).
pub fn build_peers(
    records: &[Record],
    aliases: &BTreeSet<String>,
    remote_host: &str,
    present: impl Fn(&str) -> Option<bool>,
) -> Vec<OutPeer> {
    let mut order: Vec<String> = Vec::new();
    let mut peers: HashMap<String, PeerAcc> = HashMap::new();

    for r in records {
        let key = if !r.fp.is_empty() {
            r.fp.clone()
        } else {
            format!("name:{}", r.name)
        };
        let entry = peers.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            PeerAcc {
                name: r.name.clone(),
                addrs: Vec::new(),
                sources: Vec::new(),
                fp: if r.fp.is_empty() {
                    None
                } else {
                    Some(r.fp.clone())
                },
                role: r.role.clone(),
            }
        });
        if !r.addr.is_empty() && !entry.addrs.contains(&r.addr) {
            entry.addrs.push(r.addr.clone());
        }
        if !r.source.is_empty() && !entry.sources.contains(&r.source) {
            entry.sources.push(r.source.clone());
        }
        if entry.fp.is_none() && !r.fp.is_empty() {
            entry.fp = Some(r.fp.clone());
        }
        if entry.role.is_empty() && XPAIR_ROLES.contains(&r.role.as_str()) {
            entry.role = r.role.clone();
        }
    }

    let mut out = Vec::new();
    for key in &order {
        let p = &peers[key];
        let mut name = p.name.clone();
        if let Some(alias) = alias_for(&name, &p.addrs, aliases) {
            if alias != name {
                name = alias; // surface the ssh-config alias as the connect/install target
            }
        }
        let addr = p.addrs.first().cloned().unwrap_or_else(|| name.clone());
        let src = p
            .sources
            .first()
            .cloned()
            .unwrap_or_else(|| "ssh".to_string());
        let target = if aliases.contains(&name) || name == remote_host {
            name.clone()
        } else if !addr.is_empty() {
            addr.clone()
        } else {
            name.clone()
        };
        let status = status_for(&name, &addr, &p.role, aliases, remote_host, &present);
        out.push(OutPeer {
            name,
            addrs: p.addrs.clone(),
            target,
            source: src,
            sources: p.sources.clone(),
            fp: p.fp.clone(),
            status,
        });
    }
    out
}

/// Prefer an ssh-config `Host` alias for this peer (full name, the short first label of a tailnet
/// FQDN, or any addr) so install/connect uses the alias's IdentityFile + User. `client/cli/xpair:1713-1722`.
fn alias_for(name: &str, addrs: &[String], aliases: &BTreeSet<String>) -> Option<String> {
    let short = name.split('.').next().unwrap_or(name).to_string();
    let mut cands = vec![name.to_string(), short];
    cands.extend(addrs.iter().cloned());
    cands
        .into_iter()
        .find(|cand| !cand.is_empty() && aliases.contains(cand))
}

/// Connect status for a peer (`client/cli/xpair:1673-1683`): known in ssh config / `REMOTE_HOST`
/// → `reconnect` only when the host app is CONFIRMED present (else `setup`); an Xpair-role peer →
/// `connect`; otherwise plain SSH `setup`.
fn status_for(
    name: &str,
    addr: &str,
    role: &str,
    aliases: &BTreeSet<String>,
    remote_host: &str,
    present: &impl Fn(&str) -> Option<bool>,
) -> String {
    let known = aliases.contains(name)
        || aliases.contains(addr)
        || name == remote_host
        || addr == remote_host;
    if known {
        let probe_target = if aliases.contains(name) { name } else { addr };
        return if present(probe_target) == Some(true) {
            "reconnect".to_string()
        } else {
            "setup".to_string()
        };
    }
    if XPAIR_ROLES.contains(&role) {
        "connect".to_string()
    } else {
        "setup".to_string()
    }
}

/// Render the peer array as `python json.dumps(out)` would (`", "` / `": "` separators).
pub fn render_peers_json(peers: &[OutPeer]) -> String {
    let mut out = String::from("[");
    for (i, p) in peers.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push('{');
        push_json_kv_str(&mut out, "name", &p.name, true);
        push_json_key(&mut out, "addrs", false);
        push_json_string_array(&mut out, &p.addrs);
        push_json_kv_str(&mut out, "target", &p.target, false);
        push_json_kv_str(&mut out, "source", &p.source, false);
        push_json_key(&mut out, "sources", false);
        push_json_string_array(&mut out, &p.sources);
        push_json_key(&mut out, "fp", false);
        match &p.fp {
            Some(fp) => push_json_quoted(&mut out, fp),
            None => out.push_str("null"),
        }
        push_json_kv_str(&mut out, "status", &p.status, false);
        out.push('}');
    }
    out.push(']');
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Tailscale binary location (pure selector + thin shims)
// ─────────────────────────────────────────────────────────────────────────────

/// First existing candidate path, or `None`. Pure: `exists` is injected (real = `Path::is_file`).
/// Ports `rp_tailscale_bin()` selection (`client/cli/xpair:1457-1467`).
pub fn find_tailscale(candidates: &[String], exists: impl Fn(&str) -> bool) -> Option<String> {
    candidates.iter().find(|c| exists(c)).cloned()
}

/// Build the ordered Tailscale candidate list: the macOS absolute paths, then `tailscale[.exe]`
/// under each `PATH` entry (the `command -v tailscale` analogue).
fn tailscale_candidates() -> Vec<String> {
    let mut cands: Vec<String> = MAC_TAILSCALE_PATHS.iter().map(|s| s.to_string()).collect();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["tailscale", "tailscale.exe"] {
                cands.push(dir.join(name).to_string_lossy().into_owned());
            }
        }
    }
    cands
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entrypoint + process shims
// ─────────────────────────────────────────────────────────────────────────────

/// CLI entrypoint for `xpair discover`.
pub fn run(args: &[String]) -> ExitCode {
    let parsed = parse_args(args);
    let os = Os::current();
    let mut stdout = io::stdout();

    if let Some(host) = parsed.fingerprint_host {
        let fp = fetch_host_fingerprint(&host, parsed.timeout);
        let _ = writeln!(stdout, "{}", render_fingerprint_json(fp.as_deref(), &host));
        return ExitCode::SUCCESS;
    }

    // LAN/Bonjour (dns-sd) discovery is deferred (D6, macOS-runtime-only) — no records.
    let mut records = Vec::new();
    if let Some(bin) = find_tailscale(&tailscale_candidates(), |p| Path::new(p).is_file()) {
        if let Some(json) = run_tailscale_status(&bin) {
            records.extend(parse_tailscale_peers(&json));
        }
    }

    let aliases = parse_ssh_config_aliases(&read_ssh_config());
    let remote_host = non_empty_env("REMOTE_HOST").unwrap_or_default();
    let peers = build_peers(&records, &aliases, &remote_host, |target| {
        ssh_host_app_present(os, target)
    });

    let _ = writeln!(stdout, "{}", render_peers_json(&peers));
    ExitCode::SUCCESS
}

/// `ssh-keyscan | ssh-keygen -lf -` fingerprint shim (uncovered — network/process glue).
/// Resolves an ssh-config alias to its real HostName/Port via `ssh -G` first, as the bash does.
fn fetch_host_fingerprint(host: &str, timeout: u32) -> Option<String> {
    if host.is_empty() {
        return None;
    }
    let g = Command::new("ssh")
        .args(["-G", host])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let scan_host = parse_ssh_g_field(&g, "hostname").unwrap_or_else(|| host.to_string());
    let scan_port = parse_ssh_g_field(&g, "port").unwrap_or_else(|| "22".to_string());

    let keyscan = Command::new("ssh-keyscan")
        .args([
            "-t",
            "ed25519",
            "-T",
            &timeout.to_string(),
            "-p",
            &scan_port,
            &scan_host,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let keyscan_out = String::from_utf8_lossy(&keyscan.stdout).into_owned();
    if keyscan_out.trim().is_empty() {
        return None;
    }

    let mut child = Command::new("ssh-keygen")
        .args(["-lf", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(keyscan_out.as_bytes());
    }
    let out = child.wait_with_output().ok()?;
    keygen_fp_field(&String::from_utf8_lossy(&out.stdout))
}

/// `tailscale status --json` shim (uncovered — process glue).
fn run_tailscale_status(bin: &str) -> Option<String> {
    let out = Command::new(bin)
        .args(["status", "--json"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `host_app_present` SSH probe shim (uncovered — network). Returns `Some(true)` when
/// XpairHost.app is confirmed installed, `Some(false)`/`None` otherwise (both → `setup`).
/// Hardened ssh opts (publickey-only, batch, tight timeout) keep it from hanging on a cold link.
fn ssh_host_app_present(os: Os, target: &str) -> Option<bool> {
    let mut argv: Vec<&str> = vec![
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=4",
        "-o",
        "ConnectionAttempts=1",
    ];
    argv.extend(os.ssh_mux_neutralizer_args());
    argv.extend([
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "NumberOfPasswordPrompts=0",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-T",
        "-n",
        target,
        "[ -d /Applications/XpairHost.app ] || [ -d $HOME/Applications/XpairHost.app ]",
    ]);
    let status = Command::new("ssh")
        .args(&argv)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    Some(status.success())
}

fn read_ssh_config() -> String {
    let path = std::env::var_os("RP_SSH_CFG")
        .map(std::path::PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".ssh").join("config")));
    path.and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(std::path::PathBuf::from)
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON emit helpers (compact string escaping, shared shape with host_permissions.rs)
// ─────────────────────────────────────────────────────────────────────────────

fn push_json_kv_str(out: &mut String, key: &str, value: &str, first: bool) {
    push_json_key(out, key, first);
    push_json_quoted(out, value);
}

fn push_json_key(out: &mut String, key: &str, first: bool) {
    if !first {
        out.push_str(", ");
    }
    push_json_quoted(out, key);
    out.push_str(": ");
}

fn push_json_string_array(out: &mut String, items: &[String]) {
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        push_json_quoted(out, item);
    }
    out.push(']');
}

fn push_json_quoted(out: &mut String, value: &str) {
    out.push('"');
    push_json_string_body(out, value);
    out.push('"');
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

// ─────────────────────────────────────────────────────────────────────────────
// Minimal JSON value parser (for the nested `tailscale status --json` Peer map)
// ─────────────────────────────────────────────────────────────────────────────

/// A parsed JSON value. Only the variants needed to walk `tailscale status --json` are kept;
/// objects preserve key order (`Peer` is iterated in order, like Python's ordered dict).
#[derive(Debug, Clone, PartialEq)]
enum JsonValue {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Arr(Vec<JsonValue>),
    Obj(Vec<(String, JsonValue)>),
}

impl JsonValue {
    fn parse(s: &str) -> Option<JsonValue> {
        let mut p = JsonReader::new(s);
        p.skip_ws();
        let v = p.value()?;
        p.skip_ws();
        if p.idx == p.bytes.len() {
            Some(v)
        } else {
            None
        }
    }

    fn get(&self, key: &str) -> Option<&JsonValue> {
        match self {
            JsonValue::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            JsonValue::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    fn as_bool(&self) -> Option<bool> {
        match self {
            JsonValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    fn as_array(&self) -> Option<&[JsonValue]> {
        match self {
            JsonValue::Arr(items) => Some(items),
            _ => None,
        }
    }

    fn as_object(&self) -> Option<&[(String, JsonValue)]> {
        match self {
            JsonValue::Obj(fields) => Some(fields),
            _ => None,
        }
    }
}

struct JsonReader<'a> {
    bytes: &'a [u8],
    idx: usize,
}

impl<'a> JsonReader<'a> {
    fn new(s: &'a str) -> Self {
        Self {
            bytes: s.as_bytes(),
            idx: 0,
        }
    }

    fn value(&mut self) -> Option<JsonValue> {
        self.skip_ws();
        match self.peek()? {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => self.string().map(JsonValue::Str),
            b't' => self.keyword("true", JsonValue::Bool(true)),
            b'f' => self.keyword("false", JsonValue::Bool(false)),
            b'n' => self.keyword("null", JsonValue::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn object(&mut self) -> Option<JsonValue> {
        self.idx += 1; // consume '{'
        let mut fields = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.idx += 1;
            return Some(JsonValue::Obj(fields));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return None;
            }
            self.idx += 1;
            let val = self.value()?;
            fields.push((key, val));
            self.skip_ws();
            match self.peek()? {
                b',' => {
                    self.idx += 1;
                }
                b'}' => {
                    self.idx += 1;
                    return Some(JsonValue::Obj(fields));
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self) -> Option<JsonValue> {
        self.idx += 1; // consume '['
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.idx += 1;
            return Some(JsonValue::Arr(items));
        }
        loop {
            let val = self.value()?;
            items.push(val);
            self.skip_ws();
            match self.peek()? {
                b',' => {
                    self.idx += 1;
                }
                b']' => {
                    self.idx += 1;
                    return Some(JsonValue::Arr(items));
                }
                _ => return None,
            }
        }
    }

    fn string(&mut self) -> Option<String> {
        if self.peek() != Some(b'"') {
            return None;
        }
        self.idx += 1;
        let mut s = String::new();
        loop {
            let b = self.peek()?;
            self.idx += 1;
            match b {
                b'"' => return Some(s),
                b'\\' => {
                    let esc = self.peek()?;
                    self.idx += 1;
                    match esc {
                        b'"' => s.push('"'),
                        b'\\' => s.push('\\'),
                        b'/' => s.push('/'),
                        b'b' => s.push('\u{08}'),
                        b'f' => s.push('\u{0c}'),
                        b'n' => s.push('\n'),
                        b'r' => s.push('\r'),
                        b't' => s.push('\t'),
                        b'u' => {
                            let cp = self.hex4()?;
                            // Decode a UTF-16 surrogate pair if present; else the bare scalar.
                            if (0xD800..=0xDBFF).contains(&cp) {
                                if self.peek() == Some(b'\\') {
                                    self.idx += 1;
                                    if self.peek() == Some(b'u') {
                                        self.idx += 1;
                                        let lo = self.hex4()?;
                                        let c = 0x10000
                                            + (((cp - 0xD800) as u32) << 10)
                                            + (lo - 0xDC00) as u32;
                                        s.push(char::from_u32(c).unwrap_or('\u{FFFD}'));
                                    } else {
                                        s.push('\u{FFFD}');
                                    }
                                } else {
                                    s.push('\u{FFFD}');
                                }
                            } else {
                                s.push(char::from_u32(cp as u32).unwrap_or('\u{FFFD}'));
                            }
                        }
                        _ => return None,
                    }
                }
                // A raw byte (possibly a UTF-8 lead byte): re-decode the char from the source.
                _ => {
                    self.idx -= 1;
                    let ch = self.next_char()?;
                    s.push(ch);
                }
            }
        }
    }

    fn hex4(&mut self) -> Option<u16> {
        let mut v: u16 = 0;
        for _ in 0..4 {
            let b = self.peek()?;
            self.idx += 1;
            let d = match b {
                b'0'..=b'9' => b - b'0',
                b'a'..=b'f' => b - b'a' + 10,
                b'A'..=b'F' => b - b'A' + 10,
                _ => return None,
            };
            v = v * 16 + d as u16;
        }
        Some(v)
    }

    fn number(&mut self) -> Option<JsonValue> {
        let start = self.idx;
        if self.peek() == Some(b'-') {
            self.idx += 1;
        }
        while matches!(
            self.peek(),
            Some(b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
        ) {
            self.idx += 1;
        }
        if self.idx == start {
            return None;
        }
        let raw = std::str::from_utf8(&self.bytes[start..self.idx]).ok()?;
        Some(JsonValue::Num(raw.to_string()))
    }

    fn keyword(&mut self, word: &str, val: JsonValue) -> Option<JsonValue> {
        if self.bytes[self.idx..].starts_with(word.as_bytes()) {
            self.idx += word.len();
            Some(val)
        } else {
            None
        }
    }

    fn next_char(&mut self) -> Option<char> {
        let rest = std::str::from_utf8(&self.bytes[self.idx..]).ok()?;
        let ch = rest.chars().next()?;
        self.idx += ch.len_utf8();
        Some(ch)
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.idx += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.idx).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    fn aliases(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    fn rec(name: &str, addr: &str, source: &str, fp: &str, role: &str) -> Record {
        Record {
            name: name.into(),
            addr: addr.into(),
            source: source.into(),
            fp: fp.into(),
            role: role.into(),
        }
    }

    // ── args ──

    #[test]
    fn parse_args_defaults_and_overrides() {
        assert_eq!(
            parse_args(&[]),
            DiscoverArgs {
                timeout: 4,
                fingerprint_host: None
            }
        );
        assert_eq!(parse_args(&args(&["--json", "--timeout", "9"])).timeout, 9);
        // non-numeric timeout falls back to 4
        assert_eq!(parse_args(&args(&["--timeout", "abc"])).timeout, 4);
        assert_eq!(parse_args(&args(&["--timeout"])).timeout, 4);
        assert_eq!(
            parse_args(&args(&["--fingerprint", "mac-mini"])).fingerprint_host,
            Some("mac-mini".to_string())
        );
        // unknown tokens ignored
        assert_eq!(parse_args(&args(&["whatever", "--json"])).timeout, 4);
    }

    // ── fingerprint mode ──

    #[test]
    fn normalize_fp_prefixes_bare_base64() {
        assert_eq!(normalize_fp("SHA256:abc"), "SHA256:abc");
        assert_eq!(normalize_fp("abc"), "SHA256:abc");
    }

    #[test]
    fn parse_ssh_g_field_extracts_hostname_and_port() {
        let g = "user root\nhostname 192.168.1.5\nport 2222\nforwardagent no\n";
        assert_eq!(
            parse_ssh_g_field(g, "hostname"),
            Some("192.168.1.5".to_string())
        );
        assert_eq!(parse_ssh_g_field(g, "port"), Some("2222".to_string()));
        assert_eq!(parse_ssh_g_field(g, "missing"), None);
    }

    #[test]
    fn keygen_fp_field_takes_second_token_of_first_line() {
        let out = "256 SHA256:AbCdEf0123 mac-mini (ED25519)\n";
        assert_eq!(keygen_fp_field(out), Some("SHA256:AbCdEf0123".to_string()));
        assert_eq!(keygen_fp_field(""), None);
    }

    #[test]
    fn render_fingerprint_json_compact() {
        assert_eq!(
            render_fingerprint_json(Some("SHA256:xyz"), "mac-mini"),
            "{\"fp\":\"SHA256:xyz\"}"
        );
        assert_eq!(
            render_fingerprint_json(None, "mac-mini"),
            "{\"fp\":null,\"err\":\"could not fetch host key for mac-mini\"}"
        );
        assert_eq!(
            render_fingerprint_json(Some(""), "h"),
            "{\"fp\":null,\"err\":\"could not fetch host key for h\"}"
        );
    }

    // ── tailscale parse ──

    #[test]
    fn parse_tailscale_peers_filters_non_macos_and_extracts_fields() {
        let json = r#"{
          "Peer": {
            "k1": {"OS":"macOS","DNSName":"gh-mac-m1.tailnet.ts.net.","HostName":"gh-mac-m1","TailscaleIPs":["100.64.0.1","fd7a::1"],"Online":true},
            "k2": {"OS":"linux","DNSName":"pi.tailnet.ts.net.","TailscaleIPs":["100.64.0.2"],"Online":false},
            "k3": {"OS":"","HostName":"mystery","TailscaleIPs":[],"Online":false}
          }
        }"#;
        let recs = parse_tailscale_peers(json);
        assert_eq!(recs.len(), 2, "linux peer dropped");
        assert_eq!(recs[0].name, "gh-mac-m1.tailnet.ts.net");
        assert_eq!(recs[0].addr, "100.64.0.1");
        assert_eq!(recs[0].source, "tailscale");
        assert_eq!(recs[0].role, "online");
        // empty OS kept; no IPs → addr falls back to name; offline
        assert_eq!(recs[1].name, "mystery");
        assert_eq!(recs[1].addr, "mystery");
        assert_eq!(recs[1].role, "offline");
    }

    #[test]
    fn parse_tailscale_peers_tolerates_garbage_and_missing_peer() {
        assert!(parse_tailscale_peers("not json").is_empty());
        assert!(parse_tailscale_peers("{}").is_empty());
        assert!(parse_tailscale_peers(r#"{"Peer":null}"#).is_empty());
    }

    // ── ssh config aliases ──

    #[test]
    fn parse_ssh_config_aliases_collects_host_tokens() {
        let cfg = "Host gh-mac-m1 mac-alias\n  HostName 10.0.0.1\nhost=other\n# Host commented\n  Host indented\n";
        let al = parse_ssh_config_aliases(cfg);
        assert!(al.contains("gh-mac-m1"));
        assert!(al.contains("mac-alias"));
        assert!(al.contains("other"));
        assert!(al.contains("indented"));
        assert!(!al.contains("HostName"));
        assert!(!al.contains("commented"));
    }

    // ── build_peers / status ──

    #[test]
    fn build_peers_dedups_by_fp_and_merges_addrs_sources() {
        let recs = vec![
            rec("mac", "100.64.0.1", "tailscale", "SHA256:k", "online"),
            rec("mac", "192.168.1.9", "lan", "SHA256:k", "host"),
        ];
        let peers = build_peers(&recs, &aliases(&[]), "", |_| None);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].addrs, vec!["100.64.0.1", "192.168.1.9"]);
        assert_eq!(peers[0].sources, vec!["tailscale", "lan"]);
        assert_eq!(peers[0].fp, Some("SHA256:k".to_string()));
        // role first-set to "online" (not in XPAIR_ROLES) → stays "online" → not "connect"
        assert_eq!(peers[0].source, "tailscale");
    }

    #[test]
    fn status_connect_for_xpair_role_not_in_config() {
        let recs = vec![rec("peer", "100.64.0.5", "lan", "SHA256:z", "host")];
        let peers = build_peers(&recs, &aliases(&[]), "", |_| None);
        assert_eq!(peers[0].status, "connect");
        assert_eq!(peers[0].target, "100.64.0.5");
    }

    #[test]
    fn status_setup_for_plain_peer() {
        let recs = vec![rec("peer", "100.64.0.6", "tailscale", "", "online")];
        let peers = build_peers(&recs, &aliases(&[]), "", |_| None);
        assert_eq!(peers[0].status, "setup");
    }

    #[test]
    fn status_reconnect_only_when_host_app_confirmed_present() {
        let recs = vec![rec("gh-mac-m1", "100.64.0.1", "tailscale", "", "online")];
        // known via ssh-config alias + app confirmed present → reconnect, target = alias
        let present = build_peers(&recs, &aliases(&["gh-mac-m1"]), "", |t| {
            assert_eq!(t, "gh-mac-m1");
            Some(true)
        });
        assert_eq!(present[0].status, "reconnect");
        assert_eq!(present[0].target, "gh-mac-m1");
        // known but app NOT confirmed (None/false) → setup
        let absent = build_peers(&recs, &aliases(&["gh-mac-m1"]), "", |_| None);
        assert_eq!(absent[0].status, "setup");
        let absent2 = build_peers(&recs, &aliases(&["gh-mac-m1"]), "", |_| Some(false));
        assert_eq!(absent2[0].status, "setup");
    }

    #[test]
    fn status_reconnect_keys_off_remote_host_too() {
        let recs = vec![rec(
            "mac.tailnet.ts.net",
            "100.64.0.1",
            "tailscale",
            "",
            "online",
        )];
        let peers = build_peers(&recs, &aliases(&[]), "mac.tailnet.ts.net", |_| Some(true));
        assert_eq!(peers[0].status, "reconnect");
        // target prefers the name when it equals REMOTE_HOST
        assert_eq!(peers[0].target, "mac.tailnet.ts.net");
    }

    #[test]
    fn build_peers_surfaces_short_label_alias() {
        // tailnet FQDN whose short label matches an ssh-config alias → alias surfaced as name/target
        let recs = vec![rec(
            "gh-mac-m1.tailnet.ts.net",
            "100.64.0.1",
            "tailscale",
            "",
            "online",
        )];
        let peers = build_peers(&recs, &aliases(&["gh-mac-m1"]), "", |_| Some(true));
        assert_eq!(peers[0].name, "gh-mac-m1");
        assert_eq!(peers[0].target, "gh-mac-m1");
        assert_eq!(peers[0].status, "reconnect");
    }

    // ── JSON emit ──

    #[test]
    fn render_peers_json_empty_is_bracket_pair() {
        assert_eq!(render_peers_json(&[]), "[]");
    }

    #[test]
    fn render_peers_json_matches_python_dumps_spacing() {
        let peers = vec![OutPeer {
            name: "gh-mac-m1".into(),
            addrs: vec!["100.64.0.1".into(), "192.168.1.9".into()],
            target: "gh-mac-m1".into(),
            source: "tailscale".into(),
            sources: vec!["tailscale".into()],
            fp: None,
            status: "reconnect".into(),
        }];
        assert_eq!(
            render_peers_json(&peers),
            "[{\"name\": \"gh-mac-m1\", \"addrs\": [\"100.64.0.1\", \"192.168.1.9\"], \"target\": \"gh-mac-m1\", \"source\": \"tailscale\", \"sources\": [\"tailscale\"], \"fp\": null, \"status\": \"reconnect\"}]"
        );
    }

    #[test]
    fn render_peers_json_emits_fp_string_when_present() {
        let peers = vec![OutPeer {
            name: "p".into(),
            addrs: vec![],
            target: "p".into(),
            source: "ssh".into(),
            sources: vec![],
            fp: Some("SHA256:k".into()),
            status: "setup".into(),
        }];
        assert_eq!(
            render_peers_json(&peers),
            "[{\"name\": \"p\", \"addrs\": [], \"target\": \"p\", \"source\": \"ssh\", \"sources\": [], \"fp\": \"SHA256:k\", \"status\": \"setup\"}]"
        );
    }

    // ── tailscale binary location ──

    #[test]
    fn find_tailscale_returns_first_existing() {
        let cands = vec![
            "/nope/tailscale".to_string(),
            "/opt/homebrew/bin/tailscale".to_string(),
        ];
        let found = find_tailscale(&cands, |p| p == "/opt/homebrew/bin/tailscale");
        assert_eq!(found, Some("/opt/homebrew/bin/tailscale".to_string()));
        assert_eq!(find_tailscale(&cands, |_| false), None);
    }

    // ── JSON parser internals ──

    #[test]
    fn json_parser_decodes_escapes_and_nesting() {
        let v = JsonValue::parse(r#"{"a":"x\ny","b":[1,true,null],"c":{"d":"e"}}"#).unwrap();
        assert_eq!(v.get("a").and_then(JsonValue::as_str), Some("x\ny"));
        assert_eq!(
            v.get("b").and_then(JsonValue::as_array).map(<[_]>::len),
            Some(3)
        );
        assert_eq!(
            v.get("c")
                .and_then(|c| c.get("d"))
                .and_then(JsonValue::as_str),
            Some("e")
        );
        assert!(JsonValue::parse("{bad}").is_none());
        assert!(JsonValue::parse("{} trailing").is_none());
    }
}
