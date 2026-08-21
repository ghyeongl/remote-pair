#!/usr/bin/env bash
# t_04_target — 타깃 결정 로직(로컬 vs 원격) 검증.
#
# 관측 방법: MLOG 의 mock 호출 로그로 판단.
#   로컬 경로 → tmux-aqua|…|has-session / new-session 호출,  ssh| 없음
#   원격 경로 → ssh|…|true (reach) 및 mosh| 호출
#
# 한계: 인터랙티브 '2'→로컬 선택은 /dev/tty 없는 환경에선 pty 없이 불가 — 검증하지 않음.
cd "$(dirname "$0")"; . ./lib.sh

# ────────────────────────────────────────────────────────────
# 시나리오 1: REMOTE_HOST="" (빈 값) → 강제 로컬
# ────────────────────────────────────────────────────────────
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks
MOCK_HASSESSION=0 MOCK_CLIENTS="" MOCK_SESS_EXISTS="" \
  run_launcher "$SBX"

it "target/empty-remote-host→local"
assert_contains "$MLOG" "tmux-aqua" "tmux-aqua 호출(로컬 경로)"
assert_absent   "$MLOG" "ssh|"      "ssh 미호출(로컬 경로)"

cleanup_sandbox

# ────────────────────────────────────────────────────────────
# 시나리오 2: REMOTE_HOST 설정 + --local 강제 → 로컬
# ────────────────────────────────────────────────────────────
new_sandbox   # SBX_REMOTE_HOST 미설정 → 기본 test-host 사용
make_all_mocks
MOCK_HASSESSION=0 MOCK_CLIENTS="" MOCK_SESS_EXISTS="" \
  run_launcher --local "$SBX"

it "target/remote-host+--local→local"
assert_contains "$MLOG" "tmux-aqua" "tmux-aqua 호출(--local 강제)"
assert_absent   "$MLOG" "ssh|"      "ssh 미호출(--local 강제)"

cleanup_sandbox

# ────────────────────────────────────────────────────────────
# 시나리오 3: REMOTE_HOST 설정 + --remote + MOCK_DIRCHECK=__YES__ → 원격
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ \
  run_launcher --remote "$SBX"

it "target/remote-host+--remote→remote"
assert_contains "$MLOG" "ssh|"  "ssh reach 호출(원격 경로)"
assert_contains "$MLOG" "mosh|" "mosh attach 호출(원격 경로)"

cleanup_sandbox

# ────────────────────────────────────────────────────────────
# 시나리오 4: REMOTE_HOST 설정 + RP_YES=1 (--local/--remote 없음) → 원격, 프롬프트 없음
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ RP_YES=1 \
  run_launcher "$SBX"

it "target/rp-yes→remote-no-prompt"
assert_contains "$MLOG" "ssh|"  "ssh reach 호출(RP_YES 원격)"
assert_contains "$MLOG" "mosh|" "mosh attach 호출(RP_YES 원격)"
assert_absent   "$RP_OUT" "select" "RP_YES=1 이면 프롬프트 미출력"

cleanup_sandbox

# ────────────────────────────────────────────────────────────
# 시나리오 5: REMOTE_HOST 설정 + 플래그 없음 + tty 없음 → ask()=""→remote 기본
# (테스트 환경에는 tty 없음 → read </dev/tty 실패 → ans="" → 기본 remote)
# New prompt format: "Launch claude for "<proj>":" with "session _N  (state)" annotation.
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ \
  run_launcher "$SBX"

it "target/no-tty-no-flags→remote-default"
assert_contains "$MLOG" "ssh|"  "ssh reach 호출(no-tty 원격 기본)"
assert_contains "$MLOG" "mosh|" "mosh attach 호출(no-tty 원격 기본)"

it "target/prompt-contains-session-annotation"
# The interactive prompt is printed to stdout before ask() reads /dev/tty.
# With no tty, prompt is still emitted to stdout — check it contains "session _" and a state word.
assert_contains "$RP_OUT" "session _" "prompt contains 'session _' annotation"

it "target/prompt-contains-state-word"
# State is exactly one of: new, reattach, fresh
case "$RP_OUT" in
  *"(new)"*|*"(reattach)"*|*"(fresh)"*)
    _pass "prompt contains state word" ;;
  *)
    _fail "prompt missing state word :: RP_OUT=[$RP_OUT]" ;;
esac
assert_absent "$RP_OUT" "new/reattach" "prompt never emits ambiguous state"

cleanup_sandbox

# A live remote tmux _1 is labeled reattach (not new).
new_sandbox
make_all_mocks
MOCK_REMOTE_SESS_EXISTS=1 MOCK_REACH=ok MOCK_DIRCHECK=__YES__ \
  run_launcher "$SBX"

it "target/prompt-live-remote-session→reattach"
assert_contains "$RP_OUT" "(reattach)" "live remote tmux is labeled reattach"
assert_absent "$RP_OUT" "new/reattach" "live remote state is unambiguous"

cleanup_sandbox

# ────────────────────────────────────────────────────────────
# 시나리오 6: _remote_next_n via MLOG — _remote_next_n reused in RN loop
# No live mosh-clients → RN=1 → remote session created as _1
# ────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_REACH=ok MOCK_DIRCHECK=__YES__ RP_YES=1 \
  run_launcher "$SBX"

it "target/remote-rn-1-no-mosh-clients"
# With no live mosh-clients, _remote_next_n returns 1 → SESSION ends with _1
assert_contains "$MLOG" "mosh|" "mosh invoked (remote path)"
# The SSH setup script contains SESSION=..._1 (RN=1)
SSH_SCRIPT="$(cat "$SSH_CAPTURE" 2>/dev/null)"
assert_contains "$SSH_SCRIPT" "_1" "remote setup script targets session _1"

cleanup_sandbox

# ────────────────────────────────────────────────────────────
# 시나리오 7: _local_next_n reused in launch_local — _N=2 when _1 has client
# (mirrors t_05 scenario 3 but verifies the refactored helper path)
# ────────────────────────────────────────────────────────────
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks

# First run: discover _1 session name
MOCK_HASSESSION=0 MOCK_SESS_EXISTS="" MOCK_CLIENTS="" \
  run_launcher --local "$SBX"
SESS7_1="$(printf '%s\n' "$MLOG" | grep 'new-session' | sed 's/.*|-s|\([^|]*\)|.*/\1/' | head -1)"
: > "$MOCKLOG"

# Second run: _1 has a client → helper must pick _2
MOCK_HASSESSION=0 MOCK_SESS_EXISTS="" MOCK_CLIENTS="$SESS7_1" \
  run_launcher --local "$SBX"

it "target/local-helper-_N2-when-_1-attached"
SESS7_2="${SESS7_1%_1}_2"
assert_contains "$MLOG" "new-session|-d|-s|$SESS7_2" "_local_next_n helper picks _2 when _1 attached"

cleanup_sandbox

finish
