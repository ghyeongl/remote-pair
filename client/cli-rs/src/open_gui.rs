//! `xpair open-gui` terminal launch construction.
//!
//! Ports `cmd_open_gui()` from `client/cli/xpair:679-719`: resolve the target folder,
//! construct `exec <self> launch <dir>` for macOS terminal apps, and open a new terminal
//! window/tab. The platform-specific command construction stays pure; process spawning is
//! kept in the small runtime shim below.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use crate::config;
use crate::platform::Os;

const ITERM_PATH: &str = "/Applications/iTerm.app";
const TERMINAL_PATH: &str = "/System/Applications/Utilities/Terminal.app";

/// How `open-gui` should launch the configured terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalSpawn {
    /// macOS launches through `osascript`; the string is the AppleScript body.
    Osascript(String),
    /// Windows and Linux launch directly through argv.
    Argv(Vec<String>),
}

/// Build the local argv that the new terminal should run.
pub fn build_launch_command(self_exe: &str, dir: &str) -> Vec<String> {
    vec![self_exe.to_string(), "launch".to_string(), dir.to_string()]
}

/// Build the platform-specific terminal spawn command.
///
/// `terminal_pref` is already the effective terminal choice from env/config and runtime
/// fallback. On macOS, `iterm2` selects the iTerm AppleScript branch; anything else uses
/// Terminal.app. On Linux, a non-empty non-macOS preference is treated as a terminal program,
/// otherwise `x-terminal-emulator` is used.
pub fn build_terminal_spawn(
    os: Os,
    terminal_pref: &str,
    self_exe: &str,
    dir: &str,
    wt_available: bool,
) -> TerminalSpawn {
    match os {
        Os::Mac => TerminalSpawn::Osascript(build_macos_script(terminal_pref, self_exe, dir)),
        Os::Windows => TerminalSpawn::Argv(build_windows_spawn(self_exe, dir, wt_available)),
        Os::Linux => TerminalSpawn::Argv(build_linux_spawn(terminal_pref, self_exe, dir)),
    }
}

/// Resolve the `<dir>` argument to an absolute directory path.
pub fn resolve_dir_arg(args: &[String], cwd: &Path) -> Result<PathBuf, (String, u8)> {
    let Some(raw) = args.first() else {
        return Err(("dir required".to_string(), 1));
    };

    let raw_path = Path::new(raw);
    let dir = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        cwd.join(raw_path)
    };

    if dir.is_dir() {
        Ok(dir)
    } else {
        Err((format!("folder not found: {raw}"), 1))
    }
}

/// CLI entrypoint for `xpair open-gui`.
pub fn run(args: &[String]) -> ExitCode {
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(err) => {
            eprintln!("xpair open-gui: {err}");
            return ExitCode::from(1);
        }
    };
    let client_env_path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair open-gui: {err}");
            return ExitCode::from(2);
        }
    };

    let os = Os::current();
    let terminal_app = match resolve_terminal_app(&client_env_path) {
        Ok(app) => app,
        Err(err) => {
            eprintln!("xpair open-gui: {err}");
            return ExitCode::from(1);
        }
    };
    let self_exe = resolve_self_cli(&client_env_path);
    let mut stderr = io::stderr();
    let terminal_pref = effective_terminal_pref(os, &terminal_app, &mut stderr);
    let context = RuntimeContext {
        os,
        terminal_pref,
        self_exe,
        wt_available: os == Os::Windows && wt_available(),
        cwd,
    };

    run_with_context(args, &context, &mut stderr, spawn_terminal)
}

struct RuntimeContext {
    os: Os,
    terminal_pref: String,
    self_exe: String,
    wt_available: bool,
    cwd: PathBuf,
}

fn run_with_context<E, F>(
    args: &[String],
    context: &RuntimeContext,
    err: &mut E,
    mut spawn: F,
) -> ExitCode
where
    E: Write,
    F: FnMut(&TerminalSpawn) -> io::Result<ExitCode>,
{
    let dir = match resolve_dir_arg(args, &context.cwd) {
        Ok(dir) => dir,
        Err((message, code)) => {
            let _ = writeln!(err, "{message}");
            return ExitCode::from(code);
        }
    };
    let dir = path_string(dir);
    let spawn_spec = build_terminal_spawn(
        context.os,
        &context.terminal_pref,
        &context.self_exe,
        &dir,
        context.wt_available,
    );

    match spawn(&spawn_spec) {
        Ok(code) => code,
        Err(err_inner) => {
            let _ = writeln!(err, "xpair open-gui: {err_inner}");
            ExitCode::from(1)
        }
    }
}

fn build_macos_script(terminal_pref: &str, self_exe: &str, dir: &str) -> String {
    let cmd = format!(
        "exec {} launch {}",
        bash_percent_q(self_exe),
        bash_percent_q(dir)
    );
    let esc = applescript_string_escape(&cmd);

    if terminal_pref == "iterm2" {
        format!(
            "tell application \"iTerm\"\n  activate\n  if (count of windows) is 0 then\n    set targetWindow to (create window with default profile)\n  else\n    tell current window to set newTab to (create tab with default profile)\n    set targetWindow to current window\n  end if\n  tell current session of targetWindow to write text \"{esc}\"\nend tell\n"
        )
    } else {
        format!("tell application \"Terminal\"\n  activate\n  do script \"{esc}\"\nend tell\n")
    }
}

fn build_windows_spawn(self_exe: &str, dir: &str, wt_available: bool) -> Vec<String> {
    let launch = build_launch_command(self_exe, dir);
    if wt_available {
        let mut argv = vec!["wt".to_string(), "new-tab".to_string()];
        argv.extend(launch);
        argv
    } else {
        vec![
            "cmd".to_string(),
            "/c".to_string(),
            cmd_start_command(&launch),
        ]
    }
}

fn cmd_start_command(argv: &[String]) -> String {
    let mut command = String::from("start \"\"");
    for arg in argv {
        command.push(' ');
        command.push_str(&cmd_start_quote(arg));
    }
    command
}

fn cmd_start_quote(arg: &str) -> String {
    let mut out = String::from("\"");
    for ch in arg.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn build_linux_spawn(terminal_pref: &str, self_exe: &str, dir: &str) -> Vec<String> {
    let terminal = match terminal_pref {
        "" | "terminal" | "iterm2" => "x-terminal-emulator",
        other => other,
    };
    let mut argv = vec![terminal.to_string(), "-e".to_string()];
    argv.extend(build_launch_command(self_exe, dir));
    argv
}

fn applescript_string_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
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

fn effective_terminal_pref<E: Write>(os: Os, terminal_app: &str, err: &mut E) -> String {
    match os {
        Os::Mac => {
            let selected = select_macos_terminal(
                terminal_app,
                Path::new(ITERM_PATH).is_dir(),
                Path::new(TERMINAL_PATH).exists(),
            );
            if let Some(warning) = selected.warning {
                let _ = writeln!(err, "{warning}");
            }
            selected.app
        }
        Os::Linux => non_empty_env("TERMINAL").unwrap_or_else(|| terminal_app.to_string()),
        Os::Windows => terminal_app.to_string(),
    }
}

struct TerminalSelection {
    app: String,
    warning: Option<String>,
}

fn select_macos_terminal(
    terminal_app: &str,
    iterm_installed: bool,
    terminal_installed: bool,
) -> TerminalSelection {
    if terminal_app == "iterm2" && !iterm_installed {
        TerminalSelection {
            app: "terminal".to_string(),
            warning: Some("iTerm2 not installed - falling back to Terminal.app".to_string()),
        }
    } else if terminal_app == "terminal" && !terminal_installed && iterm_installed {
        TerminalSelection {
            app: "iterm2".to_string(),
            warning: Some("Terminal.app not found - falling back to iTerm2".to_string()),
        }
    } else {
        TerminalSelection {
            app: terminal_app.to_string(),
            warning: None,
        }
    }
}

fn resolve_terminal_app(client_env_path: &Path) -> io::Result<String> {
    if let Some(value) = non_empty_env("TERMINAL_APP") {
        return Ok(value);
    }
    config::get_cli(client_env_path, "terminal")
}

fn resolve_self_cli(client_env_path: &Path) -> String {
    if let Some(local_bin) = configured_local_bin(client_env_path) {
        let candidate = normalize_windows_exe(local_bin.join("xpair"));
        if program_present(&candidate) {
            return path_string(candidate);
        }
    }

    std::env::current_exe()
        .map(path_string)
        .unwrap_or_else(|_| "xpair".to_string())
}

fn configured_local_bin(client_env_path: &Path) -> Option<PathBuf> {
    if let Some(local_bin) = non_empty_env("LOCAL_BIN") {
        return Some(PathBuf::from(local_bin));
    }
    if let Some(local_bin) = config::get(client_env_path, "LOCAL_BIN")
        .ok()
        .flatten()
        .filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(local_bin));
    }
    home_dir().map(|home| home.join(".local").join("bin"))
}

fn spawn_terminal(spawn: &TerminalSpawn) -> io::Result<ExitCode> {
    match spawn {
        TerminalSpawn::Osascript(script) => {
            let mut child = Command::new("osascript").stdin(Stdio::piped()).spawn()?;
            let Some(mut stdin) = child.stdin.take() else {
                return Err(io::Error::other("failed to open osascript stdin"));
            };
            stdin.write_all(script.as_bytes())?;
            drop(stdin);
            let status = child.wait()?;
            Ok(exit_code_from_i32(status.code().unwrap_or(1)))
        }
        TerminalSpawn::Argv(argv) => spawn_argv(argv),
    }
}

fn spawn_argv(argv: &[String]) -> io::Result<ExitCode> {
    let Some((program, args)) = argv.split_first() else {
        return Ok(ExitCode::from(1));
    };
    let status = Command::new(program).args(args).status()?;
    Ok(exit_code_from_i32(status.code().unwrap_or(1)))
}

fn wt_available() -> bool {
    command_available("wt.exe") || command_available("wt")
}

fn command_available(program: &str) -> bool {
    let program_path = Path::new(program);
    if program_path.components().count() > 1 {
        return program_present(program_path);
    }

    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };

    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(program);
        if program_present(&candidate) {
            return true;
        }
        #[cfg(windows)]
        {
            if candidate.extension().is_none() {
                for ext in windows_path_exts() {
                    if program_present(&candidate.with_extension(ext)) {
                        return true;
                    }
                }
            }
        }
    }

    false
}

#[cfg(windows)]
fn windows_path_exts() -> Vec<String> {
    std::env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter_map(|ext| ext.trim().trim_start_matches('.').split_whitespace().next())
                .filter(|ext| !ext.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_else(|| vec!["exe".to_string(), "cmd".to_string(), "bat".to_string()])
}

fn normalize_windows_exe(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if !path.is_file() {
            let exe = path.with_extension("exe");
            if exe.is_file() {
                return exe;
            }
        }
    }
    path
}

#[cfg(unix)]
fn program_present(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn program_present(path: &Path) -> bool {
    path.is_file() || path.with_extension("exe").is_file()
}

#[cfg(not(any(unix, windows)))]
fn program_present(path: &Path) -> bool {
    path.is_file()
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

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

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
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "xpair-open-gui-test-{}-{id}-{name}",
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

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    #[test]
    fn builds_launch_command() {
        assert_eq!(
            build_launch_command("/usr/local/bin/xpair", "/Users/me/project"),
            vec!["/usr/local/bin/xpair", "launch", "/Users/me/project"]
        );
    }

    #[test]
    fn builds_macos_iterm_script_with_escaping() {
        assert_eq!(
            build_terminal_spawn(
                Os::Mac,
                "iterm2",
                "/usr/local/bin/xpair",
                r#"/tmp/a\b"c"#,
                false,
            ),
            TerminalSpawn::Osascript(
                r#"tell application "iTerm"
  activate
  if (count of windows) is 0 then
    set targetWindow to (create window with default profile)
  else
    tell current window to set newTab to (create tab with default profile)
    set targetWindow to current window
  end if
  tell current session of targetWindow to write text "exec /usr/local/bin/xpair launch /tmp/a\\\\b\\\"c"
end tell
"#
                .to_string()
            )
        );
    }

    #[test]
    fn builds_macos_terminal_script() {
        assert_eq!(
            build_terminal_spawn(
                Os::Mac,
                "terminal",
                "/usr/local/bin/xpair",
                "/tmp/project",
                false,
            ),
            TerminalSpawn::Osascript(
                r#"tell application "Terminal"
  activate
  do script "exec /usr/local/bin/xpair launch /tmp/project"
end tell
"#
                .to_string()
            )
        );
    }

    #[test]
    fn builds_windows_wt_spawn_when_available() {
        assert_eq!(
            build_terminal_spawn(
                Os::Windows,
                "terminal",
                "C:\\bin\\xpair.exe",
                "C:\\work",
                true
            ),
            TerminalSpawn::Argv(vec![
                "wt".to_string(),
                "new-tab".to_string(),
                "C:\\bin\\xpair.exe".to_string(),
                "launch".to_string(),
                "C:\\work".to_string(),
            ])
        );
    }

    #[test]
    fn builds_windows_cmd_start_fallback() {
        assert_eq!(
            build_terminal_spawn(
                Os::Windows,
                "terminal",
                "C:\\Program Files\\Xpair (Preview)\\xpair.exe",
                "C:\\Users\\Alice\\Work Projects\\repo (main)",
                false,
            ),
            TerminalSpawn::Argv(vec![
                "cmd".to_string(),
                "/c".to_string(),
                "start \"\" \"C:\\Program Files\\Xpair (Preview)\\xpair.exe\" \"launch\" \"C:\\Users\\Alice\\Work Projects\\repo (main)\"".to_string(),
            ])
        );
    }

    #[test]
    fn builds_linux_terminal_spawn() {
        assert_eq!(
            build_terminal_spawn(Os::Linux, "", "/usr/bin/xpair", "/work/project", false),
            TerminalSpawn::Argv(vec![
                "x-terminal-emulator".to_string(),
                "-e".to_string(),
                "/usr/bin/xpair".to_string(),
                "launch".to_string(),
                "/work/project".to_string(),
            ])
        );
    }

    #[test]
    fn missing_dir_errors_before_spawn() {
        let tmp = TestDir::new("missing");
        let context = RuntimeContext {
            os: Os::Linux,
            terminal_pref: String::new(),
            self_exe: "xpair".to_string(),
            wt_available: false,
            cwd: tmp.path.clone(),
        };
        let mut err = Vec::new();
        let mut spawned = false;

        let code = run_with_context(&strings(&["missing"]), &context, &mut err, |_| {
            spawned = true;
            Ok(ExitCode::SUCCESS)
        });

        assert_eq!(code, ExitCode::from(1));
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "folder not found: missing\n"
        );
        assert!(!spawned);
    }
}
