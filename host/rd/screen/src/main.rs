//! screen — license-clean screen-capture sidecar for Xpair
//! Remote Desktop (the v1 high-performance path).
//!
//! STATUS: v2 (WebRTC) SHIPPED. `serve-webrtc` is the product Remote Desktop path:
//! `rp-screencap` (ScreenCaptureKit + VideoToolbox hardware H.264) → webrtc-rs
//! (DTLS/SRTP over UDP/ICE) → IDE `<video>`. View-only screen share: there is no
//! remote keyboard/mouse injection (Xpair streams the screen, not control).
//! Built behind the `webrtc` feature; shipping in 0.5.0 and verified end-to-end
//! from the IDE. `serve` (v1a WS+JPEG software path) remains a license-clean
//! fallback, and `capture`/`info` prove the capture foundation is license-clean
//! (permissive deps only; AGPL only for our own crate — see `deny.toml`).
//! Future (README roadmap): TWCC/GCC adaptation, HEVC/AV1, ICE-restart.
//!
//! Capture backend: `xcap` (Apache-2.0). `scap` (MIT) was tried first per the
//! original plan but its ScreenCaptureKit backend invokes `xcodebuild` in its
//! build script, which fails on this toolchain.
//!
//! Transport: `tungstenite` (MIT), the pure-Rust synchronous WebSocket
//! implementation, driven over std `TcpListener` + threads. No async runtime,
//! no TLS — the server binds loopback only and relies on the operator's
//! `ssh -L` tunnel for transport security.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use xcap::Monitor;

#[cfg(feature = "webrtc")]
mod control;
mod log;
mod serve;
#[cfg(feature = "webrtc")]
mod serve_webrtc;

/// License-clean screen-capture sidecar for Xpair Remote Desktop (v1).
#[derive(Parser, Debug)]
#[command(name = "screen", version, about, long_about = None)]
struct Cli {
    /// Correlation session id for logs (the tmux session name). Falls back to
    /// the `RP_SESSION` env var, then `-`. Used in the `[session]` column of
    /// `~/.xpair/host/logs/rust.log` (see docs/logging.md).
    #[arg(long, value_name = "NAME", global = true)]
    session: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Capture ONE frame of the primary display, encode to PNG, write to <out>.
    ///
    /// Proves the capture path works license-clean end to end. This is a
    /// single-shot capture, not the streaming path (that is `serve`).
    Capture {
        /// Output PNG path.
        #[arg(long, value_name = "PATH")]
        out: PathBuf,
    },
    /// Print the dimensions and metadata of every connected display.
    Info,
    /// Start the v1a WebSocket JPEG frame server (continuous capture).
    ///
    /// Binds 127.0.0.1:<port> (loopback only). At the target fps it captures
    /// the primary display, JPEG-encodes the frame, and sends the bytes as a
    /// binary WebSocket message to every connected client. Intended to be
    /// reached over an `ssh -L` tunnel; the IDE webview connects
    /// `ws://127.0.0.1:<localport>` and renders frames into a <canvas>/<img>.
    ///
    /// NOTE: the sidecar binary needs its OWN Screen Recording (TCC) grant.
    Serve {
        /// TCP port to bind on 127.0.0.1.
        #[arg(long, default_value_t = 8889)]
        port: u16,
        /// Target frames per second for the capture loop.
        #[arg(long, default_value_t = 10)]
        fps: u32,
        /// JPEG quality (1-100). Higher = better image, larger frames.
        #[arg(long, default_value_t = 60)]
        quality: u8,
        /// Downscale factor for captured frames (0.1-1.0). 1.0 = native
        /// resolution. On a Retina display (e.g. 2560x1600) a scale of 0.5
        /// quarters the pixel count — much smaller frames and faster encode —
        /// at the cost of some text sharpness. Applied only to changed frames.
        #[arg(long, default_value_t = 1.0)]
        scale: f32,
    },
    /// Start the v1b WebRTC (UDP/RTP) H.264 screen server (requires the
    /// `webrtc` build feature + the `rp-vt-encode` helper on the host).
    ///
    /// Signaling is a WebSocket on 127.0.0.1:<port>; media flows P2P over
    /// UDP/ICE. The IDE webview connects via RTCPeerConnection and renders the
    /// H.264 track into a <video>.
    #[cfg(feature = "webrtc")]
    ServeWebrtc {
        /// TCP port for the signaling WebSocket (bound on 127.0.0.1).
        #[arg(long, default_value_t = 8890)]
        port: u16,
        /// Required expected signaling session token. Use TOKEN directly or
        /// @TOKEN_FILE to read the token from an owner-only file. Every
        /// WebSocket must present this exact token in `?token=...`.
        #[arg(long, value_name = "TOKEN")]
        token: String,
        /// Target frames per second.
        #[arg(long, default_value_t = 30)]
        fps: u32,
        /// Target H.264 bitrate in bits/sec.
        #[arg(long, default_value_t = 4_000_000)]
        bitrate: u32,
        /// Downscale factor (0.1-1.0); applied only to changed frames.
        #[arg(long, default_value_t = 1.0)]
        scale: f32,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    // Resolve the correlation session (--session > RP_SESSION > "-") and bring
    // up the file logger as early as possible so even startup errors persist.
    let session = cli
        .session
        .clone()
        .or_else(|| std::env::var("RP_SESSION").ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "-".to_string());
    log::set_session(session);
    log::init();

    let result = match cli.command {
        Command::Capture { out } => cmd_capture(&out),
        Command::Info => cmd_info(),
        Command::Serve {
            port,
            fps,
            quality,
            scale,
        } => serve::run(port, fps, quality, scale),
        #[cfg(feature = "webrtc")]
        Command::ServeWebrtc {
            port,
            token,
            fps,
            bitrate,
            scale,
        } => serve_webrtc::run(port, fps, bitrate, scale, token),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!("{err}");
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}

/// Pick the primary display, falling back to the first available one.
pub(crate) fn primary_monitor() -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| format!("could not enumerate displays: {e}"))?;
    if monitors.is_empty() {
        return Err("no displays found (is Screen Recording permission granted?)".to_string());
    }

    // Prefer the monitor that reports itself as primary; otherwise take the first.
    for m in &monitors {
        if m.is_primary().unwrap_or(false) {
            return Ok(m.clone());
        }
    }
    Ok(monitors.into_iter().next().expect("checked non-empty"))
}

/// `capture --out <path>`: grab one frame of the primary display and write a PNG.
fn cmd_capture(out: &PathBuf) -> Result<(), String> {
    let monitor = primary_monitor()?;

    let frame = monitor
        .capture_image()
        .map_err(|e| format!("capture failed (check Screen Recording permission): {e}"))?;

    let (width, height) = (frame.width(), frame.height());

    // `image` is re-exported by xcap, so the RgbaImage we got back encodes
    // directly with the same crate version we depend on.
    frame
        .save(out)
        .map_err(|e| format!("failed to write PNG to {}: {e}", out.display()))?;

    let message = format!("captured {}x{} frame -> {}", width, height, out.display());
    tracing::info!("{message}");
    println!("{message}");
    Ok(())
}

/// `info`: enumerate displays and print dimensions + metadata.
fn cmd_info() -> Result<(), String> {
    let monitors = Monitor::all().map_err(|e| format!("could not enumerate displays: {e}"))?;
    if monitors.is_empty() {
        return Err("no displays found (is Screen Recording permission granted?)".to_string());
    }

    let header = format!("{} display(s):", monitors.len());
    tracing::info!("{header}");
    println!("{header}");
    for (i, m) in monitors.iter().enumerate() {
        let name = m.name().unwrap_or_else(|_| "<unknown>".to_string());
        let width = m.width().unwrap_or(0);
        let height = m.height().unwrap_or(0);
        let scale = m.scale_factor().unwrap_or(1.0);
        let primary = m.is_primary().unwrap_or(false);
        let message = format!(
            "  [{i}] {name}: {width}x{height} @ {scale}x{}",
            if primary { " (primary)" } else { "" }
        );
        tracing::info!("{message}");
        println!("{message}");
    }
    Ok(())
}
