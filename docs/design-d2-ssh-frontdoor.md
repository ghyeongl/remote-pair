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

The gate runs once per SSH session channel, after ledger authorization succeeds. It classifies the
request **in this precedence order** — command/subsystem **first**, tmux only as the fall-through:

| # | Case | Signal (checked in order) | Route |
|---|------|---------------------------|-------|
| 1 | sftp subsystem | subsystem request — `SSH_ORIGINAL_COMMAND` is the subsystem token (`internal-sftp`/`sftp-server`) | `exec` the platform sftp-server, **not** a shell |
| 2 | Remote exec / scp / rsync (incl. VS Code Remote bootstrap, git, Orca, **and `ssh -tt host cmd`**) | `SSH_ORIGINAL_COMMAND` is **non-empty** | `exec "$SHELL" -c "$SSH_ORIGINAL_COMMAND"` — the account's login shell, matching stock sshd |
| 3 | Interactive shell | `SSH_ORIGINAL_COMMAND` **empty** (fall-through) | `exec tmux-aqua attach` (attach-or-create the user's session) |
| — | Pure port-forward (`ssh -N -L …`) | no session-exec channel opened → **the forced command never runs**; only the direct-tcpip channel opens | governed by the `authorized_keys` forwarding policy, not the gate |

Key correctness points:
- **Route on `SSH_ORIGINAL_COMMAND` / subsystem FIRST, not on the pty.** A pty is not a reliable
  "interactive" signal: `ssh -tt host cmd` allocates a pty **and** sends a command, so pty-based
  detection would wrongly attach a remote exec to tmux. tmux-attach is the fall-through only when there
  is no command and no subsystem.
- **sftp must be special-cased.** With a forced command in `authorized_keys`, an sftp subsystem request
  still runs the gate, but `$SSH_ORIGINAL_COMMAND` is the subsystem token, not a shell command — piping
  it to `bash -lc` breaks sftp. The gate detects the subsystem token and `exec`s the platform
  sftp-server (`/usr/libexec/sftp-server`). Without this, "open remote file" over sftp/scp breaks.
- **Passthrough must use the account's login shell, not a hardcoded bash.** Stock sshd runs a remote
  command under the user's login shell (`$SHELL -c`). The current gate forces `/bin/bash -lc`, which on a
  zsh/fish account gives a different PATH/environment than stock sshd — breaking env-sensitive bootstraps.
  The exec arm must delegate to `"$SHELL" -c "$SSH_ORIGINAL_COMMAND"` (falling back to a login shell only
  if `$SHELL` is unset).
- **VS Code Remote / open-remote-ssh needs BOTH exec and forwarding.** Its bootstrap runs as a remote
  **exec** (takes the exec arm, never tmux), but the extension also requires `AllowTcpForwarding yes` and
  forwards to its remote server port — so the forwarding policy below **cannot** stay locked to the RD
  port if D5 (open-remote-ssh) is to work. This is the load-bearing constraint on the forwarding design.
- **tmux-aqua attach mechanics** must not fight the existing session lifecycle (`_keeper`,
  `liveSessionCount`, the Updater's restart logic). The attach command reuses the bundled `tmux-aqua`
  wrapper and its socket path — it does not spawn a competing tmux server.

## Design — tailnet-only bind

**Critical constraint: macOS Remote Login is launchd socket-activated, so `sshd_config ListenAddress`
does not control the bind.** `com.openssh.sshd` runs from `ssh.plist`, where **launchd** owns the `ssh`
socket and starts sshd in inetd/socket mode (`sshd -i`) per accepted connection. `ListenAddress` in
`sshd_config` is therefore effectively ignored — launchd's listener still accepts on all interfaces even
after a config rewrite. A `ListenAddress`-only plan is **not fail-closed**: port 22 stays open on
non-tailnet interfaces while a reconciler believes it is tailnet-only. So the bind must be enforced at
the socket/packet layer, not in `sshd_config`.

**Primary mechanism — a `pf` rule that admits `:22` only on the tailscale interface.** A packet-filter
anchor blocks inbound TCP/22 on every interface except the tailscale `utun`, and defaults to block (fail
closed) when the tailscale interface is absent. This is enforcement-layer, immune to the launchd socket
mode, and does not require editing Apple's `ssh.plist`. It keys off the interface, not the churny 100.x
IP, so it survives address changes. A small reconcile step keeps the anchor loaded across reboots /
tailscale up-down; if the anchor can't be loaded, sshd's socket should be disabled rather than left open.

**Alternative — restrict launchd's socket.** Editing `ssh.plist`'s `Sockets` to bind the tailnet
address is possible but fragile (mutating an Apple-managed LaunchDaemon, re-applied on updates, and the
100.x IP churns), so `pf` is preferred as primary.

**Rejected — tsnet userspace listener.** tsnet is a Go library that would be its **own** SSH server, not
a way to bind system sshd; it contradicts the roadmap's "no custom SSH server" and is out of scope.

**Recommendation:** `pf` anchor as the primary, fail-closed bind (block `:22` off the tailscale `utun`),
plus the reconcile step. Keep sshd itself stock.

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

## Open decisions for the planner (confirm before implementation)

1. **Bind mechanism.** `pf` anchor admitting `:22` only on the tailscale `utun`, fail-closed (recommended
   — the launchd socket activation makes `sshd_config ListenAddress` ineffective, so this is not really
   optional), vs editing the launchd `ssh.plist` socket. Confirm `pf`.
2. **Forwarding policy — must loosen for D5.** Codex review corrected the earlier "keep locked" idea:
   `open-remote-ssh` requires `AllowTcpForwarding yes` and forwards to its remote server port, so
   `permitopen=127.0.0.1:8890` alone breaks the VS Code path. Recommended policy: **allow local (`-L`)
   forwarding to loopback** (widen `permitopen` to `127.0.0.1` / the VS Code server port range so
   open-remote-ssh works), and **disable remote (`-R`) forwarding** — note `permitopen` only limits `-L`;
   `-R` needs `permitlisten` or must be denied, and the current paired line leaves `-R` un-narrowed. So:
   widen `-L` to loopback + explicitly deny/narrow `-R` via `permitlisten`. Confirm the exact `-L` scope.
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
