#!/usr/bin/env bash
# Xpair IDE build — thin wrapper over the pristine VSCodium recipe in vendor/vscodium/.
#
# Vendor separation (Option C): vendor/vscodium/ is PRISTINE VSCodium (git subtree from
# github.com/VSCodium/vscodium). Everything Xpair owns lives in remotepair/.
# This wrapper injects the Xpair artifacts into the pristine recipe at build time
# (trap-cleaned so vendor stays byte-pristine for the next `git subtree pull`), then runs
# the Xpair build orchestrator with CWD = the recipe root.
#
# Usage:  ./build.sh [dev-build flags]      (e.g. -p assets, -o skip-build, -s skip-source)
set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor/vscodium"
RP="$HERE/remotepair"

# ── toolchain pin ──────────────────────────────────────────────────────────────
# The vendored VSCodium recipe's `npm ci` is strict about lockfile/engine: it needs the
# Node in .nvmrc (a newer Node makes npm ci report "lock file out of sync"). And the CLI
# (`code`) build needs cargo. The default shell often has neither, so pin both here instead
# of silently building under the wrong Node and failing deep in the recipe.
_want_node="$(cat "$HERE/.nvmrc" 2>/dev/null | tr -d '[:space:]')"
if [ -n "$_want_node" ] && [ "$(node -v 2>/dev/null)" != "v$_want_node" ]; then
  if [ -x "$HOME/.nvm/versions/node/v$_want_node/bin/node" ]; then
    export PATH="$HOME/.nvm/versions/node/v$_want_node/bin:$PATH"
  elif command -v nvm >/dev/null 2>&1; then
    # shellcheck disable=SC1090
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" 2>/dev/null && nvm use "$_want_node" >/dev/null
  else
    echo "✗ Node v$_want_node required (.nvmrc) but active is $(node -v 2>/dev/null). Install: nvm install $_want_node" >&2
    exit 1
  fi
fi
# cargo (Rust) for the CLI build — rustup is usually on PATH but ~/.cargo/bin often is not.
[ -x "$HOME/.cargo/bin/cargo" ] && case ":$PATH:" in *":$HOME/.cargo/bin:"*) ;; *) export PATH="$HOME/.cargo/bin:$PATH";; esac
command -v cargo >/dev/null 2>&1 || { echo "✗ cargo not found — install Rust (https://rustup.rs) for the CLI build" >&2; exit 1; }
echo "→ toolchain: node $(node -v) · $(cargo --version 2>/dev/null | head -1)"

[ -d "$VENDOR" ] || {
  echo "vendor/vscodium/ missing — populate it first:" >&2
  echo "  git subtree add --prefix=client/ide/vendor/vscodium vscodium <tag> --squash" >&2
  exit 1
}

INJECTED_PATCH="$VENDOR/patches/zz-remotepair-ide-frontend.patch"
INJECTED_PATCH_MAIN="$VENDOR/patches/zz-remotepair-ide-electron-main.patch"
INJECTED_PATCH_MAIN2="$VENDOR/patches/zz-remotepair-ide-electron-main2.patch"
PRODUCT_BAK="$VENDOR/product.json.rp-orig"
# Builtin extension inject target. The vscode source lives at $VENDOR/vscode/ and the gulp recipe
# auto-discovers every dir under extensions/ via glob.sync('extensions/*/package.json') — so a dir
# dropped here becomes a builtin with NO product.json wiring. Basename MUST stay 'remotepair' so the
# US-B onboarding hook (app.ts: builtinExtensionsPath/['x10lab.remotepair','remotepair']) resolves.
INJECTED_EXT="$VENDOR/vscode/extensions/remotepair"

# Auto-incrementing dev build marker so each rebuild is visibly distinct in About (stale vs fresh
# is then unambiguous). Bumped once per build; stamped into the packaged product.json below
# (before re-sign). Override with RP_BUILD_VER=…; bump RP_BUILD_BASE when cutting a real release.
RP_BUILD_BASE="${RP_BUILD_BASE:-0.5.0a}"
# LOCKSTEP with the host build: both read+bump the SAME shared counter (repo shared/.build-counter)
# so the project has a single monotonic 0.5.0aN sequence across host + client.
COUNTER_FILE="$HERE/../../shared/.build-counter"
_n=$(( $(cat "$COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$_n" > "$COUNTER_FILE"
RP_BUILD_VER="${RP_BUILD_VER:-${RP_BUILD_BASE}${_n}}"
echo "→ Xpair build marker: $RP_BUILD_VER  (About → version; counter: $COUNTER_FILE)"

cleanup() {
  # restore pristine vendor (so `git subtree pull` stays conflict-free)
  rm -f "$INJECTED_PATCH"
  rm -f "$INJECTED_PATCH_MAIN"
  rm -f "$INJECTED_PATCH_MAIN2"
  rm -rf "$INJECTED_EXT"
  [ -f "$PRODUCT_BAK" ] && mv -f "$PRODUCT_BAK" "$VENDOR/product.json"
  rm -f "$VENDOR/dev/build.env"
}
trap cleanup EXIT INT TERM

# 1) inject the Xpair patches — prepare_vscode.sh applies ../patches/*.patch (glob, name-sorted);
#    zz- sorts last so they land after all stock + Xpair-needed patches. The frontend patch is
#    workbench(renderer)-only; the electron-main patch is the single-app onboarding hook in
#    src/vs/code/electron-main/app.ts (US-B). They touch disjoint files, so order between them is moot.
cp "$RP/patches/zz-remotepair-ide-frontend.patch" "$INJECTED_PATCH"
cp "$RP/patches/zz-remotepair-ide-electron-main.patch" "$INJECTED_PATCH_MAIN"
#    main2 = local-identity safeStorage fix: forces --password-store=basic for nameShort ending in
#    'Local' (src/main.ts), so the self-signed local build stops re-prompting for Keychain access.
#    Prod/CI (nameShort != *Local) keep the Keychain. Disjoint file (src/main.ts) from the others.
cp "$RP/patches/zz-remotepair-ide-electron-main2.patch" "$INJECTED_PATCH_MAIN2"

# 1b) The Xpair VS Code extension is injected as a BUILTIN (vscode/extensions/remotepair) INSIDE
#     dev-build.sh — AFTER source prep, right before gulp. It CANNOT be copied here: dev-build.sh wipes
#     vscode/ on SKIP_SOURCE=no (`rm -rf vscode*` + re-clone) and resets it on SKIP_SOURCE=yes
#     (`git add . && git reset --hard HEAD`), either of which would delete a pre-build copy. gulp
#     glob-discovers extensions/*/package.json → ships it as builtin 'remotepair' (matches US-B probe).
#     The cleanup trap above still rm -rf's $INJECTED_EXT so vendor ends byte-pristine.

# 2) inject the branding overlay — prepare_vscode.sh:128 merges the in-vscode/ stock product.json
#    with ../product.json (= vendor/vscodium/product.json), our overlay winning on key conflicts.
#    Stash pristine first; the trap restores it after the build.
cp "$VENDOR/product.json" "$PRODUCT_BAK"
cp "$RP/product.overlay.json" "$VENDOR/product.json"

# 2b) Local-identity isolation. Local/dev builds get a DISTINCT product identity so they live in
#     their own single-instance lock domain. The macOS lock lives at
#     ~/Library/Application Support/<nameShort> (see vscode environmentService.ts → getUserDataPath
#     uses product.nameShort), so a stale local/dev instance sharing nameShort otherwise squats the
#     lock and a NEW launch (e.g. the production cask app) silently hands off to it and exits
#     ("the app won't launch"). Suffixing the identity for local builds prevents that collision.
#     CI keeps the production identity. Override with RP_LOCAL_IDENTITY=0 to build the prod identity locally.
RP_LOCAL_IDENTITY="${RP_LOCAL_IDENTITY:-$([ -z "$GITHUB_ACTIONS" ] && echo 1 || echo 0)}"
if [ "$RP_LOCAL_IDENTITY" = "1" ]; then
  echo "→ local-identity build: XpairLocal (isolated lock domain; RP_LOCAL_IDENTITY=0 for prod identity)"
  _pj_tmp="$(mktemp)"
  # NOTE: the VSCodium recipe assumes nameShort == nameLong (gulp names the .app from nameLong,
  # build_cli.sh's codium-tunnel copy looks it up via nameShort) — keep them EQUAL or the CLI
  # copy fails ("No such file"). The single-instance lock is keyed on nameShort (getUserDataPath),
  # so changing nameShort (= nameLong here) is what isolates the lock domain.
  jq '.nameShort = "XpairLocal"
    | .nameLong = "XpairLocal"
    | .applicationName = "xpair-local"
    | .dataFolderName = ".xpair/client-local"
    | .darwinBundleIdentifier = "com.x10lab.xpair-local"
    | .win32MutexName = "xpairlocal"
    | .win32AppUserModelId = "x10lab.XpairLocal"
    | .win32DirName = "XpairLocal"' \
    "$VENDOR/product.json" > "$_pj_tmp" && mv "$_pj_tmp" "$VENDOR/product.json"
fi

# 3) run the Xpair orchestrator (pristine VSCodium dev/build.sh + Xpair identity)
#    with CWD = recipe root so its relative sources (get_repo.sh, build.sh, …) resolve into vendor.
( cd "$VENDOR" && bash "$RP/dev-build.sh" "$@" )

# 4) relocate the packaged app out of vendor into a clean dist/. The gulp recipe hardcodes its
#    output to ../VSCode-<os>-<arch>/ (= inside vendor/vscodium/); move it so vendor stays
#    artifact-free and the deliverable lives at a predictable client/ide/dist/ path.
shopt -s nullglob
for out in "$VENDOR"/VSCode-darwin-*/ "$VENDOR"/VSCode-linux-*/ "$VENDOR"/VSCode-win32-*/; do
  mkdir -p "$HERE/dist"
  rm -rf "$HERE/dist/$(basename "$out")"
  mv "$out" "$HERE/dist/"
  echo "→ build output: client/ide/dist/$(basename "$out")"
done
shopt -u nullglob

# 4.5) stamp the auto-incrementing build marker into the packaged product.json (BEFORE re-sign, so
#      the signature covers it). Shows in About → version, making stale-vs-fresh unambiguous.
shopt -s nullglob
for pj in "$HERE"/dist/VSCode-darwin-*/*.app/Contents/Resources/app/product.json \
          "$HERE"/dist/VSCode-linux-*/resources/app/product.json \
          "$HERE"/dist/VSCode-win32-*/resources/app/product.json; do
  [ -f "$pj" ] || continue
  _t="$(mktemp)"
  # Stamp ONLY remotePairBuild — do NOT clobber .version: VSCode's version must stay valid semver
  # (its update compareBuild() throws on '0.5.0a8') AND keep the 1.x major so extensions'
  # engines.vscode (^1.x) stay compatible. Build identity lives in the dedicated field.
  jq --arg v "$RP_BUILD_VER" '.remotePairBuild=$v' "$pj" > "$_t" && mv "$_t" "$pj"
  echo "→ stamped build marker $RP_BUILD_VER into $pj"
done
shopt -u nullglob

# 4.6) inject the Xpair app icon into the PACKAGED .app (BEFORE re-sign, so the signature covers it).
#      Why here and not in dev-build.sh: vscode/resources/darwin/code.icns is a TRACKED stock file, so
#      the `git reset --hard` in build.sh's source-prep reverts any pre-gulp overwrite (the builtin ext
#      survives only because it's an untracked NEW dir). Patching the final packaged icon is reset-proof.
shopt -s nullglob
for app in "$HERE"/dist/VSCode-darwin-*/*.app; do
  _icon="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$app/Contents/Info.plist" 2>/dev/null)"
  _icon="${_icon%.icns}.icns"
  if [ -n "$_icon" ] && [ -f "$RP/assets/icon/code.icns" ]; then
    cp "$RP/assets/icon/code.icns" "$app/Contents/Resources/$_icon"
    echo "→ injected Xpair app icon → $(basename "$app")/Contents/Resources/$_icon"
  fi
done
shopt -u nullglob

# 4.7) bundle the Xpair client CLI INTO the packaged .app (BEFORE re-sign, so the signature covers it).
#       The IDE-embedded onboarding shells out to the `xpair` CLI; a freshly-installed app may have no
#       CLI on the machine yet, so the onboarding bridge auto-installs it from this bundled copy
#       (installCli() → cli/shared/install.sh --role client). We ship a minimal REPO-SHAPED tree so the
#       SoT installer runs UNMODIFIED: install.sh sources config.sh/lib.sh from its own dir and derives
#       CLIENT_DIR=<repo>/client/cli — so the layout must be <cli>/shared/* + <cli>/client/cli/*.
#       Lands at <App>/Contents/Resources/app/extensions/remotepair/cli/ (== onboarding-bridge.js
#       __dirname + "/cli"; the bridge resolves install.sh there). Why here and not dev-build.sh: the
#       source-prep `git reset --hard` reverts any pre-gulp copy into vscode/ (same reason as the icon).
SHARED="$HERE/../../shared"
CLI_SRC="$HERE/../cli"
shopt -s nullglob
for app in "$HERE"/dist/VSCode-darwin-*/*.app; do
  _cli="$app/Contents/Resources/app/extensions/remotepair/cli"
  rm -rf "$_cli"
  mkdir -p "$_cli/shared" "$_cli/client/cli"
  # install.sh + the files it sources (config.sh, lib.sh) + the client runtime helper it installs
  # (logging.sh → ~/.xpair/host/bin). install.sh is the SoT — copy it verbatim.
  for f in install.sh config.sh lib.sh logging.sh; do
    cp "$SHARED/$f" "$_cli/shared/$f"
  done
  # The client CLI scripts install.sh installs to ~/.local/bin (+ the Service + hangul-romanize helper).
  for f in xpair xpair-launch xpair-mount xpair-desktop xpair-editor xpair-askpass hangul-romanize; do
    [ -e "$CLI_SRC/$f" ] && cp "$CLI_SRC/$f" "$_cli/client/cli/$f"
  done
  cp -R "$CLI_SRC/Launch Xpair.workflow" "$_cli/client/cli/Launch Xpair.workflow"
  chmod -R u+w "$_cli"
  echo "→ bundled Xpair client CLI → $(basename "$app")/Contents/Resources/app/extensions/remotepair/cli"
  # Static mosh + mosh-client (brew-free client attach). build-mosh.sh emits both to ~/.local/bin
  # (static protobuf 3.21.12, pre-abseil → 0 brew dylib). Bundle into the repo-shaped tree so
  # `install.sh --role client` copies them to ~/.local/bin exactly like the xpair CLI. Missing/failed
  # build → skip (attach falls back to ssh); never hard-fail the IDE build.
  if [ ! -x "$HOME/.local/bin/mosh-client" ] || [ ! -x "$HOME/.local/bin/mosh" ]; then
    echo "  mosh-client/mosh missing (~/.local/bin) → auto-running ./host/build-mosh.sh ..."
    ( cd "$HERE/../.." && ./host/build-mosh.sh ) || echo "⚠ build-mosh.sh failed — bundling without mosh (attach falls back to ssh)" >&2
  fi
  if [ -x "$HOME/.local/bin/mosh-client" ] && [ -x "$HOME/.local/bin/mosh" ]; then
    mkdir -p "$_cli/client/cli/bin"
    cp "$HOME/.local/bin/mosh-client" "$_cli/client/cli/bin/mosh-client"
    cp "$HOME/.local/bin/mosh"        "$_cli/client/cli/bin/mosh"
    chmod +x "$_cli/client/cli/bin/mosh-client" "$_cli/client/cli/bin/mosh"
    if otool -L "$_cli/client/cli/bin/mosh-client" | tail -n +2 | grep -q "/opt/homebrew"; then
      echo "✗ bundled mosh-client links a /opt/homebrew dylib — not brew-free" >&2
      otool -L "$_cli/client/cli/bin/mosh-client" | grep "/opt/homebrew" >&2; exit 1
    fi
    echo "→ bundled static mosh + mosh-client → .../remotepair/cli/client/cli/bin/"
  else
    echo "  (no ~/.local/bin/mosh-client — skipping mosh bundle; client attach uses ssh fallback)"
  fi
  # Also bundle the SIGNED host app so the onboarding's `xpair install-host` (default scp mode) finds a
  # local .app to ship to the host. The installed CLI (~/.local/bin/xpair) runs install-host with
  # RP_REPO_ROOT=<this cli dir> (config.sh derives REPO_ROOT=<cli>; install.sh persists it to
  # client.env), so cmd_install_host looks for $RP_REPO_ROOT/{host/,}build/XpairHost.app. Place it at
  # <cli>/build/ — the same repo-relative path host/build-host.sh produces (<repo>/build/XpairHost.app),
  # which is cmd_install_host's SECOND lookup branch. Copy AFTER the chmod above (so it doesn't rewrite
  # the host app's perms) and BEFORE re-sign (so the IDE signature wraps it); cp -R preserves the host
  # app's own signature (host-side integrity = that signature). Local builds without a host app skip.
  _hostapp="$HERE/../../build/XpairHost.app"
  if [ -d "$_hostapp" ]; then
    mkdir -p "$_cli/build"
    cp -R "$_hostapp" "$_cli/build/XpairHost.app"
    echo "→ bundled signed XpairHost.app → $(basename "$app")/Contents/Resources/app/extensions/remotepair/cli/build/XpairHost.app"
    # install-host also scp's host GLUE to the host stage (xpair cmd_install_host:1238):
    #   scp -r $repo_root/host/{rules.txt,skills,hooks} → host:~/.cache/xpair/stage/host/
    # repo_root resolves to <cli> here, so these must live at <cli>/host/. Without them the host
    # install fails at "scp: stat local .../cli/host/rules.txt: No such file or directory".
    mkdir -p "$_cli/host"
    cp "$HERE/../../host/rules.txt" "$_cli/host/rules.txt"
    cp -R "$HERE/../../host/skills" "$_cli/host/skills"
    cp -R "$HERE/../../host/hooks" "$_cli/host/hooks"
    chmod -R u+w "$_cli/host"
    echo "→ bundled host glue (rules.txt + skills + hooks) → .../cli/host/"
  else
    echo "  (no $_hostapp — skipping host app + glue bundle; run host/build-host.sh first for a full install-host bundle)"
  fi
done
shopt -u nullglob

# 5) re-sign the macOS app so it actually launches. The gulp build emits an adhoc signature; under a
#    hardened runtime Electron's V8 JIT needs allow-jit (+ disable-library-validation for a self-signed
#    identity), and `codesign --deep` strips entitlements — so re-sign inside-out (local-sign.sh).
#    No-op when not macOS or when the signing identity is absent. Release signing is done in CI.
if [ "$(uname)" = "Darwin" ]; then
  shopt -s nullglob
  for app in "$HERE"/dist/VSCode-darwin-*/*.app; do
    bash "$RP/local-sign.sh" "$app" || echo "  (re-sign skipped/failed for $(basename "$app"))"
  done
  shopt -u nullglob
fi
