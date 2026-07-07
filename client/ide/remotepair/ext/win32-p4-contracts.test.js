const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = __dirname;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-win32-p4-"));
const oldHome = process.env.HOME;
const oldUserProfile = process.env.USERPROFILE;
const oldRemoteHost = process.env.REMOTE_HOST;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.REMOTE_HOST = "alice@office-mac.local";
fs.mkdirSync(path.join(tmpHome, ".xpair", "client"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, ".xpair", "client", "client.env"),
  "REMOTE_HOST=alice@office-mac.local\n",
);

const bridge = require("./onboarding-bridge.js");
const extensionSource = fs.readFileSync(path.join(root, "extension.js"), "utf8");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (original) Object.defineProperty(process, "platform", original);
    });
}

function withPatched(object, key, value, fn) {
  const original = object[key];
  object[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      object[key] = original;
    });
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("P4 bridge defaultMountpoint returns UNC root on win32", async () => {
  await withPlatform("win32", () => {
    assert.equal(
      bridge.defaultMountpoint("/Users/alice/Projects/foo"),
      "//office-mac.local/foo",
    );
  });
});

test("P4 bridge mount on win32 does not invoke the CLI mount verb", async () => {
  await withPlatform("win32", async () => {
    await withPatched(childProcess, "spawn", () => {
      throw new Error("win32 bridge mount must not spawn xpair mount");
    }, async () => {
      await withPatched(fs, "existsSync", (candidate) => candidate === "//office-mac.local/foo", async () => {
        assert.deepEqual(await bridge.mount("/Users/alice/Projects/foo"), {
          code: 0,
          out: "Mountpoint: //office-mac.local/foo",
          err: "",
          mountpoint: "//office-mac.local/foo",
        });
      });
    });
  });
});

test("P4 bridge mount on win32 reports net use guidance when UNC is unreachable", async () => {
  await withPlatform("win32", async () => {
    await withPatched(fs, "existsSync", () => false, async () => {
      const result = await bridge.mount("/Users/alice/Projects/foo");
      assert.equal(result.code, 1);
      assert.equal(result.mountpoint, "//office-mac.local/foo");
      assert.match(result.err, /UNC path unreachable: \/\/office-mac\.local\/foo/);
      assert.match(result.err, /net use \\\\office-mac\.local\\foo \/persistent:yes/);
    });
  });
});

test("P4 extension addRoot has a win32 UNC branch before the darwin mount branch", () => {
  const addRoot = functionBody(extensionSource, "addRoot");
  const winStart = addRoot.indexOf('if (process.platform === "win32")');
  const darwinMount = addRoot.indexOf('const mres = await runXpairCli(["mount", "mount", host]', winStart);
  assert.ok(winStart >= 0, "addRoot must branch for win32");
  assert.ok(darwinMount > winStart, "darwin mount branch must remain after the win32 branch");

  const winBlock = addRoot.slice(winStart, darwinMount);
  assert.match(winBlock, /onboardingBridge\.defaultMountpoint\(host\)/);
  assert.match(winBlock, /runXpairCli\(\["map", "add", uncRoot, host, "--method", "mount"\]/);
  assert.match(winBlock, /winMap\.stderr \|\| winMap\.stdout/);
  assert.match(winBlock, /fs\.existsSync\(mappedRoot\)/);
  assert.doesNotMatch(winBlock, /\["mount", "mount", host\]/);
});

(async () => {
  try {
    for (const entry of tests) {
      try {
        await entry.fn();
        passed += 1;
        console.log(`PASS ${entry.name}`);
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${entry.name} - ${error && error.message ? error.message.split("\n")[0] : error}`);
      }
    }
    console.log(`REDGREEN ${passed} ${failed}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldUserProfile;
    if (oldRemoteHost === undefined) delete process.env.REMOTE_HOST;
    else process.env.REMOTE_HOST = oldRemoteHost;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();
