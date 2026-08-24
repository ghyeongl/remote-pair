# Xpair Requirements

This document is the requirements layer reconstructed from Q-only evidence in [requirements-raw.md](requirements-raw.md). It intentionally excludes assistant answers, implementation reports, tool output, and code-derived status. Each requirement cites representative raw Q IDs.

If a point is not directly supported by user-side Q/request text, it is either omitted or listed under Open Issues.

---

## 0. Product Constitution

### 0.1 Naming

- The product brand is **Xpair**. Legacy `RemotePair` wording should remain only where describing older builds, migration, or historical context. (Q0515, Q0525)
- The user-facing CLI name is `xpair`. If the IDE/onboarding cannot find `xpair`, that is an onboarding/product-flow problem, not something to silently fix outside the flow. (Q0533, Q0534, Q0536, Q0537)
- The exact data folder naming is not fully settled. `.xpair` is the expected product namespace, while `.xpair-ide` appearing as a separate data folder is questioned and needs confirmation. (Q0528)

### 0.2 Host / Client Separation

- Xpair has two different app roles: Host and Client. They should not be collapsed into a single identity because the Host and Client serve different jobs. (Q0343)
- Host is the permission-holding side. It is expected to run on the machine being controlled and to hold the macOS grants needed for computer-use. (Q0245, Q0337, Q0443)
- Client is the user-facing IDE/CLI side. The client experience is where the user connects, opens sessions, sees browser/mapping state, and uses Remote Desktop. (Q0183, Q0261, Q0474)
- The exact Xpair-era bundle identifiers, cask names, display names, and what can or cannot be renamed remain an open migration detail. (Q0509, Q0514, Q0525)

### 0.3 Permission Boundary

- Permission-needing behavior belongs on the Host side. The Host must preserve computer-use ability for the child sessions rather than relying on raw SSH sessions that lose macOS grants. (Q0025, Q0101, Q0245)
- Product logic that does not require macOS grants should remain outside the permission boundary where possible: CLI/skills/rules/web glue can update separately, while grant-requiring sidecars stay inside the permission boundary. (Q0337)
- Screen sharing / Remote Desktop may require grant-bearing components. If it becomes part of the core Xpair viewer, the permission boundary must account for it explicitly. (Q0346, Q0438, Q0474)

### 0.4 GUI Seam

- The GUI should be web-based UI inside a native shell, so it can start as a web UI and later live inside the app/IDE shell without rewriting the product flow. (Q0183)
- Client onboarding is not a workbench tab and not a separate app. It is a standalone pre-workbench window owned by the same IDE app/process. (Q0369, Q0419, Q0421, Q0424, Q0425, Q0426)
- Host onboarding must be accessible from the Host app/menu bar as a product flow, not as unrelated settings screens. (Q0441, Q0442, Q0473, Q0493, Q0494)

---

## 1. Functional Requirements

### 1.1 Install / Distribution

- A new user must be able to start from a simple install path, not from building source locally. User-side builds should be avoided for the normal install. (Q0006, Q0007, Q0020, Q0026)
- The installer must be role-aware: Host and Client have different responsibilities and may require different installed pieces. (Q0021, Q0022, Q0343)
- The install path should support a Claude Code paste-in setup prompt for users who want the agent to drive setup, while still having a manual path. (Q0184)
- Installation and uninstall must be reversible enough that the user can cleanly remove what Xpair installed. (Q0013)
- Homebrew cask distribution remains a raw-backed direction for app delivery and permission persistence discussions, but exact current cask names must be rechecked under the Xpair rename. (Q0169, Q0185, Q0197, Q0514, Q0525)

### 1.2 First-Run Onboarding

- Client onboarding appears before the IDE workbench. The workbench window should not appear alongside it, and onboarding should not be an editor tab. (Q0369, Q0421, Q0424, Q0426)
- Client onboarding closes only after the necessary setup is complete, then the IDE opens into the intended working surface. (Q0369, Q0402, Q0474)
- Host onboarding must exist. It is responsible for getting the Host through the required permission/TCC flow. (Q0441, Q0442, Q0443)
- Permissions and Settings actions should be able to reopen the relevant onboarding step instead of opening disconnected UI. A Settings Configure action may reopen onboarding from scratch. (Q0473, Q0493, Q0494)
- Host key fingerprint should be hidden by default and revealed only when expanded. (Q0430)
- Onboarding must be testable by actually launching and walking through it, and install verification must include checking Remote Desktop where that flow is required. (Q0423, Q0438)

### 1.3 CLI and Agent Tool Gates

- `xpair` CLI availability is a hard product requirement before flows that need it. The onboarding must either install it before the hard gate or block with a clear reason. (Q0533, Q0534, Q0536, Q0537)
- If the user chooses Claude, Codex, or OpenCode support, onboarding should check for that tool and help install/configure required environment variables. (Q0541)
- The Xpair terminal/session picker should include Codex support alongside the other supported agent/session kinds. (Q0540)
- Engine selection is **host-aware and device-first**: the user selects the device/host first, then onboarding probes which engine binaries (Claude Code / Codex / OpenCode) are installed on that host and presents only the available options; an **"Other…"** / install affordance lets the user install a missing engine onto the host. Host setup is responsible for getting the appropriate engine binary installed on the host. (Q0545; refined by user design decision 2026-06-22, superseding the earlier "engine choice before device-name" framing)

### 1.4 Network Discovery and Pairing

- First connection should be LAN-first: scan the local network with Bonjour and offer to connect when another Mac is found. (Q0382, Q0384)
- Tailscale is a fallback, not a prerequisite. If no same-network Mac is found, the product should naturally guide the user toward Tailscale or another fallback path. (Q0383, Q0384)
- The product should verify that discovery actually works on the user's likely topology, including tailnet situations where MagicDNS may be off. (Q0399)
- Multi-account / sign-in installation flows are not fully specified and remain open. (Q0387, Q0440)

### 1.5 Permissions / TCC

- Host onboarding must resolve required macOS permissions before the Host is considered usable. If TCC is not resolved, the app should not proceed as though setup succeeded. (Q0443)
- Permission steps should be broken into understandable onboarding steps rather than left as scattered manual knowledge. (Q0183, Q0443, Q0473)
- Avoid requesting unnecessary permissions. When a grant is needed because a child session or screen component needs it, the document must say so explicitly. (Q0025, Q0101, Q0245)
- Starting XpairHost before any client is acceptable, but with no connected client the Host onboarding is expected to hold at the permission step rather than report completion. (Q0543)

### 1.6 Sessions and Launching

- The product is centered on launching/attaching persistent host sessions from the client. Session identity must not be polluted by Korean or local path text. (Q0056, Q0153, Q0154)
- A new folder/path should not accidentally inherit or pollute an existing session. (Q0157)
- Detached/orphaned session handling is part of the launcher requirement; users should not need to manually reason about stale sockets. (Q0061, Q0062, Q0063)
- The old session-sharing idea is not a requirement unless reintroduced explicitly. The raw-backed direction is one host with multiple clients possible, while individual sessions stay clear and attachable. (Q0096, Q0248)
- Terminal windows/tabs should be restored after the client is closed and reopened, rather than coming back as fresh empty sessions; remembered tab state can be re-applied via `xpair launch` parameters. (Q0546, Q0547)
- Session-name translation should degrade gracefully: if the translation auth fails, fall back to the macOS built-in English converter rather than leaving an untranslated/failed name. (Q0544)

### 1.7 Folder Mapping and File Access

- Xpair assumes files are available on the host and maps client paths to host paths. Parent paths may differ, but the project subtree must correspond. (Q0041, Q0042, Q0043)
- Browser UI must reflect mapping state. If the CLI detects mappings but Browser shows none, the SSOT is broken. (Q0398)
- Client UX should use **Add Mapping**, not generic **Open Folder**, because Xpair does not treat arbitrary local folder opening as the primary flow. (Q0414)
- Mount-first access is preferred for future file access where appropriate; Syncthing/copy-sync is legacy or fallback rather than the only route. (Q0281)
- `.git` should not be synced across machines. `.claude/projects` is too large/private for normal sync and should be excluded from git/sync flows. (Q0003, Q0004, Q0012)

### 1.8 Xpair IDE UX

- The Client should be an IDE built from a VS Code/VSCodium-like base, not a from-scratch editor. (Q0183, Q0248)
- Sessions is the primary container. Browser is opened from the Sessions flow rather than competing as a separate default home surface. (Q0480)
- The default editor area should show Remote Desktop, not a welcome screen. (Q0402, Q0474)
- Browser should show mapped roots and provide Add Mapping. Search/Extensions can exist as child surfaces, but they must not break the Browser frame or mapping SSOT. (Q0398, Q0414, Q0480)
- Terminal/session creation should support Claude, Shell, Codex, and other explicitly supported agents where selected. (Q0261, Q0262, Q0540, Q0541)
- Terminal interaction must work over the remote path: copy/paste (cmd+c / cmd+v) and the close (x) control must function. The user reports paste failing over a remote tmux attach while iTerm works, so the IDE terminal must not regress below that baseline. (Q0550, Q0551)
- `control+tab` should cycle terminal tabs as well, not only editor tabs. (Q0549)

### 1.9 Remote Desktop / Screen Sharing

- Remote Desktop is a core Client IDE surface, not merely a later documentation note. The user expects IDE installation verification to include checking that Remote Desktop actually works. (Q0346, Q0438, Q0474)
- For one older release line, the user asked to remove screen sharing from `0.4.12`; that should be documented as version-specific and not used to erase the later Remote Desktop requirement. (Q0370, Q0438)
- The product should avoid carrying both v1 and v2 variants indefinitely when the intended direction is v2-only. Exact protocol details remain open unless separately specified. (Q0348, Q0349, Q0350)
- RustDesk was useful as a comparison target, but the experimental `-ide2` path was not itself the intended product direction. (Q0280, Q0313)
- Remote Desktop must reconnect reliably across launches. The user reports RD failing to connect (stuck "connecting to host") from the second launch onward, so RD connection must be stable on repeated/subsequent sessions, not only on first connect. (Q0548, Q0552)

### 1.10 Approve / Permission Dialog Automation

- Approve should be triggered through the product CLI/skill flow rather than a raw file-touch UX. (Q0015, Q0016)
- Approve handling must account for permission prompts, Claude Code terminal prompts, Chrome/site-level permission blocks, 1Password prompts, and recording-related windows where they block unattended host sessions. (Q0103, Q0104, Q0114, Q0129, Q0142)
- Keyboard handling should work for cases where mouse/OCR alone is insufficient. The `cmd+enter` then `enter` behavior remains a requirement where supported. (Q0142)
- Persist auto-detection is intentionally not a requirement unless the user reopens it. (Q0108)

### 1.11 Notifications

- Host-side completion, Stop, Ask-a-question, and approve notifications should be forwarded to the Client. (Q0183, Q0248)
- Notification settings must let the user choose which notification kinds are enabled. (Q0183)
- Approve notifications should include approval type where possible. (Q0183)

### 1.12 Logging, Crash Reporting, and Telemetry

- Users must be able to collect logs after a crash or failed setup and send a readable diagnostic bundle. (Q0380, Q0400)
- Sentry is the preferred crash/error reporting tool. PostHog is the preferred funnel/product analytics tool. (Q0385, Q0401, Q0403)
- Host should also be covered by Sentry/PostHog if telemetry is enabled, and onboarding must expose the opt-in decision. (Q0448)
- Crash-report default is open: the user asked whether crash reports could be opt-out, while other telemetry discussion points toward opt-in. Do not silently decide this in the requirements. (Q0448, Q0449)
- Telemetry must serve first-run hardening, not vanity analytics. (Q0385)

### 1.13 Documentation

- README/install docs should be beginner-oriented and include the Claude Code paste-in prompt, manual install path, brew guidance, Remote Login/SSH guidance, folder mapping explanation, security warning, and troubleshooting path. (Q0088, Q0177, Q0184, Q0185, Q0193, Q0197, Q0201)
- Korean copy should avoid translationese and keep technical proper nouns where they are clearer in English. (Q0202)
- Documentation should track the new Xpair naming and not leave stale RemotePair install guidance as the primary path. (Q0515, Q0525)

---

## 2. Non-Functional Requirements

- Target platform is Apple Silicon Mac for the supported host/client path unless the user explicitly expands scope. (Q0024)
- Normal users should not need to build binaries locally. Prebuilt distribution is a requirement. (Q0007, Q0025, Q0026)
- Xpair is open source. The user did not ban AGPL; AGPL-3.0 is acceptable as a product license direction. (Q0008, Q0310, Q0311, Q0313)
- Do not claim RustDesk AGPL independence or permissive-only dependency guarantees unless those are separately proven. (Q0310, Q0313, Q0333)
- Security copy must be explicit that Xpair intentionally lowers macOS safety guardrails on the Host and the user is responsible for careless use. (Q0088)
- State boundary is an explicit product requirement, not an implementation detail: early Qs raise `.claude` sync/config as necessary for RemotePair/Xpair to work, approve logic belongs in a Claude skill, later Qs reference app-owned state such as `~/.remote-pair/host`, and the Xpair-era data folder name remains unsettled. (Q0009, Q0010, Q0011, Q0303, Q0528)
- Release channels must distinguish alpha/beta/prerelease/stable tracks. Suggested naming includes `0.5.0a1`, `aN`, `b1`, and prerelease uploads. (Q0415, Q0444, Q0446, Q0482, Q0484, Q0497, Q0527)
- App update UI such as **Check for updates...** should be used to verify prerelease update behavior where applicable. (Q0482)

---

## 3. Raw-Backed Decisions

- Product brand moves to **Xpair**. (Q0515, Q0525)
- Host and Client identities stay separated. (Q0343)
- Client onboarding is a pre-workbench standalone window in the same IDE app/process. (Q0369, Q0419, Q0421, Q0424, Q0425, Q0426)
- Host onboarding exists and blocks on unresolved TCC. (Q0441, Q0442, Q0443)
- Discovery is LAN/Bonjour first, Tailscale fallback second. (Q0382, Q0383, Q0384)
- IDE default surface is Remote Desktop, not welcome. (Q0402, Q0474)
- Browser flow uses Add Mapping, not generic Open Folder. (Q0414)
- Xpair terminal/session support includes Codex where selected. (Q0540, Q0541)
- AGPL is allowed; do not revert licensing away from AGPL without a user decision. (Q0310, Q0311, Q0313, Q0333)
- Prerelease tracks are required before stable release confidence. (Q0415, Q0444, Q0482, Q0497, Q0527)

---

## 4. Open Issues

- Exact Xpair-era bundle identifiers, cask tokens, display names, and data folder names need a final rename matrix. (Q0509, Q0514, Q0525, Q0528)
- Whether crash reports are opt-in or opt-out remains undecided. Product analytics should not be silently enabled. (Q0448, Q0449)
- Exact current prerelease number/channel must be checked before publishing or documenting a release. (Q0446, Q0497, Q0527)
- The conflict between `0.4.12` screen-sharing removal and later Remote Desktop-as-default must be documented per release line. (Q0370, Q0438, Q0474)
- The six-digit / sign-in / host-install pairing UX is not fully specified. (Q0430, Q0440)
- The RustDesk comparison should not be treated as a product direction unless the user explicitly reopens it. (Q0280, Q0313)
- Implementation status must be sourced from a separate verification pass, not inferred from this requirements document. (Q0429, Q0438)

---

## 5. Priority Roadmap

1. **M1: Onboarding hardening** - Client pre-workbench onboarding, Host onboarding, TCC blocking, `xpair` CLI gate, selected agent tool gates. (Q0369, Q0419, Q0441, Q0443, Q0533, Q0536, Q0541)
2. **M2: Install and pairing** - Xpair naming, role-aware install, LAN Bonjour discovery, Tailscale fallback, host install from client onboarding. (Q0382, Q0383, Q0384, Q0440, Q0515, Q0525)
3. **M3: IDE shell UX** - Sessions-first Client, Browser mapping SSOT, Add Mapping, Codex support, RD default editor area. (Q0398, Q0402, Q0414, Q0474, Q0480, Q0540)
4. **M4: Remote Desktop verification** - Verify IDE RD works as part of install/onboarding validation; resolve version-specific screen-sharing scope. (Q0346, Q0370, Q0438, Q0474)
5. **M5: Observability** - log collection, Sentry crashes, PostHog funnel, Host coverage, onboarding opt-in/default decision. (Q0380, Q0385, Q0401, Q0403, Q0448, Q0449)
6. **M6: Release channel discipline** - alpha/beta/prerelease naming, Check for updates validation, stable promotion after evidence. (Q0415, Q0444, Q0482, Q0497, Q0527)
