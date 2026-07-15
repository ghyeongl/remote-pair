const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const appDelegate = fs.readFileSync(path.join(root, "host/app/AppDelegate.swift"), "utf8");
const hostApp = fs.readFileSync(path.join(root, "host/onboarding/src/App.tsx"), "utf8");
const stepWelcome = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepWelcome.tsx"),
  "utf8",
);
const stepSinglePerm = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepSinglePerm.tsx"),
  "utf8",
);
const stepEngine = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepEngine.tsx"),
  "utf8",
);
const stepBroadcast = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepBroadcast.tsx"),
  "utf8",
);
const i18n = fs.readFileSync(
  path.join(root, "host/onboarding/src/lib/i18n.ts"),
  "utf8",
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - Host onboarding exists and owns setup`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("§1.2 Q0441 Host onboarding exists for permissions, engine, and connect setup", () => {
  assert.match(
    appDelegate,
    /if !Permissions\.allGranted\(\) \{[\s\S]*Permissions\.request\("ax"\)[\s\S]*Permissions\.request\("sr"\)[\s\S]*let ob = OnboardingWindow/,
    "launch must show Host onboarding and pre-register requestable TCC permissions when required permissions are unresolved",
  );
  assert.match(
    appDelegate,
    /menu\.addItem\(withTitle: "Permissions…", action: #selector\(grantPermissions\)/,
    "Host menu must reopen the permissions onboarding step",
  );
  assert.match(
    appDelegate,
    /OnboardingWindow\(mode: \.grantOnly, initialStep: "permissions"/,
    "Permissions menu action must deep-link to the Host permissions step",
  );
  assert.match(
    appDelegate,
    /menu\.addItem\(withTitle: "Connect…", action: #selector\(connectClient\)/,
    "Host menu must expose the client connection onboarding guide",
  );
  assert.match(
    appDelegate,
    /OnboardingWindow\(mode: \.grantOnly, initialStep: "connect"/,
    "Connect menu action must deep-link to the Host client-connection step",
  );
  assert.match(
    appDelegate,
    /menu\.addItem\(withTitle: "Set up…", action: #selector\(openSetup\)/,
    "Host menu must expose the full setup onboarding flow",
  );
  assert.match(
    appDelegate,
    /OnboardingWindow\(mode: \.grantOnly, initialStep: nil/,
    "Set up menu action must start Host onboarding from Welcome",
  );
  assert.match(
    hostApp,
    /const PERM_START = 3[\s\S]*const ENGINE_IDX = PERM_END \+ 1[\s\S]*const BROADCAST_IDX = ENGINE_IDX \+ 1[\s\S]*const DONE_IDX = BROADCAST_IDX \+ 1/,
    "Host onboarding must include Welcome, consent, permissions, Engine, Broadcast, and Done steps",
  );
  assert.match(
    hostApp,
    /deepLink === "permissions"\) return PERM_START[\s\S]*deepLink === "engine"\) return ENGINE_IDX[\s\S]*deepLink === "connect"\) return BROADCAST_IDX/,
    "Host onboarding must route menu deep-links to the current split-step indices",
  );
  assert.match(
    hostApp,
    /inPerms && isRequiredPerm\(currentPermKey\) && !currentPermGranted/,
    "Host onboarding must gate required permission panes",
  );
  assert.match(
    hostApp,
    /w\.index === ENGINE_IDX && engines\.size === 0/,
    "Host onboarding must gate the engine step",
  );
  assert.match(
    hostApp,
    /w\.index === BROADCAST_IDX && broadcast !== "accepted"[\s\S]*\? undefined/,
    "Host onboarding must gate Broadcast/Connect until a proven paired state",
  );
  assert.match(stepWelcome, /title=\{t\("host\.welcome\.title"\)\}/);
  assert.match(i18n, /"host\.welcome\.title": "Set up XpairHost"/);
  assert.match(i18n, /accept connections from your client/);
  assert.match(stepSinglePerm, /export const PERM_ORDER: PermKey\[\] = \["login", "ax", "sr", "fda", "sharing"\]/);
  // File Sharing is mount-mandatory for /Volumes mappings, so React must require it.
  assert.match(stepSinglePerm, /export const REQUIRED_PERMS: PermKey\[\] = \["login", "ax", "sr", "fda", "sharing"\]/);
  assert.match(hostApp, /await window\.xpair\.requestPermission\(key\)/);
  assert.match(hostApp, /await window\.xpair\.openPermissionPane\(key\)/);
  assert.match(stepEngine, /window\.xpair\.engineStatus\(e\)/);
  assert.match(stepEngine, /s\.installed && s\.authed/);
  assert.match(hostApp, /window\.xpair\.beginPairing\(force\)/);
  assert.match(hostApp, /window\.xpair[\s\S]*\.pairingStatus\(\)/);
  assert.match(stepBroadcast, /export type BroadcastState =[\s\S]*"waiting"[\s\S]*"incoming"[\s\S]*"accepted-pending-proof"[\s\S]*"accepted"[\s\S]*"denied"/);
  assert.match(i18n, /Open Xpair on your client/);
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
