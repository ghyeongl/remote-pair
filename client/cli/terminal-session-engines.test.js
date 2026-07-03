const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const launcher = fs.readFileSync(path.join(root, "client/cli/xpair-launch"), "utf8");
const cli = fs.readFileSync(path.join(root, "client/cli/xpair"), "utf8");
// Engine selection moved to host-owned setup; the client no longer has a StepEngine picker. The
// supported session engines are now verified via the launcher, the xpair CLI, and the onboarding bridge.
const bridge = fs.readFileSync(path.join(root, "client/ide/remotepair/ext/onboarding-bridge.js"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - terminal/session creation exposes every required session kind`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

function assertEngine(id, label, sourceBundle) {
  assert.match(sourceBundle.launcher, new RegExp(`${id.replace("-", "[-]?")}`), `${id} must be handled by xpair-launch`);
  assert.match(sourceBundle.cli, new RegExp(`${id.replace("-", "[-]?")}`), `${id} must be accepted by xpair CLI config/launch`);
  assert.match(sourceBundle.bridge, new RegExp(`${id.replace("-", "[-]?")}`), `${id} must be validated by the onboarding bridge`);
}

test("Q0540 terminal/session creation supports Claude, Shell, Codex, and explicitly supported agents", () => {
  const sources = {
    launcher,
    cli,
    bridge,
  };

  assertEngine("claude", "Claude", sources);
  assertEngine("codex", "Codex", sources);
  assertEngine("opencode", "opencode|OpenCode", sources);
  assertEngine("shell", "Shell", sources);

  assert.match(launcher, /respawn_body_claude\(\)/);
  assert.match(launcher, /respawn_body_codex\(\)/);
  assert.match(launcher, /respawn_body_opencode\(\)/);
  assert.match(
    launcher,
    /respawn_body_shell\(\)|SHELL_SESSION|plain shell|login shell session/i,
    "Shell must be a first-class session creation path, not just the shell used to run an agent",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
