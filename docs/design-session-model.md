# Xpair session model — the GUI-capable persistent session (D2/D3 core)

> Status: design, confirmed 2026-07-11. Feeds D2 (SSH front door) gate redesign and
> D3 (GUI broker). Supersedes the "ForceCommand → direct tmux attach" sketch.

## Core primitive

**Xpair = a GUI-capable persistent session on a dedicated Mac.**
Concretely: **a tmux session that inherits GUI (TCC) permission** — spawned by a
permission-holding daemon inside the GUI login session.

This is the one thing nobody else has. Competitors offer either:
- a persistent session with **no GUI** (raw tmux/screen, plain SSH, cmux, Orca-over-SSH), or
- GUI with **no persistence**.

We multiply the two. Remove either half and there is no product.

## Three orthogonal axes — all owned/routed by XpairHost

| Axis | Mechanism | Notes |
|------|-----------|-------|
| **Access** | standard SSH (system sshd, tailnet-bound) | any client: iTerm, Blink, Termius, VSCode Remote, Orca, plain `ssh` — **once paired** (the client's key is in `authorized_keys`). No Xpair *client app* needed, but the one-time pairing/key-install still gates access. Reachable **only over the tailnet** (pf binds :22 to the tailnet interface); LAN / other-interface access is **intentionally excluded** for lock-out safety. |
| **Persistence** | tmux(-aqua) session, daemon-owned | survives client detach; client carries no state. Reboot-revival is the **session registry's** job (Leaf #3 re-launches the agent), **not** tmux — a tmux server dies on reboot. |
| **GUI** | inheritance (default) **or** broker (fallback) | macOS TCC forbids GUI to a bare SSH-descended process — see below. |

The daemon (**XpairHost**) is the control plane: it owns/registers the SSH connections,
owns the tmux session(s), and mediates GUI. Access ≠ session — SSH grants access; being
in the session is a separate thing the daemon routes. **SSH entry does not auto-fire
tmux**; exec/tunnel/scp/VSCode-bootstrap pass through untouched (their own role).

## Why GUI needs us (the moat, located precisely)

macOS **TCC** (Screen Recording, Accessibility) is granted **per code-signed identity**,
and a process only reaches the window server if it lives in the **GUI (Aqua) login
session**. A shell forked by system `sshd` is in a headless bootstrap namespace whose
responsible ancestor is `sshd` (no grant) → **raw computer use is denied**. This is a
macOS invariant, **not** an Xpair limitation — so *no* competitor can give a bare SSH
session GUI either. "GUI까지 조작" is the survival sentence precisely because it is
structurally impossible without a resident, granted, GUI-session daemon.

So the VP is **not** "connect with any client and GUI is free" (impossible for everyone).
It is: **"the only layer that makes remote-agent GUI possible at all — standard transport,
proprietary GUI."**

## Two ways an agent gets GUI

GUI capability follows **the session the process actually runs in**, not the client you
connected with.

### 1. Inheritance (default, preferred) — for sessions we spawn
The daemon spawns the shell/session **inside the GUI login session** (e.g.
`launchctl asuser <uid>` so the granted daemon is the responsible ancestor). Children
(claude, computer-use) **inherit** the grant → **raw computer use just works**. This is
what the current XpairHost already does, and why computer use works today.

**tmux is the bridge that makes this client-agnostic.** tmux is client/server: the tmux
*server* (and every pane process) runs where the server was started — the daemon's GUI
tree. Any *client* attaching (our SSH terminal, VSCode's integrated terminal running
`tmux attach`, a phone) runs its commands **server-side**, so they inherit GUI **even
though the attaching client has no GUI grant**. Land in tmux-aqua from any terminal
client → GUI works, no broker.

### 2. Broker (fallback) — for BYO processes outside our session
A client that spawns its own agent process **outside** any daemon-owned session cannot
inherit. Canonical case: **VSCode Remote / Orca**. They bootstrap their own server over
the SSH **exec channel** (passthrough), so their server is an `sshd` child, and the agent
(e.g. a VSCode Claude extension) runs under it — outside our GUI tree. We **must not**
re-parent their server (wrapping their bootstrap couples us to their internals = the
maintenance treadmill D2 exists to avoid). Instead the agent delegates GUI actions to
the daemon over local IPC (`rp-screencap`, `rp-input-inject`, approve-router,
Claude-in-Chrome). The daemon, holding the grants, performs the action and returns the
result. In the **target** broker model these entry points are thin shims that hold no
grant themselves; **today's RD helpers may still carry grants directly** — collapsing them
onto the grantless-shim-through-daemon model is part of the D3 broker work. Either way the
agent process itself never needs its own TCC grant. The broker IPC **authenticates its
callers** (only sanctioned agent sessions may delegate) — otherwise any local process could
borrow GUI through it.

Broker scope is therefore **narrow**: only processes that can't be in tmux-aqua. Steer
agents to run inside tmux-aqua and inheritance covers them; the broker is the escape hatch.

**Caveat (client-agnostic has a limit):** transport is client-free, but a BYO agent's
computer-use must be pointed at the broker (our tools) rather than raw screen APIs. Our
reference client wires this; BYO gets the tools + docs. Vanilla raw computer-use inside
VSCode Remote still fails — unavoidable per macOS.

## D2 gate — mostly already shipped (#100), small delta remaining

The shipped `xpair-ssh-gate` (PR #100) **already implements this session model** — it is not a
rewrite. Per SSH channel, after ledger auth, it classifies **command/subsystem first, tmux as
the fall-through** (routing on `SSH_ORIGINAL_COMMAND`/subsystem, **not** on the pty — `ssh -tt
host cmd` has a pty *and* a command, so it must take the exec arm, not tmux):

- **sftp subsystem** → `exec sftp-server` (passthrough).
- **exec / scp / rsync / VSCode-Remote bootstrap** (`SSH_ORIGINAL_COMMAND` non-empty) →
  `exec "$SHELL" -c "$CMD"` (passthrough, under the account's login shell). **No session forced**
  — this is the access ≠ session behavior for non-interactive, already correct.
- **Interactive** (no command, fall-through) → **attach the daemon-owned `tmux-aqua` session**
  (iff its `_keeper` is alive; the gate never *starts* the server). Because the daemon
  owns/keeps that tmux server in the **GUI login session**, attaching it is exactly what gives
  the interactive session **GUI inheritance** — so a direct attach here is *correct*, the thing
  you want, not something to route around. (This corrects an earlier draft of this doc that said
  "ForceCommand → daemon, **not** → tmux attach": attaching the daemon-owned tmux-aqua **is** the
  GUI-capable session.)
- **Pure port-forward** (`ssh -N`) → the forced command never runs; governed by the
  `authorized_keys` forwarding policy, not the gate.

Access ≠ session holds for non-interactive (shipped); interactive fall-through auto-attaches the
GUI-capable session **by design** — the "attach the box and you're in it" behavior.

### Remaining delta (not a rewrite)
1. **Forwarding-policy widening** — the paired key's `permitopen` is currently locked to the RD
   signaling port (`127.0.0.1:8890`). VSCode Remote / open-remote-ssh (D5) need a `-L` forward to
   their own remote-server port, so `permitopen` must widen accordingly. This is the one
   **security-sensitive** decision (it was the D2 lockdown boundary) — the exact allowlist needs
   deliberate sign-off. `-R` remote forwards stay denied (PR #102, `AllowTcpForwarding local`).
2. **Broker (D3)** — GUI for BYO processes that can't run inside tmux-aqua; a separate unit.

The D2 **access-layer hardening** (pf tailnet-bind, `-R` denial, sshd drop-in — PR #100 gate +
PR #102 hardening) is in. What's left of D2 is item 1 above, not a gate rewrite.

## Reference client is not a runtime dependency

The host runs standalone with **zero** Xpair clients — any SSH client attaches, the daemon
keeps the box alive. The VSCodium workbench exists for: (1) non-developers (Finder
right-click → "Open with Xpair", their only door), (2) the onboarding wizard + intervention
window, (3) end-to-end proof. It is a *reference client*, not the core. Core = the daemon.
