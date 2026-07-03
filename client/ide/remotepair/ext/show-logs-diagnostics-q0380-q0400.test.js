const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const cli = fs.readFileSync(path.join(root, "../../../cli/xpair"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error && error.message ? error.message.split("\n")[0] : error}`);
  }
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

test("Q0380/Q0400 Show Logs reveals logs and collects a readable diagnostic bundle", () => {
  const command = pkg.contributes.commands.find((entry) => entry.command === "remotepair.showLogs");
  assert.ok(command, "package.json must expose the Show Logs command");
  assert.equal(command.title, "Xpair: Show Logs");
  assert.match(extension, /registerCommand\("remotepair\.showLogs"/);

  const showLogs = functionBody(extension, "showLogs");
  assert.match(showLogs, /fs\.mkdirSync\(LOG_DIR, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(showLogs, /executeCommand\("revealFileInOS", dirUri\)/);
  assert.match(showLogs, /openExternal\(dirUri\)/, "Show Logs must fall back to opening the log folder");
  assert.match(showLogs, /Collect logs \(\-\-collect\)/);
  assert.match(showLogs, /Xpair logs are in ~\/\.xpair\/client\/logs/);
  assert.match(showLogs, /bug report/);
  assert.match(showLogs, /createTerminal\("Xpair . Collect Logs"\)/);
  assert.match(showLogs, /sendText\("xpair logs --collect", true\)/);

  assert.match(cli, /out="\$\{RP_CLIENT_DIR\}\/logs\/xpair-logs-\$\{stamp\}\.tgz"/);
  assert.match(cli, /tar -czf "\$out"/);
  assert.match(cli, /printf '%s\\n' "\$out"/, "collect must print the generated bundle path");
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall Q0380/Q0400 show logs diagnostics tests passed");
