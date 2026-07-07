const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const stepEngine = fs.readFileSync(
  path.join(root, "src/components/onboarding/host/StepEngine.tsx"),
  "utf8",
);
const hostAppRoot = path.resolve(root, "../app");
const engineGuard = fs.readFileSync(path.join(hostAppRoot, "EngineGuard.swift"), "utf8");
const onboardingWindow = fs.readFileSync(path.join(hostAppRoot, "OnboardingWindow.swift"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - selected engines are gated on installed+authed`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("Q0541 US-003 host onboarding checks, installs, authenticates, and rechecks ready engines", () => {
  assert.match(
    app,
    /w\.index === ENGINE_IDX && engines\.size === 0/,
    "Engine step Next must remain disabled until at least one selected engine reports ready",
  );
  assert.match(
    stepEngine,
    /const ready = new Set\(ORDER\.filter\(\(id\) => isReady\(nextStatuses\[id\]\)\)\)/,
    "Engine selection set must be derived only from installed+authenticated statuses",
  );
  assert.match(
    stepEngine,
    /const nextSelected = new Set\(\[...selected\]\.filter\(\(id\) => ready\.has\(id\)\)\)/,
    "Previously selected engines must stop counting if a fresh probe says they are not ready",
  );
  assert.match(
    stepEngine,
    /window\.xpair\.installEngine\(engine\)[\s\S]*await probe\(engine\)/,
    "Install action must re-check the same focused engine after installation",
  );
  assert.match(
    stepEngine,
    /window\.xpair\.setEngineAuth\(engine, apiKey\.trim\(\)\)[\s\S]*await probe\(engine\)/,
    "API key sign-in must re-check the same focused engine after auth setup",
  );
  assert.ok(
    stepEngine.includes("re-check") && stepEngine.includes("onClick={() => void probe(engine)}"),
    "External login path must offer a re-check action for the same focused engine",
  );

  for (const engine of ["claude", "codex", "opencode"]) {
    assert.ok(stepEngine.includes(`"${engine}"`), `${engine} must be selectable in host onboarding`);
    assert.ok(engineGuard.includes(`engine == "${engine}"`), `${engine} must be accepted by the host guard`);
    assert.ok(engineGuard.includes(`command -v ${engine}`), `${engine} install probe must check the real binary`);
  }
  assert.match(engineGuard, /RP_ENGINE_AUTHED=1/, "The host guard must report an authenticated state");
  assert.match(engineGuard, /bash -c 'set -o pipefail; curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash'/, "Claude install guidance/action must exist");
  assert.match(engineGuard, /bash -c 'set -o pipefail; curl -fsSL https:\/\/chatgpt\.com\/codex\/install\.sh \| CODEX_NON_INTERACTIVE=1 sh'/, "Codex install guidance/action must exist");
  assert.match(engineGuard, /bash -c 'set -o pipefail; curl -fsSL https:\/\/opencode\.ai\/install \| bash -s -- --no-modify-path'/, "opencode install guidance/action must exist");
  assert.match(
    onboardingWindow,
    /case "engineStatus":[\s\S]*EngineGuard\.status\(engine\)/,
    "WK bridge must wire engineStatus to the real host guard",
  );
  assert.match(
    onboardingWindow,
    /case "installEngine":[\s\S]*EngineGuard\.install\(engine\)/,
    "WK bridge must wire installEngine to the real host guard",
  );
  assert.match(
    onboardingWindow,
    /case "setEngineAuth":[\s\S]*EngineGuard\.setAuth\(engine, key: key\)/,
    "WK bridge must wire setEngineAuth to the real host guard",
  );
  assert.match(
    onboardingWindow,
    /case "setEngine":[\s\S]*EngineGuard\.persist\(engine\)/,
    "WK bridge must persist ready engine choices to the host env",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
