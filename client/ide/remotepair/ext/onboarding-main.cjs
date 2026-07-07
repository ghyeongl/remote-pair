// onboarding-main.cjs — single-app onboarding window, hosted by the IDE's MAIN process.
//
// One app, one main process (spec .omc/specs/deep-interview-single-app-onboarding.md): the VSCodium
// electron-main calls resolveOnboarding()/openOnboardingWindow() before the workbench and shows this
// PRE-WORKBENCH BrowserWindow INSTEAD of creating the workbench window; on completion the window
// closes and the caller-provided onComplete() opens the workbench (RD auto-opens there). This
// REPLACES the old standalone client/onboarding 2nd-process Electron wrapper — no second app, no
// app.quit, no IDE re-launch.
//
// Self-contained in the extension dir: the bridge, telemetry, preload, and onboarding-webview dist
// all resolve via __dirname, so the same paths work in the repo and inside the built app bundle.

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

if (!process.env.RP_SSH_CM_TAG) process.env.RP_SSH_CM_TAG = String(process.pid)

const bridge = require('./onboarding-bridge.js')
let telemetry = null
try { telemetry = require('./telemetry.js') } catch { /* telemetry optional */ }
// CLIENT→HOST liveness heartbeat — started here so the onboarding window already counts as a
// connected client. The workbench keeps it going afterwards, so stop is OPTIONAL here.
let heartbeat = null
try { heartbeat = require('./heartbeat.js') } catch { /* heartbeat optional */ }

const WEBVIEW_INDEX = path.join(__dirname, 'onboarding-webview', 'dist', 'index.html')
const PRELOAD = path.join(__dirname, 'onboarding-preload.cjs')
const RP_CLIENT_DIR = path.join(os.homedir(), '.xpair/client')
const RP_HOST_DIR = path.join(os.homedir(), '.xpair/host')
const CLIENT_ENV_FILE = path.join(RP_CLIENT_DIR, 'client.env')
const LEGACY_CLIENT_ENV_FILE = path.join(RP_HOST_DIR, 'client.env')

function selfHealIdeDataDirs() {
  const base = path.join(os.homedir(), '.xpair')
  const oldIde = path.join(base, 'client')
  const ide = path.join(base, 'ide')
  const oldServer = path.join(base, 'client-server')
  const ideServer = path.join(base, 'ide-server')
  try {
    if (fs.existsSync(oldIde) && fs.statSync(oldIde).isDirectory() &&
        !fs.existsSync(path.join(oldIde, 'client.env')) && !fs.existsSync(ide)) {
      fs.renameSync(oldIde, ide)
    }
  } catch { /* best effort */ }
  try {
    if (fs.existsSync(oldServer) && fs.statSync(oldServer).isDirectory() && !fs.existsSync(ideServer)) {
      fs.renameSync(oldServer, ideServer)
    }
  } catch { /* best effort */ }
}

selfHealIdeDataDirs()

/** Sentinel that forces onboarding on the next launch (written by the IDE's "Re-run setup"
 *  command, which can't pass an env var across an app quit+relaunch). Deleted once onboarding
 *  actually opens, so it forces exactly one run. */
const FORCE_ONBOARDING_SENTINEL = path.join(RP_CLIENT_DIR, '.force-onboarding')

/** @returns {boolean} true if the force-onboarding sentinel file exists. */
function forceOnboardingSentinelExists() {
  try { return fs.existsSync(FORCE_ONBOARDING_SENTINEL) } catch { return false }
}

/** Remove the force-onboarding sentinel (best-effort; safe if absent). */
function clearForceOnboardingSentinel() {
  try { fs.rmSync(FORCE_ONBOARDING_SENTINEL, { force: true }) } catch { /* ignore */ }
}

const START_STEP = Object.freeze({
  WELCOME: 'welcome',
  CONNECT: 'connect',
  GRANT: 'grant',
  ENGINE: 'engine',
})
const START_STEPS = new Set(Object.values(START_STEP))
const SESSION_ENGINES = new Set(['claude', 'shell', 'codex', 'opencode'])
// Mirrors `xpair launch`'s CLIENT_ENGINE_FALLBACK=${ENGINE:-claude}: the engine actually exec'd when
// neither host.env nor client.env names one. The readiness guard checks this so an un-configured setup
// doesn't skip the check and then dead-end at launch time.
const LAUNCH_ENGINE_FALLBACK = 'claude'

function readClientEnv() {
  const file = fs.existsSync(CLIENT_ENV_FILE) ? CLIENT_ENV_FILE : LEGACY_CLIENT_ENV_FILE
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch { return {} }
  const env = {}
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^["']/, '').replace(/["']\s*$/, '')
  }
  return env
}

function configuredRemoteHost(env = readClientEnv()) {
  return (env.REMOTE_HOST || '').trim()
}

function configuredEngine(env = readClientEnv()) {
  const engine = (env.ENGINE || 'claude').trim()
  return SESSION_ENGINES.has(engine) ? engine : 'claude'
}

async function configuredHostEngine(host, probeBridge = bridge) {
  if (!probeBridge || typeof probeBridge.hostEnvEngine !== 'function') return null
  const result = await probeBridge.hostEnvEngine(host)
  const engine = String((result && result.engine) || '').trim()
  return SESSION_ENGINES.has(engine) ? engine : null
}

/** Historical helper: "configured" ⇔ REMOTE_HOST is set. Folder mappings are OPTIONAL (you can
 *  attach to a host for screen share / terminal with no folders mapped and add them later from the
 *  IDE), so they are intentionally not part of the launch guard. */
function isOnboarded() {
  return configuredRemoteHost().length > 0
}

function forcedOnboardingRequested(argv = process.argv) {
  if (process.env.RP_FORCE_ONBOARDING === '1' || (Array.isArray(argv) && argv.includes('--force'))) {
    return true
  }
  return forceOnboardingSentinelExists()
}

/**
 * Evaluate the launch guard in wizard order and return the first step that needs attention.
 * Folder mappings are not a launch guard; every other runtime precondition is rechecked per launch.
 * @param {string[]} [argv]
 * @param {object} [probeBridge] test override; defaults to onboarding-bridge.js
 * @returns {Promise<'welcome'|'connect'|'grant'|'engine'|null>}
 */
async function firstFailingGuard(argv = process.argv, probeBridge = bridge) {
  if (forcedOnboardingRequested(argv)) return START_STEP.WELCOME

  const clientEnv = readClientEnv()
  const host = configuredRemoteHost(clientEnv)
  if (!host) return START_STEP.WELCOME

  try {
    const cli = await probeBridge.cliReady()
    if (!cli || cli.ready !== true) return START_STEP.WELCOME
  } catch {
    return START_STEP.WELCOME
  }

  try {
    const reach = await probeBridge.sshReachable(host)
    if (!reach || reach.reachable !== true) return START_STEP.CONNECT
  } catch {
    return START_STEP.CONNECT
  }

  try {
    const app = await probeBridge.hostAppStatus(host)
    if (!app || app.installed !== true) return START_STEP.CONNECT
    if (app.compatible !== true) return START_STEP.CONNECT
  } catch {
    return START_STEP.CONNECT
  }

  try {
    const perms = await probeBridge.hostPermissions({ host })
    if (!perms || perms.alive !== true) return START_STEP.CONNECT
    if (perms.ax !== true || perms.sr !== true) return START_STEP.GRANT
  } catch {
    return START_STEP.CONNECT
  }

  let hostEngine = null
  try {
    hostEngine = await configuredHostEngine(host, probeBridge)
  } catch {
    hostEngine = null
  }
  // On upgraded hosts that were configured by the old client-side engine step, host.env may not exist
  // yet even though client.env still NAMES the engine the user expects. Fall back to that client engine
  // so the readiness gate still runs — otherwise a missing/unreadable host.env silently skips the check
  // and the first `xpair launch` fails when that engine isn't installed/signed in on the host.
  // When nothing is named anywhere, mirror the launcher: `xpair launch` resolves the engine to
  // `${host ENGINE} || ${client ENGINE} || CLIENT_ENGINE_FALLBACK` where CLIENT_ENGINE_FALLBACK is
  // `${ENGINE:-claude}` (see client/cli/xpair-launch). So an un-configured setup still execs `claude`
  // on the host — check that same default here, or the guard skips and the first launch dead-ends with
  // "claude not found on host".
  const clientEngineRaw = (readClientEnv().ENGINE || "").trim()
  const clientEngine = SESSION_ENGINES.has(clientEngineRaw) ? clientEngineRaw : null
  const engineToCheck = hostEngine || clientEngine || LAUNCH_ENGINE_FALLBACK
  if (engineToCheck) {
    try {
      const engine = await probeBridge.hostEngineStatus(engineToCheck)
      if (!engine || engine.installed !== true || engine.authed !== true) return START_STEP.ENGINE
    } catch {
      return START_STEP.ENGINE
    }
  }

  return null
}

/** Compatibility wrapper for older local tests/scripts; new electron-main code uses
 *  resolveOnboarding() so it can await the per-launch guard. */
async function shouldOnboard(argv = process.argv) {
  return (await firstFailingGuard(argv)) !== null
}

function normalizeStartStep(startStep) {
  const step = String(startStep || '').trim().toLowerCase()
  return START_STEPS.has(step) ? step : ''
}

let _ipcWired = false
function wireIpc(ipcMain, onComplete) {
  if (_ipcWired) return
  _ipcWired = true
  // Data calls → onboarding-bridge.js (own-property guard; argv-safe; never throws to the renderer).
  ipcMain.handle('rp', async (_e, msg) => {
    const method = msg && msg.method
    if (!method || !Object.prototype.hasOwnProperty.call(bridge, method)) {
      return { error: 'unknown method: ' + method }
    }
    const fn = bridge[method]
    if (typeof fn !== 'function') return { error: 'unknown method: ' + method }
    try {
      const args = Array.isArray(msg.args) ? msg.args : []
      return await fn.apply(bridge, args)
    } catch (e) {
      return { error: String(e && e.message ? e.message : e) }
    }
  })
  // Completion → close the onboarding window and hand control back to electron-main to open the
  // workbench (SAME process; no second app, no app.quit). onComplete() is provided by the hook.
  ipcMain.handle('onboarding:complete', () => {
    _completed = true
    try {
      if (telemetry && telemetry.EVENTS) {
        if (telemetry.claimFirstLaunchOnce && telemetry.claimFirstLaunchOnce()) {
          telemetry.capture(telemetry.EVENTS.APP_FIRST_LAUNCH, { is_fresh_install: true })
        }
        const wowBase = telemetry.installTs && telemetry.installTs()
        telemetry.capture(telemetry.EVENTS.FIRST_SESSION_STARTED, {
          ...(wowBase ? { time_to_wow_ms: Date.now() - wowBase } : {}),
        })
      }
    } catch { /* telemetry must never block completion */ }
    try { if (_win && !_win.isDestroyed()) _win.close() } catch { /* ignore */ }
    try { if (typeof onComplete === 'function') onComplete() } catch { /* main opens workbench */ }
  })
}

let _win = null
let _completed = false

/**
 * Open the pre-workbench onboarding BrowserWindow (loads the onboarding-webview UI). The IDE's
 * electron-main calls this on first run INSTEAD of creating the workbench window; on completion the
 * window closes and `onComplete` is invoked so electron-main opens the workbench.
 * @param {object}  o
 * @param {typeof import('electron')} o.electron   the electron module from the main process
 * @param {() => void} o.onComplete                opens the workbench window (same process)
 * @param {string} [o.startStep]                   wizard step id to parachute into
 * @returns {import('electron').BrowserWindow}
 */
function openOnboardingWindow({ electron, onComplete, startStep } = {}) {
  const { app, BrowserWindow, ipcMain, shell } = electron
  // Onboarding is actually opening now, so consume the one-shot force sentinel (if any). This
  // guarantees exactly one forced run — a later normal launch won't re-trigger onboarding.
  clearForceOnboardingSentinel()
  try { if (telemetry && telemetry.firstRunStamp) telemetry.firstRunStamp() } catch { /* */ }
  // Count the onboarding window as a connected client (fire-and-forget; never blocks/throws).
  try { if (heartbeat && heartbeat.startHeartbeat) heartbeat.startHeartbeat() } catch { /* */ }
  wireIpc(ipcMain, onComplete)

  _win = new BrowserWindow({
    width: 720,
    height: 560,
    resizable: false,
    show: false, // show on ready-to-show so it appears focused, not behind
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#ffffff',
    webPreferences: {
      // Own session partition so this window escapes the IDE main's defaultSession security
      // interceptors (VSCode blocks raw file:// via security.promptForLocalFileProtocolHandling and
      // restricts vscode-file:// to registered editor windows — neither of which our pre-workbench
      // onboarding window is). A fresh partition has no such interceptors, so loadFile() works.
      partition: 'remotepair-onboarding',
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  _win.once('ready-to-show', () => {
    try { app.dock && app.dock.show && app.dock.show() } catch { /* not macOS */ }
    _win.show()
    _win.focus()
    try { app.focus({ steal: true }) } catch { try { app.focus() } catch { /* */ } }
  })

  const normalizedStartStep = normalizeStartStep(startStep)
  if (normalizedStartStep) {
    _win.loadFile(WEBVIEW_INDEX, { query: { startStep: normalizedStartStep, engine: configuredEngine() } })
  } else {
    _win.loadFile(WEBVIEW_INDEX)
  }
  _win.webContents.setWindowOpenHandler(({ url }) => {
    try { shell.openExternal(url) } catch { /* */ }
    return { action: 'deny' }
  })
  // Closing the onboarding window WITHOUT completing setup must NOT open the workbench: leave this
  // launch incomplete. The client is only handed off after the renderer sends onboarding:complete
  // from the gated Done step, so the next launch will show onboarding again because setup has not
  // been marked complete.
  _win.on('closed', () => {
    _win = null
  })
  return _win
}

async function resolveOnboarding({ electron, onComplete, argv = process.argv, probeBridge = bridge } = {}) {
  const startStep = await firstFailingGuard(argv, probeBridge)
  if (!startStep) return false
  openOnboardingWindow({ electron, onComplete, startStep })
  return true
}

module.exports = {
  isOnboarded,
  configuredHostEngine,
  firstFailingGuard,
  shouldOnboard,
  resolveOnboarding,
  openOnboardingWindow,
}
