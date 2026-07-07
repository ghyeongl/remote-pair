const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const testFile = path.relative(process.cwd(), __filename);
const cli = path.join(__dirname, "xpair");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function udpPort() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", (error) => {
      if (error && (error.code === "EPERM" || error.code === "EACCES")) resolve(null);
      else reject(error);
    });
    sock.bind(0, "127.0.0.1", () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
  });
}

function sendBeacon(port, payload) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const data = Buffer.from(payload);
    sock.send(data, port, "127.0.0.1", (error) => {
      sock.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runDiscoverWithBeacon() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-lan-beacon-"));
  const port = await udpPort();
  if (port === null) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { skipped: "loopback UDP bind is unavailable in this sandbox" };
  }
  const env = {
    ...process.env,
    HOME: tmp,
    RP_DIR: path.join(tmp, ".xpair", "host"),
    RP_HOST_DIR: path.join(tmp, ".xpair", "host"),
    RP_CLIENT_DIR: path.join(tmp, ".xpair", "client"),
    REMOTE_HOST: "",
    RP_SSH_CFG: path.join(tmp, "ssh_config"),
    RP_LAN_BEACON_PORT: String(port),
  };
  fs.mkdirSync(env.RP_HOST_DIR, { recursive: true });
  fs.mkdirSync(env.RP_CLIENT_DIR, { recursive: true });
  fs.writeFileSync(env.RP_SSH_CFG, "");

  const child = spawn(cli, ["discover", "--json", "--timeout", "1"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 8000);

  const valid = JSON.stringify({
    v: 1,
    kind: "xpair-host",
    name: "Beacon Test Host",
    fp: "SHA256:testFingerprint",
    role: "host",
    user: "alice",
    metaPort: 8891,
    ver: "0.5-test",
  });
  for (let i = 0; i < 5; i += 1) {
    await delay(120);
    await sendBeacon(port, "not-json");
    await sendBeacon(port, JSON.stringify({ v: 1, kind: "other", name: "Wrong Kind Host", fp: "SHA256:wrongKind" }));
    await sendBeacon(port, valid);
  }

  const code = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  clearTimeout(timer);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { code, stdout, stderr };
}

(async () => {
  const result = await runDiscoverWithBeacon();
  if (result.skipped) {
    console.log(`${testFile} SKIP ${result.skipped}`);
    return;
  }
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const peers = JSON.parse(result.stdout);
  const peer = peers.find((p) => p.fp === "SHA256:testFingerprint");
  assert.ok(peer, `missing LAN beacon peer in ${result.stdout}`);
  assert.equal(peer.name, "Beacon Test Host");
  assert.equal(peer.source, "lan");
  assert.deepEqual(peer.sources, ["lan"]);
  assert.deepEqual(peer.addrs, ["127.0.0.1"]);
  assert.equal(peer.pairingAddress, "127.0.0.1");
  assert.equal(peer.hostUser, "alice");
  assert.equal(peer.status, "connect");
  assert.equal(peers.some((p) => p.name === "Wrong Kind Host" || p.fp === "SHA256:wrongKind"), false);
  console.log(`${testFile} REDGREEN 1 0`);
})().catch((error) => {
  console.error(`${testFile} REDGREEN 0 1`);
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
