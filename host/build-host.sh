#!/bin/bash
# build-host.sh — build XpairHost.app (menu-bar host: tmux host + approve + session management + updater)
#
# Compiles the per-responsibility .swift files in one shot (zero package dependencies). Embeds the helpers (tmux-aqua, router, ocr-find) in the bundle.
# Signing: stable self-signed cert "RemotePair Local Signing" → the TCC grant is bound to the designated requirement
#   so it survives rebuilds/updates. Without the cert, falls back to ad-hoc (re-toggle on every rebuild). Generate it with: ./make-signing-cert.sh
#
# Usage:
#   ./build-host.sh                 # build/XpairHost.app build+sign+verify
#   ./build-host.sh --deploy [host] # above + rsync → remote (default REMOTE_HOST or gh-mac-m1) → install.sh --role host
#   ./build-host.sh --release       # above + signed-app zip → gh release create v<version>
set -euo pipefail
cd "$(dirname "$0")/.."                       # repo root
. shared/config.sh                            # SSOT: APP_NAME·BUNDLE_PREFIX·SIGN_CN·GH_REPO

# Version: shared monotonic alpha counter (LOCKSTEP with the client IDE build — same 0.5.0a base +
# the SAME shared/.build-counter). Each build (host OR client) bumps the one counter so the project
# has a single 0.5.0aN sequence; each build is verifiably distinct. Override with RP_VERSION=… for a
# pinned release. (cwd is the repo root — set by the `cd` above.)
RP_BUILD_BASE="${RP_BUILD_BASE:-0.5.0a}"
RP_COUNTER_FILE="shared/.build-counter"
_rpn=$(( $(cat "$RP_COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$_rpn" > "$RP_COUNTER_FILE"
VERSION="${RP_VERSION:-${RP_BUILD_BASE}${_rpn}}"
echo "→ build marker: $VERSION  (shared counter: $RP_COUNTER_FILE)"
SRC_DIR=host/app
APP="build/${APP_NAME}.app"
EXEC="$APP_NAME"
DEPLOY_HOST="${REMOTE_HOST:-gh-mac-m1}"

# ── signing identity ──
# Functional probe, not a trust/presence check: an imported-but-untrusted cert matches
# find-identity yet may still fail to codesign, and a `-v` (trusted) check is wrong the other way
# (CI's cert signs even though `find-identity -v` won't list it). So actually attempt to sign a
# throwaway binary with the cert and adopt it only if that succeeds; else fall back to ad-hoc.
# Signing only needs the private key, not a trust anchor, and the downstream
# `codesign --verify --strict` validates the signature seal (not cert trust), so it still passes.
_can_codesign_with() {
  local cn="$1" probe rc
  probe="$(mktemp -t rp-signprobe)" || return 1
  cp /usr/bin/true "$probe" 2>/dev/null || { rm -f "$probe"; return 1; }
  codesign --force --sign "$cn" "$probe" >/dev/null 2>&1; rc=$?
  rm -f "$probe"
  return $rc
}
if security find-identity -p codesigning 2>/dev/null | grep -q "$SIGN_CN" && _can_codesign_with "$SIGN_CN"; then
  SIGN_ID="$SIGN_CN"; echo "signing: stable cert '$SIGN_CN' (functional codesign probe passed; grant survives rebuilds/updates)"
else
  SIGN_ID="-"; echo "⚠ signing: ad-hoc (cert '$SIGN_CN' cannot codesign → re-toggle on every rebuild). ./host/make-signing-cert.sh recommended"
fi

# ── build the in-process onboarding (React) — bundled into Contents/Resources/onboarding ──
# The onboarding is no longer a standalone Electron app; it is loaded by OnboardingWindow.swift in a
# WKWebView. vite base is './' so the build is relocatable under file://. Build it here so the bundle
# step below can copy host/onboarding/dist/ into the .app.
echo "=== build onboarding (React: npm install + vite build) ==="
command -v npm >/dev/null || { echo "✗ npm missing — Node toolchain required to build the onboarding UI" >&2; exit 1; }
( cd host/onboarding && npm install --silent && npm run build ) \
  || { echo "✗ onboarding React build failed (host/onboarding)" >&2; exit 1; }
[ -f host/onboarding/dist/index.html ] \
  || { echo "✗ onboarding build produced no dist/index.html" >&2; exit 1; }

# ── compile (SwiftPM) — `swift build -c release` resolves+links sentry-cocoa ──
# host/Package.swift declares the executable target (all of host/app/*.swift) + the Sentry dependency.
# `swift build` fetches sentry-cocoa from GitHub on first run (network) and statically links it. The built
# product is copied into the bundle below; the rest of the bundle/sign flow is unchanged.
echo "=== compile (SwiftPM: swift build -c release — links sentry-cocoa) ==="
mkdir -p build
swift build --package-path host -c release \
  || { echo "✗ swift build -c release failed (host/Package.swift)" >&2; exit 1; }
SPM_BIN_DIR="$(swift build --package-path host -c release --show-bin-path)"
SPM_BIN="$SPM_BIN_DIR/$EXEC"
[ -x "$SPM_BIN" ] || { echo "✗ swift build produced no executable at $SPM_BIN" >&2; exit 1; }
cp "$SPM_BIN" "build/$EXEC"
xcrun swiftc -O host/ocr-find.swift -o host/ocr-find 2>/dev/null \
  || xcrun swiftc -O -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX14.5.sdk -target arm64-apple-macos13.0 host/ocr-find.swift -o host/ocr-find

echo "=== bundle ==="
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
mv "build/$EXEC" "$APP/Contents/MacOS/$EXEC"
cat > "$APP/Contents/Info.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${APP_NAME}</string>
<key>CFBundleDisplayName</key><string>${APP_NAME}</string>
<key>CFBundleIdentifier</key><string>${BUNDLE_PREFIX}</string>
<key>CFBundleExecutable</key><string>${EXEC}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${VERSION}</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
<key>RPGitHubRepo</key><string>${GH_REPO}</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSLocalNetworkUsageDescription</key><string>Xpair broadcasts this Mac on your local network so your Xpair client can discover and pair with it.</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleIconName</key><string>AppIcon</string>
</dict></plist>
P
# Inject RPSentryDSN only when RP_SENTRY_DSN env var is set and non-empty.
# Absent key => setupIfConsented() stays NoopCrashReporter (zero network). Never hardcode the DSN.
if [ -n "${RP_SENTRY_DSN:-}" ]; then
  /usr/libexec/PlistBuddy -c "Add :RPSentryDSN string ${RP_SENTRY_DSN}" "$APP/Contents/Info.plist"
  echo "  RPSentryDSN injected into Info.plist (from RP_SENTRY_DSN)"
else
  echo "  RPSentryDSN not set — crash reporting stays Noop (set RP_SENTRY_DSN=<dsn> to enable)"
fi

echo "=== embed helpers → Contents/Helpers ==="
HELP="$APP/Contents/Helpers"; mkdir -p "$HELP"
cp host/xpair-approve-router.sh "$HELP/"; chmod +x "$HELP/xpair-approve-router.sh"
cp host/ocr-find "$HELP/"; chmod +x "$HELP/ocr-find"
# cliclick = the app's click/key primitive injector. Embedded in the bundle (self-contained). If missing, falls back to the homebrew path at runtime.
if [ -x /opt/homebrew/bin/cliclick ]; then cp /opt/homebrew/bin/cliclick "$HELP/cliclick"; chmod +x "$HELP/cliclick"; echo "  embedded: cliclick"; fi
# tmux-aqua is the heart of the host (the keeper server = parent of every session). The cask installs only the .app, so
# the runtime ~/.local/bin fallback does not exist → if it is missing from the bundle, the host ships dead (zero sessions).
# So instead of "warn and pass through if missing": if missing, try to build it → if still missing, HARD-FAIL.
if [ ! -x "$HOME/.local/bin/tmux-aqua" ]; then
  echo "  tmux-aqua missing (~/.local/bin) → auto-running ./host/build-tmux-aqua.sh ..."
  ./host/build-tmux-aqua.sh || { echo "✗ tmux-aqua build failed — run ./host/build-tmux-aqua.sh manually and retry" >&2; exit 1; }
fi
[ -x "$HOME/.local/bin/tmux-aqua" ] || { echo "✗ tmux-aqua still missing — cannot bundle (without the helper the cask host is wiped out: zero sessions)" >&2; exit 1; }
cp "$HOME/.local/bin/tmux-aqua" "$HELP/tmux-aqua"; chmod +x "$HELP/tmux-aqua"
# Final check that it actually made it into the bundle — block a broken bundle from leaking into release/cask at the source.
[ -x "$HELP/tmux-aqua" ] || { echo "✗ tmux-aqua bundle embed verification failed: $HELP/tmux-aqua" >&2; exit 1; }
echo "  embedded: tmux-aqua ($("$HELP/tmux-aqua" -V 2>/dev/null || echo '?')) + xpair-approve-router.sh + ocr-find"

# mosh-server = the host side of the resilient UDP attach. The host arrives via SCP (install-host) with no
# Homebrew, so it cannot `brew install mosh`. We ship a self-contained STATIC mosh-server (built against
# protobuf 3.21.12, pre-abseil → 0 brew dylib deps; see build-mosh.sh) so attach works brew-free. If missing,
# build it; if the build fails, do NOT hard-fail — the CLI falls back to `ssh -t` when mosh-server is absent.
if [ ! -x "$HOME/.local/bin/mosh-server" ]; then
  echo "  mosh-server missing (~/.local/bin) → auto-running ./host/build-mosh.sh ..."
  ./host/build-mosh.sh || echo "⚠ mosh-server build failed — bundling without it (attach falls back to ssh)" >&2
fi
if [ -x "$HOME/.local/bin/mosh-server" ]; then
  cp "$HOME/.local/bin/mosh-server" "$HELP/mosh-server"; chmod +x "$HELP/mosh-server"
  [ -x "$HELP/mosh-server" ] || { echo "✗ mosh-server bundle embed verification failed: $HELP/mosh-server" >&2; exit 1; }
  # Guard the whole point of the static build: a brew dylib link means it won't run on a brew-less host.
  if otool -L "$HELP/mosh-server" | tail -n +2 | grep -q "/opt/homebrew"; then
    echo "✗ embedded mosh-server links a /opt/homebrew dylib — not self-contained, will break on a brew-less host" >&2
    otool -L "$HELP/mosh-server" | grep "/opt/homebrew" >&2; exit 1
  fi
  echo "  embedded: mosh-server ($("$HELP/mosh-server" --version 2>&1 | head -1 || echo '?'))"
else
  echo "  mosh-server not embedded (build unavailable) — host attach will use ssh fallback"
fi

# ── screenshare binaries (screen sidecar + capture/input helpers) → Contents/Helpers ──
# Since the SSH deploy channel was retired, this bundle is the only delivery path for these binaries.
#   • screen           v1 (JPEG/WS) + v2 (WebRTC/H.264) sidecar. v2 requires --features webrtc.
#   • rp-screencap     SCK+VT H.264 capture (Screen Recording permission)
#   • rp-input-inject  remote input injector (Accessibility permission)
# All are individually inside-out signed with the stable cert (below) so the TCC grant is bound to the designated requirement
# and survives .app updates. The resolver (serve_webrtc.rs) probes the current_exe() sibling path first, so
# when screen starts from Helpers/ it auto-discovers the sibling helpers.
echo "=== build + embed screenshare binaries (screen + rp-screencap + rp-input-inject) ==="
# Ensure cargo (+rustc): the rustup shell may not have put the toolchain on PATH, so put ~/.cargo/bin first.
export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "✗ cargo missing — Rust toolchain required (rustup). Cannot build the screen sidecar." >&2; exit 1; }
SCREEN_MANIFEST="host/rd/screen/Cargo.toml"
echo "  cargo build --release --features webrtc ($SCREEN_MANIFEST) …"
cargo build --release --features webrtc --manifest-path "$SCREEN_MANIFEST" \
  || { echo "✗ screen sidecar cargo build failed (--features webrtc)" >&2; exit 1; }
cp host/rd/screen/target/release/screen "$HELP/screen"; chmod +x "$HELP/screen"
[ -x "$HELP/screen" ] || { echo "✗ screen bundle embed verification failed: $HELP/screen" >&2; exit 1; }
# Confirm the v2 path (serve-webrtc subcommand) actually made it in — if the webrtc feature is missing, v2 silently disappears.
"$HELP/screen" serve-webrtc --help >/dev/null 2>&1 \
  || { echo "✗ screen has no serve-webrtc — --features webrtc build failed" >&2; exit 1; }
# rp-screencap — single Swift file, same toolchain/fallback strategy as compile().
compile_helper() { # $1=src $2=out
  local src="$1" out="$2" sdk
  if xcrun swiftc -O "$src" -o "$out" 2>/tmp/rp-helper.err; then return 0; fi
  for sdk in /Library/Developer/CommandLineTools/SDKs/MacOSX14.5.sdk \
             /Library/Developer/CommandLineTools/SDKs/MacOSX14.sdk \
             /Library/Developer/CommandLineTools/SDKs/MacOSX13.3.sdk; do
    [ -d "$sdk" ] || continue
    echo "  (helper default compile failed → SDK fallback: $(basename "$sdk"))"
    if xcrun swiftc -O -sdk "$sdk" -target arm64-apple-macos13.0 "$src" -o "$out" 2>/tmp/rp-helper.err; then return 0; fi
  done
  echo "✗ Swift helper compile failed ($src):"; cat /tmp/rp-helper.err >&2; return 1
}
compile_helper host/rd/rpmedia/rp-screencap.swift    "$HELP/rp-screencap";    chmod +x "$HELP/rp-screencap"
[ -x "$HELP/rp-screencap" ] \
  || { echo "✗ rp-screencap bundle embed verification failed" >&2; exit 1; }
compile_helper host/rd/rpmedia/rp-input-inject.swift "$HELP/rp-input-inject"; chmod +x "$HELP/rp-input-inject"
[ -x "$HELP/rp-input-inject" ] \
  || { echo "✗ rp-input-inject bundle embed verification failed" >&2; exit 1; }
echo "  embedded: screen ($("$HELP/screen" --version 2>/dev/null || echo '?')) + rp-screencap + rp-input-inject"

RES="$APP/Contents/Resources"; mkdir -p "$RES"   # (for the icon; populated below)

# Release install support: the app self-installs its daemon/helpers, but Installer.swift
# deliberately does not install the Claude approve skill or rules. Embed those as inert
# resources so the Rust release installer can copy them from the already codesign-verified
# bundle path without fetching bootstrap.sh or any network script.
echo "=== embed release approve glue → Contents/Resources/host-glue ==="
GLUE="$RES/host-glue"; rm -rf "$GLUE"; mkdir -p "$GLUE"
cp host/rules.txt "$GLUE/rules.txt"
cp -R host/skills "$GLUE/skills"
cp host/release-install-approve-glue.sh "$GLUE/install-approve-glue.sh"; chmod +x "$GLUE/install-approve-glue.sh"
[ -f "$GLUE/skills/approve/SKILL.md" ] \
  || { echo "✗ release approve glue embed verification failed: $GLUE/skills/approve/SKILL.md" >&2; exit 1; }
echo "  embedded: rules.txt + approve skill + install-approve-glue.sh"

# Installer.swift mirrors the approve/notify hook registration from bundle Helpers/hooks.
HOOKS="$HELP/hooks"; rm -rf "$HOOKS"; mkdir -p "$HOOKS"
cp host/hooks/xpair-notify.sh host/hooks/manage-claude-hooks.py "$HOOKS/"
[ -f host/hooks/approve-reminder.sh ] && cp host/hooks/approve-reminder.sh "$HOOKS/"
chmod +x "$HOOKS"/*
echo "  embedded: hook sources for app self-install"

# ── embed the onboarding React build → Contents/Resources/onboarding ──
# OnboardingWindow.swift loads Contents/Resources/onboarding/index.html in a WKWebView (vite base './').
echo "=== embed onboarding (React dist) → Contents/Resources/onboarding ==="
rm -rf "$RES/onboarding"; mkdir -p "$RES/onboarding"
cp -R host/onboarding/dist/. "$RES/onboarding/"
[ -f "$RES/onboarding/index.html" ] \
  || { echo "✗ onboarding bundle embed verification failed: $RES/onboarding/index.html" >&2; exit 1; }
echo "  embedded: onboarding/index.html (+ assets)"

echo "=== embed app icon + menu-bar template → Contents/Resources ==="
if [ -f assets/icon/AppIcon-1024.png ]; then
  ISET="build/AppIcon.iconset"; rm -rf "$ISET"; mkdir -p "$ISET"
  _gen() { sips -z "$2" "$2" assets/icon/AppIcon-1024.png --out "$ISET/$1" >/dev/null; }
  _gen icon_16x16.png 16;    _gen icon_16x16@2x.png 32
  _gen icon_32x32.png 32;    _gen icon_32x32@2x.png 64
  _gen icon_128x128.png 128; _gen icon_128x128@2x.png 256
  _gen icon_256x256.png 256; _gen icon_256x256@2x.png 512
  _gen icon_512x512.png 512; _gen icon_512x512@2x.png 1024
  iconutil -c icns "$ISET" -o "$RES/AppIcon.icns" && echo "  app icon → Resources/AppIcon.icns (from assets/icon/AppIcon-1024.png)"
elif [ -f assets/icon/AppIcon.icns ]; then
  cp assets/icon/AppIcon.icns "$RES/AppIcon.icns"; echo "  app icon → Resources/AppIcon.icns (prebuilt)"
else
  echo "  ⚠ no app icon (assets/icon/AppIcon-1024.png or .icns) — bundle ships without one"
fi
for f in menubar.png menubar@2x.png; do
  [ -f "assets/icon/$f" ] && cp "assets/icon/$f" "$RES/$f"
done
[ -f "$RES/menubar.png" ] && echo "  menu-bar template → Resources/menubar.png (+@2x)"

# ── signing: inside-out individual signing (Apple-recommended; not reliant on --deep) ──
# --deep is for verification and can miss or mis-sign nested code, destabilizing the TCC designated requirement.
# Sign each Helpers entry individually with the stable cert first (--options runtime for Mach-O), then sign the outer .app.
# Done this way, the Authority of the screenshare binaries (screen·rp-screencap·rp-input-inject) is baked in with the stable cert
# so the Screen Recording grant survives .app updates (designated requirement = cert leaf).
# The shell script (approve-router.sh) must also be signed individually so that --verify --strict passes after the outer non-deep signing.
for bin in "$HELP"/*; do
  [ -f "$bin" ] || continue
  if file -b "$bin" | grep -q 'Mach-O'; then
    codesign -s "$SIGN_ID" --force --options runtime --timestamp=none "$bin" \
      || { echo "✗ Helpers individual signing failed (Mach-O): $bin" >&2; exit 1; }
  else
    # non-Mach-O (shell script): a hardened runtime is meaningless → a plain signature is enough to satisfy the nested seal.
    codesign -s "$SIGN_ID" --force --timestamp=none "$bin" \
      || { echo "✗ Helpers individual signing failed (script): $bin" >&2; exit 1; }
  fi
done
codesign -s "$SIGN_ID" --force "$APP"
echo "built + signed (inside-out): $APP (v$VERSION, $BUNDLE_PREFIX)"
codesign -dv "$APP" 2>&1 | grep -iE 'Authority|^Identifier' || true
# Check the Authority of the screenshare binaries (AC2): it must be the stable cert for the grant to survive. If ad-hoc ('-'), report only (the build still passes).
for b in screen rp-screencap rp-input-inject; do
  echo "  helper $b: $(codesign -dvv "$HELP/$b" 2>&1 | grep -i 'Authority=' | head -1 || echo 'unsigned?')"
done
codesign --verify --strict "$APP" && echo "verify OK ✓"

# ── --deploy: rsync to the remote, then install.sh --role host (reuse the reversible manifest install) ──
if [ "${1:-}" = "--deploy" ]; then
  HOST="${2:-$DEPLOY_HOST}"
  echo ""
  echo "=== deploy → $HOST (rsync repo + install.sh --role host) ==="
  ssh "$HOST" 'mkdir -p ~/.local/share/xpair'
  rsync -az --delete --exclude '.git' --exclude '.omc' ./ "$HOST:~/.local/share/xpair/"
  ssh "$HOST" 'cd ~/.local/share/xpair && ./shared/install.sh --role host'
  echo ""
  echo "※ For a new bundle id ($BUNDLE_PREFIX), re-grant once: System Settings → Accessibility / Screen Recording → $APP_NAME ON"
fi

# ── --release: signed-app zip → GitHub Releases (+ Homebrew Cask bump) ──
if [ "${1:-}" = "--release" ]; then
  command -v gh >/dev/null || { echo "✗ gh CLI required (brew install gh)"; exit 1; }
  # Guard: no ad-hoc signed releases. The TCC (AX·SR) grant is bound to the designated requirement (= cert leaf), but
  #   ad-hoc has only a cdhash, so every install site would re-toggle permissions on each update → never ship it in a distribution build.
  # NOTE: the canonical release path is 'tag push → CI(release.yml)', signed with the stable p12 from the repo secret (leaf 898E32).
  #   Use this manual path only on a machine that holds the same cert as that secret. Releasing manually with a different cert (e.g. the client's 33849F)
  #   splits the signing identity and breaks the grant on existing install sites.
  [ "$SIGN_ID" = "-" ] && { echo "✗ release refused: ad-hoc signing. Release only on a machine with the stable cert '$SIGN_CN' (./host/make-signing-cert.sh)"; exit 1; }
  ZIP="build/${APP_NAME}-${VERSION}.zip"
  echo "=== release: $ZIP → gh release create v$VERSION ($GH_REPO) ==="
  ( cd build && /usr/bin/ditto -c -k --sequesterRsrc --keepParent "${APP_NAME}.app" "$(basename "$ZIP")" )
  codesign --verify --strict "$APP"
  gh release create "v$VERSION" "$ZIP" --repo "$GH_REPO" --title "v$VERSION" --generate-notes \
    || gh release upload "v$VERSION" "$ZIP" --repo "$GH_REPO" --clobber
  echo "released v$VERSION ✓"

  # Homebrew Cask auto-bump: update version + sha256 against the zip just uploaded (SSOT = the release artifact).
  CASK="Casks/xpair-host.rb"
  if [ -f "$CASK" ]; then
    SHA=$(shasum -a 256 "$ZIP" | awk '{print $1}')
    /usr/bin/sed -i '' -E "s/^  version \".*\"/  version \"${VERSION}\"/" "$CASK"
    /usr/bin/sed -i '' -E "s/^  sha256 \".*\"/  sha256 \"${SHA}\"/" "$CASK"
    echo "cask bumped: $CASK → v$VERSION sha256=${SHA:0:12}…  (reflected in the tap after commit)"
  else
    echo "⚠ $CASK missing — skipping cask bump"
  fi
fi
