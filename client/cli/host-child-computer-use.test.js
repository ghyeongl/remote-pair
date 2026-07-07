const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const repoRoot = path.join(root, "..", "..");
const launcher = fs.readFileSync(path.join(root, "xpair-launch"), "utf8");
const cli = fs.readFileSync(path.join(root, "xpair"), "utf8");
const hostManager = fs.readFileSync(path.join(repoRoot, "host/app/HostManager.swift"), "utf8");

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

test("Q0025 Q0101 Q0245 child sessions use the host tmux-aqua subtree for computer-use", () => {
  assert.match(hostManager, /For claude to use computer-use, the tmux server must live in the granted \.app \(XpairHost\) subtree/);
  assert.match(hostManager, /TMUX, "-S", SOCKET, "new-session", "-s", "_keeper"/);
  assert.match(hostManager, /posix_spawn\(&pid, "\/usr\/bin\/script"/);

  assert.match(launcher, /Single uniform target: the configured host \(may be localhost\)\. No local\/remote branch\./);
  assert.match(launcher, /\[ -n "\$REMOTE_HOST" \] \|\| die "no host configured/);
  assert.doesNotMatch(launcher, /\bensure_local_host\b|\btm_local\b|\bLOCAL_PROJ\b/);

  assert.match(launcher, /TMUXB="\$\{REMOTE_BIN\}\/tmux-aqua"/);
  assert.match(launcher, /tm\(\) \{ "\\\$TMUXB" -S "\\\$SOCK" "\\\$@"; \}/);
  assert.match(launcher, /tm new-session -d -x \$\{COLS\} -y \$\{LINES\} -s "\\\$SESSION" -c \$\{HOST_DIR_Q\} "bash \\\$T"/);
  assert.match(launcher, /mosh --ssh="ssh \$SSH_ID" --server="\$MOSH_SERVER" "\$REMOTE_HOST" -- "\$REMOTE_HOME\/\.local\/bin\/tmux-aqua" -S "\$AQUA_SOCK" attach -d -t "=\$ACTUAL_SESSION"/);
  // non-exec by design: ssh-fallback failure must return to choose_attach_recovery
  assert.match(launcher, /\n  ssh \$SSH_ID -t "\$REMOTE_HOST" "\$REMOTE_BIN\/tmux-aqua -S \$\{AQUA_SOCK_Q\} attach -d -t/);

  assert.match(cli, /in_host_session\(\) \{ case "\$\{TMUX:-\}" in \*aqua-tmux\.sock\*\) return 0/);
  assert.match(cli, /not serving: AX\/SR \+ Full Disk Access .* and File Sharing/);
  assert.match(cli, /INSIDE Xpair host.*computer-use available here/);
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall Q0025 Q0101 Q0245 computer-use tests passed");
process.exit(failed ? 1 : 0);
