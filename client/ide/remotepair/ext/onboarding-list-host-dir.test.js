const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "rp-list-host-dir-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const realSpawn = cp.spawn;
const realExecFileSync = cp.execFileSync;
const calls = [];
const responses = [];

cp.execFileSync = function fakeExecFileSync(cmd, args) {
  if (cmd === "ssh" && Array.isArray(args) && args[0] === "-G") {
    return "hostname host.example\nport 22\n";
  }
  return realExecFileSync.apply(this, arguments);
};

cp.spawn = function fakeSpawn(cmd, args, opts) {
  calls.push({ cmd, args, opts });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    const next = responses.shift() || { code: 0, out: "" };
    if (next.out) child.stdout.emit("data", Buffer.from(next.out));
    if (next.err) child.stderr.emit("data", Buffer.from(next.err));
    child.emit("close", next.code);
  });
  return child;
};

const bridge = require("./onboarding-bridge.js");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function reset(response) {
  calls.length = 0;
  responses.length = 0;
  responses.push(response);
}

function lastRemoteCommand() {
  assert.equal(calls.length, 1, "listHostDir should make one ssh invocation");
  assert.equal(calls[0].cmd, "ssh");
  assert.equal(calls[0].args.at(-2), "host1");
  return calls[0].args.at(-1);
}

(async () => {
  await test("success parses pwd plus find output into sorted absolute entries", async () => {
    reset({ code: 0, out: "/Users/min\n./zeta\n./Space Dir\n./Documents\n./내 폴더\n" });
    const result = await bridge.listHostDir("host1", "/Users/min");
    assert.deepEqual(result, {
      ok: true,
      base: "/Users/min",
      entries: [
        { name: "Documents", path: "/Users/min/Documents" },
        { name: "Space Dir", path: "/Users/min/Space Dir" },
        { name: "zeta", path: "/Users/min/zeta" },
        { name: "내 폴더", path: "/Users/min/내 폴더" },
      ],
      err: "",
    });
    assert.match(lastRemoteCommand(), /^cd '\/Users\/min' 2>\/dev\/null && pwd && find \. /);
  });

  await test("quotes spaces and Hangul inside one remote command argv", async () => {
    reset({ code: 0, out: "/Users/min/내 폴더/Child Space\n" });
    const result = await bridge.listHostDir("host1", "/Users/min/내 폴더/Child Space");
    assert.equal(result.ok, true);
    assert.equal(
      lastRemoteCommand(),
      "cd '/Users/min/내 폴더/Child Space' 2>/dev/null && pwd && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print",
    );
  });

  await test("preserves leading tilde unquoted for remote shell expansion", async () => {
    reset({ code: 0, out: "/Users/min/내 폴더\n" });
    const result = await bridge.listHostDir("host1", "~/내 폴더");
    assert.equal(result.ok, true);
    assert.equal(
      lastRemoteCommand(),
      "cd ~/'내 폴더' 2>/dev/null && pwd && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print",
    );
  });

  await test("ssh failure maps through sshResult with state and action", async () => {
    reset({ code: 255, err: "Permission denied (publickey).\n" });
    const result = await bridge.listHostDir("host1", "/Users/min");
    assert.equal(result.ok, false);
    assert.equal(result.base, "");
    assert.deepEqual(result.entries, []);
    assert.equal(result.state, "key_auth_blocked");
    assert.equal(result.action, "approve_or_retry");
    assert.match(result.err, /SSH key auth blocked/);
  });

  await test("empty directory returns ok with no entries", async () => {
    reset({ code: 0, out: "/Users/min\n" });
    const result = await bridge.listHostDir("host1", "/Users/min");
    assert.deepEqual(result, {
      ok: true,
      base: "/Users/min",
      entries: [],
      err: "",
    });
  });
})()
  .catch((error) => {
    failed += 1;
    console.error(error && error.stack ? error.stack : error);
  })
  .finally(() => {
    cp.spawn = realSpawn;
    cp.execFileSync = realExecFileSync;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`REDGREEN ${passed} ${failed}`);
    process.exit(failed ? 1 : 0);
  });
