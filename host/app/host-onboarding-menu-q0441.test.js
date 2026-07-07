const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const main = fs.readFileSync(path.join(root, "host/app/main.swift"), "utf8");
const appDelegate = fs.readFileSync(path.join(root, "host/app/AppDelegate.swift"), "utf8");
const onboardingWindow = fs.readFileSync(path.join(root, "host/app/OnboardingWindow.swift"), "utf8");
const hostApp = fs.readFileSync(path.join(root, "host/onboarding/src/App.tsx"), "utf8");
const stepBroadcast = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepBroadcast.tsx"),
  "utf8",
);
const stepDone = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepDone.tsx"),
  "utf8",
);
const i18n = fs.readFileSync(path.join(root, "host/onboarding/src/lib/i18n.ts"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - Host onboarding is reachable from the menu bar`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("Q0441 Host onboarding is a Host app/menu-bar product flow that waits for a client", () => {
  assert.match(
    main,
    /app\.setActivationPolicy\(\.accessory\)/,
    "Host app must run as a menu-bar accessory app",
  );
  assert.match(appDelegate, /NSStatusBar\.system\.statusItem/, "Host app must create a menu-bar item");
  assert.match(appDelegate, /menu\.delegate = self/, "Menu must be rebuilt by the Host app");
  assert.match(
    appDelegate,
    /withTitle: "Permissions…", action: #selector\(grantPermissions\)/,
    "Host menu must expose permission onboarding",
  );
  assert.match(
    appDelegate,
    /withTitle: "Connect…", action: #selector\(connectClient\)/,
    "Host menu must expose the client-connection onboarding step",
  );
  assert.match(
    appDelegate,
    /withTitle: "Set up…", action: #selector\(openSetup\)/,
    "Host menu must expose the full setup onboarding flow",
  );
  assert.match(
    appDelegate,
    /func grantPermissions\(\)[\s\S]*OnboardingWindow\(mode: \.grantOnly, initialStep: "permissions"/,
    "Permissions menu item must open onboarding, not a disconnected settings screen",
  );
  assert.match(
    appDelegate,
    /func connectClient\(\)[\s\S]*OnboardingWindow\(mode: \.grantOnly, initialStep: "connect"/,
    "Connect menu item must deep-link into onboarding",
  );
  assert.match(
    appDelegate,
    /func openSetup\(\)[\s\S]*OnboardingWindow\(mode: \.grantOnly, initialStep: nil/,
    "Set up menu item must open the full onboarding flow",
  );
  assert.match(
    onboardingWindow,
    /beginPairing: \(force = false\) => post\('beginPairing', \[force\]\)/,
    "Onboarding bridge must expose the host Broadcast/pairing start",
  );
  assert.match(
    onboardingWindow,
    /case "pairingStatus":[\s\S]*PairingManager\.shared\.status\(\)/,
    "Broadcast status must come from the real Host app/menu-bar pairing state",
  );
  assert.match(
    hostApp,
    /window\.xpair[\s\S]*\.pairingStatus\(\)/,
    "Host connect step must poll the pairing lifecycle",
  );
  assert.match(
    i18n,
    /Open Xpair on your client/,
    "Host connect step must guide the user to start the Client",
  );
  assert.match(
    stepBroadcast,
    /state !== "waiting"/,
    "Host connect step must remain in a waiting/broadcast state until a client is paired",
  );
  assert.match(
    stepDone,
    /t\("done\.host\.menubar"\)/,
    "Completed host setup must still route ongoing control back to the Host menu-bar flow",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
