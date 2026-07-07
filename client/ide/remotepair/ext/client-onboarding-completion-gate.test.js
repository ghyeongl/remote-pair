const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const app = fs.readFileSync(path.join(root, "onboarding-webview/src/App.tsx"), "utf8");
const waitPerm = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepWaitPerm.tsx"),
  "utf8",
);
const mappings = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepMappings.tsx"),
  "utf8",
);
const main = fs.readFileSync(path.join(root, "onboarding-main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "onboarding-preload.cjs"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - completion is gated on finished setup`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("Q0369 Q0402 Q0474 client onboarding reaches completion only from gated Done", () => {
  assert.match(app, /DONE: 7/);
  assert.match(app, /if \(w\.index !== S\.DONE\) return;/);
  assert.match(app, /if \(!selectedHost\) \{[\s\S]*w\.goTo\(S\.DISCOVER, "prev"\)/);
  assert.match(app, /if \(majorMismatch \|\| \(needsUpdate && updateState !== "done"\)\) \{[\s\S]*w\.goTo\(S\.UPDATE, "prev"\)/);
  assert.match(app, /if \(!permAccepted \|\| permDenied\) \{[\s\S]*w\.goTo\(S\.WAIT_PERM, "prev"\)/);
  assert.match(app, /const hasRealMapping = mappings\.some\(isPersistedRealMapping\)/);
  assert.match(app, /if \(!hasRealMapping\) \{[\s\S]*w\.goTo\(S\.MAPPINGS, "prev"\)/);
  assert.match(app, /footerSlot=\{[\s\S]*w\.isLast \? \([\s\S]*window\.remotepair\.complete\(\)/);
  assert.match(app, /w\.index === 7 && <StepDone host=\{selectedHost\} mappings=\{mappings\} \/>/);

  assert.match(waitPerm, /status\.paired[\s\S]*window\.remotepair\.pinHostKey\(sshTarget, host\.hostKeyFP!\)/);
  assert.match(waitPerm, /status\.paired[\s\S]*await window\.remotepair\.setHost\(sshTarget\)/);
  assert.match(waitPerm, /setAccepted\(true\)/);
  assert.match(mappings, /mappings: Mapping\[\]/);
  assert.match(mappings, /setMappings: Dispatch<SetStateAction<Mapping\[\]>>/);
  assert.match(mappings, /export function isPersistedRealMapping\(mapping: Mapping\): boolean/);

  assert.match(
    preload,
    /complete:\s*\(\)\s*=>\s*\{[\s\S]*ipcRenderer\.invoke\('onboarding:complete'\)/,
    "renderer completion must use the explicit onboarding:complete channel",
  );

  const uncommentedMain = stripLineComments(main);
  const closedStart = uncommentedMain.indexOf("_win.on('closed'");
  assert.notEqual(closedStart, -1, "onboarding-main.cjs must define a closed handler");
  const closedEnd = uncommentedMain.indexOf("return _win", closedStart);
  assert.notEqual(closedEnd, -1, "closed handler must appear before returning the window");
  const closedHandler = uncommentedMain.slice(closedStart, closedEnd);

  assert.doesNotMatch(
    closedHandler,
    /onComplete\s*\(/,
    "closing the onboarding window before completion must not call onComplete/open the workbench",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
