//! `xpair host` local host-app launcher.
//!
//! This is the local-machine counterpart to the remote launch path: probe the host tmux-aqua
//! server, start the privileged macOS app when possible, and guide instead of pretending on
//! non-macOS clients. The local command and filesystem boundary is kept behind [`LocalRuntime`]
//! so tests can assert exact process attempts without starting GUI apps.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use crate::config;
use crate::platform::Os;
use crate::status;

pub(crate) const DEFAULT_APP_NAME: &str = "XpairHost";
const DEFAULT_BUNDLE_PREFIX: &str = "com.x10lab.xpair-host";
const FORWARD_APP: &str = "Xpair";
const FORWARD_BUNDLE: &str = "com.x10lab.xpair";
const DEFAULT_AQUA_SOCK: &str = "/tmp/aqua-tmux.sock";
const DEFAULT_APPROVE_TRIGGER: &str = "/tmp/xpair.approve-request";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl CommandSpec {
    fn new(program: impl Into<String>, args: Vec<String>) -> CommandSpec {
        CommandSpec {
            program: program.into(),
            args,
        }
    }
}

pub(crate) trait LocalRuntime {
    fn is_dir(&self, path: &Path) -> bool;
    fn is_file(&self, path: &Path) -> bool;
    fn is_executable(&self, path: &Path) -> bool;
    fn status(&mut self, command: &CommandSpec) -> io::Result<i32>;
    fn output(&mut self, command: &CommandSpec) -> io::Result<String>;
    fn sleep(&mut self, duration: Duration);
}

#[derive(Debug, Clone)]
pub(crate) struct AppIdentity {
    pub app_name: String,
    pub bundle_prefix: String,
    pub forward_app: String,
    pub forward_bundle: String,
}

impl AppIdentity {
    fn load(rp_host_dir: &Path) -> AppIdentity {
        AppIdentity {
            app_name: resolve_host_env_stack_value(rp_host_dir, "APP_NAME")
                .unwrap_or_else(|| DEFAULT_APP_NAME.to_string()),
            bundle_prefix: resolve_host_env_stack_value(rp_host_dir, "BUNDLE_PREFIX")
                .unwrap_or_else(|| DEFAULT_BUNDLE_PREFIX.to_string()),
            forward_app: resolve_host_env_stack_value(rp_host_dir, "FORWARD_APP")
                .unwrap_or_else(|| FORWARD_APP.to_string()),
            forward_bundle: resolve_host_env_stack_value(rp_host_dir, "FORWARD_BUNDLE")
                .unwrap_or_else(|| FORWARD_BUNDLE.to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HostCommon {
    pub local_bin: PathBuf,
    pub aqua_sock: String,
}

impl HostCommon {
    fn tmux_aqua_bin(&self) -> PathBuf {
        self.local_bin.join("tmux-aqua")
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HostEnv {
    pub log_file: PathBuf,
    pub approve_trigger: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalContext {
    pub os: Os,
    pub identity: AppIdentity,
    pub common: HostCommon,
    pub host_env: HostEnv,
    pub home: PathBuf,
    pub rp_host_dir: PathBuf,
    pub status_file: PathBuf,
    pub tmux_env: Option<String>,
    pub poll_interval: Duration,
}

impl LocalContext {
    pub(crate) fn load() -> LocalContext {
        let rp_host_dir = default_rp_host_dir();
        let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
        let client_env_path = config::default_client_env_path().ok();
        let status_file = client_env_path
            .as_deref()
            .map(status::status_file_path)
            .unwrap_or_else(|| rp_host_dir.join("logs").join("status.json"));

        LocalContext {
            os: Os::current(),
            identity: AppIdentity::load(&rp_host_dir),
            common: load_host_common(&rp_host_dir, &home),
            host_env: load_host_env(&rp_host_dir),
            home,
            rp_host_dir,
            status_file,
            tmux_env: non_empty_env("TMUX"),
            poll_interval: Duration::from_millis(500),
        }
    }
}

pub fn run(args: &[String]) -> ExitCode {
    let context = LocalContext::load();
    let mut runtime = RealRuntime;
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();

    run_with_context(args, &context, &mut runtime, &mut stdout, &mut stderr)
}

pub(crate) fn run_with_context<R, W, E>(
    _args: &[String],
    context: &LocalContext,
    runtime: &mut R,
    out: &mut W,
    err: &mut E,
) -> ExitCode
where
    R: LocalRuntime,
    W: Write + ?Sized,
    E: Write + ?Sized,
{
    if host_up(context, runtime) {
        let _ = writeln!(out, "host server OK ({})", context.common.aqua_sock);
        return ExitCode::SUCCESS;
    }

    if context.os != Os::Mac {
        let _ = writeln!(err, "the host app runs on the mac host; start it there.");
        return ExitCode::from(2);
    }

    if !app_installed(context, runtime) && app_pid(context, runtime).is_none() {
        let _ = write_need_app_guidance(err, &context.identity.app_name);
        return ExitCode::from(1);
    }

    let _ = writeln!(
        out,
        "host server not running → starting {} ...",
        context.identity.app_name
    );
    start_host_app(context, runtime);

    for _ in 0..12 {
        if host_up(context, runtime) {
            let _ = writeln!(out, "host server OK");
            return ExitCode::SUCCESS;
        }
        runtime.sleep(context.poll_interval);
    }

    let _ = writeln!(
        err,
        "host server failed to start — check System Settings permissions / app install"
    );
    ExitCode::from(13)
}

pub(crate) fn app_available<R: LocalRuntime>(context: &LocalContext, runtime: &mut R) -> bool {
    app_installed(context, runtime)
        || app_pid(context, runtime).is_some()
        || runtime.is_file(&context.status_file)
        || (in_host_session(context) && host_up(context, runtime))
}

pub(crate) fn write_need_app_guidance<W: Write + ?Sized>(
    err: &mut W,
    app_name: &str,
) -> io::Result<()> {
    let repo = non_empty_env("GH_REPO").unwrap_or_else(|| "x10lab/xpair".to_string());
    writeln!(
        err,
        "this command needs the {app_name} app (the privileged daemon) — set up the HOST Mac:"
    )?;
    writeln!(
        err,
        "   • One-shot host setup (app daemon + approve rules + skills + CLI):"
    )?;
    writeln!(
        err,
        "       curl -fsSL https://raw.githubusercontent.com/{repo}/main/shared/bootstrap.sh | ROLE=host bash"
    )?;
    writeln!(
        err,
        "   • App binary only: {app_name}.zip from Releases → ~/Applications → open once (daemon only;"
    )?;
    writeln!(
        err,
        "     run the host setup above for approve rules + the approve skill)."
    )?;
    writeln!(err, "       https://github.com/{repo}/releases/latest")?;
    writeln!(
        err,
        "   Then grant Accessibility, Screen Recording, Full Disk Access (Privacy & Security) + File Sharing (General → Sharing). Verify with: xpair status"
    )?;
    writeln!(
        err,
        "   (This client/CLI maps/launches/attaches; approve & host run where the app lives.)"
    )
}

pub(crate) fn host_up<R: LocalRuntime>(context: &LocalContext, runtime: &mut R) -> bool {
    let tmux_aqua = context.common.tmux_aqua_bin();
    if !runtime.is_executable(&tmux_aqua) {
        return false;
    }

    let command = CommandSpec::new(
        path_string(&tmux_aqua),
        vec![
            "-S".to_string(),
            context.common.aqua_sock.clone(),
            "has-session".to_string(),
        ],
    );
    runtime
        .status(&command)
        .map(|code| code == 0)
        .unwrap_or(false)
}

fn start_host_app<R: LocalRuntime>(context: &LocalContext, runtime: &mut R) {
    if command_success(
        runtime,
        CommandSpec::new(
            "open",
            vec!["-a".to_string(), context.identity.app_name.clone()],
        ),
    ) {
        return;
    }
    if command_success(
        runtime,
        CommandSpec::new(
            "open",
            vec!["-a".to_string(), context.identity.forward_app.clone()],
        ),
    ) {
        return;
    }
    let Some(uid) = launchctl_uid(runtime) else {
        return;
    };

    let current_label = format!("gui/{uid}/{}", context.identity.bundle_prefix);
    if command_success(
        runtime,
        CommandSpec::new(
            "launchctl",
            vec!["kickstart".to_string(), "-k".to_string(), current_label],
        ),
    ) {
        return;
    }
    let forward_label = format!("gui/{uid}/{}", context.identity.forward_bundle);
    let _ = command_success(
        runtime,
        CommandSpec::new(
            "launchctl",
            vec!["kickstart".to_string(), "-k".to_string(), forward_label],
        ),
    );
}

fn launchctl_uid<R: LocalRuntime>(runtime: &mut R) -> Option<String> {
    let output = runtime
        .output(&CommandSpec::new("id", vec!["-u".to_string()]))
        .ok()?;
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && line.chars().all(|ch| ch.is_ascii_digit()))
        .map(str::to_string)
}

fn command_success<R: LocalRuntime>(runtime: &mut R, command: CommandSpec) -> bool {
    runtime
        .status(&command)
        .map(|code| code == 0)
        .unwrap_or(false)
}

fn app_installed<R: LocalRuntime>(context: &LocalContext, runtime: &R) -> bool {
    for base in [
        PathBuf::from("/Applications"),
        context.home.join("Applications"),
    ] {
        if runtime.is_dir(&base.join(format!("{}.app", context.identity.app_name)))
            || runtime.is_dir(&base.join(format!("{}.app", context.identity.forward_app)))
        {
            return true;
        }
    }
    false
}

fn app_pid<R: LocalRuntime>(context: &LocalContext, runtime: &mut R) -> Option<String> {
    let launchctl = CommandSpec::new("launchctl", vec!["list".to_string()]);
    if let Ok(output) = runtime.output(&launchctl) {
        if let Some(pid) = parse_launchctl_pid(
            &output,
            &context.identity.bundle_prefix,
            &context.identity.forward_bundle,
        ) {
            return Some(pid);
        }
    }

    let current_pattern = format!(
        "{}.app/Contents/MacOS/{}",
        context.identity.app_name, context.identity.app_name
    );
    if let Some(pid) = first_pgrep_match(runtime, &current_pattern) {
        return Some(pid);
    }

    let forward_pattern = format!(
        "{}.app/Contents/MacOS/{}",
        context.identity.forward_app, context.identity.forward_app
    );
    first_pgrep_match(runtime, &forward_pattern)
}

fn first_pgrep_match<R: LocalRuntime>(runtime: &mut R, pattern: &str) -> Option<String> {
    let command = CommandSpec::new("pgrep", vec!["-f".to_string(), pattern.to_string()]);
    let output = runtime.output(&command).ok()?;
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn parse_launchctl_pid(output: &str, bundle_prefix: &str, forward_bundle: &str) -> Option<String> {
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let pid = parts.next()?;
        let _status = parts.next()?;
        let label = parts.next()?;
        if (label == bundle_prefix || label == forward_bundle)
            && pid.chars().all(|ch| ch.is_ascii_digit())
        {
            return Some(pid.to_string());
        }
    }
    None
}

fn in_host_session(context: &LocalContext) -> bool {
    context
        .tmux_env
        .as_deref()
        .is_some_and(|tmux| tmux.contains("aqua-tmux.sock"))
}

fn load_host_common(rp_host_dir: &Path, home: &Path) -> HostCommon {
    let common_env = rp_host_dir.join("common.env");
    let default_local_bin = home.join(".local").join("bin");
    HostCommon {
        local_bin: config::get(&common_env, "LOCAL_BIN")
            .ok()
            .flatten()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_local_bin),
        aqua_sock: non_empty_env("AQUA_SOCK")
            .or_else(|| {
                config::get(&common_env, "AQUA_SOCK")
                    .ok()
                    .flatten()
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_else(|| DEFAULT_AQUA_SOCK.to_string()),
    }
}

fn load_host_env(rp_host_dir: &Path) -> HostEnv {
    let host_env = rp_host_dir.join("host.env");
    HostEnv {
        log_file: config::get(&host_env, "LOG_FILE")
            .ok()
            .flatten()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| rp_host_dir.join("logs").join("xpair.log")),
        approve_trigger: config::get(&host_env, "APPROVE_TRIGGER")
            .ok()
            .flatten()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_APPROVE_TRIGGER)),
    }
}

fn resolve_host_env_stack_value(rp_host_dir: &Path, key: &str) -> Option<String> {
    non_empty_env(key).or_else(|| {
        config::get(rp_host_dir.join("host.env"), key)
            .ok()
            .flatten()
            .filter(|value| !value.is_empty())
    })
}

fn default_rp_host_dir() -> PathBuf {
    config::default_rp_dir()
        .ok()
        .or_else(|| home_dir().map(|home| home.join(".xpair").join("host")))
        .unwrap_or_else(|| PathBuf::from("."))
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

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

struct RealRuntime;

impl LocalRuntime for RealRuntime {
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn is_executable(&self, path: &Path) -> bool {
        executable_file(path)
    }

    fn status(&mut self, command: &CommandSpec) -> io::Result<i32> {
        let status = Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        Ok(status.code().unwrap_or(1))
    }

    fn output(&mut self, command: &CommandSpec) -> io::Result<String> {
        let output = Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()?;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "xpair-host-test-{}-{id}-{name}",
                std::process::id()
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

    #[derive(Default)]
    struct MockRuntime {
        dirs: Vec<PathBuf>,
        files: Vec<PathBuf>,
        executables: Vec<PathBuf>,
        status_codes: VecDeque<i32>,
        outputs: VecDeque<String>,
        calls: Vec<CommandSpec>,
        sleeps: usize,
    }

    impl LocalRuntime for MockRuntime {
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.iter().any(|dir| dir == path)
        }

        fn is_file(&self, path: &Path) -> bool {
            self.files.iter().any(|file| file == path)
        }

        fn is_executable(&self, path: &Path) -> bool {
            self.executables.iter().any(|file| file == path)
        }

        fn status(&mut self, command: &CommandSpec) -> io::Result<i32> {
            self.calls.push(command.clone());
            Ok(self.status_codes.pop_front().unwrap_or(1))
        }

        fn output(&mut self, command: &CommandSpec) -> io::Result<String> {
            self.calls.push(command.clone());
            Ok(self.outputs.pop_front().unwrap_or_default())
        }

        fn sleep(&mut self, _duration: Duration) {
            self.sleeps += 1;
        }
    }

    fn context(tmp: &TestDir, os: Os) -> LocalContext {
        LocalContext {
            os,
            identity: AppIdentity {
                app_name: "XpairHost".to_string(),
                bundle_prefix: "com.x10lab.xpair-host".to_string(),
                forward_app: "Xpair".to_string(),
                forward_bundle: "com.x10lab.xpair".to_string(),
            },
            common: HostCommon {
                local_bin: tmp.path.join("bin"),
                aqua_sock: "/tmp/aqua-tmux.sock".to_string(),
            },
            host_env: HostEnv {
                log_file: tmp.path.join("logs").join("xpair.log"),
                approve_trigger: tmp.path.join("approve"),
            },
            home: tmp.path.join("home"),
            rp_host_dir: tmp.path.join(".xpair").join("host"),
            status_file: tmp.path.join("logs").join("status.json"),
            tmux_env: None,
            poll_interval: Duration::from_millis(0),
        }
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    struct EnvGuard {
        key: &'static str,
        old: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> EnvGuard {
            let old = std::env::var(key).ok();
            std::env::set_var(key, value);
            EnvGuard { key, old }
        }

        fn unset(key: &'static str) -> EnvGuard {
            let old = std::env::var(key).ok();
            std::env::remove_var(key);
            EnvGuard { key, old }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(old) = &self.old {
                std::env::set_var(self.key, old);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn probe_up_short_circuits() {
        let tmp = TestDir::new("up");
        let context = context(&tmp, Os::Mac);
        let mut runtime = MockRuntime::default();
        runtime.executables.push(context.common.tmux_aqua_bin());
        runtime.status_codes.push_back(0);
        let mut out = Vec::new();
        let mut err = Vec::new();

        let code = run_with_context(&[], &context, &mut runtime, &mut out, &mut err);

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "host server OK (/tmp/aqua-tmux.sock)\n"
        );
        assert_eq!(String::from_utf8(err).unwrap(), "");
        assert_eq!(runtime.calls.len(), 1);
        assert_eq!(
            runtime.calls[0],
            CommandSpec::new(
                path_string(&context.common.tmux_aqua_bin()),
                strings(&["-S", "/tmp/aqua-tmux.sock", "has-session"])
            )
        );
    }

    #[test]
    fn missing_app_guides_on_macos() {
        let tmp = TestDir::new("missing-app");
        let context = context(&tmp, Os::Mac);
        let mut runtime = MockRuntime::default();
        runtime.outputs.push_back(String::new());
        runtime.outputs.push_back(String::new());
        runtime.outputs.push_back(String::new());
        let mut out = Vec::new();
        let mut err = Vec::new();

        let code = run_with_context(&[], &context, &mut runtime, &mut out, &mut err);

        assert_eq!(code, ExitCode::from(1));
        assert_eq!(String::from_utf8(out).unwrap(), "");
        let err = String::from_utf8(err).unwrap();
        assert!(err.contains("this command needs the XpairHost app"));
        assert!(runtime.calls.iter().all(|call| {
            call.program != "open"
                && !(call.program == "launchctl"
                    && call.args.first().is_some_and(|arg| arg == "kickstart"))
        }));
    }

    #[test]
    fn windows_gate_after_probe_miss() {
        let tmp = TestDir::new("windows");
        let context = context(&tmp, Os::Windows);
        let mut runtime = MockRuntime::default();
        let mut out = Vec::new();
        let mut err = Vec::new();

        let code = run_with_context(&[], &context, &mut runtime, &mut out, &mut err);

        assert_eq!(code, ExitCode::from(2));
        assert_eq!(String::from_utf8(out).unwrap(), "");
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "the host app runs on the mac host; start it there.\n"
        );
        assert!(runtime.calls.is_empty());
    }

    #[test]
    fn macos_start_tries_current_open_first() {
        let tmp = TestDir::new("start-current");
        let context = context(&tmp, Os::Mac);
        let mut runtime = MockRuntime::default();
        runtime.executables.push(context.common.tmux_aqua_bin());
        runtime
            .dirs
            .push(context.home.join("Applications").join("XpairHost.app"));
        runtime.status_codes.push_back(1);
        runtime.status_codes.push_back(0);
        for _ in 0..12 {
            runtime.status_codes.push_back(1);
        }
        let mut out = Vec::new();
        let mut err = Vec::new();

        let code = run_with_context(&[], &context, &mut runtime, &mut out, &mut err);

        assert_eq!(code, ExitCode::from(13));
        assert_eq!(
            runtime.calls[1],
            CommandSpec::new("open", strings(&["-a", "XpairHost"]))
        );
        assert!(runtime
            .calls
            .iter()
            .all(|call| call.args != strings(&["-a", "Xpair"])));
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("host server not running → starting XpairHost ..."));
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("host server failed to start"));
    }

    #[test]
    fn macos_start_falls_back_to_launchctl_labels() {
        let tmp = TestDir::new("fallbacks");
        let context = context(&tmp, Os::Mac);
        let mut runtime = MockRuntime::default();
        runtime.executables.push(context.common.tmux_aqua_bin());
        runtime
            .dirs
            .push(context.home.join("Applications").join("XpairHost.app"));
        runtime.status_codes.push_back(1);
        runtime.status_codes.push_back(1);
        runtime.status_codes.push_back(1);
        runtime.status_codes.push_back(1);
        runtime.status_codes.push_back(0);
        runtime.status_codes.push_back(0);
        runtime.outputs.push_back("501\n".to_string());
        let mut out = Vec::new();
        let mut err = Vec::new();

        let code = run_with_context(&[], &context, &mut runtime, &mut out, &mut err);

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            runtime.calls[1],
            CommandSpec::new("open", strings(&["-a", "XpairHost"]))
        );
        assert_eq!(
            runtime.calls[2],
            CommandSpec::new("open", strings(&["-a", "Xpair"]))
        );
        assert_eq!(runtime.calls[3], CommandSpec::new("id", strings(&["-u"])));
        assert_eq!(
            runtime.calls[4],
            CommandSpec::new(
                "launchctl",
                strings(&["kickstart", "-k", "gui/501/com.x10lab.xpair-host"])
            )
        );
        assert!(String::from_utf8(out).unwrap().contains("host server OK\n"));
        assert_eq!(String::from_utf8(err).unwrap(), "");
    }

    #[test]
    fn app_available_accepts_forward_app_in_home_applications() {
        let tmp = TestDir::new("forward-app");
        let context = context(&tmp, Os::Mac);
        let mut runtime = MockRuntime::default();
        runtime
            .dirs
            .push(context.home.join("Applications").join("Xpair.app"));

        assert!(app_available(&context, &mut runtime));
        assert!(runtime.calls.is_empty());
    }

    #[test]
    fn app_pid_uses_launchctl_before_pgrep() {
        let tmp = TestDir::new("pid");
        let context = context(&tmp, Os::Mac);
        let mut runtime = MockRuntime::default();
        runtime
            .outputs
            .push_back("7777\t0\tcom.x10lab.xpair-host\n".to_string());

        assert_eq!(app_pid(&context, &mut runtime), Some("7777".to_string()));
        assert_eq!(runtime.calls.len(), 1);
        assert_eq!(
            runtime.calls[0],
            CommandSpec::new("launchctl", strings(&["list"]))
        );
    }

    #[test]
    fn host_common_prefers_aqua_sock_env_over_common_env() {
        let _guard = EnvGuard::set("AQUA_SOCK", "/tmp/env-aqua.sock");
        let tmp = TestDir::new("aqua-env");
        let rp_host_dir = tmp.path.join("host");
        fs::create_dir_all(&rp_host_dir).unwrap();
        fs::write(
            rp_host_dir.join("common.env"),
            "AQUA_SOCK=/tmp/file-aqua.sock\n",
        )
        .unwrap();

        let common = load_host_common(&rp_host_dir, &tmp.path.join("home"));

        assert_eq!(common.aqua_sock, "/tmp/env-aqua.sock");
    }

    #[test]
    fn app_identity_loads_from_process_env_then_host_env_stack() {
        let _app_guard = EnvGuard::set("APP_NAME", "EnvHost");
        let _bundle_guard = EnvGuard::unset("BUNDLE_PREFIX");
        let _forward_app_guard = EnvGuard::unset("FORWARD_APP");
        let _forward_bundle_guard = EnvGuard::unset("FORWARD_BUNDLE");
        let tmp = TestDir::new("identity-env-stack");
        let rp_host_dir = tmp.path.join("host");
        fs::create_dir_all(&rp_host_dir).unwrap();
        fs::write(
            rp_host_dir.join("common.env"),
            "APP_NAME=CommonHost\nBUNDLE_PREFIX=com.example.common\nFORWARD_APP=CommonForward\nFORWARD_BUNDLE=com.example.common-forward\n",
        )
        .unwrap();
        fs::write(
            rp_host_dir.join("host.env"),
            "APP_NAME=FileHost\nBUNDLE_PREFIX=com.example.host\nFORWARD_APP=FileForward\nFORWARD_BUNDLE=com.example.forward\n",
        )
        .unwrap();

        let identity = AppIdentity::load(&rp_host_dir);

        assert_eq!(identity.app_name, "EnvHost");
        assert_eq!(identity.bundle_prefix, "com.example.host");
        assert_eq!(identity.forward_app, "FileForward");
        assert_eq!(identity.forward_bundle, "com.example.forward");
    }
}
