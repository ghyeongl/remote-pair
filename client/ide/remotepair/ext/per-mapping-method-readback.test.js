// per-mapping-method-readback — the per-mapping access method (FOLDER_MAP_MODES) must be the
// SOURCE OF TRUTH on READ-BACK, not just on write. Regression guard for the architect-flagged gap
// where getConfig had `m.method` in hand from `map list --json` but dropped it, so the UI/gates
// silently fell back to path-convention inference (mis-classifying custom-mountpoint mounts as sync,
// making Gate 2 skip their mount verification).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extRoot = __dirname;
const bridge = fs.readFileSync(path.join(extRoot, "onboarding-bridge.js"), "utf8");
const webview = path.join(extRoot, "onboarding-webview", "src");
const stepMappings = fs.readFileSync(
  path.join(webview, "components/onboarding/client/StepMappings.tsx"),
  "utf8",
);
const app = fs.readFileSync(path.join(webview, "App.tsx"), "utf8");
const newFlow = `${stepMappings}\n${app}`;
const globalDts = fs.readFileSync(path.join(webview, "global.d.ts"), "utf8");
const preload = fs.readFileSync(path.join(extRoot, "onboarding-preload.cjs"), "utf8");

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

test("bridge getConfig derives folderMapModes from the json method and returns it", () => {
  assert.match(
    bridge,
    /async getConfig\(\)[\s\S]*m\.method[\s\S]*`\$\{m\.client\}::\$\{m\.method\}`/,
    "getConfig must build folderMapModes from each mapping's stored method (not drop it)",
  );
  assert.match(
    bridge,
    /return \{[\s\S]*folderMaps,[\s\S]*folderMapModes,[\s\S]*\};/,
    "getConfig must return folderMapModes alongside folderMaps",
  );
});

test("global.d.ts getConfig contract exposes folderMapModes", () => {
  assert.match(
    globalDts,
    /getConfig:[\s\S]*folderMaps: string[\s\S]*folderMapModes: string/,
    "getConfig return type must include folderMapModes",
  );
});

test("parseFolderMaps prefers the stored method over path inference", () => {
  assert.match(
    stepMappings,
    /export function parseFolderMaps\(raw: string, modes\?: string\)/,
    "parseFolderMaps must accept the stored modes string",
  );
  assert.match(
    stepMappings,
    /modeOf\.get\(clientPath\) \?\? inferMethod\(clientPath\)/,
    "stored method must win; inferMethod is only the fallback",
  );
});

test("every new-flow seed path passes the stored modes into parseFolderMaps", () => {
  const cfgParseCalls = (newFlow.match(/parseFolderMaps\([^)]*\)/g) || []).filter((call) =>
    call.includes("cfg.folderMaps"),
  );
  assert.ok(
    cfgParseCalls.length >= 1,
    "App must seed mappings from getConfig via parseFolderMaps",
  );
  assert.deepEqual(
    cfgParseCalls.filter((call) => !/cfg\.folderMaps\s*,\s*cfg\.folderMapModes/.test(call)),
    [],
    "every getConfig→parseFolderMaps call site must pass cfg.folderMapModes",
  );
});

test("preload bridges the method arg and hostSmbStatus to window.remotepair", () => {
  // The webview only sees what the Electron preload exposes — a bridge method missing here is
  // undefined at runtime even though global.d.ts/types compile. Guards both gate + C0 write paths.
  assert.match(
    preload,
    /addMapping: \(clientPath, hostPath, method\) => rp\('addMapping', \[clientPath, hostPath, method\]\)/,
    "preload addMapping must forward the per-mapping method (else the GUI never persists it)",
  );
  assert.match(
    preload,
    /removeMapping: \(clientPath\) => rp\('removeMapping', \[clientPath\]\)/,
    "preload removeMapping must expose xpair map rm for persisted row edits/removals",
  );
  assert.match(
    preload,
    /resolveHostPath: \(target, hostPath\) => rp\('resolveHostPath', \[target, hostPath\]\)/,
    "preload resolveHostPath must expose SSH host-path expansion before saving mappings",
  );
  assert.match(
    preload,
    /hostSmbStatus: \(\) => rp\('hostSmbStatus', \[\]\)/,
    "preload must expose hostSmbStatus (else Gate 1's call is undefined at runtime)",
  );
});

test("persisted mapping rows keep their saved client path and can be removed over the bridge", () => {
  assert.match(
    bridge,
    /async removeMapping\(clientPath\)[\s\S]*cli\(\["map", "rm", c\]\)/,
    "bridge removeMapping must run xpair map rm <clientPath>",
  );
  assert.match(
    bridge,
    /async resolveHostPath\(sshTarget, hostPath\)[\s\S]*run\("ssh", \[\.\.\.sshProbeOpts\(h, 5\), h, remote, "_", p\]\)/,
    "bridge resolveHostPath must SSH with the shared probe options and pass the host path as a positional arg",
  );
  assert.match(
    stepMappings,
    /savedClientPath: clientPath/,
    "parseFolderMaps must remember the persisted client path used by xpair map rm",
  );
  assert.match(
    stepMappings,
    /window\.remotepair\.removeMapping\(mapping\.savedClientPath\)/,
    "remove() must delete persisted mappings from the CLI before dropping the row",
  );
  assert.match(
    stepMappings,
    /window\.remotepair\.resolveHostPath\(target, hostPath\)/,
    "persist() must resolve host picker paths over SSH before mount/addMapping",
  );
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nall per-mapping method read-back tests passed");
