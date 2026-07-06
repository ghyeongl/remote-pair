const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const appDelegate = fs.readFileSync(path.join(root, "host/app/AppDelegate.swift"), "utf8");
const onboardingWindow = fs.readFileSync(path.join(root, "host/app/OnboardingWindow.swift"), "utf8");
const hostApp = fs.readFileSync(path.join(root, "host/onboarding/src/App.tsx"), "utf8");
const stepSinglePerm = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepSinglePerm.tsx"),
  "utf8",
);
const stepBroadcast = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepBroadcast.tsx"),
  "utf8",
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - host onboarding is an in-app TCC product flow`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function completeBridgeIsTccGated(source) {
  const stripped = stripLineComments(source);
  const complete = stripped.match(/case "complete":(?<body>[\s\S]*?)(?:\n\s*case "|\n\s*default:)/);
  assert.ok(complete, 'OnboardingWindow.swift must handle the "complete" bridge message');
  const body = complete.groups.body;
  const gate = body.indexOf("Permissions.allGranted()");
  const finish = body.indexOf("finish()");
  return gate !== -1 && finish !== -1 && gate < finish;
}

test("Q0441 Q0442 Q0443 Host onboarding exists in the Host app/menu bar and cannot complete before required TCC", () => {
  assert.match(
    appDelegate,
    /if !Permissions\.allGranted\(\) \{[\s\S]*OnboardingWindow\(onComplete:[\s\S]*startServingAndOpenPairingIfNeeded\(\)/,
    "launch-time host serving must be gated behind the onboarding completion callback",
  );
  assert.match(appDelegate, /menu\.addItem\(withTitle: "Permissions…", action: #selector\(grantPermissions\)/);
  assert.match(appDelegate, /menu\.addItem\(withTitle: "Connect…", action: #selector\(connectClient\)/);
  assert.match(appDelegate, /menu\.addItem\(withTitle: "Set up…", action: #selector\(openSetup\)/);
  assert.match(appDelegate, /OnboardingWindow\(mode: \.grantOnly, initialStep: "permissions"/);
  assert.match(appDelegate, /OnboardingWindow\(mode: \.grantOnly, initialStep: "connect"/);
  assert.match(appDelegate, /OnboardingWindow\(mode: \.grantOnly, initialStep: nil/);

  assert.match(hostApp, /const PERM_START = 3/);
  assert.match(hostApp, /const ENGINE_IDX = PERM_END \+ 1/);
  assert.match(hostApp, /const BROADCAST_IDX = ENGINE_IDX \+ 1/);
  assert.match(stepSinglePerm, /export const REQUIRED_PERMS: PermKey\[\] = \["login", "ax", "sr"\]/);
  assert.match(hostApp, /inPerms && isRequiredPerm\(currentPermKey\) && !currentPermGranted/);
  assert.match(hostApp, /await window\.xpair\.requestPermission\(key\)/);
  assert.match(hostApp, /await window\.xpair\.openPermissionPane\(key\)/);
  assert.match(hostApp, /window\.xpair\.beginPairing\(force\)/);
  assert.match(stepBroadcast, /export type BroadcastState =[\s\S]*"waiting"[\s\S]*"incoming"[\s\S]*"accepted-pending-proof"[\s\S]*"accepted"[\s\S]*"denied"/);

  assert.ok(
    completeBridgeIsTccGated(onboardingWindow),
    "React complete() must recheck Permissions.allGranted() before finish()",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
