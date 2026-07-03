// main.swift — XpairHost entry point.  (top-level executable statements may only live in this file)
//
// Menu-bar-only accessory app: no Dock icon + holds a graphic session (the gating condition for AX synthetic input).
// Responsibilities are split across the individual .swift files: Config / HostManager / ApproveManager / Sessions /
//   Permissions / Updater / SettingsWindow / AppDelegate.

import Cocoa

if CommandLine.arguments.contains("--pairing-self-test") {
    do {
        try PairingSecuritySelfTest.run()
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("pairing security self-test failed: \(error)\n".utf8))
        exit(1)
    }
}

// §10: install local crash dumps before anything else so even startup crashes are captured.
// ensureDirs() first — the signal-path handler writes to an fd opened under $LOG_DIR at install.
ensureDirs()
installCrashReporter()
// Crash reporting (Sentry seam) after the local handlers, before NSApplication.shared (telemetry spec).
// Gated on RPCrashReportConsent (default OFF => no-op, zero network). No SDK linked yet => stays local-only.
SentryBridge.setupIfConsented()

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // menu-bar only (holds a graphic session)
app.run()
