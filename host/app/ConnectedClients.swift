// ConnectedClients.swift — read-only view of which clients are currently connected.
//
// The CLIENT writes one heartbeat file per client at ~/.xpair/host/clients/<id>.json, shaped
// {"name":"<client hostname>","user":"<client user>","ts":<unix epoch seconds>}. A client counts as
// "connected" if its ts is within the freshness window of now. There is NO disconnect/revoke — this is
// read-only status. Reused by the menu bar (AppDelegate.rebuildMenu). Foundation only.

import Foundation

enum ConnectedClients {
    /// A client is "connected" if its heartbeat ts is within this many seconds of now.
    static let freshnessSec = 90

    /// On-disk shape written by the client heartbeat.
    private struct ClientFile: Decodable {
        let name: String
        let user: String
        let ts: Int
    }

    /// Connected clients (ts within `freshnessSec` of now), sorted by name. Never throws — any
    /// read/parse failure is logged and skipped so callers always get an array.
    static func list() -> [(name: String, user: String, ageSec: Int)] {
        let dir = "\(RP_DIR)/clients"
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return [] }

        let now = Int(Date().timeIntervalSince1970)
        let decoder = JSONDecoder()
        var out: [(name: String, user: String, ageSec: Int)] = []
        for file in names where file.hasSuffix(".json") {
            let path = "\(dir)/\(file)"
            guard let data = fm.contents(atPath: path) else { continue }
            guard let c = try? decoder.decode(ClientFile.self, from: data) else {
                log(.debug, "connectedClients: skipping unparseable \(file)")
                continue
            }
            let age = now - c.ts
            // Keep entries whose heartbeat is recent. Negative age (clock skew, client slightly ahead)
            // still counts as connected; only stale (> freshnessSec) entries are dropped.
            if age <= freshnessSec {
                out.append((name: c.name, user: c.user, ageSec: max(0, age)))
            }
        }
        return out.sorted { $0.name < $1.name }
    }
}
