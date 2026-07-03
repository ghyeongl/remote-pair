const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const mountCli = fs.readFileSync(path.join(root, "../../../cli/xpair-mount"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - mountpoint is registered as the mapping root`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}()`);
  assert.notStrictEqual(start, -1, `${name}() must exist`);
  const end = source.indexOf("\n// --- show logs", start);
  assert.notStrictEqual(end, -1, `${name}() block end marker must exist`);
  return source.slice(start, end);
}

test("§1.7 Q0281 Add Root mounts first, then maps the returned mountpoint", () => {
  const addRoot = extractFunction(extension, "addRoot");

  assert.match(
    mountCli,
    /xpair-mount \[--backend smb\] mount\s+<hostPath>/,
    "the real xpair-mount CLI requires the mount action before the host path",
  );
  assert.match(
    addRoot,
    /runXpairCli\(\["mount", "mount", host\]/,
    "Add Root must invoke xpair mount mount <hostPath> so a real Mountpoint line is produced",
  );
  assert.match(
    addRoot,
    /line\.match\(/,
    "Add Root must parse the returned Mountpoint line",
  );
  assert.match(addRoot, /Mountpoint:/, "Add Root must parse the returned Mountpoint line");
  assert.match(addRoot, /mountpoint = m\[1\]/, "Add Root must use the parsed mountpoint value");
  assert.match(
    addRoot,
    /runXpairCli\(\["map", "add", mountpoint, host\]/,
    "Add Root must register the returned mountpoint as the client path for the host path",
  );
  assert.ok(
    addRoot.indexOf('line.match(/^\\s*Mountpoint:') < addRoot.indexOf('["map", "add", mountpoint, host]'),
    "mountpoint parsing must happen before mapping registration",
  );
  assert.match(
    addRoot,
    /reconcileBrowserRoots\(\)/,
    "Add Root must reconcile Browser roots after mapping registration",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
