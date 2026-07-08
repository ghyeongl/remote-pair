#!/bin/bash
# Install the approve rules/skill from a verified XpairHost.app bundle resource.
# This is used by the Rust release install path after codesign verification; it
# deliberately performs no network fetches and does not install the native app.
set -euo pipefail

GLUE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RP_DIR="${RP_DIR:-$HOME/.xpair/host}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
RULES_FILE="${RULES_FILE:-$RP_DIR/rules.txt}"
MANIFEST="${XPAIR_RELEASE_GLUE_MANIFEST:-$RP_DIR/.install-manifest}"
BACKUP_DIR="$RP_DIR/backups"

record() {
  mkdir -p "$(dirname "$MANIFEST")"
  printf '%s\t%s\t%s\n' "$1" "${2:-}" "${3:-}" >> "$MANIFEST"
}

install_file() {
  local src="$1" dst="$2" mode="${3:-}"
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ]; then
    mkdir -p "$BACKUP_DIR"
    local safe bak
    safe="$(printf '%s' "$dst" | sed 's#/#_#g')"
    bak="$BACKUP_DIR/${safe}.$(date +%s).$$.release-glue.bak"
    cp -p "$dst" "$bak"
    record BACKUP "$dst" "$bak"
  else
    record FILE "$dst"
  fi
  cp "$src" "$dst"
  [ -z "$mode" ] || chmod "$mode" "$dst"
}

[ -f "$GLUE_DIR/rules.txt" ] || { echo "APPROVE_GLUE_MISSING: $GLUE_DIR/rules.txt" >&2; exit 1; }
[ -f "$GLUE_DIR/skills/approve/SKILL.md" ] || { echo "APPROVE_GLUE_MISSING: $GLUE_DIR/skills/approve/SKILL.md" >&2; exit 1; }

install_file "$GLUE_DIR/rules.txt" "$RULES_FILE" 644

while IFS= read -r src; do
  rel="${src#"$GLUE_DIR/skills/"}"
  install_file "$src" "$CLAUDE_DIR/skills/$rel" 644
done < <(find "$GLUE_DIR/skills" -type f)

echo "approve glue installed from $GLUE_DIR"
