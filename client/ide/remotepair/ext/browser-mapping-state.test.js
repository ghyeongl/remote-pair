const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const frontendPatch = fs.readFileSync(
  path.join(root, "../patches/zz-remotepair-ide-frontend.patch"),
  "utf8",
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - Browser roots are reconciled from mapping state`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`could not parse function ${name}`);
}

test("Q0398 Browser UI reflects FOLDER_MAPS and does not add roots on mount/map failure", () => {
  const reconcile = extractFunction(extension, "reconcileBrowserRoots");
  assert.match(reconcile, /const maps = readFolderMaps\(\);/);
  assert.match(reconcile, /const seen = new Set\(\);/);
  assert.match(reconcile, /if \(!fs\.existsSync\(m\.clientDir\)\)/);
  assert.match(reconcile, /const current = \(vscode\.workspace\.workspaceFolders \|\| \[\]\)\.map\(\(f\) => f\.uri\.fsPath\);/);
  assert.match(reconcile, /updateWorkspaceFolders\(\s*0,\s*current\.length,\s*\.\.\.clientDirs\.map\(\(d\) => \(\{ uri: vscode\.Uri\.file\(d\) \}\)\)\s*\)/);

  assert.match(
    extension,
    /vscode\.commands\.registerCommand\("remotepair\.openFileBrowser"[\s\S]*const clientDirs = reconcileBrowserRoots\(\);[\s\S]*"workbench\.view\.explorer"/,
    "Opening Browser must reconcile roots from the CLI mapping state before revealing the Browser",
  );
  assert.match(
    extension,
    /\/\/ C1\.D4 — Reconcile Browser roots on activation[\s\S]*try \{\s*reconcileBrowserRoots\(\);\s*\} catch/,
    "Activation must reconcile Browser roots so mapped folders appear without relying on manual Browser open",
  );

  const addRoot = extractFunction(extension, "addRoot");
  const mountFailure = addRoot.indexOf("if (mres.code !== 0)");
  const mapFailure = addRoot.indexOf("if (ares.code !== 0)");
  const reconcileCall = addRoot.indexOf("reconcileBrowserRoots();", mapFailure);
  assert.ok(mountFailure !== -1 && mountFailure < reconcileCall, "mount failure must return before adding a Browser root");
  assert.ok(mapFailure !== -1 && mapFailure < reconcileCall, "map failure must return before adding a Browser root");
  assert.match(addRoot.slice(mountFailure, mapFailure), /showErrorMessage\(`Xpair: 'xpair mount mount \$\{host\}' failed\./);
  assert.match(addRoot.slice(mapFailure, reconcileCall), /showErrorMessage\(`Xpair: mounted at \$\{mountpoint\} but registering the folder map failed\.`/);

  assert.match(frontendPatch, /No mapped folders yet\.[\s\S]*command:remotepair\.browser\.addRoot/);
  assert.match(frontendPatch, /id: 'remotepair\.browser\.newSessionInFolder'/);
  assert.match(frontendPatch, /id: 'remotepair\.browser\.toggleFavorite'/);
  assert.match(frontendPatch, /ExplorerFolderContext/);
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
