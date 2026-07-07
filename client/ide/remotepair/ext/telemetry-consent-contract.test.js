const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const onboardingMain = fs.readFileSync(path.join(root, "onboarding-main.cjs"), "utf8");
const onboardingApp = fs.readFileSync(path.join(root, "onboarding-webview/src/App.tsx"), "utf8");
const onboardingStepConsent = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepConsent.tsx"),
  "utf8",
);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}\n        ${error && error.message ? error.message : error}`);
  }
}

function indexOfOrThrow(source, needle) {
  const idx = source.indexOf(needle);
  assert.notStrictEqual(idx, -1, `missing ${needle}`);
  return idx;
}

check("settings mirror reads telemetry.env on activation and writes only TELEMETRY_CONSENT on changes", () => {
  assert.equal(
    pkg.contributes.configuration.properties["xpair.telemetry.enabled"].description,
    "Opt in to Xpair product analytics for this client.",
  );
  assert.match(
    extension,
    /function mirrorTelemetryConsentToSetting\(\) \{[\s\S]*const enabled = telemetry\.telemetryConsent\(\);[\s\S]*cfg\.update\("enabled", enabled, vscode\.ConfigurationTarget\.Global\)/,
  );
  assert.match(
    extension,
    /vscode\.workspace\.onDidChangeConfiguration\(\(e\) => \{[\s\S]*e\.affectsConfiguration\("xpair\.telemetry\.enabled"\)[\s\S]*syncTelemetryConsentFromSettingChange\(\);/,
  );
  assert.match(
    extension,
    /function syncTelemetryConsentFromSettingChange\(\) \{[\s\S]*telemetry\.setTelemetryConsent\(enabled\);[\s\S]*\}/,
  );
  assert.doesNotMatch(extension, /telemetry\.setConsent\(enabled,\s*enabled\)/);
});

check("client onboarding consent UI defaults off and only persists after user changes", () => {
  assert.match(onboardingApp, /const \[crashReports, setCrashReports\] = useState\(false\)/);
  assert.match(onboardingApp, /const \[analytics, setAnalytics\] = useState\(false\)/);
  assert.match(onboardingApp, /const \[consentLoaded, setConsentLoaded\] = useState\(false\)/);
  assert.match(onboardingApp, /const \[consentDirty, setConsentDirty\] = useState\(false\)/);
  assert.match(onboardingApp, /tGetConsent\(\)[\s\S]*setAnalytics\(\!\!r\.telemetry\)[\s\S]*setCrashReports\(\!\!r\.crashReport\)[\s\S]*setConsentLoaded\(true\)/);
  assert.match(onboardingApp, /if \(!consentLoaded \|\| !consentDirty\) return;[\s\S]*window\.remotepair\.tSetConsent\(analytics, crashReports\)/);
  assert.match(onboardingApp, /kind="crash"[\s\S]*disabled=\{!consentLoaded\}[\s\S]*setConsentDirty\(true\)[\s\S]*setCrashReports\(v\)/);
  assert.match(onboardingApp, /kind="analytics"[\s\S]*disabled=\{!consentLoaded\}[\s\S]*setConsentDirty\(true\)[\s\S]*setAnalytics\(v\)/);

  assert.match(onboardingStepConsent, /disabled\?: boolean/);
  assert.match(onboardingStepConsent, /disabled=\{disabled\}/);
  assert.doesNotMatch(onboardingStepConsent, /t\("consent\.recommended"\)/);
});

check("app_first_launch uses the persisted consent-aware claim and no globalState install key remains", () => {
  assert.doesNotMatch(extension, /remotepair\.installTimestamp/);
  // Claim-based, not created-based: an abandoned onboarding leaves the stamp without the
  // event; the claim persists until a consented launch/completion emits exactly once.
  assert.match(
    extension,
    /telemetry\.firstRunStamp\(\);[\s\S]*if \(telemetry\.claimFirstLaunchOnce\(\)\) \{[\s\S]*telemetry\.capture\(telemetry\.EVENTS\.APP_FIRST_LAUNCH, \{ is_fresh_install: true \}\);/,
  );
  assert.match(
    onboardingMain,
    /telemetry\.claimFirstLaunchOnce && telemetry\.claimFirstLaunchOnce\(\)[\s\S]*telemetry\.capture\(telemetry\.EVENTS\.APP_FIRST_LAUNCH, \{ is_fresh_install: true \}\)/,
  );
  const telemetryModule = fs.readFileSync(path.join(root, "telemetry.js"), "utf8");
  assert.match(
    telemetryModule,
    /function claimFirstLaunchOnce\(\) \{[\s\S]*if \(!telemetryConsent\(\)\) return false;[\s\S]*K_FIRST_LAUNCH_STAMP/,
  );
  // Upgrade safety: only a "pending" marker (written at genuine stamp creation) emits;
  // a marker-less upgraded install backfills WITHOUT emitting.
  assert.match(telemetryModule, /marker === "pending"/);
  // Cross-process atomicity: the pending emission is arbitrated by an O_EXCL token file.
  assert.match(telemetryModule, /FIRST_LAUNCH_CLAIM, fs\.constants\.O_CREAT \| fs\.constants\.O_EXCL/);
  assert.match(telemetryModule, /backfilled:\$\{Date\.now\(\)\}/);
  assert.match(telemetryModule, /if \(created\) upsertEnv\(K_FIRST_LAUNCH_STAMP, "pending"\)/);
});

check("notification polling and host probing are protected by the client services lock", () => {
  // Per-window scope: sessionId in the lock name dedupes the window's dual hosts without
  // starving other windows' pollers; stale sibling locks are swept by dead-pid check.
  // Workspace-scoped (NOT sessionId — not documented per-window): both hosts of a
  // window share the workspace; other windows get their own lock.
  assert.match(extension, /workspaceFolders \|\| \[\]\)\.map\(\(f\) => f\.uri\.fsPath\)/);
  assert.match(extension, /extension-services\.\$\{scope\}\.lock/);
  assert.match(extension, /\} else \{\n    \/\/ Non-owner host: ONE startup probe[\s\S]*?probeHost\(\);/);
  assert.match(extension, /function sweepStaleServiceLocks\(\)/);
  // Atomic create-with-content: link(2) of a pre-written temp file, never O_EXCL-then-write
  // (a racing host must never read an empty lock and unlink a live owner).
  assert.match(extension, /fs\.linkSync\(tmp, CLIENT_SERVICES_LOCK_FILE\)/);
  assert.ok(extension.includes("fs.writeFileSync(tmp, `${process.pid}\\n`, { mode: 0o600 });"));
  assert.match(
    extension,
    /const pid = readClientServicesLockPid\(\);[\s\S]*if \(pid && isProcessAlive\(pid\)\) return null;[\s\S]*fs\.unlinkSync\(CLIENT_SERVICES_LOCK_FILE\);/,
  );

  const claimIdx = indexOfOrThrow(extension, "const clientServicesLock = claimClientServicesLock();");
  const probeIdx = indexOfOrThrow(extension, "if (clientServicesLock) {\n    probeHost();");
  const timerIdx = indexOfOrThrow(extension, "const hostProbeTimer = setInterval(probeHost, 20000);");
  const pollerIdx = indexOfOrThrow(extension, "const notifier = new NotificationPoller();");
  assert.ok(claimIdx < probeIdx, "lock must be claimed before the initial probe");
  assert.ok(probeIdx < timerIdx, "probe timer must be inside the lock-owned block");
  assert.ok(claimIdx < pollerIdx, "lock must be claimed before the notification poller starts");
  assert.match(
    extension,
    /if \(clientServicesLock\) \{[\s\S]*const notifier = new NotificationPoller\(\);[\s\S]*notifier\.start\(\);[\s\S]*clientServiceDisposables\.push\(\{ dispose: \(\) => notifier\.stop\(\) \}\);[\s\S]*\}/,
  );
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall telemetry consent contract tests passed");
