const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const root = __dirname;
const bridge = require("./onboarding-bridge.js");
const extensionSource = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const bridgeSource = fs.readFileSync(path.join(root, "onboarding-bridge.js"), "utf8");
const onboardingMainPath = path.join(root, "onboarding-main.cjs");
const WIN32_XPAIR = "C:\\Program Files\\Xpair\\xpair.exe";

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (original) Object.defineProperty(process, "platform", original);
    });
}

function withPatched(object, key, value, fn) {
  const original = object[key];
  object[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      object[key] = original;
    });
}

function spawnStub(result = {}, calls = []) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    process.nextTick(() => {
      if (result.error) {
        child.emit("error", new Error(result.error));
        return;
      }
      if (result.out) child.stdout.emit("data", result.out);
      if (result.err) child.stderr.emit("data", result.err);
      child.emit("close", result.code ?? 0);
    });
    return child;
  };
}

async function withProgramFiles(fn) {
  const previousProgramFiles = process.env.ProgramFiles;
  try {
    process.env.ProgramFiles = "C:\\Program Files";
    return await fn();
  } finally {
    if (previousProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = previousProgramFiles;
  }
}

async function withWin32InstalledExe(fn) {
  await withPlatform("win32", async () => {
    await withProgramFiles(async () => {
      await withPatched(fs, "existsSync", (candidate) => candidate === WIN32_XPAIR, fn);
    });
  });
}

async function withOnboardingMainHome(clientEnvText, fn) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-win32-p3-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete require.cache[require.resolve(onboardingMainPath)];
  try {
    if (clientEnvText !== null) {
      const rpDir = path.join(home, ".xpair/client");
      fs.mkdirSync(rpDir, { recursive: true });
      fs.writeFileSync(path.join(rpDir, "client.env"), clientEnvText);
    }
    return await fn(require(onboardingMainPath), home);
  } finally {
    delete require.cache[require.resolve(onboardingMainPath)];
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function fakeVscode() {
  return {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor {},
    Uri: {
      file(filePath) {
        return { fsPath: filePath };
      },
      joinPath(...parts) {
        return { fsPath: parts.map((part) => String(part && part.fsPath ? part.fsPath : part)).join(path.sep) };
      },
    },
    ViewColumn: { Active: 1 },
    WebviewPanelSerializer: class WebviewPanelSerializer {},
    window: {
      createOutputChannel() {
        return { appendLine() {}, show() {}, dispose() {} };
      },
      createStatusBarItem() {
        return { show() {}, hide() {}, dispose() {} };
      },
      showInformationMessage() {
        return Promise.resolve(undefined);
      },
      showWarningMessage() {
        return Promise.resolve(undefined);
      },
      showErrorMessage() {
        return Promise.resolve(undefined);
      },
      createWebviewPanel() {
        return {
          webview: { asWebviewUri(uri) { return uri; }, onDidReceiveMessage() { return { dispose() {} }; } },
          onDidDispose() { return { dispose() {} }; },
          onDidChangeViewState() { return { dispose() {} }; },
          reveal() {},
          dispose() {},
        };
      },
      tabGroups: { all: [] },
      createTerminal() {
        return { show() {}, sendText() {} };
      },
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
      workspaceFolders: [],
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
      onDidChangeWorkspaceFolders() {
        return { dispose() {} };
      },
    },
    extensions: { getExtension() { return null; } },
    ConfigurationTarget: { Global: 1 },
  };
}

async function requireExtensionWithSpawnSpy(fakeBridge, fn) {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    process.nextTick(() => child.emit("close", 0));
    return child;
  };

  const realLoad = Module._load;
  const extensionPath = path.join(root, "extension.js");
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") return fakeVscode();
    if (request === "child_process") return { spawn: fakeSpawn };
    if (request === "./onboarding-bridge.js") return fakeBridge;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const extensionModule = new Module(extensionPath, module);
    extensionModule.filename = extensionPath;
    extensionModule.paths = Module._nodeModulePaths(root);
    extensionModule._compile(
      `${extensionSource}\nmodule.exports.__win32P3Test = { runXpairCli, sshControlMasterArgs };\n`,
      extensionPath,
    );
    await fn(extensionModule.exports, calls);
  } finally {
    Module._load = realLoad;
  }
}

test("P3 resolves the xpair binary per platform", () => {
  const local = path.join("/tmp/xpair-home", ".local", "bin", "xpair");
  assert.equal(
    bridge.resolveXpairCliBin({
      platform: "darwin",
      home: "/tmp/xpair-home",
      executable: (candidate) => candidate === local,
    }),
    local,
  );
  assert.equal(
    bridge.resolveXpairCliBin({
      platform: "linux",
      home: "/tmp/xpair-home",
      executable: () => false,
    }),
    "xpair",
  );
  assert.equal(
    bridge.resolveXpairCliBin({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      exists: (candidate) => candidate === "C:\\Program Files\\Xpair\\xpair.exe",
    }),
    "C:\\Program Files\\Xpair\\xpair.exe",
  );
  assert.equal(
    bridge.resolveXpairCliBin({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      exists: () => false,
    }),
    "xpair.exe",
  );
  assert.equal(
    bridge.resolveXpairCliBin({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      exists: () => false,
      absOnly: true,
    }),
    null,
  );
});

test("P3 rpBin/rpBinAbs follow fake process.platform on win32", async () => {
  await withPlatform("win32", async () => {
    await withProgramFiles(async () => {
      await withPatched(fs, "existsSync", (candidate) => candidate === "C:\\Program Files\\Xpair\\xpair.exe", () => {
        assert.equal(bridge.rpBin(), "C:\\Program Files\\Xpair\\xpair.exe");
        assert.equal(bridge.rpBinAbs(), "C:\\Program Files\\Xpair\\xpair.exe");
      });
    });
  });
});

test("P3 ControlMaster argv is omitted on win32", async () => {
  await withPlatform("win32", () => {
    assert.deepEqual(bridge.__pairingTest.sshControlMasterArgs(), []);
  });
  await withPlatform("darwin", () => {
    const args = bridge.__pairingTest.sshControlMasterArgs();
    assert.ok(args.includes("ControlMaster=auto"));
    assert.ok(args.includes("ControlPersist=300"));
    assert.ok(args.some((arg) => String(arg).startsWith("ControlPath=/tmp/rp-cm-")));
  });
});

test("P3 installCli on win32 returns MSI guidance without bash", async () => {
  await withPlatform("win32", async () => {
    await withPatched(fs, "existsSync", () => false, async () => {
      await withPatched(childProcess, "spawn", () => {
        throw new Error("installCli must not spawn on win32 when the MSI exe is absent");
      }, async () => {
        const result = await bridge.installCli();
        assert.deepEqual(result, {
          ok: false,
          err: "Install the Xpair CLI (.msi) first: https://github.com/x10lab/xpair/releases/latest",
          action: "OPEN_DOWNLOAD",
          url: "https://github.com/x10lab/xpair/releases/latest",
        });
      });
    });
  });
});

test("P3 installCli on win32 probes an existing MSI exe before ok", async () => {
  await withWin32InstalledExe(async () => {
    const calls = [];
    await withPatched(childProcess, "spawn", spawnStub({ code: 0 }, calls), async () => {
      const result = await bridge.installCli();
      assert.deepEqual(result, { ok: true, err: "" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, WIN32_XPAIR);
      assert.deepEqual(calls[0].args, ["status"]);
      assert.equal(calls[0].opts.windowsHide, true);
    });
  });
});

test("P3 installCli on win32 sends broken MSI users to reinstall", async () => {
  await withWin32InstalledExe(async () => {
    await withPatched(childProcess, "spawn", spawnStub({ code: 7, err: "boom" }), async () => {
      const result = await bridge.installCli();
      assert.deepEqual(result, {
        ok: false,
        err: "Xpair CLI found but not working — reinstall the .msi: https://github.com/x10lab/xpair/releases/latest",
        action: "OPEN_DOWNLOAD",
        url: "https://github.com/x10lab/xpair/releases/latest",
      });
    });
  });
});

test("P3 cliReady on win32 requires the serving-capable CLI surface", async () => {
  await withWin32InstalledExe(async () => {
    const realReadFileSync = fs.readFileSync;
    await withPatched(childProcess, "spawn", spawnStub({ code: 0 }), async () => {
      await withPatched(fs, "readFileSync", function readFileSync(candidate, encoding) {
        if (candidate === WIN32_XPAIR) return 'print(json.dumps({"serving": d.get("serving")}))';
        return realReadFileSync.call(fs, candidate, encoding);
      }, async () => {
        assert.deepEqual(await bridge.cliReady(), { ready: true, bin: WIN32_XPAIR, err: "" });
      });

      await withPatched(fs, "readFileSync", function readFileSync(candidate, encoding) {
        if (candidate === WIN32_XPAIR) return "old host-permissions output";
        return realReadFileSync.call(fs, candidate, encoding);
      }, async () => {
        assert.deepEqual(await bridge.cliReady(), {
          ready: false,
          bin: WIN32_XPAIR,
          err: "installed xpair CLI is out of date — reinstall the bundled client CLI",
        });
      });
    });
  });
});

test("P3 runXpairCli uses argv spawn, not sh -lc", async () => {
  const fakeBridge = {
    rpBin: () => "/opt/xpair/bin/xpair",
    spawnEnv: () => ({ PATH: "/opt/xpair/bin:/usr/bin" }),
    sshFailureKind: () => "unreachable",
    sshFailureMessage: (_state, detail) => String(detail || ""),
    SSH_STATE: { READY: "ready", HOST_KEY_MISMATCH: "host_key_mismatch", KEY_AUTH_BLOCKED: "key_auth_blocked", UNREACHABLE: "unreachable" },
    gatewayMacStatus: () => ({ allowed: true, state: "same", current: "", stored: "", err: "" }),
  };
  await requireExtensionWithSpawnSpy(fakeBridge, async (extension, calls) => {
    const result = await extension.__win32P3Test.runXpairCli(["ls", "--json"]);
    assert.equal(result.code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "/opt/xpair/bin/xpair");
    assert.deepEqual(calls[0].args, ["ls", "--json"]);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.deepEqual(calls[0].opts.env, { PATH: "/opt/xpair/bin:/usr/bin" });
    assert.ok(!calls[0].args.includes("-lc"));
  });

  const body = functionBody(extensionSource, "runXpairCli");
  assert.doesNotMatch(body, /shSingleQuote|SHELL|\/bin\/sh|\["-lc"/);
  assert.doesNotMatch(extensionSource, /cp\.spawn\([^,\n]+,\s*\[\s*["']-lc/);
  assert.match(bridgeSource, /function resolveXpairCliBin/);
});

test("P3 non-Darwin pre-workbench guard requires a configured host and CLI", async () => {
  await withPlatform("win32", async () => {
    await withOnboardingMainHome(null, async (onboardingMain) => {
      assert.equal(
        await onboardingMain.firstFailingGuard([], {
          cliReady: async () => {
            throw new Error("unconfigured non-Darwin guard must stop before the CLI probe");
          },
        }),
        "welcome",
      );
    });

    await withOnboardingMainHome("REMOTE_HOST=host-win\n", async (onboardingMain) => {
      assert.equal(
        await onboardingMain.firstFailingGuard([], {
          cliReady: async () => ({ ready: true, bin: WIN32_XPAIR, err: "" }),
          sshReachable: async () => {
            throw new Error("non-Darwin guard must not run remote probes");
          },
        }),
        null,
      );
      assert.equal(
        await onboardingMain.firstFailingGuard([], {
          cliReady: async () => ({ ready: false, bin: "", err: "missing" }),
        }),
        "welcome",
      );
    });
  });
});

(async () => {
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${entry.name} - ${error && error.message ? error.message.split("\n")[0] : error}`);
    }
  }
  console.log(`REDGREEN ${passed} ${failed}`);
  process.exit(failed ? 1 : 0);
})();
