//! `xpair approve` trigger + router-log observer.
//!
//! Ports the machine-local bash flow: write the hint/type sidecar files, touch the approve
//! trigger, then print only this request's `router:` trail until success or timeout.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use crate::host::{self, LocalContext, LocalRuntime};
use crate::platform::Os;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ApproveOptions {
    hint: String,
    approve_type: String,
    timeout_secs: u64,
}

impl Default for ApproveOptions {
    fn default() -> Self {
        Self {
            hint: String::new(),
            approve_type: String::new(),
            timeout_secs: 22,
        }
    }
}

pub fn run(args: &[String]) -> ExitCode {
    let context = LocalContext::load();
    let mut runtime = Runtime;
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();

    run_with_context(args, &context, &mut runtime, &mut stdout, &mut stderr)
}

pub(crate) fn run_with_context<R, W, E>(
    args: &[String],
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
    let opts = match parse_args(args) {
        Ok(opts) => opts,
        Err(message) => {
            let _ = writeln!(err, "{message}");
            return ExitCode::from(2);
        }
    };

    if context.os != Os::Mac {
        let _ = writeln!(
            err,
            "approve requires the privileged macOS host app; run it on the Mac host."
        );
        return ExitCode::from(2);
    }

    if !host::app_available(context, runtime) {
        let _ = host::write_need_app_guidance(err, &context.identity.app_name);
        return ExitCode::from(1);
    }

    match run_approve_request(&opts, context, runtime, out, err) {
        Ok(code) => code,
        Err(error) => {
            let _ = writeln!(err, "{error}");
            ExitCode::from(1)
        }
    }
}

fn parse_args(args: &[String]) -> Result<ApproveOptions, String> {
    let mut opts = ApproveOptions::default();
    let mut idx = 0;
    while idx < args.len() {
        match args[idx].as_str() {
            "--for" | "--label" | "--expect" => {
                opts.hint = args.get(idx + 1).cloned().unwrap_or_default();
                idx += 2;
            }
            "--type" => {
                opts.approve_type = args.get(idx + 1).cloned().unwrap_or_default();
                idx += 2;
            }
            "--timeout" => {
                opts.timeout_secs = args
                    .get(idx + 1)
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(22);
                idx += 2;
            }
            other => return Err(format!("unknown arg: {other}")),
        }
    }
    Ok(opts)
}

fn run_approve_request<R, W, E>(
    opts: &ApproveOptions,
    context: &LocalContext,
    runtime: &mut R,
    out: &mut W,
    err: &mut E,
) -> io::Result<ExitCode>
where
    R: LocalRuntime,
    W: Write + ?Sized,
    E: Write + ?Sized,
{
    let router_log = &context.host_env.log_file;
    let approve_trigger = &context.host_env.approve_trigger;
    let base0 = line_count(router_log);
    let mut base = base0;

    write_or_remove(&suffix_path(approve_trigger, ".label"), &opts.hint);
    write_or_remove(&suffix_path(approve_trigger, ".type"), &opts.approve_type);
    if let Err(error) = File::create(approve_trigger) {
        let _ = writeln!(
            err,
            "failed to write trigger: {}",
            approve_trigger.display()
        );
        return Err(error);
    }

    let expect = if opts.hint.is_empty() {
        String::new()
    } else {
        format!(" (expect: {})", opts.hint)
    };
    writeln!(
        out,
        "approve request → {}{} (observing up to {}s)",
        context.identity.app_name, expect, opts.timeout_secs
    )?;

    let deadline = Instant::now() + Duration::from_secs(opts.timeout_secs);
    while Instant::now() < deadline {
        let lines = read_lines(router_log);
        let now = lines.len();
        if now > base {
            if lines_since(&lines, base)
                .iter()
                .any(|line| router_success(line))
            {
                for line in router_trail_from_lines(&lines, base0) {
                    writeln!(out, "  {line}")?;
                }
                writeln!(out, "✓ handled (window-close verified)")?;
                return Ok(ExitCode::SUCCESS);
            }
            base = now;
        }
        runtime.sleep(context.poll_interval);
    }

    writeln!(
        err,
        "✗ not handled within {}s — router log:",
        opts.timeout_secs
    )?;
    let trail = router_trail(router_log, base0);
    if trail.is_empty() {
        writeln!(
            err,
            "  (no router log — check app/permissions/trigger. full: {})",
            router_log.display()
        )?;
    } else {
        for line in trail {
            writeln!(err, "  {line}")?;
        }
    }
    writeln!(
        err,
        "  → If the window appears late: re-trigger non-blocking, then immediately retry the blocked call. For an unknown window, add a rule to {}/rules.txt.",
        context.rp_host_dir.display()
    )?;
    Ok(ExitCode::from(1))
}

fn write_or_remove(path: &Path, value: &str) {
    if value.is_empty() {
        let _ = fs::remove_file(path);
    } else {
        let _ = fs::write(path, format!("{value}\n"));
    }
}

fn suffix_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn line_count(path: &Path) -> usize {
    read_lines(path).len()
}

fn read_lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .map(|text| text.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn lines_since(lines: &[String], base: usize) -> &[String] {
    if base >= lines.len() {
        &[]
    } else {
        &lines[base..]
    }
}

fn router_trail(path: &Path, base0: usize) -> Vec<String> {
    let lines = read_lines(path);
    router_trail_from_lines(&lines, base0)
}

fn router_trail_from_lines(lines: &[String], base0: usize) -> Vec<String> {
    lines_since(lines, base0)
        .iter()
        .filter(|line| line.contains("router:"))
        .cloned()
        .collect()
}

fn router_success(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower
        .find("router:")
        .is_some_and(|start| lower[start..].contains("success"))
}

struct Runtime;

impl LocalRuntime for Runtime {
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn is_executable(&self, path: &Path) -> bool {
        executable_file(path)
    }

    fn status(&mut self, command: &host::CommandSpec) -> io::Result<i32> {
        let status = std::process::Command::new(&command.program)
            .args(&command.args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        Ok(status.code().unwrap_or(1))
    }

    fn output(&mut self, command: &host::CommandSpec) -> io::Result<String> {
        let output = std::process::Command::new(&command.program)
            .args(&command.args)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
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
    use crate::host::{AppIdentity, CommandSpec, HostCommon, HostEnv};
    use std::fs::{self, OpenOptions};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "xpair-approve-test-{}-{id}-{name}",
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

    struct TestRuntime;

    impl LocalRuntime for TestRuntime {
        fn is_dir(&self, path: &Path) -> bool {
            path.is_dir()
        }

        fn is_file(&self, path: &Path) -> bool {
            path.is_file()
        }

        fn is_executable(&self, _path: &Path) -> bool {
            false
        }

        fn status(&mut self, _command: &CommandSpec) -> io::Result<i32> {
            Ok(1)
        }

        fn output(&mut self, _command: &CommandSpec) -> io::Result<String> {
            Ok(String::new())
        }

        fn sleep(&mut self, duration: Duration) {
            std::thread::sleep(duration);
        }
    }

    fn context(tmp: &TestDir, os: Os) -> LocalContext {
        let home = tmp.path.join("home");
        let log_dir = tmp.path.join("logs");
        fs::create_dir_all(home.join("Applications").join("XpairHost.app")).unwrap();
        fs::create_dir_all(&log_dir).unwrap();
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
                log_file: log_dir.join("xpair.log"),
                approve_trigger: tmp.path.join("xpair.approve-request"),
            },
            home,
            rp_host_dir: tmp.path.join(".xpair").join("host"),
            status_file: log_dir.join("status.json"),
            tmux_env: None,
            poll_interval: Duration::from_millis(10),
        }
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    #[test]
    fn parse_alias_flags_and_defaults() {
        assert_eq!(
            parse_args(&strings(&[
                "--label",
                "1Password",
                "--type",
                "key:return",
                "--timeout",
                "3"
            ]))
            .unwrap(),
            ApproveOptions {
                hint: "1Password".to_string(),
                approve_type: "key:return".to_string(),
                timeout_secs: 3,
            }
        );
        assert_eq!(parse_args(&[]).unwrap(), ApproveOptions::default());
        assert_eq!(
            parse_args(&strings(&["--bad"])).unwrap_err(),
            "unknown arg: --bad"
        );
    }

    #[test]
    fn trigger_files_and_successful_router_trail() {
        let tmp = TestDir::new("success");
        let context = context(&tmp, Os::Mac);
        fs::write(&context.host_env.log_file, "old\n").unwrap();
        let log_path = context.host_env.log_file.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            let mut file = OpenOptions::new()
                .append(true)
                .create(true)
                .open(log_path)
                .unwrap();
            writeln!(file, "router: trying ocr").unwrap();
            writeln!(file, "router: success close verified").unwrap();
        });
        let mut runtime = TestRuntime;
        let mut out = Vec::new();
        let mut err = Vec::new();

        let code = run_with_context(
            &strings(&[
                "--for",
                "1Password",
                "--type",
                "key:return",
                "--timeout",
                "1",
            ]),
            &context,
            &mut runtime,
            &mut out,
            &mut err,
        );

        handle.join().unwrap();
        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            fs::read_to_string(suffix_path(&context.host_env.approve_trigger, ".label")).unwrap(),
            "1Password\n"
        );
        assert_eq!(
            fs::read_to_string(suffix_path(&context.host_env.approve_trigger, ".type")).unwrap(),
            "key:return\n"
        );
        assert!(context.host_env.approve_trigger.exists());
        let out = String::from_utf8(out).unwrap();
        assert!(
            out.contains("approve request → XpairHost (expect: 1Password) (observing up to 1s)")
        );
        assert!(out.contains("  router: trying ocr\n"));
        assert!(out.contains("  router: success close verified\n"));
        assert!(out.contains("✓ handled (window-close verified)\n"));
        assert_eq!(String::from_utf8(err).unwrap(), "");
    }

    #[test]
    fn timeout_prints_router_guidance() {
        let tmp = TestDir::new("timeout");
        let mut context = context(&tmp, Os::Mac);
        context.poll_interval = Duration::from_millis(0);
        let mut runtime = TestRuntime;
        let mut out = Vec::new();
        let mut err = Vec::new();

        let code = run_with_context(
            &strings(&["--timeout", "0"]),
            &context,
            &mut runtime,
            &mut out,
            &mut err,
        );

        assert_eq!(code, ExitCode::from(1));
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "approve request → XpairHost (observing up to 0s)\n"
        );
        let err = String::from_utf8(err).unwrap();
        assert!(err.contains("✗ not handled within 0s — router log:"));
        assert!(err.contains("(no router log — check app/permissions/trigger."));
        assert!(err.contains("add a rule to"));
    }

    #[test]
    fn windows_gate_exits_two() {
        let tmp = TestDir::new("windows");
        let context = context(&tmp, Os::Windows);
        let mut runtime = TestRuntime;
        let mut out = Vec::new();
        let mut err = Vec::new();

        let code = run_with_context(&[], &context, &mut runtime, &mut out, &mut err);

        assert_eq!(code, ExitCode::from(2));
        assert_eq!(String::from_utf8(out).unwrap(), "");
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "approve requires the privileged macOS host app; run it on the Mac host.\n"
        );
    }
}
