// PairingManager.swift — hardened Broadcast pairing backend (US-004).
//
// The host webview is only a display/decision surface. Trust decisions happen here:
// signed request verification, locally-computed client key fingerprint, hardened
// authorized_keys writes, and the two-phase pending-proof → paired transition.

import Foundation
import CryptoKit
import Darwin
import Network
import Security

enum PairingSecurityError: Error, CustomStringConvertible {
    case missingHostKey
    case malformedRequest(String)
    case malformedKey(String)
    case badSignature
    case staleTimestamp
    case replay
    case budgetExceeded
    case noActiveWindow
    case noIncomingRequest
    case requestMismatch
    case invalidClientID
    case proofExpired
    case proofNotPending
    case missingLoginFingerprint
    case proofFingerprintMismatch
    case gateUnavailable(String)
    case randomUnavailable(OSStatus)

    var description: String {
        switch self {
        case .missingHostKey: return "host SSH key fingerprint unavailable"
        case .malformedRequest(let s): return "malformed pairing request: \(s)"
        case .malformedKey(let s): return "malformed client key: \(s)"
        case .badSignature: return "invalid pairing signature"
        case .staleTimestamp: return "pairing request timestamp is stale or from the future"
        case .replay: return "pairing request replay rejected"
        case .budgetExceeded: return "pairing request budget exceeded"
        case .noActiveWindow: return "pairing window is not open"
        case .noIncomingRequest: return "no verified incoming request"
        case .requestMismatch: return "pairing request no longer matches the approved request"
        case .invalidClientID: return "invalid client id"
        case .proofExpired: return "pairing proof deadline expired"
        case .proofNotPending: return "pairing proof is not pending"
        case .missingLoginFingerprint: return "missing SSH login key fingerprint"
        case .proofFingerprintMismatch: return "SSH login key fingerprint does not match approved key"
        case .gateUnavailable(let s): return "xpair SSH gate unavailable: \(s)"
        case .randomUnavailable(let status): return "secure random generation failed: \(status)"
        }
    }
}

struct PairingRequestWire {
    let clientPubKey: String
    let name: String
    let user: String
    let timestamp: Int64
    let sig: String
}

struct VerifiedPairingRequest {
    let id: String
    let name: String
    let user: String
    let sourceIP: String
    let clientPubKey: String
    let keyBlob: String
    let fingerprint: String
    let timestamp: Int64
}

struct AuthorizedClientRecord: Codable {
    var clientID: String
    var publicKey: String
    var keyBlob: String
    var fingerprint: String
    var name: String
    var created: Int64
    var status: String
    var proofDeadline: Int64
    var pairedAt: Int64?
}

private struct AuthorizedClientsLedger: Codable {
    var clients: [AuthorizedClientRecord]
}

enum PairingSecurity {
    static let timestampSkewSec: Int64 = 120

    static func canonicalTranscript(hostKeyFP: String,
                                    hostNonce: String,
                                    serviceInstanceID: String,
                                    clientPubKey: String,
                                    timestamp: Int64) -> Data {
        var out = Data()
        for field in [hostKeyFP, hostNonce, serviceInstanceID, clientPubKey, String(timestamp)] {
            let bytes = Data(field.utf8)
            var n = UInt32(bytes.count).bigEndian
            out.append(Data(bytes: &n, count: MemoryLayout<UInt32>.size))
            out.append(bytes)
        }
        return out
    }

    static func verify(_ req: PairingRequestWire,
                       sourceIP: String,
                       hostKeyFP: String,
                       hostNonce: String,
                       serviceInstanceID: String,
                       now: Int64 = Int64(Date().timeIntervalSince1970),
                       consumed: inout Set<String>) throws -> VerifiedPairingRequest {
        let parsed = try parseEd25519PublicKey(req.clientPubKey)
        guard let sig = Data(base64Encoded: req.sig), sig.count == 64 else {
            throw PairingSecurityError.malformedRequest("signature must be base64 ed25519")
        }

        let transcript = canonicalTranscript(hostKeyFP: hostKeyFP,
                                             hostNonce: hostNonce,
                                             serviceInstanceID: serviceInstanceID,
                                             clientPubKey: parsed.publicKey,
                                             timestamp: req.timestamp)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: parsed.rawKey)
        guard pub.isValidSignature(sig, for: transcript) else {
            throw PairingSecurityError.badSignature
        }
        guard timestampWithinSkew(req.timestamp, now: now) else {
            throw PairingSecurityError.staleTimestamp
        }

        var digestInput = transcript
        digestInput.append(sig)
        let digest = hex(SHA256.hash(data: digestInput))
        guard !consumed.contains(digest) else {
            throw PairingSecurityError.replay
        }
        consumed.insert(digest)

        return VerifiedPairingRequest(id: digest,
                                      name: sanitizeDisplay(req.name),
                                      user: sanitizeDisplay(req.user),
                                      sourceIP: sourceIP,
                                      clientPubKey: parsed.publicKey,
                                      keyBlob: parsed.keyBlob,
                                      fingerprint: fingerprintForKeyBlob(parsed.wireBlob),
                                      timestamp: req.timestamp)
    }

    static func timestampWithinSkew(_ timestamp: Int64, now: Int64) -> Bool {
        let lower = now.subtractingReportingOverflow(timestampSkewSec)
        let upper = now.addingReportingOverflow(timestampSkewSec)
        guard !lower.overflow, !upper.overflow else { return false }
        return timestamp >= lower.partialValue && timestamp <= upper.partialValue
    }

    static func parseEd25519PublicKey(_ key: String) throws -> (publicKey: String, keyBlob: String, wireBlob: Data, rawKey: Data) {
        let parts = key.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
            .map(String.init)
        guard parts.count == 2, parts[0] == "ssh-ed25519" else {
            throw PairingSecurityError.malformedKey("expected exactly: ssh-ed25519 <base64>")
        }
        guard parts[1].range(of: #"^[A-Za-z0-9+/]+={0,2}$"#, options: .regularExpression) != nil,
              let blob = Data(base64Encoded: parts[1]) else {
            throw PairingSecurityError.malformedKey("invalid base64 key blob")
        }
        var off = 0
        let type = try readSSHString(blob, offset: &off)
        guard String(data: type, encoding: .utf8) == "ssh-ed25519" else {
            throw PairingSecurityError.malformedKey("wire key type is not ssh-ed25519")
        }
        let raw = try readSSHString(blob, offset: &off)
        guard raw.count == 32, off == blob.count else {
            throw PairingSecurityError.malformedKey("ed25519 key blob has wrong shape")
        }
        return ("ssh-ed25519 \(parts[1])", parts[1], blob, raw)
    }

    static func fingerprintForKeyBlob(_ blob: Data) -> String {
        Data(SHA256.hash(data: blob))
            .base64EncodedString()
            .replacingOccurrences(of: "=", with: "")
            .withPrefix("SHA256:")
    }

    static func fingerprintForPublicKey(_ key: String) throws -> String {
        fingerprintForKeyBlob(try parseEd25519PublicKey(key).wireBlob)
    }

    static func sanitizeDisplay(_ s: String) -> String {
        let oneLine = s.replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return oneLine.isEmpty ? "unknown" : String(oneLine.prefix(120))
    }

    static func sanitizeCommentValue(_ s: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._@-")
        let scalars = sanitizeDisplay(s).unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
        let out = String(scalars).trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        return out.isEmpty ? "unknown" : String(out.prefix(80))
    }

    static func clientID(forKeyBlob keyBlob: String) -> String {
        let digest = SHA256.hash(data: Data(keyBlob.utf8))
        return String(Data(digest).base64URLNoPadding().prefix(24))
    }

    static func validateClientID(_ id: String) -> Bool {
        id.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
    }

    static func proofMatches(approvedFingerprint: String, loginFingerprint: String) -> Bool {
        approvedFingerprint == loginFingerprint
    }

    private static func readSSHString(_ data: Data, offset: inout Int) throws -> Data {
        guard offset + 4 <= data.count else { throw PairingSecurityError.malformedKey("truncated ssh string length") }
        let n = data[offset..<offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        offset += 4
        guard offset + Int(n) <= data.count else {
            throw PairingSecurityError.malformedKey("truncated ssh string")
        }
        let out = data[offset..<offset + Int(n)]
        offset += Int(n)
        return Data(out)
    }

    static func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
        bytes.map { String(format: "%02x", Int($0)) }.joined()
    }
}

private extension String {
    func withPrefix(_ prefix: String) -> String { prefix + self }
}

private extension Data {
    func base64URLNoPadding() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "=", with: "")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
    }
}

enum XpairAuthorizedKeys {
    static let proofTimeoutSec: Int64 = 600
    static let remoteDesktopSignalPort = 8890
    static var selfTestHomeOverride: String?
    static var selfTestGatePathOverride: String?
    static var home: String { selfTestHomeOverride ?? HOME }
    static var defaultGatePath: String { "\(home)/.xpair/host/bin/xpair-ssh-gate" }
    static var gatePath: String { selfTestGatePathOverride ?? defaultGatePath }
    static var sshDir: String { "\(home)/.ssh" }
    static var authorizedKeysPath: String { "\(home)/.ssh/authorized_keys" }
    static var lockPath: String { "\(home)/.ssh/.xpair-authorized-keys.lock" }
    static var ledgerPath: String { "\(home)/.xpair/authorized_clients.json" }

    static func buildRestrictedLine(publicKey: String,
                                    clientID: String,
                                    fingerprint: String,
                                    created: Int64,
                                    name: String,
                                    paired: Bool) throws -> String {
        let parsed = try PairingSecurity.parseEd25519PublicKey(publicKey)
        guard PairingSecurity.validateClientID(clientID) else { throw PairingSecurityError.invalidClientID }
        let safeName = PairingSecurity.sanitizeCommentValue(name)
        let comment = "xpair:v1 client_id=\(clientID) fp=\(fingerprint) created=\(created) name=\(safeName)"
        // Forwarding is granted ONLY once the client is `paired` (proof completed). While
        // accepted-pending-proof the line is bare `restrict,pty,command=…`: restrict denies BOTH -L and
        // -R, so a forwarding-only `ssh -N -L …:8890` connection (which never triggers the forced gate
        // command, hence never runs the proof) cannot reach the RD sidecar during the proof window.
        // xpair-ssh-gate adds `port-forwarding,permitopen=…` to this line the instant it flips the
        // ledger to `paired` (see add_authorized_key_forwarding). port-forwarding re-enables -L (and -R);
        // permitopen constrains -L to loopback (all ports) so VSCode Remote / open-remote-ssh forwards
        // work; permitopen does NO resolution, so IPv4, IPv6 and the `localhost` name are listed
        // explicitly. `127.0.0.1:*` still covers the RD signaling port (remoteDesktopSignalPort). There is
        // NO valid authorized_keys value that denies all -R (permitlisten accepts only "[host:]port"/*), so
        // -R is denied host-wide by D2Hardening (AllowTcpForwarding local); the forced-command gate +
        // fingerprint binding is the real boundary.
        let forwarding = paired ? #"port-forwarding,permitopen="127.0.0.1:*",permitopen="[::1]:*",permitopen="localhost:*","# : ""
        return #"restrict,pty,\#(forwarding)command="\#(gatePath) \#(clientID) \#(fingerprint)",no-agent-forwarding,no-X11-forwarding,no-user-rc \#(parsed.publicKey) \#(comment)"#
    }

    static func install(_ req: VerifiedPairingRequest) throws -> AuthorizedClientRecord {
        try withAuthorizedKeysLock {
            try ensureSSHDir()
            let now = Int64(Date().timeIntervalSince1970)
            let clientID = PairingSecurity.clientID(forKeyBlob: req.keyBlob)
            guard PairingSecurity.validateClientID(clientID) else { throw PairingSecurityError.invalidClientID }
            // paired: false — install at accept time grants NO forwarding; the gate adds it on proof.
            let line = try buildRestrictedLine(publicKey: req.clientPubKey,
                                               clientID: clientID,
                                               fingerprint: req.fingerprint,
                                               created: now,
                                               name: req.name,
                                               paired: false)
            let originalLines = readAuthorizedKeyLines()
            var lines = originalLines
            // Remove only Xpair-marked (xpair:v1) same-blob / same-client lines; unmarked same-blob
            // entries are the user's own key and are preserved. The client now pairs with a DEDICATED
            // key (~/.xpair/host/pairing_ed25519, never the personal id_ed25519), so this key blob
            // never collides with a user/legacy line — only the restricted forced-command line ends up
            // authorizing it, and xpair-ssh-gate always runs (the proof completes).
            lines.removeAll { existing in
                isXpairAuthorizedKeyLine(existing) &&
                    (authorizedKeyBlob(in: existing) == req.keyBlob ||
                     existing.contains("client_id=\(clientID)"))
            }
            lines.append(line)

            let originalLedger = readLedger()
            var ledger = originalLedger
            ledger.clients.removeAll { $0.clientID == clientID || $0.keyBlob == req.keyBlob }
            let rec = AuthorizedClientRecord(clientID: clientID,
                                             publicKey: req.clientPubKey,
                                             keyBlob: req.keyBlob,
                                             fingerprint: req.fingerprint,
                                             name: req.name,
                                             created: now,
                                             status: "accepted-pending-proof",
                                             proofDeadline: now + proofTimeoutSec,
                                             pairedAt: nil)
            ledger.clients.append(rec)
            try writeLedger(ledger)
            do {
                try ensureGateHelperReady()
                try writeAuthorizedKeyLines(lines)
                return rec
            } catch {
                try? writeLedger(originalLedger)
                try? writeAuthorizedKeyLines(originalLines)
                throw error
            }
        }
    }

    static func revoke(clientID: String) throws {
        try withAuthorizedKeysLock {
            var lines = readAuthorizedKeyLines()
            lines.removeAll { $0.contains(" xpair:v1 ") && $0.contains("client_id=\(clientID)") }
            try writeAuthorizedKeyLines(lines)
            var ledger = readLedger()
            ledger.clients.removeAll { $0.clientID == clientID }
            try writeLedger(ledger)
        }
    }

    static func expirePendingProofs(now: Int64 = Int64(Date().timeIntervalSince1970)) {
        let expired = withAuthorizedKeysLockNoThrow {
            readLedger().clients
                .filter { $0.status == "accepted-pending-proof" && $0.proofDeadline < now }
                .map(\.clientID)
        }
        for id in expired {
            do {
                try revoke(clientID: id)
                log(.warn, "pairing: rolled back unproven accepted key client_id=\(id)")
            } catch {
                log(.warn, "pairing: rollback failed for client_id=\(id): \(error)")
            }
        }
    }

    static func markPaired(clientID: String, loginFingerprint: String?) throws {
        try withAuthorizedKeysLock {
            var ledger = readLedger()
            guard let idx = ledger.clients.firstIndex(where: { $0.clientID == clientID }) else {
                throw PairingSecurityError.invalidClientID
            }
            let now = Int64(Date().timeIntervalSince1970)
            guard ledger.clients[idx].status == "accepted-pending-proof" else {
                throw PairingSecurityError.proofNotPending
            }
            guard ledger.clients[idx].proofDeadline >= now else {
                ledger.clients.remove(at: idx)
                try writeLedger(ledger)
                throw PairingSecurityError.proofExpired
            }
            let approved = ledger.clients[idx].fingerprint
            guard let login = loginFingerprint?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !login.isEmpty else {
                throw PairingSecurityError.missingLoginFingerprint
            }
            guard PairingSecurity.proofMatches(approvedFingerprint: approved, loginFingerprint: login) else {
                throw PairingSecurityError.proofFingerprintMismatch
            }
            ledger.clients[idx].status = "paired"
            ledger.clients[idx].pairedAt = now
            try writeLedger(ledger)
        }
    }

    static func latestPaired() -> AuthorizedClientRecord? {
        withAuthorizedKeysLockNoThrow {
            readLedger().clients
                .filter { $0.status == "paired" }
                .sorted { ($0.pairedAt ?? 0) > ($1.pairedAt ?? 0) }
                .first
        }
    }

    static func pending(clientID: String) -> AuthorizedClientRecord? {
        withAuthorizedKeysLockNoThrow {
            readLedger().clients.first { $0.clientID == clientID && $0.status == "accepted-pending-proof" }
        }
    }

    static func nextPendingProofDeadline() -> Int64? {
        withAuthorizedKeysLockNoThrow {
            readLedger().clients
                .filter { $0.status == "accepted-pending-proof" }
                .map(\.proofDeadline)
                .min()
        }
    }

    private static func ensureSSHDir() throws {
        try FileManager.default.createDirectory(atPath: sshDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        chmod(sshDir, 0o700)
        if !FileManager.default.fileExists(atPath: authorizedKeysPath) {
            FileManager.default.createFile(atPath: authorizedKeysPath, contents: Data(), attributes: [.posixPermissions: 0o600])
        }
        chmod(authorizedKeysPath, 0o600)
    }

    private static func readAuthorizedKeyLines() -> [String] {
        guard let raw = try? String(contentsOfFile: authorizedKeysPath, encoding: .utf8) else { return [] }
        return raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init).filter { !$0.isEmpty }
    }

    private static func authorizedKeyBlob(in line: String) -> String? {
        let fields = line.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
            .map(String.init)
        for i in fields.indices where fields[i] == "ssh-ed25519" && i + 1 < fields.count {
            return fields[i + 1]
        }
        return nil
    }

    private static func isXpairAuthorizedKeyLine(_ line: String) -> Bool {
        line.contains(" xpair:v1 ")
    }

    private static func writeAuthorizedKeyLines(_ lines: [String]) throws {
        let tmp = "\(authorizedKeysPath).xpair.\(getpid()).tmp"
        let body = lines.joined(separator: "\n") + (lines.isEmpty ? "" : "\n")
        try body.write(toFile: tmp, atomically: false, encoding: .utf8)
        chmod(tmp, 0o600)
        guard rename(tmp, authorizedKeysPath) == 0 else {
            let err = errno
            try? FileManager.default.removeItem(atPath: tmp)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
        }
        chmod(authorizedKeysPath, 0o600)
    }

    private static func readLedger() -> AuthorizedClientsLedger {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: ledgerPath)),
              let ledger = try? JSONDecoder().decode(AuthorizedClientsLedger.self, from: data) else {
            return AuthorizedClientsLedger(clients: [])
        }
        return ledger
    }

    private static func writeLedger(_ ledger: AuthorizedClientsLedger) throws {
        let dir = (ledgerPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        chmod(dir, 0o700)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try enc.encode(ledger)
        let tmp = "\(ledgerPath).\(getpid()).tmp"
        try data.write(to: URL(fileURLWithPath: tmp), options: [])
        chmod(tmp, 0o600)
        guard rename(tmp, ledgerPath) == 0 else {
            let err = errno
            try? FileManager.default.removeItem(atPath: tmp)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
        }
        chmod(ledgerPath, 0o600)
    }

    private static func withAuthorizedKeysLock<T>(_ body: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(atPath: sshDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let fd = open(lockPath, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { flock(fd, LOCK_UN) }
        return try body()
    }

    private static func withAuthorizedKeysLockNoThrow<T>(_ body: () -> T) -> T {
        (try? withAuthorizedKeysLock(body)) ?? body()
    }

    static func gateHelperScript() -> String {
        #"""
        #!/bin/sh
        set -eu
        id="${1:-}"
        login_fp="${2:-}"
        case "$id" in
          ""|*[!A-Za-z0-9_-]*)
            echo "xpair-ssh-gate: invalid client id" >&2
            exit 64
            ;;
        esac
        case "$login_fp" in
          SHA256:*) ;;
          *)
            echo "xpair-ssh-gate: missing SSH login key fingerprint" >&2
            exit 64
            ;;
        esac
        case "$login_fp" in
          *[!A-Za-z0-9:+=/_-]*)
            echo "xpair-ssh-gate: invalid SSH login key fingerprint" >&2
            exit 64
            ;;
        esac

        export XPAIR_GATE_ID="$id"
        export XPAIR_GATE_LOGIN_FP="$login_fp"
        export XPAIR_GATE_LEDGER="$HOME/.xpair/authorized_clients.json"
        export XPAIR_GATE_LOCK="$HOME/.ssh/.xpair-authorized-keys.lock"
        export XPAIR_GATE_AUTHORIZED_KEYS="$HOME/.ssh/authorized_keys"

        gate_action="$(
        /usr/bin/perl <<'PERL'
        use strict;
        use warnings;
        use Fcntl qw(:flock);
        use JSON::PP;

        sub reject {
          my ($message, $code) = @_;
          print STDERR "xpair-ssh-gate: $message\n";
          exit($code || 65);
        }

        my $id = $ENV{"XPAIR_GATE_ID"} // "";
        my $login_fp = $ENV{"XPAIR_GATE_LOGIN_FP"} // "";
        my $ledger_path = $ENV{"XPAIR_GATE_LEDGER"} // "";
        my $lock_path = $ENV{"XPAIR_GATE_LOCK"} // "";
        my $auth_path = $ENV{"XPAIR_GATE_AUTHORIZED_KEYS"} // "";
        reject("invalid client id", 64) unless $id =~ /\A[A-Za-z0-9_-]+\z/;
        reject("missing SSH login key fingerprint", 64) unless $login_fp =~ /\ASHA256:[A-Za-z0-9+\/=_-]+\z/;

        open(my $lock_fh, ">>", $lock_path) or reject("cannot open ledger lock", 65);
        flock($lock_fh, LOCK_EX) or reject("cannot lock ledger", 65);

        -f $ledger_path or reject("client is not authorized", 66);
        open(my $ledger_fh, "<", $ledger_path) or reject("cannot read ledger", 65);
        local $/;
        my $raw = <$ledger_fh>;
        close($ledger_fh);

        my $ledger = eval { JSON::PP->new->decode($raw || '{"clients":[]}') };
        reject("ledger is malformed", 65) if $@ || ref($ledger) ne "HASH";
        my $clients = $ledger->{clients};
        reject("ledger has no clients", 66) unless ref($clients) eq "ARRAY";

        my $idx = -1;
        for my $i (0 .. $#$clients) {
          my $rec = $clients->[$i];
          if (ref($rec) eq "HASH" && ($rec->{clientID} // "") eq $id) {
            $idx = $i;
            last;
          }
        }
        reject("client is not authorized", 66) if $idx < 0;

        sub write_ledger {
          my $json = JSON::PP->new->canonical(1)->pretty(1)->encode($ledger);
          my $tmp = "$ledger_path.$$.tmp";
          open(my $out, ">", $tmp) or reject("cannot write ledger", 65);
          print {$out} $json;
          close($out) or reject("cannot close ledger", 65);
          chmod 0600, $tmp;
          rename($tmp, $ledger_path) or reject("cannot replace ledger", 65);
          chmod 0600, $ledger_path;
        }

        sub remove_authorized_key_line {
          return unless -f $auth_path;
          open(my $in, "<", $auth_path) or reject("cannot read authorized_keys", 65);
          my @kept;
          while (my $line = <$in>) {
            my $is_xpair = index($line, " xpair:v1 ") >= 0;
            my $is_client = index($line, "client_id=$id") >= 0;
            push @kept, $line unless $is_xpair && $is_client;
          }
          close($in);
          my $tmp = "$auth_path.$$.tmp";
          open(my $out, ">", $tmp) or reject("cannot write authorized_keys", 65);
          print {$out} @kept;
          close($out) or reject("cannot close authorized_keys", 65);
          chmod 0600, $tmp;
          rename($tmp, $auth_path) or reject("cannot replace authorized_keys", 65);
          chmod 0600, $auth_path;
        }

        # Grant forwarding to the matching client line by inserting the tokens after `restrict,pty,`. Called
        # only after the ledger is durably `paired`, so forwarding is never live while pending. Idempotent:
        # the `!$has_fwd` guard + the anchored `\Arestrict,pty,` match (only the pending shape) make a
        # re-run on an already-forwarding line a no-op. Atomic temp+rename+chmod, mirroring
        # remove_authorized_key_line. The permitopen allowlist is hardcoded (this gate is a literal raw
        # string with no Swift interpolation); it MUST match the buildRestrictedLine paired forwarding value —
        # the self-test cross-checks both emit the same three loopback permitopen forms.
        sub add_authorized_key_forwarding {
          return unless -f $auth_path;
          open(my $in, "<", $auth_path) or reject("cannot read authorized_keys", 65);
          my @out; my $changed = 0;
          while (my $line = <$in>) {
            my $is_xpair  = index($line, " xpair:v1 ") >= 0;
            my $is_client = index($line, "client_id=$id") >= 0;
            my $has_fwd   = index($line, "port-forwarding") >= 0;
            if ($is_xpair && $is_client && !$has_fwd
                && $line =~ s/\Arestrict,pty,/restrict,pty,port-forwarding,permitopen="127.0.0.1:*",permitopen="[::1]:*",permitopen="localhost:*",/) {
              $changed = 1;
            }
            # Migrate a key paired under the old RD-port-only permitopen to the widened loopback allowlist.
            elsif ($is_xpair && $is_client && $has_fwd
                && $line =~ s/\Qport-forwarding,permitopen="127.0.0.1:8890",\E/port-forwarding,permitopen="127.0.0.1:*",permitopen="[::1]:*",permitopen="localhost:*",/) {
              $changed = 1;
            }
            push @out, $line;
          }
          close($in);
          return unless $changed;
          my $tmp = "$auth_path.$$.tmp";
          open(my $out, ">", $tmp) or reject("cannot write authorized_keys", 65);
          print {$out} @out;
          close($out) or reject("cannot close authorized_keys", 65);
          chmod 0600, $tmp;
          rename($tmp, $auth_path) or reject("cannot replace authorized_keys", 65);
          chmod 0600, $auth_path;
        }

        sub revoke_current {
          splice(@$clients, $idx, 1);
          write_ledger();
          remove_authorized_key_line();
        }

        my $rec = $clients->[$idx];
        my $status = $rec->{status} // "";
        my $now = time();
        my $deadline = 0 + ($rec->{proofDeadline} // 0);
        my $approved_fp = $rec->{fingerprint} // "";

        sub require_matching_login_fingerprint {
          reject("SSH login key fingerprint does not match approved key", 69)
            unless $approved_fp ne "" && $login_fp eq $approved_fp;
        }

        if ($status eq "accepted-pending-proof") {
          if ($deadline > 0 && $now > $deadline) {
            revoke_current();
            reject("pairing proof deadline expired", 67);
          }
          require_matching_login_fingerprint();
          $rec->{status} = "paired";
          $rec->{pairedAt} = $now;
          write_ledger();
          add_authorized_key_forwarding();   # ledger is durably paired BEFORE forwarding is granted -> crash fails closed
          print "paired\n";
          exit 0;
        }

        if ($status eq "paired") {
          require_matching_login_fingerprint();
          add_authorized_key_forwarding();   # self-heal: a prior promotion that crashed after the ledger flip
          print "exec\n";
          exit 0;
        }
        reject("client is not pending or paired", 68);
        PERL
        )"

        case "$gate_action" in
          paired)
            printf '%s\n' "xpair-ssh-gate: paired"
            exit 0
            ;;
          exec)
            ;;
          *)
            echo "xpair-ssh-gate: unexpected gate action" >&2
            exit 65
            ;;
        esac

        # D2 front-door routing, behind a flag ($HOME/.xpair/host/d2-frontdoor.enabled). When the flag is
        # absent (default) the legacy path below runs unchanged, so an unvalidated change cannot lock out
        # clients. When enabled, route command/subsystem FIRST, tmux-attach only as the fall-through
        # (a pty is not "interactive": `ssh -tt host cmd` has both a pty and a command).
        # Fail-safe: require the EFFECTIVE hardening (mirrors D2Hardening.applied()) before the D2 path, so
        # the front door never runs unhardened — including when the flag is flipped on an already-running
        # host before the app applied it. Presence alone is insufficient: the drop-in must be the first
        # obtained forwarding policy (Include before any AllowTcpForwarding/Match) and the pf tailnet block
        # must be reachable (anchor evaluated before any earlier `quick` :22 pass). Any check failing →
        # legacy path.
        d2_hardened() {
          [ -f "$HOME/.xpair/host/d2-frontdoor.enabled" ] || return 1
          grep -qx 'AllowTcpForwarding local' /etc/ssh/sshd_config.d/00-xpair-d2.conf 2>/dev/null || return 1
          grep -qx 'AllowStreamLocalForwarding local' /etc/ssh/sshd_config.d/00-xpair-d2.conf 2>/dev/null || return 1
          d2_inc=$(grep -niE '^[[:space:]]*Include[[:space:]]+(/etc/ssh/)?sshd_config\.d/(\*|00-xpair-d2)\.conf' /etc/ssh/sshd_config 2>/dev/null | head -1 | cut -d: -f1)
          [ -n "$d2_inc" ] || return 1
          d2_bad=$(grep -niE '^[[:space:]]*(AllowTcpForwarding|AllowStreamLocalForwarding|Match)([[:space:]]|$)' /etc/ssh/sshd_config 2>/dev/null | head -1 | cut -d: -f1)
          { [ -z "$d2_bad" ] || [ "$d2_bad" -gt "$d2_inc" ]; } || return 1
          # No Match block may re-enable forwarding (yes/all) for the paired login.
          awk -v ours="00-xpair-d2.conf" 'function base(p){ n=split(p,a,"/"); return a[n] } FNR==1{ inm=0; f=base(FILENAME); early=(index(FILENAME,"/sshd_config.d/")>0 && f<ours) } { t=$0; sub(/^[[:space:]]+/,"",t) } t ~ /^#/ {next} tolower(t) ~ /^match / { inm=1; next } tolower(t) ~ /^allow(tcp|streamlocal)forwarding/ { v=tolower($2); if (v!="local" && (inm||early)) found=1 } END { exit(found?1:0) }' /etc/ssh/sshd_config $(ls /etc/ssh/sshd_config.d/*.conf 2>/dev/null) || return 1
          # pf enforcement must be installed to load at boot (mirror D2Hardening.applied()): the loader
          # must reload+enforce pf and the LaunchDaemon must RunAtLoad — check the enforcing markers, not size.
          grep -q 'pfctl -f /etc/pf.conf' '/Library/Application Support/Xpair/xpair-pf.sh' 2>/dev/null || return 1
          grep -q 'com.x10lab.xpair' '/Library/Application Support/Xpair/xpair-pf.sh' 2>/dev/null || return 1
          grep -q 'RunAtLoad' /Library/LaunchDaemons/com.x10lab.xpair.pf.plist 2>/dev/null || return 1
          grep -q 'com.x10lab.xpair.pf' /Library/LaunchDaemons/com.x10lab.xpair.pf.plist 2>/dev/null || return 1
          grep -qx 'block in quick proto tcp to any port 22' /etc/pf.anchors/com.x10lab.xpair 2>/dev/null || return 1
          grep -qx 'anchor "com.x10lab.xpair"' /etc/pf.conf 2>/dev/null || return 1
          grep -qE '^[[:space:]]*load anchor "com\.x10lab\.xpair" from "/etc/pf\.anchors/com\.x10lab\.xpair"' /etc/pf.conf 2>/dev/null || return 1
          awk 'tolower($1)=="set" && tolower($2)=="skip" && tolower($3)=="on" { for (i=4;i<=NF;i++){ g=$i; gsub(/[{}]/,"",g); if (g!="" && g!="lo" && g!="lo0") bad=1 } } END { exit(bad?1:0) }' /etc/pf.conf || return 1
          d2_an=$(grep -nx 'anchor "com.x10lab.xpair"' /etc/pf.conf 2>/dev/null | head -1 | cut -d: -f1)
          d2_pp=$(awk 'tolower($0) ~ /^[[:space:]]*pass/ && tolower($0) ~ /quick/ { l=tolower($0); mt=(l !~ /proto /)||(l ~ /tcp/); m22=(l !~ /port /)||(l ~ /port[ =]+(22|ssh)([^0-9]|$)/); if (mt && m22) { print NR; exit } }' /etc/pf.conf 2>/dev/null)
          { [ -z "$d2_pp" ] || [ "$d2_pp" -gt "$d2_an" ]; } || return 1
          return 0
        }
        if d2_hardened; then
          # sftp subsystem → the real sftp-server. Under a `command=` forced command, sshd sets
          # SSH_ORIGINAL_COMMAND to the exact `Subsystem sftp <cmd>` value (incl. any args), NOT "sftp".
          # Read that configured value and match it exactly — handles internal-sftp, a custom path, and
          # arguments (e.g. `internal-sftp -f AUTH -l INFO`). Exec the real sftp-server binary;
          # `internal-sftp` is an sshd-internal sentinel a forked child cannot invoke.
          # `|| true`: a hardened/`-f`-started sshd may leave sshd_config unreadable; awk's non-zero exit
          # must NOT trip `set -e` and reject every session — just fall through to exec/tmux.
          # Some sshd builds report the subsystem as the bare name (`sftp`/`internal-sftp`) rather than the
          # expanded `Subsystem` command — match both, exactly (so `echo sftp-server` still isn't misrouted).
          case "${SSH_ORIGINAL_COMMAND:-}" in
            sftp|internal-sftp) exec /usr/libexec/sftp-server ;;
          esac
          sftp_cmd=$(awk 'tolower($1)=="subsystem" && $2=="sftp" { $1=""; $2=""; sub(/^[ \t]+/,""); print; exit }' /etc/ssh/sshd_config 2>/dev/null || true)
          if [ -n "$sftp_cmd" ] && [ "${SSH_ORIGINAL_COMMAND:-}" = "$sftp_cmd" ]; then
            # shellcheck disable=SC2086 # intentional split of the configured subsystem args
            set -- $sftp_cmd; first=$1; shift
            case "$first" in
              internal-sftp|sftp-server) exec /usr/libexec/sftp-server "$@" ;;
              *) exec "$first" "$@" ;;
            esac
          fi
          # exec / scp / rsync / VS Code Remote bootstrap → the account login shell (matches stock sshd
          # env/PATH; not a hardcoded bash).
          if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
            exec "${SHELL:-/bin/zsh}" -c "$SSH_ORIGINAL_COMMAND"
          fi
          # interactive fall-through → attach the app-owned tmux-aqua server, but ONLY with a real pty
          # (`ssh -T host` / a non-terminal stdin has no tty — tmux attach would fail "not a terminal")
          # AND ONLY if the keeper is alive. Never let an SSH login START the server: one spawned under
          # sshd is not a child of XpairHost and runs without its AX/SR grant (HostManager.spawn owns the
          # keeper). Otherwise fall back to a plain login shell.
          if [ -t 0 ] && "$HOME/.local/bin/tmux-aqua" -S /tmp/aqua-tmux.sock has-session -t _keeper 2>/dev/null; then
            exec "$HOME/.local/bin/tmux-aqua" -S /tmp/aqua-tmux.sock new-session -A -s main
          fi
          exec "${SHELL:-/bin/zsh}" -l
        fi

        if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
          exec /bin/bash -lc "$SSH_ORIGINAL_COMMAND"
        fi
        exec "${SHELL:-/bin/zsh}" -l
        """#
    }

    static func ensureGateHelperReady() throws {
        let script = gateHelperScript()
        let data = Data(script.utf8)
        let dir = (gatePath as NSString).deletingLastPathComponent
        var isDir: ObjCBool = false
        if !FileManager.default.fileExists(atPath: dir, isDirectory: &isDir) {
            do {
                try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o755])
            } catch {
                throw PairingSecurityError.gateUnavailable("\(dir) is not writable: \(error)")
            }
        } else if !isDir.boolValue {
            throw PairingSecurityError.gateUnavailable("\(dir) is not a directory")
        }

        if FileManager.default.fileExists(atPath: gatePath) {
            guard FileManager.default.isWritableFile(atPath: gatePath) else {
                throw PairingSecurityError.gateUnavailable("\(gatePath) exists but is not writable")
            }
        } else {
            guard FileManager.default.isWritableFile(atPath: dir) else {
                throw PairingSecurityError.gateUnavailable("\(dir) is not writable")
            }
        }

        try data.write(to: URL(fileURLWithPath: gatePath), options: [.atomic])
        chmod(gatePath, 0o755)
        guard FileManager.default.isExecutableFile(atPath: gatePath) else {
            throw PairingSecurityError.gateUnavailable("\(gatePath) is not executable")
        }
    }
}

final class PairingUDPServer {
    let port: UInt16
    private let fd: Int32
    private let source: DispatchSourceRead
    private let onDatagram: (Data, String) -> Void

    init(queue: DispatchQueue, onDatagram: @escaping (Data, String) -> Void) throws {
        let socketFD = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard socketFD >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }

        var one: Int32 = 1
        setsockopt(socketFD, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: INADDR_ANY)
        let bindOK = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindOK == 0 else {
            let err = errno
            close(socketFD)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
        }

        var actual = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameOK = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(socketFD, $0, &len)
            }
        }
        guard nameOK == 0 else {
            let err = errno
            close(socketFD)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
        }
        self.fd = socketFD
        self.port = UInt16(bigEndian: actual.sin_port)
        self.onDatagram = onDatagram
        let readSource = DispatchSource.makeReadSource(fileDescriptor: socketFD, queue: queue)
        self.source = readSource
        readSource.setEventHandler { [weak self] in self?.receive() }
        readSource.setCancelHandler { close(socketFD) }
        readSource.resume()
    }

    func cancel() {
        source.cancel()
    }

    private func receive() {
        var buf = [UInt8](repeating: 0, count: 65535)
        var remote = sockaddr_storage()
        var len = socklen_t(MemoryLayout<sockaddr_storage>.size)
        let n = withUnsafeMutablePointer(to: &remote) { ptr -> Int in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                recvfrom(fd, &buf, buf.count, 0, sa, &len)
            }
        }
        guard n > 0 else { return }
        onDatagram(Data(buf.prefix(n)), ipString(remote))
    }

    private func ipString(_ storage: sockaddr_storage) -> String {
        var s = storage
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let sockLen = socklen_t(s.ss_len)
        let rc = withUnsafePointer(to: &s) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getnameinfo($0, sockLen, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            }
        }
        return rc == 0 ? String(cString: host) : "unknown"
    }
}

final class PairingMetadataHTTPServer {
    static let port: UInt16 = 8891
    private let listener: NWListener
    private let response: () -> [String: Any]

    init(queue: DispatchQueue, response: @escaping () -> [String: Any]) throws {
        guard let endpointPort = NWEndpoint.Port(rawValue: Self.port) else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(EINVAL))
        }
        self.response = response
        listener = try NWListener(using: .tcp, on: endpointPort)
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else {
                connection.cancel()
                return
            }
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { _, _, _, _ in
                let body = (try? JSONSerialization.data(withJSONObject: self.response(), options: [.sortedKeys]))
                    ?? Data("{}".utf8)
                // Explicit CRLF framing terminating in "\r\n\r\n". A Swift multiline literal does
                // NOT append a newline after its last line, so building the header block that way
                // yields "...Connection: close\r\n\r" (a bare CR, missing the final LF) — strict
                // HTTP parsers (Node's llhttp in the client) reject it with "Expected LF after
                // headers". See client/ide/remotepair/ext/pairing-metadata-response.test.js.
                let header =
                    "HTTP/1.1 200 OK\r\n"
                    + "Content-Type: application/json\r\n"
                    + "Cache-Control: no-store\r\n"
                    + "Content-Length: \(body.count)\r\n"
                    + "Connection: close\r\n"
                    + "\r\n"
                var payload = Data(header.utf8)
                payload.append(body)
                connection.send(content: payload, completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
        }
        listener.start(queue: queue)
    }

    func cancel() {
        listener.cancel()
    }
}

private struct SourceRateBucket {
    var tokens: Double
    var lastRefill: Int64
    var dropped: Int
    var lastSeen: Int64
}

final class PairingManager {
    static let shared = PairingManager()
    private let queue = DispatchQueue(label: "xpair.pairing")
    private var endpoint: PairingUDPServer?
    private var metadataServer: PairingMetadataHTTPServer?
    private var serviceInstanceID = ""
    private var hostNonce = ""
    private var consumed = Set<String>()
    private var rateBuckets: [String: SourceRateBucket] = [:]
    private var globalRateBucket = SourceRateBucket(tokens: 0, lastRefill: 0, dropped: 0, lastSeen: 0)
    private let globalBucketCapacity = 300.0
    private let globalBucketRefillPerSec = 30.0
    private let sourceBucketCapacity = 50.0
    private let sourceBucketRefillPerSec = 1.0
    private let maxSourceBuckets = 256
    private var sourceEvictionLogCount = 0
    private var phase = "waiting"
    private var incoming: VerifiedPairingRequest?
    private var incomingExpiresAt: Int64?
    private var frozenDropLogCount = 0
    private var accepted: AuthorizedClientRecord?
    private var lastError = ""
    private var proofExpiryTimer: DispatchSourceTimer?
    private var broadcastExpiryTimer: DispatchSourceTimer?
    private var deniedExpiryTimer: DispatchSourceTimer?
    private var deniedFingerprint = ""
    private let maxBroadcastTTLSec = 300
    private let deniedMetadataTTLSec = 30

    func beginWindow(force: Bool = false) throws -> [String: Any] {
        try queue.sync {
            XpairAuthorizedKeys.expirePendingProofs()
            scheduleProofExpiryLocked()
            // Auto-entry / resume / poll-reopen (force=false) short-circuit to "paired" when a client is
            // already paired, so an already-paired host can finish onboarding (the Next gate needs
            // broadcast==="accepted"). An EXPLICIT re-advertise (force=true — the "Pair a different
            // device" button) skips the short-circuit and opens a fresh window (new serviceInstanceID/
            // hostNonce/pairPort) so a replacement/additional client can pair — the documented Broadcast
            // recovery (blueprint §Broadcast: client still paired → re-advertise).
            if !force, let paired = XpairAuthorizedKeys.latestPaired() {
                accepted = paired
                incoming = nil
                incomingExpiresAt = nil
                phase = "paired"
                closeEndpoint()
                return statusLocked()
            }

            closeEndpoint()
            consumed.removeAll()
            rateBuckets.removeAll()
            let now = Int64(Date().timeIntervalSince1970)
            globalRateBucket = SourceRateBucket(tokens: globalBucketCapacity,
                                                lastRefill: now,
                                                dropped: 0,
                                                lastSeen: now)
            sourceEvictionLogCount = 0
            incoming = nil
            incomingExpiresAt = nil
            frozenDropLogCount = 0
            accepted = nil
            deniedFingerprint = ""
            lastError = ""
            phase = "closed"
            let nextServiceInstanceID = UUID().uuidString
            let nextHostNonce = try Self.randomToken(byteCount: 24)
            let server = try PairingUDPServer(queue: queue) { [weak self] data, ip in
                self?.handleDatagram(data, ip: ip)
            }
            phase = "waiting"
            serviceInstanceID = nextServiceInstanceID
            hostNonce = nextHostNonce
            endpoint = server
            do {
                try startMetadataServerLocked()
            } catch {
                // The fixed metadata port is in use: roll the window back to "closed" instead of leaving
                // committed phase/sid/nonce/endpoint with no metadata endpoint (which would
                // report "waiting" forever with nothing for clients to discover). closeEndpoint() resets
                // the endpoint + sid/nonce; "closed" makes the poll loop reopen (or surface the
                // error) instead of hanging.
                closeEndpoint()
                phase = "closed"
                lastError = "pairing metadata port unavailable: \(error)"
                throw error
            }
            scheduleBroadcastExpiryLocked()
            log(.info, "pairing: window opened sid=\(serviceInstanceID) udp=\(server.port)")
            return statusLocked()
        }
    }

    func endWindow() -> [String: Any] {
        queue.sync {
            if phase == "waiting" || phase == "incoming" {
                phase = "closed"
                incoming = nil
                incomingExpiresAt = nil
            }
            closeEndpoint()
            return statusLocked()
        }
    }

    func status() -> [String: Any] {
        queue.sync {
            expireFrozenIncomingLocked()
            XpairAuthorizedKeys.expirePendingProofs()
            if let rec = accepted, XpairAuthorizedKeys.latestPaired()?.clientID == rec.clientID {
                accepted = XpairAuthorizedKeys.latestPaired()
                phase = "paired"
            } else if accepted == nil, let paired = XpairAuthorizedKeys.latestPaired(), phase != "waiting", phase != "incoming", phase != "denied" {
                // `accepted == nil` guard: promote from the ledger ONLY on a genuine resume (no in-session
                // accepted record). Without it, while a NEW client is mid-proof on a re-advertised window
                // (accepted=newClient, phase=accepted-pending-proof), latestPaired() still returns the OLD
                // client and this would falsely flip the UI to "paired" with the old one and enable Next.
                // `phase != "denied"` guard: denyIncoming() sets phase="denied" and exposes deniedFingerprint
                // for the denial TTL; promoting the old paired client here would clobber that observable state.
                accepted = paired
                phase = "paired"
            } else if let rec = accepted, XpairAuthorizedKeys.pending(clientID: rec.clientID) == nil, phase == "accepted-pending-proof" {
                // acceptIncoming() already closed the UDP endpoint, so roll back to "closed" (NOT
                // "waiting") — the React poller only reopens the backend on "closed". "waiting" would
                // report a live broadcast with pairPort 0 that no client could reach. (Mirrors the
                // scheduleProofExpiryLocked rollback.)
                phase = "closed"
                accepted = nil
                incoming = nil
                incomingExpiresAt = nil
                lastError = "pending proof expired; installed key was rolled back"
            }
            scheduleProofExpiryLocked()
            return statusLocked()
        }
    }

    func acceptIncoming(requestID: String, fingerprint: String) throws -> [String: Any] {
        try queue.sync {
            expireFrozenIncomingLocked()
            guard let req = incoming else { throw PairingSecurityError.noIncomingRequest }
            guard req.id == requestID,
                  !fingerprint.isEmpty,
                  fingerprint == req.fingerprint else {
                throw PairingSecurityError.requestMismatch
            }
            let rec = try XpairAuthorizedKeys.install(req)
            accepted = rec
            incoming = nil
            incomingExpiresAt = nil
            phase = "accepted-pending-proof"
            closeEndpoint()
            scheduleProofExpiryLocked()
            log(.info, "pairing: accepted client_id=\(rec.clientID) fp=\(rec.fingerprint)")
            return statusLocked()
        }
    }

    func denyIncoming() -> [String: Any] {
        queue.sync {
            deniedFingerprint = incoming?.fingerprint ?? ""
            incoming = nil
            incomingExpiresAt = nil
            accepted = nil
            phase = "denied"
            closeEndpoint(cancelMetadata: false)
            scheduleDeniedExpiryLocked()
            log(.info, "pairing: denied incoming request")
            return statusLocked()
        }
    }

    func hasPairedClient() -> Bool {
        XpairAuthorizedKeys.expirePendingProofs()
        return XpairAuthorizedKeys.latestPaired() != nil
    }

    private func handleDatagram(_ data: Data, ip: String) {
        guard endpoint != nil, phase == "waiting" || phase == "incoming" else { return }
        let now = Int64(Date().timeIntervalSince1970)
        guard allowDatagramFromSource(ip, now: now) else { return }
        expireFrozenIncomingLocked(now: now)
        if incoming != nil {
            frozenDropLogCount += 1
            if frozenDropLogCount <= 3 || frozenDropLogCount % 25 == 0 {
                log(.info, "pairing: frozen incoming request is displayed; dropping later datagram from=\(ip)")
            }
            return
        }
        do {
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw PairingSecurityError.malformedRequest("JSON object expected")
            }
            let req = try Self.decodeRequest(obj)
            guard let hostFP = hostKeyFingerprint() else { throw PairingSecurityError.missingHostKey }
            let verified = try PairingSecurity.verify(req,
                                                      sourceIP: ip,
                                                      hostKeyFP: hostFP,
                                                      hostNonce: hostNonce,
                                                      serviceInstanceID: serviceInstanceID,
                                                      consumed: &consumed)
            incoming = verified
            // Base the host-approval TTL on RECEIPT time (now), not the client timestamp: a client clock
            // that is behind the host but within the ±skew replay window would otherwise set a deadline
            // only seconds after arrival, so the incoming request could vanish before the user can
            // Accept. The timestamp is still validated for replay freshness in PairingSecurity.verify.
            incomingExpiresAt = now + PairingSecurity.timestampSkewSec
            frozenDropLogCount = 0
            phase = "incoming"
            lastError = ""
            log(.info, "pairing: verified incoming request fp=\(verified.fingerprint) from=\(ip)")
        } catch {
            lastError = String(describing: error)
            log(.warn, "pairing: request rejected from \(ip): \(lastError)")
        }
    }

    private static func decodeRequest(_ obj: [String: Any]) throws -> PairingRequestWire {
        guard let clientPubKey = obj["clientPubKey"] as? String, !clientPubKey.isEmpty else {
            throw PairingSecurityError.malformedRequest("missing clientPubKey")
        }
        guard let sig = obj["sig"] as? String, !sig.isEmpty else {
            throw PairingSecurityError.malformedRequest("missing sig")
        }
        let name = (obj["name"] as? String) ?? "unknown"
        let user = (obj["user"] as? String) ?? "unknown"
        let ts: Int64
        if let n = obj["timestamp"] as? Int64 { ts = n }
        else if let n = obj["timestamp"] as? Int { ts = Int64(n) }
        else if let n = obj["timestamp"] as? NSNumber { ts = n.int64Value }
        else { throw PairingSecurityError.malformedRequest("missing timestamp") }
        return PairingRequestWire(clientPubKey: clientPubKey, name: name, user: user, timestamp: ts, sig: sig)
    }

    private func allowDatagramFromSource(_ ip: String, now: Int64) -> Bool {
        guard consumeGlobalDatagramToken(now: now) else { return false }
        let key = ip.isEmpty ? "unknown" : ip
        if rateBuckets[key] == nil && rateBuckets.count >= maxSourceBuckets {
            evictLRUSourceBucket()
        }

        var bucket = rateBuckets[key] ?? SourceRateBucket(tokens: sourceBucketCapacity,
                                                          lastRefill: now,
                                                          dropped: 0,
                                                          lastSeen: now)
        bucket.lastSeen = now
        let elapsed = max(0, now - bucket.lastRefill)
        if elapsed > 0 {
            bucket.tokens = min(sourceBucketCapacity,
                                bucket.tokens + Double(elapsed) * sourceBucketRefillPerSec)
            bucket.lastRefill = now
        }

        guard bucket.tokens >= 1 else {
            bucket.dropped += 1
            rateBuckets[key] = bucket
            if bucket.dropped <= 3 || bucket.dropped % 25 == 0 {
                log(.warn, "pairing: source \(key) exceeded UDP token bucket; dropping request")
            }
            return false
        }

        bucket.tokens -= 1
        bucket.dropped = 0
        rateBuckets[key] = bucket
        return true
    }

    private func consumeGlobalDatagramToken(now: Int64) -> Bool {
        var bucket = globalRateBucket
        bucket.lastSeen = now
        let elapsed = max(0, now - bucket.lastRefill)
        if elapsed > 0 {
            bucket.tokens = min(globalBucketCapacity,
                                bucket.tokens + Double(elapsed) * globalBucketRefillPerSec)
            bucket.lastRefill = now
        }

        guard bucket.tokens >= 1 else {
            bucket.dropped += 1
            globalRateBucket = bucket
            lastError = "broadcast rate limit exceeded; retry shortly"
            if bucket.dropped <= 3 || bucket.dropped % 25 == 0 {
                log(.warn, "pairing: global UDP token bucket exhausted; dropping request")
            }
            return false
        }

        bucket.tokens -= 1
        bucket.dropped = 0
        globalRateBucket = bucket
        return true
    }

    private func evictLRUSourceBucket() {
        guard let oldest = rateBuckets.min(by: { lhs, rhs in
            if lhs.value.lastSeen == rhs.value.lastSeen { return lhs.key < rhs.key }
            return lhs.value.lastSeen < rhs.value.lastSeen
        })?.key else {
            return
        }
        rateBuckets.removeValue(forKey: oldest)
        sourceEvictionLogCount += 1
        if sourceEvictionLogCount <= 3 || sourceEvictionLogCount % 25 == 0 {
            log(.warn, "pairing: evicted least-recent UDP source bucket; table_size=\(rateBuckets.count)")
        }
    }

    private func expireFrozenIncomingLocked(now: Int64 = Int64(Date().timeIntervalSince1970)) {
        guard let deadline = incomingExpiresAt, let req = incoming, now > deadline else { return }
        log(.info, "pairing: incoming request timed out fp=\(req.fingerprint)")
        incoming = nil
        incomingExpiresAt = nil
        frozenDropLogCount = 0
        if phase == "incoming" { phase = "waiting" }
    }

    private func scheduleProofExpiryLocked() {
        proofExpiryTimer?.cancel()
        proofExpiryTimer = nil
        guard let deadline = XpairAuthorizedKeys.nextPendingProofDeadline() else { return }
        let now = Int64(Date().timeIntervalSince1970)
        let delay = max(1, Int(deadline - now + 1))
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(delay))
        timer.setEventHandler { [weak self] in
            XpairAuthorizedKeys.expirePendingProofs()
            guard let self else { return }
            if let rec = self.accepted, XpairAuthorizedKeys.latestPaired()?.clientID == rec.clientID {
                self.accepted = XpairAuthorizedKeys.latestPaired()
                self.phase = "paired"
            } else if let rec = self.accepted,
                      XpairAuthorizedKeys.pending(clientID: rec.clientID) == nil,
                      self.phase == "accepted-pending-proof" {
                // acceptIncoming() already closed the UDP endpoint, so there is
                // nothing to broadcast on. Roll back to "closed" (NOT "waiting"): the host UI auto-calls
                // beginPairing() only on "closed", reopening a fresh endpoint. Leaving it "waiting" would
                // show a live broadcast while pairPort is 0 and no client could ever send a new request.
                self.phase = "closed"
                self.accepted = nil
                self.incoming = nil
                self.incomingExpiresAt = nil
                self.lastError = "pending proof expired; installed key was rolled back"
            }
            self.scheduleProofExpiryLocked()
        }
        proofExpiryTimer = timer
        timer.resume()
    }

    private func scheduleBroadcastExpiryLocked() {
        broadcastExpiryTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(maxBroadcastTTLSec))
        timer.setEventHandler { [weak self] in
            self?.expireBroadcastWindowLocked()
        }
        broadcastExpiryTimer = timer
        timer.resume()
    }

    private func scheduleDeniedExpiryLocked() {
        deniedExpiryTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(deniedMetadataTTLSec))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if self.phase == "denied" {
                self.phase = "closed"
                self.deniedFingerprint = ""
                self.closeEndpoint(cancelBroadcastTimer: false)
            }
        }
        deniedExpiryTimer = timer
        timer.resume()
    }

    private func expireBroadcastWindowLocked() {
        broadcastExpiryTimer?.cancel()
        broadcastExpiryTimer = nil
        guard endpoint != nil, phase == "waiting" || phase == "incoming" else {
            closeEndpoint(cancelBroadcastTimer: false)
            return
        }
        phase = "closed"
        incoming = nil
        incomingExpiresAt = nil
        frozenDropLogCount = 0
        lastError = "broadcast expired; restart pairing"
        log(.info, "pairing: broadcast TTL expired; endpoint closed")
        closeEndpoint(cancelBroadcastTimer: false)
    }

    private func statusLocked() -> [String: Any] {
        var out: [String: Any] = [
            "phase": phase,
            "state": phase == "paired" ? "accepted" : phase,
            "serviceInstanceID": serviceInstanceID,
            "hostNonce": hostNonce,
            "pairPort": endpoint?.port ?? 0,
            "error": lastError,
        ]
        if phase == "denied", !deniedFingerprint.isEmpty {
            out["deniedFingerprint"] = deniedFingerprint
        }
        if let req = incoming {
            out["request"] = [
                "id": req.id,
                "name": req.name,
                "user": req.user,
                "ip": req.sourceIP,
                "keyFingerprint": req.fingerprint,
            ]
        }
        if let rec = accepted {
            out["accepted"] = [
                "clientID": rec.clientID,
                "name": rec.name,
                "keyFingerprint": rec.fingerprint,
                "proofDeadline": rec.proofDeadline,
            ]
            if out["request"] == nil {
                out["request"] = [
                    "id": rec.clientID,
                    "name": rec.name,
                    "user": "",
                    "ip": "",
                    "keyFingerprint": rec.fingerprint,
                ]
            }
        }
        return out
    }

    private func metadataStatusLocked() -> [String: Any] {
        var out: [String: Any] = [
            "role": "host",
            "phase": phase,
            "serviceInstanceID": serviceInstanceID,
            "hostNonce": hostNonce,
            "pairPort": endpoint?.port ?? 0,
            "hostKeyFP": hostKeyFingerprint() ?? "",
            "hostUser": NSUserName(),
            "hostname": Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
            "version": APP_VERSION,
        ]
        if phase == "denied", !deniedFingerprint.isEmpty {
            out["deniedFingerprint"] = deniedFingerprint
        }
        return out
    }

    private func startMetadataServerLocked() throws {
        metadataServer?.cancel()
        metadataServer = try PairingMetadataHTTPServer(queue: queue) { [weak self] in
            self?.metadataStatusLocked() ?? [:]
        }
    }

    private func closeEndpoint(cancelBroadcastTimer: Bool = true, cancelMetadata: Bool = true) {
        if cancelBroadcastTimer {
            broadcastExpiryTimer?.cancel()
            broadcastExpiryTimer = nil
        }
        if cancelMetadata {
            deniedExpiryTimer?.cancel()
            deniedExpiryTimer = nil
            deniedFingerprint = ""
            metadataServer?.cancel()
            metadataServer = nil
        }
        endpoint?.cancel()
        endpoint = nil
        serviceInstanceID = ""
        hostNonce = ""
    }

    private static func randomToken(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw PairingSecurityError.randomUnavailable(status)
        }
        return Data(bytes).base64URLNoPadding()
    }
}

extension PairingManager {
    fileprivate func selfTestFreezeIncoming(_ req: VerifiedPairingRequest) {
        queue.sync {
            closeEndpoint()
            consumed.removeAll()
            rateBuckets.removeAll()
            incoming = req
            incomingExpiresAt = req.timestamp + PairingSecurity.timestampSkewSec
            frozenDropLogCount = 0
            accepted = nil
            lastError = ""
            phase = "incoming"
        }
    }

    fileprivate func selfTestResetState() {
        queue.sync {
            closeEndpoint()
            proofExpiryTimer?.cancel()
            proofExpiryTimer = nil
            broadcastExpiryTimer?.cancel()
            broadcastExpiryTimer = nil
            consumed.removeAll()
            rateBuckets.removeAll()
            incoming = nil
            incomingExpiresAt = nil
            frozenDropLogCount = 0
            accepted = nil
            lastError = ""
            phase = "closed"
        }
    }
}

enum PairingSecuritySelfTest {
    static func run() throws {
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicRaw = privateKey.publicKey.rawRepresentation
        let pubLine = sshEd25519PublicKey(raw: publicRaw)
        let host = "SHA256:hostA"
        let nonce = "nonceA"
        let sid = "sidA"
        let ts = Int64(Date().timeIntervalSince1970)
        let sig = try privateKey.signature(for: PairingSecurity.canonicalTranscript(hostKeyFP: host,
                                                                                    hostNonce: nonce,
                                                                                    serviceInstanceID: sid,
                                                                                    clientPubKey: pubLine,
                                                                                    timestamp: ts))
        var consumed = Set<String>()
        let req = PairingRequestWire(clientPubKey: pubLine, name: "client", user: "user", timestamp: ts,
                                     sig: Data(sig).base64EncodedString())
        _ = try PairingSecurity.verify(req, sourceIP: "127.0.0.1", hostKeyFP: host, hostNonce: nonce,
                                       serviceInstanceID: sid, consumed: &consumed)
        assertThrows { _ = try PairingSecurity.verify(req, sourceIP: "127.0.0.1", hostKeyFP: host, hostNonce: nonce,
                                                      serviceInstanceID: sid, consumed: &consumed) }
        for extreme in [Int64.min, Int64.max] {
            let extremeSig = try privateKey.signature(for: PairingSecurity.canonicalTranscript(hostKeyFP: host,
                                                                                               hostNonce: nonce,
                                                                                               serviceInstanceID: sid,
                                                                                               clientPubKey: pubLine,
                                                                                               timestamp: extreme))
            let extremeReq = PairingRequestWire(clientPubKey: pubLine, name: "client", user: "user",
                                                timestamp: extreme,
                                                sig: Data(extremeSig).base64EncodedString())
            var extremeConsumed = Set<String>()
            assertThrows {
                _ = try PairingSecurity.verify(extremeReq, sourceIP: "127.0.0.1", hostKeyFP: host,
                                               hostNonce: nonce, serviceInstanceID: sid, now: ts,
                                               consumed: &extremeConsumed)
            }
        }

        let shiftedSig = try privateKey.signature(for: PairingSecurity.canonicalTranscript(hostKeyFP: "ab",
                                                                                           hostNonce: "c",
                                                                                           serviceInstanceID: sid,
                                                                                           clientPubKey: pubLine,
                                                                                           timestamp: ts))
        let shiftedReq = PairingRequestWire(clientPubKey: pubLine, name: "client", user: "user", timestamp: ts,
                                            sig: Data(shiftedSig).base64EncodedString())
        var shiftedConsumed = Set<String>()
        assertThrows { _ = try PairingSecurity.verify(shiftedReq, sourceIP: "127.0.0.1", hostKeyFP: "a",
                                                      hostNonce: "bc", serviceInstanceID: sid,
                                                      consumed: &shiftedConsumed) }

        for bad in [(host: "SHA256:other", nonce: nonce, sid: sid),
                    (host: host, nonce: "oldNonce", sid: sid),
                    (host: host, nonce: nonce, sid: "otherSid")] {
            var seen = Set<String>()
            assertThrows {
                _ = try PairingSecurity.verify(req, sourceIP: "127.0.0.1", hostKeyFP: bad.host,
                                               hostNonce: bad.nonce, serviceInstanceID: bad.sid,
                                               consumed: &seen)
            }
        }

        assertThrows { _ = try XpairAuthorizedKeys.buildRestrictedLine(publicKey: pubLine, clientID: "bad id\"`",
                                                                       fingerprint: "SHA256:x", created: ts,
                                                                       name: "bad\nname", paired: false) }
        assertThrows { _ = try XpairAuthorizedKeys.buildRestrictedLine(publicKey: "ssh-rsa AAAA", clientID: "abc",
                                                                       fingerprint: "SHA256:x", created: ts,
                                                                       name: "ok", paired: false) }
        // Pending (accepted-pending-proof): bare restrict, NO forwarding — a forwarding-only ssh -N -L
        // cannot reach the RD port before proof completes.
        let pendingLine = try XpairAuthorizedKeys.buildRestrictedLine(publicKey: pubLine, clientID: "abc_DEF-123",
                                                                      fingerprint: "SHA256:x", created: ts, name: "ok", paired: false)
        precondition(pendingLine.hasPrefix("restrict,pty,command="))
        precondition(!pendingLine.contains("port-forwarding"))
        precondition(!pendingLine.contains("permitopen"))
        // Paired: forwarding granted, constrained to loopback (all ports, both address families + localhost).
        let line = try XpairAuthorizedKeys.buildRestrictedLine(publicKey: pubLine, clientID: "abc_DEF-123",
                                                               fingerprint: "SHA256:x", created: ts, name: "ok", paired: true)
        precondition(line.contains("restrict,pty,port-forwarding"))
        precondition(line.contains(#"permitopen="127.0.0.1:*",permitopen="[::1]:*",permitopen="localhost:*""#))
        precondition(!line.contains("permitlisten"))   // no valid "deny all -R" value exists; must NOT emit an invalid one
        precondition(line.contains("command=\"\(XpairAuthorizedKeys.gatePath) abc_DEF-123 SHA256:x\""))
        precondition(!line.contains("no-port-forwarding"))
        precondition(PairingSecurity.proofMatches(approvedFingerprint: "SHA256:A", loginFingerprint: "SHA256:A"))
        precondition(!PairingSecurity.proofMatches(approvedFingerprint: "SHA256:A", loginFingerprint: "SHA256:B"))
        try markPairedRequiresObservedSSHLoginFingerprint(pubLine: pubLine)
        try acceptIncomingRequiresExactNonEmptyFingerprint(pubLine: pubLine)
        try gateRequiresObservedFingerprintAndSeparatesProofFromCommand(pubLine: pubLine)
        try gateGrantsForwardingOnlyAfterProof(pubLine: pubLine)
        try installPreservesUnmarkedSameBlobAuthorizedKey(pubLine: pubLine)
        try installRemovesMarkedDuplicateAuthorizedKey(pubLine: pubLine)
        try installDoesNotLeaveAuthorizedKeyWhenLedgerWriteFails(pubLine: pubLine)
        // D2 gate routing (behind the d2-frontdoor flag): command/subsystem-first, tmux fall-through,
        // legacy path preserved. The SOCKET literal in the gate must match Config's SOCKET (drift guard,
        // like the 8890 cross-check above — the gate is a raw string with no Swift interpolation).
        let gate = XpairAuthorizedKeys.gateHelperScript()
        precondition(gate.contains("d2-frontdoor.enabled"))                                   // flag-gated
        precondition(gate.contains(#"tolower($1)=="subsystem" && $2=="sftp""#))               // sftp: match the configured Subsystem value
        precondition(gate.contains("sftp|internal-sftp) exec /usr/libexec/sftp-server"))       // bare-token subsystem arm
        precondition(gate.contains("internal-sftp|sftp-server) exec /usr/libexec/sftp-server")) // configured-value subsystem arm
        precondition(gate.contains(#"exec "${SHELL:-/bin/zsh}" -c "$SSH_ORIGINAL_COMMAND""#))  // login-shell passthrough
        precondition(gate.contains("[ -t 0 ] &&"))                                            // tmux only with a real pty
        precondition(gate.contains("has-session -t _keeper"))                                 // never spawn a rogue tmux server
        precondition(gate.contains("new-session -A -s main"))                                 // attach-or-create shared
        precondition(gate.contains(SOCKET))                                                    // socket matches Config.SOCKET
        precondition(gate.contains(#"exec /bin/bash -lc "$SSH_ORIGINAL_COMMAND""#))            // legacy fallback intact
        // D2 hardening: -R-denial drop-in + osascript admin-escaping + STATIC default-deny pf anchor
        // (block :22, pass only lo0 + tailnet utun/CGNAT — future NICs closed by default) + a boot
        // RunAtLoad one-shot that verifies the block is REACHABLE, not merely present.
        precondition(D2Hardening.sshdContent == "AllowTcpForwarding local\nAllowStreamLocalForwarding local\n")  // deny -R TCP + unix-socket
        precondition(D2Hardening.osaCommand(#"printf 'x\n'"#) == #"do shell script "printf 'x\\n'" with administrator privileges"#)
        precondition(D2Hardening.pfAnchorContent.contains("block in quick proto tcp to any port 22"))                          // default-deny :22
        precondition(D2Hardening.pfAnchorContent.contains("pass in quick on lo0 proto tcp to any port 22"))                    // loopback pass
        precondition(D2Hardening.pfAnchorContent.contains("pass in quick on utun proto tcp from 100.64.0.0/10 to any port 22"))// tailnet IPv4 pass
        precondition(D2Hardening.pfAnchorContent.contains("pass in quick on utun inet6 proto tcp from fd7a:115c:a1e0::/48 to any port 22")) // tailnet IPv6 pass
        precondition(D2Hardening.loaderScript.contains("set -e") && D2Hardening.loaderScript.contains("pfctl -f /etc/pf.conf"))// pf load must succeed
        precondition(D2Hardening.loaderScript.contains("block .* port = 22") && D2Hardening.loaderScript.contains("not enforcing")) // verifies anchor block is live
        precondition(D2Hardening.loaderScript.contains("shadowed by earlier quick pass"))          // verifies REACHABILITY, not mere presence
        precondition(gate.contains("d2_hardened()") && gate.contains(#"grep -qx 'anchor "com.x10lab.xpair"'"#))  // gate mirrors effective hardening (pf anchor)
        precondition(gate.contains(#"grep -qx 'AllowTcpForwarding local'"#) && gate.contains("block in quick proto tcp to any port 22")) // gate checks effective sshd + default-deny anchor
        precondition(gate.contains("(22|ssh)"))                                                    // gate matches named SSH port
        precondition(gate.contains(#"tolower($3)=="on""#))                                          // gate rejects pf set-skip bypass
        precondition(gate.contains("com.x10lab.xpair.pf.plist") && gate.contains("xpair-pf.sh"))    // gate requires the pf loader + LaunchDaemon (mirror applied())
        precondition(gate.contains("^allow(tcp|streamlocal)forwarding") && gate.contains(#"tolower(t) ~ /^match /"#)) // gate scans Match forwarding overrides
        precondition(D2Hardening.plistContent.contains("com.x10lab.xpair.pf") && D2Hardening.plistContent.contains("RunAtLoad"))
        print("pairing security self-test passed")
    }

    private static func markPairedRequiresObservedSSHLoginFingerprint(pubLine: String) throws {
        try withTemporaryAuthorizedKeysHome {
            let now = Int64(Date().timeIntervalSince1970)
            let parsed = try PairingSecurity.parseEd25519PublicKey(pubLine)
            let rec = AuthorizedClientRecord(clientID: "proof_123",
                                             publicKey: pubLine,
                                             keyBlob: parsed.keyBlob,
                                             fingerprint: "SHA256:approved",
                                             name: "proof",
                                             created: now,
                                             status: "accepted-pending-proof",
                                             proofDeadline: now + 60,
                                             pairedAt: nil)
            try writeSelfTestLedger([rec])

            assertThrows { try XpairAuthorizedKeys.markPaired(clientID: rec.clientID, loginFingerprint: nil) }
            assertLedgerStatus(clientID: rec.clientID, status: "accepted-pending-proof", paired: false)

            assertThrows {
                try XpairAuthorizedKeys.markPaired(clientID: rec.clientID,
                                                   loginFingerprint: "SHA256:different")
            }
            assertLedgerStatus(clientID: rec.clientID, status: "accepted-pending-proof", paired: false)

            try XpairAuthorizedKeys.markPaired(clientID: rec.clientID,
                                               loginFingerprint: "  SHA256:approved\n")
            assertLedgerStatus(clientID: rec.clientID, status: "paired", paired: true)
        }
    }

    private static func acceptIncomingRequiresExactNonEmptyFingerprint(pubLine: String) throws {
        try withTemporaryAuthorizedKeysHome {
            let parsed = try PairingSecurity.parseEd25519PublicKey(pubLine)
            let req = VerifiedPairingRequest(id: "accept_exact",
                                             name: "accept",
                                             user: "tester",
                                             sourceIP: "127.0.0.1",
                                             clientPubKey: pubLine,
                                             keyBlob: parsed.keyBlob,
                                             fingerprint: PairingSecurity.fingerprintForKeyBlob(parsed.wireBlob),
                                             timestamp: Int64(Date().timeIntervalSince1970))
            defer { PairingManager.shared.selfTestResetState() }

            PairingManager.shared.selfTestFreezeIncoming(req)
            assertThrows {
                _ = try PairingManager.shared.acceptIncoming(requestID: req.id, fingerprint: "")
            }
            assertThrows {
                _ = try PairingManager.shared.acceptIncoming(requestID: req.id, fingerprint: "SHA256:different")
            }

            let accepted = try PairingManager.shared.acceptIncoming(requestID: req.id,
                                                                    fingerprint: req.fingerprint)
            precondition((accepted["phase"] as? String) == "accepted-pending-proof")
            let auth = try String(contentsOfFile: XpairAuthorizedKeys.authorizedKeysPath, encoding: .utf8)
            precondition(auth.contains(" fp=\(req.fingerprint) "))
        }
    }

    // R9-3: the gate must grant port-forwarding to a client's line ONLY when it flips the ledger to
    // paired, and must do so idempotently (a later paired login must not double-insert). Clean setup:
    // one pending client whose installed line is the real pending shape (restrict,pty,command=…, NO
    // forwarding), so a forwarding-only ssh -N -L cannot reach the RD port before proof completes.
    private static func gateGrantsForwardingOnlyAfterProof(pubLine: String) throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("xpair-fwd-selftest-\(UUID().uuidString)")
        let sshDir = root.appendingPathComponent(".ssh")
        let xpairDir = root.appendingPathComponent(".xpair")
        try FileManager.default.createDirectory(at: sshDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: xpairDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }

        let gate = root.appendingPathComponent("xpair-ssh-gate")
        try XpairAuthorizedKeys.gateHelperScript().write(to: gate, atomically: true, encoding: .utf8)
        chmod(gate.path, 0o755)

        let now = Int64(Date().timeIntervalSince1970)
        let rec = AuthorizedClientRecord(clientID: "fwd_123",
                                         publicKey: pubLine,
                                         keyBlob: try PairingSecurity.parseEd25519PublicKey(pubLine).keyBlob,
                                         fingerprint: "SHA256:fwd",
                                         name: "fwd",
                                         created: now,
                                         status: "accepted-pending-proof",
                                         proofDeadline: now + 60,
                                         pairedAt: nil)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(AuthorizedClientsLedger(clients: [rec]))
            .write(to: xpairDir.appendingPathComponent("authorized_clients.json"))
        // The real pending line install() writes: bare restrict,pty,command=… — NO forwarding.
        let pendingLine = "restrict,pty,command=\"\(gate.path) fwd_123 SHA256:fwd\",no-agent-forwarding \(pubLine) xpair:v1 client_id=fwd_123 fp=SHA256:fwd created=\(now) name=fwd\n"
        try pendingLine.write(to: sshDir.appendingPathComponent("authorized_keys"), atomically: true, encoding: .utf8)

        func auth() throws -> String {
            try String(contentsOf: sshDir.appendingPathComponent("authorized_keys"), encoding: .utf8)
        }
        // Pre-proof: no forwarding on the line.
        let preAuth = try auth()
        precondition(!preAuth.contains("port-forwarding"))

        // Proof: flips to paired AND grants forwarding.
        let proof = runGate(gate: gate.path, home: root.path, id: "fwd_123", loginFingerprint: "SHA256:fwd", originalCommand: nil)
        precondition(proof.status == 0)
        precondition(proof.stdout.contains("paired"))
        let afterProof = try auth()
        precondition(afterProof.contains(#"restrict,pty,port-forwarding,permitopen="127.0.0.1:*",permitopen="[::1]:*",permitopen="localhost:*",command="\#(gate.path) fwd_123"#))
        precondition(afterProof.components(separatedBy: "permitopen").count - 1 == 3)

        // A later paired login re-runs the grant but must NOT double-insert (idempotent self-heal).
        let again = runGate(gate: gate.path, home: root.path, id: "fwd_123", loginFingerprint: "SHA256:fwd", originalCommand: nil)
        precondition(again.status == 0)
        let afterAgain = try auth()
        precondition(afterAgain.components(separatedBy: "permitopen").count - 1 == 3)
    }

    private static func gateRequiresObservedFingerprintAndSeparatesProofFromCommand(pubLine: String) throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("xpair-gate-selftest-\(UUID().uuidString)")
        let sshDir = root.appendingPathComponent(".ssh")
        let xpairDir = root.appendingPathComponent(".xpair")
        try FileManager.default.createDirectory(at: sshDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: xpairDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }

        let gate = root.appendingPathComponent("xpair-ssh-gate")
        try XpairAuthorizedKeys.gateHelperScript().write(to: gate, atomically: true, encoding: .utf8)
        chmod(gate.path, 0o755)

        let now = Int64(Date().timeIntervalSince1970)
        let expired = AuthorizedClientRecord(clientID: "expired_123",
                                             publicKey: pubLine,
                                             keyBlob: try PairingSecurity.parseEd25519PublicKey(pubLine).keyBlob,
                                             fingerprint: "SHA256:expired",
                                             name: "expired",
                                             created: now - 20,
                                             status: "accepted-pending-proof",
                                             proofDeadline: now - 1,
                                             pairedAt: nil)
        let revoked = AuthorizedClientRecord(clientID: "revoked_123",
                                             publicKey: pubLine,
                                             keyBlob: expired.keyBlob,
                                             fingerprint: "SHA256:revoked",
                                             name: "revoked",
                                             created: now,
                                             status: "revoked",
                                             proofDeadline: now + 60,
                                             pairedAt: nil)
        let pending = AuthorizedClientRecord(clientID: "pending_123",
                                             publicKey: pubLine,
                                             keyBlob: expired.keyBlob,
                                             fingerprint: "SHA256:pending",
                                             name: "pending",
                                             created: now,
                                             status: "accepted-pending-proof",
                                             proofDeadline: now + 60,
                                             pairedAt: nil)
        let ledgerURL = xpairDir.appendingPathComponent("authorized_clients.json")
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(AuthorizedClientsLedger(clients: [expired, revoked, pending]))
            .write(to: ledgerURL)

        let auth = """
        restrict,command="\(gate.path) expired_123 SHA256:expired",no-agent-forwarding \(pubLine) xpair:v1 client_id=expired_123 fp=SHA256:expired created=\(now) name=expired
        restrict,command="\(gate.path) revoked_123 SHA256:revoked",no-agent-forwarding \(pubLine) xpair:v1 client_id=revoked_123 fp=SHA256:revoked created=\(now) name=revoked
        restrict,command="\(gate.path) pending_123 SHA256:pending",no-agent-forwarding \(pubLine) xpair:v1 client_id=pending_123 fp=SHA256:pending created=\(now) name=pending
        """
        try auth.write(to: sshDir.appendingPathComponent("authorized_keys"), atomically: true, encoding: .utf8)

        let commandFile = root.appendingPathComponent("executed")
        let command = "printf executed > \(shellSingleQuote(commandFile.path))"

        precondition(runGate(gate: gate.path, home: root.path, id: "expired_123",
                       loginFingerprint: "SHA256:expired", originalCommand: command).status != 0)
        precondition(runGate(gate: gate.path, home: root.path, id: "revoked_123",
                       loginFingerprint: "SHA256:revoked", originalCommand: command).status != 0)
        precondition(runGate(gate: gate.path, home: root.path, id: "missing_123",
                       loginFingerprint: "SHA256:missing", originalCommand: command).status != 0)
        let mismatchedProof = runGate(gate: gate.path, home: root.path, id: "pending_123",
                                      loginFingerprint: "SHA256:different", originalCommand: command)
        precondition(mismatchedProof.status != 0)
        precondition(!FileManager.default.fileExists(atPath: commandFile.path))

        let firstProof = runGate(gate: gate.path, home: root.path, id: "pending_123",
                                 loginFingerprint: "SHA256:pending", originalCommand: command)
        precondition(firstProof.status == 0)
        precondition(firstProof.stdout.contains("paired"))
        precondition(!FileManager.default.fileExists(atPath: commandFile.path))

        let updated = try String(contentsOf: ledgerURL, encoding: .utf8)
        precondition(updated.contains(#""clientID" : "pending_123""#))
        precondition(updated.contains(#""status" : "paired""#))
        precondition(!updated.contains(#""clientID" : "expired_123""#))
        let updatedAuth = try String(contentsOf: sshDir.appendingPathComponent("authorized_keys"), encoding: .utf8)
        precondition(!updatedAuth.contains("client_id=expired_123"))

        let pairedMismatch = runGate(gate: gate.path, home: root.path, id: "pending_123",
                                     loginFingerprint: "SHA256:different", originalCommand: command)
        precondition(pairedMismatch.status != 0)
        precondition(!FileManager.default.fileExists(atPath: commandFile.path))

        let secondConnection = runGate(gate: gate.path, home: root.path, id: "pending_123",
                                       loginFingerprint: "SHA256:pending", originalCommand: command)
        precondition(secondConnection.status == 0)
        let marker = try String(contentsOf: commandFile, encoding: .utf8)
        precondition(marker == "executed")
    }

    private static func installDoesNotLeaveAuthorizedKeyWhenLedgerWriteFails(pubLine: String) throws {
        try withTemporaryAuthorizedKeysHome {
            let ledgerDir = (XpairAuthorizedKeys.ledgerPath as NSString).deletingLastPathComponent
            try FileManager.default.removeItem(atPath: ledgerDir)
            try Data("not a directory".utf8).write(to: URL(fileURLWithPath: ledgerDir))

            let parsed = try PairingSecurity.parseEd25519PublicKey(pubLine)
            let req = VerifiedPairingRequest(id: "install_rollback",
                                             name: "rollback",
                                             user: "tester",
                                             sourceIP: "127.0.0.1",
                                             clientPubKey: pubLine,
                                             keyBlob: parsed.keyBlob,
                                             fingerprint: PairingSecurity.fingerprintForKeyBlob(parsed.wireBlob),
                                             timestamp: Int64(Date().timeIntervalSince1970))
            assertThrows { _ = try XpairAuthorizedKeys.install(req) }
            let auth = (try? String(contentsOfFile: XpairAuthorizedKeys.authorizedKeysPath, encoding: .utf8)) ?? ""
            precondition(!auth.contains(" xpair:v1 "))
            precondition(!auth.contains(pubLine))
        }
    }

    private static func installPreservesUnmarkedSameBlobAuthorizedKey(pubLine: String) throws {
        try withTemporaryAuthorizedKeysHome {
            let parsed = try PairingSecurity.parseEd25519PublicKey(pubLine)
            FileManager.default.createFile(atPath: XpairAuthorizedKeys.authorizedKeysPath,
                                           contents: Data("\(pubLine) legacy-copy\n".utf8),
                                           attributes: [.posixPermissions: 0o600])
            let req = VerifiedPairingRequest(id: "legacy_cleanup",
                                             name: "legacy",
                                             user: "tester",
                                             sourceIP: "127.0.0.1",
                                             clientPubKey: pubLine,
                                             keyBlob: parsed.keyBlob,
                                             fingerprint: PairingSecurity.fingerprintForKeyBlob(parsed.wireBlob),
                                             timestamp: Int64(Date().timeIntervalSince1970))
            _ = try XpairAuthorizedKeys.install(req)
            let auth = try String(contentsOfFile: XpairAuthorizedKeys.authorizedKeysPath, encoding: .utf8)
            let occurrences = auth.components(separatedBy: parsed.keyBlob).count - 1
            precondition(occurrences == 2)
            precondition(auth.contains(" xpair:v1 "))
            precondition(!auth.contains("permitopen"))   // install writes the PENDING line (no forwarding); the gate grants it on proof
            precondition(auth.contains("legacy-copy"))
        }
    }

    private static func installRemovesMarkedDuplicateAuthorizedKey(pubLine: String) throws {
        try withTemporaryAuthorizedKeysHome {
            let parsed = try PairingSecurity.parseEd25519PublicKey(pubLine)
            let clientID = PairingSecurity.clientID(forKeyBlob: parsed.keyBlob)
            let oldLine = """
            restrict,command="old",no-agent-forwarding \(pubLine) xpair:v1 client_id=\(clientID) fp=SHA256:old created=1 name=old
            """
            FileManager.default.createFile(atPath: XpairAuthorizedKeys.authorizedKeysPath,
                                           contents: Data(oldLine.utf8),
                                           attributes: [.posixPermissions: 0o600])
            let req = VerifiedPairingRequest(id: "marked_cleanup",
                                             name: "marked",
                                             user: "tester",
                                             sourceIP: "127.0.0.1",
                                             clientPubKey: pubLine,
                                             keyBlob: parsed.keyBlob,
                                             fingerprint: PairingSecurity.fingerprintForKeyBlob(parsed.wireBlob),
                                             timestamp: Int64(Date().timeIntervalSince1970))
            _ = try XpairAuthorizedKeys.install(req)
            let auth = try String(contentsOfFile: XpairAuthorizedKeys.authorizedKeysPath, encoding: .utf8)
            let occurrences = auth.components(separatedBy: parsed.keyBlob).count - 1
            precondition(occurrences == 1)
            precondition(auth.contains(" xpair:v1 "))
            precondition(!auth.contains("permitopen"))   // install writes the PENDING line (no forwarding); the gate grants it on proof
            precondition(!auth.contains("SHA256:old"))
        }
    }

    private struct GateRunResult {
        let status: Int32
        let stdout: String
        let stderr: String
    }

    private static func runGate(gate: String,
                                home: String,
                                id: String,
                                loginFingerprint: String,
                                originalCommand: String?) -> GateRunResult {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: gate)
        proc.arguments = [id, loginFingerprint]
        var env = [
            "HOME": home,
            "SHELL": "/bin/sh",
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        ]
        if let originalCommand {
            env["SSH_ORIGINAL_COMMAND"] = originalCommand
        }
        proc.environment = env
        let stdout = Pipe()
        let stderr = Pipe()
        proc.standardOutput = stdout
        proc.standardError = stderr
        do {
            try proc.run()
            proc.waitUntilExit()
            let out = stdout.fileHandleForReading.readDataToEndOfFile()
            let err = stderr.fileHandleForReading.readDataToEndOfFile()
            return GateRunResult(status: proc.terminationStatus,
                                 stdout: String(data: out, encoding: .utf8) ?? "",
                                 stderr: String(data: err, encoding: .utf8) ?? "")
        } catch {
            return GateRunResult(status: 127, stdout: "", stderr: "\(error)")
        }
    }

    private static func shellSingleQuote(_ s: String) -> String {
        "'\(s.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    private static func withTemporaryAuthorizedKeysHome(_ body: () throws -> Void) throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("xpair-auth-selftest-\(UUID().uuidString)")
        let oldHome = XpairAuthorizedKeys.selfTestHomeOverride
        let oldGate = XpairAuthorizedKeys.selfTestGatePathOverride
        XpairAuthorizedKeys.selfTestHomeOverride = root.path
        XpairAuthorizedKeys.selfTestGatePathOverride = root.appendingPathComponent("xpair-ssh-gate").path
        defer {
            XpairAuthorizedKeys.selfTestHomeOverride = oldHome
            XpairAuthorizedKeys.selfTestGatePathOverride = oldGate
            try? FileManager.default.removeItem(at: root)
        }
        try FileManager.default.createDirectory(atPath: XpairAuthorizedKeys.sshDir,
                                                withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(atPath: (XpairAuthorizedKeys.ledgerPath as NSString).deletingLastPathComponent,
                                                withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try body()
    }

    private static func writeSelfTestLedger(_ clients: [AuthorizedClientRecord]) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(AuthorizedClientsLedger(clients: clients))
            .write(to: URL(fileURLWithPath: XpairAuthorizedKeys.ledgerPath))
    }

    private static func readSelfTestLedger() throws -> AuthorizedClientsLedger {
        let data = try Data(contentsOf: URL(fileURLWithPath: XpairAuthorizedKeys.ledgerPath))
        return try JSONDecoder().decode(AuthorizedClientsLedger.self, from: data)
    }

    private static func assertLedgerStatus(clientID: String, status: String, paired: Bool) {
        guard let ledger = try? readSelfTestLedger(),
              let rec = ledger.clients.first(where: { $0.clientID == clientID }) else {
            preconditionFailure("missing self-test ledger record \(clientID)")
        }
        precondition(rec.status == status)
        precondition((rec.pairedAt != nil) == paired)
    }

    private static func sshEd25519PublicKey(raw: Data) -> String {
        var blob = Data()
        appendSSHString(Data("ssh-ed25519".utf8), to: &blob)
        appendSSHString(raw, to: &blob)
        return "ssh-ed25519 \(blob.base64EncodedString())"
    }

    private static func appendSSHString(_ field: Data, to data: inout Data) {
        var n = UInt32(field.count).bigEndian
        data.append(Data(bytes: &n, count: 4))
        data.append(field)
    }

    private static func assertThrows(_ body: () throws -> Void) {
        do {
            try body()
            preconditionFailure("expected throw")
        } catch {
            return
        }
    }
}
