const { contextBridge, ipcRenderer } = require('electron')

// Preload for the single-app onboarding BrowserWindow (hosted by the IDE main process).
// Exposes the same `window.remotepair` surface the onboarding-webview React UI expects. Each data
// method routes to the main process over a single `rp` channel ({method, args}) dispatched to
// onboarding-bridge.js; `complete` hands control back to electron-main to open the workbench.
const rp = (method, args = []) => ipcRenderer.invoke('rp', { method, args })

contextBridge.exposeInMainWorld('remotepair', {
  getConfig: () => rp('getConfig'),
  // Hard guards: cliReady gates the WHOLE wizard (xpair CLI must be installed + runnable);
  // hostAppStatus gates the Connect/Reconnect step (host must have the host app + be version-compatible).
  cliReady: () => rp('cliReady'),
  // No dead end: when cliReady is false, the onboarding installs the bundled CLI (install.sh
  // --role client) instead of hard-blocking; only an install failure blocks (with Retry).
  installCli: () => rp('installCli'),
  openHostOnboarding: () => rp('openHostOnboarding'),
  hostAppStatus: (host) => rp('hostAppStatus', [host]),
  setHost: (host) => rp('setHost', [host]),
  addMapping: (clientPath, hostPath, method) => rp('addMapping', [clientPath, hostPath, method]),
  removeMapping: (clientPath) => rp('removeMapping', [clientPath]),
  resolveHostPath: (target, hostPath) => rp('resolveHostPath', [target, hostPath]),
  mount: (hostPath, mountpoint) => rp('mount', [hostPath, mountpoint]),
  defaultMountpoint: (hostPath) => rp('defaultMountpoint', [hostPath]),
  // Discovery / remote-install. Client onboarding uses key auth only and pairs against the host's
  // live broadcast metadata before persisting REMOTE_HOST.
  discover: () => rp('discover'),
  fetchPairingMeta: (target) => rp('fetchPairingMeta', [target]),
  sendPairingRequest: (opts) => rp('sendPairingRequest', [opts]),
  pairingStatus: (opts) => rp('pairingStatus', [opts]),
  installHost: (opts) => rp('installHost', [opts]),
  pinHostKey: (host, expectedFp) => rp('pinHostKey', [host, expectedFp]),
  // Telemetry (consent-gated PostHog; no-ops until opt-in).
  tCapture: (event, props) => rp('tCapture', [event, props]),
  tGetConsent: () => rp('tGetConsent'),
  tSetConsent: (telemetry, crashReport) => rp('tSetConsent', [telemetry, crashReport]),
  // `complete` is fire-and-forget: main closes the onboarding window and opens the workbench.
  complete: () => {
    ipcRenderer.invoke('onboarding:complete')
    return Promise.resolve()
  },
})
