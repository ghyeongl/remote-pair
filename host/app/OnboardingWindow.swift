// OnboardingWindow.swift — in-process onboarding, replacing the standalone Electron app.
//
// The host menu-bar app now hosts the React onboarding (host/onboarding/dist, bundled into
// Contents/Resources/onboarding) inside a WKWebView. A WKUserScript injected atDocumentStart
// defines `window.xpair` with the same method surface the Electron preload exposed, each
// returning a Promise backed by a single WKScriptMessageHandlerWithReply (`rpbridge`, macOS 11+
// async reply). The Swift reply handler dispatches by method name.
//
// Engine guard (claude | codex | opencode): unlike the client (which probes/installs the engine on
// the host OVER SSH), the host onboarding runs entirely on THIS machine, so engineStatus/installEngine/
// setEngineAuth/setEngine execute locally via EngineGuard (login-shell Process). The chosen engine is
// persisted to ~/.xpair/host/host.env (the host-side counterpart of the client's client.env ENGINE).
//
// This window is shown by AppDelegate while required host permissions are not granted (the hard run-gate).
// onComplete fires when the React Done → complete() posts; closing it before they are granted quits the app.

import Cocoa
import WebKit

final class OnboardingWindow: NSObject, NSWindowDelegate, WKScriptMessageHandlerWithReply {
    /// `runGate` = the launch-time hard gate (full flow; dismissing while ungranted quits the app).
    /// `grantOnly` = the menu-bar "Grant Permissions…" entry: deep-link to the Permissions step on a
    /// still-running app; closing the window NEVER quits.
    enum Mode { case runGate, grantOnly }

    private var window: NSWindow!
    private var webView: WKWebView!
    private let onComplete: () -> Void
    private let mode: Mode
    /// Deep-link the React onboarding to a specific step on open (e.g. "permissions"). nil = start at
    /// the beginning (Welcome) — used by "Configure…" to show the whole flow from scratch.
    private let initialStep: String?
    // Set true once the React side calls complete() (Screen Recording granted). Distinguishes a
    // legitimate finish from the user dismissing the window while still ungranted (→ hard gate quit).
    private var completed = false
    // Saved so the onboarding Edit menu (installEditMenu) can be reverted on close — the host
    // normally runs as a menu-bar accessory with no application menu.
    private var previousMainMenu: NSMenu?
    private static let onboardingStepPath = "\(RP_DIR)/onboarding-step.json"
    private static let onboardingStepMax = 10

    private var modeName: String {
        switch mode {
        case .runGate: return "runGate"
        case .grantOnly: return "grantOnly"
        }
    }

    /// onComplete is invoked on the main thread when the React onboarding signals completion.
    /// `initialStep` deep-links the flow (e.g. "permissions"); nil starts at Welcome.
    init(mode: Mode = .runGate, initialStep: String? = nil, onComplete: @escaping () -> Void) {
        self.mode = mode
        self.initialStep = initialStep
        self.onComplete = onComplete
        super.init()
    }

    // The JS shim: define window.xpair with a Promise-returning method per bridge call. Each
    // method posts {method, args} to the `rpbridge` reply handler and awaits the async reply.
    private static let bridgeShim = """
    (function () {
      const post = (method, args) =>
        window.webkit.messageHandlers.rpbridge.postMessage({ method: method, args: args || [] });
      window.xpair = {
        openPermissionPane: (key) => post('openPermissionPane', [key]),
        requestPermission: (key) => post('requestPermission', [key]),
        getHostInfo: () => post('getHostInfo', []),
        getStatus: () => post('getStatus', []),
        getOnboardingStep: () => post('getOnboardingStep', []),
        setOnboardingStep: (n) => post('setOnboardingStep', [n]),
        getConsent: () => post('getConsent', []),
        setConsent: (c) => post('setConsent', [c]),
        beginPairing: (force = false) => post('beginPairing', [force]),
        pairingStatus: () => post('pairingStatus', []),
        acceptPairing: (request) => post('acceptPairing', [request]),
        denyPairing: () => post('denyPairing', []),
        endPairing: () => post('endPairing', []),
        engineStatus: (engine) => post('engineStatus', [engine]),
        installEngine: (engine) => post('installEngine', [engine]),
        setEngineAuth: (engine, key) => post('setEngineAuth', [engine, key]),
        setEngine: (engine) => post('setEngine', [engine]),
        persistEngineIfUnset: (engine) => post('persistEngineIfUnset', [engine]),
        complete: () => post('complete', []),
      };
    })();
    """

    /// Build + show the onboarding window. Main thread only.
    func show() {
        assert(Thread.isMainThread, "OnboardingWindow.show must run on the main thread")

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        let script = WKUserScript(source: Self.bridgeShim,
                                  injectionTime: .atDocumentStart,
                                  forMainFrameOnly: true)
        controller.addUserScript(script)
        let modeScript = WKUserScript(source: "window.__rp_mode = '\(modeName)';",
                                      injectionTime: .atDocumentStart,
                                      forMainFrameOnly: true)
        controller.addUserScript(modeScript)
        // Deep-link the React onboarding straight to a specific step (e.g. "permissions" / "connect").
        // Injected atDocumentStart (before the app bundle runs) so App.tsx reads it on first render.
        // nil = start at Welcome (the whole flow from scratch), so inject nothing.
        if let step = initialStep {
            let stepScript = WKUserScript(source: "window.__rp_initialStep = '\(step)';",
                                          injectionTime: .atDocumentStart,
                                          forMainFrameOnly: true)
            controller.addUserScript(stepScript)
        }
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "rpbridge")
        config.userContentController = controller

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 720, height: 524), configuration: config)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 524),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.title = APP_NAME
        window.contentView = webView
        window.delegate = self
        window.center()

        // The React build uses vite base './', so index.html references its assets relatively.
        // Load via file:// granting read access to the onboarding resource dir so the relative
        // asset requests resolve.
        guard let index = Bundle.main.url(forResource: "index",
                                          withExtension: "html",
                                          subdirectory: "onboarding") else {
            log(.error, "onboarding: Contents/Resources/onboarding/index.html missing in bundle")
            // Without the UI we cannot gate interactively — fail closed (app quits via the gate path).
            return
        }
        let dir = index.deletingLastPathComponent()
        webView.loadFileURL(index, allowingReadAccessTo: dir)

        // XpairHost is LSUIElement (menu-bar accessory) → no Dock icon + weak window focus, so
        // the onboarding can end up invisible/behind. Temporarily become a regular app so it shows in
        // the Dock and can take focus; revert to .accessory in finish() (menu-bar-only after onboarding).
        installEditMenu()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        log(.info, "onboarding window shown (run-gate; activation → regular for Dock + focus)")
    }

    // MARK: - WKScriptMessageHandlerWithReply (async reply, macOS 11+)

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any],
              let method = body["method"] as? String else {
            replyHandler(nil, "rpbridge: malformed message")
            return
        }
        let args = body["args"] as? [Any] ?? []

        switch method {
        case "getStatus":
            replyHandler([
                "alive": true,
                "login": Permissions.loginGranted(),
                "ax": Permissions.axTrusted(),
                "sr": Permissions.srGranted(),
                "fda": Permissions.fdaGranted(),
                "sharing": Permissions.sharingGranted(),
            ], nil)

        case "getOnboardingStep":
            replyHandler(Self.readOnboardingStep(), nil)

        case "setOnboardingStep":
            let n = Self.intArg(args.first) ?? 0
            do {
                try Self.writeOnboardingStep(n)
                replyHandler(nil, nil)
            } catch {
                replyHandler(nil, "onboarding-step write failed: \(error)")
            }

        case "requestPermission":
            if let key = args.first as? String { Permissions.request(key) }
            replyHandler(nil, nil)

        case "openPermissionPane":
            if let key = args.first as? String { openPane(key) }
            replyHandler(nil, nil)

        case "getHostInfo":
            replyHandler([
                "hostname": Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
                "user": NSUserName(),
            ], nil)

        case "getConsent":
            // Both flags are opt-in (default OFF via AppDelegate's UserDefaults.register). The
            // onboarding reads/writes the SAME keys the rest of the host uses (Settings, startup
            // gates), so there is one source of truth.
            replyHandler([
                "telemetry": UserDefaults.standard.bool(forKey: TelemetryClient.consentKey),
                "crash": UserDefaults.standard.bool(forKey: SentryBridge.consentKey),
            ], nil)

        case "setConsent":
            // Persist the user's opt-in choices. Defensive about JS payload types: only treat an
            // explicit Bool true as ON; anything else (missing/null/non-bool) leaves it OFF.
            if let c = args.first as? [String: Any] {
                UserDefaults.standard.set((c["telemetry"] as? Bool) ?? false,
                                          forKey: TelemetryClient.consentKey)
                UserDefaults.standard.set((c["crash"] as? Bool) ?? false,
                                          forKey: SentryBridge.consentKey)
            }
            replyHandler(nil, nil)

        case "beginPairing":
            let force = args.first as? Bool ?? false
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    replyHandler(try PairingManager.shared.beginWindow(force: force), nil)
                } catch {
                    replyHandler(nil, "beginPairing failed: \(error)")
                }
            }

        case "pairingStatus":
            replyHandler(PairingManager.shared.status(), nil)

        case "acceptPairing":
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let request = args.first as? [String: Any]
                    let requestID = (request?["id"] as? String) ?? (args.first as? String) ?? ""
                    let fingerprint = (request?["keyFingerprint"] as? String) ?? ""
                    replyHandler(try PairingManager.shared.acceptIncoming(requestID: requestID,
                                                                         fingerprint: fingerprint), nil)
                } catch {
                    replyHandler(nil, "acceptPairing failed: \(error)")
                }
            }

        case "denyPairing":
            replyHandler(PairingManager.shared.denyIncoming(), nil)

        case "endPairing":
            replyHandler(PairingManager.shared.endWindow(), nil)

        case "engineStatus":
            guard let engine = args.first as? String, EngineGuard.isKnown(engine) else {
                replyHandler(["installed": false, "authed": false, "version": "", "err": "unknown engine"], nil)
                return
            }
            // Probe the LOCAL machine (this is the host's own onboarding). Async off the main thread so
            // the login-shell probe never blocks the UI; reply on completion.
            DispatchQueue.global(qos: .userInitiated).async {
                let s = EngineGuard.status(engine)
                replyHandler(["installed": s.installed, "authed": s.authed,
                              "version": s.version, "err": s.err], nil)
            }

        case "installEngine":
            guard let engine = args.first as? String, EngineGuard.isKnown(engine) else {
                replyHandler(["ok": false, "err": "unknown engine"], nil)
                return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                let r = EngineGuard.install(engine)
                replyHandler(["ok": r.ok, "err": r.err], nil)
            }

        case "setEngineAuth":
            // args = [engine, key]. The key MUST NOT reach argv/log/disk-plaintext: EngineGuard.setAuth
            // feeds it to the child over stdin only. Drop it from this scope as soon as it's handed off.
            guard let engine = args.first as? String, EngineGuard.isKnown(engine),
                  args.count > 1, let key = args[1] as? String, !key.isEmpty else {
                replyHandler(["ok": false, "err": "missing engine or key"], nil)
                return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                let r = EngineGuard.setAuth(engine, key: key)
                replyHandler(["ok": r.ok, "err": r.err], nil)
            }

        case "setEngine":
            guard let engine = args.first as? String, EngineGuard.isKnown(engine) else {
                replyHandler(["ok": false, "err": "unknown engine"], nil)
                return
            }
            let r = EngineGuard.persist(engine)
            replyHandler(["ok": r.ok, "err": r.err], nil)

        case "persistEngineIfUnset":
            guard let engine = args.first as? String, EngineGuard.isKnown(engine) else {
                replyHandler(["ok": false, "err": "unknown engine"], nil)
                return
            }
            let r = EngineGuard.persistIfUnset(engine)
            replyHandler(["ok": r.ok, "err": r.err], nil)

        case "complete":
            guard Permissions.allGranted() else {
                log(.warn, "onboarding complete ignored — required host permissions still not granted")
                replyHandler(["ok": false, "err": "permissions not granted"], nil)
                return
            }
            guard PairingManager.shared.hasPairedClient() else {
                log(.warn, "onboarding complete ignored — no proven paired client")
                replyHandler(["ok": false, "err": "client not paired"], nil)
                return
            }
            replyHandler(["ok": true], nil)
            finish()

        default:
            replyHandler(nil, "rpbridge: unknown method \(method)")
        }
    }

    // MARK: - helpers

    private func openPane(_ key: String) {
        let urls = [
            "login": "x-apple.systempreferences:com.apple.preferences.sharing?Services_RemoteLogin",
            "ax": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            "sr": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            "fda": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
            "sharing": "x-apple.systempreferences:com.apple.preferences.sharing?Services_PersonalFileSharing",
        ]
        guard let s = urls[key], let url = URL(string: s) else { return }
        NSWorkspace.shared.open(url)
    }

    private static func intArg(_ value: Any?) -> Int? {
        if let i = value as? Int { return i }
        if let d = value as? Double { return Int(d) }
        if let n = value as? NSNumber { return n.intValue }
        return nil
    }

    private static func clampOnboardingStep(_ n: Int) -> Int {
        min(max(n, 0), onboardingStepMax)
    }

    private static func readOnboardingStep() -> Int {
        let url = URL(fileURLWithPath: onboardingStepPath)
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = intArg(obj["step"]) else {
            return 0
        }
        return clampOnboardingStep(raw)
    }

    private static func writeOnboardingStep(_ n: Int) throws {
        try FileManager.default.createDirectory(atPath: RP_DIR, withIntermediateDirectories: true)
        let step = clampOnboardingStep(n)
        let data = try JSONSerialization.data(withJSONObject: ["step": step], options: [])
        try data.write(to: URL(fileURLWithPath: onboardingStepPath), options: [.atomic])
    }

    private func tearDownWebViewBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "rpbridge")
        controller.removeAllUserScripts()
        self.webView = nil
    }

    /// Install a minimal Edit menu so the onboarding WKWebView's text fields get the standard
    /// clipboard shortcuts. The host runs as a menu-bar accessory with no application menu, so
    /// Cmd+C/V/X/A have no key-equivalents to route to the first responder; show() flips the app to
    /// .regular, which surfaces this menu bar. macOS-only app, so no cross-platform guard is needed.
    /// The previous main menu is saved and restored in windowWillClose so nothing lingers afterward.
    private func installEditMenu() {
        previousMainMenu = NSApp.mainMenu
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem()
        editItem.submenu = edit
        let bar = NSMenu()
        bar.addItem(editItem)
        NSApp.mainMenu = bar
    }

    /// React Done → complete(): close the window and start serving.
    private func finish() {
        completed = true
        // Consent was already persisted via setConsent during onboarding. Re-run the Sentry gate so
        // an opt-in chosen here takes effect THIS session without a restart. Safe: startup ran with
        // consent OFF (Noop backend), so this is the first real init when crash consent is now ON.
        SentryBridge.setupIfConsented()
        log(.info, "onboarding complete → starting serving")
        tearDownWebViewBridge()
        window.close()
        // Revert to menu-bar-only (LSUIElement) now that onboarding is done.
        NSApp.setActivationPolicy(.accessory)
        onComplete()
    }

    // MARK: - NSWindowDelegate (hard gate)

    func windowWillClose(_ notification: Notification) {
        // Revert the onboarding Edit menu — the host goes back to menu-bar-only with no app menu.
        NSApp.mainMenu = previousMainMenu
        _ = PairingManager.shared.endWindow()
        tearDownWebViewBridge()
        switch mode {
        case .runGate:
            // Launch gate: required permissions are the hard serving gate. If they are granted, closing
            // the window before pairing must still start serving so the host becomes pairable; pairing
            // can finish later from the Connect flow/menu. If any required permission is missing, keep
            // failing closed.
            if !completed && Permissions.allGranted() {
                completed = true
                SentryBridge.setupIfConsented()
                log(.info, "onboarding dismissed after required permissions — starting serving")
                NSApp.setActivationPolicy(.accessory)
                onComplete()
            } else if !completed {
                log(.warn, "onboarding dismissed without required host permissions — quitting (hard gate)")
                NSApp.terminate(nil)
            }
        case .grantOnly:
            // Menu-bar "Grant Permissions…": the app is already running — closing must NOT quit it.
            // Just revert the temporary .regular activation policy show() set back to menu-bar-only
            // (finish() already does this on the completed path).
            if !completed { NSApp.setActivationPolicy(.accessory) }
        }
    }
}
