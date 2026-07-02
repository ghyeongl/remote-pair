#!/usr/bin/env bash
# t_18_client_mosh — brew-free client mosh wiring (static bundle, no `brew install mosh`).
cd "$(dirname "$0")"; . ./lib.sh

INSTALL="$_REPO_ROOT/shared/install.sh"
XPAIR="$_REPO_ROOT/client/cli/xpair"
BUILD="$_REPO_ROOT/client/ide/build.sh"
MOSH_BUILD="$_REPO_ROOT/host/build-mosh.sh"

it "install/no-brew-install-mosh"
assert_absent "$(cat "$INSTALL")" "brew install mosh" "install.sh no longer runs brew install mosh"

it "install/copies-bundled-mosh"
assert_contains "$(cat "$INSTALL")" '$CLIENT_DIR/bin/mosh-client' "install.sh installs the bundled static mosh-client"

it "xpair/attach-passes-client-flag"
assert_contains "$(cat "$XPAIR")" "--client=" "attach passes --client so the wrapper uses our mosh-client"

it "build/bundles-mosh"
assert_contains "$(cat "$BUILD")" 'client/cli/bin/mosh-client' "client build bundles mosh-client into the CLI tree"

it "build-mosh/emits-client"
assert_contains "$(cat "$MOSH_BUILD")" "mosh-client" "build-mosh.sh emits mosh-client"

# ── hardening guards (Codex review) ──
it "install/prefers-existing-mosh"
# command -v mosh is checked BEFORE installing the bundle → never overwrites/rm a user-owned mosh
# (e.g. a Homebrew symlink). No unconditional symlink removal.
assert_contains "$(cat "$INSTALL")" 'command -v mosh >/dev/null 2>&1; then' "install.sh respects an existing mosh before installing the bundle"
assert_absent  "$(cat "$INSTALL")" 'rm -f "$_l"' "install.sh does not rm a user's mosh symlink"

it "attach/conditional-client-when-present"
assert_contains "$(cat "$XPAIR")" '[ -x "$_mc" ] && _clientarg=(--client=' "attach pins --client only when the bundled mosh-client exists"

it "attach/client-uses-local-bin"
assert_contains "$(cat "$XPAIR")" '${MOSH_CLIENT:-$LOCAL_BIN/mosh-client}' "attach probes LOCAL_BIN (matches where install.sh writes it), not a hardcoded ~/.local/bin"

it "build-mosh/validates-before-install"
# the system-only check runs over the BUILD outputs ($SRV/$CLI) before cp to ~/.local/bin
assert_contains "$(cat "$MOSH_BUILD")" 'for _b in "$SRV" "$CLI"; do' "build-mosh validates the built binaries before publishing them"

it "build/checks-arm64-arch"
assert_contains "$(cat "$BUILD")" 'lipo -archs' "client build verifies the bundled mosh-client is arm64"

it "build/rejects-non-system-dylibs"
assert_contains "$(cat "$BUILD")" "grep -vE '^/(usr/lib|System)/'" "client build rejects any non-system (incl. Intel-brew /usr/local) dylib"

it "build-mosh/rejects-non-system-dylibs"
assert_contains "$(cat "$MOSH_BUILD")" "grep -vE '^/(usr/lib|System)/'" "build-mosh checks system-only dylibs, not just /opt/homebrew"

finish
