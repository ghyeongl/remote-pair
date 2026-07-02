const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const singlePerm = fs.readFileSync(
  path.join(root, "src/components/onboarding/host/StepSinglePerm.tsx"),
  "utf8",
);
const i18n = fs.readFileSync(path.join(root, "src/lib/i18n.ts"), "utf8");
const globalTypes = fs.readFileSync(path.join(root, "src/global.d.ts"), "utf8");
const appDelegate = fs.readFileSync(path.join(root, "../app/AppDelegate.swift"), "utf8");
const onboardingWindow = fs.readFileSync(path.join(root, "../app/OnboardingWindow.swift"), "utf8");
const permissionsSwift = fs.readFileSync(path.join(root, "../app/Permissions.swift"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - host permission routing matches US-003`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("US-003 permission steps are five sequential panes at indices 3..7", () => {
  assert.match(app, /const CONSENT_ANALYTICS_IDX = 2/);
  assert.match(app, /const PERM_START = 3/);
  assert.match(app, /const PERM_END = PERM_START \+ PERM_ORDER\.length - 1/);
  assert.match(app, /const ENGINE_IDX = PERM_END \+ 1/);
  assert.match(app, /const BROADCAST_IDX = ENGINE_IDX \+ 1/);
  assert.match(app, /const DONE_IDX = BROADCAST_IDX \+ 1/);
  assert.match(app, /const TOTAL = DONE_IDX \+ 1/);
  assert.match(singlePerm, /export const PERM_ORDER: PermKey\[\] = \["login", "ax", "sr", "fda", "sharing"\]/);
  assert.match(app, /permKey=\{currentPermKey\}/);
  assert.match(app, /status=\{perm\[currentPermKey\]\}/);
});

test("US-003 deep-links are pinned to the new host indices", () => {
  assert.match(app, /deepLink === "permissions"\) return PERM_START/);
  assert.match(app, /deepLink === "engine"\) return ENGINE_IDX/);
  assert.match(app, /deepLink === "connect"\) return BROADCAST_IDX/);
  assert.match(
    appDelegate,
    /OnboardingWindow\(mode: \.grantOnly, initialStep: "permissions"/,
    "Host permissions menu action must keep injecting the permissions token",
  );
  assert.match(
    appDelegate,
    /OnboardingWindow\(mode: \.grantOnly, initialStep: "connect"/,
    "Host connect menu action must keep injecting the connect token",
  );
});

test("US-003 login and sharing bridge panes are wired to Settings URLs and pane copy", () => {
  assert.match(i18n, /"perm\.login\.pane": "System Settings → General → Sharing → Remote Login"/);
  assert.match(i18n, /"perm\.sharing\.pane": "System Settings → General → Sharing → File Sharing"/);
  assert.match(
    onboardingWindow,
    /"login": "x-apple\.systempreferences:com\.apple\.preferences\.sharing\?Services_RemoteLogin"/,
  );
  assert.match(
    onboardingWindow,
    /"sharing": "x-apple\.systempreferences:com\.apple\.preferences\.sharing\?Services_PersonalFileSharing"/,
  );
});

test("US-003 widened permission bridge probes real login/sharing facts", () => {
  assert.match(
    globalTypes,
    /openPermissionPane: \(key: 'login' \| 'ax' \| 'sr' \| 'fda' \| 'sharing'\) => Promise<void>/,
  );
  assert.match(
    globalTypes,
    /getStatus: \(\) => Promise<\{ alive: boolean; login: boolean; ax: boolean; sr: boolean; fda: boolean; sharing: boolean \}>/,
  );
  assert.match(onboardingWindow, /"login": Permissions\.loginGranted\(\)/);
  assert.match(onboardingWindow, /"sharing": Permissions\.sharingGranted\(\)/);
  assert.match(permissionsSwift, /static func loginGranted\(\)\s*-> Bool/);
  assert.match(permissionsSwift, /static func sharingGranted\(\)\s*-> Bool/);
  // The native gate must require the SAME set the React flow marks required (REQUIRED_PERMS =
  // login, ax, sr) — Remote Login is the transport every session rides on, so allGranted() includes it.
  assert.match(permissionsSwift, /static func allGranted\(\) -> Bool \{ axTrusted\(\) && srGranted\(\) && loginGranted\(\) \}/);
});

test("US-003 gates block required permissions only, then >=1 ready engine and persisted consent", () => {
  assert.match(singlePerm, /export const REQUIRED_PERMS: PermKey\[\] = \["login", "ax", "sr"\]/);
  assert.match(singlePerm, /export function isRequiredPerm/);
  assert.match(app, /inPerms && isRequiredPerm\(currentPermKey\) && !currentPermGranted/);
  assert.match(
    app,
    /const i = REQUIRED_PERMS\.findIndex\(\(k\) => state\[k\] !== "granted"\)/,
    "resume/hydration must only bounce back to required permissions",
  );
  assert.match(singlePerm, /!required && !granted[\s\S]*perm\.recommendedContinue/);
  assert.match(i18n, /"perm\.recommendedContinue": "Recommended — you can continue"/);
  assert.match(i18n, /"perm\.recommendedContinue": "권장 항목입니다 — 계속 진행할 수 있습니다"/);
  assert.match(app, /w\.index === ENGINE_IDX && engines\.size === 0/);
  assert.match(app, /const \[crashReports, setCrashReports\] = useState\(true\)/);
  assert.match(app, /const \[analytics, setAnalytics\] = useState\(false\)/);
  assert.match(app, /window\.xpair[\s\S]*\.getConsent\(\)[\s\S]*setConsentLoaded\(true\)/);
  assert.match(app, /if \(!consentLoaded \|\| !consentDirty\) return;[\s\S]*window\.xpair\.setConsent\(\{ telemetry: analytics, crash: crashReports \}\)/);
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
