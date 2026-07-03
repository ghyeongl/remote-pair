const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const app = fs.readFileSync(path.join(root, "onboarding-webview/src/App.tsx"), "utf8");
const stepDiscover = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepDiscover.tsx"),
  "utf8",
);
const xpair = fs.readFileSync(path.join(root, "../../..", "cli/xpair"), "utf8");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error && error.message ? error.message.split("\n")[0] : error}`);
  }
}

function assertPatternBefore(source, first, second, message) {
  const a = source.search(first);
  const b = source.search(second);
  assert.notEqual(a, -1, `missing first pattern: ${first}`);
  assert.notEqual(b, -1, `missing second pattern: ${second}`);
  assert.ok(a < b, message);
}

test("first connection scans Bonjour LAN first and offers discovered host rows (Q0382/Q0384)", () => {
  assert.match(app, /WELCOME: 0,[\s\S]*CONSENT_CRASH: 1,[\s\S]*CONSENT_ANALYTICS: 2,[\s\S]*DISCOVER: 3,[\s\S]*UPDATE: 4,[\s\S]*WAIT_PERM: 5,/);
  assert.match(app, /const \[selectedHost, setSelectedHost\] = useState<DiscoveredHost \| null>\(null\);/);
  assert.match(app, /const setSelected = useCallback\(\(host: DiscoveredHost \| null\) => \{/);
  assert.match(app, /w\.index === 3 && \([\s\S]*<StepDiscover[\s\S]*selected=\{selectedHost\}[\s\S]*setSelected=\{setSelected\}/);

  assert.match(stepDiscover, /window\.remotepair\.discover\(\)/);
  assert.match(stepDiscover, /for \(const peer of res\.peers \|\| \[\]\)/);
  assert.match(stepDiscover, /byId\.set\(host\.id, host\)/);
  assert.match(stepDiscover, /transport: peer\.source === "tailscale" \? "Tailscale" : "LAN"/);
  assert.match(stepDiscover, /onClick=\{onSelect\}/);
  assert.match(stepDiscover, /selected=\{selected\?\.id === h\.id\}/);

  assert.match(xpair, /RP_BONJOUR_TYPE="_xpair\._tcp"/);
  assert.match(xpair, /dns-sd -t "\$timeout" -B "\$RP_BONJOUR_TYPE"/);
  assertPatternBefore(
    xpair,
    /for bonjour_type in "\$RP_BONJOUR_TYPE" "\$RP_LEGACY_BONJOUR_TYPE"/,
    /Tailscale: parse `tailscale status --json` peers/,
    "xpair discover must collect Bonjour LAN candidates before Tailscale candidates",
  );
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall LAN-first onboarding tests passed");
