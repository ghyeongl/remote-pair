#!/usr/bin/env bash
# t_19_uninstall_safety — the uninstallers must not destroy a co-located OTHER-role install.
#   • host uninstaller: a legacy 0.4.x RemotePairHost.app is a protected production install and
#     must trip the refuse-gate (not just XpairHost.app).
#   • client uninstaller: ~/.xpair is a shared namespace; a client-only wipe must preserve
#     ~/.xpair/host when a co-located host is present.
# Both are exercised via --dry-run (run() echoes "DRY: <cmd>" instead of executing), so nothing
# is actually removed — we assert on the emitted commands / exit code.
cd "$(dirname "$0")"; . ./lib.sh

HOST_SRC="$_REPO_ROOT/host/uninstall-host.sh"
CLIENT_SRC="$_REPO_ROOT/client/cli/uninstall-client.sh"

# ── host P1: legacy RemotePairHost.app 0.4.x must trip the protected-version refuse-gate ──
H="$(mktemp -d -t rpltest.XXXXXX)"
mkdir -p "$H/Applications/RemotePairHost.app/Contents"
cat > "$H/Applications/RemotePairHost.app/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.4.7</string></dict></plist>
PL
OUT="$(HOME="$H" bash "$HOST_SRC" --dry-run 2>&1)"; RC=$?
it "uninstall_host/legacy-0.4-protected"
assert_rc "$RC" 3 "legacy RemotePairHost.app 0.4.x refuses without --force"
assert_contains "$OUT" "REFUSING" "refuse-gate fires for the legacy production app"
rm -rf "$H"

# ── client P2: co-located host present → wipe only ~/.xpair/client, preserve ~/.xpair/host ──
H="$(mktemp -d -t rpltest.XXXXXX)"
mkdir -p "$H/.xpair/host" "$H/.xpair/client"
OUT="$(HOME="$H" bash "$CLIENT_SRC" -y --dry-run 2>&1)"
it "uninstall_client/preserves-co-located-host"
assert_contains "$OUT" "rm -rf $H/.xpair/client" "removes the client subtree"
if printf '%s\n' "$OUT" | grep -qxF "DRY: rm -rf $H/.xpair"; then
  _fail "must NOT wipe the shared ~/.xpair top-level when a host is co-located"
else
  _pass "preserves ~/.xpair/host (no top-level wipe)"
fi
rm -rf "$H"

# ── client-only machine (no ~/.xpair/host) → full ~/.xpair wipe, as before ──
H="$(mktemp -d -t rpltest.XXXXXX)"
mkdir -p "$H/.xpair/client"
OUT="$(HOME="$H" bash "$CLIENT_SRC" -y --dry-run 2>&1)"
it "uninstall_client/full-wipe-when-client-only"
if printf '%s\n' "$OUT" | grep -qxF "DRY: rm -rf $H/.xpair"; then
  _pass "wipes the whole ~/.xpair on a client-only machine"
else
  _fail "client-only uninstall should remove the whole ~/.xpair :: in=[$OUT]"
fi
rm -rf "$H"

finish
