// Xpair client extension for the Xpair IDE (VSCodium fork).
// Plain CommonJS, vscode API + node stdlib only. No external npm deps.
//
// All ssh invocations are argv-safe (spawn, never a shell string built from REMOTE_HOST).
//
// Remote Desktop is a single WebRTC path (v2): an ssh local-forward tunnel carries
// only the signaling WebSocket (ws://127.0.0.1:<port> → host `screen serve-webrtc`).
// The H.264 media itself flows P2P over UDP/RTP/ICE and is decoded natively by the
// webview. Authenticated remote input is forwarded over RD WebRTC DataChannels
// after the host-side input helper reports readiness.

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

// Telemetry: zero-dep PostHog capture + Sentry envelope (consent-gated, opt-in default OFF).
// Self-contained stdlib-only module — does NOT add an external npm dependency.
const telemetry = require("./telemetry.js");
const onboardingBridge = require("./onboarding-bridge.js");

// CLIENT→HOST liveness heartbeat: while the workbench is alive, periodically write a small file to
// the host over SSH so the host can show this client as connected. Self-contained, stdlib-only,
// fire-and-forget (never crashes/blocks the IDE).
const heartbeat = require("./heartbeat.js");
const { listSessionsFromCli, checkSessionAvailableFromCli } = require("./session-list.js");

// --- constants -------------------------------------------------------------

// Build-time generated from the monorepo shared/ SoT (screen-protocol + identity).
// Committed so this extension stays self-contained; regenerate via generate-contracts.mjs.
const CONTRACTS = require("./generated/contracts.json");

// Xpair: AI agent extensions (Claude Code / Codex·ChatGPT) are DISABLED for now —
// CLI-only. Use the New Session picker's claude/codex/gemini CLI agents instead of the
// in-editor GUI extensions. Re-enable later by uncommenting. open-remote-ssh stays: it is
// the SSH transport, not an AI agent.
const AI_EXTENSIONS = [
  // "anthropic.claude-code",
  // "openai.chatgpt",
  "jeanp413.open-remote-ssh",
];

const NOTIFY_INTERVAL_MS = 5000;
const SSH_CONNECT_TIMEOUT = 6; // seconds
const XPAIR_SETTINGS_QUERY = "@ext:x10lab.remotepair";
const NOTIFY_TYPE_SETTINGS = [
  ["Stop", "stop"],
  ["Notification", "askQuestion"],
  ["SubagentStop", "subagentStop"],
  ["approve", "approval"],
  // Manual approval WAITS (host hook emits type "approve-wait" for PermissionRequest /
  // permission-prompt) require the user's action, so gate them on the same "approval"
  // toggle. Without this entry the poller's enabled.has(obj.type) check silently drops
  // every approve-wait record and the user never sees the prompt they must respond to.
  ["approve-wait", "approval"],
];

// v2 WebRTC signaling (shared/screen-protocol → generated contracts)
const SIGNAL_REMOTE_PORT = CONTRACTS.screen.v2SignalPort; // host `screen serve-webrtc` signaling port
const TUNNEL_SETTLE_MS = 1200; // wait for ssh -N tunnel to establish before the webview connects
const RD_CAPTURE_DEFAULTS = Object.freeze({ fps: 30, bitrate: 4_000_000, scale: 1.0 });
const RD_BIND_RETRY_DELAY_MS = 150;
const RD_MAX_BIND_ATTEMPTS = 3;
const RD_SESSION_TOKEN_REMOTE_FILE = "~/.xpair/host/rd-session-token";
const RD_SESSION_TOKEN_RE = /^[A-Za-z0-9._-]{24,128}$/;
const RD_TOKEN_FILE_NOT_READY_RE = /rd-session-token[\s\S]*(?:No such file|ENOENT)|(?:No such file|ENOENT)[\s\S]*rd-session-token/i;

// REMOTE_HOST must be an ssh alias / hostname, optionally prefixed with a normal
// login (`user@host`). Validate hard before it ever reaches a spawned process
// (defense in depth even though spawn is argv-safe: prevents an attacker-
// controlled env from injecting ssh options).
const HOST_RE = /^(?:(?!-)[A-Za-z0-9._-]+@)?(?!-)[A-Za-z0-9._-]+$/;
const { spawnEnv, sshFailureKind, sshFailureMessage, SSH_STATE } = onboardingBridge;
const RD_TRANSIENT_SSH_RE = /agent refused operation|signing failed|Permission denied \(publickey|Connection refused|Connection reset|kex_exchange|Operation timed out|Could not resolve|Host is down/i;
const RD_MAX_TRANSIENT_ATTEMPTS = 4;

function isTransientRdSshFailure(failureKind, detail) {
  return (
    failureKind !== SSH_STATE.HOST_KEY_MISMATCH &&
    (failureKind === SSH_STATE.KEY_AUTH_BLOCKED || RD_TRANSIENT_SSH_RE.test(String(detail || "")))
  );
}

function isRetryableRdTokenReadFailure(error, failureKind, detail) {
  return (
    failureKind !== SSH_STATE.HOST_KEY_MISMATCH &&
    ((error && error.retryable === true) ||
      isTransientRdSshFailure(failureKind, detail) ||
      RD_TOKEN_FILE_NOT_READY_RE.test(String(detail || "")))
  );
}

function rdTransientRetryDelayMs(attempt) {
  return 1200 + attempt * 1200; // 1.2s -> 2.4s -> 3.6s -> 4.8s
}

// --- logging (US-006) ------------------------------------------------------
// Conforms to docs/logging.md: line format `[<ISO>] [<LEVEL>] [ide] [<session>] <msg>`,
// file persist to ~/.xpair/host/logs/ide.log (mode 0700), rotate-on-open at 5 MB
// (keep .1/.2, max 3 files), level threshold REMOTEPAIR_LOG > info, redaction before sink.

const LOG_DIR = path.join(os.homedir(), ".xpair/host", "logs");
const LOG_FILE = path.join(LOG_DIR, "ide.log");
const CLIENT_ENV_FILE = path.join(os.homedir(), ".xpair/host", "client.env");
// Dedicated pairing identity — once paired the host trusts ONLY ~/.xpair/host/pairing_ed25519, so
// offer it explicitly on every probe/tunnel ssh (never fall back to the personal id_ed25519).
// Pre-pairing (no key yet) → [], so ssh uses its defaults.
const PAIRING_KEY_FILE = path.join(os.homedir(), ".xpair/host", "pairing_ed25519");
function pairingIdArgs() {
  try { if (fs.existsSync(PAIRING_KEY_FILE)) return ["-o", "IdentitiesOnly=yes", "-i", PAIRING_KEY_FILE]; } catch { /* ignore */ }
  return [];
}
const LOG_COMP = "ide";
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate-on-open threshold
const LOG_LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

// File default = INFO (docs/logging.md §4). REMOTEPAIR_LOG env overrides (highest precedence
// available to this self-contained ext; the IDE-setting tier is resolved in the workbench).
function resolveLogThreshold() {
  const raw = (process.env.REMOTEPAIR_LOG || "").trim().toLowerCase();
  if (raw && raw in LOG_LEVELS) return LOG_LEVELS[raw];
  return LOG_LEVELS.info;
}
const LOG_THRESHOLD = resolveLogThreshold();

function sshControlPath() {
  return "/tmp/rp-cm-" + (process.env.RP_SSH_CM_TAG || "x") + "-%C";
}

// Local-tz ISO-8601 with offset, second precision (e.g. 2026-06-15T10:45:16+0900).
function logTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/**
 * Redact secrets before any sink (docs/logging.md §6):
 *  - $HOME prefix → '~'
 *  - the REMOTE_HOST value → '<host>'
 * Best-effort + never throws (a redaction failure must not lose the log line).
 */
function redact(msg) {
  let s = String(msg);
  try {
    const home = os.homedir();
    if (home && home.length > 1) {
      s = s.split(home).join("~");
    }
    const host = readRemoteHost();
    if (host && host.length > 1) {
      s = s.split(host).join("<host>");
    }
  } catch (_e) {
    // fall through with whatever masking succeeded
  }
  return s;
}

// Reuse THIS extension's redactor for all telemetry payloads (no payload leaves the machine
// without $HOME→'~' and REMOTE_HOST→'<host>' masking — logging.md §6 / privacy constraint).
telemetry.setRedactor(redact);

// rotate-on-open: run ONCE per process so a long-lived extension host doesn't
// re-stat on every line. (The long-lived mid-run guard from §7 is the host
// daemon / Rust serve loop's job, not this short-burst extension logger.)
let logRotateChecked = false;
function rotateOnOpen() {
  if (logRotateChecked) return;
  logRotateChecked = true;
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    // shift live → .1 → .2 (keep max 3: live + .1 + .2).
    try { fs.renameSync(LOG_FILE + ".1", LOG_FILE + ".2"); } catch (_e) {}
    try { fs.renameSync(LOG_FILE, LOG_FILE + ".1"); } catch (_e) {}
  } catch (_e) {
    // no file yet (ENOENT) or stat failed → nothing to rotate.
  }
}

function appendToLogFile(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    rotateOnOpen();
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_e) {
    // file persistence is best-effort; the OutputChannel still has the line.
  }
}

// --- small utilities -------------------------------------------------------

let outputChannel;
/**
 * @param {string} msg
 * @param {("trace"|"debug"|"info"|"warn"|"error")} [level="info"]
 */
function log(msg, level) {
  const lvl = level && level in LOG_LEVELS ? level : "info";
  const safe = redact(msg);
  // OutputChannel keeps the full human-facing trail (unchanged behavior + level tag).
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel("Xpair");
  const ts = logTimestamp();
  outputChannel.appendLine(`[${ts}] [${lvl.toUpperCase()}] ${safe}`);
  // File sink honors the resolved threshold (REMOTEPAIR_LOG > info).
  if (LOG_LEVELS[lvl] >= LOG_THRESHOLD) {
    const session = process.env.RP_SESSION || "-";
    appendToLogFile(`[${ts}] [${lvl.toUpperCase()}] [${LOG_COMP}] [${session}] ${safe}`);
  }
}

function stripEnvQuotes(val) {
  let out = String(val || "").trim();
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1);
  }
  return out.trim();
}

function readClientEnvValue(keyName) {
  let raw;
  try {
    raw = fs.readFileSync(CLIENT_ENV_FILE, "utf8");
  } catch (_e) {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (key !== keyName) continue;
    return stripEnvQuotes(t.slice(eq + 1));
  }
  return null;
}

/** Read REMOTE_HOST from ~/.xpair/host/client.env (KEY=VALUE lines). */
function readRemoteHost() {
  // env override wins (useful for testing), then the client.env file.
  const fromEnv = process.env.REMOTE_HOST;
  if (fromEnv && HOST_RE.test(fromEnv.trim())) return fromEnv.trim();
  return readClientEnvValue("REMOTE_HOST");
}

/** Validated REMOTE_HOST or null. */
function getValidHost() {
  const h = readRemoteHost();
  if (!h) return null;
  if (!HOST_RE.test(h)) {
    log(`REMOTE_HOST rejected (invalid chars): ${JSON.stringify(h)}`);
    return null;
  }
  return h;
}

/** Read enabled host notification kinds from Xpair Settings. */
function readEnabledNotifyTypes() {
  const cfg = vscode.workspace.getConfiguration("xpair.notifications");
  const enabled = new Set();
  for (const [type, key] of NOTIFY_TYPE_SETTINGS) {
    if (cfg.get(key, true)) enabled.add(type);
  }
  return enabled;
}

function hasConfiguredValue(section, key) {
  const inspected = section.inspect(key);
  return !!(
    inspected &&
    (
      inspected.globalValue !== undefined ||
      inspected.workspaceValue !== undefined ||
      inspected.workspaceFolderValue !== undefined
    )
  );
}

function syncTelemetryConsentFromSettings() {
  const cfg = vscode.workspace.getConfiguration("xpair.telemetry");
  if (!hasConfiguredValue(cfg, "enabled")) return;
  const enabled = !!cfg.get("enabled", false);
  const current = telemetry.getConsent();
  if (current.telemetry === enabled && current.crashReport === enabled) return;
  telemetry.setConsent(enabled, enabled);
}

/**
 * Run a command on REMOTE_HOST over ssh, argv-safe.
 * @param {string} host validated host
 * @param {string} remoteCmd the command line to run on the host (a single
 *        string passed as ssh's last argv element; ssh runs it via the host's
 *        login shell — we control its content, never the host string)
 * @param {object} [opts] { encoding, maxBuffer, timeoutMs }
 * @returns {Promise<{code:number, stdout:Buffer|string, stderr:string}>}
 */
function sshRun(host, remoteCmd, opts = {}) {
  const encoding = opts.encoding === undefined ? "utf8" : opts.encoding; // null => Buffer
  const maxBuffer = opts.maxBuffer || 16 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs || 15000;
  const args = [
    ...pairingIdArgs(),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    // ControlMaster: reuse ONE persistent connection across probes/tunnels → faster polling
    // and a single SSH-agent (1Password) authorization instead of one per probe. The path lives
    // under this GUI session's temp dir and %C keys it by host/port/user, so the electron-main
    // onboarding guard and extension-host workbench share it without a pid split.
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${sshControlPath()}`,
    "-o",
    "ControlPersist=300",
    host, // validated against HOST_RE; passed as its own argv element
    remoteCmd,
  ];
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.spawn("ssh", args, { windowsHide: true, env: spawnEnv() });
    } catch (e) {
      resolve({ code: -1, stdout: encoding === null ? Buffer.alloc(0) : "", stderr: String(e) });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const outBuf = Buffer.concat(outChunks);
      resolve({
        code,
        stdout: encoding === null ? outBuf : outBuf.toString(encoding),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        failureKind: code === 0 ? SSH_STATE.READY : sshFailureKind(Buffer.concat(errChunks).toString("utf8")),
      });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_e) {}
      finish(-2);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      outLen += d.length;
      if (outLen <= maxBuffer) outChunks.push(d);
    });
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", (e) => {
      errChunks.push(Buffer.from(String(e)));
      finish(-1);
    });
    child.on("close", (code) => finish(code == null ? 0 : code));
  });
}

/** POSIX single-quote escape for embedding a literal in a sh command. */
function shSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

async function readRdSessionToken(host) {
  const res = await sshRun(host, `cat ${RD_SESSION_TOKEN_REMOTE_FILE}`, {
    timeoutMs: 6000,
    maxBuffer: 4096,
  });
  if (res.code !== 0) {
    const stderr = String(res.stderr || "").trim();
    const detail = stderr
      ? `Could not read host RD token: ${stderr}`
      : `Could not read host RD token: ssh exited ${res.code}`;
    const error = new Error(detail);
    error.failureKind = res.failureKind || sshFailureKind(detail);
    error.retryable = RD_TOKEN_FILE_NOT_READY_RE.test(detail);
    throw error;
  }
  const token = String(res.stdout || "").trim();
  if (!RD_SESSION_TOKEN_RE.test(token)) {
    const error = new Error("Host RD token is missing or malformed");
    error.failureKind = SSH_STATE.UNREACHABLE;
    error.retryable = true;
    throw error;
  }
  return token;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function rdCaptureParams() {
  const cfg = vscode.workspace.getConfiguration("xpair.remoteDesktop");
  const fps = clampInteger(cfg.get("fps", RD_CAPTURE_DEFAULTS.fps), 1, 120, RD_CAPTURE_DEFAULTS.fps);
  const bitrate = clampInteger(
    cfg.get("bitrate", RD_CAPTURE_DEFAULTS.bitrate),
    100000,
    50000000,
    RD_CAPTURE_DEFAULTS.bitrate
  );
  const scale = clampNumber(cfg.get("scale", RD_CAPTURE_DEFAULTS.scale), 0.1, 1.0, RD_CAPTURE_DEFAULTS.scale);
  return { fps, bitrate, scale };
}

function appendQueryParams(url, params) {
  const sep = url.includes("?") ? "&" : "?";
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${url}${sep}${query}`;
}

function isBindCollision(detail) {
  return /bind: Address already in use|Address already in use|Local forwarding failed|cannot listen to port|EADDRINUSE/i.test(String(detail || ""));
}

function classifiedSshFailureMessage(detail) {
  const state = sshFailureKind(detail);
  if (state === SSH_STATE.UNREACHABLE) return String(detail || "SSH tunnel failed");
  return sshFailureMessage(state, detail);
}

function gatewayMacBlockDetail(gw) {
  const state = gw && gw.state ? gw.state : "unknown";
  return `gateway MAC guard fail-closed: ${state}${gw && gw.err ? ` (${gw.err})` : ""}`;
}

function rdFailureKindForSshState(state) {
  if (state === SSH_STATE.HOST_KEY_MISMATCH) return "host-key";
  if (state === SSH_STATE.KEY_AUTH_BLOCKED) return "key-auth";
  return "reach";
}

function normalizeRdFailureKind(kind, fallback = "reach") {
  const raw = String(kind || "").toLowerCase().replace(/_/g, "-");
  if (raw === "host-key-mismatch") return "host-key";
  if (raw === "key-auth-blocked") return "key-auth";
  if (
    raw === "reach" ||
    raw === "key-auth" ||
    raw === "host-key" ||
    raw === "capture-failed" ||
    raw === "peer-failed" ||
    raw === "no-first-frame" ||
    raw === "superseded"
  ) {
    return raw;
  }
  return fallback;
}

// --- tunnel helpers ----------------------------------------------------------

/**
 * Find a free local TCP port by asking the OS.
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Spawn an ssh local-forward tunnel (foreground: ssh -N).
   * argv-safe: host is validated, ports are integers.
 *
 * Returns the child process — child.kill() to teardown.  We deliberately do NOT pass `-f`:
 * with `-f`, ssh forks into the background and the foreground (this Node child) exits
 * immediately, so child.kill() would target an already-dead parent and leak the real tunnel.
 * Staying in the foreground keeps THIS child as the actual tunnel process so _stopV2()'s
 * kill() truly terminates it. Readiness is not inferred from process exit — the caller waits
 * TUNNEL_SETTLE_MS before connecting.
 * Forwards the v2 WebRTC signaling port (media itself flows over UDP/ICE, not this TCP tunnel).
 */
function spawnTunnel(host, localPort, remotePort) {
  // -N: no remote command (forward only). NO -f: stay in the foreground so the returned child
  // IS the tunnel and can be killed. ControlMaster=auto reuses the existing authenticated
  // master so there's no new key prompt.
  const rport = remotePort;
  // ControlPath is shared within one app launch via RP_SSH_CM_TAG. That lets the pre-workbench
  // onboarding guard authenticate once and the workbench tunnel reuse the same live master, without
  // reusing stale masters from earlier launches.
  const args = [
    ...pairingIdArgs(),
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${sshControlPath()}`,
    "-o", "ControlPersist=300",
    "-o", "ExitOnForwardFailure=yes",
    "-N",
    "-L", `${localPort}:127.0.0.1:${rport}`,
    host, // validated HOST_RE ssh target
  ];
  log(`tunnel: ssh -N -L ${localPort}:127.0.0.1:${rport} ${host}`);
  const child = cp.spawn("ssh", args, { windowsHide: true, detached: false, env: spawnEnv() });
  child.stderr.on("data", (d) => log(`tunnel stderr: ${d.toString().trim()}`));
  child.on("error", (e) => log(`tunnel spawn error: ${e.message}`));
  child.on("close", (code) => log(`tunnel exited code=${code}`));
  return child;
}

// --- Remote Desktop editor-tab panel ---------------------------------------
// Wireframe: Remote Desktop is a *pinned editor tab* ("RD") in the main editor
// area (the right pane), behaving like a normal editor tab next to file tabs —
// NOT a view in the left activity bar.

class RemoteDesktopPanel {
  /** @param {vscode.Uri} extensionUri */
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.panel = null;
    this.visible = false;

    // v2 WebRTC signaling tunnel state
    this._tunnelChild = null;   // ssh -N child process (foreground; killable)
    this._tunnelPort = null;    // local signaling port in use
    this._v2Active = false;     // true while the v2 signaling tunnel is up
    this._v2Generation = 0;
    this._v2SettleTimer = null;
    this._v2RetryTimer = null;
    this._v2SessionToken = null;
  }

  /** Create the singleton RD editor tab, or reveal it if it already exists. */
  async reveal() {
    if (this.panel) {
      this._revealOwnedPanelAndRestart();
      return;
    }
    // Cross-extension-host dedup: this window runs TWO local extension hosts (a pre-existing
    // workbench quirk), so activate() — and this reveal() — runs twice and would open a SECOND "RD"
    // tab. Editor tabs are renderer-level (visible to every exthost via tabGroups), so if an RD
    // webview tab already exists, reveal/adopt it and restart its stream instead of creating a
    // second tab or leaving a restored RD tab inert.
    const existingTab = this._findExistingRdTab();
    if (existingTab) {
      log("RD: an RD tab already exists (opened by another extension host) — adopting/revealing singleton");
      const handled = await this._adoptExistingRdTab(existingTab);
      if (handled) return;
    }
    const panel = vscode.window.createWebviewPanel(
      "remotepair.remoteDesktop",
      "RD",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      }
    );
    this._adopt(panel);
    // Pin so it behaves like a permanent tab (wireframe: RD is a pinned editor tab).
    // Await so the pin lands on RD before anything else steals editor focus
    // (e.g. setupLayout opening a terminal tab right after).
    try {
      await vscode.commands.executeCommand("workbench.action.pinEditor");
    } catch (_e) {}
    if (this.visible) this._startStream();
  }

  _findExistingRdTab() {
    try {
      for (const g of vscode.window.tabGroups.all) {
        const tabs = g.tabs || [];
        for (let i = 0; i < tabs.length; i += 1) {
          const t = tabs[i];
          const vt = t.input && t.input.viewType;
          if (typeof vt === "string" && vt.indexOf("remotepair.remoteDesktop") !== -1) {
            return { group: g, tab: t, index: i };
          }
        }
      }
    } catch (_e) {}
    return null;
  }

  async _adoptExistingRdTab(existing) {
    await this._revealExistingRdTab(existing);
    try {
      await vscode.commands.executeCommand("remotepair.remoteDesktop.refresh");
    } catch (_e) {}
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.panel) {
      this._revealOwnedPanelAndRestart();
      return true;
    }
    try {
      const closed = await vscode.window.tabGroups.close(existing.tab, true);
      if (closed) {
        log("RD: closed an orphaned existing RD tab so the singleton can be recreated");
        return false;
      }
    } catch (e) {
      log(`RD: existing RD tab cleanup failed; keeping singleton tab: ${e && e.message ? e.message : e}`);
    }
    return true;
  }

  async _revealExistingRdTab(existing) {
    const group = existing && existing.group;
    const oneBasedIndex = (existing && existing.index !== undefined ? existing.index : 0) + 1;
    try {
      if (group && !group.isActive) {
        const names = {
          1: "First",
          2: "Second",
          3: "Third",
          4: "Fourth",
          5: "Fifth",
          6: "Sixth",
          7: "Seventh",
          8: "Eighth",
        };
        const name = names[group.viewColumn];
        if (name) {
          await vscode.commands.executeCommand(`workbench.action.focus${name}EditorGroup`);
        }
      }
    } catch (_e) {}
    try {
      await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", [oneBasedIndex]);
      return;
    } catch (_e) {}
    if (oneBasedIndex >= 1 && oneBasedIndex <= 9) {
      try {
        await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${oneBasedIndex}`);
      } catch (_e) {}
    }
  }

  _revealOwnedPanelAndRestart() {
    if (!this.panel) return;
    try {
      this.panel.reveal(this.panel.viewColumn || vscode.ViewColumn.Active, false);
    } catch (_e) {}
    this.visible = true;
    this._stopAll();
    this._startStream();
  }

  /** Adopt a webview panel (freshly created OR restored by VSCode across a reload) as THE single
   *  RD panel. If a singleton already exists, the incoming one is a restore-duplicate → dispose it
   *  so there is never a second "RD" tab. This is the fix for the pre-existing "RD opens twice"
   *  bug: without a WebviewPanelSerializer, a reload restores the old RD tab AND startup reveal()
   *  creates a new one. The serializer (registered in activate) routes restores through here. */
  _adopt(panel) {
    if (this.panel && this.panel !== panel) {
      try {
        panel.dispose();
        this._revealOwnedPanelAndRestart();
        return;
      } catch (e) {
        log(`RD: duplicate RD cleanup failed; adopting incoming panel: ${e && e.message ? e.message : e}`);
        const previous = this.panel;
        this.panel = null;
        this._stopAll();
        try { previous.dispose(); } catch (_e) {}
      }
    }
    this.panel = panel;
    try {
      panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg");
    } catch (_e) {}
    panel.webview.html = this.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    panel.onDidChangeViewState(() => {
      if (this.panel !== panel) return;
      if (panel.visible) {
        this.visible = true;
        this._startStream();
      } else {
        this.visible = false;
        this._stopAll();
      }
    });
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.visible = false;
      this._stopAll();
      this.panel = null;
    });
    this.visible = panel.visible;
  }

  /** Restore handler for VSCode's WebviewPanelSerializer — adopt the restored RD (or drop a dup). */
  restore(panel) {
    try {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      };
    } catch (_e) {}
    this._adopt(panel);
    if (this.panel === panel && this.visible) {
      this._startStream();
    }
  }

  /** Entry point: start the v2 WebRTC stream. */
  async _startStream() {
    // Guard against double-start (refresh + visibility-restore overlap) which
    // could otherwise spawn two ssh tunnels on different ports.
    if (this._v2Active) return;
    const host = getValidHost();
    if (!host) {
      this.post({ type: "status", state: "no-host" });
      return;
    }
    try {
      const gw = onboardingBridge.gatewayMacStatus();
      if (gw && gw.allowed === false) {
        const detail = gatewayMacBlockDetail(gw);
        log(detail, "warn");
        this.post({ type: "status", state: "error", detail, failureKind: "reach" });
        return;
      }
    } catch (e) {
      const detail = `gateway MAC guard unavailable; auto-connect disabled: ${e && e.message ? e.message : e}`;
      log(detail, "warn");
      this.post({ type: "status", state: "error", detail, failureKind: "reach" });
      return;
    }
    await this._startV2(host);
  }

  /** Tear down the v2 signaling tunnel. */
  _stopAll() {
    this._stopV2();
  }

  dispose() {
    this._stopAll();
    const panel = this.panel;
    this.panel = null;
    if (panel && typeof panel.dispose === "function") {
      try { panel.dispose(); } catch (_e) {}
    }
  }

  // --- v2 WebRTC (UDP/RTP H.264) -------------------------------------------

  async _startV2(host, attempt = 0, bindAttempt = 0) {
    this._stopV2();
    const generation = ++this._v2Generation;
    this._v2Active = true;
    let localPort;
    try {
      localPort = await getFreePort();
    } catch (e) {
      log(`v2: getFreePort error: ${e.message}`);
      if (this._v2Generation === generation) this._v2Active = false;
      this.post({ type: "status", state: "error", detail: String(e.message), failureKind: "reach" });
      return;
    }
    if (!this._v2Active || this._v2Generation !== generation) return;
    this._tunnelPort = localPort;
    let hostSessionToken;
    try {
      hostSessionToken = await readRdSessionToken(host);
    } catch (e) {
      const detail = e && e.message ? e.message : String(e || "could not read host RD token");
      const failureKind = e && e.failureKind ? e.failureKind : sshFailureKind(detail);
      if (
        this._v2Generation === generation &&
        attempt < RD_MAX_TRANSIENT_ATTEMPTS &&
        isRetryableRdTokenReadFailure(e, failureKind, detail)
      ) {
        this._tunnelPort = null;
        const delay = rdTransientRetryDelayMs(attempt);
        log(`v2: RD token read transient (${detail.slice(0, 120)}) — retry ${attempt + 1}/${RD_MAX_TRANSIENT_ATTEMPTS} in ${delay}ms`);
        this.post({ type: "status", state: "connecting", detail: `reconnecting… (${attempt + 1}/${RD_MAX_TRANSIENT_ATTEMPTS})` });
        const retryTimer = setTimeout(() => {
          if (this._v2RetryTimer === retryTimer) this._v2RetryTimer = null;
          if (this._v2Generation !== generation) return;
          this._startV2(host, attempt + 1, bindAttempt);
        }, delay);
        this._v2RetryTimer = retryTimer;
        return;
      }
      if (this._v2Generation === generation) {
        this._v2Active = false;
        this._tunnelPort = null;
        this.post({
          type: "status",
          state: "error",
          detail: classifiedSshFailureMessage(detail),
          failureKind: rdFailureKindForSshState(failureKind),
        });
      }
      return;
    }
    if (!this._v2Active || this._v2Generation !== generation) return;
    this._v2SessionToken = hostSessionToken;
    // Tunnel forwards the SIGNALING port only (TCP). Media flows over UDP/ICE.
    const child = spawnTunnel(host, localPort, SIGNAL_REMOTE_PORT);
    this._tunnelChild = child;

    let tunnelStderr = "";
    if (child && child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (d) => {
        tunnelStderr = (tunnelStderr + String(d || "")).slice(-1200);
      });
    }

    // Transient failures: a momentarily-locked 1Password / ssh-agent that refuses to sign exits the
    // tunnel with code 255 ("agent refused operation" / "signing failed … from agent" / publickey
    // permission denied) — and a stale ControlPath or a host still coming up also blip. These resolve
    // on a retry once 1Password is unlocked/approved, so don't surface a hard error on the first blip.
    // Match only genuinely retryable auth/network transients — NOT a bare code=255 (that also covers
    // hard failures like "bind: Address already in use" which must surface immediately).
    const postTunnelFailure = (detail) => {
      if (!this._v2Active || this._tunnelChild !== child || this._v2Generation !== generation) return;
      if (isBindCollision(detail) && bindAttempt < RD_MAX_BIND_ATTEMPTS) {
        this._tunnelChild = null;
        this._tunnelPort = null;
        log(`v2: local bind collision on ${localPort} — retrying with a fresh port (${bindAttempt + 1}/${RD_MAX_BIND_ATTEMPTS})`);
        this.post({ type: "status", state: "connecting", detail: "retrying local tunnel port…" });
        const retryTimer = setTimeout(() => {
          if (this._v2RetryTimer === retryTimer) this._v2RetryTimer = null;
          if (this._v2Generation !== generation) return;
          this._startV2(host, attempt, bindAttempt + 1);
        }, RD_BIND_RETRY_DELAY_MS);
        this._v2RetryTimer = retryTimer;
        return;
      }
      const failureKind = sshFailureKind(detail);
      // Lazy connect: re-spawn with backoff instead of failing hard, giving 1Password time to
      // unlock/approve. Only surface the error after the retry window is exhausted.
      if (
        attempt < RD_MAX_TRANSIENT_ATTEMPTS &&
        isTransientRdSshFailure(failureKind, detail)
      ) {
        this._tunnelChild = null;
        this._tunnelPort = null;
        const delay = rdTransientRetryDelayMs(attempt);
        log(`v2: tunnel transient (${detail.slice(0, 120)}) — retry ${attempt + 1}/${RD_MAX_TRANSIENT_ATTEMPTS} in ${delay}ms`);
        this.post({ type: "status", state: "connecting", detail: `reconnecting… (${attempt + 1}/${RD_MAX_TRANSIENT_ATTEMPTS})` });
        const retryTimer = setTimeout(() => {
          if (this._v2RetryTimer === retryTimer) this._v2RetryTimer = null;
          if (this._v2Generation !== generation) return; // superseded by a stop/newer start
          this._startV2(host, attempt + 1);
        }, delay);
        this._v2RetryTimer = retryTimer;
        return;
      }
      this._v2Active = false;
      this._tunnelChild = null;
      this._tunnelPort = null;
      this.post({
        type: "status",
        state: "error",
        detail: classifiedSshFailureMessage(detail),
        failureKind: rdFailureKindForSshState(failureKind),
      });
    };

    if (child && typeof child.on === "function") {
      child.on("error", (e) => {
        const msg = e && e.message ? e.message : String(e || "unknown");
        postTunnelFailure(`SSH tunnel failed: ${msg}`);
      });
      child.on("close", (code, signal) => {
        const reason = signal ? `signal=${signal}` : `code=${code}`;
        const stderr = tunnelStderr.trim();
        const detail = stderr
          ? `SSH tunnel exited ${reason}: ${stderr}`
          : `SSH tunnel exited ${reason}`;
        postTunnelFailure(detail);
      });
    }

    const self = this;
    const settleTimer = setTimeout(() => {
      if (self._v2SettleTimer === settleTimer) {
        self._v2SettleTimer = null;
      }
      if (!self._v2Active || self._v2Generation !== generation || self._tunnelChild !== child || self._tunnelPort !== localPort || !self.panel) return;
      const sessionToken = self._v2SessionToken;
      const captureParams = rdCaptureParams();
      const signalUrl = appendQueryParams(
        `ws://127.0.0.1:${localPort}/?token=${encodeURIComponent(sessionToken)}`,
        captureParams
      );
      log(`v2: telling webview to connect signaling ws://127.0.0.1:${localPort}/?token=<redacted>`);
      self.post({ type: "v2Connect", signalUrl, sessionToken });
    }, TUNNEL_SETTLE_MS);
    this._v2SettleTimer = settleTimer;
  }

  _stopV2() {
    this._v2Generation += 1;
    this._v2Active = false;
    this.post({ type: "v2Cancel" });
    if (this._v2SettleTimer) {
      try { clearTimeout(this._v2SettleTimer); } catch (_e) {}
      this._v2SettleTimer = null;
    }
    if (this._v2RetryTimer) {
      try { clearTimeout(this._v2RetryTimer); } catch (_e) {}
      this._v2RetryTimer = null;
    }
    if (this._tunnelChild) {
      try { this._tunnelChild.kill("SIGTERM"); } catch (_e) {}
      this._tunnelChild = null;
    }
    this._tunnelPort = null;
    this._v2SessionToken = null;
  }

  onMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "ready") {
      return;
    }
    if (msg.type === "refresh") {
      // Restart the v2 signaling tunnel and tell the webview to reconnect.
      this._stopAll();
      this._startStream();
      return;
    }
    // v2 (WebRTC) feedback from webview. Reconnect is handled inside the webview
    // over the current tunnel; v2Error is terminal for that bounded retry window.
    if (msg.type === "v2FirstFrame") {
      log(`v2: media track rendering`);
      return;
    }
    if (msg.type === "v2Stats") {
      log(
        `v2 stats: decoded=${msg.decoded ?? "-"} dropped=${msg.dropped ?? "-"} ` +
        `fps=${msg.fps ?? "-"} jitterMs=${msg.jitterMs ?? "-"} bitrateKbps=${msg.bitrateKbps ?? "-"}`
      );
      return;
    }
    if (msg.type === "v2Error") {
      const failureKind = normalizeRdFailureKind(msg.failureKind, "peer-failed");
      log(`v2: webview reported error (${failureKind}): ${msg.detail || "unknown"}`);
      this._stopAll();
      this.post({
        type: "status",
        state: "error",
        detail: String(msg.detail || "webrtc error"),
        failureKind,
      });
      return;
    }
  }

  post(m) {
    if (this.panel) {
      try {
        this.panel.webview.postMessage(m);
      } catch (_e) {}
    }
  }

  refresh() {
    if (this.panel) {
      this.onMessage({ type: "refresh" });
    }
  }

  getHtml(webview) {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "remote-desktop.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "remote-desktop.css")
    );
    // CSP: allow our nonce'd script, our stylesheet, the H.264 <video> media,
    // and the v2 signaling WebSocket on loopback.
    const csp = [
      `default-src 'none'`,
      `media-src ${webview.cspSource} blob: mediastream:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      // ws://127.0.0.1:* = v2 WebRTC signaling (loopback, reached over ssh -L).
      // The v2 media itself is UDP/RTP, not subject to CSP.
      `connect-src ws://127.0.0.1:* ws://localhost:*`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>Remote Desktop</title>
</head>
<body>
  <div id="stage">
    <video id="screen-video" autoplay muted playsinline></video>
    <div id="overlay" class="hidden">
      <div id="overlay-title">Xpair</div>
      <div id="overlay-msg">Connecting to host…</div>
    </div>
    <div id="badge" class="off" title="Waiting for remote input helper">input pending</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// --- helpers ----------------------------------------------------------------

function makeNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// --- AI extension bootstrap -------------------------------------------------

async function ensureExtensions(interactive) {
  const missing = AI_EXTENSIONS.filter((id) => !vscode.extensions.getExtension(id));
  if (!missing.length) {
    if (interactive) vscode.window.showInformationMessage("Xpair: AI extensions already installed.");
    return;
  }
  log(`Installing missing AI extensions: ${missing.join(", ")}`);
  for (const id of missing) {
    try {
      await vscode.commands.executeCommand("workbench.extensions.installExtension", id);
      log(`installed ${id}`);
    } catch (e) {
      // best-effort; swallow but log
      log(`install failed for ${id}: ${e && e.message ? e.message : e}`);
    }
  }
  if (interactive) {
    vscode.window.showInformationMessage(
      `Xpair: requested install of ${missing.length} extension(s). Reload if prompted.`
    );
  }
}

// --- connect to host --------------------------------------------------------

/**
 * Core connection logic: keep host selection inside the Xpair Client flow.
 * @param {string} host validated host alias
 * @param {RemoteDesktopPanel} [panel]
 */
async function _doConnectHost(host, panel) {
  // NOTE: connect deliberately keeps the host connection, mappings, sessions, and
  // Remote Desktop inside THIS window by routing through the Xpair surfaces below,
  // rather than spawning a separate open-remote-ssh window for the host filesystem.
  log(`connectHost: routing ${host} through Xpair surfaces`);

  const reach = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Xpair: checking ${host}`, cancellable: false },
    async () => {
      const res = await sshRun(host, "true", { timeoutMs: 6000 });
      return {
        ok: res.code === 0,
        detail: (res.stderr || res.stdout || "").trim().split(/\r?\n/).slice(-2).join(" "),
      };
    }
  );

  if (!reach.ok) {
    log(`connectHost: host check failed for ${host}: ${reach.detail || "unreachable"}`, "warn");
    const retry = "Retry";
    const setup = "Set up again";
    const picked = await vscode.window.showWarningMessage(
      `Xpair: ${host} is not reachable. Stay in the Xpair setup flow to recover the host connection.`,
      retry,
      setup
    );
    if (picked === retry) {
      await _doConnectHost(host, panel);
    } else if (picked === setup) {
      runSetup();
    }
    return;
  }

  let clientDirs = reconcileBrowserRoots();

  try {
    await vscode.commands.executeCommand("remotepair.terminalSidebar");
  } catch (e) {
    log(`connectHost: reveal terminal sidebar failed: ${e && e.message ? e.message : e}`, "warn");
  }
  try {
    await vscode.commands.executeCommand("remotepair.sessions.attached.view.focus", { preserveFocus: true });
  } catch (e) {
    log(`connectHost: reveal sessions panel failed: ${e && e.message ? e.message : e}`, "warn");
  }

  if (clientDirs.length === 0) {
    try {
      await vscode.commands.executeCommand("workbench.view.explorer");
    } catch (e) {
      log(`connectHost: reveal Browser empty-state failed: ${e && e.message ? e.message : e}`, "warn");
    }
    const addRootChoice = "Add Mapping";
    const setup = "Run setup";
    const picked = await vscode.window.showInformationMessage(
      "Xpair: no mapped Browser roots are configured for this host.",
      addRootChoice,
      setup
    );
    if (picked === addRootChoice) {
      await addRoot();
      clientDirs = reconcileBrowserRoots();
    } else if (picked === setup) {
      setupFileAccess();
      return;
    } else {
      return;
    }
    if (clientDirs.length === 0) {
      return;
    }
  }

  launchRemoteClaude();

  try {
    if (panel) {
      await panel.reveal();
      panel.refresh();
    } else {
      await vscode.commands.executeCommand("remotepair.openRemoteDesktop");
      await vscode.commands.executeCommand("remotepair.remoteDesktop.refresh");
    }
  } catch (e) {
    log(`connectHost: RD recovery failed: ${e && e.message ? e.message : e}`, "warn");
  }

  vscode.window.showInformationMessage(
    `Xpair: ${host} selected. Sessions, Browser mapping, and Remote Desktop are recovering in this window.`
  );
}

/**
 * Show a QuickPick listing the configured endpoint(s) (currently REMOTE_HOST from
 * client.env = one item), then connect to the selected host.
 */
async function connectHost(panel) {
  const host = getValidHost();
  if (!host) {
    vscode.window.showWarningMessage(
      "Xpair: REMOTE_HOST is not set (or invalid) in ~/.xpair/host/client.env."
    );
    return;
  }

  // Build the list of endpoints. Currently there is exactly one (REMOTE_HOST from
  // client.env). The QuickPick is kept generic so additional endpoints can be
  // appended here in the future without changing the selection UI.
  const items = [
    {
      label: `$(remote) ${host}`,
      description: "REMOTE_HOST (client.env)",
      detail: `Recover Xpair connection, mappings, sessions, and RD for ${host}`,
      host,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: "Xpair: Select Host to Connect",
    placeHolder: "Choose an endpoint…",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return; // user cancelled
  log(`connectHost: user selected ${picked.host}`);
  await _doConnectHost(picked.host, panel);
}

// --- launch remote Claude ---------------------------------------------------

/**
 * Open a terminal and stage the `xpair launch` command (addNewLine=false
 * so the user reviews before pressing Enter).
 *
 * `xpair launch` is the client-side CLI that opens a mosh+tmux session
 * on the host and starts Claude Code inside it.  If the exact subcommand name
 * changes, adjust the sendText argument here; the terminal name makes the
 * intent clear to the user regardless.
 */
function launchRemoteClaude() {
  let term;
  try {
    term = vscode.window.createTerminal("Xpair — Launch Claude");
    term.show(true);
    // Stage without auto-executing so the user can review / edit first.
    // "xpair launch" = mosh → tmux → claude (see xpair CLI help).
    // If the exact subcommand differs on your setup, edit before pressing Enter.
    term.sendText("xpair launch", false);
  } catch (e) {
    const detail = redact((e && e.message ? e.message : e) || "unknown error");
    log(`launchRemoteClaude: ${detail}`, "error");
    vscode.window.showErrorMessage(`Xpair: failed to open a terminal for 'xpair launch'. ${detail}`);
    return;
  }
  vscode.window.showInformationMessage(
    "Xpair: review 'xpair launch' in the terminal and press Enter to open " +
      "a mosh+tmux+Claude Code session on the remote host."
  );
}

// --- file access / folder mapping setup ------------------------------------

/**
 * Open a terminal and stage the interactive `xpair onboard` wizard, which
 * configures host, terminal app, folder mapping, and a doctor check. We do NOT
 * auto-run it (addNewLine=false) so the user reviews the command first.
 */
function setupFileAccess() {
  let term;
  try {
    term = vscode.window.createTerminal("Xpair Setup");
    term.show(true);
    // Stage the command without executing — the user presses Enter to start the
    // interactive wizard (it prompts for host / mapping / backend).
    term.sendText("xpair onboard", false);
  } catch (e) {
    const detail = redact((e && e.message ? e.message : e) || "unknown error");
    log(`setupFileAccess: ${detail}`, "error");
    vscode.window.showErrorMessage(`Xpair: failed to open a terminal for 'xpair onboard'. ${detail}`);
    return;
  }
  vscode.window.showInformationMessage(
    "Xpair: review 'xpair onboard' in the terminal and press Enter to " +
      "configure the host, folder mapping, and file-access backend (Syncthing or mount)."
  );
}

// --- host notifications poller ---------------------------------------------

class NotificationPoller {
  constructor() {
    this.timer = null;
    this.seen = new Set(); // dedupe by ts (+type)
    this.started = false;
    // True once the FIRST successful poll has completed. First-run suppression must NOT be
    // derived from seen.size: if the IDE starts while the queue is empty, seen stays empty,
    // so the first poll that later carries live notifications would be misread as first-run
    // and drop every record — exactly the approve-wait prompts we mean to surface.
    this.initialized = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    // initial delay so startup isn't noisy
    this.timer = setInterval(() => this.poll(), NOTIFY_INTERVAL_MS);
    setTimeout(() => this.poll(), 2500);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  async poll() {
    const host = getValidHost();
    if (!host) return;
    const enabled = readEnabledNotifyTypes(); // Set or null(=all)
    const res = await sshRun(
      host,
      "tail -n 20 ~/.xpair/host/notifications/queue.jsonl 2>/dev/null",
      { timeoutMs: 8000 }
    );
    // Distinguish "could not observe the queue" from "observed it, and it's empty/absent".
    // Over ssh, `tail … 2>/dev/null` exits 0 when the file is read and 1 when it's missing
    // (an empty queue — still a valid observation); ssh transport failure is 255 and
    // spawn/timeout are negative. Only the latter group must keep the poller uninitialized;
    // returning on a missing file too would leave `initialized` false until the file first
    // gains content, and that first batch (e.g. the first approve-wait) would then be
    // mistaken for startup history and suppressed.
    if (res.code !== 0 && res.code !== 1) return; // transport failure / timeout -> quiet
    const lines = String(res.stdout).split(/\r?\n/);
    // On the very first successful poll, mark the WHOLE existing tail seen without showing
    // any of it (avoid replaying history). Captured once per poll (batch-level), and gated
    // on an explicit `initialized` flag rather than seen.size — an empty-queue startup keeps
    // seen empty, so a size-based check would replay the first live batch as "history".
    const firstRun = !this.initialized;
    this.initialized = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch (_e) {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const key = `${obj.ts || ""}|${obj.type || ""}|${obj.session || ""}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (firstRun) continue;
      if (!obj.type || !enabled.has(obj.type)) continue;

      const title = obj.title ? String(obj.title) : "Xpair";
      const message = obj.message ? String(obj.message) : "";
      const text = message ? `${title}: ${message}` : title;
      if (obj.approvalType) {
        vscode.window.showWarningMessage(`Xpair (approval: ${obj.approvalType}) — ${text}`);
      } else {
        vscode.window.showInformationMessage(`Xpair — ${text}`);
      }
    }
    // Bound the dedupe set so it can't grow unbounded.
    if (this.seen.size > 500) {
      const arr = Array.from(this.seen);
      this.seen = new Set(arr.slice(arr.length - 250));
    }
  }
}

// --- one-time workbench layout ---------------------------------------------
// Native model (wireframe): the LEFT activity-bar rail switches a SINGLE primary
// sidebar between containers — "Terminal" (the integrated terminal, moved to the
// Sidebar in terminal.contribution) and "Browser" (the file explorer). Clicking
// a rail item switches the sidebar (no extra column). The editor area (right)
// holds files + the pinned RD tab. The sidebar is user-resizable to mid-screen.

async function setupLayout(context, force) {
  const KEY = "remotepair.layoutInitialized.v7";
  if (!force && context.globalState.get(KEY)) return;
  // Terminal now lives in a custom "Terminal" SIDEBAR container that embeds an
  // EditorPart (workbench source component — see plan #3). The extension only
  // closes the right-side bar; RD is opened in the main editor by activate().
  try {
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  } catch (_e) {}
  // Default the primary sidebar to the Browser. A fresh launch has no attached terminal
  // sessions, so we start in the Browser (file explorer) rather than the empty Sessions
  // sidebar. The workbench-side RemotePairEmptySessionsBrowserFallback contribution keeps this
  // in sync afterwards (re-reveals the Browser whenever the last terminal tab is closed), so
  // the two agree on every launch and there is no Terminal→Browser flash.
  try {
    await vscode.commands.executeCommand("workbench.view.explorer");
  } catch (e) {
    log(`setupLayout reveal browser: ${e && e.message ? e.message : e}`);
  }
  try {
    await context.globalState.update(KEY, true);
  } catch (e) {
    log(`setupLayout: globalState.update failed: ${e && e.message ? e.message : e}`);
  }
}

// --- FOLDER_MAPS parser ----------------------------------------------------

/**
 * Read FOLDER_MAPS from ~/.xpair/host/client.env.
 * Format: "clientDir::hostDir" pairs separated by ";".
 * Returns an array of { clientDir, hostDir } objects (may be empty).
 */
/** Expand a leading ~ or ~/ to the user's home dir (env-file paths commonly use ~). */
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Decode a bash ANSI-C `$'...'` segment body (the text BETWEEN the quotes) to its literal value.
 *  Handles the escapes printf %q emits: \t \n \r \\ \' \" \a \b \f \v \e \xHH \nnn(octal) \uHHHH. */
function unescapeAnsiC(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { out += ch; continue; }
    const n = body[++i];
    switch (n) {
      case "t": out += "\t"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "a": out += "\x07"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "e": out += "\x1b"; break;
      case "\\": out += "\\"; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case "x": { // \xHH (1-2 hex)
        const m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1));
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; }
        else out += "x";
        break;
      }
      case "u": { // \uHHHH (1-4 hex)
        const m = /^[0-9a-fA-F]{1,4}/.exec(body.slice(i + 1));
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; }
        else out += "u";
        break;
      }
      default: {
        if (n >= "0" && n <= "7") { // octal \nnn (1-3 digits)
          const m = /^[0-7]{1,3}/.exec(n + body.slice(i + 1));
          out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
          i += m[0].length - 1;
        } else if (n === undefined) {
          out += "\\";
        } else {
          out += n; // unknown escape — keep the char
        }
      }
    }
  }
  return out;
}

/** Reverse bash `printf %q` for ONE shell word. `%q` emits an unquoted, backslash-escaped form
 *  (e.g. `Google\ Drive`, `a\'b`) and/or inline ANSI-C `$'...'` segments for control chars. This
 *  un-escapes both so the result is the REAL filesystem path. Plain values pass through unchanged. */
function unquoteShellWord(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") { // backslash escape: next char is literal
      if (i + 1 < s.length) { out += s[++i]; } else { out += "\\"; }
    } else if (ch === "$" && s[i + 1] === "'") { // $'...' ANSI-C segment
      let j = i + 2, body = "";
      while (j < s.length && s[j] !== "'") {
        if (s[j] === "\\" && j + 1 < s.length) { body += s[j] + s[j + 1]; j += 2; }
        else { body += s[j]; j++; }
      }
      out += unescapeAnsiC(body);
      i = j; // skip past the closing quote
    } else if (ch === "'") { // plain '...' single-quoted segment: literal until next '
      let j = i + 1;
      while (j < s.length && s[j] !== "'") { out += s[j]; j++; }
      i = j;
    } else {
      out += ch;
    }
  }
  return out;
}

function readFolderMaps() {
  const envPath = path.join(os.homedir(), ".xpair/host", "client.env");
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch (_e) {
    return [];
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (key !== "FOLDER_MAPS") continue;
    let val = t.slice(eq + 1).trim();
    if (!val) return [];
    // The CLI persists the WHOLE `;`-joined value via `printf '%s=%q\n'`, so paths with spaces/specials
    // arrive bash-`%q`-escaped (e.g. `Google\ Drive`, `a\'b`, or inline `$'...'` ANSI-C form) and a `;`
    // separator is itself escaped to `\;`. The CLI consumes this by SOURCING client.env (bash un-escapes
    // the word) and then word-splitting on `;` — so un-escape the whole value FIRST, exactly mirroring
    // bash, THEN split on `;` / `::`. (Doing it after the split would corrupt the escaped `\;` boundaries.)
    val = unquoteShellWord(val);
    return val
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const sep = pair.indexOf("::");
        if (sep < 0) return null;
        return { clientDir: expandHome(pair.slice(0, sep).trim()), hostDir: pair.slice(sep + 2).trim() };
      })
      .filter(Boolean);
  }
  return [];
}

/**
 * C1.D4 — Reconcile the Browser's workspace roots so they are EXACTLY the FOLDER_MAPS
 * client dirs (that exist on disk), in declared order. This drops any non-mapped folder
 * that leaked in as a launch-arg / workspace folder (the phantom `/tmp/rp-test-folder`)
 * and adds any mapped dir that is missing — in a single updateWorkspaceFolders replace.
 *
 * Returns the resolved clientDirs (may be empty → the Browser shows its empty-state).
 * The `updateWorkspaceFolders` no-op `false` return is logged but not treated as a hard
 * failure: when the current set already matches we skip the call entirely.
 */
function reconcileBrowserRoots() {
  const maps = readFolderMaps();
  const seen = new Set();
  const clientDirs = [];
  for (const m of maps) {
    if (!m.clientDir || seen.has(m.clientDir)) continue;
    seen.add(m.clientDir);
    if (!fs.existsSync(m.clientDir)) {
      log(`reconcileBrowserRoots: skipping missing client dir: ${m.clientDir}`);
      continue;
    }
    clientDirs.push(m.clientDir);
  }

  const current = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  // Target == FOLDER_MAPS clientDirs only. Match requires SAME set AND SAME order so a
  // stray non-mapped folder (phantom root) anywhere in the list forces a replace.
  const alreadyCorrect =
    current.length === clientDirs.length &&
    clientDirs.every((d, i) => current[i] === d);
  if (alreadyCorrect) {
    return clientDirs;
  }

  log(`reconcileBrowserRoots: current=[${current.join(", ")}] target=[${clientDirs.join(", ")}]`);
  // RELOAD CAVEAT: vscode.workspace.updateWorkspaceFolders RELOADS the window when the change
  // transitions to/from 0 folders OR replaces the folder at index 0 (documented behavior). To
  // avoid an unnecessary reload, take an additive fast-path when `current` is a strict prefix of
  // the target (only NEW roots are appended): inserting at the end (start === current.length)
  // never touches index 0 and never crosses the 0-folder boundary, so the window stays put.
  // Anything else (removals, reordering, replacing index 0, or going to/from 0 folders) needs the
  // full replace below, which may reload — but the `alreadyCorrect` guard above already prevents
  // spurious runs, so the replace only fires on a genuine difference.
  const isAdditiveAppend =
    current.length > 0 &&
    clientDirs.length > current.length &&
    current.every((d, i) => clientDirs[i] === d);
  try {
    let ok;
    if (isAdditiveAppend) {
      // Append-only: insert the trailing new roots without disturbing existing ones (no reload).
      const added = clientDirs.slice(current.length);
      log(`reconcileBrowserRoots: additive append of [${added.join(", ")}] (no reload)`);
      ok = vscode.workspace.updateWorkspaceFolders(
        current.length,
        0,
        ...added.map((d) => ({ uri: vscode.Uri.file(d) }))
      );
    } else {
      // Full replace: delete all current folders, insert the mapped clientDirs in order. This may
      // reload the window (index-0 replace and/or the 0-folder boundary). When clientDirs is empty
      // this removes every root (e.g. the phantom launch-arg folder), leaving zero roots so the
      // Browser renders its empty-state add button.
      ok = vscode.workspace.updateWorkspaceFolders(
        0,
        current.length,
        ...clientDirs.map((d) => ({ uri: vscode.Uri.file(d) }))
      );
    }
    if (!ok) {
      // false = no-op or invalid change. This is expected when removing the very last
      // folder is rejected by the workspace model in some single-folder states; it is NOT
      // a thrown error, so we log and continue rather than fall back to a setup wizard.
      log("reconcileBrowserRoots: updateWorkspaceFolders returned false (no-op or invalid)");
    }
  } catch (e) {
    log(`reconcileBrowserRoots: updateWorkspaceFolders threw: ${e && e.message ? e.message : e}`);
  }
  return clientDirs;
}

/**
 * C1.D3 — Run the client `xpair` CLI and capture its stdout/stderr. Spawned through
 * the user's login shell so PATH resolution finds `xpair` wherever it was installed
 * (~/.local/bin, /opt/homebrew/bin, /usr/local/bin, …) — the extension host does not inherit
 * an interactive PATH. argv is passed as a single POSIX-quoted command string to `sh -lc`.
 *
 * Returns { code, stdout, stderr }. Never throws (spawn errors resolve as code -1).
 */
function runXpairCli(args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const quoted = ["xpair", ...args].map(shSingleQuote).join(" ");
  const shell = process.env.SHELL || "/bin/sh";
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.spawn(shell, ["-lc", quoted], { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e) });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.join(""), stderr: err.join("") });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_e) {}
      finish(-2);
    }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d.toString("utf8")));
    child.stderr.on("data", (d) => err.push(d.toString("utf8")));
    child.on("error", (e) => { err.push(String(e)); finish(-1); });
    child.on("close", (code) => finish(code == null ? 0 : code));
  });
}

/**
 * C1.D3 — Mount-first add-mapping flow for the Browser's "Add Mapping" affordance.
 *   1. Prompt for a HOST folder path (v1 = host-path input box).
 *   2. `xpair mount mount <hostPath>` (SMB default, macOS-native no-kext) → real OS mount.
 *   3. Parse the printed "Mountpoint: <path>" and register a FOLDER_MAP via
 *      `xpair map add <mountpoint> <hostPath>` (writes <mountpoint>::<hostPath>).
 *   4. Reconcile roots so the mountpoint appears as a Browser root without restart.
 */
async function addRoot() {
  const hostPath = await vscode.window.showInputBox({
    title: "Xpair — Add Mapping",
    prompt: "Enter the host folder path to map (mounts with SMB by default, then appears as a Browser root and in Finder).",
    placeHolder: "/Users/you/Projects/myrepo",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = (v || "").trim();
      if (!t) return "Enter a host folder path.";
      if (!t.startsWith("/")) return "Host path must be absolute (start with /).";
      return null;
    },
  });
  if (!hostPath) return; // user cancelled
  const host = hostPath.trim();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Xpair: mounting ${host}…`, cancellable: false },
    async () => {
      // Step 2: mount.
      const mres = await runXpairCli(["mount", "mount", host], { timeoutMs: 180000 });
      if (mres.code !== 0) {
        log(`addRoot: mount failed (code ${mres.code}): ${mres.stderr || mres.stdout}`);
        const detail = (mres.stderr || mres.stdout || "").trim().split(/\r?\n/).slice(-3).join(" ");
        vscode.window.showErrorMessage(`Xpair: 'xpair mount mount ${host}' failed. ${detail}`);
        return;
      }

      // Step 3: parse the "Mountpoint: <path>" line (printed to stdout by xpair-mount).
      let mountpoint = "";
      for (const line of mres.stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*Mountpoint:\s*(\S.*?)\s*$/);
        if (m) { mountpoint = m[1]; break; }
      }
      if (!mountpoint) {
        log(`addRoot: could not parse mountpoint from mount output: ${mres.stdout}`);
        vscode.window.showErrorMessage("Xpair: mount succeeded but the mountpoint could not be determined.");
        return;
      }
      log(`addRoot: mounted ${host} at ${mountpoint}`);

      // Step 3b: register the FOLDER_MAP (clientDir=mountpoint :: hostDir=host). 'already mapped'
      // is a benign success (the map exists / is covered) — code 0 in that case.
      const ares = await runXpairCli(["map", "add", mountpoint, host], { timeoutMs: 30000 });
      if (ares.code !== 0) {
        log(`addRoot: map add failed (code ${ares.code}): ${ares.stderr || ares.stdout}`);
        vscode.window.showErrorMessage(`Xpair: mounted at ${mountpoint} but registering the folder map failed.`);
        return;
      }

      // Step 4: reconcile roots so the new mountpoint becomes a Browser root immediately.
      reconcileBrowserRoots();
      try {
        await vscode.commands.executeCommand("workbench.view.explorer");
      } catch (_e) {}
      vscode.window.showInformationMessage(`Xpair: added mapping ${mountpoint} -> ${host}.`);
    }
  );
}

// --- show logs (US-006) ----------------------------------------------------

/**
 * Xpair: Show Logs. Reveal the logs dir in the OS file manager, and offer to
 * run `xpair logs --collect` (tar/gzip $LOG_DIR for a bug report) in a terminal.
 */
async function showLogs() {
  // Ensure the dir exists so reveal doesn't fail on a never-logged client.
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  } catch (e) {
    log(`showLogs: mkdir failed: ${e && e.message ? e.message : e}`, "warn");
  }
  const dirUri = vscode.Uri.file(LOG_DIR);
  // Reveal the logs dir in the OS file manager (Finder). revealFileInOS opens the
  // enclosing folder with the target selected; passing the dir reveals its contents.
  try {
    await vscode.commands.executeCommand("revealFileInOS", dirUri);
  } catch (e) {
    log(`showLogs: revealFileInOS failed, falling back to openExternal: ${e && e.message ? e.message : e}`, "warn");
    try {
      await vscode.env.openExternal(dirUri);
    } catch (e2) {
      log(`showLogs: openExternal failed: ${e2 && e2.message ? e2.message : e2}`, "error");
    }
  }
  // Offer to collect logs into a shareable tarball for a bug report.
  const COLLECT = "Collect logs (--collect)";
  const picked = await vscode.window.showInformationMessage(
    "Xpair logs are in ~/.xpair/host/logs. Collect them into a tarball for a bug report?",
    COLLECT
  );
  if (picked === COLLECT) {
    try {
      const term = vscode.window.createTerminal("Xpair — Collect Logs");
      term.show(true);
      // Staged with auto-execute: a read-only collect is safe to run on Enter.
      term.sendText("xpair logs --collect", true);
    } catch (e) {
      const detail = redact((e && e.message ? e.message : e) || "unknown error");
      log(`showLogs: collect terminal failed: ${detail}`, "error");
      vscode.window.showErrorMessage(
        `Xpair: failed to open a terminal for log collection. ${detail}`
      );
    }
  }
}

// --- activation -------------------------------------------------------------

// --- re-run setup ----------------------------------------------------------
// Single-app model (spec: single-app onboarding): onboarding is hosted by the IDE MAIN process as a
// pre-workbench window on first run — there is NO separate "Xpair Setup" Electron app to launch
// (that 2nd process is removed). "Re-run setup" therefore makes the NEXT launch onboard again
// (the main-process hook resolves the per-launch onboarding guard) and asks the user to restart,
// instead of spawning a second app/process.
function runSetup() {
  log("runSetup: re-onboarding requested — main process onboards on next launch");
  // A quit+relaunch can't carry an env var (RP_FORCE_ONBOARDING), so persist a one-shot sentinel
  // that onboarding-main.cjs's firstFailingGuard() honors (and clears on next open). Path MUST
  // match FORCE_ONBOARDING_SENTINEL in onboarding-main.cjs.
  try {
    fs.mkdirSync(path.join(os.homedir(), ".xpair/host"), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), ".xpair/host", ".force-onboarding"), "");
  } catch (e) {
    const detail = e && e.message ? e.message : String(e);
    log(`runSetup: could not write force-onboarding sentinel: ${detail}`, "warn");
    vscode.window.showErrorMessage(`Xpair: setup could not be scheduled. ${detail}`);
    return;
  }
  vscode.window
    .showInformationMessage(
      "Xpair setup will run when you restart the app.",
      "Restart now",
    )
    .then((choice) => {
      if (choice === "Restart now") {
        // Relaunch the SAME app (one process); the main-process hook shows onboarding on next start.
        vscode.commands.executeCommand("workbench.action.quit");
      }
    });
}

// Non-destructive re-onboarding. Bound to the bottom-left host status-bar button. Xpair
// sessions PERSIST across restart (detach/reattach), so this is NOT "ending a session" — it drops
// the same one-shot .force-onboarding sentinel runSetup() uses and quits, so the next launch
// re-enters onboarding and the user reattaches right back. No scary "end session" modal: a single
// light positive confirm (the action quits the app, so one click of confirmation is warranted).
function endSessionReonboard() {
  vscode.window
    .showInformationMessage("Set up Xpair again? Your sessions stay attached.", "Set up again")
    .then((choice) => {
      if (choice !== "Set up again") {
        return;
      }
      log("endSessionReonboard: re-onboarding on next launch (sessions persist)");
      try {
        fs.mkdirSync(path.join(os.homedir(), ".xpair/host"), { recursive: true });
        fs.writeFileSync(path.join(os.homedir(), ".xpair/host", ".force-onboarding"), "");
      } catch (e) {
        const detail = e && e.message ? e.message : String(e);
        log(`endSessionReonboard: sentinel write failed: ${detail}`, "warn");
        vscode.window.showErrorMessage(`Xpair: setup could not be scheduled. ${detail}`);
        return;
      }
      vscode.commands.executeCommand("workbench.action.quit");
    });
}

// Register extension-host crash hooks ONCE. The handlers delegate to telemetry.sentryCapture,
// which itself gates on CRASH_REPORT_CONSENT + SENTRY_DSN (so with consent OFF this is inert —
// no DSN read succeeds, no network call). We do NOT swallow the errors: we only observe them,
// preserving the host's existing behavior. unhandledRejection logs but does not exit.
let sentryHooksInstalled = false;
function installSentryHooks() {
  if (sentryHooksInstalled) return;
  sentryHooksInstalled = true;
  try {
    process.on("uncaughtException", (err) => {
      try { telemetry.sentryCapture(err, { kind: "uncaughtException" }); } catch (_e) {}
      log(`uncaughtException: ${err && err.message ? err.message : err}`, "error");
    });
    process.on("unhandledRejection", (reason) => {
      try { telemetry.sentryCapture(reason instanceof Error ? reason : new Error(String(reason)), { kind: "unhandledRejection" }); } catch (_e) {}
      log(`unhandledRejection: ${reason && reason.message ? reason.message : reason}`, "error");
    });
  } catch (e) {
    log(`installSentryHooks: ${e && e.message ? e.message : e}`, "warn");
  }
}

function activate(context) {
  log("Xpair activating…");

  syncTelemetryConsentFromSettings();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("xpair.telemetry.enabled")) {
        syncTelemetryConsentFromSettings();
      }
    })
  );

  // Start the CLIENT→HOST liveness heartbeat (writes now + every 30s; idempotent across
  // activations). Fire-and-forget — must never block or crash activation.
  try { heartbeat.startHeartbeat(); } catch (e) { log(`heartbeat start: ${e && e.message ? e.message : e}`, "warn"); }

  // Xpair: hide the bottom status bar — it is not part of this focused xpair surface.
  // The status bar's visibility is the deprecated `workbench.statusBar.visible` setting, which maps
  // to the layout UI-state (STATUSBAR_HIDDEN); patching the schema default does NOT take effect at
  // runtime in this build, but setting the value explicitly DOES (and reclaims the 22px row, unlike
  // CSS display:none). Idempotent + guarded so the duplicate activate() does not thrash settings.
  try {
    const _cfg = vscode.workspace.getConfiguration();
    if (_cfg.get("workbench.statusBar.visible") !== false) {
      _cfg.update("workbench.statusBar.visible", false, vscode.ConfigurationTarget.Global)
        .then(undefined, (e) => log(`hide status bar: ${e && e.message ? e.message : e}`, "warn"));
    }
  } catch (_e) { /* best-effort */ }

  // 0) Telemetry (opt-in, both consent flags default OFF → zero network calls). Two side effects:
  //    a) app_first_launch{is_fresh_install} — fired ONCE, gated by a globalState stamp.
  //    b) Sentry init for the extension host — a no-op unless CRASH_REPORT_CONSENT + SENTRY_DSN
  //       are both present (init just registers process error hooks that re-check consent on fire).
  try {
    // Stamp the install creation time at FIRST RUN, INDEPENDENT of consent. A bare epoch-ms with
    // no id is not PII, so this is safe pre-consent and gives time_to_wow_ms a real elapsed base
    // (first launch → first session) instead of ~0. Idempotent across activations.
    telemetry.firstRunStamp();
    const FIRST_LAUNCH_KEY = "remotepair.installTimestamp";
    const stampedAt = context.globalState.get(FIRST_LAUNCH_KEY);
    const isFresh = !stampedAt;
    if (isFresh) {
      context.globalState.update(FIRST_LAUNCH_KEY, Date.now());
    }
    // Fire once per install (the stamp guards repeats across activations).
    telemetry.capture(telemetry.EVENTS.APP_FIRST_LAUNCH, { is_fresh_install: isFresh });
  } catch (e) {
    log(`telemetry first-launch: ${e && e.message ? e.message : e}`, "warn");
  }
  // Extension-host crash reporting: forward uncaught errors to Sentry (consent-gated inside).
  // Raw HTTP envelope (no SDK) preserves the zero-dep rule. Registered once.
  installSentryHooks();

  // 1) First-run: ensure the 3 AI extensions (best-effort, swallow errors).
  ensureExtensions(false).catch((e) => log(`ensureExtensions error: ${e}`));

  // 2) Remote Desktop = a pinned editor tab ("RD") in the main editor area
  //    (NOT a left activity-bar view).
  const panel = new RemoteDesktopPanel(context.extensionUri);
  context.subscriptions.push(panel);

  // Auto-open the Remote Desktop on launch so it is the default surface (v2 RD). This regressed
  // when the onboarding / session-picker UX changed the startup view: the panel was created but
  // never revealed, so it only appeared via the command. Restore the launch-time reveal.
  panel.reveal().catch((e) => log(`RD auto-open error: ${e}`));

  // Route VSCode's webview restore (across a window reload) through the singleton so a restored RD
  // reattaches instead of opening a SECOND "RD" tab (fixes the pre-existing "RD opens twice" bug).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("remotepair.remoteDesktop", {
      async deserializeWebviewPanel(restored) {
        panel.restore(restored);
      },
    })
  );

  // 3) Status bar Host button (always visible, high priority = left-most).
  //    Shows the configured host NAME + live reachability status instead of the
  //    generic SSH "$(remote)" glyph: $(vm-active) host when reachable, red
  //    background + $(vm-outline) when down, $(sync~spin) while probing, and a
  //    "Set host" affordance when none is configured. Click still opens the
  //    endpoint quickpick (remotepair.connectHost).
  const hostBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100000000);
  // Click = non-destructive re-onboarding (detach/reattach; sessions persist) — the canonical
  // "set up / switch host" action. The button still DISPLAYS host name + reachability below.
  hostBtn.command = "remotepair.endSessionReonboard";
  context.subscriptions.push(hostBtn);
  // C3(b): a panel-toggle control in the status bar, just left of the notification bell (the bell is
  // RIGHT/NEGATIVE_INFINITY, so any small finite RIGHT priority lands adjacent-left of it). Toggles
  // the bottom Session Manager panel collapsed/expanded.
  const panelToggleBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  panelToggleBtn.text = "$(layout-panel)";
  panelToggleBtn.tooltip = "Xpair: toggle the Session Manager panel";
  panelToggleBtn.command = "workbench.action.togglePanel";
  panelToggleBtn.show();
  context.subscriptions.push(panelToggleBtn);

  let hostReachable = null; // null = unknown/probing, true/false = last probe result
  // Telemetry: classify the real connection path used today (Bonjour LAN discovery does not
  // exist yet, so a `.ts.net` host = tailscale, otherwise the manual/LAN path). Reported as
  // host_connected{path}. NOTE: `lan` here means "not a tailnet name", not Bonjour-discovered.
  const classifyPath = (host) =>
    /\.ts\.net$/i.test(String(host || "")) ? telemetry.PATHS.TAILSCALE : telemetry.PATHS.LAN;
  const renderHostButton = () => {
    const host = getValidHost();
    if (!host) {
      hostBtn.text = "$(gear) Set host";
      hostBtn.tooltip = "Xpair: no host configured — click to set up";
      hostBtn.backgroundColor = undefined;
    } else if (hostReachable === true) {
      hostBtn.text = `$(vm-active) ${host}`;
      hostBtn.tooltip = `Xpair: ${host} — reachable. Click to connect.`;
      hostBtn.backgroundColor = undefined;
    } else if (hostReachable === false) {
      hostBtn.text = `$(vm-outline) ${host}`;
      hostBtn.tooltip = `Xpair: ${host} — unreachable. Click to connect / retry.`;
      hostBtn.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else {
      hostBtn.text = `$(sync~spin) ${host}`;
      hostBtn.tooltip = `Xpair: ${host} — checking reachability…`;
      hostBtn.backgroundColor = undefined;
    }
    hostBtn.show();
  };
  renderHostButton();

  // Reachability probe: BatchMode ssh `true` over the persistent ControlMaster
  // connection (no password prompt; fails fast if unreachable / no agent key).
  // Fires host_connected / host_connect_failed only on a STATE TRANSITION (not every 20s tick).
  const probeHost = async () => {
    const host = getValidHost();
    if (!host) {
      hostReachable = null;
      renderHostButton();
      return;
    }
    const prev = hostReachable;
    const startedAt = Date.now();
    let ok = false;
    let probeReason = telemetry.REASONS.UNKNOWN;
    try {
      const gw = onboardingBridge.gatewayMacStatus();
      if (gw && gw.allowed === false) {
        hostReachable = false;
        renderHostButton();
        if (prev === true) {
          telemetry.capture(telemetry.EVENTS.HOST_CONNECT_FAILED, {
            path: classifyPath(host),
            reason: telemetry.REASONS.HOST_UNREACHABLE,
          });
        }
        log(gatewayMacBlockDetail(gw), "warn");
        return;
      }
    } catch (e) {
      hostReachable = false;
      renderHostButton();
      log(`gateway MAC guard unavailable; auto-connect disabled: ${e && e.message ? e.message : e}`, "warn");
      return;
    }
    try {
      const r = await sshRun(host, "true", { timeoutMs: 6000 });
      ok = r.code === 0;
      if (!ok) probeReason = r.code === -2 ? telemetry.REASONS.TIMEOUT : telemetry.REASONS.HOST_UNREACHABLE;
    } catch (_e) {
      ok = false;
      probeReason = telemetry.REASONS.HOST_UNREACHABLE;
    }
    hostReachable = ok;
    renderHostButton();
    // Edge-trigger telemetry: only on a change to/from reachable (prev !== current).
    // host_connected cardinality = ONCE PER INSTALL (Insight A/B count installs, not IDE
    // restarts): claimHostConnectedOnce() is a shared client.env stamp honored by BOTH this
    // probe and the webview check() emitter, so only the first observed reachability across the
    // whole install emits. host_connect_failed stays edge-triggered (per-failure is intended).
    if (ok && prev !== true) {
      if (telemetry.claimHostConnectedOnce()) {
        telemetry.capture(telemetry.EVENTS.HOST_CONNECTED, {
          path: classifyPath(host),
          connect_ms: Date.now() - startedAt,
        });
      }
    } else if (!ok && prev === true) {
      telemetry.capture(telemetry.EVENTS.HOST_CONNECT_FAILED, {
        path: classifyPath(host),
        reason: telemetry.normalizeReason(probeReason),
      });
    }
  };
  probeHost();
  const hostProbeTimer = setInterval(probeHost, 20000);
  context.subscriptions.push({ dispose: () => clearInterval(hostProbeTimer) });

  // 4) Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("remotepair.openRemoteDesktop", () => panel.reveal()),
    vscode.commands.registerCommand("remotepair.runSetup", () => runSetup()),
    vscode.commands.registerCommand("remotepair.endSessionReonboard", () => endSessionReonboard()),
    vscode.commands.registerCommand("remotepair.connectHost", () => connectHost(panel)),
    // Recovery path for a fail-closed roaming state (blueprint §6.4): when the user moves to another
    // network the stored gateway MAC differs and auto-connect stays blocked. confirmGatewayBaseline()
    // adopts the current network as the new baseline; re-probe so reachability re-enables immediately
    // without editing client.env. This is the ONLY caller of confirmGatewayBaseline().
    vscode.commands.registerCommand("remotepair.confirmGatewayBaseline", async () => {
      const gw = onboardingBridge.confirmGatewayBaseline();
      if (gw && gw.allowed) {
        vscode.window.showInformationMessage(
          `Xpair: adopted the current network as the gateway baseline${gw.current ? ` (${gw.current})` : ""}. Reconnecting…`,
        );
        await probeHost();
      } else {
        vscode.window.showWarningMessage(
          `Xpair: could not confirm the gateway baseline${gw && gw.err ? ` (${gw.err})` : ""}.`,
        );
      }
    }),
    vscode.commands.registerCommand("remotepair.launchRemoteClaude", () => launchRemoteClaude()),
    vscode.commands.registerCommand("remotepair.remoteDesktop.refresh", () => panel.refresh()),
    vscode.commands.registerCommand("remotepair.sessions.listJson", () =>
      listSessionsFromCli(runXpairCli, { log })
    ),
    vscode.commands.registerCommand("remotepair.sessions.checkAttach", (name) =>
      checkSessionAvailableFromCli(runXpairCli, name, { log })
    ),
    vscode.commands.registerCommand("remotepair.ensureExtensions", () => ensureExtensions(true)),
    vscode.commands.registerCommand("remotepair.setupFileAccess", () => setupFileAccess()),
    vscode.commands.registerCommand("remotepair.setupLayout", () => setupLayout(context, true)),
    vscode.commands.registerCommand("remotepair.openFileBrowser", () => {
      // Roots == FOLDER_MAPS clientDirs only (C1.D4): reconcile drops any phantom
      // launch-arg / workspace folder and adds the mapped dirs in declared order.
      const clientDirs = reconcileBrowserRoots();
      if (clientDirs.length === 0) {
        // No mapped roots → reveal the Browser so its empty-state "Add Mapping" button shows.
        log("openFileBrowser: no FOLDER_MAPS client dirs, revealing empty-state");
      } else {
        log(`openFileBrowser: using FOLDER_MAPS clientDirs=${clientDirs.join(", ")}`);
      }
      vscode.commands.executeCommand("workbench.view.explorer").then(
        () => {},
        (e) => log(`openFileBrowser: explorer reveal error: ${e && e.message ? e.message : e}`)
      );
    }),
    vscode.commands.registerCommand("remotepair.browser.addRoot", () =>
      addRoot().catch((e) => {
        log(`addRoot: ${e && e.message ? e.message : e}`);
        vscode.window.showErrorMessage(`Xpair: Add Mapping failed. ${e && e.message ? e.message : e}`);
      })
    ),
    vscode.commands.registerCommand("remotepair.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", XPAIR_SETTINGS_QUERY);
    }),
    vscode.commands.registerCommand("remotepair.showLogs", () =>
      showLogs().catch((e) => {
        log(`showLogs: ${e && e.message ? e.message : e}`, "error");
        vscode.window.showErrorMessage(`Xpair: Show Logs failed. ${e && e.message ? e.message : e}`);
      })
    )
  );

  // C1.D4 — Reconcile Browser roots on activation so a non-mapped launch-arg folder
  // (the phantom `/tmp/rp-test-folder`) is removed even before the user opens the Browser.
  try {
    reconcileBrowserRoots();
  } catch (e) {
    log(`activate: reconcileBrowserRoots failed: ${e && e.message ? e.message : e}`);
  }

  // 4) Host notifications poller.
  const notifier = new NotificationPoller();
  notifier.start();
  context.subscriptions.push({ dispose: () => notifier.stop() });

  // 5a) Warm the Sessions sidebar, THEN default the visible sidebar to the Browser. Constructing the
  //     Sessions view runs its constructor side effects — wiring the session reattacher and the
  //     attached-sessions provider, and scheduling the embedded EditorPart — which the bottom
  //     Detached/History reattach cards and the per-folder "New Session Here" depend on; without this
  //     warm-up a Browser-first launch leaves reattach unwired until the user opens Sessions manually.
  //     We then switch to the Browser: a fresh launch never has attached terminal tabs (they are live
  //     editor instances, not restored), so "no terminal tabs → Browser" holds unconditionally, and
  //     this runs for existing profiles too (unlike the one-time setupLayout gate). Closing the last
  //     terminal tab later returns here via RemotePairEmptySessionsBrowserFallback (workbench source).
  vscode.commands
    .executeCommand("remotepair.terminalSidebar")
    .then(() => vscode.commands.executeCommand("workbench.view.explorer"))
    .then(undefined, (e) => log(`startup Browser default: ${e && e.message ? e.message : e}`, "warn"));

  // 5) Open the RD editor tab on startup (Remote Desktop is this client's
  //    primary surface), then apply the one-time workbench layout. Chained so
  //    the RD pin lands before setupLayout opens the terminal tab.
  panel
    .reveal()
    .then(() => setupLayout(context, false))
    // C3(a): force the bottom Session Manager panel OPEN with the ATTACHED tab on EVERY launch (no
    // persisted collapse memory). The auto-registered view-focus command (id = <attached view id>
    // + '.focus') opens the panel part AND switches to the Attached composite. Runs after
    // setupLayout regardless of its one-time gate, so it re-opens the panel on every activation.
    .then(() =>
      vscode.commands.executeCommand("remotepair.sessions.attached.view.focus", {
        preserveFocus: true,
      }),
    )
    .catch((e) => log(`setupLayout / force-open Sessions panel error: ${e}`));

  log("Xpair activated.");
}

function deactivate() {
  // Stop the heartbeat and best-effort remove the host file so the host expires this client promptly.
  try { heartbeat.stopHeartbeat(); } catch { /* never let teardown throw */ }
}

module.exports = { activate, deactivate, RemoteDesktopPanel };
