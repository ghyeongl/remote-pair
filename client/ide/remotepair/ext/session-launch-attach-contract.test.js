const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const sessionList = fs.readFileSync(path.join(root, "session-list.js"), "utf8");
const frontendPatch = fs.readFileSync(path.join(root, "../patches/zz-remotepair-ide-frontend.patch"), "utf8");
const xpair = fs.readFileSync(path.join(root, "../../../cli/xpair"), "utf8");
const launcher = fs.readFileSync(path.join(root, "../../../cli/xpair-launch"), "utf8");
const launcherExecutable = launcher
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message.split("\n")[0]}`);
  }
}

test("client launches and reattaches persistent host sessions by stable IDs, not local path text (Q0056 Q0153 Q0154)", () => {
  assert.match(extension, /vscode\.window\.createTerminal\("Xpair — Launch Claude"\)/);
  assert.match(extension, /term\.show\(true\)/);
  assert.match(extension, /term\.sendText\("xpair launch", false\)/);

  assert.match(sessionList, /runXpairCli\(\["ls", "--json"\]/);
  assert.match(sessionList, /const SESSION_NAME_RE = \/\^\[A-Za-z0-9_\.-\]\+\$\//);
  assert.match(sessionList, /sessions\.push\(\{ name, attached: normalizeAttached\(raw\.attached\) \}\)/);

  assert.match(frontendPatch, /export const REMOTEPAIR_SESSIONS_ATTACHED_ID = 'remotepair\.sessions\.attached'/);
  assert.match(frontendPatch, /export const REMOTEPAIR_SESSIONS_DETACHED_ID = 'remotepair\.sessions\.detached'/);
  assert.match(frontendPatch, /export const REMOTEPAIR_SESSIONS_HISTORY_ID = 'remotepair\.sessions\.history'/);
  assert.match(frontendPatch, /setSessionReattacher\(\(name\) => this\.launchReattach\(name\)\)/);
  assert.match(frontendPatch, /instance\.sendText\('xpair attach ' \+ shellSingleQuote\(name\), true\)/);
  assert.match(frontendPatch, /v\.group\.openEditor\(v\.input, \{ pinned: true \}\)/);

  assert.match(xpair, /case "\$session" in \*\[!A-Za-z0-9_\.-\]\*\|''\) echo "invalid session name:/);
  // Attach runs mosh non-exec (trapped) so an orphaned client is detached server-side on close (Q-attach-close).
  // --client pins our bundled static mosh-client (brew-free) regardless of PATH; --server is the remote host side.
  assert.match(xpair, /mosh --client="\$\{MOSH_CLIENT:-\$HOME\/\.local\/bin\/mosh-client\}" --server="\$\{MOSH_SERVER:-\$HOME\/\.local\/bin\/mosh-server\}"/);
  assert.match(xpair, /attach -d -t "=\$session"/);

  assert.match(launcher, /Session name base = <readable-name>-<full-path-hash5>/);
  assert.match(launcher, /printf '%s_%s' "\$name" "\$\(printf '%s' "\$dir" \| shasum -a 256 \| cut -c1-5\)"/);
  assert.match(launcher, /We NEVER use `claude --continue`/);
  assert.doesNotMatch(launcherExecutable, /\bclaude\s+--continue\b/);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall session launch/attach contract tests passed");
