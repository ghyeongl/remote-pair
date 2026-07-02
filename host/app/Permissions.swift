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

    static func loginGranted() -> Bool {
        runProbeStatus("/bin/launchctl", ["print", "system/com.openssh.sshd"]) == 0
    }

    static func sharingGranted() -> Bool {
        runProbeStatus("/bin/launchctl", ["print", "system/com.apple.smbd"]) == 0
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

    /// Only checks computer-use's required gates (FDA is recommended, so it's not a gate).
    static func allGranted() -> Bool { axTrusted() && srGranted() }

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
}

/// This is an accessory(LSUIElement) app, so an explicit activate is needed to bring modals/windows to the front.
func bringToFront() {
    NSApp.activate(ignoringOtherApps: true)
}
