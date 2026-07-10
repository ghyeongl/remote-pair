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
- **Host → a CLI/daemon seam.** Expose the accept decision as a seam: **fingerprint in → install-or-reject**.
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

## Open decisions

1. **Client status transport.** Reuse the existing bridge→CLI spawn (stdout JSON stream, which the bridge
   already does for other `xpair` commands), or a daemon socket? **Rec: reuse the CLI-spawn IPC** — smallest
   change, no new protocol.
2. **Host accept seam shape.** A CLI subcommand (`xpair pair-accept <fingerprint>`) the host app shells out
   to, vs a daemon RPC. **Rec: CLI subcommand** (matches §0.1, no new daemon protocol) — unless the D3
   resident daemon lands first, in which case the seam could live there. Sequence after D3, or ship the CLI
   subcommand now and migrate later?
3. **Pairing key ownership.** Key gen/storage currently lives in JS (`ensurePairingKey`). Move it to cli-rs.
   **Confirm the key path/format is unchanged** (`id_ed25519` under `RP_HOST_DIR`) so already-paired hosts
   are not invalidated.
4. **Coordination with D2/PR2.** PR2 changes the paired `authorized_keys` line (forwarding tokens). The
   Rust installer must write those same tokens. Confirm CLI-pairing lands **after** PR2 so the installer
   targets the final line shape.

Implementation follows the migration order, each step its own PR through the Codex gate, after D2's PRs.
