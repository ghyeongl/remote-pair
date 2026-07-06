const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-q0473-"));
const oldHome = process.env.HOME;
const oldUserProfile = process.env.USERPROFILE;
const oldForce = process.env.RP_FORCE_ONBOARDING;

process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.RP_FORCE_ONBOARDING;

const clientDir = path.join(tmpHome, ".xpair", "client");
fs.mkdirSync(clientDir, { recursive: true });
fs.writeFileSync(path.join(clientDir, "client.env"), "REMOTE_HOST=configured-host\n");

const onboardingMain = require("./onboarding-main.cjs");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push(async () => {
    try {
      await fn();
      console.log(`  ok  - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL - ${name}`);
      console.error(`         ${error && error.message ? error.message.split("\n")[0] : error}`);
    }
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

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

const greenBridge = {
  cliReady: async () => ({ ready: true, bin: "/tmp/xpair", err: "" }),
  sshReachable: async () => ({ reachable: true, err: "" }),
  hostAppStatus: async () => ({ installed: true, version: "0.5.0a99", compatible: true, incompatibleKind: "", err: "" }),
  hostPermissions: async () => ({ alive: true, ax: true, sr: true, fda: false, err: "" }),
  hostEnvEngine: async () => ({ engine: "codex", err: "" }),
  hostEngineStatus: async () => ({ installed: true, authed: true, version: "ok", err: "" }),
};

test("Q0473 Settings Configure can reopen first-run onboarding without ending sessions", async () => {
  assert.equal(onboardingMain.isOnboarded(), true, "fixture must represent an already configured user");
  assert.equal(
    await onboardingMain.firstFailingGuard(["Xpair"], greenBridge),
    null,
    "configured users should normally skip onboarding when guards pass",
  );

  fs.writeFileSync(path.join(clientDir, ".force-onboarding"), "");
  assert.equal(
    await onboardingMain.firstFailingGuard(["Xpair"], greenBridge),
    "welcome",
    "force-onboarding sentinel must reopen onboarding even when REMOTE_HOST is configured",
  );

  const rerunCommand = pkg.contributes.commands.find((entry) => entry.command === "remotepair.runSetup");
  assert.ok(rerunCommand, "package.json must expose the re-run setup command");
  assert.equal(rerunCommand.title, "Xpair: Re-run setup");
  assert.match(extension, /registerCommand\("remotepair\.runSetup", \(\) => runSetup\(\)\)/);
  assert.match(extension, /registerCommand\("remotepair\.endSessionReonboard", \(\) => endSessionReonboard\(\)\)/);

  const runSetup = functionBody(extension, "runSetup");
  const endSessionReonboard = functionBody(extension, "endSessionReonboard");
  assert.match(runSetup, /\.force-onboarding/);
  assert.match(runSetup, /workbench\.action\.quit/);
  assert.match(endSessionReonboard, /Your sessions stay attached/);
  assert.match(endSessionReonboard, /\.force-onboarding/);
  assert.match(endSessionReonboard, /workbench\.action\.quit/);

  const executableBodies = stripComments(`${runSetup}\n${endSessionReonboard}`);
  assert.doesNotMatch(
    executableBodies,
    /\b(runXpairCli|spawn|execFile|kill|killSession|tmux|detach)\b/,
    "reopening onboarding must only schedule the sentinel/restart path, not tear down host sessions",
  );
});

(async () => {
  for (const entry of tests) await entry();

  process.env.HOME = oldHome;
  process.env.USERPROFILE = oldUserProfile;
  if (oldForce === undefined) {
    delete process.env.RP_FORCE_ONBOARDING;
  } else {
    process.env.RP_FORCE_ONBOARDING = oldForce;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }

  console.log("\nall Q0473 reopen onboarding tests passed");
})();
