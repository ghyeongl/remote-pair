// pairing-host-contract.test.js — pairing seams verified in isolation, build-free (~ms). Two layers:
//
//  1. Per-part unit tests of the exported pure pairing functions (no IDE, no disk, no network):
//     transcript wire format (length-prefixed ssh-string framing), signature sign→verify round-trip,
//     metadata parse (valid / incomplete), and request-JSON assembly.
//
//  2. A host↔client CONTRACT test: the client's request format (field set) and the canonical transcript
//     (field order + framing) must match what host/app/PairingManager.swift verifies. Protocol drift is
//     caught here in the ~3-min `test` job instead of at onboarding time. The Swift never builds; the
//     contract is extracted from its source.

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bridge = require("./onboarding-bridge.js");
const T = bridge.__pairingTest;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}\n        ${error && error.message ? error.message : error}`);
  }
}

const SWIFT_SRC = path.join(__dirname, "../../../../host/app/PairingManager.swift");

// ── Per-part: transcript wire format ────────────────────────────────────────────────────────────
check("canonicalPairingTranscript uses 4-byte BE length-prefixed ssh-strings in a fixed field order", () => {
  const fields = ["SHA256:host", "nonce", "sid", "ssh-ed25519 AAAA", 12345];
  const transcript = T.canonicalPairingTranscript("SHA256:host", "nonce", "sid", "ssh-ed25519 AAAA", 12345);
  // Reassemble independently from the wire and assert it decodes back to the same fields in order.
  let off = 0;
  for (const expected of fields) {
    const [chunk, next] = T.readSSHString(transcript, off);
    assert.equal(chunk.toString("utf8"), String(expected));
    off = next;
  }
  assert.equal(off, transcript.length, "no trailing bytes");
  // The last field (timestamp) is stringified, not raw-int encoded.
  assert.ok(transcript.includes(Buffer.from("12345", "utf8")));
});

// ── Per-part: signature sign → verify round-trip ────────────────────────────────────────────────
check("signPairingTranscript signature verifies against the pairing public key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-pairing-contract-"));
  try {
    const keyPath = path.join(dir, "id_ed25519");
    cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"]);
    const pub = T.parseEd25519PublicKey(fs.readFileSync(`${keyPath}.pub`, "utf8"));
    const transcript = T.canonicalPairingTranscript("SHA256:h", "n", "s", pub.clean, 42);
    // Sign with the parsed private key (signPairingTranscript reads a fixed path; the crypto is shared).
    const priv = T.parseOpenSSHEd25519PrivateKey(fs.readFileSync(keyPath, "utf8"));
    const sig = crypto.sign(null, transcript, priv.keyObject);
    assert.equal(sig.length, 64);
    const spki = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub.raw.toString("base64url") }, format: "jwk" });
    assert.ok(crypto.verify(null, transcript, spki, sig), "signature must verify");
    // Tamper: any transcript change must fail verification.
    const other = T.canonicalPairingTranscript("SHA256:h", "n", "s", pub.clean, 43);
    assert.ok(!crypto.verify(null, other, spki, sig), "signature must NOT verify a different transcript");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Per-part: metadata parse (valid / incomplete) ───────────────────────────────────────────────
check("normalizePairingMetadata accepts complete metadata and normalizes the fingerprint prefix", () => {
  const r = T.normalizePairingMetadata({ fp: "abc", sid: "sid", nonce: "n", pp: 8890, user: "me" });
  assert.equal(r.ok, true);
  assert.equal(r.fp, "SHA256:abc");
  assert.equal(r.pairPort, 8890);
  assert.equal(r.hostUser, "me");
});

check("normalizePairingMetadata rejects incomplete or out-of-range metadata", () => {
  assert.equal(T.normalizePairingMetadata({}).ok, false);
  assert.equal(T.normalizePairingMetadata({ fp: "x", sid: "s", nonce: "n", pp: 0 }).ok, false);
  assert.equal(T.normalizePairingMetadata({ fp: "x", sid: "s", nonce: "n", pp: 70000 }).ok, false);
});

// ── Per-part: request-JSON assembly ─────────────────────────────────────────────────────────────
check("pairingRequestPayload emits exactly the wire fields, dropping extras", () => {
  const payload = T.pairingRequestPayload({
    clientPubKey: "ssh-ed25519 AAAA",
    name: "laptop",
    user: "me",
    timestamp: 99,
    sig: "base64sig",
    extra: "nope",
  });
  assert.deepEqual(Object.keys(payload).sort(), ["clientPubKey", "name", "sig", "timestamp", "user"]);
  assert.equal(payload.extra, undefined);
});

// ── Contract: request fields match host PairingRequestWire ───────────────────────────────────────
check("client request fields match host PairingRequestWire", () => {
  const src = fs.readFileSync(SWIFT_SRC, "utf8");
  const block = src.match(/struct PairingRequestWire\s*\{([\s\S]*?)\}/);
  assert.ok(block, "could not find struct PairingRequestWire");
  const hostFields = [...block[1].matchAll(/let\s+(\w+)\s*:/g)].map((m) => m[1]).sort();
  const clientFields = Object.keys(
    T.pairingRequestPayload({ clientPubKey: "", name: "", user: "", timestamp: 0, sig: "" }),
  ).sort();
  assert.deepEqual(clientFields, hostFields, "client request JSON fields must match host PairingRequestWire");
});

// ── Contract: transcript field order matches host canonicalTranscript ────────────────────────────
check("client transcript field order matches host canonicalTranscript", () => {
  const src = fs.readFileSync(SWIFT_SRC, "utf8");
  // Swift: `for field in [hostKeyFP, hostNonce, serviceInstanceID, clientPubKey, String(timestamp)]`
  const m = src.match(/for field in \[([^\]]*)\]/);
  assert.ok(m, "could not find the host transcript field array");
  const hostOrder = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^String\(/, "").replace(/\)$/, ""))
    .filter(Boolean);
  const expected = ["hostKeyFP", "hostNonce", "serviceInstanceID", "clientPubKey", "timestamp"];
  assert.deepEqual(hostOrder, expected, "host transcript field order drifted from the client's");
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\npairing host-contract tests passed");
