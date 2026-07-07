import Foundation

enum CaptureControlTests {
    struct TestFailure: Error, CustomStringConvertible {
        let description: String
    }

    struct Ack: Equatable {
        let op: CaptureAckOp
        let gen: Generation
        let rid: String
        let result: CaptureAckResult
    }

    final class FakeEngine {
        var starts: [Generation] = []
        var stops = 0
        var keyframes = 0
        var bitrates: [Int] = []

        func start(_ gen: Generation) {
            starts.append(gen)
        }

        func stop() {
            stops += 1
        }

        func requestKeyframe() {
            keyframes += 1
        }

        func setBitrate(_ bitrate: Int) {
            bitrates.append(bitrate)
        }
    }

    struct Machine {
        var state: CaptureState = .idle
        var pendingStartAck: [(gen: Generation, rid: String)] = []
        var cachedStartedInfo: StartedInfo?
        var acks: [Ack] = []
        var events: [(gen: Generation, kind: CaptureEngine.CaptureFailureKind, reason: String)] = []
        var engine = FakeEngine()

        mutating func start(_ raw: UInt64, _ rid: String = "rid") {
            let gen = Generation(raw: raw)
            if let active = state.activeGen, gen < active {
                ack(.start, gen, rid, .superseded(activeGen: active))
                return
            }
            if case let .running(active) = state, active == gen {
                if let info = cachedStartedInfo {
                    ack(.start, gen, rid, .started(info))
                } else {
                    ack(.start, gen, rid, .error(kind: .startFailed, reason: "capture is running without cached start metadata"))
                }
                return
            }
            if case let .starting(active, _) = state, active == gen {
                pendingStartAck.append((gen, rid))
                return
            }
            if let active = state.activeGen, gen > active {
                supersede(with: gen)
            }
            state = .starting(gen: gen, token: StartToken())
            pendingStartAck.append((gen, rid))
            cachedStartedInfo = nil
            engine.start(gen)
        }

        mutating func stop(_ raw: UInt64, _ rid: String = "rid") {
            let gen = Generation(raw: raw)
            guard let active = state.activeGen else {
                ack(.stop, gen, rid, .stopped)
                return
            }
            guard active == gen else {
                ack(.stop, gen, rid, .superseded(activeGen: active))
                return
            }
            switch state {
            case .idle:
                ack(.stop, gen, rid, .stopped)
            case let .starting(_, token):
                token.cancel()
                let pending = consume(gen)
                state = .idle
                cachedStartedInfo = nil
                engine.stop()
                for item in pending {
                    ack(.start, item.gen, item.rid, .stopped)
                }
                ack(.stop, gen, rid, .stopped)
            case .running:
                state = .idle
                cachedStartedInfo = nil
                engine.stop()
                ack(.stop, gen, rid, .stopped)
            case .stopping:
                state = .idle
                ack(.stop, gen, rid, .stopped)
            }
        }

        mutating func keyframe(_ raw: UInt64, _ rid: String = "rid") {
            let gen = Generation(raw: raw)
            if case let .running(active) = state, active == gen {
                engine.requestKeyframe()
                ack(.keyframe, gen, rid, .accepted)
            } else if let active = state.activeGen, active != gen {
                ack(.keyframe, gen, rid, .superseded(activeGen: active))
            } else {
                ack(.keyframe, gen, rid, .accepted)
            }
        }

        mutating func bitrate(_ raw: UInt64, _ value: Int) {
            let gen = Generation(raw: raw)
            // No-ack: only retarget the live encoder for the active generation.
            guard case let .running(active) = state, active == gen else { return }
            engine.setBitrate(value)
        }

        mutating func complete(_ raw: UInt64) {
            let gen = Generation(raw: raw)
            guard case let .starting(active, _) = state, active == gen else { return }
            let info = StartedInfo(displayID: 7, width: 80, height: 60)
            state = .running(gen: gen)
            cachedStartedInfo = info
            for item in consume(gen) {
                ack(.start, item.gen, item.rid, .started(info))
            }
        }

        mutating func failStart(_ raw: UInt64) {
            let gen = Generation(raw: raw)
            guard case let .starting(active, _) = state, active == gen else { return }
            state = .idle
            for item in consume(gen) {
                ack(.start, item.gen, item.rid, .error(kind: .startFailed, reason: "failed"))
            }
        }

        mutating func engineError(_ raw: UInt64) {
            let gen = Generation(raw: raw)
            guard case let .running(active) = state, active == gen else { return }
            state = .idle
            engine.stop()
            events.append((gen, .encodeFailed, "encode"))
        }

        private mutating func supersede(with newGen: Generation) {
            if case let .starting(_, token) = state {
                token.cancel()
            }
            let pending = pendingStartAck
            pendingStartAck.removeAll()
            if state.activeGen != nil {
                engine.stop()
            }
            cachedStartedInfo = nil
            for item in pending {
                ack(.start, item.gen, item.rid, .superseded(activeGen: newGen))
            }
        }

        private mutating func consume(_ gen: Generation) -> [(gen: Generation, rid: String)] {
            let matching = pendingStartAck.filter { $0.gen == gen }
            pendingStartAck.removeAll { $0.gen == gen }
            return matching
        }

        private mutating func ack(_ op: CaptureAckOp, _ gen: Generation, _ rid: String, _ result: CaptureAckResult) {
            acks.append(Ack(op: op, gen: gen, rid: rid, result: result))
        }
    }

    static func runAll() throws {
        try stale_start_is_superseded_not_applied()
        try newer_start_cancels_pending_starting()
        try late_start_completion_after_supersede_noops()
        try stale_stop_is_acked_not_applied()
        try stop_while_starting_cancels_and_acks()
        try every_op_produces_exactly_one_ack()
        try duplicate_start_same_gen_running_reacks_started()
        try duplicate_start_same_gen_running_without_cached_info_error_acks()
        try engine_error_while_running_emits_unsolicited_event_not_ack()
        try bitrate_while_running_retargets_engine_no_ack()
        try bitrate_when_not_active_is_ignored()
    }

    static func stale_start_is_superseded_not_applied() throws {
        var machine = Machine(state: .running(gen: Generation(raw: 43)))
        machine.cachedStartedInfo = StartedInfo(displayID: 1, width: 2, height: 3)
        machine.start(42, "42-1")
        try expect(machine.engine.starts.isEmpty, "stale start must not start engine")
        try expect(machine.acks == [Ack(op: .start, gen: Generation(raw: 42), rid: "42-1", result: .superseded(activeGen: Generation(raw: 43)))], "stale start must ack superseded")
    }

    static func newer_start_cancels_pending_starting() throws {
        let oldToken = StartToken()
        var machine = Machine(state: .starting(gen: Generation(raw: 42), token: oldToken))
        machine.pendingStartAck = [(Generation(raw: 42), "42-1")]
        machine.start(43, "43-1")
        try expect(oldToken.cancelled, "newer start must cancel older token")
        try expect(machine.engine.stops == 1, "newer start must stop older engine state")
        try expect(machine.engine.starts == [Generation(raw: 43)], "newer start must start new generation")
        try expect(machine.acks.first?.result == .superseded(activeGen: Generation(raw: 43)), "old start must be acked superseded")
        machine.complete(43)
        try expect(machine.acks.last?.result == .started(StartedInfo(displayID: 7, width: 80, height: 60)), "new start must ack started")
    }

    static func late_start_completion_after_supersede_noops() throws {
        var machine = Machine(state: .running(gen: Generation(raw: 43)))
        machine.cachedStartedInfo = StartedInfo(displayID: 1, width: 2, height: 3)
        machine.complete(42)
        try expect(machine.acks.isEmpty, "late completion must not emit ack")
        try expect(machine.state.activeGen == Generation(raw: 43), "late completion must not change active gen")
    }

    static func stale_stop_is_acked_not_applied() throws {
        var machine = Machine(state: .running(gen: Generation(raw: 43)))
        machine.stop(42, "42-9")
        try expect(machine.engine.stops == 0, "stale stop must not stop engine")
        try expect(machine.acks == [Ack(op: .stop, gen: Generation(raw: 42), rid: "42-9", result: .superseded(activeGen: Generation(raw: 43)))], "stale stop must ack superseded")
    }

    static func stop_while_starting_cancels_and_acks() throws {
        let token = StartToken()
        var machine = Machine(state: .starting(gen: Generation(raw: 42), token: token))
        machine.pendingStartAck = [(Generation(raw: 42), "42-1")]
        machine.stop(42, "42-2")
        try expect(token.cancelled, "stop while starting must cancel token")
        try expect(machine.engine.stops == 1, "stop while starting must stop engine")
        try expect(machine.acks.map(\.op) == [.start, .stop], "stop while starting must ack deferred start and stop")
    }

    static func every_op_produces_exactly_one_ack() throws {
        var machine = Machine()
        let ops: [(String, UInt64, String)] = [
            ("start", 1, "1-1"),
            ("start", 1, "1-2"),
            ("keyframe", 1, "1-3"),
            ("stop", 1, "1-4"),
            ("stop", 0, "0-1"),
        ]
        for op in ops {
            switch op.0 {
            case "start": machine.start(op.1, op.2)
            case "stop": machine.stop(op.1, op.2)
            case "keyframe": machine.keyframe(op.1, op.2)
            default: break
            }
        }
        machine.complete(1)
        try expect(machine.acks.count == ops.count, "each op must produce exactly one ack")
        try expect(Set(machine.acks.map(\.rid)) == Set(ops.map(\.2)), "each ack must match one op rid")
    }

    static func duplicate_start_same_gen_running_reacks_started() throws {
        let info = StartedInfo(displayID: 9, width: 10, height: 11)
        var machine = Machine(state: .running(gen: Generation(raw: 42)), cachedStartedInfo: info)
        machine.start(42, "42-2")
        try expect(machine.engine.starts.isEmpty, "duplicate running start must not start engine")
        try expect(machine.acks == [Ack(op: .start, gen: Generation(raw: 42), rid: "42-2", result: .started(info))], "duplicate running start must re-ack started")
    }

    static func duplicate_start_same_gen_running_without_cached_info_error_acks() throws {
        var machine = Machine(state: .running(gen: Generation(raw: 42)))
        machine.start(42, "42-3")
        try expect(machine.engine.starts.isEmpty, "duplicate running start without metadata must not start engine")
        try expect(
            machine.acks == [
                Ack(
                    op: .start,
                    gen: Generation(raw: 42),
                    rid: "42-3",
                    result: .error(kind: .startFailed, reason: "capture is running without cached start metadata")
                )
            ],
            "duplicate running start without metadata must error-ack"
        )
    }

    static func engine_error_while_running_emits_unsolicited_event_not_ack() throws {
        var machine = Machine(state: .running(gen: Generation(raw: 42)))
        machine.engineError(42)
        try expect(machine.acks.isEmpty, "engine error must not emit ack")
        try expect(machine.events.count == 1, "engine error must emit one event")
    }

    static func bitrate_while_running_retargets_engine_no_ack() throws {
        var machine = Machine(state: .running(gen: Generation(raw: 42)))
        machine.bitrate(42, 1_500_000)
        try expect(machine.engine.bitrates == [1_500_000], "bitrate while running must retarget engine")
        try expect(machine.acks.isEmpty, "bitrate is a no-ack op")
    }

    static func bitrate_when_not_active_is_ignored() throws {
        var machine = Machine(state: .running(gen: Generation(raw: 43)))
        machine.bitrate(42, 1_500_000)
        try expect(machine.engine.bitrates.isEmpty, "stale-gen bitrate must not retarget engine")
        try expect(machine.acks.isEmpty, "bitrate is a no-ack op")
    }

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition {
            throw TestFailure(description: message)
        }
    }
}
