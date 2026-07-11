// D2Hardening.swift — one-time privileged host hardening for the D2 SSH front door.
//
// D2 needs system config the app can't write unprivileged (docs/design-d2-ssh-frontdoor.md). Apply it
// via the native GUI admin prompt (osascript "do shell script … with administrator privileges") —
// terminal-free, no resident root daemon. The app verifies at launch and re-prompts ONLY if a piece is
// missing/drifted. Two pieces:
//   • remote-forward denial → /etc/ssh/sshd_config.d/00-xpair-d2.conf (AllowTcpForwarding local +
//     AllowStreamLocalForwarding local: permit -L, deny -R for both TCP and unix-socket forwards).
//   • tailnet bind → a pf anchor that DEFAULT-DENIES inbound :22 and passes only loopback and the tailnet
//     path (a Tailscale CGNAT 100.64.0.0/10 source on any utun). Because :22 is closed by default, an
//     interface created LATER (USB/Thunderbolt Ethernet, VLAN/bridge, VM) is closed automatically — no
//     interface enumeration, nothing to re-run when the NIC set changes.
//
// Enforcement is EFFECTIVE-verified, not presence-verified:
//   • apply() (root) asserts the merged sshd policy via `sshd -T` and asserts the pf block is loaded AND
//     reachable (not shadowed by an earlier `quick` :22 pass) before returning success.
//   • applied() (unprivileged launch check) reads the durable config and asserts the same invariants it
//     CAN read without root: exact drop-in content, the drop-in Include ordered before any forwarding/Match
//     directive, exact anchor content, and the anchor evaluated before any earlier `quick` :22 pass.
//
// ponytail: continuous live-state reconcile (re-read the pf kernel state / repair a hand-edited pf.conf on
// every launch) is deferred to a "D2 hardening drift-repair" follow-up. Live enforcement is proven as root
// at apply time and re-proven by the boot one-shot; unprivileged launch re-verifies the durable config.

import Foundation

enum D2Hardening {
    static let sshdDropIn = "/etc/ssh/sshd_config.d/00-xpair-d2.conf"
    static let sshdContent = "AllowTcpForwarding local\nAllowStreamLocalForwarding local\n"
    static let supportDir = "/Library/Application Support/Xpair"
    static let pfLoader = "\(supportDir)/xpair-pf.sh"
    static let pfPlist = "/Library/LaunchDaemons/com.x10lab.xpair.pf.plist"
    static let pfAnchor = "/etc/pf.anchors/com.x10lab.xpair"

    // Static default-deny for :22 (no `ifconfig` enumeration). `quick` = first match wins, so the two
    // passes precede the block. Pass: loopback, and any utun carrying a Tailscale CGNAT (100.64.0.0/10)
    // source — the tailnet-only bind. Everything else on :22, including any future NIC, hits the block.
    static let pfAnchorContent = """
    pass in quick on lo0 proto tcp to any port 22
    pass in quick on utun proto tcp from 100.64.0.0/10 to any port 22
    block in quick proto tcp to any port 22
    """

    // Boot/apply one-shot: reload pf, ensure it is enabled, then PROVE effective enforcement — the anchor
    // carries the port-22 block AND our anchor call is reached before any earlier `quick` :22 pass in the
    // main ruleset. `set -e` + the explicit exits make any failure fatal, so a shadowed/absent block fails
    // apply() → the launch fail-safe strips the D2 flag rather than running the front door unhardened.
    static let loaderScript = """
    #!/bin/sh
    set -e
    pfctl -f /etc/pf.conf
    pfctl -s info 2>/dev/null | grep -q 'Status: Enabled' || pfctl -e
    pfctl -a com.x10lab.xpair -sr 2>/dev/null | grep -q 'block .* port = 22' || { echo 'xpair pf anchor not enforcing' >&2; exit 1; }
    main=$(pfctl -sr 2>/dev/null)
    a=$(printf '%s\\n' "$main" | grep -n 'anchor "com.x10lab.xpair"' | head -1 | cut -d: -f1)
    p=$(printf '%s\\n' "$main" | grep -nE 'pass .*quick.*port = 22' | head -1 | cut -d: -f1)
    [ -n "$a" ] || { echo 'xpair pf anchor missing from ruleset' >&2; exit 1; }
    { [ -z "$p" ] || [ "$p" -gt "$a" ]; } || { echo 'xpair pf anchor shadowed by earlier quick pass' >&2; exit 1; }
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

    // The drop-in Include must be an ACTIVE (non-commented) `Include … sshd_config.d…` line that precedes
    // any forwarding/`Match` directive — sshd keeps the FIRST obtained value, so a late Include never sets
    // the effective policy. A commented `#Include` does not count.
    static func sshdIncludeIsFirst() -> Bool {
        let ls = lines("/etc/ssh/sshd_config")
        guard let inc = ls.firstIndex(where: { l in
            let t = l.trimmingCharacters(in: .whitespaces)
            return !t.hasPrefix("#") && t.hasPrefix("Include") && t.contains("sshd_config.d")
        }) else { return false }
        if let bad = ls.firstIndex(where: { l in
            let t = l.trimmingCharacters(in: .whitespaces)
            return !t.hasPrefix("#")
                && (t.hasPrefix("AllowTcpForwarding") || t.hasPrefix("AllowStreamLocalForwarding") || t.hasPrefix("Match "))
        }) { return inc < bad }
        return true
    }

    // pf needs BOTH the `anchor "…"` evaluation line AND `load anchor … from …`, and the anchor call must
    // be reached before any earlier `quick` :22 pass or its block never evaluates.
    private static func pfConfAnchorReachable() -> Bool {
        let ls = lines("/etc/pf.conf")
        guard let anchorIdx = ls.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "anchor \"com.x10lab.xpair\"" }),
              ls.contains(where: { $0.hasPrefix("load anchor \"com.x10lab.xpair\"") }) else { return false }
        if let passIdx = ls.firstIndex(where: { l in
            let t = l.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("pass") && t.contains("quick") && (t.contains("port 22") || t.contains("port = 22"))
        }) { return anchorIdx < passIdx }
        return true
    }

    // Unprivileged launch-verify of the durable config. Live pf-kernel/`sshd -T` state can't be read without
    // root (proven at apply time, re-asserted by the boot one-shot); here we assert every readable invariant
    // that makes the enforcement EFFECTIVE, not merely present.
    static func applied() -> Bool {
        fileEquals(sshdDropIn, sshdContent)
            && sshdIncludeIsFirst()
            && fileEquals(pfLoader, loaderScript)
            && fileEquals(pfPlist, plistContent)
            && fileEquals(pfAnchor, pfAnchorContent)
            && pfConfAnchorReachable()
    }

    /// One-time privileged apply (both pieces) via the GUI admin prompt. No-op if already applied.
    @discardableResult
    static func apply() -> Bool {
        if applied() { return true }
        func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }
        // All root work lives in one helper script, base64-decoded to a root-owned temp file and run. The
        // helper carries the file contents as base64 (safe single tokens) and the awk/grep integration logic
        // verbatim; only the tiny outer wrapper is escaped into the AppleScript string, so no awk quoting or
        // shell metacharacter ever passes through osaCommand() — it sees opaque base64 plus a 6-line wrapper.
        let helper = """
        #!/bin/sh
        set -e
        umask 022
        install -d /etc/ssh/sshd_config.d
        # Force our drop-in Include ABOVE any forwarding/Match directive (sshd keeps the first obtained value).
        inc=$(grep -nE '^[[:space:]]*Include[[:space:]].*sshd_config\\.d' /etc/ssh/sshd_config 2>/dev/null | head -1 | cut -d: -f1)
        bad=$(grep -nE '^[[:space:]]*(AllowTcpForwarding|AllowStreamLocalForwarding|Match)([[:space:]]|$)' /etc/ssh/sshd_config 2>/dev/null | head -1 | cut -d: -f1)
        if [ -z "$inc" ] || { [ -n "$bad" ] && [ "$bad" -lt "$inc" ]; }; then t=$(mktemp); printf 'Include /etc/ssh/sshd_config.d/*.conf\\n' > "$t"; cat /etc/ssh/sshd_config >> "$t"; cat "$t" > /etc/ssh/sshd_config; rm -f "$t"; fi
        printf %s '\(b64(sshdContent))' | base64 -D > '\(sshdDropIn)'; chmod 644 '\(sshdDropIn)'
        # Assert EFFECTIVE forwarding policy (sshd -T merges Include + Match), not file presence.
        sshd -T 2>/dev/null | grep -qx 'allowtcpforwarding local' || { echo 'sshd -T: AllowTcpForwarding not local' >&2; exit 1; }
        sshd -T 2>/dev/null | grep -qx 'allowstreamlocalforwarding local' || { echo 'sshd -T: AllowStreamLocalForwarding not local' >&2; exit 1; }
        printf %s '\(b64(pfAnchorContent))' | base64 -D > '\(pfAnchor)'; chmod 644 '\(pfAnchor)'
        # Insert our anchor call at the HEAD of the filter section (before any user quick rule) if absent.
        grep -qx 'anchor "com.x10lab.xpair"' /etc/pf.conf 2>/dev/null || { t=$(mktemp); awk '!ins && /^[[:space:]]*(block|pass|anchor)[[:space:]]/ && !/-anchor/ { print "anchor \\"com.x10lab.xpair\\""; print "load anchor \\"com.x10lab.xpair\\" from \\"\(pfAnchor)\\""; ins=1 } { print } END { if (!ins) { print "anchor \\"com.x10lab.xpair\\""; print "load anchor \\"com.x10lab.xpair\\" from \\"\(pfAnchor)\\"" } }' /etc/pf.conf > "$t"; cat "$t" > /etc/pf.conf; rm -f "$t"; }
        install -d -o root -g wheel -m 755 '\(supportDir)'
        printf %s '\(b64(loaderScript))' | base64 -D > '\(pfLoader)'; chown root:wheel '\(pfLoader)'; chmod 755 '\(pfLoader)'
        printf %s '\(b64(plistContent))' | base64 -D > '\(pfPlist)'; chmod 644 '\(pfPlist)'
        launchctl load -w '\(pfPlist)' 2>/dev/null || true
        launchctl list | grep -q com.x10lab.xpair.pf
        /bin/sh '\(pfLoader)'
        """
        let wrapper = "set -e; s=$(mktemp); printf %s '\(b64(helper))' | base64 -D > \"$s\"; /bin/sh \"$s\"; r=$?; rm -f \"$s\"; exit $r"
        return runAdmin(wrapper)
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
