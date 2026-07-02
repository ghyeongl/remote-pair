// The agent engine that runs LOCALLY on this host under `xpair launch`.
export type EngineId = 'claude' | 'codex' | 'opencode' | 'shell'

export type PairingPhase =
  | 'waiting'
  | 'incoming'
  | 'accepted-pending-proof'
  | 'paired'
  | 'denied'
  | 'closed'

export interface PairingIncomingRequest {
  id: string
  name: string
  ip: string
  user: string
  keyFingerprint: string
}

export interface PairingStatus {
  phase: PairingPhase
  state: string
  serviceInstanceID: string
  hostNonce: string
  pairPort: number
  error: string
  request?: PairingIncomingRequest
  accepted?: {
    clientID: string
    name: string
    keyFingerprint: string
    proofDeadline: number
  }
}

declare global {
  interface Window {
    __rp_initialStep?: 'permissions' | 'engine' | 'connect'
    __rp_mode?: 'runGate' | 'grantOnly'
    xpair: {
      openPermissionPane: (key: 'login' | 'ax' | 'sr' | 'fda' | 'sharing') => Promise<void>
      requestPermission: (key: 'login' | 'ax' | 'sr' | 'fda' | 'sharing') => Promise<void>
      startInstall: () => Promise<void>
      getInstallStatus: () => Promise<{ appAlive: boolean; launchAgentPresent: boolean; serverUp: boolean }>
      getHostInfo: () => Promise<{ hostname: string; user: string }>
      getStatus: () => Promise<{ alive: boolean; login: boolean; ax: boolean; sr: boolean; fda: boolean; sharing: boolean }>
      getOnboardingStep: () => Promise<number>
      setOnboardingStep: (n: number) => Promise<void>
      // Both flags are opt-in (default OFF). Maps to UserDefaults RPTelemetryConsent / RPCrashReportConsent.
      getConsent: () => Promise<{ telemetry: boolean; crash: boolean }>
      setConsent: (c: { telemetry: boolean; crash: boolean }) => Promise<void>
      // Read-only: clients currently connected (heartbeat ts within the freshness window). [] when none.
      connectedClients: () => Promise<Array<{ name: string; user: string; ageSec: number }>>
      // Pairing Broadcast backend. `accepted-pending-proof` means the exact key was installed but
      // Continue stays locked; only `paired` maps to the UI's accepted state.
      beginPairing: () => Promise<PairingStatus>
      pairingStatus: () => Promise<PairingStatus>
      acceptPairing: (request: { id: string; keyFingerprint: string }) => Promise<PairingStatus>
      denyPairing: () => Promise<PairingStatus>
      endPairing: () => Promise<PairingStatus>
      // Agent-engine guard — runs LOCALLY on this host (mirrors the client's host-over-SSH guard).
      // engineStatus probes install + auth; installEngine runs brew (npm fallback for claude);
      // setEngineAuth feeds the API key over the child's stdin only (never argv/log/disk-plaintext);
      // setEngine persists the choice to ~/.xpair/host/host.env (ENGINE=<id>).
      engineStatus: (engine: EngineId) => Promise<{ installed: boolean; authed: boolean; version: string; err: string }>
      installEngine: (engine: EngineId) => Promise<{ ok: boolean; err: string }>
      setEngineAuth: (engine: EngineId, key: string) => Promise<{ ok: boolean; err: string }>
      setEngine: (engine: EngineId) => Promise<{ ok: boolean; err: string }>
      complete: () => Promise<void>
    }
  }
}

export {}
