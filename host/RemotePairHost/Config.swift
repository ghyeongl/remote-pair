// Config.swift — RemotePairHost 공통 상수/경로 + 로깅. (여러 .swift 가 같이 컴파일됨)
//
// 모든 런타임 상태는 ~/.remote-pair 아래 — ~/.claude 동기화에 의존하지 않는다.
// host 헬퍼(tmux-aqua·router·ocr-find)는 앱 번들 Contents/Helpers 에 동봉; 없으면 외부경로 폴백.

import Cocoa
import Darwin

let HOME = NSHomeDirectory()
let RP_DIR = "\(HOME)/.remote-pair"
let LOG_DIR = "\(RP_DIR)/logs"

let HELPERS = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers").path
func helper(_ name: String, _ fallback: String) -> String {
    let bundled = "\(HELPERS)/\(name)"
    return FileManager.default.fileExists(atPath: bundled) ? bundled : fallback
}

let TMUX = helper("tmux-aqua", "\(HOME)/.local/bin/tmux-aqua")        // daemon→setsid 패치된 tmux
let SOCKET = "/tmp/aqua-tmux-rp.sock"                                    // host tmux 서버 소켓
let ROUTER = helper("remote-pair-approve-router.sh", "\(RP_DIR)/bin/remote-pair-approve-router.sh")
let LOGP = "\(LOG_DIR)/remote-pair.log"
let HEARTBEAT = "\(LOG_DIR)/remote-pair.heartbeat"                    // watchdog 가 읽음
let STATUS_FILE = "\(LOG_DIR)/status.json"                            // 에이전트가 읽는 ground truth: 앱 생존 + AX/SR/FDA grant
let RULES_FILE = "\(RP_DIR)/rules.txt"                                // approve 라우터 룰
let TRIGGER = "/tmp/remote-pair.approve-request"                     // (legacy) /approve 스킬 touch → 구 라우터 폴백
// CLI(두뇌, 권한 0) ↔ 앱(권한 경계) primitive 채널. CLI 가 요청, 앱이 grant 로 실행.
//   요청(INPUT_REQ, 탭구분):  shot\t<outpath>  |  click\t<x>\t<y>  |  key\t<combo>
//   응답(INPUT_RES):          ok  |  ok\t<path>  |  err\t<msg>
let INPUT_REQ = "/tmp/remote-pair.input-req"
let INPUT_RES = "/tmp/remote-pair.input-res"

// 표시용 버전 + 업데이트 대상 (Info.plist 단일 출처; build-host.sh 가 채움)
let APP_VERSION = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
let GH_REPO = (Bundle.main.infoDictionary?["RPGitHubRepo"] as? String) ?? "ghyeongl/remote-pair"
let APP_NAME = (Bundle.main.infoDictionary?["CFBundleName"] as? String) ?? "RemotePairHost"
let BUNDLE_ID = Bundle.main.bundleIdentifier ?? "com.x10lab.remote-pair-host"

func ensureDirs() {
    try? FileManager.default.createDirectory(atPath: LOG_DIR, withIntermediateDirectories: true)
}

/// 에이전트(remote-pair status/doctor)가 읽는 단일 ground truth. 앱이 살아있고 grant 됐는지를
/// 추측(pgrep 등)이 아니라 사실로 알 수 있게 한다. 매 tick(1s) 갱신 → ts 신선도로 생존 판단.
func writeStatus() {
    ensureDirs()
    let ts = Int(Date().timeIntervalSince1970)
    let json = "{\"ts\":\(ts),\"pid\":\(getpid()),\"version\":\"\(APP_VERSION)\","
        + "\"bundle_id\":\"\(BUNDLE_ID)\",\"socket\":\"\(SOCKET)\","
        + "\"ax\":\(Permissions.axTrusted()),\"sr\":\(Permissions.srGranted()),\"fda\":\(Permissions.fdaGranted())}\n"
    try? json.write(toFile: STATUS_FILE, atomically: true, encoding: .utf8)
}

let LOG_MAX_BYTES = 5_000_000        // rotate remote-pair.log past 5MB, keep one .1 backup (24/7 host → unbounded growth otherwise)

/// Size-cap rotation: if `path` exceeds `maxBytes`, move it to `path.1` (overwriting the prior backup).
/// Append-only callers tolerate the race; worst case is one lost line at the rotation instant.
func rotateIfNeeded(_ path: String, _ maxBytes: Int) {
    let fm = FileManager.default
    guard let attrs = try? fm.attributesOfItem(atPath: path),
          let size = (attrs[.size] as? NSNumber)?.intValue, size > maxBytes else { return }
    let backup = path + ".1"
    try? fm.removeItem(atPath: backup)
    try? fm.moveItem(atPath: path, toPath: backup)
}

func log(_ s: String) {
    ensureDirs()
    rotateIfNeeded(LOGP, LOG_MAX_BYTES)
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
    if let fh = FileHandle(forWritingAtPath: LOGP) { fh.seekToEndOfFile(); fh.write(line.data(using: .utf8)!); try? fh.close() }
    else { try? line.write(toFile: LOGP, atomically: false, encoding: .utf8) }
}

// 짧은 동기 실행 헬퍼 — stdout 캡처(좌표/세션목록 등). 무거운 작업엔 쓰지 말 것.
@discardableResult
func runCapture(_ launchPath: String, _ args: [String], env: [String: String]? = nil) -> (out: String, status: Int32) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launchPath)
    p.arguments = args
    if let env = env { p.environment = env }
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return ("", -1) }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (String(data: data, encoding: .utf8) ?? "", p.terminationStatus)
}
