const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const repoRoot = path.join(root, "..", "..", "..", "..");
const clientApp = fs.readFileSync(path.join(root, "onboarding-webview/src/App.tsx"), "utf8");
const onboardingMain = fs.readFileSync(path.join(root, "onboarding-main.cjs"), "utf8");
const bridge = fs.readFileSync(path.join(root, "onboarding-bridge.js"), "utf8");
const globals = fs.readFileSync(path.join(root, "onboarding-webview/src/global.d.ts"), "utf8");
const hostApp = fs.readFileSync(path.join(repoRoot, "host/onboarding/src/App.tsx"), "utf8");
const hostStepEngine = fs.readFileSync(
  path.join(repoRoot, "host/onboarding/src/components/onboarding/host/StepEngine.tsx"),
  "utf8",
);
const hostEngineGuard = fs.readFileSync(path.join(repoRoot, "host/app/EngineGuard.swift"), "utf8");

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

test("Q0545 client flow has no engine step, but native resume still checks host.env engine", () => {
  assert.equal(
    fs.existsSync(path.join(root, "onboarding-webview/src/components/onboarding/client/StepEngine.tsx")),
    false,
  );
  assert.doesNotMatch(clientApp, /S\.ENGINE|<StepEngine|hostEngineStatus|installHostEngine|setHostEngineAuth/);
  assert.match(clientApp, /engine: S\.DISCOVER/);
  assert.match(onboardingMain, /ENGINE: 'engine'/);
  assert.match(onboardingMain, /const SESSION_ENGINES = new Set\(\['claude', 'shell', 'codex', 'opencode'\]\)/);
  assert.match(onboardingMain, /configuredHostEngine\(host, probeBridge\)/);
  assert.match(onboardingMain, /probeBridge\.hostEngineStatus\(engineToCheck\)/);
});

test("Q0545 engine guard failure surfaces the host-onboarding CTA, not a bare Discover", () => {
  // R15-5: `?startStep=engine` must not be silently collapsed into a normal Discover landing — an
  // already-paired host would just re-pair and re-hit the guard. App preserves the reason and threads
  // an engineRecovery flag into StepDiscover, which renders a host-onboarding CTA (engine setup lives
  // in the host app; the client has no engine step).
  const discover = fs.readFileSync(
    path.join(root, "onboarding-webview/src/components/onboarding/client/StepDiscover.tsx"),
    "utf8",
  );
  assert.match(clientApp, /function initialStartReason\(\)/);
  assert.match(clientApp, /engineRecovery\] = useState\(\(\) => initialStartReason\(\) === "engine"\)/);
  assert.match(clientApp, /<StepDiscover[\s\S]*engineRecovery=\{engineRecovery\}/);
  assert.match(discover, /engineRecovery\?: boolean/);
  assert.match(discover, /engineRecovery &&[\s\S]*discover\.engineRecovery\.title[\s\S]*openHostOnboarding/);
});

test("Q0545 host onboarding owns the 11-step engine setup gate", () => {
  assert.match(hostApp, /const CONSENT_ANALYTICS_IDX = 2;/);
  assert.match(hostApp, /const PERM_START = 3;/);
  assert.match(hostApp, /const ENGINE_IDX = PERM_END \+ 1;/);
  assert.match(hostApp, /const BROADCAST_IDX = ENGINE_IDX \+ 1;/);
  assert.match(hostApp, /const DONE_IDX = BROADCAST_IDX \+ 1;/);
  assert.match(hostApp, /const TOTAL = DONE_IDX \+ 1;/);
  assert.match(hostApp, /w\.index === ENGINE_IDX && engines\.size === 0/);
  assert.match(hostApp, /if \(target >= ENGINE_IDX\) \{[\s\S]*const readyEngines = await probeReadyEngines\(\);[\s\S]*if \(readyEngines\.size === 0\) \{[\s\S]*target = ENGINE_IDX;/);
  // R10-6: skipping the engine step must still persist a default ENGINE (non-destructively) so
  // xpair-launch doesn't fall back to the client/default engine on a host that never wrote one.
  assert.match(hostApp, /else if \(target > ENGINE_IDX\)[\s\S]*persistEngineIfUnset\(primary\)/);
  assert.match(hostApp, /w\.index === ENGINE_IDX && \([\s\S]*<StepEngine selected=\{engines\} setSelected=\{setEngines\} \/>/);
});

test("Q0545 host StepEngine probes, installs, authenticates, and persists supported engines", () => {
  assert.match(hostStepEngine, /const ORDER: EngineKey\[\] = \["claude", "codex", "opencode", "shell"\]/);
  assert.match(hostStepEngine, /window\.xpair\.engineStatus\(e\)/);
  assert.match(hostStepEngine, /await window\.xpair\.setEngine\(e\)|await persistEngine\(primary\)|await persistEngine\(id\)/);
  assert.match(hostStepEngine, /window\.xpair\.installEngine\(engine\)/);
  assert.match(hostStepEngine, /window\.xpair\.setEngineAuth\(engine, apiKey\.trim\(\)\)/);
  assert.match(hostStepEngine, /await probe\(engine\)/);
  assert.match(hostStepEngine, /engine === "codex" \? "sk-\.\.\. \(OpenAI API key\)"/);
});

test("Q0545 client bridge probes host engine readiness while host app owns install/auth", () => {
  assert.match(bridge, /const ENGINES = new Set\(\["claude", "codex", "opencode"\]\)/);
  assert.match(bridge, /const SESSION_ENGINES = new Set\(\[\.\.\.ENGINES, "shell"\]\)/);
  assert.match(bridge, /remoteHost: e\.REMOTE_HOST \|\| "",[\s\S]*engine: e\.ENGINE \|\| "",/);
  assert.match(bridge, /const host = String\(parseEnv\(clientEnvPath\(\)\)\.REMOTE_HOST \|\| ""\)\.trim\(\)/);
  assert.match(bridge, /async hostEnvEngine\(hostArg\)[\s\S]*cat|async hostEnvEngine\(hostArg\)[\s\S]*host\.env/);
  assert.match(bridge, /const probe = ENGINE_PROBE\[e\]/);
  assert.match(bridge, /run\("ssh", \[\.\.\.sshProbeOpts\(host, 6\), host, probe\]\)/);
  assert.doesNotMatch(bridge, /\b(?:installHostEngine|setHostEngineAuth|ENGINE_INSTALL|ENGINE_AUTH_WRITE|PATH_PERSIST)\b/);
  assert.match(globals, /getConfig: \(\) => Promise<\{[\s\S]*remoteHost: string[\s\S]*engine: string/);

  assert.match(hostEngineGuard, /static func isKnown\(_ engine: String\) -> Bool \{\s*engine == "claude" \|\| engine == "codex" \|\| engine == "opencode" \|\| engine == "shell"\s*\}/);
  assert.match(hostEngineGuard, /static func status\(_ engine: String\) -> Status/);
  assert.match(hostEngineGuard, /static func install\(_ engine: String\) -> Result/);
  assert.match(hostEngineGuard, /private static let pathPersistScript/);
  assert.match(hostEngineGuard, /static func setAuth\(_ engine: String, key: String\) -> Result/);
  assert.match(hostEngineGuard, /static func persist\(_ engine: String\) -> Result/);
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall Q0545 engine host setup tests passed");
process.exit(failed ? 1 : 0);
