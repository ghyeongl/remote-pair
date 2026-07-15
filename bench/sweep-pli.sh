#!/usr/bin/env bash
# A/B sweep: vary ONLY RP_PLI_COOLDOWN_MS with a fixed seed per profile so the
# injected impairment is byte-identical across cooldown values (fair comparison).
# Uses the PLI-cooldown host build at ~/rd-enh/screen-pli; capture via the
# deployed signed rp-screencap (has the Screen Recording TCC grant).
#
# CAVEAT (standalone capture): this runs run-impaired.sh, which starts
# `serve-webrtc` standalone (NOT RP_AU_STDIN=1). In standalone mode the host's
# PLI/FIR -> keyframe_noack control writes are not delivered to the app's
# CaptureEngine, so varying RP_PLI_COOLDOWN_MS may only change no-op control
# writes rather than on-demand IDR timing. Treat PLI-cooldown A/B results from
# this script as INDICATIVE ONLY; a definitive PLI study needs the product
# app-capture path or standalone keyframe control. (This does not affect the ABR
# results, which actuate encoder bitrate, not keyframes.)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HOST_BIN="${HOST_BIN:-$HOME/rd-enh/screen-pli}"
export RP_SCREENCAP="${RP_SCREENCAP:-$HOME/.xpair/host/bin/rp-screencap}"
export PATH="/opt/homebrew/bin:$PATH"
CONTENT="${CONTENT:-motion}"
DURATION="${DURATION:-20}"
COOLDOWNS="${COOLDOWNS:-0 150 250 400}"
mkdir -p "$ROOT/out"
OUT="$ROOT/out/sweep-$(date -u +%Y%m%dT%H%M%SZ).tsv"
echo -e "label\tcooldownMs\tscore\tgatesPassed\tframesDecoded\tdecodedFps\tfreezeCount\ttotalFreezeDur\trtpDropped\tkbps\tretxPass\tretxDrop" > "$OUT"
port=8910; pport=9010
run(){ # label profile seed extra_env...   (label disambiguates output files)
  local label="$1" profile="$2" seed="$3"; shift 3
  for cd in $COOLDOWNS; do
    port=$((port+1)); pport=$((pport+1))
    echo ">>> label=$label profile=$profile cooldown=${cd}ms seed=$seed port=$port" >&2
    # No `set -e`, so a failed run (host timeout, relay bind failure, client error)
    # would fall through to the `ls -t` below and pick the PREVIOUS cooldown's JSON,
    # emitting a row that mislabels a stale run under this cooldown. Gate on exit
    # status and skip the row on failure (no retry loop here — this is indicative A/B).
    if ! RP_PLI_COOLDOWN_MS="$cd" PROFILE="$profile" SEED="$seed" CONTENT="$CONTENT" \
      DURATION="$DURATION" PORT="$port" PROXY_PORT="$pport" "$@" \
      "$ROOT/run-impaired.sh" >/dev/null 2>>"$ROOT/out/sweep-runs.log"; then
      echo ">>> label=$label cooldown=${cd}ms run FAILED, skipping row" >&2
      continue
    fi
    c=$(ls -t "$ROOT"/out/impaired-$profile-*.json 2>/dev/null | head -1)
    x=$(ls -t "$ROOT"/out/proxy-$profile-*.json 2>/dev/null | head -1)
    sf="$ROOT/out/score-$label-cd$cd.json"
    node "$ROOT/score/score.js" --client "$c" --proxy "$x" --out "$sf" >/dev/null 2>&1
    node -e '
      const fs=require("fs");
      const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));        // score record
      const cl=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));       // client record
      const p=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));        // proxy record
      const s=cl.summary||{};  // frame/fps/freeze/bitrate live on the CLIENT summary, not the score JSON
      const h=(p.directions&&p.directions.hostToClient&&p.directions.hostToClient.classes&&p.directions.hostToClient.classes.RTP)||{};
      const row=[process.argv[4],process.argv[5],r.score,(r.gates&&r.gates.passed),s.framesDecoded,s.decodedFps,s.freezeCount,s.totalFreezesDuration,(h.dropped),Math.round(s.averageBitrateKbps||0),(p.retransmitsPassed||0),(p.retransmitsDropped||0)].join("\t");
      console.log(row);
    ' "$sf" "$c" "$x" "$label" "$cd" >> "$OUT"
    sleep 8   # thermal cooldown between runs
  done
}
run burst "burst" "spiral-fixed" env GE_P=0.03 GE_R=0.15 GE_LOSS_BAD=1
run loss  "loss"  "loss1-fixed"  env LOSS=0.01
# Residual-loss variants: retransmits can also be lost, so NACK/RTX no longer
# trivially recovers. This is where PLI cooldown / future fixes should show signal.
RETX="${RETX_LOSS:-0.3}"
run loss-retx  "loss"  "loss1r-fixed"  env LOSS=0.01 RETX_LOSS="$RETX"
run burst-retx "burst" "spiralr-fixed" env GE_P=0.03 GE_R=0.15 GE_LOSS_BAD=1 RETX_LOSS="$RETX"
echo "=== SWEEP DONE: $OUT ==="
cat "$OUT"
