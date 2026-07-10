# CLI pairing — move pairing into the brain (§0.1) (design)

**Status: design only. No implementation until the planner confirms the open decisions below, and not
before D2's front-door PRs land.**

## Why

Per §0.1 the CLI is the brain, and that holds for `ls`/`launch`/`attach`/`discover`/`config`/`doctor` —
but **pairing drifted**: `onboarding-bridge.js` does the metadata-HTTP fetch, UDP send, and ed25519
signing itself; `xpair onboard` is a deferred stub (`exit 2`); the host accept lives in
`PairingManager.swift`. So today the **GUI owns pairing logic** — the §0.1 violation.

This is **not** subsumed by D2. D2 gives *third-party* SSH clients (Orca, VS Code Remote, iTerm, phones)
a standard-sshd entry with no pairing UI. The **reference client** (the workbench onboarding + the
non-dev "Open with Xpair" path) still needs the pretty accept-pairing flow regardless of D2. So port the
**whole** pairing into the brain, not just the post-D2 remainder.

This is a **move, not a behavior change** — the #97 CRLF fix is the only pairing behavior change; behavior
stays frozen.

## Current state

- **Client** (`onboarding-bridge.js`, seams exported in #97): `fetchPairingMetadata` (HTTP :8891),
  `normalizePairingMetadata`, `canonicalPairingTranscript`, `signPairingTranscript`,
  `pairingRequestPayload`, `sendUdpJSON`, then SSH-proof polling. `xpair onboard` = stub.
- **Host** (`PairingManager.swift`): metadata HTTP server, UDP server, `verify`, the accept window,
  `authorized_keys` install, the `xpair-ssh-gate`.

## Target architecture

- **Client → cli-rs.** Real `xpair pair` (and `xpair onboard`) does the full flow in Rust:
  metadata pull → normalize → build canonical transcript → sign with the dedicated pairing key → UDP send
  to `pairPort` → SSH proof. The #97 JS seams are a stepping stone; the real home is Rust, and the #97
  **contract tests** (request fields + transcript framing vs `PairingManager.swift`) become the
  cross-language parity check. `onboarding-bridge.js` shrinks to **IPC + rendering** — it spawns
  `xpair pair` and streams its status JSON to the webview; it no longer builds transcripts or signs.
- **Host → a CLI/daemon seam.** Expose the accept decision as a seam: **request-id + fingerprint in →
  install-or-reject** (bound to the exact frozen in-memory pending request, per `acceptIncoming`).
  `PairingManager.swift` stays the implementation (verify + hardened `authorized_keys` install); add a
  thin entry point the GUI accept window calls instead of embedding the decision. The GUI becomes a thin
  renderer over that seam.

## How it composes with D2

| | any-client (D2) | reference-client (this) |
|---|---|---|
| Entry | standard sshd on the tailnet, no pairing UI | pretty accept-pairing flow |
| Auth install | the same restricted `authorized_keys` line | the same line, installed via the host seam |
| Brain | gate (`xpair-ssh-gate`) | `xpair pair` (client) + accept seam (host) |

Both land the **reference-client vs any-client split** cleanly — one `authorized_keys` install path; the
difference is only the *entry UX*. Pairing just moves JS→Rust; the wire contract is unchanged.

## Migration order

1. **cli-rs `xpair pair`** implements the client flow to parity with the JS seams (the #97 contract tests
   guard the wire format). JS bridge stays callable during transition.
2. **`onboarding-bridge.js` switches to spawning `xpair pair`** (the same CLI-spawn IPC it already uses
   for other commands) and drops its own metadata/UDP/sign logic.
3. **Host accept seam** (CLI subcommand or daemon RPC); the GUI accept window calls it.
4. **Delete** the JS pairing logic once the Rust path is proven.

## Confirmed decisions

1. **Client status transport = reuse the bridge→CLI spawn** (stdout JSON stream — the established pattern
   for the other `xpair` commands). No new daemon socket.
2. **Host accept seam = a CLI subcommand `xpair pair-accept` now** (the §0.1 brain seam; the GUI accept
   window shells out to it). Not sequenced after D3 — when the D3 resident daemon lands it can absorb/call
   the same subcommand. **The seam must carry the frozen pending request's identity, not a bare
   fingerprint**: the host verifies the incoming request in memory and `acceptIncoming(requestID:fingerprint:)`
   binds the decision to the exact displayed request/key (bind display→installed, per the pairing security
   model). So the subcommand takes the **request-id + fingerprint** the accept window is showing.
3. **Pairing key = keep the exact current path/format**: `RP_HOST_DIR/pairing_ed25519` (`PAIRING_KEY` in
   `onboarding-bridge.js` — `~/.xpair/host/pairing_ed25519`, ed25519, unencrypted, `0600`). cli-rs must
   produce the byte-identical key at that path and **reuse an existing key, never regenerate**
   (generate-if-absent is idempotent) so already-paired hosts (key already in `authorized_keys`) stay
   valid. Hard invariant — cover it with a test.
4. **Sequencing = implement after D2/PR2**, and **preserve the two-phase `authorized_keys` shape**: the
   Rust installer writes the *pending* line (`restrict,pty,command=…`, **no** `port-forwarding`/`permitopen`);
   `xpair-ssh-gate` promotes it to the forwarding line only after SSH proof. PR2's forwarding tokens
   (`permitopen` all-loopback) are what the **gate adds on promotion**, not what the installer writes; `-R`
   denial is global `sshd_config`, not the key line. So the installer targets the final *pending* shape.

Implementation follows the migration order, each step its own PR through the Codex gate, after D2's PRs.
The full implementation plan (files + order) is routed to the planner before coding.
