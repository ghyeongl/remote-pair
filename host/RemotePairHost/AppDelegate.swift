// AppDelegate.swift — 메뉴바(NSStatusItem) + 동적 세션 목록 + 권한/설정/업데이트/About 라우팅.
//
// 책임 분리: tmux host=HostManager, approve=ApproveManager, 세션조회/제어=Sessions,
//            권한=Permissions, 업데이트=Updater, 설정창=SettingsWindowController.
// 메뉴는 NSMenuDelegate.menuNeedsUpdate 로 매 오픈마다 세션 목록을 새로 그린다.

import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let host = HostManager()
    let approve = ApproveManager()
    let inputsrv = InputServer()              // CLI 두뇌가 요청하는 권한 primitive(스샷/클릭/키) 실행기
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    var hostTimer: Timer?
    var tickTimer: Timer?
    var inputTimer: Timer?
    var settings: SettingsWindowController?

    func applicationDidFinishLaunching(_ note: Notification) {
        ensureDirs()
        Installer.ensureInstalled()     // 다운로드된 .app 첫 실행 자기설치 (이미 설치돼 있으면 no-op)
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
        menu.delegate = self           // menuNeedsUpdate 로 매번 재구성
        statusItem.menu = menu
        rebuildMenu()

        log("launched (RemotePairHost v\(APP_VERSION), repo=\(GH_REPO))")
        host.ensureServer()
        hostTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.host.ensureServer() }
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
        // CLI 두뇌의 primitive 요청을 빠르게 처리(저지연 클릭/스샷). 권한 사용은 여기(앱) 안에서만.
        inputTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.inputsrv.tick() }

        if UserDefaults.standard.bool(forKey: SettingsWindowController.autoUpdateKey) {
            Updater.checkForUpdates(interactive: false)
        }
    }

    // ── 동적 메뉴 ──
    func menuNeedsUpdate(_ menu: NSMenu) { rebuildMenu() }

    private func rebuildMenu() {
        menu.removeAllItems()

        let header = NSMenuItem(title: "\(APP_NAME) v\(APP_VERSION)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        // 권한 상태 + 부여
        let perm = NSMenuItem(title: Permissions.summary(), action: nil, keyEquivalent: "")
        perm.isEnabled = false
        menu.addItem(perm)
        menu.addItem(withTitle: "Grant Permissions…", action: #selector(grantPermissions), keyEquivalent: "")
        menu.addItem(.separator())

        // 세션 목록 (서버 상태 + 각 세션 → 클릭 시 모달)
        let serverUp = Sessions.serverUp()
        let sessions = serverUp ? Sessions.list() : []
        let shdr = NSMenuItem(title: serverUp ? "Sessions (\(sessions.count))" : "tmux host: down",
                              action: nil, keyEquivalent: "")
        shdr.isEnabled = false
        menu.addItem(shdr)
        if sessions.isEmpty {
            let none = NSMenuItem(title: serverUp ? "  (활성 세션 없음)" : "  (서버 미기동)",
                                  action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        } else {
            for s in sessions {
                let label = "  \(s.name)   (\(s.attached > 0 ? "attached ×\(s.attached)" : "detached"))"
                let it = NSMenuItem(title: label, action: #selector(sessionClicked(_:)), keyEquivalent: "")
                it.representedObject = s.name
                it.target = self
                menu.addItem(it)
            }
        }
        menu.addItem(withTitle: "Restart tmux host", action: #selector(restartHost), keyEquivalent: "")
        menu.addItem(withTitle: "Repair install", action: #selector(repairInstall), keyEquivalent: "")
        menu.addItem(.separator())

        menu.addItem(withTitle: "Approve now", action: #selector(approveNow), keyEquivalent: "")
        menu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        menu.addItem(withTitle: "Check for Updates…", action: #selector(checkUpdates), keyEquivalent: "")
        menu.addItem(withTitle: "About \(APP_NAME)", action: #selector(about), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    // ── 세션 클릭 → 모달 (Detach all / Kill / Cancel) ──
    @objc private func sessionClicked(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        let list = Sessions.list()
        guard let s = list.first(where: { $0.name == name }) else { return }

        let a = NSAlert()
        a.messageText = "세션: \(s.name)"
        var detail = "경로: \(s.path.isEmpty ? "?" : s.path)\nattached: \(s.attached)  windows: \(s.windows)"
        if let c = s.created {
            let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm"
            detail += "\n생성: \(f.string(from: c))"
        }
        a.informativeText = detail
        a.addButton(withTitle: "Detach all")     // .alertFirstButtonReturn
        a.addButton(withTitle: "Kill session")   // .alertSecondButtonReturn
        a.addButton(withTitle: "Cancel")         // .alertThirdButtonReturn
        bringToFront()
        switch a.runModal() {
        case .alertFirstButtonReturn:
            Sessions.detachAll(s.name)
        case .alertSecondButtonReturn:
            let c = NSAlert()
            c.messageText = "세션 '\(s.name)' 종료?"
            c.informativeText = "이 세션 안의 프로세스(claude 등)가 정리됩니다. 되돌릴 수 없습니다."
            c.addButton(withTitle: "Kill"); c.addButton(withTitle: "Cancel")
            c.alertStyle = .warning
            bringToFront()
            if c.runModal() == .alertFirstButtonReturn { Sessions.kill(s.name) }
        default:
            break
        }
    }

    // ── 평소 루프: heartbeat + status(ground truth) + 트리거 확인 (모두 가벼움) ──
    @objc func poll() {
        try? "".write(toFile: HEARTBEAT, atomically: false, encoding: .utf8)
        writeStatus()   // 앱 생존 + AX/SR/FDA grant 사실을 status.json 에 — 에이전트가 추측 없이 읽도록
        if FileManager.default.fileExists(atPath: TRIGGER) {
            if approve.run(triggerBacked: true) {
                try? FileManager.default.removeItem(atPath: TRIGGER)
                log("APPROVE: trigger → router")
            }
        }
    }

    @objc func grantPermissions() { Permissions.requestAndOpen() }
    @objc func approveNow() {
        if FileManager.default.fileExists(atPath: TRIGGER) {
            if approve.run(triggerBacked: true) {
                try? FileManager.default.removeItem(atPath: TRIGGER)
                log("APPROVE: manual action consumed queued trigger → router")
            }
        } else {
            approve.run()
        }
    }
    @objc func restartHost() {
        // 진짜 재시작(서버+세션 reap 후 재기동) — 활성 세션 있으면 끊김 경고 후 진행.
        let n = Sessions.serverUp() ? Sessions.list().count : 0
        if n > 0 {
            let a = NSAlert()
            a.messageText = "Restart tmux host?"
            a.informativeText = "⚠ \(n) active session(s) will be disconnected. "
                + "Conversation transcripts are preserved — re-launch the same folder to resume."
            a.addButton(withTitle: "Restart")
            a.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard a.runModal() == .alertFirstButtonReturn else { return }
        }
        host.forceRestart()
    }
    @objc func checkUpdates() { Updater.checkForUpdates(interactive: true) }

    @objc func repairInstall() {
        Installer.install(force: false)   // 누락 조각 재적용 (안전: 기존 파일/실행 중 인스턴스 보존)
        rebuildMenu()
    }

    @objc func openSettings() {
        if settings == nil { settings = SettingsWindowController() }
        settings?.show()
    }

    @objc func about() {
        let a = NSAlert()
        a.messageText = "\(APP_NAME)  v\(APP_VERSION)"
        a.informativeText = """
        원격 맥에서 tmux 데몬을 호스팅해, 원격(mosh/ssh) attach 한 claude 가 \
        macOS computer-use(스크린샷·클릭·타이핑)를 쓸 수 있게 한다.

        • patched tmux-aqua 서버를 앱 자식으로 붙들어 AX·SR 권한 상속
        • 승인 다이얼로그 자동 클릭(approve 라우터)
        • 클라이언트는 'remote-pair' CLI + Finder Service 로 접속

        repo: github.com/\(GH_REPO)
        """
        a.addButton(withTitle: "GitHub 열기")
        a.addButton(withTitle: "확인")
        bringToFront()
        if a.runModal() == .alertFirstButtonReturn,
           let u = URL(string: "https://github.com/\(GH_REPO)") {
            NSWorkspace.shared.open(u)
        }
    }
}
