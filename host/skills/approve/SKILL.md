---
name: approve
description: macOS 승인/권한 다이얼로그(1Password SSH 승인·잠금, Claude-for-Chrome 권한창, 시스템 확인창 등)에 막혀 작업이 진행되지 않을 때 사용. claude 가 직접 누르지 않고, 권한을 가진 RemotePair 앱에 "허용해줘"를 요청만 한다. 어떤 창을 어떻게 허용할지는 RemotePair 가 감지·라우팅한다.
---

# approve — 막힌 승인창 통과 (RemotePair 에 요청)

작업이 macOS 승인/권한 다이얼로그에 막혔을 때, **요청 한 줄**만 하면 된다:

```bash
remote-pair approve                       # 트리거 + 결과 회수 (exit 0=처리됨, 1=실패). PATH(~/.local/bin) 필요.
remote-pair approve --for "1Password"     # 어떤 승인창인지 힌트(권장). 별칭 관대(예: Chrome/Google Chrome → Claude for Chrome)
remote-pair approve --for "Claude for Chrome" --type "key:cmd+return|return"   # ★ 어떻게 승인할지 직접 지정
```
**`--type` 으로 "어떻게 승인할지"를 직접 정해라(권장).** 화면을 보고(이미 computer-use 로 보고 있다) 그 창을
어떻게 통과시킬지 판단해서 넘기면, 라우터가 **그대로** 실행한다(룰 고정에 안 갇힘, 단시간 다회 재시도까지 알아서):
- `--type "key:cmd+return|return"` → 키 전송(여러 후보 순차). 엔터/맥커맨드+엔터 등.
- `--type "key:return"` → 단일 키.
- `--type "ocr:Allow this action"` → 그 버튼 텍스트를 찾아 클릭(키가 안 먹히는 창에서).

**무엇을 고를지 — 그 창에 보이는 승인 단축키/버튼을 그대로 따라라(이미 computer-use 로 화면을 보고 있다):**
- "Allow…" 버튼 옆에 ⏎(Return) → `--type "key:return"`   ·   ⌘⏎(Cmd+Return) → `--type "key:cmd+return"`
- **Claude for Chrome 권한 모달은 `--type "key:cmd+return|return"` 권장** — **Cmd+Return 이 "항상 허용"(다시 안 물음)이라 먼저** 시도해 매 액션마다 반복되는 팝업을 끊는다. Cmd+Return 을 안 받는 모달이면 **Return(1회 허용)으로 자동 폴백**한다(라우터가 후보 키를 순차 시도). 즉 첫째=반복 차단, 둘째=호환 보장.
- 단축키 표시가 없거나 키가 안 먹히는 창 → `--type "ocr:<그 버튼 텍스트>"` (예: `ocr:Allow this action`)
- ⚠️ 검증은 "창이 닫혔나"로만 한다 → 엉뚱한 키가 **Decline 을 눌러 닫혀도 성공처럼 보인다**. 그러니 Allow 단축키가
  **확실할 때만** `key:` 를 써라. 애매하면 버튼 텍스트 `ocr:` 가 안전하다(Allow 버튼만 정확히 누름).

`--for "<무엇>"` 는 보조 힌트다(생략 가능, 별칭 관대: 브라우저명→Claude for Chrome). `--type` 이 있으면 그게 우선, 없으면 `--for` 룰의 기본 방식으로 폴백.
폴백(힌트 없는 동작): `~/.remote-pair/bin/approve` 또는 `touch /tmp/remote-pair.approve-request`.

그게 전부다. 이후는 **RemotePair**(메뉴바 앱, 화면기록+손쉬운사용 granted)가 알아서 한다:
- 화면을 보고(OCR) **어떤 승인창**이 떴는지 감지
- 그 창에 맞는 **액션으로 라우팅** — 1Password→`Authorize` 클릭, Claude-for-Chrome→`Return`(엔터), 일반창→해당 버튼/키
- 트리거 직후 다이얼로그가 늦게 떠도 몇 초간 재시도

## 순서가 중요: 트리거 먼저, 창은 그 다음

라우터는 **트리거 후 기본 ~18초 적응형 폴링**(`RP_WAIT_SECS`)하며 승인창을 기다린다 — 에이전트가 트리거
*후* 수 초 뒤에 창을 띄워도 잡는다. 클릭/키 후엔 **재캡처로 "창이 닫혔는지" 검증**하고, 안 닫혔으면
재시도한다. 결과는 exit 0(성공·검증됨) / 1(시간 내 처리 실패)로 명확하다.

탐지는 **하이브리드**다: OCR 룰(마커 텍스트) 우선 → 미스 시 **haiku 가 "어떤 알려진 승인창인가"만 분류**
(좌표는 OCR 이 담당; haiku 는 라우팅 전용). 룰에 없는 창이면 일반 승인 라벨(Allow/허용/승인/확인…)로 폴백.
haiku 는 구독 claude CLI 로 best-effort 호출 — 없거나 느리면 OCR 룰만으로 동작(`RP_VISION=off` 로 끌 수 있음).

- **승인창이 이미 떠 있을 때** (1Password 등이 다른 프로세스를 막는 중): `remote-pair approve` (블로킹, exit 0=눌림 1=타임아웃) 그대로 쓰면 됨.
- **도구 호출이 Permission denied 로 이미 실패했을 때**: 창은 이미 사라진 상태다. approve 단독 실행은 "no known dialog up"으로 끝난다. 반드시 **논블로킹 폴백(`~/.remote-pair/bin/approve` 또는 trigger touch) → 즉시(7초 내) 실패한 호출 재시도** 순서로. 재시도가 창을 다시 띄우면 폴링 중이던 라우터가 클릭한다. 블로킹 wrapper 를 쓰면 approve 가 끝나길 기다리는 동안 창을 못 띄워 타임아웃된다.

**너(claude)가 할 일은 트리거뿐.** 클릭/키/좌표 같은 "방법"은 절대 직접 하지 마라:
- computer-use 는 권한/승인창에 기본적으로 **막혀있고**,
- osascript/System Events 직접 클릭은 신원(Automation)이 안 맞아 막히며 1Password 는 접근성에 창을 안 보여준다.
→ 그래서 **권한 가진 RemotePair 만** 누를 수 있고, 방법은 RemotePair 가 rules 로 중앙 관리한다.

## 결과 읽고 행동하기 (실패해도 로그로 판단)

`remote-pair approve` 는 **이번 요청에 해당하는 라우터 로그를 그대로 출력**하고 exit code 로 결과를 알린다.
실패 시에도 "왜" 가 로그에 남으니, 너(에이전트)는 그걸 읽고 다음 행동만 정하면 된다:

- **exit 0** = `router: success [id] (창 닫힘 검증)` — 통과. 막혔던 작업을 계속.
- **exit 1 + `click-outcome-unconfirmed`** = 클릭은 보냈지만 실제 승인 결과는 관찰할 수 없음. 즉시 막혔던 작업을 재시도해 그 결과로 판정.
- **1Password** = 감지·포커스 후 `return` → `cmd+return` → `space` → cliclick → System Events click → AXPress 순으로 시도. `RP_OUTCOME_FILE` 결과 채널이 `ok`를 돌려준 경우에만 성공하며, 창 닫힘만으로는 성공하지 않는다. 전부 실패하거나 결과가 없으면 위 `click-outcome-unconfirmed` 계약을 유지. 명시적 `--type`은 이 자동 ladder보다 우선한다.
- **exit 1** = 출력된 라우터 로그를 보고 분기:
  - `no dialog handled within …s` → 창이 (아직) 없음. **논블로킹 재트리거 후 막힌 호출을 즉시 재시도**(창이 그때 뜨면 폴링 중 라우터가 잡음).
  - `[id] 버튼 못찾음` → 창은 맞는데 버튼 라벨이 룰과 다름 → rules.txt 의 action 라벨 보정.
  - `vision → UNKNOWN` 또는 `클릭했으나 닫힘 미확인` → 미지/특이 창. rules.txt 에 규칙 추가하거나, 안 되면 사용자에게 보고.
  - `vision claude rc=…` / `claude CLI 없음` → 비전만 실패(무해). OCR 룰로 동작 중 — 룰에 그 창이 있는지 확인.
- 전체 로그: `~/.remote-pair/logs/remote-pair.log`.

핵심: **실패를 스스로 "복구"하려 애쓰지 말고, 로그를 읽고(재트리거/룰추가/사용자보고) 중 하나를 골라라.** 클릭/좌표는 절대 직접 하지 마라.

## approve 가 "성공"인데도 작업이 계속 실패하면 (★ 오진 방지)

approve 의 `success` 는 **창이 닫혔다**는 뜻이지 **허용됐다**는 보장이 아니다(엉뚱한 키가 Decline 을 눌러도 닫힘).
작업이 계속 막혀도 **"호스트가 죽었다"고 단정하지 마라 — 실제 상태부터 사실로 확인하라**:

```bash
remote-pair status   # 앱 생존(launchctl) + AX/SR/FDA grant(앱 status.json). 추측 아닌 ground truth.
```
- `app NOT running` & `host server down` → 진짜 앱 미기동 → 호스트에서 앱 실행 / `remote-pair host`.
  ⚠ 메뉴바 앱은 **권한 없어도 실행된다.** `pgrep` 으로 "안 보인다"고 죽은 게 아니다(status 는 launchctl 로 판단).
- `app running` 인데 `AX ✗` 또는 `SR ✗` → **실행은 됐지만 grant 안 됨.** approve 가 클릭해도 합성입력이
  안 먹어 "닫힘"처럼 보일 수 있다 → System Settings 에서 손쉬운사용/화면기록 ON (이건 "host down" 이 아니다).
- `AX ✓ SR ✓` 인데도 실패 → **RemotePair 문제 아님.** 둘 중 하나다:
  - 클릭이 **엉뚱한 버튼**(Decline 등)을 눌렀다 → `--type "ocr:<Allow 버튼 텍스트>"` 로 정확히 지정.
  - **RemotePair 밖의 차단** — 브라우저 확장의 per-도메인 권한, 조직 정책(예: "Service Not Allowed"), 네트워크. approve 로 못 푼다(사용자/관리자 영역).

## 새 승인창 추가 (rules.txt)
`~/.remote-pair/rules.txt`, 탭 구분 한 줄 = 한 창:  `id <TAB> 감지마커 <TAB> action`
- 감지마커 = 그 창에만 나오는 고유 문구(OCR 부분일치).
- action = `ocr:Allow|허용|OK`(버튼 텍스트 찾아 클릭) 또는 `key:return`(키 전송, `cmd+return`·`esc` 등).
- 예: `MyApp<TAB>Grant access?<TAB>ocr:Allow|허용`  /  `Some Dialog<TAB>Confirm action<TAB>key:return`
