// BonjourAdvertiser.swift — LAN discovery, host side.
//
// Advertises this Mac as `_xpair._tcp` on the local network so an Xpair client
// can discover it via Bonjour (NWBrowser / `dns-sd -B`) for `xpair discover`.
// A legacy `_remotepair._tcp` advertisement is kept for older clients. TXT record carries:
//   hn   = friendly hostname        v   = app version (Config.swift APP_VERSION)
//   role = currentRole() (host|both)  user = host GUI account
//   fp = ed25519 host-key fingerprint (HostKey.swift, for TOFU)
//   sid/nonce/pp = transient pairing-window serviceInstanceID, hostNonce, UDP port (US-004)
//
// This is ADVERTISE-ONLY. Bonjour requires a bound TCP port to advertise, so incoming
// connections here are accepted and immediately cancelled — nothing is served on this port.
//
// Lifecycle mirrors HostManager.ensureServer: an idempotent ensureAdvertising() called at
// launch and on the 5s host watchdog tick (AppDelegate), gated on isHostRole so a
// client-role machine never advertises itself as a host.

import Foundation
import Network

final class BonjourAdvertiser {
    static let serviceType = "_xpair._tcp"
    static let legacyServiceType = "_remotepair._tcp"
    private static var serviceTypes: [String] { [serviceType, legacyServiceType] }
    private static let pairingLock = NSLock()
    private static var _pairingInfo: PairingAdvertiseInfo?
    private var listeners: [NWListener] = []

    static func setPairingInfo(_ info: PairingAdvertiseInfo?) {
        pairingLock.lock()
        _pairingInfo = info
        pairingLock.unlock()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .bonjourPairingInfoChanged, object: nil)
        }
    }

    private static func pairingInfo() -> PairingAdvertiseInfo? {
        pairingLock.lock()
        defer { pairingLock.unlock() }
        return _pairingInfo
    }

    /// Idempotent: (re)start the advertiser unless it is already up. Safe to call every tick.
    func ensureAdvertising() {
        guard listeners.count == BonjourAdvertiser.serviceTypes.count else {
            start()
            return
        }
        if listeners.allSatisfy({ listener in
            switch listener.state {
            case .ready, .setup, .waiting:
                return true
            default:
                return false
            }
        }) {
            return                      // already advertising (or coming up)
        }
        start()                         // nil / cancelled / failed → (re)start
    }

    private func start() {
        stop()
        let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName

        var txt = NWTXTRecord()
        txt["hn"] = name
        txt["v"] = APP_VERSION
        let role = currentRole()
        txt["role"] = role.isEmpty ? "host" : role
        txt["user"] = NSUserName()
        if let fp = hostKeyFingerprint() { txt["fp"] = fp }
        if let p = BonjourAdvertiser.pairingInfo() {
            txt["sid"] = p.serviceInstanceID
            txt["nonce"] = p.hostNonce
            txt["pp"] = String(p.pairPort)
        }

        for serviceType in BonjourAdvertiser.serviceTypes {
            do {
                let l = try NWListener(using: .tcp)
                l.service = NWListener.Service(name: name, type: serviceType,
                                              domain: nil, txtRecord: txt)
                l.stateUpdateHandler = { state in
                    if case .failed(let err) = state {
                        log(.warn, "BONJOUR: advertiser failed for \(serviceType): \(err) — retry next tick")
                    }
                }
                // Discovery-only: we don't serve anything here. Drop any connection immediately.
                l.newConnectionHandler = { conn in conn.cancel() }
                l.start(queue: .main)
                listeners.append(l)
                log("BONJOUR: advertising \(serviceType) as \(name)")
            } catch {
                log(.warn, "BONJOUR: cannot start advertiser for \(serviceType): \(error)")
            }
        }
    }

    func stop() {
        listeners.forEach { $0.cancel() }
        listeners.removeAll()
    }

    func refreshAdvertising() {
        start()
    }
}
