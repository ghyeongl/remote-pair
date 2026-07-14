---
name: host-gui-access
description: host 의 macOS GUI 를 보거나 조작해야 할 때 — 스크린샷·클릭, 메뉴바/창/다이얼로그 확인, 또는 "이 세션에서 computer-use 가 되나?" 불확실할 때 사용. 현재 세션이 RemotePair(Host) 하위인지 판별하는 법($TMUX 소켓이 aqua-tmux-rp.sock 인지)과, 그렇다면 host GUI·computer-use(스크린샷·클릭·타이핑)를 쓸 수 있음을 알려준다.
---

# RemotePair 하위 세션 판별 → host GUI + computer-use 가능

## 활성화 조건 (이게 핵심 — 먼저 판별)
현재 claude 가 RemotePair(Host) 가 띄운 tmux 안에서 도는가?
```bash
case "${TMUX:-}" in *aqua-tmux-rp.sock*) echo yes;; *) echo no;; esac
```
- `yes` → 아래가 성립. (보강 확인: 프로세스 조상에 `RemotePairHost.app`(구 `RemotePair.app`) → `/usr/bin/script` → `tmux-aqua` 체인이 있으면 확실.)
- `no` → 일반 원격/로컬 셸. host GUI 접근 보장 없음.

## 조건 충족 시 (RemotePair-hosted)
이 세션은 host 의 화면기록(SR)+손쉬운사용(AX) grant 를 상속한다.
→ **host GUI 가 존재하고 computer-use(스크린샷·클릭·타이핑)를 쓸 수 있다.**
GUI 확인/검증을 "환경상 불가"라고 건너뛰지 말 것.

- 화면 보기: computer-use 스크린샷(또는 `screencapture -x file.png` 후 확인).
- 승인/권한 다이얼로그는 직접 누르지 말고 `approve` 스킬(`remote-pair approve --for "..."`)로.

## 호스트 앱이 살아있나 / grant 됐나 (오진 방지)
- 메뉴바 앱(RemotePairHost)은 **권한이 없어도 실행된다** — 권한은 computer-use *동작*만 게이트한다.
  CLI 에서 `open` 후 메뉴바에 바로 안 보여도 "죽은" 게 아니다.
- 생존·권한은 추측 말고 한 줄로 확인하라:  `remote-pair status`
  (앱 생존 = launchctl 기준, AX/SR/FDA grant = 앱이 1초마다 쓰는 `~/.remote-pair/logs/status.json` 기준.)
- ⚠ `pgrep` 은 `.app` 번들 프로세스를 자주 못 잡아 "앱 안 떴다" 오인을 부른다. 생존 판단에 쓰지 마라.
