const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testFile = path.relative(process.cwd(), __filename);
const extRoot = __dirname;
const repoRoot = path.resolve(extRoot, "../../../..");

const extension = fs.readFileSync(path.join(extRoot, "extension.js"), "utf8");
const onboardingMainPath = path.join(extRoot, "onboarding-main.cjs");
const appDelegate = fs.readFileSync(path.join(repoRoot, "host/app/AppDelegate.swift"), "utf8");
const onboardingWindow = fs.readFileSync(path.join(repoRoot, "host/app/OnboardingWindow.swift"), "utf8");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name} - intended behavior is asserted`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name} - ${error && error.message ? error.message.split("\n")[0] : error}`);
    }
  });
}

async function withTempHome(fn) {
  return withTempHomePrepared(null, fn);
}

async function withTempHomePrepared(setup, fn) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-reonboard-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete require.cache[require.resolve(onboardingMainPath)];
  try {
    if (typeof setup === "function") setup(tmpHome);
    return await fn(tmpHome, require(onboardingMainPath));
  } finally {
    delete require.cache[require.resolve(onboardingMainPath)];
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function fakeElectron() {
  const loads = [];
  class BrowserWindow {
    constructor() {
      this.webContents = {
        setWindowOpenHandler() {},
      };
      this.closedHandlers = {};
    }
    once() {}
    on(event, fn) {
      this.closedHandlers[event] = fn;
    }
    loadFile(file, options) {
      loads.push({ file, options });
    }
    show() {}
    focus() {}
    close() {}
    isDestroyed() {
      return false;
    }
  }

  return {
    loads,
    electron: {
      app: {
        dock: { show() {} },
        focus() {},
      },
      BrowserWindow,
      ipcMain: { handle() {} },
      shell: { openExternal() {} },
    },
  };
}

function greenBridge(overrides = {}) {
  return {
    cliReady: async () => ({ ready: true, bin: "/tmp/xpair", err: "" }),
    sshReachable: async () => ({ reachable: true, err: "" }),
    hostAppStatus: async () => ({
      installed: true,
      version: "0.5.0a99",
      compatible: true,
      incompatibleKind: "",
      err: "",
    }),
    hostPermissions: async () => ({ alive: true, ax: true, sr: true, fda: false, err: "" }),
    hostEnvEngine: async () => ({ engine: "codex", err: "" }),
    hostEngineStatus: async () => ({ installed: true, authed: true, version: "ok", err: "" }),
    ...overrides,
  };
}

test("Q0473/Q0493/Q0494 force-onboarding sentinel reopens onboarding once without clearing sessions", async () => {
  await withTempHome(async (home, onboardingMain) => {
    const rpDir = path.join(home, ".xpair/client");
    fs.mkdirSync(rpDir, { recursive: true });
    fs.writeFileSync(path.join(rpDir, "client.env"), "REMOTE_HOST=host-mac\nFOLDER_MAPS=/c::/h\nENGINE=codex\n");
    assert.equal(
      await onboardingMain.firstFailingGuard([], greenBridge()),
      null,
      "configured clients with all guards green should normally open workbench",
    );

    const sentinel = path.join(rpDir, ".force-onboarding");
    fs.writeFileSync(sentinel, "");
    assert.equal(
      await onboardingMain.firstFailingGuard([], greenBridge()),
      "welcome",
      "sentinel must force setup on next launch",
    );

    const fake = fakeElectron();
    assert.equal(
      await onboardingMain.resolveOnboarding({
        electron: fake.electron,
        onComplete() {},
        argv: [],
        probeBridge: greenBridge(),
      }),
      true,
    );
    assert.equal(fs.existsSync(sentinel), false, "forced setup must be one-shot after onboarding opens");
    assert.deepEqual(fake.loads[0].options.query, { startStep: "welcome" });
    assert.match(fs.readFileSync(path.join(rpDir, "client.env"), "utf8"), /REMOTE_HOST=host-mac/);
  });
});

test("Q0473/Q0493/Q0494 per-launch guard parachutes to the first failing step", async () => {
  await withTempHome(async (home, onboardingMain) => {
    const rpDir = path.join(home, ".xpair/client");
    fs.mkdirSync(rpDir, { recursive: true });
    fs.writeFileSync(path.join(rpDir, "client.env"), "REMOTE_HOST=host-mac\nENGINE=codex\n");

    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      sshReachable: async () => ({ reachable: false, err: "offline" }),
    })), "connect");
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostAppStatus: async () => ({
        installed: true,
        version: "0.5.0a45",
        compatible: false,
        incompatibleKind: "below_floor",
        err: "update",
      }),
    })), "connect");
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostAppStatus: async () => ({
        installed: true,
        version: "9.0.0",
        compatible: false,
        incompatibleKind: "major_mismatch",
        err: "major mismatch",
      }),
    })), "connect");
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostAppStatus: async () => ({
        installed: false,
        version: "",
        compatible: false,
        incompatibleKind: "",
        err: "missing",
      }),
    })), "connect");
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostAppStatus: async () => {
        throw new Error("host app probe failed");
      },
    })), "connect");
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostPermissions: async () => ({ alive: false, ax: true, sr: true, fda: false, err: "dead" }),
    })), "connect");
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostPermissions: async () => {
        throw new Error("permission probe failed");
      },
    })), "connect");
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostPermissions: async () => ({ alive: true, ax: false, sr: true, fda: false, err: "" }),
    })), "grant");
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostEngineStatus: async (engine) => {
        assert.equal(engine, "codex", "guard must use the host.env engine status path");
        return { installed: false, authed: false, version: "", err: "missing" };
      },
    })), "engine");
  });
});

test("Q0473/Q0493/Q0494 no engine named anywhere checks the launcher's claude fallback", async () => {
  await withTempHome(async (home, onboardingMain) => {
    const rpDir = path.join(home, ".xpair/client");
    fs.mkdirSync(rpDir, { recursive: true });
    fs.writeFileSync(path.join(rpDir, "client.env"), "REMOTE_HOST=host-mac\n");

    // `xpair launch` execs `claude` when neither host.env nor client.env names an engine
    // (CLIENT_ENGINE_FALLBACK=${ENGINE:-claude}), so the guard must check claude on the host — not skip.
    let checked = "";
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostEnvEngine: async () => ({ engine: "", err: "host ENGINE not set" }),
      hostEngineStatus: async (engine) => {
        checked = engine;
        return { installed: true, authed: true, version: "ok", err: "" };
      },
    })), null, "claude ready on host → guard passes");
    assert.equal(checked, "claude", "guard must probe the launcher's claude fallback when nothing is named");

    // claude missing/unauthed on the host → route to the engine step instead of dead-ending at launch.
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      hostEnvEngine: async () => ({ engine: "", err: "host ENGINE not set" }),
      hostEngineStatus: async (engine) => {
        assert.equal(engine, "claude");
        return { installed: false, authed: false, version: "", err: "not found" };
      },
    })), "engine", "claude not ready on host → engine recovery");
  });
});

test("round4 pre-workbench guard reads legacy host/client.env on app-only update", async () => {
  await withTempHome(async (home, onboardingMain) => {
    const legacyDir = path.join(home, ".xpair/host");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "client.env"), "REMOTE_HOST=legacy-host\nENGINE=codex\n");

    let reachedHost = "";
    let checkedEngine = "";
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      sshReachable: async (host) => {
        reachedHost = host;
        return { reachable: true, err: "" };
      },
      hostEnvEngine: async () => ({ engine: "", err: "" }),
      hostEngineStatus: async (engine) => {
        checkedEngine = engine;
        return { installed: true, authed: true, version: "ok", err: "" };
      },
    })), null);
    assert.equal(reachedHost, "legacy-host", "guard must use legacy REMOTE_HOST when split env is absent");
    assert.equal(checkedEngine, "codex", "guard must use legacy client ENGINE fallback");
    assert.equal(onboardingMain.isOnboarded(), true, "legacy REMOTE_HOST counts as onboarded");
  });
});

test("round4 app-only update self-heals legacy IDE data dirs before workbench", async () => {
  await withTempHomePrepared((home) => {
    const oldIde = path.join(home, ".xpair/client");
    const oldServer = path.join(home, ".xpair/client-server");
    fs.mkdirSync(path.join(oldIde, "User"), { recursive: true });
    fs.writeFileSync(path.join(oldIde, "User", "settings.json"), "{}\n");
    fs.mkdirSync(path.join(oldServer, "bin"), { recursive: true });
    fs.writeFileSync(path.join(oldServer, "bin", "marker"), "server\n");
  }, (home) => {
    assert.equal(fs.existsSync(path.join(home, ".xpair/ide/User/settings.json")), true);
    assert.equal(fs.existsSync(path.join(home, ".xpair/client/User/settings.json")), false);
    assert.equal(fs.existsSync(path.join(home, ".xpair/ide-server/bin/marker")), true);
    assert.equal(fs.existsSync(path.join(home, ".xpair/client-server/bin/marker")), false);
  });
});

test("round4 IDE data self-heal does not move new client runtime dir", async () => {
  await withTempHomePrepared((home) => {
    const clientDir = path.join(home, ".xpair/client");
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, "client.env"), "REMOTE_HOST=host-mac\n");
  }, (home) => {
    assert.equal(fs.existsSync(path.join(home, ".xpair/client/client.env")), true);
    assert.equal(fs.existsSync(path.join(home, ".xpair/ide")), false);
  });
});

test("Q0473/Q0493/Q0494 LOCAL_MODE no longer bypasses native remote guards", async () => {
  await withTempHome(async (home, onboardingMain) => {
    const rpDir = path.join(home, ".xpair/client");
    fs.mkdirSync(rpDir, { recursive: true });
    fs.writeFileSync(path.join(rpDir, "client.env"), "REMOTE_HOST=host-mac\nENGINE=codex\nLOCAL_MODE=1\n");

    let sshProbes = 0;
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      sshReachable: async () => {
        sshProbes += 1;
        return { reachable: false, err: "offline" };
      },
    })), "connect");
    assert.equal(sshProbes, 1, "LOCAL_MODE must not skip remote reachability");

    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      cliReady: async () => ({ ready: false, bin: "", err: "missing cli" }),
    })), "welcome", "LOCAL_MODE must still run the local CLI guard first");

    fs.writeFileSync(path.join(rpDir, "client.env"), "REMOTE_HOST=host-mac\nENGINE=codex\nLOCAL_MODE=0\n");
    assert.equal(await onboardingMain.firstFailingGuard([], greenBridge({
      sshReachable: async () => ({ reachable: false, err: "offline" }),
    })), "connect", "cleared LOCAL_MODE=0 follows the same remote guard path");
  });
});

test("Q0473/Q0493/Q0494 extension Re-run setup schedules next-launch onboarding and asks for restart", async () => {
  assert.match(extension, /vscode\.commands\.registerCommand\("remotepair\.runSetup", \(\) => runSetup\(\)\)/);
  assert.match(extension, /fs\.writeFileSync\(path\.join\(RP_CLIENT_DIR, "\.force-onboarding"\), ""\)/);
  assert.match(extension, /Xpair setup will run when you restart the app\./);
  assert.match(extension, /"Restart now"/);
  assert.match(extension, /vscode\.commands\.executeCommand\("workbench\.action\.quit"\)/);
});

test("Q0473/Q0493/Q0494 status Configure preserves sessions while reserving setup again", async () => {
  assert.match(extension, /vscode\.commands\.registerCommand\("remotepair\.endSessionReonboard", \(\) => endSessionReonboard\(\)\)/);
  assert.match(extension, /Set up Xpair again\? Your sessions stay attached\./);
  assert.match(extension, /choice !== "Set up again"/);
  assert.match(extension, /endSessionReonboard: re-onboarding on next launch \(sessions persist\)/);
  assert.match(extension, /vscode\.commands\.executeCommand\("workbench\.action\.quit"\)/);
});

test("Q0473/Q0493/Q0494 host Set up action opens onboarding from scratch, not a disconnected settings pane", async () => {
  assert.match(appDelegate, /menu\.addItem\(withTitle: "Set up…", action: #selector\(openSetup\), keyEquivalent: ","\)/);
  assert.match(appDelegate, /@objc func openSetup\(\) \{[\s\S]*OnboardingWindow\(mode: \.grantOnly, initialStep: nil,/);
  assert.match(onboardingWindow, /nil = start at Welcome \(the whole flow from scratch\), so inject nothing/);
  assert.match(onboardingWindow, /if let step = initialStep \{[\s\S]*window\.__rp_initialStep/);
});

(async () => {
  for (const entry of tests) await entry();
  console.log(`${testFile} REDGREEN ${passed} ${failed}`);
  process.exitCode = failed ? 1 : 0;
})();
