// D2Hardening.swift — one-time privileged host hardening for the D2 SSH front door.
//
// D2 needs system-level config the app can't write unprivileged (see docs/design-d2-ssh-frontdoor.md).
// This applies it via the native GUI admin prompt (osascript "do shell script … with administrator
// privileges") — terminal-free, no resident root daemon. The app verifies at launch and re-prompts ONLY
// when a piece is missing/drifted.
//
// This file covers the -R denial (an sshd_config drop-in). The pf tailnet bind is applied separately.

import Foundation

enum D2Hardening {
    // AllowTcpForwarding local = permit -L (open-remote-ssh / RD loopback), deny -R. There is no valid
    // per-key authorized_keys "deny-all -R" token, so this global drop-in is the -R boundary; acceptable
    // because the host is an agent-dedicated Mac (roadmap identity). macOS sshd is launchd-on-demand and
    // re-reads config per connection, so no reload is needed after writing the drop-in.
    static let sshdDropIn = "/etc/ssh/sshd_config.d/xpair-d2.conf"
    static let sshdContent = "AllowTcpForwarding local\n"

    static func sshdApplied() -> Bool {
        (try? String(contentsOfFile: sshdDropIn, encoding: .utf8)) == sshdContent
    }

    /// Apply the sshd drop-in via the GUI admin prompt. No-op if already correct. Returns true on success.
    @discardableResult
    static func applySshd() -> Bool {
        if sshdApplied() { return true }
        let shell = "mkdir -p /etc/ssh/sshd_config.d && "
            + "printf 'AllowTcpForwarding local\\n' > \(sshdDropIn) && chmod 644 \(sshdDropIn)"
        return runAdmin(shell)
    }

    /// Build the `osascript -e` argument that runs `shell` as root via the native admin prompt.
    /// Pure + testable: escapes backslash then double-quote so `shell` is a valid AppleScript string literal
    /// (a lone `\n` in `shell` becomes `\\n`, which AppleScript renders back to `\n` for the shell).
    static func osaCommand(_ shell: String) -> String {
        let escaped = shell
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "do shell script \"\(escaped)\" with administrator privileges"
    }

    private static func runAdmin(_ shell: String) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", osaCommand(shell)]
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 }
        catch { return false }
    }
}
