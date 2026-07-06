// telemetry.test.js — zero-dep node test (node:assert + monkeypatch). Run: `node telemetry.test.js`.
//
// Covers the two OSS-audit guarantees for the OUTBOUND telemetry/Sentry paths:
//   1) the strict outbound scrubber masks IPv4/IPv6, *.ts.net, and absolute paths in a simulated
//      Sentry payload (message + extra + structured frames) — none of those leak;
//   2) with consent OFF (default), capture()/sentryCapture() perform ZERO https.request.
//
// HOME is redirected to a throwaway dir BEFORE telemetry.js loads so the test never touches the
// real ~/.xpair/client/telemetry.env (module computes RP_CLIENT_DIR/TELEMETRY_ENV at load time).

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");

// --- isolate HOME so we own telemetry.env -----------------------------------
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rp-telemetry-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME; // win parity (harmless on posix)
const RP_DIR = path.join(TMP_HOME, ".xpair/client");
const CLIENT_ENV = path.join(RP_DIR, "client.env");
const TELEMETRY_ENV = path.join(RP_DIR, "telemetry.env");
fs.mkdirSync(RP_DIR, { recursive: true });

function writeEnv(obj) {
  fs.writeFileSync(
    TELEMETRY_ENV,
    Object.entries(obj)
      .map(([k, v]) => `${k}="${v}"`)
      .join("\n") + "\n",
  );
}

// --- monkeypatch the transport to count outbound requests -------------------
let httpsCalls = 0;
let httpCalls = 0;
const realHttpsRequest = https.request;
const realHttpRequest = http.request;
// A no-op fake request object so fire-and-forget callers don't throw.
function fakeReq() {
  return {
    on() {
      return this;
    },
    write() {},
    end() {},
    destroy() {},
  };
}
https.request = function () {
  httpsCalls++;
  return fakeReq();
};
http.request = function () {
  httpCalls++;
  return fakeReq();
};

// Load AFTER HOME redirect + transport patch.
const t = require("./telemetry.js");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL - ${name}\n        ${e && e.message ? e.message : e}`);
  }
}

// PII fixtures the audit flagged — must all be masked on the outbound path.
const SECRETS = {
  ipv4: "1.2.3.4",
  ipv6: "fe80::1",
  varFolders: "/private/var/folders/ab/cd1234/T/remotepair.sock",
  otherUser: "/Users/alice/secret/project",
  tsHost: "host-7.ts.net",
};
function assertNoSecrets(blob, label) {
  for (const [k, v] of Object.entries(SECRETS)) {
    assert.ok(
      !blob.includes(v),
      `${label}: leaked ${k} (${v}) — found in: ${blob.slice(0, 400)}`,
    );
  }
}

console.log("legacy telemetry env migration:");

check("legacy telemetry keys migrate out of client.env on first read", () => {
  const legacyHostDir = path.join(TMP_HOME, ".xpair/host");
  fs.mkdirSync(legacyHostDir, { recursive: true });
  fs.rmSync(TELEMETRY_ENV, { force: true });
  fs.writeFileSync(
    CLIENT_ENV,
    "REMOTE_HOST=client-host\nTELEMETRY_INSTALL_TS=12345\nTELEMETRY_CONSENT=true\n",
  );
  fs.writeFileSync(
    path.join(legacyHostDir, "client.env"),
    "POSTHOG_HOST=https://ph.example\nFOLDER_MAPS=/c::/h\n",
  );
  assert.deepStrictEqual(t.getConsent(), { telemetry: true, crashReport: false });
  assert.strictEqual(t.installTs(), 12345);
  const telemetryRaw = fs.readFileSync(TELEMETRY_ENV, "utf8");
  assert.ok(telemetryRaw.includes('TELEMETRY_INSTALL_TS="12345"'));
  assert.ok(telemetryRaw.includes('TELEMETRY_CONSENT="true"'));
  assert.ok(telemetryRaw.includes('POSTHOG_HOST="https://ph.example"'));
  const clientRaw = fs.readFileSync(CLIENT_ENV, "utf8");
  const legacyRaw = fs.readFileSync(path.join(legacyHostDir, "client.env"), "utf8");
  assert.ok(!clientRaw.includes("TELEMETRY_INSTALL_TS="), "client.env should lose install stamp");
  assert.ok(!clientRaw.includes("TELEMETRY_CONSENT="), "client.env should lose consent");
  assert.ok(!legacyRaw.includes("POSTHOG_HOST="), "legacy host/client.env should lose PostHog host");
  assert.ok(clientRaw.includes("REMOTE_HOST=client-host"), "non-telemetry client config remains");
  assert.ok(legacyRaw.includes("FOLDER_MAPS=/c::/h"), "non-telemetry legacy config remains");
  fs.rmSync(TELEMETRY_ENV, { force: true });
  fs.rmSync(CLIENT_ENV, { force: true });
  fs.rmSync(legacyHostDir, { recursive: true, force: true });
});

console.log("strictScrub — masks IP/path/tailnet:");

check("strictScrub masks each PII fixture", () => {
  const input = Object.values(SECRETS).join(" | ");
  const out = t.strictScrub(input);
  assertNoSecrets(out, "strictScrub");
  assert.ok(out.includes("<ip>"), "expected <ip> token");
  assert.ok(out.includes("<path>"), "expected <path> token");
  assert.ok(out.includes("<host>"), "expected <host> token");
});

check("strictScrubDeep masks nested strings/arrays", () => {
  const tree = {
    msg: `connect ${SECRETS.ipv4} failed at ${SECRETS.otherUser}`,
    frames: [{ filename: SECRETS.varFolders }, { peer: SECRETS.ipv6 }],
    host: SECRETS.tsHost,
  };
  const out = JSON.stringify(t.strictScrubDeep(tree));
  assertNoSecrets(out, "strictScrubDeep");
});

console.log("sentryCapture — simulated Sentry payload is scrubbed:");

check("sentryCapture(consent ON) sends a scrubbed envelope (no PII)", () => {
  // Capture the exact envelope body the transport would have sent.
  let sentBody = "";
  const prev = https.request;
  https.request = function (opts) {
    httpsCalls++;
    return {
      on() {
        return this;
      },
      write(b) {
        sentBody += String(b);
      },
      end() {},
      destroy() {},
    };
  };
  try {
    writeEnv({
      TELEMETRY_ANON_ID: "00000000-0000-4000-8000-000000000000",
      TELEMETRY_INSTALL_TS: "1000",
      CRASH_REPORT_CONSENT: "true",
      SENTRY_DSN: "https://pubkey@o123.ingest.sentry.io/42",
    });
    const before = httpsCalls;
    // An error whose message + stack carry every PII fixture.
    const err = new Error(
      `boom talking to ${SECRETS.tsHost} (${SECRETS.ipv4} / ${SECRETS.ipv6})`,
    );
    err.stack =
      `Error: boom\n` +
      `    at connect (${SECRETS.otherUser}/net.js:10:5)\n` +
      `    at Socket._read (${SECRETS.varFolders}:1:1)\n` +
      `    at ${SECRETS.ipv4}:443\n`;
    t.sentryCapture(err, { peer: SECRETS.ipv6, cwd: SECRETS.otherUser });
    assert.ok(httpsCalls > before, "expected one outbound envelope with consent ON");
    assert.ok(sentBody.length > 0, "expected a non-empty envelope body");
    assertNoSecrets(sentBody, "sentry envelope");
    // The raw stack key must NOT be shipped (we ship path-free structured frames instead).
    assert.ok(!/"stack"\s*:/.test(sentBody), "raw stack key must not be present in extra");
  } finally {
    https.request = prev;
  }
});

console.log("consent OFF — ZERO network:");

check("consent OFF => no https/http requests from capture/sentryCapture", () => {
  writeEnv({
    TELEMETRY_ANON_ID: "00000000-0000-4000-8000-000000000000",
    TELEMETRY_INSTALL_TS: "1000",
    POSTHOG_KEY: "phc_test",
    SENTRY_DSN: "https://pubkey@o123.ingest.sentry.io/42",
    // both consent flags absent/false => opt-in gate closed.
  });
  const beforeHttps = httpsCalls;
  const beforeHttp = httpCalls;
  t.capture(t.EVENTS.HOST_CONNECTED, { path: t.PATHS.LAN, connect_ms: 5 });
  t.capture(t.EVENTS.FIRST_SESSION_STARTED, { time_to_wow_ms: 5 });
  t.sentryCapture(new Error(`leak ${SECRETS.ipv4} ${SECRETS.otherUser}`));
  assert.strictEqual(httpsCalls, beforeHttps, "consent OFF must not call https.request");
  assert.strictEqual(httpCalls, beforeHttp, "consent OFF must not call http.request");
});

console.log("host_connected — once-per-install de-dup:");

check("claimHostConnectedOnce returns true once, then false", () => {
  writeEnv({ TELEMETRY_ANON_ID: "00000000-0000-4000-8000-000000000000" });
  assert.strictEqual(t.claimHostConnectedOnce(), true, "first claim should win");
  assert.strictEqual(t.claimHostConnectedOnce(), false, "second claim should be de-duped");
});

console.log("firstRunStamp — stamps once, independent of consent:");

check("firstRunStamp is idempotent and consent-independent", () => {
  // Fresh env, no consent flags.
  writeEnv({ TELEMETRY_ANON_ID: "00000000-0000-4000-8000-000000000000" });
  const first = t.firstRunStamp();
  assert.strictEqual(first.created, true, "first firstRunStamp should report stamp creation");
  const ts1 = first.ts;
  assert.ok(ts1 > 0, "firstRunStamp should produce a positive epoch");
  const second = t.firstRunStamp();
  assert.strictEqual(second.created, false, "second firstRunStamp should not report creation");
  const ts2 = second.ts;
  assert.strictEqual(ts1, ts2, "second firstRunStamp must not overwrite the base");
  assert.ok(fs.existsSync(TELEMETRY_ENV), "firstRunStamp should create telemetry.env");
  assert.ok(!fs.existsSync(CLIENT_ENV), "firstRunStamp must not create client.env");
});

check("setTelemetryConsent writes only TELEMETRY_CONSENT", () => {
  writeEnv({
    TELEMETRY_ANON_ID: "00000000-0000-4000-8000-000000000000",
    CRASH_REPORT_CONSENT: "true",
  });
  assert.strictEqual(t.setTelemetryConsent(false), false);
  let raw = fs.readFileSync(TELEMETRY_ENV, "utf8");
  assert.ok(raw.includes('TELEMETRY_CONSENT="false"'), "telemetry consent should be updated");
  assert.ok(raw.includes('CRASH_REPORT_CONSENT="true"'), "crash consent should be preserved");
  assert.strictEqual(t.setTelemetryConsent(true), true);
  raw = fs.readFileSync(TELEMETRY_ENV, "utf8");
  assert.ok(raw.includes('TELEMETRY_CONSENT="true"'), "telemetry consent should be re-toggleable");
  assert.ok(raw.includes('CRASH_REPORT_CONSENT="true"'), "crash consent should still be preserved");
});

check("setConsent persists telemetry flags without creating client.env", () => {
  try {
    fs.rmSync(TELEMETRY_ENV, { force: true });
    fs.rmSync(CLIENT_ENV, { force: true });
  } catch (_e) {}
  const consent = t.setConsent(true, false);
  assert.deepStrictEqual(consent, { telemetry: true, crashReport: false });
  const raw = fs.readFileSync(TELEMETRY_ENV, "utf8");
  assert.ok(raw.includes('TELEMETRY_CONSENT="true"'), "telemetry consent should land in telemetry.env");
  assert.ok(raw.includes('CRASH_REPORT_CONSENT="false"'), "crash consent should land in telemetry.env");
  assert.ok(!fs.existsSync(CLIENT_ENV), "setConsent must not create client.env");
});

// --- teardown ---------------------------------------------------------------
https.request = realHttpsRequest;
http.request = realHttpRequest;
try {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
} catch (_e) {
  /* best effort */
}

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nall telemetry tests passed");
