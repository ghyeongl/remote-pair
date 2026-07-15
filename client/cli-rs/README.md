# client/cli-rs — native xpair client CLI (Rust)

Single-source, cross-platform Rust port of the bash client CLI
(`client/cli/xpair`, `client/cli/xpair-launch`). Targets macOS, Linux, and **native
Windows** — no WSL, Cygwin, MSYS, or Git Bash. Tracks
`.omc/plans/windows-native-client-support.md`.

## Status: P0 (scaffold)

Builds and tests **offline** (no external crates yet). What exists:

- `platform` — OS detection + per-OS capability flags. Encodes decision **C1**: SSH
  connection multiplexing is unsupported on Win32-OpenSSH, so it is disabled on Windows
  (`supports_multiplexing()` / `ssh_mux_neutralizer_args()`).
- `remote_quote` — POSIX shell quoting for payloads sent to the host over SSH (decision
  **U1**; kept separate from local Windows argv spawning).
- `transport` — the mockable `Transport` trait seam + `MockTransport` (argv capture, the
  Rust analogue of `tests/lib.sh`'s MOCKLOG), so logic is testable without a real host.
- `main` — the subcommand dispatch skeleton; `doctor`/`--version`/`help` work, other
  commands report "not yet ported" (exit 2) and are filled in P1+.

## Build & test

```sh
cargo build              # links via MSVC on Windows; no network needed
cargo test               # unit tests for platform / remote_quote / transport
cargo run -- doctor      # prints OS + the per-OS SSH multiplexing posture
```

Subcommands are ported incrementally behind this stable surface, each gated by a ported
parity test, until the bash CLI is retired at cutover (P6).
