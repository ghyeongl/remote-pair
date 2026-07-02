import { useLocale, type Locale } from "@/hooks/use-locale";

type Dict = Record<string, string>;

const EN: Dict = {
  // Wizard shell
  "shell.back": "Back",
  "shell.next": "Next",
  "shell.getStarted": "Get started",
  "shell.finish": "Finish",
  "shell.continue": "Continue",
  "shell.skip": "Skip",
  "shell.beginSetup": "Begin setup",
  "shell.openXpair": "Open Xpair",

  // Client Welcome
  "client.welcome.title": "Welcome to Xpair",
  "client.welcome.desc":
    "Run Claude Code on a dedicated Mac. It keeps working after you close your laptop.",

  // Consent (shared)
  "consent.crash.title": "Help us squash bugs",
  "consent.crash.desc":
    "If Xpair ever crashes, we can send an anonymous stack trace so we can fix it fast. No file names, no code, no personal data.",
  "consent.crash.label": "Send crash reports",
  "consent.crash.sub": "Anonymous. Only sent when something breaks.",
  "consent.recommended": "Recommended",
  "consent.analytics.title": "Shape what we build next",
  "consent.analytics.desc":
    "Share aggregate feature usage so we know what to improve. Never your file names, code, or keystrokes.",
  "consent.analytics.label": "Share usage analytics",
  "consent.analytics.sub": "Off by default. Change anytime in Settings.",

  // Client Discover
  "discover.title": "Find your host",
  "discover.desc": "Scanning your LAN and Tailscale network for XpairHost.",
  "discover.installedQ": "Is your host installed?",
  "discover.installedDesc":
    "Xpair needs XpairHost running on the Mac you want to reach. If it's already set up, it'll appear here in a moment. Otherwise, install it first and come back.",
  "discover.openHost": "Open host onboarding",
  "discover.rescan": "Rescan",
  "discover.empty.title": "No hosts found",
  "discover.empty.desc":
    "XpairHost needs to be installed on the Mac you want to reach. Run the host onboarding on that Mac, then rescan.",
  "discover.badge.updateNeeded": "Update needed",
  "discover.badge.incompatible": "Incompatible",

  // Client Update
  "update.tooNew.title": "This host is too new",
  "update.tooNew.desc":
    "The host is running a newer major version than this client can talk to. Update this Xpair client to continue, or pick a different host.",
  "update.clientSupports": "Client supports: v0.5.x",
  "update.checkClientUpdates": "Check for client updates",
  "update.pickAnother": "Pick another host",
  "update.upToDate": "is up to date.",
  "update.title": "Update your host",
  "update.descPre": "is running",
  "update.descPost": ". Xpair needs v0.5+ to continue.",
  "update.pushTitle": "Push update to host",
  "update.pushDesc": "Runs remotely over your existing SSH connection.",
  "update.now": "Update now",
  "update.updating": "Updating host",
  "update.updated": "Updated",

  // Client WaitPerm
  "wait.denied.title": "Host denied the request",
  "wait.denied.desc":
    "The person at the host Mac rejected this pairing. If that was you by mistake, try again — otherwise pick a different host.",
  "wait.tryAgain": "Try again",
  "wait.pickAnother": "Pick another host",
  "wait.accepted.title": "Host accepted",
  "wait.accepted.descPre": "Permissions granted on",
  "wait.accepted.descPost": ". You can now set up folder mappings.",
  "wait.title": "Waiting for host to accept",
  "wait.descPre": "A prompt should appear on",
  "wait.descPost": ". Accept it there to continue.",
  "wait.requestingFrom": "Requesting from",

  // Client Mappings
  "map.title": "Folder mappings",
  "map.desc": "Mount host folders on this Mac, or pair folders for two-way sync.",
  "map.empty": "No mappings yet. Add your first below.",
  "map.add": "Add mapping",
  "map.n": "Mapping",
  "map.remove": "Remove mapping",
  "map.modeMount": "Mount",
  "map.modeSync": "Third-party sync",
  "map.mountDesc": "Mount a host folder on this Mac. The local mount location is managed for you.",
  "map.syncDesc": "Use when the same folder already exists on both sides via a third-party sync tool (e.g. Google Drive, Dropbox). Pick the matching folder on the host and on this Mac.",
  "map.hostFolder": "Host folder",
  "map.mountPoint": "Mount point",
  "map.clientFolder": "Local folder",
  "map.choose": "Choose",
  "map.browserTitle": "Choose host folder",
  "map.emptyFolder": "Empty folder",
  "map.selected": "Selected:",
  "map.cancel": "Cancel",
  "map.chooseThis": "Choose this folder",
  "map.localTitle": "Choose local folder",
  "map.localPick": "Choose folder on this Mac…",
  "map.localUnsupported": "Your browser doesn't support the folder picker. Type a path instead.",


  // Client Done
  "done.client.title": "You're all set",
  "done.client.pairedWith": "Paired with",
  "done.client.yourHost": "your host",
  "done.client.workspaceReady": ". Your workspace is ready.",
  "done.host": "Host",
  "done.transport": "Transport",
  "done.mappings": "Mappings",
  "done.folder": "folder",
  "done.folders": "folders",

  // Host Welcome
  "host.welcome.title": "Set up XpairHost",
  "host.welcome.desc":
    "This Mac will run your sessions and accept connections from your client. Setup takes about a minute — tap Begin setup when you're ready.",

  // Host Perm
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

  // Host Engine
  "engine.title": "Choose your engines",
  "engine.desc":
    "Pick at least one coding agent to install on this host. You can add more later from the menu bar.",
  "engine.claude.name": "Claude Code",
  "engine.claude.desc": "Anthropic's coding agent. Best all-round default.",
  "engine.codex.name": "Codex",
  "engine.codex.desc": "OpenAI's coding agent with tool use.",
  "engine.opencode.name": "Opencode",
  "engine.opencode.desc": "Open-source local agent. Bring your own model.",

  // Host Broadcast
  "bc.denied.title": "Request denied",
  "bc.denied.desc":
    "Xpair notified the client that you rejected the request. If it was a mistake, start broadcasting again to allow a new attempt.",
  "bc.broadcastAgain": "Broadcast again",
  "bc.paired.title": "Client paired",
  "bc.paired.desc": "You can keep this Mac running — sessions stay alive 24/7.",
  "bc.pairedWith": "Paired with",
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
    "This Mac is discoverable on your LAN and Tailscale network. Open Xpair on your client to send a pairing request.",
  "bc.thisMac": "This Mac",

  // Host Done
  "done.host.title": "You're paired",
  "done.host.desc":
    "XpairHost is running quietly in the background. From here on, everything lives in the menu bar.",
  "done.host.menubar":
    "Look for the XpairHost icon in your menu bar to view sessions, check status, or stop the host.",
};

const KO: Dict = {
  "shell.back": "이전",
  "shell.next": "다음",
  "shell.getStarted": "시작하기",
  "shell.finish": "완료",
  "shell.continue": "계속",
  "shell.skip": "건너뛰기",
  "shell.beginSetup": "설정 시작",
  "shell.openXpair": "Xpair 열기",

  "client.welcome.title": "Xpair에 오신 것을 환영합니다",
  "client.welcome.desc":
    "전용 Mac에서 Claude Code를 실행하세요. 노트북을 닫아도 계속 작동합니다.",

  "consent.crash.title": "버그 개선을 도와주세요",
  "consent.crash.desc":
    "Xpair에 문제가 생기면 익명 스택 트레이스를 보내주세요. 파일명, 코드, 개인정보는 포함되지 않습니다.",
  "consent.crash.label": "크래시 리포트 전송",
  "consent.crash.sub": "익명. 오류가 발생했을 때만 전송됩니다.",
  "consent.recommended": "권장",
  "consent.analytics.title": "다음에 만들 것을 함께 정해요",
  "consent.analytics.desc":
    "어떤 기능이 얼마나 쓰이는지 집계 데이터를 공유해 주세요. 파일명, 코드, 키 입력은 절대 수집하지 않습니다.",
  "consent.analytics.label": "사용 분석 공유",
  "consent.analytics.sub": "기본은 꺼짐. 설정에서 언제든 변경할 수 있습니다.",

  "discover.title": "호스트 찾기",
  "discover.desc": "LAN과 Tailscale 네트워크에서 XpairHost를 검색합니다.",
  "discover.installedQ": "호스트가 설치되어 있나요?",
  "discover.installedDesc":
    "연결할 Mac에 XpairHost가 실행되어 있어야 합니다. 이미 설정되어 있다면 곧 목록에 나타납니다. 아직이라면 먼저 설치하고 돌아오세요.",
  "discover.openHost": "호스트 온보딩 열기",
  "discover.rescan": "다시 검색",
  "discover.empty.title": "호스트를 찾지 못했습니다",
  "discover.empty.desc":
    "연결할 Mac에 XpairHost를 설치해야 합니다. 해당 Mac에서 호스트 온보딩을 진행한 뒤 다시 검색하세요.",
  "discover.badge.updateNeeded": "업데이트 필요",
  "discover.badge.incompatible": "호환 불가",

  "update.tooNew.title": "호스트 버전이 너무 높습니다",
  "update.tooNew.desc":
    "호스트가 이 클라이언트가 지원하지 않는 상위 메이저 버전을 사용 중입니다. Xpair 클라이언트를 업데이트하거나 다른 호스트를 선택하세요.",
  "update.clientSupports": "클라이언트 지원: v0.5.x",
  "update.checkClientUpdates": "클라이언트 업데이트 확인",
  "update.pickAnother": "다른 호스트 선택",
  "update.upToDate": "은(는) 최신 버전입니다.",
  "update.title": "호스트 업데이트",
  "update.descPre": "은(는) 현재",
  "update.descPost": " 버전입니다. Xpair는 v0.5 이상이 필요합니다.",
  "update.pushTitle": "호스트에 업데이트 전송",
  "update.pushDesc": "기존 SSH 연결을 통해 원격으로 실행됩니다.",
  "update.now": "지금 업데이트",
  "update.updating": "호스트 업데이트 중",
  "update.updated": "업데이트 완료",

  "wait.denied.title": "호스트가 요청을 거절했습니다",
  "wait.denied.desc":
    "호스트 Mac에서 이 페어링을 거절했습니다. 실수였다면 다시 시도하거나, 다른 호스트를 선택하세요.",
  "wait.tryAgain": "다시 시도",
  "wait.pickAnother": "다른 호스트 선택",
  "wait.accepted.title": "호스트가 수락했습니다",
  "wait.accepted.descPre": "다음에서 권한이 부여되었습니다:",
  "wait.accepted.descPost": ". 이제 폴더 매핑을 설정할 수 있습니다.",
  "wait.title": "호스트 승인 대기 중",
  "wait.descPre": "다음 Mac에 프롬프트가 표시됩니다:",
  "wait.descPost": ". 거기서 수락하면 계속됩니다.",
  "wait.requestingFrom": "요청 대상",

  "map.title": "폴더 매핑",
  "map.desc": "호스트 폴더를 이 Mac에 마운트하거나 폴더를 양방향 동기화하세요.",
  "map.empty": "아직 매핑이 없습니다. 아래에서 추가하세요.",
  "map.add": "매핑 추가",
  "map.n": "매핑",
  "map.remove": "매핑 제거",
  "map.modeMount": "마운트",
  "map.modeSync": "서드파티 동기화",
  "map.mountDesc": "호스트 폴더를 이 Mac에 마운트합니다. 로컬 마운트 위치는 자동으로 관리됩니다.",
  "map.syncDesc": "구글 드라이브·드롭박스 등 서드파티 도구로 이미 양쪽에 같은 폴더가 존재할 때 사용합니다. 호스트와 이 Mac 양쪽에서 대응되는 폴더를 선택하세요.",
  "map.hostFolder": "호스트 폴더",
  "map.mountPoint": "마운트 위치",
  "map.clientFolder": "로컬 폴더",
  "map.choose": "선택",
  "map.browserTitle": "호스트 폴더 선택",
  "map.emptyFolder": "빈 폴더",
  "map.selected": "선택됨:",
  "map.cancel": "취소",
  "map.chooseThis": "이 폴더 선택",
  "map.localTitle": "로컬 폴더 선택",
  "map.localPick": "이 Mac에서 폴더 선택…",
  "map.localUnsupported": "이 브라우저는 폴더 선택을 지원하지 않습니다. 경로를 직접 입력하세요.",


  "done.client.title": "모두 준비되었습니다",
  "done.client.pairedWith": "페어링 완료:",
  "done.client.yourHost": "호스트",
  "done.client.workspaceReady": ". 워크스페이스가 준비되었습니다.",
  "done.host": "호스트",
  "done.transport": "전송 방식",
  "done.mappings": "매핑",
  "done.folder": "개 폴더",
  "done.folders": "개 폴더",

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

  "bc.denied.title": "요청을 거절했습니다",
  "bc.denied.desc":
    "요청을 거절했다고 클라이언트에 알렸습니다. 실수였다면 다시 브로드캐스트해 새 시도를 허용하세요.",
  "bc.broadcastAgain": "다시 브로드캐스트",
  "bc.paired.title": "클라이언트 페어링 완료",
  "bc.paired.desc": "이 Mac을 켜두면 세션이 24시간 유지됩니다.",
  "bc.pairedWith": "페어링 완료:",
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
    "이 Mac이 LAN과 Tailscale 네트워크에 검색 가능한 상태입니다. 클라이언트에서 Xpair를 열어 페어링 요청을 보내세요.",
  "bc.thisMac": "이 Mac",

  "done.host.title": "페어링이 완료되었습니다",
  "done.host.desc":
    "XpairHost가 백그라운드에서 조용히 실행 중입니다. 이후 모든 조작은 메뉴 바에서 이뤄집니다.",
  "done.host.menubar":
    "메뉴 바의 XpairHost 아이콘에서 세션 확인, 상태 확인, 호스트 중지가 가능합니다.",
};

const DICTS: Record<Locale, Dict> = { en: EN, ko: KO };

export type TFn = (key: keyof typeof EN | string, vars?: Record<string, string | number>) => string;

function format(str: string, vars?: Record<string, string | number>) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

export function useT(): { t: TFn; locale: Locale } {
  const { locale } = useLocale();
  const dict = DICTS[locale] ?? EN;
  const t: TFn = (key, vars) => format(dict[key] ?? EN[key] ?? String(key), vars);
  return { t, locale };
}
