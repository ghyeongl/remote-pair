# rd-enhance — Phase 2 build plan (autoresearch on the loss benchmark)

Design (Claude) → implementation (codex). Runs on **this MacBook Air M1**, which
has the deployed host at `~/.xpair/host/bin/screen` (+ `/Applications/XpairHost.app`).
Host **fix rebuilds go through CI pre-release** (`gh workflow run release.yml -f
version=0.5.1aN` → signed prerelease → install on M1), not local rustup/Xcode.

Spec source of truth: `docs/rd-streaming-loss-benchmark.md` (merged on develop).

## Run target / constraints
- Loopback on M1. `screen serve-webrtc --port 8890 --token @TOKENFILE --fps 30
  --bitrate 4000000 --scale 1`. Standalone mode spawns `rp-screencap` (SCK +
  VideoToolbox) → needs a **Screen Recording TCC grant** for the CLI binary
  (one-time, interactive). gh-mac-m4 (M4) is an alternative when online.
- Media is WebRTC UDP/RTP H.264; signaling is JSON `{offer,answer,candidate}` on
  `ws://127.0.0.1:8890/?token=…`. Host creates the **offer**; client answers
  recvonly.

## Slices (each independently runnable/verifiable)

### Slice 1 — measurement spine (no host rebuild) ← START HERE
Establish: launch host → programmatic client receives H.264 → dump getStats JSON.
- `bench/run-baseline.sh`: write a random token file, launch the deployed
  `screen serve-webrtc`, run the client for N seconds, tear down.
- Client = **headless Chromium via Playwright (node)** (real H.264 decode path):
  connect signaling, setRemoteDescription(offer), addTransceiver video recvonly,
  createAnswer, trickle candidates, then poll `getStats()` at 1 s.
- Emit one JSON per run with: framesDecoded, framesDropped, framesPerSecond,
  **totalFreezesDuration, freezeCount, pauseCount/totalPausesDuration**, jitter,
  bytesReceived/bitrate, **packetsLost / fractionLost**, frameWidth/Height,
  keyFramesDecoded, plus the run config (fps/bitrate/scale, duration, seed).
- PASS = framesDecoded grows > 0 over loopback and the JSON has the freeze +
  packetsLost fields (the doc-required telemetry the production webview lacks).

### Slice 2 — seedable UDP impairment proxy on the media path
- Insert a controlled UDP relay between host and client; force ICE through it by
  making the client offer/accept only the relay candidate (or rewrite SDP/cands).
- Impairment keyed to **normalized RTP seq + transmission attempt** (drop first
  send, pass retransmits); profiles: latency+jitter, Gilbert-Elliott burst,
  large-packet/keyframe-fragment (size-based unless a pre-SRTP tap is added);
  impair RTCP too. Seed → reproducible schedule. Pass-through mode = Axis A.

### Slice 3 — scorer + evaluator contract
- One run → one JSON → one scalar. Normalize per-metric by baseline stddev/epsilon
  (no div-by-zero). SSIM with frame-coverage gate (needs decoded-frame capture vs
  deterministic source). Axis A = falsification gate (assert observed loss ~0).
  Record baseline 3× with stddev.

### Slice 4 — candidate fixes (host, via CI pre-release) + autoresearch loop
- PLI cooldown → ~~NACK/RTX~~ → adaptive bitrate / FEC (serve_webrtc.rs / CaptureEngine).
- Loop: codex implements fix → CI prerelease → install on M1 → score vs baseline
  beyond stddev, SSIM gate satisfied. Plus qualitative blind-A/B on top-N.

#### Findings (2026-06-28 autoresearch)
- **NACK/RTX is already on and saturated.** Host registers
  `register_default_interceptors` (serve_webrtc.rs:1160) → webrtc-rs NACK
  responder retransmits every dropped packet. Proxy stats from real runs show
  `retransmitsPassed == dropped` (burst: 138/138, 108/108; loss: 11/11). The
  doc's "bursts need NACK/RTX" is therefore *already satisfied*; do NOT build it.
- **The benchmark was saturated.** The relay dropped only the first send of each
  seq and passed all retransmits, so NACK/RTX trivially recovered everything —
  the only injected penalty was recovery latency, not information loss. Burst
  still gate-failed on coverage purely from decoder freeze during the retransmit
  RTT.
- **Fix applied (instrument, no host rebuild):** added `RETX_LOSS` to the relay
  (`bench/proxy/relay.js`) — probability a retransmit is *also* dropped, keyed
  deterministically by `(normSeq, attempt)`. Default 0 = old behavior. With
  `RETX_LOSS>0` there is real residual loss NACK can't defeat, so candidate fixes
  (FEC, adaptive bitrate, jitter buffer) finally have signal to climb.
- **PLI cooldown A/B (RETX_LOSS=0):** loss cd0=0.478 vs cd150/250=0.500 (faint,
  within single-run noise), cd400=0.475; burst all coverage-gate-fail at every
  cd. Re-run with `RETX_LOSS≈0.3` (live, M1-when-away) to see a real signal.
- **Next candidate:** adaptive bitrate (fewer packets/frame under loss → smaller
  hit probability per frame) or FEC, since residual loss is the real challenge.
  Design = Claude, host implementation = codex, build = CI/m4.

#### Findings (2026-06-28, cont'd) — what's testable & the scoring truth
- **Score gate is effectively `decodedFps >= 15`** (COVERAGE_FLOOR 0.5 × 30fps).
  SSIM is unimplemented → `gates.ssim="absent"` (never fails the gate). So burst
  runs fail purely from decoded-framerate collapse, not image quality.
- **Single-run variance is large** (calib: 2.9%loss→14fps, 5.3%loss→18.8fps,
  non-monotonic). Every measurement must be **3× with mean±std** (the doc said so;
  earlier "faint signals" were noise). Adopted in `bench/baseline-3x.sh`.
- **Realistic burst calibration** (decFps near the gate): GE_P/GE_R
  0.015/0.25 ≈ 5% loss (~15-19fps, straddles gate), 0.020/0.20 ≈ 12% (~10fps,
  fails). 0.030/0.15 (~17%) is unrealistically harsh — no fix can cross. Adopt
  0.015/0.25 as the primary optimization target.
- **Flake fixed:** the intermittent zero-traffic runs were the client racing the
  relay's UDP bind; `run-impaired.sh` now polls the port before launching client.
- **Hard architectural constraint:** bitrate is passed once at spawn to
  `rp-screencap` (serve_webrtc.rs:1841); there is no runtime bitrate channel.
  `rp-screencap` is a *separate signed binary* (XpairHost helper) — rebuilding it
  loses the Screen-Recording TCC grant, so **encoder-side fixes (adaptive bitrate,
  FEC) cannot be tested on M1 with the m4 `screen-pli` shortcut**; they require a
  full CI signed prerelease installed on M1 (which re-grants TCC).
- **Testable-without-rebuild surface:** serve_webrtc.rs transport layer (largely
  exhausted: NACK/RTX optimal, PLI neutral) **plus the bitrate/fps/scale args**
  the deployed signed encoder already accepts. → Next experiment: a 3×
  bitrate×scale grid on burst5 to find the loss-resilient operating point. That
  point both (a) may ship as a better default and (b) defines the target an
  adaptive policy (codex, via CI) should switch to under detected loss.

#### Findings (2026-06-28, cont'd 2) — congestion collapse is the real bug
- **Lowering bitrate does NOT help under pure random/burst loss** (3× grid:
  4M decFps ~18 > 2M ~14.8; scale<1.0 broke the deployed encoder, decFps ~4).
  NACK/RTX recovers loss independent of bitrate, so ABR-down is pointless here.
- **But under a bandwidth cap the host suffers congestion collapse.** 3× grid on
  passthrough + BW_KBPS (stream ≈ 570 kbps):
  - none → score 0.500, decFps 23.7 (clean)
  - 500k → gate-fail, decFps 0.2, injLoss 83%, **totalRTP 2347** (fwd ~410)
  - 300k → gate-fail, decFps 0.3, **totalRTP 6674**
  - 200k → gate-fail, decFps 0.1, **totalRTP 11918 (10× the clean count)**
  The RTP count balloons because cap-drops → NACK → retransmit → those also
  exceed the cap → more NACK = a **retransmission storm** that amplifies
  congestion. NACK/RTX makes congestion *worse*.
- **Root cause:** the host has **no send-side congestion control / pacing** — it
  emits at the encoder's rate regardless of the path, and the default NACK
  responder storms a saturated link. This is the genuine, high-value bug.
- **Fix = adaptive bitrate (ABR), congestion-triggered.** Lower the encoder
  target to fit the link so the overflow (and the NACK storm) disappears. Trigger
  on **sustained loss / retransmits-not-helping (congestion)**, NOT transient loss
  (which NACK recovers — keep bitrate high there). This is the key discriminator.

#### RESULT (2026-06-29) — ABR mitigates congestion collapse ✅
Implemented congestion-triggered ABR (env-gated `RP_ABR`, off by default):
controller in serve_webrtc.rs driven by **NACK rate** (RR fraction_lost
under-reports congestion — reads ~0 intermittently at 85% real loss; NACK storm
is the reliable signal, hundreds/s under congestion), cuts ×0.80 on
nack≥`RP_ABR_NACK_HI`, raises ×`RP_ABR_RAISE_FACTOR`(1.05) only after
`RP_ABR_RAISE_AFTER`(3) consecutive clean intervals; min/max clamp, no-RR
circuit breaker, 5% write hysteresis. Actuation: host writes `bitrate <bps>` to
rp-screencap stdin → live `VTSessionSetProperty(AverageBitRate/DataRateLimits)`.

Measured (passthrough + leaky-bucket BW cap, 3× each, **decFps** — the valid
congestion metric; the bench's score gate-fails here only because it scores under
passthrough+Axis-A which asserts ~0 loss):

| cap | ABR off | ABR on | eff.loss off→on |
|-----|---------|--------|------------------|
| 450 kbps | 6.1±0.5 | **15.6±0.5** (cov 0.52) | 75%→30% |
| 350 kbps | 4.6±0.1 | **9.7±4.8** | 84%→39% |
| 250 kbps | 0.7±0.4 | **7.0±1.7** | 93%→77% |

→ 2.5–10× decoded-framerate recovery; at moderate congestion (450) usable
framerate is fully restored (coverage > 0.5). Default build unaffected (RP_ABR
off). Build path: m4 `cargo build --features webrtc` for the `screen` binary
(fast iteration, pairs with the a2-signed rp-screencap that has the control
reader + TCC); full signed app via CI `release.yml`.

Follow-ups (optional): less-noisy convergence at tight caps; a bench "congestion"
scoring mode (skip Axis-A, score decFps/coverage directly); cut a CI release with
ABR present-but-off and merge.

## Adaptive bitrate design — RustDesk reference (port structure, drive from loss)
RustDesk `src/server/video_qos.rs` is a sender-side **delay-based** QoS controller
(TCP transport → no loss visibility). We replicate its *structure* but drive it
from **loss** (our transport is UDP/RTP, loss is visible via RTCP RR, and the
bench injects loss not delay — a delay-band law would never fire here).

- Two independent loops: **bitrate ~3s**, **fps ~1s**; fps reacts first.
- **Multiplicative ratio on bands**, clamped [min,max]. RustDesk delay bands
  ×1.15…×0.80; ours = loss bands from RR fractionLost / NACK rate, e.g.
  <1%→×1.05, 1–3%→hold, 3–7%→×0.9, >7%→×0.8 (tune on bench).
- **Never raise on static screen** (gate raises on a frame-changed counter).
- **Circuit breaker**: no RR for ~2s → throttle hard.
- encoder_bitrate = base_bitrate(res) × ratio. Base table (kbps): 720p 1000,
  1080p 2073, 1440p 3000, 2160p 5000; Balanced ratio 0.67, Best 1.5, Low 0.5.
- Signal map: avg_delay→RR fractionLost/NACK; response_delayed→RR timeout;
  dynamic_screen→frame-changed flag; keyframe→PLI/FIR (already handled).
- **Critical gap:** VideoToolbox runtime bitrate via
  `VTCompressionSessionSetProperty(kVTCompressionPropertyKey_AverageBitRate)` —
  implement this live knob in rp-screencap FIRST (the QoS loop needs something to
  actuate). This is why adaptive bitrate requires a CI signed build, not the m4
  `screen-pli` shortcut.

Source: rustdesk/rustdesk `src/server/{video_qos,video_service,connection}.rs`,
`libs/scrap/src/common/codec.rs`; PR #10459, discussion #792.

## Telemetry note
`collectVideoStats` in the production webview emits only
decoded/dropped/fps/jitter/bitrate — the bench client must collect the fuller set
above itself (it is a separate client, so no production code change needed for
Slice 1).
