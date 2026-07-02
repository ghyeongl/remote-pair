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

check("pairing signer supports encrypted keys through ssh-agent without changing raw signature format", () => {
  const bridgeSource = fs.readFileSync(path.join(__dirname, "onboarding-bridge.js"), "utf8");
  assert.match(bridgeSource, /async function signWithAgent\(pubBlob, transcript\)/);
  assert.match(bridgeSource, /SSH_AGENTC_SIGN_REQUEST = 13/);
  assert.match(bridgeSource, /sigType\.toString\("utf8"\) !== "ssh-ed25519" \|\| rawSig\.length !== 64/);
  assert.match(bridgeSource, /return await signWithAgent\(pub\.blob, transcript\)/);
  assert.match(bridgeSource, /encrypted client key is not available through ssh-agent/);
});

check("gateway MAC guard runs before automatic ssh reachability", () => {
  const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
  const probeIdx = extension.indexOf("const probeHost = async () =>");
  const guardIdx = extension.indexOf("onboardingBridge.gatewayMacStatus()", probeIdx);
  const sshIdx = extension.indexOf('sshRun(host, "true", { timeoutMs: 6000 })', probeIdx);
  assert.ok(guardIdx > 0, "extension must call gatewayMacStatus");
  assert.ok(sshIdx > guardIdx, "gateway MAC guard must run before auto ssh probe");
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
  assert.match(manager, /incomingExpiresAt = verified\.timestamp \+ PairingSecurity\.timestampSkewSec/);
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
  assert.match(discover, /hostKeyFP: peer\.fp \|\| undefined/);
  assert.match(discover, /serviceInstanceID: peer\.serviceInstanceID/);
  assert.match(discover, /hostNonce: peer\.hostNonce/);
  assert.match(discover, /pairPort: peer\.pairPort/);
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
