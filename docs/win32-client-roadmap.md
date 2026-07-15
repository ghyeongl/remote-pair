# Windows Client Roadmap

- **Status basis** (verified 2026-07-07 against `develop` @ `4e12e476` and `feat/rust-cli` @ `0453617a`): PR #37 Rust CLI is 17/22 verbs, CI green on ubuntu/windows/macos, unsigned `.msi` builds in CI. `develop` has moved 32 commits past the branch's merge-base; `client/cli-rs/` is a pure addition (zero textual rebase conflicts) but the **parity spec is stale** — the bash CLI it mirrors was refactored (maplib #76, role separation #65/#58, five-TCC permissions #81, install/config precedence #72).
- **Supersedes** decision D2's "mac-only until #37 merges" *passivity*: this roadmap actively drives #37 to merge and unparks WS13 behind it. The **host stays macOS-only** — this is a *client* roadmap; a Windows machine pairs with a mac host.
- Each phase below is one branch + one PR into its target, sized for one implementation pass. Design sections are binding.

## Ground rules

1. `develop` keeps building for mac + windows client targets; platform *gates* only, no forks (audit plan global rule 2).
2. The Rust CLI is the ONLY Windows CLI story. No bash-on-Windows (no WSL/MSYS) anywhere.
3. Machine-local darwin verbs (`approve`, `host` app-start) are ported for cutover parity but **hard-gated on win32** with a one-line explanation and exit 2 — never faked.
4. Windows artifacts stay **unsigned** for now (SmartScreen warning accepted — decision W1 below).

## Phase P0 — `feat/rust-cli`: rebase + parity re-validation (PR #37 continues)

Rebase `feat/rust-cli` onto `develop` (textually clean — cli-rs is additive). Then re-validate the port against the refactored bash before writing new code:

- `mapping.rs` was ported against the pre-#76 inline helpers; re-check against `maplib.sh` canonical semantics (strict user-qualified exact-source mount match, `valid_host` accepts `user@host`).
- `launch`/`attach`/`status`/`config` parity vs role-separation (#65/#58): `~/.xpair/client` runtime dir, single host-attach path.
- `doctor`/`status` permission rows vs the five-TCC model (#81).
- Update every stale `client/cli/xpair:<line>` parity comment (mechanical; the audit taught us stale line refs mislead the next implementer).

**Acceptance**: cli-rs tests green on 3 OSes post-rebase; a parity-notes commit lists each re-checked behavior and whether the Rust side moved.

## Phase P1 — `feat/rust-cli`: remaining verbs (PR #37 completes)

- **doctor host rows** — fits `Transport::ssh_exec` directly: host tmux-aqua, host app dir, host server has-session, approve skill file, approve hook grep, notify hook grep, and the permission grants — covering **all five** of the current permission model (#81), sourced correctly: `status.json` (written by `host/app/Config.swift`) carries only `ax`/`sr`/`fda`/`sharing` (+`serving`), so those four grants read from it, while **Remote Login is proven by the ssh probe itself** (a successful `ssh_exec` IS the Remote Login gate — it is not in status.json and is not a "login item"). Bash `cmd_doctor` refs in the P0-refreshed comments.
- **`host`** — port the probe (`tmux-aqua has-session` locally); the `open -a`/`launchctl` app-start half is darwin-gated (rule 3). On win32: probe still works when co-located host is impossible → always the "host is remote" path; app-start arm exits 2 with guidance.
- **`approve`** — NOT the ssh seam: local FS trigger (`/tmp/xpair.approve-request` + `.label`/`.type`) + poll `~/.xpair/host/logs/xpair.log` for `router:` lines. Port as darwin-gated machine-local verb (it only means something on a machine running the privileged host app).
- **`onboard`** stays deferred (D8 — the IDE bridge drives individual verbs).

**Acceptance**: 21/22 verbs implemented in dispatch (darwin-gated ones included); `onboard` is the sole remaining stub — deferred by design (D8, IDE-bridge-driven) and wired to exit 2 with guidance, not silently absent. Parity tests per verb via MockTransport/temp-dir fixtures; #37 marked ready for review → merge via the standard Codex gate. **Merging #37 unparks WS13.**

## Phase P2 — `feat/win-release-channel`: MSI on the release, Rust self-update

The release infrastructure has no manifest scheme — the convention is GitHub Release assets + `releases/latest` (Updater.swift model). Extend that, don't invent latest.json:

- `release.yml`: add a windows job (self-hosted `[self-hosted, Windows, X64, Win11]` runner probed by win-probe.yml, or windows-latest) building `xpair-<version>-x64.msi` and uploading it to the same GitHub Release with a **stable-named alias** (`xpair-cli.msi`) alongside the versioned asset — mirroring the `Xpair.zip` convention.
- cli-rs `self-update` (win32): query `api.github.com/repos/<GH_REPO>/releases/latest` (alpha: `releases?per_page=30`), compare `tag_name` vs built-in version, download the `.msi`, verify size/hash from the release body if present, run `msiexec /i <msi> /passive` and exit. This mirrors Updater.swift's flow. On darwin, `self-update` keeps the existing raw-file fetch behavior (ported later at cutover; until then bash handles mac).
- Version stamping: `package-windows.yml` exists only on `feat/rust-cli` today (it lands with PR #37) and reads the version from Cargo.toml at build time; P2 makes `release.yml`'s windows job perform that stamping explicitly (single source: Cargo.toml → `-d Version=` → MSI + release asset name). Add the CLI version to `shared/identity/versions.json` (`cli: "x.y.z"`) + a `check-identity.sh` assertion vs Cargo.toml — same drift-guard pattern as ide/host/screen-engine — so the MSI, the tag, and versions.json cannot drift apart.

**Acceptance**: a tagged release carries the `.msi`; `xpair self-update` on a Windows box with an older MSI updates itself; check-identity fails on Cargo/versions.json drift.

## Phase P3 — `fix/win32-gates` (WS13, unparked): IDE spawns the native CLI

Implements F19/F20 against as-built line refs (drifted since the audit):

- **`runXpairCli` (extension.js:1718-1748)**: replace the `sh -lc` login-shell string-spawn with the argv-safe pattern onboarding-bridge already uses (`cp.spawn(bin, args, {env, windowsHide})` + PATH-prepending `spawnEnv()`), on ALL platforms — one spawn style, no `shSingleQuote` for local spawns. Binary resolution: darwin/linux `~/.local/bin/xpair` fallback bare `xpair`; win32 `%ProgramFiles%\Xpair\xpair.exe` (MSI install dir, which is also on system PATH) fallback bare `xpair.exe`.
- **ControlMaster**: gate `-o ControlMaster/ControlPath/ControlPersist` injection in `sshRun`/`spawnTunnel`/probes behind `process.platform !== "win32"` (Windows OpenSSH has no Unix-socket ControlPath — cli-rs decision C1 already establishes this); win32 uses plain per-connection ssh.
- **`rpBin`/`rpBinAbs`/`installCli` (onboarding-bridge.js)**: same per-platform binary resolution; `installCli` on win32 does NOT run bash install.sh — it checks for the MSI-installed exe and returns guidance (`{ok:false, err:"install the Xpair CLI (.msi) first", action:"OPEN_DOWNLOAD"}`) pointing at the stable release asset URL.
- **`openHostOnboarding`**: win32 replaces `open -a` with a no-op + guidance (host onboarding runs on the mac host itself).
- **`gatewayMacStatus` (onboarding-bridge.js:1059)**: implement win32 via `arp -a` + default-gateway from `route print` (or `Get-NetRoute` via powershell) so roaming safety stops failing open; if flaky in practice, keep fail-open but log loudly (decision W2).
- **F20**: on `process.platform !== "darwin"` the pre-workbench gate must not dead-end — resolveOnboarding proceeds when the CLI probe passes; a missing CLI shows the MSI guidance instead of the bash installer path.

**Acceptance**: mac behavior byte-identical (t_15/t_23 green); on a Windows box with the MSI installed, the IDE runs `xpair ls`/`discover` through the argv spawn and reaches the workbench; no POSIX-shell local spawn reachable on win32 (grep-proof in PR).

## Phase P4 — `feat/win32-mappings`: UNC access instead of NetFS mount

macOS mounts SMB at `/Volumes` via osascript; Windows consumes SMB natively via UNC. **Decision W3: no mount verb on Windows — mappings resolve to UNC paths** (`\\<smbHost>\<share>\…`), optionally bootstrapped with `net use \\host\share /persistent:yes` when auth is needed.

- cli-rs `map`: on win32, `map add` stores the client path as the UNC path (or a user-chosen drive letter); `expected_mountpoint`/`discover_mountpoint` equivalents return the UNC root; `mount` verb exits 2 on win32 pointing at `map add` with UNC.
- extension.js `addRoot`: win32 skips the `xpair mount mount` step and adds the UNC root directly (VS Code handles UNC workspace folders).
- **Sync mode is deferred on win32** (decision W4): mappings are UNC-only until a robocopy/unison story is designed; `map add --method sync` on win32 → clear "not yet supported" error.

**Acceptance**: on Windows, adding a mapping against a mac host with File Sharing on yields a browsable UNC workspace folder in the IDE; mac mount flow untouched.

## Phase P5 — `feat/win32-ide-build`: package the IDE for Windows

The vendored VSCodium recipe already has win32 branches (dev-build.sh OS_NAME=windows, build.sh VSCode-win32-* stamping, win32 brand fields in identity.json). What's missing is the Xpair layer:

- build.sh: win32 arm of the post-gulp steps — bundle `xpair.exe` (from the P2 release or a local cargo build) into `resources/app/`-adjacent bin dir, skip codesign/lipo/mosh/XpairHost.app (mac-host-only payloads), produce a zip (and later an installer — out of scope here).
- CI: a windows build job on the self-hosted Win11 runner (toolchain inventory already proven by win-probe.yml); artifact upload; wire into release.yml behind a flag until stable.
- versions.json: the ide component version is per-component, not per-OS — no schema change; check-identity's win32AppUserModelId/win32MutexName assertions already exist.

**Acceptance**: CI produces a runnable Windows IDE zip whose bundled CLI passes `xpair doctor` against a mac host; release.yml can attach it to a release behind an opt-in flag.

## Phase P6 — `fix/win32-onboarding`: first-run flow on Windows

Sweep the client onboarding Electron surface with the P3 bridge in place: hardcoded `~/.xpair` layout works via os.homedir on Windows but verify every consumer (env files, sentinels, logs); dock/traffic-light chrome degrade gracefully (already guarded/cosmetic); StepMappings' browse/resolve/mount flow uses the P4 UNC path on win32; pairing/discovery (beacon + Tailscale) verified end-to-end from a Windows client.

**Acceptance**: fresh Windows machine → MSI → IDE zip → onboarding completes against a broadcasting mac host → mapped UNC folder opens → terminal session attaches.

## Explicitly out of scope

- Windows **host** (capture/input/RD host side) — not planned; host remains macOS.
- Code signing / SmartScreen reputation (W1) — revisit when distribution widens.
- win32 IDE auto-updater (Updater.swift equivalent) — manual reinstall until the IDE zip stabilizes.
- Retiring the bash CLI on macOS (cutover) — separate decision after P1 parity holds on mac for a release cycle.

## Decisions

| ID | Question | Decision |
|---|---|---|
| W1 | Sign Windows artifacts? | **Not yet** — unsigned MSI/zip, SmartScreen warning documented in README. Revisit at wider distribution. |
| W2 | Roaming gateway-MAC baseline on win32? | **Implement** via `arp -a`/`route print`; if unreliable, fail-open WITH loud log (today it fails open silently). |
| W3 | SMB on Windows: mount or UNC? | **UNC paths, no mount verb** — native consumption, no /Volumes analog. Optional `net use` for credential bootstrap. |
| W4 | Sync-method mappings on win32? | **Deferred** — UNC-only first; robocopy/unison design later. |
| W5 | Where does `self-update` get Windows bits? | **GitHub Releases** (existing convention: stable-named asset + tag compare), NOT a new latest.json. |
| W6 | `onboard` verb in the Rust CLI? | **Deferred indefinitely** (adopts PR #37's out-of-repo decision "D8"): the IDE onboarding bridge drives the individual verbs directly, so a CLI onboard wizard is redundant; the verb stays wired to exit 2 with guidance. All "D8" references in this document mean W6. |
| W7 | Stable Windows updater: `/releases/latest` vs scan? | **Follow-up (deferred)** — today stable `self_update.rs` reads `/releases/latest`, so a mac-failure MSI fallback (published `--latest=false`) isn't auto-delivered until the mac job is rerun and promotes the real latest. Full decouple = make the stable channel scan the release list for the newest non-prerelease with an MSI asset (mirror the alpha `releases?per_page=30` path) + update the onboarding download URL. Own PR + tests + Codex rounds when we approach a stable release; not grafted under alpha time pressure. |

## Sequencing & ownership

```
P0 → P1 (both on feat/rust-cli, PR #37) → merge #37
                                     ├→ P2 (release channel)   — needs #37 merged
                                     └→ P3 (WS13 gates)        — needs #37 merged (binary to spawn)
P2 + P3 → P4 (UNC mappings) → P5 (IDE build) → P6 (onboarding sweep)
```

Design (this document) is binding; implementation is delegated per-phase (Codex), reviewed and gated exactly like the audit workstreams (tests/run.sh + cli-rs 3-OS CI + Codex review gate).
