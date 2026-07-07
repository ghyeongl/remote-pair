const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");

const {
  normalizeOpenedSessionNames,
  parseOpenedSessions,
  serializeOpenedSessions,
  writeOpenedSessionsAtomic,
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

test("serializes the v1 host snapshot with validated unique session names", () => {
  assert.deepStrictEqual(
    serializeOpenedSessions("host-a", ["one", "bad name", "two", "one", "bad;cmd", "third.ok"]),
    { v: 1, host: "host-a", sessions: ["one", "two", "third.ok"] },
  );
  assert.deepStrictEqual(normalizeOpenedSessionNames([" a ", "b_2", "", "bad/name"]), ["a", "b_2"]);
});

test("skips corrupt, wrong-version, and host-mismatched snapshots", () => {
  assert.deepStrictEqual(parseOpenedSessions("{", "host-a"), []);
  assert.deepStrictEqual(parseOpenedSessions(JSON.stringify({ v: 2, host: "host-a", sessions: ["one"] }), "host-a"), []);
  assert.deepStrictEqual(parseOpenedSessions(JSON.stringify({ v: 1, host: "host-b", sessions: ["one"] }), "host-a"), []);
});

test("round-trips the atomic file format", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  const snapshot = serializeOpenedSessions("host-a", ["one", "two"]);
  assert.equal(writeOpenedSessionsAtomic(file, snapshot), true);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a"), ["one", "two"]);
  assert.deepStrictEqual(readOpenedSessions(file, "host-b"), []);
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
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall opened session snapshot tests passed");
