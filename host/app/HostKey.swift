// HostKey.swift — host SSH key fingerprint.
//
// The SHA256 fingerprint of the host's ed25519 SSH key, in OpenSSH `SHA256:<base64>` form
// (byte-for-byte equal to `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). It is the
// machine-identity anchor included in the LAN beacon and metadata endpoint so a discovering
// client can TOFU-check it against the host's first ssh connection.
//
// We pin the ed25519 host key specifically (the client's ssh config prefers ssh-ed25519) so
// the displayed fingerprint is the key ssh actually pins — no TOFU theater.

import Foundation
import CryptoKit

let HOST_ED25519_PUB = "/etc/ssh/ssh_host_ed25519_key.pub"

/// Computed once: the 32 RAW SHA256 bytes over the ed25519 host key's wire-format blob, or nil
/// if the pubkey is unreadable. This is the SAME digest the string form base64-encodes; the
/// string accessor below renders it for display/TXT.
private let _hostKeyFingerprintRaw: [UInt8]? = {
    guard let raw = try? String(contentsOfFile: HOST_ED25519_PUB, encoding: .utf8) else { return nil }
    // ".pub" format: "ssh-ed25519 <base64 wire-format blob> [comment]". Field 2 is the blob.
    let fields = raw.split(whereSeparator: { $0 == " " || $0 == "\t" })
    guard fields.count >= 2, let blob = Data(base64Encoded: String(fields[1])) else { return nil }
    return Array(SHA256.hash(data: blob))   // exactly 32 bytes
}()

/// Computed once: the OpenSSH SHA256 fingerprint of the ed25519 host key, or nil if the
/// public key is unreadable. Format: `SHA256:` + base64(SHA256(wire-format key blob)) with
/// the base64 padding (`=`) stripped — exactly what `ssh-keygen -lf` prints.
private let _hostKeyFingerprint: String? = {
    guard let raw = _hostKeyFingerprintRaw else { return nil }
    let b64 = Data(raw).base64EncodedString().replacingOccurrences(of: "=", with: "")
    return "SHA256:\(b64)"
}()

/// The host's ed25519 key fingerprint (`SHA256:…`), cached; nil if the pubkey is unreadable.
func hostKeyFingerprint() -> String? { _hostKeyFingerprint }
