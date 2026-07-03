const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-mountpoint-"));
const oldHome = process.env.HOME;
const oldUserProfile = process.env.USERPROFILE;

process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
fs.mkdirSync(path.join(tmpHome, ".xpair", "client"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, ".xpair", "client", "client.env"),
  "REMOTE_HOST=user@office-mac.local\n",
);

const bridge = require("./onboarding-bridge.js");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message.split("\n")[0]}`);
  }
}

test("onboarding bridge defaultMountpoint uses sanitized full host path", () => {
  assert.equal(
    bridge.defaultMountpoint("/Users/alice/Projects/foo"),
    "/Volumes/user_office-mac.local/Users_alice_Projects_foo",
  );
  assert.equal(
    bridge.defaultMountpoint("/tmp/foo"),
    "/Volumes/user_office-mac.local/tmp_foo",
  );
});

process.env.HOME = oldHome;
process.env.USERPROFILE = oldUserProfile;
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(failed ? `\n${failed} test(s) failed` : "\nmountpoint scheme tests passed");
process.exit(failed ? 1 : 0);
