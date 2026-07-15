const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const repoRoot = path.join(root, "..", "..", "..", "..");
const patch = fs.readFileSync(
  path.join(root, "..", "patches", "zz-remotepair-ide-frontend.patch"),
  "utf8",
);
const bridge = fs.readFileSync(path.join(root, "onboarding-bridge.js"), "utf8");
const launcher = fs.readFileSync(path.join(root, "..", "..", "..", "cli", "xpair-launch"), "utf8");
const hostApp = fs.readFileSync(path.join(repoRoot, "host/onboarding/src/App.tsx"), "utf8");
const hostStepEngine = fs.readFileSync(
  path.join(repoRoot, "host/onboarding/src/components/onboarding/host/StepEngine.tsx"),
  "utf8",
);
const engineGuard = fs.readFileSync(path.join(repoRoot, "host/app/EngineGuard.swift"), "utf8");

function addedFileSection(fileName) {
  const marker = `diff --git a/${fileName} b/${fileName}`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `missing patch section for ${fileName}`);
  const next = patch.indexOf("\ndiff --git ", start + marker.length);
  return patch.slice(start, next === -1 ? patch.length : next);
}

const picker = addedFileSection("src/vs/workbench/contrib/terminal/browser/remotePairSessionPicker.ts");

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

test("Codex is supported by the terminal/session flow and host-owned install/auth checks (Q0540)", () => {
  assert.match(
    picker,
    /export type SessionKind = 'claude' \| 'shell' \| 'codex' \| 'gemini';/,
    "New Session picker/session kind model must include codex",
  );
  assert.match(hostApp, /w\.index === ENGINE_IDX && \([\s\S]*<StepEngine selected=\{engines\} setSelected=\{setEngines\} \/>/);
  assert.match(hostStepEngine, /const ORDER: EngineKey\[\] = \["claude", "codex", "opencode", "shell"\]/);
  assert.match(hostStepEngine, /codex: Bot/);
  assert.match(hostStepEngine, /window\.xpair\.engineStatus\(e\)/);
  assert.match(hostStepEngine, /window\.xpair\.installEngine\(engine\)/);
  assert.match(hostStepEngine, /window\.xpair\.setEngineAuth\(engine, apiKey\.trim\(\)\)/);
  assert.match(bridge, /const ENGINES = new Set\(\["claude", "codex", "opencode"\]\)/);
  assert.match(bridge, /codex:\s*\n\s*PATH_PREFIX \+/);
  assert.match(bridge, /command -v codex/);
  assert.match(bridge, /codex login status/);
  assert.match(bridge, /\.codex\/auth\.json/);
  assert.doesNotMatch(bridge, /\b(?:ENGINE_INSTALL|ENGINE_AUTH_WRITE)\b|codex login --with-api-key/);
  assert.match(engineGuard, /engine == "claude" \|\| engine == "codex" \|\| engine == "opencode"/);
  assert.match(engineGuard, /case "codex":[\s\S]*command -v codex[\s\S]*codex login status/);
  assert.match(engineGuard, /case "codex":[\s\S]*bash -c 'set -o pipefail; curl -fsSL https:\/\/chatgpt\.com\/codex\/install\.sh \| CODEX_NON_INTERACTIVE=1 sh'/);
  assert.match(engineGuard, /case "codex":[\s\S]*codex login --with-api-key/);
  assert.match(launcher, /printf 'Agent engine:\\n  \[1\] Claude Code.*\[2\] Codex.*\[3\] OpenCode/s);
  assert.match(launcher, /codex\)\s+respawn_body_codex ;;/);
  assert.match(launcher, /codex --dangerously-bypass-approvals-and-sandbox resume --last/);
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall Codex support tests passed");
process.exit(failed ? 1 : 0);
