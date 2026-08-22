// ApproveManager.swift — approve 라우터를 이 앱(granted 신원)의 자식으로 띄운다 (on-demand).
//
// 클릭/키는 항상 RemotePairHost(AX+SR+PostEvent granted) 서브트리에서 일어나야 함(상속).
// 라우터가 화면을 보고(OCR) 어떤 승인창인지 감지→라우팅. claude/스킬은 "요청"만.

import Cocoa

final class ApproveManager {
    private var running = false
    func run() {
        if running { return }                          // 라우터가 내부 재시도하므로 중복 스폰 방지
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
        if let raw = try? String(contentsOfFile: outcomeRequest, encoding: .utf8) {
            let path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let candidate = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            let allowedParent = URL(fileURLWithPath: "/tmp").resolvingSymlinksInPath()
            if candidate.deletingLastPathComponent().path == allowedParent.path
                && candidate.lastPathComponent.hasPrefix("remote-pair.") {
                environment["RP_OUTCOME_FILE"] = candidate.path
            }
        }
        try? FileManager.default.removeItem(atPath: outcomeRequest)
        p.environment = environment
        p.terminationHandler = { [weak self] _ in self?.running = false }
        do { try p.run(); log("APPROVE: router spawned") }      // async — 메인스레드 안 막음
        catch { log("APPROVE: router spawn 실패 \(error)"); running = false }
    }
}
