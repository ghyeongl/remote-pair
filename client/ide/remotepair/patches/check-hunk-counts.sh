#!/usr/bin/env bash
# Guard: every injected VSCodium patch's file-CREATION hunk (`@@ -0,0 +1,N @@`) must declare N
# equal to its actual count of `+` lines. A short N truncates the created file mid-content when
# the patch is applied at build time, and vscode prepack then fails ("'}' expected") — a failure
# that only surfaces in the ~15-min release build, never the fast `test` job. This check catches
# it in `test`. Two such truncations shipped before this guard existed (#94, #95).
#
# Usage: check-hunk-counts.sh            scan all *.patch here; exit 1 on any mismatch
#        check-hunk-counts.sh --self-test verify the checker actually catches a bad hunk
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

check_file() {
  local p="$1" rc=0 ln rest decl actual
  while IFS=: read -r ln rest; do
    [ -n "$ln" ] || continue
    decl=$(printf '%s' "$rest" | sed -E 's/^@@ -0,0 \+1,([0-9]+) @@.*/\1/')
    # count consecutive '+' lines from just after the header until the next hunk / file diff
    actual=$(tail -n +$((ln + 1)) "$p" | awk '/^@@/{exit} /^diff --git /{exit} /^\+/{c++} END{print c + 0}')
    if [ "$decl" != "$actual" ]; then
      echo "MISMATCH $p hunk@line $ln: header declares +$decl but hunk has $actual '+' lines" >&2
      rc=1
    fi
  done < <(grep -n '^@@ -0,0 +1,[0-9]\+ @@' "$p" || true)
  return $rc
}

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
  # creation hunk declaring +1,2 but carrying 3 '+' lines → must be flagged
  printf 'diff --git a/x b/x\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b\n+c\n' > "$tmp"
  if check_file "$tmp" 2>/dev/null; then echo "SELF-TEST FAIL: mismatch not detected" >&2; exit 1; fi
  echo "self-test ok (mismatch detected)"; exit 0
fi

rc=0
shopt -s nullglob
for p in "$HERE"/*.patch; do check_file "$p" || rc=1; done
[ $rc -eq 0 ] && echo "✓ injected-patch creation hunks: all declared counts match"
exit $rc
