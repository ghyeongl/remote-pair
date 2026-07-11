// AppDelegate.swift — menu bar (NSStatusItem) + dynamic session list + permissions/update/About routing.
//
// Separation of responsibilities: tmux host=HostManager, approve=ApproveManager, session query/control=Sessions,
//            permissions=Permissions, updates=Updater, setup/onboarding=OnboardingWindow.
// The menu redraws the session list on every open via NSMenuDelegate.menuNeedsUpdate.

import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let host = HostManager()
    let approve = ApproveManager()
    let lanBeacon = LanBeacon()   // LAN discovery: broadcast host hints (host role only)
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    var hostTimer: Timer?
    var tickTimer: Timer?
    var onboarding: OnboardingWindow?   // shown while required host permissions are ungranted
    var grantWindow: OnboardingWindow?  // menu-bar "Grant Permissions…" — onboarding deep-linked to the Permissions step

    func applicationDidFinishLaunching(_ note: Notification) {
        ensureDirs()
        XpairAuthorizedKeys.expirePendingProofs()
        XpairAuthorizedKeys.reconcileForwardingAllowlist()   // migrate keys paired under the old narrow permitopen
        // Telemetry consent flags — both default OFF (opt-in). Registered so a never-toggled key reads false
        // (zero network calls by default).
        UserDefaults.standard.register(defaults: [
            TelemetryClient.consentKey: false,
            SentryBridge.consentKey: false,
        ])
        // On next launch after a signal crash, upload any appended crash-host-signal.log as a Sentry envelope
        // (local dump kept). No-op unless crash reporting is active (consent ON + DSN + SDK linked).
        SentryBridge.uploadPendingSignalCrashIfAny()
        // Single-instance guard: prevent the churn (the gh-mac-m4 incident) where two instances
        // (LaunchAgent + manual open) reap each other's _keeper on the same tmux-aqua socket.
        // I yield and terminate **only when an older (lower-pid) instance exists**.
        // → Prevents both instances terminating + converges within at most one cycle even in the
        //   dying-previous-instance race of launchctl kickstart -k.
        let myPid = ProcessInfo.processInfo.processIdentifier
        let older = NSRunningApplication.runningApplications(withBundleIdentifier: BUNDLE_ID)
            .filter { $0.processIdentifier != myPid && $0.processIdentifier < myPid && !$0.isTerminated }
        if !older.isEmpty {
            log("launch: an older XpairHost instance (pid \(older.map { $0.processIdentifier })) is running — terminating duplicate")
            NSApp.terminate(nil); return
        }
        Installer.ensureInstalled()     // self-install on first run of a downloaded .app (no-op if already installed)
        // D2: when the SSH front door is enabled, ensure the privileged hardening (-R denial + pf tailnet
        // bind) is applied. Verify at launch; the one-time GUI admin prompt only appears if missing/drifted.
        let d2Flag = "\(RP_DIR)/d2-frontdoor.enabled"
        if FileManager.default.fileExists(atPath: d2Flag), !D2Hardening.applied() {
            if !D2Hardening.apply() {
                // Fail SAFE: hardening didn't apply, so do NOT run the D2 front door unhardened (-R open,
                // physical :22 open). Disable the flag → the gate falls back to the legacy path until the
                // next launch re-prompts and it succeeds.
                try? FileManager.default.removeItem(atPath: d2Flag)
                log(.error, "D2 hardening not applied (admin prompt cancelled/failed) — disabled the D2 front door (removed \(d2Flag)); re-enable to retry")
            }
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // Menu-bar icon: monochrome template (auto-adapts to light/dark menu bar).
        // Loaded by name from Resources (menubar.png + menubar@2x.png). Falls back to text glyph.
        if let img = NSImage(named: NSImage.Name("menubar")) {
            img.isTemplate = true
            img.size = NSSize(width: 18, height: 18)
            statusItem.button?.image = img
        } else {
            statusItem.button?.title = "⌗⌘"
        }

        menu = NSMenu()
        menu.delegate = self           // rebuilt each time via menuNeedsUpdate
        statusItem.menu = menu
        rebuildMenu()
        log("launched (XpairHost v\(APP_VERSION), repo=\(GH_REPO))")

        // The tick loop (heartbeat + writeStatus + approve/onboarding triggers) ALWAYS runs — even while
        // gated — because writeStatus() drives status.json, which the onboarding WKWebView polls for
        // grant status. Serving (HostManager/ScreenServer/pairing/advertising) is gated below.
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
        // (legacy v0 InputServer 0.1s main-thread polling removed — screencapture's synchronous blocking froze the menu bar.
        //  Screen sharing is replaced by v1/v2 (xpair-screen serve-webrtc, view-only, no remote input).)

        // LAN beacon starts BEFORE the permission run-gate (the lifecycle Bonjour had): a fresh
        // host mid-onboarding is exactly when a LAN client must be able to list it and send the
        // pairing request — gating the beacon on startServing() would deadlock LAN-only setups
        // (onboarding completes only after a client pairs). Secret-free hint; safe pre-grant.
        if isHostRole { lanBeacon.ensureAdvertising() }

        // Hard run-gate. The host needs Accessibility (approve auto-click via cliclick/System Events),
        // Screen Recording (screen-share + approve OCR), Remote Login, and File Sharing. If any required
        // permission is ungranted, show the in-process onboarding window and DO NOT start serving until
        // the React flow completes. Dismissing the window while still ungranted terminates the app
        // (enforced in OnboardingWindow.windowWillClose).
        if !Permissions.allGranted() {
            log(.warn, "required host permissions not granted — showing onboarding (serving gated)")
            // Pre-register the app in the Accessibility + Screen Recording TCC lists so the user only
            // has to flip the toggle ON in System Settings (no "+"/drag-in). request() calls
            // AXIsProcessTrustedWithOptions / CGRequestScreenCaptureAccess, which add the (off) entries.
            Permissions.request("ax")
            Permissions.request("sr")
            let ob = OnboardingWindow(onComplete: { [weak self] in
                self?.onboarding = nil
                // Dismissing the run gate after required permissions are granted but BEFORE a client pairs must still
                // leave the host pairable: start serving AND (re)open a Connect/Broadcast pairing window
                // exactly like the already-granted launch path. windowWillClose called endWindow(), so
                // without this the host advertises presence but no live pairing metadata and every client
                // filters it out.
                self?.startServingAndOpenPairingIfNeeded()
            })
            onboarding = ob
            ob.show()
        } else {
            startServingAndOpenPairingIfNeeded()
        }
    }

    /// startServing() + open a grant-only Connect/Broadcast window when the host has no paired client yet,
    /// so it advertises a LIVE pairing window (serviceInstanceID/hostNonce/pairPort) that clients can
    /// discover. Shared by the launch-already-granted path and the run-gate dismiss path.
    private func startServingAndOpenPairingIfNeeded() {
        startServing()
        if isHostRole && !PairingManager.shared.hasPairedClient() {
            let ob = OnboardingWindow(mode: .grantOnly, initialStep: "connect",
                                      onComplete: { [weak self] in self?.grantWindow = nil })
            grantWindow = ob
            ob.show()
        }
    }

    /// Begins the serving path: tmux host, screen sidecar (via HostManager), LAN advertising, and the 5 s
    /// watchdog. Called at launch when required permissions are already granted, or from the onboarding
    /// onComplete once the user grants it. Idempotent enough to call once per launch.
    private func startServing() {
        host.ensureServer()
        if isHostRole { lanBeacon.ensureAdvertising() }   // advertise on launch (host/both only)
        hostTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.host.ensureServer()
            if isHostRole { self.lanBeacon.ensureAdvertising() }   // watchdog: restart beacon if needed
        }
    }

    func applicationWillTerminate(_ note: Notification) {
        lanBeacon.stop()
    }

    // ── dynamic menu ──
    func menuNeedsUpdate(_ menu: NSMenu) { rebuildMenu() }

    private func rebuildMenu() {
        menu.removeAllItems()

        let header = NSMenuItem(title: "\(APP_NAME) v\(APP_VERSION)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        // permission status + grant. One short row per permission (full names, line-broken) so the
        // dropdown stays narrow instead of one long summary line. (Grant item: host/both only.)
        let permHeader = NSMenuItem(title: "Permissions", action: nil, keyEquivalent: "")
        permHeader.isEnabled = false
        menu.addItem(permHeader)
        for (name, granted) in [("Accessibility", Permissions.axTrusted()),
                                ("Screen Recording", Permissions.srGranted()),
                                ("Full Disk", Permissions.fdaGranted()),
                                ("Remote Login", Permissions.loginGranted()),
                                ("File Sharing", Permissions.sharingGranted())] {
            let row = NSMenuItem(title: "   \(name)  \(granted ? "✓" : "✗")", action: nil, keyEquivalent: "")
            row.isEnabled = false
            menu.addItem(row)
        }
        if isHostRole {
            menu.addItem(withTitle: "Permissions…", action: #selector(grantPermissions), keyEquivalent: "")
        }
        menu.addItem(.separator())

        // Screen share status (host only). 0.5 is view-only — the host streams its screen, never
        // accepts remote input — so this is a status line, not a toggle.
        if isHostRole {
            let shr: String
            if host.screen.viewerConnected { shr = "Screen share: viewer connected" }
            else if host.screen.serving    { shr = "Screen share: ready (view-only)" }
            else                           { shr = "Screen share: off" }
            let si = NSMenuItem(title: shr, action: nil, keyEquivalent: "")
            si.isEnabled = false
            menu.addItem(si)
            menu.addItem(.separator())

            // Connected clients (host only). Read-only status — no click action, no disconnect. The
            // menu rebuilds on each open (menuNeedsUpdate) so this stays fresh. A client counts as
            // connected if its heartbeat ts is within ConnectedClients.freshnessSec of now.
            let clientHeader = NSMenuItem(title: "Clients", action: nil, keyEquivalent: "")
            clientHeader.isEnabled = false
            menu.addItem(clientHeader)
            let clients = ConnectedClients.list()
            if clients.isEmpty {
                let none = NSMenuItem(title: "   (none connected)", action: nil, keyEquivalent: "")
                none.isEnabled = false
                menu.addItem(none)
            } else {
                for c in clients {
                    let row = NSMenuItem(title: "   \(c.name)  (\(c.user))", action: nil, keyEquivalent: "")
                    row.isEnabled = false
                    menu.addItem(row)
                }
            }
            menu.addItem(.separator())
        }

        // session list (server status + each session → modal on click), grouped Attached / Detached.
        let serverUp = Sessions.serverUp()
        let sessions = serverUp ? Sessions.list() : []
        let shdr = NSMenuItem(title: serverUp ? "Sessions (\(sessions.count))" : "tmux host: down",
                              action: nil, keyEquivalent: "")
        shdr.isEnabled = false
        menu.addItem(shdr)
        if sessions.isEmpty {
            let none = NSMenuItem(title: serverUp ? "  (no active sessions)" : "  (server not running)",
                                  action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        } else {
            let attached = sessions.filter { $0.attached > 0 }
            let detached = sessions.filter { $0.attached <= 0 }
            // Render a disabled subheader per non-empty group, then its sessions.
            func appendSession(_ s: TmuxSession) {
                let it = NSMenuItem(title: "  \(s.name)", action: #selector(sessionClicked(_:)), keyEquivalent: "")
                it.representedObject = s.name
                it.target = self
                menu.addItem(it)
            }
            if !attached.isEmpty {
                let h = NSMenuItem(title: "Attached", action: nil, keyEquivalent: "")
                h.isEnabled = false
                menu.addItem(h)
                for s in attached { appendSession(s) }
            }
            if !detached.isEmpty {
                let h = NSMenuItem(title: "Detached", action: nil, keyEquivalent: "")
                h.isEnabled = false
                menu.addItem(h)
                for s in detached { appendSession(s) }
            }
        }
        menu.addItem(.separator())

        // "Connect…" (host only): deep-link the onboarding to the client-connection guide step.
        if isHostRole {
            menu.addItem(withTitle: "Connect…", action: #selector(connectClient), keyEquivalent: "")
        }
        // "Set up…" IS the onboarding (replaces the old Settings window): open the whole flow from
        // scratch (Welcome). initialStep nil → no deep-link.
        menu.addItem(withTitle: "Set up…", action: #selector(openSetup), keyEquivalent: ",")
        menu.addItem(withTitle: "Check for Updates…", action: #selector(checkUpdates), keyEquivalent: "")
        menu.addItem(withTitle: "About \(APP_NAME)", action: #selector(about), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    // ── session click → confirm-terminate modal ──
    @objc private func sessionClicked(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        let list = Sessions.list()
        guard let s = list.first(where: { $0.name == name }) else { return }

        let a = NSAlert()
        a.messageText = "Terminate session '\(s.name)'?"
        a.informativeText = "The processes inside this session (claude, etc.) will be cleaned up. This cannot be undone."
        a.alertStyle = .warning
        a.addButton(withTitle: "Terminate")   // .alertFirstButtonReturn
        a.addButton(withTitle: "Cancel")      // .alertSecondButtonReturn
        bringToFront()
        if a.runModal() == .alertFirstButtonReturn { Sessions.kill(s.name) }
    }

    // ── steady-state loop: heartbeat + status (ground truth) + trigger check (all lightweight) ──
    @objc func poll() {
        do { try "".write(toFile: HEARTBEAT, atomically: false, encoding: .utf8) }
        catch { log(.debug, "heartbeat write failed: \(error)") }   // ignorable: next tick (1s) retries
        writeStatus()   // write app liveness + AX/SR/FDA grant facts to status.json — so the agent reads them without guessing
        if FileManager.default.fileExists(atPath: TRIGGER) {
            do { try FileManager.default.removeItem(atPath: TRIGGER) }
            catch { log(.warn, "approve: removing trigger \(TRIGGER) failed (router may re-fire): \(error)") }
            log("trigger → router")
            approve.run()
        }
        // (Removed: /tmp/xpair.grant-request and .install-request trigger-file handlers. Those
        // bridged the OLD standalone Electron onboarding — a separate process that signalled the app
        // via files. Onboarding is now in-process (OnboardingWindow's WKWebView bridge calls
        // Permissions.request / Installer directly), so nothing writes those files anymore.)
    }

    @objc func grantPermissions() {
        // Open the in-app onboarding deep-linked to the Permissions step. Grant-only mode: the app is
        // already running, so closing the window does NOT quit it (unlike the launch run-gate). Pre-
        // register the TCC entries so the user only flips the toggles in System Settings.
        Permissions.request("ax"); Permissions.request("sr")
        let ob = OnboardingWindow(mode: .grantOnly, initialStep: "permissions",
                                  onComplete: { [weak self] in self?.grantWindow = nil })
        grantWindow = ob
        ob.show()
    }

    @objc func connectClient() {
        // Open the in-app onboarding deep-linked to the client-connection guide step (host only).
        // Grant-only mode: closing the window does NOT quit the running app.
        let ob = OnboardingWindow(mode: .grantOnly, initialStep: "connect",
                                  onComplete: { [weak self] in self?.grantWindow = nil })
        grantWindow = ob
        ob.show()
    }

    @objc func openSetup() {
        // "Set up…" IS the onboarding: open the whole flow from scratch (Welcome). Grant-only mode so
        // closing it never quits the running app. initialStep nil → no deep-link.
        let ob = OnboardingWindow(mode: .grantOnly, initialStep: nil,
                                  onComplete: { [weak self] in self?.grantWindow = nil })
        grantWindow = ob
        ob.show()
    }

    @objc func checkUpdates() { Updater.checkForUpdates(interactive: true) }

    @objc func about() {
        let a = NSAlert()
        a.messageText = "\(APP_NAME)  v\(APP_VERSION)"
        a.informativeText = """
        Hosts a tmux daemon on a remote Mac so that a claude attached remotely (mosh/ssh) \
        can use macOS computer-use (screenshots, clicks, typing).

        • Holds the patched tmux-aqua server as a child of the app to inherit AX/SR permissions
        • Auto-clicks approval dialogs (approve router)
        • Clients connect via the 'xpair' CLI + Finder Service

        repo: github.com/\(GH_REPO)
        """
        a.addButton(withTitle: "Open GitHub")
        a.addButton(withTitle: "OK")
        bringToFront()
        if a.runModal() == .alertFirstButtonReturn,
           let u = URL(string: "https://github.com/\(GH_REPO)") {
            NSWorkspace.shared.open(u)
        }
    }
}
