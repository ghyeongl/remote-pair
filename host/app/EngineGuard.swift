// EngineGuard.swift — local (this-machine) agent-engine install/auth guard for the host onboarding.
//
// The host runs the agent engine (claude | codex | opencode) on ITS OWN machine under `xpair launch`,
// so — unlike the client, which drives the same checks on the host over SSH — these probes/installs run
// LOCALLY here. Every shell line runs through a LOGIN shell (`/bin/bash -lc`) so Homebrew/npm-global PATH
// and the user's exported provider env (ANTHROPIC_API_KEY/OPENAI_API_KEY) resolve exactly as they will at
// launch time.
//
// Mirrors client/ide/remotepair/ext/onboarding-bridge.js (ENGINE_PROBE / ENGINE_INSTALL / ENGINE_AUTH_WRITE):
//   probe   — `command -v <engine>` for install; engine-specific auth check (env OR on-disk credential).
//   install — each engine's official native installer (non-interactive), then PATH persistence.
//   auth    — the secret is fed over the child's STDIN only (read -r KEY) — never argv/log/disk-plaintext.
//             codex pipes it into `codex login --with-api-key`; claude/opencode write an idempotent
//             `export ANTHROPIC_API_KEY=…` block into the login-shell rc.
//
// The chosen engine is persisted to ~/.xpair/host/host.env (ENGINE=<id>), the host-side counterpart of the
// client's client.env ENGINE — one source of truth the launcher reads.

import Foundation

enum EngineGuard {
    /// Path enrichment so a native (~/.local/bin, ~/.opencode/bin) or Homebrew engine resolves even
    /// before the rc's own PATH lines run.
    private static let pathPrefix =
        "export PATH=\"$HOME/.local/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; "

    static func isKnown(_ engine: String) -> Bool {
        engine == "claude" || engine == "codex" || engine == "opencode" || engine == "shell"
    }

    // MARK: - probe

    struct Status { let installed: Bool; let authed: Bool; let version: String; let err: String }

    /// Per-engine probe: prints an RP_* block (RP_ENGINE_INSTALLED, RP_ENGINE_VERSION, RP_ENGINE_AUTHED).
    private static func probeScript(_ engine: String) -> String {
        switch engine {
        case "claude":
            return pathPrefix +
                "if command -v claude >/dev/null 2>&1; then echo RP_ENGINE_INSTALLED=1; " +
                "echo \"RP_ENGINE_VERSION=$(claude --version 2>/dev/null | head -1)\"; " +
                "if [ -n \"$ANTHROPIC_API_KEY\" ] || [ -f \"$HOME/.claude/.credentials.json\" ]; then echo RP_ENGINE_AUTHED=1; fi; " +
                "else echo RP_ENGINE_INSTALLED=0; fi"
        case "codex":
            return pathPrefix +
                "if command -v codex >/dev/null 2>&1; then echo RP_ENGINE_INSTALLED=1; " +
                "echo \"RP_ENGINE_VERSION=$(codex --version 2>/dev/null | head -1)\"; " +
                "if codex login status >/dev/null 2>&1 || [ -f \"$HOME/.codex/auth.json\" ]; then echo RP_ENGINE_AUTHED=1; fi; " +
                "else echo RP_ENGINE_INSTALLED=0; fi"
        default: // opencode
            return pathPrefix +
                "if command -v opencode >/dev/null 2>&1; then echo RP_ENGINE_INSTALLED=1; " +
                "echo \"RP_ENGINE_VERSION=$(opencode --version 2>/dev/null | head -1)\"; " +
                "if [ -n \"${ANTHROPIC_API_KEY}${OPENAI_API_KEY}\" ] || [ -f \"$HOME/.local/share/opencode/auth.json\" ]; then echo RP_ENGINE_AUTHED=1; fi; " +
                "else echo RP_ENGINE_INSTALLED=0; fi"
        }
    }

    static func status(_ engine: String) -> Status {
        let r = runLogin(probeScript(engine))
        if r.code != 0 && r.out.isEmpty {
            return Status(installed: false, authed: false, version: "",
                          err: r.err.isEmpty ? "probe failed" : r.err)
        }
        var installed = false, authed = false, version = ""
        for line in r.out.split(separator: "\n") {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l == "RP_ENGINE_INSTALLED=1" { installed = true }
            else if l == "RP_ENGINE_AUTHED=1" { authed = true }
            else if l.hasPrefix("RP_ENGINE_VERSION=") {
                version = String(l.dropFirst("RP_ENGINE_VERSION=".count))
            }
        }
        return Status(installed: installed, authed: authed, version: version, err: "")
    }

    // MARK: - install

    struct Result { let ok: Bool; let err: String }

    private static func installScript(_ engine: String) -> String {
        switch engine {
        case "claude":
            return pathPrefix + "bash -c 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'"
        case "codex":
            return pathPrefix + "bash -c 'set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'"
        default: // opencode
            return pathPrefix + "bash -c 'set -o pipefail; curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path'"
        }
    }

    private static let pathPersistScript =
        "set -e; " +
        "mkdir -p \"$HOME/.xpair\"; " +
        "printf '%s\\n' 'export PATH=\"$HOME/.local/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"' > \"$HOME/.xpair/env\"; " +
        "for RC in \"$HOME/.zprofile\" \"$HOME/.zshrc\" \"$HOME/.bash_profile\" \"$HOME/.bashrc\"; do " +
        "touch \"$RC\"; TMP=\"$(mktemp)\"; " +
        "grep -vF '# >>> xpair PATH >>>' \"$RC\" | grep -vF '. \"$HOME/.xpair/env\"' | grep -vF '# <<< xpair PATH <<<' > \"$TMP\" || true; " +
        "cat \"$TMP\" > \"$RC\"; rm -f \"$TMP\"; " +
        "{ echo '# >>> xpair PATH >>>'; echo '[ -f \"$HOME/.xpair/env\" ] && . \"$HOME/.xpair/env\"'; echo '# <<< xpair PATH <<<'; } >> \"$RC\"; " +
        "done; echo RP_PATH_OK=1"

    static func install(_ engine: String) -> Result {
        let r = runLogin(installScript(engine))
        if r.code != 0 {
            let msg = r.err.isEmpty ? (r.out.isEmpty ? "install failed" : r.out) : r.err
            return Result(ok: false, err: msg)
        }
        let p = runLogin(pathPersistScript)
        if p.code != 0 || !p.out.contains("RP_PATH_OK=1") {
            let msg = p.err.isEmpty ? (p.out.isEmpty ? "PATH persistence failed" : p.out) : p.err
            return Result(ok: false, err: "\(engine) installed but PATH persistence failed: \(msg)")
        }
        return Result(ok: true, err: "")
    }

    // MARK: - auth (secret over stdin only)

    /// rc writer: idempotently rewrite a single xpair-delimited `export <var>=…` block in the login-shell rc.
    /// Reads the secret from STDIN (`read -r KEY`) — it never appears on argv/log/disk-plaintext.
    private static func rcExportScript(_ varName: String) -> String {
        return
            "read -r KEY; " +
            "case \"${SHELL:-}\" in *zsh) RC=\"$HOME/.zshrc\";; *bash) RC=\"$HOME/.bashrc\";; *) RC=\"$HOME/.zshrc\";; esac; " +
            "touch \"$RC\"; chmod 600 \"$RC\" 2>/dev/null || true; " +
            "TMP=\"$(mktemp)\"; " +
            // Drop ONLY the prior Xpair-managed block (markers + the line between), never a user's own
            // `export VAR=` outside our block — a blanket grep would silently delete it. (Mirror of
            // onboarding-bridge.js rcExportWriter.)
            "awk -v b=\"# >>> xpair \(varName) >>>\" -v e=\"# <<< xpair \(varName) <<<\" '$0==b{skip=1;next} $0==e{skip=0;next} skip!=1' \"$RC\" > \"$TMP\" || true; " +
            "mv \"$TMP\" \"$RC\"; " +
            "{ echo \"# >>> xpair \(varName) >>>\"; printf 'export \(varName)=%s\\n' \"$KEY\"; echo \"# <<< xpair \(varName) <<<\"; } >> \"$RC\"; " +
            "echo RP_AUTH_OK=1"
    }

    private static func authScript(_ engine: String) -> String {
        switch engine {
        case "codex":
            return pathPrefix +
                "read -r KEY; printf %s \"$KEY\" | codex login --with-api-key >/dev/null 2>&1 && echo RP_AUTH_OK=1"
        default: // claude / opencode both read the provider env at runtime
            return rcExportScript("ANTHROPIC_API_KEY")
        }
    }

    static func setAuth(_ engine: String, key: String) -> Result {
        let r = runLogin(authScript(engine), stdin: key + "\n")
        if r.out.contains("RP_AUTH_OK=1") { return Result(ok: true, err: "") }
        let msg = r.err.isEmpty ? (r.out.isEmpty ? "could not set API key" : r.out) : r.err
        return Result(ok: false, err: msg)
    }

    // MARK: - persist chosen engine (~/.xpair/host/host.env, ENGINE=<id>)

    private static var hostEnvPath: String { "\(RP_DIR)/host.env" }

    static func persist(_ engine: String) -> Result {
        do {
            try FileManager.default.createDirectory(atPath: RP_DIR, withIntermediateDirectories: true)
        } catch {
            // Non-fatal: writeFile below surfaces the real error if the dir truly can't be made.
        }
        // Upsert ENGINE=<id>, preserving any other KEY=VALUE lines already in host.env.
        var lines: [String] = []
        if let raw = try? String(contentsOfFile: hostEnvPath, encoding: .utf8) {
            lines = raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        }
        var found = false
        lines = lines.map { line in
            if line.hasPrefix("ENGINE=") { found = true; return "ENGINE=\(engine)" }
            return line
        }
        if !found { lines.append("ENGINE=\(engine)") }
        // Drop a trailing empty element so we don't accumulate blank lines on each rewrite.
        while let last = lines.last, last.isEmpty { lines.removeLast() }
        let body = lines.joined(separator: "\n") + "\n"
        do {
            try body.write(toFile: hostEnvPath, atomically: true, encoding: .utf8)
            return Result(ok: true, err: "")
        } catch {
            return Result(ok: false, err: "\(error)")
        }
    }

    /// Write ENGINE=<id> ONLY if host.env does not already record a non-empty one. Used when onboarding
    /// SKIPS the engine step (some engine is already installed+authed): xpair-launch reads host.env's
    /// ENGINE, so it must find one — but we must NOT clobber a choice the user made in a previous run.
    static func persistIfUnset(_ engine: String) -> Result {
        if let raw = try? String(contentsOfFile: hostEnvPath, encoding: .utf8),
           raw.split(separator: "\n", omittingEmptySubsequences: false)
               .contains(where: { $0.hasPrefix("ENGINE=") && $0 != "ENGINE=" }) {
            return Result(ok: true, err: "")   // already recorded — leave the user's choice intact
        }
        return persist(engine)
    }

    // MARK: - login-shell runner

    private struct Run { let code: Int32; let out: String; let err: String }

    /// Run `script` via `/bin/bash -lc` (login shell → brew/npm PATH + exported provider env). When
    /// `stdin` is non-nil, the value is written ONCE to the child's stdin then closed — used to hand a
    /// secret to `read -r KEY` without it ever touching argv, a log line, or disk.
    private static func runLogin(_ script: String, stdin: String? = nil) -> Run {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-lc", script]
        let outPipe = Pipe(); let errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        let inPipe: Pipe? = stdin != nil ? Pipe() : nil
        if let inPipe { p.standardInput = inPipe }
        do { try p.run() } catch {
            return Run(code: -1, out: "", err: "\(error)")
        }
        if let inPipe, let stdin {
            let h = inPipe.fileHandleForWriting
            h.write(Data(stdin.utf8))
            try? h.close()
        }
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return Run(
            code: p.terminationStatus,
            out: (String(data: outData, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            err: (String(data: errData, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}
