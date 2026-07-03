// Config.swift — XpairHost shared constants/paths + logging. (multiple .swift files are compiled together)
//
// All runtime state lives under ~/.xpair/host — it does not depend on ~/.claude syncing.
// host helpers (tmux-aqua, router, ocr-find) are bundled in the app's Contents/Helpers; falls back to an external path if absent.

import Cocoa
import Darwin

let HOME = NSHomeDirectory()
let RP_DIR = "\(HOME)/.xpair/host"
let CLIENT_DIR = "\(HOME)/.xpair/client"
let LOG_DIR = "\(RP_DIR)/logs"
let ROLE_FILE = "\(RP_DIR)/role"            // host|client|both — written by install.sh. Used to block host self-install on a client.
let CLIENT_ROLE_FILE = "\(CLIENT_DIR)/role"
let CLIENT_ENV_FILE = "\(CLIENT_DIR)/client.env" // present = client installed on this machine
let LEGACY_CLIENT_ENV_FILE = "\(RP_DIR)/client.env" // pre-split client runtime location
let RD_SESSION_TOKEN_FILE = "\(RP_DIR)/rd-session-token" // 0600 token read by the authenticated SSH client before RD signaling.

/// This machine's role. ROLE_FILE trimmed and used as-is (host|client|both); "" if absent or empty (= default host).
/// Parsing is kept consistent with Installer.shouldSkipSelfInstall(Installer.swift:50-55).
func currentRole() -> String {
    // Absent ROLE_FILE = default host (""), the common case → stay silent. Only an *unexpected* read
    // error (file present but unreadable, e.g. perms) is worth a .debug; a missing file is not an error.
    do {
        return try String(contentsOfFile: ROLE_FILE, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
        if FileManager.default.fileExists(atPath: ROLE_FILE) {
            log(.debug, "ROLE: present but unreadable at \(ROLE_FILE): \(error) — defaulting to host")
        }
        return ""
    }
}

/// Does this machine act as a host? host / both / empty (unset = default host) → true.  Only client is false.
/// HOST/both use the same grant flow as today; client is ACCESS-ONLY (no AX/SR prompts).
var isHostRole: Bool {
    let role = currentRole()
    return role == "host" || role == "both" || role.isEmpty
}

/// Is this a client (ACCESS-ONLY) machine? true only when role == "client".
var isClientRole: Bool { currentRole() == "client" }

func clientEnvFileExists() -> Bool {
    let fm = FileManager.default
    return fm.fileExists(atPath: CLIENT_ENV_FILE) || fm.fileExists(atPath: LEGACY_CLIENT_ENV_FILE)
}

func readClientEnvFile() -> String? {
    if let raw = try? String(contentsOfFile: CLIENT_ENV_FILE, encoding: .utf8) { return raw }
    return try? String(contentsOfFile: LEGACY_CLIENT_ENV_FILE, encoding: .utf8)
}

func roleFileContainsClient(_ file: String) -> Bool {
    guard let raw = try? String(contentsOfFile: file, encoding: .utf8) else { return false }
    let role = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return role == "client" || role == "both"
}

func clientEnvHasRemoteHost() -> Bool {
    guard let raw = readClientEnvFile() else { return false }
    for line in raw.split(separator: "\n") {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("REMOTE_HOST=") {
            let v = String(t.dropFirst("REMOTE_HOST=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
            return !v.isEmpty
        }
    }
    return false
}

let HELPERS = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers").path
func helper(_ name: String, _ fallback: String) -> String {
    let bundled = "\(HELPERS)/\(name)"
    return FileManager.default.fileExists(atPath: bundled) ? bundled : fallback
}

let TMUX = helper("tmux-aqua", "\(HOME)/.local/bin/tmux-aqua")        // tmux patched with daemon→setsid
let SOCKET = "/tmp/aqua-tmux.sock"                                    // host tmux server socket
let ROUTER = helper("xpair-approve-router.sh", "\(RP_DIR)/bin/xpair-approve-router.sh")
let LOGP = "\(LOG_DIR)/xpair.log"
let HEARTBEAT = "\(LOG_DIR)/xpair.heartbeat"                          // read by the watchdog
let STATUS_FILE = "\(LOG_DIR)/status.json"                            // ground truth read by the agent: app alive + AX/SR/FDA grant
let RULES_FILE = "\(RP_DIR)/rules.txt"                                // approve router rules
let TRIGGER = "/tmp/xpair.approve-request"                           // (legacy) /approve skill touch → old router fallback
// (legacy v0 InputServer file channel INPUT_REQ/INPUT_RES removed — its 0.1s main-thread polling froze
//  the menu bar. Screen sharing is replaced by v1/v2: xpair(screen) serve-webrtc (view-only, no remote input).)

// Display version + update target (Info.plist is the single source; populated by build-host.sh)
let APP_VERSION = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
let GH_REPO = (Bundle.main.infoDictionary?["RPGitHubRepo"] as? String) ?? "x10lab/xpair"
let APP_NAME = (Bundle.main.infoDictionary?["CFBundleName"] as? String) ?? "XpairHost"
let BUNDLE_ID = Bundle.main.bundleIdentifier ?? "com.x10lab.xpair-host"

func ensureDirs() {
    // §1: logs dir MUST be mode 0700 (contains host names, ssh aliases, paths). Idempotent.
    do {
        try FileManager.default.createDirectory(atPath: LOG_DIR, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
    } catch {
        // Already-exists is the common, ignorable case; anything else means we may fail to log below.
        // Use FileHandle.standardError (NOT log()) to avoid recursion into a dir that may not exist.
        let exists = FileManager.default.fileExists(atPath: LOG_DIR, isDirectory: nil)
        if !exists {
            FileHandle.standardError.write(Data("[xpair] ensureDirs: cannot create \(LOG_DIR): \(error)\n".utf8))
        }
    }
}

/// The single ground truth read by the agent (xpair status/doctor). Lets it know whether the app
/// is alive and granted as fact, not by guessing (pgrep, etc.). Refreshed every tick (1s) → liveness judged from ts freshness.
func writeStatus() {
    ensureDirs()
    let ts = Int(Date().timeIntervalSince1970)
    let json = "{\"ts\":\(ts),\"pid\":\(getpid()),\"version\":\"\(APP_VERSION)\","
        + "\"bundle_id\":\"\(BUNDLE_ID)\",\"socket\":\"\(SOCKET)\","
        + "\"ax\":\(Permissions.axTrusted()),\"sr\":\(Permissions.srGranted()),\"fda\":\(Permissions.fdaGranted())}\n"
    // status.json is the agent's ground truth; a stale file makes the agent misjudge liveness/grants → warn.
    do { try json.write(toFile: STATUS_FILE, atomically: true, encoding: .utf8) }
    catch { log(.warn, "STATUS: write \(STATUS_FILE) failed: \(error)") }
}

let LOG_MAX_BYTES = 5_000_000        // §7: rotate xpair.log past 5MB (24/7 host → unbounded growth otherwise)
let LOG_BACKUPS = 2                   // §7: keep live + .1 + .2 (max 3 total)
// §7 cross-writer lock. MUST be the SAME atomic-mkdir lock dir that bash _rp_rotate uses
// (shared/logging.sh: "$LOG_DIR/.xpair.log.lock.d") — a flock(2) lock would NOT interoperate
// with bash's mkdir lock, so the Swift host + launcher bash writers would not actually mutually exclude.
let LOG_LOCK_DIR = "\(LOG_DIR)/.xpair.log.lock.d"

// MARK: - Logging contract (docs/logging.md)

/// §4 levels (ascending). A record is written iff its level >= the resolved threshold.
enum Level: Int {
    case trace, debug, info, warn, error
    /// §3: upper-case level token in the line.
    var tag: String {
        switch self {
        case .trace: return "TRACE"
        case .debug: return "DEBUG"
        case .info:  return "INFO"
        case .warn:  return "WARN"
        case .error: return "ERROR"
        }
    }
    /// Parse a level *name* (case-insensitive). nil for unknown tokens.
    static func parse(_ raw: String) -> Level? {
        switch raw.lowercased() {
        case "trace": return .trace
        case "debug": return .debug
        case "info":  return .info
        case "warn", "warning": return .warn
        case "error": return .error
        default: return nil
        }
    }
}

/// §4: file threshold = REMOTEPAIR_LOG (level name, case-insensitive) else .info. Resolved once at process start.
let LOG_THRESHOLD: Level = {
    if let raw = ProcessInfo.processInfo.environment["REMOTEPAIR_LOG"],
       let lvl = Level.parse(raw) { return lvl }
    return .info
}()

/// §3 timestamp: local-tz ISO-8601 to second precision with numeric offset, e.g. 2026-06-15T10:45:16+0900.
/// (ISO8601DateFormatter emits a `Z`/UTC by default and a colon in the offset; the contract example is `+0900`.)
let logTSFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
    return f
}()

/// §7 size-cap rotation under a shared advisory lock so the Swift host and the launcher bash writer
/// don't clobber each other's backups (both append to xpair.log). Keeps live + .1/.2/.3.
/// The lock guards only the cheap stat + rename window; appends stay lock-free atomic single writes (§7).
func rotateIfNeeded(_ path: String, _ maxBytes: Int) {
    let fm = FileManager.default
    // Cheap pre-check outside the lock — avoid taking the lock on every single log line.
    guard let attrs = try? fm.attributesOfItem(atPath: path),
          let size = (attrs[.size] as? NSNumber)?.intValue, size > maxBytes else { return }

    // Acquire the SHARED atomic-mkdir lock (same primitive + dir as bash _rp_rotate, shared/logging.sh)
    // so the Swift host and the launcher bash writer serialize on xpair.log. 5s spin then give up.
    var spins = 0
    while mkdir(LOG_LOCK_DIR, 0o700) != 0 {
        if errno != EEXIST { return }            // unexpected error → skip rotation this pass
        spins += 1; if spins >= 50 { return }    // 50 × 0.1s = 5s timeout → skip (file grows slightly past cap)
        usleep(100_000)
    }
    defer { rmdir(LOG_LOCK_DIR) }

    // Rotation diagnostics go to STDERR, never log() — re-entering log()→rotateIfNeeded while we hold
    // this lock (e.g. on a rename failure of an oversized file) would deadlock on the same mkdir lock.
    func diag(_ m: String) { FileHandle.standardError.write(Data("[xpair] rotate: \(m)\n".utf8)) }

    // Re-check under the lock: another writer may have rotated between our pre-check and acquiring the lock.
    guard let attrs2 = try? fm.attributesOfItem(atPath: path),
          let size2 = (attrs2[.size] as? NSNumber)?.intValue, size2 > maxBytes else { return }

    // Shift backups: .(N-1) → .N, …, .1 → .2, live → .1. Keep at most LOG_BACKUPS (live + .1 + .2).
    let oldest = "\(path).\(LOG_BACKUPS)"
    do { if fm.fileExists(atPath: oldest) { try fm.removeItem(atPath: oldest) } }
    catch { diag("remove oldest \(oldest) failed: \(error)") }
    var i = LOG_BACKUPS - 1
    while i >= 1 {
        let src = "\(path).\(i)"
        let dst = "\(path).\(i + 1)"
        if fm.fileExists(atPath: src) {
            do { try fm.moveItem(atPath: src, toPath: dst) }
            catch { diag("move \(src) → \(dst) failed: \(error)") }
        }
        i -= 1
    }
    do { try fm.moveItem(atPath: path, toPath: "\(path).1") }
    catch { diag("move live \(path) → \(path).1 failed: \(error)") }
}

/// §6 REMOTE_HOST for redaction — env wins, else parsed once from ~/.xpair/client/client.env (KEY=VALUE).
private let logRemoteHost: String? = {
    if let h = ProcessInfo.processInfo.environment["REMOTE_HOST"], !h.isEmpty { return h }
    if let raw = readClientEnvFile() {
        for line in raw.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("REMOTE_HOST=") {
                let v = String(t.dropFirst("REMOTE_HOST=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
                return v.isEmpty ? nil : v
            }
        }
    }
    return nil
}()

/// §6 redaction: mask the home dir → ~ and REMOTE_HOST → <host> before any sink (logs may be shipped
/// via `xpair logs --collect`). Best-effort, msg body only.
///
/// SCOPE: this is the LOCAL-LOG redactor. Local logs legitimately keep full absolute paths (other than
/// $HOME) for debugging, so this deliberately does NOT mask IPs, arbitrary paths, or other hostnames.
/// For anything that LEAVES the machine (PostHog props, Sentry crash payloads) use `outboundScrub()`.
func logRedact(_ s: String) -> String {
    var r = s.replacingOccurrences(of: HOME, with: "~")
    if let h = logRemoteHost { r = r.replacingOccurrences(of: h, with: "<host>") }
    return r
}

// MARK: - Strict OUTBOUND scrubber (telemetry / Sentry only — NOT local logs)

/// Precompiled regexes for the outbound scrubber. Order matters at apply time:
/// hostnames (*.ts.net) and IPs are masked BEFORE generic absolute paths so a token never gets
/// half-masked. Compiled once; a nil (pattern bug) entry is simply skipped (fail-open to logRedact()).
private enum OutboundScrubPatterns {
    // IPv4 dotted-quad. Bounded by non-digit/dot edges so we don't bite version strings mid-number.
    // (A loose octet match is fine — over-masking an outbound value is acceptable; under-masking is not.)
    static let ipv4 = try? NSRegularExpression(
        pattern: #"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])"#)
    // IPv6: a run of hex/':' that contains EITHER a '::' compression (e.g. fe80::1, 2001:db8::ff00)
    // OR ≥2 ':'-separated hex groups (e.g. 1:2:3:4:5:6:7:8), with an optional %zone id. The two alts
    // cover compressed and full forms; bare hex words (no ':' run) are not matched. Edges bounded so we
    // don't eat surrounding text. Over-masking is acceptable (design rule: never under-mask outbound).
    static let ipv6 = try? NSRegularExpression(
        pattern: #"(?<![\w:.])(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?:%[0-9A-Za-z]+)?|(?<![\w:.])(?:[0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{1,4}(?:%[0-9A-Za-z]+)?(?![\w:])"#)
    // Tailnet MagicDNS names: <host>.<tailnet>.ts.net (and the *.tailscale.net variant). Mask whole FQDN.
    static let tsNet = try? NSRegularExpression(
        pattern: #"(?<![\w.-])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.ts\.net\b"#)
    // Known absolute-path roots that carry usernames / temp scratch: /Users/<name>, /home/<name>,
    // /private/var/folders/.., /var/folders/.., /tmp/.. — mask the root AND the rest of the path segment run.
    static let knownPaths = try? NSRegularExpression(
        pattern: #"(?:/Users|/home|/private/var/folders|/var/folders|/tmp)(?:/[^\s"':,;)\]}]*)*"#)
    // Generic absolute path: two-or-more leading segments (so we don't mask a bare "/" or "/x"). Runs after
    // the specific roots above. Bounded by whitespace/quote/punct so JSON/text around it survives.
    static let genericPath = try? NSRegularExpression(
        pattern: #"(?<![\w/])/[A-Za-z0-9._-]+(?:/[^\s"':,;)\]}]*)+"#)
}

private func outboundReplace(_ s: String, _ re: NSRegularExpression?, _ repl: String) -> String {
    guard let re = re else { return s }   // pattern failed to compile → skip (still has logRedact() base)
    let range = NSRange(s.startIndex..<s.endIndex, in: s)
    return re.stringByReplacingMatches(in: s, options: [], range: range, withTemplate: repl)
}

/// STRICT outbound scrubber for EVERY value that leaves the machine (PostHog properties, Sentry crash
/// payloads / panic messages / backtrace frames / JS Error stacks). Composes the local `logRedact()`
/// ($HOME → ~, REMOTE_HOST → <host>) and ADDS, in privacy-safe order:
///   • *.ts.net (tailnet MagicDNS) → <host>
///   • IPv6 and IPv4 literals       → <ip>
///   • /Users/<name>, /home/<name>, /private/var/folders/.., /var/folders/.., /tmp/.. → <path>
///   • any other absolute path (≥2 segments) → <path>
///
/// Deliberately over-masks (a too-aggressive outbound mask is acceptable; a leak is not). Does NOT change
/// `logRedact()` — local logs keep their full paths for debugging.
func outboundScrub(_ s: String) -> String {
    var r = logRedact(s)                                         // base: $HOME, REMOTE_HOST
    r = outboundReplace(r, OutboundScrubPatterns.tsNet, "<host>")        // hostnames before IP/path
    r = outboundReplace(r, OutboundScrubPatterns.ipv6, "<ip>")          // IPv6 before IPv4 (longer match)
    r = outboundReplace(r, OutboundScrubPatterns.ipv4, "<ip>")
    r = outboundReplace(r, OutboundScrubPatterns.knownPaths, "<path>")  // specific roots before generic
    r = outboundReplace(r, OutboundScrubPatterns.genericPath, "<path>")
    return r
}

/// §3 unified writer. Emits `[<ISO8601>] [<LEVEL>] [host] [<session>] <msg>` to xpair.log (LOGP),
/// gated by LOG_THRESHOLD. session defaults to RP_SESSION (§5), or `-` for app-level events.
func log(_ level: Level = .info, _ s: String,
         session: String = (ProcessInfo.processInfo.environment["RP_SESSION"] ?? "-")) {
    guard level.rawValue >= LOG_THRESHOLD.rawValue else { return }
    ensureDirs()
    rotateIfNeeded(LOGP, LOG_MAX_BYTES)
    let sess = session.isEmpty ? "-" : session
    let line = "[\(logTSFormatter.string(from: Date()))] [\(level.tag)] [host] [\(sess)] \(logRedact(s))\n"
    let data = Data(line.utf8)
    if let fh = FileHandle(forWritingAtPath: LOGP) {
        fh.seekToEndOfFile(); fh.write(data); try? fh.close()
    } else {
        // File doesn't exist yet — create it. (Append-create race tolerated; first line at worst.)
        do { try line.write(toFile: LOGP, atomically: false, encoding: .utf8) }
        catch { FileHandle.standardError.write(Data("[xpair] log: write \(LOGP) failed: \(error)\n".utf8)) }
    }
}

/// §8 legacy shim: the 45 bare-string call-sites stay unchanged and resolve to .info.
func log(_ s: String) { log(.info, s) }

// Short synchronous run helper — captures stdout (coordinates, session lists, etc.). Don't use it for heavy work.
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
