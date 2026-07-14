const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const onboardingWindow = fs.readFileSync(path.join(root, "host/app/OnboardingWindow.swift"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - Host onboarding WKWebView gets clipboard shortcuts`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("host onboarding installs a reverting Edit menu so Cmd+C/V/X/A work in the WKWebView", () => {
  // A helper builds an Edit menu carrying the standard first-responder clipboard selectors.
  assert.match(
    onboardingWindow,
    /private func installEditMenu\(\)[\s\S]*NSApp\.mainMenu = bar/,
    "must define installEditMenu() that assigns an application menu",
  );
  for (const sel of ["cut(_:)", "copy(_:)", "paste(_:)", "selectAll(_:)"]) {
    assert.match(
      onboardingWindow,
      new RegExp(`#selector\\(NSText\\.${sel.replace("(", "\\(").replace(")", "\\)")}\\)`),
      `Edit menu must bind ${sel} for the responder chain`,
    );
  }
  // It must be installed while the onboarding window is shown (before the .regular flip)...
  assert.match(
    onboardingWindow,
    /installEditMenu\(\)\s*\n\s*NSApp\.setActivationPolicy\(\.regular\)/,
    "installEditMenu() must run in show() before the .regular activation flip",
  );
  // ...and reverted on close so the accessory app keeps no stray menu.
  assert.match(
    onboardingWindow,
    /private var previousMainMenu: NSMenu\?/,
    "must save the previous main menu for restoration",
  );
  assert.match(
    onboardingWindow,
    /func windowWillClose\([\s\S]*NSApp\.mainMenu = previousMainMenu/,
    "windowWillClose must revert to the previous main menu",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
