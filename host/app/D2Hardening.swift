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

    // Static default-deny for :22 (no `ifconfig` enumeration). `quick` = first match wins, so the passes
    // precede the block. Pass: loopback, and any utun carrying a Tailscale source — IPv4 CGNAT
    // (100.64.0.0/10) or IPv6 tailnet (fd7a:115c:a1e0::/48). The trailing block has no address-family
    // qualifier, so it drops :22 on BOTH inet and inet6 for every other path, including any future NIC.
    static let pfAnchorContent = """
    pass in quick on lo0 proto tcp to any port 22
    pass in quick on utun proto tcp from 100.64.0.0/10 to any port 22
    pass in quick on utun inet6 proto tcp from fd7a:115c:a1e0::/48 to any port 22
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
    printf %s '\(Data(pfAnchorContent.utf8).base64EncodedString())' | base64 -D | cmp -s - '\(pfAnchor)' || { echo 'xpair pf anchor content drifted (pass may precede block)' >&2; exit 1; }
    main=$(pfctl -sr 2>/dev/null)
    a=$(printf '%s\\n' "$main" | grep -n 'anchor "com.x10lab.xpair"' | head -1 | cut -d: -f1)
    p=$(printf '%s\\n' "$main" | awk 'tolower($0) ~ /pass/ && tolower($0) ~ /quick/ { l=tolower($0); mt=(l !~ /proto /)||(l ~ /tcp/); m22=(l !~ /port /)||(l ~ /port[ =]+(22|ssh)([^0-9]|$)/); if (mt && m22) { print NR; exit } }')
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
            let t = l.trimmingCharacters(in: .whitespaces).lowercased()
            guard !t.hasPrefix("#"), t.hasPrefix("include ") else { return false }
            let p = t.dropFirst("include ".count).trimmingCharacters(in: .whitespaces)
            let abs = p.hasPrefix("/") ? p : "/etc/ssh/" + p   // sshd resolves relative includes against /etc/ssh
            return abs.hasPrefix("/etc/ssh/sshd_config.d/") && (abs.hasSuffix("/*.conf") || abs.hasSuffix("/00-xpair-d2.conf"))
        }) else { return false }
        if let bad = ls.firstIndex(where: { l in
            let t = l.trimmingCharacters(in: .whitespaces).lowercased()
            return !t.hasPrefix("#")
                && (t.hasPrefix("allowtcpforwarding") || t.hasPrefix("allowstreamlocalforwarding") || t.hasPrefix("match "))
        }) { return inc < bad }
        return true
    }

    // `sshd -T` reports only the GLOBAL forwarding value, and only the ROOT apply path can run it. The
    // unprivileged launch/gate checks must catch two drifts it would otherwise miss: a `Match` block that
    // re-enables forwarding (yes/all) for the paired login, and a drop-in that sorts BEFORE 00-xpair-d2.conf
    // setting global forwarding (first-wins). Refuse D2 if either sets forwarding to anything but `local`
    // (our target) — `no` also disqualifies, since it denies the -L locals D2 relies on.
    // ponytail: per-file Match scan (a Match spanning an Include boundary isn't tracked) — repair path:
    // full `sshd -T -C` probe if that edge ever matters.
    static func noForwardingOverride() -> Bool {
        let dir = "/etc/ssh/sshd_config.d"
        let drops = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])
            .filter { $0.hasSuffix(".conf") }.sorted()
        let files = ["/etc/ssh/sshd_config"] + drops.map { "\(dir)/\($0)" }
        for f in files {
            let early = f.hasPrefix(dir) && (f as NSString).lastPathComponent < "00-xpair-d2.conf"
            var inMatch = false
            for raw in lines(f) {
                let t = raw.trimmingCharacters(in: .whitespaces).lowercased()
                if t.hasPrefix("#") || t.isEmpty { continue }
                if t.hasPrefix("match ") { inMatch = true; continue }  // any Match scope (incl. Match all) can override
                if t.hasPrefix("allowtcpforwarding") || t.hasPrefix("allowstreamlocalforwarding") {
                    let v = t.split(separator: " ", maxSplits: 1).dropFirst().first?.trimmingCharacters(in: .whitespaces) ?? ""
                    if v != "local" && (inMatch || early) { return false }
                }
            }
        }
        return true
    }

    // pf needs BOTH the `anchor "…"` evaluation line AND `load anchor … from …`, and the anchor call must
    // be reached before any earlier `quick` :22 pass or its block never evaluates.
    // pf `set skip on <if>` passes that interface as if pf were disabled, bypassing our anchor block.
    // Refuse unless every skipped interface is loopback.
    private static func pfNoNonLoopbackSkip() -> Bool {
        for l in lines("/etc/pf.conf") {
            let t = l.trimmingCharacters(in: .whitespaces)
            guard t.hasPrefix("set skip on") else { continue }
            let rest = String(t.dropFirst("set skip on".count))
                .replacingOccurrences(of: "{", with: " ").replacingOccurrences(of: "}", with: " ")
            for tok in rest.split(whereSeparator: { $0 == " " || $0 == "\t" }) where tok != "lo" && tok != "lo0" {
                return false
            }
        }
        return true
    }

    private static func pfConfAnchorReachable() -> Bool {
        let ls = lines("/etc/pf.conf")
        guard let anchorIdx = ls.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "anchor \"com.x10lab.xpair\"" }),
              ls.contains(where: { l in
                  let t = l.trimmingCharacters(in: .whitespaces)   // ACTIVE line only — a commented `# load anchor` must not count
                  return t.hasPrefix("load anchor \"com.x10lab.xpair\"") && t.contains("from \"\(pfAnchor)\"")
              }) else { return false }
        // A `quick` pass shadows our block unless it restricts to a non-SSH port: broad passes
        // (`pass in quick all`, no `port` clause) and explicit :22/ssh passes both defeat the anchor.
        if let passIdx = ls.firstIndex(where: { l in
            let t = l.trimmingCharacters(in: .whitespaces).lowercased()
            guard t.hasPrefix("pass"), t.contains("quick") else { return false }
            let matchesTCP = !t.contains("proto ") || t.contains("tcp")
            let matches22 = !t.contains("port ") || t.contains("port 22") || t.contains("port = 22") || t.contains("port ssh")
            return matchesTCP && matches22
        }) { return anchorIdx < passIdx }
        return true
    }

    // Unprivileged launch-verify of the durable config. Live pf-kernel/`sshd -T` state can't be read without
    // root (proven at apply time, re-asserted by the boot one-shot); here we assert every readable invariant
    // that makes the enforcement EFFECTIVE, not merely present.
    static func applied() -> Bool {
        fileEquals(sshdDropIn, sshdContent)
            && sshdIncludeIsFirst()
            && noForwardingOverride()
            && fileEquals(pfLoader, loaderScript)
            && fileEquals(pfPlist, plistContent)
            && fileEquals(pfAnchor, pfAnchorContent)
            && pfConfAnchorReachable()
            && pfNoNonLoopbackSkip()
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
        # Atomic apply: snapshot every file we touch and restore each to its pre-image (or remove if new) on
        # any failure, so a partial apply — or a failed re-apply on an already-hardened host — never leaves an
        # inconsistent state (e.g. a restored pf.conf pointing at an anchor file we deleted).
        _bak=$(mktemp -d)
        for _f in /etc/pf.conf /etc/ssh/sshd_config '\(sshdDropIn)' '\(pfAnchor)' '\(pfLoader)' '\(pfPlist)'; do
          [ -e "$_f" ] && cp "$_f" "$_bak/$(echo "$_f" | tr / _)" 2>/dev/null || true
        done
        _restore() {
          for _f in /etc/pf.conf /etc/ssh/sshd_config '\(sshdDropIn)' '\(pfAnchor)' '\(pfLoader)' '\(pfPlist)'; do
            _b="$_bak/$(echo "$_f" | tr / _)"
            if [ -e "$_b" ]; then cp "$_b" "$_f" 2>/dev/null || true; else rm -f "$_f"; fi
          done
          launchctl bootout system/com.x10lab.xpair.pf 2>/dev/null || launchctl unload '\(pfPlist)' 2>/dev/null || true
          [ -e '\(pfPlist)' ] && launchctl load -w '\(pfPlist)' 2>/dev/null || true
          pfctl -f /etc/pf.conf 2>/dev/null || true
        }
        trap '_c=$?; [ "$_c" -ne 0 ] && _restore; rm -rf "$_bak"; exit $_c' EXIT
        install -d /etc/ssh/sshd_config.d
        # Force our drop-in Include ABOVE any forwarding/Match directive (sshd keeps the first obtained value).
        inc=$(grep -niE '^[[:space:]]*Include[[:space:]]+(/etc/ssh/)?sshd_config\\.d/(\\*|00-xpair-d2)\\.conf' /etc/ssh/sshd_config 2>/dev/null | head -1 | cut -d: -f1)
        bad=$(grep -niE '^[[:space:]]*(AllowTcpForwarding|AllowStreamLocalForwarding|Match)([[:space:]]|$)' /etc/ssh/sshd_config 2>/dev/null | head -1 | cut -d: -f1)
        if [ -z "$inc" ] || { [ -n "$bad" ] && [ "$bad" -lt "$inc" ]; }; then t=$(mktemp); printf 'Include /etc/ssh/sshd_config.d/*.conf\\n' > "$t"; cat /etc/ssh/sshd_config >> "$t"; cat "$t" > /etc/ssh/sshd_config; rm -f "$t"; fi
        printf %s '\(b64(sshdContent))' | base64 -D > '\(sshdDropIn)'; chmod 644 '\(sshdDropIn)'
        # Assert EFFECTIVE forwarding policy (sshd -T merges Include + Match), not file presence.
        sshd -T 2>/dev/null | grep -qx 'allowtcpforwarding local' || { echo 'sshd -T: AllowTcpForwarding not local' >&2; exit 1; }
        sshd -T 2>/dev/null | grep -qx 'allowstreamlocalforwarding local' || { echo 'sshd -T: AllowStreamLocalForwarding not local' >&2; exit 1; }
        awk -v ours="00-xpair-d2.conf" 'function base(p){ n=split(p,a,"/"); return a[n] } FNR==1{ inm=0; f=base(FILENAME); early=(index(FILENAME,"/sshd_config.d/")>0 && f<ours) } { t=$0; sub(/^[[:space:]]+/,"",t) } t ~ /^#/ {next} tolower(t) ~ /^match / { inm=1; next } tolower(t) ~ /^allow(tcp|streamlocal)forwarding/ { v=tolower($2); if (v!="local" && (inm||early)) found=1 } END { exit(found?1:0) }' /etc/ssh/sshd_config $(ls /etc/ssh/sshd_config.d/*.conf 2>/dev/null) || { echo 'sshd forwarding override (Match or earlier drop-in)' >&2; exit 1; }
        printf %s '\(b64(pfAnchorContent))' | base64 -D > '\(pfAnchor)'; chmod 644 '\(pfAnchor)'
        # Idempotently (re)install the anchor hook at the HEAD of the filter section: strip any prior
        # xpair anchor/load lines first, so a half-present hook (anchor without load, or vice versa) is repaired.
        t=$(mktemp); tt=$(mktemp); grep -vE '^[[:space:]]*(anchor "com\\.x10lab\\.xpair"|load anchor "com\\.x10lab\\.xpair")' /etc/pf.conf > "$t"; awk '!ins && /^[[:space:]]*(block|pass|anchor)[[:space:]]/ && !/-anchor/ { print "anchor \\"com.x10lab.xpair\\""; print "load anchor \\"com.x10lab.xpair\\" from \\"\(pfAnchor)\\""; ins=1 } { print } END { if (!ins) { print "anchor \\"com.x10lab.xpair\\""; print "load anchor \\"com.x10lab.xpair\\" from \\"\(pfAnchor)\\"" } }' "$t" > "$tt"; cat "$tt" > /etc/pf.conf; rm -f "$t" "$tt"
        awk 'tolower($1)=="set" && tolower($2)=="skip" && tolower($3)=="on" { for (i=4;i<=NF;i++){ g=$i; gsub(/[{}]/,"",g); if (g!="" && g!="lo" && g!="lo0") bad=1 } } END { exit(bad?1:0) }' /etc/pf.conf || { echo 'pf set skip on non-loopback interface' >&2; exit 1; }
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
