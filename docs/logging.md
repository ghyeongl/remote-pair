# RemotePair Logging Contract

The single source of truth for how every RemotePair component logs. All 6 components
(bash CLI, Rust `screen`, Swift host app, IDE extension, IDE workbench, shared scripts)
conform to **this** format/level/rotation spec — do not invent per-component variants.

Goal: maintainer debugging now, production diagnostics (collect/redact) later. Logs are
**local only** (never shipped automatically). Telemetry (§11) is a separate, **opt-in**
additive layer that is **OFF by default** and does not touch these log files.

## 1. Log directory

```
~/.remote-pair/logs/          # = $RP_DIR/logs, created mode 0700 by every emitter at init
```

`0700` because logs contain host names, ssh aliases, and file paths. Every logger MUST
`mkdir -p` the dir with mode 0700 on init (idempotent).

## 2. Component → file map

| comp tag | file | writer process(es) |
|----------|------|--------------------|
| `cli` | `cli.log` | bash CLI scripts (many concurrent, short-lived) |
| `rust` | `rust.log` | the `screen` serve engine |
| `host` | `remote-pair.log` | Swift host daemon **+** `remote-pair-launch` SESSION lines (KEEP existing file — no `host.log`) |
| `ide` | `ide.log` | IDE extension (extension-host process) |
| `workbench` | `workbench.log` | IDE workbench (renderer process) |

`remote-pair.log` is the one **cross-language multi-writer** file (Swift + launcher bash). The
launchd-captured `remote-pair.out.log` / `.err.log` / `remote-pair-watchdog.err.log` are raw
stdout/panic capture and are NOT in this contract (left as-is). `remote-pair logs` tails
`$LOG_DIR/*.log` (glob), so every component file surfaces.

## 3. Line format (exact)

```
[<ISO-8601 ts>] [<LEVEL>] [<comp>] [<session>] <message>
```

- `<ISO-8601 ts>`: e.g. `2026-06-15T10:45:16+0900` (local tz, second precision is fine).
- `<LEVEL>`: one of `TRACE DEBUG INFO WARN ERROR` (upper-case, fixed width not required).
- `<comp>`: the comp tag from §2 (`cli` `rust` `host` `ide` `workbench`).
- `<session>`: the correlation id (§5), or `-` when not session-scoped.
- `<message>`: redacted (§6) single logical line. Multi-line payloads: emit one record per line,
  each ≤ PIPE_BUF (≈4 KB) so a single `write()` is atomic.

Example:
```
[2026-06-15T10:45:16+0900] [WARN] [host] [proj-main@1718430000] reaping 2 session(s): a, b
```

## 4. Levels & verbosity control

Levels (ascending): `trace < debug < info < warn < error`.

- **File default = INFO** (single knob). **Console/stderr = WARN+.**
- **Precedence (highest first):** `REMOTEPAIR_LOG` env  >  `remotepair.log.level` (IDE setting)  >  `info`.
  - Rust additionally honors `RUST_LOG` (used only if `REMOTEPAIR_LOG` is unset).
- Values are level names (`debug`, `warn`, …). A record is written to a sink iff its level ≥ the
  resolved threshold for that sink.
- The file default is deliberately a single config value so it can later be lowered to `warn` after
  observing real volume, with no code change.

## 5. Correlation id (`<session>`)

- **Id = `<tmux-session-name>@<epoch>`.** The tmux session name is already the cross-machine
  correlation id (see `HostManager.swift` "the session name is the cross-machine correlation id").
- The bare name collides across reconnects, so suffix `@<epoch>` where **epoch is assigned ONCE on
  the host** (first-attach unix time) and **propagated to the client via `RP_SESSION`**, so both sides
  emit the identical id. Without host-owned epoch, a cross-machine `grep <name>@<epoch>` would not join.
- Grep stays simple: `grep '<name>@' ~/.remote-pair/logs/*.log` (prefix match) for one logical session.
- Propagation: created in `remote-pair-launch` (`new-session -s "$SESS"`), exported as `RP_SESSION`;
  read by the bash logger, the Rust `--session`/`RP_SESSION`, the ext, and Swift `HostManager`.
- App-level / non-session events use `-`.

## 6. Redaction

`redact(msg)` runs before every sink. Minimum masking (now):

- `$HOME` prefix → `~`
- `REMOTE_HOST` value and known ssh host aliases → `<host>`
- absolute paths captured from subprocess stderr → keep basename, mask the dir

Residual leak risk (arbitrary paths inside captured stderr) is documented, not fully solved;
`remote-pair logs --collect` ships these logs to bug reports, so deeper structured redaction is a
follow-up.

## 7. Rotation — rotate-on-open + lock + long-lived guard

- **Baseline (rotate-on-open):** at logger init, if `<file>` size > **5 MB**, shift
  `<file> → <file>.1 → <file>.2` (keep max **3**: the live file + `.1` + `.2`), then open fresh.
- **Lock:** the size-check + rename runs under an advisory lock (`flock` in bash; `flock(2)` in
  Swift/Rust) keyed on a per-file lock, so concurrent writers of the same file (e.g. many `cli`
  invocations, or Swift+launcher both on `remote-pair.log` via `$LOG_DIR/.remote-pair.log.lock`)
  cannot clobber each other's backup or write to an unlinked inode.
- **Long-lived guard:** rotate-on-open alone can't bound a 24/7 process. The host daemon tick loop
  and the Rust serve frame loop MUST additionally run a periodic (cheap `stat`) size-check and rotate
  mid-run.
- **Atomic append:** each record is a single `write()` ≤ PIPE_BUF; no interleaving of partial lines.

## 8. Per-language conformance (where each logger lives)

| comp | logger home | notes |
|------|-------------|-------|
| `cli` | `shared/logging.sh` → installed `$RP_DIR/bin/logging.sh` | `rp_log level comp msg` + `log_info/warn/error`; consumers source with a no-op fallback |
| `rust` | `host/rd/screen/src/log.rs` | `tracing` + custom format layer (session from span field) + custom `MakeWriter` (open + rotate); `EnvFilter` = REMOTEPAIR_LOG>RUST_LOG>info |
| `host` | `host/app/Config.swift` `log()` | leveled overload + `.info` shim for the 45 legacy call-sites; writes `remote-pair.log` |
| `ide` | `client/ide/remotepair/ext/extension.js` `log()` | leveled + file persist + redact; keep OutputChannel |
| `workbench` | `client/ide/.../remotePairLog.ts` (RemotePair-owned, in the zz patch) | `ILogService` primary + mirror appender to `workbench.log` using the SAME formatter |

## 9. Access

- `remote-pair logs` — tail `$LOG_DIR/*.log` (`--host` correlates over ssh; `-f` follow).
- `remote-pair logs --collect` — tar/gzip `$LOG_DIR` → `remote-pair-logs-<stamp>.tgz` for bug reports.
- IDE: `RemotePair: Show Logs` — reveal `$LOG_DIR` / invoke `--collect`.

## 10. Crash dumps (local-only)

Crashes are captured to disk under `$LOG_DIR`. Local capture is **always on and is the
default**; remote crash reporting (§11, Sentry) is **opt-in and OFF by default** — with the
consent flag off, crashes stay disk-local exactly as described here. Because `--collect`
tars all of `$LOG_DIR` (and the files match the `*.log` glob), a crash is recoverable from a bug
report without any external service. Dump files are mode `0600` inside the `0700` dir.

| comp | trigger | file | mechanism |
|------|---------|------|-----------|
| `host` | Obj-C/AppKit exception | `crash-host-<epoch>.log` | `NSSetUncaughtExceptionHandler` → `callStackSymbols`, redacted (§6) |
| `host` | fatal signal (SIGSEGV/ABRT/ILL/BUS/FPE/TRAP) | `crash-host-signal.log` | async-signal-safe handler → `backtrace_symbols_fd(3)` to a pre-opened fd, then re-raise to `SIG_DFL` |
| `rust` | panic | `crash-rust-<epoch>.log` | `std::panic::set_hook` → `Backtrace::force_capture` (independent of `RUST_BACKTRACE`), redacted (§6); chains the previous hook |

Loggers home: Swift in `host/app/CrashReporter.swift` (installed from `main.swift` after
`ensureDirs()`); Rust in `host/rd/screen/src/log.rs` (`install_panic_hook`, installed by `init`).

**Redaction caveat:** the NSException and Rust-panic paths run `redact()` on the dump, but the
fatal-signal path cannot (a signal handler must stay async-signal-safe — no string/alloc work), so
`crash-host-signal.log` ships a raw backtrace. Backtraces are symbol/offset frames, not message
bodies, so leak surface is low, but treat collected dumps as sensitive (§6 posture).

## 11. Remote telemetry (opt-in, OFF by default)

§10's "logs are local only" remains the **default**. As of Phase 1 (2026-06-16) RemotePair adds
an **opt-in, privacy-safe** remote observability layer on top — two independent services, each
behind its own consent flag, **both default `false`**. With both flags off there is **zero**
network traffic to any telemetry endpoint; nothing here changes the local-only posture above.

Funnel/KPI definitions and the frozen event catalog live in
[`.omc/specs/deep-interview-telemetry-funnel.md`](../.omc/specs/deep-interview-telemetry-funnel.md);
this section is the logging-contract summary.

### 11.1 Two services, two consent flags

| Service | Purpose | Consent flag (default `false`) | Client storage | Host storage |
|---------|---------|-------------------------------|----------------|--------------|
| **PostHog** | anonymous activation-funnel product analytics | `telemetry_consent` | `TELEMETRY_CONSENT` in `~/.xpair/client/telemetry.env` | `UserDefaults RPTelemetryConsent` |
| **Sentry** | crash/error reporting (additive to §10's local dumps) | `crash_report_consent` | `CRASH_REPORT_CONSENT` in `~/.xpair/client/telemetry.env` | `UserDefaults RPCrashReportConsent` |

Each flag is independent — either can be on without the other. Consent is surfaced at first run
(two unchecked checkboxes). The `xpair.telemetry.enabled` setting mirrors `TELEMETRY_CONSENT`
only; `CRASH_REPORT_CONSENT` remains owned by the onboarding consent flow.

### 11.2 Anonymous identity

- `distinct_id` = `install_id` = an anonymous **UUID v4** generated once on first run and
  disk-persisted. No account linkage, no PII, ever.
- Client: `TELEMETRY_ANON_ID` in `~/.xpair/client/telemetry.env`. Host: `UserDefaults RPTelemetryAnonId`,
  mirrored to `~/.remote-pair/host.env` for reinstall continuity.
- **Super properties** attached to every PostHog event: `app_version`, `os_version`,
  `device_arch`, `install_id`, `telemetry_consent`.

### 11.3 Phase-1 PostHog events (the only 7 that fire now)

Gated on `telemetry_consent`. Property values for `reason` are the controlled enum in §11.5.

| # | Event | Properties |
|---|-------|------------|
| 1 | `app_first_launch` | `is_fresh_install` |
| 2 | `onboarding_started` | — |
| 3 | `ssh_config_completed` | `keygen_new:bool`, `copy_id_method:"auto"\|"manual_paste"` |
| 4 | `ssh_config_failed` | `reason:<enum>` |
| 5 | `host_connected` | `path:"lan"\|"tailscale"`, `connect_ms` |
| 6 | `host_connect_failed` | `path`, `reason:<enum>` |
| 7 | `first_session_started` | `time_to_wow_ms` |

### 11.4 Reserved Phase-2 event names (NOT fired yet)

The names are frozen now so nothing is renamed later, but these are **not emitted** until the
golden-path features (Bonjour LAN discovery, Tailscale-as-fallback, hosted waitlist) land:
`host_discovery_started`, `host_discovered`, `host_discovery_empty`, `tailscale_fallback_started`,
`tailscale_auth_completed`, `tailscale_host_reachable`, `hosted_cta_shown`,
`hosted_waitlist_submitted`.

### 11.5 Privacy guarantees (OSS audit will verify)

- **Never transmitted:** repository names, file paths, command contents, IP addresses. No PII,
  no account linkage. Hash if a value is genuinely needed (e.g. a bucketed count — never the host).
- **All telemetry + Sentry payloads pass the existing `redact()` / `logRedact()` (§6)** before
  any send — masks `$HOME`, the `REMOTE_HOST` value, and ssh aliases. Reuse the existing
  redactor; do not invent a new one.
- **`reason` is a controlled enum, never raw stderr:** `timeout`, `auth_denied`,
  `host_unreachable`, `dns_failed`, `keygen_error`, `permission_denied`, `unknown`. Raw stderr
  is forbidden (it leaks hostnames/IPs/paths).
- **Sentry PII off:** `sendDefaultPii=false` (Swift/Cocoa & Electron) / `send_default_pii=false`
  (Rust); `server_name` disabled; `beforeSend` strips local paths/`$HOME`/host/IP via the shared
  redactor. Rust panic backtraces are scrubbed before upload. Local crash dumps (§10) are still
  written in parallel.

### 11.6 Transport & config (no hardcoded secrets)

- **PostHog:** raw HTTPS `POST` to a config-provided endpoint (Cloud EU default
  `https://eu.i.posthog.com`, path `/capture/`); fire-and-forget, gated on `telemetry_consent`.
  The extension uses a raw HTTPS capture POST (no `posthog-node` bundling — `extension.js` stays
  vscode-API + node-stdlib only). Project key from config (host: `Info.plist RPPostHogKey`;
  client: `client.env` or build-injected). **If the key/endpoint is absent → silent no-op.**
- **Sentry:** SDK per runtime, DSN from config, gated on `crash_report_consent`. **If the DSN is
  absent → do not init.**
- The endpoint is config-agnostic by design: **PostHog Cloud EU now → self-host later** via a
  config swap, no code change. Keys/DSN are not yet provisioned and **must never be hardcoded**.
