const fs = require("fs");
const path = require("path");

const OPENED_SESSIONS_VERSION = 1;
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

function serializeOpenedSessions(host, names) {
  const cleanHost = typeof host === "string" ? host.trim() : "";
  if (!cleanHost) return null;
  return {
    v: OPENED_SESSIONS_VERSION,
    host: cleanHost,
    sessions: normalizeOpenedSessionNames(names),
  };
}

function parseOpenedSessions(raw, currentHost) {
  const cleanHost = typeof currentHost === "string" ? currentHost.trim() : "";
  if (!cleanHost || typeof raw !== "string" || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  if (parsed.v !== OPENED_SESSIONS_VERSION) return [];
  if (parsed.host !== cleanHost) return [];
  return normalizeOpenedSessionNames(parsed.sessions);
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

function writeOpenedSessionsAtomic(filePath, snapshot) {
  if (!snapshot || typeof snapshot.host !== "string" || !Array.isArray(snapshot.sessions)) {
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

module.exports = {
  OPENED_SESSIONS_VERSION,
  SESSION_NAME_RE,
  normalizeOpenedSessionNames,
  serializeOpenedSessions,
  parseOpenedSessions,
  readOpenedSessions,
  writeOpenedSessionsAtomic,
};
