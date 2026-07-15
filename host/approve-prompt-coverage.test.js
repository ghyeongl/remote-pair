const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const router = fs.readFileSync(path.join(root, "host/xpair-approve-router.sh"), "utf8");
const rules = fs.readFileSync(path.join(root, "host/rules.txt"), "utf8");
const cli = fs.readFileSync(path.join(root, "client/cli/xpair"), "utf8");
const launcher = fs.readFileSync(path.join(root, "client/cli/xpair-launch"), "utf8");
const hook = fs.readFileSync(path.join(root, "host/hooks/approve-reminder.sh"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - approve routing covers product prompt families`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("Q0103/Q0104/Q0114/Q0129/Q0142 approve handling accounts for permission, Claude Code, Chrome, and 1Password prompts", () => {
  assert.match(
    cli,
    /cmd_approve\(\)[\s\S]*--for\|--label\|--expect[\s\S]*--type[\s\S]*approve_trigger\.label[\s\S]*approve_trigger\.type[\s\S]*handled \(window-close verified\)/,
    "xpair approve must carry prompt identity/method through the product CLI and report verified handling",
  );

  assert.match(
    router,
    /\*chrome\*\) HINT="Claude for Chrome"/,
    "router must normalize Chrome/site-level approval hints",
  );
  assert.match(
    router,
    /\*1password\*\|\*"1 password"\*\) HINT="1Password"/,
    "router must normalize 1Password approval hints",
  );
  assert.match(
    router,
    /GENERIC_LABELS=.*Allow.*Authorize.*Approve.*Confirm.*Continue.*OK/,
    "router must have generic labels for macOS permission/authorization prompts",
  );
  assert.match(
    router,
    /tell application \\"System Events\\" to key code/,
    "keyboard approval must use System Events for cases where OCR/mouse is insufficient",
  );

  assert.match(
    rules,
    /^1Password\tAccess Requested\tocr:.*Authorize.*Authorize Once.*Allow.*Approve.*Confirm/m,
    "rules must include a 1Password authorization path",
  );
  assert.match(
    rules,
    /^Claude for Chrome\tNew permissions required\tkey:cmd\+return\|return/m,
    "rules must include the Chrome permission block cmd+enter/enter path",
  );

  assert.match(
    hook,
    /Claude-for-Chrome permission modal, 1Password approval\/unlock,\s*\n#\s+macOS system permission prompts/,
    "approve hook must classify permission, Chrome, and 1Password prompt denials as approve candidates",
  );
  assert.match(
    launcher,
    /claude[\s\S]*--dangerously-skip-permissions[\s\S]*--remote-control/,
    "Claude Code terminal permission prompts must be accounted for by the launch path",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
