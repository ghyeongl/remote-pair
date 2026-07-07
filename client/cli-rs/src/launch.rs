//! Launch a folder into a tmux-aqua session.
//!
//! Ports the decision layer of `cmd_launch()` from `client/cli/xpair:885-960`
//! plus the portable remote session construction from `client/cli/xpair-launch`.
//! The host-probe onboarding branch (`client/cli/xpair:919-953`) remains deferred.
//! Local launch keeps the macOS-only process boundary small while the naming and
//! session-selection core stays pure and tested.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

pub use crate::attach::Target;
use crate::config;
use crate::mapping::{map_to_host_for_os, parse_maps};
use crate::platform::Os;
use crate::remote_quote;
use crate::respawn::{self, Engine};
use crate::session::{self, SshTransport};
use crate::transport::Transport;

const ENGINE_USAGE: &str = "claude|claudecode|shell|codex|opencode";
const REMOTE_BIN: &str = "$HOME/.local/bin";
const TMUX_AQUA: &str = "tmux-aqua";

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

/// Derive the default remote tmux session name for the mapped host dir.
///
/// The bash launcher computes `REMOTE_PROJ="${REMOTE_HOST}_$(_proj_base "$HOST_DIR")"`
/// and then appends `_N` during remote setup. This Rust slice does not yet port the live
/// client/zombie tab numbering probe, so the default deterministic handoff is `_1`.
pub fn remote_session_name_for(host: &str, host_dir: &str) -> String {
    format!(
        "{}_1",
        normalize_session_name(&format!("{host}_{}", proj_base(host_dir)))
    )
}

/// Derive the local tmux session base from the local host and project dir.
///
/// Bash computes `LOCAL_PROJ="${LOCAL_HOST}_$(_proj_base "$PROJECT_DIR")"`
/// and then normalizes `.`/`:` in `client/cli/xpair-launch:504-509`.
pub fn local_session_base_for(local_host: &str, project_dir: &str) -> String {
    normalize_session_name(&format!("{local_host}_{}", session_name_for(project_dir)))
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
    if fresh {
        return build_fresh_remote_create_loop(aqua_sock, session, host_dir, engine);
    }

    let has = remote_has_session_cmd(aqua_sock, session);
    let new = remote_new_session_cmd(aqua_sock, session, host_dir, engine, cl_continue);
    format!("{has} || {{ {new}; }}")
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
    let remote_cmd = build_ensure_session_remote_cmd_for_engine(
        engine, aqua_sock, session, host_dir, fresh, !fresh,
    );
    let out = transport
        .ssh_exec(host, &remote_cmd)
        .map_err(|err| format!("remote launch setup failed: {err}"))?;

    if out.code == 0 {
        Ok(extract_session_marker(&out.stdout).unwrap_or_else(|| session.to_string()))
    } else {
        Err(format!("remote launch setup failed (exit={})", out.code))
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

    match resolve_target(req.target_pref, local_mode, &host) {
        Target::Local => run_local(&path, &host, &req),
        Target::Remote => run_remote(&path, &host, local_mode, &req),
    }
}

fn run_local(path: &Path, host: &str, req: &LaunchReq) -> ExitCode {
    if Os::current() != Os::Mac {
        eprintln!("local launch is only available on a macOS host (use --remote)");
        return ExitCode::from(2);
    }
    run_local_macos(path, host, req)
}

fn run_local_macos(path: &Path, host: &str, req: &LaunchReq) -> ExitCode {
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
    let aqua_sock = resolve_aqua_sock();
    let engine = match resolve_engine(path, req) {
        Ok(engine) => engine,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(2);
        }
    };

    // macOS-only runtime boundary: the bash launcher starts XpairHost via `open -a`,
    // waits for launchctl/tmux-aqua readiness, then performs the local tmux handoff.
    if !ensure_local_host(path, host, &tmux_aqua_bin, &aqua_sock) {
        eprintln!("XpairHost tmux-aqua server is not ready on {aqua_sock}");
        return ExitCode::from(1);
    }

    let proj = local_session_base_for(&local_host, &project_dir);
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

    let dir = match absolutize_existing_dir(&req.dir) {
        Ok(dir) => dir,
        Err(_) => {
            eprintln!("folder not found");
            return ExitCode::from(1);
        }
    };
    let raw_maps = match resolve_raw_maps(path) {
        Ok(raw_maps) => raw_maps,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    let pairs = parse_maps(&raw_maps);
    let client_dir = dir.to_string_lossy().into_owned();
    let host_dir = match map_to_host_for_os(&client_dir, &pairs, Os::current()) {
        Ok(host_dir) => host_dir,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(2);
        }
    };
    // Deferred: the interactive unmapped-dir host probe from `client/cli/xpair:919-953`.
    // The Rust path maps deterministically and lets the remote tmux setup surface failures.

    let aqua_sock = resolve_aqua_sock();
    let session = remote_session_name_for(host, &host_dir);
    let engine = match resolve_engine(path, req) {
        Ok(engine) => engine,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(2);
        }
    };
    let transport = SshTransport;
    let session = match ensure_remote_session(
        &transport, host, &aqua_sock, &session, &host_dir, req.fresh, engine,
    ) {
        Ok(session) => session,
        Err(err) => {
            eprintln!("xpair launch: {err}");
            return ExitCode::from(1);
        }
    };
    if local_mode {
        let _ = config::set(path, "LOCAL_MODE", "0");
    }

    emit_terminal_title(&session);
    spawn_and_wait(&build_remote_launch_attach_argv(
        Os::current(),
        host,
        &aqua_sock,
        &session,
    ))
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
    let script = respawn::build_respawn_script(engine, session, cl_continue);
    let script = remote_quote::posix_single_quote(&script);
    format!(
        "T=$(mktemp -t claude-respawn.XXXXXX) && printf %s {script} > \"$T\" && {REMOTE_BIN}/{TMUX_AQUA} -S {sock} new-session -d -s {session_q} -c {host_dir} \"bash $T\""
    )
}

fn build_fresh_remote_create_loop(
    aqua_sock: &str,
    session: &str,
    host_dir: &str,
    engine: Engine,
) -> String {
    let Some((base, n)) = split_numbered_session(session) else {
        return remote_new_session_cmd(aqua_sock, session, host_dir, engine, false);
    };
    let sock = remote_quote::posix_single_quote(aqua_sock);
    let base_q = remote_quote::posix_single_quote(&base);
    let host_dir_q = remote_quote::posix_single_quote(host_dir);
    let script = remote_quote::posix_single_quote(&respawn::build_respawn_script(
        engine,
        "__XPAIR_SESSION__",
        false,
    ));
    format!(
        concat!(
            "BASE={base_q}; N={n}; ",
            "while {REMOTE_BIN}/{TMUX_AQUA} -S {sock} has-session -t \"=${{BASE}}_${{N}}\" 2>/dev/null; do N=$((N+1)); done; ",
            "SESSION=\"${{BASE}}_${{N}}\"; ",
            "T=$(mktemp -t claude-respawn.XXXXXX) && ",
            "printf %s {script} | sed \"s/__XPAIR_SESSION__/$SESSION/g\" > \"$T\" && ",
            "{REMOTE_BIN}/{TMUX_AQUA} -S {sock} new-session -d -s \"$SESSION\" -c {host_dir_q} \"bash $T\" && ",
            "printf '__SESSION__:%s\\n' \"$SESSION\""
        ),
        base_q = base_q,
        n = n,
        REMOTE_BIN = REMOTE_BIN,
        TMUX_AQUA = TMUX_AQUA,
        sock = sock,
        script = script,
        host_dir_q = host_dir_q
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
        None => config::get_cli(path, "engine").map_err(|err| err.to_string())?,
    };
    canonical_engine(&raw)
        .map(|engine| Engine::from_canonical(&engine))
        .ok_or_else(|| format!("unknown engine: {raw} (use {ENGINE_USAGE})"))
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
    let mut name = sanitize_readable_name(&basename);
    if name.is_empty() {
        name = "session".to_string();
    }
    format!("{}_{}", name, sha256_hex_prefix(host_dir, 5))
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
        if keep {
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

fn resolve_aqua_sock() -> String {
    non_empty_env("AQUA_SOCK").unwrap_or_else(|| session::DEFAULT_AQUA_SOCK.to_string())
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

fn ensure_local_host(path: &Path, remote_host: &str, tmux_aqua_bin: &str, aqua_sock: &str) -> bool {
    if !local_host_role_expected(path, remote_host) || !program_present(Path::new(tmux_aqua_bin)) {
        return false;
    }

    let app_name = non_empty_env("APP_NAME").unwrap_or_else(|| "XpairHost".to_string());
    let _ = Command::new("open")
        .arg("-a")
        .arg(app_name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if local_tmux_aqua_ready(tmux_aqua_bin, aqua_sock) {
        return true;
    }
    for _ in 0..8 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if local_tmux_aqua_ready(tmux_aqua_bin, aqua_sock) {
            return true;
        }
    }
    false
}

fn local_host_role_expected(path: &Path, remote_host: &str) -> bool {
    let Some(rp_dir) = path.parent() else {
        return false;
    };
    let role = fs::read_to_string(rp_dir.join("role"))
        .unwrap_or_default()
        .trim()
        .to_string();
    match role.as_str() {
        "host" | "both" => true,
        "client" => false,
        _ if rp_dir.join("host.env").is_file() => short_hostname()
            .map(|host| remote_host.is_empty() || host == remote_host)
            .unwrap_or(false),
        _ => false,
    }
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
                .map(|session| (session.name, session.attached))
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

    fn expected_remote_new_session_cmd(
        engine: Engine,
        aqua_sock: &str,
        session: &str,
        host_dir: &str,
        cl_continue: bool,
    ) -> String {
        let sock = remote_quote::posix_single_quote(aqua_sock);
        let session_q = remote_quote::posix_single_quote(session);
        let host_dir_q = remote_quote::posix_single_quote(host_dir);
        let script = remote_quote::posix_single_quote(&respawn::build_respawn_script(
            engine,
            session,
            cl_continue,
        ));
        format!(
            "T=$(mktemp -t claude-respawn.XXXXXX) && printf %s {script} > \"$T\" && {REMOTE_BIN}/{TMUX_AQUA} -S {sock} new-session -d -s {session_q} -c {host_dir_q} \"bash $T\""
        )
    }

    fn expected_ensure_remote_session_cmd(
        engine: Engine,
        aqua_sock: &str,
        session: &str,
        host_dir: &str,
        fresh: bool,
        cl_continue: bool,
    ) -> String {
        if fresh {
            build_fresh_remote_create_loop(aqua_sock, session, host_dir, engine)
        } else {
            let sock = remote_quote::posix_single_quote(aqua_sock);
            let target = remote_quote::posix_single_quote(&format!("={session}"));
            let has =
                format!("{REMOTE_BIN}/{TMUX_AQUA} -S {sock} has-session -t {target} 2>/dev/null");
            let new =
                expected_remote_new_session_cmd(engine, aqua_sock, session, host_dir, cl_continue);
            format!("{has} || {{ {new}; }}")
        }
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
    fn derives_session_name_from_host_dir_like_launcher() {
        assert_eq!(session_name_for("/Users/me/project"), "project_8779b");
        assert_eq!(session_name_for("/srv/work/My App"), "my-app_d4b2c");
        assert_eq!(
            session_name_for("/tmp/ReallyLongProjectName"),
            "reallylongproje_bdab5"
        );
        assert_eq!(session_name_for("/Users/me/.claude"), "_claude_0bd83");
        assert_eq!(session_name_for("/"), "session_8a5ed");
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
    fn builds_reuse_remote_session_command_exactly() {
        assert_eq!(
            build_ensure_session_remote_cmd(
                "/tmp/aqua sock's.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                false,
            ),
            expected_ensure_remote_session_cmd(
                Engine::Claude,
                "/tmp/aqua sock's.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                false,
                true,
            )
        );
    }

    #[test]
    fn builds_fresh_remote_session_command_exactly() {
        let cmd = build_ensure_session_remote_cmd(
            "/tmp/aqua-tmux.sock",
            "mac_project_8779b_1",
            "/Users/me/project",
            true,
        );
        assert_eq!(
            cmd,
            expected_ensure_remote_session_cmd(
                Engine::Claude,
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                true,
                false,
            )
        );
        assert!(!cmd.contains("exit 10"));
        assert!(cmd.contains("while $HOME/.local/bin/tmux-aqua"));
        assert!(cmd.contains("SESSION=\"${BASE}_${N}\""));
    }

    #[test]
    fn builds_remote_create_command_with_selected_engine_respawn_body() {
        assert_eq!(
            build_ensure_session_remote_cmd_for_engine(
                Engine::Opencode,
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                false,
                true,
            ),
            expected_ensure_remote_session_cmd(
                Engine::Opencode,
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
                "/Users/me/project",
                false,
                true,
            )
        );
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
        assert_eq!(
            build_remote_launch_attach_argv(
                Os::Windows,
                "mac.local",
                "/tmp/aqua sock's.sock",
                "mac_project_8779b_1",
            ),
            vec![
                "ssh",
                "-tt",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "mac.local",
                "$HOME/.local/bin/tmux-aqua -S '/tmp/aqua sock'\\''s.sock' attach -d -t '=mac_project_8779b_1'",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn builds_non_windows_remote_launch_attach_argv_without_mux_neutralizer() {
        assert_eq!(
            build_remote_launch_attach_argv(
                Os::Linux,
                "mac.local",
                "/tmp/aqua-tmux.sock",
                "mac_project_8779b_1",
            ),
            vec![
                "ssh",
                "-tt",
                "mac.local",
                "$HOME/.local/bin/tmux-aqua -S '/tmp/aqua-tmux.sock' attach -d -t '=mac_project_8779b_1'",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
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
            Err("remote launch setup failed (exit=12)".to_string())
        );

        let calls = transport.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].host, "mac.local");
        assert_eq!(
            calls[0].remote_cmd,
            expected_ensure_remote_session_cmd(
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
