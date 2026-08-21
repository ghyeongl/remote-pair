#!/usr/bin/env bash
# tests/lib.sh — remote-pair-launch 테스트 하네스 (mock PATH-shim + assert + 러너).
#
# 핵심 트릭: 런처는 시작 시 PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" 로
# prepend 한다. 그래서 테스트에서 HOME 을 임시 디렉터리로 바꾸고 모든 mock 을
# $HOME/.local/bin 에 깔면, mock 이 실제 ssh/tmux/mosh/tmux-aqua/claude/tailscale 를 가린다
# → 실 m1/네트워크/GUI 를 절대 건드리지 않고 결정론적으로 동작을 검증.
#
# mock 은 호출 argv 를 $MOCKLOG 에 "이름|arg1|arg2|..." 한 줄로 기록. 동작은 env 로 제어.
# bash 3.2 호환만 사용 (연관배열/`${x^^}` 등 금지).

# 검증 대상/레퍼런스 경로 — repo 루트 기준 상대(어느 머신/CI 체크아웃 경로든 동작; 절대경로 하드코딩 금지)
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REPO_ROOT="$(cd "$_LIB_DIR/.." && pwd)"
LAUNCHER_SRC="${LAUNCHER_SRC:-$_REPO_ROOT/client/remote-pair-launch}"
REFERENCE_SRC="${REFERENCE_SRC:-${HOME_REAL:-$HOME}/.claude/bin/claude-iterm-launch}"

# 집계 카운터
T_PASS=0; T_FAIL=0; T_NAME=""
_fail() { T_FAIL=$((T_FAIL+1)); printf '  \033[31mFAIL\033[0m %s: %s\n' "$T_NAME" "$*"; }
_pass() { T_PASS=$((T_PASS+1)); printf '  \033[32mok\033[0m   %s: %s\n' "$T_NAME" "$*"; }

it() { T_NAME="$1"; }   # 현재 케이스 이름 설정

# finish — 테스트 파일 끝에서 호출. 요약 출력 + 실패 시 비0 종료.
finish() {
  printf '__SUMMARY__ pass=%s fail=%s\n' "$T_PASS" "$T_FAIL"
  [ "$T_FAIL" = 0 ]
}

assert_rc()       { [ "$1" = "$2" ] && _pass "rc=$2 ($3)" || _fail "rc expected $2 got $1 ($3)"; }
assert_contains() { case "$1" in *"$2"*) _pass "contains '$2' ($3)";; *) _fail "missing '$2' ($3) :: in=[$1]";; esac; }
assert_absent()   { case "$1" in *"$2"*) _fail "should NOT contain '$2' ($3) :: in=[$1]";; *) _pass "absent '$2' ($3)";; esac; }
assert_eq()       { [ "$1" = "$2" ] && _pass "eq '$2' ($3)" || _fail "expected '$2' got '$1' ($3)"; }

# ── 샌드박스 + mock 환경 ──
# new_sandbox: 임시 HOME/RP_DIR 생성, MOCKBIN/MOCKLOG 설정. 호출 후 mocks 깔고 run_launcher.
# $HOME_REAL 은 레퍼런스 경로 해석용으로 보존.
HOME_REAL="${HOME_REAL:-$HOME}"

new_sandbox() {
  SBX="$(mktemp -d -t rpltest.XXXXXX)"
  export HOME="$SBX"
  RP_DIR="$SBX/.remote-pair"
  MOCKBIN="$SBX/.local/bin"
  MOCKLOG="$SBX/mocklog"
  RP_ERRFILE="$SBX/launch.err"
  SSH_CAPTURE="$SBX/ssh-capture"     # mock ssh 가 받은 원격 스크립트 저장
  mkdir -p "$RP_DIR/logs" "$MOCKBIN" "$RP_DIR/bin"
  # mock 들(런처가 자식으로 실행)이 보도록 반드시 export
  export HOME RP_DIR MOCKBIN MOCKLOG SSH_CAPTURE SBX
  : > "$MOCKLOG"
  # 기본 config (client 역할). 테스트가 덮어쓸 수 있음.
  : > "$RP_DIR/common.env"
  : > "$RP_DIR/host.env"
  # 단일대시 기본값 — SBX_REMOTE_HOST="" 로 빈 값(로컬 강제) 테스트가 가능하도록
  cat > "$RP_DIR/client.env" <<EOF
REMOTE_HOST=${SBX_REMOTE_HOST-test-host}
FOLDER_MAPS=${SBX_FOLDER_MAPS-}
EOF
}

cleanup_sandbox() { [ -n "${SBX:-}" ] && rm -rf "$SBX"; HOME="$HOME_REAL"; }

# make_mock NAME — 표준 mock 생성. env MOCK_* 로 동작 제어. 모든 mock 은 argv 로깅.
# 생략하려면 (예: claude 부재 테스트) 단순히 호출 안 하면 됨.
_emit_logger() { # 공통 머리말: argv 로깅
  cat <<'LOG'
#!/bin/bash
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$MOCKLOG"
LOG
}

make_all_mocks() {
  # which mocks: 인자로 받은 이름들. 없으면 표준 풀세트.
  local set="${*:-ssh mosh tmux tmux-aqua claude tailscale hangul-romanize launchctl open tput}"
  local m
  for m in $set; do make_mock "$m"; done
}

make_mock() {
  local name="$1" f="$MOCKBIN/$1"
  _emit_logger > "$f"
  case "$name" in
    ssh)
      cat >> "$f" <<'EOS'
last=""; for a in "$@"; do last="$a"; done
case "$last" in
  true) # reach 체크
    case "${MOCK_REACH:-ok}" in
      ok) exit 0 ;;
      fail) exit 1 ;;
      fail-then-ok)
        c="$SBX/.reachn"; n=0; [ -f "$c" ] && n=$(cat "$c"); n=$((n+1)); echo "$n" > "$c"
        [ "$n" -ge "${MOCK_REACH_OKAT:-2}" ] && exit 0 || exit 1 ;;
    esac ;;
  *__YES__*) # dir-check
    case "${MOCK_DIRCHECK:-__YES__}" in
      __YES__) echo __YES__; exit 0 ;;
      __NO__)  echo __NO__;  exit 0 ;;
      ssherr)  exit 255 ;;
    esac ;;
  \$HOME/.local/bin/tmux-aqua*" has-session -t "*)
    [ "$MOCK_REMOTE_SESS_EXISTS" = 1 ] && exit 0 || exit 1 ;;
  *__SESSION__*|*RESPAWN_B64*) # 원격 setup 스크립트
    printf '%s' "$last" > "$SSH_CAPTURE"
    echo "__SESSION__:${MOCK_REMOTE_SESSION:-rp_remote_1}"; exit 0 ;;
  *detach-client*) exit 0 ;;
  *list-sessions*) printf '%s\n' "${MOCK_ATT:-}"; exit 0 ;;
  *mkdir*) exit 0 ;;
esac
exit 0
EOS
      ;;
    tmux-aqua|tmux)
      cat >> "$f" <<'EOS'
# 첫 비옵션 토큰을 서브커맨드로 (-S 와 그 인자는 건너뜀)
sub=""
for a in "$@"; do
  case "$a" in
    -S) skip=1; continue ;;
  esac
  if [ "${skip:-0}" = 1 ]; then skip=0; continue; fi
  sub="$a"; break
done
case "$sub" in
  has-session)
    # 타깃(-t =X) 있으면 그 세션 존재 여부 = MOCK_SESS_EXISTS 목록 매칭; 없으면 서버 기동 여부
    tgt=""; nx=0; for a in "$@"; do [ "$nx" = 1 ] && { tgt="$a"; nx=0; }; [ "$a" = "-t" ] && nx=1; done
    if [ -n "$tgt" ]; then
      case " ${MOCK_SESS_EXISTS:-} " in *" ${tgt#=} "*) exit 0 ;; *) exit 1 ;; esac
    fi
    exit "${MOCK_HASSESSION:-0}" ;;   # 서버: 0=있음
  list-clients)
    tgt=""; nx=0; for a in "$@"; do [ "$nx" = 1 ] && { tgt="$a"; nx=0; }; [ "$a" = "-t" ] && nx=1; done
    case " ${MOCK_CLIENTS:-} " in *" ${tgt#=} "*) echo x; exit 0 ;; *) exit 0 ;; esac ;;
  list-sessions) printf '%s\n' "${MOCK_ATT:-}"; exit 0 ;;
  *) exit 0 ;;
esac
EOS
      ;;
    claude)
      cat >> "$f" <<'EOS'
# claude -p --model haiku "...prompt..."  → 슬러그 출력. --remote-control 등은 그냥 종료.
case " $* " in
  *" -p "*) printf '%s\n' "${MOCK_CLAUDE_SLUG:-translated-slug}" ;;
  *) : ;;
esac
exit 0
EOS
      ;;
    tailscale)
      cat >> "$f" <<'EOS'
case "$1" in
  status) ts="${MOCK_TS_JSON}"; [ -z "$ts" ] && ts='{"Peer":{}}'; printf '%s' "$ts" ;;
  set) : ;;
esac
exit 0
EOS
      ;;
    hangul-romanize)
      cat >> "$f" <<'EOS'
printf '%s' "${MOCK_HROMANIZE:-romanized}"
exit 0
EOS
      ;;
    mosh|launchctl|open)
      echo 'exit 0' >> "$f" ;;
    tput)
      cat >> "$f" <<'EOS'
case "$1" in cols) echo "${MOCK_COLS:-200}";; lines) echo "${MOCK_LINES:-50}";; *) echo 0;; esac
exit 0
EOS
      ;;
    *) echo 'exit 0' >> "$f" ;;
  esac
  chmod +x "$f"
}

# run_launcher [args...] — 격리 샌드박스에서 대상 런처 실행. RP_OUT/RP_ERR/RP_RC/MLOG 설정.
run_launcher() {
  RP_OUT="$(bash "$LAUNCHER_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  sleep 0.2   # stderr tee(process-sub) drain 대기
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
  MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
}

# run_reference [args...] — 같은 샌드박스 규칙으로 레퍼런스 실행 (동일성 비교용).
# 레퍼런스는 ~/.claude 경로/구 이름을 쓰므로 호출 측에서 그에 맞는 mock/env 준비.
run_reference() {
  RP_OUT="$(printf '%s' "" | bash "$REFERENCE_SRC" "$@" 2>"$RP_ERRFILE")"; RP_RC=$?
  sleep 0.2
  RP_ERR="$(cat "$RP_ERRFILE" 2>/dev/null)"
  MLOG="$(cat "$MOCKLOG" 2>/dev/null)"
}
