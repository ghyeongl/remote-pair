// D2Hardening.swift — one-time privileged host hardening for the D2 SSH front door.
//
// D2 needs system config the app can't write unprivileged (docs/design-d2-ssh-frontdoor.md). Apply it
// via the native GUI admin prompt (osascript "do shell script … with administrator privileges") —
// terminal-free, no resident root daemon. The app verifies at launch and re-prompts ONLY if a piece is
// missing/drifted. Two pieces:
//   • -R denial  → /etc/ssh/sshd_config.d/00-xpair-d2.conf = "AllowTcpForwarding local" (the `00-` prefix
//     wins sshd's first-value-per-keyword among drop-ins, which macOS Includes before the main file body).
//   • tailnet bind → a pf anchor that blocks :22 on physical en* (LAN/public), leaving utun (VPN/tailscale)
//     + lo default-allow, loaded at boot by a RunAtLoad one-shot. Blocking physical (not "all except the
//     tailscale utun") means a headless agent Mac can't be locked out of SSH by a boot-before-tailscale
//     race or utun churn — the real threat (public/LAN exposure) is still closed.

import Foundation

enum D2Hardening {
    static let sshdDropIn = "/etc/ssh/sshd_config.d/00-xpair-d2.conf"
    static let sshdContent = "AllowTcpForwarding local\n"
    // Root-owned dir (installed root:wheel 0755) — NOT /usr/local, which is group/user-writable on
    // Homebrew Macs and would let a local user replace a script the root LaunchDaemon runs.
    static let supportDir = "/Library/Application Support/Xpair"
    static let pfLoader = "\(supportDir)/xpair-pf.sh"
    static let pfPlist = "/Library/LaunchDaemons/com.x10lab.xpair.pf.plist"
    static let pfAnchor = "/etc/pf.anchors/com.x10lab.xpair"

    // ponytail: block :22 on en* only (Wi-Fi/Ethernet = the LAN/public surface); utun + lo default-allow,
    // so a tailscale utun appearing/reconnecting is never locked out. Refreshed at boot (RunAtLoad) + app
    // launch; a NIC hot-added without a reboot isn't blocked until the next boot — accepted on a dedicated
    // host that rarely hot-adds physical interfaces.
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
      <key>ProgramArguments</key><array><string>/bin/sh</string><string>\(pfLoader)</string></array>
      <key>RunAtLoad</key><true/>
    </dict></plist>
    """

    private static func fileEquals(_ path: String, _ expected: String) -> Bool {
        (try? String(contentsOfFile: path, encoding: .utf8)) == expected
    }

    // Verify CONTENT (not mere existence), so a stale/truncated file re-applies.
    static func applied() -> Bool {
        fileEquals(sshdDropIn, sshdContent) && fileEquals(pfLoader, loaderScript) && fileEquals(pfPlist, plistContent)
    }

    /// One-time privileged apply (both pieces) via the GUI admin prompt. No-op if already applied.
    @discardableResult
    static func apply() -> Bool {
        if applied() { return true }
        // Stage into a fresh 0700 dir with an unguessable name so no other process running as this user can
        // swap a file between write and the root install (TOCTOU). Single-quote every path in the root
        // command in case TMPDIR contains spaces/metacharacters.
        let fm = FileManager.default
        let stage = fm.temporaryDirectory.appendingPathComponent("xpair-d2-\(UUID().uuidString)")
        let cSshd = stage.appendingPathComponent("00-xpair-d2.conf")
        let cLoader = stage.appendingPathComponent("xpair-pf.sh")
        let cPlist = stage.appendingPathComponent("com.x10lab.xpair.pf.plist")
        do {
            try fm.createDirectory(at: stage, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            try sshdContent.write(to: cSshd, atomically: true, encoding: .utf8)
            try loaderScript.write(to: cLoader, atomically: true, encoding: .utf8)
            try plistContent.write(to: cPlist, atomically: true, encoding: .utf8)
        } catch { return false }
        defer { try? fm.removeItem(at: stage) }
        func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let shell = [
            "install -d /etc/ssh/sshd_config.d",
            "install -d -o root -g wheel -m 755 \(q(supportDir))",
            "install -m 644 \(q(cSshd.path)) \(q(sshdDropIn))",
            "install -o root -g wheel -m 755 \(q(cLoader.path)) \(q(pfLoader))",
            "install -m 644 \(q(cPlist.path)) \(q(pfPlist))",
            "launchctl load -w \(q(pfPlist)) 2>/dev/null || true",
            "/bin/sh \(q(pfLoader))",
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
