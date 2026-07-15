const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const testFile = path.relative(process.cwd(), __filename);
const launcher = fs.readFileSync(path.join(__dirname, "xpair-launch"), "utf8");
const nonCommentLauncher = launcher
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - intended behavior is asserted`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error && error.message ? error.message.split("\n")[0] : error}`);
  }
}

test("Q0546 remote relaunch reattaches existing tmux sessions instead of creating fresh tabs", () => {
  assert.match(launcher, /RCONT=1/);
  assert.match(launcher, /\[ "\$RN" -gt 1 \] && RCONT=0/);
  assert.match(launcher, /\[ "\$FRESH" = 1 \] && RCONT=0/);
  assert.ok(
    launcher.includes('if tm has-session -t "=\\$SESSION" 2>/dev/null; then NEED_CREATE=0; fi'),
    "remote setup must detect existing sessions before creating one",
  );
  assert.match(launcher, /if \[ "\\\$NEED_CREATE" = 1 \]; then[\s\S]*tm new-session -d/);
  assert.match(launcher, /mosh --ssh="ssh \$SSH_ID" --server="\$MOSH_SERVER" "\$REMOTE_HOST" -- "\$REMOTE_HOME\/\.local\/bin\/tmux-aqua" -S "\$AQUA_SOCK" attach -d -t "=\$ACTUAL_SESSION"/);
});

test("Q0546 claude sessions resume the exact recorded conversation id when continuing", () => {
  assert.match(launcher, /_LSD="\$HOME\/\.claude\/\.git\/last-session"/);
  assert.match(launcher, /_K="\$\(printf '%s' "\$PWD" \| shasum -a 256 \| cut -c1-16\)"/);
  assert.match(launcher, /\[ "\$\{CL_CONTINUE:-0\}" = 1 \] && \[ -f "\$_LSD\/\$_K" \] && RESUME_SID="\$\(cat "\$_LSD\/\$_K"/);
  assert.match(launcher, /claude --dangerously-skip-permissions --resume "\$RESUME_SID" --remote-control "\$RC"/);
  assert.doesNotMatch(nonCommentLauncher, /\bclaude\b[^\n]*--continue/);
});

test("Q0546 launch injects CL_CONTINUE into newly created sessions so context is restored", () => {
  assert.match(launcher, /CONT=\$\{RCONT\}/);
  assert.match(launcher, /printf "export CL_CONTINUE=%s\\n" "\\\$CONT"/);
  assert.match(launcher, /SESSION=\$\{REMOTE_PROJ_Q\}/);
  assert.match(launcher, /ACTUAL_SESSION="\$\(printf '%s\\n' "\$SSH_OUT" \| grep '\^__SESSION__:' \| tail -1 \| sed 's\/\^__SESSION__:\/\/'\)"/);
  assert.match(launcher, /export RP_SESSION="\$ACTUAL_SESSION"/);
});

console.log(`${testFile} REDGREEN ${passed} ${failed}`);
process.exitCode = failed ? 1 : 0;
