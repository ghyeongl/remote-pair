const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const patch = fs.readFileSync(path.join(__dirname, "../patches/zz-remotepair-ide-frontend.patch"), "utf8");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}\n        ${error && error.message ? error.message : error}`);
  }
}

// --- editor-tab X close fix (S0 lookup-only part registration) ------------------------------
// The embedded Sessions EditorPart is not in `_parts`, so global tab/title commands (close X,
// middle-click, context-menu, closeActiveEditor) resolve `getGroup(id)` to undefined and no-op.
// The fix restores getGroup reachability via a lookup-only registry without the MRU/activeGroup
// reverse-leak. If any leg regresses the tab X silently stops working again.

check("IEditorPartsView exposes registerLookupPart", () => {
  assert.match(patch, /registerLookupPart\(part: IEditorPart\): IDisposable;/);
});

check("EditorParts keeps lookup-only parts out of _parts", () => {
  assert.match(patch, /private readonly lookupParts = new Set<EditorPart>\(\);/);
  assert.match(patch, /registerLookupPart\(part: EditorPart\): IDisposable \{\n\+\s*this\.lookupParts\.add\(part\);/);
});

check("getGroup consults the lookup-only parts", () => {
  // The new loop must sit inside getGroup, before the mainPart fallback.
  assert.match(patch, /for \(const part of this\.lookupParts\) \{\n\+\s*const group = part\.getGroup\(identifier\);/);
});

check("getPart id-branch consults the lookup-only parts (Split/Move routing)", () => {
  // Symmetric with getGroup so group mutators (addGroup/moveGroup/...) route to the embedded part
  // instead of falling back to mainPart. Must be the id branch only (guarded by !isHTMLElement) so
  // getPartByDocument / activePart stay untouched.
  assert.match(patch, /if \(!isHTMLElement\(groupOrElement\)\) \{\n\+\s*const id = typeof groupOrElement === 'number' \? groupOrElement : groupOrElement\.id;\n\+\s*for \(const part of this\.lookupParts\) \{\n\+\s*if \(part\.hasGroup\(id\)\) \{/);
});

check("embedded Sessions part registers for lookup (not full registerPart)", () => {
  // The lookup registration must be wired as an executable disposable.
  assert.match(patch, /this\.partDisposables\.add\(editorPartsView\.registerLookupPart\(part\)\);/);
  // Must NOT full-register the embedded part as executable code (that reintroduces the S0
  // reverse-leak). Guard against the disposable-add form; the explanatory comment may still
  // mention registerPart in prose, so only reject the wired call.
  assert.doesNotMatch(patch, /\.add\(editorPartsView\.registerPart\(part\)\)/);
});

// --- Favorites section defaults to open ------------------------------------------------------

check("Favorites view descriptor defaults to expanded", () => {
  const favBlock = patch.match(/const favoritesViewDescriptor: IViewDescriptor = \{[\s\S]*?\};/);
  assert.ok(favBlock, "favoritesViewDescriptor block not found");
  assert.match(favBlock[0], /collapsed: false,/);
  assert.doesNotMatch(favBlock[0], /collapsed: true,/);
});

// --- empty-sessions -> Browser fallback (#2 launch default, #4 close-last auto-switch) -------

check("attachedSessionCount is exported for the fallback contribution", () => {
  assert.match(patch, /export function attachedSessionCount\(\): number \{ return attachedProvider\?\.getAttached\(\)\.length \?\? 0; \}/);
});

check("close-last Browser fallback only fires on a nonzero->0 transition", () => {
  assert.match(patch, /class RemotePairEmptySessionsBrowserFallback extends Disposable implements IWorkbenchContribution/);
  assert.match(patch, /onDidChangeAttachedSessions\(\(\) => this\.onAttachedChanged\(\)\)/);
  // Must gate on the transition, NOT every count==0 — otherwise an explicit Sessions open (which
  // fires onDidChange at count 0 before the terminal is created) gets bounced back to Browser.
  assert.match(patch, /const wasNonzero = this\.lastCount > 0;/);
  assert.match(patch, /if \(wasNonzero && count === 0\) \{\n\+\s*this\.viewsService\.openViewContainer\(BROWSER_VIEWLET_ID, false\);/);
  assert.match(patch, /registerWorkbenchContribution2\(RemotePairEmptySessionsBrowserFallback\.ID, RemotePairEmptySessionsBrowserFallback, WorkbenchPhase\.AfterRestored\);/);
});

check("Browser-first launch queues per-folder actions until the embedded part is ready", () => {
  // setupLayout no longer warms the Sessions part, so openSessionInFolder/stageBrowserCommand
  // must wait for embeddedPartReady instead of no-op'ing when editorPart is still unset.
  assert.match(patch, /private readonly embeddedPartReady = new Promise<void>\(resolve => \{ this\.resolveEmbeddedPartReady = resolve; \}\);/);
  assert.match(patch, /this\.resolveEmbeddedPartReady\(\);/);
  assert.match(patch, /this\.embeddedPartReady\.then\(\(\) => \{ if \(this\.editorPart\) \{ this\.openSessionInFolder\(cwd, kind\); \} \}\);/);
  assert.match(patch, /this\.embeddedPartReady\.then\(\(\) => \{ if \(this\.editorPart\) \{ this\.stageBrowserCommand\(text\); \} \}\);/);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall terminal-tab-close and browser-fallback tests passed");
