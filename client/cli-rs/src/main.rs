//! `xpair` CLI entry point (P0 dispatch skeleton).
//!
//! Subcommands are ported incrementally (P1+) behind this stable surface; until a command is
//! ported it returns exit 2 with a clear "not yet implemented" message. The canonical command
//! set mirrors the bash dispatch at `client/cli/xpair:2261-2287`.

use std::fs;
use std::path::Path;
use std::process::ExitCode;
use xpair::attach;
use xpair::config;
use xpair::discover;
use xpair::doctor;
use xpair::host_permissions;
use xpair::install_host;
use xpair::launch;
use xpair::logs;
use xpair::mapping::{map_to_host, parse_maps};
use xpair::notify;
use xpair::open_gui;
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
            ExitCode::SUCCESS
        }
        "--help" | "-h" | "help" => {
            print_help();
            ExitCode::SUCCESS
        }
        "doctor" => doctor::run(&args[1..]),
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
        "editor" => tools::run_passthrough("xpair-editor", &args[1..]),
        "desktop" => tools::run_passthrough("xpair-desktop", &args[1..]),
        "mount" => tools::run_passthrough("xpair-mount", &args[1..]),
        "map" => cmd_map(&args[1..]),
        "config" => run_config(&args[1..]),
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
        "(native Rust client — port in progress; most verbs work today; onboard/approve/self-update remaining)"
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
    let aqua_sock = resolve_aqua_sock();
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
    let raw_maps = match resolve_raw_maps(&path) {
        Ok(raw_maps) => raw_maps,
        Err(err) => {
            eprintln!("xpair map: {err}");
            return ExitCode::from(1);
        }
    };
    let pairs = parse_maps(&raw_maps);

    match args {
        [flag] if flag == "--list" => {
            println!("{}", render_map_list(&pairs));
            ExitCode::SUCCESS
        }
        [client_path] => match map_to_host(client_path, &pairs) {
            Ok(host_path) => {
                println!("{host_path}");
                ExitCode::SUCCESS
            }
            Err(err) => {
                eprintln!("{err}");
                ExitCode::from(2)
            }
        },
        _ => {
            eprintln!("usage: xpair map <client_path>");
            eprintln!("       xpair map --list");
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
    let aqua_sock = resolve_aqua_sock();
    let transport = SshTransport;

    if json {
        let output = if host.is_empty() {
            session::render_json("host", "", &[])
        } else {
            session::render_remote_json(&transport, &host, &aqua_sock)
        };
        println!("{output}");
        return ExitCode::SUCCESS;
    }

    let raw_maps = match resolve_raw_maps(&path) {
        Ok(raw_maps) => raw_maps,
        Err(err) => {
            eprintln!("xpair ls: {err}");
            return ExitCode::from(1);
        }
    };
    let pairs = parse_maps(&raw_maps);
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
    if pairs.is_empty() {
        return "(none)".to_string();
    }

    pairs
        .iter()
        .map(|(client, host)| format!("{client}::{host}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn resolve_host(path: &Path) -> std::io::Result<String> {
    if let Some(host) = non_empty_env("REMOTE_HOST") {
        return Ok(host);
    }
    config::get_cli(path, "host")
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
        "maps" => {
            eprintln!("xpair: 'config maps' is not yet ported to the native client (Rust port in progress)");
            ExitCode::from(2)
        }
        _ => {
            eprintln!("config [list|get <key>|set <key> <value>|maps]");
            ExitCode::from(2)
        }
    }
}
