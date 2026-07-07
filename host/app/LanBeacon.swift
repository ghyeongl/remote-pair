// LanBeacon.swift - LAN discovery, host side.
//
// Broadcasts a tiny, secret-free UDP hint so clients on the same network can list this host.
// Pairing details remain behind the HTTP metadata pull on port 8891.

import Foundation
import Darwin

final class LanBeacon {
    // LAN_BEACON_PORT pairs with the metadata HTTP port 8891 (RP_TAILNET_PAIRING_METADATA_PORT
    // in client/cli/xpair and PairingMetadataHTTPServer.port at PairingManager.swift:827).
    static let port: UInt16 = 8892

    private let queue = DispatchQueue(label: "xpair.lan-beacon")
    private var socketFD: Int32 = -1
    private var timer: DispatchSourceTimer?

    /// Idempotent: start broadcasting unless already running. Safe to call from the watchdog tick.
    func ensureAdvertising() {
        queue.async { [weak self] in
            self?.ensureAdvertisingLocked()
        }
    }

    func stop() {
        queue.sync {
            stopLocked()
        }
    }

    private func ensureAdvertisingLocked() {
        if socketFD >= 0, timer != nil {
            return
        }
        startLocked()
    }

    private func startLocked() {
        stopLocked()

        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else {
            log(.warn, "LAN-BEACON: socket failed: \(errno)")
            return
        }

        var yes: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            let err = errno
            close(fd)
            log(.warn, "LAN-BEACON: SO_BROADCAST failed: \(err)")
            return
        }

        socketFD = fd
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .seconds(2), leeway: .milliseconds(200))
        t.setEventHandler { [weak self] in
            self?.broadcastLocked()
        }
        timer = t
        t.resume()

        log("LAN-BEACON: broadcasting on 255.255.255.255:\(Self.port)")
    }

    private func stopLocked() {
        let fd = socketFD
        timer?.cancel()
        timer = nil
        socketFD = -1
        if fd >= 0 {
            close(fd)
        }
    }

    private func broadcastLocked() {
        guard socketFD >= 0, let payload = payloadData() else { return }

        var dest = sockaddr_in()
        dest.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        dest.sin_family = sa_family_t(AF_INET)
        dest.sin_port = in_port_t(Self.port).bigEndian
        inet_pton(AF_INET, "255.255.255.255", &dest.sin_addr)

        payload.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            _ = withUnsafePointer(to: &dest) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    sendto(socketFD, base, payload.count, 0, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
    }

    private func payloadData() -> Data? {
        let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        let role = currentRole()
        let body: [String: Any] = [
            "v": 1,
            "kind": "xpair-host",
            "name": name,
            "fp": hostKeyFingerprint() ?? "",
            "role": role.isEmpty ? "host" : role,
            "user": NSUserName(),
            "metaPort": PairingMetadataHTTPServer.port,
            "ver": APP_VERSION,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]),
              data.count < 512 else {
            return nil
        }
        return data
    }
}
