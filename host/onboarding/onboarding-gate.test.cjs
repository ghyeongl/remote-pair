const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const globalTypes = fs.readFileSync(path.join(root, "src/global.d.ts"), "utf8");
const onboardingWindow = fs.readFileSync(path.resolve(root, "../app/OnboardingWindow.swift"), "utf8");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   - ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message.split("\n")[0]}`);
  }
}

test("single permission steps gate Next only on required real probes (US-003)", () => {
  assert.match(app, /const inPerms = w\.index >= PERM_START && w\.index <= PERM_END/);
  assert.match(app, /const currentPermKey = inPerms \? PERM_ORDER\[w\.index - PERM_START\] : null/);
  assert.match(app, /currentPermKey !== null && perm\[currentPermKey\] === "granted"/);
  assert.match(app, /inPerms && isRequiredPerm\(currentPermKey\) && !currentPermGranted/);
  assert.match(app, /await window\.xpair\.getStatus\(\)/);
});

test("engine step gates Next on >=1 installed+authed engine (US-003)", () => {
  assert.match(app, /w\.index === ENGINE_IDX && engines\.size === 0/);
  assert.match(app, /await window\.xpair\.engineStatus\(engine\)/);
  assert.match(app, /s\.installed && s\.authed/);
});

test("broadcast step hides Next until accepted and has no Skip (US-003)", () => {
  assert.match(app, /w\.index === BROADCAST_IDX && broadcast !== "accepted"[\s\S]*\? undefined/);
  assert.doesNotMatch(app, /shell\.skip|t\("shell\.skip"\)/);
});

test("cross-restart resume uses onboarding-step sidecar, not status/version SSoT (US-003)", () => {
  assert.match(globalTypes, /getOnboardingStep: \(\) => Promise<number>/);
  assert.match(globalTypes, /setOnboardingStep: \(n: number\) => Promise<void>/);
  assert.match(app, /await window\.xpair\.getOnboardingStep\(\)/);
  assert.match(app, /window\.xpair\.setOnboardingStep\(w\.index\)/);
  assert.ok(
    onboardingWindow.includes('private static let onboardingStepPath = "\\(RP_DIR)/onboarding-step.json"'),
    "Swift bridge must use ~/.xpair/host/onboarding-step.json as the resume sidecar",
  );
  assert.match(onboardingWindow, /case "getOnboardingStep":[\s\S]*readOnboardingStep\(\)/);
  assert.match(onboardingWindow, /case "setOnboardingStep":[\s\S]*writeOnboardingStep\(n\)/);
  assert.doesNotMatch(onboardingWindow, /onboardingStepPath[\s\S]{0,300}STATUS_FILE/);
  assert.doesNotMatch(onboardingWindow, /onboardingStepPath[\s\S]{0,300}APP_VERSION/);
});

test("grantOnly Set up starts at Welcome while runGate can resume persisted step", () => {
  assert.match(globalTypes, /__rp_mode\?: 'runGate' \| 'grantOnly'/);
  assert.match(onboardingWindow, /window\.__rp_mode = '\\\(modeName\)'/);
  assert.match(app, /const resumeAllowed = injectedMode\(\) === "runGate"/);
  assert.match(
    app,
    /const requested = requestedDeepLink > 0 \? requestedDeepLink : \(resumeAllowed \? persisted : 0\)/,
    "grantOnly without a deep link must ignore persisted DONE_IDX and open Welcome",
  );
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall host onboarding gate tests passed");
process.exit(failed ? 1 : 0);
