#!/usr/bin/env bash
# t_23_repo_js_contracts — run repository-level JS/CJS contract tests that live outside
# client/ide/remotepair/ext and were previously not wired into tests/run.sh.
cd "$(dirname "$0")"; . ./lib.sh

if ! command -v node >/dev/null 2>&1; then
  it "repo-js/node-available"; _fail "node not found — cannot run repository JS contract tests"
  finish; exit
fi

count=0
for f in "$_REPO_ROOT"/client/cli/*.test.js \
         "$_REPO_ROOT"/host/*.test.js \
         "$_REPO_ROOT"/host/app/*.test.js \
         "$_REPO_ROOT"/host/onboarding/*.test.cjs \
         "$_REPO_ROOT"/shared/*.test.js; do
  [ -e "$f" ] || continue
  count=$((count+1))
  rel="${f#"$_REPO_ROOT"/}"
  out="$(node "$f" 2>&1)"; rc=$?
  it "repo-js/$rel"
  assert_rc "$rc" 0 "node $rel"
  [ "$rc" = 0 ] || printf '%s\n' "$out" | tail -8
done

it "repo-js/suite-discovered"
[ "$count" -gt 0 ] && _pass "found $count repo JS/CJS contract tests" \
                   || _fail "no repo JS/CJS contract tests found"

finish
