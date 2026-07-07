//! Client env-file config (`~/.xpair/client/client.env`).
//!
//! Ports the bash `rp_set`/`cmd_config` storage model: one `KEY=VALUE` assignment per line
//! in `client.env`, with shell-style quoting for values. The core file functions take an
//! explicit path so tests and future callers can stay isolated from the real user config.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Line {
    Pair {
        key: String,
        value: String,
        raw: Option<String>,
    },
    Raw(String),
}

/// Return the configured client env path.
///
/// The bash SSOT is `RP_CLIENT_DIR="${RP_CLIENT_DIR:-$HOME/.xpair/client}"` plus
/// `CLIENT_ENV="$RP_CLIENT_DIR/client.env"`. `CLIENT_ENV` is honored for tests and
/// role-aware installer callers that source `shared/config.sh`.
pub fn default_client_env_path() -> io::Result<PathBuf> {
    if let Some(client_env) = non_empty_env("CLIENT_ENV") {
        return Ok(PathBuf::from(client_env));
    }
    if let Some(rp_client_dir) = non_empty_env("RP_CLIENT_DIR") {
        return Ok(PathBuf::from(rp_client_dir).join("client.env"));
    }

    Ok(default_client_dir()?.join("client.env"))
}

/// The bash SSOT `RP_HOST_DIR="${RP_HOST_DIR:-$HOME/.xpair/host}"`.
pub fn default_rp_dir() -> io::Result<PathBuf> {
    if let Some(rp_host_dir) = non_empty_env("RP_HOST_DIR") {
        return Ok(PathBuf::from(rp_host_dir));
    }
    if let Some(rp_dir) = non_empty_env("RP_DIR") {
        return Ok(PathBuf::from(rp_dir));
    }

    Ok(home_dir()?.join(".xpair").join("host"))
}

/// The bash SSOT `LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"` (installed client tools).
pub fn default_local_bin() -> io::Result<PathBuf> {
    if let Some(local_bin) = non_empty_env("LOCAL_BIN") {
        return Ok(PathBuf::from(local_bin));
    }
    let client_env = default_client_env_path()?;
    if let Some(local_bin) = get(&client_env, "LOCAL_BIN")?.filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(local_bin));
    }

    Ok(home_dir()?.join(".local").join("bin"))
}

/// Read one effective config key from the bash-parity env-file stack.
///
/// Runtime sourcing order is `common.env` before `client.env`; later assignments win. When
/// the default client env is absent, the legacy host-dir `{common,client}.env` fallback is
/// used exactly like `client/cli/xpair`.
pub fn get(path: impl AsRef<Path>, key: &str) -> io::Result<Option<String>> {
    let lines = read_lookup_lines(path.as_ref())?;
    Ok(lines.into_iter().rev().find_map(|line| match line {
        Line::Pair { key: k, value, .. } if k == key => Some(value),
        _ => None,
    }))
}

/// Set or append one config key in `path`.
///
/// Comments, blank lines, unknown keys, and the relative order of other lines are preserved.
/// The first existing `key` is overwritten in place and later duplicates are removed so the
/// resulting file has a single authoritative assignment for that key.
pub fn set(path: impl AsRef<Path>, key: &str, value: &str) -> io::Result<()> {
    validate_env_key(key)?;

    let path = path.as_ref();
    let lines = read_file_lines(path)?;
    let mut out = Vec::with_capacity(lines.len() + 1);
    let mut replaced = false;

    for line in lines {
        match line {
            Line::Pair { key: existing, .. } if existing == key => {
                if !replaced {
                    out.push(Line::Pair {
                        key: key.to_string(),
                        value: value.to_string(),
                        raw: None,
                    });
                    replaced = true;
                }
            }
            other => out.push(other),
        }
    }

    if !replaced {
        out.push(Line::Pair {
            key: key.to_string(),
            value: value.to_string(),
            raw: None,
        });
    }

    atomic_write(path, &serialize_lines(&out))
}

/// List parsed config assignments in file order.
///
/// If a key appears more than once, the returned list includes each parsed assignment. The
/// writer removes duplicates only for the key it is updating.
pub fn list(path: impl AsRef<Path>) -> io::Result<Vec<(String, String)>> {
    Ok(read_file_lines(path.as_ref())?
        .into_iter()
        .filter_map(|line| match line {
            Line::Pair { key, value, .. } => Some((key, value)),
            Line::Raw(_) => None,
        })
        .collect())
}

/// Get a bash-facing config key (`host`, `terminal`, or `engine`).
pub fn get_cli(path: impl AsRef<Path>, key: &str) -> io::Result<String> {
    let path = path.as_ref();
    match key {
        "host" => Ok(valid_remote_host(path)?.unwrap_or_default()),
        "terminal" => Ok(get(path, "TERMINAL_APP")?.unwrap_or_else(default_terminal_app)),
        "engine" => Ok(get(path, "ENGINE")?.unwrap_or_else(|| "claude".to_string())),
        _ => Err(invalid_input("config get <host|terminal|engine>")),
    }
}

/// Set a bash-facing config key (`host`, `terminal`, or `engine`).
pub fn set_cli(path: impl AsRef<Path>, key: &str, value: &str) -> io::Result<String> {
    let path = path.as_ref();
    match key {
        "host" => {
            if !value.is_empty() && !valid_host(value) {
                return Err(invalid_input(format!("invalid host: {value}")));
            }
            set(path, "REMOTE_HOST", value)?;
            Ok(if value.is_empty() {
                "host cleared (no host configured)".to_string()
            } else {
                format!("host set: {value}")
            })
        }
        "terminal" => match value {
            "iterm2" | "terminal" => {
                set(path, "TERMINAL_APP", value)?;
                Ok(format!("terminal set: {value}"))
            }
            _ => Err(invalid_input("config set terminal <iterm2|terminal>")),
        },
        "engine" => {
            let canon = canonical_engine(value).ok_or_else(|| {
                invalid_input("config set engine <claude|claudecode|shell|codex|opencode>")
            })?;
            set(path, "ENGINE", canon)?;
            Ok(format!("engine set: {canon}"))
        }
        _ => Err(invalid_input("config set <host|terminal|engine> <value>")),
    }
}

/// Format the bash-style `config list` summary rows.
pub fn list_cli(path: impl AsRef<Path>) -> io::Result<Vec<(String, String)>> {
    let path = path.as_ref();
    let host = valid_remote_host(path)?.unwrap_or_else(|| "(no host configured)".to_string());
    let maps = resolve_raw_maps(path)?
        .split(';')
        .filter(|entry| !entry.is_empty())
        .count();

    Ok(vec![
        ("host".to_string(), host),
        (
            "terminal".to_string(),
            get(path, "TERMINAL_APP")?.unwrap_or_else(default_terminal_app),
        ),
        (
            "engine".to_string(),
            get(path, "ENGINE")?.unwrap_or_else(|| "claude".to_string()),
        ),
        ("mappings".to_string(), maps.to_string()),
    ])
}

fn resolve_raw_maps(path: &Path) -> io::Result<String> {
    if let Some(raw_maps) = non_empty_env_string("FOLDER_MAPS") {
        return Ok(raw_maps);
    }
    if let Some(raw_maps) = non_empty_env_string("SYNC_ROOTS") {
        return Ok(raw_maps);
    }
    if let Some(raw_maps) = get(path, "FOLDER_MAPS")?.filter(|maps| !maps.is_empty()) {
        return Ok(raw_maps);
    }
    Ok(get(path, "SYNC_ROOTS")?.unwrap_or_default())
}

fn read_lookup_lines(path: &Path) -> io::Result<Vec<Line>> {
    let mut lines = Vec::new();
    for path in lookup_env_paths(path)? {
        lines.extend(read_file_lines(&path)?);
    }
    Ok(lines)
}

fn read_file_lines(path: &Path) -> io::Result<Vec<Line>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };

    Ok(text.lines().map(parse_line).collect())
}

fn lookup_env_paths(path: &Path) -> io::Result<Vec<PathBuf>> {
    let common = |env_path: &Path| {
        env_path
            .parent()
            .map(|parent| parent.join("common.env"))
            .unwrap_or_else(|| PathBuf::from("common.env"))
    };

    if use_legacy_host_env_stack(path)? {
        let host_client = default_rp_dir()?.join("client.env");
        return Ok(vec![common(&host_client), host_client]);
    }

    Ok(vec![common(path), path.to_path_buf()])
}

fn parse_line(line: &str) -> Line {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return Line::Raw(line.to_string());
    }

    let Some((key, raw_value)) = line.split_once('=') else {
        return Line::Raw(line.to_string());
    };

    if validate_env_key(key).is_err() {
        return Line::Raw(line.to_string());
    }

    match shell_unquote(raw_value) {
        Ok(value) => Line::Pair {
            key: key.to_string(),
            value,
            raw: Some(line.to_string()),
        },
        Err(_) => Line::Raw(line.to_string()),
    }
}

fn serialize_lines(lines: &[Line]) -> String {
    let mut out = String::new();
    for line in lines {
        match line {
            Line::Pair { key, value, raw } => {
                if let Some(raw) = raw {
                    out.push_str(raw);
                } else {
                    out.push_str(key);
                    out.push('=');
                    out.push_str(&bash_percent_q(value));
                }
            }
            Line::Raw(raw) => out.push_str(raw),
        }
        out.push('\n');
    }
    out
}

fn shell_unquote(raw: &str) -> io::Result<String> {
    let mut chars = raw.chars().peekable();
    let mut out = String::new();

    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some(next) => out.push(next),
                None => out.push('\\'),
            },
            '\'' => {
                let mut closed = false;
                for next in chars.by_ref() {
                    if next == '\'' {
                        closed = true;
                        break;
                    }
                    out.push(next);
                }
                if !closed {
                    return Err(invalid_input("unterminated single quote"));
                }
            }
            '"' => {
                let mut closed = false;
                while let Some(next) = chars.next() {
                    match next {
                        '"' => {
                            closed = true;
                            break;
                        }
                        '\\' => match chars.next() {
                            Some(escaped @ ('"' | '\\' | '$' | '`' | '\n')) => out.push(escaped),
                            Some(other) => {
                                out.push('\\');
                                out.push(other);
                            }
                            None => out.push('\\'),
                        },
                        _ => out.push(next),
                    }
                }
                if !closed {
                    return Err(invalid_input("unterminated double quote"));
                }
            }
            '$' if chars.peek() == Some(&'\'') => {
                chars.next();
                parse_ansi_c_quoted(&mut chars, &mut out)?;
            }
            _ => out.push(c),
        }
    }

    Ok(out)
}

fn parse_ansi_c_quoted<I>(chars: &mut std::iter::Peekable<I>, out: &mut String) -> io::Result<()>
where
    I: Iterator<Item = char>,
{
    let mut closed = false;
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                closed = true;
                break;
            }
            '\\' => match chars.next() {
                Some('a') => out.push('\u{7}'),
                Some('b') => out.push('\u{8}'),
                Some('e') | Some('E') => out.push('\u{1b}'),
                Some('f') => out.push('\u{c}'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('v') => out.push('\u{b}'),
                Some('\\') => out.push('\\'),
                Some('\'') => out.push('\''),
                Some(other) => out.push(other),
                None => out.push('\\'),
            },
            _ => out.push(c),
        }
    }

    if closed {
        Ok(())
    } else {
        Err(invalid_input("unterminated ANSI-C quote"))
    }
}

fn bash_percent_q(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }

    let mut out = String::new();
    for c in value.chars() {
        if is_bash_q_plain(c) {
            out.push(c);
        } else {
            out.push('\\');
            out.push(c);
        }
    }
    out
}

fn is_bash_q_plain(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(c, '%' | '+' | ',' | '-' | '.' | '/' | ':' | '=' | '@' | '_')
}

fn atomic_write(path: &Path, contents: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    let tmp = temp_path(path);
    fs::write(&tmp, contents)?;
    replace_file(&tmp, path)
}

fn temp_path(path: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut name = path
        .file_name()
        .unwrap_or_else(|| OsStr::new("client.env"))
        .to_os_string();
    name.push(format!(".{}.{}.tmp", std::process::id(), nonce));
    path.with_file_name(name)
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    extern "system" {
        fn MoveFileExW(
            lpExistingFileName: *const u16,
            lpNewFileName: *const u16,
            dwFlags: u32,
        ) -> i32;
    }

    let from_w: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to_w: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            from_w.as_ptr(),
            to_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if ok == 0 {
        let err = io::Error::last_os_error();
        let _ = fs::remove_file(from);
        Err(err)
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

fn validate_env_key(key: &str) -> io::Result<()> {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_alphabetic() => {}
        _ => return Err(invalid_input("invalid config key")),
    }

    if chars.all(|c| c == '_' || c.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err(invalid_input("invalid config key"))
    }
}

/// Bash `valid_host()` from `client/cli/bin/maplib.sh`: accepts either `host` or
/// `user@host`, rejects ssh-option-looking values, and restricts both parts to
/// `[A-Za-z0-9._-]`.
pub fn valid_host(target: &str) -> bool {
    if target.is_empty() || target.starts_with('-') {
        return false;
    }

    let (user, host) = match target.split_once('@') {
        Some((user, host)) if !target[user.len() + 1..].contains('@') => (Some(user), host),
        Some(_) => return false,
        None => (None, target),
    };

    if let Some(user) = user {
        if !valid_host_part(user) {
            return false;
        }
    }
    valid_host_part(host)
}

fn valid_host_part(part: &str) -> bool {
    !part.is_empty()
        && !part.starts_with('-')
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_remote_host(path: &Path) -> io::Result<Option<String>> {
    Ok(get(path, "REMOTE_HOST")?.filter(|host| host.is_empty() || valid_host(host)))
}

fn canonical_engine(engine: &str) -> Option<&'static str> {
    match engine {
        "claude" | "claudecode" | "claude-code" => Some("claude"),
        "shell" => Some("shell"),
        "codex" => Some("codex"),
        "opencode" => Some("opencode"),
        _ => None,
    }
}

fn default_terminal_app() -> String {
    if Path::new("/Applications/iTerm.app").is_dir() {
        "iterm2".to_string()
    } else {
        "terminal".to_string()
    }
}

fn home_dir() -> io::Result<PathBuf> {
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
        _ => Err(io::Error::new(
            io::ErrorKind::NotFound,
            "HOME is not set; cannot resolve ~/.xpair/client/client.env",
        )),
    }
}

fn default_client_dir() -> io::Result<PathBuf> {
    Ok(home_dir()?.join(".xpair").join("client"))
}

fn use_legacy_host_env_stack(path: &Path) -> io::Result<bool> {
    if non_empty_env("CLIENT_ENV").is_some() {
        return Ok(false);
    }

    let default_client_env = if let Some(rp_client_dir) = non_empty_env("RP_CLIENT_DIR") {
        PathBuf::from(rp_client_dir).join("client.env")
    } else {
        // No resolvable home means the caller passed an explicit path that cannot be the
        // default stack — treat as non-legacy instead of failing the whole lookup (bash
        // parity: common.env is sourced only when its well-known location exists).
        match default_client_dir() {
            Ok(dir) => dir.join("client.env"),
            Err(_) => return Ok(false),
        }
    };

    if path != default_client_env {
        return Ok(false);
    }

    Ok(!path.is_file())
}

fn non_empty_env(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

fn non_empty_env_string(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
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
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "xpair-config-test-{}-{nonce}-{id}-{name}.env",
                std::process::id()
            ));
            let _ = fs::remove_file(&path);
            TestPath { path }
        }

        fn write(&self, body: &str) {
            fs::write(&self.path, body).unwrap();
        }

        fn read(&self) -> String {
            fs::read_to_string(&self.path).unwrap()
        }
    }

    impl Drop for TestPath {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
            if let Some(parent) = self.path.parent() {
                if let Some(name) = self.path.file_name().and_then(OsStr::to_str) {
                    if let Ok(entries) = fs::read_dir(parent) {
                        for entry in entries.flatten() {
                            let file_name = entry.file_name();
                            if file_name.to_string_lossy().starts_with(name) {
                                let _ = fs::remove_file(entry.path());
                            }
                        }
                    }
                }
            }
        }
    }

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "xpair-config-test-{}-{nonce}-{id}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir(&path).unwrap();
            TestDir { path }
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

    #[test]
    fn get_set_list_round_trip_with_shell_escaping() {
        let tmp = TestPath::new("round-trip");

        set(&tmp.path, "REMOTE_HOST", "test-host").unwrap();
        set(
            &tmp.path,
            "FOLDER_MAPS",
            "/tmp/xpair path'quote::/host path",
        )
        .unwrap();

        assert_eq!(
            get(&tmp.path, "REMOTE_HOST").unwrap(),
            Some("test-host".to_string())
        );
        assert_eq!(
            get(&tmp.path, "FOLDER_MAPS").unwrap(),
            Some("/tmp/xpair path'quote::/host path".to_string())
        );
        assert_eq!(
            list(&tmp.path).unwrap(),
            vec![
                ("REMOTE_HOST".to_string(), "test-host".to_string()),
                (
                    "FOLDER_MAPS".to_string(),
                    "/tmp/xpair path'quote::/host path".to_string()
                )
            ]
        );

        let body = tmp.read();
        assert!(body.contains("REMOTE_HOST=test-host\n"));
        assert!(body.contains("FOLDER_MAPS=/tmp/xpair\\ path\\'quote::/host\\ path\n"));
    }

    #[test]
    fn upsert_overwrites_in_place_and_removes_duplicates() {
        let tmp = TestPath::new("upsert");
        tmp.write("FIRST=1\nREMOTE_HOST=old\nMIDDLE=2\nREMOTE_HOST=older\nLAST=3\n");

        set(&tmp.path, "REMOTE_HOST", "new-host").unwrap();

        assert_eq!(
            get(&tmp.path, "REMOTE_HOST").unwrap(),
            Some("new-host".to_string())
        );
        assert_eq!(
            tmp.read(),
            "FIRST=1\nREMOTE_HOST=new-host\nMIDDLE=2\nLAST=3\n"
        );
    }

    #[test]
    fn preserves_comments_blank_lines_unknown_keys_and_order() {
        let tmp = TestPath::new("preserve");
        tmp.write("# heading\n\nREMOTE_HOST=old\nUNKNOWN=\"one two\"\n# tail\n");

        set(&tmp.path, "REMOTE_HOST", "new").unwrap();

        assert_eq!(
            tmp.read(),
            "# heading\n\nREMOTE_HOST=new\nUNKNOWN=\"one two\"\n# tail\n"
        );
    }

    #[test]
    fn missing_key_returns_none() {
        let tmp = TestPath::new("missing");
        tmp.write("REMOTE_HOST=test-host\n");

        assert_eq!(get(&tmp.path, "ENGINE").unwrap(), None);
    }

    #[test]
    fn missing_file_reads_as_empty_config() {
        let tmp = TestPath::new("missing-file");

        assert_eq!(get(&tmp.path, "REMOTE_HOST").unwrap(), None);
        assert_eq!(list(&tmp.path).unwrap(), Vec::<(String, String)>::new());
    }

    #[test]
    fn get_sources_common_before_client_env() {
        let tmp = TestDir::new("common-before-client");
        let client_env = tmp.path.join("client.env");
        fs::write(
            tmp.path.join("common.env"),
            "LOCAL_BIN=/opt/xpair/bin\nAQUA_SOCK=/tmp/common.sock\n",
        )
        .unwrap();
        fs::write(&client_env, "AQUA_SOCK=/tmp/client.sock\n").unwrap();

        assert_eq!(
            get(&client_env, "LOCAL_BIN").unwrap(),
            Some("/opt/xpair/bin".to_string())
        );
        assert_eq!(
            get(&client_env, "AQUA_SOCK").unwrap(),
            Some("/tmp/client.sock".to_string())
        );
        assert_eq!(
            list(&client_env).unwrap(),
            vec![("AQUA_SOCK".to_string(), "/tmp/client.sock".to_string())]
        );
    }

    #[test]
    fn get_uses_legacy_host_env_stack_when_default_client_env_is_absent() {
        with_env(
            &[
                ("CLIENT_ENV", None),
                ("RP_CLIENT_DIR", None),
                ("RP_HOST_DIR", None),
                ("RP_DIR", None),
                ("USERPROFILE", None),
                ("HOMEDRIVE", None),
                ("HOMEPATH", None),
            ],
            || {
                let tmp = TestDir::new("legacy-host-stack");
                let home = tmp.path.join("home");
                let host_dir = home.join(".xpair").join("host");
                fs::create_dir_all(&host_dir).unwrap();
                fs::write(host_dir.join("common.env"), "LOCAL_BIN=/legacy/bin\n").unwrap();
                fs::write(
                    host_dir.join("client.env"),
                    "LOCAL_BIN=/legacy/client/bin\nREMOTE_HOST=legacy-host\n",
                )
                .unwrap();
                let home_s = home.to_string_lossy().into_owned();
                let _guard = EnvGuard::set(&[("HOME", Some(&home_s))]);
                let client_env = default_client_env_path().unwrap();

                assert_eq!(
                    get(&client_env, "LOCAL_BIN").unwrap(),
                    Some("/legacy/client/bin".to_string())
                );
                assert_eq!(
                    get(&client_env, "REMOTE_HOST").unwrap(),
                    Some("legacy-host".to_string())
                );
            },
        );
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let tmp = TestPath::new("atomic");

        set(&tmp.path, "REMOTE_HOST", "test-host").unwrap();

        let parent = tmp.path.parent().unwrap();
        let name = tmp.path.file_name().unwrap().to_string_lossy();
        let leftovers: Vec<_> = fs::read_dir(parent)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|file_name| file_name.starts_with(name.as_ref()) && file_name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }

    #[test]
    fn parses_existing_double_quotes_and_backslash_quotes() {
        let tmp = TestPath::new("parse-quotes");
        tmp.write("A=\"one two\"\nB=/tmp/xpair\\ path\\'quote\\;tail\n");

        assert_eq!(get(&tmp.path, "A").unwrap(), Some("one two".to_string()));
        assert_eq!(
            get(&tmp.path, "B").unwrap(),
            Some("/tmp/xpair path'quote;tail".to_string())
        );
    }

    #[test]
    fn cli_engine_alias_stores_canonical_claude() {
        let tmp = TestPath::new("engine");

        let msg = set_cli(&tmp.path, "engine", "claudecode").unwrap();

        assert_eq!(msg, "engine set: claude");
        assert_eq!(
            get(&tmp.path, "ENGINE").unwrap(),
            Some("claude".to_string())
        );
        assert_eq!(get_cli(&tmp.path, "engine").unwrap(), "claude");
    }

    #[test]
    fn cli_rejects_removed_mode_keys_like_bash() {
        let tmp = TestPath::new("mode");

        let get_err = get_cli(&tmp.path, "mode").unwrap_err();
        let set_err = set_cli(&tmp.path, "local_mode", "local").unwrap_err();

        assert_eq!(get_err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(get_err.to_string(), "config get <host|terminal|engine>");
        assert_eq!(set_err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(
            set_err.to_string(),
            "config set <host|terminal|engine> <value>"
        );
    }

    #[test]
    fn list_cli_counts_legacy_sync_roots_when_folder_maps_absent() {
        let tmp = TestPath::new("sync-roots");
        tmp.write("REMOTE_HOST=mac-mini\nSYNC_ROOTS='/client/a::/host/a;/client/b::/host/b'\n");

        let rows = list_cli(&tmp.path).unwrap();

        assert_eq!(
            rows.iter()
                .find(|(key, _)| key == "mappings")
                .map(|(_, value)| value.as_str()),
            Some("2")
        );
    }

    #[test]
    fn list_cli_prefers_folder_maps_over_legacy_sync_roots() {
        let tmp = TestPath::new("maps-over-sync-roots");
        tmp.write(
            "REMOTE_HOST=mac-mini\nFOLDER_MAPS='/client/a::/host/a'\nSYNC_ROOTS='/client/a::/host/a;/client/b::/host/b'\n",
        );

        let rows = list_cli(&tmp.path).unwrap();

        assert_eq!(
            rows.iter()
                .find(|(key, _)| key == "mappings")
                .map(|(_, value)| value.as_str()),
            Some("1")
        );
    }

    #[test]
    fn cli_rejects_ssh_option_host() {
        let tmp = TestPath::new("host");

        let err = set_cli(&tmp.path, "host", "-oProxyCommand=touch-pwn").unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(err.to_string(), "invalid host: -oProxyCommand=touch-pwn");
        assert_eq!(get(&tmp.path, "REMOTE_HOST").unwrap(), None);
    }

    #[test]
    fn valid_host_matches_maplib_user_qualified_contract() {
        assert!(valid_host("mac-mini"));
        assert!(valid_host("alice@mac-mini.local"));
        assert!(valid_host("a_b.c-d@host_1.local"));

        assert!(!valid_host(""));
        assert!(!valid_host("-oProxyCommand=touch-pwn"));
        assert!(!valid_host("@host"));
        assert!(!valid_host("alice@"));
        assert!(!valid_host("alice@bob@host"));
        assert!(!valid_host("bad/user@host"));
        assert!(!valid_host("alice@bad/host"));
        assert!(!valid_host("-alice@host"));
        assert!(!valid_host("alice@-host"));
    }
}
