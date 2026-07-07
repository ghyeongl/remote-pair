const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const preload = fs.readFileSync(path.join(root, "onboarding-preload.cjs"), "utf8");
const main = fs.readFileSync(path.join(root, "onboarding-main.cjs"), "utf8");
const globals = fs.readFileSync(path.join(root, "onboarding-webview/src/global.d.ts"), "utf8");
const bridge = require("./onboarding-bridge.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - renderer bridge surface is frozen`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

function sorted(values) {
  return [...values].sort();
}

function extractPreloadRpcMethods() {
  const methods = [];
  for (const match of preload.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:[^\n]*=>\s*rp\('([^']+)'/gm)) {
    assert.equal(match[1], match[2], `preload key ${match[1]} must call matching rp method ${match[2]}`);
    methods.push(match[1]);
  }
  return sorted(methods);
}

function extractRendererMethods() {
  const match = main.match(/const RENDERER_METHODS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, "onboarding-main.cjs must define RENDERER_METHODS");
  return sorted([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function extractGlobalRpcMethods() {
  assert.match(globals, /remotepair: \{/);
  const methods = [...globals.matchAll(/^      ([A-Za-z_$][\w$]*)\s*:/gm)]
    .map((m) => m[1])
    .filter((name) => name !== "complete");
  return sorted(methods);
}

test("preload, global.d.ts, and IPC allowlist expose the same renderer RPC methods", () => {
  const preloadRpc = extractPreloadRpcMethods();
  const globalRpc = extractGlobalRpcMethods();
  const allowlist = extractRendererMethods();

  assert.deepEqual(globalRpc, preloadRpc, "global.d.ts must declare exactly the preload rp methods");
  assert.deepEqual(allowlist, preloadRpc, "RENDERER_METHODS must mirror the preload rp methods");

  assert.match(preload, /complete:\s*\(\)\s*=>\s*\{[\s\S]*ipcRenderer\.invoke\('onboarding:complete'\)/);
  assert.match(globals, /complete: \(\) => Promise<void>/);
  assert.equal(allowlist.includes("complete"), false, "complete uses onboarding:complete, not rp dispatch");
});

test("bridge exports are a superset of renderer RPC methods and keep launch helpers bridge-only", () => {
  const allowlist = extractRendererMethods();
  const bridgeFunctions = Object.entries(bridge)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name);

  for (const name of allowlist) {
    assert.ok(bridgeFunctions.includes(name), `bridge must export renderer method ${name}`);
  }

  const bridgeOnly = [
    "sshReachable",
    "hostPermissions",
    "hostEngineStatus",
    "hostEnvEngine",
    "spawnEnv",
    "sshFailureKind",
    "confirmGatewayBaseline",
  ];
  for (const name of bridgeOnly) {
    assert.ok(bridgeFunctions.includes(name), `bridge-only helper ${name} must remain exported`);
    assert.equal(allowlist.includes(name), false, `${name} must not be renderer-callable`);
  }
});

test("unknown renderer IPC methods are rejected without dispatching bridge exports", () => {
  assert.match(main, /if \(!method \|\| !RENDERER_METHODS\.has\(method\)\) \{[\s\S]*return \{ error: 'unknown method' \}/);
  assert.doesNotMatch(main, /Object\.prototype\.hasOwnProperty\.call\(bridge, method\)/);
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
