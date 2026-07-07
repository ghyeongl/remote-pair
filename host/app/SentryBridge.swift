// SentryBridge.swift — host crash-reporting seam for XpairHost (telemetry-funnel spec, Sentry scope).
//
// PROTOCOL SEAM. The crash backend is swappable behind the CrashReporting protocol: NoopCrashReporter
// (zero network) by default, and a sentry-cocoa-backed SentryCrashReporter once consent + DSN are present.
// The host build links sentry-cocoa via SwiftPM (host/Package.swift, product "Sentry") and is driven by
// `swift build -c release` (build-host.sh). The real backend is compiled behind `#if canImport(Sentry)` so
// this file still compiles if the dependency is ever removed (falls back to staying no-op).
//
// Contract:
//   • init gated on RPCrashReportConsent; if DSN absent => do NOT init (no network — the SDK never starts).
//   • sendDefaultPii=false; disable server_name.
//   • beforeSend MUST run the STRICT outbound scrubber `outboundScrub()` (Config.swift) over every
//     outbound field (message, exception value, backtrace frames). outboundScrub() composes
//     logRedact() ($HOME/REMOTE_HOST) PLUS IPv4/IPv6 → <ip>, abs paths → <path>, *.ts.net → <host>.
//     Plain logRedact() is INSUFFICIENT here — crash payloads carry raw IPs/paths/tailnet names.
//   • release = APP_VERSION; RP_SESSION tag when available.
//   • NSException path: capture BEFORE the local dump write (CrashReporter.swift).
//   • Signal path stays async-signal-safe (local-only): CrashReporter.swift OWNS the signal handler, so
//     sentry-cocoa's own crash handler is DISABLED (options.enableCrashHandler = false). On next launch any
//     appended crash-host-signal.log is uploaded as a message envelope, then the local dump is KEPT.
//
// Default behavior (consent OFF, or DSN absent, or SDK absent): every method is a no-op => ZERO network calls.

import Foundation
#if canImport(Sentry)
import Sentry
#endif

/// The crash-reporting surface the rest of the host calls. Swappable: NoopCrashReporter today,
/// a sentry-cocoa-backed impl once the dependency is wired in (see SentryBridge file header).
protocol CrashReporting {
    /// True only when the backend actually initialized (consent ON + DSN present + SDK linked).
    var isActive: Bool { get }
    /// Report a handled NSException. Caller scrubs via logRedact() before passing; impl must not log raw.
    func captureException(name: String, reason: String?, frames: [String])
    /// Report a raw crash-host-signal.log payload as an envelope. Caller passes already-redacted text.
    func captureSignalCrashLog(_ redactedText: String)
}

/// No-op default. Guarantees ZERO network calls until a real backend is wired in. Used whenever the
/// SDK is absent, consent is OFF, or the DSN is not configured.
struct NoopCrashReporter: CrashReporting {
    var isActive: Bool { false }
    func captureException(name: String, reason: String?, frames: [String]) {}
    func captureSignalCrashLog(_ redactedText: String) {}
}

#if canImport(Sentry)
/// sentry-cocoa-backed reporter. Constructed by SentryBridge.setupIfConsented() ONLY after SentrySDK.start
/// (consent ON + DSN present). All inputs are ALREADY scrubbed by the caller via outboundScrub(); beforeSend
/// (SentryBridge.setupIfConsented) scrubs again as defense in depth before any send.
struct SentryCrashReporter: CrashReporting {
    var isActive: Bool { true }

    /// Report a handled NSException as a synthetic Sentry event. The caller (CrashReporter.swift) already
    /// ran outboundScrub() over reason + every frame; we build the exception/stacktrace from those scrubbed
    /// strings and capture it as an event (NOT capture(exception:) — we don't hold the live NSException and
    /// the frames are already symbolicated text).
    func captureException(name: String, reason: String?, frames: [String]) {
        let event = Event(level: .error)
        let exc = Exception(value: reason ?? name, type: name)
        // Map each pre-scrubbed backtrace line to a frame's function field (it is symbolicated text, not a
        // file path). beforeSend re-scrubs function/fileName/package, so this is privacy-safe either way.
        let stack = SentryStacktrace(frames: frames.map { line in
            let f = Frame()
            f.function = line
            return f
        }, registers: [:])
        exc.stacktrace = stack
        event.exceptions = [exc]
        SentrySDK.capture(event: event)
    }

    /// Upload an already-outboundScrub'd signal-path crash dump as a message envelope. Plain message capture
    /// (not an Exception) since the raw backtrace text is preserved verbatim; beforeSend scrubs once more.
    func captureSignalCrashLog(_ redactedText: String) {
        SentrySDK.capture(message: redactedText)
    }
}
#endif

/// Host crash-reporting entry point. Holds the active CrashReporting backend (Noop until sentry-cocoa
/// is wired in). Init is gated on RPCrashReportConsent.
enum SentryBridge {

    /// Gates Sentry. Default false (opt-in). Registered in AppDelegate via UserDefaults.register(defaults:).
    static let consentKey = "RPCrashReportConsent"
    /// Info.plist DSN. Absent => do not init (the SDK, once wired, must skip init entirely => no network).
    static let dsnPlist = "RPSentryDSN"

    /// The active backend. Defaults to no-op (zero network). Replaced by setupIfConsented() when a real
    /// SDK is linked and consent + DSN are present.
    private(set) static var reporter: CrashReporting = NoopCrashReporter()

    /// Initialize crash reporting. Call in main.swift AFTER installCrashReporter() and BEFORE
    /// NSApplication.shared. No-op (zero network) unless RPCrashReportConsent is ON AND RPSentryDSN is
    /// present AND the Sentry SDK is linked. In every other case the backend stays NoopCrashReporter, so
    /// the SDK never starts and no network calls occur.
    static func setupIfConsented() {
        guard UserDefaults.standard.bool(forKey: consentKey) else {
            reporter = NoopCrashReporter(); return
        }
        guard let dsn = Bundle.main.object(forInfoDictionaryKey: dsnPlist) as? String,
              !dsn.isEmpty else {
            // DSN not provisioned => do not init (no network). Stay no-op — but SAY so: a user who
            // opted in deserves a visible reason uploads never happen. A silent Noop here hid a
            // release pipeline that shipped every build DSN-less (RP_SENTRY_DSN unset in CI).
            reporter = NoopCrashReporter()
            log(.warn, "CRASH-REPORT: consent ON but RPSentryDSN missing from Info.plist — staying local-only (build with RP_SENTRY_DSN set)")
            return
        }
        #if canImport(Sentry)
        // ── sentry-cocoa wiring point ────────────────────────────────────────────────────────────────
        SentrySDK.start { o in
            o.dsn = dsn
            o.sendDefaultPii = false              // spec: PII off
            // spec: disable server_name. SentryOptions has no serverName setter — server_name is suppressed
            // per-event in beforeSend (event.serverName = nil) below, which is what actually gets sent.
            o.releaseName = APP_VERSION           // spec: release = app_version
            // CrashReporter.swift OWNS the async-signal-safe signal handler. sentry-cocoa's own crash /
            // watchdog handlers must NOT fight it — we want ONLY NSException capture + manual envelopes +
            // the next-launch signal-log upload. Disable everything that hooks signals or swizzles.
            o.enableCrashHandler = false
            o.enableSigtermReporting = false
            o.enableWatchdogTerminationTracking = false
            o.enableAutoSessionTracking = false
            o.enableAppHangTracking = false
            o.enableSwizzling = false
            o.beforeSend = { event in
                // STRICT outbound scrub before any send: $HOME/REMOTE_HOST + IPv4/IPv6 + abs paths +
                // *.ts.net. Use outboundScrub() (NOT logRedact) — crash payloads carry raw IPs/paths.
                event.serverName = nil
                if let m = event.message?.formatted {
                    // SentryMessage.formatted is read-only → rebuild the message with the scrubbed text.
                    event.message = SentryMessage(formatted: outboundScrub(m))
                }
                event.exceptions?.forEach { exc in
                    exc.value = outboundScrub(exc.value)
                    exc.stacktrace?.frames.forEach { f in
                        if let fn = f.fileName { f.fileName = outboundScrub(fn) }
                        if let fn = f.function { f.function = outboundScrub(fn) }
                        // SentryFrame has no absPath; `package` carries the binary's absolute path.
                        if let pk = f.package  { f.package  = outboundScrub(pk) }
                    }
                }
                return event
            }
        }
        if let s = ProcessInfo.processInfo.environment["RP_SESSION"], s != "-", !s.isEmpty {
            SentrySDK.configureScope { $0.setTag(value: s, key: "rp_session") }
        }
        reporter = SentryCrashReporter()
        log(.info, "CRASH-REPORT: Sentry backend started (consent ON + DSN present) — NSException + signal-log upload, signal handler owned locally")
        #else
        // SDK not linked => keep no-op (build still compiles, no network).
        reporter = NoopCrashReporter()
        log(.info, "CRASH-REPORT: consent ON + DSN present, but Sentry SDK not linked in this build — staying local-only (no upload)")
        #endif
    }

    /// End-to-end pipeline check for `XpairHost --sentry-self-test`: prints each gate's state, and
    /// when the backend is active sends ONE synthetic marker event and flushes it. Exit 0 only when the
    /// event was handed to the SDK and flushed; nonzero (with the failing gate printed) otherwise.
    static func selfTest() -> Bool {
        let consent = UserDefaults.standard.bool(forKey: consentKey)
        let dsn = (Bundle.main.object(forInfoDictionaryKey: dsnPlist) as? String) ?? ""
        print("consent (\(consentKey)):  \(consent ? "ON" : "OFF")")
        print("DSN (\(dsnPlist)):        \(dsn.isEmpty ? "ABSENT" : "present")")
        setupIfConsented()
        print("backend:                 \(reporter.isActive ? "Sentry (active)" : "Noop")")
        guard reporter.isActive else {
            print("→ nothing uploads in this state; fix the gate(s) above (consent ON + DSN present + SDK linked) and re-run.")
            return false
        }
        reporter.captureException(
            name: "XpairSentrySelfTest",
            reason: "synthetic self-test event (\(APP_VERSION))",
            frames: ["--sentry-self-test"])
        #if canImport(Sentry)
        SentrySDK.flush(timeout: 5)   // returns Void; blocks up to the timeout draining the transport
        print("→ test event sent + flushed (5s). Look for 'XpairSentrySelfTest' in the Sentry project.")
        return true
        #else
        return false
        #endif
    }

    /// Upload a pending signal-path crash dump (crash-host-signal.log) on next launch, then KEEP the local
    /// dump. No-op unless the backend is active. The signal handler itself stays async-signal-safe and
    /// local-only; this runs at normal launch time where Foundation + redaction are safe.
    static func uploadPendingSignalCrashIfAny() {
        guard reporter.isActive else { return }
        let path = "\(LOG_DIR)/crash-host-signal.log"
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8), !raw.isEmpty else { return }
        // The signal path cannot redact a raw backtrace at crash time; scrub here before upload. A raw
        // backtrace can carry IPv4/IPv6, *.ts.net peer names, /Users/<name>/.., /private/var/folders/..
        // etc., so use the STRICT outbound scrubber (NOT plain logRedact) for this OUTBOUND payload.
        reporter.captureSignalCrashLog(outboundScrub(raw))
        log(.info, "CRASH-REPORT: uploaded pending signal crash dump (local copy kept) — \(path)")
        // KEEP the local dump (spec: local dumps preserved). We only upload once per dump by truncating to
        // a processed marker so the same backtrace is not re-uploaded on every subsequent launch.
        markSignalCrashUploaded(path)
    }

    /// Mark crash-host-signal.log as uploaded without deleting it: rename to a dated copy so the live file
    /// starts empty (no re-upload) while the local dump is preserved for `xpair logs --collect`.
    private static func markSignalCrashUploaded(_ path: String) {
        let fm = FileManager.default
        let archived = "\(LOG_DIR)/crash-host-signal-\(Int(Date().timeIntervalSince1970)).log"
        do {
            try fm.moveItem(atPath: path, toPath: archived)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: archived)
        } catch {
            log(.debug, "CRASH-REPORT: archiving uploaded signal dump skipped: \(error)")
        }
    }
}
