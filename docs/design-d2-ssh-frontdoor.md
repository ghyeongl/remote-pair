# D2 — System sshd as the standard front door (design)

**Status: design only. No implementation until the planner confirms the open decisions below.**

D2 (see [`roadmap-0.6.0.md`](roadmap-0.6.0.md)) makes the OS's own sshd the single SSH front door, bound
to the tailnet only, with a ForceCommand that auto-attaches tmux-aqua for interactive sessions and passes
everything else (exec, scp, sftp, tunnels) through untouched. The payoff: Orca, VS Code Remote, iTerm,
and phone clients become Xpair clients with zero per-tool integration.

## What already exists (reuse, don't rebuild)

D2 is **not greenfield** — most of the front door is already in place:

- **System sshd is already the server.** Onboarding requires macOS **Remote Login** to be ON;
  `Permissions.loginGranted()` gates on `serviceEnabled("com.openssh.sshd")`
  (`host/app/Permissions.swift:16`). There is no custom SSH server to remove.
- **A per-key forced command already exists.** Pairing writes a restricted `authorized_keys` line
  (`PairingManager.swift` `buildRestrictedLine`, ~line 262/282):
  ```
  restrict,pty,[port-forwarding,permitopen="127.0.0.1:8890",]command="<xpair-ssh-gate> <clientID> <fingerprint>",no-agent-forwarding,no-X11-forwarding,no-user-rc <pubkey> xpair:v1 client_id=<id>
  ```
  `restrict` denies all forwarding by default; the paired state adds `port-forwarding` + `permitopen`
  limited to the RD signaling port (127.0.0.1:8890) only.
- **The gate already branches on `SSH_ORIGINAL_COMMAND`.** `xpair-ssh-gate` (the embedded shell+Perl
  script in `PairingManager.swift`, ~line 694-697) already does, after ledger authorization:
  ```sh
  if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
    exec /bin/bash -lc "$SSH_ORIGINAL_COMMAND"   # non-interactive: exec/scp path
  fi
  exec "${SHELL:-/bin/zsh}" -l                    # interactive: plain login shell
  ```
  This is exactly the D2 conditional-branch skeleton — it already runs on every SSH entry.
- **tmux-aqua is the session substrate.** A bundled Helper `tmux-aqua` is symlinked by the installer
  (`Installer.swift:128`); sessions (including a `_keeper`) are tracked via `Sessions.liveSessionCount`
  and a known socket path (`Updater.swift`). The interactive branch should attach to this server.

So D2 is a **targeted change to an existing gate + a bind**, not a new subsystem.

## What D2 adds (the gaps)

1. **Interactive arm → tmux-aqua attach** instead of `exec $SHELL -l`.
2. **Harden the non-interactive arm** so scp, sftp (subsystem), rsync, and VS Code Remote bootstrap all
   pass through correctly — the current single `SSH_ORIGINAL_COMMAND` test is insufficient for the sftp
   **subsystem** case (see the decision table).
3. **Tailnet-only bind.** Today sshd listens on all interfaces (Remote Login default, `0.0.0.0:22`).
   D2 must make it reachable on the tailscale interface only. **This is the one genuinely new mechanism**
   and the main security decision.

## Design — the ForceCommand routing table

The gate runs once per SSH session channel, after ledger authorization succeeds. It must classify the
request and route it. The four cases and the signals that distinguish them:

| Case | Signal | Route |
|------|--------|-------|
| Interactive shell | TTY allocated (`[ -t 0 ]` / `SSH_TTY` set), `SSH_ORIGINAL_COMMAND` empty | `exec tmux-aqua attach` (attach-or-create the user's session) |
| Remote exec (incl. VS Code Remote bootstrap, git, Orca agent) | `SSH_ORIGINAL_COMMAND` set, not a subsystem | `exec /bin/bash -lc "$SSH_ORIGINAL_COMMAND"` (unchanged) |
| scp / rsync | `SSH_ORIGINAL_COMMAND` starts with `scp `/`rsync ` (a command) | same exec path (unchanged) |
| sftp subsystem | subsystem request — sshd runs the forced command with `SSH_ORIGINAL_COMMAND=internal-sftp` (or `sftp-server`) | `exec` the sftp server, **not** `bash -lc` |
| Pure port-forward (`ssh -N -L …`) | no session-exec channel opened → **the forced command never runs**; only the direct-tcpip channel opens, gated by `permitopen` | governed by the `authorized_keys` forwarding tokens, not the gate |

Key correctness points:
- **Interactive detection uses the TTY, not the absence of `SSH_ORIGINAL_COMMAND` alone.** A pty is
  requested iff the client asked for an interactive/`-t` session. This cleanly separates "attach tmux"
  from "run a command."
- **sftp must be special-cased.** With a forced command in `authorized_keys`, an sftp subsystem request
  still runs the gate, but `$SSH_ORIGINAL_COMMAND` is the subsystem token, not a shell command — piping
  it to `bash -lc` breaks sftp. The gate detects the subsystem token and `exec`s the platform
  sftp-server (`/usr/libexec/sftp-server`). Without this, "open remote file" over sftp/scp breaks.
- **VS Code Remote / open-remote-ssh stays unbroken.** Its bootstrap runs as a remote **exec** (a shell
  command over the exec channel), so it takes the unchanged exec arm — never wrapped in tmux. This is
  what keeps D5 (open-remote-ssh migration) working on top of D2.
- **tmux-aqua attach mechanics** must not fight the existing session lifecycle (`_keeper`,
  `liveSessionCount`, the Updater's restart logic). The attach command reuses the bundled `tmux-aqua`
  wrapper and its socket path — it does not spawn a competing tmux server.

## Design — tailnet-only bind

Two candidate mechanisms; the tradeoff is the core open decision.

**Option A — `ListenAddress` on the tailscale IP (lean).**
Add `ListenAddress 100.x.y.z` (the host's tailscale CGNAT address) to sshd's config, dropping the
`0.0.0.0` listener. Pros: uses stock sshd, no new process, minimal code. Cons: the tailscale address is
assigned asynchronously at boot and can change (logout/relogin, node re-key); sshd must be (re)configured
when the address appears/changes, and sshd started only after the tailscale interface is up. Needs a
small reconcile step (watch the tailscale IP, rewrite the drop-in `ListenAddress`, reload sshd) and must
fail closed (never fall back to `0.0.0.0`).

**Option B — tsnet userspace listener (heavier).**
Embed a tsnet (Go) listener that terminates SSH on the tailnet in userspace, independent of the OS
network stack. Pros: bound to the tailnet by construction, immune to interface timing/IP churn. Cons:
a new embedded Go component + its own sshd, a large surface, and duplicates what the system daemon
already provides. Runs against the roadmap's "no custom SSH server" and ponytail.

**Recommendation: Option A** — reuse system sshd, add a tailscale-IP `ListenAddress` drop-in plus a
reconcile-on-change step that fails closed. It is the smaller, standards-aligned change and keeps the
"system sshd, no custom server" invariant. Option B only if we later need SSH before/without the OS
tailscale daemon.

Independent of A/B, defense in depth: the macOS application firewall / packet filter should also deny
`:22` on non-tailscale interfaces, so a misconfigured `ListenAddress` cannot silently expose the host.

## How D2 shrinks the pairing surface

With terminal transport handled by standard sshd + the existing gate, pairing no longer owns a transport.
It shrinks to: (1) identity / key-exchange (install the client's restricted `authorized_keys` line — the
current bind-display→installed-key flow), (2) tailnet join, and (3) the GUI-broker channel (D3). The
pairing internals stay **frozen/minimal** — the shipped CRLF correctness fix (#97) is the last pairing
change until D3. No pairing refactor rides D2.

## Non-goals / stays frozen

- No custom SSH server, no replacing sshd.
- No change to the pairing protocol beyond what identity/key-exchange already does.
- No new IDE/workbench features (D1 freeze).
- The RD signaling forwarding stays locked to `permitopen=127.0.0.1:8890` unless a decision below loosens
  it.

## Open decisions for the planner (confirm before implementation)

1. **Bind mechanism: Option A (ListenAddress on tailscale IP + fail-closed reconcile) vs Option B
   (tsnet).** Recommendation A. Confirm.
2. **Forwarding policy.** Keep `permitopen` locked to the RD port (127.0.0.1:8890), or loosen it for
   general client use? VS Code Remote does **not** need `-L` (it multiplexes over exec), so locked is
   likely fine — but Orca or phone workflows that rely on `-L`/`-R` tunnels would need an explicit,
   auditable allowance. Decision: keep locked (recommended) vs define an allowlist.
3. **sftp/scp exposure.** Enabling the sftp arm makes the whole host filesystem reachable over sftp for
   any paired client. Acceptable given D4 (host is SSoT), or restrict to specific paths? Recommendation:
   allow (it is the same trust level as an interactive shell), but confirm.
4. **tmux-aqua attach semantics.** One shared session per client, or attach-or-create per connection?
   And behavior when the host has an active GUI operator — attach read/write, or view-only? This touches
   the intervention-window model; needs a product call.
5. **Rollout / migration.** Ship behind a flag and keep the current `exec $SHELL -l` interactive arm as
   fallback during rollout, or switch directly? Recommendation: flag it, since it changes what every
   interactive SSH lands in.

I'll implement incrementally in follow-up PRs once these are confirmed: (1) gate routing table
(interactive→tmux, sftp arm), (2) tailnet bind + fail-closed reconcile, each its own PR through the Codex
gate.
