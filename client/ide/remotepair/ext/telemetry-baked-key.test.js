// telemetry-baked-key.test.js — zero-dep node test (node:assert). Run: `node telemetry-baked-key.test.js`.
//
// Covers seedBakedKeys(): materializes build-baked, publishable POSTHOG_KEY/SENTRY_DSN from a
// bundled file into telemetry.env at activation — seeds when absent, preserves consent, is
// idempotent, and never clobbers an existing value.
//
// HOME is redirected to a throwaway dir BEFORE telemetry.js loads so the test never touches the
// real ~/.xpair/client/telemetry.env (module computes RP_CLIENT_DIR/TELEMETRY_ENV at load time).

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rp-baked-key-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME; // win parity (harmless on posix)
const RP_DIR = path.join(TMP_HOME, ".xpair/client");
const TELEMETRY_ENV = path.join(RP_DIR, "telemetry.env");
fs.mkdirSync(RP_DIR, { recursive: true });

const telemetry = require("./telemetry.js");

const DSN = "https://abc@o1.ingest.sentry.io/1";
const baked = path.join(TMP_HOME, "telemetry.build.env");
fs.writeFileSync(baked, `POSTHOG_KEY="phc_test"\nSENTRY_DSN="${DSN}"\n`);

const read = () => fs.readFileSync(TELEMETRY_ENV, "utf8");
const count = (re) => (read().match(re) || []).length;

// (a) seeds when absent; leaves consent untouched
fs.writeFileSync(TELEMETRY_ENV, 'TELEMETRY_CONSENT="1"\n');
telemetry.seedBakedKeys(baked);
assert.match(read(), /POSTHOG_KEY="?phc_test"?/, "POSTHOG_KEY seeded");
assert.ok(read().includes(DSN), "SENTRY_DSN seeded");
assert.match(read(), /TELEMETRY_CONSENT="?1"?/, "consent line preserved");

// (b) idempotent — no duplicate POSTHOG_KEY line
telemetry.seedBakedKeys(baked);
assert.strictEqual(count(/^\s*POSTHOG_KEY=/gm), 1, "POSTHOG_KEY not duplicated");

// (c) never clobbers an existing value
fs.writeFileSync(TELEMETRY_ENV, 'POSTHOG_KEY="existing"\n');
telemetry.seedBakedKeys(baked);
assert.match(read(), /POSTHOG_KEY="?existing"?/, "existing POSTHOG_KEY not overwritten");
assert.ok(!read().includes("phc_test"), "baked key did not clobber existing");

console.log("PASS telemetry-baked-key");
