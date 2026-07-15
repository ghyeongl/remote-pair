# Full-tree Flow Validity (BFS) — stale path detection

Third verification axis: does each user-flow PATH still exist in the current product?
Per top-level root, a codex worker read the real code and walked the tree BFS top-down,
flagging stale subtrees (path diverged from reality; cascades to descendants).

Total: 115 stale prefixes across all 20 roots.

## 111
Entry flow: Xpair IDE-embedded first-run client onboarding. `shouldOnboard()` opens the pre-workbench onboarding window when `REMOTE_HOST` is absent; the current UI is Welcome -> Before you start -> Find your host. Discover polls `xpair discover --json`, then branches peer rows by `setup` / `connect` / `reconnect`, or falls back to manual SSH connect.

Code read: `client/ide/remotepair/ext/onboarding-main.cjs`, `client/ide/remotepair/ext/onboarding-preload.cjs`, `client/ide/remotepair/ext/onboarding-bridge.js`, `client/ide/remotepair/ext/onboarding-webview/src/App.tsx`, `StepWelcome.tsx`, `StepConsent.tsx`, `ConsentControls.tsx`, `StepDiscover.tsx`, `StepSetupPassword.tsx`, `StepConnect.tsx`, `StepReconnect.tsx`, `StepInstalling.tsx`, `StepGrantPermissions.tsx`, `StepEngine.tsx`, `StepFileAccess.tsx`, and `client/cli/xpair`.

### STALE
- 1111145 : No current client-onboarding UI route sends a no-host Discover state to Host-first flow `411`; the screen keeps polling or offers manual connect.
- 1111154 : Setup peers are classified before selection by `xpair discover`; the setup password step no longer performs an in-step "already installed" reclassification to connect.
- 1111171 : A `connect` peer no longer shows a setup password/account screen; it renders `StepConnect` with SSH key, host field, and "Check connection".
- 1111173 : The connect path has no partial account/password state; required input is the host field plus SSH reachability check.
- 1111174 : The connect path has no account/password-complete action; progression is gated by reachability and host-app compatibility.
- 1111271 : Same stale connect-screen divergence: `connect` peers go to `StepConnect`, not a setup password step.
- 1111371 : Same stale connect-screen divergence: `connect` peers go to `StepConnect`, not a setup password step.
- 1111414 : No current client-onboarding UI route sends scan-wait Discover state to Host-first flow `411`; a newly running host would be rediscovered instead.
- 1111445 : No current client-onboarding UI route sends no-host fallback to Host-first flow `411`; the available actions are Tailscale/manual connect.
- 1111454 : Setup peers are classified before selection by `xpair discover`; the setup password step no longer performs an in-step "already installed" reclassification to connect.
- 1111471 : Same stale connect-screen divergence: `connect` peers go to `StepConnect`, not a setup password step.

### VALID
Main current paths match: Welcome Next -> consent with two independent opt-in checkboxes -> Discover; CLI missing/installing/failed status bar with Retry exists; Discover scans Bonjour/Tailscale, shows setup/connect/reconnect peer rows and manual fallbacks; setup peers go through account/password -> automatic host install -> host permission grant -> engine guard -> file access; reconnect/manual/connect paths use SSH reachability plus host-app guard before engine and mapping.

STALE_PREFIXES 11

---

## 112
Entry flow: Xpair first-run pre-workbench client onboarding -> Welcome -> Consent -> Discover -> manual fallback (`Enter manually` / Tailscale fallback) -> Connect.

Code read: `client/ide/remotepair/patches/zz-remotepair-ide-electron-main.patch`, `client/ide/remotepair/ext/onboarding-main.cjs`, `client/ide/remotepair/ext/onboarding-preload.cjs`, `client/ide/remotepair/ext/onboarding-bridge.js`, `client/ide/remotepair/ext/onboarding-webview/src/App.tsx`, `client/ide/remotepair/ext/onboarding-webview/src/components/onboarding/WizardShell.tsx`, `client/ide/remotepair/ext/onboarding-webview/src/components/onboarding/useWizard.ts`, `client/ide/remotepair/ext/onboarding-webview/src/components/onboarding/client/StepDiscover.tsx`, `client/ide/remotepair/ext/onboarding-webview/src/components/onboarding/client/StepConnect.tsx`, `client/ide/remotepair/ext/onboarding-webview/src/components/onboarding/client/StepEngine.tsx`. Also checked `client/onboarding/electron/main.cjs`; it is the old standalone wrapper, while the current first-run hook loads `ext/onboarding-main.cjs`.

### STALE
- 112122 : Retry is not available directly from the check action; current UI shows Retry only after the failure panel state `112121`.
- 112123 : Input clearing is not available during the direct checking transition because the input is disabled; editing happens after failure state `112121`.
- 112124 : Valid-host correction is not available during the direct checking transition because the input is disabled; editing happens after failure state `112121`.
- 1121415 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 1121423 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 1121454 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 112222 : Retry is not available directly from the check action; current UI shows Retry only after the failure panel state `112221`.
- 112223 : Input clearing is not available during the direct checking transition because the input is disabled; editing happens after failure state `112221`.
- 112224 : Valid-host correction is not available during the direct checking transition because the input is disabled; editing happens after failure state `112221`.
- 1122215 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 1122423 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 112322 : Retry is not available directly from the check action; current UI shows Retry only after the failure panel state `112321`.
- 112323 : Input clearing is not available during the direct checking transition because the input is disabled; editing happens after failure state `112321`.
- 112324 : Valid-host correction is not available during the direct checking transition because the input is disabled; editing happens after failure state `112321`.
- 1123215 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 1123415 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 1123424 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 1123455 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 112422 : Retry is not available directly from the check action; current UI shows Retry only after the failure panel state `112421`.
- 112423 : Input clearing is not available during the direct checking transition because the input is disabled; editing happens after failure state `112421`.
- 112424 : Valid-host correction is not available during the direct checking transition because the input is disabled; editing happens after failure state `112421`.
- 1124216 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.
- 1124423 : Current client onboarding has no UI transition that routes to Host-first branch `4`; manipulating XpairHost is outside this client flow.

### VALID
Main path matches current code: manual fallback from Discover reaches `StepConnect`; Tailscale checking/ready/not-running/not-installed guidance exists; empty host disables Check connection; non-empty host runs `sshReachable`; failed/rekeyed SSH shows failure with Retry; SSH success persists host, runs `hostAppStatus`, blocks on missing/incompatible host app, and advances to `StepEngine` only when host app is installed and compatible.

STALE_PREFIXES 23

---

## 121
Entry flow: already-onboarded Xpair workbench opens with no usable host (empty/invalid/unreachable `REMOTE_HOST` handling in the client IDE extension).

Code read: `client/ide/remotepair/patches/zz-remotepair-ide-electron-main.patch`, `client/ide/remotepair/ext/onboarding-main.cjs`, `client/ide/remotepair/ext/package.json`, `client/ide/remotepair/ext/extension.js`, `client/ide/remotepair/ext/media/remote-desktop.js`, `client/ide/remotepair/ext/heartbeat.js`, `client/ide/remotepair/ext/telemetry.js`.

### STALE
- 12111 : the "Set host" host-status button is not user-visible in the current workbench because activation forces `workbench.statusBar.visible=false`.
- 12121 : the invalid-host host-status button branch has the same hidden-status-bar problem; `getValidHost()` collapses it to no-host internally, but the button is not reachable UI.
- 12131 : the checking host-status button is not user-visible; the SSH probe runs, but the described visible checking affordance is hidden with the status bar.
- 12132 : the unreachable host-status button is not user-visible; the probe can set unreachable internally, but the described retry/status button path is hidden.
- 12140 : the "Set up again" confirmation cancel path is not reachable from current user UI; that confirmation is only bound to the hidden status item.
- 12141 : the "Set up again" confirmation path is not reachable from current user UI; the visible palette path is `Xpair: Re-run setup`, which uses the separate Restart-now prompt.
- 1213414 : the RD webview is a minimal view-only video/overlay surface and exposes no in-RD VSCodium/browser controls to open.
- 1215314 : same RD view-only surface issue; after refresh there is no in-RD out-of-scope browser/VSCodium control.
- 1217214 : same RD view-only surface issue; the no-host/error RD view exposes no in-RD out-of-scope browser/VSCodium control.

### VALID
The main no-usable-host paths do exist: empty/invalid host resolves to RD `no-host` plus quiet notification polling, valid-unreachable host probes over SSH and drives RD tunnel error/refresh paths, `Connect to Host` opens QuickPick then `vscode.openFolder`/Open Remote SSH fallback, and `Xpair: Re-run setup` writes `.force-onboarding` for next-launch onboarding.

STALE_PREFIXES 9

---

## 122
Entry flow: configured Xpair client workbench with a valid/reachable `REMOTE_HOST` and no current session. Current startup auto-opens the RD editor tab, forces the Sessions sidebar, and opens the bottom Session Manager.

Code files read: `client/ide/remotepair/ext/extension.js`, `client/ide/remotepair/ext/media/remote-desktop.js`, `client/ide/remotepair/ext/package.json`, `client/ide/remotepair/ext/session-list.js`, `client/ide/remotepair/patches/zz-remotepair-ide-frontend.patch`, `client/cli/xpair`, `client/cli/xpair-launch`, `client/cli/xpair-mount`.

### STALE
- `122112` : Under root `122`, `getValidHost()` is already valid/reachable; RD refresh enters `_startV2(host)`, not the `no-host` overlay branch. This prefix is unreachable without changing host config outside this flow.
- `1224120` : After an absolute host path is submitted, Add Root immediately enters non-cancellable progress and calls `xpair mount`; there is no UI transition to close the Add Root flow before mount/map starts.

### VALID
Main paths match current code: RD auto-open/refresh/retry/error/close and RD Connect to Host; empty bottom Session Manager with Attached/Detached/History plus Sessions `+` to Browser; `Launch Remote Claude` staging `xpair launch` and CLI remote session create/attach; empty Browser Add Root input validation, mount, map, and root reconcile; host quickpick with direct `vscode.openFolder` and open-remote-ssh fallback.

STALE_PREFIXES 2

---

## 123
Entry flow: configured Xpair IDE workbench with reachable host and existing tmux-backed sessions; current surface is the Sessions primary sidebar plus bottom Session Manager tabs.

Code read: `client/ide/remotepair/patches/zz-remotepair-ide-frontend.patch`, `client/ide/remotepair/ext/extension.js`, `client/ide/remotepair/ext/session-list.js`, `client/cli/xpair`, `client/cli/xpair-launch`, `host/app/Sessions.swift`.

### STALE
- `1231112` : Attached card reveal failure has no user-visible error/removal/retry branch; current code only logs or no-ops on reveal/open failure.
- `12313` : No separate resync path exists for attached-provider/render mismatch; cards are rendered from the registered attached map, with fallback only when no provider is registered.
- `1234322` : Browser `New Session Here` sends plain `xpair launch`; there is no current UI branch that lets a detached `_1` takeover be routed to a fresh-session path instead.
- `12353` : Orphan Attached cards cannot be produced by the current renderer because visible Attached cards are derived directly from the internal attached map and disposed instances are removed.

### VALID
Main paths match current code: Attached/Detached/History tabs exist; Attached cards reveal or close terminal instances and support Enter/Space; Detached and live History cards run `xpair attach <name>`; persisted History cards are display-only with removable X; Sessions `+` opens Browser, folder `New Session Here` opens a Sessions terminal and runs `xpair launch`; launcher/attach code uses current tmux facts and `attach -d` for detached-session takeover while creating fresh `_N` for already attached sessions.

STALE_PREFIXES 4

---

## 124
Entry flow: Xpair workbench forced re-onboarding / setup-again. Current reachable path is the command-palette `Xpair: Re-run setup` command, which writes `~/.xpair/host/.force-onboarding`, offers `Restart now`, then the next launch's main-process onboarding hook opens the pre-workbench first-run onboarding window.

Code read: `client/ide/remotepair/ext/extension.js`, `client/ide/remotepair/ext/package.json`, `client/ide/remotepair/ext/onboarding-main.cjs`, `client/ide/remotepair/patches/zz-remotepair-ide-electron-main.patch`, `client/ide/remotepair/ext/onboarding-webview/src/App.tsx`, `client/ide/remotepair/ext/onboarding-webview/src/components/onboarding/client/StepDiscover.tsx`, `client/ide/remotepair/ext/onboarding-webview/src/components/onboarding/client/StepWelcome.tsx`, `client/ide/remotepair/ext/onboarding-webview/src/components/onboarding/useWizard.ts`.

### STALE
- 1241 : Host status-button setup-again entry is not user-reachable in the current workbench; activation explicitly sets `workbench.statusBar.visible=false`, and `remotepair.endSessionReonboard` is only wired to a hidden status-bar item, not contributed as a command-palette command.
- 124312 : Closing the pre-workbench onboarding window before completion does not route to a separate incomplete-close flow; current `onboarding-main.cjs` handles `_win.on('closed')` by calling `onComplete()` when `_completed` is false, which opens the workbench.

### VALID
The command-palette `remotepair.runSetup` path, `.force-onboarding` sentinel write/consume path, no-sentinel normal-workbench path, pre-workbench onboarding window, first-run discovery/setup/manual branches, and non-destructive session-preservation path all exist in current code.

STALE_PREFIXES 2

---

## 131
Entry flow: Xpair Sessions surface - primary-sidebar `Sessions` container plus bottom Session Manager tabs.

Code read: `client/ide/remotepair/patches/zz-remotepair-ide-frontend.patch` (`remotePairTerminalSidebar.ts`, `remotePairSessionManager.ts`, `remotePairBrowserActions.ts`), `client/ide/remotepair/ext/extension.js`, `client/ide/remotepair/ext/session-list.js`, `client/cli/xpair`, `client/cli/xpair-launch`.

### STALE
- `131611` : Browser is hosted as the real Explorer; ordinary file open/expand is a live Browser action, not an inaccessible Xpair-session terminal branch.
- `131622` : Browser `New Session Here` is contributed only for Explorer folders under existing mapped roots; missing roots are skipped and unmapped/host-missing setup goes through Add Root or `xpair launch` prompts, not `route to: 313`.
- `131820` : Missing detached/history `dataProvider` does not render empty Detached while hiding live sessions; current code uses the `xpair ls --json` cache and shows `Session list unavailable; retrying...` when listing fails.

### VALID
Main Sessions paths match current code: Sessions opens on activation, Attached/Detached/History tabs render, Attached cards reveal/close terminals, Detached and live History cards reattach with exact `xpair attach` names, readonly history is display/remove only, Sessions `+` opens Browser, folder `New Session Here` runs `xpair launch`, Add Root mounts/maps roots, and the panel toggle collapses/expands the Session Manager.

STALE_PREFIXES 3

---

## 132
Entry flow: Xpair Remote Desktop editor-tab flow. `remotepair.openRemoteDesktop` and startup activation reveal the singleton `RD` webview panel, visible panels start the v2 signaling tunnel to the host, and the webview renders receive-only WebRTC video.

Code read: `client/ide/remotepair/ext/package.json`, `client/ide/remotepair/ext/extension.js`, `client/ide/remotepair/ext/media/remote-desktop.js`, `client/ide/remotepair/ext/media/remote-desktop.css`, `client/ide/remotepair/ext/generated/contracts.json`, `host/app/AppDelegate.swift`, `host/app/HostManager.swift`, `host/app/ScreenServer.swift`, `host/app/CaptureEngine.swift`, `host/rd/screen/src/main.rs`, `host/rd/screen/src/serve_webrtc.rs`, `client/ide/remotepair/ext/remote-desktop-default-surface.test.js`, `client/ide/remotepair/ext/remote-desktop-client-surface-q0474.test.js`, `client/ide/remotepair/ext/remote-desktop-tunnel.test.js`.

### STALE
- `132611`: current RD client closes/ignores host-created input DataChannels and never sends click input from the permanent view-only webview, so a "DataChannel exists during click" subpath is not a controllable path.
- `132632`: the badge is initialized and kept as `view-only`/`.off`; no current code path hides it or switches it to an on/controllable state.
- `1327120`: when `tabGroups` inspection throws, `reveal()` immediately falls through to webview creation; there is no user-visible "before fallback handling" close step.
- `1327122`: if `tabGroups` fails while another extension host already has an RD tab, current code cannot detect that existing tab and falls back to creating its own panel, so the "keep existing RD with no new panel" transition is not real.

### VALID
Main paths match current code: RD open/reveal/restore singleton, pinned webview creation with pin-failure continuation, reload serializer adoption/duplicate disposal, valid/no-host handling, free local port + foreground `ssh -N -L` tunnel to v2 signaling port `8890`, settle-timer `v2Connect`, refresh restart, tunnel/peer/WebSocket error overlays, offer/answer/candidate handling, first-frame reporting, receive-only video rendering, view-only input attempts, RD title `Refresh` and `Connect to Host`, and duplicate guards where `tabGroups` is available.

STALE_PREFIXES 4

---

## 133
Entry flow: Xpair client IDE Browser/Add Root/Settings/Logs surfaces: `remotepair.openFileBrowser` opens the relabeled Explorer Browser after `FOLDER_MAPS` reconciliation; Browser Add Root runs the mount-first host-folder mapping flow; Settings opens the stock workbench Settings editor; Show Logs reveals `~/.xpair/client/logs` and optionally runs collection in a terminal.

Files read: `client/ide/remotepair/ext/extension.js`, `client/ide/remotepair/ext/package.json`, `client/ide/remotepair/patches/zz-remotepair-ide-frontend.patch`, `client/cli/xpair`, `client/ide/remotepair/ext/browser-mapping-contract.test.js`, `client/ide/remotepair/ext/add-mapping-q0414.test.js`, `client/ide/remotepair/ext/show-logs-diagnostics-q0380-q0400.test.js`.

### STALE
- `133411`: no current Xpair-specific settings are contributed; `remotepair.openSettings` only executes `workbench.action.openSettings`, so an "Xpair 전용 설정" item/path is not present.
- `1335211`: `xpair logs --collect` does not emit a progress-output state; the CLI tars logs silently, then prints the tarball path on success or `collect: tar failed` on failure.

### VALID
Main paths exist: Browser roots are derived from existing `FOLDER_MAPS` client dirs in order, empty Browser/Add Root affordances call `remotepair.browser.addRoot`, folder rows expose expand/search/favorite/New Session Here paths, Settings/Manage/command-palette settings entry points exist, and Show Logs reveal/fallback/collect-terminal paths exist.
STALE_PREFIXES 2

---

## 211
Entry flow: Finder Quick Action `Launch Xpair` for `public.folder` input. Current code passes Finder selections to `xpair open-gui`, which opens iTerm/Terminal with `exec xpair launch <dir>`; `xpair launch` then execs `xpair-launch` for mapped host-path launch/attach.

Code read: `client/cli/Launch Xpair.workflow/Contents/Info.plist`, `client/cli/Launch Xpair.workflow/Contents/document.wflow`, `client/cli/xpair`, `client/cli/xpair-launch`. Corroborating tests read: `client/cli/folder-mapping-launch.test.js`, `client/cli/session-restore.test.js`, `client/cli/detached-session-handling.test.js`, `tests/t_06_remote_setup.sh`, `tests/t_08_logging_zombie.sh`.

### STALE
- `2112113` : remote setup no longer decides create/take-over/fresh from remote attached state; `_N` is chosen client-side first, and the remote script only creates or reattaches the injected session.
- `2112213` : there is no user-facing force-takeover action for an already attached lower `_N`; live lower sessions are skipped to the next fresh number.
- `2112223` : a race where `_1` becomes attached during status checking is not re-routed to fresh-number selection; the already chosen session is used with `attach -d`.
- `211313` : SSH reach failure after remote/default selection does not route to an SSH/auth failure flow; launcher retries/Tailscale-checks and then falls back to local launch.
- `211332` : even with explicit `--remote`, unreachable host follows the same retry/Tailscale/local fallback path, not a direct SSH/auth failure branch.
- `2113113` : if the host path disappears inside the remote setup script, current code emits `host dir missing` and fails remote setup; it does not re-enter the missing-dir/mapping repair flow.
- `2114212` : mosh failure before screen display exits through `mosh` status; there is no Xpair route to the SSH/auth failure flow.
- `2114222` : ssh fallback auth/reach/key failure exits through the `ssh -t` command, not a dedicated Xpair SSH/auth failure flow.
- `2114223` : if ssh connects but tmux-aqua/session is missing during attach, current code surfaces the remote command failure; it does not route to a host-app/tmux/session diagnostic flow.
- `211523` : unrecovered network loss has no route to a CLI failure flow; mosh keeps roaming or the attach command exits while the host session remains.

### VALID
Main path matches current code: Finder folder service -> `xpair open-gui` -> terminal `xpair launch <dir>` -> longest-prefix mapped host path/session base -> remote/default or local target -> host dir check -> XpairHost tmux-aqua create/reattach -> mosh or ssh attach.

STALE_PREFIXES 10

---

## 212
Entry flow: Finder Quick Action `Launch Xpair` for a selected folder. The service accepts Finder `public.folder` input, runs `~/.local/bin/xpair open-gui "$d"`, and that opens Terminal/iTerm with `xpair launch <dir>`. Code read: `client/cli/Launch Xpair.workflow/Contents/Info.plist`, `client/cli/Launch Xpair.workflow/Contents/document.wflow`, `client/cli/xpair`, `client/cli/xpair-launch`.

### STALE
- `21222` : From an existing mapped path whose host directory is missing, current `xpair-launch` only asks `create the directory on host? [y/N]`; remap-to-existing-host-path is only offered earlier for unmapped folders in `xpair cmd_launch`, so `212220`/`212221`/`212222` are not reachable under `2122`.

### VALID
Finder folder input, local folder disappearance before GUI launch, mapped host-dir missing create/cancel, SSH reach/auth failures with raw `BatchMode` SSH errors, Tailscale exit-node retry, 3-attempt `__YES__`/`__NO__` dir-check, automatic local fallback, remote setup failures for missing engine/tmux-aqua/no session marker, and mosh/ssh attach after a session marker all match current code paths.

STALE_PREFIXES 1

---

## 311
Entry flow: `xpair launch` local/self-host target, from `xpair` wrapper dispatch into the local branch of `xpair-launch`.

Code read: `client/cli/xpair` (`cmd_launch`, command dispatch), `client/cli/xpair-launch` (arg parsing, engine selection, target decision, `ensure_local_host`, `_local_next_n`, `launch_local`, remote fallback boundary), `tests/t_00_smoke.sh`, `tests/t_04_target.sh`, `tests/t_05_local_policy.sh`, `client/cli/detached-session-handling.test.js`.

### STALE
- `311342`: aqua branch does not detect a plain tmux detached session and route to `31142`; plain tmux session checks happen only after `ensure_local_host` fails and execution has already fallen out of the aqua path.
- `311422`: plain tmux detached attach has no user/action branch for expecting XpairHost permission inheritance or aqua takeover; it directly reuses the plain tmux target with `tmux attach -d`.
- `311433`: plain tmux fresh/attached path has no user/action branch for expecting XpairHost inheritance or Remote Desktop; current fallback exposes no route or guard for that expectation.

### VALID
Main local paths match current code: `xpair launch` delegates to `xpair-launch`; local target selection exists for `--local`, empty `REMOTE_HOST`, self-host, and prompt choice; `launch_local` checks the selected engine, uses host-role `tmux-aqua` create/reattach/fresh when available, and falls back to plain tmux create/reattach/fresh when host/aqua is unavailable.

STALE_PREFIXES 3

---

## 312
Entry flow: mapped remote `xpair launch` from the client CLI. `client/cli/xpair` resolves the launch command and optional unmapped-folder repair; `client/cli/xpair-launch` performs longest-prefix folder mapping, remote reach/dir checks, session naming/numbering, remote tmux-aqua setup, and mosh/ssh attach. Corroborating tests read: `client/cli/folder-mapping-launch.test.js`, `client/cli/xpair-launch-q0056.test.js`, `client/cli/xpair-launch-detached-session.test.js`.

### STALE
- `31212`: no "outside Xpair launch scope / access unavailable" branch exists; unmapped paths are identity-mapped or handled by map/create/cancel repair before launch.
- `31222`: dir-check SSH failure after 3 attempts falls back to local launch, not `route to: 314`.
- `31252`: attach/setup errors are printed and the launcher exits; there is no agent-screen error branch that routes to `314`.
- `312112`: unreachable remote host tries Tailscale exit-node recovery and then falls back to local launch, not `route to: 314`.
- `312212`: missing mapped host directory is handled inline with create/cancel, not `route to: 313`.
- `312312`: there is no stale detached-session-name failure branch; if the selected tmux session exists it is reused, otherwise setup creates it.
- `312322`: fresh session creation failure exits as `remote setup failed`; no `314` recovery route is invoked.
- `312331`: missing host agent CLI prints an install/use-other-engine error and exits from remote setup, not `route to: 314`.
- `312332`: missing XpairHost tmux-aqua server attempts app/launchctl start and then exits with an error, not `route to: 314`.
- `312413`: mosh attach failure exits with the command status; no `314` recovery route is invoked.
- `312422`: ssh attach disconnect exits; reattach is possible only on a later launch, not an in-flow `route to: 31231`.
- `312423`: ssh attach failure exits with the command status; no `314` recovery route is invoked.
- `3121112`: host disconnect after reachability is treated by the dir-check retry path and then local fallback, not `route to: 314`.
- `3123214`: attach errors after fresh-session setup are handled by the attach command failure/exit paths, not `route to: 314`.
- `3123332`: missing/corrupt `__SESSION__` marker exits with "failed to extract remote session name", not `route to: 314`.
- `3124112`: after mosh attach, abnormal/error output is not a separate routed recovery branch; failure exits via mosh status.
- `3124213`: ssh fallback has no Xpair-level terminal-control branch that distinguishes resize from out-of-scope terminal features.

### VALID
Main mapped-remote paths match current code: `xpair launch` dispatches to `xpair-launch`; `map_to_host` applies the longest mapping prefix; a reachable remote with an existing mapped host dir proceeds to local mosh-client based `_N` selection; remote setup receives `HOST_DIR` and the computed session base, creates or reuses a detached tmux-aqua session, returns `__SESSION__`, then attaches via mosh when present or ssh TTY fallback when mosh is absent. Existing detached sessions reattach with `attach -d`; live mosh client tabs advance to the next `_N`.

STALE_PREFIXES 17

---

## 313
Entry flow: `xpair launch` from an unmapped local folder. Read current code in `client/cli/xpair` (`resolve_host`, `is_mapped`, `cmd_map`, `map_register_interactive`, `cmd_launch`), `client/cli/xpair-launch` (target choice, host dir check, auto mkdir, local fallback, remote setup/attach), and `client/cli/folder-mapping-launch.test.js`.

### STALE
- `31313`: no current branch re-reads/deduplicates a mapping added by another process while the register prompt is open; `cmd_map add` uses the current shell's `FOLDER_MAPS`.
- `313214`: in `map_register_interactive`, host-path `mkdir` failure warns and returns to the re-enter/create/cancel loop; it does not terminate immediately.
- `31323`: an unrecognized answer at the missing-path prompt is immediately treated as `cancelled` and returns failure; there is no continued intermediate branch before `313230`.
- `31330`: inside the `RP_YES=1` / `--yes` path there is no branch for "do not use RP_YES"; non-RP_YES execution belongs to the interactive `3131`/`3132` paths, not a terminal child of `3133`.

### VALID
Main existing paths match current code: unmapped interactive launch probes the resolved host path, offers register when it exists, offers map/create/cancel when missing, persists mappings through `cmd_map add`, then `xpair-launch` checks the mapped host dir and creates/attaches the remote session; `RP_YES=1` skips prompts, chooses remote, auto-creates a missing host dir, and falls back to local after repeated dir-check SSH failure.

STALE_PREFIXES 4

---

## 314
Entry flow: `xpair launch` remote-target failure handling for SSH reachability/auth/host-key errors, host-dir probe failures, remote setup failures, local fallback, and failure log/pause behavior.

Code read: `client/cli/xpair`, `client/cli/xpair-launch`, `tests/t_07_resilience.sh`, `tests/t_08_logging_zombie.sh`, `tests/t_06_remote_setup.sh`, `client/cli/host-child-computer-use.test.js`, `client/cli/session-restore.test.js`.

### STALE
- None.

### VALID
Main paths match current code: `xpair launch` dispatches to `xpair-launch`; remote reach uses `ssh -o BatchMode=yes`, leaving timeout/auth/host-key errors visible on stderr and in `claude-launch.err.log`; Tailscale exit-node retry/no-candidate/no-CLI branches exist; second reach failure and 3 failed dir-check attempts call `launch_local`; `__YES__` proceeds to remote setup, `__NO__` prompts create/cancel; remote setup fails cleanly for missing engine, missing/unstarted `XpairHost` tmux-aqua, SSH setup errors, or missing `__SESSION__` marker; local fallback uses host-role `tmux-aqua` or plain `tmux`; failure logging, 5MB rotation, pause, `RP_YES=1`, and no-tty pause skip paths exist.

STALE_PREFIXES 0

---

## 411
Entry flow: XpairHost in-process onboarding, `Welcome -> Permissions -> Engine -> Connect -> Done`.

Code read: `host/onboarding/src/App.tsx`, `host/onboarding/src/components/onboarding/host/StepWelcome.tsx`, `host/onboarding/src/components/onboarding/host/StepPermissions.tsx`, `host/onboarding/src/components/onboarding/host/StepEngine.tsx`, `host/onboarding/src/components/onboarding/host/StepWaiting.tsx`, `host/onboarding/src/components/onboarding/host/StepDone.tsx`, `host/onboarding/src/global.d.ts`, `host/app/AppDelegate.swift`, `host/app/OnboardingWindow.swift`, `host/app/Permissions.swift`, `host/app/EngineGuard.swift`.

### STALE
- `4112136` : Permissions 화면에서 Xpair 클라이언트 흐름으로 route하는 Host onboarding UI/bridge가 없음.
- `4112235` : SR 미승인 상태에서 Xpair 클라이언트 연결로 전환하는 Host onboarding path가 없음.
- `4112236` : XpairHost onboarding 안에 VSCodium 기능이나 임의 host 조작으로 우회하는 reachable action이 없음.
- `4112414` : Permissions 화면에는 client connection entry point가 없고 AX/SR/FDA rows와 Next/Back만 있음.
- `411310` : Engine 화면은 `claude`, `codex`, `opencode`만 노출하며 unsupported engine은 사용자 선택지로 존재하지 않음.
- `4113323` : install 실패 뒤 외부 설치 완료를 감지하는 return/re-check path가 없음; 현재 UI는 Install 재시도 또는 다른 engine 선택만 제공함.
- `4113324` : XpairHost가 제공하지 않는 설치 경로나 VSCodium 우회 action은 Engine 화면에 존재하지 않음.
- `4113425` : Engine 인증 화면에 Xpair 범위 밖 engine 설정 또는 VSCodium 표면으로 가는 action이 없음.

### VALID
Main path exists: Welcome `Begin setup` opens Permissions; Permissions has AX/SR required and FDA recommended rows that request/open macOS panes and poll status; Next is gated on AX+SR; Engine supports `claude`, `codex`, `opencode`, probes install/auth, offers install/API-key/external-login re-check where implemented, and gates Next on installed+authed before Connect/Waiting.

STALE_PREFIXES 8

---

## 412

Entry flow: XpairHost onboarding after Permissions + Engine, covering Connect and Done.

Code read: `host/onboarding/src/App.tsx`, `host/onboarding/src/components/onboarding/host/StepWaiting.tsx`, `host/onboarding/src/components/onboarding/host/StepDone.tsx`, `host/onboarding/src/components/onboarding/host/ConsentControls.tsx`, `host/onboarding/src/components/onboarding/WizardShell.tsx`, `host/onboarding/src/components/onboarding/useWizard.ts`, `host/app/OnboardingWindow.swift`, `host/app/ConnectedClients.swift`, `host/app/AppDelegate.swift`.

### STALE

- `4122113` : Multiple connected clients can press Next, but the transition lands on the same generic Done screen; there is no connected-client/paired Done route.
- `412222` : App renders `<StepDone />` without passing client state, so the connected-client Done branch and all children under it are not reachable.
- `412312` : Reachable Done never shows paired wording for an existing connected client; it always defaults to "Host is ready".

### VALID

Main Connect/Done paths exist: Connect polls `connectedClients()` every 3s, shows no-client waiting, 90s-fresh one/many client cards, keeps stale/failed reads as waiting, supports Previous to Engine and Next to generic Done, Done supports consent toggles and `Open Xpair` completion that starts host serving; Host-side install/client-management attempts are correctly unavailable on these screens.

STALE_PREFIXES 3

---

## 421
Entry flow: XpairHost ready-state menu-bar menu.

Code read: `host/app/AppDelegate.swift`, `host/app/OnboardingWindow.swift`, `host/onboarding/src/App.tsx`, `host/onboarding/src/components/onboarding/host/StepPermissions.tsx`, `host/onboarding/src/components/onboarding/host/StepWaiting.tsx`, `host/onboarding/src/components/onboarding/host/StepEngine.tsx`, `host/onboarding/src/components/onboarding/host/StepDone.tsx`, `host/onboarding/src/components/onboarding/WizardShell.tsx`, `host/app/Permissions.swift`, `host/app/Sessions.swift`, `host/app/ConnectedClients.swift`, `host/app/Updater.swift`, `host/app/Config.swift`, `host/app/SettingsWindow.swift`.

### STALE
- `42112`: Current `Permissions...` deep-link opens the Permissions onboarding step with per-permission `Open Settings` rows and a gated `Next`; there is no Permissions-screen Done/complete action that returns directly to the menu. Completion exists later only on the final Done step via `Open Xpair`.

### VALID
The ready menu and all other checked main paths exist in current code: no-selection/close terminals, `Permissions...` request/settings actions, `Connect...` guide and connected-client polling, `Set up...` full onboarding, update failure/latest/apply-with-session-gate branches, About OK/Open GitHub, Sessions down/none/attached/detached rows with terminate confirmation, Quit, read-only permission/screen-share/client/session status rows, and no direct Settings/logs/diagnostics/status detail menu entries.

STALE_PREFIXES 1

---

## 422
Entry flow: host-ready client connection from Xpair IDE launch/onboarding through discovery or manual SSH, host-app/engine guards, and host-visible client heartbeat. Code read: `client/ide/remotepair/ext/onboarding-main.cjs`, `onboarding-preload.cjs`, `onboarding-webview/src/App.tsx`, `StepDiscover.tsx`, `StepConnect.tsx`, `StepReconnect.tsx`, `StepSetupPassword.tsx`, `StepInstalling.tsx`, `StepGrantPermissions.tsx`, `StepEngine.tsx`, `onboarding-bridge.js`, `heartbeat.js`, `extension.js`, `client/cli/xpair`, `client/onboarding/electron/main.cjs`, `host/app/AppDelegate.swift`, `host/app/BonjourAdvertiser.swift`, `host/app/ConnectedClients.swift`, `host/app/OnboardingWindow.swift`, and `host/onboarding/src/components/onboarding/host/StepWaiting.tsx`.

### STALE
- `4221` : No current code/UI can show a client install guide when the Xpair IDE is not installed; the host waiting UI only says to open Xpair, and an absent client app cannot enter onboarding.
- `42231` : Bonjour-found rows are not currently reachable: the client scans `_xpair._tcp`, while the host advertises `_remotepair._tcp`; Tailscale/manual discovery still exist.
- `422411` : Reconnect success no longer routes to `111118` or directly back to workbench from that step; it enables Next, then current onboarding continues through host-app/engine gates.
- `4224222` : During `Check connection`, the host input is disabled and there is no in-flight change-host or alternate-host selection path.
- `4224314` : A failed manual/Connect probe already is on the manual host input surface; there is no separate `Enter manually` / `Connect over Internet` transition from that failure state.
- `42244` : The post-host-app-guard sequence is stale; current non-setup paths go `Engine -> File access & mapping -> liveness -> Done`, while only the setup/install path has the Grant permissions step.
- `4225113` : The Host menu has no `Restart tmux host` item wired to `HostManager.forceRestart()`.
- `4225114` : The Host menu has read-only status/session rows, but no Host-menu `Open Logs` action; logs are exposed from the IDE command/CLI surface instead.

### VALID
Current main paths match for IDE launch gating (`REMOTE_HOST` missing, existing config, or `.force-onboarding`), discovery/manual fallback, reconnect and manual SSH BatchMode probes, host-app guard, setup install plus permission grant, engine guard, optional mappings, workbench host probe, and client heartbeat display via `~/.xpair/host/clients/*.json` with a 90s freshness window.

STALE_PREFIXES 8

---

## 423
Entry flow: XpairHost is serving/ready and has no fresh connected Xpair client heartbeat, so the Host menu and Connect onboarding show the no-client/waiting state.

Code read: `host/app/AppDelegate.swift`, `host/app/ConnectedClients.swift`, `host/app/Sessions.swift`, `host/app/OnboardingWindow.swift`, `host/onboarding/src/App.tsx`, `host/onboarding/src/components/onboarding/host/StepWaiting.tsx`, `host/onboarding/src/components/onboarding/host/StepPermissions.tsx`, `host/app/Updater.swift`, `client/cli/xpair`.

### STALE
- None.

### VALID
Main paths match current code: menu-bar Clients shows `(none connected)` when `ConnectedClients.list()` has no heartbeat within 90s, recent heartbeats route into connected-client state, Sessions are readable/terminable independently of clients, `Connect…` deep-links to the Connect waiting step, `Set up…`/`Permissions…` open Host onboarding, update/About/status/log/Quit paths exist, and the separate `tmux host` stop path remains inaccessible.

STALE_PREFIXES 0

---
