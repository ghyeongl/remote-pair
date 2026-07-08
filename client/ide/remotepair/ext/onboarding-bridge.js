// onboarding-bridge.js — Node ↔ xpair CLI bridge for the IDE-embedded client onboarding.
//
// The client onboarding runs inside the Xpair IDE (VSCodium) as a webview; this module is the
// extension-side bridge the webview calls to perform REAL setup (Tailscale/SSH connection, file-access
// backend, folder mappings) via the `xpair` CLI. Per §0.1 the CLI is the brain — this bridge only
// shells out to it (argv-safe spawn, never a shell string), it does not reimplement install/map logic.
//
// Spec: .omc/specs/deep-interview-client-onboarding-real-wiring.md
const cp = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dgram = require("dgram");
const net = require("net");
const http = require("http");

// Zero-dep telemetry (PostHog capture + consent). Shared with the extension host. Consent is
// opt-in (default OFF) → all capture() calls below are no-ops until the user opts in.
const telemetry = require("./telemetry.js");

const HOME = os.homedir();
const RP_CLIENT_DIR = path.join(HOME, ".xpair/client");
const RP_HOST_DIR = path.join(HOME, ".xpair/host");
const CLIENT_ENV_FILE = path.join(RP_CLIENT_DIR, "client.env");
const LEGACY_CLIENT_ENV = path.join(RP_HOST_DIR, "client.env");
const SSH_KEY = path.join(HOME, ".ssh", "id_ed25519");
// Dedicated xpair pairing key — used ONLY for pairing (request signature), the SSH proof, and the
// paired runtime (launch/heartbeat/RD). Kept OUTSIDE ~/.ssh so it never collides with the user's
// personal id_ed25519: the host installs ONLY this key as the restricted, fingerprint-bound
// forced-command line, so the xpair-ssh-gate always runs and the proof completes. Generated
// unencrypted (owned by us) → signed raw, no ssh-agent needed.
const PAIRING_KEY = path.join(RP_HOST_DIR, "pairing_ed25519");
const SSH_KNOWN_HOSTS = path.join(HOME, ".ssh", "known_hosts");
const SSH_KNOWN_HOSTS_DEFAULTS = [
  SSH_KNOWN_HOSTS,
  path.join(HOME, ".ssh", "known_hosts2"),
  "/etc/ssh/ssh_known_hosts",
  "/etc/ssh/ssh_known_hosts2",
];
const HOST_RE = /^(?!-)[A-Za-z0-9._-]+$/;
const ACCOUNT_RE = /^(?!-)[A-Za-z0-9._-]+$/;
const SSH_TARGET_RE = /^(?:(?!-)[A-Za-z0-9._-]+@)?(?!-)[A-Za-z0-9._-]+$/;
const TAILNET_PAIRING_METADATA_PORT = 8891;
const GITHUB_XPAIR_URL_PREFIX = "https://github.com/x10lab/xpair/";
const HOST_SETUP_URL = "https://github.com/x10lab/xpair#host-setup";
const CLI_DOWNLOAD_URL = `${GITHUB_XPAIR_URL_PREFIX}releases/latest`;
const EFFECTIVE_KNOWN_HOSTS_FILES = new Map();
let sshEphemeralKnownHostsDir;

function validHost(host) {
  return HOST_RE.test(String(host || "").trim());
}

function invalidHost(host) {
  return `invalid host: ${String(host || "").trim()}`;
}

function validSshTarget(target) {
  return SSH_TARGET_RE.test(String(target || "").trim());
}

function invalidSshTarget(target) {
  return invalidHost(target);
}

function validAccount(account) {
  return ACCOUNT_RE.test(String(account || "").trim());
}

function invalidAccount(account) {
  return `invalid account: ${String(account || "").trim()}`;
}

function isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fileExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function win32XpairBin(env = process.env) {
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
  return path.win32.join(programFiles, "Xpair", "xpair.exe");
}

// P5 zip layout: build.sh bundles the native CLI at <app>/resources/app/bin/xpair.exe and this
// bridge ships at <app>/resources/app/extensions/remotepair/, so the bundled copy is two levels up.
// Checked FIRST on win32 so the zip works without a separate MSI install.
function win32BundledXpairBin() {
  return path.join(__dirname, "..", "..", "bin", "xpair.exe");
}

function resolveXpairCliBin({
  platform = process.platform,
  env = process.env,
  home = HOME,
  absOnly = false,
  exists = fileExists,
  executable = isExecutableFile,
} = {}) {
  if (platform === "win32") {
    const bundled = win32BundledXpairBin();
    if (exists(bundled)) return bundled;
    const installed = win32XpairBin(env);
    if (exists(installed)) return installed;
    return absOnly ? null : "xpair.exe";
  }
  const local = path.join(home, ".local", "bin", "xpair");
  if (executable(local)) return local;
  return absOnly ? null : "xpair";
}

/** Resolve the xpair binary (installed platform path, else on PATH). */
function rpBin() {
  return resolveXpairCliBin();
}

/** The xpair binary ONLY when it resolves to a real absolute path on disk; null when it would
 *  fall back to the bare "xpair" PATH lookup (which silently ENOENTs from a GUI Electron app whose
 *  inherited PATH omits ~/.local/bin). Used by the hard CLI guard so we never claim "ready" off a
 *  PATH guess. */
function rpBinAbs() {
  return resolveXpairCliBin({ absOnly: true });
}

function clientEnvPath() {
  try {
    if (fs.existsSync(CLIENT_ENV_FILE)) return CLIENT_ENV_FILE;
  } catch {
    /* fall back to the legacy path */
  }
  return LEGACY_CLIENT_ENV;
}

/** Client version SSOT — the same 0.5.0a{N} lockstep stamp the webview build embeds (read from the
 *  shared monotonic build counter). Repo-relative from this file: ext → remotepair → ide → client →
 *  repo-root. In a built app bundle the counter is absent, so we fall back to the base "0.5.0a". */
function clientVersion() {
  const candidates = [
    path.join(__dirname, "..", "..", "..", "..", "shared", ".build-counter"),
    path.join(__dirname, "shared", ".build-counter"),
  ];
  for (const f of candidates) {
    try {
      const n = fs.readFileSync(f, "utf8").trim();
      if (n) return `0.5.0a${n}`;
    } catch { /* try next */ }
  }
  return "0.5.0a";
}

/** Extract the major component of a version string for coarse compatibility (e.g. "0.5.0a3" → "0",
 *  "1.2.0" → "1"). Empty/garbage → "". */
function versionMajor(v) {
  const m = String(v || "").match(/^\s*(\d+)/);
  return m ? m[1] : "";
}

/** The OLDEST host version this client can talk to. **BUMP THIS** whenever a host↔client
 *  protocol/interface changes incompatibly — e.g. the a49 RD session-token requirement made
 *  rd-session-token and serve-webrtc --token mandatory, and a51 reworked the RD screen/control
 *  channel (serve_webrtc rewrite + new control.rs + rp-input-inject) this client now drives, so an
 *  a50-or-older host fails subtly (black RD / no input / "signaling closed 1006"). A same-major host
 *  OLDER than this connects today but breaks; gating it at onboarding with a clear "update the host"
 *  message is far better than a silent breakage. A host >= this is accepted. INVARIANT: the host cask
 *  (Casks/xpair-host.rb) must ship a version >= this floor, AND App.tsx's mirror must stay in sync. */
const MIN_COMPATIBLE_HOST = "0.5.0a51";

/** Compare two "X.Y.Z" or "X.Y.ZaN" version strings → -1 | 0 | 1 (a<b | a==b | a>b).
 *  The alpha suffix sorts BELOW the same release: 0.5.0a44 < 0.5.0a45 < 0.5.0 (a released X.Y.Z
 *  has no `aN`, so it ranks above every alpha of that X.Y.Z). Unparseable input → 0 (unknown). */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v || "").match(/^\s*(\d+)\.(\d+)\.(\d+)(?:a(\d+))?/);
    // 4th field: alpha number, or Infinity for a non-alpha release (ranks above any aN).
    return m ? [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : Infinity] : null;
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The standard user-tool PATH a GUI Electron app is missing (its inherited PATH is minimal). */
function richPath() {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
    return [
      path.win32.join(programFiles, "Xpair"),
      process.env.PATH || "",
    ].filter(Boolean).join(";");
  }
  return `${HOME}/.local/bin:${HOME}/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`;
}

/** Resolve the running ssh-agent's auth socket. A GUI Electron app launched from Finder/Dock does
 *  NOT inherit SSH_AUTH_SOCK, so ssh can't reach the agent and silently falls back to a password
 *  prompt even when key auth would succeed in a terminal. Recover it so probes use key auth. Returns
 *  the socket path, or "" if none is found (caller simply omits SSH_AUTH_SOCK then).
 *
 *  Order: an EXPLICIT non-system SSH_AUTH_SOCK (a deliberately forwarded/custom agent) wins; else
 *  the 1Password SSH agent if its socket is present (extremely common — keys configured as
 *  `IdentityFile ~/.ssh/*.pub` are held there, and the system launchd agent can NOT sign them);
 *  else whatever the env held; else the macOS system launchd agent discovered on disk.
 *
 *  Subtlety: a GUI app does NOT inherit a useful SSH_AUTH_SOCK — launchd injects the macOS *system*
 *  ssh-agent socket (/var/run|/private/tmp/com.apple.launchd.<id>/Listeners), which holds no
 *  1Password keys. So that auto-injected value must NOT short-circuit the 1Password lookup, or host
 *  connect/update silently fails for 1Password users (the reported "update host" loop). */
function sshAuthSock() {
  const env = process.env.SSH_AUTH_SOCK || "";
  const isSystemAgent = /\/com\.apple\.launchd\.[^/]+\/Listeners$/.test(env);
  if (env && !isSystemAgent) return env; // explicit/custom agent → respect it
  // 1Password SSH agent — fixed socket under the app's Group Container.
  try {
    const op = path.join(HOME, "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock");
    if (fs.existsSync(op)) return op;
  } catch { /* not installed — fall through */ }
  if (env) return env; // system agent, no 1Password → use what we were given
  try {
    // macOS: the system agent socket lives in a per-boot dir named like
    // /private/tmp/com.apple.launchd.XXXX/Listeners — find the newest one.
    const tmp = "/private/tmp";
    const dirs = fs
      .readdirSync(tmp)
      .filter((d) => d.startsWith("com.apple.launchd."))
      .map((d) => path.join(tmp, d, "Listeners"))
      .filter((p) => {
        try { return fs.existsSync(p); } catch { return false; }
      });
    if (dirs.length) return dirs[dirs.length - 1];
  } catch { /* no system agent socket — fall through */ }
  return "";
}

/** Spawn env for child processes (PATH enrichment + ssh-agent recovery). When a GUI Electron app
 *  shells out to ssh (directly or via the xpair CLI), this restores both the user PATH and the
 *  SSH_AUTH_SOCK the desktop launch dropped, so ssh uses key auth instead of falling to password. */
function spawnEnv(extra = {}) {
  const env = { ...process.env, PATH: richPath(), ...extra };
  const sock = sshAuthSock();
  if (sock) env.SSH_AUTH_SOCK = sock;
  return env;
}

function sshControlPath() {
  return "/tmp/rp-cm-" + (process.env.RP_SSH_CM_TAG || "x") + "-%C";
}

function sshControlMasterArgs() {
  if (process.platform === "win32") return [];
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${sshControlPath()}`,
    "-o", "ControlPersist=300",
  ];
}

function sshEphemeralKnownHostsPath() {
  if (sshEphemeralKnownHostsDir === undefined) {
    let dir = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-kh-"));
      sshEphemeralKnownHostsDir = dir;
      process.on("exit", () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      });
    } catch {
      sshEphemeralKnownHostsDir = null;
    }
  }
  return sshEphemeralKnownHostsDir ? path.join(sshEphemeralKnownHostsDir, "known_hosts") : null;
}

function effectiveKnownHostsFiles(host) {
  const h = String(host || "").trim();
  if (!h) return null;
  if (EFFECTIVE_KNOWN_HOSTS_FILES.has(h)) return EFFECTIVE_KNOWN_HOSTS_FILES.get(h);
  try {
    const out = cp.execFileSync("ssh", ["-G", h], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!out) {
      EFFECTIVE_KNOWN_HOSTS_FILES.set(h, null);
      return null;
    }
    const seen = new Set();
    const files = [];
    for (const line of String(out).split("\n")) {
      const m = line.match(/^\s*(userknownhostsfile|globalknownhostsfile)\s+(.+?)\s*$/i);
      if (!m) continue;
      const tokens = m[2].split(/\s+/).filter(Boolean);
      for (let i = 0; i < tokens.length;) {
        let best = "";
        let bestEnd = -1;
        let acc = "";
        for (let j = i; j < tokens.length; j++) {
          acc = acc ? `${acc} ${tokens[j]}` : tokens[j];
          let exists = false;
          try { exists = fs.existsSync(acc); } catch { exists = false; }
          if (exists) {
            best = acc;
            bestEnd = j;
          }
        }
        if (best) {
          if (!seen.has(best)) {
            seen.add(best);
            files.push(best);
          }
          i = bestEnd + 1;
        } else {
          i += 1;
        }
      }
    }
    EFFECTIVE_KNOWN_HOSTS_FILES.set(h, files);
    return files;
  } catch {
    EFFECTIVE_KNOWN_HOSTS_FILES.set(h, null);
    return null;
  }
}

function sshConfigDoubleQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sshUserKnownHostsFileOption(host) {
  const ephemeral = sshEphemeralKnownHostsPath();
  const effective = effectiveKnownHostsFiles(host);
  const files = effective === null ? SSH_KNOWN_HOSTS_DEFAULTS : effective;
  const seen = new Set();
  return [ephemeral, ...files]
    .filter((file) => typeof file === "string" && file.length > 0)
    .filter((file) => {
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    })
    .map(sshConfigDoubleQuote)
    .join(" ");
}

function hostKeyMismatch(err) {
  return {
    ok: false,
    err,
    state: SSH_STATE.HOST_KEY_MISMATCH,
    action: SSH_ACTION.RECOVER_HOST_KEY,
  };
}

function knownHostsKeyLines(out) {
  return String(out || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function keyIdentity(line) {
  const fields = String(line || "").trim().split(/\s+/).filter(Boolean);
  const i = fields.findIndex((f) => /^(?:ssh|ecdsa|sk)-/.test(f));
  return i >= 0 && fields[i + 1] ? `${fields[i]} ${fields[i + 1]}` : "";
}

function preferEd25519(lines) {
  return lines.find((line) => keyIdentity(line).startsWith("ssh-ed25519 ")) || lines[0] || "";
}

function removeKnownHostsLine(file, line) {
  const target = String(line || "").trim();
  if (!target) return;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const hadFinalNewline = raw.endsWith("\n");
    const source = hadFinalNewline ? raw.slice(0, -1) : raw;
    const kept = (source ? source.split("\n") : []).filter((l) => l.trim() !== target);
    const next = kept.length ? kept.join("\n") + (hadFinalNewline ? "\n" : "") : "";
    fs.writeFileSync(file, next, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  } catch {
    /* best effort */
  }
}

async function fingerprintKnownHostsLine(line, useStdin) {
  if (useStdin) {
    const r = await runSecretStdin("ssh-keygen", ["-lf", "-"], line);
    if (r.code !== 0) return "";
    const fields = String(r.out || "").trim().split(/\s+/);
    return fields[1] || "";
  }

  let dir = "";
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-kh-fp-"));
    const tmp = path.join(dir, "known_hosts");
    fs.writeFileSync(tmp, `${line}\n`, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    const r = await run("ssh-keygen", ["-lf", tmp]);
    if (r.code !== 0) return "";
    const fields = String(r.out || "").trim().split(/\s+/);
    return fields[1] || "";
  } finally {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

async function hostKeyLinesFromEphemeral(host, lookupName) {
  const ephemeral = sshEphemeralKnownHostsPath();
  if (!ephemeral) return [];
  const seen = new Set();
  for (const name of [lookupName, host]) {
    const key = String(name || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      const r = await run("ssh-keygen", ["-F", key, "-f", ephemeral]);
      const lines = knownHostsKeyLines(r.out);
      if (lines.length) return lines;
    } catch {
      /* try the next lookup name */
    }
  }
  return [];
}

async function liveHostKeyLine(scanHost, scanPort) {
  const host = String(scanHost || "").trim();
  const port = String(scanPort || "22").trim() || "22";
  if (!host) return "";
  const r = await run("ssh-keyscan", ["-t", "ed25519", "-T", "5", "-p", port, host]);
  if (r.code !== 0) return "";
  return preferEd25519(knownHostsKeyLines(r.out));
}

function seedEphemeralHostKey(lookupName, line) {
  const ephemeral = sshEphemeralKnownHostsPath();
  const name = String(lookupName || "").trim();
  const raw = String(line || "").trim();
  if (!ephemeral || !name || !raw) return;
  try {
    const rewritten = raw.replace(/^\S+(\s+)/, `${name}$1`);
    fs.mkdirSync(path.dirname(ephemeral), { recursive: true });
    fs.appendFileSync(ephemeral, `${rewritten}\n`, { mode: 0o600 });
    try { fs.chmodSync(ephemeral, 0o600); } catch { /* best effort */ }
  } catch {
    /* best effort */
  }
}

function expandHomePath(p) {
  const s = String(p || "");
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

function firstUserKnownHostsFile(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const tokens = raw.split(/\s+/).filter(Boolean);
  const first = tokens[0] || "";
  if (first.toLowerCase() === "none") return "none";
  let best = "";
  let acc = "";
  for (const token of tokens) {
    acc = acc ? `${acc} ${token}` : token;
    const candidate = expandHomePath(acc);
    let parentExists = false;
    try { parentExists = fs.existsSync(path.dirname(candidate)); } catch { parentExists = false; }
    if (parentExists) best = candidate;
  }
  return best;
}

async function durableKnownHostsReadback(host) {
  const h = String(host || "").trim();
  const fallback = { isNone: false, file: "", lookupName: h, scanHost: h, scanPort: "22" };
  const r = await run("ssh", ["-G", h]);
  if (r.code !== 0) return fallback;

  let file = "";
  let hostname = "";
  let port = "";
  let hostkeyalias = "";
  for (const line of String(r.out || "").split("\n")) {
    const m = line.match(/^\s*(userknownhostsfile|hostname|port|hostkeyalias)\s+(.+?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === "userknownhostsfile" && !file) file = firstUserKnownHostsFile(value);
    else if (key === "hostname") hostname = value.trim().split(/\s+/)[0] || "";
    else if (key === "port") port = value.trim().split(/\s+/)[0] || "";
    else if (key === "hostkeyalias") {
      const alias = value.trim().split(/\s+/)[0] || "";
      hostkeyalias = alias.toLowerCase() === "none" ? "" : alias;
    }
  }
  const lookupHost = hostname || h;
  const scanPort = port || "22";
  if (String(file).toLowerCase() === "none") {
    return { isNone: true, file: "", lookupName: "", scanHost: lookupHost, scanPort };
  }

  const lookupName = hostkeyalias
    ? hostkeyalias
    : (port && port !== "22" ? `[${lookupHost}]:${port}` : lookupHost);
  return { isNone: false, file, lookupName, scanHost: lookupHost, scanPort };
}

function shSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function shPathQuotePreserveHome(p) {
  const s = String(p);
  if (s === "~") return "~";
  if (s === "~/") return "~/";
  if (s.startsWith("~/")) return "~/" + shSingleQuote(s.slice(2));
  const m = s.match(/^(~[A-Za-z0-9._-]*)(?:\/(.*))?$/);
  if (m) return m[2] === undefined ? m[1] : `${m[1]}/${shSingleQuote(m[2])}`;
  return shSingleQuote(s);
}

/** Expand a leading ~ / ~/… in a CLIENT (local) path to the absolute home dir. The CLI's
 *  `xpair map add` runs `cd "$2"` on the client path, and a quoted argument is NOT tilde-expanded by
 *  the shell, so ~ paths would fail with "client path not found". Host paths are resolved separately
 *  over SSH (resolveHostPath) — this is the local side only. */
function expandClientHome(p) {
  const s = String(p || "");
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Non-interactive ssh options for reachability/read probes: name the key explicitly, force
 *  publickey-only auth, and BatchMode so ssh NEVER drops to a password/passphrase prompt (which
 *  would hang or spawn an out-of-band GUI prompt). Used by every read/probe ssh call and by the
 *  install preflight: fingerprint-confirmed key auth is the primary path. ControlMaster is shared
 *  within one app launch via RP_SSH_CM_TAG so probes/tunnels multiplex over one authenticated SSH
 *  master without reusing a previous launch's stale master. */
function sshProbeOpts(host, connectTimeout = 5) {
  const opts = [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeout}`,
    "-o", "ConnectionAttempts=1",
    ...sshControlMasterArgs(),
    "-o", "PreferredAuthentications=publickey",
    "-o", "PubkeyAuthentication=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", `UserKnownHostsFile=${sshUserKnownHostsFileOption(host)}`,
    "-o", "StrictHostKeyChecking=accept-new",
  ];
  pushProbeIdentities(opts);
  return opts;
}

/** OFFER the pairing key (and the personal key) via -i, but do NOT set IdentitiesOnly. The pairing key
 *  may exist locally from an ATTEMPTED-but-unproven pairing (host denied / proof expired / acceptance
 *  failed), where it is NOT yet authorized on the host. Adding -i still lets ssh fall back to the
 *  ssh-agent AND the user's default identities — IdentitiesOnly=yes would restrict auth to ONLY these
 *  files, breaking a user whose working host auth is agent-only (no id_ed25519 on disk). The pairing
 *  PROOF login is the ONLY caller that must force the pairing key alone — sshPairingProofOpts. */
function pushProbeIdentities(opts) {
  try {
    if (fs.existsSync(PAIRING_KEY)) opts.push("-i", PAIRING_KEY);
    if (fs.existsSync(SSH_KEY)) opts.push("-i", SSH_KEY);
  } catch { /* key probe failed — let ssh use the agent / defaults */ }
}

/** Options for the pairing PROOF login: a FRESH, non-multiplexed connection that forces ONLY the
 *  pairing key. Must NOT reuse sshProbeOpts' shared ControlMaster — an earlier probe over the same
 *  ControlPath (authenticated with the user's normal key when the host was already reachable) would be
 *  reused, so the forced xpair-ssh-gate would never see pairing_ed25519 and the host would stay stuck
 *  at accepted-pending-proof. ControlMaster=no + ControlPath=none guarantees a new authentication. */
function sshPairingProofOpts(host, connectTimeout = 5) {
  return [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeout}`,
    "-o", "ConnectionAttempts=1",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "PreferredAuthentications=publickey",
    "-o", "PubkeyAuthentication=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", `UserKnownHostsFile=${sshUserKnownHostsFileOption(host)}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "IdentitiesOnly=yes", "-i", PAIRING_KEY,
  ];
}

function sshDurablePinOpts(connectTimeout = 5) {
  const opts = [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeout}`,
    "-o", "ConnectionAttempts=1",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "PreferredAuthentications=publickey",
    "-o", "PubkeyAuthentication=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "HostKeyAlgorithms=ssh-ed25519",
  ];
  pushProbeIdentities(opts);
  return opts;
}

const SSH_STATE = Object.freeze({
  READY: "ready",
  INVALID_HOST: "invalid_host",
  INVALID_ACCOUNT: "invalid_account",
  HOST_KEY_MISMATCH: "host_key_mismatch",
  KEY_AUTH_BLOCKED: "key_auth_blocked",
  NEEDS_PASSWORD: "needs_password",
  PASSWORD_DENIED: "password_denied",
  UNREACHABLE: "unreachable",
});

const SSH_ACTION = Object.freeze({
  CONTINUE: "continue",
  ABORT: "abort",
  RECOVER_HOST_KEY: "recover_host_key",
  APPROVE_OR_RETRY: "approve_or_retry",
  PROMPT_PASSWORD: "prompt_password",
  RETRY: "retry",
});

function sshFailureKind(err) {
  const s = String(err || "");
  if (/REMOTE HOST IDENTIFICATION|Host key verification failed|POSSIBLE DNS SPOOFING|Offending .*known_hosts|host key .*changed/i.test(s)) {
    return SSH_STATE.HOST_KEY_MISMATCH;
  }
  if (/Permission denied \(publickey|sign_and_send_pubkey|agent refused operation|Could not open a connection to your authentication agent|Enter passphrase|passphrase|Too many authentication failures|no such identity|identity file .*not accessible|Load key .*Permission denied|Load key .*invalid format|error in libcrypto/i.test(s)) {
    return SSH_STATE.KEY_AUTH_BLOCKED;
  }
  return SSH_STATE.UNREACHABLE;
}

function isHostKeyVerificationFailure(err) {
  return /host key verification failed|no .*host key is known|is not known|REMOTE HOST IDENTIFICATION HAS CHANGED|host key.*has changed/i.test(
    String(err || "")
  );
}

function isSshNetworkFailure(err) {
  return /could not resolve hostname|name or service not known|temporary failure in name resolution|connection refused|connection timed out|operation timed out|network is unreachable|no route to host|kex_exchange_identification|connection closed by remote host|connection closed by|connection reset by peer|banner exchange|broken pipe/i.test(
    String(err || "")
  );
}

function isRemotePublickeyDenied(err) {
  return /Permission denied \((?=[^)]*publickey)[^)]*\)/i.test(String(err || ""));
}

// LOCAL key/agent problems — the key can't sign on THIS machine, which is NOT "the host hasn't
// authorized us". ssh may print both (e.g. `sign_and_send_pubkey: agent refused operation` then
// `Permission denied (publickey)`); when a local marker is present we must keep the approve/unlock
// recovery path and NOT spend the account password authorizing an unusable key.
function isLocalKeyFailure(err) {
  return /sign_and_send_pubkey|agent refused operation|Load key [^\n]*:|passphrase|Too many authentication failures|no mutual signature|key_load_public|invalid format|error in libcrypto|No more authentication methods|not accessible/i.test(
    String(err || "")
  );
}

function isPasswordDenied(err) {
  const s = String(err || "");
  return /PASSWORD_DENIED/i.test(s) || /Permission denied \((?=[^)]*password)[^)]*\)/i.test(s);
}

function sshFailureMessage(state, err) {
  if (state === SSH_STATE.HOST_KEY_MISMATCH) {
    return "SSH host key mismatch: the host identity changed. Re-confirm the fingerprint, remove the stale known_hosts entry if this is your Mac, then retry.";
  }
  if (state === SSH_STATE.KEY_AUTH_BLOCKED) {
    return "SSH key auth blocked: unlock or approve your SSH agent/key passphrase, make sure this Mac's public key is authorized on the host, then retry.";
  }
  if (state === SSH_STATE.NEEDS_PASSWORD) {
    return "This host has not authorized this Mac's SSH key yet. Enter the host account password to authorize it once.";
  }
  if (state === SSH_STATE.PASSWORD_DENIED) {
    return "The host account password was denied. Check it and try again.";
  }
  return err || "could not reach host over SSH";
}

function sshActionForState(state) {
  if (state === SSH_STATE.READY) return SSH_ACTION.CONTINUE;
  if (state === SSH_STATE.INVALID_HOST || state === SSH_STATE.INVALID_ACCOUNT) return SSH_ACTION.ABORT;
  if (state === SSH_STATE.HOST_KEY_MISMATCH) return SSH_ACTION.RECOVER_HOST_KEY;
  if (state === SSH_STATE.KEY_AUTH_BLOCKED) return SSH_ACTION.APPROVE_OR_RETRY;
  if (state === SSH_STATE.NEEDS_PASSWORD || state === SSH_STATE.PASSWORD_DENIED) return SSH_ACTION.PROMPT_PASSWORD;
  return SSH_ACTION.RETRY;
}

function sshResult(r, fallbackErr) {
  if (r.code === 0) {
    return {
      reachable: true,
      err: "",
      state: SSH_STATE.READY,
      action: SSH_ACTION.CONTINUE,
    };
  }
  const raw = r.err || r.out || fallbackErr || "could not reach host over SSH";
  const state = sshFailureKind(raw);
  return {
    reachable: false,
    err: sshFailureMessage(state, raw),
    state,
    action: sshActionForState(state),
  };
}

/** Run argv-safe; resolve {code, out, err} (never rejects).
 *  When spawned from a GUI Electron app the inherited PATH is minimal; prepend the standard
 *  user-tool locations so `tailscale`, `ssh`, etc. resolve without requiring a shell wrapper. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = cp.spawn(cmd, args, {
        windowsHide: true,
        env: spawnEnv(),
        ...opts,
      });
    } catch (e) {
      return resolve({ code: -1, out: "", err: String(e && e.message ? e.message : e) });
    }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e.message) }));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}
const cli = (args) => run(rpBin(), args);

/** Like run(), but writes ONE secret line to the child's STDIN (fd 0) then closes it — for handing a
 *  secret to a child/remote command WITHOUT it ever touching argv (`ps`), a log line, or disk. ssh
 *  forwards its own stdin to the remote command's stdin, and install-host reads its bootstrap account
 *  password from stdin before setting up its bash-managed askpass fd. The secret is written once and
 *  the pipe closed immediately. */
function runSecretStdin(cmd, args, secret) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = cp.spawn(cmd, args, {
        windowsHide: true,
        env: spawnEnv(),
        stdio: ["pipe", "pipe", "pipe"], // fd0 = secret pipe
      });
    } catch (e) {
      return resolve({ code: -1, out: "", err: String(e && e.message ? e.message : e) });
    }
    try {
      child.stdin.on("error", () => {}); // EPIPE if the remote never reads — benign.
      child.stdin.write(String(secret) + "\n");
      child.stdin.end();
    } catch {
      /* a write race (child already gone) must never crash the main process */
    }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e.message) }));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

function cliWithPasswordStdin(args, secret) {
  return runSecretStdin(rpBin(), [...args, "--password-stdin"], secret);
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function readU32(buf, off) {
  if (off + 4 > buf.length) throw new Error("truncated uint32");
  return [buf.readUInt32BE(off), off + 4];
}

function readSSHString(buf, off) {
  const [len, next] = readU32(buf, off);
  if (next + len > buf.length) throw new Error("truncated ssh string");
  return [buf.subarray(next, next + len), next + len];
}

function sshString(buf) {
  const b = Buffer.from(buf);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function canonicalPairingTranscript(hostKeyFP, hostNonce, serviceInstanceID, clientPubKey, timestamp) {
  return Buffer.concat(
    [hostKeyFP, hostNonce, serviceInstanceID, clientPubKey, String(timestamp)].map((field) =>
      sshString(Buffer.from(String(field), "utf8"))
    )
  );
}

function sanitizeEd25519PublicKey(pubkey) {
  const parts = String(pubkey || "").trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== "ssh-ed25519") {
    throw new Error("expected ssh-ed25519 public key");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) {
    throw new Error("invalid ed25519 public key blob");
  }
  // Drop comments/options before sending. The host accepts exactly "ssh-ed25519 <base64>".
  return `ssh-ed25519 ${parts[1]}`;
}

function parseEd25519PublicKey(pubkey) {
  const clean = sanitizeEd25519PublicKey(pubkey);
  const [, b64] = clean.split(/\s+/);
  const blob = Buffer.from(b64, "base64");
  let off = 0;
  let field;
  [field, off] = readSSHString(blob, off);
  if (field.toString("utf8") !== "ssh-ed25519") throw new Error("public key type is not ssh-ed25519");
  let raw;
  [raw, off] = readSSHString(blob, off);
  if (raw.length !== 32 || off !== blob.length) throw new Error("bad ed25519 public key blob");
  const fp = "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=/g, "");
  return { clean, blob, raw, fingerprint: fp };
}

function clientIDForKeyBlob(keyBlob) {
  return b64url(crypto.createHash("sha256").update(String(keyBlob), "utf8").digest()).slice(0, 24);
}

function parseOpenSSHEd25519PrivateKey(pem) {
  const b64 = String(pem || "")
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----|-----END OPENSSH PRIVATE KEY-----|\s/g, "");
  const buf = Buffer.from(b64, "base64");
  const magic = Buffer.from("openssh-key-v1\0", "utf8");
  if (buf.length < magic.length || !buf.subarray(0, magic.length).equals(magic)) {
    throw new Error("not an OpenSSH private key");
  }
  let off = magic.length;
  let cipher, kdf, kdfOptions;
  [cipher, off] = readSSHString(buf, off);
  [kdf, off] = readSSHString(buf, off);
  [kdfOptions, off] = readSSHString(buf, off);
  void kdfOptions;
  if (cipher.toString("utf8") !== "none" || kdf.toString("utf8") !== "none") {
    throw new Error("encrypted OpenSSH private keys are not supported for pairing signatures");
  }
  const [nkeys, afterN] = readU32(buf, off);
  off = afterN;
  if (nkeys !== 1) throw new Error("expected one OpenSSH private key");
  let pubBlob, privateBlob;
  [pubBlob, off] = readSSHString(buf, off);
  [privateBlob, off] = readSSHString(buf, off);
  void pubBlob;
  let poff = 0;
  const [check1, poff1] = readU32(privateBlob, poff);
  const [check2, poff2] = readU32(privateBlob, poff1);
  poff = poff2;
  if (check1 !== check2) throw new Error("OpenSSH private key checkints differ");
  let type, pubRaw, privRaw;
  [type, poff] = readSSHString(privateBlob, poff);
  if (type.toString("utf8") !== "ssh-ed25519") throw new Error("private key is not ssh-ed25519");
  [pubRaw, poff] = readSSHString(privateBlob, poff);
  [privRaw, poff] = readSSHString(privateBlob, poff);
  if (pubRaw.length !== 32 || privRaw.length !== 64 || !privRaw.subarray(32, 64).equals(pubRaw)) {
    throw new Error("bad ed25519 private key shape");
  }
  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    d: b64url(privRaw.subarray(0, 32)),
    x: b64url(pubRaw),
  };
  return { keyObject: crypto.createPrivateKey({ key: jwk, format: "jwk" }), publicRaw: pubRaw };
}

function sshAgentRequest(payload, timeoutMs = 5000) {
  const sockPath = sshAuthSock();
  if (!sockPath) return Promise.reject(new Error("ssh-agent socket not found"));
  const body = Buffer.from(payload);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return new Promise((resolve, reject) => {
    let done = false;
    let chunks = [];
    let total = 0;
    let expected = null;
    const socket = net.createConnection(sockPath);
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("ssh-agent request timed out")), timeoutMs);
    socket.on("connect", () => socket.write(Buffer.concat([len, body])));
    socket.on("error", (err) => finish(err));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      const buf = Buffer.concat(chunks, total);
      if (expected === null && buf.length >= 4) expected = buf.readUInt32BE(0);
      if (expected !== null && buf.length >= expected + 4) {
        finish(null, buf.subarray(4, 4 + expected));
      }
    });
    socket.on("end", () => {
      if (!done) finish(new Error("ssh-agent closed before responding"));
    });
  });
}

async function sshAgentIdentities() {
  const SSH_AGENTC_REQUEST_IDENTITIES = 11;
  const SSH_AGENT_IDENTITIES_ANSWER = 12;
  const response = await sshAgentRequest(Buffer.from([SSH_AGENTC_REQUEST_IDENTITIES]));
  if (!response.length || response[0] !== SSH_AGENT_IDENTITIES_ANSWER) {
    throw new Error("ssh-agent did not return identities");
  }
  let [count, off] = readU32(response, 1);
  const identities = [];
  for (let i = 0; i < count; i++) {
    let blob, comment;
    [blob, off] = readSSHString(response, off);
    [comment, off] = readSSHString(response, off);
    identities.push({ blob, comment: comment.toString("utf8") });
  }
  return identities;
}

async function signWithAgent(pubBlob, transcript) {
  const SSH_AGENTC_SIGN_REQUEST = 13;
  const SSH_AGENT_SIGN_RESPONSE = 14;
  const SSH_AGENT_FAILURE = 5;
  const identities = await sshAgentIdentities();
  const match = identities.find((identity) => identity.blob.equals(pubBlob));
  if (!match) throw new Error("client key is not loaded in ssh-agent");
  const flags = Buffer.alloc(4);
  flags.writeUInt32BE(0, 0);
  const payload = Buffer.concat([
    Buffer.from([SSH_AGENTC_SIGN_REQUEST]),
    sshString(match.blob),
    sshString(transcript),
    flags,
  ]);
  const response = await sshAgentRequest(payload);
  if (!response.length || response[0] === SSH_AGENT_FAILURE) {
    throw new Error("ssh-agent refused to sign with the client key");
  }
  if (response[0] !== SSH_AGENT_SIGN_RESPONSE) {
    throw new Error("ssh-agent returned an unexpected signing response");
  }
  let sigBlob;
  [sigBlob] = readSSHString(response, 1);
  let off = 0;
  let sigType, rawSig;
  [sigType, off] = readSSHString(sigBlob, off);
  [rawSig, off] = readSSHString(sigBlob, off);
  if (sigType.toString("utf8") !== "ssh-ed25519" || rawSig.length !== 64 || off !== sigBlob.length) {
    throw new Error("ssh-agent returned a non-ed25519 signature");
  }
  return rawSig;
}

async function ensurePairingKey() {
  try {
    fs.mkdirSync(RP_HOST_DIR, { recursive: true });
    fs.chmodSync(RP_HOST_DIR, 0o700);
  } catch { /* best-effort dir perms */ }
  if (!fs.existsSync(PAIRING_KEY)) {
    await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", PAIRING_KEY, "-C", "xpair-pairing", "-q"]);
  }
  try { fs.chmodSync(PAIRING_KEY, 0o600); } catch { /* ssh-keygen already sets 600 */ }
  return fs.existsSync(PAIRING_KEY);
}

/** The SSH identity for ALL client→host xpair connections: the dedicated pairing key once it exists
 *  (installed on the host as the restricted, fingerprint-bound authorized_keys line), else the
 *  personal id_ed25519 as a pre-pairing fallback. id_ed25519 is NEVER installed by pairing. */
function pairingIdentityKey() {
  try { if (fs.existsSync(PAIRING_KEY)) return PAIRING_KEY; } catch { /* fall through to default key */ }
  return SSH_KEY;
}

/** Sign the pairing transcript with the DEDICATED pairing key. It is generated unencrypted and owned
 *  by us, so it signs directly (no ssh-agent, no encrypted-key handling). */
function signPairingTranscript(transcript) {
  const privateKey = parseOpenSSHEd25519PrivateKey(fs.readFileSync(PAIRING_KEY, "utf8"));
  return crypto.sign(null, transcript, privateKey.keyObject);
}

function sshTargetHost(target) {
  const s = String(target || "").trim();
  const at = s.indexOf("@");
  return at === -1 ? s : s.slice(at + 1);
}

function pairingMetadataURL(host) {
  const h = sshTargetHost(host);
  const wrapped = h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
  return `http://${wrapped}:${TAILNET_PAIRING_METADATA_PORT}/.well-known/xpair-pairing.json`;
}

function fetchPairingMetadata(host, timeoutMs = 1200) {
  const h = sshTargetHost(host);
  if (!validHost(h)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get(pairingMetadataURL(h), { timeout: timeoutMs }, (res) => {
      let body = "";
      if (res.statusCode && res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 16384) req.destroy();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body || "{}"));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

function normalizePairingMetadata(metadata) {
  const fpRaw = String(metadata?.hostKeyFP || metadata?.fp || "");
  const fp = fpRaw ? (fpRaw.startsWith("SHA256:") ? fpRaw : `SHA256:${fpRaw}`) : "";
  const serviceInstanceID = String(metadata?.serviceInstanceID || metadata?.sid || "");
  const hostNonce = String(metadata?.hostNonce || metadata?.nonce || "");
  const pairPort = Number(metadata?.pairPort || metadata?.pp || 0);
  const hostUser = String(metadata?.hostUser || metadata?.user || "");
  if (!fp || !serviceInstanceID || !hostNonce || !Number.isInteger(pairPort) || pairPort <= 0 || pairPort > 65535) {
    return {
      ok: false,
      fp,
      serviceInstanceID,
      hostNonce,
      pairPort: Number.isFinite(pairPort) ? pairPort : 0,
      hostUser,
      err: "pairing metadata incomplete",
    };
  }
  return { ok: true, fp, serviceInstanceID, hostNonce, pairPort, hostUser, err: "" };
}

function sendUdpJSON(host, port, obj) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    socket.send(payload, Number(port), host, (err) => {
      socket.close();
      resolve(err ? { ok: false, err: err.message } : { ok: true, err: "" });
    });
  });
}

function commandOutput(cmd, args) {
  try {
    const r = cp.spawnSync(cmd, args, { encoding: "utf8", timeout: 1200, windowsHide: true });
    return r.status === 0 ? String(r.stdout || "") : "";
  } catch {
    return "";
  }
}

function currentGatewayMac() {
  const route = commandOutput("/sbin/route", ["-n", "get", "default"]);
  const gm = route.match(/gateway:\s*([^\s]+)/);
  if (!gm) return "";
  const arp = commandOutput("/usr/sbin/arp", ["-n", gm[1]]);
  const mm = arp.match(/\bat\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i);
  return mm ? mm[1].toLowerCase() : "";
}

function normalizeMac(mac) {
  const parts = String(mac || "").trim().split(/[:-]/).filter(Boolean);
  if (parts.length !== 6) return "";
  if (!parts.every((p) => /^[0-9a-f]{1,2}$/i.test(p))) return "";
  return parts.map((p) => p.toLowerCase().padStart(2, "0")).join(":");
}

function win32DefaultGateway() {
  const route = commandOutput("route", ["print", "0.0.0.0"]);
  let match = route.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+/m);
  if (match) return match[1];

  const ps = commandOutput("powershell", [
    "-NoProfile",
    "-Command",
    "Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1 -ExpandProperty NextHop",
  ]);
  match = ps.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return match ? match[1] : "";
}

function currentGatewayMacWin32() {
  const gateway = win32DefaultGateway();
  if (!gateway) return { mac: "", err: "default gateway not found" };
  const arp = commandOutput("arp", ["-a", gateway]);
  const escapedGateway = gateway.replace(/\./g, "\\.");
  const re = new RegExp(`^\\s*${escapedGateway}\\s+([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\\s+`, "im");
  const match = arp.match(re) || arp.match(/\b([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\b/i);
  const mac = match ? normalizeMac(match[1]) : "";
  return mac ? { mac, err: "" } : { mac: "", err: `gateway MAC not found for ${gateway}` };
}

function logWin32GatewayFailOpen(err) {
  try {
    console.error(`xpair: win32 gateway MAC guard fail-open (${err || "unknown parse failure"})`);
  } catch {
    /* ignore */
  }
}

function gatewayMacVerdict(current, stored, updateBaseline) {
  if (updateBaseline || !stored) {
    upsertEnv("GATEWAY_MAC", current);
    return { allowed: true, state: "baseline", current, stored: current, err: "" };
  }
  if (stored !== current) {
    return { allowed: false, state: "changed", current, stored, err: "default gateway MAC changed" };
  }
  return { allowed: true, state: "same", current, stored, err: "" };
}

function gatewayMacStatus({ updateBaseline = false } = {}) {
  const stored = parseEnv(clientEnvPath()).GATEWAY_MAC || "";
  if (process.platform === "win32") {
    const current = currentGatewayMacWin32();
    if (!current.mac) {
      logWin32GatewayFailOpen(current.err);
      return { allowed: true, state: "unsupported-platform", current: "", stored, err: current.err };
    }
    return gatewayMacVerdict(current.mac, stored, updateBaseline);
  }
  if (process.platform !== "darwin") {
    return { allowed: true, state: "unsupported-platform", current: "", stored, err: "" };
  }
  const current = currentGatewayMac();
  // Roaming safety (blueprint §6.4): the gateway MAC is NOT auth, but auto-connect must FAIL CLOSED on
  // an unknown/changed network (a moved-network signal). It is never the security boundary (SSH host
  // key + the restricted, fingerprint-bound key is), so recovery is a user-confirmed re-baseline:
  // gatewayMacStatus({ updateBaseline: true }) (exposed as confirmGatewayBaseline) adopts the new
  // network on an explicit reconnect — no manual client.env edit needed.
  if (!current) {
    return { allowed: false, state: "unknown", current: "", stored, err: "default gateway MAC unknown" };
  }
  return gatewayMacVerdict(current, stored, updateBaseline);
}

/** True when the installed CLI can accept install-host --password-stdin. On Windows the native
 *  Rust MSI exe has supported the flag since its first release and generates its own askpass at
 *  runtime, so there is no xpair-askpass sibling to scan. On script CLIs (darwin/linux), require
 *  both the flag and the FIFO-capable sibling askpass marker; this mirrors the serving-gate
 *  rationale from #86 round 3: old script CLIs can pass `xpair status` while lacking a required
 *  onboarding capability. Conservative for scripts: unreadable → false. */
function cliSupportsPasswordStdin() {
  const bin = rpBinAbs();
  if (!bin) return false;
  if (process.platform === "win32") {
    return true;
  }
  try {
    if (!fs.readFileSync(bin, "utf8").includes("--password-stdin")) return false;
    // xpair-askpass ships next to the CLI (rp_askpass_path resolves it as a sibling). A CLI that
    // knows the flag but an old askpass that can't read the FIFO would still dead-end the bootstrap.
    const askpass = path.join(path.dirname(bin), "xpair-askpass");
    return fs.readFileSync(askpass, "utf8").includes("RP_ASKPASS_FIFO");
  } catch {
    return false;
  }
}

/* Does the INSTALLED script CLI convey the host's serving verdict? The guard trusts `serving` from a
 * modern host but falls back to ax/sr when it is absent (older HOST). A stale ~/.local/bin/xpair,
 * however, would DROP the field even from a modern host, letting a not-serving host through the ax/sr
 * fallback. Feature-detect non-Windows script source (same conservative pattern as
 * cliSupportsPasswordStdin): unreadable/old ⇒ false ⇒ the guard routes to WELCOME to reinstall the
 * bundled CLI. */
function cliSupportsServing() {
  const bin = rpBinAbs();
  if (!bin) return false;
  if (process.platform === "win32") {
    // Do not UTF-8 source-scan the native Rust MSI binary. The Rust CLI has shipped the five-TCC
    // host-permissions surface, including `serving`, since the first MSI; roadmap P1 predates any
    // MSI release. If a real MSI capability gap appears, add a dedicated capability verb.
    return true;
  }
  try {
    return fs.readFileSync(bin, "utf8").includes('d.get("serving")');
  } catch {
    return false;
  }
}

// --- Engine constants (claude | codex | opencode | shell) -------------------------------------
// Agent engines run ON THE HOST; these drive the host-side install/auth-check/auth-set guards.
// `shell` is a valid session engine (plain login shell, no install/auth guard), so it is only a
// member of SESSION_ENGINES — never of the install/auth-guarded ENGINES set.
const ENGINES = new Set(["claude", "codex", "opencode"]);
const SESSION_ENGINES = new Set([...ENGINES, "shell"]);

// Per-engine host probe: a single shell line (run over key-auth SSH) that prints a RP_* block:
//   RP_ENGINE_INSTALLED=1|0, RP_ENGINE_VERSION=<v>, RP_ENGINE_AUTHED=1 (only when authed).
// PATH is enriched first so a Homebrew/npm-global engine resolves under a non-login ssh command.
// Auth detection is engine-specific:
//   claude    — ANTHROPIC_API_KEY exported in the login shell, OR ~/.claude/.credentials.json (OAuth).
//   shell     — no auth; uses the host account's default login shell.
//   codex     — `codex login status` exits 0 (API key or ChatGPT login), OR ~/.codex/auth.json.
//   opencode  — a provider env var set (ANTHROPIC_API_KEY/OPENAI_API_KEY), OR ~/.local/share/opencode/auth.json.
const PATH_PREFIX =
  'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
const ENGINE_PROBE = {
  claude:
    PATH_PREFIX +
    'if command -v claude >/dev/null 2>&1; then echo RP_ENGINE_INSTALLED=1; ' +
    'echo "RP_ENGINE_VERSION=$(claude --version 2>/dev/null | head -1)"; ' +
    'KEY="$(bash -lc \'printf %s "$ANTHROPIC_API_KEY"\' 2>/dev/null)"; ' +
    'if [ -n "$KEY" ] || [ -f "$HOME/.claude/.credentials.json" ]; then echo RP_ENGINE_AUTHED=1; fi; ' +
    'else echo RP_ENGINE_INSTALLED=0; fi',
  shell:
    'SHELL_BIN="${SHELL:-/bin/zsh}"; ' +
    'if [ -x "$SHELL_BIN" ]; then echo RP_ENGINE_INSTALLED=1; echo "RP_ENGINE_VERSION=$SHELL_BIN"; echo RP_ENGINE_AUTHED=1; ' +
    'elif [ -x /bin/bash ]; then echo RP_ENGINE_INSTALLED=1; echo "RP_ENGINE_VERSION=/bin/bash"; echo RP_ENGINE_AUTHED=1; ' +
    'else echo RP_ENGINE_INSTALLED=0; fi',
  codex:
    PATH_PREFIX +
    'if command -v codex >/dev/null 2>&1; then echo RP_ENGINE_INSTALLED=1; ' +
    'echo "RP_ENGINE_VERSION=$(codex --version 2>/dev/null | head -1)"; ' +
    'if codex login status >/dev/null 2>&1 || [ -f "$HOME/.codex/auth.json" ]; then echo RP_ENGINE_AUTHED=1; fi; ' +
    'else echo RP_ENGINE_INSTALLED=0; fi',
  opencode:
    PATH_PREFIX +
    'if command -v opencode >/dev/null 2>&1; then echo RP_ENGINE_INSTALLED=1; ' +
    'echo "RP_ENGINE_VERSION=$(opencode --version 2>/dev/null | head -1)"; ' +
    'KEY="$(bash -lc \'printf %s "${ANTHROPIC_API_KEY}${OPENAI_API_KEY}"\' 2>/dev/null)"; ' +
    'if [ -n "$KEY" ] || [ -f "$HOME/.local/share/opencode/auth.json" ]; then echo RP_ENGINE_AUTHED=1; fi; ' +
    'else echo RP_ENGINE_INSTALLED=0; fi',
};

/** Parse a KEY="value" env file into an object. */
function parseEnv(file) {
  const env = {};
  let txt = "";
  try {
    txt = fs.readFileSync(file, "utf8");
  } catch {
    return env;
  }
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']/, "").replace(/["']\s*$/, "");
  }
  return env;
}

/** Upsert KEY="value" in client.env. (CLI `config set` only covers host|terminal; backend keys land here.) */
function upsertEnv(key, val) {
  let lines = [];
  try {
    lines = fs.readFileSync(clientEnvPath(), "utf8").split("\n");
  } catch {
    /* file may not exist yet */
  }
  const re = new RegExp("^\\s*" + key + "=");
  let found = false;
  lines = lines.map((l) => {
    if (re.test(l)) {
      found = true;
      return `${key}="${val}"`;
    }
    return l;
  });
  if (!found) lines.push(`${key}="${val}"`);
  try {
    fs.mkdirSync(RP_CLIENT_DIR, { recursive: true });
    fs.writeFileSync(CLIENT_ENV_FILE, lines.join("\n").replace(/\n+$/, "\n"));
  } catch {
    /* best effort */
  }
}

const bridge = {
  // CLI hard guard (global): is the `xpair` CLI actually usable on THIS machine? The whole onboarding
  // shells out to it, so if it isn't there every "real" step silently ENOENTs (code -1) and the wizard
  // would otherwise sail past. Two checks, both required:
  //   1. rpBinAbs() resolves to a real absolute path (NOT the bare "xpair" PATH guess that ENOENTs
  //      from a GUI Electron app whose inherited PATH omits ~/.local/bin).
  //   2. `xpair status` runs to completion (code 0) — a cheap, side-effect-free liveness probe.
  // Returns {ready, bin, err}; ready===false → App.tsx raises a global block that disables every Next.
  async cliReady() {
    const bin = rpBinAbs();
    if (!bin) {
      const expected = process.platform === "win32" ? "%ProgramFiles%\\Xpair\\xpair.exe" : "~/.local/bin/xpair";
      return { ready: false, bin: "", err: `xpair CLI not found at ${expected}` };
    }
    const r = await run(bin, ["status"]);
    if (r.code !== 0) {
      const why = r.code === -1
        ? `xpair could not be executed: ${r.err || "spawn failed"}`
        : `xpair status exited ${r.code}: ${r.err || "no output"}`;
      return { ready: false, bin, err: why };
    }
    // Runnable is not enough on script CLIs: a CLI too old to convey the host's `serving` verdict
    // would drop it even from a modern host and slip a not-serving host past the guard's ax/sr
    // fallback. Treat that as not-ready so the existing installCli path reinstalls the bundled CLI.
    if (!cliSupportsServing()) {
      return { ready: false, bin, err: "installed xpair CLI is out of date — reinstall the bundled client CLI" };
    }
    return { ready: true, bin, err: "" };
  },


  // CLI auto-install (component ⓪ — the "no dead end" path). cliReady===false used to be a hard wall;
  // instead the onboarding calls this to install the BUNDLED client CLI to ~/.local/bin and proceed.
  // We ship a repo-shaped tree next to this file (build.sh §4.7 → <ext>/cli/{shared,client/cli}/...),
  // so the SoT installer runs unmodified: `cli/shared/install.sh --role client`. install.sh sources
  // its own config.sh/lib.sh and derives CLIENT_DIR from its location, so no args/env beyond role are
  // needed; REMOTE_HOST is only prompted on a tty (none here) so client install is non-interactive.
  // Returns {ok, err}; only a FALSE here should make App.tsx show the blocking banner (+ Retry).
  async installCli() {
    if (process.platform === "win32") {
      const bin = rpBinAbs();
      if (!bin) {
        return {
          ok: false,
          err: "Install the Xpair CLI (.msi) first: https://github.com/x10lab/xpair/releases/latest",
          action: "OPEN_DOWNLOAD",
          url: CLI_DOWNLOAD_URL,
        };
      }
      const probe = await run(bin, ["status"]);
      if (probe.code === 0) return { ok: true, err: "" };
      return {
        ok: false,
        err: `Xpair CLI found but not working — reinstall the .msi: ${CLI_DOWNLOAD_URL}`,
        action: "OPEN_DOWNLOAD",
        url: CLI_DOWNLOAD_URL,
      };
    }
    // Prefer the bundled copy (production .app); fall back to the in-repo SoT (dev checkout, where the
    // bridge runs from client/ide/remotepair/ext → ../../../../shared/install.sh).
    const candidates = [
      path.join(__dirname, "cli", "shared", "install.sh"),
      path.join(__dirname, "..", "..", "..", "..", "shared", "install.sh"),
    ];
    let installer = "";
    for (const c of candidates) {
      try { if (fs.existsSync(c)) { installer = c; break; } } catch { /* ignore */ }
    }
    if (!installer) {
      return { ok: false, err: "bundled installer not found (cli/shared/install.sh)" };
    }
    // RP_YES=1 + no tty ⇒ install.sh skips the interactive REMOTE_HOST prompt and the trailing
    // onboarding/doctor blocks (all gated on REMOTE_HOST being set, which it is not here).
    const r = await run("bash", [installer, "--role", "client"], {
      cwd: path.dirname(installer),
      env: spawnEnv({ RP_YES: "1" }),
    });
    if (r.code !== 0) {
      return { ok: false, err: r.err || r.out || `installer exited ${r.code}` };
    }
    // Confirm the binary actually landed at the canonical path before claiming success.
    if (!rpBinAbs()) {
      return { ok: false, err: "installer ran but ~/.local/bin/xpair is still missing" };
    }
    return { ok: true, err: "" };
  },

  async openExternal(url) {
    const target = String(url || "").trim();
    if (!target.startsWith(GITHUB_XPAIR_URL_PREFIX)) {
      return { ok: false, err: "unsupported external URL" };
    }
    try {
      const { shell } = require("electron");
      await shell.openExternal(target);
      return { ok: true, err: "" };
    } catch (error) {
      return {
        ok: false,
        err: `could not open external URL: ${error && error.message ? error.message : String(error)}`,
      };
    }
  },

  async openHostOnboarding() {
    if (process.platform === "win32") {
      const docs = await run("cmd", ["/c", "start", "", HOST_SETUP_URL]);
      if (docs.code === 0) return { ok: true, err: "" };
      return {
        ok: false,
        err: docs.err || `Host onboarding runs on the Mac host. Open ${HOST_SETUP_URL}`,
      };
    }
    const app = await run("open", ["-a", "XpairHost"]);
    if (app.code === 0) return { ok: true, err: "" };
    const docs = await run("open", [HOST_SETUP_URL]);
    if (docs.code === 0) return { ok: true, err: "" };
    return {
      ok: false,
      err: docs.err || app.err || `could not open host onboarding (${HOST_SETUP_URL})`,
    };
  },

  // Current client config (real state, not hardcoded).
  // SSOT: mappings come from the CLI (`map list --json`), NOT from re-parsing client.env here.
  // rp_set shell-escapes FOLDER_MAPS (e.g. `a::b\;c::d`); the CLI `.`-sources it (unescaping),
  // while parseEnv reads it literally — so a local re-parse split on ';' diverges from the CLI
  // and the UI shows zero/garbled mappings. Re-derive a clean `client::host;...` from the CLI.
  async getConfig() {
    const e = parseEnv(clientEnvPath());
    let folderMaps = e.FOLDER_MAPS || "";
    // Per-mapping method comes from the CLI SSOT (FOLDER_MAP_MODES via `map list --json`). Carry it
    // alongside folderMaps as `clientPath::method;…` so the UI uses the STORED method instead of the
    // path-convention inference. Falls back to the raw env var when the CLI is unavailable.
    let folderMapModes = e.FOLDER_MAP_MODES || "";
    try {
      const r = await cli(["map", "list", "--json"]);
      if (r.code === 0 && r.out) {
        const arr = JSON.parse(r.out);
        if (Array.isArray(arr)) {
          folderMaps = arr.map((m) => `${m.client}::${m.host}`).join(";");
          folderMapModes = arr
            .filter((m) => m.method)
            .map((m) => `${m.client}::${m.method}`)
            .join(";");
        }
      }
    } catch {
      /* CLI unavailable — fall back to the raw env values */
    }
    return {
      remoteHost: e.REMOTE_HOST || "",
      engine: e.ENGINE || "",
      folderMaps,
      folderMapModes,
      syncBackend: e.SYNC_BACKEND || "",
      mountBackend: e.MOUNT_BACKEND || "",
    };
  },

  // Connection — real reachability check (hard-gate for the Connect step).
  async sshReachable(host) {
    const h = String(host || "").trim();
    if (!h) return { reachable: false, err: "no host" };
    if (!validSshTarget(h)) {
      return {
        reachable: false,
        err: invalidSshTarget(h),
        state: SSH_STATE.INVALID_HOST,
        action: SSH_ACTION.ABORT,
      };
    }
    const r = await run("ssh", [...sshProbeOpts(h, 5), h, "true"]);
    return sshResult(r);
  },

  // Connection — persist REMOTE_HOST via the CLI.
  async setHost(host) {
    return cli(["config", "set", "host", host]);
  },

  // --- Engine host-readiness hard guard (component — same philosophy as the CLI/host-app guards) ---
  //
  // The chosen session engine runs ON THE HOST (xpair launch SSHes in and execs `claude`/`codex`/
  // `opencode`, or a plain shell, there). So before launch we must confirm THAT engine is available
  // on the host, or `xpair launch` dead-ends with "<engine> not found on host" / an auth prompt the
  // GUI can never answer.

  // Engine — is `engine` installed AND authenticated on the host? One SSH round-trip (key auth,
  // BatchMode) runs an engine-specific probe and prints a parseable RP_* block. Auth detection is
  // engine-specific (each engine stores creds differently); see ENGINE_PROBE below. Returns
  // {installed, authed, version, err}.
  async hostEnvEngine(hostArg) {
    const host = String(hostArg || parseEnv(clientEnvPath()).REMOTE_HOST || "").trim();
    if (!host) return { engine: "", err: "REMOTE_HOST not set" };
    if (!validSshTarget(host)) {
      return { engine: "", err: invalidSshTarget(host), state: SSH_STATE.INVALID_HOST, action: SSH_ACTION.ABORT };
    }
    const cmd = 'set -a; [ -f "$HOME/.xpair/host/host.env" ] && . "$HOME/.xpair/host/host.env"; printf "%s\\n" "${ENGINE:-}"';
    const r = await run("ssh", [...sshProbeOpts(host, 6), host, cmd]);
    if (r.code !== 0) {
      const s = sshResult(r);
      return { engine: "", err: s.err, state: s.state, action: s.action };
    }
    const engine = String(r.out || "").trim().split(/\r?\n/).pop().trim();
    if (!engine) return { engine: "", err: "host ENGINE not set" };
    if (!SESSION_ENGINES.has(engine)) return { engine: "", err: `unknown host ENGINE: ${engine}` };
    return { engine, err: "" };
  },

  async hostEngineStatus(engine) {
    const e = String(engine || "").trim();
    const host = String(parseEnv(clientEnvPath()).REMOTE_HOST || "").trim();
    if (!host) return { installed: false, authed: false, version: "", err: "REMOTE_HOST not set" };
    if (!validSshTarget(host)) {
      return {
        installed: false,
        authed: false,
        version: "",
        err: invalidSshTarget(host),
        state: SSH_STATE.INVALID_HOST,
        action: SSH_ACTION.ABORT,
      };
    }
    const probe = ENGINE_PROBE[e];
    if (!probe) return { installed: false, authed: false, version: "", err: `unknown engine: ${e}` };
    const r = await run("ssh", [...sshProbeOpts(host, 6), host, probe]);
    if (r.code !== 0) {
      const s = sshResult(r);
      return {
        installed: false,
        authed: false,
        version: "",
        err: s.err,
        state: s.state,
        action: s.action,
      };
    }
    const out = r.out || "";
    const installed = /RP_ENGINE_INSTALLED=1/.test(out);
    if (!installed) {
      return { installed: false, authed: false, version: "", err: `Host has no '${e}' installed` };
    }
    const authed = /RP_ENGINE_AUTHED=1/.test(out);
    let version = "";
    const vm = out.match(/RP_ENGINE_VERSION=(.*)/);
    if (vm) version = vm[1].trim();
    return {
      installed: true,
      authed,
      version,
      err: authed ? "" : `'${e}' is installed on the host but not signed in`,
    };
  },

  // Mappings — resolve a host folder over SSH before saving it. FOLDER_MAPS must store an
  // absolute path that exists on the host, so the renderer treats this call as the trust boundary.
  async resolveHostPath(sshTarget, hostPath) {
    const h = String(sshTarget || "").trim();
    const p = String(hostPath || "").trim();
    if (!h) return { ok: false, path: "", err: "no host" };
    if (!p) return { ok: false, path: "", err: "no path" };
    if (!validSshTarget(h)) {
      return { ok: false, path: "", err: invalidSshTarget(h), state: SSH_STATE.INVALID_HOST, action: SSH_ACTION.ABORT };
    }
    // ssh appends extra argv to the remote command STRING (space-joined); it does NOT set $1. So the
    // path must be embedded — safely quoted, leading ~ left unquoted so the remote shell expands it —
    // directly into the command. cd verifies existence; pwd returns the absolute path.
    const r = await run("ssh", [...sshProbeOpts(h, 5), h, "cd " + shPathQuotePreserveHome(p) + " 2>/dev/null && pwd"]);
    if (r.code === 0 && String(r.out || "").trim()) {
      return { ok: true, path: String(r.out || "").trim().split("\n").pop(), err: "" };
    }
    if (r.code === 255 || r.err) {
      const s = sshResult(r, "could not resolve host folder");
      return { ok: false, path: "", err: s.err, state: s.state, action: s.action };
    }
    return { ok: false, path: "", err: "folder not found" };
  },

  async listHostDir(sshTarget, hostPath) {
    const h = String(sshTarget || "").trim();
    const p = String(hostPath || "").trim() || "~";
    const empty = (err, state, action) => ({ ok: false, base: "", entries: [], err, state, action });
    if (!h) return empty("no host");
    if (!validSshTarget(h)) {
      return empty(invalidSshTarget(h), SSH_STATE.INVALID_HOST, SSH_ACTION.ABORT);
    }
    const cmd = "cd " + shPathQuotePreserveHome(p) +
      " 2>/dev/null && pwd && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print";
    const r = await run("ssh", [...sshProbeOpts(h, 5), h, cmd]);
    if (r.code === 0) {
      const lines = String(r.out || "").split("\n");
      const base = String(lines.shift() || "").trim();
      if (!base) return empty("folder not found");
      const names = lines
        .filter((line) => line.startsWith("./"))
        .map((line) => line.slice(2))
        .filter(Boolean)
        .sort();
      const capped = names.slice(0, 500);
      const prefix = base === "/" ? "" : base;
      const result = {
        ok: true,
        base,
        entries: capped.map((name) => ({ name, path: `${prefix}/${name}` })),
        err: "",
      };
      if (names.length > capped.length) result.truncated = true;
      return result;
    }
    if (r.code === 255 || r.err) {
      const s = sshResult(r, "could not list host folder");
      return empty(s.err, s.state, s.action);
    }
    return empty("folder not found");
  },

  // Mappings — pre-fill with the NetFS/Finder mountpoint. macOS chooses
  // /Volumes/<share> or a suffixed variant; when the share is already mounted,
  // discover the real path from mount(8), otherwise return the first expected path.
  defaultMountpoint(hostPath) {
    const cfg = parseEnv(clientEnvPath());
    const remoteHost = cfg.REMOTE_HOST || "";
    const smbHost = String(remoteHost).includes("@") ? String(remoteHost).split("@").pop() : String(remoteHost);
    const shareName = path.posix.basename(String(hostPath || ""));
    if (!shareName) return "/Volumes";
    try {
      const out = cp.execFileSync("mount", { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      const marker = `@${smbHost}/${shareName} on `;
      for (const line of String(out || "").split("\n")) {
        if (!line.includes(marker) || !line.includes(" (smbfs")) continue;
        const start = line.indexOf(" on ");
        const end = line.indexOf(" (smbfs", start);
        if (start >= 0 && end > start) return line.slice(start + 4, end);
      }
    } catch { /* best effort only */ }
    return path.join("/Volumes", shareName);
  },

  // Mappings — actually mount a host folder. `xpair-mount` takes a SUBCOMMAND first, so via the
  // wrapper this is `xpair mount mount <hostPath> [mountpoint]` (1st "mount" = the xpair
  // subcommand that execs xpair-mount; 2nd "mount" = its mount action).
  // mountpoint is optional: when provided it overrides the default computed by xpair-mount.
  // Returns the parsed Mountpoint from CLI output.
  async mount(hostPath, mountpoint) {
    const h = String(hostPath || "").trim();
    if (!h) return { code: -1, out: "", err: "mount requires a host path", mountpoint: "" };
    const mp = String(mountpoint || "").trim();
    const r = await cli(["mount", "mount", h, ...(mp ? [mp] : [])]);
    let parsedMountpoint = "";
    for (const line of (r.out || "").split("\n")) {
      const m = line.match(/^\s*Mountpoint:\s*(\S.*?)\s*$/);
      if (m) {
        parsedMountpoint = m[1];
        break;
      }
    }
    return { code: r.code, out: r.out, err: r.err, mountpoint: parsedMountpoint };
  },

  // Mappings — manual add of a client→host mapping (hard-gate: >=1).
  // method (mount|sync) is persisted per-mapping (FOLDER_MAP_MODES); omitted ⇒ the CLI infers
  // it by path convention, preserving legacy callers.
  async addMapping(clientPath, hostPath, method) {
    const args = ["map", "add", expandClientHome(clientPath), hostPath];
    if (method === "mount" || method === "sync") args.push(method);
    return cli(args);
  },

  async removeMapping(clientPath) {
    // Expand ~ the same way addMapping does, so the stored (absolute) client path is matched on rm.
    const c = expandClientHome(String(clientPath || "").trim());
    if (!c) return { code: -1, out: "", err: "removeMapping requires a client path" };
    return cli(["map", "rm", c]);
  },

  // --- Discovery / remote-install (component ⑤ — shells to the CLI brain) -----------------------
  //
  // SECURITY (Principle 2): public-key auth is the PRIMARY path — SSH probes and the install
  // preflight are BatchMode, publickey-only; host-key mismatch and key-agent/passphrase failures are
  // returned as explicit recovery states. An account password is accepted by installHost ONLY as a
  // one-shot bootstrap for the first connection to a host that has not yet authorized this client's
  // key, and even then it is handed to the CLI over stdin (never argv/env-value/log/disk). The CLI
  // sets up the bash-managed askpass fd. A key passphrase is never received or returned. Do NOT add a
  // tCapture/telemetry call inside discover/installHost.

  // Discovery — Tailscale sweep via the CLI. Returns a deduped peer array
  // (deduped by host-key fingerprint inside the CLI; the UI dedups again as a backstop).
  // Each peer: {name, addrs[], source, sources[], fp, status("reconnect"|"connect"|"setup")}.
  async discover() {
    const r = await cli(["discover", "--json"]);
    if (r.code !== 0) return { peers: [], err: r.err };
    let peers = [];
    try {
      const parsed = JSON.parse(r.out || "[]");
      if (Array.isArray(parsed)) peers = parsed;
    } catch (e) {
      return { peers: [], err: "discover: bad JSON: " + String(e && e.message ? e.message : e) };
    }
    return { peers, err: "" };
  },

  async fetchPairingMeta(target) {
    const h = String(target || "").trim();
    if (!h) {
      return { ok: false, fp: "", serviceInstanceID: "", hostNonce: "", pairPort: 0, hostUser: "", err: "no host" };
    }
    const host = sshTargetHost(h);
    if (!validHost(host)) {
      return { ok: false, fp: "", serviceInstanceID: "", hostNonce: "", pairPort: 0, hostUser: "", err: invalidHost(host) };
    }
    try {
      const metadata = await fetchPairingMetadata(host, 3000);
      if (!metadata) {
        return {
          ok: false,
          fp: "",
          serviceInstanceID: "",
          hostNonce: "",
          pairPort: 0,
          hostUser: "",
          err: "Host is not broadcasting pairing details. Open Connect on the host, then rescan.",
        };
      }
      return normalizePairingMetadata(metadata);
    } catch (e) {
      return {
        ok: false,
        fp: "",
        serviceInstanceID: "",
        hostNonce: "",
        pairPort: 0,
        hostUser: "",
        err: String(e && e.message ? e.message : e),
      };
    }
  },

  // Pairing — send a signed request to the host's ephemeral UDP endpoint. The request carries the
  // actual client public key and a raw Ed25519 signature over the length-prefixed transcript:
  // hostKeyFP, hostNonce, serviceInstanceID, clientPubKey, timestamp.
  async sendPairingRequest({ host, port, hostKeyFP, hostNonce, serviceInstanceID, name, user } = {}) {
    const h = String(host || "").trim();
    const p = Number(port);
    if (!h || !validHost(h)) return { ok: false, err: invalidHost(h), fingerprint: "" };
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      return { ok: false, err: "invalid pairing port", fingerprint: "" };
    }
    if (!hostKeyFP || !hostNonce || !serviceInstanceID) {
      return { ok: false, err: "missing pairing transcript fields", fingerprint: "" };
    }

    if (!(await ensurePairingKey())) {
      return { ok: false, err: "could not create the xpair pairing key", fingerprint: "" };
    }
    let pubkey;
    try {
      pubkey = sanitizeEd25519PublicKey(fs.readFileSync(PAIRING_KEY + ".pub", "utf8"));
    } catch (e) {
      return { ok: false, err: `could not read pairing public key: ${e.message || e}`, fingerprint: "" };
    }

    let pub;
    try {
      pub = parseEd25519PublicKey(pubkey);
    } catch (e) {
      return { ok: false, err: `could not read pairing public key: ${e.message || e}`, fingerprint: "" };
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const transcript = canonicalPairingTranscript(hostKeyFP, hostNonce, serviceInstanceID, pub.clean, timestamp);
    let sig;
    try {
      sig = signPairingTranscript(transcript).toString("base64");
    } catch (e) {
      return { ok: false, err: `could not sign pairing request: ${e.message || e}`, fingerprint: pub.fingerprint };
    }
    const sent = await sendUdpJSON(h, p, {
      clientPubKey: pub.clean,
      name: String(name || os.hostname()),
      user: String(user || os.userInfo().username),
      timestamp,
      sig,
    });
    return { ok: sent.ok, err: sent.err, fingerprint: pub.fingerprint };
  },

  async pairingStatus({ host, pairingHost } = {}) {
    const h = String(host || "").trim();
    if (!h) return { paired: false, pending: false, denied: false, err: "no host", fingerprint: "" };
    if (!validSshTarget(h)) {
      return {
        paired: false,
        pending: false,
        denied: false,
        err: invalidSshTarget(h),
        fingerprint: "",
        state: SSH_STATE.INVALID_HOST,
        action: SSH_ACTION.ABORT,
      };
    }

    await ensurePairingKey();
    let pub;
    let clientID;
    try {
      pub = parseEd25519PublicKey(fs.readFileSync(PAIRING_KEY + ".pub", "utf8"));
      clientID = clientIDForKeyBlob(pub.clean.split(/\s+/)[1]);
    } catch (e) {
      return {
        paired: false,
        pending: false,
        denied: false,
        err: `could not read client public key: ${e.message || e}`,
        fingerprint: "",
      };
    }

    const metadata = await fetchPairingMetadata(pairingHost || h);
    if (
      metadata &&
      metadata.phase === "denied" &&
      metadata.deniedFingerprint &&
      metadata.deniedFingerprint === pub.fingerprint
    ) {
      return {
        paired: false,
        pending: false,
        denied: true,
        err: "pairing request denied on host",
        fingerprint: pub.fingerprint,
        state: SSH_STATE.KEY_AUTH_BLOCKED,
        action: SSH_ACTION.ABORT,
      };
    }

    const probe =
      `XPAIR_CLIENT_ID=${clientID} /usr/bin/perl -MJSON::PP -e '` +
      'use strict; use warnings; ' +
      'my $id=$ENV{"XPAIR_CLIENT_ID"}||""; ' +
      'my $ledger="$ENV{HOME}/.xpair/authorized_clients.json"; ' +
      'open(my $fh,"<",$ledger) or exit 2; local $/; my $raw=<$fh>; close($fh); ' +
      'my $j=eval { JSON::PP->new->decode($raw) }; exit 3 if $@ || ref($j) ne "HASH" || ref($j->{clients}) ne "ARRAY"; ' +
      'for my $r (@{$j->{clients}}) { next unless ref($r) eq "HASH" && ($r->{clientID}//"") eq $id; if (($r->{status}//"") eq "paired") { print "paired\\n"; exit 0; } exit 4; } exit 5;' +
      "'";
    const r = await run("ssh", [...sshPairingProofOpts(h, 5), h, probe]);
    if (r.code === 0 && /\bpaired\b/.test(r.out || "")) {
      return { paired: true, pending: false, denied: false, err: "", fingerprint: pub.fingerprint };
    }
    const s = sshResult(r, "pairing proof not accepted yet");
    const pending = s.state === SSH_STATE.KEY_AUTH_BLOCKED || s.state === SSH_STATE.NEEDS_PASSWORD || r.code === 255;
    return {
      paired: false,
      pending,
      denied: false,
      err: s.err,
      fingerprint: pub.fingerprint,
      state: s.state,
      action: s.action,
    };
  },

  // Setup — remote install over SSH. Keys are the PRIMARY path: we preflight the key-only path and,
  // once the host trusts this client's key, every install/connect is key-auth. But the first install
  // on a host that has NOT yet authorized this client's key cannot connect with a key that isn't
  // there yet — so when that preflight reports a REMOTE publickey denial, the webview collects an
  // account `password` and this bridge hands it to install-host over stdin (never argv/env/disk) to
  // bootstrap that one setup connection; install-host then appends the key (ssh-copy-id) so all later
  // ops are key-auth. `force` reinstalls over an already-installed but incompatible host app (host
  // update flow). Returns {ok,out,err,state,action}; `out` carries the redacted progress stream.
  async installHost({ host, user, password, force } = {}) {
    if (!host) return { ok: false, out: "", err: "installHost requires host" };
    let h = String(host || "").trim();
    let account = String(user || "").trim();
    // Accept `user@host` typed into the host field — the documented way to set a remote login that
    // differs from the local user. HOST_RE rejects `@`, so split it here (an explicit `user` wins)
    // before validation; the CLI install-host then authenticates/normalizes as account@host.
    if (h.includes("@")) {
      const at = h.indexOf("@");
      // An explicit account wins, but the `@`-prefix must be stripped from the host either way —
      // otherwise HOST_RE would reject the host even when a separate login was supplied.
      if (!account) account = h.slice(0, at);
      h = h.slice(at + 1);
    }
    if (!validHost(h)) {
      return {
        ok: false,
        out: "",
        err: invalidHost(h),
        state: SSH_STATE.INVALID_HOST,
        action: SSH_ACTION.ABORT,
      };
    }
    if (account && !validAccount(account)) {
      return {
        ok: false,
        out: "",
        err: invalidAccount(account),
        state: SSH_STATE.INVALID_ACCOUNT,
        action: SSH_ACTION.ABORT,
      };
    }
    const pw = String(password || "");
    const target = account ? `${account}@${h}` : h;
    // Reachability/host-identity preflight ONLY. The key-only probe doubles as a reachability check.
    // A REMOTE "Permission denied (publickey...)" means this host has not authorized the client key
    // yet, so the webview must collect the account password for the one-shot bootstrap. LOCAL key
    // failures (agent refused, passphrase required, unreadable key) stay on the existing key recovery
    // path and must not consume the account password.
    let keyBlocked = false;
    const preflight = await run("ssh", [...sshProbeOpts(target, 8), target, "true"]);
    if (preflight.code !== 0) {
      const raw = preflight.err || preflight.out || "";
      const s = sshResult(preflight);
      if (s.state !== SSH_STATE.KEY_AUTH_BLOCKED) {
        return { ok: false, out: "", err: s.err, state: s.state, action: s.action };
      }
      // Take the password-bootstrap path ONLY for a clean remote publickey denial — NOT when ssh
      // also shows a local key/agent failure (then the key is unusable here and the approve/unlock
      // recovery path applies; a password would only authorize a key later probes still can't use).
      if (!isRemotePublickeyDenied(raw) || isLocalKeyFailure(raw)) {
        return { ok: false, out: "", err: s.err, state: s.state, action: s.action };
      }
      keyBlocked = true; // client key not yet authorized → bootstrap this one connection with the password.
    }
    const args = ["install-host", "--host", h];
    if (account) args.push("--account", account);
    // force:true installs/reinstalls the client-bundled XpairHost for a not-ready host app state
    // — the CLI's --force flag overwrites the existing app when present and restarts the
    // host (terminating any running tmux sessions). Used by the onboarding host-repair flow.
    if (force) args.push("--force");
    if (keyBlocked && !pw) {
      return {
        ok: false,
        out: "",
        err: sshFailureMessage(SSH_STATE.NEEDS_PASSWORD),
        state: SSH_STATE.NEEDS_PASSWORD,
        action: SSH_ACTION.PROMPT_PASSWORD,
      };
    }
    // First-time (key not yet authorized) AND a password was supplied → bootstrap the setup
    // connection via install-host --password-stdin. Otherwise the key is already authorized, so run
    // the existing key-auth path and ignore any stale password value.
    let r;
    if (keyBlocked && pw) {
      // An upgraded IDE can sit on an OLD ~/.local/bin/xpair that predates --password-stdin;
      // cliReady() only proves `xpair status` runs, so verify the flag is actually supported before
      // relying on it — an old CLI would just print its usage error and dead-end first-time setup.
      if (!cliSupportsPasswordStdin()) {
        // NOT a needs_password/prompt state — that would loop the user back to the password form.
        // Surface it as a plain failure so the UI shows the "update the CLI" message + a retry.
        return {
          ok: false,
          out: "",
          err: "The installed xpair CLI is too old for first-time password setup. Update it (run `xpair self-update`, or reinstall the client) and try again.",
          state: SSH_STATE.UNREACHABLE,
          action: SSH_ACTION.RETRY,
        };
      }
      r = await cliWithPasswordStdin(args, pw);
    } else {
      r = await cli(args);
    }
    if (r.code === 0) {
      return { ok: true, out: r.out, err: "", state: SSH_STATE.READY, action: SSH_ACTION.CONTINUE };
    }
    if (keyBlocked && (r.code === 7 || isPasswordDenied(`${r.err}\n${r.out}`))) {
      return {
        ok: false,
        out: r.out,
        err: sshFailureMessage(SSH_STATE.PASSWORD_DENIED),
        state: SSH_STATE.PASSWORD_DENIED,
        action: SSH_ACTION.PROMPT_PASSWORD,
      };
    }
    const s = sshResult(r, "install failed");
    return { ok: false, out: r.out, err: s.err, state: s.state, action: s.action };
  },

  // Host TCC grant status — after install, the host app cannot be granted Accessibility / Screen
  // Recording / Full Disk Access remotely (macOS blocks it); the user must toggle them on the host's
  // own screen. This SSH-reads the status.json the host app writes (LOG_DIR/status.json) so the
  // onboarding can show "permissions granted ✓" vs "waiting for you to grant on the host". Returns
  // {alive, ax, sr, fda, sharing} (booleans; all false when the file is absent/unreadable) + {err}.
  async hostPermissions({ host } = {}) {
    if (!host) return { alive: false, ax: false, sr: false, fda: false, sharing: false, err: "no host" };
    // `host-permissions` SSH-reads the host app's status.json (key auth, bounded, never prompts) and
    // emits {alive,ax,sr,fda,sharing} as JSON.
    const r = await cli(["host-permissions", "--host", String(host)]);
    if (r.code !== 0) {
      const s = sshResult(r, "could not read host status");
      return {
        alive: false,
        ax: false,
        sr: false,
        fda: false,
        sharing: false,
        err: s.err,
        state: s.state,
        action: s.action,
      };
    }
    try {
      const j = JSON.parse(r.out.trim() || "{}");
      return {
        alive: !!j.alive,
        ax: !!j.ax,
        sr: !!j.sr,
        fda: !!j.fda,
        sharing: !!j.sharing,
        // The host's OWN serving verdict (Permissions.allGranted). undefined on hosts that
        // predate the field — the guard falls back to ax/sr for those (their actual gate).
        serving: typeof j.serving === "boolean" ? j.serving : undefined,
        err: "",
      };
    } catch (e) {
      return { alive: false, ax: false, sr: false, fda: false, sharing: false, err: "host-permissions: bad JSON" };
    }
  },

  // Gateway-MAC roaming is a convenience guard only (blueprint §6.4). Unknown/changed network state
  // fails CLOSED for auto-connect; auth remains SSH host-key TOFU + the approved client key.
  gatewayMacStatus,
  // Recovery for a fail-closed roaming state: an explicit user reconnect re-confirms the current
  // network by adopting it as the new baseline (so auto-connect is re-enabled without editing client.env).
  confirmGatewayBaseline() {
    return gatewayMacStatus({ updateBaseline: true });
  },
  // TOFU confirm — pin the exact ed25519 host key fingerprint the user confirmed into the effective
  // durable UserKnownHostsFile. Probes learn first-seen keys in an app-launch ephemeral known_hosts
  // file; this asks ssh to bridge the confirmed key into the durable store so later CLI/RD SSH flows
  // do not re-TOFU.
  async pinHostKey(host, expectedFp) {
    const h = String(host || "").trim();
    if (!validSshTarget(h)) {
      return { ok: false, err: invalidSshTarget(h), state: SSH_STATE.INVALID_HOST, action: SSH_ACTION.ABORT };
    }
    if (!expectedFp) return { ok: false, err: "no fingerprint to confirm" };

    const ephemeralPath = sshEphemeralKnownHostsPath();
    const rb = await durableKnownHostsReadback(h);
    let line = preferEd25519(await hostKeyLinesFromEphemeral(h, rb.lookupName));
    if (!line) {
      const scanned = await liveHostKeyLine(rb.scanHost, rb.scanPort);
      if (scanned) {
        seedEphemeralHostKey(rb.lookupName, scanned);
        line = scanned;
      }
    }
    const fp = line ? await fingerprintKnownHostsLine(line, false) : "";
    if (!line || !fp) return { ok: false, err: "could not read host key to pin" };
    if (fp !== String(expectedFp)) {
      return hostKeyMismatch("host key does not match the confirmed fingerprint");
    }

    const verify = await run("ssh", [
      ...sshDurablePinOpts(8),
      "-o", `UserKnownHostsFile=${sshConfigDoubleQuote(ephemeralPath)}`,
      "-o", "StrictHostKeyChecking=yes",
      h,
      "true",
    ]);
    const verifyErr = verify.err || verify.out || "";
    if (isHostKeyVerificationFailure(verifyErr)) {
      return hostKeyMismatch("host key changed before it could be pinned");
    }
    if (isSshNetworkFailure(verifyErr)) return { ok: false, err: "could not reach host to pin" };

    // ponytail: ssh still delegates the durable write, then we read back the persisted ed25519 key
    // and fingerprint-check it against the confirmed value; a mismatch is removed precisely so the
    // verify->accept-new window cannot pin a wrong key.
    const persist = await run("ssh", [
      ...sshDurablePinOpts(8),
      "-o", "StrictHostKeyChecking=accept-new",
      h,
      "true",
    ]);
    const persistErr = persist.err || persist.out || "";
    if (isHostKeyVerificationFailure(persistErr)) {
      return hostKeyMismatch("a different host key is already trusted for this host");
    }
    if (isSshNetworkFailure(persistErr)) return { ok: false, err: "could not reach host to pin" };

    if (rb.isNone) return { ok: false, err: "SSH config disables host-key checking (UserKnownHostsFile none); cannot establish durable host trust" };
    if (!rb.file) return { ok: false, err: "could not verify pinned host key" };

    const foundResult = await run("ssh-keygen", ["-F", rb.lookupName, "-f", rb.file]);
    const lines = knownHostsKeyLines(foundResult.out);
    const found = lines.find((l) => keyIdentity(l).startsWith("ssh-ed25519 ")) || "";
    if (!found) {
      const strict = await run("ssh", [
        ...sshDurablePinOpts(8),
        "-o", "StrictHostKeyChecking=yes",
        h,
        "true",
      ]);
      const strictErr = strict.err || strict.out || "";
      if (!isHostKeyVerificationFailure(strictErr) && !isSshNetworkFailure(strictErr)) {
        return { ok: true, err: "" };
      }
      return { ok: false, err: "host key was not saved" };
    }

    const persistedFp = await fingerprintKnownHostsLine(found, false);
    if (persistedFp !== String(expectedFp)) {
      removeKnownHostsLine(rb.file, found);
      return hostKeyMismatch("host key changed before it could be pinned");
    }
    return { ok: true, err: "" };
  },

  // Host-app hard guard (Connect / Reconnect step): being able to SSH to the host (reachable) is NOT
  // enough — the host must actually have the Xpair host app installed AND be version-compatible with
  // this client, or pairing produces a connected-but-dead session that silently does nothing. SSHes
  // once (key auth, BatchMode, never prompts) and probes:
  //   installed  — ~/Applications/XpairHost.app exists on the host.
  //   version    — the host app's status.json `version` field (empty when the app hasn't written it).
  //   compatible — same MAJOR as this client's version. Unknown host version (app installed but no
  //                status yet) is treated as compatible (don't hard-block a fresh install that simply
  //                hasn't stamped status.json); a KNOWN mismatching major is incompatible.
  //   incompatibleKind — WHY compatible is false, so the UI doesn't re-parse versions:
  //                "below_floor"   = same major but older than MIN_COMPATIBLE_HOST → use update wording
  //                                  (the client's bundled host is the same major, just newer).
  //                "major_mismatch"= different major (incl. a NEWER host) → use generic repair wording.
  //                ""              = compatible (no incompatibility).
  // Returns {installed, version, compatible, incompatibleKind, err}.
  async hostAppStatus(host) {
    const h = String(host || "").trim();
    if (!h) return { installed: false, version: "", compatible: false, incompatibleKind: "", err: "no host" };
    if (!validSshTarget(h)) {
      return {
        installed: false,
        version: "",
        compatible: false,
        incompatibleKind: "",
        err: invalidSshTarget(h),
        state: SSH_STATE.INVALID_HOST,
        action: SSH_ACTION.ABORT,
      };
    }
    const sshArgs = sshProbeOpts(h, 6);
    // Resolve the host version that will actually serve the RD session, in priority order:
    //   1. RUNNING version — ~/.xpair/host/logs/status.json. The app rewrites it every second, so a FRESH
    //      file means the app is up and its `version` is the live process version. After an on-disk update
    //      that did not restart the daemon (e.g. `brew upgrade --cask` without kickstart), the running
    //      process — which is what actually serves RD — can be older than the on-disk bundle, so it wins.
    //   2. ON-DISK version of the copy the LaunchAgent will launch — ProgramArguments[0] (config.sh
    //      APP_EXEC / Installer.swift Bundle.main.executablePath) → that bundle's CFBundleShortVersionString.
    //      The label comes from host.env BUNDLE_PREFIX (the current label) so a leftover legacy plist
    //      (e.g. com.ghyeong.xpair-host) can't be picked nondeterministically over the active one.
    //   3. Fallback when no host LaunchAgent is registered yet (e.g. a cask install before first launch):
    //      whichever installed bundle exists (/Applications, the cask default, then ~/Applications) — read
    //      ITS version too, so a cask-installed-but-not-launched old host is gated, not waved through.
    const probe =
      'pf="$(. "$HOME/.xpair/host/host.env" 2>/dev/null && printf %s "${BUNDLE_PREFIX:-}")"; [ -n "$pf" ] || pf=com.x10lab.xpair-host; ' +
      'la="$HOME/Library/LaunchAgents/$pf.plist"; [ -f "$la" ] || la=""; ' +
      'ex="$([ -n "$la" ] && /usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$la" 2>/dev/null)"; ' +
      'app="${ex%/Contents/MacOS/*}"; ' +
      'if [ -z "$app" ] || [ ! -d "$app" ]; then for d in "/Applications/XpairHost.app" "$HOME/Applications/XpairHost.app"; do [ -d "$d" ] && { app="$d"; break; }; done; fi; ' +
      'if [ -n "$app" ] && [ -d "$app" ]; then echo RP_APP_INSTALLED=1; dv="$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)"; [ -n "$dv" ] && echo "RP_DISK_VERSION=$dv"; else echo RP_APP_INSTALLED=0; fi; ' +
      'st="$HOME/.xpair/host/logs/status.json"; if [ -f "$st" ]; then now="$(date +%s)"; mt="$(stat -f %m "$st" 2>/dev/null || echo 0)"; [ "$((now - mt))" -le 10 ] && { echo RP_RUNNING=1; cat "$st"; }; fi';
    const r = await run("ssh", [...sshArgs, h, probe]);
    if (r.code !== 0) {
      const s = sshResult(r);
      return { installed: false, version: "", compatible: false, incompatibleKind: "", err: s.err, state: s.state, action: s.action };
    }
    const out = r.out || "";
    const installed = /RP_APP_INSTALLED=1/.test(out);
    if (!installed) {
      return { installed: false, version: "", compatible: false, incompatibleKind: "", err: "Host has no Xpair host app" };
    }
    // The RUNNING process version (fresh status.json) wins over the on-disk bundle — it is what actually
    // serves RD; on-disk is used only when the app is not running (so an old running process is never
    // masked by a newer on-disk bundle that hasn't been started yet).
    let diskVersion = "";
    const dm = out.match(/^RP_DISK_VERSION=(.+)$/m);
    if (dm) diskVersion = dm[1].trim();
    let runningVersion = "";
    if (/^RP_RUNNING=1$/m.test(out)) {
      const j0 = out.indexOf("{");
      if (j0 !== -1) {
        try {
          const j = JSON.parse(out.slice(j0));
          if (j && typeof j.version === "string") runningVersion = j.version.trim();
        } catch { /* status.json garbled — ignore and use the on-disk version */ }
      }
    }
    const version = runningVersion || diskVersion;
    const clientV = clientVersion();
    const hostMajor = versionMajor(version);
    const clientMajor = versionMajor(clientV);
    // Compatibility = same MAJOR (necessary) AND host >= MIN_COMPATIBLE_HOST (the protocol floor).
    // The old check was major-only, which let a too-old same-major host (e.g. a43 vs an a45-protocol
    // client) connect and fail subtly. Version comes from the running process or the installed bundle
    // (above), so an installed host normally has a known version; unknown only when neither is readable
    // (corrupt/partial install), which we allow rather than hard-block on a read glitch.
    let compatible;
    let incompatibleKind = "";
    let reason = "";
    if (!hostMajor) {
      compatible = true; // unreadable bundle version → allow (don't hard-block on a read glitch)
    } else if (hostMajor !== clientMajor) {
      // Different major — including a NEWER host. Keep the diagnostic distinct so the UI can use
      // generic repair wording instead of the below-floor update wording.
      compatible = false;
      incompatibleKind = "major_mismatch";
      reason = `Host version ${version} is a different major than client ${clientV}`;
    } else if (compareVersions(clientV, MIN_COMPATIBLE_HOST) >= 0 && compareVersions(version, MIN_COMPATIBLE_HOST) < 0) {
      // The protocol floor only applies when THIS client is itself a release at/above the floor.
      // A locally-built client derives its version from the untracked shared/.build-counter (low or
      // absent on a fresh checkout), so it can sit below the floor; in that dev case a same-major
      // host built from the same tree must NOT be rejected as "too old" — same major is enough.
      // Same major + below floor → the client's bundled host is the same major (just newer), so a
      // forced update is a safe in-place upgrade.
      compatible = false;
      incompatibleKind = "below_floor";
      reason = `Host version ${version} is older than the minimum compatible ${MIN_COMPATIBLE_HOST} — update the host (xpair install-host --force)`;
    } else {
      compatible = true;
    }
    return {
      installed: true,
      version,
      compatible,
      incompatibleKind,
      err: compatible ? "" : reason,
    };
  },

  // --- Telemetry (consent-gated PostHog; all no-ops until the user opts in) -------------------

  // Fire a Phase-1 PostHog event from the webview. The bridge re-validates the event name and
  // re-coerces reason/path to the controlled enums (defense in depth — the webview can NEVER
  // push a raw error string or an unknown path into a payload). Returns {ok:true} regardless
  // (fire-and-forget); consent/key gating + redaction happen inside telemetry.capture.
  tCapture(event, props) {
    const p = { ...(props || {}) };
    if ("reason" in p) p.reason = telemetry.normalizeReason(p.reason);
    if ("path" in p) p.path = telemetry.normalizePath(p.path);
    // host_connected cardinality = ONCE PER INSTALL (Insight A/B count installs, not IDE
    // restarts). The same shared telemetry.env stamp is honored by extension.js probeHost(), so a
    // host_connected fires at most once whether the webview or the extension observes it first.
    if (event === telemetry.EVENTS.HOST_CONNECTED && !telemetry.claimHostConnectedOnce()) {
      return { ok: true }; // already counted this install — drop the duplicate.
    }
    telemetry.capture(event, p);
    return { ok: true };
  },

  // Consent flags for the first-run consent UI (both default false / opt-in).
  tGetConsent() {
    return telemetry.getConsent();
  },
  tSetConsent(telemetryOn, crashReportOn) {
    return telemetry.setConsent(!!telemetryOn, !!crashReportOn);
  },

  // Shared by the Remote Desktop tunnel path so every ssh child gets the same
  // GUI-app PATH enrichment, SSH_AUTH_SOCK recovery, and failure taxonomy.
  rpBin,
  rpBinAbs,
  resolveXpairCliBin,
  spawnEnv,
  sshFailureKind,
  sshFailureMessage,
  sshActionForState,
  SSH_STATE,
  SSH_ACTION,
	  __pairingTest: {
	    canonicalPairingTranscript,
	    sanitizeEd25519PublicKey,
	    parseEd25519PublicKey,
	    clientIDForKeyBlob,
	    parseOpenSSHEd25519PrivateKey,
	    gatewayMacStatus,
	    sshControlMasterArgs,
	    cliSupportsPasswordStdin,
	    currentGatewayMacWin32,
	  },
};

module.exports = bridge;
