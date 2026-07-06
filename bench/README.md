# RD Baseline Benchmark

Standalone Slice 1 benchmark harness for the deployed RD WebRTC host. This does
not use production client code.

## Runtime prerequisite

The deployed host CLI at `~/.xpair/host/bin/screen` must already have a macOS
Screen Recording (TCC) grant. Without that grant, capture fails or frames never
flow even though signaling may connect.

## Install

```sh
cd bench
npm install
```

If this sandbox blocks network access, skip install here and run it on the target
machine before using the live benchmark.

## Run

```sh
cd bench
./run-baseline.sh
```

The script creates an owner-only random token file, starts:

```sh
~/.xpair/host/bin/screen serve-webrtc --port 8890 --token @<tokenfile> --fps 30 --bitrate 4000000 --scale 1
```

Then it runs the headless Chromium receiver for `DURATION` seconds and writes one
JSON file under `bench/out/baseline-<timestamp>.json`.

Environment overrides:

```sh
CONTENT=static PORT=8891 DURATION=90 FPS=30 BITRATE=4000000 SCALE=1 OUT=/tmp/baseline.json ./run-baseline.sh
```

`CONTENT` is `motion` by default and may be `static` or `motion`. The script
opens `bench/content/pattern.html` in a separate Google Chrome user-data-dir with
`--kiosk --new-window` before starting the host. The content window must be
fullscreen, frontmost, and on the same display that ScreenCaptureKit captures.
The host currently uses `showsCursor=true`; park the cursor in a corner and do
not move it during a run so cursor pixels do not perturb the deterministic
source.

The JSON contains per-second `inbound-rtp` video samples, loss fields, freeze and
pause fields, computed bitrate, raw `framesPerSecond`, derived decoded FPS, run
config under `run`, and wallclock start/end timestamps.

## Impaired media path

Slice 2 adds a seedable UDP relay on `127.0.0.1:${PROXY_PORT}` and rewrites both
peers' UDP host ICE candidates to that relay from the benchmark client. STUN and
DTLS are always passed through; RTP media impairment is applied only on the
host-to-client direction by default. The relay writes counters to
`bench/out/proxy-<profile>-<timestamp>.json`, and the client run record includes
the path as `run.proxyStats`.

```sh
cd bench
PROFILE=passthrough SEED=axis-a ./run-impaired.sh
PROFILE=loss LOSS=0.01 SEED=loss-001 ./run-impaired.sh
PROFILE=burst GE_P=0.03 GE_R=0.15 GE_LOSS_BAD=1 SEED=burst-001 ./run-impaired.sh
PROFILE=marked-burst BURST_SCHEDULE=3000:700,9000:700 SEED=burst-window ./run-impaired.sh
```

Profiles are `passthrough`, `latency`, `loss`, `burst`, `fragment`, and
`marked-burst`. Set `LAT_MS`/`JIT_MS` to add seeded delay to any non-passthrough
profile. Set `RTCP_LOSS` to impair feedback packets; it defaults to off.
`RETX_LOSS` adds residual loss for RTX retransmissions. `BW_KBPS` enables a
host-to-client RTP leaky-bucket bandwidth cap, and `BW_BUFFER_MS` controls how
long packets may queue before tail-drop. The `marked-burst` profile drops
host-to-client RTP during `BURST_SCHEDULE` windows, formatted as comma-separated
`startMs:durationMs` entries anchored to the first media packet. The `fragment`
profile drops RTP packets by packet size (`FRAG_BYTES`, default 1100) because
SRTP keeps the RTP header visible but hides whether a large packet is an IDR
fragment.

## Baseline variance

Run the baseline repeatedly with cooldown between runs:

```sh
cd bench
CONTENT=motion RUNS=3 COOLDOWN=20 ./baseline-variance.sh
CONTENT=static RUNS=3 COOLDOWN=20 ./baseline-variance.sh
```

This writes `bench/out/variance-<content>-<timestamp>.json` with per-metric mean
and sample standard deviation, then prints a short table.

## Verify without a live session

```sh
cd bench
npm run parse-check
npm run relay-check
npm run score-check
```

This loads the local client stats module, builds a fabricated sample, and exits
nonzero if the output schema is missing required fields. The relay check feeds
crafted STUN, DTLS, RTP, and RTCP buffers through the classifier and impairment
logic without running Chrome or the host.
