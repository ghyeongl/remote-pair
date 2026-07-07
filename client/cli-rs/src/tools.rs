//! Thin pass-through launchers for sibling client tools.
//!
//! The bash CLI resolves these with `_resolve_client_tool`: PATH, `LOCAL_BIN`,
//! `RP_CLIENT_DIR/bin`, then a tool beside the CLI itself. This module keeps that order
//! shared for `editor`, `desktop`, and `mount`.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use crate::config;

/// Resolve a sibling client tool using the bash order.
///
/// `local_bin`, `rp_bin`, and `repo_sibling` are directories; `name` is appended
/// to each. Filesystem checks are delegated to the runtime candidate resolver.
pub fn resolve_client_tool(
    name: &str,
    on_path: Option<PathBuf>,
    local_bin: &Path,
    rp_bin: &Path,
    repo_sibling: &Path,
) -> Option<PathBuf> {
    resolve_client_tool_with(
        name,
        on_path,
        local_bin,
        rp_bin,
        repo_sibling,
        executable_path,
    )
}

/// Pure ordering core for tests and for the thin runtime shim.
pub fn resolve_client_tool_with<F>(
    name: &str,
    on_path: Option<PathBuf>,
    local_bin: &Path,
    rp_bin: &Path,
    repo_sibling: &Path,
    mut resolve_candidate: F,
) -> Option<PathBuf>
where
    F: FnMut(PathBuf) -> Option<PathBuf>,
{
    if let Some(path) = on_path {
        return Some(path);
    }

    for dir in [local_bin, rp_bin, repo_sibling] {
        if let Some(path) = resolve_candidate(dir.join(name)) {
            return Some(path);
        }
    }

    None
}

pub fn run_passthrough(name: &str, args: &[String]) -> ExitCode {
    let mut stderr = io::stderr();
    run_passthrough_with(
        name,
        args,
        || resolve_runtime_client_tool(name),
        run_tool,
        &mut stderr,
    )
}

fn run_passthrough_with<R, S, W>(
    name: &str,
    args: &[String],
    resolve: R,
    spawn: S,
    stderr: &mut W,
) -> ExitCode
where
    R: FnOnce() -> Option<PathBuf>,
    S: FnOnce(&Path, &[String]) -> io::Result<ExitCode>,
    W: Write + ?Sized,
{
    let Some(tool) = resolve() else {
        let _ = writeln!(
            stderr,
            "{name} not found (install client, or run from the repo)"
        );
        return ExitCode::from(1);
    };

    match spawn(&tool, args) {
        Ok(code) => code,
        Err(err) => {
            let _ = writeln!(stderr, "{}: {err}", tool.display());
            ExitCode::from(1)
        }
    }
}

fn resolve_runtime_client_tool(name: &str) -> Option<PathBuf> {
    let on_path = find_on_path(name);
    let local_bin = config::default_local_bin().ok();
    let rp_bin = config::default_client_env_path()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .map(|dir| dir.join("bin"));
    let repo_sibling = current_exe_dir();

    if let Some(path) = on_path {
        return Some(path);
    }

    for dir in [
        local_bin.as_deref(),
        rp_bin.as_deref(),
        repo_sibling.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(path) = executable_path(dir.join(name)) {
            return Some(path);
        }
    }

    None
}

#[cfg(unix)]
fn run_tool(tool: &Path, args: &[String]) -> io::Result<ExitCode> {
    use std::os::unix::process::CommandExt;

    let err = Command::new(tool).args(args).exec();
    Err(err)
}

#[cfg(not(unix))]
fn run_tool(tool: &Path, args: &[String]) -> io::Result<ExitCode> {
    let status = Command::new(tool).args(args).status()?;
    Ok(exit_code_from_i32(status.code().unwrap_or(1)))
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let name_path = Path::new(name);
    if name_path.components().count() > 1 {
        return executable_path(name_path.to_path_buf());
    }

    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if let Some(candidate) = executable_path(dir.join(name)) {
            return Some(candidate);
        }
    }

    None
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

#[cfg(unix)]
fn executable_path(path: PathBuf) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .ok()
        .filter(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .map(|_| path)
}

#[cfg(windows)]
fn executable_path(path: PathBuf) -> Option<PathBuf> {
    if windows_executable_file(&path) {
        return Some(path);
    }

    if path.extension().is_none() {
        for ext in windows_path_exts() {
            let candidate = path.with_extension(ext);
            if windows_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }

    None
}

#[cfg(windows)]
fn windows_executable_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                windows_path_exts()
                    .iter()
                    .any(|known| ext.eq_ignore_ascii_case(known))
            })
}

#[cfg(windows)]
fn windows_path_exts() -> Vec<String> {
    std::env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter_map(|ext| {
                    let ext = ext.trim().trim_start_matches('.');
                    (!ext.is_empty()).then(|| ext.to_string())
                })
                .collect()
        })
        .filter(|exts: &Vec<String>| !exts.is_empty())
        .unwrap_or_else(|| vec!["COM".into(), "EXE".into(), "BAT".into(), "CMD".into()])
}

#[cfg(not(any(unix, windows)))]
fn executable_path(path: PathBuf) -> Option<PathBuf> {
    path.is_file().then_some(path)
}

#[cfg(not(unix))]
fn exit_code_from_i32(code: i32) -> ExitCode {
    if code == 0 {
        ExitCode::SUCCESS
    } else if (1..=255).contains(&code) {
        ExitCode::from(code as u8)
    } else {
        ExitCode::from(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(path: &str) -> PathBuf {
        path.split('/').collect()
    }

    fn resolve_with_present(on_path: Option<PathBuf>, present: &[PathBuf]) -> Option<PathBuf> {
        resolve_client_tool_with(
            "xpair-editor",
            on_path,
            Path::new("local-bin"),
            Path::new("rp-bin"),
            Path::new("repo-sibling"),
            |candidate| {
                if present.iter().any(|path| path == &candidate) {
                    Some(candidate)
                } else {
                    None
                }
            },
        )
    }

    #[test]
    fn resolve_path_wins() {
        let path_tool = p("path/xpair-editor");
        assert_eq!(
            resolve_with_present(
                Some(path_tool.clone()),
                &[p("local-bin/xpair-editor"), p("rp-bin/xpair-editor")]
            ),
            Some(path_tool)
        );
    }

    #[test]
    fn resolve_local_bin_wins_after_path() {
        assert_eq!(
            resolve_with_present(
                None,
                &[
                    p("local-bin/xpair-editor"),
                    p("rp-bin/xpair-editor"),
                    p("repo-sibling/xpair-editor")
                ]
            ),
            Some(p("local-bin/xpair-editor"))
        );
    }

    #[test]
    fn resolve_client_runtime_bin_wins_after_local_bin() {
        assert_eq!(
            resolve_with_present(
                None,
                &[p("rp-bin/xpair-editor"), p("repo-sibling/xpair-editor")]
            ),
            Some(p("rp-bin/xpair-editor"))
        );
    }

    #[test]
    fn resolve_repo_sibling_is_last_match() {
        assert_eq!(
            resolve_with_present(None, &[p("repo-sibling/xpair-editor")]),
            Some(p("repo-sibling/xpair-editor"))
        );
    }

    #[test]
    fn resolve_none_when_no_candidates_match() {
        assert_eq!(resolve_with_present(None, &[]), None);
    }

    #[test]
    fn run_passthrough_reports_missing_without_spawning() {
        let mut stderr = Vec::new();
        let args = vec!["--flag".to_string()];

        let code = run_passthrough_with(
            "xpair-editor",
            &args,
            || None,
            |_, _| -> io::Result<ExitCode> { panic!("spawn should not run") },
            &mut stderr,
        );

        assert_eq!(code, ExitCode::from(1));
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            "xpair-editor not found (install client, or run from the repo)\n"
        );
    }
}
