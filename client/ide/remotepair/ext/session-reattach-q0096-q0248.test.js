const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeSessionList } = require("./session-list.js");

const extRoot = __dirname;
const repoRoot = path.resolve(extRoot, "../../..", "..");
const patch = fs.readFileSync(
  path.join(extRoot, "../patches/zz-remotepair-ide-frontend.patch"),
  "utf8",
);
const cli = fs.readFileSync(path.join(repoRoot, "client/cli/xpair"), "utf8");

function extract(source, start, end) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, `missing section start: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `missing section end: ${end}`);
  return source.slice(a, b);
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message.split("\n")[0]}`);
  }
}

test("named sessions remain distinct and exact-name attachable (Q0096 Q0248)", () => {
  assert.deepStrictEqual(
    normalizeSessionList({
      sessions: [
        { name: "host_repo_1", attached: "0" },
        { name: "host_repo_2", attached: 1 },
        { name: "host repo 3", attached: 0 },
        { name: "bad;touch-pwn", attached: 0 },
      ],
    }),
    {
      sessions: [
        { name: "host_repo_1", attached: 0 },
        { name: "host_repo_2", attached: 1 },
      ],
    },
    "session list normalization must preserve exact safe names and reject display/path text",
  );

  assert.match(
    patch,
    /function cachedDetachedSessions\(\): readonly string\[\] \{[\s\S]*const local = localAttachedSessionNames\(\);[\s\S]*liveSessionCache\.filter\(s => s\.attached === 0 && !local\.has\(s\.name\)\)\.map\(s => s\.name\)/,
    "detached cards must come from unattached live tmux sessions that are not local attached terminal tabs",
  );
  const localAttachedNames = extract(
    patch,
    "function localAttachedSessionNames(): ReadonlySet<string> {",
    "function localAttachedSessionNameList(): readonly string[] {",
  );
  assert.match(
    localAttachedNames,
    /normalizedSessionName\(session\.sessionName\)[\s\S]*names\.add\(name\)/,
    "local attached snapshots must persist only stable tmux sessionName values",
  );
  assert.doesNotMatch(
    localAttachedNames,
    /session\.title|session\.id/,
    "local attached snapshots must never fall back to mutable display titles or terminal ids",
  );
  assert.match(
    patch,
    /const liveNames = new Set\(cachedSessionNames\(\)\);[\s\S]*const persisted = this\.readHistory\(\)\.filter\(name => !liveNames\.has\(name\)\)/,
    "History must be persisted last-seen names minus every live tmux session",
  );
  assert.match(
    patch,
    /function cachedRemoteAttachedSessions\(\): readonly string\[\] \{[\s\S]*s\.attached > 0 && !local\.has\(s\.name\)/,
    "sessions attached elsewhere must be tracked separately from Detached cards",
  );
  assert.match(
    patch,
    /const remoteAttached = cachedRemoteAttachedSessions\(\);[\s\S]*remoteAttached\.length > 0 \? localize\('remotepairAttachedElsewhere', "Some sessions are attached in another window or device\."\)/,
    "attached-elsewhere sessions must render only an informational hint when no detached sessions exist",
  );
  assert.doesNotMatch(
    patch,
    /selecting one will reattach it here/,
    "attached-elsewhere hint must not imply selecting it will steal the session",
  );
  assert.match(
    patch,
    /const names = cachedDetachedSessions\(\);[\s\S]*this\.recordHistory\(names\);[\s\S]*for \(const name of names\)/,
    "Detached must record displayed live detached names into last-seen History",
  );
  assert.match(
    patch,
    /this\.recordHistory\(sessions\.map\(s => normalizedSessionName\(s\.sessionName\)\)\.filter\(\(n\): n is string => !!n\)\)/,
    "Attached history must record only stable sessionName values",
  );
  assert.doesNotMatch(
    patch,
    /recordHistory\(sessions\.map\(s => s\.sessionName \?\? s\.title\)\)|recordHistory\(instances\.map\(instance => instance\.title\)\)/,
    "Attached history must not fall back to mutable terminal display titles",
  );
  assert.match(
    patch,
    /function reattach\(name: string\): void \{[\s\S]*SESSION_NAME_RE\.test\(name\)[\s\S]*reattacher\(name\);/,
    "reattach must pass only a validated selected session name",
  );
  assert.match(
    patch,
    /instance\.sendText\('xpair attach ' \+ shellSingleQuote\(name\), true\)/,
    "the Sessions UI must attach exactly the selected quoted name",
  );
  assert.doesNotMatch(
    patch,
    /addDisplayCard|remotepair-session-card-readonly|display-only rather than wiring a reattach/,
    "restored History entries must not render as inert display-only cards",
  );
  assert.match(
    patch,
    /const persisted = this\.readHistory\(\)\.filter\(name => !liveNames\.has\(name\)\);[\s\S]*for \(const name of persisted\)[\s\S]*this\.addCard\(name, \(\) => validateAndReattach\(name, this\.commandService\)\)/,
    "persisted History names must validate through checkAttach before any reattach",
  );
  assert.match(
    patch,
    /function validateAndReattach\(name: string, commandService: ICommandService\): void \{[\s\S]*commandService\.executeCommand\('remotepair\.sessions\.checkAttach', name\)[\s\S]*if \(isRecord\(value\) && value\.ok === true\)[\s\S]*reattach\(name\)/,
    "History validation must use the existing checkAttach path and only reattach when ok",
  );

  const attach = extract(cli, "cmd_attach() {", "\ncmd_host() {");
  assert.match(attach, /attach requires exactly one session name/);
  assert.match(attach, /case "\$session" in \*\[!A-Za-z0-9_.-\]\*\|''\)/);
  assert.match(attach, /has-session -t \$\(sh_quote "=\$session"\)/);
  assert.match(attach, /attach -d -t "=\$session"/);
  assert.doesNotMatch(attach, /new-session|tmux new\b/, "xpair attach must never create a fresh session");
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall Q0096/Q0248 session reattach tests passed");
