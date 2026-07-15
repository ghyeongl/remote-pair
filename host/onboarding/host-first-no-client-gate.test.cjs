const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const appDelegate = fs.readFileSync(path.join(root, "../app/AppDelegate.swift"), "utf8");
const stepBroadcast = fs.readFileSync(
  path.join(root, "src/components/onboarding/host/StepBroadcast.tsx"),
  "utf8",
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - broadcast gate is the US-004 seam`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("US-004 host Broadcast holds until the backend reports a proven paired state", () => {
  assert.match(app, /const BROADCAST_IDX = ENGINE_IDX \+ 1/);
  assert.match(app, /const \[broadcast, setBroadcast\] = useState<BroadcastState>\("waiting"\)/);
  assert.doesNotMatch(app, /accept(?:ed)?Click|rawAccept|hasAccepted/);
  assert.match(
    app,
    /w\.index === BROADCAST_IDX && broadcast !== "accepted"[\s\S]*\? undefined[\s\S]*: w\.next/,
    "Next must be hidden at Broadcast until broadcast === accepted",
  );
  assert.match(
    app,
    /w\.index === BROADCAST_IDX && broadcast === "accepted"[\s\S]*\? t\("shell\.continue"\)/,
    "Accepted broadcast must restore the Continue label",
  );
  assert.match(
    app,
    /w\.index === BROADCAST_IDX && broadcast === "incoming"[\s\S]*t\("bc\.deny"\)[\s\S]*t\("bc\.accept"\)/,
    "Accept/Deny buttons must live in the footerSlot while incoming",
  );
  assert.doesNotMatch(app, /shell\.skip|t\("shell\.skip"\)/, "Broadcast must not expose Skip");
  assert.match(
    stepBroadcast,
    /export type BroadcastState =[\s\S]*"waiting"[\s\S]*"incoming"[\s\S]*"accepted-pending-proof"[\s\S]*"accepted"[\s\S]*"denied"/,
  );
  assert.match(
    app,
    /window\.xpair[\s\S]*\.acceptPairing\(\{ id: request\.id, keyFingerprint: request\.keyFingerprint \}\)[\s\S]*\.then\(applyPairingStatus\)/,
  );
  assert.match(stepBroadcast, /setState\("waiting"\)/, "Deny recovery must rebroadcast in-body");
  assert.doesNotMatch(stepBroadcast, /setState\("accepted"\)/, "Accept belongs in the WizardShell footerSlot");
});

test("launch gate opens Connect when permissions are granted but no client is paired", () => {
  assert.match(
    appDelegate,
    /\} else \{[\s\S]*startServing\(\)[\s\S]*isHostRole && !PairingManager\.shared\.hasPairedClient\(\)[\s\S]*OnboardingWindow\(mode: \.grantOnly, initialStep: "connect"/,
    "permissions-complete launch with an empty pairing ledger must serve first, then open grant-only Connect",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
