const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rp-tunnel-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
fs.mkdirSync(path.join(TMP_HOME, ".xpair/host"), { recursive: true });

const TEST_RD_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const spawnedChildren = [];
const tokenReadCommands = [];
const scheduledTimers = [];
let nextLocalPort = 31000;
let failTokenRead = false;
let transientTokenReadFailuresRemaining = 0;
const tokenReadResponses = [];
let gatewayMacResponse = { allowed: true, state: "same", current: "aa:bb:cc:dd:ee:ff", stored: "aa:bb:cc:dd:ee:ff", err: "" };
let gatewayMacError = null;
// Delegate to the REAL bridge so ssh-failure classification (host-key taxonomy, key-auth,
// etc.) stays faithful; only gatewayMacStatus is overridden so tests can drive the roaming
// guard. Loaded before the Module._load patch below — onboarding-bridge.js has no load-time
// side effects, so the real child_process/net are harmless at require time.
const realBridge = require("./onboarding-bridge.js");
const fakeBridge = {
  ...realBridge,
  gatewayMacStatus() {
    if (gatewayMacError) throw gatewayMacError;
    return gatewayMacResponse;
  },
};

function fakeSpawn(cmd, args, opts) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.cmd = cmd;
  child.args = args;
  child.opts = opts || {};
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  if (cmd === "ssh" && Array.isArray(args) && args[args.length - 1] === "cat ~/.xpair/host/rd-session-token") {
    tokenReadCommands.push(args);
    process.nextTick(() => {
      const queued = tokenReadResponses.shift();
      if (queued) {
        if (queued.stderr) child.stderr.emit("data", Buffer.from(queued.stderr));
        if (queued.stdout) child.stdout.emit("data", Buffer.from(queued.stdout));
        child.emit("close", queued.code == null ? 0 : queued.code);
      } else if (failTokenRead) {
        child.stderr.emit("data", Buffer.from("cat: ~/.xpair/host/rd-session-token: Permission denied\n"));
        child.emit("close", 1);
      } else if (transientTokenReadFailuresRemaining > 0) {
        transientTokenReadFailuresRemaining -= 1;
        child.stderr.emit(
          "data",
          Buffer.from("sign_and_send_pubkey: signing failed for ED25519 from agent: agent refused operation\n")
        );
        child.emit("close", 255);
      } else {
        child.stdout.emit("data", Buffer.from(`${TEST_RD_TOKEN}\n`));
        child.emit("close", 0);
      }
    });
    return child;
  }
  spawnedChildren.push(child);
  return child;
}

const fakeNet = {
  createServer() {
    const server = {
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
    return server;
  },
};

const postedMessages = [];
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
      return { fsPath: parts.map((part) => String(part)).join(path.sep) };
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

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}\n        ${error && error.message ? error.message : error}`);
  }
}

function resetHarness() {
  spawnedChildren.length = 0;
  tokenReadCommands.length = 0;
  postedMessages.length = 0;
  scheduledTimers.length = 0;
  nextLocalPort = 31000;
  failTokenRead = false;
  transientTokenReadFailuresRemaining = 0;
  tokenReadResponses.length = 0;
  gatewayMacResponse = { allowed: true, state: "same", current: "aa:bb:cc:dd:ee:ff", stored: "aa:bb:cc:dd:ee:ff", err: "" };
  gatewayMacError = null;
}

function makePanel() {
  const panel = new extension.RemoteDesktopPanel({ fsPath: "/test/ext" });
  panel.panel = fakePanel;
  return panel;
}

function errorPosts() {
  return postedMessages.filter((message) => message.type === "status" && message.state === "error");
}

function v2ConnectPosts() {
  return postedMessages.filter((message) => message.type === "v2Connect");
}

function latestTimerByDelay(timers, delay) {
  for (let i = timers.length - 1; i >= 0; i -= 1) {
    if (timers[i].delay === delay && !timers[i].cleared) return timers[i];
  }
  return null;
}

function latestIntervalByDelay(intervals, delay) {
  for (let i = intervals.length - 1; i >= 0; i -= 1) {
    if (intervals[i].delay === delay && !intervals[i].cleared) return intervals[i];
  }
  return null;
}

function ackNegotiatedInput(harness, socketIndex = 0) {
  harness.sockets[socketIndex].emit("message", {
    data: JSON.stringify({ type: "hello-ack", negotiatedInput: true }),
  });
}

function runRemoteDesktopWebview() {
  const script = fs.readFileSync(path.join(__dirname, "media", "remote-desktop.js"), "utf8");
  const posted = [];
  const timers = [];
  const intervals = [];
  const windowListeners = [];
  const documentListeners = new Map();
  const elements = new Map();
  function fakeDataChannel(label, options) {
    return {
      label,
      options,
      readyState: "connecting",
      bufferedAmount: 0,
      sent: [],
      listeners: new Map(),
      addEventListener(type, fn) {
        const existing = this.listeners.get(type) || [];
        existing.push(fn);
        this.listeners.set(type, existing);
      },
      send(message) {
        this.sent.push(message);
      },
    };
  }
  function element(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        id,
        textContent: "",
        style: {},
        srcObject: null,
        className: "",
        readyState: 0,
        classList: {
          add() {},
          remove() {},
        },
        setAttribute() {},
        appendChild() {},
        focus() {},
        addEventListener(type, fn) {
          const existing = listeners.get(type) || [];
          existing.push(fn);
          listeners.set(type, existing);
        },
        emit(type, event = {}) {
          for (const listener of listeners.get(type) || []) {
            listener(event);
          }
        },
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 100, height: 100 };
        },
      });
    }
    return elements.get(id);
  }
  class FakeWebSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }
    addEventListener(type, fn) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(fn);
      this.listeners.set(type, listeners);
    }
    close() {
      this.readyState = 3;
    }
    send(message) {
      this.sent.push(message);
    }
    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) {
        listener(event);
      }
    }
  }
  class FakeRTCPeerConnection {
    static instances = [];
    constructor() {
      this.connectionState = "new";
      this.iceConnectionState = "new";
      this.onconnectionstatechange = null;
      this.oniceconnectionstatechange = null;
      this.onicecandidate = null;
      this.ontrack = null;
      this.statsTimestamp = 1000;
      this.bytesReceived = 100000;
      this.dataChannels = [];
      FakeRTCPeerConnection.instances.push(this);
    }
    addTransceiver() {}
    createDataChannel(label, options) {
      const channel = fakeDataChannel(label, options);
      this.dataChannels.push(channel);
      return channel;
    }
    close() {
      this.closed = true;
      this.connectionState = "closed";
    }
    setRemoteDescription() {
      return Promise.resolve();
    }
    createAnswer() {
      return Promise.resolve({ sdp: "answer" });
    }
    setLocalDescription() {
      return Promise.resolve();
    }
    addIceCandidate() {
      return Promise.resolve();
    }
    getStats() {
      this.statsTimestamp += 5000;
      this.bytesReceived += 250000;
      return Promise.resolve(new Map([[
        "inbound-video",
        {
          type: "inbound-rtp",
          kind: "video",
          timestamp: this.statsTimestamp,
          bytesReceived: this.bytesReceived,
          framesDecoded: 120,
          framesDropped: 3,
          framesPerSecond: 29.7,
          jitter: 0.012,
        },
      ]]));
    }
  }
  const sandbox = {
    acquireVsCodeApi() {
      return { postMessage(message) { posted.push(message); } };
    },
    document: {
      body: element("body"),
      activeElement: element("body"),
      createElement: element,
      getElementById: element,
      addEventListener(type, fn) {
        const existing = documentListeners.get(type) || [];
        existing.push(fn);
        documentListeners.set(type, existing);
      },
    },
    window: { addEventListener(type, listener) { if (type === "message") windowListeners.push(listener); } },
    WebSocket: FakeWebSocket,
    RTCPeerConnection: FakeRTCPeerConnection,
    setTimeout(fn, delay, ...args) {
      function timer() {
        if (!timer.cleared) fn(...args);
      }
      timer.delay = delay;
      timer.cleared = false;
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    setInterval(fn, delay, ...args) {
      async function interval() {
        if (!interval.cleared) return fn(...args);
        return undefined;
      }
      interval.delay = delay;
      interval.cleared = false;
      intervals.push(interval);
      return interval;
    },
    clearInterval(interval) {
      if (interval) interval.cleared = true;
    },
    console,
  };
  vm.runInNewContext(script, sandbox, { filename: "remote-desktop.js" });
  return {
    posted,
    sockets: FakeWebSocket.instances,
    peers: FakeRTCPeerConnection.instances,
    timers,
    intervals,
    elements,
    makeDataChannel: fakeDataChannel,
    sendWindowMessage(message) {
      for (const listener of windowListeners) {
        listener({ data: message });
      }
    },
    emitDocument(type, event = {}) {
      for (const listener of documentListeners.get(type) || []) {
        listener(event);
      }
    },
  };
}

(async () => {
  await check("extension exports RemoteDesktopPanel for tunnel regression coverage", () => {
    assert.strictEqual(typeof extension.activate, "function");
    assert.strictEqual(typeof extension.deactivate, "function");
    assert.strictEqual(typeof extension.RemoteDesktopPanel, "function");
    const source = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
    assert.match(source, /context\.subscriptions\.push\(panel\)/, "RD panel must be disposed on extension deactivate");
  });

  await check("active tunnel child error posts RD overlay error", async () => {
    resetHarness();
    const panel = makePanel();
    await panel._startV2("test-host");
    assert.strictEqual(spawnedChildren.length, 1, "expected one ssh tunnel child");

    spawnedChildren[0].emit("error", new Error("ssh ENOENT"));

    const errors = errorPosts();
    assert.strictEqual(errors.length, 1, "expected one status:error post");
    assert.match(errors[0].detail, /SSH tunnel failed/);
    assert.match(errors[0].detail, /ssh ENOENT/);
    assert.strictEqual(errors[0].failureKind, "reach");
  });

  await check("host-key tunnel failure posts host-key taxonomy", async () => {
    resetHarness();
    const panel = makePanel();
    await panel._startV2("test-host");

    spawnedChildren[0].stderr.emit("data", Buffer.from("REMOTE HOST IDENTIFICATION HAS CHANGED!\n"));
    spawnedChildren[0].emit("close", 255);

    const errors = errorPosts();
    assert.strictEqual(errors.length, 1, "expected one status:error post");
    assert.strictEqual(errors[0].failureKind, "host-key");
    assert.match(errors[0].detail, /host key mismatch/i);
  });

  await check("local bind collision picks a fresh port instead of hard-failing", async () => {
    resetHarness();
    const panel = makePanel();
    await panel._startV2("test-host");
    assert.ok(
      spawnedChildren[0].args.includes("ExitOnForwardFailure=yes"),
      "tunnel ssh must exit when local forwarding fails so bind retries can observe the failure"
    );

    spawnedChildren[0].stderr.emit("data", Buffer.from("bind: Address already in use\n"));
    spawnedChildren[0].emit("close", 255);

    assert.strictEqual(errorPosts().length, 0, "bind collision must not surface a hard error");
    const retry = latestTimerByDelay(scheduledTimers, 150);
    assert.ok(retry, "bind collision should schedule a short fresh-port retry");
    retry();
    await waitForAsync();
    assert.strictEqual(spawnedChildren.length, 2, "retry should spawn a fresh ssh tunnel");
    assert.notDeepStrictEqual(spawnedChildren[0].args, spawnedChildren[1].args, "retry should use a new local port");
  });

  await check("transient tunnel close (1Password agent refused) lazily retries, no hard error", async () => {
    resetHarness();
    const panel = makePanel();
    await panel._startV2("test-host");
    // 1Password momentarily locked → ssh-agent refuses to sign → tunnel exits 255.
    spawnedChildren[0].stderr.emit(
      "data",
      Buffer.from("sign_and_send_pubkey: signing failed for ED25519 from agent: agent refused operation\n")
    );
    spawnedChildren[0].emit("close", 255);
    assert.strictEqual(errorPosts().length, 0, "transient close must not surface a hard error");
    const connecting = postedMessages.filter((m) => m.type === "status" && m.state === "connecting");
    assert.ok(connecting.length >= 1, "transient close should post a reconnecting status");
    // firing the scheduled retry re-spawns the tunnel (lazy reconnect)
    scheduledTimers[scheduledTimers.length - 1]();
    await waitForAsync();
    assert.strictEqual(spawnedChildren.length, 2, "retry should spawn a fresh tunnel");
  });

  await check("transient RD token read retry participates in tunnel retry window", async () => {
    resetHarness();
    transientTokenReadFailuresRemaining = 1;
    const panel = makePanel();
    await panel._startV2("test-host");

    assert.strictEqual(tokenReadCommands.length, 1, "first start should try to read the RD token");
    assert.strictEqual(spawnedChildren.length, 0, "must not open a tunnel until the token read succeeds");
    assert.strictEqual(errorPosts().length, 0, "transient token read failure must not be terminal immediately");
    const retry = latestTimerByDelay(scheduledTimers, 1200);
    assert.ok(retry, "transient token read should schedule the same initial retry backoff");

    retry();
    await waitForAsync();

    assert.strictEqual(tokenReadCommands.length, 2, "token retry should read the host token again");
    assert.strictEqual(spawnedChildren.length, 1, "successful token retry should continue into tunnel spawn");
    assert.strictEqual(errorPosts().length, 0, "successful token retry must not leave an RD error");
  });

  await check("RD token read retries while host token file is not ready at startup", async () => {
    resetHarness();
    tokenReadResponses.push(
      { code: 1, stderr: "cat: ~/.xpair/host/rd-session-token: No such file or directory\n" },
      { code: 0, stdout: `${TEST_RD_TOKEN}\n` }
    );
    const panel = makePanel();
    await panel._startV2("test-host");

    assert.strictEqual(tokenReadCommands.length, 1, "first start should try to read the RD token");
    assert.strictEqual(spawnedChildren.length, 0, "must wait for the host token file before opening a tunnel");
    assert.strictEqual(errorPosts().length, 0, "missing startup token file must not be terminal immediately");
    const retry = latestTimerByDelay(scheduledTimers, 1200);
    assert.ok(retry, "startup token file miss should schedule the bounded token retry");

    retry();
    await waitForAsync();

    assert.strictEqual(tokenReadCommands.length, 2, "token retry should read the startup token file again");
    assert.strictEqual(spawnedChildren.length, 1, "successful startup token retry should continue into tunnel spawn");
    assert.strictEqual(errorPosts().length, 0, "successful startup token retry must not leave an RD error");
  });

  await check("RD token read retries empty and malformed startup token rewrites", async () => {
    resetHarness();
    tokenReadResponses.push(
      { code: 0, stdout: "\n" },
      { code: 0, stdout: "short-token\n" },
      { code: 0, stdout: `${TEST_RD_TOKEN}\n` }
    );
    const panel = makePanel();
    await panel._startV2("test-host");

    assert.strictEqual(tokenReadCommands.length, 1, "empty token rewrite should be observed as a token read");
    assert.strictEqual(spawnedChildren.length, 0, "must not open a tunnel for an empty token");
    assert.strictEqual(errorPosts().length, 0, "empty token should retry inside the bounded startup window");
    const emptyRetry = latestTimerByDelay(scheduledTimers, 1200);
    assert.ok(emptyRetry, "empty token should schedule the initial retry");

    emptyRetry();
    await waitForAsync();

    assert.strictEqual(tokenReadCommands.length, 2, "malformed token should be read on retry");
    assert.strictEqual(spawnedChildren.length, 0, "must not open a tunnel for a malformed token");
    assert.strictEqual(errorPosts().length, 0, "malformed token should retry inside the bounded startup window");
    const malformedRetry = latestTimerByDelay(scheduledTimers, 2400);
    assert.ok(malformedRetry, "malformed token should schedule the second bounded retry");

    malformedRetry();
    await waitForAsync();

    assert.strictEqual(tokenReadCommands.length, 3, "token retry should continue until a valid token is observed");
    assert.strictEqual(spawnedChildren.length, 1, "valid token after rewrite should continue into tunnel spawn");
    assert.strictEqual(errorPosts().length, 0, "valid token after rewrite must not leave an RD error");
  });

  await check("transient RD token read surfaces terminal error only after retry window", async () => {
    resetHarness();
    transientTokenReadFailuresRemaining = 5;
    const panel = makePanel();
    await panel._startV2("test-host");

    for (let i = 0; i < 4; i += 1) {
      assert.strictEqual(errorPosts().length, 0, "token transient should stay non-terminal inside retry window");
      const retry = latestTimerByDelay(scheduledTimers, 1200 + i * 1200);
      assert.ok(retry, `expected token retry timer ${i + 1}`);
      retry();
      await waitForAsync();
    }

    assert.strictEqual(tokenReadCommands.length, 5, "initial read plus four bounded retries should be attempted");
    assert.strictEqual(spawnedChildren.length, 0, "must not open a signaling tunnel without the host token");
    const errors = errorPosts();
    assert.strictEqual(errors.length, 1, "exhausted token retry window should surface one RD error");
    assert.strictEqual(errors[0].failureKind, "key-auth");
  });

  await check("intentional stop suppresses later tunnel close error", async () => {
    resetHarness();
    const panel = makePanel();
    await panel._startV2("test-host");

    const child = spawnedChildren[0];
    panel._stopV2();
    child.emit("close", 143);

    assert.strictEqual(errorPosts().length, 0, "stop-triggered close should stay quiet");
  });

  await check("visible restored RD panel starts the stream", async () => {
    resetHarness();
    process.env.REMOTE_HOST = "test-host";
    const panel = new extension.RemoteDesktopPanel({ fsPath: "/test/ext" });

    panel.restore(fakePanel);
    await waitForAsync();

    assert.strictEqual(spawnedChildren.length, 1, "visible restored panel should start one ssh tunnel");
  });

  await check("v2 error resets state so a second reveal can reconnect", async () => {
    resetHarness();
    process.env.REMOTE_HOST = "test-host";
    const panel = makePanel();
    panel.visible = true;
    await panel._startStream();
    await waitForAsync();
    assert.strictEqual(spawnedChildren.length, 1, "first stream should start one ssh tunnel");

    panel.onMessage({ type: "v2Error", detail: "peer connection failed" });
    assert.strictEqual(spawnedChildren[0].killed, true, "v2 error should stop the active ssh tunnel");
    await panel.reveal();
    await waitForAsync();

    assert.strictEqual(spawnedChildren.length, 2, "second reveal should start a fresh ssh tunnel");
  });

  await check("RD start respects the gateway MAC roaming guard before ssh", async () => {
    resetHarness();
    process.env.REMOTE_HOST = "test-host";
    gatewayMacResponse = {
      allowed: false,
      state: "changed",
      current: "11:22:33:44:55:66",
      stored: "aa:bb:cc:dd:ee:ff",
      err: "default gateway MAC changed",
    };
    const panel = makePanel();
    panel.visible = true;

    await panel._startStream();
    await waitForAsync();

    assert.strictEqual(tokenReadCommands.length, 0, "blocked roaming guard must not read the RD token");
    assert.strictEqual(spawnedChildren.length, 0, "blocked roaming guard must not open an ssh tunnel");
    const errors = errorPosts();
    assert.strictEqual(errors.length, 1, "blocked roaming guard should surface one RD error");
    assert.match(errors[0].detail, /default gateway MAC changed/);
  });

  await check("stale settle timer cannot post obsolete v2Connect", async () => {
    resetHarness();
    const panel = makePanel();
    await panel._startV2("test-host");
    assert.strictEqual(tokenReadCommands.length, 1, "first start should read the RD token over ssh");
    const firstTimer = latestTimerByDelay(scheduledTimers, 1200);
    assert.ok(firstTimer, "first start should arm a settle timer");
    panel._stopV2();
    await panel._startV2("test-host");
    assert.strictEqual(tokenReadCommands.length, 2, "restart should read the current host RD token again");

    firstTimer();
    assert.strictEqual(v2ConnectPosts().length, 0, "old timer should not post a stale v2Connect");
    const currentTimer = latestTimerByDelay(scheduledTimers, 1200);
    assert.ok(currentTimer, "restart should arm a current settle timer");
    currentTimer();
    const posts = v2ConnectPosts();
    assert.strictEqual(posts.length, 1, "current timer should still post v2Connect");
    assert.match(posts[0].signalUrl, new RegExp(`^ws://127\\.0\\.0\\.1:\\d+/\\?token=${TEST_RD_TOKEN}&fps=30&bitrate=4000000&scale=1$`));
    assert.strictEqual(posts[0].sessionToken, TEST_RD_TOKEN);
  });

  await check("RD tunnel fails closed when host token file cannot be read", async () => {
    resetHarness();
    failTokenRead = true;
    const panel = makePanel();
    await panel._startV2("test-host");

    assert.strictEqual(tokenReadCommands.length, 1, "should try to read the host RD token");
    assert.strictEqual(spawnedChildren.length, 0, "must not open a signaling tunnel without the host token");
    const errors = errorPosts();
    assert.strictEqual(errors.length, 1, "token read failure should surface as RD error");
    assert.match(errors[0].detail, /Could not read host RD token|Permission denied/);
  });

  await check("RemoteDesktopPanel dispose tears down active RD tunnel", async () => {
    resetHarness();
    const panel = makePanel();
    await panel._startV2("test-host");
    assert.strictEqual(spawnedChildren.length, 1, "expected one active tunnel");

    panel.dispose();

    assert.strictEqual(spawnedChildren[0].killed, true, "dispose should stop the active tunnel");
  });

  await check("webview ignores stale v2 events from previous connections", async () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:1" });
    const oldSocket = harness.sockets[0];
    const oldPeer = harness.peers[0];

    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:2" });
    oldSocket.emit("error");
    oldSocket.emit("close", { wasClean: false, code: 1006 });
    oldPeer.connectionState = "failed";
    oldPeer.onconnectionstatechange();

    const staleErrors = harness.posted.filter((message) => message.type === "v2Error");
    assert.strictEqual(staleErrors.length, 0, "old connection events should not report v2Error");

    harness.sockets[1].emit("error");
    assert.strictEqual(
      harness.posted.filter((message) => message.type === "v2Error").length,
      0,
      "current transient signaling errors should enter reconnect before terminal v2Error"
    );
    const reconnect = latestTimerByDelay(harness.timers, 500);
    assert.ok(reconnect, "current signaling error should schedule bounded reconnect");
    reconnect();
    assert.strictEqual(harness.sockets.length, 3, "bounded reconnect should open a fresh signaling socket");
  });

  await check("webview reconnects on media drop, disconnected grace, 1006, and first-frame timeout", async () => {
    let harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:1/?token=aaaaaaaaaaaaaaaaaaaaaaaa" });
    harness.peers[0].connectionState = "failed";
    harness.peers[0].onconnectionstatechange();
    assert.strictEqual(harness.posted.filter((message) => message.type === "v2Error").length, 0);
    latestTimerByDelay(harness.timers, 500)();
    assert.strictEqual(harness.sockets.length, 2, "failed peer should reconnect with a new WebSocket");

    harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:2/?token=bbbbbbbbbbbbbbbbbbbbbbbb" });
    harness.peers[0].connectionState = "disconnected";
    harness.peers[0].onconnectionstatechange();
    const grace = latestTimerByDelay(harness.timers, 3000);
    assert.ok(grace, "disconnected should arm a grace timer");
    grace();
    latestTimerByDelay(harness.timers, 500)();
    assert.strictEqual(harness.sockets.length, 2, "disconnected grace expiry should reconnect");

    harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:3/?token=cccccccccccccccccccccccc" });
    harness.sockets[0].emit("close", { wasClean: false, code: 1006 });
    latestTimerByDelay(harness.timers, 500)();
    assert.strictEqual(harness.sockets.length, 2, "abnormal signaling close should reconnect");

    harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:4/?token=dddddddddddddddddddddddd" });
    latestTimerByDelay(harness.timers, 15000)();
    latestTimerByDelay(harness.timers, 500)();
    assert.strictEqual(harness.sockets.length, 2, "first-frame timeout should reconnect");

    const currentErrors = harness.posted.filter((message) => message.type === "v2Error");
    assert.strictEqual(currentErrors.length, 0, "reconnectable media drops should not be terminal immediately");
  });

  await check("webview reports first frame only after decoded video, not on track negotiation", () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:5/?token=eeeeeeeeeeeeeeeeeeeeeeee" });
    harness.peers[0].ontrack({ streams: [{ id: "media" }] });
    assert.strictEqual(
      harness.posted.filter((message) => message.type === "v2FirstFrame").length,
      0,
      "ontrack alone must not report first frame"
    );
    harness.elements.get("screen-video").emit("timeupdate");
    assert.strictEqual(
      harness.posted.filter((message) => message.type === "v2FirstFrame").length,
      1,
      "decoded-frame fallback should report first frame"
    );
  });

  await check("webview maps capture status to actionable overlay taxonomy", () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:6/?token=ffffffffffffffffffffffff" });
    harness.sockets[0].emit("message", {
      data: JSON.stringify({
        type: "status",
        kind: "capture-failed",
        captureKind: "start-failed",
        reason: "Screen Recording denied",
      }),
    });

    const overlay = harness.elements.get("overlay-msg").textContent;
    assert.match(overlay, /could not start screen capture/i);
    assert.match(overlay, /Screen Recording denied/);
    const errors = harness.posted.filter((message) => message.type === "v2Error");
    assert.strictEqual(errors.length, 1, "capture status should become a terminal v2Error");
    assert.strictEqual(errors[0].failureKind, "capture-failed");
  });

  await check("webview sends hello as the first signaling message after open", () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:11/?token=bbbbbbbbbbbbbbbbbbbbbbbb" });

    assert.deepStrictEqual(harness.sockets[0].sent, [], "no signaling messages should be sent before open");
    harness.sockets[0].emit("open");

    assert.strictEqual(harness.sockets[0].sent.length, 1, "open should send exactly the hello");
    assert.deepStrictEqual(JSON.parse(harness.sockets[0].sent[0]), {
      type: "hello",
      proto: 1,
      caps: { negotiatedInput: true },
    });
  });

  await check("webview creates negotiated input channels on hello-ack and sends input", () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:12/?token=cccccccccccccccccccccccc" });

    assert.strictEqual(harness.peers[0].dataChannels.length, 0, "client must wait for hello-ack before creating input channels");
    ackNegotiatedInput(harness);

    const ctl = harness.peers[0].dataChannels.find((channel) => channel.label === "rp-ctl");
    const move = harness.peers[0].dataChannels.find((channel) => channel.label === "rp-move");
    assert.deepStrictEqual({ ...ctl.options }, { negotiated: true, id: 0 });
    assert.deepStrictEqual({ ...move.options }, { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    ctl.readyState = "open";
    harness.sockets[0].emit("message", {
      data: JSON.stringify({ type: "status", kind: "input-ready" }),
    });

    harness.elements.get("screen-video").emit("wheel", {
      deltaX: 3,
      deltaY: 4,
      deltaMode: 0,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    assert.strictEqual(JSON.parse(ctl.sent[0]).t, "w", "control input should flow on the negotiated channel");
  });

  await check("webview keeps legacy ondatachannel fallback when hello-ack never arrives", () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:13/?token=dddddddddddddddddddddddd" });

    assert.strictEqual(harness.peers[0].dataChannels.length, 0, "old-host path must not create client channels without an ack");
    const ctl = harness.makeDataChannel("rp-ctl");
    harness.peers[0].ondatachannel({ channel: ctl });
    ctl.readyState = "open";
    harness.sockets[0].emit("message", {
      data: JSON.stringify({ type: "status", kind: "input-ready" }),
    });

    harness.elements.get("screen-video").emit("wheel", {
      deltaX: 5,
      deltaY: 6,
      deltaMode: 0,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    assert.strictEqual(JSON.parse(ctl.sent[0]).t, "w", "legacy host-created channel should still be wired");
    assert.strictEqual(harness.peers[0].dataChannels.length, 0, "ondatachannel delivery must not count as a client-created channel");
  });

  await check("webview always sends pointerup and keyup releases under control-channel backpressure", () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:8/?token=888888888888888888888888" });
    ackNegotiatedInput(harness);
    const ctl = harness.peers[0].dataChannels.find((channel) => channel.label === "rp-ctl");
    assert.ok(ctl, "webview should create the reliable control DataChannel");
    ctl.readyState = "open";
    harness.sockets[0].emit("message", {
      data: JSON.stringify({ type: "status", kind: "input-ready" }),
    });

    const video = harness.elements.get("screen-video");
    const pointerEvent = (props) => ({
      button: 0,
      clientX: 10,
      clientY: 20,
      preventDefault() {},
      ...props,
    });
    const keyEvent = (props) => ({
      isComposing: false,
      repeat: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
      ...props,
    });
    const sentMessages = () => ctl.sent.map((message) => JSON.parse(message));

    ctl.bufferedAmount = 0;
    video.emit("pointerdown", pointerEvent({ pointerId: 1, button: 0, clientX: 10, clientY: 20 }));
    ctl.bufferedAmount = 65537;
    video.emit("pointerup", pointerEvent({ pointerId: 1, button: 0, clientX: 30, clientY: 40 }));
    assert.deepStrictEqual(
      sentMessages().map((message) => message.t),
      ["d", "u"],
      "pointerup release must bypass BUFFER_LIMIT after a delivered pointerdown"
    );

    ctl.bufferedAmount = 0;
    harness.emitDocument("keydown", keyEvent({ code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 }));
    ctl.bufferedAmount = 65537;
    harness.emitDocument("keyup", keyEvent({ code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 }));
    const keyMessages = sentMessages().filter((message) => message.t === "k");
    assert.deepStrictEqual(
      keyMessages.map((message) => message.action),
      ["down", "up"],
      "keyup release must bypass BUFFER_LIMIT after a delivered keydown"
    );
  });

  await check("webview forwards per-event modifier flags on pointer and wheel input", () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:10/?token=aaaaaaaaaaaaaaaaaaaaaaaa" });
    ackNegotiatedInput(harness);
    const ctl = harness.peers[0].dataChannels.find((channel) => channel.label === "rp-ctl");
    const move = harness.peers[0].dataChannels.find((channel) => channel.label === "rp-move");
    assert.ok(ctl, "webview should create the reliable control DataChannel");
    assert.ok(move, "webview should create the lossy move DataChannel");
    ctl.readyState = "open";
    move.readyState = "open";
    harness.sockets[0].emit("message", {
      data: JSON.stringify({ type: "status", kind: "input-ready" }),
    });

    const video = harness.elements.get("screen-video");
    const pointerEvent = (props) => ({
      pointerId: 3,
      button: 0,
      clientX: 10,
      clientY: 20,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
      ...props,
    });
    const cmdShift = 0x100000 | 0x020000;
    const allModifiers = 0x100000 | 0x020000 | 0x040000 | 0x080000;

    video.emit("pointerdown", pointerEvent({ metaKey: true, shiftKey: true }));
    video.emit("pointermove", pointerEvent({ clientX: 15, clientY: 25, metaKey: true, shiftKey: true }));
    video.emit("pointerup", pointerEvent({ clientX: 20, clientY: 30, metaKey: true, shiftKey: true }));
    video.emit("wheel", pointerEvent({
      deltaX: 1,
      deltaY: 2,
      deltaMode: 0,
      metaKey: true,
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    }));

    const ctlMessages = ctl.sent.map((message) => JSON.parse(message));
    const moveMessages = move.sent.map((message) => JSON.parse(message));
    assert.strictEqual(ctlMessages.find((message) => message.t === "d").flags, cmdShift);
    assert.strictEqual(ctlMessages.find((message) => message.t === "u").flags, cmdShift);
    assert.strictEqual(ctlMessages.find((message) => message.t === "w").flags, allModifiers);
    assert.strictEqual(moveMessages.find((message) => message.t === "m").flags, cmdShift);
  });

  await check("webview ignores unsupported mouse buttons instead of mapping them to primary", () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:9/?token=777777777777777777777777" });
    ackNegotiatedInput(harness);
    const ctl = harness.peers[0].dataChannels.find((channel) => channel.label === "rp-ctl");
    assert.ok(ctl, "webview should create the reliable control DataChannel");
    ctl.readyState = "open";
    harness.sockets[0].emit("message", {
      data: JSON.stringify({ type: "status", kind: "input-ready" }),
    });

    const video = harness.elements.get("screen-video");
    const pointerEvent = (props) => ({
      pointerId: 2,
      button: 1,
      clientX: 10,
      clientY: 20,
      preventDefault() {},
      ...props,
    });

    video.emit("pointerdown", pointerEvent({ button: 1 }));
    video.emit("pointerup", pointerEvent({ button: 1 }));
    video.emit("pointerdown", pointerEvent({ button: 3 }));
    video.emit("pointerup", pointerEvent({ button: 3 }));
    assert.deepStrictEqual(ctl.sent, [], "middle/back/forward buttons must not emit left-click events");

    video.emit("pointerdown", pointerEvent({ button: 2 }));
    video.emit("pointerup", pointerEvent({ button: 2 }));
    assert.deepStrictEqual(
      ctl.sent.map((message) => JSON.parse(message).btn),
      ["r", "r"],
      "right button should still map to right-button down/up"
    );
  });

  await check("webview samples WebRTC stats and clears sampler on cancel", async () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:7/?token=999999999999999999999999" });
    const sampler = latestIntervalByDelay(harness.intervals, 5000);
    assert.ok(sampler, "stats sampler should be armed at a bounded interval");

    await sampler();
    const stats = harness.posted.filter((message) => message.type === "v2Stats");
    assert.strictEqual(stats.length, 1, "expected one v2Stats post");
    assert.strictEqual(stats[0].decoded, 120);
    assert.strictEqual(stats[0].dropped, 3);
    assert.strictEqual(stats[0].jitterMs, 12);
    assert.ok(Object.prototype.hasOwnProperty.call(stats[0], "bitrateKbps"));

    harness.sendWindowMessage({ type: "v2Cancel" });
    assert.strictEqual(sampler.cleared, true, "cancel should stop the stats sampler");
  });

  await check("webview resets reconnect budget after decoded recovery", () => {
    const harness = runRemoteDesktopWebview();
    harness.sendWindowMessage({ type: "v2Connect", signalUrl: "ws://127.0.0.1:8/?token=888888888888888888888888" });

    function markDecoded(peer) {
      const video = harness.elements.get("screen-video");
      video.readyState = 2;
      peer.ontrack({ streams: [{}] });
    }

    function forceReconnect(peer, cycle) {
      markDecoded(peer);
      peer.connectionState = "disconnected";
      peer.onconnectionstatechange();
      const grace = latestTimerByDelay(harness.timers, 3000);
      assert.ok(grace, `cycle ${cycle} should arm disconnected grace`);
      grace();
      const retry = latestTimerByDelay(harness.timers, 500);
      assert.ok(retry, `cycle ${cycle} should retry as a fresh first attempt`);
      retry();
    }

    for (let i = 0; i < 6; i += 1) {
      const peer = harness.peers[harness.peers.length - 1];
      forceReconnect(peer, i + 1);
    }

    assert.strictEqual(harness.peers.length, 7, "six recovered blips should not exhaust the reconnect budget");
    assert.strictEqual(
      harness.posted.filter((message) => message.type === "v2Error").length,
      0,
      "recovered blips should not become terminal errors"
    );
  });

  await check("webview status errors stay visible after first frame", () => {
    const script = fs.readFileSync(path.join(__dirname, "media", "remote-desktop.js"), "utf8");
    assert.match(script, /failureOverlayMessage\(m\.failureKind \|\| m\.kind \|\| "reach"/);
    assert.match(script, /if \(m\.state === "error"\) showOverlay\(msg\);/);
    assert.match(script, /else if \(!haveFrame\) showOverlay\(msg\);/);
  });

  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;

  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch (_error) {
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }

  console.log("\nall remote desktop tunnel tests passed");
})();
