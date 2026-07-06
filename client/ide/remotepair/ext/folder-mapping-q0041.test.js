const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extRoot = __dirname;
const repoRoot = path.resolve(extRoot, "../../..", "..");
const extension = fs.readFileSync(path.join(extRoot, "extension.js"), "utf8");
const patch = fs.readFileSync(
  path.join(extRoot, "../patches/zz-remotepair-ide-frontend.patch"),
  "utf8",
);
const cli = fs.readFileSync(path.join(repoRoot, "client/cli/xpair"), "utf8");
const launcher = fs.readFileSync(path.join(repoRoot, "client/cli/xpair-launch"), "utf8");
const maplib = fs.readFileSync(path.join(repoRoot, "client/cli/bin/maplib.sh"), "utf8");

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

test("client paths map to host paths before Browser roots and launches (Q0041)", () => {
  assert.match(
    maplib,
    /map_to_host\(\)[\s\S]*best_c="" best_h=""[\s\S]*case "\$d" in "\$c"\|"\$c"\/\*\)[\s\S]*"\$\{d#"\$best_c"\}"/,
    "CLI must resolve a client path through the longest matching FOLDER_MAPS host prefix",
  );
  assert.match(maplib, /resolve_host\(\) \{ map_to_host "\$1"; \}/);
  assert.match(
    cli,
    /cmd_map\(\)[\s\S]*_c="\$\(map_client_of "\$pair"\)"[\s\S]*\{"client":%s,"host":%s,"method":%s\}[\s\S]*_json_str "\$\(map_host_of "\$pair"\)"[\s\S]*_json_str "\$\(map_mode_of "\$_c"\)"/,
    "map list --json must expose client/host path pairs plus per-mapping method (JSON-escaped via _json_str) as the mapping SSOT",
  );
  assert.match(
    launcher,
    /HOST_DIR="\$\(map_to_host "\$PROJECT_DIR"\)"[\s\S]*\[ -d \$\{HOST_DIR_Q\} \]/,
    "xpair launch must check and run against the mapped host directory",
  );
  assert.match(
    extension,
    /function reconcileBrowserRoots\(\)[\s\S]*const maps = readFolderMaps\(\)[\s\S]*clientDirs\.push\(m\.clientDir\)[\s\S]*updateWorkspaceFolders\(/,
    "Browser roots must be reconciled from mapped client dirs only",
  );
  assert.match(
    extension,
    /title: "Xpair . Add Mapping"[\s\S]*prompt: "Enter the host folder path[\s\S]*runXpairCli\(\["mount", "mount", host\][\s\S]*runXpairCli\(\["map", "add", mountpoint, host\]/,
    "Add Mapping must ask for a host path, mount it, then register mountpoint::host mapping",
  );
  assert.match(
    patch,
    /executeCommand\('remotepair\.terminalSidebar\.openSessionInFolder', uri\)/,
    "folder row actions must pass the selected folder URI into the session launcher",
  );
  assert.match(
    patch,
    /openSessionInFolder\(cwd: URI \| undefined\)[\s\S]*openTerminalInGroup\(group, cwd\)[\s\S]*instance\.sendText\('xpair launch', true\)/,
    "the selected folder must become the terminal cwd used for xpair launch",
  );
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}

console.log("\nall Q0041 folder mapping tests passed");
