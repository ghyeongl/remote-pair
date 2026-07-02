// Permissions.swift — Check Accessibility(AX) + Screen Recording(SR) + Full Disk Access(FDA) permission status + open System Settings.
//
// computer-use 2 gates (required):  AX(synthetic input) = AXIsProcessTrusted(),  SR(screenshot) = CGPreflightScreenCaptureAccess().
// FDA(recommended): on a headless host, the macOS TCC folder prompt cannot be clicked remotely, so the session stalls.
//   Enabling FDA makes that prompt disappear entirely. The trade-off, in exchange, is that every session can silently read the whole disk (including Mail/Messages/browser).
// Since this is SIP+non-MDM, only the user can toggle — we just show the status + open the correct settings pane.

import Cocoa
import ApplicationServices
import CoreGraphics

enum Permissions {
    static func axTrusted() -> Bool { AXIsProcessTrusted() }
    static func srGranted() -> Bool { CGPreflightScreenCaptureAccess() }

    static func loginGranted() -> Bool { serviceEnabled("com.openssh.sshd") }

    static func sharingGranted() -> Bool { serviceEnabled("com.apple.smbd") }

    /// A launchd system service is "on" only if it is not disabled AND its target is loaded. The
    /// target can exist while Remote Login / File Sharing is toggled OFF, so presence alone is not
    /// proof: `launchctl print-disabled system` exposes the enable/disable override (`"<label>" =>
    /// true` means disabled). Explicit override wins; otherwise fall back to target presence.
    private static func serviceEnabled(_ label: String) -> Bool {
        let disabled = runProbeOutput("/bin/launchctl", ["print-disabled", "system"])
        if let line = disabled.split(separator: "\n").first(where: { $0.contains(label) }) {
            let v = line.lowercased().replacingOccurrences(of: " ", with: "")
            if v.contains("=>true") { return false }    // explicitly disabled
            if v.contains("=>false") { return true }     // explicitly enabled
        }
        return runProbeStatus("/bin/launchctl", ["print", "system/\(label)"]) == 0
    }

    /// FDA has no public preflight API → infer it by actually reading a TCC-protected file (TCC.db) that can only be opened with FDA.
    static func fdaGranted() -> Bool {
        let probe = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db")
        guard let fh = FileHandle(forReadingAtPath: probe) else { return false }
        defer {
            // Closing the read-only probe handle failing is genuinely ignorable, but trace it so a leaked fd is diagnosable.
            do { try fh.close() } catch { log(.debug, "fdaGranted: close TCC.db probe handle failed: \(error)") }
        }
        // A successful 1-byte read means FDA is granted; a read error means it isn't (the load-bearing inference) — log the error so a non-FDA failure is distinguishable from other I/O faults.
        do {
            return try fh.read(upToCount: 1) != nil
        } catch {
            log(.debug, "fdaGranted: TCC.db probe read failed (treating as FDA not granted): \(error)")
            return false
        }
    }

    /// One-line summary (used by the Settings window text blob). The menu bar renders permissions as
    /// one short row each (see AppDelegate.rebuildMenu) so the dropdown stays narrow.
    static func summary() -> String {
        "Permissions: Accessibility \(axTrusted() ? "✓" : "✗")  Screen Recording \(srGranted() ? "✓" : "✗")  Full Disk \(fdaGranted() ? "✓" : "✗")"
    }

    /// The required gates. AX + SR are computer-use's input/capture gates; Remote Login (sshd) is the
    /// transport every client session rides on, so a host with sshd off is not actually usable even
    /// with AX/SR granted and a key still on file — include it so completion/launch reflect reality.
    /// (FDA is recommended, not a gate.)
    static func allGranted() -> Bool { axTrusted() && srGranted() && loginGranted() }

    /// Onboarding-triggered single-permission request (the onboarding owns the surrounding UI, so no alert/panes here).
    /// AX → AXIsProcessTrustedWithOptions(prompt) shows the system prompt AND registers the app in the Accessibility list.
    /// SR → CGRequestScreenCaptureAccess() registers the app in the Screen Recording list. FDA has no request API.
    static func request(_ key: String) {
        if isClientRole { return }   // client = access-only, never requests
        switch key {
        case "ax":
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        case "sr":
            if !srGranted() { CGRequestScreenCaptureAccess() }
        default:
            break   // fda: no programmatic request API — the user adds the app via the Full Disk Access pane
        }
    }

    private static func runProbeStatus(_ path: String, _ args: [String]) -> Int32 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = args
        task.standardOutput = Pipe()
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus
        } catch {
            log(.debug, "permission status probe failed: \(path) \(args.joined(separator: " ")) — \(error)")
            return -1
        }
    }

    private static func runProbeOutput(_ path: String, _ args: [String]) -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = args
        let out = Pipe()
        task.standardOutput = out
        task.standardError = Pipe()
        do {
            try task.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            log(.debug, "permission output probe failed: \(path) \(args.joined(separator: " ")) — \(error)")
            return ""
        }
    }
}

/// This is an accessory(LSUIElement) app, so an explicit activate is needed to bring modals/windows to the front.
func bringToFront() {
    NSApp.activate(ignoringOtherApps: true)
}
