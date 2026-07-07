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
const onboardingMain = fs.readFileSync(path.join(root, "onboarding-main.cjs"), "utf8");
const extension = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const cli = fs.readFileSync(path.join(root, "../../../cli/xpair"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - CLI-dependent onboarding flow is gated on xpair availability`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("Q0533/Q0534/Q0536/Q0537 xpair CLI availability is a native pre-workbench hard gate", () => {
  assert.match(
    bridge,
    /async cliReady\(\)[\s\S]*const bin = rpBinAbs\(\);[\s\S]*%ProgramFiles%\\\\Xpair\\\\xpair\.exe[\s\S]*~\/\.local\/bin\/xpair[\s\S]*run\(bin, \["status"\]\)[\s\S]*cliSupportsServing\(\)/,
    "cliReady must resolve a real xpair binary, prove it with xpair status, and reject CLIs that drop serving",
  );
  assert.match(
    bridge,
    /function cliSupportsServing\(\)[\s\S]*rpBinAbs\(\)[\s\S]*readFileSync\(bin, "utf8"\)\.includes\('d\.get\("serving"\)'\)/,
    "cliReady must feature-detect the serving field surface instead of accepting old win32 CLIs",
  );
  assert.match(
    bridge,
    /async installCli\(\)[\s\S]*process\.platform === "win32"[\s\S]*const bin = rpBinAbs\(\)[\s\S]*Install the Xpair CLI \(\.msi\) first[\s\S]*run\(bin, \["status"\]\)[\s\S]*Xpair CLI found but not working[\s\S]*OPEN_DOWNLOAD[\s\S]*CLI_DOWNLOAD_URL[\s\S]*shared", "install\.sh"[\s\S]*run\("bash", \[installer, "--role", "client"\][\s\S]*if \(!rpBinAbs\(\)\)/,
    "installCli must return MSI guidance on Windows, probe existing MSI usability, and use the bundled installer elsewhere",
  );

  assert.match(
    onboardingMain,
    /const clientEnv = readClientEnv\(\)[\s\S]*const host = configuredRemoteHost\(clientEnv\)[\s\S]*if \(!host\) return START_STEP\.WELCOME[\s\S]*if \(!\(await cliProbeReady\(probeBridge\)\)\) return START_STEP\.WELCOME[\s\S]*if \(process\.platform !== 'darwin'\)[\s\S]*return null/,
    "non-Darwin pre-workbench gating must require a configured host and usable CLI before skipping Darwin-only probes",
  );
  assert.match(
    onboardingMain,
    /if \(!\(await cliProbeReady\(probeBridge\)\)\) return START_STEP\.WELCOME/,
    "firstFailingGuard must stop at Welcome when the CLI is missing",
  );
  assert.match(
    onboardingMain,
    /if \(!\(await cliProbeReady\(probeBridge\)\)\) return START_STEP\.WELCOME[\s\S]*probeBridge\.sshReachable\(host\)/,
    "CLI probe failures must happen before any remote host probe",
  );
  assert.match(
    stepDiscover,
    /const cli = await window\.remotepair\.cliReady\(\)[\s\S]*if \(!cli\.ready\)[\s\S]*window\.remotepair\.installCli\(\)[\s\S]*const res = await window\.remotepair\.discover\(\)/,
    "the renderer must install/gate the CLI before discovery so fresh clients do not see a false empty scan",
  );
  assert.match(stepDiscover, /setScanError\(res\.err\)/, "discover errors must be surfaced");
  assert.doesNotMatch(app, /CLI_DEPENDENT_STEPS|cliGateActive|installCliNow|StepConnect/);

  assert.match(
    extension,
    /term\.sendText\("xpair launch", false\)/,
    "Sessions must stage xpair launch for the user to enter the launch flow",
  );
  assert.match(
    cli,
    /launch\)\s+shift; cmd_launch "\$@"[\s\S]*\*\) echo "unknown command: \$1" >&2[\s\S]*exit 2/,
    "xpair launch must route to cmd_launch and unknown commands must fail",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
