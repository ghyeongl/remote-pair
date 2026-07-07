const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const app = fs.readFileSync(path.join(root, "onboarding-webview/src/App.tsx"), "utf8");
const discover = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepDiscover.tsx"),
  "utf8",
);
const waitPerm = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepWaitPerm.tsx"),
  "utf8",
);
const onboardingMain = fs.readFileSync(path.join(root, "onboarding-main.cjs"), "utf8");

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    console.error(`  fail - ${name}`);
    throw error;
  }
}

test("resume vocabulary maps to the new 8-step client flow", () => {
  assert.match(app, /const TOTAL = 8;/);
  assert.match(app, /WELCOME: 0,[\s\S]*CONSENT_CRASH: 1,[\s\S]*CONSENT_ANALYTICS: 2,[\s\S]*DISCOVER: 3,[\s\S]*UPDATE: 4,[\s\S]*WAIT_PERM: 5,[\s\S]*MAPPINGS: 6,[\s\S]*DONE: 7,/);
  assert.match(app, /welcome: S\.WELCOME,[\s\S]*connect: S\.DISCOVER,[\s\S]*grant: S\.DISCOVER,[\s\S]*engine: S\.DISCOVER,/);
  assert.match(app, /new URLSearchParams\(window\.location\.search\)\.get\("startStep"\)/);
});

test("native guard still returns the old startStep words used by electron-main", () => {
  assert.match(onboardingMain, /CONNECT: 'connect'/);
  assert.match(onboardingMain, /GRANT: 'grant'/);
  assert.match(onboardingMain, /ENGINE: 'engine'/);
  assert.match(onboardingMain, /if \(!host\) return START_STEP\.WELCOME/);
  assert.match(onboardingMain, /probeBridge\.sshReachable\(host\)[\s\S]*return START_STEP\.CONNECT/);
  assert.match(onboardingMain, /probeBridge\.hostPermissions\(\{ host \}\)[\s\S]*return START_STEP\.GRANT/);
  assert.match(onboardingMain, /configuredHostEngine\(host, probeBridge\)[\s\S]*probeBridge\.hostEngineStatus\(engineToCheck\)[\s\S]*return START_STEP\.ENGINE/);
});

test("discover selection maps peers while App owns probes and pairing metadata", () => {
  assert.match(discover, /export function peerToHost\(peer: BridgePeer\): DiscoveredHost/);
  assert.match(discover, /const pairingAddress = peer\.pairingAddress \?\? peer\.addrs\[0\] \?\? peer\.name;/);
  assert.match(discover, /const sshTarget =[\s\S]*peer\.target \?\? \(peer\.hostUser \? `\$\{peer\.hostUser\}@\$\{pairingAddress\}` : pairingAddress\)/);
  assert.match(discover, /peer\.source === "lan" \? "LAN" : peer\.source === "tailscale" \? "Tailscale" : "SSH"/);
  assert.match(discover, /const chooseHost = \(peer: BridgePeer\) => \{[\s\S]*setSelected\(peerToHost\(peer\)\)/);
  assert.doesNotMatch(discover, /window\.remotepair\.hostAppStatus/);
  assert.doesNotMatch(discover, /serviceInstanceID: peer\.serviceInstanceID|hostNonce: peer\.hostNonce|pairPort: peer\.pairPort/);
  assert.match(app, /export function deriveHostFlags/);
  assert.match(app, /window\.remotepair\.hostAppStatus\(host\.sshTarget \?\? host\.address\)/);
  assert.match(app, /fetchAndMergePairingMeta/);
  assert.match(app, /window\.remotepair\.fetchPairingMeta\(target\)/);
  assert.match(app, /serviceInstanceID: meta\.serviceInstanceID \|\| undefined/);
  assert.match(app, /hostNonce: meta\.hostNonce \|\| undefined/);
  assert.match(app, /pairPort: meta\.pairPort \|\| undefined/);
});

test("pairing wait step sends the signed request and persists host only after proof", () => {
  assert.match(waitPerm, /const pairingHost = host\.pairingAddress \?\? host\.address/);
  assert.match(waitPerm, /const sshTarget = host\.sshTarget \?\? host\.address/);
  assert.match(waitPerm, /window\.remotepair\.sendPairingRequest\(\{[\s\S]*host: pairingHost,[\s\S]*port: host\.pairPort!,[\s\S]*hostKeyFP: host\.hostKeyFP!,[\s\S]*hostNonce: host\.hostNonce!,[\s\S]*serviceInstanceID: host\.serviceInstanceID!,/);
  assert.match(waitPerm, /window\.remotepair\.pairingStatus\(\{[\s\S]*host: sshTarget,[\s\S]*pairingHost,/);
  assert.match(waitPerm, /status\.paired[\s\S]*status\.fingerprint === expectedFingerprint/);
  // setHost failure must block acceptance and surface the error, not be swallowed (round-14).
  assert.match(waitPerm, /const saved = await window\.remotepair\.setHost\(sshTarget\)/);
  assert.match(waitPerm, /if \(saved && saved\.code !== 0\) \{[\s\S]*setError\(saved\.err \|\| saved\.out[\s\S]*return;/);
  assert.doesNotMatch(waitPerm, /setHost\(sshTarget\)\.catch/);
  assert.match(waitPerm, /status\.denied[\s\S]*onDeny\(\)/);
  assert.match(waitPerm, /Host is not broadcasting pairing details/);
});

console.log("\nall onboarding routing tests passed");
