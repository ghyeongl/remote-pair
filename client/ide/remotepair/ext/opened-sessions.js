const fs = require("fs");
const path = require("path");

const OPENED_SESSIONS_VERSION = 2;
const OPENED_SESSIONS_LEGACY_VERSION = 1;
const OPENED_SESSIONS_BUCKET_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OPENED_SESSIONS_LOCK_FILE = "opened-sessions.lock";
const SESSION_NAME_RE = /^[A-Za-z0-9_.-]+$/;

function normalizeOpenedSessionNames(names) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!SESSION_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function cleanHost(host) {
  const value = typeof host === "string" ? host.trim() : "";
  return value || null;
}

function cleanScopeId(scopeId) {
  const value = typeof scopeId === "string" ? scopeId.trim() : "";
  return SESSION_NAME_RE.test(value) ? value : null;
}

function nowFromOpts(opts) {
  return Number.isFinite(opts.now) ? opts.now : Date.now();
}

function pidFromOpts(opts) {
  return Number.isInteger(opts.pid) && opts.pid > 0 ? opts.pid : process.pid;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function serializeOpenedSessions(host, scopeId, names, opts = {}) {
  const clean = cleanHost(host);
  const scope = cleanScopeId(scopeId);
  if (!clean || !scope) return null;
  const now = nowFromOpts(opts);
  return {
    v: OPENED_SESSIONS_VERSION,
    host: clean,
    windows: {
      [scope]: {
        sessions: normalizeOpenedSessionNames(names),
        ts: now,
        pid: pidFromOpts(opts),
      },
    },
  };
}

function normalizeBucket(bucket, now, pruneOld) {
  if (!isRecord(bucket)) return null;
  const ts = Number.isFinite(bucket.ts) ? bucket.ts : now;
  if (pruneOld && ts < now - OPENED_SESSIONS_BUCKET_TTL_MS) return null;
  const pid = Number.isInteger(bucket.pid) && bucket.pid > 0 ? bucket.pid : 0;
  return {
    sessions: normalizeOpenedSessionNames(bucket.sessions),
    ts,
    pid,
  };
}

function normalizedWindows(windows, now, pruneOld) {
  const out = {};
  if (!isRecord(windows)) return out;
  for (const [rawScope, bucket] of Object.entries(windows)) {
    const scope = cleanScopeId(rawScope);
    if (!scope) continue;
    const normalized = normalizeBucket(bucket, now, pruneOld);
    if (!normalized) continue;
    out[scope] = normalized;
  }
  return out;
}

function unionWindowSessions(windows) {
  const out = [];
  const seen = new Set();
  if (!isRecord(windows)) return out;
  for (const [scope, bucket] of Object.entries(windows)) {
    if (!cleanScopeId(scope)) continue;
    if (!isRecord(bucket)) continue;
    for (const name of normalizeOpenedSessionNames(bucket.sessions)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function parseOpenedSessions(raw, currentHost) {
  const clean = cleanHost(currentHost);
  if (!clean || typeof raw !== "string" || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return [];
  }
  if (!isRecord(parsed) || parsed.host !== clean) return [];
  if (parsed.v === OPENED_SESSIONS_VERSION) {
    return unionWindowSessions(parsed.windows);
  }
  if (parsed.v === OPENED_SESSIONS_LEGACY_VERSION) {
    return normalizeOpenedSessionNames(parsed.sessions);
  }
  return [];
}

function readOpenedSessions(filePath, currentHost, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e && e.code !== "ENOENT" && typeof opts.log === "function") {
      opts.log(`opened sessions: read failed: ${e.message || e}`, "debug");
    }
    return [];
  }
  const sessions = parseOpenedSessions(raw, currentHost);
  if (sessions.length === 0 && typeof opts.log === "function") {
    opts.log("opened sessions: no usable snapshot", "debug");
  }
  return sessions;
}

function readSnapshotForWrite(filePath, currentHost, now) {
  const clean = cleanHost(currentHost);
  const empty = { v: OPENED_SESSIONS_VERSION, host: clean, windows: {} };
  if (!clean) return null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (_e) {
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return empty;
  }
  if (!isRecord(parsed) || parsed.host !== clean) return empty;
  if (parsed.v !== OPENED_SESSIONS_VERSION) return empty;
  return {
    v: OPENED_SESSIONS_VERSION,
    host: clean,
    windows: normalizedWindows(parsed.windows, now, true),
  };
}

function writeSnapshotAtomic(filePath, snapshot) {
  if (!snapshot || typeof snapshot.host !== "string" || !isRecord(snapshot.windows)) {
    return false;
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_e) {}
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(snapshot) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return true;
}

function lockPidAlive(pid, opts) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (typeof opts.isProcessAlive === "function") return !!opts.isProcessAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

function readLockPid(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, "utf8").trim();
    const m = raw.match(/^\d+/);
    if (!m) return 0;
    const pid = parseInt(m[0], 10);
    return Number.isFinite(pid) ? pid : 0;
  } catch (_e) {
    return 0;
  }
}

function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
  } catch (_e) {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function claimOpenedSessionsLock(lockFile, opts = {}) {
  const pid = pidFromOpts(opts);
  const deadline = Date.now() + (Number.isFinite(opts.lockWaitMs) ? opts.lockWaitMs : 1000);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(lockFile), 0o700); } catch (_e) {}
  while (true) {
    let fd;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, `${pid}\n`);
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_closeErr) {}
      }
      if (!e || e.code !== "EEXIST") throw e;
      const owner = readLockPid(lockFile);
      if (!owner || !lockPidAlive(owner, opts)) {
        try {
          fs.unlinkSync(lockFile);
          continue;
        } catch (unlinkErr) {
          if (!unlinkErr || unlinkErr.code !== "ENOENT") throw unlinkErr;
          continue;
        }
      }
      if (Date.now() >= deadline) return false;
      sleepSync(25);
    }
  }
}

function releaseOpenedSessionsLock(lockFile, opts = {}) {
  const pid = pidFromOpts(opts);
  if (readLockPid(lockFile) !== pid) return;
  try { fs.unlinkSync(lockFile); } catch (_e) {}
}

function writeOpenedSessionsForScope(filePath, host, scopeId, names, opts = {}) {
  const clean = cleanHost(host);
  const scope = cleanScopeId(scopeId);
  if (!clean || !scope) return false;
  const dir = path.dirname(filePath);
  const lockFile = path.join(dir, OPENED_SESSIONS_LOCK_FILE);
  if (!claimOpenedSessionsLock(lockFile, opts)) return false;
  try {
    const now = nowFromOpts(opts);
    const snapshot = readSnapshotForWrite(filePath, clean, now);
    if (!snapshot) return false;
    snapshot.windows[scope] = {
      sessions: normalizeOpenedSessionNames(names),
      ts: now,
      pid: pidFromOpts(opts),
    };
    return writeSnapshotAtomic(filePath, snapshot);
  } finally {
    releaseOpenedSessionsLock(lockFile, opts);
  }
}

module.exports = {
  OPENED_SESSIONS_VERSION,
  OPENED_SESSIONS_BUCKET_TTL_MS,
  OPENED_SESSIONS_LOCK_FILE,
  SESSION_NAME_RE,
  normalizeOpenedSessionNames,
  serializeOpenedSessions,
  parseOpenedSessions,
  readOpenedSessions,
  writeOpenedSessionsForScope,
};
