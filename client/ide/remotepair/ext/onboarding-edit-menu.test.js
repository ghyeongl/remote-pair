const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const onboardingMain = fs.readFileSync(path.join(root, "onboarding-main.cjs"), "utf8");

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

test("pre-workbench onboarding installs an Edit-role application menu so Cmd+C/V/X/A work", () => {
  // Menu must be pulled off the electron module in openOnboardingWindow.
  assert.match(
    onboardingMain,
    /function openOnboardingWindow\([\s\S]*const \{ app, BrowserWindow, ipcMain, shell, Menu \} = electron/,
    "openOnboardingWindow must destructure Menu from electron",
  );
  // The Edit-role menu (Cut/Copy/Paste/SelectAll + accelerators) must be installed as the app menu.
  assert.match(
    onboardingMain,
    /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(\[[\s\S]*role: 'editMenu'[\s\S]*\]\)\)/,
    "must install an application menu whose template includes the editMenu role",
  );
  // macOS-only: the whole setApplicationMenu must be guarded to darwin — the gap is mac-specific and
  // on Windows/Linux the app menu renders as a visible per-window menu bar (unwanted wizard chrome).
  assert.match(
    onboardingMain,
    /if \(process\.platform === 'darwin'\) \{[\s\S]*Menu\.setApplicationMenu\(/,
    "the onboarding menu install must be guarded to darwin only (no menu bar on non-mac clients)",
  );
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall onboarding edit-menu tests passed");
process.exit(failed ? 1 : 0);
