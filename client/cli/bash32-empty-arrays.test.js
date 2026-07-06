const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testFile = path.relative(process.cwd(), __filename);
const root = path.resolve(__dirname, "../..");
const cli = fs.readFileSync(path.join(root, "client/cli/xpair"), "utf8");
const router = fs.readFileSync(path.join(root, "host/xpair-approve-router.sh"), "utf8");

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

function extractOneLineFunction(source, name) {
  const match = source.match(new RegExp(`^\\s*${name}\\(\\)\\s*\\{[^\\n]*\\}$`, "m"));
  assert.ok(match, `missing shell function ${name}`);
  return match[0].trim();
}

function extractShellFunction(source, name) {
  const match = source.match(new RegExp(`(?:^|\\n)${name}\\(\\)\\s*\\{[^\\n]*\\n[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(match, `missing shell function ${name}`);
  return match[0].trimStart();
}

function extractLine(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing ${label}`);
  return match[0].trim();
}

function extractBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing start for ${label}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing end for ${label}`);
  return source.slice(start, end);
}

function indent(source, spaces = "  ") {
  return source
    .split("\n")
    .map((line) => (line ? `${spaces}${line}` : line))
    .join("\n");
}

function runBash(script, env = {}) {
  return spawnSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function assertNoUnboundVariable(result) {
  assert.doesNotMatch(result.stderr, /unbound variable/);
}

const sshEnvDecl = extractLine(cli, /^\s*local SSHENV=\(\)$/m, "SSHENV declaration");
const rpSshOptsDecl = extractBetween(
  cli,
  "  local RP_SSHOPTS=(",
  "\n  if [ \"$password_stdin\" = 1 ]; then",
  "RP_SSHOPTS declaration",
).trim();
const rpSsh = extractOneLineFunction(cli, "_rp_ssh");
const sendkey = extractShellFunction(router, "sendkey");
const logsCollectBlock = extractBetween(
  cli,
  "  if [ \"$collect\" = 1 ]; then\n",
  "\n  if [ \"$host\" = 1 ]; then",
  "logs --collect block",
);

test("_rp_ssh tolerates empty SSHENV under bash 3.2 nounset", () => {
  const result = runBash(`
set -euo pipefail
ssh() { :; }
exercise() {
  local RP_CM="\${TMPDIR:-/tmp}/xpair-test-control"
${indent(sshEnvDecl)}
${indent(rpSshOptsDecl)}
${indent(rpSsh)}
  _rp_ssh example.local true
}
exercise
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertNoUnboundVariable(result);
});

test("sendkey tolerates an empty modifier array under bash 3.2 nounset", () => {
  const result = runBash(`
set -euo pipefail
osascript() { :; }
${sendkey}
sendkey return
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertNoUnboundVariable(result);
});

test("logs --collect returns a warning when no local log dirs exist", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-bash32-empty-"));
  try {
    const result = runBash(`
set -euo pipefail
warn() { printf '%s\\n' "$*" >&2; }
local_log_dirs() { :; }
exercise() {
  local collect=1
${logsCollectBlock}
}
exercise
`, { TMPDIR: tmpDir });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /collect: no log dirs yet/);
    assertNoUnboundVariable(result);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`${testFile} REDGREEN ${passed} ${failed}`);
process.exitCode = failed ? 1 : 0;
