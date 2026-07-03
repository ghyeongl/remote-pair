#!/usr/bin/env bash
# t_03_session_naming — verify the launcher's deterministic session name (_readable + _proj_base)
# + compare naming-scheme equivalence against the reference (claude-iterm-launch).
#
# Observation: the uniform host path injects the computed session base into the
# remote setup script as SESSION='<NAME>'; pull NAME from $SSH_CAPTURE and verify it.
# session base = "<host>_<readable15>_<sha256(hostpath)[1-5]>"  ('.'/':' -> '_').
cd "$(dirname "$0")"; . ./lib.sh

TEST_REMOTE_HOST="test-host"

# Extract the remote session base the launcher injected into the SSH setup script.
extract_session() {
  sed -n "s/^SESSION='\([^']*\)'$/\1/p" "$SSH_CAPTURE" | head -1
}

# Compute the expected session name with the same rules as the launcher (independent impl for verification).
# readable: keep as-is if ASCII, otherwise use the given slug. Then sanitize to the
# launcher's safe session alphabet, cut -c1-15, and strip a trailing '-'.
# base = "<readable15>_<sha5(fullpath)>", final = "<host>_<base>" with [.:]->_.
expect_name() { # $1=fullpath  $2=readable(slug; may be omitted if basename is ASCII)
  local dir="$1" readable="$2" base name hash
  [ -z "$readable" ] && readable="$(basename "$dir")"
  name="$(printf '%s' "$readable" | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C sed 's/[^a-z0-9_.-]/-/g; s/-\{2,\}/-/g; s/^-//; s/-$//' | cut -c1-15)"
  [ -n "$name" ] || name=session
  hash="$(printf '%s' "$dir" | shasum -a 256 | cut -c1-5)"
  base="${name}_${hash}"
  name="${TEST_REMOTE_HOST}_${base}"
  printf '%s' "$(printf '%s' "$name" | tr '.:' '__')"
}

# ───────────────────────────────────────────────────────────────────
# Scenario 1 — ASCII basename → used verbatim, no translation. claude/hangul-romanize not invoked.
# ───────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
ASCII_DIR="$SBX/myproj"; mkdir -p "$ASCII_DIR"
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher "$ASCII_DIR"
GOT1="$(extract_session)"
EXP1="$(expect_name "$ASCII_DIR" "myproj")"

it "ascii/verbatim-name"
assert_rc "$RP_RC" 0 "ascii remote launch succeeds"
assert_eq "$GOT1" "$EXP1" "session base = host_myproj_<5hex>"
assert_absent "$MLOG" "claude|" "ASCII → claude translation not invoked"
assert_absent "$MLOG" "hangul-romanize|" "ASCII → romanization not invoked"
cleanup_sandbox

# ───────────────────────────────────────────────────────────────────
# Scenario 2 — non-ASCII basename + claude present → use the claude-translated slug.
# ───────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
HAN_DIR="$SBX/한글폴더"; mkdir -p "$HAN_DIR"
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ MOCK_CLAUDE_SLUG=myslug run_launcher "$HAN_DIR"
GOT2="$(extract_session)"
EXP2="$(expect_name "$HAN_DIR" "myslug")"

it "nonascii/claude-translate"
assert_rc "$RP_RC" 0 "non-ASCII remote launch succeeds"
assert_contains "$MLOG" "claude|" "non-ASCII → claude translation invoked"
assert_contains "$GOT2" "myslug" "session name contains the claude slug"
assert_eq "$GOT2" "$EXP2" "session base = host_myslug_<5hex>"
cleanup_sandbox

# ───────────────────────────────────────────────────────────────────
# Scenario 3 — cache determinism: same RP_DIR/same dir twice → no second claude call.
# new_sandbox is not called again, so RP_DIR (=the cache) stays intact.
# ───────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
HAN_DIR3="$SBX/한글폴더"; mkdir -p "$HAN_DIR3"
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ MOCK_CLAUDE_SLUG=cachedslug run_launcher "$HAN_DIR3"
RUN1_NAME="$(extract_session)"
it "nonascii/cache-first-call"
assert_contains "$MLOG" "claude|" "first call goes through claude translation"
# Second run — only clear MOCKLOG and rerun against the same sandbox/RP_DIR (expect a cache hit).
: > "$MOCKLOG"
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ MOCK_CLAUDE_SLUG=cachedslug run_launcher "$HAN_DIR3"
RUN2_NAME="$(extract_session)"
it "nonascii/cache-hit-no-reclaude"
assert_absent "$MLOG" "claude|" "cache hit → no second claude call"
assert_eq "$RUN2_NAME" "$RUN1_NAME" "session name stays stable via cache (identical across 2 runs)"
cleanup_sandbox

# ───────────────────────────────────────────────────────────────────
# Scenario 4 — claude translation fails (empty output) + hangul-romanize present → romanization fallback.
# Note: the name is computed locally, then injected into the remote setup script.
# ───────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
# Overwrite the claude mock as "present but no -p output" (keeping argv logging).
{
  printf '#!/bin/bash\n'
  printf '{ printf "%%s" "$(basename "$0")"; for a in "$@"; do printf "|%%s" "$a"; done; printf "\\n"; } >> "$MOCKLOG"\n'
  printf 'exit 0\n'
} > "$MOCKBIN/claude"; chmod +x "$MOCKBIN/claude"
# The launcher's romanizer looks at $HROMANIZE=$RP_CLIENT_DIR/bin/hangul-romanize, not PATH.
# → to hit the romanization fallback, place an executable at that location.
cp "$MOCKBIN/hangul-romanize" "$RP_CLIENT_DIR/bin/hangul-romanize"; chmod +x "$RP_CLIENT_DIR/bin/hangul-romanize"
HAN_DIR4="$SBX/한글폴더"; mkdir -p "$HAN_DIR4"
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ MOCK_HROMANIZE=romanX run_launcher "$HAN_DIR4"
GOT4="$(extract_session)"
EXP4="$(expect_name "$HAN_DIR4" "romanX")"

it "nonascii/hangul-fallback"
assert_rc "$RP_RC" 0 "claude-translation-failure romanization fallback launch succeeds"
assert_contains "$MLOG" "claude|" "claude -p attempted (present but empty output)"
assert_contains "$GOT4" "romanx" "session name contains the sanitized romanization result"
assert_eq "$GOT4" "$EXP4" "session base = host_romanx_<5hex>"
cleanup_sandbox

# ───────────────────────────────────────────────────────────────────
# Scenario 4b — claude prints an auth/API failure on stdout → treat as failure and romanize.
# ───────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
{
  printf '#!/bin/bash\n'
  printf '{ printf "%%s" "$(basename "$0")"; for a in "$@"; do printf "|%%s" "$a"; done; printf "\\n"; } >> "$MOCKLOG"\n'
  printf 'case " $* " in *" -p "*) printf "Failed to authenticate. API Error: 401 Invalid authentication credentials\\n"; exit 42 ;; esac\n'
  printf 'exit 0\n'
} > "$MOCKBIN/claude"; chmod +x "$MOCKBIN/claude"
cp "$MOCKBIN/hangul-romanize" "$RP_CLIENT_DIR/bin/hangul-romanize"; chmod +x "$RP_CLIENT_DIR/bin/hangul-romanize"
HAN_DIR4B="$SBX/회의녹음본"; mkdir -p "$HAN_DIR4B"
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ MOCK_HROMANIZE=hoeui-nogeum-bon run_launcher "$HAN_DIR4B"
GOT4B="$(extract_session)"
EXP4B="$(expect_name "$HAN_DIR4B" "hoeui-nogeum-bon")"

it "nonascii/claude-auth-failure-fallback"
assert_rc "$RP_RC" 0 "claude auth failure output falls back to romanizer"
assert_contains "$MLOG" "claude|" "claude -p attempted"
assert_contains "$MLOG" "hangul-romanize|" "auth failure triggers romanizer"
assert_absent "$GOT4B" "failed-to-auth" "session name does not cache auth error text"
assert_eq "$GOT4B" "$EXP4B" "session base = host_romanized_<5hex>"
cleanup_sandbox

# ───────────────────────────────────────────────────────────────────
# Scenario 4c — any non-zero claude -p failure, regardless of message → romanization fallback.
# ───────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
{
  printf '#!/bin/bash\n'
  printf '{ printf "%%s" "$(basename "$0")"; for a in "$@"; do printf "|%%s" "$a"; done; printf "\\n"; } >> "$MOCKLOG"\n'
  printf 'case " $* " in *" -p "*) printf "provider exploded in a novel way\\n"; exit 77 ;; esac\n'
  printf 'exit 0\n'
} > "$MOCKBIN/claude"; chmod +x "$MOCKBIN/claude"
cp "$MOCKBIN/hangul-romanize" "$RP_CLIENT_DIR/bin/hangul-romanize"; chmod +x "$RP_CLIENT_DIR/bin/hangul-romanize"
HAN_DIR4C="$SBX/번역실패"; mkdir -p "$HAN_DIR4C"
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ MOCK_HROMANIZE=beonyeok-silpae run_launcher "$HAN_DIR4C"
GOT4C="$(extract_session)"
EXP4C="$(expect_name "$HAN_DIR4C" "beonyeok-silpae")"

it "nonascii/claude-any-error-fallback"
assert_rc "$RP_RC" 0 "any claude -p non-zero failure falls back to romanizer"
assert_contains "$MLOG" "claude|" "claude -p attempted"
assert_contains "$MLOG" "hangul-romanize|" "generic failure triggers romanizer"
assert_absent "$GOT4C" "provider-exploded" "session name does not cache arbitrary error text"
assert_eq "$GOT4C" "$EXP4C" "session base = host_romanized_<5hex>"
cleanup_sandbox

# ───────────────────────────────────────────────────────────────────
# Scenario 5 — claude translation fails + hangul-romanize absent → raw basename (sanitized) fallback.
# The romanizer looks at $RP_CLIENT_DIR/bin/hangul-romanize, not the PATH mock.
# new_sandbox creates only the $RP_CLIENT_DIR/bin directory and lays down no file → [ -x ] fails → raw fallback.
# claude is present (so the local launch proceeds) but left with empty -p output.
# ───────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
{
  printf '#!/bin/bash\n'
  printf '{ printf "%%s" "$(basename "$0")"; for a in "$@"; do printf "|%%s" "$a"; done; printf "\\n"; } >> "$MOCKLOG"\n'
  printf 'exit 0\n'
} > "$MOCKBIN/claude"; chmod +x "$MOCKBIN/claude"
HAN_DIR5="$SBX/한글폴더"; mkdir -p "$HAN_DIR5"
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher "$HAN_DIR5"
GOT5="$(extract_session)"
# Fallback = raw basename "한글폴더" → sanitized to safe fallback slug.
EXP5="$(expect_name "$HAN_DIR5" "한글폴더")"

it "nonascii/raw-fallback"
assert_rc "$RP_RC" 0 "claude-failure + romanizer-absent -> raw fallback succeeds"
assert_contains "$MLOG" "claude|" "claude -p attempted (empty output)"
assert_absent "$MLOG" "hangul-romanize|" "romanizer absent (RP_CLIENT_DIR/bin is empty)"
assert_eq "$GOT5" "$EXP5" "session base = host_session_<5hex> (safe raw fallback)"
cleanup_sandbox

# ───────────────────────────────────────────────────────────────────
# Scenario 6 — determinism: same input dir path → identical session name even across two fresh sandboxes.
# (Even with an empty cache, the ASCII path is translation-free and deterministic, so it must match.)
# ───────────────────────────────────────────────────────────────────
DET_PATH=""   # use a fixed path so both sandboxes use the same dir path string
DET_BASENAME="detproj"

new_sandbox
make_all_mocks
DET_DIR_A="$SBX/$DET_BASENAME"; mkdir -p "$DET_DIR_A"
DET_PATH="$DET_DIR_A"   # the path includes SBX (random) — since we can't reuse the same SBX, the same path string is forced below
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher "$DET_DIR_A"
DET_A="$(extract_session)"
cleanup_sandbox

# Second fresh sandbox — recreate the dir with the same absolute path string to reproduce.
new_sandbox
make_all_mocks
mkdir -p "$DET_PATH"   # the previous SBX was cleaned up, but recreate with the same path string
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ run_launcher "$DET_PATH"
DET_B="$(extract_session)"

it "determinism/two-sandboxes"
assert_eq "$DET_B" "$DET_A" "same dir path → identical session name (two fresh sandboxes)"
cleanup_sandbox

# Static equivalence: assert at the source level that the two _proj_base definitions use the same scheme.
# Both use name="$(_readable basename | cut -c1-15 | sed 's/-$//')" and
#        printf '%s_%s' name "$(...shasum -a 256 | cut -c1-5)".
it "equivalence/static-proj-base"
NEW_PB="$(sed -n '/^_proj_base() {/,/^}/p' "$LAUNCHER_SRC")"
REF_PB=""
[ -f "${REFERENCE_SRC:-/nonexist}" ] && REF_PB="$(sed -n '/^_proj_base() {/,/^}/p' "$REFERENCE_SRC")"
assert_contains "$NEW_PB" "cut -c1-15" "new _proj_base: readable capped at 15 chars"
assert_contains "$NEW_PB" "shasum -a 256 | cut -c1-5" "new _proj_base: 5hex path hash"
assert_contains "$NEW_PB" "%s_%s" "new _proj_base: underscore-separated name_hash"
if [ -n "$REF_PB" ]; then
  assert_contains "$REF_PB" "cut -c1-15" "reference _proj_base: readable capped at 15 chars"
  assert_contains "$REF_PB" "shasum -a 256 | cut -c1-5" "reference _proj_base: 5hex path hash"
  assert_contains "$REF_PB" "%s_%s" "reference _proj_base: underscore-separated name_hash"
fi

finish
