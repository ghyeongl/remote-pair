// ApproveManager.swift — approve 라우터를 이 앱(granted 신원)의 자식으로 띄운다 (on-demand).
//
// 클릭/키는 항상 RemotePairHost(AX+SR+PostEvent granted) 서브트리에서 일어나야 함(상속).
// 라우터가 화면을 보고(OCR) 어떤 승인창인지 감지→라우팅. claude/스킬은 "요청"만.

import Cocoa

final class ApproveManager {
    private var running = false
    private func readRegularCompanion(_ path: String) -> String? {
        let fd = Darwin.open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
        guard fd >= 0 else { return nil }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
        var bytes = [UInt8](repeating: 0, count: 4096)
        let count = Darwin.read(fd, &bytes, bytes.count)
        guard count > 0 else { return nil }
        return String(bytes: bytes.prefix(Int(count)), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @discardableResult
    func run() -> Bool {
        if running { return false }                    // caller keeps trigger queued until the active router exits
        running = true
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [ROUTER]
        var environment = ["HOME": HOME,
                         // 번들 Helpers 를 PATH 앞에 — 라우터가 동봉된 ocr-find 를 찾도록
                         "PATH": "\(HELPERS):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                         "LANG": "en_US.UTF-8",
                         // 라우터가 올바른 네임스페이스에서 룰/로그를 읽도록 명시 주입
                         "RP_DIR": RP_DIR, "RULES_FILE": RULES_FILE, "LOG_FILE": LOGP]
        let outcomeRequest = TRIGGER + ".outcome"
        if let path = readRegularCompanion(outcomeRequest) {
            let candidate = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            let allowedParent = URL(fileURLWithPath: "/tmp").resolvingSymlinksInPath()
            if candidate.deletingLastPathComponent().path == allowedParent.path
                && candidate.lastPathComponent.hasPrefix("remote-pair.outcome.") {
                environment["RP_OUTCOME_FILE"] = candidate.path
            }
        }
        try? FileManager.default.removeItem(atPath: outcomeRequest)
        let requestIDFile = TRIGGER + ".request-id"
        if let requestID = readRegularCompanion(requestIDFile), !requestID.isEmpty {
            environment["RP_REQUEST_ID"] = requestID
        }
        try? FileManager.default.removeItem(atPath: requestIDFile)
        p.environment = environment
        p.terminationHandler = { [weak self] _ in self?.running = false }
        do { try p.run(); log("APPROVE: router spawned"); return true } // async — 메인스레드 안 막음
        catch { log("APPROVE: router spawn 실패 \(error)"); running = false; return false }
    }
}
