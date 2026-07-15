const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const launcher = fs.readFileSync(path.join(root, "client/cli/xpair-launch"), "utf8");
const cli = fs.readFileSync(path.join(root, "client/cli/xpair"), "utf8");
const sessions = fs.readFileSync(path.join(root, "host/app/Sessions.swift"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - detached sessions are reused instead of duplicated`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

test("Q0061 launcher preserves detached/orphaned sessions and reattaches instead of creating duplicates", () => {
  assert.match(
    launcher,
    /while pgrep -f "mosh-client\.\*attach -d -t =\$\{base\}_\$\{n\}/,
    "remote numbering must skip only live attached client tabs",
  );
  assert.match(
    launcher,
    /if tm has-session -t "=\\\$SESSION" 2>\/dev\/null; then NEED_CREATE=0; fi[\s\S]*if \[ "\\\$NEED_CREATE" = 1 \]; then[\s\S]*tm new-session -d -x \$\{COLS\} -y \$\{LINES\}[\s\S]*attach -d -t "=\$ACTUAL_SESSION"/,
    "uniform host launch must preserve an existing host session and use attach -d for takeover",
  );
  assert.match(
    launcher,
    /detach-client -s \$\(sh_quote "=\$ACTUAL_SESSION"\)/,
    "remote tab-close cleanup must detach the host session instead of killing it",
  );

  const attachBody = between(cli, "cmd_attach() {", "\n}\n\ncmd_host() {");
  assert.match(attachBody, /has-session -t \$\(sh_quote "=\$session"\)/);
  assert.match(attachBody, /attach -d -t "=\$session"/);
  assert.doesNotMatch(
    attachBody,
    /new-session|tmux new|tm new/,
    "xpair attach must never create a new session when reattaching an existing one",
  );

  assert.match(sessions, /#\{session_attached\}/);
  assert.match(sessions, /if name == "_keeper" \{ continue \}/);
  assert.match(sessions, /static func liveSessionCount\(\) -> Int \{ listReal\(\)\.count \}/);
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
