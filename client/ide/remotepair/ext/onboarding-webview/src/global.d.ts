// Discovery peer shape returned by `xpair discover --json` (deduped by host-key fingerprint).
export type PeerStatus = "reconnect" | "connect" | "setup"
export type PeerSource = "lan" | "tailscale" | "ssh"

export interface Peer {
  name: string
  addrs: string[]
  // Canonical SSH target for install/connect: the ssh-config alias name when this peer is
  // config-known (carries IdentityFile + User → key auth), otherwise a discovered address. Always
  // prefer this over addrs[0] for any window.remotepair call that SSHes — a bare tailnet/LAN address
  // not in ssh config falls back to password auth and hangs the GUI askpass. Optional for
  // back-compat with an older CLI that did not emit it (fall back to addrs[0] || name).
  target?: string
  pairingAddress?: string
  hostUser?: string
  source: PeerSource
  sources: PeerSource[]
  fp: string | null
  status: PeerStatus
}

declare global {
  interface Window {
    remotepair: {
      // Hard CLI guard (global): is the `xpair` CLI installed at a real path AND runnable (`xpair
      // status` → code 0)? ready===false blocks the entire wizard (every step's Next disabled).
      cliReady: () => Promise<{ ready: boolean; bin: string; err: string }>
      // No dead end: install the bundled client CLI to ~/.local/bin (install.sh --role client). The
      // onboarding calls this when cliReady is false; only ok===false blocks (with Retry).
      installCli: () => Promise<{ ok: boolean; err: string; action?: "OPEN_DOWNLOAD"; url?: string }>
      openHostOnboarding: () => Promise<{ ok: boolean; err: string }>
      // Hard host-app guard (Connect/Reconnect): reachable is not enough — the host must have the
      // Xpair host app installed AND be version-compatible. installed/compatible false → block the step.
      hostAppStatus: (host: string) => Promise<{
        installed: boolean
        version: string
        compatible: boolean
        // WHY compatible is false (surfaced by the bridge so the UI doesn't re-parse versions):
        //   "below_floor"    — same major but older than the protocol floor → use update wording.
        //   "major_mismatch" — different/NEWER major → use generic repair wording.
        //   ""               — compatible.
        incompatibleKind: "below_floor" | "major_mismatch" | ""
        err: string
      }>
      getConfig: () => Promise<{
        remoteHost: string
        engine: string
        folderMaps: string
        folderMapModes: string
        syncBackend: string
        mountBackend: string
      }>
      setHost: (host: string) => Promise<any>
      addMapping: (clientPath: string, hostPath: string, method?: "mount" | "sync") => Promise<any>
      removeMapping: (clientPath: string) => Promise<{ code: number; out: string; err: string }>
      resolveHostPath: (target: string, hostPath: string) => Promise<{ ok: boolean; path: string; err: string }>
      listHostDir: (target: string, hostPath?: string) => Promise<{
        ok: boolean
        base: string
        entries: { name: string; path: string }[]
        truncated?: boolean
        err: string
        state?: string
        action?: string
      }>
      mount: (hostPath: string, mountpoint?: string) => Promise<{ code: number; out: string; err: string; mountpoint: string }>
      defaultMountpoint: (hostPath: string) => Promise<string>
      // Discovery / remote-install (component ⑤). Client onboarding uses SSH key auth as the primary
      // path: the setup step prepares/reuses the client key, installHost authorizes it on the host,
      // and the bridge uses BatchMode/publickey-only probes. Failures return explicit recovery states
      // (host-key mismatch, key-agent/passphrase failure) instead of password or pairing-code entry.
      discover: () => Promise<{ peers: Peer[]; err: string }>
      fetchPairingMeta: (target: string) => Promise<{
        ok: boolean
        fp: string
        serviceInstanceID: string
        hostNonce: string
        pairPort: number
        hostUser: string
        err: string
      }>
      sendPairingRequest: (opts: {
        host: string
        port: number
        hostKeyFP: string
        hostNonce: string
        serviceInstanceID: string
        name?: string
        user?: string
      }) => Promise<{ ok: boolean; err: string; fingerprint: string }>
      pairingStatus: (opts: { host: string; pairingHost?: string }) => Promise<{
        paired: boolean
        pending: boolean
        denied: boolean
        err: string
        fingerprint: string
        state?: "ready" | "invalid_host" | "host_key_mismatch" | "key_auth_blocked" | "needs_password" | "password_denied" | "unreachable"
        action?: "continue" | "abort" | "recover_host_key" | "approve_or_retry" | "prompt_password" | "retry"
      }>
      // force:true reinstalls the bundled XpairHost over a missing/incompatible/below-floor host app
      // (restart repairs omit force so the CLI only kickstarts/opens the existing app). password is a
      // one-shot used only to bootstrap the first connection to a host that hasn't authorized the key.
      installHost: (opts: { host: string; user?: string; password?: string; force?: boolean }) => Promise<{
        ok: boolean
        out: string
        err: string
        state?: "ready" | "invalid_host" | "invalid_account" | "host_key_mismatch" | "key_auth_blocked" | "needs_password" | "password_denied" | "unreachable"
        action?: "continue" | "abort" | "recover_host_key" | "approve_or_retry" | "prompt_password" | "retry"
      }>
      pinHostKey: (host: string, expectedFp: string) => Promise<{ ok: boolean; err: string; state?: string; action?: string }>
      // Telemetry (consent-gated PostHog; no-ops until opt-in).
      tCapture: (event: string, props?: Record<string, unknown>) => Promise<{ ok: boolean }>
      tGetConsent: () => Promise<{ telemetry: boolean; crashReport: boolean }>
      tSetConsent: (
        telemetry: boolean,
        crashReport: boolean,
      ) => Promise<{ telemetry: boolean; crashReport: boolean }>
      complete: () => Promise<void>
    }
  }
}

export {}
