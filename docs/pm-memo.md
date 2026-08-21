# pm-memo.md — xpair PM working record

PM working notes, provenance, correction log, and parked material. Not a requirements source — `spec.md` is authoritative, `register.md` is the utterance→requirement trace. This file holds what neither of those is.

Owner: xpair DRI session. Append-only by convention; supersede, never delete.

---

## Provenance — how the record was built (2026-08-21, "migration" run #1)

The three PM files (`register.md`, `spec.md`, this file) were established on 2026-08-21 per a VP Type-1 allocation. Method followed the `/orchestrate migration` procedure (skill not yet built; instructions relayed as directive): investigate **intent** sources only — code is out of scope — and extract append-only, so re-runs converge.

Sources drawn from, in order of signal:

1. **`develop/docs/requirements.md`** — a reconstructed requirements layer, each requirement already cited to raw Q-IDs. This is the spine of `spec.md`.
2. **`develop/docs/requirements-raw.md`** — 542 human Q/request entries (Q0001–Q0552) extracted from 18 top-level Claude Code sessions in the pre-migration repo `Lang-Swift/remote-pair` (2026-06-02 onward). This is the CEO-utterance corpus behind `register.md`. Kept as a pointer, not copied.
3. **`recovered-queries-git-windows.md`** (repo root) — 66 user queries recovered from the 2026-06-22 git-migration / mosh-windows session (`Lang-Swift/remote-pair`, session `fcd7ea57…`). Mostly ephemeral git-rescue chatter; a handful carry durable requirements (repo→`xpair/{branch}` layout, codex-as-worker, mosh-over-ssh for tmux rendering, windows-host future).
4. Secondary intent docs in `develop/docs/` (README, architecture, roadmaps, behavioral-spec/, design-*) — gap-digested for intent not already in requirements.md.

**Not used as intent** (implementation fact, not intent — out of scope by method):
- Source code anywhere in the tree.
- `develop/docs/subagents/*.md` — machine-generated scratch (numeric filenames), no human intent.
- Root `docs/rd-loss-benchmark/` — a nested benchmark clone, not this product's intent.

**Session-store finding.** The repo-root `.session-context.sqlite` holds only this session. The real history is `develop/.session-context.sqlite` (255 turns), but it is 80% `COEXE` (codex-exec, 204) + `COSub`/`CCSub` subagent turns — machine, not human. Only 5 `Claude`-source turns exist and they are trivial ("xpair host 이 컴에 깔려있는거 지우려면 어떻게 해?", "했어"). **The store carries almost no durable human intent** — the Q-corpus above is the real utterance record.

---

## ⚠️ SUPERSEDED BY CEO — 0.5/0.6 abandoned, live base is 0.4.13

**CEO 2026-08-21:** *"원래 0.5 0.6 만드려던 건 폐기했고... 지금은 0.4.13 돌리고 있어. 너도 0.4.13 위에서 돌고있어."* The 0.6.0-reframe headline below (written earlier the same session) is **history, not direction.** Corrected reality:

- **Live base = 0.4.13** (`remote-pair`): tag `v0.4.13`, branch `origin/release/v0.4.13`, installed & running at `~/.remote-pair` (`.version`=0.4.13, pid ~1210). This session runs on it.
- **0.5.x + 0.6.0 = scrapped.** The `develop` worktree (0.5.x monorepo + 0.6.0 docs, HEAD `v0.5.1a13`+19) is the abandoned line. There's a live-line worktree at `fix/v0413-engine-picker/` (uses legacy `remote-pair-approve-router.sh`).
- **The corpus (§0–4 of spec) is the live 0.4.x-era intent** — not superseded after all. The whole "0.6.0 supersedes corpus" raise is moot.
- **#2 approve target flips** to the live **`remote-pair-approve-router.sh`** — same bug confirmed by direct read at lines **145/155** (`dialog_gone()` @117, `for combo` loop @139). The VP-briefed `xpair-approve-router.sh` 143/153 is on the dead 0.5.x line. (The VP's *first* reading of `remote-pair-approve-router.sh` from `Env-X10lab/remote-pair` was actually the closer-to-live legacy file.) The installed running copy differs slightly from the worktree copy — the fix targeted the 0.4.13 release line and was verified against tests. **Fixed in PR #121 (merged); deploy to the running `~/.remote-pair` host is a separate step owned by whoever runs it.**
- **Record placement RESOLVED (CEO, 2026-08-21):** the record + the #2 fix target `release/v0.4.13`. The three files (plus the provenance sources `requirements.md`, `requirements-raw.md`, `recovered-queries-git-windows.md`) are placed on the live line via PR #120; #2 is PR #121. Authored in `develop/docs/`, placed on the live line by the Sol-mode Codex implementer (PM authors, implementer places — one writer per checkout).

---

## Headline finding of migration #1 (SUPERSEDED — see above) — the 0.6.0 reframe supersedes the corpus

The single most important thing the record turned up: **`roadmap-0.6.0.md` (self-declared "engineering SSoT") redefines the product and supersedes several baseline `[사실]` requirements.** This was not in `requirements.md` (the reconstructed corpus, 2026-06); it is a newer decision layer.

- **Identity shift:** Xpair is now framed as *infrastructure that owns and keeps alive an agent-dedicated Mac* — the daemon/machine layer — with editors/terminals/IDEs demoted to **bring-your-own** clients. Litmus: build the daemon, not the workbench.
- **Workbench FROZEN (D1):** the VSCodium IDE is a "reference client," no new IDE features. This freezes the corpus's M3 "IDE shell UX" investment (Sessions-first, RD-default-surface, Browser SSOT remain as behavior, but are not where effort goes).
- **System sshd front door (D2):** custom SSH transport dropped; tailnet-only, fail-closed at the packet layer; access ≠ session (`xpair launch` is explicit).
- **All two-way sync BANNED (D4):** supersedes the corpus's mount-first/Syncthing-fallback (REQ-MAP-4). Host FS is the single source of truth; SMB mount → open-remote-ssh (D5).
- **GUI broker is the moat (D3):** answers TCC prompts against a whitelist with an audit log. **The approve items #2/#3 live inside this** — approve *is* the broker's ongoing-prompt-handling job.

Recorded in `spec.md` §−1 (governing layer + supersession map) and `register.md` §2. **Raised to VP/CEO** because it reprioritizes the roadmap and, with the ledger empty, reads as the de-facto goal direction the empty O/KR should be set against.

Verified against the primary doc directly (not just the digest) before reshaping the spec.

**Version reality — 0.6.0 is a destination, not shipped (CEO-confirmed base is 0.4, 2026-08-21).** Three layers: **0.4.x legacy `remote-pair`** (last documented 0.4.12; no 0.4.14 found in-tree — CEO's "0.4.14" is the nearest memory of the 0.4 line; the running app on this machine is this legacy line) → **0.5.x current Xpair** (git HEAD `v0.5.1a13`+19, cask `0.5.1a1`, identity host 0.5.0; alpha, no stable) → **0.6.0 forward roadmap** (the reframe; mostly NOT built — 0.5.x still has SMB mount, IDE surfaces, `~/.remote-pair` paths). *(This "Version reality" block was an intermediate note written when the CEO first said "base is 0.4.14"; it is superseded by the top "SUPERSEDED BY CEO" block — 0.5/0.6 are abandoned and the corpus ≈ the live 0.4.13, not 0.5.x.)* The approve fix (#2) targets the LIVE 0.4 `remote-pair-approve-router.sh` (see REQ-APPROVE-4 and the correction log); the 0.5.x `xpair-approve-router.sh` is the dead line. The installed skill correctly calls `remote-pair` because 0.4.13 is what runs here.

## Ledger status

Domain O/KR is **empty — awaiting CEO** (per VP). Consequence: priority in `spec.md` cannot be justified against a KR. The M1–M6 roadmap ordering is inherited from `requirements.md` (dependency-derived), **not** goal-derived, and is subject to reversal once the ledger is set. Flagged so no reader mistakes the roadmap for a settled priority.

---

## Parked material — approve items #2 and #3 (do before starting, referenced by spec REQ-APPROVE-*)

VP Type-1 allocation put two `approve` items on this session, after the record. Both are settled at fact-grade below because the **VP independently verified** the numbers (opened the live tree with `sed`), correcting an earlier relayed report. Materials from peer PM `skill-orchestrate`.

### #2 — approve router success verdict is a false positive

- File (LIVE 0.4.13 target): **`host/remote-pair-approve-router.sh`**. (The abandoned 0.5.x tree's `xpair-approve-router.sh` was the VP's initial mis-target; it is the dead line.)
- `dialog_gone()` at **line 117**; success returns at **lines 145 and 155**.
- Line 145 sits inside a `for` loop that presses candidate keys `key:A|B` sequentially and does `return 0` at the **first key that closed the window** — it never checks *which* button. **Pressing Decline and closing the dialog is recorded as `success`.** (Fixed in PR #121, merged 2026-08-21.)
- **Falsifier (check first):** if the router already confirms the result by some path other than "dialog closed" (which button, or whether the blocked call actually unblocked), the diagnosis is wrong.
- Fix *direction* (skill-orchestrate's opinion, not a design directive — method is this session's): verify the outcome, not the closure — which button, or that the blocked call resumed.
- Evidence it is real (not weak): two sessions blocked on this today. `recordings` escalated it as "false positive, outside my authority"; `landing` misdiagnosed a 1Password approval twice before reaching "config is fine, approve can't handle that window". CEO: *"approve가 지금 동작을 잘 안하는듯"*.

### #3 — approve skill guidance (LARGELY ALREADY DONE on the live line — verify-only residual)

**Premise corrected by direct read of the live 0.4.13 skill (2026-08-21).** skill-orchestrate's report said two content pieces were "missing from the repo skill and need porting." That premise came from the abandoned 0.5.x skill and is **FALSE against the live line.** The live `host/skills/approve/SKILL.md` already carries the substance:

- **(a) arm-before-dialog ordering** — line 47 already documents the "tool call already failed with Permission denied → non-blocking fallback → immediately (≤7s) retry the failed call" ordering, and that the blocking wrapper times out because the window can't be raised while it waits. That IS the order-sensitivity point.
- **(b) non-blocking fallback vs blocking** — lines 46–47 already distinguish blocking `remote-pair approve` from the non-blocking fallback. **BUT the `~/.remote-pair/bin/approve` helper it references (lines 29/47) does NOT exist** (verified 2026-08-21: `~/.remote-pair/bin/` holds only `remote-pair-launch`, `remote-pair-watchdog.sh`, `rp-screencap`, `screen`; no `approve`, and no repo generator — `shared/install.sh` creates only the watchdog there). So the documented `bin/approve` path is **dead**; only the `touch /tmp/remote-pair.approve-request` trigger path could work, and only if something watches that file (unverified). **This is a real product gap in the live skill, not just a record error** — tracked under REQ-APPROVE-5's residual (and the queued approve-enhancement, which is held outside this committed record until the record PR lands).
- **CLI is `remote-pair approve`** (skill lines 11–13), never `xpair approve`.

**Residual work (small, verify-first):**
- Diff the installed copy `~/.claude/skills/approve/SKILL.md` (which `landing` edited) against the live repo skill — is there any wording actually absent from the repo? On this read, the key content is already in the repo skill, so #3 may reduce to nothing.
- If a real delta exists, add it to the repo skill and set recurrence-prevention (symlink installed↔repo, or installer sync) so a reinstall can't drop it.
- Confirm (c) below is present in the repo skill.

**(c) Locked vault is out of approve's scope.** If signing keeps failing while grants show ✓ **and** the vault is confirmed unlocked, it's likely outside RemotePair — ask the human, don't retry-loop. A green `status` alone is not proof (it can be stale) — check the vault-lock state before concluding. (Verify this line is in the repo skill.)

---

## Correction log

| Date | What | Grounds | Author |
|---|---|---|---|
| 2026-08-21 | approve router location corrected: `remote-pair-approve-router.sh` 145·155 → `xpair-approve-router.sh` 143·153, `dialog_gone` @115 | VP opened the live tree with `sed` and verified directly, superseding a relayed line-number report | VP (relayed here) |
| 2026-08-21 | approve router target **REVERSED to the live line**: `xpair-approve-router.sh` 143·153 (0.5.x, dead) → **`remote-pair-approve-router.sh` 145·155** (`dialog_gone` @117). Fixed in PR #121. | The VP row above pointed at the abandoned 0.5.x tree; the CEO confirming 0.4.13 is the live base moved the target back to the legacy router — this is the final, authoritative target. | PM |
| 2026-08-21 | approve item #3 reframed: "13 lines missing from original, sync" → "installed copy is older generation, port two content pieces into new-gen wording" | live-tree skill is next-generation, not missing content | skill-orchestrate → VP |
| 2026-08-21 | approve #3 urgency lowered; order set 1→2→3 | this machine runs healthy `remote-pair`; xpair host stale 16d, so installed copy currently correct | VP |

---

## Open decisions (surfaced, not settled)

- Crash reports opt-in vs opt-out — CEO asked, undecided (Q0448, Q0449). Do not silently enable analytics.
- Xpair-era rename matrix — bundle IDs, cask tokens, display names, data folder (`​.xpair` vs `.xpair-ide`) — unsettled (Q0509, Q0514, Q0525, Q0528).
- Current prerelease number/channel — must be re-checked against the live release before publishing (Q0446, Q0497, Q0527).
- `0.4.12` screen-sharing removal vs later Remote-Desktop-as-default — must be documented per release line, not collapsed (Q0370, Q0438, Q0474).
