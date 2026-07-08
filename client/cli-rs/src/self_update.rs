//! `xpair self-update` for the native Windows release channel.
//!
//! The bash client still owns macOS/Linux self-update until the Rust cutover. This module only
//! implements the Windows MSI path: GitHub Releases metadata via `curl`, MSI download verification,
//! then `msiexec /i ... /passive`.

use std::cmp::Ordering;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use crate::platform::Os;

const DEFAULT_GH_REPO: &str = "x10lab/xpair";
const USER_AGENT_PREFIX: &str = "xpair-cli";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Alpha,
}

impl Channel {
    fn from_env() -> Channel {
        match env::var("RP_UPDATE_CHANNEL") {
            Ok(value) if value.eq_ignore_ascii_case("alpha") => Channel::Alpha,
            _ => Channel::Stable,
        }
    }

    fn release_path(self) -> &'static str {
        match self {
            Channel::Stable => "releases/latest",
            Channel::Alpha => "releases?per_page=30",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateConfig {
    pub os: Os,
    pub repo: String,
    pub channel: Channel,
    pub current_version: String,
    pub temp_dir: PathBuf,
}

impl UpdateConfig {
    fn load() -> UpdateConfig {
        UpdateConfig {
            os: Os::current(),
            repo: non_empty_env("GH_REPO").unwrap_or_else(|| DEFAULT_GH_REPO.to_string()),
            channel: Channel::from_env(),
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            temp_dir: env::temp_dir(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait LocalExec {
    fn output(&mut self, program: &str, args: &[String]) -> io::Result<ExecOutput>;
    fn status(&mut self, program: &str, args: &[String]) -> io::Result<i32>;
}

struct RealExec;

impl LocalExec for RealExec {
    fn output(&mut self, program: &str, args: &[String]) -> io::Result<ExecOutput> {
        let out = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .output()?;
        Ok(ExecOutput {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        })
    }

    fn status(&mut self, program: &str, args: &[String]) -> io::Result<i32> {
        let status = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .status()?;
        Ok(status.code().unwrap_or(-1))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOutcome {
    NonWindows,
    AlreadyCurrent { current: String, latest: String },
    Installed { version: String, msi_path: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateError {
    pub message: String,
    pub code: u8,
}

impl UpdateError {
    fn new(message: impl Into<String>, code: u8) -> UpdateError {
        UpdateError {
            message: message.into(),
            code,
        }
    }
}

pub fn run(args: &[String]) -> ExitCode {
    if !args.is_empty() {
        eprintln!("usage: xpair self-update");
        return ExitCode::from(2);
    }

    let config = UpdateConfig::load();
    let mut exec = RealExec;
    match run_with_exec(&mut exec, &config) {
        Ok(UpdateOutcome::NonWindows) => {
            eprintln!(
                "xpair self-update: native MSI update is Windows-only; macOS/Linux stay on the bash `xpair self-update` flow"
            );
            ExitCode::from(2)
        }
        Ok(UpdateOutcome::AlreadyCurrent { current, latest }) => {
            println!("xpair self-update: already up to date ({current}; latest {latest})");
            ExitCode::SUCCESS
        }
        Ok(UpdateOutcome::Installed { version, msi_path }) => {
            println!(
                "xpair self-update: installed {version} from {}",
                msi_path.display()
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("xpair self-update: {}", err.message);
            ExitCode::from(err.code)
        }
    }
}

pub fn run_with_exec<E: LocalExec + ?Sized>(
    exec: &mut E,
    config: &UpdateConfig,
) -> Result<UpdateOutcome, UpdateError> {
    if config.os != Os::Windows {
        return Ok(UpdateOutcome::NonWindows);
    }

    let release = fetch_release(exec, config)?;
    let (latest_version, asset) = select_cli_msi_asset(&release).ok_or_else(|| {
        UpdateError::new(
            format!(
                "release {} has no CLI asset matching xpair-<version>-x64.msi",
                release.tag
            ),
            1,
        )
    })?;

    if !is_newer(&latest_version, &config.current_version) {
        return Ok(UpdateOutcome::AlreadyCurrent {
            current: config.current_version.clone(),
            latest: latest_version,
        });
    }

    let msi_path = download_msi(exec, config, &latest_version, asset)?;
    install_msi(exec, &msi_path)?;
    Ok(UpdateOutcome::Installed {
        version: latest_version,
        msi_path,
    })
}

fn fetch_release<E: LocalExec + ?Sized>(
    exec: &mut E,
    config: &UpdateConfig,
) -> Result<Release, UpdateError> {
    let url = format!(
        "https://api.github.com/repos/{}/{}",
        config.repo,
        config.channel.release_path()
    );
    let args = vec![
        "-fsSL".to_string(),
        "-H".to_string(),
        "Accept: application/vnd.github+json".to_string(),
        "-H".to_string(),
        "X-GitHub-Api-Version: 2022-11-28".to_string(),
        "-A".to_string(),
        user_agent(&config.current_version),
        url,
    ];
    let out = exec
        .output("curl", &args)
        .map_err(|err| UpdateError::new(format!("could not run curl: {err}"), 1))?;
    if out.code != 0 {
        return Err(UpdateError::new(
            format!(
                "GitHub release query failed via curl (exit {}): {}",
                out.code, out.stderr
            ),
            1,
        ));
    }
    parse_release_response(&out.stdout, config.channel)
}

fn parse_release_response(json: &str, channel: Channel) -> Result<Release, UpdateError> {
    let root = JsonValue::parse(json)
        .ok_or_else(|| UpdateError::new("failed to parse GitHub release JSON", 1))?;
    match channel {
        Channel::Stable => Release::from_json(&root).ok_or_else(|| {
            UpdateError::new("GitHub latest release JSON has no usable MSI metadata", 1)
        }),
        Channel::Alpha => {
            let releases = root
                .as_array()
                .ok_or_else(|| UpdateError::new("GitHub alpha release list was not an array", 1))?;
            releases
                .iter()
                .filter_map(Release::from_json)
                .filter(|release| release.prerelease)
                .find(|release| select_cli_msi_asset(release).is_some())
                .ok_or_else(|| {
                    UpdateError::new("no prerelease with CLI MSI asset found in alpha channel", 1)
                })
        }
    }
}

fn download_msi<E: LocalExec + ?Sized>(
    exec: &mut E,
    config: &UpdateConfig,
    version: &str,
    asset: &Asset,
) -> Result<PathBuf, UpdateError> {
    fs::create_dir_all(&config.temp_dir).map_err(|err| {
        UpdateError::new(
            format!(
                "could not create temp dir {}: {err}",
                config.temp_dir.display()
            ),
            1,
        )
    })?;
    let dest = config.temp_dir.join(format!(
        "xpair-self-update-{}-{version}.msi",
        std::process::id()
    ));
    let _ = fs::remove_file(&dest);
    let dest_arg = path_arg(&dest);
    let args = vec![
        "-fL".to_string(),
        "--retry".to_string(),
        "2".to_string(),
        "-A".to_string(),
        user_agent(&config.current_version),
        "-o".to_string(),
        dest_arg,
        "-w".to_string(),
        "%{size_download} %{content_length_download}".to_string(),
        asset.url.clone(),
    ];
    let out = exec
        .output("curl", &args)
        .map_err(|err| UpdateError::new(format!("could not run curl download: {err}"), 1))?;
    if out.code != 0 {
        return Err(UpdateError::new(
            format!(
                "MSI download failed via curl (exit {}): {}",
                out.code, out.stderr
            ),
            1,
        ));
    }

    let actual_len = fs::metadata(&dest)
        .map_err(|err| UpdateError::new(format!("downloaded MSI missing: {err}"), 1))?
        .len();
    if actual_len == 0 {
        return Err(UpdateError::new("downloaded MSI is empty", 1));
    }

    let curl_lengths = parse_curl_lengths(&out.stdout);
    if let Some(size_download) = curl_lengths.size_download {
        if size_download != actual_len {
            return Err(UpdateError::new(
                format!("curl reported {size_download} bytes but wrote {actual_len}"),
                1,
            ));
        }
    }
    let expected_len = curl_lengths.content_length.or(asset.size);
    let Some(expected_len) = expected_len else {
        return Err(UpdateError::new("download missing content-length", 1));
    };
    if expected_len == 0 {
        return Err(UpdateError::new("download content-length was zero", 1));
    }
    if expected_len != actual_len {
        return Err(UpdateError::new(
            format!("content-length mismatch: expected {expected_len}, got {actual_len}"),
            1,
        ));
    }

    Ok(dest)
}

fn install_msi<E: LocalExec + ?Sized>(exec: &mut E, path: &Path) -> Result<(), UpdateError> {
    let args = vec!["/i".to_string(), path_arg(path), "/passive".to_string()];
    let code = exec
        .status("msiexec", &args)
        .map_err(|err| UpdateError::new(format!("could not run msiexec: {err}"), 1))?;
    if code == 0 {
        Ok(())
    } else {
        Err(UpdateError::new(
            format!("msiexec failed with exit {code}"),
            1,
        ))
    }
}

fn select_cli_msi_asset(release: &Release) -> Option<(String, &Asset)> {
    release
        .assets
        .iter()
        .filter_map(|asset| {
            cli_version_from_msi_asset_name(&asset.name).map(|version| (version, asset))
        })
        .max_by(|(a_version, _), (b_version, _)| version_cmp(a_version, b_version))
}

fn cli_version_from_msi_asset_name(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let prefix = "xpair-";
    let suffix = "-x64.msi";
    if !lower.starts_with(prefix) || !lower.ends_with(suffix) {
        return None;
    }
    let version = &name[prefix.len()..name.len() - suffix.len()];
    if version_key(version).is_some() {
        Some(clean_version(version))
    } else {
        None
    }
}

pub fn is_newer(a: &str, than: &str) -> bool {
    version_cmp(a, than) == Ordering::Greater
}

fn version_cmp(a: &str, b: &str) -> Ordering {
    parse_version(a).cmp(&parse_version(b))
}

fn parse_version(raw: &str) -> (u32, u32, u32, u32) {
    version_key(raw).unwrap_or((0, 0, 0, 0))
}

fn version_key(raw: &str) -> Option<(u32, u32, u32, u32)> {
    let core = clean_version(raw);
    let mut parts = core.split('.');
    let major = parse_nonempty_u32(parts.next()?)?;
    let minor = parse_nonempty_u32(parts.next()?)?;
    let patch_part = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let (patch_raw, alpha) = split_alpha(patch_part);
    let patch = parse_nonempty_u32(patch_raw)?;
    Some((major, minor, patch, alpha))
}

fn parse_nonempty_u32(raw: &str) -> Option<u32> {
    if raw.is_empty() {
        None
    } else {
        raw.parse().ok()
    }
}

fn split_alpha(patch_part: &str) -> (&str, u32) {
    let Some(idx) = patch_part.find(['a', 'A']) else {
        return (patch_part, u32::MAX);
    };
    let (patch, suffix) = patch_part.split_at(idx);
    let alpha = suffix
        .get(1..)
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    (patch, alpha)
}

fn clean_version(raw: &str) -> String {
    raw.trim()
        .trim_start_matches(['v', 'V'])
        .split('-')
        .next()
        .unwrap_or_default()
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CurlLengths {
    size_download: Option<u64>,
    content_length: Option<u64>,
}

fn parse_curl_lengths(stdout: &str) -> CurlLengths {
    let mut nums = stdout
        .split_whitespace()
        .filter_map(|part| part.parse::<f64>().ok())
        .filter(|n| *n >= 0.0)
        .map(|n| n as u64);
    CurlLengths {
        size_download: nums.next(),
        content_length: nums.next(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Release {
    tag: String,
    prerelease: bool,
    assets: Vec<Asset>,
}

impl Release {
    fn from_json(value: &JsonValue) -> Option<Release> {
        let tag = value.get("tag_name")?.as_str()?.to_string();
        let prerelease = value
            .get("prerelease")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        let assets = value
            .get("assets")
            .and_then(JsonValue::as_array)
            .unwrap_or(&[])
            .iter()
            .filter_map(Asset::from_json)
            .collect();
        Some(Release {
            tag,
            prerelease,
            assets,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Asset {
    name: String,
    url: String,
    size: Option<u64>,
}

impl Asset {
    fn from_json(value: &JsonValue) -> Option<Asset> {
        Some(Asset {
            name: value.get("name")?.as_str()?.to_string(),
            url: value.get("browser_download_url")?.as_str()?.to_string(),
            size: value
                .get("size")
                .and_then(JsonValue::as_i64)
                .and_then(|size| u64::try_from(size).ok()),
        })
    }
}

fn user_agent(version: &str) -> String {
    format!("{USER_AGENT_PREFIX}/{version}")
}

fn path_arg(path: &Path) -> String {
    path.display().to_string()
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.is_empty())
}

// Minimal JSON value parser for GitHub release metadata. This mirrors the dependency-free parser
// used by `discover` so the native CLI stays buildable offline.
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

    fn as_i64(&self) -> Option<i64> {
        match self {
            JsonValue::Num(raw) => raw.parse::<i64>().ok(),
            _ => None,
        }
    }

    fn as_array(&self) -> Option<&[JsonValue]> {
        match self {
            JsonValue::Arr(items) => Some(items),
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
        self.idx += 1;
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
                b',' => self.idx += 1,
                b'}' => {
                    self.idx += 1;
                    return Some(JsonValue::Obj(fields));
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self) -> Option<JsonValue> {
        self.idx += 1;
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
                b',' => self.idx += 1,
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
                            s.push(char::from_u32(cp as u32).unwrap_or('\u{FFFD}'));
                        }
                        _ => return None,
                    }
                }
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
    use std::cell::RefCell;

    #[test]
    fn version_compare_matches_alpha_train_rules() {
        assert!(is_newer("v0.5.0a13", "0.5.0a12"));
        assert!(is_newer("0.5.0", "0.5.0a99"));
        assert!(is_newer("0.6.0", "0.5.9"));
        assert!(!is_newer("0.5.0a1", "0.5.0"));
        assert!(!is_newer("v0.1.0", "0.1.0"));
    }

    #[test]
    fn asset_selection_uses_versioned_cli_msi_only() {
        let release = Release {
            tag: "v9.9.9".to_string(),
            prerelease: false,
            assets: vec![
                asset("xpair-cli.msi", "https://example.com/stable", 7),
                asset("xpair-0.1.9-x64.msi", "https://example.com/old", 7),
                asset("xpair-0.2.0-x64.msi", "https://example.com/versioned", 7),
            ],
        };
        assert_eq!(
            select_cli_msi_asset(&release).map(|(version, asset)| (version, asset.name.as_str())),
            Some(("0.2.0".to_string(), "xpair-0.2.0-x64.msi"))
        );

        let release = Release {
            tag: "v9.9.9".to_string(),
            prerelease: false,
            assets: vec![asset("xpair-cli.msi", "https://example.com/stable", 7)],
        };
        assert_eq!(select_cli_msi_asset(&release), None);
    }

    #[test]
    fn alpha_response_picks_newest_prerelease_with_cli_msi_asset() {
        let release = parse_release_response(
            r#"[
              {"tag_name":"host-v0.5.0a4","prerelease":true,"assets":[{"name":"XpairHost.zip","browser_download_url":"https://example.com/host","size":7}]},
              {"tag_name":"host-v0.5.0","prerelease":false,"assets":[{"name":"xpair-0.2.0-x64.msi","browser_download_url":"https://example.com/final","size":7}]},
              {"tag_name":"host-v0.5.0a3","prerelease":true,"assets":[{"name":"xpair-0.2.0a3-x64.msi","browser_download_url":"https://example.com/a3","size":7}]},
              {"tag_name":"host-v0.5.0a2","prerelease":true,"assets":[{"name":"xpair-0.2.0a2-x64.msi","browser_download_url":"https://example.com/a2","size":7}]}
            ]"#,
            Channel::Alpha,
        )
        .unwrap();
        assert_eq!(release.tag, "host-v0.5.0a3");
    }

    #[test]
    fn windows_update_uses_curl_and_msiexec_argv() {
        let tmp = TestDir::new("self-update-success");
        let mut exec = MockExec::new(
            r#"{"tag_name":"host-v9.9.9","prerelease":false,"assets":[{"name":"xpair-0.2.0-x64.msi","browser_download_url":"https://example.com/xpair-0.2.0-x64.msi","size":7}]}"#,
            7,
        );
        let config = UpdateConfig {
            os: Os::Windows,
            repo: "x10lab/xpair".to_string(),
            channel: Channel::Stable,
            current_version: "0.1.0".to_string(),
            temp_dir: tmp.path.clone(),
        };

        let outcome = run_with_exec(&mut exec, &config).unwrap();
        assert!(matches!(
            outcome,
            UpdateOutcome::Installed { version, .. } if version == "0.2.0"
        ));

        let calls = exec.calls.borrow();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].program, "curl");
        assert!(calls[0]
            .args
            .contains(&"https://api.github.com/repos/x10lab/xpair/releases/latest".to_string()));
        assert_eq!(calls[1].program, "curl");
        assert!(calls[1].args.contains(&"-o".to_string()));
        assert!(calls[1]
            .args
            .contains(&"https://example.com/xpair-0.2.0-x64.msi".to_string()));
        assert_eq!(calls[2].program, "msiexec");
        assert_eq!(calls[2].args[0], "/i");
        assert_eq!(calls[2].args[2], "/passive");
    }

    #[test]
    fn stable_release_without_cli_msi_asset_reports_clean_error() {
        let tmp = TestDir::new("self-update-no-cli-msi");
        let mut exec = MockExec::new(
            r#"{"tag_name":"host-v9.9.9","prerelease":false,"assets":[{"name":"xpair-cli.msi","browser_download_url":"https://example.com/xpair-cli.msi","size":7}]}"#,
            7,
        );
        let config = UpdateConfig {
            os: Os::Windows,
            repo: "x10lab/xpair".to_string(),
            channel: Channel::Stable,
            current_version: "0.1.0".to_string(),
            temp_dir: tmp.path.clone(),
        };

        let err = run_with_exec(&mut exec, &config).unwrap_err();
        assert!(err
            .message
            .contains("has no CLI asset matching xpair-<version>-x64.msi"));
        assert_eq!(exec.calls.borrow().len(), 1);
    }

    #[test]
    fn non_windows_defers_to_bash_flow_without_curl() {
        let tmp = TestDir::new("self-update-non-windows");
        let mut exec = MockExec::new("{}", 0);
        let config = UpdateConfig {
            os: Os::Mac,
            repo: "x10lab/xpair".to_string(),
            channel: Channel::Stable,
            current_version: "0.1.0".to_string(),
            temp_dir: tmp.path.clone(),
        };

        let outcome = run_with_exec(&mut exec, &config).unwrap();
        assert_eq!(outcome, UpdateOutcome::NonWindows);
        assert!(exec.calls.borrow().is_empty());
    }

    fn asset(name: &str, url: &str, size: u64) -> Asset {
        Asset {
            name: name.to_string(),
            url: url.to_string(),
            size: Some(size),
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Call {
        program: String,
        args: Vec<String>,
    }

    struct MockExec {
        calls: RefCell<Vec<Call>>,
        release_json: String,
        download_len: usize,
    }

    impl MockExec {
        fn new(release_json: &str, download_len: usize) -> MockExec {
            MockExec {
                calls: RefCell::new(Vec::new()),
                release_json: release_json.to_string(),
                download_len,
            }
        }
    }

    impl LocalExec for MockExec {
        fn output(&mut self, program: &str, args: &[String]) -> io::Result<ExecOutput> {
            self.calls.borrow_mut().push(Call {
                program: program.to_string(),
                args: args.to_vec(),
            });
            if program == "curl" && args.iter().any(|arg| arg == "-o") {
                let out_idx = args.iter().position(|arg| arg == "-o").unwrap() + 1;
                fs::write(&args[out_idx], vec![b'x'; self.download_len])?;
                Ok(ExecOutput {
                    code: 0,
                    stdout: format!("{} {}", self.download_len, self.download_len),
                    stderr: String::new(),
                })
            } else {
                Ok(ExecOutput {
                    code: 0,
                    stdout: self.release_json.clone(),
                    stderr: String::new(),
                })
            }
        }

        fn status(&mut self, program: &str, args: &[String]) -> io::Result<i32> {
            self.calls.borrow_mut().push(Call {
                program: program.to_string(),
                args: args.to_vec(),
            });
            Ok(0)
        }
    }

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let path = env::temp_dir().join(format!(
                "xpair-{name}-{}-{}",
                std::process::id(),
                now_nanos()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            TestDir { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn now_nanos() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
