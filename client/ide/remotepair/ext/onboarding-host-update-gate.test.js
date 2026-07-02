const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const app = fs.readFileSync(path.join(root, "onboarding-webview/src/App.tsx"), "utf8");
const discover = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepDiscover.tsx"),
  "utf8",
);
const update = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepUpdate.tsx"),
  "utf8",
);
const bridge = fs.readFileSync(path.join(root, "onboarding-bridge.js"), "utf8");
const globals = fs.readFileSync(path.join(root, "onboarding-webview/src/global.d.ts"), "utf8");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message.split("\n")[0]}`);
  }
}

test("bridge and preload contracts still expose force host updates and incompatibility kind", () => {
  assert.match(bridge, /const MIN_COMPATIBLE_HOST = "0\.5\.0a51";/);
  assert.match(bridge, /async installHost\(\{ host, user, password, force \} = \{\}\)/);
  assert.match(bridge, /if \(force\) args\.push\("--force"\)/);
  assert.match(bridge, /incompatibleKind = "major_mismatch"/);
  assert.match(bridge, /incompatibleKind = "below_floor"/);
  assert.match(globals, /installHost: \(opts: \{ host: string; user\?: string; password\?: string; force\?: boolean \}\)/);
  assert.match(globals, /incompatibleKind: "below_floor" \| "major_mismatch" \| ""/);
});

test("discovery classifies host update states before leaving Discover", () => {
  assert.match(discover, /function deriveHostFlags/);
  assert.match(discover, /!!r\.installed && !r\.compatible && r\.incompatibleKind === "major_mismatch"/);
  assert.match(discover, /!majorMismatch && !!r\.installed && !r\.compatible && r\.incompatibleKind === "below_floor"/);
  assert.match(discover, /const status = await window\.remotepair\.hostAppStatus\(host\.sshTarget \?\? host\.address\)/);
  assert.match(discover, /outdated: flags\.outdated/);
  assert.match(discover, /majorMismatch: flags\.majorMismatch/);
});

test("App gates the Update step and cannot finish while update or pairing is incomplete", () => {
  assert.match(app, /UPDATE: 4,[\s\S]*WAIT_PERM: 5,[\s\S]*MAPPINGS: 6,[\s\S]*DONE: 7/);
  assert.match(app, /const needsUpdate = !!selectedHost\?\.outdated;/);
  assert.match(app, /const majorMismatch = !!selectedHost\?\.majorMismatch;/);
  assert.match(app, /const blockedOnUpdate = w\.index === 4 && majorMismatch;/);
  assert.match(app, /w\.index === 4 && needsUpdate && updateState !== "done"/);
  assert.match(app, /if \(majorMismatch \|\| \(needsUpdate && updateState !== "done"\)\) \{[\s\S]*w\.goTo\(S\.UPDATE, "prev"\)/);
  assert.match(app, /if \(!permAccepted \|\| permDenied\) \{[\s\S]*w\.goTo\(S\.WAIT_PERM, "prev"\)/);
  assert.match(app, /if \(!hasRealMapping\) \{[\s\S]*w\.goTo\(S\.MAPPINGS, "prev"\)/);
  assert.match(app, /w\.index === 4 && !needsUpdate && !majorMismatch && updateState !== "done"[\s\S]*setTimeout\(\(\) => w\.next\(\), 650\)/);
});

test("StepUpdate force-installs below-floor hosts, re-probes, and blocks major mismatches", () => {
  assert.match(update, /const needsUpdate = !!host\?\.outdated && !host\.majorMismatch;/);
  assert.match(update, /const majorMismatch = !!host\?\.majorMismatch;/);
  assert.match(update, /if \(majorMismatch\) \{[\s\S]*<StepDeadEnd[\s\S]*title=\{t\("update\.tooNew\.title"\)\}[\s\S]*update\.checkClientUpdates[\s\S]*update\.pickAnother/);
  assert.match(update, /window\.remotepair\.installHost\(\{ host: host\.address, force: true \}\)/);
  assert.match(update, /const status = await window\.remotepair\.hostAppStatus\(host\.address\)/);
  assert.match(update, /if \(status\.compatible\) \{[\s\S]*setPct\(100\);[\s\S]*setState\("done"\);[\s\S]*return;/);
  assert.match(update, /setError\(status\.err \|\| t\("update\.error"\)\)/);
  assert.doesNotMatch(app, /StepInstalling/);
  assert.doesNotMatch(app, /routeToHostUpdate/);
});

test("password bootstrap states remain bridge-only, not a renderer StepInstalling dependency", () => {
  assert.match(bridge, /NEEDS_PASSWORD: "needs_password"/);
  assert.match(bridge, /PASSWORD_DENIED: "password_denied"/);
  assert.match(bridge, /PROMPT_PASSWORD: "prompt_password"/);
  assert.match(bridge, /cliWithPasswordStdin\(args, pw\)/);
  assert.doesNotMatch(app, /StepSetupPassword/);
});

console.log(
  failed ? `\n${failed} test(s) failed` : "\nall onboarding host-update gate tests passed",
);
process.exit(failed ? 1 : 0);
