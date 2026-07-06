#!/usr/bin/env bash
# t_23_repo_js_contracts — run repository-level JS/CJS contract tests that live outside
# client/ide/remotepair/ext and were previously not wired into tests/run.sh.
cd "$(dirname "$0")"; . ./lib.sh

if ! command -v node >/dev/null 2>&1; then
  it "repo-js/node-available"; _fail "node not found — cannot run repository JS contract tests"
  finish; exit
fi

# One glob per covered area, asserted separately below: a whole subtree losing its
# tests (rename/move/delete) must fail loudly, not hide behind another area's count.
run_area() { # $1=area label, $2...=files (glob-expanded by caller)
  local area="$1"; shift
  local n=0 f rel out rc
  for f in "$@"; do
    [ -e "$f" ] || continue
    n=$((n+1))
    rel="${f#"$_REPO_ROOT"/}"
    out="$(node "$f" 2>&1)"; rc=$?
    it "repo-js/$rel"
    assert_rc "$rc" 0 "node $rel"
    [ "$rc" = 0 ] || printf '%s\n' "$out" | tail -8
  done
  it "repo-js/area-$area"
  [ "$n" -gt 0 ] && _pass "$area: $n contract test(s) discovered" \
                 || _fail "$area: no tests discovered — subtree renamed/moved/deleted?"
}

run_area client-cli  "$_REPO_ROOT"/client/cli/*.test.js
run_area host        "$_REPO_ROOT"/host/*.test.js
run_area host-app    "$_REPO_ROOT"/host/app/*.test.js
run_area host-onb    "$_REPO_ROOT"/host/onboarding/*.test.cjs
run_area shared      "$_REPO_ROOT"/shared/*.test.js
run_area bench       "$_REPO_ROOT"/bench/proxy/*.test.js "$_REPO_ROOT"/bench/score/*.test.js

finish
