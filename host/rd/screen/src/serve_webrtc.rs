//! `serve-webrtc` — continuous-capture **WebRTC (UDP/RTP) H.264** screen server.
//!
//! The real v1b transport. UDP is mandatory: TCP/WebSocket head-of-line blocking
//! stalls a screen stream on any lost packet. Media flows over webrtc-rs
//! (DTLS/SRTP over UDP/ICE); only the tiny SDP/ICE **signaling** uses a WS side
//! channel (control data — HoL irrelevant there).
//!
//! ```text
//!   capture thread:  xcap RGBA ─swizzle→BGRA─▶ rp-vt-encode stdin (VTCompressionSession)
//!   reader thread:   rp-vt-encode stdout ─[4B len|Annex-B AU]→ tokio mpsc
//!   rtp task:        mpsc ─▶ TrackLocalStaticSample::write_sample (H264 → RTP/SRTP/UDP)
//!   signaling:       ws://127.0.0.1:<port>/  JSON {offer,answer,candidate}
//! ```
//! Client = browser/webview `RTCPeerConnection` (Chromium native WebRTC, decodes
//! H.264 on macOS/Windows/Linux → cross-platform) rendering into a `<video>`.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::SocketAddr;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::control::{
    app_control_frame, AppControlFrame, CaptureConfig, CaptureErrorKind, ControlClient,
    ControlError, StartedInfo,
};

const CONNECT_DEADLINE: Duration = Duration::from_secs(10);
const SESSION_TOKEN_MIN_LEN: usize = 24;
const SESSION_TOKEN_MAX_LEN: usize = 128;
const APP_CONTROL_FD_ENV: &str = "RP_AU_CONTROL_FD";
const MAX_AU_FRAME_LEN: usize = 64 * 1024 * 1024;
const MAX_CONTROL_FRAME_LEN: usize = 1024 * 1024;
const ABR_NO_RR_CUT_AFTER: Duration = Duration::from_secs(2);
const ABR_WRITE_HYSTERESIS: f32 = 0.05;

type SignalingWs = WebSocketStream<tokio::net::TcpStream>;
type WsTx = SplitSink<SignalingWs, Message>;
type WsRx = SplitStream<SignalingWs>;
type InputTx = std::sync::mpsc::Sender<Vec<u8>>;
type InputRx = std::sync::mpsc::Receiver<Vec<u8>>;

static APP_CAPTURE_IO: OnceLock<Arc<AppCaptureIo>> = OnceLock::new();

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SessionToken(String);

impl SessionToken {
    fn parse(raw: &str) -> Result<Self, SessionError> {
        let token = raw.trim();
        if token.len() < SESSION_TOKEN_MIN_LEN || token.len() > SESSION_TOKEN_MAX_LEN {
            return Err(SessionError::InvalidToken);
        }
        if !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            return Err(SessionError::InvalidToken);
        }
        Ok(Self(token.to_owned()))
    }

    fn redacted(&self) -> String {
        let head: String = self.0.chars().take(6).collect();
        format!("{head}…")
    }
}

#[derive(Debug, thiserror::Error)]
enum SessionError {
    #[error("missing signaling session token")]
    MissingToken,
    #[error("invalid signaling session token")]
    InvalidToken,
    #[error("signaling session token mismatch")]
    TokenMismatch,
    #[error("connect deadline exceeded")]
    ConnectDeadlineExceeded,
    #[error("session superseded")]
    Superseded,
    #[error("peer failed: {0}")]
    PeerFailed(String),
    #[error("signaling closed")]
    SignalingClosed,
    #[error("websocket handshake: {0}")]
    WsHandshake(String),
    #[error("webrtc: {0}")]
    WebRtc(String),
    #[error("capture: {0}")]
    Capture(String),
    #[error("status serialization: {0}")]
    StatusSerialize(String),
}

struct CaptureStartError {
    status: Option<RdStatus>,
    error: SessionError,
}

impl CaptureStartError {
    fn with_status(status: RdStatus, error: SessionError) -> Self {
        Self {
            status: Some(status),
            error,
        }
    }

    fn without_status(error: SessionError) -> Self {
        Self {
            status: None,
            error,
        }
    }

    fn capture_failed(capture_kind: CaptureErrorKind, reason: String, error: SessionError) -> Self {
        Self::with_status(
            RdStatus::CaptureFailed {
                capture_kind,
                reason: bounded_reason(reason),
            },
            error,
        )
    }
}

impl From<webrtc::Error> for SessionError {
    fn from(value: webrtc::Error) -> Self {
        SessionError::WebRtc(value.to_string())
    }
}

impl From<ControlError> for SessionError {
    fn from(value: ControlError) -> Self {
        match value {
            ControlError::CaptureFailed { kind, reason } => {
                SessionError::Capture(format!("{kind:?}: {reason}"))
            }
            ControlError::Superseded { .. } => SessionError::Superseded,
            other => SessionError::Capture(other.to_string()),
        }
    }
}

struct AcceptedSignaling {
    token: SessionToken,
    capture_config: CaptureConfig,
    ws: SignalingWs,
}

struct ActiveSession {
    seq: u64,
    token: SessionToken,
    cancel: CancellationToken,
}

struct SessionDone {
    seq: u64,
    token: SessionToken,
    result: Result<(), SessionError>,
}

enum SignalingAcceptResult {
    Accepted {
        seq: u64,
        peer: SocketAddr,
        signaling: Box<AcceptedSignaling>,
    },
    Rejected {
        seq: u64,
        peer: SocketAddr,
        error: SessionError,
    },
}

enum PeerEvent {
    Connected,
    Terminal(PeerFailureKind),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PeerFailureKind {
    Failed,
    Closed,
}

impl std::fmt::Display for PeerFailureKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let label = match self {
            PeerFailureKind::Failed => "failed",
            PeerFailureKind::Closed => "closed",
        };
        f.write_str(label)
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum RdStatus {
    CaptureFailed {
        #[serde(rename = "captureKind")]
        capture_kind: CaptureErrorKind,
        reason: String,
    },
    PeerFailed {
        peer: PeerFailureKind,
        reason: String,
    },
    Superseded {
        reason: String,
    },
    InputReady {
        helper: String,
        #[serde(rename = "axTrusted")]
        ax_trusted: bool,
        #[serde(rename = "displayId")]
        display_id: Option<u32>,
        width: Option<f64>,
        height: Option<f64>,
    },
    InputFailed {
        reason: String,
    },
}

#[derive(Serialize)]
struct SignalingStatus<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    #[serde(flatten)]
    status: &'a RdStatus,
}

impl RdStatus {
    fn to_signaling_text(&self) -> Result<String, SessionError> {
        serde_json::to_string(&SignalingStatus {
            message_type: "status",
            status: self,
        })
        .map_err(|e| SessionError::StatusSerialize(e.to_string()))
    }
}

#[derive(Debug, Deserialize)]
struct InputHelperStatus {
    kind: String,
    reason: Option<String>,
    #[serde(rename = "axTrusted")]
    ax_trusted: Option<bool>,
    #[serde(rename = "displayId")]
    display_id: Option<u32>,
    width: Option<f64>,
    height: Option<f64>,
}

struct SignalingIo {
    ws_tx: WsTx,
    ws_rx: WsRx,
    sig_rx: mpsc::UnboundedReceiver<String>,
}

struct PeerResources {
    pc: Arc<webrtc::peer_connection::RTCPeerConnection>,
    _input_dcs: Vec<Arc<webrtc::data_channel::RTCDataChannel>>,
    input_rx: Option<InputRx>,
}

struct PeerSetup {
    pc: Arc<webrtc::peer_connection::RTCPeerConnection>,
}

impl PeerSetup {
    fn new(pc: Arc<webrtc::peer_connection::RTCPeerConnection>) -> Self {
        Self { pc }
    }

    async fn close_with<T>(self, error: SessionError) -> Result<T, SessionError> {
        let _ = self.pc.close().await;
        Err(error)
    }

    fn into_resources(
        self,
        _input_dcs: Vec<Arc<webrtc::data_channel::RTCDataChannel>>,
        input_rx: InputRx,
    ) -> PeerResources {
        PeerResources {
            pc: self.pc,
            _input_dcs,
            input_rx: Some(input_rx),
        }
    }
}

struct NegotiatingSession {
    seq: u64,
    token: SessionToken,
    started: Instant,
    io: SignalingIo,
    sig_tx: mpsc::UnboundedSender<String>,
    peer: PeerResources,
    state_rx: mpsc::UnboundedReceiver<PeerEvent>,
    au_tx: mpsc::Sender<Vec<u8>>,
    capture_config: CaptureConfig,
    control: ControlClient,
    cancel: CancellationToken,
    abr_loss: Arc<Mutex<AbrSignalState>>,
    abr_frames: Arc<AtomicU64>,
}

struct ConnectedSession {
    token: SessionToken,
    started: Instant,
    io: SignalingIo,
    peer: PeerResources,
    state_rx: mpsc::UnboundedReceiver<PeerEvent>,
    _capture: CaptureSource,
    _caffeinate: CaffeinateGuard,
    cancel: CancellationToken,
    abr_cancel: CancellationToken,
}

fn pli_should_force(last: Option<Instant>, now: Instant, cooldown: Duration) -> bool {
    if cooldown == Duration::from_millis(0) {
        return true;
    }
    last.is_none_or(|last| now.duration_since(last) >= cooldown)
}

#[derive(Clone, Copy, Debug)]
struct AbrCfg {
    interval: Duration,
    loss_lo: f32,
    loss_hi: f32,
    raise_after: usize,
    raise_factor: f32,
    nack_lo: f32,
    nack_hi: f32,
}

impl AbrCfg {
    fn from_env() -> Self {
        Self {
            interval: env_duration_ms("RP_ABR_INTERVAL_MS", 1500),
            loss_lo: env_f32("RP_ABR_LOSS_LO", 0.02),
            loss_hi: env_f32("RP_ABR_LOSS_HI", 0.10),
            // Raise only after RP_ABR_RAISE_AFTER consecutive clean ABR intervals (default 3).
            raise_after: env_usize("RP_ABR_RAISE_AFTER", 3).max(1),
            // RP_ABR_RAISE_FACTOR is intentionally gentler than the cut factor (default 1.05).
            raise_factor: env_f32("RP_ABR_RAISE_FACTOR", 1.05).max(1.0),
            // NACK thresholds are RTP sequence numbers NACKed per second.
            nack_lo: env_f32("RP_ABR_NACK_LO", 5.0),
            nack_hi: env_f32("RP_ABR_NACK_HI", 50.0),
        }
    }
}

#[derive(Default)]
struct AbrSignalState {
    last_loss: Option<f32>,
    last_rr: Option<Instant>,
    preferred_media_ssrc: Option<u32>,
    nack_count: u64,
}

fn abr_enabled() -> bool {
    std::env::var("RP_ABR")
        .ok()
        .map(|value| value != "0")
        .unwrap_or(false)
}

fn env_duration_ms(name: &str, default_ms: u64) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(default_ms))
}

fn env_f32(name: &str, default: f32) -> f32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(default)
}

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default)
}

fn abr_raise_tick_clean(loss_rr: f32, nack_rate: f32, cfg: &AbrCfg) -> bool {
    loss_rr < cfg.loss_lo && nack_rate < cfg.nack_lo
}

fn abr_raise_streak_next(
    current: usize,
    loss_rr: Option<f32>,
    nack_rate: f32,
    cfg: &AbrCfg,
) -> usize {
    if loss_rr
        .map(|loss| abr_raise_tick_clean(loss, nack_rate, cfg))
        .unwrap_or(false)
    {
        current.saturating_add(1)
    } else {
        0
    }
}

fn abr_next_bps(
    cur: u32,
    loss_rr: f32,
    nack_rate: f32,
    raise_streak: usize,
    min: u32,
    max: u32,
    cfg: &AbrCfg,
) -> u32 {
    let min = min.min(max);
    let cur = cur.clamp(min, max);
    if loss_rr >= cfg.loss_hi || nack_rate >= cfg.nack_hi {
        ((cur as f32) * 0.80).round() as u32
    } else if abr_raise_tick_clean(loss_rr, nack_rate, cfg) && raise_streak >= cfg.raise_after {
        ((cur as f32) * cfg.raise_factor).round() as u32
    } else {
        cur
    }
    .clamp(min, max)
}

fn nack_sequence_count(
    nack: &webrtc::rtcp::transport_feedbacks::transport_layer_nack::TransportLayerNack,
) -> u64 {
    nack.nacks
        .iter()
        .map(|pair| pair.packet_list().len() as u64)
        .sum()
}

fn bitrate_change_exceeds_hysteresis(was: u32, now: u32) -> bool {
    if was == now {
        return false;
    }
    let denom = was.max(1) as f32;
    // `>=`, not `>`: a clean raise uses RAISE_FACTOR=1.05, i.e. exactly a 5% change,
    // and ABR_WRITE_HYSTERESIS is also 0.05 — with `>` an exactly-5% raise updates the
    // logged target but never actuates the encoder until a *later* raise compounds past
    // 5%. The boundary change must write.
    ((now as f32 - was as f32).abs() / denom) >= ABR_WRITE_HYSTERESIS
}

/// Whether a missing/stale ReceiverReport should be read as congestion starvation
/// (→ drive the encoder toward MIN). Only when we're ACTIVELY producing frames: a
/// static screen makes SCK stop emitting frames, so the receiver legitimately has
/// nothing to RR. Treating that idle gap as 100% loss would crater the encoder to MIN
/// and resume motion at the lowest bitrate. So require `screen_changed` too.
fn abr_starved(no_recent_rr: bool, screen_changed: bool, elapsed_past_cut: bool) -> bool {
    no_recent_rr && screen_changed && elapsed_past_cut
}

/// Locate a helper binary that sits **next to this executable** (the bundle
/// `Contents/Helpers/` layout). `current_exe()` is `canonicalize()`d first so a
/// symlinked launch path (e.g. `~/.xpair/host/bin/screen` → bundle Helpers) is
/// resolved to the real bundle dir, where the sibling helpers actually live.
/// Returns `None` when no sibling helper exists (dev `cargo run`, missing file).
fn sibling_helper(name: &str) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let real = exe.canonicalize().unwrap_or(exe);
    let sibling = real.parent()?.join(name);
    if sibling.exists() {
        return sibling.to_str().map(|s| s.to_string());
    }
    None
}

/// Resolve the remote-input injector helper (`rp-input-inject`).
/// Order: `$RP_INPUT_INJECT` → bundle sibling (`current_exe` dir) →
/// `~/.xpair/host/bin`. No bare PATH fallback: clean installs must use the
/// signed helper bundled with XpairHost.app, and development can set
/// `RP_INPUT_INJECT` explicitly.
fn input_helper_path() -> Result<String, String> {
    if let Ok(p) = std::env::var("RP_INPUT_INJECT") {
        let p = p.trim();
        if !p.is_empty() {
            return Ok(p.to_string());
        }
    }
    if let Some(p) = sibling_helper("rp-input-inject") {
        return Ok(p);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let deployed = format!("{home}/.xpair/host/bin/rp-input-inject");
    if std::path::Path::new(&deployed).exists() {
        return Ok(deployed);
    }
    Err(format!(
        "rp-input-inject not found (expected bundle sibling or {deployed}; set RP_INPUT_INJECT for development)"
    ))
}

/// Resolve the SCK capture+encode helper (`rp-screencap`). It self-captures via
/// ScreenCaptureKit and encodes H.264 — no raw-frame pipe, no Rust-side capture.
/// Order: `$RP_SCREENCAP` → bundle sibling (`current_exe` dir) →
/// `~/.xpair/host/bin` → PATH.
fn screencap_path() -> String {
    if let Ok(p) = std::env::var("RP_SCREENCAP") {
        return p;
    }
    if let Some(p) = sibling_helper("rp-screencap") {
        return p;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let deployed = format!("{home}/.xpair/host/bin/rp-screencap");
    if std::path::Path::new(&deployed).exists() {
        return deployed;
    }
    "rp-screencap".to_string()
}

fn expected_token_from_arg(raw: &str) -> Result<SessionToken, String> {
    let token = if let Some(path) = raw.strip_prefix('@') {
        std::fs::read_to_string(path)
            .map_err(|e| format!("read signaling token file '{path}': {e}"))?
    } else {
        raw.to_string()
    };
    SessionToken::parse(&token).map_err(|e| e.to_string())
}

pub fn run(port: u16, fps: u32, bitrate: u32, scale: f32, token: String) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;
    rt.block_on(async move { run_async(port, fps, bitrate, scale, token).await })
}

async fn run_async(
    port: u16,
    fps: u32,
    bitrate: u32,
    scale: f32,
    token: String,
) -> Result<(), String> {
    let fps = fps.clamp(1, 120);
    let scale = scale.clamp(0.1, 1.0);
    let capture_config = CaptureConfig {
        fps,
        bitrate,
        scale,
    };
    let expected_token = expected_token_from_arg(&token)?;

    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    tracing::info!("screen serve-webrtc: signaling ws://{addr} (H.264/WebRTC UDP)");
    tracing::info!("  reach signaling over:  ssh -L {port}:127.0.0.1:{port} <host>");
    tracing::info!("  media flows P2P over UDP/ICE (host-candidate, loopback/LAN/VPN)");
    tracing::info!("  signaling token: required");

    let (ready_tx, mut ready_rx) = mpsc::unbounded_channel::<SignalingAcceptResult>();
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<SessionDone>();
    let mut active: Option<ActiveSession> = None;
    let mut next_session_seq: u64 = 0;

    // One browser (pair session is 1:1). The accept loop is the arbiter: it owns
    // the active session identity, and a new valid signaling connection cancels
    // the prior one before installing itself.
    loop {
        crate::log::rotate_guard(); // §7 long-lived guard: also rotate between signaling sessions
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(x) => x,
                    Err(e) => {
                        tracing::warn!("serve-webrtc: accept error: {e}");
                        continue;
                    }
                };
                tracing::info!("serve-webrtc: tcp client {peer} connected");
                next_session_seq = next_session_seq.wrapping_add(1);
                let seq = next_session_seq;
                let ready_tx = ready_tx.clone();
                let expected_token = expected_token.clone();
                tokio::spawn(async move {
                    let result = tokio::time::timeout(
                        CONNECT_DEADLINE,
                        accept_signaling(stream, &expected_token, capture_config),
                    )
                    .await
                    .map_err(|_| SessionError::ConnectDeadlineExceeded)
                    .and_then(|x| x);
                    let message = match result {
                        Ok(signaling) => SignalingAcceptResult::Accepted {
                            seq,
                            peer,
                            signaling: Box::new(signaling),
                        },
                        Err(error) => SignalingAcceptResult::Rejected { seq, peer, error },
                    };
                    let _ = ready_tx.send(message);
                });
            }
            Some(ready) = ready_rx.recv() => {
                let (seq, peer, accepted) = match ready {
                    SignalingAcceptResult::Accepted { seq, peer, signaling } => (seq, peer, *signaling),
                    SignalingAcceptResult::Rejected { seq, peer, error } => {
                        tracing::warn!("serve-webrtc: rejected signaling client {peer} seq={seq}: {error}");
                        continue;
                    }
                };
                if active.as_ref().is_some_and(|s| seq < s.seq) {
                    tracing::info!(
                        "serve-webrtc: dropping late accepted session {} seq={seq}",
                        accepted.token.redacted()
                    );
                    continue;
                }
                tracing::info!(
                    "serve-webrtc: signaling client {peer} accepted as session {} seq={seq}",
                    accepted.token.redacted(),
                );
                if let Some(old) = active.take() {
                    tracing::info!(
                        "serve-webrtc: replacing active session {} with {}",
                        old.token.redacted(),
                        accepted.token.redacted()
                    );
                    old.cancel.cancel();
                }
                let token = accepted.token.clone();
                let cancel = CancellationToken::new();
                active = Some(ActiveSession {
                    seq,
                    token: token.clone(),
                    cancel: cancel.clone(),
                });
                let done_tx = done_tx.clone();
                tokio::spawn(async move {
                    let result = serve_session(seq, accepted, cancel).await;
                    let _ = done_tx.send(SessionDone { seq, token, result });
                });
            }
            Some(done) = done_rx.recv() => {
                match &done.result {
                    Ok(()) => tracing::info!(
                        "serve-webrtc: session {} seq={} ended cleanly",
                        done.token.redacted(),
                        done.seq
                    ),
                    Err(SessionError::Superseded) => tracing::info!(
                        "serve-webrtc: session {} seq={} superseded",
                        done.token.redacted(),
                        done.seq
                    ),
                    Err(e) => tracing::warn!(
                        "serve-webrtc: session {} seq={} ended: {e}",
                        done.token.redacted(),
                        done.seq
                    ),
                }
                if active
                    .as_ref()
                    .is_some_and(|s| s.seq == done.seq && s.token == done.token)
                {
                    active = None;
                }
            }
        }
    }
}

#[allow(clippy::result_large_err)]
async fn accept_signaling(
    stream: tokio::net::TcpStream,
    expected_token: &SessionToken,
    default_capture_config: CaptureConfig,
) -> Result<AcceptedSignaling, SessionError> {
    let mut parsed_token: Option<SessionToken> = None;
    let mut parsed_capture_config = default_capture_config;
    let ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, response: Response| {
        let token = match parse_request_token(req, expected_token) {
            Ok(token) => token,
            Err(e) => return Err(session_rejection(&e)),
        };
        parsed_capture_config = capture_config_from_request(req, default_capture_config);
        parsed_token = Some(token);
        Ok(response)
    })
    .await
    .map_err(|e| SessionError::WsHandshake(e.to_string()))?;
    let token = parsed_token.ok_or(SessionError::MissingToken)?;
    Ok(AcceptedSignaling {
        token,
        capture_config: parsed_capture_config,
        ws,
    })
}

fn parse_request_token(
    req: &Request,
    expected_token: &SessionToken,
) -> Result<SessionToken, SessionError> {
    let raw = req
        .uri()
        .query()
        .and_then(token_from_query)
        .ok_or(SessionError::MissingToken)?;
    let token = SessionToken::parse(raw)?;
    if expected_token != &token {
        return Err(SessionError::TokenMismatch);
    }
    Ok(token)
}

fn token_from_query(query: &str) -> Option<&str> {
    query.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == "token").then_some(value)
    })
}

fn query_value<'a>(query: &'a str, needle: &str) -> Option<&'a str> {
    query.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == needle).then_some(value)
    })
}

fn capture_config_from_request(req: &Request, default: CaptureConfig) -> CaptureConfig {
    let Some(query) = req.uri().query() else {
        return default;
    };
    let fps = query_value(query, "fps")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default.fps)
        .clamp(1, 120);
    let bitrate = query_value(query, "bitrate")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default.bitrate)
        .max(100_000);
    let scale = query_value(query, "scale")
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(default.scale)
        .clamp(0.1, 1.0);
    CaptureConfig {
        fps,
        bitrate,
        scale,
    }
}

fn is_h264_keyframe_au(au: &[u8]) -> bool {
    let mut i = 0usize;
    while i + 3 < au.len() {
        let start_code_len = if i + 4 <= au.len()
            && au[i] == 0
            && au[i + 1] == 0
            && au[i + 2] == 0
            && au[i + 3] == 1
        {
            4
        } else if au[i] == 0 && au[i + 1] == 0 && au[i + 2] == 1 {
            3
        } else {
            i += 1;
            continue;
        };
        let nal_index = i + start_code_len;
        if nal_index < au.len() {
            let nal_type = au[nal_index] & 0x1f;
            if nal_type == 5 {
                return true;
            }
        }
        i = nal_index.saturating_add(1);
    }
    false
}

fn forward_au_latest(
    au_tx: &mpsc::Sender<Vec<u8>>,
    au: Vec<u8>,
    dropped_delta_frames: &mut u64,
) -> bool {
    match au_tx.try_send(au) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Closed(_)) => false,
        Err(mpsc::error::TrySendError::Full(au)) => {
            if is_h264_keyframe_au(&au) {
                au_tx.blocking_send(au).is_ok()
            } else {
                *dropped_delta_frames = dropped_delta_frames.wrapping_add(1);
                if *dropped_delta_frames == 1 || (*dropped_delta_frames).is_multiple_of(300) {
                    tracing::warn!(
                        "serve-webrtc: dropped {} stale delta AU(s) before RTP",
                        *dropped_delta_frames
                    );
                }
                true
            }
        }
    }
}

fn read_len_prefixed_frame<R: Read>(reader: &mut R, max_len: usize) -> Option<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    if reader.read_exact(&mut len_buf).is_err() {
        return None;
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > max_len {
        return None;
    }
    let mut frame = vec![0u8; len];
    if reader.read_exact(&mut frame).is_err() {
        return None;
    }
    Some(frame)
}

struct AppCaptureSessionSink {
    generation: u64,
    au_tx: mpsc::Sender<Vec<u8>>,
    sig_tx: mpsc::UnboundedSender<String>,
}

#[derive(Default)]
struct AppCaptureRegistry {
    current: std::sync::Mutex<Option<AppCaptureSessionSink>>,
}

impl AppCaptureRegistry {
    fn lock_current(&self) -> std::sync::MutexGuard<'_, Option<AppCaptureSessionSink>> {
        match self.current.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::warn!("serve-webrtc: app capture registry lock was poisoned");
                poisoned.into_inner()
            }
        }
    }

    fn register(
        &self,
        generation: u64,
        au_tx: mpsc::Sender<Vec<u8>>,
        sig_tx: mpsc::UnboundedSender<String>,
    ) {
        let mut current = self.lock_current();
        if current
            .as_ref()
            .is_some_and(|sink| generation < sink.generation)
        {
            tracing::debug!(
                "serve-webrtc: ignoring stale app capture registration gen={generation}"
            );
            return;
        }
        *current = Some(AppCaptureSessionSink {
            generation,
            au_tx,
            sig_tx,
        });
    }

    fn deregister(&self, generation: u64) {
        let mut current = self.lock_current();
        if current
            .as_ref()
            .is_some_and(|sink| sink.generation == generation)
        {
            *current = None;
        }
    }

    fn current_au_tx(&self) -> Option<mpsc::Sender<Vec<u8>>> {
        self.lock_current().as_ref().map(|sink| sink.au_tx.clone())
    }

    fn sig_tx_for_generation(&self, generation: u64) -> Option<mpsc::UnboundedSender<String>> {
        self.lock_current()
            .as_ref()
            .filter(|sink| sink.generation == generation)
            .map(|sink| sink.sig_tx.clone())
    }
}

struct AppCaptureIo {
    control: ControlClient,
    registry: Arc<AppCaptureRegistry>,
}

impl AppCaptureIo {
    fn process_global() -> Arc<Self> {
        APP_CAPTURE_IO
            .get_or_init(|| Arc::new(Self::spawn_process_global()))
            .clone()
    }

    fn spawn_process_global() -> Self {
        let control = ControlClient::stdout();
        let registry = Arc::new(AppCaptureRegistry::default());
        let mixed_stdin_control =
            !spawn_app_control_reader_from_env(registry.clone(), control.clone());
        spawn_au_stdin_reader(registry.clone(), control.clone(), mixed_stdin_control);
        Self { control, registry }
    }

    #[cfg(test)]
    fn new_for_test(control: ControlClient) -> Self {
        Self {
            control,
            registry: Arc::new(AppCaptureRegistry::default()),
        }
    }

    fn control(&self) -> ControlClient {
        self.control.clone()
    }

    fn register_session(
        &self,
        generation: u64,
        au_tx: mpsc::Sender<Vec<u8>>,
        sig_tx: mpsc::UnboundedSender<String>,
    ) -> StdinReaderHandle {
        self.registry.register(generation, au_tx, sig_tx);
        StdinReaderHandle {
            stopped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            generation,
            control: self.control.clone(),
            registry: self.registry.clone(),
            start_info: None,
        }
    }

    #[cfg(test)]
    fn relay_frame_for_test(&self, frame: AppControlFrame) {
        relay_app_control_frame(frame, &self.registry, &self.control);
    }

    #[cfg(test)]
    fn forward_au_for_test(&self, au: Vec<u8>, dropped_delta_frames: &mut u64) -> bool {
        forward_app_au(&self.registry, au, dropped_delta_frames)
    }
}

fn app_capture_io() -> Arc<AppCaptureIo> {
    AppCaptureIo::process_global()
}

fn app_capture_control_client() -> ControlClient {
    if std::env::var("RP_AU_STDIN").as_deref() == Ok("1") {
        app_capture_io().control()
    } else {
        ControlClient::stdout()
    }
}

fn forward_app_au(
    registry: &AppCaptureRegistry,
    au: Vec<u8>,
    dropped_delta_frames: &mut u64,
) -> bool {
    let Some(au_tx) = registry.current_au_tx() else {
        tracing::debug!("serve-webrtc: dropping AU with no active app capture session");
        return true;
    };
    if forward_au_latest(&au_tx, au, dropped_delta_frames) {
        true
    } else {
        tracing::debug!("serve-webrtc: dropping AU for closed app capture session");
        true
    }
}

fn relay_app_control_frame(
    frame: AppControlFrame,
    registry: &AppCaptureRegistry,
    control: &ControlClient,
) {
    match frame {
        AppControlFrame::Ack(ack) => control.deliver_ack(ack),
        AppControlFrame::CaptureError(event) => {
            tracing::warn!(
                "serve-webrtc: relaying host capture error gen={}: {:?}: {}",
                event.gen,
                event.kind,
                event.reason
            );
            if let Some(sig_tx) = registry.sig_tx_for_generation(event.gen) {
                queue_status(
                    &sig_tx,
                    RdStatus::CaptureFailed {
                        capture_kind: event.kind,
                        reason: bounded_reason(event.reason),
                    },
                );
            } else {
                tracing::debug!(
                    "serve-webrtc: dropping stale host capture error gen={}",
                    event.gen
                );
            }
        }
    }
}

fn read_app_control_stream<R: Read>(
    reader: &mut R,
    registry: &AppCaptureRegistry,
    control: &ControlClient,
) {
    while let Some(frame) = read_len_prefixed_frame(reader, MAX_CONTROL_FRAME_LEN) {
        if let Some(frame) = app_control_frame(&frame) {
            relay_app_control_frame(frame, registry, control);
        } else {
            tracing::debug!("serve-webrtc: ignoring non-control frame on app control fd");
        }
    }
}

#[cfg(unix)]
fn spawn_app_control_reader_from_env(
    registry: Arc<AppCaptureRegistry>,
    control: ControlClient,
) -> bool {
    use std::os::fd::FromRawFd;

    let raw_fd = match std::env::var(APP_CONTROL_FD_ENV) {
        Ok(raw) => raw,
        Err(_) => return false,
    };
    let Some(fd) = raw_fd.parse::<i32>().ok().filter(|fd| *fd > 2) else {
        tracing::warn!("serve-webrtc: invalid {APP_CONTROL_FD_ENV}={raw_fd:?}; falling back to stdin control frames");
        return false;
    };
    tracing::info!("serve-webrtc: app control reader using fd {fd}");
    // SAFETY: ScreenServer passes an owned child-side pipe fd via RP_AU_CONTROL_FD.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    match std::thread::Builder::new()
        .name("app-control-reader".into())
        .spawn(move || read_app_control_stream(&mut file, &registry, &control))
    {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!("serve-webrtc: failed to spawn app control reader: {e}");
            false
        }
    }
}

#[cfg(not(unix))]
fn spawn_app_control_reader_from_env(
    _registry: Arc<AppCaptureRegistry>,
    _control: ControlClient,
) -> bool {
    false
}

fn bounded_reason(raw: impl Into<String>) -> String {
    const MAX_REASON: usize = 800;
    let reason = raw.into();
    if reason.chars().count() <= MAX_REASON {
        return reason;
    }
    let mut shortened: String = reason.chars().take(MAX_REASON).collect();
    shortened.push_str("...");
    shortened
}

fn status_from_input_helper_line(line: &str, helper: &str) -> Option<RdStatus> {
    let payload = line.strip_prefix("RPINPUT ")?;
    let status: InputHelperStatus = serde_json::from_str(payload).ok()?;
    match status.kind.as_str() {
        "ready" => Some(RdStatus::InputReady {
            helper: helper.to_string(),
            ax_trusted: status.ax_trusted.unwrap_or(true),
            display_id: status.display_id,
            width: status.width,
            height: status.height,
        }),
        "error" => Some(RdStatus::InputFailed {
            reason: bounded_reason(
                status
                    .reason
                    .unwrap_or_else(|| "remote input helper failed".to_string()),
            ),
        }),
        _ => None,
    }
}

fn wire_input_data_channel(dc: &Arc<RTCDataChannel>, in_tx: InputTx) {
    let label = dc.label().to_string();
    dc.on_open(Box::new(move || {
        tracing::info!("serve-webrtc: input DataChannel '{label}' open");
        Box::pin(async {})
    }));
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let tx = in_tx.clone();
        Box::pin(async move {
            let _ = tx.send(msg.data.to_vec());
        })
    }));
}

fn should_forward_input_message(json: &[u8], last_applied_seq: &mut u64) -> bool {
    let parsed: serde_json::Value = match serde_json::from_slice(json) {
        Ok(value) => value,
        Err(_) => return true,
    };
    let seq = match parsed.get("seq").and_then(serde_json::Value::as_u64) {
        Some(seq) => seq,
        None => return true,
    };
    let kind = parsed.get("t").and_then(serde_json::Value::as_str);
    if kind == Some("m") && seq <= *last_applied_seq {
        tracing::debug!(
            "serve-webrtc: dropping stale rp-move seq={seq} last_applied_seq={}",
            *last_applied_seq
        );
        return false;
    }
    *last_applied_seq = (*last_applied_seq).max(seq);
    true
}

async fn configure_input_data_channels(
    pc: &Arc<webrtc::peer_connection::RTCPeerConnection>,
) -> Result<(Vec<Arc<RTCDataChannel>>, InputRx), SessionError> {
    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let incoming_tx = in_tx.clone();
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let tx = incoming_tx.clone();
        Box::pin(async move {
            let label = dc.label().to_string();
            if label == "rp-ctl" || label == "rp-move" {
                wire_input_data_channel(&dc, tx);
            } else {
                tracing::debug!("serve-webrtc: ignoring unexpected input DataChannel '{label}'");
            }
        })
    }));

    let ctl = pc
        .create_data_channel("rp-ctl", None)
        .await
        .map_err(SessionError::from)?;
    let mv_init = RTCDataChannelInit {
        ordered: Some(false),
        max_retransmits: Some(0),
        ..Default::default()
    };
    let mv = pc
        .create_data_channel("rp-move", Some(mv_init))
        .await
        .map_err(SessionError::from)?;
    for dc in [&ctl, &mv] {
        wire_input_data_channel(dc, in_tx.clone());
    }
    Ok((vec![ctl, mv], in_rx))
}

fn spawn_input_helper(
    input_rx: InputRx,
    sig_tx: mpsc::UnboundedSender<String>,
    display_id: Option<u32>,
) {
    match input_helper_path() {
        Ok(bin) => {
            let mut command = Command::new(&bin);
            command.stdin(Stdio::piped()).stderr(Stdio::piped());
            if let Some(display_id) = display_id {
                command.env("RP_CAPTURE_DISPLAY_ID", display_id.to_string());
            }
            match command.spawn() {
                Ok(mut child) => {
                    if let Some(stderr) = child.stderr.take() {
                        let sig_tx = sig_tx.clone();
                        let helper = bin.clone();
                        std::thread::Builder::new()
                            .name("rp-input-stderr".into())
                            .spawn(move || {
                                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                                    if let Some(status) =
                                        status_from_input_helper_line(&line, &helper)
                                    {
                                        queue_status(&sig_tx, status);
                                    } else if line.starts_with("RPIN ") {
                                        tracing::debug!("serve-webrtc input: {line}");
                                    } else {
                                        tracing::info!("serve-webrtc input: {line}");
                                    }
                                }
                            })
                            .ok();
                    }
                    if let Some(mut stdin) = child.stdin.take() {
                        std::thread::Builder::new()
                            .name("rp-input-writer".into())
                            .spawn(move || {
                                let mut last_applied_seq = 0;
                                while let Ok(json) = input_rx.recv() {
                                    if !should_forward_input_message(&json, &mut last_applied_seq) {
                                        continue;
                                    }
                                    let len = (json.len() as u32).to_be_bytes();
                                    if stdin.write_all(&len).is_err()
                                        || stdin.write_all(&json).is_err()
                                    {
                                        break;
                                    }
                                }
                                drop(stdin);
                                let _ = child.wait();
                            })
                            .ok();
                    } else {
                        queue_status(
                            &sig_tx,
                            RdStatus::InputFailed {
                                reason: format!("input helper '{bin}' did not expose stdin"),
                            },
                        );
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
                Err(e) => {
                    let reason =
                        format!("input helper '{bin}' spawn failed (remote input disabled): {e}");
                    tracing::warn!("serve-webrtc: {reason}");
                    queue_status(&sig_tx, RdStatus::InputFailed { reason });
                }
            }
        }
        Err(reason) => {
            tracing::warn!("serve-webrtc: {reason}");
            queue_status(&sig_tx, RdStatus::InputFailed { reason });
        }
    }
}

fn queue_status(sig_tx: &mpsc::UnboundedSender<String>, status: RdStatus) {
    match status.to_signaling_text() {
        Ok(text) => {
            let _ = sig_tx.send(text);
        }
        Err(e) => tracing::warn!("serve-webrtc: could not serialize status: {e}"),
    }
}

async fn send_status_ws(ws_tx: &mut WsTx, status: RdStatus) -> Result<(), SessionError> {
    let text = status.to_signaling_text()?;
    ws_tx
        .send(Message::Text(text.into()))
        .await
        .map_err(|e| SessionError::WsHandshake(format!("send status: {e}")))
}

fn session_rejection(error: &SessionError) -> ErrorResponse {
    let status = match error {
        SessionError::MissingToken | SessionError::InvalidToken => StatusCode::UNAUTHORIZED,
        SessionError::TokenMismatch => StatusCode::FORBIDDEN,
        _ => StatusCode::BAD_REQUEST,
    };
    let mut response = ErrorResponse::new(Some(error.to_string()));
    *response.status_mut() = status;
    response
}

async fn serve_session(
    seq: u64,
    accepted: AcceptedSignaling,
    cancel: CancellationToken,
) -> Result<(), SessionError> {
    let token = accepted.token;
    let capture_config = accepted.capture_config;
    let ws = accepted.ws;
    let (mut ws_tx, ws_rx) = ws.split();
    let control = app_capture_control_client();

    // --- build webrtc API with H264 ---
    let mut m = MediaEngine::default();
    m.register_default_codecs()?;
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut m)?;
    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build();
    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration::default())
            .await
            .map_err(SessionError::from)?,
    );
    let peer_setup = PeerSetup::new(pc);

    let track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90000,
            sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                .to_owned(),
            ..Default::default()
        },
        "video".to_owned(),
        "xpair-screen".to_owned(),
    ));
    let rtp_sender = match peer_setup
        .pc
        .add_track(track.clone() as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(SessionError::from)
    {
        Ok(sender) => sender,
        Err(error) => return peer_setup.close_with(error).await,
    };
    let abr_loss = Arc::new(Mutex::new(AbrSignalState::default()));
    let abr_frames = Arc::new(AtomicU64::new(0));

    // RTCP reader: the client sends PictureLossIndication / FullIntraRequest when it
    // loses a keyframe (e.g. a packet of the 76KB IDR dropped on a lossy link). Forward
    // that as a keyframe control op so the parent app forces a fresh IDR —
    // otherwise the remote viewer stays BLACK forever. read_rtcp() returning Err ends
    // the task (session over). In standalone mode (no RP_AU_STDIN) the parent ignores
    // the control op harmlessly; the loop still drains RTCP as webrtc-rs expects.
    {
        let rtp_sender = rtp_sender.clone();
        let control = control.clone();
        let abr_loss = abr_loss.clone();
        tokio::spawn(async move {
            use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
            use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
            use webrtc::rtcp::receiver_report::ReceiverReport;
            use webrtc::rtcp::transport_feedbacks::transport_layer_nack::TransportLayerNack;
            let pli_cooldown = std::env::var("RP_PLI_COOLDOWN_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .map(Duration::from_millis)
                .unwrap_or_default();
            let mut last_forced: Option<Instant> = None;
            let mut suppressed_plis = 0u64;
            while let Ok((packets, _attrs)) = rtp_sender.read_rtcp().await {
                for pkt in packets {
                    let any = pkt.as_any();
                    if any.downcast_ref::<PictureLossIndication>().is_some()
                        || any.downcast_ref::<FullIntraRequest>().is_some()
                    {
                        let now = Instant::now();
                        if pli_should_force(last_forced, now, pli_cooldown) {
                            tracing::info!("serve-webrtc: RTCP PLI/FIR -> requesting keyframe");
                            control.keyframe_noack(seq);
                            last_forced = Some(now);
                        } else if let Some(last) = last_forced {
                            suppressed_plis += 1;
                            tracing::debug!(
                                "serve-webrtc: RTCP PLI/FIR suppressed by cooldown ({}ms since last IDR)",
                                now.duration_since(last).as_millis()
                            );
                        }
                    }
                    if let Some(rr) = any.downcast_ref::<ReceiverReport>() {
                        let selected = if let Ok(state) = abr_loss.lock() {
                            state.preferred_media_ssrc.and_then(|ssrc| {
                                rr.reports.iter().find(|report| report.ssrc == ssrc)
                            })
                        } else {
                            None
                        }
                        .or_else(|| {
                            if rr.reports.len() == 1 {
                                rr.reports.first()
                            } else {
                                rr.reports
                                    .iter()
                                    .max_by(|a, b| a.fraction_lost.cmp(&b.fraction_lost))
                            }
                        });
                        if let Some(report) = selected {
                            let loss = report.fraction_lost as f32 / 256.0;
                            if let Ok(mut state) = abr_loss.lock() {
                                state.last_loss = Some(loss);
                                state.last_rr = Some(Instant::now());
                                state.preferred_media_ssrc.get_or_insert(report.ssrc);
                            }
                        }
                    }
                    if let Some(nack) = any.downcast_ref::<TransportLayerNack>() {
                        let count = nack_sequence_count(nack);
                        if count > 0 {
                            if let Ok(mut state) = abr_loss.lock() {
                                state.preferred_media_ssrc = Some(nack.media_ssrc);
                                state.nack_count = state.nack_count.saturating_add(count);
                            }
                        }
                    }
                }
            }
            if suppressed_plis > 0 {
                tracing::info!(
                    "serve-webrtc: RTCP reader suppressed {suppressed_plis} PLI/FIR keyframe request(s) by cooldown"
                );
            }
            tracing::info!("serve-webrtc: RTCP reader ended (sender closed)");
        });
    }

    // --- ICE candidate trickle: PC -> browser (via an mpsc to the WS writer) ---
    let (sig_tx, sig_rx) = mpsc::unbounded_channel::<String>();
    {
        let sig_tx = sig_tx.clone();
        peer_setup.pc.on_ice_candidate(Box::new(move |cand| {
            let sig_tx = sig_tx.clone();
            Box::pin(async move {
                if let Some(c) = cand {
                    if let Ok(init) = c.to_json() {
                        let msg = serde_json::json!({
                            "type": "candidate",
                            "candidate": init.candidate,
                            "sdpMid": init.sdp_mid,
                            "sdpMLineIndex": init.sdp_mline_index,
                        });
                        let _ = sig_tx.send(msg.to_string());
                    }
                }
            })
        }));
    }
    // Peer-state callback is a gate, not a shared flag: Connected is delivered
    // over a channel, and only that transition can construct ConnectedSession.
    let (state_tx, state_rx) = mpsc::unbounded_channel::<PeerEvent>();
    peer_setup
        .pc
        .on_peer_connection_state_change(Box::new(move |s| {
            use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
            tracing::info!("serve-webrtc: peer connection state: {s}");
            match s {
                RTCPeerConnectionState::Connected => {
                    let _ = state_tx.send(PeerEvent::Connected);
                }
                RTCPeerConnectionState::Disconnected => {}
                RTCPeerConnectionState::Failed => {
                    let _ = state_tx.send(PeerEvent::Terminal(PeerFailureKind::Failed));
                }
                RTCPeerConnectionState::Closed => {
                    let _ = state_tx.send(PeerEvent::Terminal(PeerFailureKind::Closed));
                }
                _ => {}
            }
            Box::pin(async {})
        }));

    let (au_tx, mut au_rx) = mpsc::channel::<Vec<u8>>(16);

    // rtp task: forward access units to the track as H264 samples
    let track_w = track.clone();
    let abr_frames_w = abr_frames.clone();
    let frame_dur = Duration::from_secs_f64(1.0 / capture_config.fps as f64);
    tokio::spawn(async move {
        let mut frames: u64 = 0;
        let mut deferred_after_keyframe: Option<Vec<u8>> = None;
        loop {
            let first_au = if let Some(deferred) = deferred_after_keyframe.take() {
                deferred
            } else {
                match au_rx.recv().await {
                    Some(au) => au,
                    None => break,
                }
            };
            let (mut latest_keyframe, mut latest_delta) = if is_h264_keyframe_au(&first_au) {
                (Some(first_au), None)
            } else {
                (None, Some(first_au))
            };
            let mut dropped_queued = 0u64;
            while let Ok(newer) = au_rx.try_recv() {
                dropped_queued = dropped_queued.wrapping_add(1);
                if is_h264_keyframe_au(&newer) {
                    latest_keyframe = Some(newer);
                    latest_delta = None;
                } else {
                    latest_delta = Some(newer);
                }
            }
            if dropped_queued > 0 {
                tracing::debug!("serve-webrtc: dropped {dropped_queued} queued stale AU(s)");
            }
            let au = if let Some(keyframe) = latest_keyframe {
                deferred_after_keyframe = latest_delta;
                keyframe
            } else if let Some(delta) = latest_delta {
                delta
            } else {
                continue;
            };
            // §7 long-lived guard: this is the ACTIVE media path (serve-webrtc), so rust.log must be
            // rotated mid-session, not only at init. Cheap stat every ~300 frames (~10s @ 30fps).
            frames = frames.wrapping_add(1);
            if frames.is_multiple_of(300) {
                crate::log::rotate_guard();
            }
            // DIAG: confirm the host actually forwards encoded frames to RTP (first few + every 30th).
            // AU size also tells keyframe (large) vs delta (small) — helps diagnose a black viewer.
            if frames <= 3 || frames.is_multiple_of(30) {
                tracing::info!("serve-webrtc: rtp frame #{frames} ({} bytes au)", au.len());
            }
            let sample = Sample {
                data: Bytes::from(au),
                duration: frame_dur,
                ..Default::default()
            };
            abr_frames_w.fetch_add(1, Ordering::Relaxed);
            if track_w.write_sample(&sample).await.is_err() {
                break;
            }
        }
    });

    // --- remote input: create TWO DataChannels BEFORE the offer ---
    // Host-created channels put the m=application (SCTP) section in the first
    // offer (no renegotiation). Client-created channels are also accepted here;
    // the channel-ownership redesign is tracked separately.
    // rp-ctl = reliable/ordered (text/keys/clicks); rp-move = unreliable/unordered
    // (mousemove — stale positions are worthless, dropping is correct) (B4).
    let (_input_dcs, input_rx) = match configure_input_data_channels(&peer_setup.pc).await {
        Ok(channels) => channels,
        Err(error) => return peer_setup.close_with(error).await,
    };

    // --- create offer, send to browser ---
    let offer = match peer_setup
        .pc
        .create_offer(None)
        .await
        .map_err(SessionError::from)
    {
        Ok(offer) => offer,
        Err(error) => return peer_setup.close_with(error).await,
    };
    if let Err(error) = peer_setup
        .pc
        .set_local_description(offer.clone())
        .await
        .map_err(SessionError::from)
    {
        return peer_setup.close_with(error).await;
    }
    let offer_msg = serde_json::json!({ "type": "offer", "sdp": offer.sdp }).to_string();
    if let Err(error) = ws_tx
        .send(Message::Text(offer_msg.into()))
        .await
        .map_err(|e| SessionError::WsHandshake(format!("send offer: {e}")))
    {
        return peer_setup.close_with(error).await;
    }

    let io = SignalingIo {
        ws_tx,
        ws_rx,
        sig_rx,
    };
    let peer = peer_setup.into_resources(_input_dcs, input_rx);
    NegotiatingSession {
        seq,
        token,
        started: Instant::now(),
        io,
        sig_tx,
        peer,
        state_rx,
        au_tx,
        capture_config,
        control,
        cancel,
        abr_loss,
        abr_frames,
    }
    .run_until_connected()
    .await?
    .run()
    .await
}

impl NegotiatingSession {
    async fn run_until_connected(mut self) -> Result<ConnectedSession, SessionError> {
        let deadline = tokio::time::sleep(CONNECT_DEADLINE);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => {
                    let _ = self
                        .send_status(RdStatus::Superseded {
                            reason: "remote desktop session was replaced by a newer connection".to_string(),
                        })
                        .await;
                    let _ = self.peer.pc.close().await;
                    return Err(SessionError::Superseded);
                }
                _ = &mut deadline => {
                    let _ = self.peer.pc.close().await;
                    return Err(SessionError::ConnectDeadlineExceeded);
                }
                Some(event) = self.state_rx.recv() => {
                    match event {
                        PeerEvent::Connected => {
                            tracing::info!(
                                "serve-webrtc: session {} connected in {:?}",
                                self.token.redacted(),
                                self.started.elapsed()
                            );
                            return self.into_connected().await;
                        }
                        PeerEvent::Terminal(peer) => {
                            let _ = self
                                .send_status(RdStatus::PeerFailed {
                                    peer,
                                    reason: format!("peer connection {peer} before capture started"),
                                })
                                .await;
                            let _ = self.peer.pc.close().await;
                            return Err(SessionError::PeerFailed(peer.to_string()));
                        }
                    }
                }
                Some(out) = self.io.sig_rx.recv() => {
                    if let Err(error) = self.send_signaling(out).await {
                        let _ = self.peer.pc.close().await;
                        return Err(error);
                    }
                }
                msg = self.io.ws_rx.next() => {
                    let Some(msg) = msg else {
                        let _ = self.peer.pc.close().await;
                        return Err(SessionError::SignalingClosed);
                    };
                    let msg = match msg {
                        Ok(m) => m,
                        Err(e) => {
                            let _ = self.peer.pc.close().await;
                            return Err(SessionError::WsHandshake(e.to_string()));
                        }
                    };
                    let closed = match self.apply_ws_message(msg).await {
                        Ok(closed) => closed,
                        Err(error) => {
                            let _ = self.peer.pc.close().await;
                            return Err(error);
                        }
                    };
                    if closed {
                        let _ = self.peer.pc.close().await;
                        return Err(SessionError::SignalingClosed);
                    }
                }
            }
        }
    }

    async fn into_connected(mut self) -> Result<ConnectedSession, SessionError> {
        let mut capture = match CaptureSource::start(
            self.capture_config,
            self.au_tx.clone(),
            self.sig_tx.clone(),
            self.seq,
            self.control.clone(),
        )
        .await
        {
            Ok(capture) => capture,
            Err(e) => {
                if let Some(status) = e.status {
                    if let Err(send_error) = self.send_status(status).await {
                        tracing::warn!(
                            "serve-webrtc: failed to send capture startup failure status: {send_error}"
                        );
                    }
                }
                let _ = self.peer.pc.close().await;
                return Err(e.error);
            }
        };
        let abr_cancel = CancellationToken::new();
        spawn_abr_controller(
            self.capture_config.bitrate,
            capture.bitrate_control(),
            self.abr_loss.clone(),
            self.abr_frames.clone(),
            abr_cancel.clone(),
        );
        if let Some(input_rx) = self.peer.input_rx.take() {
            match capture.capture_display_id_for_input().await {
                Ok(display_id) => {
                    spawn_input_helper(input_rx, self.sig_tx.clone(), display_id);
                }
                Err(reason) => {
                    tracing::warn!("serve-webrtc: {reason}");
                    queue_status(&self.sig_tx, RdStatus::InputFailed { reason });
                }
            }
        }
        Ok(ConnectedSession {
            token: self.token,
            started: self.started,
            io: self.io,
            peer: self.peer,
            state_rx: self.state_rx,
            _capture: capture,
            _caffeinate: CaffeinateGuard::start(),
            cancel: self.cancel,
            abr_cancel,
        })
    }

    async fn send_status(&mut self, status: RdStatus) -> Result<(), SessionError> {
        send_status_ws(&mut self.io.ws_tx, status).await
    }

    async fn send_signaling(&mut self, out: String) -> Result<(), SessionError> {
        self.io
            .ws_tx
            .send(Message::Text(out.into()))
            .await
            .map_err(|e| SessionError::WsHandshake(format!("send signaling: {e}")))
    }

    async fn apply_ws_message(&mut self, msg: Message) -> Result<bool, SessionError> {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => return Ok(true),
            _ => return Ok(false),
        };
        apply_signaling_message(&self.peer.pc, &text).await?;
        Ok(false)
    }
}

impl ConnectedSession {
    async fn run(mut self) -> Result<(), SessionError> {
        let result = self.run_inner().await;
        self.abr_cancel.cancel();
        let _ = self.peer.pc.close().await;
        tracing::info!(
            "serve-webrtc: session {} closed after {:?}",
            self.token.redacted(),
            self.started.elapsed()
        );
        result
    }

    async fn run_inner(&mut self) -> Result<(), SessionError> {
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => {
                    let _ = self
                        .send_status(RdStatus::Superseded {
                            reason: "remote desktop session was replaced by a newer connection".to_string(),
                        })
                        .await;
                    return Err(SessionError::Superseded);
                }
                Some(event) = self.state_rx.recv() => {
                    match event {
                        PeerEvent::Connected => {}
                        PeerEvent::Terminal(PeerFailureKind::Closed) => return Ok(()),
                        PeerEvent::Terminal(peer) => {
                            let _ = self
                                .send_status(RdStatus::PeerFailed {
                                    peer,
                                    reason: format!("peer connection {peer}"),
                                })
                                .await;
                            return Err(SessionError::PeerFailed(peer.to_string()));
                        }
                    }
                }
                Some(out) = self.io.sig_rx.recv() => {
                    self.io
                        .ws_tx
                        .send(Message::Text(out.into()))
                        .await
                        .map_err(|e| SessionError::WsHandshake(format!("send signaling: {e}")))?;
                }
                msg = self.io.ws_rx.next() => {
                    let Some(msg) = msg else {
                        return Ok(());
                    };
                    let msg = msg.map_err(|e| SessionError::WsHandshake(e.to_string()))?;
                    match msg {
                        Message::Close(_) => return Ok(()),
                        Message::Text(t) => apply_signaling_message(&self.peer.pc, t.as_ref()).await?,
                        _ => {}
                    }
                }
            }
        }
    }

    async fn send_status(&mut self, status: RdStatus) -> Result<(), SessionError> {
        send_status_ws(&mut self.io.ws_tx, status).await
    }
}

async fn apply_signaling_message(
    pc: &Arc<webrtc::peer_connection::RTCPeerConnection>,
    text: &str,
) -> Result<(), SessionError> {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("answer") => {
            if let Some(sdp) = v.get("sdp").and_then(|s| s.as_str()) {
                let ans = RTCSessionDescription::answer(sdp.to_owned())?;
                pc.set_remote_description(ans).await?;
            }
        }
        Some("candidate") => {
            if let Some(c) = v.get("candidate").and_then(|s| s.as_str()) {
                let init = RTCIceCandidateInit {
                    candidate: c.to_owned(),
                    sdp_mid: v
                        .get("sdpMid")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_owned()),
                    sdp_mline_index: v
                        .get("sdpMLineIndex")
                        .and_then(|x| x.as_u64())
                        .map(|n| n as u16),
                    ..Default::default()
                };
                let _ = pc.add_ice_candidate(init).await;
            }
        }
        _ => {}
    }
    Ok(())
}

struct CaffeinateGuard {
    child: Option<std::process::Child>,
}

impl CaffeinateGuard {
    fn start() -> Self {
        let child = Command::new("caffeinate").arg("-d").spawn().ok();
        Self { child }
    }
}

impl Drop for CaffeinateGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Per-session capture source: either a spawned `rp-screencap` child (default
/// standalone mode) or an app-capture registration (`RP_AU_STDIN=1`, the
/// in-app capture path). The app-capture fd readers are process-lifetime
/// singletons; the session handle only installs/removes the current sink and
/// sends stop for its generation.
enum CaptureSource {
    Child(CaptureHandle),
    Stdin(StdinReaderHandle),
}
impl CaptureSource {
    async fn start(
        config: CaptureConfig,
        au_tx: mpsc::Sender<Vec<u8>>,
        sig_tx: mpsc::UnboundedSender<String>,
        generation: u64,
        control: ControlClient,
    ) -> Result<Self, CaptureStartError> {
        // RP_AU_STDIN=1: the parent app captures+encodes in-process (using the app's
        // Screen Recording TCC grant) and feeds already-encoded Annex-B AUs to our
        // stdin. We then ONLY do WebRTC transport — no rp-screencap spawn. stdout is
        // the framed JSON control channel back to the app.
        // Default (env unset): spawn rp-screencap exactly as before (standalone/dev).
        let au_stdin_mode = std::env::var("RP_AU_STDIN").as_deref() == Ok("1");
        if au_stdin_mode {
            let app_capture = app_capture_io();
            let handle = app_capture.register_session(generation, au_tx, sig_tx.clone());
            let start_info = match control.start(generation, config).await {
                Ok(info) => info,
                Err(ControlError::CaptureFailed { kind, reason }) => {
                    handle.stop();
                    let error = ControlError::CaptureFailed {
                        kind,
                        reason: reason.clone(),
                    }
                    .into();
                    return Err(CaptureStartError::capture_failed(kind, reason, error));
                }
                Err(ControlError::Superseded { gen, active_gen }) => {
                    handle.stop();
                    return Err(CaptureStartError::without_status(
                        ControlError::Superseded { gen, active_gen }.into(),
                    ));
                }
                Err(e) => {
                    handle.stop();
                    let reason = e.to_string();
                    return Err(CaptureStartError::capture_failed(
                        CaptureErrorKind::Unknown,
                        reason,
                        e.into(),
                    ));
                }
            };
            Ok(CaptureSource::Stdin(handle.with_start_info(start_info)))
        } else {
            match spawn_screencap(config.fps, config.bitrate, config.scale, au_tx) {
                Ok(handle) => Ok(CaptureSource::Child(handle)),
                Err(reason) => {
                    let error = SessionError::Capture(reason.clone());
                    Err(CaptureStartError::capture_failed(
                        CaptureErrorKind::HelperFailed,
                        reason,
                        error,
                    ))
                }
            }
        }
    }

    async fn capture_display_id_for_input(&mut self) -> Result<Option<u32>, String> {
        match self {
            CaptureSource::Child(_) => Ok(None),
            CaptureSource::Stdin(h) => h.capture_display_id_for_input().await,
        }
    }

    fn stop(&self) {
        match self {
            CaptureSource::Child(h) => h.stop(),
            CaptureSource::Stdin(h) => h.stop(),
        }
    }

    fn bitrate_control(&self) -> Option<AbrActuator> {
        match self {
            CaptureSource::Child(h) => h.bitrate_control(),
            CaptureSource::Stdin(h) => Some(h.bitrate_control()),
        }
    }
}

impl Drop for CaptureSource {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Handle for one app-capture generation. The process-lifetime reader threads
/// outlive this handle; `stop()` removes this generation's sink and emits a
/// generation-bearing `stop` control op to the parent so it can stop the
/// matching in-app CaptureEngine session.
struct StdinReaderHandle {
    stopped: Arc<std::sync::atomic::AtomicBool>,
    generation: u64,
    control: ControlClient,
    registry: Arc<AppCaptureRegistry>,
    start_info: Option<StartedInfo>,
}
impl StdinReaderHandle {
    fn with_start_info(mut self, start_info: StartedInfo) -> Self {
        self.start_info = Some(start_info);
        self
    }

    fn stop(&self) {
        if !self.stopped.swap(true, std::sync::atomic::Ordering::SeqCst) {
            self.control.stop_noack(self.generation);
            self.registry.deregister(self.generation);
        }
    }

    fn bitrate_control(&self) -> AbrActuator {
        AbrActuator::control(self.control.clone(), self.generation)
    }

    async fn capture_display_id_for_input(&mut self) -> Result<Option<u32>, String> {
        let Some(info) = self.start_info.take() else {
            return Err("host capture start metadata was already consumed".to_string());
        };
        info.display_id.ok_or_else(|| {
            "host capture did not report a display id; remote input disabled to avoid misaligned injection"
                .to_string()
        }).map(Some)
    }
}

/// Start the process-lifetime AU-from-stdin reader for `RP_AU_STDIN=1` mode. It
/// reads `[4B BE len][Annex-B AU]` frames from stdin and forwards them into the
/// currently registered session's `au_tx` with the same bounded drop-delta
/// policy as `spawn_screencap`'s reader thread.
/// When `RP_AU_CONTROL_FD` is present, app control ACK/event frames are read on
/// that separate fd so they cannot queue behind media pipe backpressure; otherwise
/// JSON control frames on stdin remain supported as a fallback. The thread exits
/// only on EOF/error; session teardown is handled by registry updates.
fn spawn_au_stdin_reader(
    registry: Arc<AppCaptureRegistry>,
    control: ControlClient,
    mixed_stdin_control: bool,
) {
    tracing::info!("serve-webrtc: AU-from-stdin mode (in-app capture); starting singleton reader");
    std::thread::Builder::new()
        .name("au-stdin-reader".into())
        .spawn(move || {
            let mut stdin = std::io::stdin();
            let mut dropped_delta_frames = 0u64;
            while let Some(au) = read_len_prefixed_frame(&mut stdin, MAX_AU_FRAME_LEN) {
                if mixed_stdin_control {
                    if let Some(frame) = app_control_frame(&au) {
                        relay_app_control_frame(frame, &registry, &control);
                        continue;
                    }
                } else if app_control_frame(&au).is_some() {
                    tracing::debug!("serve-webrtc: ignoring unexpected control frame on AU stdin");
                    continue;
                }
                forward_app_au(&registry, au, &mut dropped_delta_frames);
            }
        })
        .ok();
}

/// Where ABR pushes a new target bitrate. `Pipe` writes `bitrate <bps>\n` to a
/// spawned rp-screencap child's stdin (standalone path); `Control` sends a no-ack
/// `bitrate` control op to the parent app's in-process CaptureEngine encoder
/// (app-capture / `RP_AU_STDIN=1` path).
#[derive(Clone)]
enum AbrActuator {
    Pipe(Arc<Mutex<std::process::ChildStdin>>),
    Control {
        control: ControlClient,
        generation: u64,
    },
}

impl AbrActuator {
    fn pipe(stdin: Arc<Mutex<std::process::ChildStdin>>) -> Self {
        Self::Pipe(stdin)
    }

    fn control(control: ControlClient, generation: u64) -> Self {
        Self::Control {
            control,
            generation,
        }
    }

    fn set_bitrate(&self, bps: u32) -> bool {
        match self {
            Self::Pipe(stdin) => {
                let line = format!("bitrate {bps}\n");
                stdin
                    .lock()
                    .map(|mut stdin| stdin.write_all(line.as_bytes()).is_ok())
                    .unwrap_or(false)
            }
            Self::Control {
                control,
                generation,
            } => {
                // Fire-and-forget: the app applies the new bitrate best-effort on
                // its encoder session; there is no ack to wait on.
                control.bitrate_noack(*generation, bps);
                true
            }
        }
    }
}

fn spawn_abr_controller(
    spawn_bps: u32,
    actuator: Option<AbrActuator>,
    signal_state: Arc<Mutex<AbrSignalState>>,
    frame_counter: Arc<AtomicU64>,
    cancel: CancellationToken,
) {
    if !abr_enabled() {
        return;
    }
    let cfg = AbrCfg::from_env();
    let max_bps = env_u32("RP_ABR_MAX_BPS", spawn_bps).min(spawn_bps);
    let min_bps = env_u32("RP_ABR_MIN_BPS", 150_000).min(max_bps);
    tracing::info!(
        "serve-webrtc: ABR enabled interval={}ms loss_lo={} loss_hi={} raise_after={} raise_factor={} nack_lo={}/s nack_hi={}/s min={}bps max={}bps actuation={}",
        cfg.interval.as_millis(),
        cfg.loss_lo,
        cfg.loss_hi,
        cfg.raise_after,
        cfg.raise_factor,
        cfg.nack_lo,
        cfg.nack_hi,
        min_bps,
        max_bps,
        actuator.is_some()
    );
    if actuator.is_none() {
        // No bitrate actuator wired for this capture path, so this process cannot
        // retarget the encoder. Be honest that ABR is observe-only here rather than
        // implying it is throttling the encoder under congestion.
        tracing::warn!(
            "serve-webrtc: ABR has no bitrate actuator on this capture path; running OBSERVE-ONLY — encoder bitrate will NOT change under congestion"
        );
    }
    tokio::spawn(async move {
        let started = Instant::now();
        let mut target_bps = spawn_bps.clamp(min_bps, max_bps);
        let mut sent_bps = spawn_bps;
        let mut last_frames = frame_counter.load(Ordering::Relaxed);
        let mut last_cut_at: Option<Instant> = None;
        let mut raise_streak = 0usize;
        let mut tick = tokio::time::interval(cfg.interval);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tick.tick() => {
                    let now = Instant::now();
                    let (loss_rr, last_rr, nacks) = signal_state
                        .lock()
                        .map(|mut state| {
                            let nacks = state.nack_count;
                            state.nack_count = 0;
                            (state.last_loss, state.last_rr, nacks)
                        })
                        .unwrap_or((None, None, 0));
                    let nack_rate = nacks as f32 / cfg.interval.as_secs_f32();
                    let no_recent_rr = last_rr
                        .map(|last_rr| now.duration_since(last_rr) > ABR_NO_RR_CUT_AFTER)
                        .unwrap_or(true);

                    let frames = frame_counter.load(Ordering::Relaxed);
                    let screen_changed = frames != last_frames;
                    last_frames = frames;

                    // A stale RR is only congestion when we're actively sending frames;
                    // on a static screen SCK emits nothing so RR silence is benign.
                    let elapsed_past_cut = now.duration_since(started) >= ABR_NO_RR_CUT_AFTER;
                    let starved = abr_starved(no_recent_rr, screen_changed, elapsed_past_cut);
                    let loss = match (loss_rr, no_recent_rr) {
                        (Some(loss), false) => Some(loss),
                        _ if starved => Some(1.0),
                        _ => None,
                    };

                    raise_streak = abr_raise_streak_next(raise_streak, loss, nack_rate, &cfg);

                    let mut next_bps =
                        if starved {
                            min_bps
                        } else if nack_rate >= cfg.nack_hi {
                            abr_next_bps(
                                target_bps,
                                loss.unwrap_or(0.0),
                                nack_rate,
                                raise_streak,
                                min_bps,
                                max_bps,
                                &cfg,
                            )
                        } else if let Some(loss) = loss {
                            abr_next_bps(
                                target_bps,
                                loss,
                                nack_rate,
                                raise_streak,
                                min_bps,
                                max_bps,
                                &cfg,
                            )
                        } else {
                            target_bps
                        };
                    if next_bps > target_bps && !screen_changed {
                        next_bps = target_bps;
                    }
                    if next_bps > target_bps
                        && last_cut_at
                            .map(|last| now.duration_since(last) < cfg.interval)
                            .unwrap_or(false)
                    {
                        next_bps = target_bps;
                    }
                    if next_bps < target_bps {
                        last_cut_at = Some(now);
                    }

                    let logged_loss = loss.unwrap_or(f32::NAN);
                    tracing::info!(
                        "serve-webrtc: ABR tick loss_rr={logged_loss:.3} nack_rate={nack_rate:.1} raise_streak={raise_streak} target={next_bps}bps"
                    );
                    if next_bps != target_bps {
                        let was = target_bps;
                        target_bps = next_bps;
                        tracing::info!(
                            "serve-webrtc: ABR: loss_rr={logged_loss:.3} nack_rate={nack_rate:.1} target={target_bps}bps (was {was})"
                        );
                    }
                    if bitrate_change_exceeds_hysteresis(sent_bps, target_bps) {
                        if let Some(actuator) = actuator.as_ref() {
                            if actuator.set_bitrate(target_bps) {
                                sent_bps = target_bps;
                            } else {
                                tracing::warn!("serve-webrtc: ABR bitrate command failed");
                                break;
                            }
                        } else {
                            sent_bps = target_bps;
                        }
                    }
                }
            }
        }
    });
}

/// Handle to stop the capture/encode helper process.
struct CaptureHandle {
    child: std::sync::Mutex<std::process::Child>,
    control_stdin: Option<Arc<Mutex<std::process::ChildStdin>>>,
}
impl CaptureHandle {
    fn stop(&self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    fn bitrate_control(&self) -> Option<AbrActuator> {
        self.control_stdin
            .as_ref()
            .map(|stdin| AbrActuator::pipe(stdin.clone()))
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Spawn `rp-screencap` (ScreenCaptureKit capture + VideoToolbox H.264 in ONE
/// process: IOSurface zero-copy, GPU-scaled, on-change — no raw-frame pipe, no
/// Rust-side capture/swizzle) and stream its Annex-B access units to `au_tx`.
fn spawn_screencap(
    fps: u32,
    bitrate: u32,
    scale: f32,
    au_tx: mpsc::Sender<Vec<u8>>,
) -> Result<CaptureHandle, String> {
    let bin = screencap_path();
    tracing::info!("serve-webrtc: capture+encode '{bin}' @ {fps}fps {bitrate}bps scale={scale}");
    let mut command = Command::new(&bin);
    command
        .arg(fps.to_string())
        .arg(bitrate.to_string())
        .arg(format!("{scale}"))
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if abr_enabled() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|e| format!("spawn '{bin}': {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no helper stdout")?;
    let control_stdin = if abr_enabled() {
        child.stdin.take().map(|stdin| Arc::new(Mutex::new(stdin)))
    } else {
        None
    };

    // reader thread: helper stdout (length-prefixed Annex-B AUs) -> au_tx
    std::thread::Builder::new()
        .name("rtp-reader".into())
        .spawn(move || {
            let mut len_buf = [0u8; 4];
            let mut dropped_delta_frames = 0u64;
            loop {
                if stdout.read_exact(&mut len_buf).is_err() {
                    break;
                }
                let len = u32::from_be_bytes(len_buf) as usize;
                if len == 0 || len > 64 * 1024 * 1024 {
                    break;
                }
                let mut au = vec![0u8; len];
                if stdout.read_exact(&mut au).is_err() {
                    break;
                }
                if !forward_au_latest(&au_tx, au, &mut dropped_delta_frames) {
                    break;
                }
            }
        })
        .map_err(|e| format!("spawn reader thread: {e}"))?;

    Ok(CaptureHandle {
        child: std::sync::Mutex::new(child),
        control_stdin,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{AckOp, AckResult, ControlAck, ControlWriter};
    use std::sync::Mutex;

    #[derive(Default)]
    struct TestControlWriter {
        frames: Mutex<Vec<Vec<u8>>>,
    }

    impl TestControlWriter {
        fn frames(&self) -> Vec<Vec<u8>> {
            self.frames.lock().expect("test writer lock").clone()
        }
    }

    impl ControlWriter for TestControlWriter {
        fn write_frame(&self, payload: &[u8]) -> Result<(), ControlError> {
            self.frames
                .lock()
                .expect("test writer lock")
                .push(payload.to_vec());
            Ok(())
        }
    }

    fn request(uri: &str) -> Request {
        Request::builder()
            .uri(uri)
            .body(())
            .expect("test request should build")
    }

    fn token(ch: char) -> String {
        std::iter::repeat_n(ch, SESSION_TOKEN_MIN_LEN).collect()
    }

    fn test_capture_config() -> CaptureConfig {
        CaptureConfig {
            fps: 30,
            bitrate: 4_000_000,
            scale: 1.0,
        }
    }

    async fn wait_for_frames(writer: &TestControlWriter, count: usize) -> Vec<Vec<u8>> {
        for _ in 0..50 {
            let frames = writer.frames();
            if frames.len() >= count {
                return frames;
            }
            tokio::task::yield_now().await;
        }
        panic!("timed out waiting for {count} control frame(s)");
    }

    #[test]
    fn control_actuator_writes_bitrate_frame() {
        let writer = Arc::new(TestControlWriter::default());
        let control = ControlClient::new(writer.clone());
        let actuator = AbrActuator::control(control, 42);
        assert!(actuator.set_bitrate(1_500_000));
        let frames = writer.frames();
        assert_eq!(frames.len(), 1);
        assert_eq!(
            String::from_utf8(frames[0].clone()).expect("utf8"),
            r#"{"v":1,"op":"bitrate","gen":42,"rid":"42-1","bitrate":1500000}"#
        );
    }

    #[test]
    fn pli_cooldown_decision_forces_only_after_cooldown() {
        let now = Instant::now();
        let cooldown = Duration::from_millis(200);

        assert!(pli_should_force(None, now, cooldown));
        assert!(pli_should_force(Some(now), now, Duration::from_millis(0)));
        assert!(!pli_should_force(
            Some(now),
            now + Duration::from_millis(199),
            cooldown
        ));
        assert!(pli_should_force(
            Some(now),
            now + Duration::from_millis(200),
            cooldown
        ));
    }

    fn test_abr_cfg() -> AbrCfg {
        AbrCfg {
            interval: Duration::from_millis(1500),
            loss_lo: 0.02,
            loss_hi: 0.10,
            raise_after: 3,
            raise_factor: 1.05,
            nack_lo: 5.0,
            nack_hi: 50.0,
        }
    }

    #[test]
    fn abr_next_bps_holds_clean_tick_below_raise_threshold() {
        let cfg = test_abr_cfg();

        assert_eq!(
            abr_next_bps(1_000_000, 0.01, 0.0, 2, 150_000, 2_000_000, &cfg),
            1_000_000
        );
    }

    #[test]
    fn abr_next_bps_raises_at_streak_threshold_and_clamps_to_max() {
        let cfg = test_abr_cfg();

        assert_eq!(
            abr_next_bps(1_000_000, 0.01, 0.0, 3, 150_000, 2_000_000, &cfg),
            1_050_000
        );
        assert_eq!(
            abr_next_bps(1_950_000, 0.0, 0.0, 3, 150_000, 2_000_000, &cfg),
            2_000_000
        );
        assert_eq!(
            abr_next_bps(2_000_000, 0.0, 0.0, 3, 150_000, 2_000_000, &cfg),
            2_000_000
        );
    }

    #[test]
    fn abr_next_bps_holds_inside_loss_band() {
        let cfg = test_abr_cfg();

        assert_eq!(
            abr_next_bps(1_000_000, 0.02, 0.0, 3, 150_000, 2_000_000, &cfg),
            1_000_000
        );
        assert_eq!(
            abr_next_bps(1_000_000, 0.05, 0.0, 3, 150_000, 2_000_000, &cfg),
            1_000_000
        );
        assert_eq!(
            abr_next_bps(1_000_000, 0.0, 5.0, 3, 150_000, 2_000_000, &cfg),
            1_000_000
        );
    }

    #[test]
    fn abr_next_bps_cuts_above_high_loss_and_clamps_to_min() {
        let cfg = test_abr_cfg();

        assert_eq!(
            abr_next_bps(1_000_000, 0.10, 0.0, 0, 150_000, 2_000_000, &cfg),
            800_000
        );
        assert_eq!(
            abr_next_bps(180_000, 0.50, 0.0, 0, 150_000, 2_000_000, &cfg),
            150_000
        );
        assert_eq!(
            abr_next_bps(150_000, 1.0, 0.0, 0, 150_000, 2_000_000, &cfg),
            150_000
        );
    }

    #[test]
    fn abr_next_bps_cuts_on_high_nack_rate_even_when_rr_loss_is_low() {
        let cfg = test_abr_cfg();

        assert_eq!(
            abr_next_bps(1_000_000, 0.0, 50.0, 0, 150_000, 2_000_000, &cfg),
            800_000
        );
        assert_eq!(
            abr_next_bps(1_000_000, 0.01, 250.0, 0, 150_000, 2_000_000, &cfg),
            800_000
        );
    }

    #[test]
    fn abr_next_bps_raises_only_when_rr_and_nacks_are_clean() {
        let cfg = test_abr_cfg();

        assert_eq!(
            abr_next_bps(1_000_000, 0.01, 4.9, 3, 150_000, 2_000_000, &cfg),
            1_050_000
        );
        assert_eq!(
            abr_next_bps(1_000_000, 0.01, 5.0, 3, 150_000, 2_000_000, &cfg),
            1_000_000
        );
    }

    #[test]
    fn abr_raise_streak_resets_on_dirty_tick() {
        let cfg = test_abr_cfg();

        assert_eq!(abr_raise_streak_next(0, Some(0.01), 4.9, &cfg), 1);
        assert_eq!(abr_raise_streak_next(1, Some(0.01), 4.9, &cfg), 2);
        assert_eq!(abr_raise_streak_next(2, Some(0.02), 0.0, &cfg), 0);
        assert_eq!(abr_raise_streak_next(2, Some(0.01), 5.0, &cfg), 0);
        assert_eq!(abr_raise_streak_next(2, None, 0.0, &cfg), 0);
    }

    #[test]
    fn abr_starved_requires_active_frames() {
        // idle screen (no frame change) => not starved even when RR is stale & elapsed
        assert!(!abr_starved(true, false, true));
        // actively sending frames + stale RR + past cut window => starved
        assert!(abr_starved(true, true, true));
        // recent RR => not starved
        assert!(!abr_starved(false, true, true));
        // not yet past the cut window => not starved
        assert!(!abr_starved(true, true, false));
    }

    #[test]
    fn bitrate_change_writes_on_exact_five_percent_raise() {
        // RAISE_FACTOR=1.05 yields an exactly-5% change; ABR_WRITE_HYSTERESIS=0.05.
        // The boundary must actuate (>=), else a single clean raise never reaches the
        // encoder.
        assert!(bitrate_change_exceeds_hysteresis(600_000, 630_000)); // exactly +5%
        assert!(!bitrate_change_exceeds_hysteresis(600_000, 600_000)); // no change
        assert!(!bitrate_change_exceeds_hysteresis(600_000, 610_000)); // <5% held
    }

    fn frame_rid(frame: &[u8]) -> String {
        let value: serde_json::Value =
            serde_json::from_slice(frame).expect("control frame should be json");
        value["rid"]
            .as_str()
            .expect("control frame should carry rid")
            .to_string()
    }

    #[test]
    fn parse_request_token_requires_exact_expected_token() {
        let expected = SessionToken::parse(&token('a')).expect("expected token should parse");
        let accepted = parse_request_token(&request(&format!("/?token={}", token('a'))), &expected)
            .expect("matching token should be accepted");
        assert_eq!(accepted, expected);

        let mismatch = parse_request_token(&request(&format!("/?token={}", token('b'))), &expected);
        assert!(matches!(mismatch, Err(SessionError::TokenMismatch)));

        let missing = parse_request_token(&request("/"), &expected);
        assert!(matches!(missing, Err(SessionError::MissingToken)));
    }

    #[test]
    fn expected_token_arg_reads_owner_file_form() {
        let raw = token('c');
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock should be after epoch")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("xpair-rd-token-{}-{unique}", std::process::id()));
        std::fs::write(&path, format!("{raw}\n")).expect("test token file should write");
        let resolved = expected_token_from_arg(&format!("@{}", path.display()))
            .expect("token file should resolve");
        let _ = std::fs::remove_file(&path);
        assert_eq!(resolved, SessionToken(raw));
    }

    #[test]
    fn superseded_ack_maps_to_session_superseded() {
        let err: SessionError = ControlError::Superseded {
            gen: 42,
            active_gen: 43,
        }
        .into();
        assert!(matches!(err, SessionError::Superseded));
    }

    #[test]
    fn error_ack_maps_to_capture_failed_with_kind_preserved() {
        let err: SessionError = ControlError::CaptureFailed {
            kind: CaptureErrorKind::StartFailed,
            reason: "missing grant".to_string(),
        }
        .into();
        match err {
            SessionError::Capture(reason) => {
                assert!(reason.contains("StartFailed"));
                assert!(reason.contains("missing grant"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn capture_start_error_carries_status_for_direct_send() {
        let err = CaptureStartError::capture_failed(
            CaptureErrorKind::StartFailed,
            "missing grant".to_string(),
            SessionError::Capture("missing grant".to_string()),
        );
        let status = err
            .status
            .as_ref()
            .expect("capture start failures should carry client status");
        let text = status
            .to_signaling_text()
            .expect("capture failure status should serialize");
        let value: serde_json::Value =
            serde_json::from_str(&text).expect("status should be valid json");
        assert_eq!(value["type"], "status");
        assert_eq!(value["kind"], "capture-failed");
        assert_eq!(value["captureKind"], "start-failed");
        assert_eq!(value["reason"], "missing grant");
        assert!(matches!(err.error, SessionError::Capture(_)));
    }

    #[tokio::test]
    async fn singleton_app_capture_io_routes_acks_and_aus_across_supersede() {
        let writer = Arc::new(TestControlWriter::default());
        let control = ControlClient::new(writer.clone());
        let app_capture = Arc::new(AppCaptureIo::new_for_test(control.clone()));

        let (au1_tx, mut au1_rx) = mpsc::channel(4);
        let (sig1_tx, _sig1_rx) = mpsc::unbounded_channel();
        let generation1 = app_capture.register_session(1, au1_tx, sig1_tx);
        let start1 = {
            let control = control.clone();
            tokio::spawn(async move { control.start(1, test_capture_config()).await })
        };
        let frames = wait_for_frames(&writer, 1).await;
        let rid1 = frame_rid(&frames[0]);
        assert_eq!(rid1, "1-1");

        let (au2_tx, mut au2_rx) = mpsc::channel(4);
        let (sig2_tx, _sig2_rx) = mpsc::unbounded_channel();
        let generation2 = app_capture.register_session(2, au2_tx, sig2_tx);
        let start2 = {
            let control = control.clone();
            tokio::spawn(async move { control.start(2, test_capture_config()).await })
        };
        let frames = wait_for_frames(&writer, 2).await;
        let rid2 = frame_rid(&frames[1]);
        assert_eq!(rid2, "2-2", "rid counter should be process-global");

        {
            let app_capture = app_capture.clone();
            std::thread::spawn(move || {
                app_capture.relay_frame_for_test(AppControlFrame::Ack(ControlAck {
                    v: 1,
                    ack: AckOp::Start,
                    gen: 1,
                    rid: rid1,
                    result: AckResult::Superseded { active_gen: 2 },
                }));
                app_capture.relay_frame_for_test(AppControlFrame::Ack(ControlAck {
                    v: 1,
                    ack: AckOp::Start,
                    gen: 2,
                    rid: rid2,
                    result: AckResult::Started {
                        display_id: Some(69734662),
                        width: Some(2560.0),
                        height: Some(1440.0),
                    },
                }));
            })
            .join()
            .expect("ack relay thread should finish");
        }

        assert!(matches!(
            start1.await.expect("start1 task should finish"),
            Err(ControlError::Superseded {
                gen: 1,
                active_gen: 2
            })
        ));
        let info = start2
            .await
            .expect("start2 task should finish")
            .expect("generation 2 should start");
        assert_eq!(info.display_id, Some(69734662));

        let mut dropped_delta_frames = 0;
        assert!(app_capture.forward_au_for_test(vec![0, 0, 0, 1, 0x65], &mut dropped_delta_frames));
        assert_eq!(
            au2_rx
                .try_recv()
                .expect("current generation should receive AU"),
            vec![0, 0, 0, 1, 0x65]
        );
        assert!(au1_rx.try_recv().is_err());

        generation1.stop();
        assert!(app_capture.forward_au_for_test(vec![0, 0, 0, 1, 0x41], &mut dropped_delta_frames));
        assert_eq!(
            au2_rx
                .try_recv()
                .expect("stale stop must not clear newer generation"),
            vec![0, 0, 0, 1, 0x41]
        );

        generation2.stop();
        assert!(app_capture.forward_au_for_test(vec![0, 0, 0, 1, 0x41], &mut dropped_delta_frames));
        assert!(au2_rx.try_recv().is_err());
    }

    #[test]
    fn app_control_stream_relays_capture_error_status() {
        let (sig_tx, mut sig_rx) = mpsc::unbounded_channel();
        let (au_tx, _au_rx) = mpsc::channel(1);
        let registry = AppCaptureRegistry::default();
        registry.register(42, au_tx, sig_tx);
        let payload =
            br#"{"v":1,"event":"capture-error","gen":42,"kind":"start-failed","reason":"no grant"}"#;
        let mut frame = Vec::new();
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        let mut cursor = std::io::Cursor::new(frame);
        let control = ControlClient::stdout();

        read_app_control_stream(&mut cursor, &registry, &control);

        let sent = sig_rx
            .try_recv()
            .expect("capture error event should be queued for signaling");
        let value: serde_json::Value =
            serde_json::from_str(&sent).expect("status should be valid json");
        assert_eq!(value["type"], "status");
        assert_eq!(value["kind"], "capture-failed");
        assert_eq!(value["captureKind"], "start-failed");
        assert_eq!(value["reason"], "no grant");
    }

    #[test]
    fn input_writer_drops_stale_moves_without_dropping_releases() {
        let mut last_applied_seq = 0;

        assert!(should_forward_input_message(
            br#"{"t":"d","seq":10,"rx":0.1,"ry":0.1,"btn":"l"}"#,
            &mut last_applied_seq
        ));
        assert_eq!(last_applied_seq, 10);

        assert!(should_forward_input_message(
            br#"{"t":"m","seq":11,"rx":0.2,"ry":0.2,"btn":"l"}"#,
            &mut last_applied_seq
        ));
        assert_eq!(last_applied_seq, 11);

        assert!(!should_forward_input_message(
            br#"{"t":"m","seq":11,"rx":0.3,"ry":0.3,"btn":"l"}"#,
            &mut last_applied_seq
        ));
        assert_eq!(last_applied_seq, 11);

        assert!(should_forward_input_message(
            br#"{"t":"u","seq":12,"rx":0.4,"ry":0.4,"btn":"l"}"#,
            &mut last_applied_seq
        ));
        assert_eq!(last_applied_seq, 12);

        assert!(!should_forward_input_message(
            br#"{"t":"m","seq":12,"rx":0.5,"ry":0.5,"btn":"l"}"#,
            &mut last_applied_seq
        ));
        assert_eq!(last_applied_seq, 12);

        assert!(should_forward_input_message(
            br#"{"t":"k","seq":11,"code":55,"action":"up","flags":0}"#,
            &mut last_applied_seq
        ));
        assert_eq!(last_applied_seq, 12);
    }
}
