const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const mountCli = fs.readFileSync(path.join(__dirname, "../../../cli/xpair-mount"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

// Regression: an idempotent re-mount (already mounted) must still emit the `Mountpoint:`
// line that onboarding-bridge.mount() parses. Without it the bridge sees code 0 + empty
// mountpoint and reports a false mount failure, blocking add-mapping retries.
test("already-mounted branch emits the Mountpoint line before returning", () => {
  const start = mountCli.indexOf("if is_mounted");
  assert.notStrictEqual(start, -1, "already-mounted guard must exist");
  const ret = mountCli.indexOf("return 0", start);
  assert.notStrictEqual(ret, -1, "guard must return 0");
  const branch = mountCli.slice(start, ret);
  assert.match(branch, /printf '  Mountpoint: %s\\n' "\$mountpoint"/,
    "already-mounted branch must print the Mountpoint: line before return 0");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
