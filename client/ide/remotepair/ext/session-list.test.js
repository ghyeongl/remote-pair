const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { listSessionsFromCli, checkSessionAvailableFromCli } = require("./session-list.js");

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

(async () => {
  await check("calls xpair ls --json and normalizes valid sessions", async () => {
    const calls = [];
    const result = await listSessionsFromCli(async (args, opts) => {
      calls.push({ args, opts });
      return {
        code: 0,
        stdout: JSON.stringify({
          target: "local",
          sessions: [
            { name: "local_one", attached: 1 },
            { name: "local_two", attached: "0" },
          ],
        }),
        stderr: "",
      };
    });

    assert.deepStrictEqual(calls, [{ args: ["ls", "--json"], opts: { timeoutMs: 5000 } }]);
    assert.deepStrictEqual(result, {
      sessions: [
        { name: "local_one", attached: 1 },
        { name: "local_two", attached: 0 },
      ],
    });
  });

  await check("filters malformed entries without parsing human output", async () => {
    const result = await listSessionsFromCli(async () => ({
      code: 0,
      stdout: JSON.stringify({
        sessions: [
          { name: "  good  ", attached: 2.8 },
          { name: "" , attached: 1 },
          { name: 42, attached: 1 },
          { title: "human-looking-session", attached: 1 },
          { name: "bad;touch-pwn", attached: 1 },
          { name: "bad$(id)", attached: 1 },
          { name: "bad name", attached: 1 },
          { name: "bad\ncmd", attached: 1 },
          null,
        ],
      }),
      stderr: "",
    }));

    assert.deepStrictEqual(result, { sessions: [{ name: "good", attached: 2 }] });
  });

  await check("invalid JSON marks the session list unavailable", async () => {
    const result = await listSessionsFromCli(async () => ({ code: 0, stdout: "Folder mappings:\n  x", stderr: "" }));
    assert.deepStrictEqual(result, { sessions: [], unavailable: true });
  });

  await check("nonzero CLI exit marks the session list unavailable", async () => {
    const result = await listSessionsFromCli(async () => ({ code: 4, stdout: "", stderr: "unreachable" }));
    assert.deepStrictEqual(result, { sessions: [], unavailable: true });
  });

  await check("timeout CLI exit marks the session list unavailable", async () => {
    const result = await listSessionsFromCli(async () => ({ code: -2, stdout: "", stderr: "" }));
    assert.deepStrictEqual(result, { sessions: [], unavailable: true });
  });

  await check("checkAttach refuses sessions that are attached elsewhere", async () => {
    const result = await checkSessionAvailableFromCli(async () => ({
      code: 0,
      stdout: JSON.stringify({ sessions: [{ name: "local_one", attached: 1 }] }),
      stderr: "",
    }), "local_one");
    assert.deepStrictEqual(result, {
      sessions: [{ name: "local_one", attached: 1 }],
      ok: false,
      attachedElsewhere: true,
      session: { name: "local_one", attached: 1 },
      cause: "Some sessions are attached in another window or device.",
    });
  });

  await check("thrown runner error marks the session list unavailable", async () => {
    const result = await listSessionsFromCli(async () => {
      throw new Error("spawn ENOENT");
    });
    assert.deepStrictEqual(result, { sessions: [], unavailable: true });
  });

  await check("package activates the session-list bridge command", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    assert.ok(pkg.activationEvents.includes("onCommand:remotepair.sessions.listJson"));
  });

  await check("frontend patch retries and periodically refreshes session data", async () => {
    const patch = fs.readFileSync(path.join(__dirname, "../patches/zz-remotepair-ide-frontend.patch"), "utf8");
    assert.match(patch, /SESSION_REFRESH_RETRY_MS/);
    assert.match(patch, /SESSION_REFRESH_INTERVAL_MS/);
    assert.match(patch, /scheduleSessionRefresh\(commandService, SESSION_REFRESH_RETRY_MS\)/);
    assert.match(patch, /scheduleSessionRefresh\(commandService, SESSION_REFRESH_INTERVAL_MS\)/);
  });

  await check("frontend patch distinguishes unavailable session list from empty sessions", async () => {
    const patch = fs.readFileSync(path.join(__dirname, "../patches/zz-remotepair-ide-frontend.patch"), "utf8");
    assert.match(patch, /sessionListUnavailable = true/);
    assert.match(patch, /commandResultUnavailable\(value\)/);
    assert.match(patch, /Session list unavailable; retrying\.\.\./);
  });

  await check("frontend patch refreshes when unavailable flag changes", async () => {
    const patch = fs.readFileSync(path.join(__dirname, "../patches/zz-remotepair-ide-frontend.patch"), "utf8");
    assert.match(patch, /const nextUnavailable = commandResultUnavailable\(value\)/);
    assert.match(patch, /const unavailableChanged = sessionListUnavailable !== nextUnavailable/);
    assert.match(patch, /if \(unavailableChanged \|\| !sameSessionCache\(liveSessionCache, next\)\)/);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall session list tests passed");
})();
