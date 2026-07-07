import Foundation

struct Generation: Comparable, Hashable {
    let raw: UInt64

    static func < (lhs: Generation, rhs: Generation) -> Bool {
        lhs.raw < rhs.raw
    }
}

final class StartToken {
    private let lock = NSLock()
    private var cancelledFlag = false

    var cancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelledFlag
    }

    func cancel() {
        lock.lock()
        cancelledFlag = true
        lock.unlock()
    }
}

struct CaptureConfig {
    let fps: Int
    let bitrate: Int
    let scale: Double
}

struct StartedInfo: Equatable {
    let displayID: UInt32
    let width: Int
    let height: Int
}

enum CaptureState {
    case idle
    case starting(gen: Generation, token: StartToken)
    case running(gen: Generation)
    case stopping(gen: Generation)

    var activeGen: Generation? {
        switch self {
        case .idle:
            return nil
        case let .starting(gen, _), let .running(gen), let .stopping(gen):
            return gen
        }
    }
}

enum CaptureControlEvent {
    case startOp(gen: Generation, rid: String, cfg: CaptureConfig)
    case stopOp(gen: Generation, rid: String)
    case keyframeOp(gen: Generation, rid: String)
    case bitrateOp(gen: Generation, rid: String, bitrate: Int)
    case startCompleted(gen: Generation, info: StartedInfo)
    case startFailed(gen: Generation, kind: CaptureEngine.CaptureFailureKind, reason: String)
    case engineError(gen: Generation, kind: CaptureEngine.CaptureFailureKind, reason: String)
}

enum CaptureAckOp: String {
    case start
    case stop
    case keyframe
}

enum CaptureAckResult: Equatable {
    case started(StartedInfo)
    case stopped
    case superseded(activeGen: Generation)
    case error(kind: CaptureEngine.CaptureFailureKind, reason: String)
    case accepted

    var jsonObject: [String: Any] {
        switch self {
        case let .started(info):
            return [
                "status": "started",
                "displayId": NSNumber(value: info.displayID),
                "width": info.width,
                "height": info.height,
            ]
        case .stopped:
            return ["status": "stopped"]
        case let .superseded(activeGen):
            return ["status": "superseded", "activeGen": NSNumber(value: activeGen.raw)]
        case let .error(kind, reason):
            return ["status": "error", "kind": kind.rawValue, "reason": boundedControlReason(reason)]
        case .accepted:
            return ["status": "accepted"]
        }
    }
}

func boundedControlReason(_ raw: String) -> String {
    let limit = 800
    guard raw.count > limit else { return raw }
    return String(raw.prefix(limit)) + "..."
}
