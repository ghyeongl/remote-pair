const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const patch = fs.readFileSync(
  path.join(root, "..", "patches", "zz-remotepair-ide-frontend.patch"),
  "utf8",
);

function addedFileSection(fileName) {
  const marker = `diff --git a/${fileName} b/${fileName}`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `missing patch section for ${fileName}`);
  const next = patch.indexOf("\ndiff --git ", start + marker.length);
  return patch.slice(start, next === -1 ? patch.length : next);
}

const sessionManager = addedFileSection(
  "src/vs/workbench/contrib/terminal/browser/remotePairSessionManager.ts",
);
const terminalSidebar = addedFileSection(
  "src/vs/workbench/contrib/terminal/browser/remotePairTerminalSidebar.ts",
);

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

test("terminal tabs restore saved sessions after client relaunch (Q0546/Q0547)", () => {
  assert.match(
    terminalSidebar,
    /private launchReattach\(name: string\): void[\s\S]*xpair attach/,
    "restore must reuse the real reattach path that opens a terminal and runs xpair attach",
  );
  assert.match(
    sessionManager,
    /HISTORY_STORAGE_KEY[\s\S]*StorageScope\.WORKSPACE/,
    "terminal/session state must be persisted across workbench launches",
  );
  assert.doesNotMatch(
    sessionManager,
    /SessionDataProvider|setSessionDataProvider|dataProvider/,
    "the dead bottom-bar session data injection point must stay removed",
  );
  assert.doesNotMatch(
    sessionManager,
    /display-only rather than wiring a reattach/,
    "persisted sessions are currently display-only, so closed/reopened terminal tabs cannot restore",
  );
  assert.match(
    sessionManager,
    /const liveNames = new Set\(cachedSessionNames\(\)\);[\s\S]*const persisted = this\.readHistory\(\)\.filter\(name => !liveNames\.has\(name\)\);[\s\S]*for \(const name of persisted\)[\s\S]*this\.addCard\(name, \(\) => reattach\(name\)\)/,
    "History must be persisted last-seen names minus every currently live tmux session, and entries must still reattach",
  );
  assert.match(
    sessionManager,
    /commandService\.executeCommand\('remotepair\.sessions\.writeOpened', localAttachedSessionNameList\(\)\)/,
    "Attached changes must rewrite the last-opened session snapshot through the extension host",
  );
  assert.match(
    terminalSidebar,
    /id: 'remotepair\.terminalSidebar\.reattachSession'[\s\S]*view\.reattachSession\(name\.trim\(\)\)/,
    "startup restore must have a command entry point into the same sidebar reattach flow",
  );
  assert.match(
    extension,
    /const OPENED_SESSIONS_FILE = path\.join\(RP_CLIENT_DIR, "opened-sessions\.json"\)/,
    "opened sessions must persist to ~/.xpair/client/opened-sessions.json",
  );
  assert.match(
    extension,
    /OPENED_SESSIONS_RESTORE_ATTEMPTS = 3[\s\S]*async function waitForAvailableSessionList\(\)[\s\S]*listSessionsFromCli\(runXpairCli, \{ log, timeoutMs: 5000 \}\)/,
    "startup restore must gate on the existing session-list helper with bounded retries",
  );
  assert.match(
    extension,
    /restoreOpenedSessionsOnActivation\(\)[\s\S]*vscode\.commands\.executeCommand\("remotepair\.terminalSidebar\.reattachSession", name\)/,
    "activation restore must execute the sidebar reattach command for stored live names",
  );
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall terminal restore tests passed");
process.exit(failed ? 1 : 0);
