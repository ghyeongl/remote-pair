// ScreenServer.swift — owns the v2 WebRTC screen-share sidecar (`screen serve-webrtc`).
//
// Screen sharing belongs to the host app, not the client. ScreenCaptureKit requires a
// GUI/Aqua session with WindowServer access AND a per-binary Screen Recording (TCC) grant,
// so the capture+encode now runs IN THIS APP PROCESS (CaptureEngine) using the app's grant.
// The sidecar (`screen serve-webrtc`, env RP_AU_STDIN=1) does ONLY WebRTC transport: it reads
// already-encoded H.264 access units from its stdin and writes framed control ops to its stdout.
//
// Wiring (per session):
//   pipe A (app -> child stdin): [4B len][AU] frames.
//   pipe B (child stdout -> app): [4B len][JSON op] start / stop / keyframe.
//   pipe C (app -> child fd3): [4B len][JSON ack/event] frames.
//   child stderr (fd2): LOG_DIR/screen-serve.log (as before).
// On start we start CaptureEngine (in-app SCK+VT capture); on stop we stop it.
// Capture is thus per-connection — no capture (privacy/power cost) while idle.
//
// Lifecycle: the sidecar process is kept alive for as long as the app runs (idle = a listening
// signaling socket, no capture). On app quit we kill the sidecar and stop the engine; a stale
// one from a crash is reaped on the next ensure().
import Cocoa
import Darwin
import Security

final class ScreenServer {
    private(set) var childPid: pid_t = 0
    private var observer: NSObjectProtocol?

    /// True while the screen-share sidecar is running (serving; awaiting or with viewers).
    var serving: Bool { childPid != 0 && isAlive(childPid) }
    /// True while a remote viewer is actively connected (the sidecar requested capture:start).
    var viewerConnected: Bool {
        controlQueue.sync { state.activeGen != nil }
    }

    // In-app capture/encode (uses the APP's Screen Recording TCC grant, not a helper binary's).
    private let captureEngine = CaptureEngine()
    private let rdTokenByteCount = 32
    // Pipe A write end (app -> child stdin: the AU stream). -1 when not spawned.
    private var auWriteFD: Int32 = -1
    // Pipe C write end (app -> child fd3: capture-control ACK/event frames). -1 when not spawned.
    private var sidecarControlWriteFD: Int32 = -1
    // Pipe B read end (child stdout -> app: framed control ops). -1 when not spawned.
    private var ctlReadFD: Int32 = -1
    // Serialize writes to pipe A: SCK's sample callback runs on its own queue.
    private let auWriteQueue = DispatchQueue(label: "rp.screenserver.au-write")
    // Separate from the AU media writer so control ACKs/events cannot sit behind media backpressure.
    private let sidecarControlWriteQueue = DispatchQueue(label: "rp.screenserver.sidecar-control-write")
    private let auStateLock = NSLock()
    private var pendingKeyframeAU: Data?
    private var pendingDeltaAU: Data?
    private var auWriterScheduled = false
    private var droppedAUFrames: UInt64 = 0
    private let controlQueue = DispatchQueue(label: "rp.screenserver.capture-control")
    private var state: CaptureState = .idle
    private var pendingStartAck: [(gen: Generation, rid: String)] = []
    private var cachedStartedInfo: StartedInfo?
    private let captureGateLock = NSLock()
    private var activeAUGeneration: Generation?

    var droppedFrameCount: UInt64 {
        auStateLock.lock()
        defer { auStateLock.unlock() }
        return droppedAUFrames
    }

    init() {
        // Kill the sidecar when the app terminates (no AppDelegate wiring needed).
        observer = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: nil
        ) { [weak self] _ in self?.stop() }
    }

    /// Absolute path to the bundled sidecar (Contents/Helpers/screen). Launching the
    /// bundle path keeps rp-screencap as a resolvable sibling.
    private var binPath: String {
        Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/screen").path
    }

    private func generateRDToken() -> String? {
        var bytes = [UInt8](repeating: 0, count: rdTokenByteCount)
        let status = bytes.withUnsafeMutableBytes { rawBuffer -> OSStatus in
            guard let base = rawBuffer.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(kSecRandomDefault, rawBuffer.count, base)
        }
        guard status == errSecSuccess else {
            log(.error, "SCREEN: could not generate RD session token status=\(status)")
            return nil
        }
        var token = ""
        token.reserveCapacity(bytes.count * 2)
        for byte in bytes {
            token += String(format: "%02x", Int(byte))
        }
        return token
    }

    private func writeAllToFD(_ fd: Int32, data: Data) -> Bool {
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard let base = raw.baseAddress else { return true }
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, base.advanced(by: offset), raw.count - offset)
                if n > 0 {
                    offset += n
                    continue
                }
                if n == -1 && errno == EINTR { continue }
                log(.error, "SCREEN: token file write failed errno=\(errno)")
                return false
            }
            return true
        }
    }

    private func writeRDTokenFile(_ token: String) -> Bool {
        do {
            try FileManager.default.createDirectory(
                atPath: RP_DIR,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            log(.error, "SCREEN: could not create \(RP_DIR) for RD token: \(error)")
            return false
        }
        let mode = mode_t(S_IRUSR | S_IWUSR)
        let fd = open(RD_SESSION_TOKEN_FILE, O_WRONLY | O_CREAT | O_TRUNC, mode)
        guard fd >= 0 else {
            log(.error, "SCREEN: could not open RD token file errno=\(errno)")
            return false
        }
        defer { close(fd) }
        if fchmod(fd, mode) != 0 {
            log(.warn, "SCREEN: could not chmod RD token file 0600 errno=\(errno)")
        }
        guard let data = "\(token)\n".data(using: .utf8) else {
            log(.error, "SCREEN: could not encode RD token")
            return false
        }
        return writeAllToFD(fd, data: data)
    }

    /// Idempotent: (re)spawn the sidecar if it is not genuinely alive. Safe to call from
    /// the same 5 s timer that drives HostManager.ensureServer — doubles as a watchdog.
    func ensureServer() {
        if childPid != 0 && isAlive(childPid) { return }
        spawn()
    }

    func stop() {
        controlQueue.sync {
            cancelStartingToken()
            state = .idle
            pendingStartAck.removeAll()
            cachedStartedInfo = nil
            setActiveAUGeneration(nil)
        }
        captureEngine.stop()
        closePipes()
        if childPid != 0 { kill(childPid, SIGTERM); childPid = 0 }
        reapStrays()
    }

    private func closePipes() {
        auWriteQueue.sync {
            if auWriteFD >= 0 { close(auWriteFD); auWriteFD = -1 }
        }
        sidecarControlWriteQueue.sync {
            if sidecarControlWriteFD >= 0 { close(sidecarControlWriteFD); sidecarControlWriteFD = -1 }
        }
        clearPendingAUs()
        if ctlReadFD >= 0 { close(ctlReadFD); ctlReadFD = -1 }
    }

    // Same zombie-aware liveness check as HostManager: a child we never waitpid lingers as
    // a zombie after it dies; reap it here and judge it dead so the watchdog restarts it.
    private func isAlive(_ pid: pid_t) -> Bool {
        var status: Int32 = 0
        let r = waitpid(pid, &status, WNOHANG)
        if r == pid { return false }
        if r == -1 && errno == ECHILD { return false }
        return kill(pid, 0) == 0
    }

    /// Kill any stray `screen serve-webrtc` from a previous instance (crash / unclean quit).
    private func reapStrays() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        p.arguments = ["-f", "screen serve-webrtc"]
        try? p.run(); p.waitUntilExit()
    }

    private func spawn() {
        let bin = binPath
        guard FileManager.default.isExecutableFile(atPath: bin) else {
            log("SCREEN: sidecar missing/not executable at \(bin) — v2 screen-share unavailable")
            return
        }
        // Writing AUs into pipe A can hit EPIPE if the child died; ignore SIGPIPE so that
        // surfaces as a -1/EPIPE return in writeAU (handled) instead of killing the app.
        signal(SIGPIPE, SIG_IGN)
        // A fresh spawn: tear down any leftover engine/pipes from a previous (dead) child.
        controlQueue.sync {
            cancelStartingToken()
            state = .idle
            pendingStartAck.removeAll()
            cachedStartedInfo = nil
            setActiveAUGeneration(nil)
        }
        captureEngine.stop()
        closePipes()
        reapStrays()
        usleep(150_000)

        // Log stderr (serve-webrtc logs there) so connection/capture issues are diagnosable.
        try? FileManager.default.createDirectory(atPath: LOG_DIR, withIntermediateDirectories: true)
        let logPath = "\(LOG_DIR)/screen-serve.log"
        // Threat model: 127.0.0.1:8890 is reachable by any process running on
        // this host, including another local user. The 0600 token file gates
        // OTHER users; the same-user host owner can already control this app
        // and is trusted.
        guard let rdToken = generateRDToken(), writeRDTokenFile(rdToken) else {
            log(.error, "SCREEN: not spawning serve-webrtc without a persisted RD token")
            return
        }

        // pipe A: app -> child stdin (AU stream). pipe B: child stdout -> app (control ops).
        // pipe C: app -> child fd3 (control acks/events), kept independent from AU media backpressure.
        var pipeA: [Int32] = [-1, -1] // [read(child fd0), write(app)]
        var pipeB: [Int32] = [-1, -1] // [read(app), write(child fd1)]
        var pipeC: [Int32] = [-1, -1] // [read(child fd3), write(app)]
        guard pipe(&pipeA) == 0 else { log(.error, "SCREEN: pipe(A) failed errno=\(errno)"); return }
        guard pipe(&pipeB) == 0 else {
            close(pipeA[0]); close(pipeA[1])
            log(.error, "SCREEN: pipe(B) failed errno=\(errno)"); return
        }
        guard pipe(&pipeC) == 0 else {
            close(pipeA[0]); close(pipeA[1])
            close(pipeB[0]); close(pipeB[1])
            log(.error, "SCREEN: pipe(C) failed errno=\(errno)"); return
        }
        let aRead = pipeA[0], aWrite = pipeA[1]
        let bRead = pipeB[0], bWrite = pipeB[1]
        let cRead = pipeC[0], cWrite = pipeC[1]

        let argv = [bin, "serve-webrtc", "--token", "@\(RD_SESSION_TOKEN_FILE)"]
        var env = ["PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                   "HOME=\(HOME)", "LANG=en_US.UTF-8", "RP_AU_STDIN=1", "RP_AU_CONTROL_FD=3"]
        // Forward RP_ABR* from the host app's env: the sidecar's abr_enabled() reads RP_ABR,
        // so without this ABR is always off in the product path (fixed env doesn't inherit it).
        for (key, value) in ProcessInfo.processInfo.environment where key.hasPrefix("RP_ABR") {
            env.append("\(key)=\(value)")
        }
        var cargs = argv.map { strdup($0) }; cargs.append(nil)
        var cenv = env.map { strdup($0) }; cenv.append(nil)
        defer { cargs.forEach { free($0) }; cenv.forEach { free($0) } }

        var fa: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fa)
        // fd0 = read end of pipe A (AU stream from app), fd1 = write end of pipe B (control to app),
        // fd3 = read end of pipe C (control acks/events from app),
        // fd2 = log file (as before).
        posix_spawn_file_actions_adddup2(&fa, aRead, 0)
        posix_spawn_file_actions_adddup2(&fa, bWrite, 1)
        posix_spawn_file_actions_adddup2(&fa, cRead, 3)
        posix_spawn_file_actions_addopen(&fa, 2, logPath, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        defer { posix_spawn_file_actions_destroy(&fa) }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, bin, &fa, nil, cargs, cenv)
        // Close the child-side ends in the parent regardless of outcome.
        close(aRead); close(bWrite); close(cRead)
        guard rc == 0 else {
            close(aWrite); close(bRead); close(cWrite)
            log(.error, "SCREEN: posix_spawn failed rc=\(rc)")
            return
        }
        childPid = pid
        auWriteFD = aWrite
        sidecarControlWriteFD = cWrite
        ctlReadFD = bRead
        log("SCREEN: serve-webrtc spawned pid=\(pid) RP_AU_STDIN=1 RP_AU_CONTROL_FD=3 token-file=\(RD_SESSION_TOKEN_FILE) (\(bin))")
        startControlReader(fd: bRead)
    }

    /// Background reader for pipe B (child stdout): length-prefixed JSON control ops.
    /// Exits on EOF (child gone).
    private func startControlReader(fd: Int32) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var buf = Data()
            var chunk = [UInt8](repeating: 0, count: 4096)
            while true {
                let n = read(fd, &chunk, chunk.count)
                if n <= 0 { break } // EOF or error: child gone
                buf.append(contentsOf: chunk[0..<n])
                while buf.count >= 4 {
                    let len = buf.withUnsafeBytes { raw -> UInt32 in
                        guard let base = raw.baseAddress else { return 0 }
                        var value: UInt32 = 0
                        memcpy(&value, base, 4)
                        return UInt32(bigEndian: value)
                    }
                    if len == 0 || len > 1024 * 1024 {
                        log(.warn, "SCREEN: invalid control frame length \(len)")
                        return
                    }
                    let total = 4 + Int(len)
                    if buf.count < total { break }
                    let frame = buf.subdata(in: 4..<total)
                    buf.removeSubrange(0..<total)
                    self?.handleControlFrame(frame)
                }
            }
        }
    }

    private func handleControlFrame(_ frame: Data) {
        guard let event = parseControlFrame(frame) else {
            let text = String(data: frame, encoding: .utf8) ?? "<non-utf8>"
            log(.warn, "SCREEN: unknown control frame: \(text)")
            return
        }
        controlQueue.async { [weak self] in
            self?.apply(event)
        }
    }

    private func apply(_ event: CaptureControlEvent) {
        switch event {
        case let .startOp(gen, rid, cfg):
            applyStart(gen: gen, rid: rid, cfg: cfg)
        case let .stopOp(gen, rid):
            applyStop(gen: gen, rid: rid)
        case let .keyframeOp(gen, rid):
            applyKeyframe(gen: gen, rid: rid)
        case let .bitrateOp(gen, _, bitrate):
            applyBitrate(gen: gen, bitrate: bitrate)
        case let .startCompleted(gen, info):
            applyStartCompleted(gen: gen, info: info)
        case let .startFailed(gen, kind, reason):
            applyStartFailed(gen: gen, kind: kind, reason: reason)
        case let .engineError(gen, kind, reason):
            applyEngineError(gen: gen, kind: kind, reason: reason)
        }
    }

    private func applyStart(gen: Generation, rid: String, cfg: CaptureConfig) {
        if let active = state.activeGen, gen < active {
            writeAck(gen: gen, rid: rid, op: .start, result: .superseded(activeGen: active))
            return
        }

        if case let .running(active) = state, active == gen {
            if let info = cachedStartedInfo {
                writeAck(gen: gen, rid: rid, op: .start, result: .started(info))
            } else {
                writeAck(
                    gen: gen,
                    rid: rid,
                    op: .start,
                    result: .error(kind: .startFailed, reason: "capture is running without cached start metadata")
                )
            }
            return
        }

        if case let .starting(active, _) = state, active == gen {
            pendingStartAck.append((gen: gen, rid: rid))
            return
        }

        if let active = state.activeGen, gen > active {
            supersedeActiveCapture(with: gen)
        }

        let token = StartToken()
        state = .starting(gen: gen, token: token)
        pendingStartAck.append((gen: gen, rid: rid))
        cachedStartedInfo = nil
        setActiveAUGeneration(nil)
        log("SCREEN: control start -> begin in-app capture generation=\(gen.raw) fps=\(cfg.fps) bitrate=\(cfg.bitrate) scale=\(cfg.scale)")
        captureEngine.start(
            fps: cfg.fps,
            bitrate: cfg.bitrate,
            scale: cfg.scale,
            token: token,
            eventSink: { [weak self] event in
                self?.handleCaptureEvent(event, generation: gen)
            },
            sink: { [weak self] data in
                self?.writeCaptureAU(data, generation: gen)
            }
        )
    }

    private func applyStop(gen: Generation, rid: String) {
        guard let active = state.activeGen else {
            writeAck(gen: gen, rid: rid, op: .stop, result: .stopped)
            return
        }
        guard active == gen else {
            writeAck(gen: gen, rid: rid, op: .stop, result: .superseded(activeGen: active))
            return
        }

        switch state {
        case .idle:
            writeAck(gen: gen, rid: rid, op: .stop, result: .stopped)
        case let .starting(_, token):
            token.cancel()
            let startAcks = consumePendingStartAcks(for: gen)
            state = .idle
            cachedStartedInfo = nil
            setActiveAUGeneration(nil)
            captureEngine.stop()
            clearPendingAUs()
            for ack in startAcks {
                writeAck(gen: ack.gen, rid: ack.rid, op: .start, result: .stopped)
            }
            writeAck(gen: gen, rid: rid, op: .stop, result: .stopped)
        case .running:
            state = .stopping(gen: gen)
            cachedStartedInfo = nil
            setActiveAUGeneration(nil)
            captureEngine.stop()
            clearPendingAUs()
            state = .idle
            writeAck(gen: gen, rid: rid, op: .stop, result: .stopped)
        case .stopping:
            state = .idle
            writeAck(gen: gen, rid: rid, op: .stop, result: .stopped)
        }
    }

    private func applyKeyframe(gen: Generation, rid: String) {
        if case let .running(active) = state, active == gen {
            log("SCREEN: control keyframe -> force keyframe generation=\(gen.raw)")
            captureEngine.requestKeyframe()
            writeAck(gen: gen, rid: rid, op: .keyframe, result: .accepted)
            return
        }
        if let active = state.activeGen, active != gen {
            writeAck(gen: gen, rid: rid, op: .keyframe, result: .superseded(activeGen: active))
        } else {
            writeAck(gen: gen, rid: rid, op: .keyframe, result: .accepted)
        }
    }

    private func applyBitrate(gen: Generation, bitrate: Int) {
        // No-ack runtime ABR actuation: only retarget the live encoder for the active
        // generation; a stale/non-running gen is ignored best-effort (like keyframe).
        guard case let .running(active) = state, active == gen else {
            log("SCREEN: ignoring bitrate op for non-active generation=\(gen.raw) active=\(String(describing: state.activeGen?.raw))")
            return
        }
        log("SCREEN: control bitrate -> retarget encoder generation=\(gen.raw) bitrate=\(bitrate)")
        captureEngine.setBitrate(bitrate)
    }

    private func applyStartCompleted(gen: Generation, info: StartedInfo) {
        guard case let .starting(active, _) = state, active == gen else {
            log("SCREEN: ignoring late capture start completion generation=\(gen.raw) active=\(String(describing: state.activeGen?.raw))")
            return
        }
        state = .running(gen: gen)
        cachedStartedInfo = info
        setActiveAUGeneration(gen)
        let startAcks = consumePendingStartAcks(for: gen)
        log("SCREEN: forwarding capture started generation=\(gen.raw) displayId=\(info.displayID)")
        for ack in startAcks {
            writeAck(gen: ack.gen, rid: ack.rid, op: .start, result: .started(info))
        }
    }

    private func applyStartFailed(gen: Generation, kind: CaptureEngine.CaptureFailureKind, reason: String) {
        guard case let .starting(active, _) = state, active == gen else {
            log("SCREEN: ignoring late capture start failure generation=\(gen.raw) active=\(String(describing: state.activeGen?.raw))")
            return
        }
        state = .idle
        cachedStartedInfo = nil
        setActiveAUGeneration(nil)
        captureEngine.stop()
        let startAcks = consumePendingStartAcks(for: gen)
        log(.error, "SCREEN: forwarding capture start error generation=\(gen.raw) kind=\(kind.rawValue): \(reason)")
        for ack in startAcks {
            writeAck(gen: ack.gen, rid: ack.rid, op: .start, result: .error(kind: kind, reason: reason))
        }
    }

    private func applyEngineError(gen: Generation, kind: CaptureEngine.CaptureFailureKind, reason: String) {
        guard case let .running(active) = state, active == gen else {
            log("SCREEN: ignoring stale capture engine error generation=\(gen.raw) active=\(String(describing: state.activeGen?.raw))")
            return
        }
        state = .idle
        cachedStartedInfo = nil
        setActiveAUGeneration(nil)
        captureEngine.stop()
        clearPendingAUs()
        log(.error, "SCREEN: forwarding capture engine error generation=\(gen.raw) kind=\(kind.rawValue): \(reason)")
        writeEvent(gen: gen, kind: kind, reason: reason)
    }

    private func supersedeActiveCapture(with newGen: Generation) {
        if case let .starting(_, token) = state {
            token.cancel()
        }
        let startAcks = pendingStartAck
        pendingStartAck.removeAll()
        if state.activeGen != nil {
            captureEngine.stop()
            clearPendingAUs()
        }
        cachedStartedInfo = nil
        setActiveAUGeneration(nil)
        for ack in startAcks {
            writeAck(gen: ack.gen, rid: ack.rid, op: .start, result: .superseded(activeGen: newGen))
        }
    }

    private func cancelStartingToken() {
        if case let .starting(_, token) = state {
            token.cancel()
        }
    }

    private func consumePendingStartAcks(for gen: Generation) -> [(gen: Generation, rid: String)] {
        let matching = pendingStartAck.filter { $0.gen == gen }
        pendingStartAck.removeAll { $0.gen == gen }
        return matching
    }

    private func handleCaptureEvent(_ event: CaptureEngine.CaptureEvent, generation: Generation) {
        controlQueue.async { [weak self] in
            guard let self = self else { return }
            switch event {
            case let .started(displayID, width, height):
                self.apply(.startCompleted(
                    gen: generation,
                    info: StartedInfo(displayID: displayID, width: width, height: height)
                ))
            case let .error(kind, reason):
                if case let .starting(active, _) = self.state, active == generation {
                    self.apply(.startFailed(gen: generation, kind: kind, reason: reason))
                } else {
                    self.apply(.engineError(gen: generation, kind: kind, reason: reason))
                }
            }
        }
    }

    private func writeCaptureAU(_ data: Data, generation: Generation) {
        captureGateLock.lock()
        let shouldWrite = activeAUGeneration == generation
        captureGateLock.unlock()
        guard shouldWrite else { return }
        writeAU(data)
    }

    private struct ControlOpMessage: Decodable {
        let v: Int
        let op: String
        let gen: UInt64
        let rid: String
        let fps: Int?
        let bitrate: Int?
        let scale: Double?
    }

    private func parseControlFrame(_ frame: Data) -> CaptureControlEvent? {
        guard let message = try? JSONDecoder().decode(ControlOpMessage.self, from: frame),
              message.v == 1 else {
            return nil
        }
        let gen = Generation(raw: message.gen)
        switch message.op {
        case "start":
            let fps = max(1, min(120, message.fps ?? 30))
            let bitrate = max(100_000, message.bitrate ?? 4_000_000)
            let scale = max(0.1, min(1.0, message.scale ?? 1.0))
            return .startOp(
                gen: gen,
                rid: message.rid,
                cfg: CaptureConfig(fps: fps, bitrate: bitrate, scale: scale)
            )
        case "stop":
            return .stopOp(gen: gen, rid: message.rid)
        case "keyframe":
            return .keyframeOp(gen: gen, rid: message.rid)
        case "bitrate":
            guard let bitrate = message.bitrate else { return nil }
            return .bitrateOp(gen: gen, rid: message.rid, bitrate: bitrate)
        default:
            return nil
        }
    }

    private func isKeyframeAU(_ data: Data) -> Bool {
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return false }
            let count = raw.count
            if count <= 5 { return false }
            var i = 4 // skip the outer AU length prefix
            while i + 4 < count {
                let startCodeBytes: Int
                if i + 4 < count && base[i] == 0 && base[i + 1] == 0 && base[i + 2] == 0 && base[i + 3] == 1 {
                    startCodeBytes = 4
                } else if i + 3 < count && base[i] == 0 && base[i + 1] == 0 && base[i + 2] == 1 {
                    startCodeBytes = 3
                } else {
                    i += 1
                    continue
                }
                let nalIndex = i + startCodeBytes
                if nalIndex < count {
                    let nalType = base[nalIndex] & 0x1F
                    if nalType == 5 { return true }
                }
                i = nalIndex + 1
            }
            return false
        }
    }

    private func noteDroppedAULocked() {
        droppedAUFrames &+= 1
        if droppedAUFrames == 1 || droppedAUFrames.isMultiple(of: 30) {
            log(.warn, "SCREEN: AU backpressure dropped \(droppedAUFrames) stale frame(s)")
        }
    }

    private func clearPendingAUs() {
        auStateLock.lock()
        pendingKeyframeAU = nil
        pendingDeltaAU = nil
        auWriterScheduled = false
        auStateLock.unlock()
    }

    /// Queue one framed AU ([4B len][AU]) for pipe A using bounded latest-frame semantics.
    /// Stale delta frames are replaced; the newest keyframe is preserved ahead of deltas.
    private func writeAU(_ data: Data) {
        let isKeyframe = isKeyframeAU(data)
        var shouldSchedule = false
        auStateLock.lock()
        if auWriteFD >= 0 {
            if isKeyframe {
                if pendingKeyframeAU != nil { noteDroppedAULocked() }
                if pendingDeltaAU != nil {
                    pendingDeltaAU = nil
                    noteDroppedAULocked()
                }
                pendingKeyframeAU = data
            } else {
                if pendingDeltaAU != nil { noteDroppedAULocked() }
                pendingDeltaAU = data
            }
            if !auWriterScheduled {
                auWriterScheduled = true
                shouldSchedule = true
            }
        }
        auStateLock.unlock()
        if shouldSchedule {
            auWriteQueue.async { [weak self] in
                self?.drainAUWrites()
            }
        }
    }

    private func setActiveAUGeneration(_ generation: Generation?) {
        captureGateLock.lock()
        activeAUGeneration = generation
        captureGateLock.unlock()
    }

    private func writeAck(gen: Generation, rid: String, op: CaptureAckOp, result: CaptureAckResult) {
        let json: [String: Any] = [
            "v": 1,
            "ack": op.rawValue,
            "gen": NSNumber(value: gen.raw),
            "rid": rid,
            "result": result.jsonObject,
        ]
        writeFramedSidecarJSON(json)
    }

    private func writeEvent(gen: Generation, kind: CaptureEngine.CaptureFailureKind, reason: String) {
        let json: [String: Any] = [
            "v": 1,
            "event": "capture-error",
            "gen": NSNumber(value: gen.raw),
            "kind": kind.rawValue,
            "reason": boundedControlReason(reason),
        ]
        writeFramedSidecarJSON(json)
    }

    private func writeFramedSidecarJSON(_ json: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(json),
              let payload = try? JSONSerialization.data(withJSONObject: json, options: []) else {
            log(.warn, "SCREEN: could not encode sidecar control message")
            return
        }
        var len = UInt32(payload.count).bigEndian
        var framed = Data(bytes: &len, count: 4)
        framed.append(payload)
        sidecarControlWriteQueue.async { [weak self] in
            guard let self = self else { return }
            guard self.sidecarControlWriteFD >= 0 else { return }
            if !self.writeSidecarControlToPipe(framed) {
                log(.warn, "SCREEN: sidecar control write failed (child gone?)")
            }
        }
    }

    private func takeNextPendingAU() -> Data? {
        auStateLock.lock()
        defer { auStateLock.unlock() }
        if let keyframe = pendingKeyframeAU {
            pendingKeyframeAU = nil
            return keyframe
        }
        if let delta = pendingDeltaAU {
            pendingDeltaAU = nil
            return delta
        }
        auWriterScheduled = false
        return nil
    }

    private func drainAUWrites() {
        while let data = takeNextPendingAU() {
            guard auWriteFD >= 0 else {
                clearPendingAUs()
                return
            }
            if !writeAUToPipe(data) {
                log(.warn, "SCREEN: AU pipe write failed (child gone?) — stopping capture")
                captureEngine.stop()
                clearPendingAUs()
                setActiveAUGeneration(nil)
                controlQueue.async { [weak self] in
                    guard let self = self else { return }
                    self.cancelStartingToken()
                    self.state = .idle
                    self.pendingStartAck.removeAll()
                    self.cachedStartedInfo = nil
                    self.setActiveAUGeneration(nil)
                }
                if auWriteFD >= 0 { close(auWriteFD); auWriteFD = -1 }
                return
            }
        }
    }

    private func writeAUToPipe(_ data: Data) -> Bool {
        let fd = auWriteFD
        if fd < 0 { return false }
        return writeFrameToPipe(fd: fd, data: data)
    }

    private func writeSidecarControlToPipe(_ data: Data) -> Bool {
        let fd = sidecarControlWriteFD
        if fd < 0 { return false }
        return writeFrameToPipe(fd: fd, data: data)
    }

    private func writeFrameToPipe(fd: Int32, data: Data) -> Bool {
        var ok = true
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            var off = 0
            let total = raw.count
            while off < total {
                let w = Darwin.write(fd, base + off, total - off)
                if w > 0 {
                    off += w
                    continue
                }
                if w == -1 && errno == EINTR { continue }
                ok = false // EPIPE or other error: child gone
                break
            }
        }
        return ok
    }
}
