#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/config.sh"
. "$HERE/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

env_file="$tmp/telemetry.env"
build_file="$tmp/telemetry.build.env"

cat > "$env_file" <<'EOF'
TELEMETRY_CONSENT=1
TELEMETRY_ANON_ID=anon-test
EOF

cat > "$build_file" <<'EOF'
POSTHOG_KEY=phc_test
SENTRY_DSN=https://abc@o1.ingest.sentry.io/1
EOF

_seed_telemetry_env "$build_file" "$env_file"

grep -qx 'POSTHOG_KEY=phc_test' "$env_file" || { echo "FAIL: missing PostHog key"; exit 1; }
grep -qx 'SENTRY_DSN=https://abc@o1.ingest.sentry.io/1' "$env_file" || { echo "FAIL: missing Sentry DSN"; exit 1; }
grep -qx 'TELEMETRY_CONSENT=1' "$env_file" || { echo "FAIL: consent line clobbered"; exit 1; }

_seed_telemetry_env "$build_file" "$env_file"

[ "$(grep -c '^POSTHOG_KEY=' "$env_file")" = 1 ] || { echo "FAIL: duplicate PostHog key"; exit 1; }

echo "PASS"
