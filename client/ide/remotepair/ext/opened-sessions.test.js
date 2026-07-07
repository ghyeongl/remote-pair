const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const openedSessionsSource = fs.readFileSync(path.join(__dirname, "opened-sessions.js"), "utf8");

const {
  OPENED_SESSIONS_VERSION,
  OPENED_SESSIONS_BUCKET_HEARTBEAT_MS,
  OPENED_SESSIONS_LOCK_FILE,
  BUCKET_KEY_RE,
  claimOpenedSessionsBucket,
  migrateOpenedSessionsClaim,
  normalizeOpenedSessionNames,
  parseOpenedSessions,
  serializeOpenedSessions,
  touchOpenedSessionsClaim,
  writeOpenedSessionsForBucket,
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
  assert.deepStrictEqual(parseOpenedSessions("{", "host-a", "scope-a"), []);
  assert.deepStrictEqual(parseOpenedSessions(JSON.stringify({ v: 3, host: "host-a", sessions: ["one"] }), "host-a", "scope-a"), []);
  assert.deepStrictEqual(parseOpenedSessions(JSON.stringify({ v: 1, host: "host-b", sessions: ["one"] }), "host-a", "scope-a"), []);
});

test("reads only the requested v2 per-window bucket", () => {
  const raw = JSON.stringify({
    v: 2,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["one", "two", "bad name"], ts: 1000, pid: 11 },
      "scope-a#2": { sessions: ["sibling"], ts: 1000, pid: 14 },
      "scope-a#10": { sessions: ["ten"], ts: 1000, pid: 15 },
      "scope-b": { sessions: ["two", "three"], ts: 1001, pid: 12 },
      "bad/scope": { sessions: ["ignored"], ts: 1002, pid: 13 },
    },
  });
  assert.deepStrictEqual(parseOpenedSessions(raw, "host-a", "scope-a"), ["one", "two"]);
  assert.deepStrictEqual(parseOpenedSessions(raw, "host-a", "scope-a#2"), ["sibling"]);
  assert.deepStrictEqual(parseOpenedSessions(raw, "host-a", "scope-a#10"), ["ten"]);
  assert.deepStrictEqual(parseOpenedSessions(raw, "host-a", "scope-b"), ["two", "three"]);
  assert.deepStrictEqual(parseOpenedSessions(raw, "host-a", "missing"), []);
});

test("bucket keys accept multi-digit sibling suffixes without accepting #1", () => {
  assert.equal(BUCKET_KEY_RE.test("scope-a#10"), true);
  assert.equal(BUCKET_KEY_RE.test("scope-a#123"), true);
  assert.equal(BUCKET_KEY_RE.test("scope-a#1"), false);
  assert.equal(BUCKET_KEY_RE.test("scope-a#01"), false);
});

test("migrates v1 reads while the first scoped write replaces the file with v2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1, host: "host-a", sessions: ["legacy", "two"] }) + "\n");
  assert.deepStrictEqual(readOpenedSessions(file, "host-a", "scope-a"), ["legacy", "two"]);
  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-a", ["one", "two"], { now: 2000, pid: 101, isProcessAlive: () => false }), true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(written, {
    v: 2,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["one", "two"], ts: 2000, pid: 101 },
    },
  });
  assert.deepStrictEqual(readOpenedSessions(file, "host-a", "scope-a"), ["one", "two"]);
  assert.deepStrictEqual(readOpenedSessions(file, "host-b", "scope-a"), []);
});

test("scoped writes merge buckets, update only the caller scope, and prune stale buckets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-a", ["one"], { now: 1000, pid: 101, isProcessAlive: () => false }), true);
  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-b", ["two"], { now: 2000, pid: 102, isProcessAlive: () => false }), true);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a", "scope-a"), ["one"]);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a", "scope-b"), ["two"]);

  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-a", ["three"], { now: 3000, pid: 103, isProcessAlive: () => false }), true);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a", "scope-a"), ["three"]);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a", "scope-b"), ["two"]);

  const oldTs = 3000 - (31 * 24 * 60 * 60 * 1000);
  fs.writeFileSync(file, JSON.stringify({
    v: 2,
    host: "host-a",
    windows: {
      "scope-old": { sessions: ["old"], ts: oldTs, pid: 99 },
      "scope-b": { sessions: ["two"], ts: 3000, pid: 102 },
    },
  }) + "\n");
  assert.equal(writeOpenedSessionsForScope(file, "host-a", "scope-a", ["one"], { now: 3000, pid: 101, isProcessAlive: () => false }), true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(Object.keys(written.windows).sort(), ["scope-a", "scope-b"]);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a", "scope-a"), ["one"]);
  assert.deepStrictEqual(readOpenedSessions(file, "host-a", "scope-b"), ["two"]);
});

test("claim preference order uses exact, then #N, then a fresh sibling bucket", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  fs.writeFileSync(file, JSON.stringify({
    v: OPENED_SESSIONS_VERSION,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["exact"], ts: 1000, pid: 901 },
      "scope-a#2": { sessions: ["two"], ts: 1001, pid: 902 },
    },
  }) + "\n");

  assert.deepStrictEqual(
    claimOpenedSessionsBucket(file, "host-a", "scope-a", { now: 2000, pid: 101, isProcessAlive: () => false }),
    { bucketKey: "scope-a", sessions: ["exact"] },
  );
  assert.deepStrictEqual(
    claimOpenedSessionsBucket(file, "host-a", "scope-a", { now: 3000, pid: 102, isProcessAlive: (pid) => pid === 101 }),
    { bucketKey: "scope-a#2", sessions: ["two"] },
  );
  assert.deepStrictEqual(
    claimOpenedSessionsBucket(file, "host-a", "scope-a", { now: 4000, pid: 103, isProcessAlive: (pid) => pid === 101 || pid === 102 }),
    { bucketKey: "scope-a#3", sessions: [] },
  );

  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(written.windows["scope-a"], { sessions: ["exact"], ts: 2000, pid: 101 });
  assert.deepStrictEqual(written.windows["scope-a#2"], { sessions: ["two"], ts: 3000, pid: 102 });
  assert.deepStrictEqual(written.windows["scope-a#3"], { sessions: [], ts: 4000, pid: 103 });
});

test("stale pid buckets are takeoverable without losing their sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  fs.writeFileSync(file, JSON.stringify({
    v: OPENED_SESSIONS_VERSION,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["old"], ts: 1000, pid: 999999 },
    },
  }) + "\n");

  assert.deepStrictEqual(
    claimOpenedSessionsBucket(file, "host-a", "scope-a", { now: 2000, pid: 101, isProcessAlive: () => false }),
    { bucketKey: "scope-a", sessions: ["old"] },
  );
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(written.windows["scope-a"], { sessions: ["old"], ts: 2000, pid: 101 });
});

test("stale heartbeat buckets are takeoverable even when their pid is alive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  const now = 2000 + OPENED_SESSIONS_BUCKET_HEARTBEAT_MS;
  fs.writeFileSync(file, JSON.stringify({
    v: OPENED_SESSIONS_VERSION,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["old"], ts: now - OPENED_SESSIONS_BUCKET_HEARTBEAT_MS - 1, pid: 777 },
    },
  }) + "\n");

  assert.deepStrictEqual(
    claimOpenedSessionsBucket(file, "host-a", "scope-a", { now, pid: 101, isProcessAlive: (pid) => pid === 777 }),
    { bucketKey: "scope-a", sessions: ["old"] },
  );
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(written.windows["scope-a"], { sessions: ["old"], ts: now, pid: 101 });
});

test("claim preference recognizes multi-digit sibling bucket suffixes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  fs.writeFileSync(file, JSON.stringify({
    v: OPENED_SESSIONS_VERSION,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["exact"], ts: 1000, pid: 901 },
      "scope-a#2": { sessions: ["two"], ts: 1000, pid: 902 },
      "scope-a#10": { sessions: ["ten"], ts: 1000, pid: 910 },
    },
  }) + "\n");

  assert.deepStrictEqual(
    claimOpenedSessionsBucket(file, "host-a", "scope-a", { now: 2000, pid: 101, isProcessAlive: (pid) => pid === 901 || pid === 902 }),
    { bucketKey: "scope-a#10", sessions: ["ten"] },
  );
});

test("claimed bucket writes target only the claimed key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  fs.writeFileSync(file, JSON.stringify({
    v: OPENED_SESSIONS_VERSION,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["one"], ts: 1000, pid: 101 },
      "scope-a#2": { sessions: ["two"], ts: 1001, pid: 102 },
    },
  }) + "\n");

  assert.equal(writeOpenedSessionsForBucket(file, "host-a", "scope-a#2", ["updated"], { now: 2000, pid: 102 }), true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(written.windows["scope-a"], { sessions: ["one"], ts: 1000, pid: 101 });
  assert.deepStrictEqual(written.windows["scope-a#2"], { sessions: ["updated"], ts: 2000, pid: 102 });
});

test("claim heartbeat touch refreshes only this claimed bucket timestamp", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  fs.writeFileSync(file, JSON.stringify({
    v: OPENED_SESSIONS_VERSION,
    host: "host-a",
    windows: {
      "scope-a": { sessions: ["one"], ts: 1000, pid: 101 },
      "scope-a#2": { sessions: ["two"], ts: 1001, pid: 102 },
    },
  }) + "\n");

  assert.equal(touchOpenedSessionsClaim(file, "host-a", "scope-a", { now: 2000, pid: 101 }), true);
  assert.equal(touchOpenedSessionsClaim(file, "host-a", "scope-a#2", { now: 3000, pid: 101 }), false);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(written.windows["scope-a"], { sessions: ["one"], ts: 2000, pid: 101 });
  assert.deepStrictEqual(written.windows["scope-a#2"], { sessions: ["two"], ts: 1001, pid: 102 });
});

test("migration moves this claimed bucket, keeps its pid, and avoids live target collisions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  fs.writeFileSync(file, JSON.stringify({
    v: OPENED_SESSIONS_VERSION,
    host: "host-a",
    windows: {
      "old-scope": { sessions: ["one", "bad name", "two"], ts: 1000, pid: 0 },
      "new-scope": { sessions: ["busy"], ts: 1001, pid: 202 },
      "other-scope": { sessions: ["three"], ts: 1002, pid: 303 },
    },
  }) + "\n");

  assert.deepStrictEqual(
    claimOpenedSessionsBucket(file, "host-a", "old-scope", { now: 2000, pid: 101, isProcessAlive: (pid) => pid === 202 || pid === 303 }),
    { bucketKey: "old-scope", sessions: ["one", "two"] },
  );
  assert.equal(
    migrateOpenedSessionsClaim(file, "host-a", "old-scope", "new-scope", {
      now: 3000,
      pid: 101,
      isProcessAlive: (pid) => pid === 101 || pid === 202 || pid === 303,
    }),
    "new-scope#2",
  );
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.windows["old-scope"], undefined);
  assert.deepStrictEqual(written.windows["new-scope"], { sessions: ["busy"], ts: 1001, pid: 202 });
  assert.deepStrictEqual(written.windows["new-scope#2"], { sessions: ["one", "two"], ts: 2000, pid: 101 });
  assert.deepStrictEqual(written.windows["other-scope"], { sessions: ["three"], ts: 1002, pid: 303 });
});

test("scope migration respects the opened-sessions lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  const before = JSON.stringify({
    v: OPENED_SESSIONS_VERSION,
    host: "host-a",
    windows: {
      "old-scope": { sessions: ["one"], ts: 1000, pid: 11 },
      "other-scope": { sessions: ["two"], ts: 1001, pid: 12 },
    },
  }) + "\n";
  fs.writeFileSync(file, before);
  fs.writeFileSync(path.join(dir, OPENED_SESSIONS_LOCK_FILE), "999999\n");

  assert.equal(
    migrateOpenedSessionsClaim(file, "host-a", "old-scope", "new-scope", {
      now: 2000,
      pid: 11,
      lockWaitMs: 0,
      isProcessAlive: (pid) => pid === 999999,
    }),
    null,
  );
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("stale lock takeover does not unlink a fresh racer lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");
  const lockFile = path.join(dir, OPENED_SESSIONS_LOCK_FILE);
  fs.writeFileSync(lockFile, "901\n");
  let staleOwnerChecked = false;

  assert.equal(
    claimOpenedSessionsBucket(file, "host-a", "scope-a", {
      now: 1000,
      pid: 101,
      lockWaitMs: 0,
      isProcessAlive: (pid) => {
        if (pid === 901) {
          if (!staleOwnerChecked) {
            staleOwnerChecked = true;
            fs.writeFileSync(lockFile, "902\n");
          }
          return false;
        }
        return pid === 902;
      },
    }),
    null,
  );
  assert.equal(fs.readFileSync(lockFile, "utf8"), "902\n");
});

test("two claimers racing the same workspace leave the second in #2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-opened-sessions-"));
  const file = path.join(dir, "opened-sessions.json");

  assert.deepStrictEqual(
    claimOpenedSessionsBucket(file, "host-a", "scope-a", { now: 1000, pid: 101, isProcessAlive: (pid) => pid === 101 }),
    { bucketKey: "scope-a", sessions: [] },
  );
  assert.deepStrictEqual(
    claimOpenedSessionsBucket(file, "host-a", "scope-a", { now: 1100, pid: 102, isProcessAlive: (pid) => pid === 101 || pid === 102 }),
    { bucketKey: "scope-a#2", sessions: [] },
  );
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(written.windows["scope-a"], { sessions: [], ts: 1000, pid: 101 });
  assert.deepStrictEqual(written.windows["scope-a#2"], { sessions: [], ts: 1100, pid: 102 });
});

test("opened-session lock creation writes content before the name is visible", () => {
  assert.match(openedSessionsSource, /fs\.writeFileSync\(tmp, `\$\{pid\}\\n`, \{ mode: 0o600 \}\);[\s\S]*fs\.linkSync\(tmp, lockFile\);/);
  assert.doesNotMatch(openedSessionsSource, /fs\.openSync\(lockFile, "wx"/);
});

test("opened-session restore and writes are owned by per-bucket claims, not the services lock", () => {
  assert.match(extension, /let openedSessionsClaimedBucketKey = null;/);
  assert.match(
    extension,
    /function scheduleOpenedSessionsWrite\(names\) \{[\s\S]*if \(!openedSessionsClaimedBucketKey\) \{[\s\S]*opened sessions: ignored write before snapshot bucket claim/,
  );
  assert.match(
    extension,
    /function flushOpenedSessionsWriteOnDeactivate\(\) \{[\s\S]*if \(!openedSessionsClaimedBucketKey\) return;[\s\S]*writeOpenedSessionsNow\(host, pending\);/,
  );
  assert.doesNotMatch(extension, /setOpenedSessionsWriteOwner/);
  assert.match(extension, /const CLIENT_SERVICES_SCOPE_ID = \(\(\) => \{[\s\S]*return scope;[\s\S]*const CLIENT_SERVICES_LOCK_FILE = \(\(\) => \{[\s\S]*const scope = CLIENT_SERVICES_SCOPE_ID;[\s\S]*extension-services\.\$\{scope\}\.lock/);
  assert.match(extension, /let currentSnapshotScopeId = CLIENT_SERVICES_SCOPE_ID;/);
  assert.match(extension, /writeOpenedSessionsForBucket\(OPENED_SESSIONS_FILE, host, bucketKey, clean, \{ now: Date\.now\(\), pid: process\.pid \}\)/);
  assert.match(extension, /const OPENED_SESSIONS_CLAIM_TOUCH_INTERVAL_MS = 10 \* 60 \* 1000;/);
  assert.match(extension, /function touchOpenedSessionsClaimNow\(\) \{[\s\S]*touchOpenedSessionsClaim\(OPENED_SESSIONS_FILE, host, bucketKey, \{ now: Date\.now\(\), pid: process\.pid \}\)/);
  assert.match(extension, /function startOpenedSessionsClaimHeartbeat\(\) \{[\s\S]*setInterval\(\(\) => \{[\s\S]*touchOpenedSessionsClaimNow\(\);[\s\S]*OPENED_SESSIONS_CLAIM_TOUCH_INTERVAL_MS/);
  assert.match(extension, /function deactivate\(\) \{[\s\S]*stopOpenedSessionsClaimHeartbeat\(\)[\s\S]*flushOpenedSessionsWriteOnDeactivate\(\)/);
  assert.match(extension, /function migrateOpenedSessionsSnapshotScope\(\) \{[\s\S]*const oldBucketKey = openedSessionsClaimedBucketKey;[\s\S]*const nextScope = computeWorkspaceScopeId\(\);[\s\S]*migrateOpenedSessionsClaim\(OPENED_SESSIONS_FILE, host, oldBucketKey, nextScope, \{ now: Date\.now\(\), pid: process\.pid \}\)[\s\S]*openedSessionsClaimedBucketKey = migratedBucketKey;[\s\S]*currentSnapshotScopeId = nextScope;/);
  assert.match(extension, /vscode\.workspace\.onDidChangeWorkspaceFolders\(\(\) => \{[\s\S]*migrateOpenedSessionsSnapshotScope\(\);[\s\S]*\}\)/);
  assert.match(extension, /const claimScope = computeWorkspaceScopeId\(\);[\s\S]*currentSnapshotScopeId = claimScope;[\s\S]*claimOpenedSessionsBucket\(OPENED_SESSIONS_FILE, host, claimScope, \{ log, pid: process\.pid \}\)/);
  assert.match(extension, /if \(list\.sessions\.length === 0\) \{[\s\S]*opened sessions: live session list empty during restore; keeping snapshot[\s\S]*return 0;[\s\S]*sessionListCanSyncSnapshot = true;/);
  assert.match(extension, /openedSessionsClaimedBucketKey = claim \? claim\.bucketKey : null;[\s\S]*const openedNames = claim \? claim\.sessions : \[\];/);
  assert.match(extension, /\/\/ 5a\) Warm the Sessions sidebar in every window[\s\S]*Snapshot restore\/write ownership is claimed per opened-session bucket[\s\S]*return restoreOpenedSessionsOnActivation\(\);/);
  assert.doesNotMatch(extension, /if \(clientServicesLock\) \{\n\s*return restoreOpenedSessionsOnActivation\(\);/);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall opened session snapshot tests passed");
