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
  assert.match(app, /welcome: S\.WELCOME,[\s\S]*connect: S\.DISCOVER,[\s\S]*grant: S\.WAIT_PERM,[\s\S]*engine: S\.DISCOVER,/);
  assert.match(app, /new URLSearchParams\(window\.location\.search\)\.get\("startStep"\)/);
});

test("native guard still returns the old startStep words used by electron-main", () => {
  assert.match(onboardingMain, /CONNECT: 'connect'/);
  assert.match(onboardingMain, /GRANT: 'grant'/);
  assert.match(onboardingMain, /ENGINE: 'engine'/);
  assert.match(onboardingMain, /if \(!host\) return START_STEP\.WELCOME/);
  assert.match(onboardingMain, /probeBridge\.sshReachable\(host\)[\s\S]*return START_STEP\.CONNECT/);
  assert.match(onboardingMain, /probeBridge\.hostPermissions\(\{ host \}\)[\s\S]*return START_STEP\.GRANT/);
  assert.match(onboardingMain, /probeBridge\.hostEngineStatus\(configuredEngine\(clientEnv\)\)[\s\S]*return START_STEP\.ENGINE/);
});

test("discover selection probes host status and carries pairing transcript fields", () => {
  assert.match(discover, /function peerToHost\(peer: BridgePeer\): DiscoveredHost/);
  assert.match(discover, /const pairingAddress = peer\.pairingAddress \?\? peer\.addrs\[0\] \?\? peer\.name;/);
  assert.match(discover, /const sshTarget =[\s\S]*peer\.target \?\? \(peer\.hostUser \? `\$\{peer\.hostUser\}@\$\{pairingAddress\}` : pairingAddress\)/);
  assert.match(discover, /transport: peer\.source === "tailscale" \? "Tailscale" : "LAN"/);
  assert.match(discover, /hostKeyFP: peer\.fp \|\| undefined/);
  assert.match(discover, /serviceInstanceID: peer\.serviceInstanceID/);
  assert.match(discover, /hostNonce: peer\.hostNonce/);
  assert.match(discover, /pairPort: peer\.pairPort/);
  assert.match(discover, /const status = await window\.remotepair\.hostAppStatus\(host\.sshTarget \?\? host\.address\)/);
  assert.match(discover, /majorMismatch[\s\S]*incompatibleKind === "major_mismatch"/);
  assert.match(discover, /outdated[\s\S]*incompatibleKind === "below_floor"/);
});

test("pairing wait step sends the signed request and persists host only after proof", () => {
  assert.match(waitPerm, /const pairingHost = host\.pairingAddress \?\? host\.address/);
  assert.match(waitPerm, /const sshTarget = host\.sshTarget \?\? host\.address/);
  assert.match(waitPerm, /window\.remotepair\.sendPairingRequest\(\{[\s\S]*host: pairingHost,[\s\S]*port: host\.pairPort!,[\s\S]*hostKeyFP: host\.hostKeyFP!,[\s\S]*hostNonce: host\.hostNonce!,[\s\S]*serviceInstanceID: host\.serviceInstanceID!,/);
  assert.match(waitPerm, /window\.remotepair\.pairingStatus\(\{[\s\S]*host: sshTarget,[\s\S]*pairingHost,/);
  assert.match(waitPerm, /status\.paired[\s\S]*status\.fingerprint === expectedFingerprint/);
  assert.match(waitPerm, /await window\.remotepair\.setHost\(sshTarget\)\.catch\(\(\) => \{\}\)/);
  assert.match(waitPerm, /status\.denied[\s\S]*onDeny\(\)/);
  assert.match(waitPerm, /Host is not broadcasting pairing details/);
});

console.log("\nall onboarding routing tests passed");
