# Xpair 0.6.0 roadmap (engineering SSoT)

This is the repository source of truth for the 0.6.0 engineering direction. It captures the
**engineering** decisions (D1–D6) from the 0.6.0 strategy. Go-to-market items (D7 and the "Leaf 8–11"
growth work) are noted only as out-of-scope pointers — they are not designed here.

## Identity — what Xpair is

Xpair is **infrastructure that owns and keeps alive an agent-dedicated Mac**. It is the machine layer:
the always-on daemon that holds the host, its session, and its GUI login context. The tools a user runs
on top — Orca, cmux, VS Code, iTerm, Claude Code — are **bring-your-own (BYO)**; Xpair does not build or
replace them.

**Litmus for every feature:** does it strengthen the **daemon (machine layer)**, or the **workbench
(tool layer)**? Build only the daemon. Anything that makes a better *editor/terminal/IDE* is out of
scope; anything that makes the *host more reliably owned, reachable, and revivable* is in.

## D1 — Protocol is core; the workbench is a reference client (FROZEN)

- **Core = the protocol**: pairing, session, revival, intervention. This is what Xpair owns and evolves.
- The VSCodium **workbench is the "reference client"** — one client of the protocol, not the product.
- **Workbench scope is FROZEN**: onboarding, the intervention window, and a basic terminal. **No new IDE
  features** — no worktree UI, no diff viewer, no code review surface. New IDE work is out of scope until
  further notice; effort goes to the daemon and protocol.

## D2 — System sshd as the standard front door (CRITICAL, make-or-break)

Replace any custom SSH transport with the OS's own sshd (macOS Remote Login). This is the highest-risk,
highest-leverage decision of 0.6.0.

- **No custom SSH server.** Use system sshd.
- **Tailnet-only bind.** System sshd binds to the host's **tailscale interface address only**
  (`ListenAddress` on the 100.x tailnet IP), never `0.0.0.0` — zero public exposure. (tsnet is a Go
  library that would be its *own* userspace SSH server, not a way to bind system sshd, so it is not the
  bind mechanism here; see the design doc for that tradeoff.)
- **ForceCommand → tmux-aqua auto-attach, with a conditional branch** on SSH entry:
  - **Interactive shell** (a pty is allocated) → auto-attach the tmux-aqua session.
  - **Remote exec / scp / rsync / sftp / VS Code Remote bootstrap** (`SSH_ORIGINAL_COMMAND` or a
    subsystem request) → **pass through untouched**, never wrapped in tmux.
  - **Pure port-forwarding** (`ssh -N -L …` / `-R …`) runs **no** remote command, so the forced command
    never executes; forwarding is governed by the `authorized_keys` forwarding policy, not the branch.
- **Payoff:** any standards-compliant SSH client — Orca, VS Code Remote, iTerm, phone clients
  (Blink/Termius) — becomes an Xpair client with **zero per-tool integration**.

D2's companion design doc — [`design-d2-ssh-frontdoor.md`](design-d2-ssh-frontdoor.md) (the ForceCommand
routing table + tailnet bind) — is delivered alongside this roadmap and confirmed with the planner before
any implementation.

**D2 subsumes most of pairing.** With terminal transport handled by standard sshd, the pairing surface
shrinks to identity / key-exchange + tailnet-join + the GUI-broker channel (D3). Pairing internals are
therefore **frozen/minimal** — no deep refactor beyond the shipped correctness fix
([#97](https://github.com/x10lab/xpair/pull/97): metadata HTTP response CRLF fix + strict-parse test).

## D3 — GUI broker (the structural differentiator)

A daemon **resident in the GUI login session** — this is what raw sshd cannot do and is Xpair's real moat.
It brokers GUI-context capabilities:

- **TCC consent handled in the GUI session** — because the broker lives in the logged-in GUI session
  (with Accessibility), it can **answer/approve TCC consent prompts** against an explicit whitelist and
  record an **audit log** of every approval. Note: this is *responding to prompts in the live session*,
  not a silent API grant — macOS does **not** allow programmatic TCC grants on the standard SIP-enabled,
  non-MDM host, so the initial Accessibility + Screen Recording grant remains the documented one-time
  manual step (see README). The broker's value is handling the *ongoing* prompts a headless shell can't.
- Computer use (host-side automation in the logged-in GUI).
- Claude in Chrome (browser control in the GUI session).

Raw sshd gives a headless shell; the GUI broker gives a live, permissioned desktop session. That
difference is the product.

## D4 — Folder mapping is not ours; host is the single source of truth

- The daemon holds **one host cwd string per session** — nothing more.
- The **client owns folder browsing**; Xpair does not implement a file manager.
- **No bidirectional sync.** Syncthing (and any two-way mirror) is banned. The **host filesystem is the
  single source of truth**; clients read/write it over a remote protocol, never a synced copy.

## D5 — Workbench stays local execution; remote access via open-remote-ssh (not a mount)

- The workbench **executes locally**. The Finder **"Open with Xpair" dropdown is the onboarding heart**
  for non-developers — that entry path stays local.
- "Folder access" means **open the REMOTE file over a remote protocol, not mount it locally.**
- **Current mechanism = SMB mount** (`smbfs` → `/Volumes` via `xpair mount`). **Switch to
  open-remote-ssh** (the OSS extension, distributed via Open VSX).
- There is already a **partial open-remote-ssh footprint** to verify and reuse rather than rebuild:
  `client/ide/remotepair/product.overlay.json`, `client/ide/remotepair/ext/extension.js`,
  `client/ide/remotepair/ext/ssh-connect-flow-requirement.test.js`, the onboarding walkthroughs, and a
  Windows patch. The migration verifies this footprint and extends it; it does not start from scratch.

## D6 — Orca/cmux compatibility via standards, not code

- Compatibility with Orca, cmux, and other upper tools is achieved by **standards compliance +
  documentation**, not per-tool integration code.
- Verified by a **compatibility matrix** (client × capability), not by tool-specific branches in the
  codebase. If a tool speaks standard SSH + tailnet, it works; the matrix records it.

## Out of engineering scope (pointers only)

- **D7** and the **Leaf 8–11** items are go-to-market / growth work. They are tracked elsewhere and are
  **not designed in this repo**. Listed here only so the boundary is explicit: engineering builds D1–D6
  (the daemon and protocol); GTM is out of scope for these docs.

## Leaf sequencing (engineering)

1. **Pairing** — minimal correctness only. Done ([#97](https://github.com/x10lab/xpair/pull/97)); frozen,
   subsumed by D2.
2. **D2 SSH front door** — design first (`design-d2-ssh-frontdoor.md`), confirmed with the planner, then
   implemented incrementally. The make-or-break item.
3. **D3 GUI broker** — the differentiator; follows D2.
4. **D5 open-remote-ssh migration** — replace the SMB mount path, reusing the existing footprint.

D4 and D6 are constraints/policies that shape the above rather than standalone build items.
