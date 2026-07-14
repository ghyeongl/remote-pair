//! Launch a folder into a tmux-aqua session.
//!
//! Ports the decision layer of `cmd_launch()` from `client/cli/xpair:885-960`
//! plus the portable remote session construction from `client/cli/xpair-launch`.
//! The host-probe onboarding branch (`client/cli/xpair:919-953`) remains deferred.
//! Local launch keeps the macOS-only process boundary small while the naming and
//! session-selection core stays pure and tested.

use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

pub use crate::attach::Target;
use crate::config;
use crate::mapping::{
    client_path_eq_for_os, client_path_eq_or_child_for_os, map_to_host_for_os,
    normalize_client_path_for_persistence, parse_maps,
};
use crate::platform::Os;
use crate::remote_quote;
use crate::respawn::{self, Engine};
use crate::session::{self, SshTransport};
use crate::transport::Transport;

const ENGINE_USAGE: &str = "claude|claudecode|shell|codex|opencode";
const REMOTE_BIN: &str = "$HOME/.local/bin";
const TMUX_AQUA: &str = "tmux-aqua";
const REMOTE_AGENT_PATH_EXPORT: &str =
    "export PATH=\"$HOME/.local/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"";
const DEFAULT_APP_NAME: &str = "XpairHost";
const DEFAULT_BUNDLE_PREFIX: &str = "com.x10lab.xpair-host";
const DEFAULT_FORWARD_APP: &str = "Xpair";
const DEFAULT_FORWARD_BUNDLE: &str = "com.x10lab.xpair";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchReq {
    pub target_pref: Option<Target>,
    pub fresh: bool,
    pub yes: bool,
    pub engine: Option<String>,
    pub dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalLaunchPlan {
    pub session: String,
    pub create: bool,
    pub cont: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppIdentity {
    app_name: String,
    bundle_prefix: String,
    forward_app: String,
    forward_bundle: String,
}

impl Default for AppIdentity {
    fn default() -> Self {
        Self {
            app_name: DEFAULT_APP_NAME.to_string(),
            bundle_prefix: DEFAULT_BUNDLE_PREFIX.to_string(),
            forward_app: DEFAULT_FORWARD_APP.to_string(),
            forward_bundle: DEFAULT_FORWARD_BUNDLE.to_string(),
        }
    }
}

/// Parse `xpair launch` args with the bash exit-code contract.
pub fn parse_launch_args(args: &[String]) -> Result<LaunchReq, (String, u8)> {
    let target_pref = None;
    let mut fresh = false;
    let mut yes = false;
    let mut engine = None;
    let mut dir = None;
    let mut i = 0;

    while i < args.len() {
        match args[i].as_str() {
            "--fresh" => {
                fresh = true;
                i += 1;
            }
            "--yes" | "-y" => {
                yes = true;
                i += 1;
            }
            "--engine" => {
                let raw = args.get(i + 1).map(String::as_str).unwrap_or("");
                let Some(canon) = canonical_engine(raw) else {
                    return Err((format!("unknown engine: {raw} (use {ENGINE_USAGE})"), 2));
                };
                engine = Some(canon);
                i += 2;
            }
            opt if opt.starts_with("--") => {
                return Err((format!("unknown launch option: {opt}"), 2));
            }
            _ => {
                dir = Some(args[i].clone());
                i += 1;
            }
        }
    }

    Ok(LaunchReq {
        target_pref,
        fresh,
        yes,
        engine,
        dir: dir.unwrap_or_else(|| ".".to_string()),
    })
}

/// Canonicalize the launch engine aliases from `client/cli/xpair:158-164`.
pub fn canonical_engine(engine: &str) -> Option<String> {
    match engine {
        "claude" | "claudecode" | "claude-code" => Some("claude".to_string()),
        "shell" => Some("shell".to_string()),
        "codex" => Some("codex".to_string()),
        "opencode" => Some("opencode".to_string()),
        _ => None,
    }
}

/// Resolve the launch target. Current bash launch is a single configured-host path.
pub fn resolve_target(pref: Option<Target>, local_mode: bool, host: &str) -> Target {
    crate::attach::resolve_target(pref, local_mode, host)
}

/// Derive the deterministic project session base from a mapped host dir.
///
/// Mirrors `_proj_base()` and the final `.`/`:` normalization from
/// `client/cli/xpair-launch:341-360`, with the remote host prefix added by
/// [`remote_session_name_for`] just like `REMOTE_PROJ` at
/// `client/cli/xpair-launch:504-509`.
pub fn session_name_for(host_dir: &str) -> String {
    normalize_session_name(&proj_base(host_dir))
}

/// Runtime variant of [`session_name_for`] that mirrors the bash `_readable` pipeline for
/// non-ASCII basenames without invoking network-backed translation.
fn session_name_for_local_tools(host_dir: &str) -> String {
    normalize_session_name(&proj_base_with_exec(host_dir, &RealNameExec))
}

/// Derive the default remote tmux session name for the mapped host dir.
///
/// The bash launcher computes `REMOTE_PROJ="${REMOTE_HOST}_$(_proj_base "$HOST_DIR")"`
/// and starts remote setup at `_1`. The host-side setup script may advance to a later
/// `_N` when `_1` already has attached clients.
pub fn remote_session_name_for(host: &str, host_dir: &str) -> String {
    format!("{}_1", remote_session_base_for(host, host_dir))
}

fn remote_session_name_for_local_tools(host: &str, host_dir: &str) -> String {
    format!(
        "{}_1",
        normalize_session_name(&format!(
            "{host}_{}",
            proj_base_with_exec(host_dir, &RealNameExec)
        ))
    )
}

fn remote_session_base_for(host: &str, host_dir: &str) -> String {
    normalize_session_name(&format!("{host}_{}", proj_base(host_dir)))
}

/// Derive the local tmux session base from the local host and project dir.
///
/// Bash computes `LOCAL_PROJ="${LOCAL_HOST}_$(_proj_base "$PROJECT_DIR")"`
/// and then normalizes `.`/`:` in `client/cli/xpair-launch:504-509`.
pub fn local_session_base_for(local_host: &str, project_dir: &str) -> String {
    normalize_session_name(&format!("{local_host}_{}", session_name_for(project_dir)))
}

fn local_session_base_for_local_tools(local_host: &str, project_dir: &str) -> String {
    normalize_session_name(&format!(
        "{local_host}_{}",
        session_name_for_local_tools(project_dir)
    ))
}

/// Choose the local tmux-aqua session using the launcher's `_local_next_n` policy.
///
/// Non-fresh launches skip only attached sessions, then reattach a detached winner or create
/// it. Fresh launches skip every existing session and create the first free `_N`.
pub fn pick_local_session(proj: &str, existing: &[(String, bool)], fresh: bool) -> LocalLaunchPlan {
    let mut n = 1usize;
    if fresh {
        while local_session_exists(existing, proj, n) {
            n += 1;
        }
        return LocalLaunchPlan {
            session: format!("{proj}_{n}"),
            create: true,
            cont: false,
        };
    }

    while local_session_attached(existing, proj, n) {
        n += 1;
    }

    LocalLaunchPlan {
        session: format!("{proj}_{n}"),
        create: !local_session_exists(existing, proj, n),
        cont: n == 1,
    }
}

/// Build the remote create-or-reuse command for a detached tmux-aqua session.
pub fn build_ensure_session_remote_cmd(
    aqua_sock: &str,
    session: &str,
    host_dir: &str,
    fresh: bool,
) -> String {
    build_ensure_session_remote_cmd_for_engine(
        Engine::Claude,
        aqua_sock,
        session,
        host_dir,
        fresh,
        !fresh,
    )
}

/// Build the remote create-or-reuse command with a real respawn body.
pub fn build_ensure_session_remote_cmd_for_engine(
    engine: Engine,
    aqua_sock: &str,
    session: &str,
    host_dir: &str,
    fresh: bool,
    cl_continue: bool,
) -> String {
    build_ensure_session_remote_cmd_for_engine_and_identity(
        engine,
        aqua_sock,
        session,
        host_dir,
        fresh,
        cl_continue,
        &AppIdentity::default(),
    )
}

fn build_ensure_session_remote_cmd_for_engine_and_identity(
    engine: Engine,
    aqua_sock: &str,
    session: &str,
    host_dir: &str,
    fresh: bool,
    cl_continue: bool,
    identity: &AppIdentity,
) -> String {
    let body = if let Some((base, n)) = split_numbered_session(session) {
        build_numbered_session_remote_cmd(engine, aqua_sock, &base, n, host_dir, fresh, cl_continue)
    } else {
        build_single_named_session_remote_cmd(
            engine,
            aqua_sock,
            session,
            host_dir,
            fresh,
            cl_continue,
        )
    };
    wrap_remote_setup_cmd(aqua_sock, engine, identity, &body)
}

/// Build the local argv for the remote SSH attach handoff.
pub fn build_remote_launch_attach_argv(
    os: Os,
    host: &str,
    aqua_sock: &str,
    session: &str,
) -> Vec<String> {
    crate::attach::build_remote_attach_argv(os, host, session, aqua_sock)
}

/// Build the local argv for the macOS tmux-aqua attach handoff.
pub fn build_local_launch_attach_argv(
    tmux_aqua_bin: &str,
    aqua_sock: &str,
    session: &str,
) -> Vec<String> {
    crate::attach::build_local_attach_argv(tmux_aqua_bin, aqua_sock, session)
}

/// Build the local tmux-aqua argv that creates a detached session with the respawn script.
pub fn build_local_new_session_argv(
    tmux_aqua_bin: &str,
    aqua_sock: &str,
    session: &str,
    dir: &str,
    respawn_path: &str,
) -> Vec<String> {
    vec![
        tmux_aqua_bin.to_string(),
        "-S".to_string(),
        aqua_sock.to_string(),
        "new-session".to_string(),
        "-d".to_string(),
        "-s".to_string(),
        session.to_string(),
        "-c".to_string(),
        dir.to_string(),
        format!("bash {respawn_path}"),
    ]
}

/// Ensure the remote session exists, preserving exact SSH payloads for MockTransport tests.
pub fn ensure_remote_session(
    transport: &dyn Transport,
    host: &str,
    aqua_sock: &str,
    session: &str,
    host_dir: &str,
    fresh: bool,
    engine: Engine,
) -> Result<String, String> {
    Ok(ensure_remote_session_info(
        transport,
        host,
        aqua_sock,
        session,
        host_dir,
        fresh,
        engine,
        &AppIdentity::default(),
    )?
    .session)
}

struct RemoteSessionInfo {
    session: String,
    remote_home: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn ensure_remote_session_info(
    transport: &dyn Transport,
    host: &str,
    aqua_sock: &str,
    session: &str,
    host_dir: &str,
    fresh: bool,
    engine: Engine,
    identity: &AppIdentity,
) -> Result<RemoteSessionInfo, String> {
    let remote_cmd = build_ensure_session_remote_cmd_for_engine_and_identity(
        engine, aqua_sock, session, host_dir, fresh, !fresh, identity,
    );
    let out = transport
        .ssh_exec(host, &remote_cmd)
        .map_err(|err| format!("remote launch setup failed: {err}"))?;

    if out.code == 0 {
        Ok(RemoteSessionInfo {
            session: extract_session_marker(&out.stdout).unwrap_or_else(|| session.to_string()),
            remote_home: extract_home_marker(&out.stdout),
        })
    } else if setup_output_without_markers(&out.stdout).is_empty() {
        Err(format!("remote launch setup failed (exit={})", out.code))
    } else {
        Err(format!(
            "remote launch setup failed (exit={})\n{}",
            out.code,
            setup_output_without_markers(&out.stdout)
        ))
    }
}

/// A launchable host: a configured remote (ssh) or THIS machine (local-direct tmux attach).
#[derive(Debug, Clone, PartialEq, Eq)]
enum HostChoice {
    Remote(String),
    Local,
}

/// Build the launchable host list: the configured REMOTE_HOST (if set) plus the local host when
/// XpairHost is installed here. ponytail: at most two entries — no LAN discovery.
fn build_host_choices(remote: &str, local_available: bool) -> Vec<HostChoice> {
    let mut choices = Vec::new();
    if !remote.trim().is_empty() {
        choices.push(HostChoice::Remote(remote.trim().to_string()));
    }
    if local_available {
        choices.push(HostChoice::Local);
    }
    choices
}

fn host_choice_label(choice: &HostChoice) -> String {
    match choice {
        HostChoice::Remote(host) => host.clone(),
        HostChoice::Local => "this Mac (local)".to_string(),
    }
}

/// Pick one host: 0 → error; 1 → auto-select (no prompt); >1 → numbered prompt on a tty, else error.
fn select_host_choice<R: BufRead, W: Write>(
    choices: Vec<HostChoice>,
    is_tty: bool,
    input: &mut R,
    out: &mut W,
) -> Result<HostChoice, (String, u8)> {
    match choices.len() {
        0 => Err((
            "no host configured — set one in Xpair.app or: xpair config set host <ssh-host>"
                .to_string(),
            1,
        )),
        1 => Ok(choices.into_iter().next().expect("len==1")),
        _ => {
            if !is_tty {
                return Err((
                    "multiple hosts available; run in a terminal to choose, or set REMOTE_HOST"
                        .to_string(),
                    1,
                ));
            }
            for (i, choice) in choices.iter().enumerate() {
                let _ = writeln!(out, "  {}) {}", i + 1, host_choice_label(choice));
            }
            let _ = write!(out, "select host [1-{}]: ", choices.len());
            let _ = out.flush();
            let mut line = String::new();
            input.read_line(&mut line).ok();
            match line
                .trim()
                .parse::<usize>()
                .ok()
                .filter(|n| *n >= 1 && *n <= choices.len())
            {
                Some(n) => Ok(choices.into_iter().nth(n - 1).expect("in range")),
                None => Err(("invalid selection".to_string(), 1)),
            }
        }
    }
}

/// Impure CLI entrypoint: resolve config, map the folder, ensure remote tmux, then attach.
pub fn run(args: &[String]) -> ExitCode {
    let req = match parse_launch_args(args) {
        Ok(req) => req,
        Err((msg, code)) => {
            eprintln!("{msg}");
            return ExitCode::from(code);
        }
    };

    let path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(2);
        }
    };
    let host = match resolve_host(&path) {
        Ok(host) => host,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    let local_mode = match resolve_local_mode(&path) {
        Ok(local_mode) => local_mode,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };

    // Host-list picker: configured REMOTE_HOST + the local host (when XpairHost is installed here).
    // Single entry auto-selects; >1 prompts on a tty. Folder-first is preserved — the chosen host's
    // run_local/run_remote handles the dir/mapping exactly as before.
    let local_available = local_host_role_expected(&host);
    // Self-host: if the configured remote IS this Mac, prefer the local-direct entry and drop the remote
    // one — never offer ssh-to-self (which would reintroduce the loopback auth path this change removes,
    // and would make the non-tty picker fail on two entries that are the same machine).
    let remote = if local_available && remote_is_local(&host) {
        ""
    } else {
        host.as_str()
    };
    let choices = build_host_choices(remote, local_available);
    let is_tty = std::io::stdin().is_terminal();
    let mut input = std::io::stdin().lock();
    let mut err = std::io::stderr();
    let choice = match select_host_choice(choices, is_tty, &mut input, &mut err) {
        Ok(choice) => choice,
        Err((msg, code)) => {
            eprintln!("{msg}");
            return ExitCode::from(code);
        }
    };
    match choice {
        // Local host → DIRECT tmux-aqua attach (no ssh, no auth). resolve_target stays as-is; we route
        // here explicitly. run_local keeper-guards below.
        HostChoice::Local => run_local(&path, &host, &req),
        HostChoice::Remote(remote) => run_remote(&path, &remote, local_mode, &req),
    }
}

fn run_local(path: &Path, host: &str, req: &LaunchReq) -> ExitCode {
    if Os::current() != Os::Mac {
        eprintln!("local launch is only available on a macOS host (use --remote)");
        return ExitCode::from(2);
    }
    run_local_macos(path, host, req)
}

fn run_local_macos(path: &Path, _host: &str, req: &LaunchReq) -> ExitCode {
    let dir = match absolutize_existing_dir(&req.dir) {
        Ok(dir) => dir,
        Err(_) => {
            eprintln!("folder not found");
            return ExitCode::from(1);
        }
    };
    let project_dir = dir.to_string_lossy().into_owned();
    let local_host = match short_hostname() {
        Ok(host) => host,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    let tmux_aqua_bin = match resolve_tmux_aqua_bin(path) {
        Ok(tmux_aqua_bin) => tmux_aqua_bin,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    let aqua_sock = match resolve_aqua_sock(path) {
        Ok(aqua_sock) => aqua_sock,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    let engine = match resolve_engine(path, req) {
        Ok(engine) => engine,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(2);
        }
    };

    // ponytail: local-direct requires the REAL XpairHost. Verify the APP PROCESS is running — not just
    // that some tmux-aqua server answers on the socket: an orphaned/stray server (app dead) would pass a
    // bare has-session but runs OUTSIDE HostManager's granted AX/SR subtree (no computer-use). We also
    // never start the server from the CLI (a CLI-spawned one likewise escapes that subtree).
    let app_name = resolve_app_identity(path)
        .map(|id| id.app_name)
        .unwrap_or_else(|_| DEFAULT_APP_NAME.to_string());
    if !xpair_host_running(&app_name) || !local_tmux_aqua_ready(&tmux_aqua_bin, &aqua_sock) {
        eprintln!(
            "XpairHost isn't running — start it from the menu bar, then run xpair launch again."
        );
        return ExitCode::from(1);
    }

    let proj = local_session_base_for_local_tools(&local_host, &project_dir);
    let existing = list_local_sessions(&tmux_aqua_bin, &aqua_sock);
    let plan = pick_local_session(&proj, &existing, req.fresh);

    if plan.create {
        let respawn_path = match write_local_respawn_script(engine, &plan.session, plan.cont) {
            Ok(path) => path,
            Err(err) => {
                eprintln!("xpair launch: could not write local respawn script: {err}");
                return ExitCode::from(1);
            }
        };
        let respawn = respawn_path.to_string_lossy().into_owned();
        let argv = build_local_new_session_argv(
            &tmux_aqua_bin,
            &aqua_sock,
            &plan.session,
            &project_dir,
            &respawn,
        );
        if let Err(err) = run_noninteractive_argv(&argv) {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    }

    emit_terminal_title(&plan.session);
    spawn_and_wait(&build_local_launch_attach_argv(
        &tmux_aqua_bin,
        &aqua_sock,
        &plan.session,
    ))
}

fn run_remote(path: &Path, host: &str, local_mode: bool, req: &LaunchReq) -> ExitCode {
    if host.is_empty() {
        eprintln!("no host configured — set one in Xpair.app or: xpair config set host <ssh-host>");
        return ExitCode::from(1);
    }

    let mut raw_maps = match resolve_raw_maps(path) {
        Ok(raw_maps) => raw_maps,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    let mut raw_modes = match resolve_raw_modes(path) {
        Ok(raw_modes) => raw_modes,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    let mount_state =
        ensure_launch_arg_mount_best_effort(path, &req.dir, host, &raw_maps, &raw_modes);

    let dir = match absolutize_existing_dir(&mount_state.dir) {
        Ok(dir) => dir,
        Err(_) => {
            eprintln!("folder not found");
            return ExitCode::from(1);
        }
    };
    raw_maps = mount_state.raw_maps;
    let pairs = parse_maps(&raw_maps);
    let client_dir = dir.to_string_lossy().into_owned();
    let os = Os::current();
    let mut host_dir = match map_to_host_for_os(&client_dir, &pairs, os) {
        Ok(host_dir) => host_dir,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(2);
        }
    };
    let transport = SshTransport;
    match prompt_unmapped_folder_if_needed(
        path,
        &transport,
        host,
        &client_dir,
        &mut raw_maps,
        &mut raw_modes,
        req.yes,
        os,
    ) {
        Ok(Some(mapped_host_dir)) => host_dir = mapped_host_dir,
        Ok(None) => {}
        Err((message, code)) => {
            eprintln!("{message}");
            return ExitCode::from(code);
        }
    }

    let aqua_sock = match resolve_aqua_sock(path) {
        Ok(aqua_sock) => aqua_sock,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    let identity = match resolve_app_identity(path) {
        Ok(identity) => identity,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    let session = remote_session_name_for_local_tools(host, &host_dir);
    let engine = match resolve_remote_engine(path, req, host, &transport) {
        Ok(engine) => engine,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(2);
        }
    };
    if let Err((message, code)) = ensure_remote_host_dir_ready(&transport, host, &host_dir, req.yes)
    {
        eprintln!("{message}");
        return ExitCode::from(code);
    }
    let remote_info = match ensure_remote_session_info(
        &transport, host, &aqua_sock, &session, &host_dir, req.fresh, engine, &identity,
    ) {
        Ok(info) => info,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    if local_mode {
        let _ = config::set(path, "LOCAL_MODE", "0");
    }

    emit_terminal_title(&remote_info.session);
    crate::attach::run_remote_attach_handoff(
        path,
        Os::current(),
        host,
        &remote_info.session,
        &aqua_sock,
        &session::pairing_identity_args(),
        remote_info.remote_home.as_deref(),
    )
}

#[allow(clippy::too_many_arguments)]
fn prompt_unmapped_folder_if_needed(
    path: &Path,
    transport: &dyn Transport,
    host: &str,
    client_dir: &str,
    raw_maps: &mut String,
    raw_modes: &mut String,
    yes: bool,
    os: Os,
) -> Result<Option<String>, (String, u8)> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut out = io::stdout();
    let mut err = io::stderr();
    prompt_unmapped_folder_if_needed_with(
        path, transport, host, client_dir, raw_maps, raw_modes, yes, os, &mut input, &mut out,
        &mut err,
    )
}

#[allow(clippy::too_many_arguments)]
fn prompt_unmapped_folder_if_needed_with<R, W, E>(
    path: &Path,
    transport: &dyn Transport,
    host: &str,
    client_dir: &str,
    raw_maps: &mut String,
    raw_modes: &mut String,
    yes: bool,
    os: Os,
    input: &mut R,
    out: &mut W,
    err: &mut E,
) -> Result<Option<String>, (String, u8)>
where
    R: BufRead,
    W: Write,
    E: Write,
{
    if yes || os == Os::Windows || mapping_for_dir(client_dir, raw_maps, os).is_some() {
        return Ok(None);
    }
    if !remote_reachable(transport, host) {
        return Ok(None);
    }

    let host_dir = map_to_host_for_os(client_dir, &parse_maps(raw_maps), os)
        .map_err(|err| (err.to_string(), 2))?;
    print_unmapped_folder(out, client_dir, &host_dir);
    if remote_dir_exists_once(transport, host, &host_dir) {
        let _ = writeln!(out, "exists on {host}");
        let ans = prompt_answer(out, input, "  Register this mapping for next time? [Y/n]: ");
        if !ans.starts_with(['n', 'N']) {
            add_folder_mapping(
                path,
                RawMappingState {
                    maps: raw_maps,
                    modes: raw_modes,
                },
                client_dir,
                &host_dir,
                host,
                os,
                out,
            )
            .map_err(|err| (format!("xpair launch: {err}"), 1))?;
        }
        let _ = writeln!(out, "  Edit later with 'xpair config' / 'xpair map'.");
        return Ok(Some(host_dir));
    }

    let _ = writeln!(
        err,
        "not found on {host} — usually this folder should also exist on the host via sync."
    );
    let ans = prompt_answer(
        out,
        input,
        concat!(
            "  [m] map to the host path that actually has this content\n",
            "  [c] create an empty dir on host (new project only — content will not be synced here)\n",
            "  [N] cancel\n",
            "  choose: "
        ),
    );
    let host_dir = match ans.as_str() {
        "m" | "M" => map_register_interactive(
            path, transport, host, client_dir, raw_maps, raw_modes, os, input, out, err,
        )?,
        "c" | "C" => match transport.ssh_exec(host, &build_remote_mkdir_cmd(&host_dir)) {
            Ok(result) if result.code == 0 => {
                let _ = writeln!(out, "created on {host}: {host_dir}");
                host_dir
            }
            _ => return Err((format!("mkdir failed on {host}"), 1)),
        },
        _ => return Err(("cancelled.".to_string(), 1)),
    };
    let _ = writeln!(out, "  Edit later with 'xpair config' / 'xpair map'.");
    Ok(Some(host_dir))
}

fn print_unmapped_folder(out: &mut impl Write, client_dir: &str, host_dir: &str) {
    let _ = writeln!(out, "This folder is outside any registered mapping:");
    let _ = writeln!(out, "  client: {client_dir}");
    let _ = writeln!(out, "  host:   {host_dir}");
}

fn prompt_answer<R: BufRead>(out: &mut impl Write, input: &mut R, prompt: &str) -> String {
    let _ = write!(out, "{prompt}");
    let _ = out.flush();
    let mut answer = String::new();
    if input.read_line(&mut answer).is_err() {
        return String::new();
    }
    answer.trim_end_matches(['\r', '\n']).to_string()
}

fn remote_reachable(transport: &dyn Transport, host: &str) -> bool {
    transport
        .ssh_exec(host, "true")
        .map(|out| out.code == 0)
        .unwrap_or(false)
}

fn remote_dir_exists_once(transport: &dyn Transport, host: &str, host_dir: &str) -> bool {
    transport
        .ssh_exec(host, &build_remote_host_dir_check_cmd(host_dir))
        .map(|out| out.code == 0 && out.stdout.contains("__YES__"))
        .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
fn map_register_interactive<R, W, E>(
    path: &Path,
    transport: &dyn Transport,
    host: &str,
    seed_client_dir: &str,
    raw_maps: &mut String,
    raw_modes: &mut String,
    os: Os,
    input: &mut R,
    out: &mut W,
    err: &mut E,
) -> Result<String, (String, u8)>
where
    R: BufRead,
    W: Write,
    E: Write,
{
    let client_dir = absolutize_existing_dir(seed_client_dir)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| (format!("client path not found: {seed_client_dir}"), 1))?;
    let mut host_dir;
    loop {
        let ans = prompt_answer(
            out,
            input,
            &format!("Host path that has this content [{client_dir}]: "),
        );
        host_dir = if ans.is_empty() {
            client_dir.clone()
        } else {
            ans
        };
        if remote_dir_exists_once(transport, host, &host_dir) {
            let _ = writeln!(out, "exists on {host}: {host_dir}");
            break;
        }
        let _ = writeln!(err, "not found on {host}: {host_dir}");
        let ans = prompt_answer(
            out,
            input,
            "  [r] re-enter path  [c] create it on host  [N] cancel: ",
        );
        match ans.as_str() {
            "c" | "C" => match transport.ssh_exec(host, &build_remote_mkdir_cmd(&host_dir)) {
                Ok(result) if result.code == 0 => {
                    let _ = writeln!(out, "created on {host}: {host_dir}");
                    break;
                }
                _ => {
                    let _ = writeln!(err, "mkdir failed on {host}");
                }
            },
            "r" | "R" => {}
            _ => return Err(("cancelled.".to_string(), 1)),
        }
    }

    let ans = prompt_answer(
        out,
        input,
        "Map this folder only, or a parent sync root? [t]his / [p]arent root: ",
    );
    if matches!(ans.as_str(), "p" | "P") {
        let default_client_root = path_dirname(&client_dir);
        let ans = prompt_answer(
            out,
            input,
            &format!("  Parent client root [{default_client_root}]: "),
        );
        let client_root = if ans.is_empty() {
            default_client_root
        } else {
            absolutize_existing_dir(&ans)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or(ans)
        };
        let default_host_root = posix_dirname(&host_dir);
        let ans = prompt_answer(
            out,
            input,
            &format!("  Parent host root [{default_host_root}]: "),
        );
        let host_root = if ans.is_empty() {
            default_host_root
        } else {
            ans
        };
        add_folder_mapping(
            path,
            RawMappingState {
                maps: raw_maps,
                modes: raw_modes,
            },
            &client_root,
            &host_root,
            host,
            os,
            out,
        )
        .map_err(|err| (format!("xpair launch: {err}"), 1))?;
        let _ = writeln!(out, "  All subfolders under {client_root} are now covered.");
    } else {
        add_folder_mapping(
            path,
            RawMappingState {
                maps: raw_maps,
                modes: raw_modes,
            },
            &client_dir,
            &host_dir,
            host,
            os,
            out,
        )
        .map_err(|err| (format!("xpair launch: {err}"), 1))?;
    }

    map_to_host_for_os(&client_dir, &parse_maps(raw_maps), os).map_err(|err| (err.to_string(), 2))
}

struct RawMappingState<'a> {
    maps: &'a mut String,
    modes: &'a mut String,
}

fn add_folder_mapping(
    path: &Path,
    raw: RawMappingState<'_>,
    client_dir: &str,
    host_dir: &str,
    host: &str,
    os: Os,
    out: &mut impl Write,
) -> io::Result<()> {
    let RawMappingState {
        maps: raw_maps,
        modes: raw_modes,
    } = raw;
    let client_dir = normalize_client_path_for_persistence(client_dir, os);
    if mapping_for_dir(&client_dir, raw_maps, os).is_some() {
        let _ = writeln!(out, "already mapped (or under a mapped root): {client_dir}");
        return Ok(());
    }

    let mut entries = parse_maps(raw_maps)
        .into_iter()
        .map(|(client, host)| {
            format!(
                "{}::{host}",
                normalize_client_path_for_persistence(&client, os)
            )
        })
        .collect::<Vec<_>>();
    entries.push(format!("{client_dir}::{host_dir}"));
    *raw_maps = entries.join(";");
    config::set(path, "FOLDER_MAPS", raw_maps)?;

    let method = infer_launch_map_method(&client_dir, host);
    *raw_modes = upsert_map_mode(raw_modes, &client_dir, &method, os);
    config::set(path, "FOLDER_MAP_MODES", raw_modes)?;
    let _ = writeln!(out, "mapping added: {client_dir}  →  {host_dir} ({method})");
    Ok(())
}

fn upsert_map_mode(raw_modes: &str, client_dir: &str, method: &str, os: Os) -> String {
    let mut entries = parse_maps(raw_modes)
        .into_iter()
        .filter(|(client, _)| !client_path_eq_for_os(client, client_dir, os))
        .map(|(client, mode)| {
            format!(
                "{}::{mode}",
                normalize_client_path_for_persistence(&client, os)
            )
        })
        .collect::<Vec<_>>();
    entries.push(format!("{client_dir}::{method}"));
    entries.join(";")
}

fn mapping_for_dir(dir: &str, raw_maps: &str, os: Os) -> Option<(String, String)> {
    parse_maps(raw_maps)
        .into_iter()
        .filter(|(client, _)| client_path_eq_or_child_for_os(dir, client, os))
        .max_by_key(|(client, _)| client.len())
}

fn path_dirname(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .filter(|parent| !parent.is_empty())
        .unwrap_or_else(|| ".".to_string())
}

fn posix_dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == path && path == "/" {
        return "/".to_string();
    }
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(idx) => trimmed[..idx].to_string(),
        None => ".".to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchMountState {
    dir: String,
    raw_maps: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MountCommandOutput {
    success: bool,
    output: String,
}

struct LaunchMountEnsure<'a> {
    os: Os,
    target: &'a str,
    host: &'a str,
    raw_maps: &'a str,
    raw_modes: &'a str,
    mount_tool: Option<PathBuf>,
}

fn ensure_launch_arg_mount_best_effort(
    path: &Path,
    target: &str,
    host: &str,
    raw_maps: &str,
    raw_modes: &str,
) -> LaunchMountState {
    let tool = resolve_xpair_mount_tool(path);
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();
    ensure_launch_arg_mount_best_effort_with(
        LaunchMountEnsure {
            os: Os::current(),
            target,
            host,
            raw_maps,
            raw_modes,
            mount_tool: tool,
        },
        |host_path| discover_mountpoint_for_hostpath(host_path, host),
        run_mount_tool,
        &mut stdout,
        &mut stderr,
    )
}

fn ensure_launch_arg_mount_best_effort_with<D, M, W, E>(
    input: LaunchMountEnsure<'_>,
    mut discover_mountpoint: D,
    mut mount_host_path: M,
    out: &mut W,
    err: &mut E,
) -> LaunchMountState
where
    D: FnMut(&str) -> Option<String>,
    M: FnMut(&Path, &str) -> io::Result<MountCommandOutput>,
    W: Write,
    E: Write,
{
    let mut state = LaunchMountState {
        dir: input.target.to_string(),
        raw_maps: input.raw_maps.to_string(),
    };
    if input.os != Os::Mac
        || !input.target.starts_with("/Volumes/")
        || input.host.is_empty()
        || input.raw_maps.is_empty()
    {
        return state;
    }

    for (client_path, host_path) in parse_maps(input.raw_maps) {
        if !path_eq_or_child(input.target, &client_path) {
            continue;
        }
        if map_mode_of(&client_path, input.raw_modes, input.host) != "mount" {
            continue;
        }

        if let Some(mountpoint) = discover_mountpoint(&host_path) {
            apply_mountpoint_override(
                &mut state,
                input.raw_modes,
                input.target,
                &client_path,
                &mountpoint,
            );
            return state;
        }

        let Some(tool) = input.mount_tool.as_deref() else {
            let _ = writeln!(
                err,
                "warning: xpair-mount not found; cannot ensure mount-method folder map before launch"
            );
            return state;
        };

        let expected = expected_mountpoint(&host_path);
        match mount_host_path(tool, &host_path) {
            Ok(MountCommandOutput {
                success: true,
                output,
            }) => {
                if !output.is_empty() {
                    let _ = write!(out, "{output}");
                    if !output.ends_with('\n') {
                        let _ = writeln!(out);
                    }
                }
                let mountpoint = mountpoint_from_mount_output(&output)
                    .or_else(|| discover_mountpoint(&host_path));
                if let Some(mountpoint) = mountpoint {
                    apply_mountpoint_override(
                        &mut state,
                        input.raw_modes,
                        input.target,
                        &client_path,
                        &mountpoint,
                    );
                }
            }
            Ok(MountCommandOutput { output, .. }) => {
                let _ = writeln!(
                    err,
                    "warning: could not mount {host_path} at {expected} before launch; continuing"
                );
                if !output.is_empty() {
                    let _ = write!(err, "{output}");
                    if !output.ends_with('\n') {
                        let _ = writeln!(err);
                    }
                }
            }
            Err(error) => {
                let _ = writeln!(
                    err,
                    "warning: could not mount {host_path} at {expected} before launch; continuing"
                );
                let _ = writeln!(err, "{error}");
            }
        }
        return state;
    }

    state
}

fn apply_mountpoint_override(
    state: &mut LaunchMountState,
    raw_modes: &str,
    target: &str,
    client_path: &str,
    mountpoint: &str,
) {
    let (raw_maps, _raw_modes) =
        replace_mount_mapping_client_path(&state.raw_maps, raw_modes, client_path, mountpoint);
    state.raw_maps = raw_maps;
    if path_eq_or_child(target, client_path) {
        state.dir = format!("{mountpoint}{}", &target[client_path.len()..]);
    }
}

fn replace_mount_mapping_client_path(
    raw_maps: &str,
    raw_modes: &str,
    old: &str,
    new: &str,
) -> (String, String) {
    if old.is_empty() || new.is_empty() || old == new {
        return (raw_maps.to_string(), raw_modes.to_string());
    }

    let maps = parse_maps(raw_maps)
        .into_iter()
        .map(|(client, host)| {
            let client = if client == old {
                new.to_string()
            } else {
                client
            };
            format!("{client}::{host}")
        })
        .collect::<Vec<_>>()
        .join(";");
    let modes = parse_maps(raw_modes)
        .into_iter()
        .map(|(client, mode)| {
            let client = if client == old {
                new.to_string()
            } else {
                client
            };
            format!("{client}::{mode}")
        })
        .collect::<Vec<_>>()
        .join(";");
    (maps, modes)
}

fn map_mode_of(client_path: &str, raw_modes: &str, host: &str) -> String {
    parse_maps(raw_modes)
        .into_iter()
        .find(|(client, _)| client == client_path)
        .map(|(_, mode)| mode)
        .unwrap_or_else(|| infer_launch_map_method(client_path, host))
}

fn infer_launch_map_method(client_path: &str, host: &str) -> String {
    if !client_path.starts_with("/Volumes/") || host.is_empty() {
        return "sync".to_string();
    }
    let host = host.rsplit('@').next().unwrap_or(host);
    let Some(mount_output) = mount_output() else {
        return "sync".to_string();
    };
    for line in mount_output.lines() {
        if !line.contains(" (smbfs") {
            continue;
        }
        let Some((source, rest)) = line.split_once(" on ") else {
            continue;
        };
        let Some((mountpoint, _)) = rest.split_once(" (smbfs") else {
            continue;
        };
        let source_matches = source.contains(&format!("@{host}/"))
            || source
                .strip_prefix("//")
                .is_some_and(|source| source.starts_with(&format!("{host}/")));
        if source_matches && path_eq_or_child(client_path, mountpoint) {
            return "mount".to_string();
        }
    }
    "sync".to_string()
}

fn resolve_xpair_mount_tool(path: &Path) -> Option<PathBuf> {
    let local_bin = config::default_local_bin().ok();
    let rp_bin = path.parent().map(|parent| parent.join("bin"));
    for dir in [local_bin.as_deref(), rp_bin.as_deref()]
        .into_iter()
        .flatten()
    {
        let candidate = dir.join("xpair-mount");
        if program_present(&candidate) {
            return Some(candidate);
        }
    }
    find_on_path("xpair-mount")
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if program_present(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn run_mount_tool(tool: &Path, host_path: &str) -> io::Result<MountCommandOutput> {
    let out = Command::new(tool)
        .args(["--backend", "smb", "mount", host_path])
        .stdin(Stdio::null())
        .output()?;
    let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
    output.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(MountCommandOutput {
        success: out.status.success(),
        output,
    })
}

fn mountpoint_from_mount_output(output: &str) -> Option<String> {
    output
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("Mountpoint:"))
        .map(str::trim)
        .rfind(|mountpoint| !mountpoint.is_empty())
        .map(str::to_string)
}

fn discover_mountpoint_for_hostpath(host_path: &str, host: &str) -> Option<String> {
    let share = share_name_for_hostpath(host_path);
    let host = host.rsplit('@').next().unwrap_or(host);
    let mount_output = mount_output()?;
    for line in mount_output.lines() {
        if !line.contains(" (smbfs") {
            continue;
        }
        let Some((source, rest)) = line.split_once(" on ") else {
            continue;
        };
        let Some((mountpoint, _)) = rest.split_once(" (smbfs") else {
            continue;
        };
        let source_matches = source.contains(&format!("@{host}/{share}"))
            || source
                .strip_prefix("//")
                .is_some_and(|source| source.starts_with(&format!("{host}/{share}")));
        if source_matches {
            return Some(mountpoint.to_string());
        }
    }
    None
}

fn expected_mountpoint(host_path: &str) -> String {
    let root = non_empty_env("MOUNTS_ROOT").unwrap_or_else(|| "/Volumes".to_string());
    format!("{root}/{}", share_name_for_hostpath(host_path))
}

fn share_name_for_hostpath(host_path: &str) -> String {
    posix_basename(host_path)
}

fn mount_output() -> Option<String> {
    Command::new("mount")
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn path_eq_or_child(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn remote_has_session_cmd(aqua_sock: &str, session: &str) -> String {
    let sock = remote_quote::posix_single_quote(aqua_sock);
    let target = remote_quote::posix_single_quote(&format!("={session}"));
    format!("{REMOTE_BIN}/{TMUX_AQUA} -S {sock} has-session -t {target} 2>/dev/null")
}

fn remote_new_session_cmd(
    aqua_sock: &str,
    session: &str,
    host_dir: &str,
    engine: Engine,
    cl_continue: bool,
) -> String {
    let sock = remote_quote::posix_single_quote(aqua_sock);
    let session_q = remote_quote::posix_single_quote(session);
    let host_dir = remote_quote::posix_single_quote(host_dir);
    let script = build_remote_respawn_script(engine, session, cl_continue);
    let script = remote_quote::posix_single_quote(&script);
    format!(
        "T=$(mktemp -t claude-respawn.XXXXXX) && printf %s {script} > \"$T\" && {REMOTE_BIN}/{TMUX_AQUA} -S {sock} new-session -d -s {session_q} -c {host_dir} \"bash $T\""
    )
}

fn build_single_named_session_remote_cmd(
    engine: Engine,
    aqua_sock: &str,
    session: &str,
    host_dir: &str,
    fresh: bool,
    cl_continue: bool,
) -> String {
    if fresh {
        remote_new_session_cmd(aqua_sock, session, host_dir, engine, false)
    } else {
        let has = remote_has_session_cmd(aqua_sock, session);
        let new = remote_new_session_cmd(aqua_sock, session, host_dir, engine, cl_continue);
        format!("{has} || {{ {new}; }}")
    }
}

fn build_numbered_session_remote_cmd(
    engine: Engine,
    aqua_sock: &str,
    base: &str,
    n: usize,
    host_dir: &str,
    fresh: bool,
    cl_continue: bool,
) -> String {
    let sock = remote_quote::posix_single_quote(aqua_sock);
    let base_q = remote_quote::posix_single_quote(base);
    let host_dir_q = remote_quote::posix_single_quote(host_dir);
    let body = remote_quote::posix_single_quote(respawn::respawn_body(engine));
    let fresh = u8::from(fresh);
    let cl_continue = u8::from(cl_continue);
    let tmux = format!("{REMOTE_BIN}/{TMUX_AQUA} -S {sock}");
    format!(
        concat!(
            "BASE={base_q}; N={n}; FRESH={fresh}; CONT={cl_continue}; ",
            "while {tmux} list-clients -t \"=${{BASE}}_${{N}}\" -F x 2>/dev/null | grep -q x; do N=$((N+1)); CONT=0; done; ",
            "SESSION=\"${{BASE}}_${{N}}\"; ",
            "NEED_CREATE=1; ",
            "if [ \"$FRESH\" = 1 ]; then ",
            "CONT=0; ",
            "while {tmux} has-session -t \"=$SESSION\" 2>/dev/null; do N=$((N+1)); SESSION=\"${{BASE}}_${{N}}\"; done; ",
            "else ",
            "if {tmux} has-session -t \"=$SESSION\" 2>/dev/null; then NEED_CREATE=0; fi; ",
            "fi; ",
            "if [ \"$NEED_CREATE\" = 1 ]; then ",
            "while :; do ",
            "T=$(mktemp -t claude-respawn.XXXXXX) && ",
            "{{ printf '%s\\n' '{path_export}'; printf 'export CLAUDE_WARP_RC=%s\\n' \"$SESSION\"; printf 'export CL_CONTINUE=%s\\n' \"$CONT\"; printf %s {body}; }} > \"$T\" && ",
            "if {tmux} new-session -d -s \"$SESSION\" -c {host_dir_q} \"bash $T\"; then break; fi; ",
            "if [ \"$FRESH\" = 1 ] && {tmux} has-session -t \"=$SESSION\" 2>/dev/null; then N=$((N+1)); SESSION=\"${{BASE}}_${{N}}\"; continue; fi; ",
            "exit 13; ",
            "done; ",
            "fi; ",
            "printf '__SESSION__:%s\\n' \"$SESSION\""
        ),
        base_q = base_q,
        n = n,
        fresh = fresh,
        cl_continue = cl_continue,
        tmux = tmux,
        body = body,
        host_dir_q = host_dir_q,
        path_export = REMOTE_AGENT_PATH_EXPORT,
    )
}

fn build_remote_respawn_script(engine: Engine, session: &str, cl_continue: bool) -> String {
    format!(
        "{REMOTE_AGENT_PATH_EXPORT}\n{}",
        respawn::build_respawn_script(engine, session, cl_continue)
    )
}

fn wrap_remote_setup_cmd(
    aqua_sock: &str,
    engine: Engine,
    identity: &AppIdentity,
    body: &str,
) -> String {
    let sock = remote_quote::posix_single_quote(aqua_sock);
    format!(
        "{}{}; printf '__HOME__:%s\\n' \"$HOME\"",
        remote_setup_preamble(&sock, engine, identity),
        body
    )
}

fn remote_setup_preamble(sock_q: &str, engine: Engine, identity: &AppIdentity) -> String {
    let app = remote_quote::posix_single_quote(&identity.app_name);
    let bundle = remote_quote::posix_single_quote(&identity.bundle_prefix);
    let forward_app = remote_quote::posix_single_quote(&identity.forward_app);
    let forward_bundle = remote_quote::posix_single_quote(&identity.forward_bundle);
    format!(
        concat!(
            "set -e; exec 2>&1; {path_export}; ",
            "APP_NAME={app}; BUNDLE_PREFIX={bundle}; FORWARD_APP={forward_app}; FORWARD_BUNDLE={forward_bundle}; ",
            "{engine_preflight}",
            "SOCK={sock_q}; TMUXB=\"{remote_bin}/{tmux_aqua}\"; ",
            "tm() {{ \"$TMUXB\" -S \"$SOCK\" \"$@\"; }}; ",
            "host_setup_recovery() {{ ",
            "why=\"${{1:-$APP_NAME tmux-aqua is not ready}}\"; ",
            "printf '__XPAIR_HOST_RECOVERY__\\n'; ",
            "printf '\\n%s setup is required before this remote session can start.\\n' \"$APP_NAME\" >&2; ",
            "printf 'Reason: %s\\n' \"$why\" >&2; ",
            "printf 'Recovery on %s:\\n' \"$(hostname -s)\" >&2; ",
            "printf '  1. Open %s.app on the host Mac.\\n' \"$APP_NAME\" >&2; ",
            "printf '  2. From the menu bar, choose Set up... or Permissions...\\n' >&2; ",
            "printf '  3. Grant Accessibility and Screen Recording, then retry xpair launch.\\n' >&2; ",
            "printf 'Diagnostics: tmux-aqua=%s socket=%s\\n' \"$TMUXB\" \"$SOCK\" >&2; ",
            "exit 13; ",
            "}}; ",
            "[ -x \"$TMUXB\" ] || host_setup_recovery \"tmux-aqua helper is missing or not executable: $TMUXB\"; ",
            "if ! tm has-session 2>/dev/null; then ",
            "open -a \"$APP_NAME\" 2>/dev/null || open -a \"$FORWARD_APP\" 2>/dev/null || /bin/launchctl kickstart \"gui/$(id -u)/$BUNDLE_PREFIX\" 2>/dev/null || /bin/launchctl kickstart \"gui/$(id -u)/$FORWARD_BUNDLE\" 2>/dev/null || true; ",
            "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do tm has-session 2>/dev/null && break; sleep 0.5; done; ",
            "fi; ",
            "if ! tm has-session 2>/dev/null; then host_setup_recovery \"$APP_NAME host server is not running on $SOCK\"; fi; "
        ),
        path_export = REMOTE_AGENT_PATH_EXPORT,
        app = app,
        bundle = bundle,
        forward_app = forward_app,
        forward_bundle = forward_bundle,
        engine_preflight = remote_engine_preflight(engine),
        sock_q = sock_q,
        remote_bin = REMOTE_BIN,
        tmux_aqua = TMUX_AQUA,
    )
}

fn remote_engine_preflight(engine: Engine) -> String {
    if engine == Engine::Shell {
        return String::new();
    }

    let command = remote_quote::posix_single_quote(engine.command_name());
    format!(
        concat!(
            "RP_ENGINE={command}; ",
            "if [ \"$RP_ENGINE\" != shell ] && ! command -v \"$RP_ENGINE\" >/dev/null 2>&1; then ",
            "printf '%s not found on %s (PATH=%s) — install it with the native installer or use --engine claude\\n' \"$RP_ENGINE\" \"$(hostname -s)\" \"$PATH\" >&2; ",
            "exit 11; ",
            "fi; "
        ),
        command = command,
    )
}

pub fn build_remote_host_dir_check_cmd(host_dir: &str) -> String {
    let host_dir = remote_quote::posix_single_quote(host_dir);
    format!("[ -d {host_dir} ] && echo __YES__ || echo __NO__")
}

fn build_remote_mkdir_cmd(host_dir: &str) -> String {
    let host_dir = remote_quote::posix_single_quote(host_dir);
    format!("mkdir -p {host_dir}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteHostDirStatus {
    Present,
    Missing,
    Unknown,
}

fn check_remote_host_dir(
    transport: &dyn Transport,
    host: &str,
    host_dir: &str,
) -> RemoteHostDirStatus {
    let cmd = build_remote_host_dir_check_cmd(host_dir);
    for _ in 0..3 {
        let Ok(out) = transport.ssh_exec(host, &cmd) else {
            continue;
        };
        if out.stdout.contains("__YES__") {
            return RemoteHostDirStatus::Present;
        }
        if out.stdout.contains("__NO__") {
            return RemoteHostDirStatus::Missing;
        }
    }
    RemoteHostDirStatus::Unknown
}

fn ensure_remote_host_dir_ready(
    transport: &dyn Transport,
    host: &str,
    host_dir: &str,
    yes: bool,
) -> Result<(), (String, u8)> {
    match check_remote_host_dir(transport, host, host_dir) {
        RemoteHostDirStatus::Present => Ok(()),
        RemoteHostDirStatus::Missing => {
            eprintln!("{host_dir} does not exist on {host} (mapped host path).");
            let create = yes || ask_create_host_dir();
            if !create {
                return Err((
                    format!("cancelled: directory missing on host ({host_dir})"),
                    5,
                ));
            }
            match transport.ssh_exec(host, &build_remote_mkdir_cmd(host_dir)) {
                Ok(out) if out.code == 0 => Ok(()),
                _ => Err((format!("mkdir failed ({host})"), 4)),
            }
        }
        RemoteHostDirStatus::Unknown => Err((remote_disconnect_message(host), 21)),
    }
}

fn ask_create_host_dir() -> bool {
    eprint!("create the directory on host? [y/N]: ");
    let _ = io::stderr().flush();
    let mut answer = String::new();
    io::stdin().read_line(&mut answer).is_ok()
        && answer
            .chars()
            .next()
            .is_some_and(|ch| matches!(ch, 'y' | 'Y'))
}

fn remote_disconnect_message(host: &str) -> String {
    format!(
        concat!(
            "remote launch stopped: {host} dir-check ssh failed 3 times\n",
            "please connect/reconnect to {host} (LAN, VPN, or Tailscale), then rerun xpair launch.\n",
            "  (tailscale exit-node is not auto-configured by Xpair — bring the link up yourself)\n",
            "Xpair will not change Tailscale exit-node settings or fall back to local automatically."
        ),
        host = host,
    )
}

fn extract_session_marker(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .filter_map(|line| line.strip_prefix("__SESSION__:"))
        .next_back()
        .map(str::to_string)
        .filter(|session| !session.is_empty())
}

fn extract_home_marker(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .filter_map(|line| line.strip_prefix("__HOME__:"))
        .next_back()
        .map(str::to_string)
        .filter(|home| !home.is_empty())
}

fn setup_output_without_markers(stdout: &str) -> String {
    stdout
        .lines()
        .filter(|line| {
            !line.starts_with("__SESSION__:")
                && !line.starts_with("__HOME__:")
                && *line != "__XPAIR_HOST_RECOVERY__"
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn split_numbered_session(session: &str) -> Option<(String, usize)> {
    let (base, raw_n) = session.rsplit_once('_')?;
    let n = raw_n.parse::<usize>().ok()?;
    if base.is_empty() || n == 0 {
        None
    } else {
        Some((base.to_string(), n))
    }
}

fn resolve_engine(path: &Path, req: &LaunchReq) -> Result<Engine, String> {
    let raw = match &req.engine {
        Some(engine) => engine.clone(),
        None => resolve_client_engine_fallback(path)?,
    };
    canonical_engine(&raw)
        .map(|engine| Engine::from_canonical(&engine))
        .ok_or_else(|| format!("unknown engine: {raw} (use {ENGINE_USAGE})"))
}

fn resolve_remote_engine<T: Transport + ?Sized>(
    path: &Path,
    req: &LaunchReq,
    host: &str,
    transport: &T,
) -> Result<Engine, String> {
    if req.engine.is_some() {
        return resolve_engine(path, req);
    }

    if let Some(engine) = read_host_engine(transport, host).and_then(|raw| canonical_engine(&raw)) {
        return Ok(Engine::from_canonical(&engine));
    }

    let raw = resolve_client_engine_fallback(path)?;
    canonical_engine(&raw)
        .map(|engine| Engine::from_canonical(&engine))
        .ok_or_else(|| format!("unknown engine: {raw} (use {ENGINE_USAGE})"))
}

fn resolve_client_engine_fallback(path: &Path) -> Result<String, String> {
    if let Some(engine) = non_empty_env("ENGINE") {
        return Ok(engine);
    }
    config::get_cli(path, "engine").map_err(|err| err.to_string())
}

pub fn build_read_host_engine_remote_cmd() -> &'static str {
    "set -a; [ -f \"$HOME/.xpair/host/host.env\" ] && . \"$HOME/.xpair/host/host.env\"; printf \"%s\\n\" \"${ENGINE:-}\""
}

fn read_host_engine<T: Transport + ?Sized>(transport: &T, host: &str) -> Option<String> {
    if host.is_empty() {
        return None;
    }
    let out = transport
        .ssh_exec(host, build_read_host_engine_remote_cmd())
        .ok()?;
    if out.code != 0 {
        return None;
    }
    out.stdout
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

fn local_session_exists(existing: &[(String, bool)], proj: &str, n: usize) -> bool {
    let session = format!("{proj}_{n}");
    existing.iter().any(|(name, _)| name == &session)
}

fn local_session_attached(existing: &[(String, bool)], proj: &str, n: usize) -> bool {
    let session = format!("{proj}_{n}");
    existing
        .iter()
        .any(|(name, attached)| name == &session && *attached)
}

fn proj_base(host_dir: &str) -> String {
    let basename = posix_basename(host_dir);
    proj_base_with_readable(host_dir, &basename)
}

fn proj_base_with_exec(host_dir: &str, exec: &dyn NameExec) -> String {
    let basename = posix_basename(host_dir);
    let readable = readable_basename(&basename, exec);
    proj_base_with_readable(host_dir, &readable)
}

fn proj_base_with_readable(host_dir: &str, readable: &str) -> String {
    let mut name = sanitize_readable_name(readable);
    if name.is_empty() {
        name = "session".to_string();
    }
    format!("{}_{}", name, sha256_hex_prefix(host_dir, 5))
}

trait NameExec {
    fn output(&self, program: &Path, arg: &str) -> Option<String>;
}

struct RealNameExec;

impl NameExec for RealNameExec {
    fn output(&self, program: &Path, arg: &str) -> Option<String> {
        let out = Command::new(program)
            .arg(arg)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout)
            .trim_end_matches(['\r', '\n'])
            .to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

fn readable_basename(basename: &str, exec: &dyn NameExec) -> String {
    if readable_fast_path(basename) {
        return basename.to_string();
    }

    let cache_file = readable_cache_file(basename);
    if let Some(cache_file) = &cache_file {
        if let Ok(value) = fs::read_to_string(cache_file) {
            if !value.is_empty() {
                return value;
            }
        }
    }

    if let Some(romanizer) = romanizer_path().filter(|path| program_present(path)) {
        if let Some(value) = exec.output(&romanizer, basename) {
            if let Some(cache_file) = &cache_file {
                write_readable_cache(cache_file, &value);
            }
            return value;
        }
    }

    if let Some(cache_file) = &cache_file {
        write_readable_cache(cache_file, basename);
    }
    basename.to_string()
}

fn readable_fast_path(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn readable_cache_file(basename: &str) -> Option<PathBuf> {
    let client_dir = client_dir_for_tools()?;
    Some(
        client_dir
            .join("session-names")
            .join(sha256_hex_prefix(basename, 12)),
    )
}

fn romanizer_path() -> Option<PathBuf> {
    if let Some(path) = non_empty_env("HROMANIZE") {
        return Some(PathBuf::from(path));
    }
    Some(client_dir_for_tools()?.join("bin").join("hangul-romanize"))
}

fn client_dir_for_tools() -> Option<PathBuf> {
    if let Some(dir) = non_empty_env("RP_CLIENT_DIR") {
        return Some(PathBuf::from(dir));
    }
    config::default_client_env_path()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

fn write_readable_cache(path: &Path, value: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, value);
}

fn posix_basename(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

fn sanitize_readable_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;

    for ch in name.chars().flat_map(char::to_lowercase) {
        let keep = ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '.' | '-');
        if ch == '-' {
            if !last_dash {
                out.push('-');
                last_dash = true;
            }
        } else if keep {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }

    let trimmed = out.trim_matches('-');
    trimmed.chars().take(15).collect()
}

fn normalize_session_name(session: &str) -> String {
    session
        .chars()
        .map(|ch| {
            if matches!(ch, '.' | ':' | '@') {
                '_'
            } else {
                ch
            }
        })
        .collect()
}

fn sha256_hex_prefix(input: &str, chars: usize) -> String {
    let digest = sha256(input.as_bytes());
    let mut out = String::with_capacity(chars);
    for byte in digest {
        if out.len() >= chars {
            break;
        }
        out.push(hex_digit(byte >> 4));
        if out.len() >= chars {
            break;
        }
        out.push(hex_digit(byte & 0x0f));
    }
    out
}

fn sha256(input: &[u8]) -> [u8; 32] {
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let bit_len = (input.len() as u64) * 8;
    let mut msg = input.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    let mut h = H0;
    let mut w = [0u32; 64];
    for chunk in msg.chunks_exact(64) {
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (idx, word) in h.into_iter().enumerate() {
        out[idx * 4..idx * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn hex_digit(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => unreachable!(),
    }
}

fn absolutize_existing_dir(dir: &str) -> std::io::Result<PathBuf> {
    fs::canonicalize(dir).and_then(|path| {
        if path.is_dir() {
            Ok(path)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "folder not found",
            ))
        }
    })
}

fn resolve_host(path: &Path) -> std::io::Result<String> {
    if let Some(host) = non_empty_env("REMOTE_HOST") {
        config::require_valid_host(&host)?;
        return Ok(host);
    }
    config::get_cli(path, "host")
}

fn resolve_local_mode(path: &Path) -> std::io::Result<bool> {
    let _ = path;
    Ok(false)
}

fn resolve_raw_maps(path: &Path) -> std::io::Result<String> {
    if let Some(raw_maps) = non_empty_env("FOLDER_MAPS") {
        return Ok(raw_maps);
    }
    if let Some(raw_maps) = non_empty_env("SYNC_ROOTS") {
        return Ok(raw_maps);
    }
    if let Some(raw_maps) = config::get(path, "FOLDER_MAPS")?.filter(|maps| !maps.is_empty()) {
        return Ok(raw_maps);
    }
    Ok(config::get(path, "SYNC_ROOTS")?.unwrap_or_default())
}

fn resolve_raw_modes(path: &Path) -> std::io::Result<String> {
    if let Some(raw_modes) = non_empty_env("FOLDER_MAP_MODES") {
        return Ok(raw_modes);
    }
    Ok(config::get(path, "FOLDER_MAP_MODES")?.unwrap_or_default())
}

fn resolve_app_identity(path: &Path) -> io::Result<AppIdentity> {
    let host_env = config::default_rp_dir()?.join("host.env");
    Ok(AppIdentity {
        app_name: resolve_env_stack_value_with_host_env(path, &host_env, "APP_NAME")?
            .unwrap_or_else(|| DEFAULT_APP_NAME.to_string()),
        bundle_prefix: resolve_env_stack_value_with_host_env(path, &host_env, "BUNDLE_PREFIX")?
            .unwrap_or_else(|| DEFAULT_BUNDLE_PREFIX.to_string()),
        forward_app: resolve_env_stack_value_with_host_env(path, &host_env, "FORWARD_APP")?
            .unwrap_or_else(|| DEFAULT_FORWARD_APP.to_string()),
        forward_bundle: resolve_env_stack_value_with_host_env(path, &host_env, "FORWARD_BUNDLE")?
            .unwrap_or_else(|| DEFAULT_FORWARD_BUNDLE.to_string()),
    })
}

fn resolve_env_stack_value_with_host_env(
    path: &Path,
    host_env: &Path,
    key: &str,
) -> io::Result<Option<String>> {
    let mut value = non_empty_env(key);

    if let Some(file_value) = config::get(path, key)?.filter(|value| !value.is_empty()) {
        value = Some(file_value);
    }

    for (existing_key, existing_value) in config::list(host_env)? {
        if existing_key == key && !existing_value.is_empty() {
            value = Some(existing_value);
        }
    }

    Ok(value)
}

fn resolve_aqua_sock(path: &Path) -> io::Result<String> {
    if let Some(aqua_sock) = non_empty_env("AQUA_SOCK") {
        return Ok(aqua_sock);
    }
    Ok(config::get(path, "AQUA_SOCK")?
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| session::DEFAULT_AQUA_SOCK.to_string()))
}

fn resolve_tmux_aqua_bin(path: &Path) -> io::Result<String> {
    if let Some(tmux_b) = non_empty_env("TMUXB") {
        return Ok(normalize_windows_exe(PathBuf::from(tmux_b))
            .to_string_lossy()
            .into_owned());
    }

    let local_bin = if let Some(local_bin) = non_empty_env("LOCAL_BIN") {
        PathBuf::from(local_bin)
    } else if let Some(local_bin) =
        config::get(path, "LOCAL_BIN")?.filter(|value| !value.is_empty())
    {
        PathBuf::from(local_bin)
    } else {
        home_dir()?.join(".local").join("bin")
    };

    Ok(normalize_windows_exe(local_bin.join(TMUX_AQUA))
        .to_string_lossy()
        .into_owned())
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
            "HOME is not set; cannot resolve ~/.local/bin/tmux-aqua",
        )),
    }
}

fn short_hostname() -> io::Result<String> {
    let out = Command::new("hostname")
        .arg("-s")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    if !out.status.success() {
        return Err(io::Error::other("hostname -s failed"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// True when XpairHost is installed on THIS machine. Reads the AUTHORITATIVE host marker
/// `~/.xpair/host/role` (RP_HOST_DIR) — a host-only install writes the role there, NOT under the
/// client dir, so keying off the client env path would miss it.
fn local_host_role_expected(remote_host: &str) -> bool {
    let Ok(rp_host_dir) = config::default_rp_dir() else {
        return false;
    };
    let role = fs::read_to_string(rp_host_dir.join("role"))
        .unwrap_or_default()
        .trim()
        .to_string();
    match role.as_str() {
        "host" | "both" => true,
        "client" => false,
        _ if rp_host_dir.join("host.env").is_file() => short_hostname()
            .map(|host| remote_host.is_empty() || host == remote_host)
            .unwrap_or(false),
        _ => false,
    }
}

/// True when the configured remote string actually points at THIS machine (loopback or same hostname) —
/// used to prefer local-direct over ssh-to-self.
fn remote_is_local(remote: &str) -> bool {
    // Strip an optional `user@` prefix — a self-host remote may be `alice@localhost` / `alice@hostname`.
    let host = remote.rsplit_once('@').map(|(_, h)| h).unwrap_or(remote);
    !host.is_empty()
        && (matches!(host, "localhost" | "127.0.0.1" | "::1")
            || short_hostname()
                .map(|h| h.eq_ignore_ascii_case(host))
                .unwrap_or(false))
}

/// True when the XpairHost app process is running — then its tmux-aqua keeper is in the app's granted
/// AX/SR subtree. Guards local-direct against attaching to an orphaned/stray server. macOS-only path.
/// `app_name` comes from the config stack (a non-default APP_NAME is not exported into local shells).
fn xpair_host_running(app_name: &str) -> bool {
    Command::new("pgrep")
        .arg("-x")
        .arg(app_name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn local_tmux_aqua_ready(tmux_aqua_bin: &str, aqua_sock: &str) -> bool {
    Command::new(tmux_aqua_bin)
        .arg("-S")
        .arg(aqua_sock)
        .arg("has-session")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn list_local_sessions(tmux_aqua_bin: &str, aqua_sock: &str) -> Vec<(String, bool)> {
    match Command::new(tmux_aqua_bin)
        .arg("-S")
        .arg(aqua_sock)
        .arg("list-sessions")
        .arg("-F")
        .arg("#S\t#{session_attached}")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        Ok(out) if out.status.success() => {
            session::parse_sessions(&String::from_utf8_lossy(&out.stdout))
                .into_iter()
                .map(|session| (session.name, session.attached != 0))
                .collect()
        }
        _ => Vec::new(),
    }
}

fn write_local_respawn_script(engine: Engine, session: &str, cont: bool) -> io::Result<PathBuf> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("xpair-respawn-{}-{stamp}.sh", std::process::id()));
    fs::write(&path, respawn::build_respawn_script(engine, session, cont))?;
    Ok(path)
}

fn run_noninteractive_argv(argv: &[String]) -> Result<(), String> {
    let Some((program, args)) = argv.split_first() else {
        return Err("empty argv".to_string());
    };
    match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!(
            "{program} failed with exit {}",
            status.code().unwrap_or(1)
        )),
        Err(err) => Err(format!("{program}: {err}")),
    }
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

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn emit_terminal_title(session: &str) {
    print!("\x1b]2;{session}\x07");
}

fn spawn_and_wait(argv: &[String]) -> ExitCode {
    let Some((program, args)) = argv.split_first() else {
        return ExitCode::from(1);
    };
    match Command::new(program).args(args).status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(err) => {
            eprintln!("{program}: {err}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MockTransport;
    use std::cell::RefCell;
    use std::ffi::OsString;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct TestPath {
        path: PathBuf,
    }

    impl TestPath {
        fn new(name: &str) -> TestPath {
            let path = std::env::temp_dir().join(format!(
                "xpair-launch-test-{}-{name}.env",
                std::process::id()
            ));
            let _ = fs::remove_file(&path);
            TestPath { path }
        }

        fn write(&self, body: &str) {
            fs::write(&self.path, body).unwrap();
        }
    }

    impl Drop for TestPath {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let path = std::env::temp_dir()
                .join(format!("xpair-launch-test-{}-{name}", std::process::id()));
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
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let _guard = EnvGuard::set(values);
        f()
    }

    fn path_string(path: impl AsRef<Path>) -> String {
        path.as_ref().to_string_lossy().into_owned()
    }

    struct FakeNameExec {
        outputs: RefCell<Vec<Option<String>>>,
        calls: RefCell<Vec<(String, String)>>,
    }

    impl FakeNameExec {
        fn new(outputs: Vec<Option<&str>>) -> FakeNameExec {
            FakeNameExec {
                outputs: RefCell::new(
                    outputs
                        .into_iter()
                        .map(|value| value.map(str::to_string))
                        .collect(),
                ),
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl NameExec for FakeNameExec {
        fn output(&self, program: &Path, arg: &str) -> Option<String> {
            self.calls
                .borrow_mut()
                .push((path_string(program), arg.to_string()));
            self.outputs.borrow_mut().remove(0)
        }
    }

    fn make_executable(path: &Path) {
        fs::write(path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(path).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(path, perms).unwrap();
        }
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    fn local_existing(entries: &[(&str, bool)]) -> Vec<(String, bool)> {
        entries
            .iter()
            .map(|(name, attached)| ((*name).to_string(), *attached))
            .collect()
    }

    fn parse(args: &[&str]) -> Result<LaunchReq, (String, u8)> {
        parse_launch_args(&strings(args))
    }

    #[test]
    fn parses_all_launch_flags_and_last_positional_dir() {
        assert_eq!(
            parse(&[
                "--fresh",
                "--yes",
                "-y",
                "--engine",
                "claude-code",
                "/first",
                "/last",
            ])
            .unwrap(),
            LaunchReq {
                target_pref: None,
                fresh: true,
                yes: true,
                engine: Some("claude".to_string()),
                dir: "/last".to_string(),
            }
        );
    }

    #[test]
    fn parse_defaults_dir_to_current_marker() {
        assert_eq!(
            parse(&[]).unwrap(),
            LaunchReq {
                target_pref: None,
                fresh: false,
                yes: false,
                engine: None,
                dir: ".".to_string(),
            }
        );
    }

    #[test]
    fn parse_rejects_unknown_engine_with_exit_two() {
        assert_eq!(
            parse(&["--engine", "vim"]),
            Err((
                "unknown engine: vim (use claude|claudecode|shell|codex|opencode)".to_string(),
                2,
            ))
        );
        assert_eq!(
            parse(&["--engine"]),
            Err((
                "unknown engine:  (use claude|claudecode|shell|codex|opencode)".to_string(),
                2,
            ))
        );
        assert_eq!(
            parse(&["--local"]),
            Err(("unknown launch option: --local".to_string(), 2))
        );
        assert_eq!(
            parse(&["--remote"]),
            Err(("unknown launch option: --remote".to_string(), 2))
        );
    }

    #[test]
    fn canonical_engine_matches_bash_aliases() {
        assert_eq!(canonical_engine("claude").as_deref(), Some("claude"));
        assert_eq!(canonical_engine("claudecode").as_deref(), Some("claude"));
        assert_eq!(canonical_engine("claude-code").as_deref(), Some("claude"));
        assert_eq!(canonical_engine("shell").as_deref(), Some("shell"));
        assert_eq!(canonical_engine("codex").as_deref(), Some("codex"));
        assert_eq!(canonical_engine("opencode").as_deref(), Some("opencode"));
        assert_eq!(canonical_engine("CLAUDE"), None);
    }

    #[test]
    fn remote_engine_prefers_host_env_when_engine_omitted() {
        let tmp = TestPath::new("host-engine");
        tmp.write("ENGINE=codex\n");
        let transport = MockTransport::new();
        transport.push_response(0, "opencode\n");
        let req = parse(&[]).unwrap();

        with_env(&[("ENGINE", Some("shell"))], || {
            assert_eq!(
                resolve_remote_engine(&tmp.path, &req, "mac.local", &transport).unwrap(),
                Engine::Opencode
            );
        });

        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].remote_cmd, build_read_host_engine_remote_cmd());
    }

    #[test]
    fn remote_engine_falls_back_to_client_default_when_host_env_is_empty_or_unknown() {
        let tmp = TestPath::new("client-engine");
        tmp.write("ENGINE=codex\n");
        let transport = MockTransport::new();
        transport.push_response(0, "unknown\n");
        let req = parse(&[]).unwrap();

        assert_eq!(
            resolve_remote_engine(&tmp.path, &req, "mac.local", &transport).unwrap(),
            Engine::Codex
        );
    }

    #[test]
    fn process_engine_wins_over_client_env_when_host_engine_is_invalid() {
        let tmp = TestPath::new("process-engine");
        tmp.write("ENGINE=opencode\n");
        let transport = MockTransport::new();
        transport.push_response(0, "unknown\n");
        let req = parse(&[]).unwrap();

        with_env(&[("ENGINE", Some("codex"))], || {
            assert_eq!(
                resolve_remote_engine(&tmp.path, &req, "mac.local", &transport).unwrap(),
                Engine::Codex
            );
        });
    }

    #[test]
    fn client_env_engine_is_used_when_process_engine_is_absent() {
        let tmp = TestPath::new("file-engine");
        tmp.write("ENGINE=opencode\n");
        let transport = MockTransport::new();
        transport.push_response(0, "unknown\n");
        let req = parse(&[]).unwrap();

        with_env(&[("ENGINE", None)], || {
            assert_eq!(
                resolve_remote_engine(&tmp.path, &req, "mac.local", &transport).unwrap(),
                Engine::Opencode
            );
        });
    }

    #[test]
    fn explicit_engine_skips_host_env_probe() {
        let tmp = TestPath::new("explicit-engine");
        tmp.write("ENGINE=codex\n");
        let transport = MockTransport::new();
        let req = parse(&["--engine", "shell"]).unwrap();

        assert_eq!(
            resolve_remote_engine(&tmp.path, &req, "mac.local", &transport).unwrap(),
            Engine::Shell
        );
        assert!(transport.calls().is_empty());
    }

    #[test]
    fn mount_method_launch_rewrites_requested_dir_after_successful_mount() {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut mount_calls = Vec::new();

        let state = ensure_launch_arg_mount_best_effort_with(
            LaunchMountEnsure {
                os: Os::Mac,
                target: "/Volumes/Old/sub",
                host: "mac.local",
                raw_maps: "/Volumes/Old::/Users/me/Project",
                raw_modes: "/Volumes/Old::mount",
                mount_tool: Some(PathBuf::from("/opt/xpair/xpair-mount")),
            },
            |_| None,
            |tool, host_path| {
                mount_calls.push((tool.to_string_lossy().into_owned(), host_path.to_string()));
                Ok(MountCommandOutput {
                    success: true,
                    output: "Mountpoint: /Volumes/Project\n".to_string(),
                })
            },
            &mut out,
            &mut err,
        );

        assert_eq!(state.dir, "/Volumes/Project/sub");
        assert_eq!(state.raw_maps, "/Volumes/Project::/Users/me/Project");
        assert_eq!(
            mount_calls,
            [(
                "/opt/xpair/xpair-mount".to_string(),
                "/Users/me/Project".to_string()
            )]
        );
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Mountpoint: /Volumes/Project\n"
        );
        assert_eq!(String::from_utf8(err).unwrap(), "");
    }

    #[test]
    fn mount_method_launch_uses_existing_discovered_mountpoint_without_tool() {
        let mut out = Vec::new();
        let mut err = Vec::new();

        let state = ensure_launch_arg_mount_best_effort_with(
            LaunchMountEnsure {
                os: Os::Mac,
                target: "/Volumes/Old",
                host: "mac.local",
                raw_maps: "/Volumes/Old::/Users/me/Project",
                raw_modes: "/Volumes/Old::mount",
                mount_tool: None,
            },
            |_| Some("/Volumes/Project".to_string()),
            |_, _| panic!("mount tool should not run when discovery succeeds"),
            &mut out,
            &mut err,
        );

        assert_eq!(state.dir, "/Volumes/Project");
        assert_eq!(state.raw_maps, "/Volumes/Project::/Users/me/Project");
        assert_eq!(String::from_utf8(out).unwrap(), "");
        assert_eq!(String::from_utf8(err).unwrap(), "");
    }

    #[test]
    fn mount_method_launch_skips_non_macos_clients() {
        let mut out = Vec::new();
        let mut err = Vec::new();

        let state = ensure_launch_arg_mount_best_effort_with(
            LaunchMountEnsure {
                os: Os::Windows,
                target: "/Volumes/Old",
                host: "mac.local",
                raw_maps: "/Volumes/Old::/Users/me/Project",
                raw_modes: "/Volumes/Old::mount",
                mount_tool: Some(PathBuf::from("/opt/xpair/xpair-mount")),
            },
            |_| panic!("discovery should be skipped"),
            |_, _| panic!("mount should be skipped"),
            &mut out,
            &mut err,
        );

        assert_eq!(state.dir, "/Volumes/Old");
        assert_eq!(state.raw_maps, "/Volumes/Old::/Users/me/Project");
        assert_eq!(String::from_utf8(out).unwrap(), "");
        assert_eq!(String::from_utf8(err).unwrap(), "");
    }

    #[test]
    fn win32_launch_resolves_unc_child_under_mapped_share_root() {
        let maps = parse_maps("//office-mac.local/Project::/Users/alice/Project");

        assert_eq!(
            map_to_host_for_os(r"\\OFFICE-MAC.local\project\src", &maps, Os::Windows).unwrap(),
            "/Users/alice/Project/src"
        );
    }

    #[test]
    fn resolves_target_precedence_like_attach() {
        assert_eq!(
            resolve_target(Some(Target::Local), false, "mac"),
            Target::Local
        );
        assert_eq!(
            resolve_target(Some(Target::Remote), true, ""),
            Target::Remote
        );
        assert_eq!(resolve_target(None, true, "mac"), Target::Remote);
        assert_eq!(resolve_target(None, false, "mac"), Target::Remote);
        assert_eq!(resolve_target(None, false, ""), Target::Remote);
    }

    #[test]
    fn host_choices_list_and_autoselect() {
        use std::io::Cursor;

        assert_eq!(
            build_host_choices("mac.local", false),
            vec![HostChoice::Remote("mac.local".into())]
        );
        assert_eq!(build_host_choices("", true), vec![HostChoice::Local]);
        assert_eq!(build_host_choices("  ", false), vec![]);
        assert_eq!(
            build_host_choices("mac.local", true),
            vec![HostChoice::Remote("mac.local".into()), HostChoice::Local]
        );

        // 0 → error; 1 → auto-select (no prompt read)
        let mut out = Vec::new();
        assert!(select_host_choice(vec![], false, &mut Cursor::new(""), &mut out).is_err());
        assert_eq!(
            select_host_choice(
                vec![HostChoice::Local],
                false,
                &mut Cursor::new(""),
                &mut out
            )
            .unwrap(),
            HostChoice::Local
        );

        // >1 on a tty: pick #2 (Local); non-tty >1 errors
        let two = vec![HostChoice::Remote("mac.local".into()), HostChoice::Local];
        assert_eq!(
            select_host_choice(two.clone(), true, &mut Cursor::new("2\n"), &mut out).unwrap(),
            HostChoice::Local
        );
        assert!(select_host_choice(two, false, &mut Cursor::new(""), &mut out).is_err());

        // self-host detection: loopback literals point at this machine; empty never does. A `user@`
        // prefix is stripped before the comparison.
        assert!(remote_is_local("localhost"));
        assert!(remote_is_local("127.0.0.1"));
        assert!(remote_is_local("::1"));
        assert!(remote_is_local("alice@localhost"));
        assert!(remote_is_local("root@127.0.0.1"));
        assert!(!remote_is_local(""));
        assert!(!remote_is_local("bob@"));
    }

    #[test]
    fn derives_session_name_from_host_dir_like_launcher() {
        assert_eq!(session_name_for("/Users/me/project"), "project_8779b");
        assert_eq!(session_name_for("/srv/work/My App"), "my-app_d4b2c");
        assert_eq!(
            session_name_for("/tmp/ReallyLongProjectName"),
            "reallylongproje_bdab5"
        );
        assert_eq!(session_name_for("/Users/me/.claude"), "_claude_0bd83");
        assert_eq!(session_name_for("/"), "session_8a5ed");
        assert_eq!(
            session_name_for("/tmp/A!!--B"),
            format!("a-b_{}", sha256_hex_prefix("/tmp/A!!--B", 5))
        );
    }

    #[test]
    fn derives_default_remote_session_with_host_prefix_and_number() {
        assert_eq!(
            remote_session_name_for("mac.local", "/Users/me/project"),
            "mac_local_project_8779b_1"
        );
        assert_eq!(
            remote_session_name_for("alice@mac.local", "/Users/me/project"),
            "alice_mac_local_project_8779b_1"
        );
    }

    #[test]
    fn readable_cache_wins_before_romanizer_for_non_ascii_basename() {
        let tmp = TestDir::new("readable-cache");
        let cache_dir = tmp.path.join("session-names");
        fs::create_dir_all(&cache_dir).unwrap();
        fs::write(
            cache_dir.join(sha256_hex_prefix("프로젝트", 12)),
            "cached-project",
        )
        .unwrap();
        let exec = FakeNameExec::new(vec![Some("romanized-project")]);
        let client_dir = path_string(&tmp.path);

        with_env(
            &[("RP_CLIENT_DIR", Some(&client_dir)), ("HROMANIZE", None)],
            || {
                assert_eq!(
                    proj_base_with_exec("/Users/me/프로젝트", &exec),
                    format!(
                        "cached-project_{}",
                        sha256_hex_prefix("/Users/me/프로젝트", 5)
                    )
                );
            },
        );

        assert!(exec.calls.borrow().is_empty());
    }

    #[test]
    fn romanizer_runs_after_cache_miss_and_populates_cache() {
        let tmp = TestDir::new("readable-romanizer");
        let bin_dir = tmp.path.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let romanizer = bin_dir.join("hangul-romanize");
        make_executable(&romanizer);
        let exec = FakeNameExec::new(vec![Some("hanguk-project")]);
        let client_dir = path_string(&tmp.path);

        with_env(
            &[("RP_CLIENT_DIR", Some(&client_dir)), ("HROMANIZE", None)],
            || {
                assert_eq!(readable_basename("한국 프로젝트", &exec), "hanguk-project");
            },
        );

        assert_eq!(
            exec.calls.borrow().as_slice(),
            &[(path_string(&romanizer), "한국 프로젝트".to_string())]
        );
        assert_eq!(
            fs::read_to_string(
                tmp.path
                    .join("session-names")
                    .join(sha256_hex_prefix("한국 프로젝트", 12))
            )
            .unwrap(),
            "hanguk-project"
        );
    }

    #[test]
    fn derives_local_session_base_with_host_prefix_without_number() {
        assert_eq!(
            local_session_base_for("mac.local", "/Users/me/project"),
            "mac_local_project_8779b"
        );
    }

    #[test]
    fn picks_local_session_one_for_new_project_and_continues() {
        assert_eq!(
            pick_local_session("mac_project_8779b", &[], false),
            LocalLaunchPlan {
                session: "mac_project_8779b_1".to_string(),
                create: true,
                cont: true,
            }
        );
    }

    #[test]
    fn picks_detached_local_session_one_for_reattach() {
        assert_eq!(
            pick_local_session(
                "mac_project_8779b",
                &local_existing(&[("mac_project_8779b_1", false)]),
                false,
            ),
            LocalLaunchPlan {
                session: "mac_project_8779b_1".to_string(),
                create: false,
                cont: true,
            }
        );
    }

    #[test]
    fn picks_next_local_session_when_one_is_attached() {
        assert_eq!(
            pick_local_session(
                "mac_project_8779b",
                &local_existing(&[("mac_project_8779b_1", true)]),
                false,
            ),
            LocalLaunchPlan {
                session: "mac_project_8779b_2".to_string(),
                create: true,
                cont: false,
            }
        );
    }

    #[test]
    fn picks_fresh_local_session_by_skipping_every_existing_session() {
        assert_eq!(
            pick_local_session(
                "mac_project_8779b",
                &local_existing(&[
                    ("mac_project_8779b_1", false),
                    ("mac_project_8779b_2", true),
                    ("other_project_1", true),
                ]),
                true,
            ),
            LocalLaunchPlan {
                session: "mac_project_8779b_3".to_string(),
                create: true,
                cont: false,
            }
        );
    }

    #[test]
    fn nonfresh_local_selection_reuses_lowest_non_attached_session() {
        assert_eq!(
            pick_local_session(
                "mac_project_8779b",
                &local_existing(&[
                    ("mac_project_8779b_1", true),
                    ("mac_project_8779b_2", false),
                ]),
                false,
            ),
            LocalLaunchPlan {
                session: "mac_project_8779b_2".to_string(),
                create: false,
                cont: false,
            }
        );
    }

    #[test]
    fn builds_reuse_remote_session_command_skips_attached_before_attach_takeover() {
        let cmd = build_ensure_session_remote_cmd(
            "/tmp/aqua sock's.sock",
            "mac_project_8779b_1",
            "/Users/me/project",
            false,
        );
        assert!(cmd.contains(REMOTE_AGENT_PATH_EXPORT));
        assert!(cmd.contains("APP_NAME='XpairHost'; BUNDLE_PREFIX='com.x10lab.xpair-host';"));
        assert!(cmd.contains("FORWARD_APP='Xpair'; FORWARD_BUNDLE='com.x10lab.xpair';"));
        assert!(cmd.contains("command -v \"$RP_ENGINE\""));
        assert!(cmd.contains("open -a \"$APP_NAME\" 2>/dev/null || open -a \"$FORWARD_APP\""));
        assert!(cmd.contains("/bin/launchctl kickstart \"gui/$(id -u)/$BUNDLE_PREFIX\""));
        assert!(cmd.contains("/bin/launchctl kickstart \"gui/$(id -u)/$FORWARD_BUNDLE\""));
        assert!(cmd.contains("setup is required before this remote session can start."));
        assert!(cmd.contains("BASE='mac_project_8779b'; N=1; FRESH=0; CONT=1;"));
        assert!(cmd.contains("list-clients -t \"=${BASE}_${N}\" -F x"));
        assert!(cmd.contains("do N=$((N+1)); CONT=0; done"));
        assert!(cmd.contains("if $HOME/.local/bin/tmux-aqua -S '/tmp/aqua sock'\\''s.sock' has-session -t \"=$SESSION\" 2>/dev/null; then NEED_CREATE=0; fi"));
        assert!(cmd.contains(
            "printf '%s\\n' 'export PATH=\"$HOME/.local/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"'"
        ));
        assert!(cmd.contains("printf '__SESSION__:%s\\n' \"$SESSION\""));
    }

    #[test]
    fn builds_fresh_remote_session_command_skips_all_existing_sessions() {
        let cmd = build_ensure_session_remote_cmd(
            "/tmp/aqua-tmux.sock",
            "mac_project_8779b_1",
            "/Users/me/project",
            true,
        );
        assert!(!cmd.contains("exit 10"));
        assert!(cmd.contains("BASE='mac_project_8779b'; N=1; FRESH=1; CONT=0;"));
        assert!(cmd.contains("while $HOME/.local/bin/tmux-aqua -S '/tmp/aqua-tmux.sock' has-session -t \"=$SESSION\" 2>/dev/null"));
        assert!(cmd.contains("SESSION=\"${BASE}_${N}\""));
    }

    #[test]
    fn builds_remote_create_command_with_selected_engine_respawn_body() {
        let cmd = build_ensure_session_remote_cmd_for_engine(
            Engine::Opencode,
            "/tmp/aqua-tmux.sock",
            "mac_project_8779b_1",
            "/Users/me/project",
            false,
            true,
        );
        assert!(cmd.contains("opencode"));
        assert!(cmd.contains("OPENCODE_CONFIG_CONTENT"));
    }

    #[test]
    fn remote_setup_uses_configured_app_identity_and_forward_fallbacks() {
        let identity = AppIdentity {
            app_name: "LabHost".to_string(),
            bundle_prefix: "com.example.lab-host".to_string(),
            forward_app: "Xpair".to_string(),
            forward_bundle: "com.x10lab.xpair".to_string(),
        };
        let cmd = build_ensure_session_remote_cmd_for_engine_and_identity(
            Engine::Claude,
            "/tmp/aqua-tmux.sock",
            "mac_project_8779b_1",
            "/Users/me/project",
            false,
            true,
            &identity,
        );

        assert!(cmd.contains("APP_NAME='LabHost'; BUNDLE_PREFIX='com.example.lab-host';"));
        assert!(cmd.contains("FORWARD_APP='Xpair'; FORWARD_BUNDLE='com.x10lab.xpair';"));
        assert!(!cmd.contains("open -a \"XpairHost\""));
        assert!(cmd.contains("open -a \"$APP_NAME\""));
        assert!(cmd.contains("open -a \"$FORWARD_APP\""));
    }

    #[test]
    fn shell_remote_setup_skips_engine_preflight() {
        let cmd = build_ensure_session_remote_cmd_for_engine(
            Engine::Shell,
            "/tmp/aqua-tmux.sock",
            "mac_project_8779b_1",
            "/Users/me/project",
            false,
            true,
        );

        assert!(!cmd.contains("command -v \"$RP_ENGINE\""));
    }

    #[test]
    fn app_identity_loads_from_client_then_host_env_stack() {
        let client_env = TestPath::new("identity-client");
        let host_dir = TestDir::new("identity-host");
        client_env.write("APP_NAME=ClientHost\nBUNDLE_PREFIX=com.example.client\n");
        fs::write(
            host_dir.path.join("host.env"),
            "APP_NAME=HostHost\nBUNDLE_PREFIX=com.example.host\nFORWARD_APP=ForwardHost\nFORWARD_BUNDLE=com.example.forward\n",
        )
        .unwrap();
        let host_dir_s = path_string(&host_dir.path);

        with_env(
            &[
                ("RP_HOST_DIR", Some(&host_dir_s)),
                ("APP_NAME", Some("EnvHost")),
                ("BUNDLE_PREFIX", None),
                ("FORWARD_APP", None),
                ("FORWARD_BUNDLE", None),
            ],
            || {
                assert_eq!(
                    resolve_app_identity(&client_env.path).unwrap(),
                    AppIdentity {
                        app_name: "HostHost".to_string(),
                        bundle_prefix: "com.example.host".to_string(),
                        forward_app: "ForwardHost".to_string(),
                        forward_bundle: "com.example.forward".to_string(),
                    }
                );
            },
        );
    }

    #[test]
    fn unmapped_prompt_registers_existing_host_path_by_default() {
        let tmp = TestPath::new("unmapped-existing");
        let client = TestDir::new("unmapped-existing-client");
        // This test exercises the darwin/linux interactive flow (Os::Mac below); feed it a
        // POSIX-separator path even when the test itself runs on windows.
        let client_dir = path_string(&client.path).replace('\\', "/");
        let transport = MockTransport::new();
        transport.push_response(0, "");
        transport.push_response(0, "__YES__\n");
        let mut raw_maps = String::new();
        let mut raw_modes = String::new();
        let mut input = io::Cursor::new(b"\n".as_slice());
        let mut out = Vec::new();
        let mut err = Vec::new();

        let result = prompt_unmapped_folder_if_needed_with(
            &tmp.path,
            &transport,
            "mac.local",
            &client_dir,
            &mut raw_maps,
            &mut raw_modes,
            false,
            Os::Mac,
            &mut input,
            &mut out,
            &mut err,
        )
        .unwrap();

        assert_eq!(result, Some(client_dir.clone()));
        assert_eq!(raw_maps, format!("{client_dir}::{client_dir}"));
        assert_eq!(raw_modes, format!("{client_dir}::sync"));
        assert_eq!(
            config::get(&tmp.path, "FOLDER_MAPS").unwrap(),
            Some(format!("{client_dir}::{client_dir}"))
        );
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Register this mapping for next time? [Y/n]: "));
        assert_eq!(String::from_utf8(err).unwrap(), "");
        assert_eq!(transport.calls().len(), 2);
    }

    #[test]
    fn unmapped_missing_prompt_can_register_actual_host_path() {
        let tmp = TestPath::new("unmapped-map");
        let client = TestDir::new("unmapped-map-client");
        let client_dir = path_string(&client.path);
        let transport = MockTransport::new();
        transport.push_response(0, "");
        transport.push_response(0, "__NO__\n");
        transport.push_response(0, "__YES__\n");
        let mut raw_maps = String::new();
        let mut raw_modes = String::new();
        let mut input = io::Cursor::new(b"m\n/Users/host/project\n\n".as_slice());
        let mut out = Vec::new();
        let mut err = Vec::new();

        let result = prompt_unmapped_folder_if_needed_with(
            &tmp.path,
            &transport,
            "mac.local",
            &client_dir,
            &mut raw_maps,
            &mut raw_modes,
            false,
            Os::Linux,
            &mut input,
            &mut out,
            &mut err,
        )
        .unwrap();

        let registered_client_dir = path_string(absolutize_existing_dir(&client_dir).unwrap());
        assert_eq!(result, Some("/Users/host/project".to_string()));
        assert_eq!(
            raw_maps,
            format!("{registered_client_dir}::/Users/host/project")
        );
        assert_eq!(raw_modes, format!("{registered_client_dir}::sync"));
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("[m] map to the host path that actually has this content"));
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("not found on mac.local"));
    }

    #[test]
    fn unmapped_prompt_is_skipped_for_yes_and_windows() {
        let tmp = TestPath::new("unmapped-skip");
        let transport = MockTransport::new();
        let mut raw_maps = String::new();
        let mut raw_modes = String::new();
        let mut input = io::Cursor::new([].as_slice());
        let mut out = Vec::new();
        let mut err = Vec::new();

        assert_eq!(
            prompt_unmapped_folder_if_needed_with(
                &tmp.path,
                &transport,
                "mac.local",
                "/client",
                &mut raw_maps,
                &mut raw_modes,
                true,
                Os::Mac,
                &mut input,
                &mut out,
                &mut err,
            )
            .unwrap(),
            None
        );
        assert_eq!(
            prompt_unmapped_folder_if_needed_with(
                &tmp.path,
                &transport,
                "mac.local",
                "/client",
                &mut raw_maps,
                &mut raw_modes,
                false,
                Os::Windows,
                &mut input,
                &mut out,
                &mut err,
            )
            .unwrap(),
            None
        );
        assert!(transport.calls().is_empty());
    }

    #[test]
    fn remote_host_dir_check_command_uses_markers() {
        assert_eq!(
            build_remote_host_dir_check_cmd("/Users/me/project"),
            "[ -d '/Users/me/project' ] && echo __YES__ || echo __NO__"
        );
    }

    #[test]
    fn remote_host_dir_missing_with_yes_creates_before_setup() {
        let transport = MockTransport::new();
        transport.push_response(0, "__NO__\n");
        transport.push_response(0, "");

        assert_eq!(
            ensure_remote_host_dir_ready(&transport, "mac.local", "/Users/me/new", true),
            Ok(())
        );

        let calls = transport.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0].remote_cmd,
            "[ -d '/Users/me/new' ] && echo __YES__ || echo __NO__"
        );
        assert_eq!(calls[1].remote_cmd, "mkdir -p '/Users/me/new'");
    }

    #[test]
    fn remote_host_dir_unknown_reports_disconnect_guidance() {
        let transport = MockTransport::new();

        assert_eq!(
            ensure_remote_host_dir_ready(&transport, "mac.local", "/Users/me/new", true),
            Err((remote_disconnect_message("mac.local"), 21))
        );

        assert_eq!(transport.calls().len(), 3);
    }

    #[test]
    fn builds_local_new_session_argv_exactly() {
        assert_eq!(
            build_local_new_session_argv(
                "/Users/me/.local/bin/tmux-aqua",
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                "/var/tmp/xpair-respawn.123",
            ),
            vec![
                "/Users/me/.local/bin/tmux-aqua",
                "-S",
                "/tmp/aqua-tmux.sock",
                "new-session",
                "-d",
                "-s",
                "mac_project_8779b_1",
                "-c",
                "/Users/me/project",
                "bash /var/tmp/xpair-respawn.123",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn builds_local_launch_attach_argv_exactly() {
        assert_eq!(
            build_local_launch_attach_argv(
                "/Users/me/.local/bin/tmux-aqua",
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
            ),
            vec![
                "/Users/me/.local/bin/tmux-aqua",
                "-S",
                "/tmp/aqua-tmux.sock",
                "attach",
                "-d",
                "-t",
                "=mac_project_8779b_1",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn builds_windows_remote_launch_attach_argv_with_mux_neutralizer() {
        let argv = build_remote_launch_attach_argv(
            Os::Windows,
            "mac.local",
            "/tmp/aqua sock's.sock",
            "mac_project_8779b_1",
        );
        assert_eq!(
            &argv[..7],
            strings(&[
                "ssh",
                "-tt",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "mac.local",
            ])
            .as_slice()
        );
        let cmd = argv.last().unwrap();
        assert!(cmd.contains(r#"SOCK='/tmp/aqua sock'\''s.sock'"#));
        assert!(cmd.contains("TARGET='=mac_project_8779b_1'"));
        assert!(cmd.contains("detach-client -s \"$TARGET\""));
        assert!(cmd.contains("attach -d -t \"$TARGET\""));
    }

    #[test]
    fn builds_non_windows_remote_launch_attach_argv_without_mux_neutralizer() {
        let argv = build_remote_launch_attach_argv(
            Os::Linux,
            "mac.local",
            "/tmp/aqua-tmux.sock",
            "mac_project_8779b_1",
        );
        assert_eq!(&argv[..3], strings(&["ssh", "-tt", "mac.local"]).as_slice());
        let cmd = argv.last().unwrap();
        assert!(cmd.contains("SOCK='/tmp/aqua-tmux.sock'"));
        assert!(cmd.contains("TARGET='=mac_project_8779b_1'"));
        assert!(cmd.contains("detach-client -s \"$TARGET\""));
        assert!(cmd.contains("attach -d -t \"$TARGET\""));
    }

    #[test]
    fn ensure_remote_session_records_exact_command_and_maps_exit_code() {
        let transport = MockTransport::new();
        transport.push_response(0, "");
        transport.push_response(12, "nope");

        assert_eq!(
            ensure_remote_session(
                &transport,
                "mac.local",
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                false,
                Engine::Codex,
            ),
            Ok("mac_project_8779b_1".to_string())
        );
        assert_eq!(
            ensure_remote_session(
                &transport,
                "mac.local",
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                false,
                Engine::Codex,
            ),
            Err("remote launch setup failed (exit=12)\nnope".to_string())
        );

        let calls = transport.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].host, "mac.local");
        assert_eq!(
            calls[0].remote_cmd,
            build_ensure_session_remote_cmd_for_engine(
                Engine::Codex,
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                false,
                true,
            )
        );
        assert_eq!(calls[1], calls[0]);
    }

    #[test]
    fn ensure_remote_session_returns_emitted_fresh_session_marker() {
        let transport = MockTransport::new();
        transport.push_response(0, "setup\n__SESSION__:mac_project_8779b_2\n");

        assert_eq!(
            ensure_remote_session(
                &transport,
                "mac.local",
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                true,
                Engine::Claude,
            ),
            Ok("mac_project_8779b_2".to_string())
        );
    }
}
