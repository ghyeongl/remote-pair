import { createUseT, type Dict } from "@shared/lib/i18n";

export type { Locale, TFn } from "@shared/lib/i18n";

const EN: Dict = {
  "host.welcome.title": "Set up XpairHost",
  "host.welcome.desc":
    "This Mac will run your sessions and accept connections from your client. Setup takes about a minute — tap Begin setup when you're ready.",

  "perm.of": "Permission {n} of {total}",
  "perm.granted": "Granted — you can continue",
  "perm.recommendedContinue": "Recommended — you can continue",
  "perm.openSettings": "Open Settings",
  "perm.waiting": "Waiting for you in Settings…",
  "perm.login.name": "Remote Login (SSH)",
  "perm.login.desc": "Lets your client Mac reach this Mac over SSH. Required for the connection.",
  "perm.login.pane": "System Settings → General → Sharing → Remote Login",
  "perm.ax.name": "Accessibility",
  "perm.ax.desc": "Allows the client to move the mouse and send keystrokes on this Mac.",
  "perm.ax.pane": "System Settings → Privacy & Security → Accessibility",
  "perm.sr.name": "Screen Recording",
  "perm.sr.desc": "Captures the screen so the client can see this Mac's display.",
  "perm.sr.pane": "System Settings → Privacy & Security → Screen Recording",
  "perm.fda.name": "Full Disk Access",
  "perm.fda.desc": "Lets Xpair read files in protected locations like Documents and Desktop.",
  "perm.fda.pane": "System Settings → Privacy & Security → Full Disk Access",
  "perm.sharing.name": "File Sharing",
  "perm.sharing.desc": "Exposes the folders you map so the client can mount them.",
  "perm.sharing.pane": "System Settings → General → Sharing → File Sharing",

  "engine.title": "Choose your engines",
  "engine.desc":
    "Pick at least one coding agent to install on this host. You can add more later from the menu bar.",
  "engine.claude.name": "Claude Code",
  "engine.claude.desc": "Anthropic's coding agent. Best all-round default.",
  "engine.codex.name": "Codex",
  "engine.codex.desc": "OpenAI's coding agent with tool use.",
  "engine.opencode.name": "Opencode",
  "engine.opencode.desc": "Open-source local agent. Bring your own model.",
  "engine.shell.name": "Shell",
  "engine.shell.desc": "A plain login shell — no AI agent, no install or sign-in.",

  "bc.denied.title": "Request denied",
  "bc.denied.desc":
    "Xpair notified the client that you rejected the request. If it was a mistake, start broadcasting again to allow a new attempt.",
  "bc.broadcastAgain": "Broadcast again",
  "bc.paired.title": "Client paired",
  "bc.paired.desc": "You can keep this Mac running — sessions stay alive 24/7.",
  "bc.pairedWith": "Paired with",
  "bc.pairAnother": "Pair a different device",
  "bc.pending.title": "Waiting for SSH proof",
  "bc.pending.desc":
    "The exact key was installed. Keep this open while the client connects once with that key.",
  "bc.incoming.title": "Incoming pairing request",
  "bc.incoming.desc":
    "Compare the fingerprint below with what the client is showing. Only accept if they match — the name alone can be spoofed.",
  "bc.from": "From",
  "bc.fingerprint": "Client key fingerprint",
  "bc.warnTitle": "What accepting allows",
  "bc.warn1": "Authorize this exact client key through Xpair's restricted SSH gate",
  "bc.warn2": "Run Xpair-managed setup and session commands as this macOS user",
  "bc.warn3": "Agent, port, X11, and user-rc forwarding stay disabled for this key",
  "bc.warnRevoke": "You can revoke access anytime from the menu bar.",
  "bc.deny": "Deny",
  "bc.accept": "Accept",
  "bc.title": "Broadcasting",
  "bc.desc":
    "This Mac is discoverable on your same network and Tailscale. Open Xpair on your client to send a pairing request.",
  "bc.thisMac": "This Mac",

  "done.host.title": "You're paired",
  "done.host.desc":
    "XpairHost is running quietly in the background. From here on, everything lives in the menu bar.",
  "done.host.menubar":
    "Look for the XpairHost icon in your menu bar to view sessions, check status, or stop the host.",
};

const KO: Dict = {
  "host.welcome.title": "XpairHost 설정",
  "host.welcome.desc":
    "이 Mac이 세션을 실행하고 클라이언트 연결을 수락합니다. 약 1분 정도 걸립니다. 준비되면 '설정 시작'을 누르세요.",

  "perm.of": "권한 {n} / {total}",
  "perm.granted": "허용됨 — 계속 진행할 수 있습니다",
  "perm.recommendedContinue": "권장 항목입니다 — 계속 진행할 수 있습니다",
  "perm.openSettings": "설정 열기",
  "perm.waiting": "설정에서 조작을 기다리는 중…",
  "perm.login.name": "원격 로그인 (SSH)",
  "perm.login.desc": "클라이언트 Mac이 이 Mac에 SSH로 접근하도록 허용합니다. 연결에 필수입니다.",
  "perm.login.pane": "시스템 설정 → 일반 → 공유 → 원격 로그인",
  "perm.ax.name": "손쉬운 사용",
  "perm.ax.desc": "클라이언트가 이 Mac의 마우스를 움직이고 키 입력을 보낼 수 있게 합니다.",
  "perm.ax.pane": "시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용",
  "perm.sr.name": "화면 기록",
  "perm.sr.desc": "화면을 캡처해 클라이언트가 이 Mac 화면을 볼 수 있게 합니다.",
  "perm.sr.pane": "시스템 설정 → 개인정보 보호 및 보안 → 화면 기록",
  "perm.fda.name": "전체 디스크 접근",
  "perm.fda.desc": "문서, 데스크탑 등 보호된 위치의 파일을 Xpair가 읽도록 허용합니다.",
  "perm.fda.pane": "시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근",
  "perm.sharing.name": "파일 공유",
  "perm.sharing.desc": "매핑한 폴더를 클라이언트가 마운트할 수 있도록 노출합니다.",
  "perm.sharing.pane": "시스템 설정 → 일반 → 공유 → 파일 공유",

  "engine.title": "엔진 선택",
  "engine.desc":
    "이 호스트에 설치할 코딩 에이전트를 하나 이상 선택하세요. 나중에 메뉴 바에서 추가할 수 있습니다.",
  "engine.claude.name": "Claude Code",
  "engine.claude.desc": "Anthropic의 코딩 에이전트. 가장 균형 잡힌 기본값.",
  "engine.codex.name": "Codex",
  "engine.codex.desc": "도구 사용을 지원하는 OpenAI 코딩 에이전트.",
  "engine.opencode.name": "Opencode",
  "engine.opencode.desc": "오픈소스 로컬 에이전트. 원하는 모델을 사용하세요.",
  "engine.shell.name": "셸",
  "engine.shell.desc": "일반 로그인 셸 — AI 에이전트 없음, 설치·로그인 불필요.",

  "bc.denied.title": "요청을 거절했습니다",
  "bc.denied.desc":
    "요청을 거절했다고 클라이언트에 알렸습니다. 실수였다면 다시 브로드캐스트해 새 시도를 허용하세요.",
  "bc.broadcastAgain": "다시 브로드캐스트",
  "bc.paired.title": "클라이언트 페어링 완료",
  "bc.paired.desc": "이 Mac을 켜두면 세션이 24시간 유지됩니다.",
  "bc.pairedWith": "페어링 완료:",
  "bc.pairAnother": "다른 기기 페어링",
  "bc.pending.title": "SSH 증명 대기 중",
  "bc.pending.desc":
    "정확한 키를 설치했습니다. 클라이언트가 그 키로 한 번 연결할 때까지 이 창을 열어두세요.",
  "bc.incoming.title": "들어온 페어링 요청",
  "bc.incoming.desc":
    "아래 지문을 클라이언트에 표시된 값과 대조하세요. 일치할 때만 수락하세요 — 이름만으로는 위조될 수 있습니다.",
  "bc.from": "요청자",
  "bc.fingerprint": "클라이언트 키 지문",
  "bc.warnTitle": "수락 시 허용되는 것",
  "bc.warn1": "이 클라이언트 키만 Xpair의 제한된 SSH 게이트로 승인",
  "bc.warn2": "이 macOS 사용자 권한으로 Xpair가 관리하는 설정 및 세션 명령 실행",
  "bc.warn3": "이 키에는 에이전트, 포트, X11, user-rc 포워딩을 계속 비활성화",
  "bc.warnRevoke": "메뉴 바에서 언제든지 권한을 회수할 수 있습니다.",
  "bc.deny": "거절",
  "bc.accept": "수락",
  "bc.title": "브로드캐스트 중",
  "bc.desc":
    "이 Mac이 같은 네트워크와 Tailscale에서 검색 가능한 상태입니다. 클라이언트에서 Xpair를 열어 페어링 요청을 보내세요.",
  "bc.thisMac": "이 Mac",

  "done.host.title": "페어링이 완료되었습니다",
  "done.host.desc":
    "XpairHost가 백그라운드에서 조용히 실행 중입니다. 이후 모든 조작은 메뉴 바에서 이뤄집니다.",
  "done.host.menubar":
    "메뉴 바의 XpairHost 아이콘에서 세션 확인, 상태 확인, 호스트 중지가 가능합니다.",
};

export const useT = createUseT({ en: EN, ko: KO });
