# remote-pair-launch ↔ claude-iterm-launch 동일성 감사

신규 `client/remote-pair-launch` 가 레퍼런스 `~/.claude/bin/claude-iterm-launch` 의 모든 동작을 재현하는지(1:1 연결 모델) 항목별로 검증한 결과. 테스트 근거: `tests/t_*.sh` (총 116 assertion, fail 0).

## 동작 매핑표

| # | 레퍼런스 동작 | 신규 | 판정 | 테스트 |
|---|---|---|---|---|
| 1 | 에러로그 + stderr tee + 실패 시 pause | 동일 (로그 경로만 `$RP_DIR/logs/claude-launch.err.log` 로 네임스페이스 이전) | **SAME** | t_08 s1,s3 |
| 2 | `_readable`: ASCII 그대로 / 비ASCII→haiku 번역+캐시 / hangul-romanize 폴백 / 원본 | 동일 (캐시 `$RP_DIR/session-names`) | **SAME** | t_03 |
| 3 | `_proj_base` = 읽기쉬운이름(≤15) + 경로해시(5) | 동일 | **SAME** | t_03 |
| 4 | host-prefix 세션명 `<host>_<base>`, `[.:]`→`_` | 동일 | **SAME** | t_03 |
| 5 | respawn 루프; 새 tmux는 fresh Claude, live tmux는 reattach | 동일 | **SAME** | t_04, t_05 s1,s2,s3,s4 |
| 6 | 3-way: 없음→생성+continue / detached→`attach -d` take-over / attached→`_N` fresh | 동일 | **SAME** | t_05 s1-4 |
| 7 | 일반 tmux 폴백 | 동일 | **SAME** | t_05 s5 |
| 8 | 타깃 선택 (m1=로컬, 그외 프롬프트 [1]remote/[2]local) | 일반화: REMOTE_HOST 빈값/==local→로컬, `--local/--remote`, `RP_YES`→remote, 프롬프트 | **SAME** (+RP_YES 비대화 추가) | t_04 |
| 9 | reach + tailscale exit-node 자동설정 + 로컬 폴백 | 동일 | **SAME** | t_07 s1-3 |
| 10 | dir-check 3회 재시도(마커) + 생성 프롬프트 + 로컬 폴백 | 동일 | **SAME** | t_07 s4-6 |
| 11 | 좀비 탭 정리 | 동일 | **SAME** | t_08 s4 (kill 경로는 헤드리스 한계) |
| 12 | 원격 setup: 서버 기동보장→세션생성→base64 respawn 주입 | 동일 (앱/번들명 `RemotePairHost`/`com.x10lab.remote-pair-host` 로 적응) | **SAME** | t_06 s1,3,6 |
| 13 | mosh attach 절대경로 + `on_tab_close` detach trap + ssh -t 폴백 | 동일 | **SAME** | t_06 s4,5 |

## 의도된 차이 (DIVERGENCE — 복원 안 함)

| 항목 | 레퍼런스 | 신규 | 이유 |
|---|---|---|---|
| 경로 매핑 (FOLDER_MAPS) | 없음(동일경로 가정) | **신규 기능** (client↔host 절대경로 상이 대응) | 외부 sync 환경 지원. t_02 |
| `~/.claude` sync | 무거운 병렬(M1 bg + 락 + index.lock 자가치유) | 경량 best-effort 1줄 | sync 디커플(opt-in). [[launcher-1to1-decision]] |
| 로컬 aqua 사용 | 비-m1 머신에선 AQUA 비활성(`AQUA=""`) → 항상 일반 tmux | tmux-aqua 있으면 로컬도 aqua 사용 | 새 구조는 host 역할이 m1 고정이 아님 — 더 일반적 |
| presize | COLS/LINES 계산하지만 new-session 에 미적용(死 코드) | `new-session -x/-y` 로 실제 적용 | 레퍼런스 의도 실현(개선) |
| 세션 공유 | (없음 — 단일 attach take-over) | (없음 — 1:1 유지) | 사용자 결정: multi-attach 폐기, 레퍼런스와 동일한 1:1 |

## 발견·수정한 버그 (ralph 중)

1. **`exec tm_local attach`** (line ~200) — `exec` 는 셸 함수를 실행 못 함 → 로컬 aqua take-over attach 가 깨짐. → `exec "$LOCAL_BIN/tmux-aqua" -S "$AQUA_SOCK" attach -d ...` 로 수정. (t_00/t_05 가 검출)
2. **mosh `$REMOTE_BIN/tmux-aqua`** (ralph 직전) — mosh `--` 는 비셸 exec 라 리터럴 `$HOME` 미전개 → tmux-aqua 못 찾음. → 절대경로(`"$HOME/.local/bin/tmux-aqua"`)로 수정. (t_06 s4 가 회귀 가드)

## 결론
- UNINTENTIONAL gap: **0**. 레퍼런스의 모든 핵심 동작이 SAME 또는 의도된 개선으로 매핑됨.
- 헤드리스 미검증(한계): 인터랙티브 mosh attach 실화면, AX 합성입력 실동작, on_tab_close 실트리거, 좀비 kill 실경로 → 사람이 터미널/VNC 로 확인 필요.
