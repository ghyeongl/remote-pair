// D2Hardening.swift — one-time privileged host hardening for the D2 SSH front door.
//
// D2 needs system config the app can't write unprivileged (docs/design-d2-ssh-frontdoor.md). Apply it
// via the native GUI admin prompt (osascript "do shell script … with administrator privileges") —
// terminal-free, no resident root daemon. The app verifies at launch and re-prompts ONLY if a piece is
// missing/drifted. Two pieces:
//   • -R denial  → /etc/ssh/sshd_config.d/xpair-d2.conf = "AllowTcpForwarding local".
//   • tailnet bind → a pf anchor that blocks :22 on physical en* (LAN/public), leaving utun (VPN/tailscale)
//     + lo default-allow, loaded at boot by a RunAtLoad one-shot. Blocking physical (not "all except the
//     tailscale utun") means a headless agent Mac can never be locked out of SSH by a boot-before-tailscale
//     race or utun churn — the real threat (public/LAN exposure) is still closed.

import Foundation

enum D2Hardening {
    static let sshdDropIn = "/etc/ssh/sshd_config.d/xpair-d2.conf"
    static let sshdContent = "AllowTcpForwarding local\n"
    static let pfLoader = "/usr/local/libexec/xpair-pf.sh"
    static let pfAnchor = "/etc/pf.anchors/com.x10lab.xpair"
    static let pfPlist = "/Library/LaunchDaemons/com.x10lab.xpair.pf.plist"

    // ponytail: block :22 on en* only (Wi-Fi/Ethernet = the LAN/public surface); utun + lo default-allow,
    // so a tailscale utun appearing/reconnecting is never locked out. Re-run at boot + app launch.
    static let loaderScript = """
    #!/bin/sh
    anchor=\(pfAnchor)
    ifconfig -l | tr ' ' '\\n' | grep '^en' | sed 's/.*/block in quick proto tcp on & to any port 22/' > "$anchor"
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
      <key>ProgramArguments</key><array><string>\(pfLoader)</string></array>
      <key>RunAtLoad</key><true/>
    </dict></plist>
    """

    static func applied() -> Bool {
        (try? String(contentsOfFile: sshdDropIn, encoding: .utf8)) == sshdContent
            && FileManager.default.fileExists(atPath: pfLoader)
            && FileManager.default.fileExists(atPath: pfPlist)
    }

    /// One-time privileged apply (both pieces) via the GUI admin prompt. No-op if already applied.
    @discardableResult
    static func apply() -> Bool {
        if applied() { return true }
        // Write contents to unprivileged temp files, then a SHORT one-line privileged command installs +
        // loads them — keeps the osascript string a single line (no heredoc/newline escaping through
        // AppleScript). ponytail: install(1) sets perms; the loader run applies pf now.
        let tmp = FileManager.default.temporaryDirectory
        let cSshd = tmp.appendingPathComponent("xpair-d2.conf")
        let cLoader = tmp.appendingPathComponent("xpair-pf.sh")
        let cPlist = tmp.appendingPathComponent("com.x10lab.xpair.pf.plist")
        do {
            try sshdContent.write(to: cSshd, atomically: true, encoding: .utf8)
            try loaderScript.write(to: cLoader, atomically: true, encoding: .utf8)
            try plistContent.write(to: cPlist, atomically: true, encoding: .utf8)
        } catch { return false }
        let shell = [
            "install -d /etc/ssh/sshd_config.d /usr/local/libexec",
            "install -m 644 \(cSshd.path) \(sshdDropIn)",
            "install -m 755 \(cLoader.path) \(pfLoader)",
            "install -m 644 \(cPlist.path) \(pfPlist)",
            "launchctl load -w \(pfPlist) 2>/dev/null || true",
            "sh \(pfLoader)",
        ].joined(separator: " && ")
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
