const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const repoRoot = path.resolve(__dirname, "../../../..");
const appDelegate = fs.readFileSync(path.join(repoRoot, "host/app/AppDelegate.swift"), "utf8");
const hostTelemetry = fs.readFileSync(path.join(repoRoot, "host/app/TelemetryClient.swift"), "utf8");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-analytics-test-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.RP_POSTHOG_KEY;

const rpDir = path.join(tmpHome, ".xpair/client");
const clientEnv = path.join(rpDir, "client.env");
fs.mkdirSync(rpDir, { recursive: true });

function writeEnv(obj) {
  fs.writeFileSync(
    clientEnv,
    Object.entries(obj)
      .map(([key, value]) => `${key}="${value}"`)
      .join("\n") + "\n",
  );
}

let requests = 0;
const realHttpRequest = http.request;
const realHttpsRequest = https.request;

function fakeRequest() {
  return {
    on() {
      return this;
    },
    write() {},
    end() {},
    destroy() {},
  };
}

http.request = function () {
  requests += 1;
  return fakeRequest();
};
https.request = function () {
  requests += 1;
  return fakeRequest();
};

const telemetry = require("./telemetry.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - product analytics stays opt-in`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("Q0448 Q0449 product analytics sends nothing without explicit consent and key", () => {
  writeEnv({ POSTHOG_KEY: "phc_test" });
  telemetry.capture(telemetry.EVENTS.ONBOARDING_STARTED);
  assert.equal(requests, 0, "PostHog key alone must not send without TELEMETRY_CONSENT");

  writeEnv({ TELEMETRY_CONSENT: "true" });
  telemetry.capture(telemetry.EVENTS.ONBOARDING_STARTED);
  assert.equal(requests, 0, "telemetry consent alone must not send without POSTHOG_KEY");

  assert.match(
    appDelegate,
    /UserDefaults\.standard\.register\(defaults:\s*\[[\s\S]*TelemetryClient\.consentKey:\s*false/,
    "host product analytics consent must default OFF",
  );

  const consentGate = hostTelemetry.indexOf(
    "guard UserDefaults.standard.bool(forKey: consentKey) else { return }",
  );
  const keyGate = hostTelemetry.indexOf("guard let key = Bundle.main.object");
  const networkSend = hostTelemetry.indexOf("URLSession(configuration: .ephemeral)");
  assert.ok(consentGate !== -1, "host TelemetryClient.capture must guard on consent");
  assert.ok(keyGate > consentGate, "host TelemetryClient.capture must require a key after consent");
  assert.ok(networkSend > keyGate, "host network send must happen only after consent and key gates");
});

http.request = realHttpRequest;
https.request = realHttpsRequest;
try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch (_error) {
  // best effort
}

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
