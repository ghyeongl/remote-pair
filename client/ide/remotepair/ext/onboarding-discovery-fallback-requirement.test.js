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
  assert.match(cli, /rp_tailscale_bin\(\)/, "discovery must include Tailscale fallback probing");
  assert.match(cli, /RP_LAN_BEACON_PORT="\$\{RP_LAN_BEACON_PORT:-8892\}"/, "discovery must include native LAN beacon probing");
  assert.doesNotMatch(cli, /RP_BONJOUR_TYPE|RP_LEGACY_BONJOUR_TYPE|\bdns-sd\b/, "discovery must not browse Bonjour");
  assert.match(bridge, /async discover\(\)[\s\S]*cli\(\["discover", "--json"\]\)/, "onboarding bridge must call real xpair discovery");
  assert.match(bridge, /async fetchPairingMeta\(target\)[\s\S]*fetchPairingMetadata\(host, 3000\)/, "pairing metadata must be pulled directly from the selected host");

  assert.match(app, /w\.index === 3 && !selectedHost/);
  assert.match(app, /w\.index === 3 && \([\s\S]*<StepDiscover[\s\S]*selected=\{selectedHost\}[\s\S]*setSelected=\{setSelected\}/);
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

test("LAN beacon and Tailscale remain part of discovery without reviving the deleted manual StepConnect path", () => {
  assert.match(stepDiscover, /peer\.source === "lan" \? "LAN" : peer\.source === "tailscale" \? "Tailscale" : "SSH"/);
  assert.match(cli, /RP_TAILNET_PAIRING_METADATA_PORT=8891/);
  assert.match(cli, /hostKeyFP[\s\S]*hostUser/);
  assert.doesNotMatch(cli, /item\["serviceInstanceID"\]|item\["hostNonce"\]|item\["pairPort"\]/);
  assert.match(stepDiscover, /transportLabelKey[\s\S]*transport === "LAN"[\s\S]*discover\.badge\.lan/);
  assert.match(stepDiscover, /host\.transport === "Tailscale"[\s\S]*bg-blue-500\/10 text-blue-500/);
  assert.doesNotMatch(app, /onManual|StepConnect|S\.CONNECT/);
  assert.equal(
    fs.existsSync(path.join(root, "onboarding-webview/src/components/onboarding/client/StepConnect.tsx")),
    false,
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
