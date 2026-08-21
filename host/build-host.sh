#!/bin/bash
# build-host.sh — RemotePairHost.app 빌드 (메뉴바 호스트: tmux host + approve + 세션관리 + 업데이터)
#
# 책임별 .swift 를 한 번에 컴파일(패키지 의존 0). helpers(tmux-aqua·router·ocr-find) 를 번들에 동봉.
# 서명: 안정 self-signed cert "RemotePair Local Signing" → TCC grant 가 designated requirement 에
#   묶여 재빌드/업데이트에도 유지. cert 없으면 ad-hoc 폴백(재빌드마다 재토글). 생성: ./make-signing-cert.sh
#
# 사용:
#   ./build-host.sh                 # build/RemotePairHost.app 빌드+서명+검증
#   ./build-host.sh --deploy [host] # 위 + rsync → 원격(기본 REMOTE_HOST 또는 gh-mac-m1) → install.sh --role host
#   ./build-host.sh --release       # 위 + 서명앱 zip → gh release create v<버전>
set -euo pipefail
cd "$(dirname "$0")/.."                       # repo 루트
. shared/config.sh                            # SSOT: APP_NAME·BUNDLE_PREFIX·SIGN_CN·GH_REPO

VERSION="${RP_VERSION:-0.4.14}"                # 버전 단일 출처(Info.plist 로 박힘). 릴리스 태그 = v$VERSION. (pre-1.0, 패치 +0.0.1)
SRC_DIR=host/RemotePairHost
APP="build/${APP_NAME}.app"
EXEC="$APP_NAME"
DEPLOY_HOST="${REMOTE_HOST:-gh-mac-m1}"

# ── 서명 정체성 ──
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_CN"; then
  SIGN_ID="$SIGN_CN"; echo "서명: 안정 cert '$SIGN_CN' (재빌드/업데이트에도 grant 유지)"
else
  SIGN_ID="-"; echo "⚠ 서명: ad-hoc (cert '$SIGN_CN' 없음 → 재빌드마다 재토글). ./host/make-signing-cert.sh 권장"
fi

# ── SDK 선택 (CLT+신SDK 조합이 깨질 때 14.x 폴백) ──
compile() { # $1=out
  local out="$1" sdk
  # 1) 기본 툴체인 시도
  if xcrun swiftc -O "$SRC_DIR"/*.swift -o "$out" 2>/tmp/rp-swiftc.err; then return 0; fi
  # 2) 폴백: 호환 SDK 탐색 (Swift 5.10 CLT + MacOSX15 swiftinterface 불일치 회피)
  for sdk in /Library/Developer/CommandLineTools/SDKs/MacOSX14.5.sdk \
             /Library/Developer/CommandLineTools/SDKs/MacOSX14.sdk \
             /Library/Developer/CommandLineTools/SDKs/MacOSX13.3.sdk; do
    [ -d "$sdk" ] || continue
    echo "  (기본 컴파일 실패 → SDK 폴백: $(basename "$sdk"))"
    if xcrun swiftc -O -sdk "$sdk" -target arm64-apple-macos13.0 "$SRC_DIR"/*.swift -o "$out" 2>/tmp/rp-swiftc.err; then return 0; fi
  done
  echo "✗ Swift 컴파일 실패:"; cat /tmp/rp-swiftc.err >&2; return 1
}

echo "=== compile (Swift, multi-file) ==="
mkdir -p build
compile "build/$EXEC"
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
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleIconName</key><string>AppIcon</string>
</dict></plist>
P

echo "=== embed helpers → Contents/Helpers ==="
HELP="$APP/Contents/Helpers"; mkdir -p "$HELP"
cp host/remote-pair-approve-router.sh "$HELP/"; chmod +x "$HELP/remote-pair-approve-router.sh"
cp host/ocr-find "$HELP/"; chmod +x "$HELP/ocr-find"
# cliclick = 앱의 click/key primitive 주입기. 번들에 동봉(자기완결). 없으면 런타임에 homebrew 경로 폴백.
if [ -x /opt/homebrew/bin/cliclick ]; then cp /opt/homebrew/bin/cliclick "$HELP/cliclick"; chmod +x "$HELP/cliclick"; echo "  embedded: cliclick"; fi
# tmux-aqua 는 호스트의 심장(keeper 서버 = 모든 세션의 부모). cask 는 .app 만 설치하므로
# 런타임 ~/.local/bin 폴백이 존재하지 않는다 → 번들에 없으면 호스트가 죽은 채로 배포됨(세션 0).
# 따라서 "없으면 경고하고 통과"가 아니라: 없으면 빌드 시도 → 그래도 없으면 HARD-FAIL.
if [ ! -x "$HOME/.local/bin/tmux-aqua" ]; then
  echo "  tmux-aqua 없음(~/.local/bin) → ./host/build-tmux-aqua.sh 자동 실행 ..."
  ./host/build-tmux-aqua.sh || { echo "✗ tmux-aqua 빌드 실패 — 수동으로 ./host/build-tmux-aqua.sh 실행 후 재시도" >&2; exit 1; }
fi
[ -x "$HOME/.local/bin/tmux-aqua" ] || { echo "✗ tmux-aqua 여전히 없음 — 번들 불가(헬퍼 없으면 cask 호스트 전멸: 세션 0)" >&2; exit 1; }
cp "$HOME/.local/bin/tmux-aqua" "$HELP/tmux-aqua"; chmod +x "$HELP/tmux-aqua"
# 번들에 실제로 들어갔는지 최종 검증 — 깨진 번들이 release/cask 로 새는 것을 원천 차단.
[ -x "$HELP/tmux-aqua" ] || { echo "✗ tmux-aqua 번들 임베드 검증 실패: $HELP/tmux-aqua" >&2; exit 1; }
echo "  embedded: tmux-aqua ($("$HELP/tmux-aqua" -V 2>/dev/null || echo '?')) + remote-pair-approve-router.sh + ocr-find"

RES="$APP/Contents/Resources"; mkdir -p "$RES"   # (icon 용; 아래에서 채움)
# NOTE: 결합도 낮게 — 앱 번들엔 런타임에 앱이 직접 쓰는 것(Helpers: tmux-aqua·router·ocr-find)만 둔다.
#   skills(claude 하네스) · rules.txt(approve 설정) · CLI 는 동봉/자기설치하지 않는다.
#   그건 CLI/README 단일설치(shared/install.sh)가 담당한다.

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

codesign -s "$SIGN_ID" --force --deep "$APP"
echo "built + signed: $APP (v$VERSION, $BUNDLE_PREFIX)"
codesign -dv "$APP" 2>&1 | grep -iE 'Authority|^Identifier' || true
codesign --verify --strict "$APP" && echo "verify OK ✓"

# ── --deploy: 원격에 rsync 후 install.sh --role host (manifest 가역 설치 재사용) ──
if [ "${1:-}" = "--deploy" ]; then
  HOST="${2:-$DEPLOY_HOST}"
  echo ""
  echo "=== deploy → $HOST (rsync repo + install.sh --role host) ==="
  ssh "$HOST" 'mkdir -p ~/.local/share/remote-pair'
  rsync -az --delete --exclude '.git' --exclude '.omc' ./ "$HOST:~/.local/share/remote-pair/"
  ssh "$HOST" 'cd ~/.local/share/remote-pair && ./shared/install.sh --role host'
  echo ""
  echo "※ 새 bundle id($BUNDLE_PREFIX)면 1회 재grant: System Settings → 손쉬운 사용 / 화면 기록 → $APP_NAME ON"
fi

# ── --release: 서명앱 zip → GitHub Releases (+ Homebrew Cask bump) ──
if [ "${1:-}" = "--release" ]; then
  command -v gh >/dev/null || { echo "✗ gh CLI 필요 (brew install gh)"; exit 1; }
  # 가드: ad-hoc 서명 릴리스 금지. TCC(AX·SR) grant 는 designated requirement(= cert leaf)에 묶이는데,
  #   ad-hoc 은 cdhash 뿐이라 업데이트마다 모든 설치처가 권한 재토글 → 배포본으로 절대 내보내지 않는다.
  # NOTE: 캐노니컬 릴리스 경로는 'tag push → CI(release.yml)' 이며 repo 시크릿의 안정 p12(leaf 898E32)로 서명.
  #   이 수동 경로는 그 시크릿과 같은 cert 를 가진 머신에서만 쓸 것. 다른 cert(예: 클라이언트 33849F)로
  #   수동 릴리스하면 서명 정체성이 갈려 기존 설치처 grant 가 깨진다.
  [ "$SIGN_ID" = "-" ] && { echo "✗ release 거부: ad-hoc 서명. 안정 cert '$SIGN_CN' 있는 머신에서만 릴리스(./host/make-signing-cert.sh)"; exit 1; }
  ZIP="build/${APP_NAME}-${VERSION}.zip"
  echo "=== release: $ZIP → gh release create v$VERSION ($GH_REPO) ==="
  ( cd build && /usr/bin/ditto -c -k --sequesterRsrc --keepParent "${APP_NAME}.app" "$(basename "$ZIP")" )
  codesign --verify --strict "$APP"
  gh release create "v$VERSION" "$ZIP" --repo "$GH_REPO" --title "v$VERSION" --generate-notes --prerelease --latest=false \
    || gh release upload "v$VERSION" "$ZIP" --repo "$GH_REPO" --clobber
  echo "released v$VERSION ✓"

  # Homebrew Cask 자동 bump: version + sha256 를 방금 올린 zip 기준으로 갱신(SSOT = 릴리스 산출물).
  CASK="Casks/remote-pair-host.rb"
  if [ -f "$CASK" ]; then
    SHA=$(shasum -a 256 "$ZIP" | awk '{print $1}')
    /usr/bin/sed -i '' -E "s/^  version \".*\"/  version \"${VERSION}\"/" "$CASK"
    /usr/bin/sed -i '' -E "s/^  sha256 \".*\"/  sha256 \"${SHA}\"/" "$CASK"
    echo "cask bumped: $CASK → v$VERSION sha256=${SHA:0:12}…  (커밋 후 tap 반영)"
  else
    echo "⚠ $CASK 없음 — cask bump 건너뜀"
  fi
fi
