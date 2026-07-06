const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const onboardingMain = fs.readFileSync(path.join(root, "onboarding-main.cjs"), "utf8");
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

check("app_first_launch is gated by firstRunStamp creation and no globalState install key remains", () => {
  assert.doesNotMatch(extension, /remotepair\.installTimestamp/);
  assert.match(
    extension,
    /const firstRun = telemetry\.firstRunStamp\(\);[\s\S]*const isFresh = !!\(firstRun && firstRun\.created\);[\s\S]*if \(isFresh\) telemetry\.capture\(telemetry\.EVENTS\.APP_FIRST_LAUNCH, \{ is_fresh_install: true \}\);/,
  );
  assert.match(
    onboardingMain,
    /const firstRunStamp = _firstRunStamp[\s\S]*_firstRunStamp = null[\s\S]*firstRunStamp && firstRunStamp\.created[\s\S]*telemetry\.capture\(telemetry\.EVENTS\.APP_FIRST_LAUNCH, \{ is_fresh_install: true \}\)/,
  );
});

check("notification polling and host probing are protected by the client services lock", () => {
  indexOfOrThrow(extension, 'const CLIENT_SERVICES_LOCK_FILE = path.join(RP_CLIENT_DIR, "extension-services.lock")');
  assert.match(extension, /fs\.constants\.O_CREAT \| fs\.constants\.O_EXCL \| fs\.constants\.O_WRONLY/);
  assert.ok(extension.includes("fs.writeFileSync(fd, `${process.pid}\\n`);"));
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
