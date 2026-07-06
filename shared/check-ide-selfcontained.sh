#!/usr/bin/env bash
# check-ide-selfcontained.sh — verify client/ide/ consumes shared/ only via committed
# generated artifacts and never reaches into the parent shared/ at build/runtime.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXT="$ROOT/client/ide/remotepair/ext"
GEN="$EXT/generated/contracts.json"
fail=0
ok()   { printf 'ok:  %s\n' "$1"; }
miss() { printf 'MISS: %s\n' "$1"; fail=1; }

# 1) extension.js syntax valid
node --check "$EXT/extension.js" 2>/dev/null && ok "extension.js syntax" || miss "extension.js syntax"

# 2) generated contracts in sync with shared/ (regenerate is a no-op)
if [[ -f "$GEN" ]]; then
  tmp=$(mktemp -t xpair-contracts.XXXXXX)
  # regenerate with the real generator into a temp file (OUT override) — the check
  # must never duplicate the generator's mapping, and never dirty the working tree
  if OUT="$tmp" node "$EXT/generate-contracts.mjs" >/dev/null 2>&1; then
    committed=$(shasum "$GEN" | cut -d' ' -f1)
    expected=$(shasum "$tmp" | cut -d' ' -f1)
    [[ "$committed" == "$expected" ]] && ok "generated/ in sync with shared/" || miss "generated/ stale — run generate-contracts.mjs and commit (working tree left unchanged)"
  else
    miss "generator failed"
  fi
  rm -f "$tmp"
else
  miss "generated/contracts.json missing — run generate-contracts.mjs"
fi

# 3) self-containment: only the generator may reference the parent shared/ (relative parent paths)
viol=$(grep -rnE '\.\./\.\./shared|\.\./shared' "$EXT" --include='*.js' --include='*.json' 2>/dev/null \
       | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' \
       | grep -v 'generate-contracts' || true)
[[ -z "$viol" ]] && ok "no client/ide/ → parent shared/ deps (generator excepted)" \
                  || { miss "client/ide/ reaches parent shared/:"; echo "$viol"; }

# 4) generated identity/version fields are covered by the SoT (no silent drift surface)
command -v jq >/dev/null || { echo "jq required"; exit 2; }
IDJSON="$ROOT/shared/identity/identity.json"; VERJSON="$ROOT/shared/identity/versions.json"
eqg() { if [[ "$2" == "$3" ]]; then ok "$1 = $2"; else miss "$1 (SoT=$2 gen=$3)"; fi; }
eqg "generated.identity.product"     "$(jq -r .product "$IDJSON")"     "$(jq -r .identity.product "$GEN")"
eqg "generated.identity.urlProtocol" "$(jq -r .urlProtocol "$IDJSON")" "$(jq -r .identity.urlProtocol "$GEN")"
eqg "generated.identity.ideBundleId" "$(jq -r .components.ide.darwinBundleIdentifier "$IDJSON")" "$(jq -r .identity.ideBundleId "$GEN")"
eqg "generated.version"              "$(jq -r .ide "$VERJSON")"        "$(jq -r .version "$GEN")"

[[ $fail -eq 0 ]] && echo "✓ client/ide/ self-contained (consumes shared/ via committed generated/ only)" \
                  || { echo "✗ self-containment violated"; exit 1; }
