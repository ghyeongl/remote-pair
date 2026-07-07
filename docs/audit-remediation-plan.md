# Code Audit Remediation Plan

- **Audit basis**: `develop` @ `e3750c8d` (post PR #65 merge). **All `file:line` references are pinned to this commit** — re-locate before editing if the target branch has moved.
- **Method**: 10-area multi-agent audit (one auditor per subsystem, full-file reads), followed by one adversarial verifier per finding (instructed to refute by re-reading code and both sides of every contract). 73 raw findings → **71 confirmed (F01–F71), 2 rejected**. Corrected claims from verifiers are folded in.
- **Scope**: first-party code only (`client/cli`, `client/ide/remotepair/ext`, `client/onboarding`, `host/app`, `host/rd`, `shared`, `tests`, `bench`, `Casks`). Vendored VSCodium, `dist/`, `generated/`, `node_modules/` excluded.
- **Severity**: high 6 / medium 33 / low 32. Kinds: bug 34, dead-code 24, architecture 10, design-pattern 3.

## Status (living — updated 2026-07-07)

The audit body below (findings F01–F71, per-WS design) is the frozen source record; this section is the live tracker.

| WS | Scope | PR | State |
|---|---|---|---|
| — | Spec (this doc) | #67 | ✅ merged (6 review rounds) |
| WS1 | bash 3.2 empty-array guards | #68 | ✅ merged |
| WS2 | test gating (suite now hard-fails) | #69 | ✅ merged |
| WS3 | install/uninstall symmetry, config precedence | #72 | ✅ merged |
| WS4 | single `maplib.sh` | #76 | ✅ merged |
| WS5 | CLI small fixes | #70 | ✅ merged |
| WS6 | Swift stability (capture race, pipe drain, retain cycle) | #75 | ✅ merged |
| WS7 | Rust RD lifecycle (leaks, zombie, console) | #74 | ✅ merged |
| WS8 | dead-code sweep + IPC allowlist | #77 | ✅ merged |
| WS9 | telemetry consent SoT + service lock | #73 | ✅ merged |
| WS10 | wizard UX **+ pull-pairing + LAN beacon + border/logo** (see expanded section) | #78 | 🔵 in review |
| WS11 | bench scoring/RTX/rate math | #71 | ✅ merged |
| WS12 | onboarding-ui shared source (D1 build-time dist) | — | ⏳ next |
| WS13 | win32 gates | — | ⏸ parked until Rust CLI #37 |
| WS14 | real host folder browsing (`listHostDir`) | — | ⏳ after WS10 |
| WS15 | DC ownership (`negotiated:true`) | — | ⏳ own soak-tested branch |
| **WS16** | host permission model: File Sharing REQUIRED, Sentry consent UI default-OFF (new — from live QA) | — | ⏳ queued |
| **WS17** | terminal session restore + bottom-bar attached/detached/history (new — from live QA) | — | ⏳ after WS10 |

**All 6 high + all but a few medium findings are on `develop`.** The `fix/onboarding-ssh-tofu-and-path-quoting` blocker named below **dissolved**: that branch's work (host-key TOFU + path quoting) was already absorbed into develop via the #60 onboarding redesign, so WS8/WS10/WS12 were unblocked and proceed normally.

WS16 and WS17 are net-new workstreams surfaced by the product owner testing the live onboarding/session flow — they are not audit findings F01–F71. Their designs live in their own sections at the end of this document.

## How to use this document

Each workstream (WS) below is one branch off `develop` and one PR into `develop`, sized for a single implementation pass. The **Design** section is binding; **Steps** are the mechanical checklist; **Acceptance** is what the PR must prove. Implementers must not weaken product code to satisfy a stale test — when a wired-in test fails, fix whichever side has drifted from the *documented* contract, and say which side moved in the PR description.

Global rules:

1. Every deletion (dead code) requires a fresh repo-wide grep (excluding `vendor/`, `dist/`, `node_modules/`, `generated/`) in the PR branch — several dead items are pinned by source-text test assertions that must be updated in the same commit (each WS names the known ones).
2. `develop` must keep building for both mac and windows client targets; nothing here may fork the codebase per-platform (platform *gates* are fine, see WS13).
3. Commit messages, PR titles/bodies in English.
4. Run `tests/run.sh` locally before pushing; after WS2 lands it is the gate for everything else.

### Coordination: in-flight branch (RESOLVED)

~~`fix/onboarding-ssh-tofu-and-path-quoting`~~ — this blocker is gone. Its host-key TOFU hardening and remote-path quoting were already in develop via the #60 onboarding redesign; the local branch was superseded and deleted. WS8/WS10 proceeded without it. F21's password contract was addressed in WS10 (#78) by routing `NEEDS_PASSWORD` to re-pair guidance, not by building a password form.

### Workstream order

| Order | WS | Blocked by |
|---|---|---|
| now | WS1 (bash 3.2 hotfix), WS2 (test gating), WS3 (install/config), WS11 (bench) | — |
| after WS1 | WS5 (CLI small fixes), then WS4 (maplib) — same file, sequence to avoid rebase pain | WS1 |
| after WS2 | WS6 (Swift stability), WS7 (Rust lifecycle), WS9 (telemetry) | WS2 |
| after in-flight branch merges | WS8 (dead-code sweep + IPC allowlist), WS10 (wizard UX), WS12 (onboarding-ui single source) | WS2 + in-flight |
| after WS8 + WS10 | WS14 (real host folder browsing, D5) | WS8, WS10 |
| own branch, soak-tested | WS15 (DC ownership, D4) | WS7 |
| **parked** until PR #37 (Rust CLI) merges | WS13 (win32 gates) — decision D2: mac-only until then | PR #37 |

---

## WS1 — `fix/bash32-unbound-arrays` (high, hotfix)

**Findings**: F01 (high), F02 (high), F45 (low).

`set -u` + empty-array expansion aborts on macOS stock bash 3.2 (`/usr/bin/env bash` resolves there on any Mac without Homebrew bash — which is exactly the fresh-install onboarding audience). The repo already knows the correct idiom (`client/cli/xpair:1007-1009`, `xpair-launch:58`): `${arr[@]+"${arr[@]}"}`.

**Design**: apply the existing idiom; do not migrate to bash-4 constructs, do not add a bash version re-exec.

**Steps**:
1. F01 — `client/cli/xpair`: guard `"${SSHENV[@]}"` at all 7 sites: 1927 (`_rp_ssh`), 1993, 2014, 2017, 2019, 2021, 2056. `RP_SSHOPTS` is never empty; leave it.
2. F02 — `host/xpair-approve-router.sh:87` (`sendkey`): modifier tokens are space-free, so iterate words: `for m in ${mods//+/ }; do … done`, or use the guarded expansion. One change inside `sendkey` fixes every caller, including the shipped `key:return` fallback.
3. F45 — `client/cli/xpair:1325` (`logs --collect`): explicit empty check before tar: `[ "${#roots[@]}" -gt 0 ] || { warn "collect: no log dirs yet"; return 1; }`.
4. Regression check: add `client/cli/bash32-empty-arrays.test.js` following the existing extraction pattern in that directory — extract `_rp_ssh` + `sendkey` + the `logs --collect` block, run each under `/bin/bash` (3.2 on macOS) with `set -u` and empty arrays. Assert rc==0 for `_rp_ssh`/`sendkey`; for the `logs --collect` empty-roots block assert **rc==1 with the `collect: no log dirs` warning** (that is its fixed behavior per step 3); in all three, assert stderr contains no `unbound variable`. (Runner wiring arrives with WS2's t_23; the file is still runnable standalone via `node`.)

**Acceptance**: on a machine whose `bash --version` is 3.2, `xpair install-host --host <h>` reaches the ssh probe on the key-auth path (no `unbound variable`); the new test passes under `node`; `bash -n` clean.

## WS2 — `fix/test-gating` (high)

**Findings**: F03, F05, F06 (high — silent-pass holes), F04 (high — 21 orphan test files), F09, F14, F31, F35 (stale/orphan tests), F34, F67 (CI gaps).

The systemic problem: `tests/run.sh` only globs `t_*.sh`; `t_15` only globs `ext/*.test.js`; a `t_*.sh` that exits 0 without printing `__SUMMARY__` counts as passing. Result: 21 JS test files across `client/cli/`, `host/app/`, `host/`, `host/onboarding/`, `shared/` gate nothing, 11 of them already fail or crash, and two whole `t_*.sh` suites (t_16, t_17) have been green-but-inert for months.

**Design**:
- Root-cause guard first (F03): a summary-less rc=0 test file is a **failure**. Any future `finish`-forgetting suite then fails loudly.
- One new wrapper `tests/t_23_repo_js_contracts.sh`, mirroring `t_15`'s per-file `node` + rc assertion, globbing: `client/cli/*.test.js`, `host/*.test.js`, `host/app/*.test.js`, `host/onboarding/*.test.cjs`, `shared/*.test.js`. Keep t_15 untouched (ext dir only).
- Triage before wiring — fix the *test* when the source is correct and the assertion is stale; delete a test only when its contract is provably covered elsewhere (name where, in the PR).

**Steps**:
1. F03 — `tests/run.sh:17`: count missing `__SUMMARY__` as failure: `if [ -z "$s" ]; then f=$((f+1)); printf '  (no __SUMMARY__ line, rc=%s — counted as fail)\n' "$rc"; fi`.
2. F05/F06 — append `finish` after `cleanup_sandbox` in `tests/t_16_map_method.sh` and `tests/t_17_doctor_smb.sh`. Then fix whatever t_16's 7 latent assertion failures reveal (they were written against a `/usr/bin/true` stub; re-run and repair the assertions against real behavior).
3. F09 — repair the 4 stale `client/cli` tests: `host-child-computer-use.test.js:35` and `session-restore.test.js:35` expect old mosh args → assert current `mosh --ssh="ssh $SSH_ID" --server="$MOSH_SERVER"` (xpair-launch:915); `approve-permission-prompts.test.js:34` → `$approve_trigger` (xpair:1254); `folder-mapping-launch.test.js:46` → extract `map_client_of`/`map_host_of` alongside `map_to_host`.
4. F35 — the 3 `host/app` onboarding tests crash on files deleted in PR #60 (`StepPermissions.tsx`, `StepWaiting.tsx`): update to the post-#60 step sources (mirroring `host-client-separation.test.js`), or delete each with a pointer to the covering test.
5. F04/F14/F31 — add `tests/t_23_repo_js_contracts.sh` as designed; run it; fix remaining failures it surfaces (11 known-failing files total, incl. the ones above).
6. F34 — `.github/workflows/ci.yml`: add a step invoking the three SoT drift guards (`shared/check-ide-selfcontained.sh`, `shared/screen-protocol/check-screen-protocol.sh`, `shared/identity/check-identity.sh`); change `check-ide-selfcontained.sh` to regenerate into a temp file and hash-compare instead of overwriting `generated/contracts.json` in place. **Fix the guards before relying on them**: `check-identity.sh:37` points at `client/ide/remotepair-ext/package.json` (real path: `client/ide/remotepair/ext/package.json`) and its `[[ -f "$EXT_PKG" ]] &&` guard silently skips the assertion — correct the path and make a missing consumer file a failure, not a skip, or the new CI step just certifies a guard that checks nothing.
7. F67 — the `bash -n` gate: fail on missing listed files, and replace the hardcoded list with `git ls-files` over `shared/`, `client/cli/`, `host/`, `tests/` **filtered to shell files** — `*.sh` plus extensionless files whose first line matches `^#!.*[/ ](ba)?sh([[:space:]]|$)` (POSIX ERE — no `\b`, which BSD grep only honors as a GNU-compat extension) — so new entrypoints are auto-covered without feeding `bash -n` the `*.test.js` and `Launch Xpair.workflow` artifacts living in the same directories.

**Acceptance**: mutation proof in the PR description — flip one assertion in a t_23-covered file and one in t_16, show `tests/run.sh` exits nonzero for each, revert. CI green afterward.

## WS3 — `fix/install-uninstall-consistency` (medium)

**Findings**: F32, F63 (casks), F33 (config precedence), F66 (split manifest), F64 (log rotation contract), F65 (host logging.sh path), F43 (duplicate uninstaller).

**Design**: one teardown implementation per artifact; the documented config precedence (`env var > role env file > derived default`) actually enforced in `config.sh` so every consumer inherits it; log rotation only ever happens under the shared mkdir-lock (the Swift daemon already rotates this file — writers should not).

**Steps**:
1. F32 — `Casks/xpair-host.rb`: add `uninstall launchctl: ["com.x10lab.xpair-host", "com.x10lab.xpair-host-watchdog"], quit: "com.x10lab.xpair-host"`; add both `~/Library/LaunchAgents/com.x10lab.xpair-host*.plist` to **`uninstall trash:` as well as `zap trash:`** — zap only runs with `--zap`, so a plain `brew uninstall` must itself remove the plists or the KeepAlive agents return at next login. (Verify label names against `Installer.swift` before hardcoding.)
2. F63 — `Casks/xpair.rb`: `zap trash: ["~/.xpair/client", "~/.xpair/ide", "~/.xpair/ide-server"]` — matches what `uninstall-client.sh` removes and `t_19` asserts.
3. F33 — `shared/config.sh:39`: snapshot **the original process environment only**. `install.sh` sources `config.sh` twice (lines 24/40 — before and after `--role` parsing), so a naive snapshot-before-each-source would launder first-source file values into "caller env" on the second source (e.g. a host-role reinstall on a combined machine keeping client-common values). Guard the snapshot with a sentinel so it is captured exactly once per process (`[ -n "${_XPAIR_ENV_SNAPSHOT:-}" ] || { …capture known keys…; _XPAIR_ENV_SNAPSHOT=1; }`), then re-apply after every source — restoring documented `REMOTE_HOST=my-mac ./install.sh --role client` reinstall behavior for all consumers in one place.
4. F66 — `shared/sync-setup.sh:12`: passing `MANIFEST` down is **not enough by itself** — sync-setup re-sources `config.sh`, whose line 29 unconditionally resets `MANIFEST` to the legacy host path. First make `config.sh` respect a pre-set value (`MANIFEST="${MANIFEST:-$RP_HOST_DIR/.install-manifest}"` — same respect-caller pattern as the F33 fix), then have `install.sh` pass it down (`MANIFEST="$MANIFEST" "$HERE/sync-setup.sh"`) so reversal entries (GITREMOTE/NOTE) land in the role manifest, not the legacy host one.
5. F64 — `host/xpair-approve-router.sh:30`: delete the ad-hoc unlocked `mv` rotation block; the Swift daemon rotates `xpair.log` under the shared lock on every append (docs/logging.md §7).
6. F65 — `shared/logging.sh` host path: install it where it is declared — add `install_file "$HERE/logging.sh" "$RP_DIR/bin/logging.sh" 644` to the host branch of `shared/install.sh`, and stop `lib.sh migrate_layout` moving it out. This revives the intended logger for `bootstrap.sh:31`, `sync-setup.sh:16`, and xpair-launch's host-side SSH snippet (line 746) without repointing three consumers + docs.
7. F43 — `client/cli/uninstall-host.sh`: replace the drifted 8-label copy with a thin wrapper that pipes the canonical `host/uninstall-host.sh` over SSH (`ssh "$HOST" 'bash -s --' "$@" < "$CANONICAL"` — **forward only the flags the user actually supplied; never inject `-y`/`--force`**, or the wrapper silently bypasses the 0.4.x-production-host refusal both scripts currently enforce and a safe uninstall attempt becomes a destructive wipe). Keep only the client-side `--host` / 0.4-protection UX. `$CANONICAL` must not be a bare repo-relative path: the wrapper runs from installed copies and arbitrary cwd, where `host/…` does not exist and the redirection fails before SSH. Stage the canonical script into the client install (`shared/install.sh` + self-update, like `logging.sh`), resolve `$RP_CLIENT_DIR/share/uninstall-host.sh` first and fall back to the repo-relative path only when running from a checkout. Interactivity: the remote `confirm()` reads `/dev/tty` and aborts when absent — under `bash -s` piping stdin IS the script and no tty is allocated, so the wrapper must run the confirmation **locally** (it owns the user's tty, including the 0.4-protection prompt) and pass `--yes` to the remote only after local confirmation succeeds. Remote argv must be SANITIZED, not `"$@"`: the canonical parser accepts only `-y/--yes`, `--dry-run`, `--force` — client-only options (`--host <target>` and its value) must be stripped or the remote exits `unknown arg: --host` before doing anything; forward `--force`/`--dry-run` only when user-supplied. One teardown implementation.

**Acceptance**: `tests/t_10_install_reversibility.sh` and `t_19_uninstall_safety.sh` pass; a client-role install → uninstall leaves no `GITREMOTE` remnant; `brew uninstall --cask xpair-host` on a test box leaves no loaded launch agents (`launchctl list | grep x10lab` empty).

## WS4 — `refactor/maplib-dedup` (medium) — after WS1/WS5

**Findings**: F10.

The mapping + SMB-discovery helper family is copy-pasted across `xpair` (266–297, 368–389), `xpair-launch` (192–254), `xpair-mount` (116–204), `reset-onboarding.sh` (45–64), and has drifted: `xpair-mount` matches mounts by exact `//user@host/share on ` source (with fallback) while the others match loose `@host/share on `; the duplicated `host_smb_status` guards already disagree on `user@host` targets (xpair:463 rejects, xpair-mount:123 accepts).

**Design**:
- New `$RP_CLIENT_DIR/bin/maplib.sh`, installed and self-updated exactly like `logging.sh` (`shared/install.sh` + `cmd_self_update`). Contents: `map_client_of`, `map_host_of`, `map_mode_infer`, `valid_host`, `smb_host`, `share_name_for_hostpath`, `expected_mountpoint`, `discover_mountpoint_for_hostpath`, `host_smb_status` — **plus the live entrypoints that consume them**: the longest-prefix client→host resolver currently exists twice under two names, `resolve_host` (xpair:355, called at 479/975) and `map_to_host` (xpair-launch:195, called at 541). maplib ships one canonical `map_to_host` with `resolve_host` as a thin alias (or update xpair's two call sites). Omitting these leaves normal launches at `command not found`.
- **Canonical semantics = `xpair-mount`'s** (stricter user-qualified exact-source match first, fallback second; `valid_host` accepts `user@host`). The looser copies are the drifted ones.
- Unlike logging.sh, mapping helpers cannot no-op: if the lib is missing, **fail loudly** with `error "maplib.sh missing — run: xpair self-update"` rather than silently mis-discovering mounts. `reset-onboarding.sh` starts sourcing it too.

**Steps**: create lib from the xpair-mount versions; add to install/self-update manifests; replace all four scripts' copies with the guarded `source`; extend `t_16_map_method.sh` with a cross-script contract: for a fixture `mount` table, `discover_mountpoint_for_hostpath` invoked via each of the three scripts returns the identical mountpoint.

**Acceptance**: t_02/t_16/t_21 pass; `grep -rn 'map_client_of()' client/` returns exactly one definition.

## WS5 — `fix/cli-small-fixes` (low, batchable) — after WS1

**Findings**: F44, F46, F47, F48, F49.

1. F44 — delete `_rp_in_ssh_config` + `_rp_peer_status` (`xpair:1510–1523`); the live policy is `cmd_discover`'s embedded python `status_for`.
2. F46 — `xpair:1074`: capture mosh's real rc in an `else` clause (`if mosh …; then …; else rc=$?; fi`); today the diagnostic always prints `rc=0`.
3. F47 — delete unused `TMUXB` (`xpair:99`).
4. F48 — `xpair-launch:512` `_remote_next_n`: drop the dead third parameter and state-word suffix (caller discards it); fix the header comment at 508.
5. F49 — `xpair-mount:292`: the printed tip references a nonexistent config key; change to the real verb: `xpair map add <mountpoint> <hostpath>`.

**Acceptance**: `bash -n` clean; t_23 (WS2) green; grep proves zero remaining refs for each deletion.

## WS6 — `fix/host-swift-stability` (medium)

**Findings**: F27, F28, F29.

1. F27 — `CaptureEngine.swift:199`: `stop()` mutates encoder state from arbitrary threads against the SCK sample path and VT callback, violating the file's own line-42 invariant. Move the VT/SCK teardown onto `sampleQueue` — but NOT with an unconditional `.sync`: the AU-pipe-write-failure path calls `stop()` from inside the sink callback, which already runs on the sample queue (CaptureEngine.swift:81-83 contract; ScreenServer.swift:739-741 caller), so a bare `sampleQueue.sync` deadlocks exactly there. Tag the queue with `DispatchQueue.setSpecific` and branch in `stop()`: already-on-queue → run teardown inline; otherwise `sampleQueue.sync { … }` (stop capture, invalidate session, clear `au/sink/eventSink`, `resetSampleState()`), mirroring how `requestKeyframe()`/`setBitrate()` already hop; only the `startGeneration` bump stays outside.
2. F28 — `EngineGuard.swift:221` `runLogin()`: sequential stdout-then-stderr drain deadlocks when the child fills the 64KB stderr buffer. Do **not** merge stderr into stdout (`runCaptureMergingStderr`-style): `status()` (line 61) reports a probe failure only when `r.code != 0 && r.out.isEmpty` and surfaces `r.err` as the message — merging would make failing probes non-empty-out (silently mis-parsed as "not installed", error text lost). Drain both pipes **concurrently but separately**: `readabilityHandler` accumulators (or a second DispatchQueue reading stderr) installed before `waitUntilExit`, keeping the `(out, err, code)` contract intact.
3. F29 — `OnboardingWindow.swift:111`: retain cycle via `add(self, name:"rpbridge")` with no removal — every menu-open leaks window + WKWebView. In `windowWillClose` (and `finish()`): `removeScriptMessageHandler(forName:)` + `removeAllUserScripts()`, nil out webView. (Upgrade path if more windows appear: a weak-proxy `WKScriptMessageHandler` wrapper.)

**Acceptance**: `swift build` clean; manual: open/close "Set up…" 5×, memory graph shows no accumulating `OnboardingWindow`; engine-install step completes with a deliberately stderr-noisy child.

## WS7 — `fix/rd-lifecycle` (medium)

**Findings**: F24, F25 (medium), F57, F58, F59, F60, F61 (low).

1. F25 — `serve_webrtc.rs:1674`: `into_connected`'s error arm must `let _ = self.peer.pc.close().await;` before returning (mirrors other arms); for `serve_session`'s early-`?` paths, route failures after `new_peer_connection` through one cleanup helper owning the pc, instead of bare `?` — no more leaked ICE/DTLS agents + UDP sockets per failed capture start.
2. F59 — `CaptureHandle::stop` (`serve_webrtc.rs:2226`): after `kill()`, `wait()` — same pattern as `CaffeinateGuard::drop` (1848–1851). One zombie per ended session otherwise.
3. F61 — delete the `Session` enum + unreachable match arms (1586); end `serve_session` with `NegotiatingSession { … }.run_until_connected().await?.run().await`.
4. F58 — `main.rs:153`: fatal errors additionally `eprintln!`; `cmd_info`/`cmd_capture` print human-facing output via `println!` (keep tracing calls for the log contract). `screen info` currently prints nothing.
5. F57 — delete the five passthrough cargo features (`Cargo.toml:100–104`); deps stay optional behind `webrtc`/`crash-report`.
6. F24 — `rp-input-inject.swift:171`: stop blocking the stdin loop per keystroke — but plain fire-and-forget loses inter-keystroke ordering (`cmd+s` then `cmd+w` as two concurrent osascripts can land swapped, which is worse than the latency). Enqueue the spawn+wait onto one **serial background DispatchQueue worker**: the stdin loop stays non-blocking, System-Events keys stay ordered relative to each other. Two required details: (a) a command-line process does not wait for queued GCD blocks after top-level code returns — after the stdin loop hits EOF (RD disconnect/window close), drain the queue before exiting (`queue.sync {}` barrier or DispatchGroup wait) so the final `cmd+…` keystrokes aren't dropped in exactly the disconnect case; (b) cross-path ordering vs direct CGEvent injection remains best-effort — say so in a comment.
7. F60 — comments only: fix the stale host comment (1537–1539) claiming the client never creates channels. The channel-ownership redesign itself is WS15 (decision D4).

**Acceptance**: `cargo build` + `cargo clippy` clean; a failed capture start no longer leaks (assert via `lsof -p` UDP count before/after 3 failed starts); `ps` shows no `<defunct>` rp-screencap after ending a session; `screen info` prints display metadata.

## WS8 — `chore/dead-code-sweep` (medium) — after WS2 **and** the in-flight branch

**Findings**: F12, F22, F26, F30, F36, F50, F51, F53, F54, F55, F56, F62, F68, F69, F70, F71, then F23 last.

This is a surface-reduction pass: the onboarding bridge/preload expose ~26 dead methods (several security-relevant: `setHostEngineAuth` pipes API keys, `spawnEnv` returns full env), plus assorted dead files. Order matters: shrink the surface first, then freeze it (F23).

**Steps** (each item: grep, delete, update the named pinning tests, re-run t_15 + t_23):
1. F22 — delete the client-side engine-setup cluster from `onboarding-bridge.js` (`setEngine`, `installHostEngine`, `setHostEngineAuth`, constants `ENGINE_INSTALL`/`ENGINE_AUTH_WRITE`/`PATH_PERSIST`, `rcExportWriter`); keep `ENGINE_PROBE`/`hostEngineStatus`/`hostEnvEngine` (live in the launch guard). Update/retire `onboarding-engine-host-setup.test.js:92–96` and preload comments + `global.d.ts:64–77`.
2. F55 — delete the ten never-called bridge methods (`hostInfo`, `clientVersion` *(exposed method only — internal helper stays)*, `hostSmbStatus`, `setBackend`, `hostPathExists`, `sshKeygen`, `tailscaleStatus`, `hostKeyFingerprint`, `hasDurableHostKey`, `tCatalog`) + their preload lines, `global.d.ts` entries, and pinning source-text assertions.
3. F36 — prune `onboarding-preload.cjs` to **exactly the live set, derived at implementation time — and not with a single-line grep**: multiline chains (`window.remotepair` + `.tGetConsent()` / `.getConfig()` on the next line, App.tsx:97/160) and optional-chained calls (`window.remotepair?.tCapture?.(…)`, src/lib/telemetry.ts:41) defeat `window\.remotepair\.<name>` patterns. Derive it inversely: take the preload's own exported method names and grep the webview **implementation files** for each bare name (`\b<name>\b`, any call shape) — exclude `*.d.ts` from the scan (`global.d.ts` declares every method, so including it marks everything live); a method is dead only when its name appears in no implementation file, and `global.d.ts` is updated to the pruned set afterwards (~17+ live at e3750c8d — mapping, pairing, host install/update, consent, and telemetry calls are all live; do NOT trust any hardcoded count from the audit). **Bridge implementations of `sshReachable`/`hostPermissions`/`hostEngineStatus`/`hostEnvEngine` stay** (used by onboarding-main's launch guard); update `per-mapping-method-readback.test.js:104`.
4. F50/F56/F68 — `onboarding-main.cjs`: drop `engine: configuredEngine()` from the loadFile query, delete `configuredEngine()` and the `_completed` flag; `SESSION_ENGINES` stays (live at 108, 184–186). Update the three pinning assertions (`reonboarding-configure.test.js:140`, `onboarding-pre-workbench.test.js:32`, `client-preworkbench-onboarding.test.js:46`).
5. F69 — `App.tsx`: delete the numeric `startStep` parachute (54–57) and the unreachable `initialStep >= UPDATE` auto-select block (175–186); keep the `FOLDER_MAPS` preload above it.
6. F12 — delete `onboarding-webview/harness/` (broken shim of an architecture that no longer exists).
7. F70 — delete both `StepProgress.tsx` files (client + host webviews).
8. F71 — prune the host-onboarding vocabulary (~57 keys × 2 locales) and dead `shell.*`/`map.localPick`/`map.mountPoint` keys from the client webview `i18n.ts`. *(Skip if WS12 lands first — the union dictionary becomes shared there.)*
9. F51 — `OnboardingWindow.swift`: delete the `startInstall`/`getInstallStatus`/`connectedClients` shims, reply-handler cases, `global.d.ts` decls (the three crashing tests referencing them are handled in WS2 step 4).
10. F30 — **decision D3 (resolved): host launch-time auto-update is not wanted** — the client already gates on host version at connect (onboarding host-update gate), so a stale host is caught there. Delete `SettingsWindow.swift`, the `RPAutoUpdateCheck` key, *and* the launch-time auto-update check in `AppDelegate.startServing()` (~130). The manual "Check for Updates…" menu item stays as the only update trigger on the host itself.
11. F26 — `CaptureControlTests.swift`: wire, don't delete — add a `--capture-control-self-test` flag in `main.swift` calling `runAll()`, run it in CI after `swift build`; fix the diverged inner `Machine.start` force-unwrap (ScreenServer error-acks the nil case). Long-term refactor → shared pure transition function (out of scope).
12. F62 — `Installer.swift:88`: drop the dead `force:`/`refreshResources:` parameters (single behavior), fix the LEVEL-1 doc comment to match reality (version-up re-runs full install; bootstrap doesn't restart a loaded agent).
13. F54 — delete `telemetry.js` `sentryConfig()` + export; fix the header comment (no `@sentry/electron` consumer exists).
14. F53 — `extension.js:1938`: make the status-bar tooltip match the bound `endSessionReonboard` command; delete the stale `connectHost` comment.
15. F23 — **last**: replace `onboarding-main.cjs:215`'s "any own exported function" IPC dispatch with an explicit `RENDERER_METHODS` allowlist mirroring the (now-pruned) preload surface; unknown method → `{ error: 'unknown method' }`. This freezes the reduced surface and unexposes `spawnEnv`/`sshFailureKind`/`confirmGatewayBaseline` from the renderer.

**Acceptance**: t_15 + t_23 green; **preload, `global.d.ts`, and the IPC allowlist name the identical renderer-facing set, and the bridge's exports are a superset of it** — bridge-only helpers (`sshReachable`, `hostPermissions`, `hostEngineStatus`, `hostEnvEngine`, `spawnEnv` for extension.js) stay unexposed per step 3, so equality across all four surfaces is *not* the invariant. Add a small contract test asserting exactly this relationship (three-way equality + superset) — it prevents the next drift; webview onboarding completes end-to-end manually.

## WS9 — `fix/telemetry-consent` (medium)

**Findings**: F16, F17, F18.

**Design**: `telemetry.env` is the single source of truth for consent; the VS Code setting is a *mirror*. Singleton services in the dual-extension-host world are elected via one lockfile mechanism, mirroring the RD-tab dedupe.

1. F16 — `extension.js:306`: on activation, write file value → setting (never the reverse); propagate setting → file **only** on a real `onDidChangeConfiguration` event, and map the boolean to `TELEMETRY_CONSENT` only (crash-report consent stays onboarding-owned, per docs/logging.md §11.1). Kills the re-grant/revoke-on-activation and the stuck-flags round trip.
2. F17 — `extension.js:1898`: gate the send: `if (isFresh) telemetry.capture(EVENTS.APP_FIRST_LAUNCH, …)`. Careful: `firstRunStamp()` (telemetry.js:358–365) **writes `TELEMETRY_INSTALL_TS` when absent and then returns it**, so its return value cannot distinguish fresh from already-stamped. Change it to report whether it created the stamp (return `{ ts, created }`, or check absence *before* stamping) and derive `isFresh` from that — the claim-style pattern `claimHostConnectedOnce()` already implements; delete the redundant `remotepair.installTimestamp` globalState key.
3. F18 — `extension.js:2122`: claim an exclusive lockfile under `~/.xpair/client` (O_EXCL create with pid; stale-pid takeover; released on dispose) before starting `NotificationPoller` + the 20s `probeHost` loop, so exactly one of the two extension hosts runs them. Also fixes the double-counted `host_connect_failed` edge-trigger.

**Acceptance**: with consent granted in onboarding, Settings checkbox reflects it on next launch; toggling the checkbox off stops capture (verify `telemetry.env`); `app_first_launch` appears exactly once for a fresh `~/.xpair` (grep the posthog queue/log); only one poller lock exists while a window is open.

## WS10 — `fix/onboarding-wizard-ux` (medium) — PR #78, in review

> **As-built note (supersedes the original design below).** WS10 grew well past its audit findings during live QA. What actually shipped in #78:
> - **F37/F38/F39/F52** as designed. **F39 caveat**: making the host probe async introduced a race — the Update-step 650ms auto-skip could fire before the probe resolved and skip an outdated host. Fixed by gating the skip on a `probed` flag (set true on probe success *and* failure). **F38 caveat**: the Done guard's forced landing on Update (below-floor/major-mismatch) had to be distinguished from a user Back via a `forcedUpdateLanding` ref so only user Backs pass through to Discover.
> - **F21**: resolved as planned (route `NEEDS_PASSWORD` → re-pair guidance, no password form). **F13**: left untouched (deferred to WS14) as designed.
> - **U1 — pull-based pairing (user-directed):** pairing fields (`serviceInstanceID`/`hostNonce`/`pairPort`/`fp`) are no longer captured at scan time; a new `fetchPairingMeta` bridge method HTTP-GETs the host's `/.well-known/xpair-pairing.json` (port 8891) on host selection and every retry. Discovery is a listing hint only. This structurally kills the "host is not broadcasting" false-negative class. `fetchPairingMeta` was added to preload + `global.d.ts` + `RENDERER_METHODS` + the WS8 surface contract test (the sanctioned way to grow the frozen surface). A failed pull invalidates any stale transcript fields so WaitPerm can't poll a dead pairing window.
> - **U2 — Bonjour removed, replaced by a native LAN beacon (user-directed):** the dns-sd browse/resolve phase left `cmd_discover` and `BonjourAdvertiser.swift` left the host. Replacement: `host/app/LanBeacon.swift` UDP-broadcasts a secret-free JSON hint (`{v,kind,name,fp,role,user,metaPort,ver}`, <512B) to `255.255.255.255:8892` every 2s; `cmd_discover` gains a bounded UDP listen phase (sender IP = peer address). Discovery is now pure pull + announce-beacon; no mDNS. **The beacon starts at launch, BEFORE the permission run-gate** (the lifecycle Bonjour had) — gating it on `startServing()` deadlocked LAN-only fresh installs (onboarding completes only after a client pairs, which needs the beacon up). Pre-1.0: old dns-sd clients won't see new hosts / new clients won't see old Bonjour-only hosts — accepted, no compatibility shim.
> - **U3 — window boundary == design boundary:** `WizardShell` dropped the mockup backdrop band (a 720px card floated in a `bg-muted` padded band inside a 720px window → visible double border); the card root now fills the window, and the Electron BrowserWindow + host NSWindow shrank to the card's natural 720×524.
> - **U4 — logo:** both webview logo assets were 128px upscales (blurry on Retina); regenerated at 512px from `assets/icon/Logo-1024.png` and rendered `object-contain` (never cropped).
>
> The `SessionDataProvider` for the bottom bar and the "broadcasting" copy cleanup that U2 implies are **WS17**, not here.

**Findings**: F13, F37, F38, F39 (webview), F21 (bridge contract), F52 (host Done step).

1. F37 — `App.tsx:263–267` `retryHostPrompt`: merge the fresh identity **and endpoint** fields into the selected host. Beware the schema boundary: `match` is a raw discovery peer whose fields are `fp`/`target`/`pairingAddress`/`addrs[]`/`hostUser` — **`match.sshTarget` and `match.address` do not exist**; `sshTarget`/`address` are products of `peerToHost()` (StepDiscover.tsx:33–42). Export `peerToHost` (or move it next to the `DiscoveredHost` type per WS10 step 3) and merge from the mapped object — keeping the updater's existing same-host guard, since the user can pick another host or navigate back before `discover()` resolves: `const m = peerToHost(match); setSelectedHost(h => (h && h.id === selectedId ? { ...h, ...m, hostKeyFP: m.hostKeyFP || h.hostKeyFP } : h))` (no-op on null/changed selection; `||` keeps the old fp when the fresh one is absent). `StepWaitPerm` keys `pairingStatus`/`pinHostKey`/`setHost` off `sshTarget ?? address` (StepWaitPerm.tsx:53), so refreshing only the nonce fields would send the new pairing request while polling, pinning, and persisting the stale target. Today "Try Again" can never succeed for an fp-less host.
2. F38 — `App.tsx:326`: make the Update pass-through step direction-aware: on `w.direction === "prev"` immediately `w.goTo(S.DISCOVER, "prev")`; keep the 650ms auto-`next()` only for forward entry. Kills the Back-button bounce trap.
3. F39 — single probe owner: `StepDiscover.chooseHost` only does `setSelected(peerToHost(peer))`; App's id-keyed effect stamps version/flags via `probeSelectedHost`; delete `StepDiscover`'s `deriveHostFlags` copy (export App's). The Update-step entry re-probe (276–283) stays.
4. F13 — **moved to WS14** (decision D5: build real browsing). WS10 leaves `StepMappings` untouched — the fake tree is explicitly labeled as examples and picks are host-verified, so it can survive until WS14 replaces its data source; deleting it here would just churn UI that WS14 re-backs.
5. F21 — **re-check against the landed in-flight branch first.** If still bridge-only: keep the states but make `StepUpdate` map `result.action === 'prompt_password'` to re-pair guidance (route to pairing) instead of surfacing the impossible "enter the host password" text. Do not build a password form unless the in-flight branch already did.
6. F52 — `host/onboarding/src/App.tsx:377`: await `window.xpair.complete()`; on `{ok:false}` surface the reason via the existing error UI (or `goTo` the first unmet permission step). The primary CTA currently fails silently.

**Acceptance**: wizard walkthrough — Back from WaitPerm reaches Discover; Try Again succeeds after a host starts broadcasting; one SSH probe per host pick (count via bridge log); host Done step shows feedback when completion is refused.

## WS11 — `fix/bench-scoring` (medium/low, isolated)

**Findings**: F07, F08 (medium), F40, F41, F42 (low).

1. F07 — `baseline-score.sh:35`: exclude gate-failed runs (`score === -1e9`) from mean/stddev — `records.filter(r => r.gates && r.gates.passed)` — report an `excludedRuns` count and exit nonzero when any run was excluded (a flaked baseline must be visible, not averaged; grid.sh:88 already does `+r[2]>-1e8`).
2. F08 — `relay.js:335`: RTX-ssrc retransmits must traverse the same link impairment as everything else — factor `delayFor` to take a key, use `rtx:${ssrc}:${seq}`, add `bwRtx.delayMs`; and drop RTX inside the marked-burst outage window. Today NACK/RTX recovery (Chrome's real path) arrives with zero link latency under latency profiles.
3. F41 — export `rateFromCounter` from `score/score.js`; `client/variance.js` requires it, delete the comment-guarded rewrite (baseline normalization must not be able to drift from scoring).
4. F42 — `grid.sh:14`: default `HOST_BIN` to the deployed binary `$HOME/.xpair/host/bin/screen` (matching run-baseline/run-impaired). `sweep-pli.sh` keeps its experimental default — documented intentional (header + docs/rd-enhance-plan.md).
5. F40 — README: add `marked-burst` + `BURST_SCHEDULE`, document `RETX_LOSS`/`BW_KBPS`/`BW_BUFFER_MS`, correct the proxy stats filename (`proxy-<profile>-<timestamp>.json`), add `npm run score-check` to the verify section.

**Acceptance**: `bench/score/score.test.js` + `relay.test.js` green (extend relay.test.js with an RTX-delay case); a synthetic gate-failed record no longer shifts the aggregate mean.

## WS12 — `refactor/onboarding-ui-shared` (architecture) — after the in-flight branch

**Findings**: F15, F11.

- F15 — the onboarding UI kit is duplicated between `host/onboarding/src` and `ext/onboarding-webview/src` (11 byte-identical files, union i18n dictionaries, already-diverged drift). Extract to `shared/onboarding-ui/` and point both vite roots at it via a resolve alias (both already use `@` aliases; no packaging needed). Each app keeps only its own `Step*`/`App.tsx`. i18n: one shared base dict + per-app extension — this supersedes WS8 step 8 (F71) if it lands first.
- F11 — **decision D1 (resolved)**: build the client webview at build time — add `npm ci && npm run build` for `ext/onboarding-webview` to `client/ide/build.sh` before the ext injection (mirroring `build-host.sh`), delete the committed `ext/onboarding-webview/dist` and gitignore it. Two packaging caveats: (a) `dev-build.sh` injects the ext tree with a blanket `cp -R`, and `onboarding-main.cjs` loads `__dirname/onboarding-webview/dist/index.html` from the INJECTED tree — so the dist must exist inside what gets copied, while `node_modules` must not. Concretely: build in place (producing `ext/onboarding-webview/dist`), then make the injection copy exclude `onboarding-webview/node_modules` and `onboarding-webview/src` (rsync `--exclude` or post-copy `rm -rf`); a temp-dir build is fine only if the dist is staged back into the tree before injection. (b) any release step that consumed the committed dist must now run after `build.sh`.

**Acceptance**: both apps build from the shared source; `diff -r` of the extracted files against pre-refactor copies is empty (pure move); onboarding renders in both surfaces; no committed dist drift possible (whichever D1 option).

## WS13 — `fix/win32-gates` — **PARKED** (decision D2)

**Findings**: F19, F20 — accepted as known-latent. **Decision D2 (resolved)**: Windows support arrives via the Rust CLI (PR #37); until it merges, the product is mac-only and no win32 gating work is done. Do not start this WS; the plan below is kept so the findings aren't lost when PR #37 lands:
- F19 — `extension.js:1625` `runXpairCli`: branch on `process.platform` — win32 spawns the executable argv-style (no login-shell wrapper, no `shSingleQuote`); gate `sshControlPath`/`sshRun`/`spawnTunnel` ControlMaster usage behind `!== 'win32'`.
- F20 — skip the pre-workbench onboarding gate on `process.platform !== 'darwin'` (open the workbench normally, show a "host setup requires the CLI — coming to Windows" notice) until a win32 CLI exists. Long-term: platform-branch `rpBin`/`installCli`/`openHostOnboarding`.

**Acceptance**: mac behavior byte-identical (t_15/t_23 green); code inspection shows no POSIX-shell spawn reachable on win32.

## WS14 — `feat/onboarding-host-browse` (D5) — after WS8 + WS10

**Findings**: F13. **Decision D5 (resolved)**: build real host folder browsing; the fake `HOST_FS` tree goes away by being *replaced*, not deleted.

**Design**:
- New bridge method `listHostDir(target, path)` in `onboarding-bridge.js`: one `ssh` invocation of `ls -1apL` (or `find -maxdepth 1 -type d`) via the existing hardened ssh helper the bridge already uses — **directories only**, home-anchored default, path passed through the same quoting/validation as `resolveHostPath` (this is post-TOFU code: reuse its host-key-pinned connection options). Returns `{ok, entries:[{name, path}], err}`; never throws into the renderer.
- Expose via `onboarding-preload.cjs` + `global.d.ts`, and add to WS8's frozen `RENDERER_METHODS` allowlist — this is the sanctioned way to grow the surface: method + preload + types + allowlist + a caller, all in one PR (the WS8 contract test enforces the set stays identical).
- `StepMappings.tsx`: delete the `HOST_FS` constant + `nodeAt`; the existing tree pane fetches lazily per expanded directory (cache per path, spinner per node), falls back to the manual input with a labeled error when `listHostDir` fails (offline host, permission). Picks remain verified via `resolveHostPath` before persisting — browsing is a convenience, not a new trust path.

**Steps**: bridge method + tests (mirror an existing bridge ssh-method test, incl. a quoting case for paths with spaces/Hangul); preload/types/allowlist; StepMappings data-source swap; i18n keys for loading/error states (EN+KO).

**Acceptance**: browsing a real host shows its actual home directories lazily; a path with spaces round-trips; killing ssh mid-browse degrades to manual input with a visible error; the WS8 surface contract test passes with exactly one new method.

## WS15 — `fix/rd-datachannel-ownership` (D4) — own branch, soak-tested

**Findings**: F60 (the redesign half; WS7 already fixed the stale comments). **Decision D4 (resolved)**: converge on `negotiated: true` + fixed channel IDs.

**Design**: both sides declare `rp-ctl` (id 0) and `rp-move` (id 1) with `negotiated: true`, removing the four-live-channels split-brain and the client's silent mid-session switch from client-created to host-created SCTP streams. Host side: `serve_webrtc.rs` channel creation; client side: `media/remote-desktop.js` `ctlDC`/`moveDC` setup. The client's `ondatachannel` handlers are NOT removed in this release: a new client against a previous-release host only receives channels through `pc.ondatachannel` (remote-desktop.js:612-615), so the handlers stay as the legacy path for the migration window and are deleted together with the fallback one release later. The input-ready gate stays (it also covers capture readiness, not just channel ordering).

**Constraint**: version-skew — an old client against a new host (or vice versa) must still connect. **There is no existing RD protocol-version negotiation to lean on** (`shared/screen-protocol/constants.json` is transport constants only; neither `serve_webrtc.rs` nor `remote-desktop.js` exchanges a version), so step 0 of this WS is to add one — and it must complete **before the host creates its channels**: the host builds `rp-ctl`/`rp-move` before sending the offer, so a capability carried only in offer/answer JSON arrives too late to pick the channel mode. Carry it in the client's FIRST signaling message (add a hello if none exists today — the current browser client sends nothing until the host's offer arrives, remote-desktop.js:684-692), register it in `shared/screen-protocol` so the SoT guard covers it, and have the host choose negotiated-vs-legacy per session from it. The host's wait for that capability must be BOUNDED (first client message or a short timeout, then default to legacy) — an old client never sends a hello, and an unbounded wait would stall every legacy connection. Keep the client's `ondatachannel` fallback handlers alive for the transition release; drop the fallback one release later.

**Acceptance**: manual soak — 30-minute RD session with continuous input, reconnect ×5, host restart mid-session; `webrtc-internals` (or rust-side stats) shows exactly 2 data channels; cross-version pairing against the previous release still connects.

---

## Decisions (resolved 2026-07-07 KST / 2026-07-06 UTC, by the maintainer in-session)

| ID | Question | Decision |
|---|---|---|
| D1 | Client webview `dist/`: commit or build? | **Build at build time** in `client/ide/build.sh`, delete + gitignore the committed dist (WS12). |
| D2 | win32 interim handling? | **None — mac-only until the Rust CLI (PR #37) merges.** WS13 parked; F19/F20 accepted as known-latent, revisit when #37 lands. |
| D3 | Host launch-time auto-update? | **Not needed** — the client's connect-time host-version gate covers stale hosts. Delete `SettingsWindow`, `RPAutoUpdateCheck`, and the `startServing()` check; manual "Check for Updates…" menu stays (WS8 step 10). |
| D4 | DC ownership redesign? | **Yes** — `negotiated:true` + fixed IDs as its own soak-tested branch, WS15, with a protocol-version fallback window. |
| D5 | Real host folder browsing? | **Yes** — `listHostDir` bridge + lazy tree, WS14 (supersedes WS10's F13 step). |

## WS16 — `fix/host-permission-model` (new, from live QA) — queued

Not an audit finding — surfaced when the maintainer tested the host onboarding on 2026-07.

**Problems (verified in code):**
- `StepSinglePerm.tsx`: `PERM_ORDER = [login, ax, sr, fda, sharing]` but `REQUIRED_PERMS = [login, ax, sr]`. File Sharing (`sharing`) is only *recommended*, so `nextDisabled` (App.tsx) never blocks on it and the parachute (`firstUnmetPermIndex`, required-only) never lands there — the wizard auto-advances past an ungranted File Sharing. But **File Sharing is mandatory for SMB mounts** (the whole `/Volumes` mount path), so it must be required.
- `host/onboarding/src/App.tsx:75` `crashReports = useState(true)`: the crash-report (Sentry) consent toggle renders **checked by default** until the async `getConsent()` load overwrites it, and `StepConsent.tsx` badges crash as "recommended". The storage layer is correctly opt-in (`AppDelegate` registers `RPCrashReportConsent=false`; `SentryBridge.setupIfConsented` needs consent+DSN), but the UI default contradicts docs/logging.md §11.1 ("both flags default OFF, opt-in") and can persist consent:true for a user who never touched the toggle. *(Note: the maintainer separately found Sentry receives zero events regardless — the release build ships no `RPSentryDSN`, so the backend stays Noop. That DSN-pipeline fix is tracked separately and is out of WS16 scope by the maintainer's instruction.)*

**Design:**
1. Move `sharing` into `REQUIRED_PERMS` (mount needs it). The parachute + `nextDisabled` then block/land on it automatically — the landing machinery already exists, it was just scoped to a too-narrow required set. `fda` stays recommended unless a mount path is shown to need it.
2. `crashReports` default → `false`; disable the toggle until `getConsent()` resolves (no checked-then-unchecked flash); drop the "recommended" badge on crash so it reads as opt-in, matching §11.1.

**Acceptance:** fresh host with File Sharing off cannot advance past the sharing step and re-lands there on reopen; a click-through host onboarding leaves `RPCrashReportConsent` false.

## WS17 — `fix/session-restore-and-bottom-bar` (new, from live QA) — after WS10

Not an audit finding — surfaced in live QA. Touches both the IDE frontend patch (`client/ide/remotepair/patches/zz-remotepair-ide-frontend.patch`) and the extension, so it lands after WS10 (#78) to avoid `extension.js` churn.

**Problems (verified in code):**
- **Bottom-bar Detached/History are permanently empty.** `remotePairSessionManager.ts` exposes a `setSessionDataProvider` hook, but **no caller exists anywhere in the repo** — the default empty provider is always used. Only the Attached tab works (fed by the sidebar's own registry).
- **No opened-set persistence / restore.** The only "restore" in `extension.js` is the RD webview panel serializer. Nothing records which sessions were attached at quit, and nothing re-attaches them on next launch — a relaunch reopens with no terminals.

**Desired contract (maintainer):** define *opened* = the sessions attached (live terminal tabs) at the moment of last quit. Persist that set; on next launch re-attach exactly those (not every detached session). Invariant: every terminal tab appears in Attached, and every terminal tab corresponds to an attached session — nothing outside Attached (except the brief `xpair launch` → tmux-created window).

**Design:**
1. **Data supply**: the extension registers a workbench command the patch calls (mirroring the `setSessionLauncher`/`setAttachedSessionsProvider` injection pattern), pushing `xpair ls --json` poll results so the renderer never spawns a child process. Detached = in tmux, `attached==0`, not a local tab; History = a last-seen session-name store (extension-maintained) whose session is no longer in tmux.
2. **Opened-set persistence**: write `~/.xpair/client/opened-sessions.json` on every terminal tab open/close (write-on-change *is* the last-quit snapshot — a quit hook is unreliable).
3. **Restore**: on activation, read the opened set, and for each session still present in tmux, re-attach via the existing `setSessionReattacher` path (same as clicking a Detached card), gated on host reachability with bounded retry.
4. **Invariant**: the tab→Attached direction is already structural (sidebar registry); the Attached→tab direction is enforced by deriving Attached from the tab registry reconciled against tmux state, not tmux state alone.
5. Also fold in the U2 fallout: remove the now-dead host Bonjour advertising remnants and retire "broadcasting" copy in favor of "discoverable on your network / Tailscale".

**Acceptance:** quit with N terminals attached → relaunch re-attaches exactly those N (verified against a tmux fixture); Detached/History tabs populate from `xpair ls`; no terminal tab exists without a matching Attached entry.

## Rejected findings (for the record)

2 of 73 raw findings were refuted in adversarial verification and are excluded above. Full verdicts (including the per-finding refutation reasoning for all 73) live in the audit session archive, not in-repo.

## Appendix — findings index

| ID | Sev | Kind | Location | Summary |
|---|---|---|---|---|
| F01 | high | bug | client/cli/xpair:1927 | Empty `SSHENV[@]` under `set -u` aborts `install-host` on stock bash 3.2 (7 sites) |
| F02 | high | bug | host/xpair-approve-router.sh:87 | `sendkey` empty-modifier array aborts the approve router on bash 3.2 |
| F03 | high | design-pattern | tests/run.sh:17 | rc=0 without `__SUMMARY__` counts as passing — the silent-pass root cause |
| F04 | high | dead-code | tests/t_15_ext_js_contracts.sh:22 | 21 `*.test.js` outside ext/ run under no runner; 11 currently fail/crash |
| F05 | high | bug | tests/t_16_map_method.sh:71 | Never calls `finish` — 8 assertions can fail without failing CI |
| F06 | high | bug | tests/t_17_doctor_smb.sh:42 | Never calls `finish` — entire doctor-SMB coverage inert |
| F07 | med | bug | bench/baseline-score.sh:35 | Gate-failed runs (−1e9) averaged into baseline mean/stddev |
| F08 | med | bug | bench/proxy/relay.js:335 | RTX retransmits bypass link latency/jitter (and burst window) |
| F09 | med | dead-code | client/cli/host-child-computer-use.test.js:35 | 4 of 11 cli tests stale-failing; none wired to a runner |
| F10 | med | architecture | client/cli/xpair:266 | Mapping/SMB helpers copy-pasted ×4, matching semantics drifted |
| F11 | med | architecture | client/ide/remotepair/dev-build.sh:146 | Client webview dist committed & never rebuilt; build-ID canary broken |
| F12 | med | dead-code | ext/onboarding-webview/harness/preload.cjs:6 | Electron harness unreferenced and structurally broken |
| F13 | med | bug | …/client/StepMappings.tsx:86 | Folder-browse dialog renders hard-coded fake tree (`HOST_FS`) |
| F14 | med | dead-code | host/onboarding/onboarding-gate.test.cjs:1 | All 6 host onboarding contract tests unwired |
| F15 | med | architecture | host/onboarding/src/lib/i18n.ts:1 | Onboarding UI kit duplicated across two vite roots, drifting |
| F16 | med | architecture | ext/extension.js:306 | Telemetry consent in two stores; lossy one-way sync collapses two flags |
| F17 | med | bug | ext/extension.js:1898 | `app_first_launch` fired every activation ×2 hosts, stamp unused as gate |
| F18 | med | bug | ext/extension.js:2122 | NotificationPoller + probeHost run once per extension host (×2) |
| F19 | med | bug | ext/extension.js:1625 | `runXpairCli` hardcodes POSIX login shell — dead on win32 |
| F20 | med | bug | ext/onboarding-bridge.js:75 | Pre-workbench gate is darwin-only; win32 build dead-ends |
| F21 | med | bug | ext/onboarding-bridge.js:1869 | `NEEDS_PASSWORD` bridge state surfaces an impossible instruction in StepUpdate |
| F22 | med | dead-code | ext/onboarding-bridge.js:1488 | Dead engine-setup cluster still renderer-reachable (API-key pipe) |
| F23 | med | design-pattern | ext/onboarding-main.cjs:215 | IPC dispatch allowlists *any* exported function (incl. `spawnEnv`) |
| F24 | med | design-pattern | host/rd/rpmedia/rp-input-inject.swift:171 | Per-keystroke blocking `osascript` stalls all remote input |
| F25 | med | bug | host/rd/screen/src/serve_webrtc.rs:1674 | Failed capture start leaks RTCPeerConnection (ICE/DTLS/UDP) |
| F26 | med | dead-code | host/app/CaptureControlTests.swift:176 | Self-test never invoked; diverged state-machine copy ships in release binary |
| F27 | med | bug | host/app/CaptureEngine.swift:199 | `stop()` races the sample queue + VT callback (violates own invariant) |
| F28 | med | bug | host/app/EngineGuard.swift:221 | Sequential pipe drain can deadlock engine install on 64KB stderr |
| F29 | med | bug | host/app/OnboardingWindow.swift:111 | rpbridge handler retain cycle leaks window+WKWebView per open |
| F30 | med | dead-code | host/app/SettingsWindow.swift:7 | Dead Settings window is the only writer of `RPAutoUpdateCheck` |
| F31 | med | dead-code | host/app/host-client-separation.test.js:1 | 7 host/app contract tests unwired |
| F32 | med | bug | Casks/xpair-host.rb:26 | No `uninstall launchctl:` — KeepAlive agents survive brew uninstall |
| F33 | med | bug | shared/config.sh:39 | Role env files clobber caller env — documented priority inverted |
| F34 | med | architecture | .github/workflows/ci.yml:29 | Three SoT drift guards exist but no CI job runs them |
| F35 | med | bug | host/app/host-onboarding-q0441.test.js:21 | 3 tests crash on files deleted in PR #60 |
| F36 | med | dead-code | ext/onboarding-preload.cjs:10 | 16/36 exposed `window.remotepair` methods have zero callers |
| F37 | med | bug | …/onboarding-webview/src/App.tsx:265 | `retryHostPrompt` drops `match.fp` — Try Again can never succeed |
| F38 | med | bug | …/onboarding-webview/src/App.tsx:326 | Update auto-skip ignores direction — Back bounces forward |
| F39 | med | architecture | …/onboarding-webview/src/App.tsx:227 | Host probing owned twice; policy duplicated verbatim |
| F40 | low | bug | bench/README.md:72 | README drifted: missing profile/knobs, wrong filenames |
| F41 | low | architecture | bench/client/variance.js:53 | `rateFromCounter` re-implemented instead of shared |
| F42 | low | bug | bench/grid.sh:14 | `HOST_BIN` defaults to a one-developer experimental path |
| F43 | low | architecture | client/cli/uninstall-host.sh:55 | Duplicate drifted teardown (8 vs 15 labels, no manifest revert) |
| F44 | low | dead-code | client/cli/xpair:1516 | `_rp_peer_status`/`_rp_in_ssh_config` never called; policy superseded |
| F45 | low | bug | client/cli/xpair:1325 | `logs --collect` empty-array abort on bash 3.2 |
| F46 | low | bug | client/cli/xpair:1074 | mosh fallback diagnostic always reports rc=0 |
| F47 | low | dead-code | client/cli/xpair:99 | `TMUXB` assigned, never used |
| F48 | low | dead-code | client/cli/xpair-launch:512 | `_remote_next_n` dead param + discarded state word |
| F49 | low | bug | client/cli/xpair-mount:292 | Post-mount tip references nonexistent config key (exit 2 if followed) |
| F50 | low | dead-code | ext/onboarding-main.cjs:298 | `engine` query param unread by webview (pinned by 3 tests) |
| F51 | low | dead-code | host/app/OnboardingWindow.swift:201 | `startInstall`/`getInstallStatus`/`connectedClients` shims unused |
| F52 | low | bug | host/onboarding/src/App.tsx:377 | Done CTA fire-and-forgets `complete()`; `{ok:false}` silent |
| F53 | low | bug | ext/extension.js:1938 | Status-bar tooltip promises connect, command re-onboards (cosmetic) |
| F54 | low | dead-code | ext/telemetry.js:406 | `sentryConfig()` exported, zero consumers, phantom dependency |
| F55 | low | dead-code | ext/onboarding-bridge.js:1644 | Ten more bridge methods with zero product callers |
| F56 | low | dead-code | ext/onboarding-main.cjs:298 | `_completed` flag written, never read |
| F57 | low | dead-code | host/rd/screen/Cargo.toml:100 | Five passthrough cargo features gate nothing |
| F58 | low | bug | host/rd/screen/src/main.rs:153 | No console sink — `screen info` prints nothing |
| F59 | low | bug | host/rd/screen/src/serve_webrtc.rs:2226 | Killed rp-screencap never reaped — zombie per session |
| F60 | low | architecture | host/rd/screen/src/serve_webrtc.rs:1538 | Both peers create ctl/move channels; comments contradict reality |
| F61 | low | dead-code | host/rd/screen/src/serve_webrtc.rs:1586 | `Session` enum match arms unreachable by construction |
| F62 | low | dead-code | host/app/Installer.swift:88 | Dead `force:`/`refreshResources:` params; LEVEL-1 contract false as written |
| F63 | low | bug | Casks/xpair.rb:27 | zap misses `~/.xpair/ide` and `~/.xpair/ide-server` |
| F64 | low | bug | host/xpair-approve-router.sh:30 | Unlocked `mv` log rotation violates the mkdir-lock contract |
| F65 | low | architecture | shared/logging.sh:15 | Declared host install path never installed — consumers on no-op fallback |
| F66 | low | bug | shared/sync-setup.sh:12 | Reversal entries split across two manifests — remote never uninstalled |
| F67 | low | bug | .github/workflows/ci.yml:25 | `bash -n` gate skips missing files; list omits shipped scripts |
| F68 | low | dead-code | ext/onboarding-main.cjs:298 | `configuredEngine()` orphaned with the engine param |
| F69 | low | dead-code | …/onboarding-webview/src/App.tsx:174 | Resume-parachute block unreachable (producer vocabulary can't trigger it) |
| F70 | low | dead-code | …/onboarding/StepProgress.tsx:3 | Exported, never imported (both webviews) |
| F71 | low | dead-code | …/onboarding-webview/src/lib/i18n.ts:123 | Entire host vocabulary (~57 keys ×2 locales) dead in client bundle |
