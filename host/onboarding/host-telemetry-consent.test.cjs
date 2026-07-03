const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(__dirname, "src/App.tsx"), "utf8");
const globalTypes = fs.readFileSync(path.join(__dirname, "src/global.d.ts"), "utf8");
const stepConsent = fs.readFileSync(
  path.join(__dirname, "src/components/onboarding/host/StepConsent.tsx"),
  "utf8",
);
const onboardingWindow = fs.readFileSync(
  path.join(root, "host/app/OnboardingWindow.swift"),
  "utf8",
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - host onboarding exposes and persists consent choices`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("US-003 host onboarding shows crash and analytics consent as separate persisted steps", () => {
  assert.match(app, /const \[crashReports, setCrashReports\] = useState\(true\)/);
  assert.match(app, /const \[analytics, setAnalytics\] = useState\(false\)/);
  assert.match(app, /const \[consentLoaded, setConsentLoaded\] = useState\(false\)/);
  assert.match(app, /const \[consentDirty, setConsentDirty\] = useState\(false\)/);
  assert.match(app, /window\.xpair[\s\S]*\.getConsent\(\)[\s\S]*setAnalytics\(\!\!c\.telemetry\)[\s\S]*setCrashReports\(\!\!c\.crash\)[\s\S]*setConsentLoaded\(true\)/);
  assert.match(app, /if \(!consentLoaded \|\| !consentDirty\) return;[\s\S]*window\.xpair\.setConsent\(\{ telemetry: analytics, crash: crashReports \}\)/);
  assert.match(app, /w\.index === 1 && \([\s\S]*kind="crash"[\s\S]*setConsentDirty\(true\)[\s\S]*setCrashReports\(v\)/);
  assert.match(app, /w\.index === CONSENT_ANALYTICS_IDX && \([\s\S]*kind="analytics"[\s\S]*setConsentDirty\(true\)[\s\S]*setAnalytics\(v\)/);
  assert.match(app, /window\.xpair\.setConsent\(\{ telemetry: analytics, crash: crashReports \}\)/);

  assert.match(stepConsent, /export type ConsentKind = "crash" \| "analytics"/);
  assert.match(stepConsent, /kind === "crash"/);
  assert.match(stepConsent, /t\(`consent\.\$\{kind\}\.title`\)/);
  assert.match(stepConsent, /role="switch"/);
  assert.match(stepConsent, /t\("consent\.recommended"\)/);

  assert.match(globalTypes, /getConsent: \(\) => Promise<\{ telemetry: boolean; crash: boolean \}>/);
  assert.match(globalTypes, /setConsent: \(c: \{ telemetry: boolean; crash: boolean \}\) => Promise<void>/);
  assert.match(onboardingWindow, /getConsent: \(\) => post\('getConsent', \[\]\)/);
  assert.match(onboardingWindow, /setConsent: \(c\) => post\('setConsent', \[c\]\)/);
  assert.match(onboardingWindow, /case "getConsent":[\s\S]*TelemetryClient\.consentKey[\s\S]*SentryBridge\.consentKey/);
  assert.match(onboardingWindow, /case "setConsent":[\s\S]*c\["telemetry"\][\s\S]*TelemetryClient\.consentKey/);
  assert.match(onboardingWindow, /case "setConsent":[\s\S]*c\["crash"\][\s\S]*SentryBridge\.consentKey/);
});

console.log(`${__filename}`);
console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
