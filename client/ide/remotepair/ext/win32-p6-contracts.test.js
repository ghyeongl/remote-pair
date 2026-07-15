const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = __dirname;
const bridge = require("./onboarding-bridge.js");
const mainPath = path.join(root, "onboarding-main.cjs");
const mainSource = fs.readFileSync(mainPath, "utf8");
const bridgeSource = fs.readFileSync(path.join(root, "onboarding-bridge.js"), "utf8");
const cliRsSource = fs.readFileSync(path.join(root, "../../../cli-rs/src/main.rs"), "utf8");
const stepMappings = fs.readFileSync(
  path.join(root, "onboarding-webview/src/components/onboarding/client/StepMappings.tsx"),
  "utf8",
);
const i18n = fs.readFileSync(path.join(root, "onboarding-webview/src/lib/i18n.ts"), "utf8");

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

async function withMainHome(clientEnvText, fn) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-win32-p6-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete require.cache[require.resolve(mainPath)];
  try {
    if (clientEnvText !== null) {
      const clientDir = path.join(home, ".xpair", "client");
      fs.mkdirSync(clientDir, { recursive: true });
      fs.writeFileSync(path.join(clientDir, "client.env"), clientEnvText);
    }
    return await fn(require(mainPath), home);
  } finally {
    delete require.cache[require.resolve(mainPath)];
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function fakeElectronCapture() {
  let options = null;
  class BrowserWindow {
    constructor(opts) {
      options = opts;
      this.webContents = { setWindowOpenHandler() {} };
    }
    once() {}
    show() {}
    focus() {}
    loadFile() {}
    on() {}
    isDestroyed() { return false; }
    close() {}
  }
  return {
    electron: {
      app: { dock: { show() {} }, focus() {} },
      BrowserWindow,
      ipcMain: { handle() {} },
      shell: { openExternal() {} },
      Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
    },
    options: () => options,
  };
}

function hasControlMasterArg(args) {
  return args.some((arg) => /ControlMaster|ControlPath/.test(String(arg)));
}

test("P6 win32 pairing SSH paths omit all ControlMaster options", async () => {
  await withPlatform("win32", () => {
    const pairing = bridge.__pairingTest.sshPairingProofOpts("office-mac.local");
    const durable = bridge.__pairingTest.sshDurablePinOpts();
    assert.equal(hasControlMasterArg(pairing), false);
    assert.equal(hasControlMasterArg(durable), false);
  });
  await withPlatform("darwin", () => {
    const pairing = bridge.__pairingTest.sshPairingProofOpts("office-mac.local");
    assert.ok(pairing.includes("ControlMaster=no"));
    assert.ok(pairing.includes("ControlPath=none"));
  });
});

test("P6 onboarding window guards mac-only chrome on win32", async () => {
  assert.match(
    mainSource,
    /const macWindowChrome = process\.platform === 'darwin'[\s\S]*titleBarStyle: 'hiddenInset'[\s\S]*trafficLightPosition/,
  );
  await withMainHome(null, async (main) => {
    await withPlatform("win32", () => {
      const fake = fakeElectronCapture();
      main.openOnboardingWindow({ electron: fake.electron, onComplete() {} });
      const options = fake.options();
      assert.ok(options);
      assert.equal(options.titleBarStyle, undefined);
      assert.equal(options.trafficLightPosition, undefined);
    });
  });
  await withMainHome(null, async (main) => {
    await withPlatform("darwin", () => {
      const fake = fakeElectronCapture();
      main.openOnboardingWindow({ electron: fake.electron, onComplete() {} });
      const options = fake.options();
      assert.equal(options.titleBarStyle, "hiddenInset");
      assert.deepEqual(options.trafficLightPosition, { x: 16, y: 18 });
    });
  });
});

test("P6 StepMappings treats UNC roots as mount mappings and accepts Windows absolute local paths", () => {
  assert.ok(stepMappings.includes('clientPath.startsWith("//")'));
  assert.ok(stepMappings.includes('clientPath.startsWith("\\\\\\\\")'));
  assert.ok(stepMappings.includes("/^[A-Za-z]:[\\\\/]/.test(p)"));
  assert.ok(stepMappings.includes('p.startsWith("\\\\\\\\")'));
  assert.match(stepMappings, /setError\(t\("map\.localPathInvalid"\)\)/);
});

test("P6 mapping copy is platform-neutral and localized", () => {
  assert.match(i18n, /"map\.desc": "Mount host folders on this computer, or pair folders for two-way sync\."/);
  assert.match(i18n, /"map\.localPathInvalid": "Enter an absolute local path\."/);
  assert.match(i18n, /"map\.desc": "호스트 폴더를 이 컴퓨터에 마운트하거나 폴더를 양방향 동기화하세요\."/);
  assert.match(i18n, /"map\.localPathInvalid": "로컬 절대 경로를 입력하세요\."/);
});

test("P6 Windows sync mappings surface the native W4 not-supported error", () => {
  assert.match(
    cliRsSource,
    /sync mappings are not supported on Windows yet; use a UNC or mapped-drive path with --method mount/,
  );
  assert.match(
    stepMappings,
    /window\.remotepair\.addMapping\([\s\S]*persistedClientPath,[\s\S]*resolvedHostPath,[\s\S]*mapping\.mode/,
  );
  assert.match(
    stepMappings,
    /if \(added\.code !== 0\) throw new Error\(added\.err \|\| added\.out \|\| "mapping save failed"\)/,
  );
});

test("P6 Windows first-run gate proceeds from configured host and ready MSI CLI", async () => {
  await withPlatform("win32", async () => {
    await withMainHome("REMOTE_HOST=office-mac.local\n", async (main) => {
      assert.equal(
        await main.firstFailingGuard([], {
          cliReady: async () => ({ ready: true, bin: "C:\\Program Files\\Xpair\\xpair.exe", err: "" }),
          sshReachable: async () => {
            throw new Error("win32 first-run gate must not run darwin-only remote probes");
          },
        }),
        null,
      );
    });
  });
});

test("P6 client runtime files stay homedir-rooted and temp dirs use os.tmpdir", () => {
  assert.match(bridgeSource, /const RP_CLIENT_DIR = path\.join\(HOME, "\.xpair\/client"\)/);
  assert.match(bridgeSource, /const CLIENT_ENV_FILE = path\.join\(RP_CLIENT_DIR, "client\.env"\)/);
  assert.match(bridgeSource, /function commonEnvPathForClientEnv\(file\)[\s\S]*path\.join\(path\.dirname\(file\), "common\.env"\)/);
  assert.match(bridgeSource, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), "rp-kh-"\)\)/);
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
