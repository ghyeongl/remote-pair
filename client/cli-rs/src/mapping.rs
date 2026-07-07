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
}
