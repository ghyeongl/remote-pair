const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const launcher = fs.readFileSync(path.join(root, "xpair-launch"), "utf8");
const maplib = fs.readFileSync(path.join(root, "bin/maplib.sh"), "utf8");

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

test("launch/attach preserves persistent host session identity and context (Q0056)", () => {
  assert.match(
    maplib,
    /map_to_host\(\)[\s\S]*best_c="" best_h=""[\s\S]*case "\$d" in "\$c"\|"\$c"\/\*\)[\s\S]*"\$\{d#"\$best_c"\}"/,
    "client paths must resolve to the longest matching mapped host path",
  );
  assert.match(
    launcher,
    /HOST_DIR="\$\(map_to_host "\$PROJECT_DIR"\)"[\s\S]*REMOTE_PROJ="\$\{REMOTE_HOST\}_\$\(_proj_base "\$HOST_DIR"\)"/,
    "remote session identity must be derived from the mapped host path",
  );
  assert.match(
    launcher,
    /while pgrep -f "mosh-client\.\*attach -d -t =\$\{base\}_\$\{n\}\( \|\\\$\)"[\s\S]*n=\$\(\(n\+1\)\)/,
    "a live client tab must advance to a fresh _N session instead of stealing the attached one",
  );
  assert.match(
    launcher,
    /\[ "\$RN" -gt 1 \] && RCONT=0/,
    "_2 and later sessions must be fresh agent conversations",
  );
  assert.match(
    launcher,
    /if tm has-session -t "=\\\$SESSION" 2>\/dev\/null; then NEED_CREATE=0; fi[\s\S]*tm new-session/,
    "an existing detached tmux session must be reused, not recreated",
  );
  assert.match(
    launcher,
    /--resume "\$RESUME_SID" --remote-control "\$RC"/,
    "reattach must resume the exact recorded agent conversation id",
  );
  const uncommentedLauncher = launcher.replace(/^#.*$/gm, "");
  assert.doesNotMatch(
    uncommentedLauncher,
    /^\s*claude --continue\b/m,
    "launcher must not use claude --continue because it can cross-pollute sibling project context",
  );
  assert.match(
    launcher,
    /attach -d -t "=\$ACTUAL_SESSION"/,
    "remote attach must take over the selected detached session in place",
  );
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall Q0056 launcher tests passed");
