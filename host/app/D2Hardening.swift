// D2Hardening.swift — one-time privileged host hardening for the D2 SSH front door.
//
// D2 needs system config the app can't write unprivileged (docs/design-d2-ssh-frontdoor.md). Apply it
// via the native GUI admin prompt (osascript "do shell script … with administrator privileges") —
// terminal-free, no resident root daemon. The app verifies at launch and re-prompts ONLY if a piece is
// missing/drifted. Two pieces:
//   • remote-forward denial → /etc/ssh/sshd_config.d/00-xpair-d2.conf (AllowTcpForwarding local +
//     AllowStreamLocalForwarding local: permit -L, deny -R for both TCP and unix-socket forwards).
//   • tailnet bind → a pf anchor that blocks :22 on every interface except lo* and utun* (VPN/tailscale),
//     loaded at boot by a RunAtLoad one-shot. Allowing any utun (never blocking it) keeps a headless
//     agent Mac from being locked out by a boot-before-tailscale race or utun churn, while en*/bridge/VLAN
//     — the LAN/public surface — stay closed.
//
// ponytail: continuous drift self-heal (reconcile live pf state / repair a half-edited pf.conf on every
// launch) is deferred to a "D2 hardening drift-repair" follow-up. This PR = apply-once (which fully
// verifies live enforcement at apply time, as root) + launch-verify-presence + fail-closed gating.

import Foundation

enum D2Hardening {
    static let sshdDropIn = "/etc/ssh/sshd_config.d/00-xpair-d2.conf"
    static let sshdContent = "AllowTcpForwarding local\nAllowStreamLocalForwarding local\n"
    static let supportDir = "/Library/Application Support/Xpair"
    static let pfLoader = "\(supportDir)/xpair-pf.sh"
    static let pfPlist = "/Library/LaunchDaemons/com.x10lab.xpair.pf.plist"
    static let pfAnchor = "/etc/pf.anchors/com.x10lab.xpair"

    // pf.conf grammar is `action dir [quick] [on if] [proto p] …` — `on` BEFORE `proto`. Anchor file is
    // chmod 644 so the unprivileged app can read it to verify. Enable + enforcement failures are fatal
    // (set -e) so a broken pf makes apply() fail → the launch fail-safe removes the D2 flag.
    static let loaderScript = """
    #!/bin/sh
    set -e
    anchor=\(pfAnchor)
    ifconfig -l | tr ' ' '\\n' | grep -vE '^(lo|utun)' | sed 's/.*/block in quick on & proto tcp to any port 22/' > "$anchor"
    chmod 644 "$anchor"
    grep -qx 'anchor "com.x10lab.xpair"' /etc/pf.conf 2>/dev/null || \
      printf '\\nanchor "com.x10lab.xpair"\\nload anchor "com.x10lab.xpair" from "%s"\\n' "$anchor" >> /etc/pf.conf
    pfctl -f /etc/pf.conf
    pfctl -s info 2>/dev/null | grep -q 'Status: Enabled' || pfctl -e
    pfctl -a com.x10lab.xpair -s rules 2>/dev/null | grep -q 'port = 22' || { echo 'xpair pf anchor not enforcing' >&2; exit 1; }
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

    private static func lines(_ path: String) -> [String] {
        ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }
    private static func fileEquals(_ path: String, _ expected: String) -> Bool {
        (try? String(contentsOfFile: path, encoding: .utf8)) == expected
    }
    private static func fileContains(_ path: String, _ needle: String) -> Bool {
        ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "").contains(needle)
    }
    // An ACTIVE (non-commented) `Include … sshd_config.d…` line — a commented mention doesn't count.
    static func sshdIncludesDropInDir() -> Bool {
        lines("/etc/ssh/sshd_config").contains {
            let t = $0.trimmingCharacters(in: .whitespaces)
            return !t.hasPrefix("#") && t.hasPrefix("Include") && t.contains("sshd_config.d")
        }
    }
    // pf needs BOTH lines: the `anchor "…"` evaluation line AND `load anchor … from …`.
    private static func pfConfEvaluatesAnchor() -> Bool {
        let ls = lines("/etc/pf.conf")
        return ls.contains("anchor \"com.x10lab.xpair\"")
            && ls.contains { $0.hasPrefix("load anchor \"com.x10lab.xpair\"") }
    }

    // Unprivileged launch-verify of the durable config. Live pf-kernel state can't be read without root
    // (ponytail: proven at apply time, re-asserted by the boot one-shot; continuous reconcile is the
    // deferred follow-up).
    static func applied() -> Bool {
        fileEquals(sshdDropIn, sshdContent)
            && sshdIncludesDropInDir()
            && fileEquals(pfLoader, loaderScript)
            && fileEquals(pfPlist, plistContent)
            && pfConfEvaluatesAnchor()
            && fileContains(pfAnchor, "block in quick on ")
    }

    /// One-time privileged apply (both pieces) via the GUI admin prompt. No-op if already applied.
    @discardableResult
    static func apply() -> Bool {
        if applied() { return true }
        func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }
        // Root writes the files itself from base64 (safe single tokens — no user stage, no shell-metachar
        // escaping). `set -e`; every step is fatal except the intentionally-guarded ones.
        let shell = [
            "set -e",
            "umask 022",
            "install -d /etc/ssh/sshd_config.d",
            // Prepend an active Include if none exists (stock macOS has it; a drifted config would leave
            // our drop-in unread). Match only an ACTIVE (uncommented) Include line.
            "grep -qE '^[[:space:]]*Include[[:space:]].*sshd_config\\.d' /etc/ssh/sshd_config 2>/dev/null || { t=$(mktemp); printf 'Include /etc/ssh/sshd_config.d/*.conf\\n' > \"$t\"; cat /etc/ssh/sshd_config >> \"$t\"; cat \"$t\" > /etc/ssh/sshd_config; rm -f \"$t\"; }",
            "install -d -o root -g wheel -m 755 '\(supportDir)'",
            "printf %s '\(b64(sshdContent))' | base64 -D > '\(sshdDropIn)'; chmod 644 '\(sshdDropIn)'",
            "printf %s '\(b64(loaderScript))' | base64 -D > '\(pfLoader)'; chown root:wheel '\(pfLoader)'; chmod 755 '\(pfLoader)'",
            "printf %s '\(b64(plistContent))' | base64 -D > '\(pfPlist)'; chmod 644 '\(pfPlist)'",
            "launchctl load -w '\(pfPlist)' 2>/dev/null || true",
            "launchctl list | grep -q com.x10lab.xpair.pf",   // registration must succeed
            "/bin/sh '\(pfLoader)'",                            // applies pf now + verifies it enforces
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
