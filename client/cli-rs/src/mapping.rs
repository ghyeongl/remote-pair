//! Folder mapping from a client path to the POSIX host path.
//!
//! Ports `map_to_host()`/`resolve_host()` from `client/cli/bin/maplib.sh:7-16`:
//! `FOLDER_MAPS` is a `;`-separated list of
//! `client::host` entries, empty entries are ignored, entries without `::` are identity
//! mappings, and the longest matching client prefix wins.

use crate::platform::Os;
use std::fmt;

/// One parsed `FOLDER_MAPS` entry: `(client_path, host_path)`.
pub type FolderMap = (String, String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredUnc {
    pub root: String,
    pub subpath: String,
}

impl DiscoveredUnc {
    pub fn path(&self) -> String {
        if self.subpath.is_empty() {
            self.root.clone()
        } else {
            format!("{}/{}", self.root, self.subpath.trim_start_matches('/'))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MapError {
    WslPath { path: String },
    MappingRequired { path: String },
}

impl fmt::Display for MapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MapError::WslPath { path } => {
                write!(f, "unsupported WSL path for native xpair client: {path}")
            }
            MapError::MappingRequired { path } => write!(
                f,
                "Windows launch path is outside FOLDER_MAPS: {path}; add the mapping with: xpair map add <UNC-or-drive path> <host path>"
            ),
        }
    }
}

impl std::error::Error for MapError {}

/// Parse a `FOLDER_MAPS` string into `(client, host)` pairs.
///
/// Bash parity: split only on `;`, ignore empty entries, split each entry on the first
/// `::`, and treat entries without `::` as identity mappings.
pub fn parse_maps(raw: &str) -> Vec<FolderMap> {
    raw.split(';')
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            if let Some(idx) = entry.find("::") {
                (
                    entry[..idx].to_string(),
                    entry[idx + "::".len()..].to_string(),
                )
            } else {
                (entry.to_string(), entry.to_string())
            }
        })
        .collect()
}

/// Resolve `client_path` to its host path using longest client-prefix matching.
///
/// The match is exact client root or slash-delimited child path, mirroring the bash
/// `case "$d" in "$c"|"$c"/*)` behavior. If no map matches, the canonicalized path is
/// returned as a POSIX host-side path.
pub fn map_to_host(client_path: &str, pairs: &[FolderMap]) -> Result<String, MapError> {
    map_to_host_for_os(client_path, pairs, Os::current())
}

/// Resolve a client path while using the supplied client OS for prefix matching.
///
/// Windows-native clients compare path prefixes case-insensitively (drive letter and
/// components). Unix clients keep the bash byte-exact prefix behavior.
pub fn map_to_host_for_os(
    client_path: &str,
    pairs: &[FolderMap],
    os: Os,
) -> Result<String, MapError> {
    let path = canonicalize_client_path(client_path)?;
    let mut best_client = String::new();
    let mut best_host = String::new();

    for (client, host) in pairs {
        let candidate = canonicalize_client_path(client)?;
        if !candidate.is_empty()
            && path_prefix_matches(&path, &candidate, os)
            && candidate.len() > best_client.len()
        {
            best_client = candidate;
            best_host = host.clone();
        }
    }

    if best_client.is_empty() && os == Os::Windows {
        return Err(MapError::MappingRequired { path });
    }
    if best_client.is_empty() {
        return Ok(to_posix_path(&path));
    }

    let suffix = &path[best_client.len()..];
    Ok(format!(
        "{}{}",
        to_posix_path(&best_host),
        to_posix_path(suffix)
    ))
}

/// Canonicalize a client path string for Windows-native matching, without touching the
/// filesystem.
///
/// Decision table:
/// - `C:\a\b` and `C:/a/b`: compare as `C:/a/b`; drive letter is case-insensitive.
/// - `\\server\share\a`: compare as `//server/share/a` (UNC is preserved).
/// - `\\?\C:\a` and `\\?\UNC\server\share`: strip the long-path prefix first.
/// - `/mnt/c/...` and `\\wsl$\...`: reject with `MapError::WslPath`.
/// - Host results are POSIX paths, so backslashes become `/` after substitution.
pub fn canonicalize_client_path(path: &str) -> Result<String, MapError> {
    let mut out = path.replace('\\', "/");
    reject_wsl_path(path, &out)?;

    if let Some(rest) = strip_prefix_ascii_case(&out, "//?/UNC/") {
        out = format!("//{rest}");
    } else if let Some(rest) = strip_prefix_ascii_case(&out, "//?/") {
        out = rest.to_string();
    }

    reject_wsl_path(path, &out)?;
    uppercase_drive_letter(&mut out);
    Ok(out)
}

/// Normalize a client path before writing it back to `FOLDER_MAPS` or
/// `FOLDER_MAP_MODES`.
///
/// Windows `fs::canonicalize` may return verbatim paths (`\\?\C:\...` or
/// `\\?\UNC\...`). Those are useful for Win32 APIs, but they are not the mapping
/// format bash and the rest of xpair consume. Persist the comparable form instead.
pub fn normalize_client_path_for_persistence(path: &str, os: Os) -> String {
    if os != Os::Windows {
        return path.to_string();
    }

    let mut normalized = canonicalize_client_path(path).unwrap_or_else(|_| path.replace('\\', "/"));
    trim_trailing_windows_separators(&mut normalized);
    normalized
}

/// Normalize all client keys in parsed mapping rows before display or rewrite.
pub fn normalize_folder_maps_for_persistence(pairs: Vec<FolderMap>, os: Os) -> Vec<FolderMap> {
    pairs
        .into_iter()
        .map(|(client, host)| (normalize_client_path_for_persistence(&client, os), host))
        .collect()
}

/// Compare two client mapping keys using the same normalization as persistence.
pub fn client_path_eq_for_os(left: &str, right: &str, os: Os) -> bool {
    if os == Os::Windows {
        normalize_windows_path_for_cmp(left) == normalize_windows_path_for_cmp(right)
    } else {
        left == right
    }
}

/// Return true when `path` is exactly `prefix` or is a child path under it.
pub fn client_path_eq_or_child_for_os(path: &str, prefix: &str, os: Os) -> bool {
    if os == Os::Windows {
        let path = normalize_windows_path_for_cmp(path);
        let prefix = normalize_windows_path_for_cmp(prefix);
        return path == prefix
            || path
                .strip_prefix(&prefix)
                .is_some_and(|suffix| suffix.starts_with('/'));
    }

    path_prefix_matches(path, prefix, os)
}

fn path_prefix_matches(path: &str, prefix: &str, os: Os) -> bool {
    if os == Os::Windows {
        path.eq_ignore_ascii_case(prefix)
            || (path.len() > prefix.len()
                && path
                    .as_bytes()
                    .get(prefix.len())
                    .is_some_and(|ch| is_windows_separator(*ch))
                && path[..prefix.len()].eq_ignore_ascii_case(prefix))
    } else {
        path == prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with('/'))
    }
}

fn normalize_windows_path_for_cmp(path: &str) -> String {
    let mut normalized = normalize_client_path_for_persistence(path, Os::Windows);
    trim_trailing_windows_separators(&mut normalized);
    normalized.to_ascii_lowercase()
}

fn trim_trailing_windows_separators(path: &mut String) {
    while path.len() > 3 && path.ends_with('/') {
        path.pop();
    }
}

fn is_windows_separator(ch: u8) -> bool {
    matches!(ch, b'/' | b'\\')
}

fn to_posix_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn strip_prefix_ascii_case<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let bytes = s.as_bytes();
    let prefix = prefix.as_bytes();

    if bytes.len() < prefix.len() {
        None
    } else if bytes[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

fn uppercase_drive_letter(path: &mut String) {
    let drive = {
        let bytes = path.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            Some((bytes[0] as char).to_ascii_uppercase())
        } else {
            None
        }
    };

    if let Some(drive) = drive {
        path.replace_range(0..1, &drive.to_string());
    }
}

fn reject_wsl_path(original: &str, normalized: &str) -> Result<(), MapError> {
    if is_wsl_path(normalized) {
        Err(MapError::WslPath {
            path: original.to_string(),
        })
    } else {
        Ok(())
    }
}

fn is_wsl_path(path: &str) -> bool {
    path.eq_ignore_ascii_case("//wsl$")
        || strip_prefix_ascii_case(path, "//wsl$/").is_some()
        || is_wsl_mount_path(path)
}

fn is_wsl_mount_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 6
        && strip_prefix_ascii_case(path, "/mnt/").is_some()
        && bytes[5].is_ascii_alphabetic()
        && (bytes.len() == 6 || bytes[6] == b'/')
}

pub fn smb_host(remote_host: &str) -> &str {
    remote_host.rsplit('@').next().unwrap_or(remote_host)
}

pub fn share_name_for_hostpath(host_path: &str) -> String {
    posix_basename(host_path)
}

pub fn expected_unc_root(smb_host: &str, share: &str) -> String {
    format!(
        "//{}/{}",
        smb_host.trim_matches('/'),
        share.trim_matches('/')
    )
}

pub fn discover_unc_for_hostpath(remote_host: &str, host_path: &str) -> Option<DiscoveredUnc> {
    let host = smb_host(remote_host);
    let share = share_name_for_hostpath(host_path);
    if host.is_empty() || share.is_empty() {
        return None;
    }
    Some(DiscoveredUnc {
        root: expected_unc_root(host, &share),
        subpath: String::new(),
    })
}

fn posix_basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_semicolon_maps_and_identity_entries() {
        assert_eq!(
            parse_maps(";/client::/host;;/same;/a::/b::kept"),
            vec![
                ("/client".to_string(), "/host".to_string()),
                ("/same".to_string(), "/same".to_string()),
                ("/a".to_string(), "/b::kept".to_string()),
            ]
        );
    }

    #[test]
    fn identity_fallback_when_no_map_matches() {
        let maps = parse_maps("/client::/host");
        assert_eq!(
            map_to_host_for_os("/other/project", &maps, Os::Mac).unwrap(),
            "/other/project"
        );
        assert_eq!(
            map_to_host_for_os(r"C:\other\project", &maps, Os::Windows),
            Err(MapError::MappingRequired {
                path: "C:/other/project".to_string(),
            })
        );
    }

    #[test]
    fn single_map_preserves_subpath() {
        let maps = parse_maps("/sbx/proj::/host/proj");
        assert_eq!(
            map_to_host("/sbx/proj/sub", &maps).unwrap(),
            "/host/proj/sub"
        );
    }

    #[test]
    fn longest_prefix_wins() {
        let maps = parse_maps("/sbx/a::/x;/sbx/a/b::/y");
        assert_eq!(map_to_host("/sbx/a/b/c", &maps).unwrap(), "/y/c");
    }

    #[test]
    fn multiple_maps_select_matching_root() {
        let maps = parse_maps("/left::/host/left;/right::/host/right");
        assert_eq!(map_to_host("/right/sub", &maps).unwrap(), "/host/right/sub");
    }

    #[test]
    fn separator_free_entry_is_identity_mapping() {
        let maps = parse_maps("/plain");
        assert_eq!(map_to_host("/plain", &maps).unwrap(), "/plain");
    }

    #[test]
    fn prefix_match_requires_path_boundary() {
        let maps = parse_maps("/sbx/a::/x");
        assert_eq!(
            map_to_host_for_os("/sbx/ab", &maps, Os::Mac).unwrap(),
            "/sbx/ab"
        );

        let maps = parse_maps(r"C:\sbx\a::/x");
        assert_eq!(
            map_to_host_for_os(r"C:\sbx\ab", &maps, Os::Windows),
            Err(MapError::MappingRequired {
                path: "C:/sbx/ab".to_string(),
            })
        );
    }

    #[test]
    fn unix_prefix_match_is_byte_exact() {
        let maps = parse_maps("/Users/Alice/Project::/host/project");
        assert_eq!(
            map_to_host_for_os("/users/alice/project/sub", &maps, Os::Mac).unwrap(),
            "/users/alice/project/sub"
        );
    }

    #[test]
    fn windows_forward_slash_input_matches_backslash_map() {
        let maps = parse_maps(r"C:\Users\me::/host/me");
        assert_eq!(
            map_to_host("C:/Users/me/project", &maps).unwrap(),
            "/host/me/project"
        );
    }

    #[test]
    fn windows_unc_paths_are_matched() {
        let maps = parse_maps(r"\\server\share\proj::/host/proj");
        assert_eq!(
            map_to_host(r"\\server\share\proj\sub", &maps).unwrap(),
            "/host/proj/sub"
        );
    }

    #[test]
    fn windows_long_path_prefix_is_stripped() {
        let maps = parse_maps(r"C:\Users\me::/host/me");
        assert_eq!(
            map_to_host(r"\\?\C:\Users\me\sub", &maps).unwrap(),
            "/host/me/sub"
        );
    }

    #[test]
    fn windows_long_unc_prefix_is_stripped() {
        let maps = parse_maps(r"\\server\share::/host/share");
        assert_eq!(
            map_to_host(r"\\?\UNC\server\share\sub", &maps).unwrap(),
            "/host/share/sub"
        );
    }

    #[test]
    fn windows_unc_mapping_accepts_canonical_slash_root_round_trip() {
        let maps = parse_maps("//server/share::/Users/alice/Project");
        assert_eq!(
            map_to_host_for_os(r"\\SERVER\Share\src", &maps, Os::Windows).unwrap(),
            "/Users/alice/Project/src"
        );
    }

    #[test]
    fn canonicalizes_windows_client_path_forms() {
        assert_eq!(
            canonicalize_client_path(r"\\server\share\project").unwrap(),
            "//server/share/project"
        );
        assert_eq!(
            canonicalize_client_path(r"\\?\UNC\server\share\project").unwrap(),
            "//server/share/project"
        );
        assert_eq!(
            canonicalize_client_path(r"c:\Users\Alice\Project").unwrap(),
            "C:/Users/Alice/Project"
        );
    }

    #[test]
    fn windows_persistence_strips_verbatim_prefixes() {
        assert_eq!(
            normalize_client_path_for_persistence(r"\\?\C:\Users\Alice\Project", Os::Windows),
            "C:/Users/Alice/Project"
        );
        assert_eq!(
            normalize_client_path_for_persistence(r"\\?\UNC\server\share\Project", Os::Windows),
            "//server/share/Project"
        );
    }

    #[test]
    fn windows_persistence_normalizes_parsed_mapping_clients() {
        assert_eq!(
            normalize_folder_maps_for_persistence(
                parse_maps(
                    r"\\?\C:\Users\Alice\Project::/host/project;\\?\UNC\server\share::/host/share"
                ),
                Os::Windows,
            ),
            vec![
                (
                    "C:/Users/Alice/Project".to_string(),
                    "/host/project".to_string()
                ),
                ("//server/share".to_string(), "/host/share".to_string()),
            ]
        );
    }

    #[test]
    fn windows_mapping_key_compare_strips_verbatim_prefixes() {
        assert!(client_path_eq_for_os(
            r"\\?\C:\Users\Alice\Project",
            "c:/users/alice/project/",
            Os::Windows,
        ));
        assert!(client_path_eq_or_child_for_os(
            "C:/Users/Alice/Project/Sub",
            r"\\?\C:\Users\Alice\Project",
            Os::Windows,
        ));
        assert!(!client_path_eq_or_child_for_os(
            "C:/Users/Alice/Projectile",
            r"\\?\C:\Users\Alice\Project",
            Os::Windows,
        ));
    }

    #[test]
    fn windows_drive_letter_compare_is_case_insensitive() {
        let maps = parse_maps(r"c:\Users\me::/host/me");
        assert_eq!(
            map_to_host_for_os(r"C:\Users\me\sub", &maps, Os::Windows).unwrap(),
            "/host/me/sub"
        );
    }

    #[test]
    fn windows_components_compare_case_insensitively() {
        let maps = parse_maps(r"C:\Users\Alice\Project::/host/project");
        assert_eq!(
            map_to_host_for_os(r"c:\users\alice\project\Sub", &maps, Os::Windows).unwrap(),
            "/host/project/Sub"
        );
    }

    #[test]
    fn windows_case_insensitive_prefix_still_requires_boundary() {
        let maps = parse_maps(r"C:\Users\Alice\Project::/host/project");
        assert_eq!(
            map_to_host_for_os(r"c:\users\alice\projectile", &maps, Os::Windows),
            Err(MapError::MappingRequired {
                path: "C:/users/alice/projectile".to_string()
            })
        );
    }

    #[test]
    fn windows_requires_mapping_instead_of_identity_fallback() {
        assert_eq!(
            map_to_host_for_os(r"C:\Users\me\project", &[], Os::Windows),
            Err(MapError::MappingRequired {
                path: r"C:/Users/me/project".to_string(),
            })
        );
    }

    #[test]
    fn windows_prefix_match_accepts_either_separator_boundary() {
        assert!(path_prefix_matches(
            r"C:\Users\Alice\Project\Child",
            r"c:\users\alice\project",
            Os::Windows
        ));
        assert!(path_prefix_matches(
            "C:/Users/Alice/Project/Child",
            "c:/users/alice/project",
            Os::Windows
        ));
    }

    #[test]
    fn wsl_mount_paths_are_rejected() {
        assert_eq!(
            map_to_host("/mnt/c/Users/me", &[]),
            Err(MapError::WslPath {
                path: "/mnt/c/Users/me".to_string(),
            })
        );
    }

    #[test]
    fn wsl_unc_paths_are_rejected() {
        assert_eq!(
            map_to_host(r"\\wsl$\Ubuntu\home\me", &[]),
            Err(MapError::WslPath {
                path: r"\\wsl$\Ubuntu\home\me".to_string(),
            })
        );
    }

    #[test]
    fn win32_unc_helpers_match_bash_share_name_rule() {
        let unc = discover_unc_for_hostpath("alice@office-mac.local", "/Users/alice/Projects/foo")
            .unwrap();
        assert_eq!(unc.root, "//office-mac.local/foo");
        assert_eq!(unc.subpath, "");
        assert_eq!(unc.path(), "//office-mac.local/foo");
        assert_eq!(share_name_for_hostpath("/Users/alice/Projects/foo/"), "foo");
    }
}
