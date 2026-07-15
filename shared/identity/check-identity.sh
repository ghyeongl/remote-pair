#!/usr/bin/env bash
# check-identity.sh — verify all consumers match the shared/identity/ SoT.
# Non-breaking: reads identity.json + versions.json and asserts that
# client/ide/product.json, Casks/xpair-host.rb, host/rd Cargo.toml, and host/app Swift
# carry the canonical brand/version values. Exits non-zero on drift.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ID="$HERE/identity.json"
VER="$HERE/versions.json"

command -v jq >/dev/null || { echo "jq required"; exit 2; }

fail=0
check() { # desc expected actual
  if [[ "$2" != "$3" ]]; then
    printf 'MISMATCH: %-40s SoT=%q actual=%q\n' "$1" "$2" "$3"; fail=1
  else
    printf 'ok: %-40s = %s\n' "$1" "$2"
  fi
}

# --- client/ide/product.json brand fields + version ---
PJ="$ROOT/client/ide/product.json"
if [[ -f "$PJ" ]]; then
  for k in nameShort nameLong applicationName dataFolderName darwinBundleIdentifier \
           urlProtocol serverApplicationName serverDataFolderName win32AppUserModelId win32MutexName; do
    check "client/ide/product.json:$k" "$(jq -r ".components.ide.$k" "$ID")" "$(jq -r ".$k // empty" "$PJ")"
  done
else
  echo "skip: client/ide/product.json not found"
fi

# ide version lives in the committed Xpair extension (product.json has none;
# the app version is injected at build from RELEASE_VERSION).
EXT_PKG="$ROOT/client/ide/remotepair/ext/package.json"
if [[ -f "$EXT_PKG" ]]; then
  check "ide version (remotepair/ext)" "$(jq -r .ide "$VER")" "$(jq -r '.version // empty' "$EXT_PKG")"
else
  printf 'MISSING: %s\n' "$EXT_PKG"; fail=1
fi

# --- Casks/xpair-host.rb version ---
CASK="$ROOT/Casks/xpair-host.rb"
[[ -f "$CASK" ]] && check "Casks host version" "$(jq -r .host "$VER")" \
  "$(grep -E '^[[:space:]]*version "' "$CASK" | head -1 | sed -E 's/.*version "([^"]+)".*/\1/')"

# --- host/rd Cargo.toml version ---
CARGO="$ROOT/host/rd/screen/Cargo.toml"
[[ -f "$CARGO" ]] && check "rs screen-engine version" "$(jq -r '."screen-engine"' "$VER")" \
  "$(awk -F'"' '/^\[package\]/{p=1} p&&/^version[[:space:]]*=/{print $2; exit}' "$CARGO")"

# --- client/cli-rs Cargo.toml version ---
CLI_CARGO="$ROOT/client/cli-rs/Cargo.toml"
[[ -f "$CLI_CARGO" ]] && check "cli-rs Cargo.toml version" "$(jq -r .cli "$VER")" \
  "$(awk -F'"' '/^\[package\]/{p=1} p&&/^version[[:space:]]*=/{print $2; exit}' "$CLI_CARGO")"

# --- host bundle id present in Config.swift ---
CFG="$ROOT/host/app/Config.swift"
EXP_BID="$(jq -r .components.host.bundleId "$ID")"
if [[ -f "$CFG" ]]; then
  if grep -q "$EXP_BID" "$CFG"; then printf 'ok: %-40s = %s\n' "host bundleId in Config.swift" "$EXP_BID"
  else printf 'MISMATCH: %-40s %q not found\n' "host bundleId in Config.swift" "$EXP_BID"; fail=1; fi
fi

if [[ $fail -eq 0 ]]; then echo "✓ identity SoT: all consumers aligned"; else echo "✗ identity drift detected"; exit 1; fi
