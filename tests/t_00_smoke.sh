#!/usr/bin/env bash
# t_00_smoke — 하네스 자체 검증(US-1) + 로컬 생성 경로 최소 확인.
cd "$(dirname "$0")"; . ./lib.sh

# 시나리오: --local 강제 → 로컬 경로. 서버 up, 세션/클라이언트 없음 → new-session + attach -d.
SBX_REMOTE_HOST="" new_sandbox
make_all_mocks
MOCK_HASSESSION=0 MOCK_CLIENTS="" MOCK_SESS_EXISTS="" \
  run_launcher --local "$SBX"

it "harness/local-create"
assert_rc "$RP_RC" 0 "local 생성 후 exec attach 성공"
assert_contains "$MLOG" "tmux-aqua|-S|/tmp/aqua-tmux-rp.sock|new-session" "tmux-aqua new-session 호출"
assert_contains "$MLOG" "new-session|-d" "detached 세션 생성"
assert_contains "$MLOG" "attach|-d" "attach -d take-over 호출"
assert_absent "$MLOG" "ssh|" "로컬 경로에선 ssh 미호출"
assert_absent "$MLOG" "mosh|" "로컬 경로에선 mosh 미호출"

cleanup_sandbox
finish
