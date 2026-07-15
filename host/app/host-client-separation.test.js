const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const appDelegate = fs.readFileSync(path.join(__dirname, "AppDelegate.swift"), "utf8");
const config = fs.readFileSync(path.join(__dirname, "Config.swift"), "utf8");
const onboardingWindow = fs.readFileSync(path.join(__dirname, "OnboardingWindow.swift"), "utf8");
const screenServer = fs.readFileSync(path.join(__dirname, "ScreenServer.swift"), "utf8");
const captureEngine = fs.readFileSync(path.join(__dirname, "CaptureEngine.swift"), "utf8");
const captureControlTests = fs.readFileSync(path.join(__dirname, "CaptureControlTests.swift"), "utf8");
const lanBeacon = fs.readFileSync(path.join(__dirname, "LanBeacon.swift"), "utf8");
// The redesign merged the old StepWaiting into the host StepBroadcast (the pairing/broadcast step).
const stepBroadcast = fs.readFileSync(
  path.join(root, "host/onboarding/src/components/onboarding/host/StepBroadcast.tsx"),
  "utf8",
);
const clientBridge = fs.readFileSync(
  path.join(root, "client/ide/remotepair/ext/onboarding-bridge.js"),
  "utf8",
);
const clientExtension = fs.readFileSync(
  path.join(root, "client/ide/remotepair/ext/extension.js"),
  "utf8",
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name} - host and client responsibilities remain separated`);
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

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notStrictEqual(start, -1, `missing ${signature}`);
  const brace = source.indexOf("{", start);
  assert.notStrictEqual(brace, -1, `missing body for ${signature}`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

test("Q0343 host onboarding does not install, open, or operate the client workbench", () => {
  assert.match(config, /let ROLE_FILE = .*host\|client\|both/);
  assert.match(config, /var isHostRole: Bool \{[\s\S]*return role == "host" \|\| role == "both" \|\| role\.isEmpty[\s\S]*\}/);
  assert.match(config, /var isClientRole: Bool \{ currentRole\(\) == "client" \}/);

  assert.match(appDelegate, /if isHostRole \{ lanBeacon\.ensureAdvertising\(\) \}/);
  assert.match(lanBeacon, /"role": role\.isEmpty \? "host" : role/);
  assert.match(screenServer, /Screen sharing belongs to the host app, not the client\./);

  // The host pairing/broadcast step drives ONLY the host bridge (window.xpair) and must never invoke
  // client-side operations — host and client responsibilities stay separated.
  assert.match(stepBroadcast, /window\.xpair/);
  assert.doesNotMatch(stepBroadcast, /installHost|openRemoteDesktop|vscode\.openFolder|xpair onboard/);

  const bridgeShim = extractFunction(onboardingWindow, "private static let bridgeShim");
  assert.doesNotMatch(bridgeShim, /installHost|openRemoteDesktop|connectHost|openFileBrowser|vscode\.openFolder/);

  const completeCase = stripLineComments(onboardingWindow).match(
    /case "complete":(?<body>[\s\S]*?)(?:\n\s*default:)/,
  );
  assert.ok(completeCase, 'OnboardingWindow.swift must handle the "complete" bridge message');
  assert.match(completeCase.groups.body, /finish\(\)/);

  const finishBody = extractFunction(stripLineComments(onboardingWindow), "private func finish()");
  assert.doesNotMatch(finishBody, /NSWorkspace\.shared\.open|Process\(\)|installHost|openRemoteDesktop|vscode\.openFolder/);

  assert.match(clientBridge, /async installHost\(\{ host, user, password, force \} = \{\}\)/);
  assert.match(clientExtension, /vscode\.commands\.registerCommand\("remotepair\.openRemoteDesktop"/);
  // The client (not the host) operates the workbench's folder roots. Per round-1
  // decision #3 (Xpair Sessions only — native workbench surfaces stay hidden during
  // owned Xpair flows) the connect flow routes through Xpair surfaces and reconciles
  // Browser roots via updateWorkspaceFolders, rather than opening a separate
  // open-remote-ssh window. See ssh-connect-flow-requirement.test.js, which asserts
  // the client extension must NOT contain vscode.openFolder.
  assert.match(clientExtension, /vscode\.workspace\.updateWorkspaceFolders/);
  assert.doesNotMatch(clientExtension, /vscode\.openFolder/);
});

test("RD capture failures are forwarded as structured sidecar diagnostics", () => {
  assert.match(captureEngine, /enum CaptureFailureKind/);
  assert.match(captureEngine, /case startFailed = "start-failed"/);
  assert.match(captureEngine, /case encoderFailed = "encoder-failed"/);
  assert.match(captureEngine, /eventSink: \(\(CaptureEvent\) -> Void\)\? = nil/);
  assert.match(captureEngine, /reportCaptureError\(\s*kind: \.startFailed/);
  assert.match(screenServer, /handleCaptureEvent\(_ event: CaptureEngine\.CaptureEvent, generation: Generation\)/);
  assert.match(screenServer, /writeEvent\(gen: gen, kind: kind, reason: reason\)/);
  assert.match(screenServer, /"event": "capture-error"/);
  assert.match(screenServer, /sidecarControlWriteFD/);
  assert.match(screenServer, /sidecarControlWriteQueue/);
  assert.match(screenServer, /"RP_AU_CONTROL_FD=3"/);
  const controlWrite = extractFunction(screenServer, "private func writeFramedSidecarJSON");
  assert.match(controlWrite, /sidecarControlWriteQueue\.async/);
  assert.doesNotMatch(controlWrite, /auWriteQueue\.async/);
});

test("RD signaling token is host-generated, persisted 0600, and read by client over SSH", () => {
  assert.match(config, /RD_SESSION_TOKEN_FILE = .*rd-session-token/);
  assert.match(screenServer, /SecRandomCopyBytes\(kSecRandomDefault/);
  assert.match(screenServer, /open\(RD_SESSION_TOKEN_FILE, O_WRONLY \| O_CREAT \| O_TRUNC, mode\)/);
  assert.match(screenServer, /fchmod\(fd, mode\)/);
  assert.match(screenServer, /let argv = \[bin, "serve-webrtc", "--token", "@\\\(RD_SESSION_TOKEN_FILE\)"\]/);
  assert.match(screenServer, /127\.0\.0\.1:8890 is reachable by any process/);
  assert.match(clientExtension, /RD_SESSION_TOKEN_REMOTE_FILE = "~\/\.xpair\/host\/rd-session-token"/);
  assert.match(clientExtension, /async function readRdSessionToken\(host\)/);
  assert.match(clientExtension, /cat \$\{RD_SESSION_TOKEN_REMOTE_FILE\}/);
  assert.match(clientExtension, /RD_TOKEN_FILE_NOT_READY_RE/);
  assert.match(clientExtension, /isRetryableRdTokenReadFailure/);
  assert.match(clientExtension, /error\.retryable = true/);
  assert.match(clientExtension, /readRdSessionToken\(host\)/);
  assert.doesNotMatch(clientExtension, /makeRdSessionToken/);
});

test("RD capture replacement uses generation so stale pending starts and stops cannot cancel newer starts", () => {
  assert.match(screenServer, /private var state: CaptureState = \.idle/);
  assert.match(screenServer, /private var pendingStartAck:/);
  assert.match(screenServer, /private let controlQueue = DispatchQueue/);
  assert.match(screenServer, /private func apply\(_ event: CaptureControlEvent\)/);
  assert.match(screenServer, /gen < active/);
  assert.match(screenServer, /superseded\(activeGen: active\)/);
  assert.match(screenServer, /case let \.starting\(active, _\) = state, active == gen/);
  assert.match(captureEngine, /private var startGeneration: UInt64 = 0/);
  assert.match(captureEngine, /token: StartToken/);
  assert.match(captureEngine, /guard !token\.cancelled else \{ return \}/);
  assert.match(captureEngine, /guard self\.startGeneration == generation else \{ return \}/);
  const applyStop = extractFunction(screenServer, "private func applyStop");
  assert.match(
    applyStop,
    /guard active == gen else \{[\s\S]*writeAck\(gen: gen, rid: rid, op: \.stop, result: \.superseded\(activeGen: active\)\)[\s\S]*return[\s\S]*\}/,
  );
  assert.match(screenServer, /writeAck\(gen: ack\.gen, rid: ack\.rid, op: \.start, result: \.superseded\(activeGen: newGen\)\)/);
  assert.match(screenServer, /"ack": op\.rawValue/);
  assert.match(captureControlTests, /stale_start_is_superseded_not_applied/);
  assert.match(captureControlTests, /newer_start_cancels_pending_starting/);
  assert.match(captureControlTests, /late_start_completion_after_supersede_noops/);
  assert.match(captureControlTests, /stale_stop_is_acked_not_applied/);
  assert.match(captureControlTests, /stop_while_starting_cancels_and_acks/);
  assert.match(captureControlTests, /every_op_produces_exactly_one_ack/);
  assert.match(captureControlTests, /duplicate_start_same_gen_running_reacks_started/);
  assert.match(captureControlTests, /engine_error_while_running_emits_unsolicited_event_not_ack/);
  assert.doesNotMatch(screenServer, /activeCaptureGeneration/);
  assert.doesNotMatch(screenServer, /pendingCaptureStartGeneration/);
});

console.log(`${__filename}`);
console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
