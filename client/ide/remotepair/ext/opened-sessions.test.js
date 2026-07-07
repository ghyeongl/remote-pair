const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");

const {
  OPENED_SESSIONS_VERSION,
  normalizeOpenedSessionNames,
  parseOpenedSessions,
  serializeOpenedSessions,
  writeOpenedSessionsForScope,
  readOpenedSessions,
} = require("./opened-sessions.js");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}\n        ${error && error.message ? error.message : error}`);
  }
}

test("serializes a v2 scoped host snapshot with validated unique session names", () => {
  assert.deepStrictEqual(
    serializeOpenedSessions("host-a", "scope-a", ["one", "bad name", "two", "one", "bad;cmd", "third.ok"], { now: 1234, pid: 42 }),
    { v: OPENED_SESSIONS_VERSION, host: "host-a", windows: { "scope-a": { sessions: ["one", "two", "third.ok"], ts: 1234, pid: 42 } } },
  );
  assert.deepStrictEqual(normalizeOpenedSessionNames([" a ", "b_2", "", "bad/name"]), ["a", "b_2"]);
});

test("skips corrupt, wrong-version, and host-mismatched snapshots", () => {
  assert.deepStrictEqual(parseOpenedSessions("{", "host-a"), []);
  assert.deepStrictEqual(parseOpenedSessions(JSON.stringify({ v: 3, host: "host-a", sessions: ["one"] }), "host-a"), []);
  assert.deepStrictEqual(parseOpenedSessions(JSON.stringify({ v: 1, host: "host-b", sessions: ["one"] }), "host-a"), []);
});

test("reads v2 snapshots as a deduped union of validated per-window buckets", () => {
  const raw = JSON.stringify({
    v: 2,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["one", "two", "bad name"], ts: 1000, pid: 11 },
      "scope-b": { sessions: ["two", "three"], ts: 1001, pid: 12 },
      "bad/scope": { sessions: ["ignored"], ts: 1002, pid: 13 },
    },
  });
  assert.deepStrictEqual(parseOpenedSessions(raw, "host-a"), ["one", "two", "three"]);
});

test("migrates v1 reads while the first scoped write replaces the file with v2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1, host: "host-a", sessions: ["legacy", "two"] }) + "\n");
  assert.deepStrictEqual(readOpenedSessions(file, "host-a"), ["legacy", "two"]);
  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-a", ["one", "two"], { now: 2000, pid: 101 }), true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(written, {
    v: 2,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["one", "two"], ts: 2000, pid: 101 },
    },
  });
  assert.deepStrictEqual(readOpenedSessions(file, "host-a"), ["one", "two"]);
  assert.deepStrictEqual(readOpenedSessions(file, "host-b"), []);
});

test("scoped writes merge buckets, update only the caller scope, and prune stale buckets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-a", ["one"], { now: 1000, pid: 101 }), true);
  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-b", ["two"], { now: 2000, pid: 102 }), true);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a"), ["one", "two"]);

  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-a", ["three"], { now: 3000, pid: 103 }), true);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a"), ["three", "two"]);

  const oldTs = 3000 - (31 * 24 * 60 * 60 * 1000);
  fs.writeFileSync(file, JSON.stringify({
    v: 2,
    host: "host-a",
    windows: {
      "scope-old": { sessions: ["old"], ts: oldTs, pid: 99 },
      "scope-b": { sessions: ["two"], ts: 3000, pid: 102 },
    },
  }) + "\n");
  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-a", ["one"], { now: 3000, pid: 101 }), true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(Object.keys(written.windows).sort(), ["scope-a", "scope-b"]);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a"), ["two", "one"]);
});

test("opened-session writes are gated to the services lock owner", () => {
  assert.match(extension, /let openedSessionsWriteOwner = false;/);
  assert.match(
    extension,
    /function scheduleOpenedSessionsWrite\(names\) \{[\s\S]*if \(!openedSessionsWriteOwner\) \{[\s\S]*opened sessions: ignored write from non-owner extension host/,
  );
  assert.match(
    extension,
    /function flushOpenedSessionsWriteOnDeactivate\(\) \{[\s\S]*if \(!openedSessionsWriteOwner\) return;[\s\S]*writeOpenedSessionsNow\(host, pending\);/,
  );
  assert.match(extension, /setOpenedSessionsWriteOwner\(\!!clientServicesLock\);/);
  assert.match(extension, /const CLIENT_SERVICES_SCOPE_ID = \(\(\) => \{[\s\S]*return scope;[\s\S]*const CLIENT_SERVICES_LOCK_FILE = \(\(\) => \{[\s\S]*const scope = CLIENT_SERVICES_SCOPE_ID;[\s\S]*extension-services\.\$\{scope\}\.lock/);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall opened session snapshot tests passed");
