const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const install = fs.readFileSync(path.join(root, "install.sh"), "utf8");
const config = fs.readFileSync(path.join(root, "config.sh"), "utf8");
const installer = fs.readFileSync(path.join(root, "..", "host", "app", "Installer.swift"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} - installer keeps Host and Client responsibilities separate`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

function guardedInstallBlock(source, guard, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notStrictEqual(markerIndex, -1, `${marker} marker must exist`);
  const start = source.lastIndexOf(guard, markerIndex);
  assert.notStrictEqual(start, -1, `${guard} guard must wrap ${marker}`);
  const end = source.indexOf("\nfi\n\n#", markerIndex);
  assert.notStrictEqual(end, -1, `${marker} block must close before the next section`);
  return source.slice(start, end + 4);
}

test("Q0021/Q0022/Q0343 installer roles keep Host running and leave client connection as a separate start", () => {
  assert.match(config, /HOST_KEYS=\([^)]*BUNDLE_PREFIX[^)]*APP_NAME[^)]*RULES_FILE[^)]*\)/);
  assert.match(config, /CLIENT_KEYS=\([^)]*REMOTE_HOST[^)]*FOLDER_MAPS[^)]*LAUNCHER[^)]*\)/);
  assert.match(install, /case "\$ROLE" in host\|client\|both\)/);
  assert.match(install, /is_host\(\)\s+\{ \[ "\$ROLE" = host \] \|\| \[ "\$ROLE" = both \]; \}/);
  assert.match(install, /is_client\(\)\s+\{ \[ "\$ROLE" = client \] \|\| \[ "\$ROLE" = both \]; \}/);

  const hostBlock = guardedInstallBlock(install, "if is_host; then", 'say "[host] approve rules');
  assert.match(hostBlock, /if is_host; then/);
  assert.match(hostBlock, /Installing app[\s\S]*\$APP_PATH/);
  assert.match(hostBlock, /<key>RunAtLoad<\/key><true\/><key>KeepAlive<\/key><true\/>/);
  assert.match(hostBlock, /launchctl bootstrap "gui\/\$U" "\$app_plist"/);
  assert.match(hostBlock, /record LAUNCHCTL "\$APP_LABEL" "\$app_plist"/);

  const clientBlock = guardedInstallBlock(install, "if is_client; then", 'say "[client] launcher + Service"');
  assert.match(clientBlock, /if is_client; then/);
  assert.match(clientBlock, /install_file "\$CLIENT_DIR\/xpair-launch" "\$LAUNCHER" 755/);
  assert.match(clientBlock, /Launch Xpair\.workflow/);
  assert.doesNotMatch(clientBlock, /\$APP_PATH|launchctl bootstrap|XpairHost\.app/);

  assert.match(
    install,
    /host handshake poll[\s\S]*warn "handshake timed out[\s\S]*host may not be running XpairHost\.app yet \(install succeeded; start the app on the host\)"/,
    "client install may verify the host, but connecting/starting the host remains a separate action",
  );
  assert.match(installer, /if roleFileIsClientOnly\(ROLE_FILE\) \|\| roleFileIsClientOnly\(CLIENT_ROLE_FILE\) \{[\s\S]*client role marker[\s\S]*skipping host self-install[\s\S]*return true/);
  assert.match(installer, /if clientEnvHasRemoteHost\(\) && !fm\.fileExists\(atPath: HOST_ENV\) \{[\s\S]*client\.env REMOTE_HOST \+ no host\.env[\s\S]*skipping host self-install[\s\S]*return true/);
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
