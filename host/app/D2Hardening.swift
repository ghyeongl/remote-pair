// D2Hardening.swift — one-time privileged host hardening for the D2 SSH front door.
//
// D2 needs system config the app can't write unprivileged (docs/design-d2-ssh-frontdoor.md). Apply it
// via the native GUI admin prompt (osascript "do shell script … with administrator privileges") —
// terminal-free, no resident root daemon. The app verifies at launch and re-prompts ONLY if a piece is
// missing/drifted. Two pieces:
//   • -R denial  → /etc/ssh/sshd_config.d/00-xpair-d2.conf = "AllowTcpForwarding local" (the `00-` prefix
//     wins sshd's first-value-per-keyword among drop-ins, which macOS Includes before the main file body).
//   • tailnet bind → a pf anchor that blocks :22 on every interface EXCEPT loopback + utun (VPN/tailscale),
//     loaded at boot by a RunAtLoad one-shot. Allowing utun (never blocking it) means a headless agent Mac
//     can't be locked out by a boot-before-tailscale race or utun churn, while en*/bridge/VLAN/etc. — the
//     LAN/public surface — stay closed.
//
// The privileged command carries the file bytes as base64 embedded in the (admin-authorized) osascript
// string and writes them as root itself — there is NO user-writable stage a same-UID process could swap
// between write and a root copy.

import Foundation

enum D2Hardening {
    static let sshdDropIn = "/etc/ssh/sshd_config.d/00-xpair-d2.conf"
    static let sshdContent = "AllowTcpForwarding local\n"
    static let supportDir = "/Library/Application Support/Xpair"
    static let pfLoader = "\(supportDir)/xpair-pf.sh"
    static let pfPlist = "/Library/LaunchDaemons/com.x10lab.xpair.pf.plist"
    static let pfAnchor = "/etc/pf.anchors/com.x10lab.xpair"
    static let pfConfMarker = "anchor \"com.x10lab.xpair\""

    // ponytail: block :22 on every interface except lo*/utun* (utun = VPN/tailscale, default-allow so a
    // reconnect onto a new utun is never locked out). Refreshed at boot (RunAtLoad) + app-launch apply; a
    // NIC hot-added without a reboot isn't blocked until the next boot — accepted on a dedicated host.
    static let loaderScript = """
    #!/bin/sh
    anchor=\(pfAnchor)
    ifconfig -l | tr ' ' '\\n' | grep -vE '^(lo|utun)' | sed 's/.*/block in quick proto tcp on & to any port 22/' > "$anchor"
    grep -q 'anchor "com.x10lab.xpair"' /etc/pf.conf 2>/dev/null || \
      printf '\\nanchor "com.x10lab.xpair"\\nload anchor "com.x10lab.xpair" from "%s"\\n' "$anchor" >> /etc/pf.conf
    pfctl -f /etc/pf.conf 2>/dev/null || true
    pfctl -E 2>/dev/null || true
    """

    static let plistContent = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
      <key>Label</key><string>com.x10lab.xpair.pf</string>
      <key>ProgramArguments</key><array><string>/bin/sh</string><string>\(pfLoader)</string></array>
      <key>RunAtLoad</key><true/>
    </dict></plist>
    """

    private static func fileEquals(_ path: String, _ expected: String) -> Bool {
        (try? String(contentsOfFile: path, encoding: .utf8)) == expected
    }

    private static func pfConfHasAnchor() -> Bool {
        ((try? String(contentsOfFile: "/etc/pf.conf", encoding: .utf8)) ?? "").contains(pfConfMarker)
    }

    // Verify CONTENT + the /etc/pf.conf hook, not mere existence — so a stale/truncated file OR a pf.conf
    // that lost the anchor line re-applies.
    static func applied() -> Bool {
        fileEquals(sshdDropIn, sshdContent) && fileEquals(pfLoader, loaderScript)
            && fileEquals(pfPlist, plistContent) && pfConfHasAnchor()
    }

    /// One-time privileged apply (both pieces) via the GUI admin prompt. No-op if already applied.
    @discardableResult
    static func apply() -> Bool {
        if applied() { return true }
        func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }
        // Root writes the files itself from base64 (safe single tokens — no user stage, no shell-metachar
        // escaping). `set -e` aborts on any failure; the launchctl reload is the only non-fatal step.
        let shell = [
            "set -e",
            "umask 077",
            "install -d /etc/ssh/sshd_config.d",
            "install -d -o root -g wheel -m 755 '\(supportDir)'",
            "printf %s '\(b64(sshdContent))' | base64 -D > '\(sshdDropIn)'; chmod 644 '\(sshdDropIn)'",
            "printf %s '\(b64(loaderScript))' | base64 -D > '\(pfLoader)'; chown root:wheel '\(pfLoader)'; chmod 755 '\(pfLoader)'",
            "printf %s '\(b64(plistContent))' | base64 -D > '\(pfPlist)'; chmod 644 '\(pfPlist)'",
            "{ launchctl load -w '\(pfPlist)' 2>/dev/null || true; }",
            "/bin/sh '\(pfLoader)'",
        ].joined(separator: "; ")
        return runAdmin(shell)
    }

    /// Build the `osascript -e` argument that runs `shell` as root via the native admin prompt.
    /// Pure + testable: escape backslash then double-quote so `shell` is a valid AppleScript string literal.
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
