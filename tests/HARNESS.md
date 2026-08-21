# 테스트 하네스 계약 (tests/lib.sh)

대상 런처: `client/remote-pair-launch` (신규). 레퍼런스: `~/.claude/bin/claude-iterm-launch`.
실 m1/네트워크/GUI 안 건드림 — 임시 HOME 의 `.local/bin` 에 mock 을 깔면 런처의 PATH-prepend 때문에 mock 이 실 바이너리를 이긴다. bash 3.2 호환만.

## 테스트 파일 형식
```bash
#!/usr/bin/env bash
cd "$(dirname "$0")"; . ./lib.sh
new_sandbox            # 시나리오마다 호출(격리). 앞에 SBX_REMOTE_HOST=/SBX_FOLDER_MAPS= 프리픽스로 config 조정
make_all_mocks         # 전체 mock 설치. 특정 mock 빼려면 make_all_mocks ssh tmux tmux-aqua ...(claude 제외 등)
MOCK_X=.. MOCK_Y=.. run_launcher --remote "$SOMEDIR"   # MOCK_* 는 프리픽스로
it "케이스명"
assert_rc "$RP_RC" 0 "설명"
assert_contains "$MLOG" "패턴" "설명"
assert_absent  "$MLOG" "패턴" "설명"
assert_eq "$got" "$exp" "설명"
cleanup_sandbox
# ... 다음 시나리오는 new_sandbox 다시 ...
finish                 # 파일 끝. __SUMMARY__ 출력 + 실패 시 비0
```

## 헬퍼/변수
- `new_sandbox` : 임시 HOME/RP_DIR/MOCKBIN/MOCKLOG/SSH_CAPTURE 생성. 프리픽스 env:
  - `SBX_REMOTE_HOST` : client.env 의 REMOTE_HOST. `""` 이면 빈 값(로컬 강제), 미설정이면 `test-host`.
  - `SBX_FOLDER_MAPS` : client.env 의 FOLDER_MAPS (형식 `client::host;client2::host2`).
- `make_all_mocks [이름...]` : 기본 풀세트(ssh mosh tmux tmux-aqua claude tailscale hangul-romanize launchctl open tput). 인자 주면 그 목록만 설치(나머지 부재 테스트 가능).
- `make_mock NAME` : 단일 mock.
- 커스텀 동작이 필요하면 **lib.sh 수정 금지**. make_all_mocks 후 `$MOCKBIN/NAME` 에 직접 실행파일을 덮어써라(chmod +x). 첫 줄에 argv 로깅을 원하면 `{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '|%s' "$a"; done; echo; } >> "$MOCKLOG"` 를 넣어라.
- `run_launcher [args]` : 신규 런처 실행. 설정값: `$RP_OUT`(stdout) `$RP_ERR`(stderr) `$RP_RC`(종료코드) `$MLOG`(mock 호출 로그, 줄당 `name|arg|arg`).
- `run_reference [args]` : 레퍼런스 실행(동일성 비교용). 레퍼런스는 `~/.claude` 경로/구 이름(open -a RemotePair, com.ghyeong.remote-pair) 사용 — 그에 맞는 mock/디렉터리 준비 필요.
- 변수: `$SBX`(샌드박스 루트=HOME) `$RP_DIR` `$MOCKBIN` `$MOCKLOG` `$SSH_CAPTURE`(mock ssh 가 받은 원격 setup 스크립트 본문 저장 파일).

## MOCK_* 노브 (run_launcher 프리픽스)
- `MOCK_REACH` = `ok`(기본) | `fail` | `fail-then-ok`(+`MOCK_REACH_OKAT=N`, N번째 reach 부터 ok)
- `MOCK_DIRCHECK` = `__YES__`(기본) | `__NO__` | `ssherr`(마커 없이 255)
- `MOCK_HASSESSION` = `0`(기본, 서버 있음) | `1`(서버 없음) — 인자 없는 `has-session` 의 rc
- `MOCK_SESS_EXISTS` = "name1 name2" — `has-session -t =name` 이 성공(존재)할 세션들(= 접두 제외)
- `MOCK_CLIENTS` = "name1" — `list-clients -t =name` 이 클라이언트 있음(x)으로 답할 세션들
- `MOCK_CLAUDE_SLUG` = claude `-p` mock 이 낼 슬러그(기본 translated-slug)
- `MOCK_HROMANIZE` = hangul-romanize mock 출력(기본 romanized)
- `MOCK_TS_JSON` = `tailscale status --json` 출력 JSON
- `MOCK_COLS` / `MOCK_LINES` = tput 출력(기본 200/50)
- `MOCK_ATT` = `list-sessions` 출력(좀비정리용, "세션명 attached" 줄들)
- `MOCK_REMOTE_SESSION` = mock ssh 가 setup 응답으로 줄 `__SESSION__:<값>` (기본 rp_remote_1)

## 관측 팁
- 로컬/원격 세션명은 `new-session -s <NAME>`(MLOG) 또는 SSH_CAPTURE 의 `SESSION='<NAME>'` 로 확인.
- 주입된 respawn 임시파일은 MLOG 의 `bash /…/claude-respawn.XXX` 경로를 추출해 `cat` 하면 fresh Claude 실행과 `CLAUDE_WARP_RC=`를 확인 가능(런처가 삭제 안 함).
- 원격 setup 스크립트 검증은 `$(cat "$SSH_CAPTURE")` 사용.

## 규칙
- `tests/lib.sh`, `tests/run.sh`, 런처 본체 **수정 금지**. 오직 `tests/t_NN_<area>.sh` 생성.
- 만약 테스트가 런처의 **진짜 버그**를 드러내면, 그 assert 를 실패로 남기고 버그를 보고(파일:라인 + 증상). 런처 직접 수정 금지(직렬 수정은 메인이 담당).
- 인터랙티브 `ask()` 는 /dev/tty 를 읽음 — tty 없으면 빈 응답. pty 없는 테스트에선 "비대화 기본 분기"만 검증(예: 빈 응답 → remote 기본).
