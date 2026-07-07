# Future — Upcoming Features / Deferred Work

Items that were discussed in this session (2026-06-12~13) but pushed back. Roughly in priority order.

## 1. `remote-pair config` — role switching (interactive)
- Implemented: `remote-pair config get/set host|terminal`, `config maps` (view/edit client config), `remote-pair map` (folder mapping).
- **Not implemented (the core of this item)**: role (host/client/both) is decided only at install time via `install.sh --role`, and there is **no way to switch it afterward**. Add a subcommand to `remote-pair config` that switches role between host ↔ client ↔ both via **manifest-based safe reinstall/rollback**. An **interactive menu** that ties `REMOTE_HOST` and folder mapping into a single flow (currently it's per-key `config set`). Provide both non-interactive (`--role host`) and interactive modes.

## 2. Releases zip download fallback in install.sh (remove brew dependency)
- Right now `install.sh --role host` only installs the app if a locally built `build/RemotePairHost.app` exists (it skips otherwise).
  So a host without a build toolchain can only obtain the app via **brew cask** → "why do I have to run brew separately?" is awkward.
- Add a fallback to install.sh: "if there's no local build, download the signed zip from GitHub Releases → remove quarantine → install".
- Effect: a host without a toolchain can also get app + approve in one shot with a single `install.sh --role host`, making brew a pure option.
  Since it's the same signed zip, the TCC grant is preserved.

## 3. glue auto-update trigger (design finalized — requirements §0.4)
- **Design finalized**: "permission boundary = bundle boundary" (requirements §0.4). glue (CLI, approve rules, skill, hooks, IDE ext = permission 0) is **not bundled** into the .app bundle; instead `remote-pair update` **fetches it from GitHub and hot-swaps** (the goal is for cask-only hosts to update without a repo too). Only the `screen` sidecar, which needs permissions, is bundled into the signed .app bundle.
- Implemented: `remote-pair update` (cmd_update, L1 hot-swap) and `remote-pair self-update` (GitHub network path) — applied instantly by replacing files on disk.
- **Not implemented (remaining work)**:
  - ① **Auto-trigger glue on app launch** — have `Updater` call `remote-pair update` (L1) after updating L2 (the app) (permission 0, so independent of the sidecar). Currently `Updater` only does L2 and glue doesn't follow.
  - ② **Complete network glue fetch** — the current `self-update` network path covers **only CLI/launcher/romanize**, while the full glue (approve rules/skills, host hooks) still requires a repo checkout (the warning in `cmd_update`). Extend it so cask-only hosts can receive the full glue without a repo.
  - ③ **Bundle the sidecar into the signed bundle** — put `screen` into the signed .app for SR grant survival + cask auto-update (requirements §0.4, §4).

## 4. approve hook noise tuning (if needed)
- Currently matcher = `mcp__claude-in-chrome__.*|mcp__computer-use__.*|Bash`, gate = `denied|permission|timed out|timeout`.
- On a `--dangerously-skip-permissions` host, approval blockages are mostly hang→timeout, so timeout is included as the main signal.
- Side effect: the reminder may also fire on Bash timeouts unrelated to approval (slow builds, hung tests).
- If it's too noisy: either exclude Bash from the matcher (chrome/computer-use only), or AND in a condition for
  'authentication-bearing commands' such as ssh/git/scp on the gate.

## 5. cask UX — post-install first-run guidance/automation
- cask only places the .app and **does not auto-launch the app** → the user has to open it once for self-install (LaunchAgent,
  tmux-aqua link) to run. The current caveats only have permission-grant guidance and is missing "open it once".
- Add "open the app once after install" to caveats, or trigger the first run with `open -a` in postflight.

## 6. Client (IDE) bare identity migration + cert CI consolidation

> **Identity unification → re-decided as separation** (2026-06-15, requirements §Identity Separation, §3). The two apps are too different in nature (Host = headless permission daemon, Client = IDE GUI), so they're separated rather than unified. Host keeps `-host` permanently — below is only the Client-side migration and cert.

- **Client bare migration** — ✅ DONE (0.5.0a38): IDE bare identity `com.x10lab.remotepair-ide` → `com.x10lab.remote-pair` (`shared/identity/identity.json`, `client/ide/remotepair/product.overlay.json`, `client/ide/build.sh` local variant), display name `RemotePair`, **new Client cask `Casks/remote-pair.rb`** (separate from Host `remote-pair-host`). IDE build+sign+publish folded into `.github/workflows/release.yml` (shared prerelease with the host; same self-signed cert, `RP_LOCAL_IDENTITY=0`). IDE assets/update repo `ASSETS_REPOSITORY`/`GH_REPO_PATH` repointed `ghyeongl/remotepair-ide` → `ghyeongl/remote-pair`. **`ghyeongl/remotepair-ide` is now deprecated** (archive it; it had 0 releases so no cask users were affected by the bundle-id change).
- **cert CI consolidation**: release signing only via CI (898E32, p12 gh secret), no manual maintainer signing (33849F contamination). The host bundle id doesn't change, so the designated requirement changes only when the cert actually changes → **one AX/SR re-grant** (an independent event, stated in README and cask caveats).

## 7-1. All-in-one "conductor" — Syncthing (e2e) + Tailscale/WireGuard + in-house screen engine
RemotePair as a single setup that *orchestrates* the best OSS. The existing low-coupling philosophy stays as-is (app = permission daemon, CLI = brain, sync delegated to Syncthing) — RemotePair only **installs, configures, and runs** the components and never touches their source.

- **Syncthing e2e mapping**: currently the user configures Syncthing folders manually. → RemotePair **auto-adds folders via both sides' (host/client) Syncthing REST API + injects `.stignore`** (excluding .git, .claude/projects) to set up folder mapping e2e. Optionally `~/.claude` sync via the same mechanism (replacing/complementing the current git-backbone opt-in). The `.git` and device-local state exclusion rules stay ([[syncthing-git-exclude]] principle).
- **Tailscale/WireGuard connectivity**: host↔client zero-config reachability (removing manual SSH/port forwarding). Onboarding guides Tailscale install/login + node verification. Onboarding is to be implemented as two Electron windows (host in RemotePairHost, client in RemotePair IDE), based on the mockup — not yet built; the prior browser-based web wizard was removed. (BSD-3/MIT — free to bundle)
- **Remote Desktop (in-house `host/rd/screen` engine)**: connected to M5.

**License**: RemotePair is **AGPL-3.0-or-later** (pure in-house code). The OSS consumed via orchestration is permissive/weak-copyleft (Syncthing = MPL-2.0, Tailscale = BSD-3, WireGuard = MIT — OK to bundle). Screen sharing uses the in-house `host/rd/screen` engine (permissive deps only) instead of an external stack. Legal review recommended before commercial distribution.

> **Telemetry dependency**: the 8 reserved Phase-2 telemetry events depend on these golden-path features landing. Direct host discovery → `host_discovery_*`; Tailscale-as-fallback → `tailscale_*`; the hosted waitlist CTA → `hosted_*`. The names are frozen now (no rename between phases) but stay un-fired until each feature exists. Full catalog + privacy contract: [`.omc/specs/deep-interview-telemetry-funnel.md`](../.omc/specs/deep-interview-telemetry-funnel.md) and [requirements.md §2](requirements.md) / [logging.md §11](logging.md). Telemetry is opt-in, default OFF.

## 8. M6 — 2-level hot-update + AX inheritance spike (⚠️ spike must come first)

Open items that must be verified before implementing M6.

### 8-1. AX permission inheritance spike

Restarting the app with `launchctl kickstart -k` reparents the `tmux-aqua` process's parent to launchd, which may break the AX inheritance chain. We need to spike first to confirm that the `tmux-aqua` patch (only `daemon→setsid`, no reparenting) is preserved across the app-replacement process. Do not proceed with the L2 (native restart) implementation before confirming this.

**Spike checklist**:
1. Compare the recorded PPID of `tmux-aqua` before and after the app restart.
2. Whether `screencapture` and `cliclick` work in a `claude` session after the restart (verify AX/SR inheritance).
3. If inheritance breaks: consider re-spawning the tmux server as an app child by re-calling `HostManager.spawn()`.

### 8-2. 2-level update design (see architecture.md §11)

- **L1 glue hot-swap**: `remote-pair-editor`, `remote-pair-notify.sh`, approve skills/hooks, etc. are applied instantly by just replacing files. No restart needed (CodePush-style). The model is finalized via the permission boundary (§0.4) — see §3 for the app-launch auto-trigger and network-fetch completion.
- **L2 native restart**: confirm session count + user consent → `launchctl kickstart -k`. Implemented in `Updater.swift` (checkForUpdates L2). Passing the AX inheritance spike (§8-1) is the prerequisite for zero downtime.

## 9. M4 IDE — VSCodium fork (`remotepair-ide`) upstream tracking

> The code-server path is **abandoned** (2026-06-14 pivot to the VSCodium fork — requirements M4, decision record). Below is future maintenance of the new fork.

- Fork base: VSCodium (`client/ide`). Strategy "keep the code, hide the UI" (composite-bar allowlist + `when=false`) to minimize upstream rebase cost.
- **patches/ tracking**: capture `vscode/src` changes (G001–G009) as `patches/` and reapply them on VSCodium upstream bumps. Revert upstream-absorbed parts in the fork to continuously shrink the patch surface.
- **Claude Code / Codex extensions**: install via the Open VSX path (not the MS Marketplace).

## 10. doctor expansion room
- This time we included host approve skill/hook presence + AX/SR grant in the healthy determination.
- Room to add: presence of the remaining helpers like cliclick/ocr-find, whether hooks are actually registered in settings.json (`claude /hooks`
  level), checking whether tmux-aqua is self-contained (otool).
