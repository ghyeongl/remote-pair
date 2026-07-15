//! `log` — the `rust` component's conforming logger for the Xpair logging
//! contract (see `docs/logging.md`).
//!
//! Emits the unified line
//!
//! ```text
//! [<ISO-8601 ts>] [<LEVEL>] [rust] [<session>] <message>
//! ```
//!
//! to `~/.xpair/host/logs/rust.log`, level-gated by `EnvFilter`
//! (`REMOTEPAIR_LOG` > `RUST_LOG` > `info`), with size-based rotate-on-open
//! (5 MB → `.1` → `.2`, max 3) under a `flock(2)` advisory lock.
//!
//! ## Why a custom `Layer` instead of the stock `fmt` layer
//!
//! `tracing_subscriber::fmt` cannot produce this exact bracket grammar (it owns
//! its own field/timestamp formatting). Rather than fight `FormatEvent`, we
//! implement a tiny `Layer` whose `on_event` extracts the event's `message`
//! field, formats the contract line by hand, and writes it through a shared
//! `Mutex<File>` in one `write_all` (a single `write(2)`, atomic ≤ PIPE_BUF for
//! normal log lines). The session id is a **process-global** (`set_session`):
//! this crate serves exactly one pair session per process, so a global is more
//! robust than threading a span field through every call site.

use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{EnvFilter, Layer};

/// Component tag for this crate, per the contract's comp→file map (§2).
const COMP: &str = "rust";
/// Rotate when the live log exceeds this many bytes (contract §7: 5 MB).
const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// Keep the live file plus this many `.N` backups (contract §7: max 3 total).
const MAX_BACKUPS: u32 = 2;

/// Process-global correlation id (contract §5). `-` until `set_session` is
/// called (app-level / non-session events use `-`).
static SESSION: OnceLock<Mutex<String>> = OnceLock::new();

/// The shared, open handle to `rust.log`. The custom layer writes every record
/// through this single `Mutex<File>` so concurrent threads cannot interleave
/// partial lines.
static FILE: OnceLock<Mutex<File>> = OnceLock::new();

fn session_cell() -> &'static Mutex<String> {
    SESSION.get_or_init(|| Mutex::new("-".to_string()))
}

/// Set the process-global session id used in the `[session]` column. Pass the
/// tmux session name (the cross-machine correlation id); app-level processes may
/// leave it at the default `-`.
pub fn set_session(s: String) {
    let s = if s.is_empty() { "-".to_string() } else { s };
    *session_cell().lock().unwrap() = s;
}

fn current_session() -> String {
    session_cell().lock().unwrap().clone()
}

/// `~/.xpair/host/logs`.
fn log_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".xpair").join("host").join("logs")
}

/// `~/.xpair/host/logs/rust.log`.
fn log_path() -> PathBuf {
    log_dir().join("rust.log")
}

/// Lock file guarding the rotate-on-open critical section. Per-file so it does
/// not contend with other components' locks.
fn lock_path() -> PathBuf {
    log_dir().join(".rust.log.lock")
}

/// Create `~/.xpair/host/logs` mode 0700 (idempotent). Logs hold host names and
/// paths, so the dir is owner-only (contract §1).
fn ensure_dir() -> std::io::Result<()> {
    let dir = log_dir();
    if !dir.exists() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
    } else {
        // Tighten perms if the dir pre-existed with looser bits (best-effort).
        if let Ok(meta) = std::fs::metadata(&dir) {
            let mut perms = meta.permissions();
            if perms.mode() & 0o777 != 0o700 {
                perms.set_mode(0o700);
                let _ = std::fs::set_permissions(&dir, perms);
            }
        }
    }
    Ok(())
}

/// RAII wrapper around a `flock(2)` advisory exclusive lock on the lock fd.
/// Held across the size-check + rename so a second starting process (or the
/// mid-run guard) cannot clobber a backup or write to an unlinked inode.
struct FlockGuard(File);

impl FlockGuard {
    /// Acquire `LOCK_EX` on the lock file, creating it if needed. Returns `None`
    /// on any error (we then proceed unlocked — rotation is single-process at
    /// start in the common case, so a missing lock degrades to the documented
    /// "racing is minimal" behavior rather than blocking startup).
    fn acquire() -> Option<FlockGuard> {
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(lock_path())
            .ok()?;
        // SAFETY: flock on a valid fd; LOCK_EX blocks until exclusive.
        let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) };
        if rc != 0 {
            return None;
        }
        Some(FlockGuard(f))
    }
}

impl Drop for FlockGuard {
    fn drop(&mut self) {
        // SAFETY: fd is still valid until the File drops after us.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

/// Size-check + shift `rust.log → .1 → .2` (max [`MAX_BACKUPS`] backups) if the
/// live file exceeds [`ROTATE_BYTES`]. Runs under [`FlockGuard`] so concurrent
/// starters / the mid-run guard cannot interleave. No-op when the file is small
/// or absent.
fn rotate_if_needed() {
    let path = log_path();
    let size = match std::fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(_) => return, // no live file yet → nothing to rotate
    };
    if size <= ROTATE_BYTES {
        return;
    }

    let _guard = FlockGuard::acquire();
    // Re-check under the lock: another process may have just rotated.
    match std::fs::metadata(&path) {
        Ok(m) if m.len() > ROTATE_BYTES => {}
        _ => return,
    }

    // Drop the oldest, then shift each backup up by one: .1→.2, live→.1.
    let dir = log_dir();
    let oldest = dir.join(format!("rust.log.{MAX_BACKUPS}"));
    let _ = std::fs::remove_file(&oldest);
    let mut n = MAX_BACKUPS;
    while n > 1 {
        let from = dir.join(format!("rust.log.{}", n - 1));
        let to = dir.join(format!("rust.log.{n}"));
        let _ = std::fs::rename(&from, &to);
        n -= 1;
    }
    let _ = std::fs::rename(&path, dir.join("rust.log.1"));
}

/// Open (or re-open) `rust.log` for appending and store it as the shared writer.
fn open_file() -> std::io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
}

/// Format the local-tz ISO-8601 timestamp `YYYY-MM-DDTHH:MM:SS+ZZZZ` (second
/// precision; contract §3). Computed from `SystemTime` + the host's UTC offset
/// (via `localtime_r`) to avoid a chrono dependency.
fn iso8601_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as libc::time_t;

    // SAFETY: localtime_r writes into our stack `tm`; we read it after.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }

    let off = tm.tm_gmtoff; // seconds east of UTC
    let sign = if off >= 0 { '+' } else { '-' };
    let off_abs = off.unsigned_abs();
    let off_h = off_abs / 3600;
    let off_m = (off_abs % 3600) / 60;

    let mut s = String::with_capacity(25);
    let _ = write!(
        s,
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        sign,
        off_h,
        off_m,
    );
    s
}

/// Map a `tracing::Level` to the contract's upper-case level token (§3/§4).
fn level_str(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => "ERROR",
        Level::WARN => "WARN",
        Level::INFO => "INFO",
        Level::DEBUG => "DEBUG",
        Level::TRACE => "TRACE",
    }
}

/// Extracts the `message` field (the macro's format-string body) from an event.
struct MessageVisitor {
    message: String,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            // The `message` field arrives as a Debug value; `{:?}` of a
            // fmt::Arguments renders the formatted string without quotes.
            let _ = write!(self.message, "{value:?}");
        }
    }
}

/// §6 REMOTE_HOST for redaction — env wins, else parsed once from ~/.xpair/client/client.env.
static REMOTE_HOST: OnceLock<Option<String>> = OnceLock::new();
fn remote_host() -> Option<String> {
    REMOTE_HOST
        .get_or_init(|| {
            if let Ok(h) = std::env::var("REMOTE_HOST") {
                if !h.trim().is_empty() {
                    return Some(h);
                }
            }
            let home = std::env::var_os("HOME")?;
            let path = std::path::Path::new(&home).join(".xpair/client/client.env");
            let raw = std::fs::read_to_string(path).ok()?;
            for line in raw.lines() {
                if let Some(v) = line.trim().strip_prefix("REMOTE_HOST=") {
                    let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
                    if !v.is_empty() {
                        return Some(v.to_string());
                    }
                }
            }
            None
        })
        .clone()
}

/// §6 redaction: mask the home dir → ~ and REMOTE_HOST → <host> before any sink (logs may be
/// shipped via `xpair logs --collect`). Best-effort, message body only.
fn redact(s: &str) -> String {
    let mut r = s.to_string();
    if let Some(home) = std::env::var_os("HOME").and_then(|h| h.into_string().ok()) {
        if !home.is_empty() {
            r = r.replace(&home, "~");
        }
    }
    if let Some(host) = remote_host() {
        if !host.is_empty() {
            r = r.replace(&host, "<host>");
        }
    }
    r
}

/// Compiled-once regexes backing [`scrub_outbound`]. Kept behind the
/// `crash-report` feature because only the Sentry `before_send` path needs the
/// strict (over-)masking; local logs deliberately keep full paths (see the
/// module/`redact` docs and `docs/logging.md` §6). Each pattern is anchored on
/// word/segment boundaries so it masks the secret without eating surrounding
/// punctuation.
#[cfg(feature = "crash-report")]
struct OutboundRes {
    /// `*.ts.net` tailnet hostnames (matched FIRST, before the IP/path passes,
    /// so a `host-7.tailnet.ts.net` collapses to `<host>` as one unit).
    ts_net: regex::Regex,
    /// IPv6 literals (full, `::`-compressed, and `fe80::1`-style link-local).
    /// Run before IPv4 so an IPv4-mapped tail does not get half-masked.
    ipv6: regex::Regex,
    /// Dotted-quad IPv4 literals.
    ipv4: regex::Regex,
    /// Absolute filesystem paths: the named macOS/Linux roots plus a generic
    /// `/<seg>/<seg>/…` fallback. Run AFTER the host/IP passes so it cannot eat
    /// an already-substituted `<ip>`/`<host>` token (those have no leading `/`).
    abs_path: regex::Regex,
}

#[cfg(feature = "crash-report")]
fn outbound_res() -> &'static OutboundRes {
    static RES: OnceLock<OutboundRes> = OnceLock::new();
    RES.get_or_init(|| OutboundRes {
        // tailnet: <label>.…(.<label>)+.ts.net  → <host>. `(?i-u)` = ASCII-only
        // case-insensitivity (the char classes are ASCII), avoiding the regex
        // crate's `unicode-case` feature.
        ts_net: regex::Regex::new(r"(?i-u)\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.ts\.net\b")
            .expect("ts.net regex"),
        // IPv6: a hex-group/`::` run with at least one `:` pair, optionally a
        // `%zone` or `/prefix` suffix. Broad on purpose (outbound = mask-heavy).
        // `(?i-u)`: ASCII-only case-insensitivity (hex digits are ASCII).
        ipv6: regex::Regex::new(
            r"(?i-u)\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}(?:%[0-9a-z]+)?\b|\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4})?\b|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4}\b",
        )
        .expect("ipv6 regex"),
        // IPv4 dotted quad.
        ipv4: regex::Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").expect("ipv4 regex"),
        // Absolute paths. Named roots first (so /private/var/folders/… and
        // /Users/<name>/… collapse whole), then a generic 2+-segment abs path.
        // `[^\s:"']` segments stop at whitespace/quotes/colon so a "path: x"
        // label or a `file:line` suffix is not swallowed.
        abs_path: regex::Regex::new(
            r#"(?:/private/var/folders|/var/folders|/Users|/home|/tmp|/private/tmp)(?:/[^\s:"'<>]+)+|/[^\s:"'<>/]+/[^\s:"'<>/]+(?:/[^\s:"'<>]*)*"#,
        )
        .expect("abs_path regex"),
    })
}

/// Strict OUTBOUND scrubber — the last line of defense before any telemetry /
/// Sentry payload leaves the machine. **Composes the local-log [`redact`]**
/// (`$HOME` -> `~`, `REMOTE_HOST` -> `<host>`) and then additionally masks the
/// classes that `redact` deliberately does NOT touch (so local debug logs keep
/// full paths, per `docs/logging.md` §6):
///
///   * `*.ts.net` tailnet hostnames -> `<host>`
///   * IPv6 + IPv4 literals          -> `<ip>`
///   * absolute paths (`/Users/<name>`, `/home/<name>`,
///     `/private/var/folders/..`, `/var/folders/..`, `/tmp/..`, and any generic
///     `/<seg>/<seg>/..`) -> `<path>`
///
/// Pass order is deliberate: `redact` (turns the local `$HOME` into `~` so it is
/// not re-masked as a generic `<path>`), then hostnames, then IPv6, then IPv4,
/// then absolute paths (which therefore cannot eat an already-substituted
/// `<ip>`/`<host>`). This is intentionally aggressive — over-masking an outbound
/// crash report is acceptable; leaking an IP/path is not.
#[cfg(feature = "crash-report")]
fn scrub_outbound(s: &str) -> String {
    let res = outbound_res();
    let r = redact(s);
    let r = res.ts_net.replace_all(&r, "<host>");
    let r = res.ipv6.replace_all(&r, "<ip>");
    let r = res.ipv4.replace_all(&r, "<ip>");
    let r = res.abs_path.replace_all(&r, "<path>");
    r.into_owned()
}

/// Read a single `KEY=value` line from `~/.xpair/client/client.env` (the same
/// file [`remote_host`] parses), honoring quotes. `None` if absent/empty. Used
/// for the telemetry consent + DSN settings, mirroring the env>file>default
/// precedent of `REMOTEPAIR_LOG`/`REMOTE_HOST`. Only the crash reporter consumes
/// these settings, so they are compiled only when that feature is enabled.
#[cfg(feature = "crash-report")]
fn client_env_value(key: &str) -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home).join(".xpair/client/client.env");
    let raw = std::fs::read_to_string(path).ok()?;
    let prefix = format!("{key}=");
    for line in raw.lines() {
        if let Some(v) = line.trim().strip_prefix(&prefix) {
            let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Resolve a telemetry setting: env var wins, else `client.env`, else `None`
/// (precedent: `REMOTE_HOST`/`REMOTEPAIR_LOG` — env > file > default).
#[cfg(feature = "crash-report")]
fn telemetry_setting(key: &str) -> Option<String> {
    if let Ok(v) = std::env::var(key) {
        let v = v.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    client_env_value(key)
}

/// `crash_report_consent` (spec: gates Sentry; **default false / opt-in**).
/// Read from `CRASH_REPORT_CONSENT` (env > `~/.xpair/client/client.env`). Truthy
/// = `1`/`true`/`yes`/`on` (case-insensitive). Anything else (including absent)
/// => `false` => Sentry is never initialized => ZERO network calls.
#[cfg(feature = "crash-report")]
fn crash_report_consent() -> bool {
    match telemetry_setting("CRASH_REPORT_CONSENT") {
        Some(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        None => false,
    }
}

/// The custom layer: formats and persists the unified contract line for every
/// event whose level passes the `EnvFilter`.
struct RemotePairLayer;

impl<S: Subscriber> Layer<S> for RemotePairLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = MessageVisitor {
            message: String::new(),
        };
        event.record(&mut visitor);

        let meta = event.metadata();
        let line = format!(
            "[{}] [{}] [{}] [{}] {}\n",
            iso8601_now(),
            level_str(meta.level()),
            COMP,
            current_session(),
            redact(&visitor.message),
        );

        if let Some(file) = FILE.get() {
            if let Ok(mut f) = file.lock() {
                // One write_all → one write(2) for a contract-sized line.
                let _ = f.write_all(line.as_bytes());
            }
        }
    }
}

/// Build the `EnvFilter`: `REMOTEPAIR_LOG` if set, else `RUST_LOG` if set, else
/// `info` (contract §4 precedence; Rust additionally honors `RUST_LOG`).
fn build_filter() -> EnvFilter {
    if let Ok(v) = std::env::var("REMOTEPAIR_LOG") {
        if !v.trim().is_empty() {
            return EnvFilter::new(v);
        }
    }
    if let Ok(v) = std::env::var("RUST_LOG") {
        if !v.trim().is_empty() {
            return EnvFilter::new(v);
        }
    }
    EnvFilter::new("info")
}

/// Initialize the global tracing subscriber. Idempotent-safe to call once early
/// in `main` (after [`set_session`]). Creates the log dir (0700), rotates on
/// open if oversized, opens `rust.log`, and installs the custom layer behind the
/// resolved `EnvFilter`.
pub fn init() {
    if ensure_dir().is_err() {
        // Without a dir we cannot persist; install nothing and let the process
        // run silently rather than panic.
        return;
    }
    rotate_if_needed();

    match open_file() {
        Ok(f) => {
            let _ = FILE.set(Mutex::new(f));
        }
        Err(_) => return,
    }

    // Crash reporting (Sentry) MUST init before the local panic hook so the
    // hook chain ends up [local dump -> sentry capture -> default]: see
    // `init_crash_reporter` + `install_panic_hook`. No-op when consent is off,
    // the DSN is absent, or the `crash-report` feature is disabled.
    init_crash_reporter();
    install_panic_hook();

    let _ = tracing_subscriber::registry()
        .with(RemotePairLayer.with_filter(build_filter()))
        .try_init();
}

/// Seconds since the Unix epoch — used to name crash-dump files uniquely.
fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Keep the Sentry client guard alive for the whole process. Dropping it would
/// flush + disable the client; storing it in a process-global keeps crash
/// reporting active until exit (the guard's `Drop` then flushes pending events).
#[cfg(feature = "crash-report")]
static SENTRY_GUARD: OnceLock<sentry::ClientInitGuard> = OnceLock::new();

/// Scrub every PII-bearing string in a Sentry [`Event`] through the strict
/// outbound scrubber [`scrub_outbound`] (which composes the local-log [`redact`]
/// with IPv4/IPv6 -> `<ip>`, broad absolute paths -> `<path>`, and `*.ts.net` ->
/// `<host>`). This is the `before_send` last line of defense: panic messages and
/// backtrace frame paths are the usual leak, but a raw IPv4/IPv6, a tailnet
/// `*.ts.net` name, or an other-user `/Users/<name>/…` path can ride along too,
/// so we mask aggressively over **every** free-text surface:
///   * message / culprit / transaction / logger / log entry
///   * every exception value + module + frame string field
///   * every thread frame and the deprecated top-level stacktrace
///   * breadcrumb messages
///   * `contexts` string values (the hardware `device` context is DROPPED — the
///     `device_arch` super-property already carries the only useful bit and the
///     model id is a fingerprint), `extra` values, and `tags` values
///
/// It also CLEARS `user` and `request` (they only carry PII — ip/email/cookies/
/// headers) and force-nulls `server_name`. The `server_name = None` here is
/// **load-bearing**, not merely defensive: Sentry's `ContextIntegration`
/// repopulates `server_name` (the hostname) *after* client init, so clearing it
/// only at `ClientOptions` build time is insufficient — `before_send` is the one
/// place that runs after that integration.
#[cfg(feature = "crash-report")]
fn scrub_event(mut event: sentry::protocol::Event<'static>) -> sentry::protocol::Event<'static> {
    fn scrub_opt(s: &mut Option<String>) {
        if let Some(v) = s {
            *v = scrub_outbound(v);
        }
    }
    fn scrub_frames(st: &mut sentry::protocol::Stacktrace) {
        for f in &mut st.frames {
            scrub_opt(&mut f.function);
            scrub_opt(&mut f.symbol);
            scrub_opt(&mut f.module);
            scrub_opt(&mut f.package);
            scrub_opt(&mut f.filename);
            scrub_opt(&mut f.abs_path);
            scrub_opt(&mut f.context_line);
            for line in &mut f.pre_context {
                *line = scrub_outbound(line);
            }
            for line in &mut f.post_context {
                *line = scrub_outbound(line);
            }
        }
    }
    // Recursively scrub every string leaf of a serde_json value in place (used
    // for `extra` values and the serialized form of each `contexts` entry).
    fn scrub_json(v: &mut serde_json::Value) {
        match v {
            serde_json::Value::String(s) => *s = scrub_outbound(s),
            serde_json::Value::Array(a) => a.iter_mut().for_each(scrub_json),
            serde_json::Value::Object(o) => o.values_mut().for_each(scrub_json),
            _ => {}
        }
    }

    // Never ship a server/host name. Load-bearing: ContextIntegration sets this
    // AFTER init, so the init-time `server_name: None` alone is not enough — this
    // `before_send` clear is the one that actually wins.
    event.server_name = None;

    // Drop PII-only carriers wholesale (ip_address/email/username, request
    // url/cookies/headers/env). Nothing here is useful for crash triage.
    event.user = None;
    event.request = None;

    scrub_opt(&mut event.message);
    scrub_opt(&mut event.culprit);
    scrub_opt(&mut event.transaction);
    scrub_opt(&mut event.logger);
    if let Some(le) = &mut event.logentry {
        le.message = scrub_outbound(&le.message);
    }

    for ex in &mut event.exception.values {
        scrub_opt(&mut ex.value);
        scrub_opt(&mut ex.module);
        if let Some(st) = &mut ex.stacktrace {
            scrub_frames(st);
        }
        if let Some(st) = &mut ex.raw_stacktrace {
            scrub_frames(st);
        }
    }

    for th in &mut event.threads.values {
        if let Some(st) = &mut th.stacktrace {
            scrub_frames(st);
        }
        if let Some(st) = &mut th.raw_stacktrace {
            scrub_frames(st);
        }
    }

    if let Some(st) = &mut event.stacktrace {
        scrub_frames(st);
    }

    // Breadcrumbs are not produced by this sidecar today, but scrub any message
    // defensively in case future code adds them before a panic.
    for bc in &mut event.breadcrumbs.values {
        bc.message = bc.message.as_deref().map(scrub_outbound);
    }

    // Contexts: DROP the hardware `device` fingerprint context (the
    // `device_arch` super-property covers the only useful bit), then scrub every
    // remaining context's string values. We round-trip each context through
    // serde_json so this covers os/app/runtime/`Other` string fields generically
    // without matching on every typed field by hand.
    event.contexts.remove("device");
    for ctx in event.contexts.values_mut() {
        if let Ok(mut val) = serde_json::to_value(&*ctx) {
            scrub_json(&mut val);
            if let Ok(scrubbed) = serde_json::from_value(val) {
                *ctx = scrubbed;
            }
        }
    }

    // Extra: arbitrary user-attached values — scrub every string leaf.
    for val in event.extra.values_mut() {
        scrub_json(val);
    }

    // Tags: e.g. the `rp_session` correlation tag; scrub the values (keys are
    // our own static identifiers).
    for tag in event.tags.values_mut() {
        *tag = scrub_outbound(tag);
    }

    event
}

/// Initialize Sentry crash reporting (crashes ONLY — the AGPL Rust core never
/// emits PostHog/product analytics). **Gated at runtime on `crash_report_consent`
/// (default OFF) AND a configured DSN**; if either is missing this is a no-op and
/// **no network client is ever created** => zero outbound calls (spec acceptance:
/// both consent flags OFF => zero network).
///
/// Privacy posture (spec / OSS audit):
///   * `send_default_pii = false`
///   * `server_name = None` at init AND force-cleared in [`scrub_event`]. The
///     `before_send` clear is load-bearing: Sentry's `ContextIntegration`
///     repopulates `server_name` (the hostname) after init, so the init-time
///     `None` alone would be undone.
///   * `before_send = scrub_event` runs the strict [`scrub_outbound`] scrubber
///     (composes [`redact`] + IPv4/IPv6 + broad absolute paths + `*.ts.net`)
///     over the message, every backtrace frame, contexts/extra/tags, and clears
///     user/request — so IPs, tailnet names, and `$HOME`/other-user paths never
///     leave the machine.
///
/// DSN + `release` come from config (env/`client.env`), never hardcoded.
#[cfg(feature = "crash-report")]
fn init_crash_reporter() {
    if !crash_report_consent() {
        return; // opt-in default OFF => no client, no network.
    }
    let dsn = match telemetry_setting("SENTRY_DSN") {
        Some(d) => d,
        None => return, // DSN absent => do not init (spec).
    };

    // release = crate version; environment from config or "production".
    let release = sentry::release_name!();
    let environment = telemetry_setting("RP_TELEMETRY_ENV")
        .map(std::borrow::Cow::Owned)
        .unwrap_or(std::borrow::Cow::Borrowed("production"));

    let options = sentry::ClientOptions {
        release,
        environment: Some(environment),
        send_default_pii: false,
        server_name: None,
        // Attach a backtrace to error-level non-panic events too; panics already
        // carry one via the panic integration. Frames are scrubbed in before_send.
        attach_stacktrace: true,
        // Last-line PII scrub over every outgoing event.
        before_send: Some(std::sync::Arc::new(|event| Some(scrub_event(event)))),
        ..Default::default()
    };

    // `(dsn, options)` -> ClientOptions via IntoDsn; an unparseable DSN yields a
    // disabled client (no network) rather than a panic.
    let guard = sentry::init((dsn, options));
    let _ = SENTRY_GUARD.set(guard);

    // Correlation tag: the process-global session (the tmux session id, or `-`).
    // NOTE: ScreenServer.spawn() does not pass RP_SESSION to the sidecar today,
    // so this is `-` until that is wired (see followups).
    sentry::configure_scope(|scope| {
        scope.set_tag("rp_session", current_session());
        scope.set_tag("component", COMP);
    });
}

/// No-op build of the crash reporter when the `crash-report` feature is off.
/// Keeps [`init`] free of `cfg` noise and the crate compilable with
/// `--no-default-features` (license-firewall fallback path).
#[cfg(not(feature = "crash-report"))]
fn init_crash_reporter() {}

/// Install a panic hook that persists a local crash dump (contract §10) so a
/// panic is recoverable from `xpair logs --collect` even though no remote
/// telemetry is sent. Writes the panic message + location + a full backtrace
/// (`force_capture`, independent of `RUST_BACKTRACE`) to
/// `~/.xpair/host/logs/crash-rust-<epoch>.log` (mode 0600), drops a one-line
/// ERROR pointer into `rust.log`, then chains the previous hook (keeps the
/// default stderr message / abort behavior). Panics are not async-signal
/// contexts, so allocation + [`redact`] are safe here.
fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let ts = iso8601_now();
        let sess = current_session();
        let bt = std::backtrace::Backtrace::force_capture();

        let body = redact(&format!(
            "=== Xpair CRASH (rust panic) ===\n\
             [{ts}] [PANIC] [{COMP}] [{sess}] {msg} at {loc}\n\n{bt}\n"
        ));
        let path = log_dir().join(format!("crash-{COMP}-{}.log", epoch_secs()));
        let _ = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .and_then(|mut f| f.write_all(body.as_bytes()));

        // One-line pointer into the normal log so `xpair logs` shows it inline.
        if let Some(file) = FILE.get() {
            if let Ok(mut f) = file.lock() {
                let _ = f.write_all(
                    redact(&format!(
                        "[{ts}] [ERROR] [{COMP}] [{sess}] PANIC {msg} at {loc} (dump: {})\n",
                        path.display()
                    ))
                    .as_bytes(),
                );
            }
        }

        prev(info);
    }));
}

/// Mid-run rotation guard for long-lived loops (the serve frame loop). Cheap:
/// one `stat`; rotates + re-opens the shared writer only when oversized
/// (contract §7 "long-lived guard"). Call periodically, e.g. every N frames.
pub fn rotate_guard() {
    let oversized = matches!(std::fs::metadata(log_path()), Ok(m) if m.len() > ROTATE_BYTES);
    if !oversized {
        return;
    }
    rotate_if_needed();
    // Re-open onto the fresh inode so subsequent writes don't go to the
    // now-renamed `.1` (which would also keep it growing).
    if let (Ok(f), Some(slot)) = (open_file(), FILE.get()) {
        if let Ok(mut guard) = slot.lock() {
            *guard = f;
        }
    }
}

#[cfg(all(test, feature = "crash-report"))]
mod tests {
    use super::*;
    use sentry::protocol::{Context, Event, Exception, Frame, Stacktrace};

    /// The five PII classes the outbound scrubber MUST mask (privacy audit):
    /// IPv4, IPv6 (incl. link-local), a `/private/var/folders` macOS temp path,
    /// an other-user `/Users/<name>` path, and a `*.ts.net` tailnet hostname.
    const SECRETS: &[&str] = &[
        "1.2.3.4",
        "fe80::1",
        "/private/var/folders/x/y",
        "/Users/alice/secret",
        "/opt/company/key.pem",
        "host-7.tailnet.ts.net",
    ];

    fn assert_all_masked(s: &str, where_: &str) {
        for secret in SECRETS {
            assert!(
                !s.contains(secret),
                "outbound scrub leaked {secret:?} in {where_}: {s:?}"
            );
        }
    }

    #[test]
    fn scrub_outbound_masks_every_class() {
        let raw = "ip4=1.2.3.4 ip6=fe80::1 tmp=/private/var/folders/x/y \
                   home=/Users/alice/secret opt=/opt/company/key.pem host=host-7.tailnet.ts.net";
        let out = scrub_outbound(raw);
        assert_all_masked(&out, "scrub_outbound");
        // Sanity: the masks are actually applied (not just deletion).
        assert!(out.contains("<ip>"), "expected <ip> token: {out:?}");
        assert!(out.contains("<path>"), "expected <path> token: {out:?}");
        assert!(out.contains("<host>"), "expected <host> token: {out:?}");
    }

    #[test]
    fn scrub_event_masks_message_and_frame_and_meta() {
        let blob = "1.2.3.4 fe80::1 /private/var/folders/x/y \
                    /Users/alice/secret /opt/company/key.pem host-7.tailnet.ts.net";

        let frame = Frame {
            filename: Some(format!("{blob} fname")),
            abs_path: Some(format!("{blob} abspath")),
            function: Some(format!("{blob} fn")),
            context_line: Some(format!("{blob} ctx")),
            ..Default::default()
        };
        let stacktrace = Stacktrace {
            frames: vec![frame],
            ..Default::default()
        };
        let exception = Exception {
            ty: "Panic".into(),
            value: Some(format!("{blob} exval")),
            stacktrace: Some(stacktrace),
            ..Default::default()
        };

        let mut event = Event {
            message: Some(format!("{blob} msg")),
            ..Default::default()
        };
        event.exception.values.push(exception);
        // contexts / extra / tags carriers + the device fingerprint that must be dropped.
        let mut ctx_map = sentry::protocol::Map::new();
        ctx_map.insert("note".into(), serde_json::Value::String(blob.into()));
        event
            .contexts
            .insert("custom".into(), Context::Other(ctx_map));
        event.contexts.insert(
            "device".into(),
            Context::Other({
                let mut m = sentry::protocol::Map::new();
                m.insert("model".into(), serde_json::Value::String(blob.into()));
                m
            }),
        );
        event
            .extra
            .insert("k".into(), serde_json::Value::String(blob.into()));
        event.tags.insert("rp_session".into(), blob.into());

        let scrubbed = scrub_event(event);

        // Re-serialize the whole event and assert no secret survives anywhere.
        let json = serde_json::to_string(&scrubbed).expect("serialize scrubbed event");
        assert_all_masked(&json, "serialized scrub_event output");

        // server_name force-nulled; device context dropped; user/request cleared.
        assert!(scrubbed.server_name.is_none(), "server_name must be None");
        assert!(
            !scrubbed.contexts.contains_key("device"),
            "device context must be dropped"
        );
        assert!(scrubbed.user.is_none(), "user must be cleared");
        assert!(scrubbed.request.is_none(), "request must be cleared");
    }
}
