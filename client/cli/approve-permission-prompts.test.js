const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const cli = fs.readFileSync(path.join(root, "xpair"), "utf8");
const router = fs.readFileSync(path.join(root, "../../host/xpair-approve-router.sh"), "utf8");
const skill = fs.readFileSync(path.join(root, "../../host/skills/approve/SKILL.md"), "utf8");

const cmdApprove = cli.slice(
  cli.indexOf("cmd_approve() {"),
  cli.indexOf("# xpair logs", cli.indexOf("cmd_approve() {")),
);

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   - ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message.split("\n")[0]}`);
  }
}

test("approve request waits for permission prompt outcome and branches success/failure (Q0103)", () => {
  assert.notEqual(cmdApprove.length, 0, "cmd_approve must exist in the xpair CLI");

  assert.match(skill, /(permission\/approval|approval\/permission) dialog/);
  assert.match(skill, /xpair approve/);
  assert.match(skill, /exit 0=handled, 1=failed/);

  assert.match(cmdApprove, /: > "\$approve_trigger"/);
  assert.match(cmdApprove, /observing up to \$\{timeout\}s/);
  assert.match(cmdApprove, /while \[ "\$\(date \+%s\)" -lt "\$end" \]/);
  assert.match(cmdApprove, /grep -qiE 'router:\.\*success'/);
  assert.match(cmdApprove, /handled \(window-close verified\)/);
  assert.match(cmdApprove, /not handled within \$\{timeout\}s/);
  assert.match(cmdApprove, /router log/);

  assert.match(router, /WAIT_SECS=/);
  assert.match(router, /GENERIC_LABELS=.*Allow.*Authorize.*Approve.*Confirm.*Continue.*OK/);
  assert.match(router, /HINT_TYPE=/);
  assert.match(router, /act_and_verify\(\)/);
  assert.match(router, /dialog_gone\(\)/);
  assert.ok(
    router.includes("key:*\\|*)"),
    "router must support multiple terminal prompt key choices such as allow/deny candidates",
  );
  assert.match(router, /UNKNOWN\|unknown\)[\s\S]*ocr:\$GENERIC_LABELS/);
});

console.log(failed ? `\n${failed} test(s) failed` : "\napprove permission prompt tests passed");
process.exit(failed ? 1 : 0);
