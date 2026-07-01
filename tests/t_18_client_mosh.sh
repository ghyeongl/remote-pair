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

finish
