#!/bin/bash
# build-mosh.sh — build a self-contained STATIC mosh-server → ~/.local/bin/mosh-server
#
# Why: the host receives XpairHost.app over SCP (xpair install-host), so it may have ZERO Homebrew.
# The client attaches with `mosh --server=<host>:~/.local/bin/mosh-server` (resilient UDP reconnect),
# which means the HOST needs a mosh-server but cannot rely on `brew install mosh`. So we ship a
# mosh-server inside the .app bundle (like tmux-aqua + cliclick) — but mosh links protobuf, and
# Homebrew's protobuf 35 drags in ~78 abseil dylibs. Bundling that dynamically is untenable.
# Fix: build mosh-server STATIC against protobuf 3.21.12 — the last protobuf release BEFORE the
# abseil dependency (abseil landed in protobuf 22.0). 3.21.12 is self-contained, so a static
# libprotobuf.a links cleanly with zero non-system dylib deps. ncurses comes from macOS /usr/lib.
#
# Usage: ./build-mosh.sh   (run on the maintainer M1; needs Xcode CLT + cmake. The HOST never builds.)
#   STATIC=1 (default): static libprotobuf.a + system ncurses → 0 brew dylib deps (for .app embedding).
#   STATIC=0           : link the existing Homebrew protobuf dynamically (dev only; requires brew).
set -euo pipefail

MOSH_VER=1.4.0
PB_VER=3.21.12           # last protobuf C++ release WITHOUT the abseil dependency (abseil arrived in 22.0)
PB_TAG=21.12             # its GitHub release tag (protobuf's main-version scheme: v21.12 ships cpp 3.21.12)
BUILD=/tmp/mosh-static-build
DEST="$HOME/.local/bin/mosh-server"
STATIC="${STATIC:-1}"

command -v cmake >/dev/null || { echo "✗ cmake required (brew install cmake) — maintainer build host only"; exit 1; }
command -v make  >/dev/null || { echo "✗ make required (xcode-select --install)"; exit 1; }

mkdir -p "$BUILD"

# ── 1. protobuf 3.21.12 → static libprotobuf.a + protoc (no abseil) ──
PB_PREFIX="$BUILD/protobuf-$PB_VER-static"
if [ "$STATIC" = 1 ] && [ ! -f "$PB_PREFIX/lib/libprotobuf.a" ]; then
  echo "=== build protobuf $PB_VER (static, no-abseil) ==="
  ( cd "$BUILD"
    [ -f "protobuf-cpp-$PB_VER.tar.gz" ] || curl -fsSL -o "protobuf-cpp-$PB_VER.tar.gz" \
      "https://github.com/protocolbuffers/protobuf/releases/download/v$PB_TAG/protobuf-cpp-$PB_VER.tar.gz"
    rm -rf "protobuf-$PB_VER" && tar xzf "protobuf-cpp-$PB_VER.tar.gz"
    cd "protobuf-$PB_VER"
    cmake -S . -B build-static \
      -DCMAKE_BUILD_TYPE=Release \
      -Dprotobuf_BUILD_SHARED_LIBS=OFF \
      -Dprotobuf_BUILD_TESTS=OFF \
      -Dprotobuf_BUILD_PROTOC_BINARIES=ON \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
      -DCMAKE_INSTALL_PREFIX="$PB_PREFIX" >/dev/null
    cmake --build build-static -j"$(sysctl -n hw.ncpu)" >/dev/null
    cmake --install build-static >/dev/null )
  [ -f "$PB_PREFIX/lib/libprotobuf.a" ] || { echo "✗ protobuf static build failed (no libprotobuf.a)"; exit 1; }
  echo "  protobuf static: $PB_PREFIX/lib/libprotobuf.a"
fi

# ── 2. mosh 1.4.0 → mosh-server (+ mosh-client) ──
echo "=== build mosh $MOSH_VER (STATIC=$STATIC) ==="
( cd "$BUILD"
  [ -f "mosh-$MOSH_VER.tar.gz" ] || curl -fsSL -o "mosh-$MOSH_VER.tar.gz" \
    "https://github.com/mobile-shell/mosh/releases/download/mosh-$MOSH_VER/mosh-$MOSH_VER.tar.gz"
  rm -rf "mosh-$MOSH_VER" && tar xzf "mosh-$MOSH_VER.tar.gz"
  cd "mosh-$MOSH_VER"

  if [ "$STATIC" = 1 ]; then
    # mosh's configure.ac uses PKG_CHECK_MODULES([protobuf]) — its override vars are LOWERCASE
    # (protobuf_CFLAGS / protobuf_LIBS). Setting those makes autoconf skip pkg-config entirely, so it
    # links our static libprotobuf.a instead of the Cellar protobuf 35 (+abseil). protobuf needs zlib
    # (-lz, from macOS /usr/lib). PROTOC + matching headers must come from the SAME static prefix or the
    # generated .pb.h version-checks against mismatched headers. PKG_CONFIG_PATH is cleared so a stray
    # brew .pc can't leak back in. ncurses/setupterm resolves against macOS /usr/lib (system).
    PROTOC="$PB_PREFIX/bin/protoc" \
    protobuf_CFLAGS="-I$PB_PREFIX/include" \
    protobuf_LIBS="$PB_PREFIX/lib/libprotobuf.a -lz" \
    TINFO_LIBS="-lncurses" \
    PKG_CONFIG_PATH="" \
    ./configure --disable-silent-rules >/dev/null
  else
    # dev path: dynamic Homebrew protobuf (requires brew).
    PB="$(brew --prefix protobuf 2>/dev/null || echo /opt/homebrew)"
    PKG_CONFIG_PATH="$PB/lib/pkgconfig:${PKG_CONFIG_PATH:-}" ./configure --disable-silent-rules >/dev/null
  fi
  make -j"$(sysctl -n hw.ncpu)" >/dev/null )

SRV="$BUILD/mosh-$MOSH_VER/src/frontend/mosh-server"
CLI="$BUILD/mosh-$MOSH_VER/src/frontend/mosh-client"   # same `make` builds it (host uses server, client uses client)
WRAP="$BUILD/mosh-$MOSH_VER/scripts/mosh"              # perl wrapper (execs mosh-client via PATH; accepts --client=PATH)
[ -x "$SRV" ]  || { echo "✗ mosh-server not built ($SRV)"; exit 1; }
[ -x "$CLI" ]  || { echo "✗ mosh-client not built ($CLI)"; exit 1; }
[ -f "$WRAP" ] || { echo "✗ mosh wrapper not built ($WRAP)"; exit 1; }

BINDIR="$(dirname "$DEST")"                            # ~/.local/bin
mkdir -p "$BINDIR"
cp "$SRV"  "$BINDIR/mosh-server" && chmod 755 "$BINDIR/mosh-server"
cp "$CLI"  "$BINDIR/mosh-client" && chmod 755 "$BINDIR/mosh-client"
cp "$WRAP" "$BINDIR/mosh"        && chmod 755 "$BINDIR/mosh"
echo "installed: $BINDIR/mosh-server ($("$BINDIR/mosh-server" --version 2>&1 | head -1 || echo '?'))"
echo "installed: $BINDIR/mosh-client + $BINDIR/mosh (perl wrapper)"

# ── 3. self-containment assertion (no brew dylib = embeddable) ──
# Check both Mach-O binaries (server + client). The `mosh` wrapper is a perl script → no dylib deps.
echo "=== dynamic dependency check (no brew dylib = self-contained) ==="
_brewfree=1
for _b in "$BINDIR/mosh-server" "$BINDIR/mosh-client"; do
  if otool -L "$_b" | tail -n +2 | grep -q "/opt/homebrew"; then
    echo "⚠ brew dylib links remain in $_b:"; otool -L "$_b" | grep "/opt/homebrew"; _brewfree=0
  fi
done
if [ "$_brewfree" = 1 ]; then
  echo "✓ 0 brew dylib dependencies — self-contained (ready to embed in Xpair apps)"
elif [ "$STATIC" = 1 ]; then
  echo "✗ STATIC=1 must be self-contained — failing"; exit 1
fi
