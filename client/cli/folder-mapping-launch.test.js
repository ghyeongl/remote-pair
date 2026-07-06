const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testFile = path.relative(process.cwd(), __filename);
const cli = fs.readFileSync(path.join(__dirname, "xpair"), "utf8");
const launcher = fs.readFileSync(path.join(__dirname, "xpair-launch"), "utf8");

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

function extractShellFunction(source, name) {
  const match = source.match(new RegExp(`(?:^|\\n)${name}\\(\\)\\s*\\{[^\\n]*\\n[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(match, `missing shell function ${name}`);
  return match[0].trimStart();
}

function extractOneLineFunction(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\)\\s*\\{[^\\n]*\\}$`, "m"));
  assert.ok(match, `missing shell function ${name}`);
  return match[0];
}

function runShellFunction(fnSource, env, command) {
  const result = spawnSync("bash", ["-lc", `${fnSource}\n${command}`], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("Q0041/Q0042/Q0043 launcher maps client paths with the longest host prefix", () => {
  const helpers = [
    extractOneLineFunction(launcher, "map_client_of"),
    extractOneLineFunction(launcher, "map_host_of"),
    extractShellFunction(launcher, "map_to_host"),
  ].join("\n");
  const env = {
    FOLDER_MAPS: "/client::/host;/client/work::/srv/work;/client/work/app::/srv/app",
  };

  assert.equal(runShellFunction(helpers, env, "map_to_host '/client/work/app/src'"), "/srv/app/src");
  assert.equal(runShellFunction(helpers, env, "map_to_host '/client/work/other'"), "/srv/work/other");
  assert.equal(runShellFunction(helpers, env, "map_to_host '/outside/project'"), "/outside/project");
});

test("Q0041/Q0042/Q0043 xpair launch resolves unmapped candidates through the same mapping rule", () => {
  const helpers = [
    extractOneLineFunction(cli, "map_client_of"),
    extractOneLineFunction(cli, "map_host_of"),
    extractShellFunction(cli, "resolve_host"),
  ].join("\n");
  const env = {
    FOLDER_MAPS: "/Users/me/Spaces::/Volumes/Host/Spaces;/Users/me/Spaces/Work::/srv/work",
  };

  assert.equal(
    runShellFunction(helpers, env, "resolve_host '/Users/me/Spaces/Work/repo'"),
    "/srv/work/repo",
  );
  assert.equal(
    runShellFunction(helpers, env, "resolve_host '/Users/me/Other/repo'"),
    "/Users/me/Other/repo",
  );
});

test("Q0041/Q0042/Q0043 missing host directories offer map, create, or cancel repair paths", () => {
  assert.match(cli, /hostdir="\$\(resolve_host "\$dir"\)"/);
  assert.match(cli, /\[m\] map to the host path that actually has this content/);
  assert.match(cli, /map_register_interactive "\$dir"/);
  assert.match(cli, /\[c\] create an empty dir on host/);
  assert.match(cli, /\[N\] cancel/);
  assert.match(cli, /Register this mapping for next time\? \[Y\/n\]/);
});

test("Q0041/Q0042/Q0043 remote launch and attach use the mapped host path as session identity", () => {
  assert.match(launcher, /HOST_DIR="\$\(map_to_host "\$PROJECT_DIR"\)"/);
  assert.match(launcher, /REMOTE_PROJ="\$\{REMOTE_HOST\}_\$\(_proj_base "\$HOST_DIR"\)"/);
  assert.match(launcher, /\[ -d \$\{HOST_DIR_Q\} \]/);
  assert.match(launcher, /cd \$\{HOST_DIR_Q\}/);
  assert.match(launcher, /tm new-session -d -x \$\{COLS\} -y \$\{LINES\} -s "\\\$SESSION" -c \$\{HOST_DIR_Q\}/);
  assert.match(launcher, /attach -d -t "=\$ACTUAL_SESSION"/);
});

console.log(`${testFile} REDGREEN ${passed} ${failed}`);
process.exitCode = failed ? 1 : 0;
