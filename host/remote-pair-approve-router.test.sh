#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/logs"
touch "$TMP/shot.png"
cat >"$TMP/bin/ocr-find" <<'EOF'
#!/bin/bash
case "${OCR_RESULT:-}" in
  always) [[ "$2" == *"Always Allow"* ]] && echo 10,10 ;;
  once) [[ "$2" == *"Allow Once"* ]] && echo 10,10 ;;
esac
EOF
chmod +x "$TMP/bin/ocr-find"
printf 'Claude for Chrome\tNew permissions required\tkey:cmd+return|return\n' >"$TMP/rules.txt"

run_router() {
  PATH="$TMP/bin:$PATH" RP_DIR="$TMP" RULES_FILE="$TMP/rules.txt" \
    LOG_FILE="$TMP/logs/router.log" RP_SHOT="$TMP/shot.png" RP_DRY=1 \
    RP_FOR="${2-Claude for Chrome}" RP_TYPE="${3:-}" OCR_RESULT="$1" \
    "$ROOT/host/remote-pair-approve-router.sh"
}

[[ "$(run_router always)" == "WOULD key 'cmd+return' x5 [Claude for Chrome]" ]]
[[ "$(run_router once)" == "WOULD key 'return' x5 [Claude for Chrome]" ]]
if run_router decline >/dev/null 2>&1; then
  echo "router accepted an unconfirmed key outcome" >&2
  exit 1
fi

printf 'Some Dialog\tConfirm action\tkey:return\n' >"$TMP/rules.txt"
[[ "$(run_router decline 'Some Dialog')" == "WOULD key 'return' x5 [Some Dialog]" ]]
[[ "$(run_router decline '' 'key:return')" == "WOULD key 'return' x5 [agent-type]" ]]
