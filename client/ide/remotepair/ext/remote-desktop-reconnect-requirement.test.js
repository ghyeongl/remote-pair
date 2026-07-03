const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rp-rd-reconnect-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.REMOTE_HOST = "same-host";
fs.mkdirSync(path.join(TMP_HOME, ".xpair/host"), { recursive: true });

const TEST_RD_TOKEN = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const spawnedChildren = [];
const tokenReadCommands = [];
const postedMessages = [];
const scheduledTimers = [];
let nextLocalPort = 32000;

function fakeSpawn(cmd, args) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.cmd = cmd;
  child.args = args;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  if (cmd === "ssh" && Array.isArray(args) && args[args.length - 1] === "cat ~/.xpair/host/rd-session-token") {
    tokenReadCommands.push(args);
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from(`${TEST_RD_TOKEN}\n`));
      child.emit("close", 0);
    });
    return child;
  }
  spawnedChildren.push(child);
  return child;
}

const fakeNet = {
  createServer() {
    return {
      _port: 0,
      listen(_port, _host, cb) {
        this._port = nextLocalPort++;
        if (typeof cb === "function") cb();
      },
      address() {
        return { port: this._port };
      },
      close(cb) {
        if (typeof cb === "function") cb();
      },
      on() {},
    };
  },
};

const fakeWebview = {
  html: "",
  options: {},
  cspSource: "vscode-webview://test",
  asWebviewUri(uri) {
    return uri;
  },
  postMessage(message) {
    postedMessages.push(message);
    return Promise.resolve(true);
  },
  onDidReceiveMessage() {
    return { dispose() {} };
  },
};

const fakePanel = {
  visible: true,
  viewColumn: 1,
  webview: fakeWebview,
  reveal() {},
  dispose() {},
  onDidChangeViewState() {
    return { dispose() {} };
  },
  onDidDispose() {
    return { dispose() {} };
  },
};

const fakeVscode = {
  ViewColumn: { Active: 1 },
  StatusBarAlignment: { Left: 0, Right: 1 },
  ThemeColor: class ThemeColor {},
  Uri: {
    joinPath(...parts) {
      return { fsPath: parts.map((part) => String(part && part.fsPath ? part.fsPath : part)).join(path.sep) };
    },
  },
  window: {
    createOutputChannel() {
      return { appendLine() {} };
    },
    createWebviewPanel() {
      return fakePanel;
    },
    tabGroups: { all: [] },
    showInformationMessage() {},
    showErrorMessage() {},
  },
  commands: {
    executeCommand() {
      return Promise.resolve();
    },
    registerCommand() {
      return { dispose() {} };
    },
  },
  workspace: {
    getConfiguration() {
      return {
        get(_key, fallback) {
          return fallback;
        },
        update() {
          return Promise.resolve();
        },
      };
    },
  },
  extensions: { getExtension() { return null; } },
  ConfigurationTarget: { Global: 1 },
  WebviewPanelSerializer: class WebviewPanelSerializer {},
};

// Real bridge with only the roaming guard overridden (this reconnect test does not exercise
// gateway-MAC roaming; the guard must simply allow so the RD token read / tunnel path runs).
const realBridge = require("./onboarding-bridge.js");
const fakeBridge = {
  ...realBridge,
  gatewayMacStatus() {
    return { allowed: true, state: "same", current: "aa:bb:cc:dd:ee:ff", stored: "aa:bb:cc:dd:ee:ff", err: "" };
  },
};

const realLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  if (request === "child_process") return { spawn: fakeSpawn };
  if (request === "net") return fakeNet;
  if (request === "./onboarding-bridge.js") return fakeBridge;
  return realLoad.call(this, request, parent, isMain);
};

const extension = require("./extension.js");
Module._load = realLoad;

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
global.setTimeout = function fakeSetTimeout(fn, delay, ...args) {
  function timer() {
    if (!timer.cleared) fn(...args);
  }
  timer.delay = delay;
  timer.cleared = false;
  scheduledTimers.push(timer);
  return timer;
};
global.clearTimeout = function fakeClearTimeout(timer) {
  if (timer) timer.cleared = true;
};

function waitForAsync() {
  return new Promise((resolve) => realSetTimeout(resolve, 20));
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} - ${error && error.message ? error.message.split("\n")[0] : error}`);
  }
}

function v2ConnectPosts() {
  return postedMessages.filter((message) => message.type === "v2Connect");
}

function latestTimerByDelay(delay) {
  for (let i = scheduledTimers.length - 1; i >= 0; i -= 1) {
    if (scheduledTimers[i].delay === delay && !scheduledTimers[i].cleared) return scheduledTimers[i];
  }
  return null;
}

(async () => {
  await test("Q0548/Q0552 RD restores and reconnects to the same host with a fresh tunnel", async () => {
    const panel = new extension.RemoteDesktopPanel({ fsPath: "/test/ext" });

    panel.restore(fakePanel);
    await waitForAsync();

    assert.equal(tokenReadCommands.length, 1, "visible restored RD panel should read the host RD token");
    assert.equal(spawnedChildren.length, 1, "visible restored RD panel should start one tunnel");
    assert.equal(spawnedChildren[0].cmd, "ssh");
    assert.ok(spawnedChildren[0].args.includes("same-host"), "first tunnel must target the configured host");
    assert.ok(
      spawnedChildren[0].args.some((arg) => /^\d+:127\.0\.0\.1:\d+$/.test(arg)),
      "first tunnel must forward a local signaling port to the host RD signaling port",
    );

    latestTimerByDelay(1200)();
    assert.equal(v2ConnectPosts().length, 1, "restored RD should tell the webview to connect after tunnel settle");
    assert.match(v2ConnectPosts()[0].signalUrl, new RegExp(`^ws://127\\.0\\.0\\.1:\\d+/\\?token=${TEST_RD_TOKEN}&fps=30&bitrate=4000000&scale=1$`));

    const firstChild = spawnedChildren[0];
    panel.onMessage({ type: "v2Error", detail: "peer connection failed" });
    assert.equal(firstChild.killed, true, "RD error should clean up the current tunnel before retry");

    await panel.reveal();
    await waitForAsync();

    assert.equal(tokenReadCommands.length, 2, "retry should read the current host RD token again");
    assert.equal(spawnedChildren.length, 2, "revealing after an RD error should start a fresh tunnel");
    assert.ok(spawnedChildren[1].args.includes("same-host"), "retry tunnel must target the same configured host");
    assert.notEqual(spawnedChildren[1], firstChild, "retry must use a new child process");

    latestTimerByDelay(1200)();
    assert.equal(v2ConnectPosts().length, 2, "fresh retry tunnel should reconnect the webview");
    assert.match(v2ConnectPosts()[1].signalUrl, new RegExp(`^ws://127\\.0\\.0\\.1:\\d+/\\?token=${TEST_RD_TOKEN}&fps=30&bitrate=4000000&scale=1$`));
  });

  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch (_error) {
  }

  console.log(`REDGREEN ${passed} ${failed}`);
  process.exit(failed ? 1 : 0);
})();
