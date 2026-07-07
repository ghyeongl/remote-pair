const SESSION_NAME_RE = /^[A-Za-z0-9_.-]+$/;

function normalizeAttached(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function normalizeSessionList(doc) {
  const rawSessions = doc && Array.isArray(doc.sessions) ? doc.sessions : [];
  const sessions = [];
  for (const raw of rawSessions) {
    if (!raw || typeof raw.name !== "string") continue;
    const name = raw.name.trim();
    if (!SESSION_NAME_RE.test(name)) continue;
    sessions.push({ name, attached: normalizeAttached(raw.attached) });
  }
  return { sessions };
}

function unavailableSessionList() {
  return { sessions: [], unavailable: true };
}

function sessionUnavailableCause(name) {
  return `Session "${name}" no longer exists. The list was refreshed; choose another session or start a new one.`;
}

function sessionListUnavailableCause() {
  return "Session list unavailable. Check the host connection, then retry.";
}

async function listSessionsFromCli(runXpairCli, opts = {}) {
  const timeoutMs = opts.timeoutMs || 5000;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  let result;
  try {
    result = await runXpairCli(["ls", "--json"], { timeoutMs });
  } catch (e) {
    log(`session list: xpair ls --json threw: ${e && e.message ? e.message : e}`, "warn");
    return unavailableSessionList();
  }
  if (!result || result.code !== 0) {
    const code = result && typeof result.code !== "undefined" ? result.code : "unknown";
    const detail = result && (result.stderr || result.stdout) ? String(result.stderr || result.stdout).trim() : "";
    log(`session list: xpair ls --json failed code=${code}${detail ? `: ${detail}` : ""}`, "warn");
    return unavailableSessionList();
  }
  try {
    return normalizeSessionList(JSON.parse(result.stdout || ""));
  } catch (e) {
    log(`session list: invalid xpair ls --json output: ${e && e.message ? e.message : e}`, "warn");
    return unavailableSessionList();
  }
}

async function checkSessionAvailableFromCli(runXpairCli, name, opts = {}) {
  const sessionName = typeof name === "string" ? name.trim() : "";
  if (!SESSION_NAME_RE.test(sessionName)) {
    return {
      ok: false,
      stale: true,
      sessions: [],
      cause: "Session name is invalid. The list was refreshed; choose another session or start a new one.",
    };
  }

  const list = await listSessionsFromCli(runXpairCli, opts);
  if (list.unavailable) {
    return { ...list, ok: false, cause: sessionListUnavailableCause() };
  }

  const session = list.sessions.find((entry) => entry.name === sessionName);
  if (!session) {
    return { ...list, ok: false, stale: true, cause: sessionUnavailableCause(sessionName) };
  }

  return { ...list, ok: true, session };
}

module.exports = { SESSION_NAME_RE, normalizeSessionList, listSessionsFromCli, checkSessionAvailableFromCli };
