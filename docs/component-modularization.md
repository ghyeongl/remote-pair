# Component modularization standard

## Why

The client onboarding once stalled before the Accept screen because the host's pairing metadata HTTP
server emitted a malformed response — a header block ending in a bare `\r` (missing the final `LF`),
produced by a Swift multiline string literal that does not append a newline after its last line.
Lenient tools (curl, nc) tolerated it, so it passed every manual check. The real client parses with
Node's strict `llhttp`, which rejected it with "Expected LF after headers", returned `null`, and
pairing never started. Nothing caught it until a live host was probed by hand.

The root problem was not the typo. It was that **the correctness of one small part — the metadata wire
response — could only be observed by running the whole system**. There was no way to test that part in
isolation, in seconds, without a ~40-minute release build.

This document defines how we decompose each system component so every part is independently testable in
the fast (~3-minute) CI `test` job.

## The pattern

Decompose each component into three seams:

1. **Pure logic** — deterministic functions with no IO: parsing, canonical encoding, validation,
   signing/verifying, request/response assembly. No sockets, no disk, no clock (inject time). These are
   trivially unit-testable and are where most bugs live.
2. **IO / transport seam** — the thin layer that moves bytes: sockets, HTTP, UDP, files, subprocesses.
   Keep it dumb; it should only call pure functions and shuttle their output. Test it against loopback
   or a fake, never the real remote.
3. **Wire contract** — the exact bytes/fields exchanged with another component (host ↔ client), often
   across a language boundary (Swift ↔ Node). This is where drift silently breaks things. Pin it with a
   contract test that fails when either side changes the field set, order, or framing.

### Rules

- **Expose the seams.** Export pure functions so they are callable from a test without launching the
  IDE, the host app, or the network. Keep the existing public surface (e.g. the `bridge` export)
  unchanged; add a test-only namespace (`__pairingTest`) for internals.
- **Add a fast, build-free per-part test.** Each part gets a `*.test.js` under
  `client/ide/remotepair/ext/` (auto-discovered and run by `tests/t_15_ext_js_contracts.sh`) or a
  `tests/t_*.sh`. Node's standard library is the whole toolchain — no framework, no fixtures.
- **Add a contract test for every cross-component wire.** Extract the counterpart's contract from its
  source (regex over the Swift/TS file — no build) and assert the two sides agree. A contract test must
  fail on field-set, field-order, or framing drift.
- **No component's correctness may depend solely on the ~40-minute release build.** If the only way to
  know a part works is to build and run the whole app, it is not modularized yet. Use a real strict
  parser (not a lenient one) wherever a wire format is asserted, so tolerated-but-wrong output fails.
- **Keep it lean.** Expose seams and test them; do not rewrite working components or add speculative
  abstractions. The seam is a place to test, not a new layer of indirection.

## Reference implementation: pairing (done)

- **Pure logic** (`onboarding-bridge.js`, exported via `__pairingTest`):
  `canonicalPairingTranscript` (length-prefixed ssh-string transcript), `sanitizeEd25519PublicKey` /
  `parseEd25519PublicKey`, `parseOpenSSHEd25519PrivateKey` / `signPairingTranscript` (sign→verify),
  `normalizePairingMetadata` (valid/incomplete), `pairingRequestPayload` (request-JSON assembly).
- **IO / transport seam**: `PairingMetadataHTTPServer` (host, Swift) emits the metadata response;
  `fetchPairingMetadata` / `sendUdpJSON` (client) move bytes. Tested against loopback, not a live host.
- **Wire contract**: the UDP request field set and the canonical transcript framing, verified by the
  host's `PairingRequestWire` and `PairingSecurity.canonicalTranscript`.
- **Tests**:
  - `pairing-metadata-response.test.js` — materializes the host response from Swift source (no build)
    and asserts a **strict** HTTP parser accepts it, with CRLF framing and `Content-Length` == body
    byte length. This is the test that would have caught the original bug.
  - `pairing-host-contract.test.js` — per-part unit tests (transcript framing, sign→verify, metadata
    parse, request assembly) plus host↔client contract tests (request fields match
    `PairingRequestWire`; transcript field order matches `canonicalTranscript`).
  - `pairing-signing.test.js` — existing signer/accept-flow coverage.

## Rollout list (priority order)

| Priority | Component | Parts to seam (pure ▸ IO ▸ contract) | Status |
|----------|-----------|--------------------------------------|--------|
| 1 | **pairing** | transcript / signing / metadata / request ▸ HTTP+UDP ▸ request+transcript wire | **done** |
| 2 | RD / screen-serve | offer/answer + control-channel message assembly ▸ serve-webrtc / control channel ▸ signaling + input-event wire (host ↔ client) | todo |
| 3 | install-host | arg/authorized_keys line assembly + version-floor checks ▸ ssh/subprocess ▸ install request wire | todo |
| 4 | discover / LAN-beacon | beacon encode/parse + peer normalization ▸ UDP broadcast ▸ beacon field wire | todo |
| 5 | telemetry (client + host) | event-name validation + payload assembly ▸ HTTP post ▸ event schema | todo |
| 6 | updater | version compare + manifest parse ▸ download/verify ▸ manifest + signature wire | todo |

Work down the list one component per PR, following the pattern above. Mark a row done only when its
pure parts, IO seam, and wire contract each have a fast, build-free test.
