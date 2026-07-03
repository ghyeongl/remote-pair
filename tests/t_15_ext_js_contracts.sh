#!/usr/bin/env bash
# t_15_ext_js_contracts — run the VSCodium extension's *.test.js contract tests (onboarding bridge,
# host-update gate, remote-desktop, global.d.ts, etc.) under the shared CI harness.
#
# WHY: these *.test.js files were never wired into tests/run.sh (which only globs t_*.sh), so the
# only thing that ran them was a developer invoking node by hand. That let invariant drift slip
# through — e.g. the MIN_COMPATIBLE_HOST host-compatibility floor reading a49 in onboarding-bridge.js
# but a45 in App.tsx / this very test file. Running them here makes that drift a CI failure.
#
# Each *.test.js prints "ok"/"FAIL" lines and exits non-zero on any failure; we assert rc==0 per file.
cd "$(dirname "$0")"; . ./lib.sh

EXT_DIR="$_REPO_ROOT/client/ide/remotepair/ext"

if ! command -v node >/dev/null 2>&1; then
  it "ext-js/node-available"; _fail "node not found — cannot run extension contract tests"
  finish; exit
fi

shopt -s nullglob
count=0
for f in "$EXT_DIR"/*.test.js; do
  count=$((count+1))
  name="$(basename "$f")"
  out="$(cd "$EXT_DIR" && node "$name" 2>&1)"; rc=$?
  it "ext-js/$name"
  assert_rc "$rc" 0 "node $name"
  [ "$rc" = 0 ] || printf '%s\n' "$out" | tail -5
done

it "ext-js/suite-discovered"
[ "$count" -gt 0 ] && _pass "found $count *.test.js under client/ide/remotepair/ext" \
                   || _fail "no *.test.js found under $EXT_DIR"

BRIDGE_JS="$(cat "$EXT_DIR/onboarding-bridge.js")"
it "ext-js/onboarding-bridge-legacy-client-env"
assert_contains "$BRIDGE_JS" 'const LEGACY_CLIENT_ENV = path.join(RP_HOST_DIR, "client.env")' "bridge defines legacy client.env fallback path"
assert_contains "$BRIDGE_JS" 'const CLIENT_ENV = fs.existsSync(CLIENT_ENV_FILE) ? CLIENT_ENV_FILE : LEGACY_CLIENT_ENV' "bridge prefers split client.env and falls back to legacy host/client.env"

finish
