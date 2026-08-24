# register.md — utterance → requirement trace

Answers "where did this requirement come from?" Every requirement in `spec.md` traces here to the utterance(s) that produced it. A `spec.md` line with no trace here is one the PM invented — none should exist.

**The verbatim utterances are not copied.** They live in `requirements-raw.md` (Q0001–Q0552) and `recovered-queries-git-windows.md`, both already in the repo. Copying them would add only a way to go stale. This file is the **index** over them: requirement id ← the Q-IDs behind it. `requirements.md` embeds the same mapping in prose; this file is the id-level inverse.

**Trace mechanism.** `requirements-raw.md` is 542 human Q/request turns extracted from 18 top-level Claude Code sessions in the pre-migration repo `Lang-Swift/remote-pair` (2026-06-02 →). Each carries `Source: <jsonl>:<line>` and a timestamp, so any Q-ID resolves to the exact line of the exact transcript. `spec.md`'s "source" column lists the Q-IDs per requirement; to read the actual words, open that Q block in `requirements-raw.md`.

---

## 1. Corpus requirements — REQ ← Q-IDs

The backing Q-IDs are recorded inline in `spec.md`'s source column (single source of truth — not duplicated here to avoid drift). This section records only the **grade of trace**, not a second copy of the ids:

- **Most REQ rows tagged `[사실]` in `spec.md` §0–2** have ≥1 Q-ID in their source column → each is a genuine utterance trace into `requirements-raw.md`. That citation *is* the register row.
- **`[봉인]` rows** (REQ-NAME-3, REQ-ROLE-4, REQ-OBS-4, REQ-RD-2, REQ-NET-4) trace to Qs that raised the question without settling it — the Q-IDs mark where the CEO surfaced the open issue.
- **Two `[파생]` exceptions: REQ-APPROVE-4 and REQ-APPROVE-5.** These are NOT Q-corpus-backed — they derive from the CEO's symptom statement + VP direct-read verification + the skill-orchestrate peer report (2026-08-21), and each carries a falsifier. They are the only non-Q-backed rows in §0–2.

To regenerate this trace mechanically: for each Q-backed REQ in `spec.md`, its source-column Q-IDs → grep `## <Qid>` in `requirements-raw.md`.

**Provenance-file co-location.** This register and `spec.md` reference `requirements.md`, `requirements-raw.md`, and `recovered-queries-git-windows.md` as their sources. Those files are co-located on the live 0.4.13 line (`docs/`) so the trace resolves in a fresh checkout — they were carried over from the abandoned develop line alongside this record.

## 2. 0.6.0 layer (REQ-06-*) — provenance

These do **not** trace to the Q-corpus. Their "utterance" is the engineering-strategy documents, which are the CEO's written direction in a later form (a PRD-equivalent, cited as intent per §5). Traces:

| REQ | traces to |
|---|---|
| REQ-06-IDENTITY, D1, D2, D2b, D3, D4, D5, D5b, D6 | `roadmap-0.6.0.md` (engineering SSoT), line ranges in `spec.md` source column |
| REQ-06-PAIR, REQ-06-ONBOARD | `onboarding-redesign-blueprint.md`, `onboarding-flow.md`, `architecture.md`, `design-cli-pairing.md`, `design-session-model.md` |
| REQ-06-WIN | `win32-client-roadmap.md` |
| REQ-06-STATE | `client-runtime-dir-split.md` |

These are `[사실]` as *written engineering direction*, not as Q-utterances. If a future PRD from the CEO contradicts them, the PRD wins (newer intent).

## 3. Recovered git/windows session (2026-06-22) — durable utterances only

`recovered-queries-git-windows.md` holds 66 user queries from session `fcd7ea57…` (`Lang-Swift/remote-pair`). Most are ephemeral git-rescue / logistics chatter from a one-off migration episode (RQ#19–34: monorepo→develop rescue; RQ#53–66: worktree reorg). The durable requirements it carries:

| RQ# | utterance (paraphrased) | produced / relates to |
|---|---|---|
| 45 | "`remote-pair/` 내용을 `xpair/`로, `xpair/{branch}` 형태로 바꾸자" | **Realized infra layout** — the current `.bare` + branch-name-worktree structure. Meta (repo layout), not a product REQ. |
| 1 | "codex 워커 코덱스 써줘 코덱스 좋아" | **Workflow decision** — Codex as implementer/worker. Meta (delivery process), realized. |
| 3, 4 | "cli는 client에도 host에도 설치해야 하는데 / client의 cli 파트는 인터페이스 역할만" | Reinforces REQ-ROLE-1/2, REQ-CLI-1 (role-aware CLI; client CLI is interface-side). |
| 35–41 | "ssh는 tmux 결합하면 렌더가 깨진다 / mosh가 해결 / windows 호스트는 나중에 뭐로 통신?" | Transport observation feeding REQ-06-D2 (front door) and REQ-06-WIN (windows client). mosh-vs-ssh weighing; not itself a settled REQ. |
| 12, 25 | "모든 세션은 같은 브랜치 공유 / develop에 커밋로그 차곡차곡" | **Dev-process discipline** — see memory `xpair-signed-commits-required`, `xpair-worktree-folder-branch-match`. Meta, not a product REQ. |

The remaining ~55 queries are ephemeral and carry no durable requirement; they are left in the recovered file as history, not indexed here.

---

## Idempotency note

This register is an **index**, not a copy — re-running the migration re-derives it from the same three sources (`requirements.md`, `requirements-raw.md`, `recovered-queries-git-windows.md`) plus the 0.6.0 docs, and lands on the same rows. Add new rows only when a new utterance produces a new REQ; never rewrite the trace of an existing one (an utterance's origin does not change).
