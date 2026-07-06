#!/usr/bin/env bash
# Canonical bench grid runner: N conditions x REPS repeats, validity-retry on the
# zero-traffic flake, mean+/-std aggregation. Reads JSON via fs.readFileSync (NOT
# require) to avoid the "relative path treated as node_module" trap.
#
# Define conditions in the CONDS array below (one per line):
#   "label|PROFILE|SEED|BITRATE|SCALE|EXTRA_ENV..."
# EXTRA_ENV is space-separated VAR=val passed to run-impaired (GE_P=.. LOSS=.. RETX_LOSS=..).
#
# Env: REPS (default 3), DURATION (20), CONTENT (motion). Host build via HOST_BIN.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
export HOST_BIN="${HOST_BIN:-$HOME/.xpair/host/bin/screen}"
export RP_SCREENCAP="${RP_SCREENCAP:-$HOME/.xpair/host/bin/rp-screencap}"
export PATH="/opt/homebrew/bin:$PATH"
REPS="${REPS:-3}"; DURATION="${DURATION:-20}"; CONTENT="${CONTENT:-motion}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="out/grid-$STAMP.tsv"
LOG="out/grid-$STAMP.log"
mkdir -p out
echo -e "label\trep\tscore\tgate\tdecFps\tcoverage\tfreezeRatio\tinjLoss\tbitrate\tscale" > "$OUT"
port=9300; pport=9400

# CONDS: edit this list per experiment.
ABR_ON="RP_ABR=1 RP_ABR_INTERVAL_MS=1000 RP_ABR_MIN_BPS=150000 RP_ABR_MAX_BPS=600000 RP_ABR_NACK_HI=20 RP_ABR_NACK_LO=3"
CONDS=(
  "off_bw450|passthrough|congcal|4000000|1.0|BW_KBPS=450 BW_BUFFER_MS=300"
  "on_bw450|passthrough|congcal|4000000|1.0|BW_KBPS=450 BW_BUFFER_MS=300 $ABR_ON"
  "off_bw350|passthrough|congcal|4000000|1.0|BW_KBPS=350 BW_BUFFER_MS=300"
  "on_bw350|passthrough|congcal|4000000|1.0|BW_KBPS=350 BW_BUFFER_MS=300 $ABR_ON"
  "off_bw250|passthrough|congcal|4000000|1.0|BW_KBPS=250 BW_BUFFER_MS=300"
  "on_bw250|passthrough|congcal|4000000|1.0|BW_KBPS=250 BW_BUFFER_MS=300 $ABR_ON"
)

for cond in "${CONDS[@]}"; do
  IFS='|' read -r label profile seed bitrate scale extra <<<"$cond"
  for rep in $(seq 1 "$REPS"); do
    ok=0; c=""; x=""
    for a in 1 2 3; do
      port=$((port+1)); pport=$((pport+1))
      echo ">>> $label rep=$rep attempt=$a port=$port (br=$bitrate scale=$scale)" >&2
      # grid.sh runs without `set -e`, so a failed run-impaired.sh (host startup
      # timeout, relay-not-ready, axisA gate) would fall through and the ls -t below
      # would pick the newest leftover JSON from a PRIOR attempt/condition, scoring a
      # stale run under this label. Gate on the exit status: on failure, retry the
      # attempt instead of selecting any output file.
      if ! env PROFILE="$profile" SEED="$seed" CONTENT="$CONTENT" DURATION="$DURATION" \
        BITRATE="$bitrate" SCALE="$scale" PORT="$port" PROXY_PORT="$pport" \
        RP_PLI_COOLDOWN_MS=0 $extra \
        "$ROOT/run-impaired.sh" >/dev/null 2>>"$LOG"; then
        echo "    !! run-impaired.sh failed, retry" >&2; sleep 4; continue
      fi
      c="$ROOT/$(ls -t out/impaired-$profile-*.json | head -1)"
      x="$ROOT/$(ls -t out/proxy-$profile-*.json | head -1)"
      # Valid = ICE actually routed media through the relay (proxy forwarded RTP > 0).
      # A true zero-traffic flake has forwarded==0; severe-but-real degradation
      # (e.g. bandwidth cap) has forwarded>0 with low framesDecoded — NOT a flake.
      if node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const h=p.directions.hostToClient.classes.RTP||{};process.exit((h.forwarded||0)>0?0:1)' "$x" 2>/dev/null; then ok=1; break; fi
      echo "    !! zero-traffic flake, retry" >&2; sleep 4
    done
    # All attempts failed/flaked: $c/$x would still hold a PRIOR rep/cond's files
    # (they persist across iterations), so scoring here would label a stale run.
    # Emit a visible NA row and skip instead.
    if [[ "$ok" -ne 1 ]]; then
      echo "    !! $label rep=$rep: all attempts failed, no valid output — skipping" >&2
      echo -e "$label\t$rep\tNA\tfalse\t\t\t\t\t$bitrate\t$scale" >> "$OUT"
      continue
    fi
    sf="$ROOT/out/score-$label-rep$rep.json"
    node score/score.js --client "$c" --proxy "$x" --out "$sf" >/dev/null 2>&1
    node -e '
      const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const i=r.inputs||{};
      const f=(x,d=3)=>x==null?"":(typeof x==="number"?x.toFixed(d):x);
      console.log([process.argv[2],process.argv[3],f(r.score),(r.gates&&r.gates.passed),f(i.decodedFps,1),f(i.coverage),f(i.freezeRatio),f(i.injectedLossRate),process.argv[4],process.argv[5]].join("\t"));
    ' "$sf" "$label" "$rep" "$bitrate" "$scale" >> "$OUT"
    sleep 6
  done
done

echo "=== GRID DONE: $OUT ==="
column -t -s $'\t' "$OUT"
node -e '
const fs=require("fs");const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").slice(1).map(l=>l.split("\t"));
const by={};for(const r of L)(by[r[0]]??=[]).push(r);
const stat=a=>{a=a.filter(x=>x!==""&&!isNaN(x)).map(Number);if(!a.length)return[NaN,NaN];const m=a.reduce((x,y)=>x+y,0)/a.length;return[m,Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/a.length)];};
console.log("\n=== mean +/- std (decFps | score | gatePass) ===");
for(const k in by){const g=by[k];const[fm,fsd]=stat(g.map(r=>r[4]));const sc=g.filter(r=>+r[2]>-1e8).map(r=>r[2]);const[sm,ssd]=stat(sc);const pass=g.filter(r=>r[3]==="true").length;
console.log(k+": decFps "+fm.toFixed(1)+"±"+fsd.toFixed(1)+" | score "+(sc.length?sm.toFixed(3)+"±"+ssd.toFixed(3):"all-gatefail")+" | gate "+pass+"/"+g.length);}
' "$OUT"
