const assert = require("node:assert/strict");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bridge = require("./onboarding-bridge.js");

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

check("pairing signer verifies a valid length-prefixed transcript", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-pairing-key-"));
  try {
    const keyPath = path.join(dir, "id_ed25519");
    cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"]);
    const pub = bridge.__pairingTest.sanitizeEd25519PublicKey(
      fs.readFileSync(`${keyPath}.pub`, "utf8"),
    );
    const priv = bridge.__pairingTest.parseOpenSSHEd25519PrivateKey(
      fs.readFileSync(keyPath, "utf8"),
    );
    const transcript = bridge.__pairingTest.canonicalPairingTranscript(
      "SHA256:host",
      "nonce",
      "sid",
      pub,
      12345,
    );
    const sig = crypto.sign(null, transcript, priv.keyObject);
    assert.equal(sig.length, 64);
    assert.equal(crypto.verify(null, transcript, crypto.createPublicKey(priv.keyObject), sig), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("pairing framing rejects a boundary-shifted transcript", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-pairing-key-"));
  try {
    const keyPath = path.join(dir, "id_ed25519");
    cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"]);
    const pub = bridge.__pairingTest.sanitizeEd25519PublicKey(
      fs.readFileSync(`${keyPath}.pub`, "utf8"),
    );
    const priv = bridge.__pairingTest.parseOpenSSHEd25519PrivateKey(
      fs.readFileSync(keyPath, "utf8"),
    );
    const signed = bridge.__pairingTest.canonicalPairingTranscript("ab", "c", "sid", pub, 12345);
    const shifted = bridge.__pairingTest.canonicalPairingTranscript("a", "bc", "sid", pub, 12345);
    const sig = crypto.sign(null, signed, priv.keyObject);
    assert.equal(crypto.verify(null, shifted, crypto.createPublicKey(priv.keyObject), sig), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("pairing public key sanitizer rejects malformed keys and strips comments", () => {
  assert.throws(() => bridge.__pairingTest.sanitizeEd25519PublicKey("ssh-rsa AAAA"));
  const clean = bridge.__pairingTest.sanitizeEd25519PublicKey(
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE8d8QoZExhG+ZL0KxEn8WLEm8JZJMSnMn4qt4K96fj2 user@host",
  );
  assert.equal(
    clean,
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE8d8QoZExhG+ZL0KxEn8WLEm8JZJMSnMn4qt4K96fj2",
  );
});

check("pairing signer uses the dedicated pairing key (raw ed25519, no agent, no id_ed25519 collision)", () => {
  const bridgeSource = fs.readFileSync(path.join(__dirname, "onboarding-bridge.js"), "utf8");
  // Dedicated key kept OUTSIDE ~/.ssh so it never collides with the user's personal id_ed25519 —
  // the host installs only this key as the restricted forced-command line, so the gate always runs.
  assert.match(bridgeSource, /const PAIRING_KEY = path\.join\(RP_HOST_DIR, "pairing_ed25519"\)/);
  // Generated unencrypted on demand (ensurePairingKey), then signed RAW — no ssh-agent needed.
  assert.match(bridgeSource, /"ssh-keygen"[\s\S]*"-f", PAIRING_KEY/);
  assert.match(
    bridgeSource,
    /function signPairingTranscript\(transcript\) \{[\s\S]*parseOpenSSHEd25519PrivateKey\(fs\.readFileSync\(PAIRING_KEY[\s\S]*crypto\.sign\(null, transcript, privateKey\.keyObject\)/,
  );
  // The pairing request + status read the DEDICATED pub, and client→host ssh uses the paired identity.
  assert.match(bridgeSource, /fs\.readFileSync\(PAIRING_KEY \+ "\.pub"/);
  assert.match(bridgeSource, /function pairingIdentityKey\(\)/);
});

check("gateway MAC guard runs before automatic ssh reachability", () => {
  const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
  const probeIdx = extension.indexOf("const probeHost = async () =>");
  const guardIdx = extension.indexOf("onboardingBridge.gatewayMacStatus()", probeIdx);
  const sshIdx = extension.indexOf('sshRun(host, "true", { timeoutMs: 6000 })', probeIdx);
  assert.ok(guardIdx > 0, "extension must call gatewayMacStatus");
  assert.ok(sshIdx > guardIdx, "gateway MAC guard must run before auto ssh probe");
});

check("gateway MAC guard also runs before the RD ssh tunnel", () => {
  const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
  const startIdx = extension.indexOf("async _startStream()");
  const guardIdx = extension.indexOf("onboardingBridge.gatewayMacStatus()", startIdx);
  const tunnelIdx = extension.indexOf("await this._startV2(host)", startIdx);
  assert.ok(guardIdx > 0, "RD start must call gatewayMacStatus");
  assert.ok(tunnelIdx > guardIdx, "gateway MAC guard must run before RD tunnel start");
});

check("host freezes the first verified incoming request until decision or timeout", () => {
  const manager = fs.readFileSync(
    path.join(__dirname, "../../../..", "host/app/PairingManager.swift"),
    "utf8",
  );
  const dropIdx = manager.indexOf("if incoming != nil");
  const installIdx = manager.indexOf("incoming = verified");
  assert.ok(dropIdx > 0, "PairingManager must drop later datagrams while a request is frozen");
  assert.ok(installIdx > dropIdx, "freeze check must happen before assigning incoming = verified");
  // R13-1: the host-approval TTL is based on RECEIPT time (now), not the client timestamp, so a valid
  // clock-skew request doesn't expire before the user can Accept. (Replay freshness still uses the
  // timestamp, validated in PairingSecurity.verify.)
  assert.match(manager, /incomingExpiresAt = now \+ PairingSecurity\.timestampSkewSec/);
  assert.match(manager, /expireFrozenIncomingLocked/);
});

check("acceptPairing binds approval to displayed request id and fingerprint", () => {
  const manager = fs.readFileSync(
    path.join(__dirname, "../../../..", "host/app/PairingManager.swift"),
    "utf8",
  );
  const hostApp = fs.readFileSync(
    path.join(__dirname, "../../../..", "host/onboarding/src/App.tsx"),
    "utf8",
  );
  const hostTypes = fs.readFileSync(
    path.join(__dirname, "../../../..", "host/onboarding/src/global.d.ts"),
    "utf8",
  );
  assert.match(manager, /func acceptIncoming\(requestID: String, fingerprint: String\)/);
  assert.match(manager, /req\.id == requestID/);
  assert.match(manager, /!fingerprint\.isEmpty/);
  assert.match(manager, /fingerprint == req\.fingerprint/);
  assert.doesNotMatch(manager, /approvedFingerprint == nil \|\| approvedFingerprint!\.isEmpty/);
  assert.match(hostApp, /id: s\.request\.id/);
  assert.match(hostApp, /acceptPairing\(\{ id: request\.id, keyFingerprint: request\.keyFingerprint \}\)/);
  assert.match(hostTypes, /acceptPairing: \(request: \{ id: string; keyFingerprint: string \}\)/);
});

check("client wait step uses real pairing request and proof polling", () => {
  const wait = fs.readFileSync(
    path.join(
      __dirname,
      "onboarding-webview/src/components/onboarding/client/StepWaitPerm.tsx",
    ),
    "utf8",
  );
  const discover = fs.readFileSync(
    path.join(
      __dirname,
      "onboarding-webview/src/components/onboarding/client/StepDiscover.tsx",
    ),
    "utf8",
  );
  const app = fs.readFileSync(path.join(__dirname, "onboarding-webview/src/App.tsx"), "utf8");
  assert.match(app, /window\.remotepair\.fetchPairingMeta\(target\)/);
  assert.match(app, /hostKeyFP: meta\.fp \|\| base\.hostKeyFP \|\| h\.hostKeyFP/);
  assert.match(app, /serviceInstanceID: meta\.serviceInstanceID \|\| undefined/);
  assert.match(app, /hostNonce: meta\.hostNonce \|\| undefined/);
  assert.match(app, /pairPort: meta\.pairPort \|\| undefined/);
  assert.doesNotMatch(discover, /serviceInstanceID: peer\.serviceInstanceID|hostNonce: peer\.hostNonce|pairPort: peer\.pairPort/);
  assert.match(discover, /pairingAddress/);
  assert.match(discover, /sshTarget/);
  assert.match(wait, /window\.remotepair\.sendPairingRequest/);
  assert.match(wait, /window\.remotepair\.pairingStatus/);
  assert.match(wait, /window\.setInterval\(\(\) => void sendOnce\(\), 2000\)/);
  assert.match(wait, /window\.remotepair\.pinHostKey\(sshTarget, host\.hostKeyFP!\)/);
  assert.match(wait, /status\.paired/);
  assert.doesNotMatch(wait, /simAccept|simDeny|setAccepted\(true\)\}/);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\npairing signing tests passed");
