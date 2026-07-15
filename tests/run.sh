#!/usr/bin/env bash
# tests/run.sh — runs all tests/t_*.sh, tallies PASS/FAIL. Exits non-zero on failure.
cd "$(dirname "$0")"
export HOME_REAL="$HOME"
TOTP=0; TOTF=0; FILES=0
for t in t_*.sh; do
  [ -f "$t" ] || continue
  FILES=$((FILES+1))
  printf '\n=== %s ===\n' "$t"
  out="$(bash "$t" 2>&1)"; rc=$?
  printf '%s\n' "$out" | grep -v '^__SUMMARY__'
  s="$(printf '%s\n' "$out" | grep '^__SUMMARY__' | tail -1)"
  p="$(printf '%s' "$s" | sed -n 's/.*pass=\([0-9]*\).*/\1/p')"
  f="$(printf '%s' "$s" | sed -n 's/.*fail=\([0-9]*\).*/\1/p')"
  [ -z "$p" ] && p=0; [ -z "$f" ] && f=0
  # No summary line means the test file did not call finish; count it as a harness failure even if rc=0.
  if [ -z "$s" ]; then f=$((f+1)); printf '  (no __SUMMARY__ line, rc=%s — counted as fail)\n' "$rc"; fi
  TOTP=$((TOTP+p)); TOTF=$((TOTF+f))
done
printf '\n========================================\n'
printf 'TOTAL: %s passed, %s failed across %s files\n' "$TOTP" "$TOTF" "$FILES"
[ "$TOTF" = 0 ]
