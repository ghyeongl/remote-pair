// rp-screencap — ScreenCaptureKit capture + VideoToolbox H.264 encode in ONE
// process. Replaces the xcap-capture (Rust) + raw-frame-pipe + rp-vt-encode
// split: SCK delivers IOSurface-backed CVPixelBuffers straight into VT
// (zero-copy, on-change, GPU-scaled), so there is NO raw-frame piping, NO
// swizzle, NO full-screen grab. Output to stdout: [4B BE len][Annex-B AU] per
// encoded frame (same framing the Rust sidecar already reads).
//
// Usage: rp-screencap <fps> <bitrate_bps> <scale 0.1..1.0>
// Needs Screen Recording (TCC) permission for THIS binary.
import Foundation
import ScreenCaptureKit
import VideoToolbox
import CoreMedia
import CoreVideo

func die(_ m: String) -> Never { FileHandle.standardError.write((m+"\n").data(using:.utf8)!); exit(1) }

let a = CommandLine.arguments
guard a.count >= 4, let argFps = Int(a[1]), let argBr = Int(a[2]), let argScale = Double(a[3]) else {
  die("usage: rp-screencap <fps> <bitrate_bps> <scale 0.1..1.0>")
}
let stdoutFH = FileHandle.standardOutput
let startCode = Data([0,0,0,1])

// ---- VT encoder (created once we know dimensions) ----
final class Enc {
  let fps: Int
  var bitrate: Int
  var session: VTCompressionSession?
  var au = Data()
  init(fps: Int, bitrate: Int) { self.fps = fps; self.bitrate = bitrate }
  func applyBitrate(_ bps: Int) {
    bitrate = bps
    guard let sess = session else { return }
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AverageBitRate, value: bps as CFNumber)
    let bytesPerSecond = max(1, bps / 8)
    let limits = [bytesPerSecond as CFNumber, 1 as CFNumber] as CFArray
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
    FileHandle.standardError.write("rp-screencap: bitrate \(bps)bps\n".data(using:.utf8)!)
  }
  func ensure(_ w: Int, _ h: Int) {
    if session != nil { return }
    var s: VTCompressionSession?
    let st = VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Int32(w), height: Int32(h),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary,
      imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: { _, _, status, _, sample in encOutput(status, sample) },
      refcon: nil, compressionSessionOut: &s)
    guard st == noErr, let sess = s else { die("VTCompressionSessionCreate failed: \(st)") }
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (self.fps * 2) as CFNumber)
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AverageBitRate, value: self.bitrate as CFNumber)
    // DataRateLimits is a HARD 1-second byte cap that constrains frame/IDR bursts. Only
    // install it when ABR is active; with ABR off (the default) normal RD captures must
    // keep VideoToolbox's stock behavior (AverageBitRate only). Installing it
    // unconditionally would change off-by-default capture, contradicting the
    // zero-behavior-change contract for RP_ABR unset.
    if abrControlEnabled() {
      let bytesPerSecond = max(1, self.bitrate / 8)
      let limits = [bytesPerSecond as CFNumber, 1 as CFNumber] as CFArray
      VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
    }
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: self.fps as CFNumber)
    VTCompressionSessionPrepareToEncodeFrames(sess)
    session = sess
  }
}
let enc = Enc(fps: argFps, bitrate: argBr)
// The encoder (Enc.ensure / VTCompressionSessionEncodeFrame) runs on the SCK
// sample-output queue. applyBitrate touches the same enc.session/enc.bitrate, so
// it must run on this same queue to avoid a data race with encoding.
let sckQueue = DispatchQueue(label: "rp.sck")

func startControlReader() -> DispatchSourceRead {
  let source = DispatchSource.makeReadSource(fileDescriptor: FileHandle.standardInput.fileDescriptor, queue: DispatchQueue(label: "rp.control"))
  var buffer = ""
  source.setEventHandler {
    let data = FileHandle.standardInput.availableData
    if data.isEmpty {
      source.cancel()
      return
    }
    if let text = String(data: data, encoding: .utf8) {
      buffer.append(text)
      while let nl = buffer.firstIndex(of: "\n") {
        let line = String(buffer[..<nl]).trimmingCharacters(in: .whitespacesAndNewlines)
        buffer.removeSubrange(...nl)
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        if parts.count == 2, parts[0] == "bitrate", let bps = Int(parts[1]), bps > 0 {
          sckQueue.async { enc.applyBitrate(bps) }
        }
      }
    }
  }
  source.resume()
  return source
}
// Only attach the stdin control reader when ABR is active. The host pipes a control
// stdin ONLY when RP_ABR is enabled (serve_webrtc.rs abr_enabled(): RP_ABR set and
// != "0"); RP_ABR is inherited from the host's env. In normal non-ABR runs the host
// does not pipe stdin, so an unconditional reader would attach to whatever stdin the
// helper inherited (the host's terminal/pipe) and steal its input.
func abrControlEnabled() -> Bool {
  guard let v = ProcessInfo.processInfo.environment["RP_ABR"] else { return false }
  return v != "0"
}
let controlReader: DispatchSourceRead? = abrControlEnabled() ? startControlReader() : nil
_ = controlReader  // retained to keep the dispatch source alive

func appendParamSets(_ fmt: CMFormatDescription) {
  var count = 0
  CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
  for i in 0..<count {
    var p: UnsafePointer<UInt8>? = nil; var s = 0
    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &s, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pp = p {
      enc.au.append(startCode); enc.au.append(UnsafeBufferPointer(start: pp, count: s))
    }
  }
}
func appendAVCC(_ bb: CMBlockBuffer) {
  var total = 0; var dp: UnsafeMutablePointer<Int8>? = nil
  guard CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total, dataPointerOut: &dp) == noErr, let base = dp else { return }
  var off = 0
  base.withMemoryRebound(to: UInt8.self, capacity: total) { u8 in
    while off + 4 <= total {
      var n: UInt32 = 0; memcpy(&n, base + off, 4); n = UInt32(bigEndian: n); off += 4
      if off + Int(n) > total { break }
      enc.au.append(startCode); enc.au.append(UnsafeBufferPointer(start: u8 + off, count: Int(n)))
      off += Int(n)
    }
  }
}
func encOutput(_ status: OSStatus, _ sample: CMSampleBuffer?) {
  guard status == noErr, let sample = sample, CMSampleBufferDataIsReady(sample) else { return }
  enc.au.removeAll(keepingCapacity: true)
  var keyframe = true
  if let arr = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false), CFArrayGetCount(arr) > 0 {
    let d = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFDictionary.self)
    if let notSync = (d as NSDictionary)[kCMSampleAttachmentKey_NotSync as String] as? Bool { keyframe = !notSync }
  }
  if keyframe, let fmt = CMSampleBufferGetFormatDescription(sample) { appendParamSets(fmt) }
  if let bb = CMSampleBufferGetDataBuffer(sample) { appendAVCC(bb) }
  var len = UInt32(enc.au.count).bigEndian
  var hdr = Data(bytes: &len, count: 4); hdr.append(enc.au)
  stdoutFH.write(hdr)
}

// ---- SCK stream output: IOSurface CVPixelBuffer -> VT (zero-copy) ----
final class Output: NSObject, SCStreamOutput {
  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, CMSampleBufferIsValid(sample) else { return }
    // Skip frames SCK marks as idle/blank (no on-screen change) — frame-skip for free.
    if let arr = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
       let info = arr.first, let raw = info[.status] as? Int, let st = SCFrameStatus(rawValue: raw), st != .complete {
      return
    }
    guard let pb = CMSampleBufferGetImageBuffer(sample) else { return }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    enc.ensure(w, h)
    guard let sess = enc.session else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    VTCompressionSessionEncodeFrame(sess, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid, frameProperties: nil, sourceFrameRefcon: nil, infoFlagsOut: nil)
  }
}
let output = Output()

// ---- bring up SCK on the main display ----
let sem = DispatchSemaphore(value: 0)
var theStream: SCStream?
SCShareableContent.getWithCompletionHandler { content, err in
  guard let content = content, let display = content.displays.first else {
    die("no display from SCShareableContent: \(String(describing: err))")
  }
  let filter = SCContentFilter(display: display, excludingWindows: [])
  let cfg = SCStreamConfiguration()
  cfg.width = max(2, Int(Double(display.width) * argScale)) & ~1
  cfg.height = max(2, Int(Double(display.height) * argScale)) & ~1
  cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(argFps))
  cfg.pixelFormat = kCVPixelFormatType_32BGRA
  cfg.queueDepth = 5
  cfg.showsCursor = true
  let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
  do {
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: sckQueue)
    stream.startCapture { e in
      if let e = e { die("startCapture failed (Screen Recording grant?): \(e)") }
      FileHandle.standardError.write("rp-screencap: SCK \(cfg.width)x\(cfg.height) @\(argFps)fps capturing\n".data(using:.utf8)!)
    }
  } catch { die("addStreamOutput/start failed: \(error)") }
  theStream = stream
  sem.signal()
}
sem.wait()
RunLoop.main.run()
