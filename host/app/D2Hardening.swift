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

    // ponytail: block :22 on every interface except lo*/utun* (utun = VPN/tailscale, default-allow so a
    // reconnect onto a new utun is never locked out). Refreshed at boot (RunAtLoad) + app-launch apply; a
    // NIC hot-added without a reboot isn't blocked until the next boot — accepted on a dedicated host.
    static let loaderScript = """
    #!/bin/sh
    set -e
    anchor=\(pfAnchor)
    ifconfig -l | tr ' ' '\\n' | grep -vE '^(lo|utun)' | sed 's/.*/block in quick proto tcp on & to any port 22/' > "$anchor"
    grep -qx 'anchor "com.x10lab.xpair"' /etc/pf.conf 2>/dev/null || \
      printf '\\nanchor "com.x10lab.xpair"\\nload anchor "com.x10lab.xpair" from "%s"\\n' "$anchor" >> /etc/pf.conf
    pfctl -f /etc/pf.conf              # must succeed — set -e aborts (loader non-zero → apply() false → D2 flag removed)
    pfctl -e 2>/dev/null || true       # enable if off; benign if already on. `-e` (not `-E`) so we don't leak PF enable-refs
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

    private static func fileContains(_ path: String, _ needle: String) -> Bool {
        ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "").contains(needle)
    }

    // pf needs BOTH lines: the `anchor "…"` line that EVALUATES the anchor in the main ruleset, and the
    // `load anchor … from …` line that fills it. A substring/partial match would pass with only one.
    private static func pfConfEvaluatesAnchor() -> Bool {
        let lines = ((try? String(contentsOfFile: "/etc/pf.conf", encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
        return lines.contains("anchor \"com.x10lab.xpair\"")
            && lines.contains { $0.hasPrefix("load anchor \"com.x10lab.xpair\"") }
    }

    // Verify CONTENT + every hook, not mere existence, so any drifted piece re-applies: the drop-in bytes
    // AND that sshd actually Includes the drop-in dir; the loader + plist bytes; the /etc/pf.conf load line
    // AND the anchor file (non-empty with a block rule — its interface list is dynamic so no byte compare).
    static func applied() -> Bool {
        fileEquals(sshdDropIn, sshdContent)
            && fileContains("/etc/ssh/sshd_config", "/etc/ssh/sshd_config.d/")
            && fileEquals(pfLoader, loaderScript)
            && fileEquals(pfPlist, plistContent)
            && pfConfEvaluatesAnchor()
            && fileContains(pfAnchor, "block in quick proto tcp")
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
            // Ensure sshd actually reads drop-ins: prepend the Include if the host's sshd_config lacks it
            // (stock macOS has it; a drifted config would leave our -R denial unread). Prepend keeps it
            // early so first-value-per-keyword still favors our 00- drop-in.
            "grep -q '/etc/ssh/sshd_config.d/' /etc/ssh/sshd_config 2>/dev/null || { t=$(mktemp); printf 'Include /etc/ssh/sshd_config.d/*.conf\\n' > \"$t\"; cat /etc/ssh/sshd_config >> \"$t\"; cat \"$t\" > /etc/ssh/sshd_config; rm -f \"$t\"; }",
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
