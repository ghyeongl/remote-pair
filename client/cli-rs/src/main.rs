//! `xpair` CLI entry point (P0 dispatch skeleton).
//!
//! Subcommands are ported incrementally (P1+) behind this stable surface; until a command is
//! ported it returns exit 2 with a clear "not yet implemented" message. The canonical command
//! set mirrors the bash dispatch at `client/cli/xpair:2261-2287`.

use std::fs;
use std::path::Path;
use std::process::ExitCode;
use xpair::approve;
use xpair::attach;
use xpair::config;
use xpair::discover;
use xpair::doctor;
use xpair::host;
use xpair::host_permissions;
use xpair::install_host;
use xpair::launch;
use xpair::logs;
use xpair::mapping::{
    canonicalize_client_path, client_path_eq_for_os, client_path_eq_or_child_for_os,
    discover_unc_for_hostpath, normalize_client_path_for_persistence,
    normalize_folder_maps_for_persistence, parse_maps, FolderMap,
};
use xpair::notify;
use xpair::open_gui;
use xpair::platform::Os;
use xpair::session::{self, SshTransport};
use xpair::status;
use xpair::tools;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Canonical subcommands (parity target with the bash CLI). `roots` is a legacy alias of `map`.
const SUBCOMMANDS: &[&str] = &[
    "launch",
    "attach",
    "ls",
    "map",
    "config",
    "onboard",
    "open-gui",
    "discover",
    "install-host",
    "host-permissions",
    "doctor",
    "approve",
    "status",
    "editor",
    "desktop",
    "mount",
    "notify",
    "logs",
    "self-update",
    "update",
    "host",
];

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("help");

    match cmd {
        "--version" | "-V" | "version" => {
            println!("xpair {VERSION}");
            if args.get(1).is_some_and(|arg| arg == "--verbose") {
                println!(
                    "bridge-serving-marker {}",
                    host_permissions::BRIDGE_SERVING_MARKER
                );
            }
            ExitCode::SUCCESS
        }
        "__caps" => {
            println!(
                "bridge-serving-marker {}",
                host_permissions::BRIDGE_SERVING_MARKER
            );
            ExitCode::SUCCESS
        }
        "--help" | "-h" | "help" => {
            print_help();
            ExitCode::SUCCESS
        }
        "doctor" => doctor::run(&args[1..]),
        "host" => host::run(&args[1..]),
        "approve" => approve::run(&args[1..]),
        "discover" => discover::run(&args[1..]),
        "launch" => launch::run(&args[1..]),
        "open-gui" => open_gui::run(&args[1..]),
        "attach" => attach::run(&args[1..]),
        "ls" => cmd_ls(&args[1..]),
        "status" => cmd_status(&args[1..]),
        "logs" => logs::run(&args[1..]),
        "notify" => notify::run(&args[1..]),
        "install-host" => install_host::run(&args[1..]),
        "host-permissions" => host_permissions::run(&args[1..]),
        "editor" => run_tool_or_windows_gate("editor", "xpair-editor", &args[1..]),
        "desktop" => run_tool_or_windows_gate("desktop", "xpair-desktop", &args[1..]),
        "mount" => run_tool_or_windows_gate("mount", "xpair-mount", &args[1..]),
        "map" => cmd_map(&args[1..]),
        "config" => run_config(&args[1..]),
        "onboard" => {
            eprintln!(
                "xpair onboard: IDE onboarding drives the flow — native CLI onboard is deferred"
            );
            ExitCode::from(2)
        }
        // `roots` is a legacy alias of `map` (client/cli/xpair:2266).
        "roots" => cmd_map(&args[1..]),
        other if SUBCOMMANDS.contains(&other) => {
            eprintln!(
                "xpair: '{other}' is not yet ported to the native client (Rust port in progress)"
            );
            ExitCode::from(2)
        }
        other => {
            eprintln!("xpair: unknown command '{other}'");
            eprintln!("try `xpair help`");
            ExitCode::from(2)
        }
    }
}

fn print_help() {
    println!("xpair {VERSION} — cross-platform client CLI");
    println!();
    println!("usage: xpair <command> [args]");
    println!();
    println!("commands:");
    for c in SUBCOMMANDS {
        println!("  {c}");
    }
    println!();
    println!(
        "(native Rust client — port in progress; onboard deferred to IDE onboarding; self-update remaining)"
    );
}

fn cmd_status(args: &[String]) -> ExitCode {
    if !args.is_empty() {
        eprintln!("usage: xpair status");
        return ExitCode::from(2);
    }

    let path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair status: {err}");
            return ExitCode::from(2);
        }
    };

    let host = match resolve_host(&path) {
        Ok(host) => host,
        Err(err) => {
            eprintln!("xpair status: {err}");
            return ExitCode::from(1);
        }
    };
    let aqua_sock = match resolve_aqua_sock(&path) {
        Ok(aqua_sock) => aqua_sock,
        Err(err) => {
            eprintln!("xpair status: {err}");
            return ExitCode::from(1);
        }
    };
    let status_json = match fs::read_to_string(status::status_file_path(&path)) {
        Ok(status_json) => Some(status_json),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            eprintln!("xpair status: {err}");
            return ExitCode::from(1);
        }
    };
    let transport = SshTransport;

    print!(
        "{}",
        status::render_status(
            &transport,
            &host,
            &aqua_sock,
            status_json.as_deref(),
            status::now_ts()
        )
    );
    ExitCode::SUCCESS
}

fn cmd_map(args: &[String]) -> ExitCode {
    let path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair map: {err}");
            return ExitCode::from(2);
        }
    };
    let verb = args.first().map(String::as_str).unwrap_or("list");

    match verb {
        "list" | "" => {
            if args.len() > 2 || args.get(1).is_some_and(|arg| arg != "--json") {
                eprintln!(
                    "map [list|add <clientDir> <hostDir> [--method mount|sync]|rm <clientDir>]"
                );
                return ExitCode::from(2);
            }
            let raw_maps = match resolve_raw_maps(&path) {
                Ok(raw_maps) => raw_maps,
                Err(err) => {
                    eprintln!("xpair map: {err}");
                    return ExitCode::from(1);
                }
            };
            let raw_modes = match resolve_raw_modes(&path) {
                Ok(raw_modes) => raw_modes,
                Err(err) => {
                    eprintln!("xpair map: {err}");
                    return ExitCode::from(1);
                }
            };
            let os = Os::current();
            let pairs = normalize_folder_maps_for_persistence(parse_maps(&raw_maps), os);
            let modes = normalize_folder_maps_for_persistence(parse_maps(&raw_modes), os);
            if args.get(1).is_some_and(|arg| arg == "--json") {
                println!("{}", render_map_json(&pairs, &modes));
            } else {
                print!("{}", render_map_list(&pairs));
            }
            ExitCode::SUCCESS
        }
        "add" => {
            let add = match parse_map_add_args(&args[1..]) {
                Ok(add) => add,
                Err(message) => {
                    eprintln!("{message}");
                    return ExitCode::from(2);
                }
            };
            let os = Os::current();
            if let Err(message) = validate_map_add_args_for_os(&add, os) {
                eprintln!("{message}");
                return ExitCode::from(2);
            }
            let client_dir = match canonical_client_dir_for_os(&add.client, os) {
                Ok(dir) => dir,
                Err(err) => {
                    eprintln!("{err}");
                    return ExitCode::from(1);
                }
            };
            let raw_maps = match resolve_raw_maps(&path) {
                Ok(raw_maps) => raw_maps,
                Err(err) => {
                    eprintln!("xpair map: {err}");
                    return ExitCode::from(1);
                }
            };
            let pairs = parse_maps(&raw_maps);
            if is_mapped(&client_dir, &pairs, os) {
                println!("already mapped (or under a mapped root): {client_dir}");
                return ExitCode::SUCCESS;
            }

            let method = add
                .method
                .unwrap_or_else(|| infer_map_method_for_os(&client_dir, os));
            if !matches!(method.as_str(), "mount" | "sync") {
                eprintln!("invalid method: {method} (mount|sync)");
                return ExitCode::from(2);
            }

            let host_dir = add.host.unwrap_or_else(|| client_dir.clone());
            let new_maps = append_folder_map_for_os(&raw_maps, &client_dir, &host_dir, os);
            if let Err(err) = config::set(&path, "FOLDER_MAPS", &new_maps) {
                eprintln!("xpair map: {err}");
                return ExitCode::from(1);
            }
            if let Err(err) = set_map_mode_for_os(&path, &client_dir, &method, os) {
                eprintln!("xpair map: {err}");
                return ExitCode::from(1);
            }
            println!("mapping added: {client_dir}  →  {host_dir} ({method})");
            ExitCode::SUCCESS
        }
        "rm" => {
            if args.len() != 2 || args[1].is_empty() {
                eprintln!("map rm <clientDir>");
                return ExitCode::from(2);
            }
            let os = Os::current();
            let client_dir = canonical_client_dir_for_os(&args[1], os)
                .unwrap_or_else(|_| normalize_client_dir_literal_for_os(&args[1], os));
            let raw_maps = match resolve_raw_maps_with_source(&path) {
                Ok(raw_maps) => raw_maps,
                Err(err) => {
                    eprintln!("xpair map: {err}");
                    return ExitCode::from(1);
                }
            };
            let kept = remove_client_from_raw_maps(&raw_maps.value, &client_dir, os);
            if let Err(err) = config::set(&path, "FOLDER_MAPS", &kept) {
                eprintln!("xpair map: {err}");
                return ExitCode::from(1);
            }
            if kept.is_empty()
                && matches!(
                    raw_maps.source,
                    RawMapsSource::FileFolderMaps | RawMapsSource::FileSyncRoots
                )
            {
                match config::get(&path, "SYNC_ROOTS") {
                    Ok(Some(sync_roots)) if !sync_roots.is_empty() => {
                        if let Err(err) = config::set(&path, "SYNC_ROOTS", "") {
                            eprintln!("xpair map: {err}");
                            return ExitCode::from(1);
                        }
                    }
                    Ok(_) => {}
                    Err(err) => {
                        eprintln!("xpair map: {err}");
                        return ExitCode::from(1);
                    }
                }
            }
            if let Err(err) = remove_map_mode_for_os(&path, &client_dir, os) {
                eprintln!("xpair map: {err}");
                return ExitCode::from(1);
            }
            println!("mapping removed: {client_dir}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("map [list|add <clientDir> <hostDir> [--method mount|sync]|rm <clientDir>]");
            ExitCode::from(2)
        }
    }
}

fn cmd_ls(args: &[String]) -> ExitCode {
    let json = match args {
        [] => false,
        [flag] if flag == "--json" => true,
        _ => {
            eprintln!("usage: xpair ls [--json]");
            return ExitCode::from(2);
        }
    };

    let path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair ls: {err}");
            return ExitCode::from(2);
        }
    };

    let host = match resolve_host(&path) {
        Ok(host) => host,
        Err(err) => {
            eprintln!("xpair ls: {err}");
            return ExitCode::from(1);
        }
    };
    let aqua_sock = match resolve_aqua_sock(&path) {
        Ok(aqua_sock) => aqua_sock,
        Err(err) => {
            eprintln!("xpair ls: {err}");
            return ExitCode::from(1);
        }
    };
    let transport = SshTransport;

    if json {
        let output = if host.is_empty() {
            Ok(session::render_json("host", "", &[]))
        } else {
            session::render_remote_json_checked(&transport, &host, &aqua_sock)
        };
        return match output {
            Ok(output) => {
                println!("{output}");
                ExitCode::SUCCESS
            }
            Err(session::RemoteListError::Transport) => {
                eprintln!(
                    "warning: session listing failed — host '{host}' unreachable (ssh transport)"
                );
                ExitCode::from(3)
            }
        };
    }

    let raw_maps = match resolve_raw_maps(&path) {
        Ok(raw_maps) => raw_maps,
        Err(err) => {
            eprintln!("xpair ls: {err}");
            return ExitCode::from(1);
        }
    };
    let pairs = normalize_folder_maps_for_persistence(parse_maps(&raw_maps), Os::current());
    let map_list = render_map_list(&pairs);
    let output = if host.is_empty() {
        session::render_text("host", "", "", &map_list)
    } else {
        session::render_remote_text(&transport, &host, &aqua_sock, &map_list)
    };
    print!("{output}");
    ExitCode::SUCCESS
}

fn render_map_list(pairs: &[(String, String)]) -> String {
    let mut out = String::from("Folder mappings (client → host):\n");
    if pairs.is_empty() {
        out.push_str("  (none)\n");
        return out;
    }

    for (client, host) in pairs {
        out.push_str("  ");
        out.push_str(client);
        out.push_str("  →  ");
        out.push_str(host);
        out.push('\n');
    }
    out
}

fn resolve_host(path: &Path) -> std::io::Result<String> {
    if let Some(host) = non_empty_env("REMOTE_HOST") {
        config::require_valid_host(&host)?;
        return Ok(host);
    }
    config::get_cli(path, "host")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawMapsSource {
    EnvFolderMaps,
    EnvSyncRoots,
    FileFolderMaps,
    FileSyncRoots,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawMaps {
    value: String,
    source: RawMapsSource,
}

fn resolve_raw_maps(path: &Path) -> std::io::Result<String> {
    Ok(resolve_raw_maps_with_source(path)?.value)
}

fn resolve_raw_maps_with_source(path: &Path) -> std::io::Result<RawMaps> {
    if let Some(raw_maps) = non_empty_env("FOLDER_MAPS") {
        return Ok(RawMaps {
            value: raw_maps,
            source: RawMapsSource::EnvFolderMaps,
        });
    }
    if let Some(raw_maps) = non_empty_env("SYNC_ROOTS") {
        return Ok(RawMaps {
            value: raw_maps,
            source: RawMapsSource::EnvSyncRoots,
        });
    }
    if let Some(raw_maps) = config::get(path, "FOLDER_MAPS")?.filter(|maps| !maps.is_empty()) {
        return Ok(RawMaps {
            value: raw_maps,
            source: RawMapsSource::FileFolderMaps,
        });
    }
    let value = config::get(path, "SYNC_ROOTS")?.unwrap_or_default();
    let source = if value.is_empty() {
        RawMapsSource::None
    } else {
        RawMapsSource::FileSyncRoots
    };
    Ok(RawMaps { value, source })
}

fn resolve_raw_modes(path: &Path) -> std::io::Result<String> {
    if let Some(raw_modes) = non_empty_env("FOLDER_MAP_MODES") {
        return Ok(raw_modes);
    }
    Ok(config::get(path, "FOLDER_MAP_MODES")?.unwrap_or_default())
}

struct MapAddArgs {
    client: String,
    host: Option<String>,
    method: Option<String>,
}

fn parse_map_add_args(args: &[String]) -> Result<MapAddArgs, String> {
    if args.is_empty() {
        return Err("map add <clientDir> <hostDir> [--method mount|sync]".to_string());
    }

    let client = args[0].clone();
    let mut host = None;
    let mut method = None;
    let mut idx = 1;
    while idx < args.len() {
        match args[idx].as_str() {
            "--method" => {
                let Some(value) = args.get(idx + 1) else {
                    return Err("map add <clientDir> <hostDir> [--method mount|sync]".to_string());
                };
                method = Some(value.clone());
                idx += 2;
            }
            value if value.starts_with("--") => {
                return Err(format!("unknown map add option: {value}"));
            }
            value => {
                if host.is_none() {
                    host = Some(value.to_string());
                } else if method.is_none() {
                    method = Some(value.to_string());
                } else {
                    return Err("map add <clientDir> <hostDir> [--method mount|sync]".to_string());
                }
                idx += 1;
            }
        }
    }

    Ok(MapAddArgs {
        client,
        host,
        method,
    })
}

fn validate_map_add_args_for_os(add: &MapAddArgs, os: Os) -> Result<(), String> {
    if os != Os::Windows {
        return Ok(());
    }

    if add.host.is_none() {
        return Err(
            "map add on Windows requires an explicit mac host path: xpair map add <clientDir> <hostDir>"
                .to_string(),
        );
    }
    if add.method.as_deref() == Some("sync") {
        return Err(
            "sync mappings are not supported on Windows yet; use a UNC or mapped-drive path with --method mount"
                .to_string(),
        );
    }

    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClientDirError {
    NotFound { path: String },
    UncUnavailable { path: String, unc: String },
    Invalid { message: String },
}

impl std::fmt::Display for ClientDirError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientDirError::NotFound { path } => write!(f, "client path not found: {path}"),
            ClientDirError::UncUnavailable { path, unc } => write!(
                f,
                "client path not found: {path}\nHint: if this share needs credentials, run: net use {unc} /persistent:yes"
            ),
            ClientDirError::Invalid { message } => f.write_str(message),
        }
    }
}

fn canonical_client_dir_for_os(path: &str, os: Os) -> Result<String, ClientDirError> {
    if os == Os::Windows {
        return canonical_windows_client_dir(path);
    }
    canonical_client_dir(path, os).map_err(|()| ClientDirError::NotFound {
        path: path.to_string(),
    })
}

fn canonical_client_dir(path: &str, os: Os) -> Result<String, ()> {
    let path = fs::canonicalize(path).map_err(|_| ())?;
    if path.is_dir() {
        Ok(normalize_client_path_for_persistence(
            &path.to_string_lossy(),
            os,
        ))
    } else {
        Err(())
    }
}

fn canonical_windows_client_dir(path: &str) -> Result<String, ClientDirError> {
    let canonical = fs::canonicalize(path).map_err(|_| windows_client_dir_error(path))?;
    if !canonical.is_dir() {
        return Err(windows_client_dir_error(path));
    }
    let raw = canonical.to_string_lossy();
    let normalized = canonicalize_client_path(&raw).map_err(|err| ClientDirError::Invalid {
        message: err.to_string(),
    })?;
    Ok(normalize_client_path_for_persistence(
        &normalized,
        Os::Windows,
    ))
}

fn windows_client_dir_error(path: &str) -> ClientDirError {
    if let Some(unc) = net_use_unc_target(path) {
        ClientDirError::UncUnavailable {
            path: path.to_string(),
            unc,
        }
    } else {
        ClientDirError::NotFound {
            path: path.to_string(),
        }
    }
}

fn net_use_unc_target(path: &str) -> Option<String> {
    let normalized = canonicalize_client_path(path).ok()?;
    let rest = normalized.strip_prefix("//")?;
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let server = parts.next()?;
    let share = parts.next()?;
    Some(format!(r"\\{server}\{share}"))
}

fn is_mapped(client_dir: &str, pairs: &[FolderMap], os: Os) -> bool {
    pairs
        .iter()
        .any(|(client, _)| client_path_eq_or_child_for_os(client_dir, client, os))
}

fn append_folder_map_for_os(raw_maps: &str, client_dir: &str, host_dir: &str, os: Os) -> String {
    let mut entries = normalize_folder_maps_for_persistence(parse_maps(raw_maps), os)
        .into_iter()
        .map(|(client, host)| format!("{client}::{host}"))
        .collect::<Vec<_>>();
    entries.push(format!(
        "{}::{host_dir}",
        normalize_client_path_for_persistence(client_dir, os)
    ));
    entries.join(";")
}

fn set_map_mode_for_os(path: &Path, client_dir: &str, method: &str, os: Os) -> std::io::Result<()> {
    let raw = resolve_raw_modes(path)?;
    let mut entries = parse_maps(&raw)
        .into_iter()
        .filter(|(client, _)| !map_client_eq_for_os(client, client_dir, os))
        .map(|(client, mode)| {
            format!(
                "{}::{mode}",
                normalize_client_path_for_persistence(&client, os)
            )
        })
        .collect::<Vec<_>>();
    entries.push(format!("{client_dir}::{method}"));
    config::set(path, "FOLDER_MAP_MODES", &entries.join(";"))
}

fn remove_map_mode_for_os(path: &Path, client_dir: &str, os: Os) -> std::io::Result<()> {
    let raw = resolve_raw_modes(path)?;
    let entries = remove_client_from_raw_maps(&raw, client_dir, os);
    config::set(path, "FOLDER_MAP_MODES", &entries)
}

fn remove_client_from_raw_maps(raw: &str, client_dir: &str, os: Os) -> String {
    parse_maps(raw)
        .into_iter()
        .filter(|(client, _)| !map_client_eq_for_os(client, client_dir, os))
        .map(|(client, mode)| {
            format!(
                "{}::{mode}",
                normalize_client_path_for_persistence(&client, os)
            )
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn map_client_eq_for_os(left: &str, right: &str, os: Os) -> bool {
    if os == Os::Windows {
        client_path_eq_for_os(left, right, os)
    } else {
        normalize_posix_path_for_cmp(left) == normalize_posix_path_for_cmp(right)
    }
}

fn normalize_client_dir_literal_for_os(path: &str, os: Os) -> String {
    if os == Os::Windows {
        return normalize_client_path_for_persistence(path, os);
    }

    let literal = Path::new(path);
    let absolute = if literal.is_absolute() {
        literal.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| Path::new(".").to_path_buf())
            .join(literal)
    };
    normalize_posix_path_for_cmp(&absolute.to_string_lossy())
}

fn normalize_posix_path_for_cmp(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if !parts.is_empty() => {
                parts.pop();
            }
            ".." if !absolute => parts.push(part),
            ".." => {}
            _ => parts.push(part),
        }
    }

    let mut normalized = String::new();
    if absolute {
        normalized.push('/');
    }
    normalized.push_str(&parts.join("/"));
    if normalized.is_empty() {
        if absolute {
            "/".to_string()
        } else {
            ".".to_string()
        }
    } else {
        normalized
    }
}

fn render_map_json(pairs: &[FolderMap], modes: &[FolderMap]) -> String {
    let mut out = String::from("[");
    for (idx, (client, host)) in pairs.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        out.push_str("{\"client\":");
        push_json_quoted(&mut out, client);
        out.push_str(",\"host\":");
        push_json_quoted(&mut out, host);
        out.push_str(",\"method\":");
        push_json_quoted(&mut out, &map_mode_for_os(client, modes, Os::current()));
        out.push('}');
    }
    out.push(']');
    out
}

fn map_mode_for_os(client: &str, modes: &[FolderMap], os: Os) -> String {
    modes
        .iter()
        .find(|(mode_client, _)| mode_client == client)
        .map(|(_, mode)| mode.clone())
        .unwrap_or_else(|| infer_map_method_for_os(client, os))
}

fn infer_map_method_for_os(client: &str, os: Os) -> String {
    if os == Os::Windows {
        "mount".to_string()
    } else {
        infer_map_method(client)
    }
}

fn infer_map_method(client: &str) -> String {
    if !client.starts_with("/Volumes/") {
        return "sync".to_string();
    }
    let Some(host) = non_empty_env("REMOTE_HOST") else {
        return "sync".to_string();
    };
    if !config::valid_host(&host) {
        return "sync".to_string();
    }
    let host = host.rsplit('@').next().unwrap_or(&host);
    let output = std::process::Command::new("mount").output().ok();
    let Some(output) = output else {
        return "sync".to_string();
    };
    let mount = String::from_utf8_lossy(&output.stdout);
    for line in mount.lines() {
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
                .is_some_and(|s| s.starts_with(&format!("{host}/")));
        let path_matches = client == mountpoint
            || client
                .strip_prefix(mountpoint)
                .is_some_and(|suffix| suffix.starts_with('/'));
        if source_matches && path_matches {
            return "mount".to_string();
        }
    }
    "sync".to_string()
}

fn push_json_quoted(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch <= '\u{1f}' => {
                out.push_str("\\u00");
                let byte = ch as u8;
                out.push(hex_digit(byte >> 4));
                out.push(hex_digit(byte & 0x0f));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
}

fn hex_digit(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'a' + (n - 10)) as char,
        _ => unreachable!("hex nibble is always <= 15"),
    }
}

fn run_tool_or_windows_gate(verb: &str, tool: &str, args: &[String]) -> ExitCode {
    if Os::current() == Os::Windows {
        match verb {
            "editor" | "desktop" => eprintln!("xpair {verb}: IDE-driven on Windows"),
            "mount" => eprintln!("{}", windows_mount_guidance(args)),
            _ => eprintln!("xpair {verb}: unavailable on Windows"),
        }
        return ExitCode::from(2);
    }
    tools::run_passthrough(tool, args)
}

fn windows_mount_guidance(args: &[String]) -> String {
    windows_mount_guidance_with_host(args, configured_remote_host_for_guidance().as_deref())
}

fn configured_remote_host_for_guidance() -> Option<String> {
    if let Some(host) = non_empty_env("REMOTE_HOST").filter(|host| config::valid_host(host)) {
        return Some(host);
    }
    let path = config::default_client_env_path().ok()?;
    resolve_host(&path).ok().filter(|host| !host.is_empty())
}

fn windows_mount_guidance_with_host(args: &[String], host: Option<&str>) -> String {
    let host_path = match args.first().map(String::as_str) {
        Some("mount") => args.get(1).map(String::as_str),
        Some(value) if value.starts_with('/') => Some(value),
        _ => None,
    };
    let Some(host_path) = host_path.filter(|value| !value.is_empty()) else {
        return "xpair mount: Windows uses UNC paths; use: xpair map add \\\\<smbHost>\\<share> <host path>"
            .to_string();
    };
    let Some(host) = host else {
        return format!(
            "xpair mount: Windows uses UNC paths; configure REMOTE_HOST, then use: xpair map add \\\\<smbHost>\\<share> {host_path}"
        );
    };
    let Some(unc) = discover_unc_for_hostpath(host, host_path) else {
        return format!(
            "xpair mount: Windows uses UNC paths; use: xpair map add \\\\<smbHost>\\<share> {host_path}"
        );
    };
    let unc_arg = unc.root.replace('/', "\\");
    format!("xpair mount: Windows uses UNC paths; use: xpair map add {unc_arg} {host_path}")
}

fn resolve_aqua_sock(path: &Path) -> std::io::Result<String> {
    if let Some(aqua_sock) = non_empty_env("AQUA_SOCK") {
        return Ok(aqua_sock);
    }
    Ok(config::get(path, "AQUA_SOCK")?
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| session::DEFAULT_AQUA_SOCK.to_string()))
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn run_config(args: &[String]) -> ExitCode {
    let path = match config::default_client_env_path() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("xpair config: {err}");
            return ExitCode::from(2);
        }
    };

    match args.first().map(String::as_str).unwrap_or("list") {
        "list" | "" => match config::list_cli(&path) {
            Ok(rows) => {
                println!("Xpair client config");
                for (key, value) in rows {
                    println!("{key:<12} {value}");
                }
                ExitCode::SUCCESS
            }
            Err(err) => {
                eprintln!("xpair config: {err}");
                ExitCode::from(1)
            }
        },
        "get" => {
            if args.len() != 2 {
                eprintln!("config get <host|terminal|engine>");
                return ExitCode::from(2);
            }
            match config::get_cli(&path, &args[1]) {
                Ok(value) => {
                    println!("{value}");
                    ExitCode::SUCCESS
                }
                Err(err) if err.kind() == std::io::ErrorKind::InvalidInput => {
                    eprintln!("{err}");
                    ExitCode::from(2)
                }
                Err(err) => {
                    eprintln!("xpair config: {err}");
                    ExitCode::from(1)
                }
            }
        }
        "set" => {
            if args.len() != 3 {
                eprintln!("config set <host|terminal|engine> <value>");
                return ExitCode::from(2);
            }
            match config::set_cli(&path, &args[1], &args[2]) {
                Ok(message) => {
                    println!("{message}");
                    ExitCode::SUCCESS
                }
                Err(err) if err.kind() == std::io::ErrorKind::InvalidInput => {
                    eprintln!("{err}");
                    ExitCode::from(2)
                }
                Err(err) => {
                    eprintln!("xpair config: {err}");
                    ExitCode::from(1)
                }
            }
        }
        "maps" => cmd_map(&["list".to_string()]),
        _ => {
            eprintln!("config [list|get <key>|set <key> <value>|maps]");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());
    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "xpair-main-test-{}-{id}-{name}",
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

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    fn path_string(path: impl AsRef<Path>) -> String {
        path.as_ref().to_string_lossy().into_owned()
    }

    #[test]
    fn windows_child_containment_accepts_forward_and_backslash_boundaries() {
        assert!(client_path_eq_or_child_for_os(
            r"C:\Users\Alice\Project\Child",
            r"c:\users\alice\project",
            Os::Windows
        ));
        assert!(client_path_eq_or_child_for_os(
            "C:/Users/Alice/Project/Child",
            "c:/users/alice/project",
            Os::Windows
        ));
    }

    #[test]
    fn windows_child_containment_still_requires_separator_boundary() {
        assert!(!client_path_eq_or_child_for_os(
            r"C:\Users\Alice\Projectile",
            r"c:\users\alice\project",
            Os::Windows
        ));
    }

    #[test]
    fn windows_map_rm_comparison_normalizes_case_slashes_and_drive_letter() {
        assert!(map_client_eq_for_os(
            r"\\?\C:\Users\Alice\Project",
            "c:/users/alice/project/",
            Os::Windows
        ));
        assert!(map_client_eq_for_os(
            r"\\?\UNC\Office-Mac.local\Project",
            "//office-mac.local/project/",
            Os::Windows
        ));
        assert!(!map_client_eq_for_os(
            r"C:\Users\Alice\ProjectX",
            r"c:\users\alice\project",
            Os::Windows
        ));
    }

    #[test]
    fn windows_map_rm_comparison_normalizes_long_unc_prefix() {
        assert!(map_client_eq_for_os(
            r"\\?\UNC\Server\Share\Project",
            r"\\server\share\project",
            Os::Windows
        ));
        assert_eq!(
            remove_client_from_raw_maps(
                r"\\server\share\project::/host/project;D:\Other::/host/other",
                r"\\?\UNC\server\share\project",
                Os::Windows,
            ),
            r"D:/Other::/host/other"
        );
    }

    #[test]
    fn remove_client_from_raw_maps_uses_windows_normalized_key() {
        assert_eq!(
            remove_client_from_raw_maps(
                r"C:\Users\Alice\Project::/host/project;D:\Other::/host/other",
                "c:/users/alice/project/",
                Os::Windows,
            ),
            r"D:/Other::/host/other"
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
    fn windows_map_list_normalizes_verbatim_clients_for_display() {
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
    fn windows_map_add_persists_stripped_verbatim_clients() {
        assert_eq!(
            append_folder_map_for_os(
                r"\\?\C:\Users\Alice\Old::/host/old",
                r"\\?\UNC\server\share\Project",
                "/host/project",
                Os::Windows,
            ),
            "C:/Users/Alice/Old::/host/old;//server/share/Project::/host/project"
        );
        assert_eq!(
            remove_client_from_raw_maps(
                r"//office-mac.local/Project::/Users/alice/Project;D:\Other::/host/other",
                r"\\?\UNC\office-mac.local\project",
                Os::Windows,
            ),
            r"D:/Other::/host/other"
        );
    }

    #[test]
    fn map_rm_posix_comparison_normalizes_deleted_literal_paths() {
        assert_eq!(
            remove_client_from_raw_maps(
                "/tmp/deleted::/host/deleted;/tmp/keep::/host/keep",
                "/tmp/deleted/",
                Os::Mac,
            ),
            "/tmp/keep::/host/keep"
        );
        assert_eq!(
            remove_client_from_raw_maps(
                "/tmp/deleted::/host/deleted;/tmp/keep::/host/keep",
                "/tmp/parent/../deleted",
                Os::Linux,
            ),
            "/tmp/keep::/host/keep"
        );
    }

    #[test]
    fn map_rm_clears_legacy_sync_roots_when_last_mapping_removed() {
        let tmp = TestDir::new("legacy-sync-rm");
        let client_dir = tmp.path.join("project");
        fs::create_dir_all(&client_dir).unwrap();
        let client_dir_s = path_string(fs::canonicalize(&client_dir).unwrap());
        let client_env = tmp.path.join("client.env");
        // Single-quote the value: on windows the canonicalized path carries backslashes
        // (and a \\?\\ prefix) that the shell-style env parser would otherwise mangle.
        fs::write(
            &client_env,
            format!("SYNC_ROOTS='{}::/host/project'\n", client_dir_s),
        )
        .unwrap();
        let client_env_s = path_string(&client_env);

        with_env(
            &[
                ("CLIENT_ENV", Some(&client_env_s)),
                ("FOLDER_MAPS", None),
                ("SYNC_ROOTS", None),
                ("RP_CLIENT_DIR", None),
            ],
            || {
                assert_eq!(cmd_map(&strings(&["rm", &client_dir_s])), ExitCode::SUCCESS);
            },
        );

        assert_eq!(
            config::get(&client_env, "FOLDER_MAPS").unwrap(),
            Some(String::new())
        );
        assert_eq!(
            config::get(&client_env, "SYNC_ROOTS").unwrap(),
            Some(String::new())
        );
        assert_eq!(resolve_raw_maps(&client_env).unwrap(), "");
    }

    #[test]
    fn config_maps_dispatches_to_map_list() {
        let tmp = TestDir::new("config-maps");
        let client_env = tmp.path.join("client.env");
        fs::write(
            &client_env,
            "FOLDER_MAPS='/client/project::/host/project'\nFOLDER_MAP_MODES='/client/project::sync'\n",
        )
        .unwrap();
        let client_env_s = path_string(&client_env);

        with_env(
            &[
                ("CLIENT_ENV", Some(&client_env_s)),
                ("FOLDER_MAPS", None),
                ("SYNC_ROOTS", None),
                ("FOLDER_MAP_MODES", None),
                ("RP_CLIENT_DIR", None),
            ],
            || {
                assert_eq!(run_config(&strings(&["maps"])), ExitCode::SUCCESS);
            },
        );
    }

    #[test]
    fn windows_map_add_requires_explicit_host_path_for_single_arg_form() {
        let add = parse_map_add_args(&strings(&[r"C:\Users\Alice\Project"])).unwrap();
        assert_eq!(
            validate_map_add_args_for_os(&add, Os::Windows),
            Err(
                "map add on Windows requires an explicit mac host path: xpair map add <clientDir> <hostDir>"
                    .to_string()
            )
        );

        let add = parse_map_add_args(&strings(&[
            r"C:\Users\Alice\Project",
            "/Users/alice/project",
        ]))
        .unwrap();
        assert_eq!(validate_map_add_args_for_os(&add, Os::Windows), Ok(()));

        let add = parse_map_add_args(&strings(&[
            r"\\office-mac.local\Project",
            "/Users/alice/Project",
            "--method",
            "sync",
        ]))
        .unwrap();
        assert_eq!(
            validate_map_add_args_for_os(&add, Os::Windows),
            Err(
                "sync mappings are not supported on Windows yet; use a UNC or mapped-drive path with --method mount"
                    .to_string()
            )
        );
    }

    #[test]
    fn windows_map_add_unc_failures_include_net_use_hint() {
        assert_eq!(
            net_use_unc_target(r"\\?\UNC\office-mac.local\Project\src").unwrap(),
            r"\\office-mac.local\Project"
        );
        assert_eq!(
            windows_client_dir_error(r"\\office-mac.local\Project").to_string(),
            "client path not found: \\\\office-mac.local\\Project\nHint: if this share needs credentials, run: net use \\\\office-mac.local\\Project /persistent:yes"
        );
    }

    #[test]
    fn windows_mapping_mode_defaults_to_direct_mount() {
        assert_eq!(
            infer_map_method_for_os("//office-mac.local/Project", Os::Windows),
            "mount"
        );
        assert_eq!(
            map_mode_for_os("//office-mac.local/Project", &[], Os::Windows),
            "mount"
        );
    }

    #[test]
    fn windows_mount_guidance_uses_concrete_unc_suggestion() {
        assert_eq!(
            windows_mount_guidance_with_host(
                &strings(&["mount", "/Users/alice/Projects/foo"]),
                Some("alice@office-mac.local"),
            ),
            r"xpair mount: Windows uses UNC paths; use: xpair map add \\office-mac.local\foo /Users/alice/Projects/foo"
        );
    }

    #[test]
    fn resolve_host_rejects_option_like_env_host_before_ssh_use() {
        with_env(&[("REMOTE_HOST", Some("-oProxyCommand=touch-pwn"))], || {
            let err = resolve_host(Path::new("/tmp/unused-client.env")).unwrap_err();
            assert_eq!(err.to_string(), "invalid host: -oProxyCommand=touch-pwn");
        });
    }
}
