#!/usr/bin/env bash
# t_24_win32_ide_build - Windows IDE package contract (P5).
cd "$(dirname "$0")"; . ./lib.sh

BUILD="$_REPO_ROOT/client/ide/build.sh"
WORKFLOW="$_REPO_ROOT/.github/workflows/win32-ide-build.yml"
RELEASE="$_REPO_ROOT/.github/workflows/release.yml"
README="$_REPO_ROOT/client/ide/README.md"

it "build/win32-gated-on-output"
assert_contains "$(cat "$BUILD")" 'WIN32_OUTPUTS=()' "build.sh tracks win32 outputs moved by the current build"
assert_contains "$(cat "$BUILD")" 'VSCode-win32-*) WIN32_OUTPUTS+=' "win32 post-gulp pass is gated on freshly moved win32 output"
assert_contains "$(cat "$BUILD")" 'for app in "${WIN32_OUTPUTS[@]}"; do' "win32 package pass does not scan stale dist directories"

it "build/win32-bundles-native-cli"
assert_contains "$(cat "$BUILD")" 'XPAIR_CLI_EXE' "build.sh documents and reads XPAIR_CLI_EXE"
assert_contains "$(cat "$BUILD")" 'resources/app/bin/xpair.exe' "build.sh bundles native xpair.exe into the app resources bin dir"

it "build/win32-zips-with-powershell"
assert_contains "$(cat "$BUILD")" 'Compress-Archive' "win32 zip uses PowerShell Compress-Archive"
assert_contains "$(cat "$BUILD")" 'Xpair-${_app_name#VSCode-}-${RP_BUILD_VER}.zip' "win32 zip artifact includes platform, arch, and build marker"

it "workflow/self-hosted-windows"
assert_contains "$(cat "$WORKFLOW")" 'runs-on: [self-hosted, Windows, X64, Win11]' "win32 IDE build uses the validated self-hosted Win11 runner"
assert_contains "$(cat "$WORKFLOW")" 'workflow_dispatch:' "win32 IDE build can be run manually"
assert_contains "$(cat "$WORKFLOW")" 'schedule:' "win32 IDE build runs on a schedule"

it "workflow/cli-rs-guard"
assert_contains "$(cat "$WORKFLOW")" 'if [ -d client/cli-rs ]; then' "workflow only builds the Rust CLI when client/cli-rs exists"
assert_contains "$(cat "$WORKFLOW")" 'win32 IDE zip will be built without bundled xpair.exe' "workflow loudly notices the pre-cli-rs skip path"
assert_contains "$(cat "$WORKFLOW")" 'echo "XPAIR_CLI_EXE=$exe" >> "$GITHUB_ENV"' "workflow passes cargo output to build.sh"

it "workflow/uploads-zip"
assert_contains "$(cat "$WORKFLOW")" 'client/ide/dist/Xpair-win32-*.zip' "workflow verifies and uploads the win32 IDE zip"
assert_contains "$(cat "$WORKFLOW")" 'actions/upload-artifact@v4' "workflow uploads the produced zip artifact"

it "release/opt-in-flag-default-off"
assert_contains "$(cat "$RELEASE")" 'include_win32_ide:' "release workflow exposes a win32 IDE opt-in skeleton"
assert_contains "$(cat "$RELEASE")" 'default: false' "win32 release wiring defaults off"

it "docs/win32-build-inputs"
assert_contains "$(cat "$README")" 'XPAIR_CLI_EXE=/c/path/to/xpair.exe ./build.sh' "README documents the Windows CLI input"
assert_contains "$(cat "$README")" 'Compress-Archive' "README documents the PowerShell packaging requirement"

finish
