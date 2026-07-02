// CaptureEngine.swift — in-app ScreenCaptureKit capture + VideoToolbox H.264 encode.
//
// WHY THIS EXISTS: macOS Screen Recording (TCC) permission is granted PER BINARY.
// The standalone `rp-screencap` helper (host/rd/rpmedia/rp-screencap.swift) is a
// separate executable, so the XpairHost.app Screen Recording grant does NOT
// cover it — ScreenCaptureKit returns SCStreamErrorDomain Code=-3801 ("user
// declined TCCs"), the helper exits, and the WebRTC stream is BLACK on a freshly
// installed host. Running the SAME SCK+VT pipeline INSIDE this app process makes
// capture use the APP's grant (and the app's GUI/Aqua session), so it works.
//
// This is a faithful lift of rp-screencap.swift's exact SCK config, exact VT
// settings, and exact Annex-B framing ([4B BE len][AU]). The ONLY differences:
//   1) instead of FileHandle.standardOutput.write, each framed AU is handed to a
//      `sink` closure (ScreenServer pipes it to the sidecar's stdin), and
//   2) it does NOT block the thread (no RunLoop.main.run()/sem.wait()) — the app
//      already runs a runloop; SCK's sample handler fires on its own queue. start()
//      kicks off capture and returns; stop() tears down cleanly so the next session
//      can start fresh.
import Foundation
import ScreenCaptureKit
import VideoToolbox
import CoreMedia
import CoreVideo
import QuartzCore

final class CaptureEngine {
    enum CaptureFailureKind: String {
        case noDisplay = "no-display"
        case startFailed = "start-failed"
        case addOutputFailed = "add-output-failed"
        case encoderFailed = "encoder-failed"
        case encodeFailed = "encode-failed"
    }

    enum CaptureEvent {
        case started(displayID: UInt32, width: Int, height: Int)
        case error(kind: CaptureFailureKind, reason: String)
    }

    private let startCode = Data([0, 0, 0, 1])

    // VT/SCK state (all touched on the SCK sample queue once capture is running).
    private var session: VTCompressionSession?
    private var stream: SCStream?
    private var output: StreamOutput?
    private var au = Data()
    private var fps = 30
    private var bitrate = 4_000_000
    private var sink: ((Data) -> Void)?
    private var eventSink: ((CaptureEvent) -> Void)?
    private let sampleQueue = DispatchQueue(label: "rp.sck")
    private let errorLock = NSLock()
    private var reportedErrorKinds = Set<CaptureFailureKind>()
    private var startGeneration: UInt64 = 0

    /// Advisory: true while capture is running (a viewer is connected → the sidecar sent capture:start).
    /// Read cross-thread only for the menu-bar status line, so a one-tick-stale value is acceptable.
    var isCapturing: Bool { stream != nil }

    // Keyframe forcing. A 76KB IDR can lose a packet on a lossy link -> undecodable;
    // with no further keyframe the remote viewer stays black forever. SCK is change-driven,
    // so static screens do not necessarily emit more `.complete` samples. Keep the last
    // pixel buffer and re-encode it as an IDR on wall-clock cadence or PLI/FIR demand.
    // These fields are touched only on sampleQueue.
    private var forceKeyframeFlag = false
    // Set once a runtime ABR bitrate command arrives. Gates the hard DataRateLimits cap
    // so ABR-off captures keep VideoToolbox's stock AverageBitRate-only behavior.
    private var bitrateOverridden = false
    private var lastPixelBuffer: CVPixelBuffer?
    private var encodedFrameIndex: Int64 = 0
    private var lastKeyframeTime: CFTimeInterval = 0
    private let periodicKeyframeSeconds: CFTimeInterval = 1.0
    private let periodicKeyframeInterval: DispatchTimeInterval = .seconds(1)
    private var keyframeTimer: DispatchSourceTimer?
    // SCK only emits `.complete` frames when the screen CHANGES; on a static screen it emits none,
    // so a viewer joining a still screen would get zero frames → black. Force the FIRST frame after
    // start to encode even if SCK marks it idle, so the initial keyframe (the current screen) is
    // always delivered. Touched only on the sample queue (like frameCount).
    private var firstFrameSubmitted = false

    /// Start capturing the first display and encoding to H.264. `sink` receives one
    /// `[4B BE len][Annex-B AU]` Data per encoded frame, on SCK's sample queue (the
    /// caller must serialize any shared writes). Idempotent: a no-op if already running.
    func start(
        fps: Int = 30,
        bitrate: Int = 4_000_000,
        scale: Double = 1.0,
        token: StartToken,
        eventSink: ((CaptureEvent) -> Void)? = nil,
        sink: @escaping (Data) -> Void
    ) {
        if stream != nil { return } // already running
        startGeneration &+= 1
        let generation = startGeneration
        let safeFps = max(1, min(120, fps))
        let safeBitrate = max(100_000, bitrate)
        let safeScale = max(0.1, min(1.0, scale))
        self.fps = safeFps
        self.bitrate = safeBitrate
        self.sink = sink
        self.eventSink = eventSink
        errorLock.lock()
        reportedErrorKinds.removeAll(keepingCapacity: true)
        errorLock.unlock()
        // Fresh per-session keyframe state: force a keyframe on the first encoded frame.
        sampleQueue.sync {
            encodedFrameIndex = 0
            lastKeyframeTime = 0
            lastPixelBuffer = nil
            firstFrameSubmitted = false
            forceKeyframeFlag = false
            bitrateOverridden = false
        }
        startKeyframeTimer()

        SCShareableContent.getWithCompletionHandler { [weak self] content, err in
            guard let self = self else { return }
            guard !token.cancelled else { return }
            guard self.startGeneration == generation else { return }
            guard let content = content, let display = content.displays.first else {
                self.reportCaptureError(
                    kind: .noDisplay,
                    reason: "no display from SCShareableContent: \(String(describing: err))"
                )
                self.stop()
                return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.width = max(2, Int(Double(display.width) * safeScale)) & ~1
            cfg.height = max(2, Int(Double(display.height) * safeScale)) & ~1
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(safeFps))
            cfg.pixelFormat = kCVPixelFormatType_32BGRA
            cfg.queueDepth = 5
            cfg.showsCursor = true

            let out = StreamOutput(engine: self)
            let s = SCStream(filter: filter, configuration: cfg, delegate: nil)
            do {
                try s.addStreamOutput(out, type: .screen, sampleHandlerQueue: self.sampleQueue)
                guard !token.cancelled else { return }
                guard self.startGeneration == generation else { return }
                self.output = out
                self.stream = s
                s.startCapture { e in
                    guard !token.cancelled else { return }
                    guard self.startGeneration == generation, self.stream === s else { return }
                    if let e = e {
                        self.reportCaptureError(
                            kind: .startFailed,
                            reason: "startCapture failed (Screen Recording grant?): \(e)"
                        )
                        self.stop()
                        return
                    }
                    let displayID = UInt32(display.displayID)
                    log("CAPTURE: SCK \(cfg.width)x\(cfg.height) @\(safeFps)fps capturing displayId=\(displayID)")
                    self.eventSink?(.started(displayID: displayID, width: cfg.width, height: cfg.height))
                }
            } catch {
                guard !token.cancelled else { return }
                guard self.startGeneration == generation else { return }
                self.reportCaptureError(
                    kind: .addOutputFailed,
                    reason: "addStreamOutput/start failed: \(error)"
                )
                self.stop()
                return
            }
        }
    }

    private func startKeyframeTimer() {
        keyframeTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
        timer.schedule(deadline: .now() + periodicKeyframeInterval, repeating: periodicKeyframeInterval, leeway: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            self?.encodeRetainedKeyframeIfDue()
        }
        keyframeTimer = timer
        timer.resume()
    }

    private func stopKeyframeTimer() {
        keyframeTimer?.cancel()
        keyframeTimer = nil
    }

    private func resetSampleState() {
        encodedFrameIndex = 0
        lastKeyframeTime = 0
        lastPixelBuffer = nil
        firstFrameSubmitted = false
        forceKeyframeFlag = false
    }

    /// Stop capture, invalidate the VT session, and release state so start() can be
    /// called again cleanly for the next session. Idempotent.
    func stop() {
        startGeneration &+= 1
        if let s = stream {
            s.stopCapture { _ in }
        }
        stream = nil
        output = nil
        if let sess = session {
            VTCompressionSessionInvalidate(sess)
        }
        session = nil
        au.removeAll(keepingCapacity: false)
        sink = nil
        eventSink = nil
        stopKeyframeTimer()
        sampleQueue.sync {
            resetSampleState()
        }
        errorLock.lock()
        reportedErrorKinds.removeAll(keepingCapacity: true)
        errorLock.unlock()
    }

    /// Request that the next encoded frame be a keyframe (IDR). Called from another
    /// thread (ScreenServer's control reader) when the client signals picture loss
    /// (RTCP PLI/FIR). The actual state mutation and retained-buffer encode run on
    /// the SCK sample queue.
    func requestKeyframe() {
        sampleQueue.async { [weak self] in
            guard let self = self, self.stream != nil else { return }
            self.forceKeyframeFlag = true
            self.encodeRetainedKeyframe(reason: "on-demand")
        }
    }

    /// Retarget the encoder's average bitrate at runtime (ABR actuation). Called from
    /// another thread (ScreenServer's control reader) on a no-ack `bitrate` control op.
    /// Best-effort: applied on the SCK sample queue (where the VT session lives); a
    /// no-op if there is no session yet — the next ensureEncoder() uses the new value.
    func setBitrate(_ bitrate: Int) {
        sampleQueue.async { [weak self] in
            guard let self = self else { return }
            let safe = max(100_000, bitrate)
            self.bitrate = safe
            self.bitrateOverridden = true
            guard let sess = self.session else { return }
            VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AverageBitRate, value: safe as CFNumber)
            // DataRateLimits is [bytes, seconds]: cap the 1s window to the new bitrate/8.
            let limits = [safe / 8, 1] as CFArray
            VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
        }
    }

    // ---- VT encoder (created once we know dimensions) ----
    private func ensureEncoder(_ w: Int, _ h: Int) {
        if session != nil { return }
        var s: VTCompressionSession?
        let st = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault, width: Int32(w), height: Int32(h),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { refcon, _, status, _, sample in
                guard let refcon = refcon else { return }
                let engine = Unmanaged<CaptureEngine>.fromOpaque(refcon).takeUnretainedValue()
                engine.encOutput(status, sample)
            },
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &s)
        guard st == noErr, let sess = s else {
            reportCaptureError(
                kind: .encoderFailed,
                reason: "VTCompressionSessionCreate failed: \(st)"
            )
            return
        }
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (self.fps * 2) as CFNumber)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AverageBitRate, value: self.bitrate as CFNumber)
        // Mirror setBitrate's hard 1s cap so a bitrate set before the session existed
        // (which only stored self.bitrate) is honored once the session is created. Only
        // when a runtime bitrate override actually arrived — ABR-off captures keep
        // VideoToolbox's stock AverageBitRate-only behavior (no hard burst cap).
        if self.bitrateOverridden {
            let limits = [self.bitrate / 8, 1] as CFArray
            VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
        }
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: self.fps as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(sess)
        session = sess
    }

    private func appendParamSets(_ fmt: CMFormatDescription) {
        var count = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
        for i in 0..<count {
            var p: UnsafePointer<UInt8>? = nil; var s = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &s, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pp = p {
                au.append(startCode); au.append(UnsafeBufferPointer(start: pp, count: s))
            }
        }
    }

    private func appendAVCC(_ bb: CMBlockBuffer) {
        var total = 0; var dp: UnsafeMutablePointer<Int8>? = nil
        guard CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total, dataPointerOut: &dp) == noErr, let base = dp else { return }
        var off = 0
        base.withMemoryRebound(to: UInt8.self, capacity: total) { u8 in
            while off + 4 <= total {
                var n: UInt32 = 0; memcpy(&n, base + off, 4); n = UInt32(bigEndian: n); off += 4
                if off + Int(n) > total { break }
                au.append(startCode); au.append(UnsafeBufferPointer(start: u8 + off, count: Int(n)))
                off += Int(n)
            }
        }
    }

    private func nextPresentationTime() -> CMTime {
        let pts = CMTime(value: encodedFrameIndex, timescale: CMTimeScale(max(1, fps)))
        encodedFrameIndex &+= 1
        return pts
    }

    private func shouldForceKeyframe(now: CFTimeInterval, isFirst: Bool) -> Bool {
        let periodic = lastKeyframeTime == 0 || now - lastKeyframeTime >= periodicKeyframeSeconds
        let onDemand = forceKeyframeFlag
        forceKeyframeFlag = false
        return isFirst || periodic || onDemand
    }

    private func encodeRetainedKeyframeIfDue() {
        guard stream != nil, firstFrameSubmitted else { return }
        let now = CACurrentMediaTime()
        guard lastKeyframeTime == 0 || now - lastKeyframeTime >= periodicKeyframeSeconds else { return }
        encodeRetainedKeyframe(reason: "periodic")
    }

    private func encodeRetainedKeyframe(reason: String) {
        guard let pb = lastPixelBuffer else { return }
        log("CAPTURE: forcing retained IDR (\(reason))")
        encodePixelBuffer(pb, forceKeyframe: true, now: CACurrentMediaTime())
        forceKeyframeFlag = false
    }

    private func encodePixelBuffer(_ pb: CVPixelBuffer, forceKeyframe: Bool, now: CFTimeInterval) {
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        ensureEncoder(w, h)
        guard let sess = session else { return }
        let frameProps: CFDictionary? = forceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
            : nil
        let pts = nextPresentationTime()
        let status = VTCompressionSessionEncodeFrame(
            sess,
            imageBuffer: pb,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: frameProps,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
        if status == noErr && forceKeyframe {
            lastKeyframeTime = now
        } else if status != noErr {
            log(.warn, "CAPTURE: VTCompressionSessionEncodeFrame failed: \(status)")
            reportCaptureError(
                kind: .encodeFailed,
                reason: "VTCompressionSessionEncodeFrame failed: \(status)"
            )
        }
    }

    private func reportCaptureError(kind: CaptureFailureKind, reason: String) {
        errorLock.lock()
        let shouldEmit = !reportedErrorKinds.contains(kind)
        if shouldEmit {
            reportedErrorKinds.insert(kind)
        }
        errorLock.unlock()
        log(.error, "CAPTURE: \(reason)")
        if shouldEmit {
            eventSink?(.error(kind: kind, reason: reason))
        }
    }

    private func encOutput(_ status: OSStatus, _ sample: CMSampleBuffer?) {
        guard status == noErr, let sample = sample, CMSampleBufferDataIsReady(sample) else { return }
        au.removeAll(keepingCapacity: true)
        var keyframe = true
        if let arr = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false), CFArrayGetCount(arr) > 0 {
            let d = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFDictionary.self)
            if let notSync = (d as NSDictionary)[kCMSampleAttachmentKey_NotSync as String] as? Bool { keyframe = !notSync }
        }
        if keyframe, let fmt = CMSampleBufferGetFormatDescription(sample) { appendParamSets(fmt) }
        if let bb = CMSampleBufferGetDataBuffer(sample) { appendAVCC(bb) }
        var len = UInt32(au.count).bigEndian
        var hdr = Data(bytes: &len, count: 4); hdr.append(au)
        sink?(hdr)
    }

    // ---- SCK stream output: IOSurface CVPixelBuffer -> VT (zero-copy) ----
    private final class StreamOutput: NSObject, SCStreamOutput {
        private unowned let engine: CaptureEngine
        init(engine: CaptureEngine) { self.engine = engine }

        func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
            guard type == .screen, CMSampleBufferIsValid(sample) else { return }
            // Skip frames SCK marks as idle/blank (no on-screen change) — frame-skip for free.
            // EXCEPTION: never skip the FIRST frame after start. On a static screen SCK emits only
            // idle frames, so skipping them would deliver zero frames and the viewer stays black;
            // the first frame must always encode (as the initial keyframe = current screen).
            if engine.firstFrameSubmitted,
               let arr = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
               let info = arr.first, let raw = info[.status] as? Int, let st = SCFrameStatus(rawValue: raw), st != .complete {
                return
            }
            guard let pb = CMSampleBufferGetImageBuffer(sample) else { return }
            let isFirst = !engine.firstFrameSubmitted
            engine.firstFrameSubmitted = true
            engine.lastPixelBuffer = pb
            let now = CACurrentMediaTime()
            let force = engine.shouldForceKeyframe(now: now, isFirst: isFirst)
            engine.encodePixelBuffer(pb, forceKeyframe: force, now: now)
        }
    }
}
