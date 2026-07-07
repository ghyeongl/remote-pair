const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const webview = fs.readFileSync(path.join(root, "media/remote-desktop.js"), "utf8");
const hostReadme = fs.readFileSync(path.join(root, "../../../../host/rd/screen/README.md"), "utf8");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   - ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message.split("\n")[0]}`);
  }
}

test("Remote Desktop forwards click and keyboard input and can request a fresh frame (Q0346)", () => {
  assert.match(extension, /vscode\.commands\.registerCommand\("remotepair\.openRemoteDesktop"/);
  assert.match(extension, /panel\.reveal\(\)[\s\S]*setupLayout/);
  assert.match(extension, /msg\.type === "refresh"[\s\S]*this\._stopAll\(\);[\s\S]*this\._startStream\(\);/);

  assert.match(hostReadme, /rp-ctl[\s\S]*rp-move[\s\S]*rp-input-inject/);
  assert.match(webview, /createDataChannel\(["']rp-ctl["'],\s*\{ negotiated: true, id: 0 \}\)/);
  assert.match(webview, /createDataChannel\(["']rp-move["'],\s*\{ negotiated: true, id: 1, ordered: false, maxRetransmits: 0 \}\)/);
  assert.match(webview, /addEventListener\(["']pointerdown["'][\s\S]*\bt:\s*["']d["']/);
  assert.match(webview, /addEventListener\(["']pointermove["'][\s\S]*\bt:\s*["']m["']/);
  assert.match(webview, /addEventListener\(["']pointerup["'][\s\S]*\bt:\s*["']u["']/);
  assert.match(webview, /addEventListener\(["']wheel["'][\s\S]*\bt:\s*["']w["']/);
  assert.match(webview, /addEventListener\(["']keydown["'][\s\S]*sendKeyEvent\(ev,\s*["']down["']\)/);
  assert.match(webview, /addEventListener\(["']keyup["'][\s\S]*\baction:\s*["']up["']/);
  assert.match(webview, /addEventListener\(["'](?:beforeinput|input|compositionend)["'][\s\S]*\bt:\s*["']x["']/);
  assert.match(webview, /input-ready/);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall Q0346 Remote Desktop core-surface tests passed");
