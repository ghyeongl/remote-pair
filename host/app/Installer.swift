// Installer.swift — self-install on the first launch of a downloaded .app.
//
// So that an .app obtained from GitHub Releases becomes a working host even without
// shared/install.sh, ensureInstalled() is called on every launch. If already installed it is
// an immediate no-op (files/launchctl untouched).
// install(force:) produces the same state as the is_host section of shared/install.sh (identical labels, plist, paths).
//
// SSOT note: the labels/plist shape/paths must match shared/config.sh + shared/install.sh character for character.

import Cocoa

enum Installer {
    // Identifiers matching shared/config.sh (derived from this app bundle)
    static let RP_ORG = "com.x10lab"
    static let APP_LABEL = BUNDLE_ID                       // = BUNDLE_PREFIX (Info.plist CFBundleIdentifier)
    static let WATCHDOG_LABEL = "\(BUNDLE_ID)-watchdog"
    static let LAUNCH_AGENTS = "\(HOME)/Library/LaunchAgents"
    static let LOCAL_BIN = "\(HOME)/.local/bin"
    static let COMMON_ENV = "\(RP_DIR)/common.env"
    static let HOST_ENV = "\(RP_DIR)/host.env"
    static let WATCHDOG_SH = "\(RP_DIR)/bin/xpair-watchdog.sh"
    static let APP_EXEC = Bundle.main.executablePath ?? "/Applications/\(APP_NAME).app/Contents/MacOS/\(APP_NAME)"

    private static var fm: FileManager { FileManager.default }
    private static var appPlist: String { "\(LAUNCH_AGENTS)/\(APP_LABEL).plist" }
    private static var wdPlist: String { "\(LAUNCH_AGENTS)/\(WATCHDOG_LABEL).plist" }

    private static var versionFile: String { "\(RP_DIR)/.version" }

    /// Called on every launch. If "installed + same version", it is a true no-op (does not touch the running tmux server).
    /// If installed but the version went up, only resources (skills/rules/tmux-aqua) are refreshed — this prevents
    /// the case where only the app changes to the new version while ~/.xpair/host / ~/.claude resources remain old
    /// (common to app replacement / in-app update).
    /// grant / LaunchAgent / host.env (user settings) are left untouched.
    ///
    /// ── M6 LEVEL-1 (hot update) non-interference guarantee ──────────────────────────────────────
    /// glue/web (CLI / rules / skills / web / hooks) changes are hot-swapped on disk by the CLI
    /// (`xpair update`) — no .app/tmux restart. The app's role is **not to interfere** with that:
    ///   • Same version → true no-op. Never touches the tmux server / LaunchAgent / grant (hot-swap protection).
    ///   • Version up → only refresh resources (tmux-aqua link / env alignment), preserving grant / LaunchAgent / host.env.
    /// In other words, even if a LEVEL-1 hot-swap changes disk resources, the app does not revert them or trigger a restart.
    /// (LEVEL-2, which requires a native restart, is handled by the gate in Updater.swift.)
    /// Is this a machine/launch where host self-install must not happen? (gh-mac-m4 incident: a client laptop opened a
    /// build/ app once and got self-installed as a host — blocking that case.) ① launched from a non-installed location
    /// (repo build/) ② real client role marker ③ client.env with REMOTE_HOST but no host.env (a client install, not a host) →
    /// skip if any one is true. Telemetry-only client.env is not a client install signal.
    static func shouldSkipSelfInstall() -> Bool {
        let p = Bundle.main.bundlePath
        if !(p.hasPrefix("/Applications/") || p.hasPrefix("\(HOME)/Applications/")) {
            log(.warn, "launched from non-installed location (\(p)) — refusing host self-install (build/dev launch guard)")
            return true
        }
        if roleFileContainsClient(ROLE_FILE) || roleFileContainsClient(CLIENT_ROLE_FILE) {
            log(.info, "client role marker — skipping host self-install")
            return true
        }
        if clientEnvHasRemoteHost() && !fm.fileExists(atPath: HOST_ENV) {
            log(.info, "client.env REMOTE_HOST + no host.env — treating as client, skipping host self-install")
            return true
        }
        return false
    }

    static func ensureInstalled() {
        if shouldSkipSelfInstall() { return }
        let installed = fm.fileExists(atPath: appPlist) && fm.fileExists(atPath: HOST_ENV)
        let stamped: String
        do {
            stamped = try String(contentsOfFile: versionFile, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            // Missing version stamp is normal on first install / pre-stamp builds — trace and treat as unstamped.
            log(.debug, "version stamp read skipped (\(versionFile)): \(error)")
            stamped = ""
        }
        if installed && stamped == APP_VERSION { return }                 // LEVEL-1: same version → true no-op (no hot-swap/tmux interference)
        if installed {
            log(.info, "version \(stamped.isEmpty ? "(none)" : stamped) → \(APP_VERSION) — refreshing resources (grant/config preserved)")
            install(force: false, refreshResources: true)                 // LEVEL-1: version up → refresh resources only (preserve grant/LaunchAgent)
        } else {
            log(.info, "not fully installed (plist=\(fm.fileExists(atPath: appPlist)) host.env=\(fm.fileExists(atPath: HOST_ENV))) → installing")
            install(force: false)
        }
    }

    /// Host install steps — mirrors the is_host section of shared/install.sh.
    /// If refreshResources=true, rules.txt is refreshed to the new bundle even without force (so resources follow on a version up).
    static func install(force: Bool, refreshResources: Bool = false) {
        // Direct call paths such as repairInstall also refuse a non-installed location (build/) — so the LaunchAgent does not point at a dev tree.
        let bp = Bundle.main.bundlePath
        if !(bp.hasPrefix("/Applications/") || bp.hasPrefix("\(HOME)/Applications/")) {
            log(.warn, "install() refused — launched from non-installed location (\(bp))")
            return
        }
        log(.info, "begin (force=\(force) refreshResources=\(refreshResources))")
        ensureDir(RP_DIR)
        ensureDir(LOG_DIR)
        ensureDir("\(RP_DIR)/bin")
        // role marker: if install.sh did not lay it down (pure cask install), record as host. If already present, respect it (both/host).
        if !fm.fileExists(atPath: ROLE_FILE) {
            do { try "host\n".write(toFile: ROLE_FILE, atomically: true, encoding: .utf8) }
            catch { log(.warn, "role marker write failed (\(ROLE_FILE)): \(error)") }
        }

        // 1. env files (host.env: HOST_KEYS defaults, common.env: COMMON_KEYS)
        writeEnv(COMMON_ENV, [
            ("LOCAL_BIN", LOCAL_BIN),
            ("AQUA_SOCK", SOCKET),
        ], onlyIfAbsent: false)                            // common is always identical → refreshing it is harmless
        writeEnv(HOST_ENV, [
            ("RP_ORG", RP_ORG),
            ("BUNDLE_PREFIX", BUNDLE_ID),
            ("APP_NAME", APP_NAME),
            ("SIGN_CN", "RemotePair Local Signing"),
            ("GH_REPO", GH_REPO),
            ("APPROVE_TRIGGER", TRIGGER),
            ("LOG_FILE", LOGP),
            ("HEARTBEAT_FILE", HEARTBEAT),
            ("RULES_FILE", RULES_FILE),
        ], onlyIfAbsent: !force)

        // NOTE: rules.txt (approve config) + skills (claude harness) are not installed by the app (to keep coupling low).
        //       That is the job of the CLI/README single install (shared/install.sh). The app only brings up its own daemon.

        // 3.5 host notification hook mirror — so that a cask-only host (one that did not go through install.sh) also gets
        //     notification delivery, install/register xpair-notify.sh + manage-claude-hooks.py best-effort, the same way the CLI does.
        installNotifyHook()

        // 4. tmux-aqua symlink → bundled Helpers/tmux-aqua (replace if the link is wrong/stale)
        let tmuxSrc = "\(Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers").path)/tmux-aqua"
        let tmuxLink = "\(LOCAL_BIN)/tmux-aqua"
        if fm.fileExists(atPath: tmuxSrc) {
            ensureDir(LOCAL_BIN)
            // nil = no existing link (fresh install) — expected, not an error.
            let cur = try? fm.destinationOfSymbolicLink(atPath: tmuxLink)
            if cur != tmuxSrc {
                do { try fm.removeItem(atPath: tmuxLink) }
                catch { log(.debug, "tmux-aqua stale link remove skipped (\(tmuxLink)): \(error)") }
                do { try fm.createSymbolicLink(atPath: tmuxLink, withDestinationPath: tmuxSrc); log(.info, "tmux-aqua link → \(tmuxSrc)") }
                catch { log(.error, "tmux-aqua link failed: \(error)") }
            }
        } else { log(.warn, "bundled tmux-aqua not found (\(tmuxSrc))") }

        // 4a. mosh-server symlink → bundled Helpers/mosh-server (resilient-attach host side). The client
        //     attaches with `mosh --server=~/.local/bin/mosh-server`, so it must live in LOCAL_BIN next to
        //     tmux-aqua. OPTIONAL: unlike tmux-aqua, a missing mosh-server is not fatal — the CLI falls back
        //     to `ssh -t` when it is absent (so this is debug-logged, not a warning).
        let moshSrc = "\(Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers").path)/mosh-server"
        let moshLink = "\(LOCAL_BIN)/mosh-server"
        if fm.fileExists(atPath: moshSrc) {
            ensureDir(LOCAL_BIN)
            let cur = try? fm.destinationOfSymbolicLink(atPath: moshLink)
            if cur != moshSrc {
                do { try fm.removeItem(atPath: moshLink) }
                catch { log(.debug, "mosh-server stale link remove skipped (\(moshLink)): \(error)") }
                do { try fm.createSymbolicLink(atPath: moshLink, withDestinationPath: moshSrc); log(.info, "mosh-server link → \(moshSrc)") }
                catch { log(.error, "mosh-server link failed: \(error)") }
            }
        } else { log(.debug, "bundled mosh-server not found (\(moshSrc)) — attach uses ssh fallback") }

        // 4b. Screen-sharing symlinks → bundled Helpers/{screen,rp-screencap,rp-input-inject}.
        //     Resolves the stable path ~/.xpair/host/bin/<name> that extensions/docs call to the bundle's signed binary
        //     (after retiring SSH deploy, the bundle is the only delivery path). Being symlinks, on .app update they always
        //     point at the new bundle so there is no version skew, and the serve_webrtc resolver's current_exe().canonicalize()
        //     resolves the link to the real Helpers path to discover sibling helpers.
        //     If a stale real file (ad-hoc signed) left behind by the old SSH deploy exists, replace it with a symlink — so that
        //     grant resolves to the stable-cert binary (S3c stale cleanup). Same meaning as install.sh manifest reversibility.
        linkBundledBinaries(["screen", "rp-screencap", "rp-input-inject"])

        // 5. watchdog script + LaunchAgent plist (app + watchdog) — same shape as install.sh
        writeWatchdogScript()
        writeFile(appPlist, appPlistXML())
        writeFile(wdPlist, watchdogPlistXML())
        bootstrap(label: APP_LABEL, plist: appPlist)
        bootstrap(label: WATCHDOG_LABEL, plist: wdPlist)

        // version stamp → so the next launch can decide no-op. If this fails, the next launch re-runs install (idempotent) instead of no-op'ing.
        do { try APP_VERSION.write(toFile: versionFile, atomically: true, encoding: .utf8) }
        catch { log(.warn, "version stamp write failed (\(versionFile)) — next launch will re-run install: \(error)") }
        log(.info, "done (force=\(force) → version \(APP_VERSION))")
    }

    // ── host notification hook mirror (for cask-only hosts) ────────────────────────────────────
    //
    // Why: notification delivery starts with the host's Claude Code hook (xpair-notify.sh) writing events to a queue.
    //   install.sh (--role host) lays this down, but a host that received only the .app via cask never went through
    //   install.sh and has no hook → the client receives no notifications. So app self-install mirrors it the same way the CLI does.
    //
    // Approach (consistent with the approve/notify hook section of shared/install.sh):
    //   Source lookup order ① app bundle Contents/Helpers/hooks ② repo HOST_DIR/hooks (dev/source tree)
    //   If neither is present (pure cask + repo unreachable) → graceful skip: just log and pass.
    //   Install locations (character-for-character identical to install.sh — guarantees reversibility): notify.sh → $RP_DIR/bin/xpair-notify.sh,
    //             manage-claude-hooks.py → $RP_DIR/bin/ (idempotent JSON merger, same as install.sh)
    //   Registration: manage-claude-hooks.py add <settings> <approve_cmd> <notify_cmd> — preserves existing user hooks (idempotent).
    //     notify_cmd is registered with the same absolute path as install.sh ($RP_DIR/bin/xpair-notify.sh) →
    //     uninstall.sh's path-keyed remove (manage-claude-hooks.py remove) removes it exactly by the same key regardless of
    //     whether the CLI or the app registered it (blocks reversibility leaks).
    //   If python3 is absent, skip (install the skill/notification scripts but defer only hook registration) — the same conservative handling as install.sh.
    //
    // Reversibility (cask-only): a pure cask host that did not go through install.sh has no install.sh manifest. So
    //   what is installed/registered here is appended directly to $RP_DIR/.install-manifest in the TAB format of
    //   shared/lib.sh record() (FILE notify.sh + FILE manage-claude-hooks.py [+ FILE approve-reminder.sh],
    //   HOOKS <settings> <cmd>). uninstall.sh globs .install-manifest and reverts in reverse order, so there is no leak.
    //   (A separate file from the .manifest-host laid down by install.sh — no duplication/conflict.)
    //
    // best-effort: even if it fails, it does not block daemon bring-up (the body of install()).
    private static func installNotifyHook() {
        // python3 gate (manage-claude-hooks.py needs python3 for the idempotent JSON merge — macOS has no jq)
        guard let py = whichPython3() else {
            log("INSTALL: notify hook skip — no python3 (recommend install.sh --role host after installing CLT)")
            return
        }

        // Source lookup: ① bundle Helpers/hooks ② repo HOST_DIR/hooks
        let bundleHooks = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/hooks").path
        let repoHooks = repoHostHooksDir()
        let candidates = [bundleHooks, repoHooks].compactMap { $0 }
        var notifySrc: String?
        var managerSrc: String?
        var approveSrc: String?
        for base in candidates {
            let n = "\(base)/xpair-notify.sh"
            let m = "\(base)/manage-claude-hooks.py"
            if notifySrc == nil, fm.fileExists(atPath: n) { notifySrc = n }
            if managerSrc == nil, fm.fileExists(atPath: m) { managerSrc = m }
            let ar = "\(base)/approve-reminder.sh"
            if approveSrc == nil, fm.fileExists(atPath: ar) { approveSrc = ar }
        }

        guard let notify = notifySrc, let manager = managerSrc else {
            // cask-only + repo unreachable → notification hook source is not in the bundle. Graceful skip.
            log("INSTALL: notify hook skip — source unreachable (no notify.sh/manage-claude-hooks.py; normal if cask-only)")
            return
        }

        let claudeDir = "\(HOME)/.claude"
        let hooksDst = "\(claudeDir)/hooks"
        // FIX 9: unify to the same path as install.sh — notify.sh goes in $RP_DIR/bin (registered/reverted under the same key as the CLI).
        let notifyDst = "\(RP_DIR)/bin/xpair-notify.sh"
        let managerDst = "\(RP_DIR)/bin/manage-claude-hooks.py"
        let approveDst = "\(hooksDst)/xpair-approve-reminder.sh"   // same as install.sh (approve only)
        let settings = "\(claudeDir)/settings.json"

        // cask-only reversibility record target (a separate file from install.sh's .manifest-host). Records only newly created files/registrations.
        let manifest = "\(RP_DIR)/.install-manifest"
        var fileRecords: [String] = []     // record FILE <path>
        let settingsExisted = fm.fileExists(atPath: settings)

        // 1) Copy scripts (grant execute permission) — notify/manager all go in $RP_DIR/bin, approve goes in ~/.claude/hooks.
        ensureDir(hooksDst)
        ensureDir("\(RP_DIR)/bin")
        let notifyNew = !fm.fileExists(atPath: notifyDst)
        if !copyFile(notify, to: notifyDst, mode: 0o755) {
            log("INSTALL: notify hook skip — notify.sh copy failed")
            return
        }
        if notifyNew { fileRecords.append(notifyDst) }
        let managerNew = !fm.fileExists(atPath: managerDst)
        if !copyFile(manager, to: managerDst, mode: 0o755) {
            log("INSTALL: notify hook skip — manage-claude-hooks.py copy failed")
            return
        }
        if managerNew { fileRecords.append(managerDst) }

        // FIX 11: install and register the dedicated approve hook only when the approve-reminder source exists.
        //   If absent, SKIP approve identity registration (register only the notify hook) — do not alias to notifyDst.
        //   (Aliasing would attach notify.sh to the approve event and lose the dedicated approve-skill nudge — degraded behavior.)
        var approveCmdPath: String? = nil
        if let approve = approveSrc {
            let approveNew = !fm.fileExists(atPath: approveDst)
            if copyFile(approve, to: approveDst, mode: 0o755) {
                approveCmdPath = approveDst
                if approveNew { fileRecords.append(approveDst) }
            } else {
                log("INSTALL: approve-reminder copy failed — skipping approve registration (notify hook only)")
            }
        } else {
            log("INSTALL: no approve-reminder source — skipping approve registration (notify hook only, no aliasing)")
        }

        // 2) Idempotent registration: manage-claude-hooks.py add <settings> <approve_cmd> <notify_cmd>
        //    (python add mode merges the approve family + Stop/Notification/SubagentStop hooks in one shot. Preserves existing hooks.)
        //    If approve is absent an empty argument would create a garbage entry, so when approve is missing pass the notify path
        //    as the approve argument too — thanks to python's has_ours(substring) idempotency, only the notify entry is registered once (duplicates ignored).
        //    That is, it achieves "no approve identity registered + notify only", and manifest HOOKS also records just the one notify line.
        let approveArg = approveCmdPath ?? notifyDst
        let r = runCapture(py, [managerDst, "add", settings, approveArg, notifyDst])
        if r.status == 0 {
            log("INSTALL: notify hook registered ok (\(settings))")
            // 3) cask-only reversibility record — meaningful only when there is no install.sh manifest (no .manifest-* glob present).
            //    If the host was already laid down by install.sh, its .manifest-host handles the revert, so we only need to avoid duplicate records:
            //    the record here goes to .install-manifest (a separate file), so it does not conflict with install.sh's .manifest-host.
            //    On re-run (version-up refresh), if add is a no-op there are no new HOOKS, so omit the HOOKS record (prevents manifest bloat).
            //    Record HOOKS/new settings only when add actually merged (= output contains no "no-op").
            let registeredNew = !r.out.contains("no-op")
            recordManifest(manifest, fileRecords: fileRecords,
                           settings: settings, settingsExisted: settingsExisted,
                           approveCmd: approveCmdPath, notifyCmd: notifyDst,
                           recordHooks: registeredNew)
        } else {
            log("INSTALL: notify hook registration rc=\(r.status) — manual check needed (\(settings))")
        }
    }

    /// cask-only reversibility record — appends to $RP_DIR/.install-manifest in the same TAB 3-field format as shared/lib.sh record().
    ///   FILE  <path>            : a newly created file (notify.sh / manage-claude-hooks.py / approve-reminder.sh)
    ///   HOOKS <settings> <cmd>  : our hook merged into settings.json (path key). Record as a surgical HOOKS line only when
    ///                             settings is a pre-existing file; if we created it, revert the whole thing with a single FILE <settings> line.
    /// Same meaning as the approve/notify hook section of install.sh (the existed branch). Consistent with python3/lib.sh.
    private static func recordManifest(_ manifest: String, fileRecords: [String],
                                       settings: String, settingsExisted: Bool,
                                       approveCmd: String?, notifyCmd: String,
                                       recordHooks: Bool) {
        func rec(_ action: String, _ a: String, _ b: String = "") -> String {
            // shared/lib.sh record(): printf '%s\t%s\t%s\n' — unused fields are empty strings.
            return "\(action)\t\(a)\t\(b)\n"
        }
        var lines = ""
        for f in fileRecords { lines += rec("FILE", f) }
        // Record HOOKS/new settings only when the hook merge actually added new entries (skip on no-op re-runs).
        if recordHooks {
            if settingsExisted {
                // Pre-existing user file → surgically remove only our entries. One line each for approve/notify (unique key per path).
                if let ac = approveCmd { lines += rec("HOOKS", settings, ac) }
                lines += rec("HOOKS", settings, notifyCmd)
            } else {
                // settings.json we created ourselves → revert by deleting the whole file.
                lines += rec("FILE", settings)
            }
        }
        guard !lines.isEmpty else { return }
        ensureDir((manifest as NSString).deletingLastPathComponent)
        if let h = FileHandle(forWritingAtPath: manifest) {
            h.seekToEndOfFile()
            if let d = lines.data(using: .utf8) { h.write(d) }
            do { try h.close() }
            catch { log(.debug, "manifest handle close skipped (\(manifest)): \(error)") }
        } else {
            // No file → create it fresh (append start point). best-effort even if it fails.
            do { try lines.write(toFile: manifest, atomically: true, encoding: .utf8) }
            catch { log(.warn, "cask-only manifest fresh write failed (\(manifest)) — uninstall reversibility may be incomplete: \(error)") }
        }
        log(.info, "cask-only manifest recorded → \(manifest) (\(fileRecords.count) file + hooks)")
    }

    /// Best-effort guess of the host/hooks path in the repo source tree (dev/source install). nil if absent.
    /// The bundle is usually in /Applications and unrelated to the repo → only lightly check env vars/conventional paths.
    private static func repoHostHooksDir() -> String? {
        var bases: [String] = []
        if let env = ProcessInfo.processInfo.environment["REPO_ROOT"], !env.isEmpty {
            bases.append("\(env)/host/hooks")
        }
        // The conventional location used by bootstrap.sh (if present)
        bases.append("\(HOME)/.local/share/xpair/host/hooks")
        for b in bases where fm.fileExists(atPath: "\(b)/xpair-notify.sh") { return b }
        return nil
    }

    /// python3 path lookup — conventional paths first, otherwise delegate to PATH via /usr/bin/env.
    private static func whichPython3() -> String? {
        for p in ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
            if fm.isExecutableFile(atPath: p) { return p }
        }
        let r = runCapture("/usr/bin/which", ["python3"])
        let path = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
        return (r.status == 0 && !path.isEmpty && fm.isExecutableFile(atPath: path)) ? path : nil
    }

    /// Atomic copy (overwrite) + permissions. Returns whether it succeeded.
    @discardableResult
    private static func copyFile(_ src: String, to dst: String, mode: Int) -> Bool {
        ensureDir((dst as NSString).deletingLastPathComponent)
        guard let data = fm.contents(atPath: src) else { return false }
        let tmp = dst + ".rp-tmp"
        do {
            try data.write(to: URL(fileURLWithPath: tmp), options: .atomic)
            // Remove an existing destination so the move can't collide — absent dst is the normal fresh-install case.
            do { try fm.removeItem(atPath: dst) }
            catch { log(.debug, "copyFile pre-move remove skipped (\(dst)): \(error)") }
            try fm.moveItem(atPath: tmp, toPath: dst)
            do { try fm.setAttributes([.posixPermissions: mode], ofItemAtPath: dst) }
            catch { log(.warn, "copyFile chmod \(String(mode, radix: 8)) failed (\(dst)): \(error)") }
            return true
        } catch {
            // Best-effort cleanup of the temp on failure.
            do { try fm.removeItem(atPath: tmp) }
            catch { log(.debug, "copyFile temp cleanup skipped (\(tmp)): \(error)") }
            log(.error, "copyFile failed \(src) → \(dst): \(error)")
            return false
        }
    }

    /// Bundle Contents/Helpers/<name> → ~/.xpair/host/bin/<name> symlink (replace if it is a wrong/stale link or a real file).
    /// Resolves the stable call path of screen-sharing sidecars/helpers (~/.xpair/host/bin) to the signed bundle binary.
    /// Items not in the bundle are silently skipped (dev/partial bundle). Idempotent — a no-op if the link is already correct.
    private static func linkBundledBinaries(_ names: [String]) {
        let helpersDir = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers").path
        let binDir = "\(RP_DIR)/bin"
        ensureDir(binDir)
        for name in names {
            let src = "\(helpersDir)/\(name)"
            let link = "\(binDir)/\(name)"
            guard fm.fileExists(atPath: src) else { log(.warn, "bundled \(name) not found (\(src)) — link skip"); continue }
            // nil = no existing link (fresh install) — expected, not an error.
            let cur = try? fm.destinationOfSymbolicLink(atPath: link)
            if cur == src { continue }                       // already the correct link → no-op
            // Remove a stale link or a real file (ad-hoc) left behind by an old deploy, then replace with a new symlink.
            do { try fm.removeItem(atPath: link) }
            catch { log(.debug, "\(name) stale link/file remove skipped (\(link)): \(error)") }
            do { try fm.createSymbolicLink(atPath: link, withDestinationPath: src); log(.info, "\(name) link → \(src)") }
            catch { log(.error, "\(name) link failed: \(error)") }
        }
    }

    // ── helpers ──

    private static func ensureDir(_ p: String) {
        // withIntermediateDirectories:true is a no-op if the dir already exists, so any throw is a real failure
        // (install layout below depends on these dirs existing).
        do { try fm.createDirectory(atPath: p, withIntermediateDirectories: true) }
        catch { log(.warn, "ensureDir failed (\(p)): \(error)") }
    }

    private static func writeFile(_ path: String, _ contents: String, mode: Int? = nil) {
        ensureDir((path as NSString).deletingLastPathComponent)
        do { try contents.write(toFile: path, atomically: true, encoding: .utf8) }
        catch { log(.error, "writeFile failed (\(path)): \(error)"); return }
        if let mode = mode {
            do { try fm.setAttributes([.posixPermissions: mode], ofItemAtPath: path) }
            catch { log(.warn, "writeFile chmod \(String(mode, radix: 8)) failed (\(path)): \(error)") }
        }
    }

    /// _write_env mirror: header + `KEY=<shell-quoted value>` (matches bash printf %q).
    private static func writeEnv(_ path: String, _ pairs: [(String, String)], onlyIfAbsent: Bool) {
        if onlyIfAbsent && fm.fileExists(atPath: path) { return }
        let base = (path as NSString).lastPathComponent
        var s = "# Xpair config (\(base)) — written by XpairHost self-install. Safe to edit manually.\n"
        for (k, v) in pairs { s += "\(k)=\(shellQuote(v))\n" }
        writeFile(path, s)
        log("INSTALL: env \(path)")
    }

    /// bash `printf %q`-compatible quoting: leave as-is if only safe characters, otherwise escape special characters with backslashes.
    private static func shellQuote(_ s: String) -> String {
        if s.isEmpty { return "''" }
        let safe = CharacterSet(charactersIn:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./:=@%+,")
        if s.unicodeScalars.allSatisfy({ safe.contains($0) }) { return s }
        var out = ""
        for ch in s {
            if ch == "\\" || ch == "'" || ch == "\"" || ch == " " || ch == "$" || ch == "`" {
                out.append("\\")
            }
            out.append(ch)
        }
        return out
    }

    private static func writeWatchdogScript() {
        // Same runtime behavior as the here-doc in install.sh (kickstart when HB is stale).
        let label = "gui/$(id -u)/\(APP_LABEL)"
        let s = """
        #!/bin/bash
        # xpair-watchdog.sh — Restart \(APP_NAME) when heartbeat goes stale. (generated by XpairHost self-install)
        set -u
        HB="\(HEARTBEAT)"; LOG="\(LOGP)"
        STALE=90; LABEL="\(label)"; now=$(date +%s)
        if [ -f "$HB" ]; then
          age=$(( now - $(stat -f %m "$HB" 2>/dev/null || echo 0) ))
          [ "$age" -gt "$STALE" ] && { launchctl kickstart -k "$LABEL" >/dev/null 2>&1; printf '%s watchdog: stale %ss\\n' "$(date '+%F %T')" "$age" >> "$LOG"; }
        else launchctl kickstart -k "$LABEL" >/dev/null 2>&1; fi
        """
        writeFile(WATCHDOG_SH, s + "\n", mode: 0o755)
    }

    private static func appPlistXML() -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
          <key>Label</key><string>\(APP_LABEL)</string>
          <key>ProgramArguments</key><array><string>\(APP_EXEC)</string></array>
          <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
          <key>ProcessType</key><string>Interactive</string>
          <key>StandardOutPath</key><string>\(LOG_DIR)/xpair.out.log</string>
          <key>StandardErrorPath</key><string>\(LOG_DIR)/xpair.err.log</string>
        </dict></plist>

        """
    }

    private static func watchdogPlistXML() -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
          <key>Label</key><string>\(WATCHDOG_LABEL)</string>
          <key>ProgramArguments</key><array><string>/bin/bash</string><string>\(WATCHDOG_SH)</string></array>
          <key>RunAtLoad</key><true/><key>StartInterval</key><integer>30</integer>
          <key>StandardErrorPath</key><string>\(LOG_DIR)/xpair-watchdog.err.log</string>
        </dict></plist>

        """
    }

    /// launchctl bootstrap gui/<uid> — best-effort. If already loaded, ignore (does not kill an already-running instance).
    private static func bootstrap(label: String, plist: String) {
        let uid = getuid()
        let r = runCapture("/bin/launchctl", ["bootstrap", "gui/\(uid)", plist])
        if r.status != 0 { log("INSTALL: bootstrap \(label) rc=\(r.status) (may already be loaded — ignoring)") }
        else { log("INSTALL: bootstrap \(label) ok") }
    }
}
