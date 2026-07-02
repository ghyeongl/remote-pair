const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const app = fs.readFileSync(path.join(root, "onboarding-webview/src/App.tsx"), "utf8");
const stepDiscover = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepDiscover.tsx"),
  "utf8",
);
const bridge = fs.readFileSync(path.join(root, "onboarding-bridge.js"), "utf8");
const cli = fs.readFileSync(path.join(root, "../../../cli/xpair"), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error && error.message ? error.message.split("\n")[0] : error}`);
  }
}

test("Q0383/Q0384 no discovered host guides to host onboarding and rescan", () => {
  assert.match(cli, /RP_BONJOUR_TYPE="_xpair\._tcp"/, "discovery must include LAN Bonjour");
  assert.match(cli, /rp_tailscale_bin\(\)/, "discovery must include Tailscale fallback probing");
  assert.match(bridge, /async discover\(\)[\s\S]*cli\(\["discover", "--json"\]\)/, "onboarding bridge must call real xpair discovery");

  assert.match(app, /w\.index === 3 && !selectedHost/);
  assert.match(app, /w\.index === 3 && \([\s\S]*<StepDiscover selected=\{selectedHost\} setSelected=\{setSelected\} \/>/);
  assert.match(stepDiscover, /const empty = !scanning && hosts\.length === 0;/);
  assert.match(stepDiscover, /hosts\.length === 0 && scanning/);
  assert.match(stepDiscover, /t\("discover\.installedQ"\)/);
  assert.match(stepDiscover, /t\("discover\.empty\.title"\)/);
  assert.match(stepDiscover, /t\("discover\.empty\.desc"\)/);
  assert.match(stepDiscover, /t\("discover\.openHost"\)/);
  assert.match(stepDiscover, /const openHostOnboarding = useCallback/);
  assert.match(stepDiscover, /window\.remotepair\.openHostOnboarding\(\)/);
  assert.match(bridge, /async openHostOnboarding\(\)[\s\S]*open", \["-a", "XpairHost"\][\s\S]*HOST_SETUP_URL/);
  assert.match(stepDiscover, /t\("discover\.rescan"\)/);
  assert.match(stepDiscover, /setScanNonce\(\(nonce\) => nonce \+ 1\)/);
});

test("Tailscale remains part of discovery without reviving the deleted manual StepConnect path", () => {
  assert.match(stepDiscover, /transport: peer\.source === "tailscale" \? "Tailscale" : "LAN"/);
  assert.match(cli, /RP_TAILNET_PAIRING_METADATA_PORT=8891/);
  assert.match(cli, /hostKeyFP[\s\S]*serviceInstanceID[\s\S]*hostNonce[\s\S]*pairPort[\s\S]*hostUser/);
  assert.match(stepDiscover, /host\.transport === "LAN"[\s\S]*bg-blue-500\/10 text-blue-500/);
  assert.doesNotMatch(app, /onManual|StepConnect|S\.CONNECT/);
  assert.equal(
    fs.existsSync(path.join(root, "onboarding-webview/src/components/onboarding/client/StepConnect.tsx")),
    false,
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
