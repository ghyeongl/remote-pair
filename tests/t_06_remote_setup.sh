#!/usr/bin/env bash
# t_06_remote_setup — 원격 setup 스크립트, presize, base64 respawn, mosh attach, 세션명 시나리오.
cd "$(dirname "$0")"; . ./lib.sh

# ─────────────────────────────────────────────────────────────────────────────
# 시나리오 1: SSH_CAPTURE 내용 기본 구성 검증
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_DIRCHECK=__YES__ MOCK_REACH=ok \
  run_launcher --remote "$SBX"

it "ssh-capture/RESPAWN_B64-present"
assert_contains "$(cat "$SSH_CAPTURE")" "RESPAWN_B64=" "setup 스크립트에 RESPAWN_B64= 포함"

it "ssh-capture/base64-decode-cmd"
assert_contains "$(cat "$SSH_CAPTURE")" "base64 -d" "setup 스크립트에 base64 -d 포함"

it "ssh-capture/SESSION-line"
assert_contains "$(cat "$SSH_CAPTURE")" "SESSION='" "setup 스크립트에 SESSION='<name>' 포함"

it "ssh-capture/open-RemotePairHost"
assert_contains "$(cat "$SSH_CAPTURE")" 'open -a "RemotePairHost"' "RemotePairHost 앱 open 명령 포함"

it "ssh-capture/bundle-prefix"
assert_contains "$(cat "$SSH_CAPTURE")" "com.x10lab.remote-pair-host" "번들 prefix 포함"

it "ssh-capture/SOCK-aqua"
assert_contains "$(cat "$SSH_CAPTURE")" 'SOCK="/tmp/aqua-tmux-rp.sock"' "SOCK 변수 설정 포함"

it "ssh-capture/computer-use-comment"
assert_contains "$(cat "$SSH_CAPTURE")" "RemotePairHost" "computer-use 관련 RemotePairHost 언급"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# 시나리오 2: presize — MOCK_COLS/MOCK_LINES 가 new-session -x/-y 에 반영되는지
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_DIRCHECK=__YES__ MOCK_REACH=ok MOCK_COLS=123 MOCK_LINES=45 \
  run_launcher --remote "$SBX"

it "presize/cols-in-new-session"
assert_contains "$(cat "$SSH_CAPTURE")" "-x 123" "new-session 에 -x 123 포함"

it "presize/lines-in-new-session"
assert_contains "$(cat "$SSH_CAPTURE")" "-y 45" "new-session 에 -y 45 포함"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# 시나리오 3: base64 round-trip — RESPAWN_B64 값을 추출해 decode 후 내용 검증
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_DIRCHECK=__YES__ MOCK_REACH=ok \
  run_launcher --remote "$SBX"

it "base64-roundtrip/claude-remote-control"
# RESPAWN_B64='...' 줄에서 값 추출 → base64 decode
_b64="$(grep "^RESPAWN_B64='" "$SSH_CAPTURE" | sed "s/^RESPAWN_B64='//;s/'$//")"
_decoded="$(printf '%s' "$_b64" | base64 -d 2>/dev/null)"
assert_contains "$_decoded" "claude --remote-control" "decode 결과에 claude --remote-control 포함"

it "base64-roundtrip/crash-restart-loop"
assert_contains "$_decoded" "restarting in 3s" "decode 결과에 crash-restart 루프 포함"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# 시나리오 4: mosh 라인 — $HOME 확장 버그 회귀 방지 (CRITICAL)
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_DIRCHECK=__YES__ MOCK_REACH=ok \
  run_launcher --remote "$SBX"

it "mosh-line/present-in-mlog"
mline="$(printf '%s\n' "$MLOG" | grep '^mosh|')"
assert_contains "$mline" "mosh" "MLOG 에 mosh 호출 존재"

it "mosh-line/no-literal-HOME"
# $HOME 이 문자 그대로 남아있으면 안 됨 — 반드시 확장된 절대경로여야 함
assert_absent "$mline" '$HOME' "mosh 라인에 리터럴 \$HOME 없음 (버그 회귀 방지)"

it "mosh-line/absolute-tmux-aqua"
assert_contains "$mline" "/.local/bin/tmux-aqua" "mosh 라인에 절대경로 tmux-aqua 포함"

it "mosh-line/mosh-server-path"
assert_contains "$mline" "--server=/opt/homebrew/bin/mosh-server" "mosh --server 절대경로 포함"

it "mosh-line/attach-d"
assert_contains "$mline" "attach" "mosh 라인에 attach 포함"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# 시나리오 5a: 세션명 — MOCK_REMOTE_SESSION 미설정 → 기본 rp_remote_1
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_DIRCHECK=__YES__ MOCK_REACH=ok \
  run_launcher --remote "$SBX"

it "session-name/default-rp_remote_1"
mline="$(printf '%s\n' "$MLOG" | grep '^mosh|')"
assert_contains "$mline" "=rp_remote_1" "mosh attach 대상이 =rp_remote_1"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# 시나리오 5b: 세션명 — MOCK_REMOTE_SESSION=foo_2 → attach -t =foo_2
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_DIRCHECK=__YES__ MOCK_REACH=ok MOCK_REMOTE_SESSION=foo_2 \
  run_launcher --remote "$SBX"

it "session-name/custom-foo_2"
mline="$(printf '%s\n' "$MLOG" | grep '^mosh|')"
assert_contains "$mline" "=foo_2" "mosh attach 대상이 =foo_2"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# 시나리오 6: RemotePairHost server-ensure — has-session 블록 + launchctl kickstart
# ─────────────────────────────────────────────────────────────────────────────
new_sandbox
make_all_mocks
MOCK_DIRCHECK=__YES__ MOCK_REACH=ok \
  run_launcher --remote "$SBX"

it "server-ensure/has-session-block"
assert_contains "$(cat "$SSH_CAPTURE")" "tm has-session" "setup 스크립트에 tm has-session 블록 포함"

it "server-ensure/launchctl-kickstart"
assert_contains "$(cat "$SSH_CAPTURE")" 'launchctl kickstart "gui/$(id -u)/com.x10lab.remote-pair-host"' "launchctl kickstart 라인 포함"

cleanup_sandbox

# ─────────────────────────────────────────────────────────────────────────────
# on_tab_close 커버리지 한계 기록 (헤드리스 HUP/TERM 트리거 불가)
# — 런처 소스에서 trap 선언만 확인 (read-only grep)
# ─────────────────────────────────────────────────────────────────────────────
it "on-tab-close/trap-defined-in-launcher"
_trap_line="$(grep 'trap on_tab_close HUP TERM' "$LAUNCHER_SRC" || true)"
assert_contains "$_trap_line" "trap on_tab_close HUP TERM" "런처 소스에 trap on_tab_close HUP TERM 선언 존재"

finish
