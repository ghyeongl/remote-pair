# spec.md — xpair requirements (authoritative)

The requirement list the implementer's brief is drawn from. Built against the CEO's intent as recorded in `requirements.md` (Q-cited reconstruction) and `requirements-raw.md` (Q0001–Q0552, the utterance corpus). `register.md` traces each id back to the utterance. `requirements.md` remains the prose source; this file is the id/priority/tag/falsifier layer over it.

**Tags** — `[사실]` CEO said it (register row / Q-backed) · `[파생]` follows from ≥2 facts (carries falsifier) · `[보간]` filled by PM (carries falsifier) · `[봉인]` deliberately undecided. An untagged line is treated as nonexistent.

**Priority** — inherited from the `requirements.md` M1–M6 roadmap, which is **dependency-derived, not goal-derived** (domain ledger is empty, awaiting CEO — see `pm-memo.md`). Subject to reversal when O/KR lands. `open` = unsettled, blocks nothing until decided.

**Falsifier** — only `[보간]`/`[파생]` carry one. Q-backed `[사실]` rows cite Qs in place of a falsifier.

**Two layers, and the LIVE one is the corpus.** Sections 0–4 are the requirement corpus reconstructed from the Q-utterances (2026-06) — this is the **live 0.4.13 product's intent** and it governs. Section −1 records the **0.5/0.6 engineering direction, which the CEO ABANDONED** (2026-08-21); it is history, governs nothing, and its "supersession map" never shipped. Where −1 and 0–4 disagree, 0–4 wins because −1 is dead. (Earlier in this session −1 was mistakenly framed as the newer governing layer, before the CEO confirmed 0.5/0.6 were scrapped.)

---

## −1. 0.5 / 0.6 line — ABANDONED (CEO, 2026-08-21). Live base is 0.4.13.

> **CEO 2026-08-21:** *"원래 0.5 0.6 만드려던 건 폐기했고... 내가 쓰는 용도로 지금은 0.4.13 돌리고 있어. 너도 0.4.13 위에서 돌고있어."*

**The 0.5.x Xpair line and the 0.6.0 roadmap below were scrapped.** They are recorded here as history, not direction. Do not treat `roadmap-0.6.0.md`, its "engineering SSoT" label, or the supersession map as governing — the CEO reverted to the 0.4 line for actual use.

**Live base = 0.4.13** (`remote-pair`), verified in-repo:
- tag `v0.4.13`, branch `origin/release/v0.4.13`.
- installed & **running** at `~/.remote-pair` (`.version` = `0.4.13`; app healthy, pid ~1210). This session runs on it.
- 0.4.13 is the legacy pre-rename `remote-pair` line; the corpus §0–4 (0.4.x-era intent) is **the live product's intent**, not a superseded one.

**The abandoned `develop` worktree** (0.5.x monorepo + these 0.6.0 docs, git HEAD `v0.5.1a13`+19) is where this record was first authored — **placement RESOLVED: this record lives on `release/v0.4.13`** (the live line), placed via PR #120 alongside its provenance sources. See `pm-memo.md`.

**Consequence for the approve items:** #2's real target is the **0.4.13 `remote-pair-approve-router.sh`** (same `dialog_gone`-only success bug confirmed at lines **145 / 155**, `dialog_gone()` @117), **not** the abandoned-line `xpair-approve-router.sh` 143/153 the brief named. The bug lineage is shared; the file to fix is the live one.

*(The 0.6.0 D1–D6 decisions that were in this section are retained below the fold only as abandoned-line history; they govern nothing.)*

<details><summary>Abandoned 0.6.0 roadmap decisions (history only — govern nothing)</summary>

These were settled engineering decisions on the scrapped 0.6.0 line. Kept for provenance.

| id | tag | decision | source / falsifier |
|---|---|---|---|
| REQ-06-IDENTITY | [사실] | Xpair is **infrastructure that owns and keeps alive an agent-dedicated Mac** — the machine/daemon layer (host, session, GUI login context). Tools on top (Orca, cmux, VS Code, iTerm, Claude Code) are **bring-your-own**; Xpair does not build or replace them. Litmus for every feature: strengthen the **daemon**, not the workbench | roadmap-0.6.0.md:9-16 |
| REQ-06-D1 | [사실] | **Protocol is core** (pairing, session, revival, intervention); the VSCodium workbench is a **"reference client," FROZEN** — onboarding + intervention window + basic terminal only, **no new IDE features** (no worktree UI, diff viewer, code-review surface) | roadmap-0.6.0.md:18-24 |
| REQ-06-D2 | [사실] | **System sshd (macOS Remote Login) is the standard front door**; no custom SSH server. Reachability is **tailnet-only, fail-closed at the packet layer** (`pf` admits `:22` only on the tailscale utun; `ListenAddress` is not fail-closed under launchd socket-activation; tsnet rejected) | roadmap-0.6.0.md:26-37, design-d2-ssh-frontdoor.md |
| REQ-06-D2b | [사실] | **Access ≠ session.** ForceCommand routes on `SSH_ORIGINAL_COMMAND`/subsystem first: sftp→sftp-server, exec/scp/rsync/VS Code bootstrap→passthrough login shell, bare interactive→plain login shell (no auto tmux). The computer-use session is entered explicitly via `xpair launch` (host picker; local host attaches directly, `Target::Local`). Any standards-compliant SSH client works with zero per-tool integration | roadmap-0.6.0.md:38-56, design-session-model.md:29-30,98-113 |
| REQ-06-D3 | [사실] | **GUI broker** — a daemon resident in the GUI login session (the moat raw sshd can't replicate). It **answers/approves TCC consent prompts** against an explicit whitelist with an audit log (responding to live prompts, not silent API grants — the one-time AX+SR grant stays manual), and brokers computer-use + Claude-in-Chrome for BYO agents that can't run in tmux-aqua | roadmap-0.6.0.md:66-82, design-session-model.md:63-85 |
| REQ-06-D4 | [사실] | **Host filesystem is the single source of truth; all two-way sync (Syncthing, any mirror) is BANNED.** Daemon holds one host cwd string per session; the client owns folder browsing; Xpair implements no file manager | roadmap-0.6.0.md:83-88 |
| REQ-06-D5 | [사실] | Workbench executes **locally**; the Finder **"Open with Xpair" dropdown is the onboarding heart** for non-developers (stays local). "Folder access" = open the **remote** file over a remote protocol, not mount it. **Migrate SMB mount → open-remote-ssh** (OSS ext via Open VSX); `extension.js`+its test currently forbid `openremotessh.openEmptyWindow` and must be **changed**, not preserved | roadmap-0.6.0.md:90-103 |
| REQ-06-D5b | [사실] | **Drop the macOS File Sharing (`sharing`) permission gate** when SMB is removed — it exists only for the SMB mount; the SSH Remote Login gate stays. Falsifier: any non-SMB consumer of `sharing` in the host permission model | roadmap-0.6.0.md:104-107 |
| REQ-06-D6 | [사실] | Orca/cmux/upper-tool compatibility via **standards compliance + a compatibility matrix (client × capability)**, never per-tool integration code | roadmap-0.6.0.md:109-114 |
| REQ-06-PAIR | [사실] | Hardened cryptographic pairing (post codex-challenge): client sends a signed request carrying its real pubkey; host verifies signature (proof-of-possession, nonce+timestamp anti-replay), computes the fingerprint locally, user eyeball-compares the full SHA256 SAS, host installs only that exact key, final SSH-proof binding before `paired`. Ephemeral pairing endpoint open **only** while the Broadcast step is visible (no permanent inbound port). `authorized_keys` hardened via a restricted `xpair-ssh-gate` key line | onboarding-redesign-blueprint.md:124-158 |
| REQ-06-ONBOARD | [사실] | Onboarding rebuilt as **two separate Electron windows** (host in XpairHost, client in the IDE) over IPC — the prior localhost-HTTP web wizard was fully removed. Host onboarding is **hard-gated on a client actually pairing**. Every step is a **self-healing "parachute guard"**: re-probes its precondition on entry/re-entry, auto-bounces to the repair step, and resumes across the TCC-forced app restart (persist to disk, land on first unmet step, never restart at 0). Permission gates are five: `[login(Remote Login), ax, sr, fda, sharing]` (sharing to drop under REQ-06-D5b) | architecture.md:158-168, onboarding-redesign-blueprint.md:71,73,87-121, onboarding-flow.md:90 |
| REQ-06-WIN | [사실] | **Windows CLIENT support planned** (host stays macOS-only forever); a Windows machine pairs with a Mac host. The **Rust CLI (`cli-rs`) is the only Windows CLI** — no bash/WSL/MSYS; Darwin-only verbs (`approve`, host app-start) hard-gate on win32 with exit 2, never faked. `.msi` via GitHub Releases, unsigned for now; SMB consumed as UNC paths, no mount verb | win32-client-roadmap.md:4,10-12,34-42,57-65,84 |
| REQ-06-STATE | [사실] | Runtime state split by role into `~/.xpair/{host,client,ide,ide-server}` so uninstalling one role can't delete another's files (was a single `~/.remote-pair`) | client-runtime-dir-split.md:1-18 |

### Supersession map (0.6.0 over the corpus)

| corpus id | status under 0.6.0 | governing id |
|---|---|---|
| REQ-MAP-4 (mount-first, Syncthing fallback) | **superseded** — all two-way sync banned; SMB mount → open-remote-ssh | REQ-06-D4, REQ-06-D5 |
| REQ-NET-1/2 (LAN Bonjour first) | **refined** — LAN is discovery/pairing only; SSH transport is tailnet-only | REQ-06-D2 |
| REQ-IDE-2/3/4 (Sessions-first IDE, RD default surface, Browser SSOT) | **frozen** — remains as reference-client behavior, but no new IDE investment | REQ-06-D1 |
| REQ-TCC-* / REQ-APPROVE-* (permission handling) | **relocated** — the ongoing-prompt answering is the D3 GUI broker's job; approve items #2/#3 (`pm-memo.md`) sit inside this moat | REQ-06-D3 |
| REQ-NFR-6 (`~/.remote-pair` app-owned state) | **superseded** — role-split runtime dirs | REQ-06-STATE |
| REQ-ONBOARD-* (web-based onboarding) | **refined** — same intent, now two Electron windows + parachute guard + crypto pairing | REQ-06-ONBOARD, REQ-06-PAIR |

*(Abandoned-line ordering, retained as history: Pairing #97 → D2 SSH front door → D3 GUI broker → D5 open-remote-ssh. Governs nothing — the line was scrapped.)*

</details>

**Live direction is the 0.4.13 corpus (§0–4 below) until the CEO/VP sets a new O/KR.** The M1–M6 corpus roadmap is the working feature-area map for the live line.

---

## 0. Product constitution

| id | pri | tag | requirement | source / falsifier |
|---|---|---|---|---|
| REQ-NAME-1 | M2 | [사실] | Product brand is **Xpair**; `RemotePair` wording survives only in migration/historical context | Q0515, Q0525 |
| REQ-NAME-2 | M1 | [사실] | User-facing CLI is `xpair`; if IDE/onboarding can't find `xpair`, that is a product-flow problem, not a silent side-fix | Q0533, Q0534, Q0536, Q0537 |
| REQ-NAME-3 | open | [봉인] | Data-folder naming unsettled: `.xpair` is the expected namespace; `.xpair-ide` as a separate folder is questioned | Q0528 |
| REQ-ROLE-1 | M1 | [사실] | Host and Client are two distinct app roles, not one collapsed identity | Q0343 |
| REQ-ROLE-2 | M1 | [사실] | Host is the permission-holding side: runs on the controlled machine, holds macOS grants for computer-use | Q0245, Q0337, Q0443 |
| REQ-ROLE-3 | M3 | [사실] | Client is the user-facing IDE/CLI side: connect, open sessions, see mapping/browser state, use Remote Desktop | Q0183, Q0261, Q0474 |
| REQ-ROLE-4 | open | [봉인] | Xpair-era bundle ids, cask names, display names, rename matrix — undecided | Q0509, Q0514, Q0525 |
| REQ-PERM-1 | M1 | [사실] | Permission-needing behavior lives on Host; Host preserves computer-use for child sessions rather than raw SSH that loses grants | Q0025, Q0101, Q0245 |
| REQ-PERM-2 | M2 | [사실] | Non-grant product logic (CLI/skills/rules/web glue) stays outside the permission boundary and can update separately; grant-requiring sidecars stay inside | Q0337 |
| REQ-PERM-3 | M4 | [사실] | If Remote Desktop becomes core viewer, the permission boundary must account for its grant-bearing components explicitly | Q0346, Q0438, Q0474 |
| REQ-GUI-1 | M3 | [사실] | GUI is web-based UI inside a native shell — can start as web UI, later live in app/IDE shell without rewriting the flow | Q0183 |
| REQ-GUI-2 | M1 | [사실] | Client onboarding is a standalone pre-workbench window owned by the same IDE app/process — not a tab, not a separate app | Q0369, Q0419, Q0421, Q0424, Q0425, Q0426 |
| REQ-GUI-3 | M1 | [사실] | Host onboarding is reachable from the Host app/menu bar as a product flow, not scattered settings screens | Q0441, Q0442, Q0473, Q0493, Q0494 |

## 1. Functional

| id | pri | tag | requirement | source / falsifier |
|---|---|---|---|---|
| REQ-INSTALL-1 | M2 | [사실] | New user starts from a simple install path, not a local source build | Q0006, Q0007, Q0020, Q0026 |
| REQ-INSTALL-2 | M2 | [사실] | Installer is role-aware — Host and Client install different pieces | Q0021, Q0022, Q0343 |
| REQ-INSTALL-3 | M2 | [사실] | Install supports a Claude Code paste-in setup prompt, plus a manual path | Q0184 |
| REQ-INSTALL-4 | M2 | [사실] | Install/uninstall is reversible — user can cleanly remove what Xpair installed | Q0013 |
| REQ-INSTALL-5 | M2 | [사실] | Homebrew cask distribution is the delivery direction; exact cask tokens must be re-checked under the rename | Q0169, Q0185, Q0197, Q0514, Q0525 |
| REQ-ONBOARD-1 | M1 | [사실] | Client onboarding shows before the workbench; workbench must not appear alongside it; not an editor tab | Q0369, Q0421, Q0424, Q0426 |
| REQ-ONBOARD-2 | M1 | [사실] | Client onboarding closes only after required setup completes, then IDE opens to the working surface | Q0369, Q0402, Q0474 |
| REQ-ONBOARD-3 | M1 | [사실] | Host onboarding exists and carries the Host through the required permission/TCC flow | Q0441, Q0442, Q0443 |
| REQ-ONBOARD-4 | M1 | [사실] | Permissions/Settings actions reopen the relevant onboarding step; a Settings Configure action may reopen onboarding from scratch | Q0473, Q0493, Q0494 |
| REQ-ONBOARD-5 | M1 | [사실] | Host key fingerprint hidden by default, revealed on expand | Q0430 |
| REQ-ONBOARD-6 | M4 | [사실] | Onboarding is testable by launching and walking it; install verification includes checking Remote Desktop where required | Q0423, Q0438 |
| REQ-CLI-1 | M1 | [사실] | `xpair` CLI availability is a hard gate before flows needing it: install before the gate, or block with a clear reason | Q0533, Q0534, Q0536, Q0537 |
| REQ-CLI-2 | M1 | [사실] | If user picks Claude/Codex/OpenCode, onboarding checks for it and helps install/configure required env vars | Q0541 |
| REQ-CLI-3 | M3 | [사실] | Terminal/session picker includes Codex alongside other supported agent kinds | Q0540 |
| REQ-CLI-4 | M1 | [사실] | Engine selection is host-aware, device-first: pick device/host first, then probe installed engine binaries on that host and present only available ones, with an "Other…"/install affordance; host setup installs the engine | Q0545 (refined by user decision 2026-06-22, superseding "engine choice before device-name") |
| REQ-NET-1 | M2 | [사실] | First connection is LAN-first: Bonjour-scan the local network and offer to connect when another Mac is found | Q0382, Q0384 |
| REQ-NET-2 | M2 | [사실] | Tailscale is a fallback, not a prerequisite; guide toward it when no same-network Mac is found | Q0383, Q0384 |
| REQ-NET-3 | M2 | [사실] | Verify discovery works on the user's likely topology, incl. tailnets with MagicDNS off | Q0399 |
| REQ-NET-4 | open | [봉인] | Multi-account / sign-in installation flows — not fully specified | Q0387, Q0440 |
| REQ-TCC-1 | M1 | [사실] | Host onboarding resolves required macOS permissions before Host is usable; unresolved TCC must not report success | Q0443 |
| REQ-TCC-2 | M1 | [사실] | Permission steps are broken into understandable onboarding steps, not scattered manual knowledge | Q0183, Q0443, Q0473 |
| REQ-TCC-3 | M1 | [사실] | Avoid unnecessary permissions; when a grant is needed (child session / screen component), the doc says so explicitly | Q0025, Q0101, Q0245 |
| REQ-TCC-4 | M1 | [사실] | Starting XpairHost with no connected client is fine, but Host onboarding holds at the permission step rather than reporting completion | Q0543 |
| REQ-SESSION-1 | M3 | [사실] | Product centers on launching/attaching persistent host sessions from the client; session identity not polluted by Korean/local path text | Q0056, Q0153, Q0154 |
| REQ-SESSION-2 | M3 | [사실] | A new folder/path must not inherit or pollute an existing session | Q0157 |
| REQ-SESSION-3 | M3 | [사실] | Detached/orphaned session handling is part of the launcher; users don't reason about stale sockets manually | Q0061, Q0062, Q0063 |
| REQ-SESSION-4 | M3 | [사실] | Direction is one host / multiple clients possible, sessions stay clear and attachable; old session-sharing idea is not a requirement unless reintroduced | Q0096, Q0248 |
| REQ-SESSION-5 | M3 | [사실] | Terminal windows/tabs restored after client close+reopen (via `xpair launch` params), not returned as fresh empty sessions | Q0546, Q0547 |
| REQ-SESSION-6 | M3 | [사실] | Session-name translation degrades gracefully: on translation-auth failure, fall back to the macOS built-in English converter | Q0544 |
| REQ-MAP-1 | M3 | [사실] | Files assumed available on host; client paths map to host paths — parents may differ, project subtree must correspond | Q0041, Q0042, Q0043 |
| REQ-MAP-2 | M3 | [사실] | Browser UI reflects mapping state; CLI-detected mappings with none in Browser means the SSOT is broken | Q0398 |
| REQ-MAP-3 | M3 | [사실] | Client UX uses **Add Mapping**, not generic **Open Folder** | Q0414 |
| REQ-MAP-4 | M3 | [사실] | Mount-first access preferred where appropriate; Syncthing/copy-sync is legacy/fallback | Q0281 |
| REQ-MAP-5 | M3 | [사실] | `.git` not synced across machines; `.claude/projects` excluded from git/sync (too large/private) | Q0003, Q0004, Q0012 |
| REQ-IDE-1 | M3 | [사실] | Client is an IDE on a VS Code/VSCodium base, not a from-scratch editor | Q0183, Q0248 |
| REQ-IDE-2 | M3 | [사실] | Sessions is the primary container; Browser opens from the Sessions flow, not a competing default home | Q0480 |
| REQ-IDE-3 | M3 | [사실] | Default editor area shows Remote Desktop, not a welcome screen | Q0402, Q0474 |
| REQ-IDE-4 | M3 | [사실] | Browser shows mapped roots + Add Mapping; Search/Extensions may be child surfaces but must not break the Browser frame or mapping SSOT | Q0398, Q0414, Q0480 |
| REQ-IDE-5 | M3 | [사실] | Terminal/session creation supports Claude, Shell, Codex, and other selected agents | Q0261, Q0262, Q0540, Q0541 |
| REQ-IDE-6 | M3 | [사실] | Terminal must work over the remote path: cmd+c/cmd+v copy/paste and the close (x) control function; must not regress below the iTerm baseline the user reports working | Q0550, Q0551 |
| REQ-IDE-7 | M3 | [사실] | `control+tab` cycles terminal tabs too, not only editor tabs | Q0549 |
| REQ-RD-1 | M4 | [사실] | Remote Desktop is a core Client IDE surface; install verification includes confirming RD actually works | Q0346, Q0438, Q0474 |
| REQ-RD-2 | open | [봉인] | `0.4.12` screen-sharing removal is version-specific and must not erase the later RD requirement — document per release line | Q0370, Q0438 |
| REQ-RD-3 | M4 | [사실] | Do not carry both v1 and v2 RD variants indefinitely; direction is v2-only; exact protocol open unless specified | Q0348, Q0349, Q0350 |
| REQ-RD-4 | M4 | [사실] | RustDesk was a comparison target only; the experimental `-ide2` path is not the product direction | Q0280, Q0313 |
| REQ-RD-5 | M4 | [사실] | Remote Desktop reconnects reliably across launches; RD must be stable on repeated/subsequent sessions (reported stuck "connecting to host" from 2nd launch) | Q0548, Q0552 |
| REQ-APPROVE-1 | M2 | [사실] | Approve is triggered through the product CLI/skill flow, not a raw file-touch UX | Q0015, Q0016 |
| REQ-APPROVE-2 | M2 | [사실] | Approve handles permission prompts, Claude Code terminal prompts, Chrome/site permission blocks, 1Password prompts, and recording windows where they block unattended host sessions | Q0103, Q0104, Q0114, Q0129, Q0142 |
| REQ-APPROVE-3 | M2 | [사실] | Keyboard handling covers cases where mouse/OCR is insufficient; `cmd+enter` then `enter` where supported | Q0142 |
| REQ-APPROVE-4 | P0-fix | [파생] | Approve router success verdict must confirm the **outcome** (which button pressed, or blocked call resumed), not merely that the dialog closed. The **live 0.4.13 `host/remote-pair-approve-router.sh`** returns `success` at lines **145/155** on any key that closes the dialog (`dialog_gone()` @117, candidate-key `for` loop @139), so pressing Decline reads as success. **Falsifier:** a pre-existing result-confirmation path other than dialog-closure already present in the router | Derived from: CEO symptom ("approve가 동작을 잘 안한다") + VP direct-read verification 2026-08-21 + skill-orchestrate report; two sessions blocked. NOT Q-corpus-backed. See `pm-memo.md` #2 |
| REQ-APPROVE-5 | before-cutover | [파생] | Approve SKILL.md (live tree) must carry: (a) the "about to raise a dialog — arm approve before the signing command" case, since `ssh agent refused operation` dies immediately; (b) non-blocking trigger-touch vs blocking `xpair approve` kept distinct; (c) locked-vault is out of approve's scope → ask human, don't retry-loop. **Falsifier:** if no `~/.xpair`/`~/.remote-pair` bin/approve fallback exists on the live 0.4.13 line, item (b) does not apply there. | Derived from skill-orchestrate materials (peer report, unverified against live 0.4.13 install). NOT Q-corpus-backed. See `pm-memo.md` #3 |
| REQ-NOTIFY-1 | M5 | [사실] | Host-side completion / Stop / Ask-a-question / approve notifications are forwarded to the Client | Q0183, Q0248 |
| REQ-NOTIFY-2 | M5 | [사실] | Notification settings let the user choose which kinds are enabled | Q0183 |
| REQ-NOTIFY-3 | M5 | [사실] | Approve notifications include approval type where possible | Q0183 |
| REQ-OBS-1 | M5 | [사실] | Users can collect logs after a crash/failed setup and send a readable diagnostic bundle | Q0380, Q0400 |
| REQ-OBS-2 | M5 | [사실] | Sentry is the crash/error tool; PostHog is the funnel/product-analytics tool | Q0385, Q0401, Q0403 |
| REQ-OBS-3 | M5 | [사실] | Host is covered by Sentry/PostHog if telemetry is enabled; onboarding exposes the opt-in decision | Q0448 |
| REQ-OBS-4 | open | [봉인] | Crash-report default (opt-in vs opt-out) undecided; do not silently enable analytics | Q0448, Q0449 |
| REQ-OBS-5 | M5 | [사실] | Telemetry serves first-run hardening, not vanity analytics | Q0385 |
| REQ-DOC-1 | M2 | [사실] | README/install docs are beginner-oriented: Claude Code paste-in prompt, manual path, brew guidance, Remote Login/SSH guidance, folder-mapping explanation, security warning, troubleshooting | Q0088, Q0177, Q0184, Q0185, Q0193, Q0197, Q0201 |
| REQ-DOC-2 | M2 | [사실] | Korean copy avoids translationese, keeps technical proper nouns in English where clearer | Q0202 |
| REQ-DOC-3 | M2 | [사실] | Docs track the Xpair naming; stale RemotePair install guidance is not the primary path | Q0515, Q0525 |

## 2. Non-functional

| id | pri | tag | requirement | source / falsifier |
|---|---|---|---|---|
| REQ-NFR-1 | M1 | [사실] | Target platform is Apple Silicon Mac unless the user explicitly expands scope | Q0024 |
| REQ-NFR-2 | M2 | [사실] | Normal users never build binaries locally; prebuilt distribution is required | Q0007, Q0025, Q0026 |
| REQ-NFR-3 | M2 | [사실] | Xpair is open source; AGPL-3.0 is acceptable and must not be reverted without a user decision | Q0008, Q0310, Q0311, Q0313 |
| REQ-NFR-4 | M2 | [사실] | Do not claim RustDesk AGPL-independence or permissive-only dependency guarantees unless separately proven | Q0310, Q0313, Q0333 |
| REQ-NFR-5 | M2 | [사실] | Security copy is explicit that Xpair intentionally lowers macOS Host guardrails and the user owns careless use | Q0088 |
| REQ-NFR-6 | M2 | [사실] | State boundary is a product requirement: `.claude` sync/config, approve-as-Claude-skill, app-owned state (`~/.remote-pair/host` era), Xpair data-folder name still unsettled | Q0009, Q0010, Q0011, Q0303, Q0528 |
| REQ-NFR-7 | M6 | [사실] | Release channels distinguish alpha/beta/prerelease/stable; naming like `0.5.0a1`, `aN`, `b1`, prerelease uploads | Q0415, Q0444, Q0446, Q0482, Q0484, Q0497, Q0527 |
| REQ-NFR-8 | M6 | [사실] | "Check for updates…" UI is used to verify prerelease update behavior | Q0482 |

## 3. Open issues (sealed — `[봉인]`, awaiting decision)

- REQ-NAME-3, REQ-ROLE-4 — Xpair rename matrix (bundle ids, cask tokens, display names, data folder). Q0509, Q0514, Q0525, Q0528.
- REQ-OBS-4 — crash reports opt-in vs opt-out. Q0448, Q0449.
- REQ-RD-2 — `0.4.12` screen-sharing removal vs RD-as-default per release line. Q0370, Q0438, Q0474.
- REQ-NET-4 — multi-account / sign-in / host-install pairing UX. Q0387, Q0430, Q0440.
- Current prerelease number/channel — verify against the live release before publishing. Q0446, Q0497, Q0527.
- Implementation status is sourced from a separate verification pass, never inferred from this file. Q0429, Q0438.

## 4. Priority roadmap (dependency-derived — see header)

1. **M1 Onboarding hardening** — client pre-workbench onboarding, host onboarding, TCC blocking, `xpair` CLI gate, selected agent gates.
2. **M2 Install & pairing** — Xpair naming, role-aware install, LAN Bonjour discovery, Tailscale fallback, host install from client onboarding.
3. **M3 IDE shell UX** — Sessions-first client, Browser mapping SSOT, Add Mapping, Codex support, RD default editor area.
4. **M4 Remote Desktop verification** — verify IDE RD as part of install/onboarding validation; resolve version-specific screen-sharing scope.
5. **M5 Observability** — log collection, Sentry, PostHog, host coverage, onboarding opt-in decision.
6. **M6 Release channel discipline** — alpha/beta/prerelease naming, Check-for-updates validation, stable promotion after evidence.

*(Out-of-band fixes: REQ-APPROVE-4 is a P0 correctness fix on a shipped path; REQ-APPROVE-5 is due before cutover reaches the M1/M4 machines. Neither waits on the roadmap.)*
