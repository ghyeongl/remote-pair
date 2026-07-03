const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const cli = fs.readFileSync(path.join(root, "../../../cli/xpair"), "utf8");

const showLogs = extension.slice(
  extension.indexOf("// --- show logs"),
  extension.indexOf("// --- activation", extension.indexOf("// --- show logs")),
);
const cmdLogs = cli.slice(
  cli.indexOf("# xpair logs"),
  cli.indexOf("# Self-update", cli.indexOf("# xpair logs")),
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

test("users can reveal logs and collect a readable diagnostic bundle (Q0380)", () => {
  assert.notEqual(showLogs.length, 0, "showLogs implementation must exist in the IDE extension");
  assert.notEqual(cmdLogs.length, 0, "cmd_logs implementation must exist in the xpair CLI");

  assert.match(showLogs, /fs\.mkdirSync\(LOG_DIR, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(showLogs, /executeCommand\("revealFileInOS", dirUri\)/);
  assert.match(showLogs, /openExternal\(dirUri\)/);
  assert.ok(showLogs.includes('const COLLECT = "Collect logs (--collect)"'));
  assert.match(showLogs, /showInformationMessage\([\s\S]*Collect them into a tarball/);
  assert.match(showLogs, /createTerminal\("Xpair . Collect Logs"\)/);
  assert.match(showLogs, /term\.sendText\("xpair logs --collect", true\)/);

  assert.match(cmdLogs, /--collect\)\s+collect=1/);
  assert.ok(cmdLogs.includes('out="${RP_CLIENT_DIR}/logs/xpair-logs-${stamp}.tgz"'));
  assert.match(cmdLogs, /local_log_dirs\(\)/);
  assert.match(cmdLogs, /tar -czf "\$out" -C "\$HOME\/\.xpair"/);
  assert.match(cmdLogs, /printf '%s\\n' "\$out"/);
});

console.log(failed ? `\n${failed} test(s) failed` : "\nlog collection tests passed");
process.exit(failed ? 1 : 0);
