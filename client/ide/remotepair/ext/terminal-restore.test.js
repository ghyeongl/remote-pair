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
    terminalSidebar,
    /private readonly pendingReattachSessions: string\[\] = \[\];[\s\S]*reattachSession\(name: string\): void[\s\S]*if \(!this\.editorPart\) \{[\s\S]*this\.queueReattach\(sessionName\);[\s\S]*private flushPendingReattachSessions\(\): void \{[\s\S]*for \(const name of names\) \{[\s\S]*this\.launchReattach\(name\);[\s\S]*this\.resolveEmbeddedPartReady\(\);\n\+\s*this\.flushPendingReattachSessions\(\);/,
    "startup restore reattach requests must queue until the embedded EditorPart exists, then flush in order",
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
    /const liveNames = new Set\(cachedSessionNames\(\)\);[\s\S]*const persisted = this\.readHistory\(\)\.filter\(name => !liveNames\.has\(name\)\);[\s\S]*for \(const name of persisted\)[\s\S]*this\.addCard\(name, \(\) => validateAndReattach\(name, this\.commandService\)\)/,
    "History must be persisted last-seen names minus every currently live tmux session, and clicks must validate before reattach",
  );
  assert.match(
    sessionManager,
    /CommandsRegistry\.registerCommand\(\{[\s\S]*id: 'remotepair\.terminalSidebar\.syncOpenedSessions'[\s\S]*writeOpenedSessions\(accessor\.get\(ICommandService\)\)/,
    "frontend must expose a post-restore sync command that rewrites the current opened-session set",
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
    terminalSidebar,
    /import \{[\s\S]*onDidChangeSessionData, liveSessionNameFromTitle, SESSION_NAME_RE[\s\S]*\} from '\.\/remotePairSessionManager\.js';[\s\S]*private sessionNameFromTitle\(title: string \| undefined\): string \| undefined \{[\s\S]*return liveSessionNameFromTitle\(title\);/,
    "new session title candidates must be accepted only when they match the live tmux session cache",
  );
  assert.match(
    sessionManager,
    /export function liveSessionNameFromTitle\(value: string \| undefined\): string \| undefined \{[\s\S]*SESSION_NAME_RE\.test\(name\)[\s\S]*return liveSessionCache\.some\(s => s\.name === name\) \? name : undefined;/,
    "default titles such as zsh or Terminal must not freeze unless they exactly match liveSessionCache",
  );
  assert.match(
    terminalSidebar,
    /private freezeSessionNameFromTitle\(key: string, instance: ITerminalInstance\): boolean \{[\s\S]*if \(!entry \|\| entry\.sessionName\) \{[\s\S]*entry\.sessionName = name;[\s\S]*return true;/,
    "sessionName freezing must be one-shot and must not overwrite a previously frozen name",
  );
  assert.match(
    terminalSidebar,
    /instance\.onTitleChanged\(\(\) => \{[\s\S]*this\.freezeSessionNameFromTitle\(key, instance\);[\s\S]*notifyAttachedSessionsChanged\(\);/,
    "title changes must only fill a missing frozen sessionName and then refresh the Attached row",
  );
  assert.match(
    terminalSidebar,
    /this\._register\(onDidChangeSessionData\(\(\) => this\.freezePendingSessionNamesFromLiveCache\(\)\)\);[\s\S]*private freezePendingSessionNamesFromLiveCache\(\): void \{[\s\S]*for \(const \[key, entry\] of this\.attached\)[\s\S]*this\.freezeSessionNameFromTitle\(key, entry\.instance\)[\s\S]*notifyAttachedSessionsChanged\(\);/,
    "live-list refreshes must keep rechecking unfrozen title candidates until the tmux name appears",
  );
  assert.match(
    terminalSidebar,
    /let frozenSessionName = sessionName && SESSION_NAME_RE\.test\(sessionName\) \? sessionName : this\.sessionNameFromTitle\(instance\.title\);[\s\S]*if \(!frozenSessionName\) \{[\s\S]*frozenSessionName = this\.sessionNameFromTitle\(instance\.title\);[\s\S]*this\.attached\.set\(key, \{ instance, input, group, sessionName: frozenSessionName \}\);/,
    "reattach must freeze the explicit tmux name immediately while new sessions wait for a live-cache title match",
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
  assert.match(
    extension,
    /const live = new Map\(list\.sessions\.map\(\(entry\) => \[entry\.name, entry\.attached\]\)\);[\s\S]*const attached = live\.get\(name\);[\s\S]*if \(attached !== 0\) \{[\s\S]*opened sessions: skipped restore for \$\{name\}; attached elsewhere/,
    "activation restore must retain attached counts and skip sessions already attached elsewhere",
  );
  assert.match(
    extension,
    /const clientServicesLock = claimClientServicesLock\(\);\n  setOpenedSessionsWriteOwner\(\!!clientServicesLock\);/,
    "opened-session restore/write ownership must reuse the existing client services lock",
  );
  assert.match(
    extension,
    /\/\/ 5a\) Warm the Sessions sidebar in every window[\s\S]*vscode\.commands\.executeCommand\("remotepair\.terminalSidebar"\)[\s\S]*if \(clientServicesLock\) \{[\s\S]*return restoreOpenedSessionsOnActivation\(\);[\s\S]*opened sessions: restore skipped in non-owner extension host[\s\S]*return 0;/,
    "startup warmup and Browser default must run in every window while restore stays owner-gated",
  );
  assert.match(
    extension,
    /restoreOpenedSessionsOnActivation\(\)[\s\S]*readOpenedSessions\(OPENED_SESSIONS_FILE, host, CLIENT_SERVICES_SCOPE_ID, \{ log \}\)[\s\S]*let sessionListWasAvailable = false;[\s\S]*const list = await waitForAvailableSessionList\(\);[\s\S]*if \(!list\) \{[\s\S]*keeping snapshot[\s\S]*return 0;[\s\S]*sessionListWasAvailable = true;[\s\S]*finally \{[\s\S]*enableOpenedSessionWrites\(\);[\s\S]*if \(sessionListWasAvailable && restored === 0\) \{[\s\S]*vscode\.commands\.executeCommand\("remotepair\.terminalSidebar\.syncOpenedSessions"\)/,
    "restore must read only this window scope and sync immediately only when nothing was restored",
  );
  assert.doesNotMatch(
    extension,
    /writeOpenedSessionsNow\(host, \[\]\)/,
    "restore must not clear the saved opened-session snapshot when the live list is empty",
  );
  assert.match(
    extension,
    /function flushOpenedSessionsWriteOnDeactivate\(\)[\s\S]*clearTimeout\(openedSessionsWriteTimer\);[\s\S]*const pending = openedSessionsPendingNames \|\| \[\];[\s\S]*host = getValidHost\(\);[\s\S]*writeOpenedSessionsNow\(host, pending\);[\s\S]*function deactivate\(\)[\s\S]*flushOpenedSessionsWriteOnDeactivate\(\)/,
    "deactivate must synchronously drain any pending debounced opened-session write with guarded host lookup",
  );
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall terminal restore tests passed");
process.exit(failed ? 1 : 0);
