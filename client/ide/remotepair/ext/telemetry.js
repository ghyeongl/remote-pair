// telemetry.js — Xpair client telemetry (PostHog activation funnel + Sentry crash reports).
//
// ZERO external npm deps: node stdlib (https/crypto/fs/os/path) only. This module is shared by
// BOTH the VSCodium extension host (extension.js) and the Electron onboarding main process
// (via onboarding-bridge.js → preload → webview). The Electron app additionally uses
// @sentry/electron for renderer/main crash capture; this module is the PostHog transport and
// the extension-host Sentry path (raw HTTP envelope, no SDK, to preserve the zero-dep rule).
//
// HARD PRIVACY (OSS audit): NEVER transmit repo names, file paths, command contents, or IP
// addresses. Every string value is passed through redact() (the existing $HOME→'~',
// REMOTE_HOST→'<host>' masker) before send. `reason` is a controlled enum — never raw stderr.
//
// Consent is OPT-IN: both flags default false. With consent OFF this module performs ZERO
// network calls (the capture()/sentryCapture() entry points return early before any https call).
//
// Spec: .omc/specs/deep-interview-telemetry-funnel.md

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");

// --- paths / keys ----------------------------------------------------------

const RP_CLIENT_DIR = path.join(os.homedir(), ".xpair/client");
const CLIENT_ENV = path.join(RP_CLIENT_DIR, "client.env");
const LEGACY_CLIENT_ENV = path.join(os.homedir(), ".xpair/host/client.env");
const TELEMETRY_ENV = path.join(RP_CLIENT_DIR, "telemetry.env");

// telemetry.env keys (FROZEN — see spec "Telemetry Setup").
const K_ANON_ID = "TELEMETRY_ANON_ID"; // distinct_id = install_id (UUID v4, disk-persisted)
const K_TELEMETRY_CONSENT = "TELEMETRY_CONSENT"; // gates PostHog
const K_CRASH_CONSENT = "CRASH_REPORT_CONSENT"; // gates Sentry
const K_INSTALL_TS = "TELEMETRY_INSTALL_TS"; // install_id creation epoch (ms) → time_to_wow_ms base
const K_POSTHOG_KEY = "POSTHOG_KEY"; // project key (config / build-injected); absent => no-op
const K_POSTHOG_HOST = "POSTHOG_HOST"; // capture endpoint origin; default Cloud EU
const K_SENTRY_DSN = "SENTRY_DSN"; // Sentry DSN; absent => Sentry no-op
// Activation-funnel de-dup stamp. host_connected is INTENDED CARDINALITY = once per install
// (Insight A/B count installs, not IDE restarts). Both the webview check() emitter (via the
// bridge) and extension.js probeHost() emitter honor this shared flag, so a host_connected
// fires at most once for the lifetime of the install regardless of how many times either lane
// observes reachability.
const K_HOST_CONNECTED_STAMP = "TELEMETRY_HOST_CONNECTED_AT"; // epoch ms of first host_connected
const TELEMETRY_KEYS = Object.freeze([
  K_ANON_ID,
  K_TELEMETRY_CONSENT,
  K_CRASH_CONSENT,
  K_INSTALL_TS,
  K_POSTHOG_KEY,
  K_POSTHOG_HOST,
  K_SENTRY_DSN,
  K_HOST_CONNECTED_STAMP,
]);
const TELEMETRY_KEY_SET = new Set(TELEMETRY_KEYS);

// Cloud EU default (endpoint-agnostic: swappable to self-host via POSTHOG_HOST in telemetry.env).
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";
const CAPTURE_PATH = "/capture/";

// app_version — read from the extension's package.json when available (best-effort).
let APP_VERSION = "0";
try {
  APP_VERSION = require("./package.json").version || "0";
} catch (_e) {
  /* leave default */
}

// --- frozen catalog --------------------------------------------------------

// Phase-1 events — THE ONLY events that may be emitted now.
const EVENTS = Object.freeze({
  APP_FIRST_LAUNCH: "app_first_launch",
  ONBOARDING_STARTED: "onboarding_started",
  SSH_CONFIG_COMPLETED: "ssh_config_completed",
  SSH_CONFIG_FAILED: "ssh_config_failed",
  HOST_CONNECTED: "host_connected",
  HOST_CONNECT_FAILED: "host_connect_failed",
  FIRST_SESSION_STARTED: "first_session_started",
});

// Phase-2 events — RESERVED names only. Defined so nothing gets renamed between phases.
// These MUST NOT be emitted in Phase 1; capture() rejects any event not in EVENTS.
const RESERVED_PHASE2_EVENTS = Object.freeze([
  "host_discovery_started",
  "host_discovered",
  "host_discovery_empty",
  "tailscale_fallback_started",
  "tailscale_auth_completed",
  "tailscale_host_reachable",
  "hosted_cta_shown",
  "hosted_waitlist_submitted",
]);

const PHASE1_EVENT_SET = new Set(Object.values(EVENTS));

// `reason` is a CONTROLLED ENUM ONLY (never raw stderr — it leaks hostnames/IPs/paths).
const REASONS = Object.freeze({
  TIMEOUT: "timeout",
  AUTH_DENIED: "auth_denied",
  HOST_UNREACHABLE: "host_unreachable",
  DNS_FAILED: "dns_failed",
  KEYGEN_ERROR: "keygen_error",
  PERMISSION_DENIED: "permission_denied",
  UNKNOWN: "unknown",
});
const REASON_SET = new Set(Object.values(REASONS));

// `path` for host_connected/host_connect_failed.
const PATHS = Object.freeze({ LAN: "lan", TAILSCALE: "tailscale" });
const PATH_SET = new Set(Object.values(PATHS));

// --- env file I/O ----------------------------------------------------------

/** Parse KEY=VALUE env files into a flat object. Never throws. */
function readEnvFile(file) {
  const env = {};
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (_e) {
    return env;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function stripTelemetryKeysFromEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (_e) {
    return;
  }
  const kept = [];
  let changed = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const eq = t.indexOf("=");
    const key = eq >= 0 ? t.slice(0, eq).trim() : "";
    if (key && TELEMETRY_KEY_SET.has(key)) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  if (!changed) return;
  try {
    fs.writeFileSync(file, kept.join("\n").replace(/\n+$/, "\n"));
  } catch (_e) {
    /* best effort */
  }
}

let legacyTelemetryMigrationAttempted = false;
function migrateLegacyTelemetryEnv(currentEnv) {
  const additions = {};
  for (const file of [CLIENT_ENV, LEGACY_CLIENT_ENV]) {
    const legacy = readEnvFile(file);
    for (const key of TELEMETRY_KEYS) {
      if (currentEnv[key] === undefined && additions[key] === undefined && legacy[key] !== undefined) {
        additions[key] = legacy[key];
      }
    }
    stripTelemetryKeysFromEnvFile(file);
  }
  const entries = Object.entries(additions);
  if (!entries.length) return;
  let lines = [];
  try {
    lines = fs.readFileSync(TELEMETRY_ENV, "utf8").split("\n");
  } catch (_e) {
    /* file may not exist yet */
  }
  for (const [key, val] of entries) {
    lines.push(`${key}="${val}"`);
  }
  try {
    fs.mkdirSync(RP_CLIENT_DIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(RP_CLIENT_DIR, 0o700);
    } catch (_e) {}
    fs.writeFileSync(TELEMETRY_ENV, lines.join("\n").replace(/\n+$/, "\n"));
  } catch (_e) {
    /* best effort */
  }
}

/** Parse telemetry.env (KEY=VALUE, optional quotes) into a flat object. Never throws. */
function readEnv() {
  let env = readEnvFile(TELEMETRY_ENV);
  if (!legacyTelemetryMigrationAttempted && TELEMETRY_KEYS.some((key) => env[key] === undefined)) {
    legacyTelemetryMigrationAttempted = true;
    migrateLegacyTelemetryEnv(env);
    env = readEnvFile(TELEMETRY_ENV);
  }
  return env;
}

/** Upsert KEY="value" in telemetry.env (creates the file/dir if missing). Never throws. */
function upsertEnv(key, val) {
  let lines = [];
  try {
    lines = fs.readFileSync(TELEMETRY_ENV, "utf8").split("\n");
  } catch (_e) {
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
    fs.mkdirSync(RP_CLIENT_DIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(RP_CLIENT_DIR, 0o700);
    } catch (_e) {}
    fs.writeFileSync(TELEMETRY_ENV, lines.join("\n").replace(/\n+$/, "\n"));
  } catch (_e) {
    /* best effort */
  }
}

// --- redaction -------------------------------------------------------------

// Default redactor: $HOME→'~', REMOTE_HOST→'<host>'. extension.js passes its own redact()
// in (same semantics); the Electron lane has no vscode redact() so it uses this fallback.
function defaultRedact(msg) {
  let s = String(msg);
  try {
    const home = os.homedir();
    if (home && home.length > 1) s = s.split(home).join("~");
    const clientEnvFile = fs.existsSync(CLIENT_ENV) ? CLIENT_ENV : LEGACY_CLIENT_ENV;
    const host = (readEnvFile(clientEnvFile).REMOTE_HOST || "").trim();
    if (host && host.length > 1) s = s.split(host).join("<host>");
  } catch (_e) {
    /* fall through with whatever masking succeeded */
  }
  return s;
}

let _redact = defaultRedact;
/** Install the host runtime's existing redactor (extension.js redact()). */
function setRedactor(fn) {
  if (typeof fn === "function") _redact = fn;
}

/** Recursively redact every string in a JSON-able value (defense in depth). */
function redactDeep(v) {
  if (typeof v === "string") return _redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = redactDeep(v[k]);
    return out;
  }
  return v;
}

// --- strict OUTBOUND scrubber (Sentry crash payloads) ----------------------
//
// DESIGN RULE: the local-log redact()/logRedact() ($HOME→'~', REMOTE_HOST→'<host>') is
// DELIBERATELY narrow — local logs keep full paths/IPs for debugging. This scrubber is a
// SEPARATE, STRICTER pass for anything that LEAVES the machine (Sentry panic messages,
// backtrace frames, JS Error stacks). It COMPOSES the existing redactor (so $HOME/REMOTE_HOST
// still collapse) and then masks the residue an OSS privacy audit flagged:
//   - IPv4 / IPv6 literals                         → <ip>
//   - *.ts.net tailnet hostnames                   → <host>
//   - absolute paths (other users, system temp,
//     and generic /<seg>/<seg>/.. abs paths)       → <path>
// Never used on local logs; never used to broaden redact().

// IPv4 (with optional :port) — bounded octets to avoid eating version strings like 1.2.3.4500.
const RE_IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b(?::\d{1,5})?/g;
// IPv6 — full/compressed forms (incl. :: and embedded IPv4). Requires >=2 colon groups so a
// bare "a:b" word does not match.
const RE_IPV6 =
  /\b(?:[0-9a-fA-F]{1,4}:){2,7}(?:[0-9a-fA-F]{1,4}|:)(?::[0-9a-fA-F]{1,4})*\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4})?\b|::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\b|\bfe80::[0-9a-fA-F:]+\b/g;
// *.ts.net tailnet names (e.g. host-7.ts.net, my-mac.tailnet.ts.net).
const RE_TSNET = /\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.ts\.net\b/g;
// Absolute paths: /Users/<name>, /home/<name>, /private/var/folders/.., /var/folders/..,
// /tmp/.., and a generic catch-all for any /<seg>/<seg>/.. POSIX absolute path with >=2
// segments (covers other-user dirs and arbitrary system paths a backtrace frame carries).
const RE_PATH =
  /\/(?:Users|home)\/[^/\s:]+(?:\/[^\s:)'"]*)?|\/private\/var\/folders\/[^\s:)'"]*|\/var\/folders\/[^\s:)'"]*|\/tmp\/[^\s:)'"]*|\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[^\s:)'"]*)?/g;

/** Strict outbound text scrub: redactor + IP/path/tailnet masking. Never throws. */
function strictScrub(msg) {
  let s = String(msg == null ? "" : msg);
  try {
    s = _redact(s);
  } catch (_e) {
    /* fall through with the raw string if the injected redactor misbehaves */
  }
  // Order matters: tailnet hostnames before the generic path rule (so we don't also mangle
  // the part of a URL path), IPs before paths (so an IP literal isn't swallowed by /seg/seg).
  s = s.replace(RE_TSNET, "<host>");
  s = s.replace(RE_IPV6, "<ip>");
  s = s.replace(RE_IPV4, "<ip>");
  s = s.replace(RE_PATH, "<path>");
  return s;
}

/** Recursively apply the strict outbound scrubber to every string in a JSON-able value. */
function strictScrubDeep(v) {
  if (typeof v === "string") return strictScrub(v);
  if (Array.isArray(v)) return v.map(strictScrubDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = strictScrubDeep(v[k]);
    return out;
  }
  return v;
}

// --- install_id / consent --------------------------------------------------

/** Anonymous install_id (UUID v4), generated once on first run and disk-persisted. */
function installId() {
  const env = readEnv();
  let id = (env[K_ANON_ID] || "").trim();
  if (id) return id;
  id = crypto.randomUUID();
  upsertEnv(K_ANON_ID, id);
  return id;
}

/**
 * Stamp the install creation time at FIRST RUN, INDEPENDENT of consent.
 * A bare epoch-ms with no id is not PII, so this is safe to write before the consent prompt —
 * it gives time_to_wow_ms a real elapsed base (first launch → first session) instead of ~0
 * (which is what happens if the base is only set lazily at the moment the WOW event fires).
 * Idempotent: only the first call writes and returns created=true; later calls are a no-op.
 * Never throws.
 * Call this on the very first run of BOTH the extension host and the Electron onboarding.
 */
function firstRunStamp() {
  try {
    const existing = installTs();
    if (existing) return { ts: existing, created: false };
    const now = Date.now();
    upsertEnv(K_INSTALL_TS, String(now));
    const stamped = installTs();
    return { ts: stamped, created: stamped === now };
  } catch (_e) {
    /* telemetry must never break the app */
  }
  return { ts: installTs(), created: false };
}

/** install_id creation epoch (ms). 0 if unknown (caller treats as "no wow timing"). */
function installTs() {
  const v = parseInt((readEnv()[K_INSTALL_TS] || "").trim(), 10);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Claim the once-per-install host_connected slot. Returns true exactly ONCE for the lifetime
 * of an install; every later call (any lane, any IDE restart) returns false. This caps the
 * activation-funnel cardinality of host_connected to per-install (NOT per-restart) so PostHog
 * Insight A/B count installs. Shared by extension.js probeHost() and the webview check() emitter
 * (via onboarding-bridge.js). Best-effort + race-tolerant: a rare double-write loses a stamp,
 * never the gate; never throws.
 */
function claimHostConnectedOnce() {
  try {
    if (readEnv()[K_HOST_CONNECTED_STAMP]) return false; // already counted this install.
    upsertEnv(K_HOST_CONNECTED_STAMP, String(Date.now()));
    return true;
  } catch (_e) {
    return false; // on any I/O failure, prefer NOT emitting (de-dup is the priority).
  }
}

function envTrue(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** PostHog gate. */
function telemetryConsent() {
  return envTrue(readEnv()[K_TELEMETRY_CONSENT]);
}
/** Sentry gate. */
function crashReportConsent() {
  return envTrue(readEnv()[K_CRASH_CONSENT]);
}

/** Sentry config for SDK-based runtimes (Electron @sentry/electron). null DSN => do not init. */
function sentryConfig() {
  const env = readEnv();
  return {
    dsn: (env[K_SENTRY_DSN] || process.env.RP_SENTRY_DSN || "").trim() || null,
    release: APP_VERSION,
    consent: crashReportConsent(),
  };
}

/** Read both consent flags (for the consent UI). */
function getConsent() {
  const env = readEnv();
  return {
    telemetry: envTrue(env[K_TELEMETRY_CONSENT]),
    crashReport: envTrue(env[K_CRASH_CONSENT]),
  };
}

/** Persist both consent flags (re-toggleable). Booleans → "true"/"false". */
function setConsent(telemetry, crashReport) {
  upsertEnv(K_TELEMETRY_CONSENT, telemetry ? "true" : "false");
  upsertEnv(K_CRASH_CONSENT, crashReport ? "true" : "false");
  return getConsent();
}

function setTelemetryConsent(enabled) {
  upsertEnv(K_TELEMETRY_CONSENT, enabled ? "true" : "false");
  return telemetryConsent();
}

// --- super properties ------------------------------------------------------

function osVersion() {
  // os.release() is a kernel string (e.g. 24.5.0 on macOS) — coarse, no PII.
  return `${process.platform} ${os.release()}`;
}

function superProps() {
  return {
    app_version: APP_VERSION,
    os_version: osVersion(),
    device_arch: process.arch,
    install_id: installId(),
    telemetry_consent: telemetryConsent(),
  };
}

// --- PostHog capture -------------------------------------------------------

/**
 * Fire a Phase-1 PostHog event. Fire-and-forget; NEVER throws; NEVER blocks.
 * Performs ZERO network I/O when: telemetry consent is OFF, or no key/endpoint configured,
 * or the event is not a Phase-1 event. All property values are redacted before send.
 *
 * @param {string} event one of EVENTS (Phase-1 only)
 * @param {object} [props] event-specific properties (already-validated enums for reason/path)
 */
function capture(event, props = {}) {
  try {
    if (!telemetryConsent()) return; // OPT-IN gate: zero network calls when OFF.
    if (!PHASE1_EVENT_SET.has(event)) return; // Phase-2 names are reserved, not emitted.

    const env = readEnv();
    const key = (env[K_POSTHOG_KEY] || process.env.RP_POSTHOG_KEY || "").trim();
    if (!key) return; // no key provisioned => silent no-op.
    const host = (env[K_POSTHOG_HOST] || DEFAULT_POSTHOG_HOST).trim();

    const properties = redactDeep({ ...superProps(), ...(props || {}) });
    const body = JSON.stringify({
      api_key: key,
      event,
      distinct_id: installId(),
      properties,
      timestamp: new Date().toISOString(),
    });
    postJson(host, CAPTURE_PATH, body);
  } catch (_e) {
    /* telemetry must never break the app */
  }
}

// --- Sentry (extension host: raw HTTP envelope, zero-dep) -------------------

/**
 * Capture an error to Sentry via a raw HTTP envelope (no SDK → preserves zero-dep).
 * Gated on crash_report_consent; no DSN => no-op. sendDefaultPii is implicitly false
 * (we attach no user/server_name); the message + stack are scrubbed via the redactor.
 *
 * Rationale (spec line 99 decision): the extension host bans external npm deps, so a
 * raw envelope POST is the lower-risk option vs. dynamic-require of @sentry/node (which
 * would need the package present in the IDE's node_modules — it is not). The envelope
 * format is stable Sentry ingest API and needs only stdlib https.
 *
 * @param {Error|string} err
 * @param {object} [extra] additional context (redacted)
 */
function sentryCapture(err, extra = {}) {
  try {
    if (!crashReportConsent()) return; // OPT-IN gate: zero network calls when OFF.
    const dsn = (readEnv()[K_SENTRY_DSN] || process.env.RP_SENTRY_DSN || "").trim();
    if (!dsn) return; // no DSN => do not send.

    const parsed = parseDsn(dsn);
    if (!parsed) return;

    // STRICT outbound scrub (not the narrow local redactor): masks $HOME/REMOTE_HOST AND
    // IPv4/IPv6, *.ts.net, and absolute paths — a crash message/stack can carry any of these.
    const message = strictScrub(err && err.message ? err.message : String(err));
    // Do NOT ship the full raw stack. Extract STRUCTURED frames (function names only, no file
    // paths) so a backtrace can never leak /Users/<name>/.. or system temp paths. Each function
    // token is still strict-scrubbed defensively.
    const frames = err && err.stack ? structuredFrames(String(err.stack)) : [];
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const sentAt = new Date().toISOString();

    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      release: APP_VERSION,
      // server_name disabled (PII): omitted entirely.
      tags: { component: "ide-ext", rp_session: process.env.RP_SESSION || "-" },
      exception: {
        values: [
          {
            type: (err && err.name) || "Error",
            value: message,
            ...(frames.length ? { stacktrace: { frames } } : {}),
          },
        ],
      },
      // extra is strict-scrubbed (no raw stack key — frames above carry function names only).
      extra: strictScrubDeep({ ...(extra || {}) }),
    };

    // Envelope = headers line + item header line + item payload line (newline-delimited).
    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: sentAt, dsn }) +
      "\n" +
      JSON.stringify({ type: "event" }) +
      "\n" +
      JSON.stringify(event) +
      "\n";

    const auth =
      `Sentry sentry_version=7, sentry_client=remotepair-ext/${APP_VERSION}, ` +
      `sentry_key=${parsed.publicKey}`;
    postRaw(parsed.envelopeUrl, envelope, {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth": auth,
    });
  } catch (_e) {
    /* never break the app */
  }
}

/**
 * Extract path-free structured frames from a V8 Error.stack. We keep ONLY the function name
 * (the "    at <fn> (<loc>)" token) and DROP the location entirely (file path + line:col) —
 * the path is exactly the thing that leaks /Users/<name>/.. or temp dirs. Function names are
 * still run through strictScrub() as defense in depth. Returns Sentry-frame objects.
 */
function structuredFrames(stack) {
  const frames = [];
  for (const line of String(stack).split(/\r?\n/)) {
    const m = line.match(/^\s*at\s+(.+?)\s*(?:\(.*\))?\s*$/);
    if (!m) continue;
    let fn = m[1].trim();
    // If the only token was a bare location (anonymous frame), there's no safe function name.
    if (!fn || fn.startsWith("/") || /^[A-Za-z]:\\/.test(fn)) continue;
    fn = strictScrub(fn);
    frames.push({ function: fn });
  }
  return frames;
}

/** Parse a Sentry DSN into { publicKey, envelopeUrl }. null on malformed DSN. */
function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\//, "");
    if (!publicKey || !projectId) return null;
    const envelopeUrl = `${u.protocol}//${u.host}/api/${projectId}/envelope/`;
    return { publicKey, envelopeUrl };
  } catch (_e) {
    return null;
  }
}

// --- transport (fire-and-forget) -------------------------------------------

/** POST a JSON body to host+path. Fire-and-forget; swallows all errors. */
function postJson(hostOrigin, pathName, body) {
  let url;
  try {
    url = new URL(pathName, hostOrigin);
  } catch (_e) {
    return;
  }
  postRaw(url.toString(), body, { "Content-Type": "application/json" });
}

/** POST a raw body to an absolute URL with the given headers. Fire-and-forget. */
function postRaw(absUrl, body, headers) {
  let url;
  try {
    url = new URL(absUrl);
  } catch (_e) {
    return;
  }
  const lib = url.protocol === "http:" ? http : https;
  const opts = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || (url.protocol === "http:" ? 80 : 443),
    path: url.pathname + url.search,
    headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
    timeout: 5000,
  };
  try {
    const req = lib.request(opts, (res) => {
      // Drain so the socket can be reused / closed; we don't care about the body.
      res.on("data", () => {});
      res.on("end", () => {});
    });
    req.on("error", () => {}); // network failure must be silent (offline, blocked, etc.)
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch (_e) {}
    });
    req.write(body);
    req.end();
  } catch (_e) {
    /* swallow */
  }
}

// --- reason / path normalization (defense: callers should pass enums already) ----

/** Coerce an arbitrary value to a valid `reason` enum; unknowns map to UNKNOWN. */
function normalizeReason(r) {
  return REASON_SET.has(r) ? r : REASONS.UNKNOWN;
}
/** Coerce an arbitrary value to a valid `path` enum; unknowns map to TAILSCALE (today's real path). */
function normalizePath(p) {
  return PATH_SET.has(p) ? p : PATHS.TAILSCALE;
}

module.exports = {
  EVENTS,
  REASONS,
  PATHS,
  RESERVED_PHASE2_EVENTS,
  capture,
  sentryCapture,
  setRedactor,
  redact: defaultRedact, // narrow local masker ($HOME→'~' / REMOTE_HOST→'<host>') — NOT for outbound.
  strictScrub, // strict OUTBOUND scrubber: redactor + IPv4/IPv6 + abs-path + *.ts.net (Sentry payloads).
  strictScrubDeep, // recursive strictScrub for a whole event tree (Electron beforeSend).
  installId,
  installTs,
  firstRunStamp, // stamp install creation time at first run, INDEPENDENT of consent (time_to_wow base).
  claimHostConnectedOnce, // once-per-install host_connected gate (activation-funnel cardinality).
  getConsent,
  setConsent,
  setTelemetryConsent,
  telemetryConsent,
  crashReportConsent,
  sentryConfig,
  superProps,
  normalizeReason,
  normalizePath,
};
