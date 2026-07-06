const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const delegate = fs.readFileSync(path.join(root, "host/app/AppDelegate.swift"), "utf8");
const onboardingWindow = fs.readFileSync(path.join(root, "host/app/OnboardingWindow.swift"), "utf8");
const hostOnboarding = fs.readFileSync(path.join(root, "host/onboarding/src/App.tsx"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - Host menu bar exposes onboarding as a product flow`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("Q0441/Q0442/Q0473/Q0493/Q0494 Host onboarding is accessible from the Host app/menu bar", () => {
  assert.match(
    delegate,
    /statusItem = NSStatusBar\.system\.statusItem[\s\S]*menu\.delegate = self[\s\S]*statusItem\.menu = menu/,
    "Host app must own a live menu-bar menu",
  );
  assert.match(
    delegate,
    /NSMenuItem\(title: "Permissions"[\s\S]*"Accessibility"[\s\S]*"Screen Recording"[\s\S]*"Full Disk"/,
    "menu must expose permission state",
  );
  assert.match(
    delegate,
    /menu\.addItem\(withTitle: "Permissions…", action: #selector\(grantPermissions\)/,
    "menu must provide a Permissions onboarding entry",
  );
  assert.match(
    delegate,
    /menu\.addItem\(withTitle: "Connect…", action: #selector\(connectClient\)/,
    "menu must provide a Connect onboarding entry",
  );
  assert.match(
    delegate,
    /menu\.addItem\(withTitle: "Set up…", action: #selector\(openSetup\)/,
    "menu must provide a full Set up onboarding entry",
  );
  assert.match(
    delegate,
    /menu\.addItem\(withTitle: "Check for Updates…", action: #selector\(checkUpdates\)/,
    "menu must provide update control",
  );
  assert.ok(delegate.includes("let serverUp = Sessions.serverUp()"), "menu must query tmux host status");
  assert.ok(
    delegate.includes("let sessions = serverUp ? Sessions.list() : []"),
    "menu must query current sessions when the server is up",
  );
  assert.ok(
    delegate.includes('NSMenuItem(title: serverUp ? "Sessions (\\(sessions.count))" : "tmux host: down"'),
    "menu must expose session status",
  );

  assert.match(
    delegate,
    /@objc func grantPermissions\(\)[\s\S]*Permissions\.request\("ax"\); Permissions\.request\("sr"\)[\s\S]*OnboardingWindow\(mode: \.grantOnly, initialStep: "permissions"/,
    "Permissions entry must reopen onboarding at the permissions step",
  );
  assert.match(
    delegate,
    /@objc func connectClient\(\)[\s\S]*OnboardingWindow\(mode: \.grantOnly, initialStep: "connect"/,
    "Connect entry must reopen onboarding at the connection guide step",
  );
  assert.match(
    delegate,
    /@objc func openSetup\(\)[\s\S]*OnboardingWindow\(mode: \.grantOnly, initialStep: nil/,
    "Set up entry must reopen the whole Host onboarding from scratch",
  );
  assert.match(
    delegate,
    /@objc func checkUpdates\(\) \{ Updater\.checkForUpdates\(interactive: true\) \}/,
    "Update menu item must invoke the app update flow",
  );

  assert.match(
    onboardingWindow,
    /private let initialStep: String\?[\s\S]*window\.__rp_initialStep = '\\\(step\)'/,
    "OnboardingWindow must inject initialStep for menu deep-links",
  );
  assert.match(
    hostOnboarding,
    /const PERM_START = 3[\s\S]*const ENGINE_IDX = PERM_END \+ 1[\s\S]*const BROADCAST_IDX = ENGINE_IDX \+ 1[\s\S]*const DONE_IDX = BROADCAST_IDX \+ 1/,
    "full Host onboarding must include split permissions, engine, Broadcast, and Done steps",
  );
  assert.match(
    hostOnboarding,
    /deepLink === "permissions"\) return PERM_START[\s\S]*deepLink === "engine"\) return ENGINE_IDX[\s\S]*deepLink === "connect"\) return BROADCAST_IDX/,
    "Host onboarding must route menu deep-links and default Set up to Welcome",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
