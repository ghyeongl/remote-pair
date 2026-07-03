const { contextBridge, ipcRenderer } = require('electron')

// Preload for the single-app onboarding BrowserWindow (hosted by the IDE main process).
// Exposes the same `window.remotepair` surface the onboarding-webview React UI expects. Each data
// method routes to the main process over a single `rp` channel ({method, args}) dispatched to
// onboarding-bridge.js; `complete` hands control back to electron-main to open the workbench.
const rp = (method, args = []) => ipcRenderer.invoke('rp', { method, args })

contextBridge.exposeInMainWorld('remotepair', {
  hostInfo: () => rp('hostInfo'),
  getConfig: () => rp('getConfig'),
  // Hard guards: cliReady gates the WHOLE wizard (xpair CLI must be installed + runnable);
  // hostAppStatus gates the Connect/Reconnect step (host must have the host app + be version-compatible).
  cliReady: () => rp('cliReady'),
  // No dead end: when cliReady is false, the onboarding installs the bundled CLI (install.sh
  // --role client) instead of hard-blocking; only an install failure blocks (with Retry).
  installCli: () => rp('installCli'),
  openHostOnboarding: () => rp('openHostOnboarding'),
  hostAppStatus: (host) => rp('hostAppStatus', [host]),
  clientVersion: () => rp('clientVersion'),
  setHost: (host) => rp('setHost', [host]),
  // Engine selection + host-engine hard guard (Engine step). setEngine persists the chosen engine
  // (config set engine → client.env ENGINE). hostEngineStatus probes whether the engine is installed
  // AND authenticated on the host; installHostEngine installs it (brew); setHostEngineAuth sets the
  // host-side API key (handed to the host over the SSH stdin pipe — NEVER argv/log/disk).
  setEngine: (engine) => rp('setEngine', [engine]),
  hostEngineStatus: (engine) => rp('hostEngineStatus', [engine]),
  installHostEngine: (engine) => rp('installHostEngine', [engine]),
  setHostEngineAuth: (engine, apiKey) => rp('setHostEngineAuth', [engine, apiKey]),
  addMapping: (clientPath, hostPath, method) => rp('addMapping', [clientPath, hostPath, method]),
  removeMapping: (clientPath) => rp('removeMapping', [clientPath]),
  resolveHostPath: (target, hostPath) => rp('resolveHostPath', [target, hostPath]),
  hostSmbStatus: () => rp('hostSmbStatus', []),
  setBackend: (sync, mount) => rp('setBackend', [sync, mount]),
  mount: (hostPath, mountpoint) => rp('mount', [hostPath, mountpoint]),
  hostPathExists: (hostPath) => rp('hostPathExists', [hostPath]),
  defaultMountpoint: (hostPath) => rp('defaultMountpoint', [hostPath]),
  sshKeygen: () => rp('sshKeygen'),
  sshReachable: (host) => rp('sshReachable', [host]),
  tailscaleStatus: () => rp('tailscaleStatus'),
  // Discovery / remote-install. Client onboarding uses key auth only: hostPermissions SSH-reads the
  // host's grant status (status.json) so the Grant step can confirm AX/SR were granted on the
  // host's screen.
  discover: () => rp('discover'),
  sendPairingRequest: (opts) => rp('sendPairingRequest', [opts]),
  pairingStatus: (opts) => rp('pairingStatus', [opts]),
  installHost: (opts) => rp('installHost', [opts]),
  hostPermissions: (opts) => rp('hostPermissions', [opts]),
  hostKeyFingerprint: (host) => rp('hostKeyFingerprint', [host]),
  pinHostKey: (host, expectedFp) => rp('pinHostKey', [host, expectedFp]),
  hasDurableHostKey: (host) => rp('hasDurableHostKey', [host]),
  // Telemetry (consent-gated PostHog; no-ops until opt-in).
  tCapture: (event, props) => rp('tCapture', [event, props]),
  tCatalog: () => rp('tCatalog'),
  tGetConsent: () => rp('tGetConsent'),
  tSetConsent: (telemetry, crashReport) => rp('tSetConsent', [telemetry, crashReport]),
  // `complete` is fire-and-forget: main closes the onboarding window and opens the workbench.
  complete: () => {
    ipcRenderer.invoke('onboarding:complete')
    return Promise.resolve()
  },
})
