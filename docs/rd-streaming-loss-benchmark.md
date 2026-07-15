# RD Streaming Loss Benchmark (autoresearch harness)

Design doc for a **deterministic, scriptable benchmark** that reproduces and
scores Remote Desktop (RD) frame-rate degradation, intended to drive an
autoresearch optimization loop.

## Problem under test

RD streams fine for the first few minutes, then frame rate degrades severely and
progressively while **host CPU climbs**. The transport is WebRTC (H.264, HW
VideoToolbox encode on the macOS host, native Chromium decode in the IDE
webview).

### Leading hypothesis: keyframe feedback spiral

1. An H.264 IDR keyframe is ~76 KB → fragments into **~64 RTP packets** at a
   ~1200 B MTU.
2. An IDR is **atomic**: losing any single one of those packets makes the whole
   frame undecodable. `P(keyframe unusable) = 1 - (1-p)^64` — at p=0.5% per-packet
   that is already ~27%, at p=1% ~47%.
3. On loss the client sends RTCP **PLI/FIR**; the host responds by forcing a
   fresh IDR (`serve_webrtc.rs` RTCP reader → `control.keyframe_noack`), with
   **no debounce / rate limit**.
4. Each forced IDR is large → likely to lose a packet again → another PLI →
   another IDR. Positive feedback. Bitrate is fixed (no adaptation), so the loop
   never self-corrects; it ratchets up until CPU saturates and FPS collapses.
5. Forced IDRs are expensive to encode (intra-only) and to packetize/SRTP-encrypt
   → **CPU climbs** as keyframe frequency rises.

Big atomic keyframes defeat UDP's "lose a packet, drop the frame, move on"
model — the proper fix is **packet-level recovery (NACK/RTX)** plus **adaptive
bitrate** plus a **PLI cooldown**, not re-sending whole frames.

> **Critical caveat:** the benchmark must be able to *falsify* this hypothesis,
> not just confirm it. See Axis A (no-loss control) below.

## Benchmark structure

Do **not** wait 3–5 min for organic loss — it is slow and non-deterministic.
Force the failure condition and keep runs short, reproducible, and machine-scored.

### Two measurement axes (run both, compare)

- **Axis A — no-loss control (10+ min long run).** No injected impairment.
  Isolates *time-dependent* causes from *loss-dependent* ones. If CPU /
  encode-time / RSS climb here **with zero injected loss**, the root cause is
  time-based (thermal throttling, memory leak, controller windup), **not** the
  keyframe spiral. This axis is what makes the benchmark falsifiable.
  **Gate on *observed* loss, not *injected* loss:** over the real P2P UDP path
  "no injected impairment" still admits ambient Wi-Fi/VPN loss, which triggers the
  same PLI/IDR path and would make a real spiral look time-based. So Axis A is
  only valid as a falsifier if it runs over a controlled lossless path (the proxy
  in pass-through, seed = no-drop) **or** asserts receiver/RTCP packet-loss deltas
  are ~0 for the whole run before accepting the result.
- **Axis B — loss injection (60–90 s).** Force packet loss / latency so the
  spiral (if it exists) develops in seconds.

### Impairment injection (Axis B)

**Inject on the media path, not loopback.** Verified against the code: video RTP
flows P2P over UDP/ICE host candidates, while `127.0.0.1` carries only the
SSH-forwarded signaling WebSocket (`client/ide/remotepair/ext/extension.js`,
`media/remote-desktop.js`). A `dnctl`/`pfctl` pipe on `lo0` therefore drops
*signaling*, not video — Axis B would silently run as a no-loss test. Loopback is
also too reliable to fail on its own, so impairment must be **explicit and on the
RTP 5-tuple**.

Primary mechanism: a **dedicated, seedable UDP impairment proxy** spliced into the
media path. Force ICE to route RTP through a single controlled relay candidate
(a host-local UDP relay — same box over loopback, or across `ssh gh-mac-m4` for a
two-host path), then apply impairment inside the proxy.

**This needs an explicit ICE integration step — it won't happen by itself.**
Today the browser uses `RTCPeerConnection({ iceServers: [] })` and the host
`RTCConfiguration::default()` (`remote-desktop.js`, `serve_webrtc.rs`), so both
peers only trickle their own direct host candidates; merely starting a UDP proxy
nearby leaves media on a direct path (or fails ICE) and Axis B silently bypasses
the injector. So the harness must do one of: run a **TURN / ICE-lite relay** and
advertise it as the only usable candidate, or **rewrite the SDP/candidate** lines
to point both peers at the proxy 5-tuple. Specify which; without it the injector
is not in the path.

Then apply impairment inside the proxy:

- **Seedable, keyed to RTP identity.** A fixed RNG seed alone is *not* enough: if
  the proxy draws per UDP datagram, the same seed hits different packets run to
  run because ICE/STUN/DTLS and the SCTP data channel share the 5-tuple and shift
  timing. Define the drop/jitter schedule as a **function of RTP sequence number /
  timestamp** (and start it only after ICE, on media RTP), so the same seed always
  impairs the same logical packets. This is what makes the evaluator contract
  reproducible and resolves the `dnctl plr` non-determinism (`plr` is unseeded
  random drop probability). **Key it to (seq, transmission attempt), not seq
  alone:** a NACK resend reuses the sequence number and RTX carries the original
  packet identity, so a seq-permanent drop also kills every retransmission and
  makes NACK/RTX *structurally unable* to recover — silently penalizing the
  headline fix. Drop the **first** transmission of a selected packet, let its
  retransmissions through. **Normalize RTP IDs first:** initial RTP sequence
  numbers/timestamps are randomized per connection, so hashing raw IDs hits
  different logical frames across runs even with the same seed — key the schedule
  to IDs *relative to the first media packet* (or pin deterministic initial IDs).
- **Impair RTCP feedback too, not just media RTP.** The same ICE 5-tuple carries
  PLI/FIR/NACK and receiver reports — the very signals that drive the spiral and
  the NACK/adaptive-bitrate fixes. Leaving RTCP lossless/instant is unrealistic
  and flatters those fixes; apply (lighter) loss/delay to the feedback direction
  so recovery time and PLI rate reflect real Wi-Fi.
- **Profiles** (model real Wi-Fi, since loopback never fails):
  - **latency + jitter** (e.g. 50 ms ± jitter, 100 ms ± jitter),
  - **bursty loss** — Gilbert-Elliott two-state, *not* uniform random; bursts
    hurt atomic keyframes far more (steady vs burst variants each: NACK helps
    steady, PLI-cooldown helps burst recovery),
  - **large-packet / fragment drop** — preferentially drop the big keyframe RTP
    fragments, the exact failure mode under test. **Caveat — SRTP blinds an
    external proxy:** the host hands whole AUs to `TrackLocalStaticSample`, after
    which WebRTC packetizes and DTLS/SRTP-encrypts, so a relay on the ICE path
    sees only encrypted payloads + lengths — it cannot tell an IDR fragment from a
    large delta fragment. Either (a) tap **pre-SRTP** with an H.264-aware hook on
    the host (knows which packets are IDR), (b) use a WebRTC/TURN component that
    carries packet metadata, or (c) accept this profile as **size-based loss only**
    and state that approximation explicitly.
- **The objective is UDP graceful degradation**: a correct stack keeps streaming
  *through* this impairment by recovering at packet granularity (NACK/RTX,
  smaller keyframes) — never by re-sending whole 76 KB IDRs. The proxy is the
  gauntlet the candidate fixes must survive.
- MTU check still holds: webrtc enforces ~1200 B chunking regardless of the
  ~16 KB loopback MTU, so "~64 packets/keyframe" stands. Confirm, don't assume.

`dnctl`/`pfctl` (dummynet) on the selected media interface remains a secondary
cross-check only. `dnctl` exposes `plr` as an *unseeded* random drop probability
with no deterministic loss schedule, so it must **never** be the scored/seeded
injector — repeated trials would drop different keyframe fragments and the
evaluator contract's seeded reproducibility would break. Keep it for occasional
spot validation against the proxy, nothing on the scored path.

### Deterministic content source

HW-encoder output is content-dependent; randomness ruins comparability.

- Drive a **fixed, deterministic screen source** (test pattern with known,
  repeatable motion).
- Test at least two content profiles: **static (mostly text)** and
  **high-motion** — bitrate shape differs drastically, and SCK skips idle frames.
- **Exclude the cursor** — `CaptureEngine` sets `cfg.showsCursor = true`, so any
  stray mouse movement during the static/text profile makes SCK see new content
  and emit/encode extra frames, moving keyframe size / FPS / CPU independently of
  the candidate. Hide or pin the cursor (or mask its region in scoring) as part of
  the deterministic-source contract.

### Determinism guards (or autoresearch chases noise)

- **Cooldown between runs** — HW-encoder thermal state contaminates the next run.
- **Baseline variance first** — run the baseline 3× and compute stddev. Any
  improvement smaller than that stddev is noise, not signal.
- Pin / record background machine load.
- **Pin + record capture params** — fps / bitrate / scale come from the
  `xpair.remoteDesktop` workspace settings (`RD_CAPTURE_DEFAULTS` = 30 fps /
  4 Mbps / 1.0), read by the IDE at connection and passed in the signaling URL
  before `CaptureEngine` starts. If a tester or candidate changes them between
  baseline and trial, keyframe size / CPU slope / FPS move independently of the
  loss-handling fix and baseline variance compares different workloads. Fix these
  in the run config and echo them into the run JSON. Note these settings are
  `"scope": "application"` (`package.json`), so a `.vscode/settings.json` workspace
  override won't take — the harness must set/record the **application-level**
  config (or change the scope) for the pin to actually control the workload.
- **Scored PLI/IDR runs must use the product capture path (`RP_AU_STDIN=1`).**
  Verified: the RTCP PLI handler (`serve_webrtc.rs` → `control.keyframe_noack`)
  forwards the keyframe request to the **parent app** (`ScreenServer` /
  CaptureEngine). In standalone/dev mode the capture is `CaptureSource::Child`,
  whose input path returns `Ok(None)` — the keyframe request is **not** wired to
  the child, so injected loss never forces an on-demand IDR and a standalone Axis B
  run would *falsely* rule out the spiral. Run the spiral/PLI tests in product
  mode (or add a standalone keyframe-control path first).

## Metrics

Optimize the **mechanism**, not just the symptom — and guard against reward
hacking.

### Primary (perceptual + anti-reward-hack)

- **Freeze ratio** — `totalFreezesDuration / wall-clock` (receiver `getStats`).
  Average FPS can look fine while the viewer suffers 2 s freezes; for
  pair-programming, freezes matter more than mean FPS.
  **Not collected today:** `collectVideoStats` (`media/remote-desktop.js`) only
  forwards decoded/dropped/fps/jitter/bitrate — there is no `totalFreezesDuration`
  or freeze count in the stream. Adding freeze-count + total-freeze-duration to
  the emitted JSON is part of this contract; without it the scorer would emit null
  and silently fall back to FPS, defeating the anti-reward-hack design. **Same
  gap blocks the Axis A gate:** `packetsLost` / fraction-lost aren't emitted
  either, so add them too — the Axis A "observed loss ~0" gate is unenforceable
  without a machine-readable loss delta in the JSON.
- **Time-to-recover** — after a forced loss burst, time until a clean image
  returns (black/corrupt duration).

> Why not "keyframe bytes/sec" as the sole primary? Optimizing it alone teaches
> the degenerate solution **"ignore all PLI, never send keyframes"** → keyframe
> rate 0, viewer permanently black/corrupt. Recovery + correctness metrics must
> anchor the objective.

### Mechanism (diagnostic)

- **PLI / FIR rate** and **keyframe bytes/sec** — direct probes of the spiral,
  but **tag keyframes by cause before scoring**. `CaptureEngine` emits a baseline
  IDR every `periodicKeyframeSeconds = 1.0` (reason `"periodic"`) plus the first
  frame, *independent* of loss — on the static/text profile those scheduled IDRs
  can dominate keyframe bytes/sec. **Cause tagging must be built, not assumed:**
  `CaptureEngine` only `log()`s `"periodic"`/`"on-demand"` on the retained-buffer
  path — first-frame and SCK-sample-driven keyframes pass through
  `shouldForceKeyframe`/`encOutput` with **no cause carried into the AU stream,
  JSON, or counters**. So part of the instrumentation contract is emitting a
  per-keyframe cause (periodic / first / PLI-FIR-forced) into the telemetry, then
  splitting it so the scorer attributes only loss-forced IDRs to the spiral (and
  doesn't misread a candidate that retunes the refresh cadence). **But still
  penalize *total* keyframe bytes/sec** (periodic + forced) somewhere in the
  objective: if only PLI-forced IDRs are scored, a candidate that floods cheap
  periodic IDRs (lowering `periodicKeyframeSeconds`) hides that cost — wasting CPU
  and bandwidth while looking spiral-free. Attribute by cause *and* keep a total
  keyframe-byte guardrail.
- **CPU-vs-bandwidth disambiguation** — *not* from `qualityLimitationReason`.
  Verified: the client transceiver is `recvonly` (`media/remote-desktop.js`) so
  only inbound receiver stats exist, and the host writes already-encoded H.264 via
  `TrackLocalStaticSample` — WebRTC never owns the VideoToolbox encoder, so the
  sender `qualityLimitation*` fields are null/meaningless here. Disambiguate
  instead from **host-side encoder telemetry** (CaptureEngine/VideoToolbox: encode
  time, target vs actual bitrate, QP) cross-referenced with receiver RTCP loss
  reports.

### Correctness

- **Image fidelity** — SSIM/PSNR of the decoded frame against the known
  deterministic source (or at minimum decode-error counts). None of the
  throughput/timing metrics check "is the picture actually right."

### Guardrails (must not regress)

- **Per-process CPU** slope — attribute to the mode the bench actually runs in.
  In the **product path** (`RP_AU_STDIN=1`) capture+encode run in the host **app
  process** (`host/app/ScreenServer.swift` / CaptureEngine, SCK+VideoToolbox) and
  `serve-webrtc` only transports (SRTP / retransmit packetizing) — `rp-screencap`
  is **not** spawned. In **standalone/dev** mode (`RP_AU_STDIN` unset) encode/
  thermal lives in `rp-screencap` instead. Split = app/CaptureEngine (or
  rp-screencap) for encode/thermal, serve-webrtc for transport, browser for
  decode. Pin one mode and attribute to the right process; "CPU climbs" is
  meaningless without the split *and* measuring the wrong process is worse.
- **Encode time / frame** slope (`totalEncodeTime`/`framesEncoded`) — thermal
  throttling signal.
- **Host process RSS** slope — leak signal (relevant to Axis A).
- **Thermal pressure** — `pmset -g therm` / thermal state, sampled over time.
- **QP** (`qpSum`/frames) — bitrate starvation blurs the image; "FPS retained"
  ≠ "quality retained."
- **E2E latency p95** — ensure NACK retransmission doesn't trade FPS for latency.
- **FPS retention** = `fps(last 30s) / fps(first 30s)` — downstream symptom,
  kept as a guardrail not the primary.

### Composite score (illustrative)

```
score = w1 * (1 - freeze_ratio)              # already 0..1
      + w2 * norm(recovery_speed)
      - w3 * norm(pli_rate)
      - w4 * norm(cpu_slope)                  # per-process, encode side
      - w5 * norm(max(0, qp - qp_base))
      - w6 * norm(max(0, e2e_p95 - e2e_base))
constraint: image_fidelity (SSIM) >= floor   # hard gate; kills "never send keyframe"
```

- **Normalize before weighting — but not by raw baseline division.** Raw metrics
  live on wildly different scales (freeze_ratio 0–1, pli_rate in /s, cpu_slope in
  %/min); a raw weighted sum is dominated by the largest-magnitude term. Naive
  `value / baseline` is undefined/explosive where the baseline is ~0 — the delta
  terms `max(0, qp - qp_base)` and `max(0, e2e_p95 - e2e_base)` are exactly 0 at
  baseline, and a healthy baseline may have zero freezes or PLI. So `norm()` =
  **per-metric variance- or epsilon-based scaling**: divide by the metric's
  baseline *stddev* (or `baseline + ε` with a metric-specific floor), so each term
  is finite and comparable and the weights mean what they say.
- **SSIM floor is concrete, alignment-aware, and coverage-gated.** Pick a floor
  (start ~0.92 on the static/text profile, tune from baseline) and compute SSIM on
  frame-aligned pairs: tag deterministic source frames and match decoded frames by
  content/timestamp. Skipping dropped frames avoids false quality loss from
  misalignment — **but skipping alone is a reward-hack hole**: a candidate that
  drops most frames and keeps only a few sharp ones would pass on those survivors
  while the viewer sees long stale/black gaps. So pair SSIM with a **frame-coverage
  / staleness gate** (minimum fraction of wall-clock sample points showing a fresh,
  decodable frame), or score the *displayed* video at fixed wall-clock sample times
  (stale frame = its real, degraded SSIM) rather than only surviving decoded pairs.
- **Axis A is a falsification gate, not a scored term.** The composite is scored
  on **Axis B**, averaged across loss × content profiles. Axis A (no-loss long
  run) is pass/fail: if CPU/encode-time/RSS climb with zero injected loss the root
  cause is time-based and the spiral hypothesis is falsified — it gates *which*
  fixes are worth scoring, it does not enter `score`.
- Lead with freeze/recovery so the loop cannot escape into a black screen.

### More independent metrics is better

The metrics above (perceptual, mechanism, correctness, guardrails) are
deliberately *redundant and independent*. That is a feature: a reward-hacking
candidate has to fool **all** of them at once, which is far harder than gaming a
single objective. When in doubt, add another independent probe rather than fewer —
the scalar can stay a weighted sum, but the more orthogonal evidence feeds it
(loss-forced vs periodic keyframe bytes, per-process CPU, QP, E2E p95, freeze,
recovery, SSIM, coverage), the less room the loop has to escape into a degenerate
win.

## Qualitative evaluation (human-in-the-loop)

The scalar score cannot capture *how it feels* — pair-programming is acutely
sensitive to micro-stutter, cursor lag, and text legibility during motion, and a
candidate can post good numbers while feeling worse. A qualitative pass catches
reward-hacks the metrics miss **and validates the weight choices**.

- **Blind A/B playback.** Record the decoded output per run (the source is
  deterministic). Play baseline vs candidate side-by-side; reviewer picks better /
  worse / can't-tell without knowing which is which.
- **MOS-style task ratings (1–5).** Score scripted pair-programming actions — fast
  scroll through code, continuous typing with cursor tracking, window/tab switch —
  on fluidity, cursor lag, and text legibility.
- **Qualitative checklist.** Cursor-tracking lag, text shimmer/blur during scroll,
  freeze-then-catch-up jumps, banding/posterization from low QP, color shift.
- **Cadence.** Don't run it every autoresearch iteration (too slow). Gate it on
  baseline + the top-N candidates the scalar promotes, as the final check before a
  "win" is accepted.
- **Feedback loop.** When the human verdict disagrees with the scalar, that is the
  strongest signal the weights or metric set are wrong — feed it back into the
  weight tuning (see *Open question*). Qualitative is the ground truth the scalar
  is trying to approximate, not a nice-to-have.

## Instrumentation status

Partial scaffolding already exists:

- `client/ide/remotepair/ext/media/remote-desktop.js` — `getStats` polling at
  `V2_STATS_INTERVAL_MS = 5000`, capped by `V2_STATS_MAX_SAMPLES = 120` (≈10 min).
  Dropping to 1 s cadence **without raising the cap stops collection at ~2 min** —
  raise/remove the cap so a 10+ min Axis A run keeps its `last 30s` and slope data
  (≥ ~650 samples to cover 10 min + cooldown).
- Host side (`host/rd/screen/src/serve_webrtc.rs`) — tracing counters for
  dropped / forwarded AUs (every 30th). Add keyframe-bytes and PLI counters, plus
  the host encoder telemetry (CaptureEngine/VideoToolbox encode time, target vs
  actual bitrate, QP) the CPU-vs-bandwidth disambiguation above depends on.

## autoresearch evaluator contract

- One harness invocation → one JSON blob → one scalar score (strict contract).
- Fixed loss profiles + seeds for reproducibility.
- Record the **baseline (current code) score with stddev** first; each iteration
  is gated on beating baseline beyond that stddev.

## Optimization direction

The benchmark exists to drive one goal: **maximize perceived screen-share
fluidity over real (lossy, variable) UDP networks, at bounded host CPU/thermal.**
The target is *graceful degradation*, not perfect delivery.

**Principle — lean into UDP, don't fight it.** UDP's strength is "lose a packet,
move on." The failure mode under test is the stack defeating that: a big atomic
IDR turns one lost packet into a whole lost frame, and the PLI→IDR spiral makes it
worse. So the direction is: recover at *packet* granularity, shrink the atomic
unit, and stop the self-inflicted feedback — never re-send whole 76 KB IDRs.

**Sequence by leverage (cheapest, highest-confidence first):**

1. **PLI cooldown** — debounce forced IDRs. Cheapest change, directly breaks the
   feedback spiral; ship as a safety net even before the structural fixes.
2. **NACK / RTX** — recover the lost RTP packet instead of the whole frame. The
   structural answer; biggest expected win on steady loss. (Bench must let
   retransmissions survive the seeded drop — see impairment notes.)
3. **Adaptive bitrate** from RTCP receiver-report loss — smaller keyframes → fewer
   fragments → lower `P(keyframe unusable)`; main lever for burst loss.
4. *(stretch)* **Periodic intra-refresh** — spread intra macroblocks across frames
   to remove the atomic IDR entirely. Gated on VideoToolbox exposing the knob.

**What success looks like:** under 1–3 % bursty loss, freeze ratio and
time-to-recover stay near the no-loss baseline, host CPU slope stays flat, and
SSIM holds above floor with adequate frame coverage. The autoresearch loop should
converge metric weights toward that profile, and the qualitative pass should agree
the result *feels* fluid.

**Non-goals (guardrails, not targets):** don't trade FPS for latency (E2E p95),
don't trade quality for FPS (QP / SSIM), don't trade viewer experience for a clean
number (freeze/recovery primaries + SSIM coverage gate exist to prevent this).

## Candidate fixes this benchmark should discriminate

1. **NACK / RTX** (packet-level retransmission) — the structural answer; recover
   the lost packet instead of re-sending the whole 76 KB IDR. webrtc-rs
   interceptor + codec `nack` feedback + SDP negotiation.
2. **Adaptive bitrate** — drive `AverageBitRate` from RTCP receiver-report loss;
   smaller keyframes → fewer packets → lower loss probability.
3. **PLI cooldown** — debounce forced keyframes (e.g. ignore PLI within N ms of
   the last forced IDR); safety net for genuine, unrecoverable loss.
4. *(stretch)* **Periodic intra-refresh** — spread intra macroblocks across
   frames to eliminate the big atomic IDR. Feasibility gated on VideoToolbox
   exposing the knob (uncertain).

## Implementation traps (resolve while building, verified against code)

These are real but implementation-level — concrete resolution belongs in the
harness build, not further doc iteration:

- **Fragment-drop tap point.** A host hook *before* `TrackLocalStaticSample` sees
  only whole Annex-B AUs; WebRTC packetizes internally afterward, so such a hook
  can drop a whole IDR but **not** a single RTP fragment of it. True per-fragment
  keyframe drop needs a tap after packetization but pre-SRTP (inside webrtc-rs), a
  metadata-carrying TURN relay, or fall back to whole-AU / size-based drop.
- **E2E p95 needs latency probes.** Current stats emit only
  decoded/dropped/fps/jitter/bitrate — no capture/render timestamps or wall-clock
  probe. Without them `e2e_p95` can't be computed, so a NACK/RTX candidate that
  trades FPS for ballooning retransmit latency would pass. Add the timestamps to
  the instrumentation contract. **In two-host runs (`ssh gh-mac-m4`) capture and
  render timestamps are on different clocks** — raw differences reflect clock
  offset/skew (even negative latencies), not retransmit delay. Require clock
  sync / offset exchange, or use a same-clock visual/wall-clock probe, before
  scoring E2E latency.
- **Recovery scoring needs scheduled burst markers.** Time-to-recover (a primary)
  is only comparable if each run has a known burst start/end recorded in the run
  JSON. The stochastic Gilbert-Elliott profile doesn't give that — add a separate
  **scheduled, marked** loss burst for recovery measurement, distinct from the
  steady GE profile.
- **Pin captured display geometry.** The product capture path uses
  `content.displays.first` and derives encoder width/height from that display's
  current dimensions × scale. Multi-display, changed display order, or different
  resolution/Retina scaling between baseline and trial changes keyframe size /
  packet count / CPU independently of the fix. Pin and record the display + its
  geometry, not just fps/bitrate/scale.

## Open question (informs metric weighting + gate threshold)

When degradation is observed live: does the image **blur (QP)**, **freeze**, or
just go **sparse (FPS)**? And does the **Mac get hot / fans spin up**? These two
observations largely separate the thermal hypothesis from the spiral hypothesis.
They do **not** set an "Axis A vs Axis B weight" — Axis A is a pass/fail
falsification gate, not a scored term (see composite score). Instead they tune the
**Axis-B metric weights** (e.g. lean on QP/encode-time if it blurs and the Mac
runs hot; lean on freeze/recovery if it freezes) and the **Axis-A gate threshold**
(how much no-loss CPU/encode-time/RSS climb counts as falsifying the spiral).
