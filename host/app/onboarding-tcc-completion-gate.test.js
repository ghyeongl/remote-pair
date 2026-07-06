const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "host/onboarding/src/App.tsx"), "utf8");
const singlePerm = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepSinglePerm.tsx"),
  "utf8",
);
const onboardingWindow = fs.readFileSync(
  path.join(root, "host/app/OnboardingWindow.swift"),
  "utf8",
);
const permissions = fs.readFileSync(path.join(root, "host/app/Permissions.swift"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - required TCC gates block onboarding progress and completion`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function extractCompleteCase(source) {
  const match = stripLineComments(source).match(
    /case "complete":(?<body>[\s\S]*?)(?:\n\s*case "|\n\s*default:)/,
  );
  assert.ok(match, 'OnboardingWindow.swift must handle the "complete" bridge message');
  return match.groups.body;
}

function extractFinishBody(source) {
  const match = stripLineComments(source).match(
    /private func finish\(\) \{(?<body>[\s\S]*?)\n    \}/,
  );
  assert.ok(match, "OnboardingWindow.swift must keep completion side effects in finish()");
  return match.groups.body;
}

function hasRequiredTccGateBeforeCompletionSideEffects(source) {
  const completeCase = extractCompleteCase(source);
  const finishBody = extractFinishBody(source);

  const completeGate = completeCase.indexOf("Permissions.allGranted()");
  const completeFinish = completeCase.indexOf("finish()");
  const completeCaseGatesFinish =
    completeGate !== -1 && completeFinish !== -1 && completeGate < completeFinish;

  const finishGate = finishBody.indexOf("Permissions.allGranted()");
  const firstCompletionSideEffect = Math.min(
    ...["completed = true", "window.close()", "onComplete()"]
      .map((needle) => finishBody.indexOf(needle))
      .filter((index) => index !== -1),
  );
  const finishGatesSideEffects =
    finishGate !== -1 && firstCompletionSideEffect !== Infinity && finishGate < firstCompletionSideEffect;

  return completeCaseGatesFinish || finishGatesSideEffects;
}

test("Q0443 host onboarding must not proceed/complete while required TCC permissions are unresolved", () => {
  assert.match(
    permissions,
    /static func allGranted\(\) -> Bool \{\s*axTrusted\(\) && srGranted\(\) && loginGranted\(\)\s*\}/,
    "required native gate must mean Accessibility, Screen Recording, and Remote Login",
  );
  assert.match(
    singlePerm,
    /export const REQUIRED_PERMS: PermKey\[\] = \["login", "ax", "sr"\]/,
    "React permissions readiness must require Remote Login, AX, and SR",
  );
  assert.match(
    app,
    /inPerms && isRequiredPerm\(currentPermKey\) && !currentPermGranted/,
    "Required permission step Next must stay disabled until the current required permission is resolved",
  );
  assert.ok(
    hasRequiredTccGateBeforeCompletionSideEffects(onboardingWindow),
    "WK complete bridge can finish/onComplete without re-checking Permissions.allGranted(), so setup may complete while AX/SR is unresolved",
  );
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
