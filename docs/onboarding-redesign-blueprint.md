# Onboarding redesign — implementation blueprint

Design owner: Claude. Implementation: Codex. Source of truth for the target UX:
`context/remotepair-onboarding` (gitignored reference clone). Requirements spec:
`.omc/specs/deep-interview-onboarding-redesign.md`. This blueprint is the bridge
from that spec to code.

Delivery: single branch `feat/onboarding-redesign`, big-bang replacement of both
onboarding surfaces, old onboarding deleted. Done = both apps build + typecheck
green, happy-path e2e for client and host, and quit&reopen resume verified.

---

## 1. Scope map (what replaces what)

| Surface | Current (delete/replace) | Target |
|---|---|---|
| Client webview | `client/ide/remotepair/ext/onboarding-webview/` (9-step, dark, macOS chrome) | Demo client flow (8-step, light 720px card) |
| Host webview | `host/onboarding/` (5-step, dark) | Demo host flow (11-step, light 720px card) |
| Host backend | passive `connectedClients` poll, no accept/deny | broadcast advertise + pairing accept/deny + SSH key authorize + per-step probes |
| Guard | client `runLivenessCheck` + `nextDisabled`; host `nextDisabled` only | per-step self-healing parachute on BOTH, cross-restart resume, DeadEnd |

Keep reusing existing bridge capabilities where they already exist (SSH probe,
discovery, host-app install, mount) — re-sequence and re-skin, do not rewrite.

---

## 2. Design system (replace shell)

From demo `src/styles.css` — light default, no `.dark` toggle:
- `--background: oklch(1 0 0)` (white); foreground near-black slate.
- `--primary: oklch(0.52 0.22 277)` (indigo/violet); `--destructive` red; inline emerald/amber/rose/blue accents.
- `--radius: 0.625rem` (10px); cards `rounded-3xl`/`rounded-2xl`.
- Wizard card `w-[720px]`, body `h-[440px]` scrollable, 3-col footer (Back ghost / center / Next primary). **No macOS traffic-light chrome.** Floating card on `bg-muted/40`, soft shadow.
- System sans; `font-mono` for hostnames, IPs, paths, fingerprints.
- Animations: `step-enter-next/prev` (260ms slide), `radar-ring`, `shimmer-bar`, `soft-pulse`.

Port the demo's `WizardShell`, `AnimatedStep`, `useWizard`, `StepProgress`,
`StepHero`, `StepDeadEnd`, `InstallProgressBar`, and shadcn `ui/*` into both real
webviews, replacing the current dark shell. `StepCheckPerm` is demo dead code — do
not port.

---

## 3. Client flow (8 steps) — `TOTAL = 8`

Indices + gates (from demo `routes/client.tsx`, verbatim logic):

| idx | Step | Gate (`nextDisabled`) / behavior |
|---|---|---|
| 0 | Welcome | none; Next "Get started" |
| 1 | Consent(crash) | none; toggle default **ON** |
| 2 | Consent(analytics) | none; toggle default **OFF** |
| 3 | Discover | disabled until a host selected |
| 4 | Update | auto-skip (650ms) if up-to-date; `needsUpdate`→gated until `updateState==="done"`; `majorMismatch`→**DeadEnd**, Next hidden |
| 5 | WaitPerm | gated until `permAccepted`; `permDenied`→**DeadEnd**, Next hidden |
| 6 | Mappings | gated until `mappings.length>=1`; Next "Finish" |
| 7 | Done | last; footer "Open Xpair" |

`goBackToDiscover()` resets selected/update/perm and `goTo(3,"prev")`.

---

## 4. Host flow (11 steps) — `TOTAL = 11`

| idx | Step | Gate |
|---|---|---|
| 0 | Welcome | none; Next "Begin setup" |
| 1 | Consent(crash) | none; default ON |
| 2 | Consent(analytics) | none; default OFF |
| 3-7 | SinglePerm ×5 `PERM_ORDER=[login,ax,sr,fda,sharing]` | each gated until that perm `granted` |
| 8 | Engine (multi-select) | gated until `engines.size>=1` |
| 9 | Broadcast | **HARD-GATED on accept** (ref 988ee1c+): Next hidden until `broadcast==="accepted"`, no Skip. Deny is soft in-body (re-broadcast). Host onboarding cannot complete until a client pairs. US-004 repoints `accepted`→proven `paired`. |
| 10 | Done | last; footer "Open Xpair" |

Permission copy + panes (verbatim, demo `StepSinglePerm`):
- login "Remote Login (SSH)" — "System Settings → General → Sharing → Remote Login"
- ax "Accessibility" — "…→ Privacy & Security → Accessibility"
- sr "Screen Recording" — "…→ Screen Recording"
- fda "Full Disk Access" — "…→ Full Disk Access"
- sharing "File Sharing" — "System Settings → General → Sharing → File Sharing"

Engines (multi-select, ≥1): Claude Code (Recommended) / Codex / Opencode.

---

## 5. Parachute guard (the core logic change)

**Model:** every step is a self-healing node. On entry AND re-entry, the step
re-probes its precondition. If unmet → auto-bounce (descend) to the matching
repair step. Unrecoverable → `StepDeadEnd` (Next hidden, in-body recovery only).
No single end-of-flow completion gate. Applies to client AND host.

**Cross-restart resume (why the guard is mandatory):** granting a macOS TCC
permission forces the host app to quit & relaunch. Onboarding progress MUST
persist across restart; on relaunch the guard re-probes from the top and lands at
the first unmet step (never restarts at step 0). Persist to disk (host:
`status.json`/app-support state; client: extension global state).

### 5.1 Guard = { probe, repairTarget, deadEnd? } per step

Client:
| Step | Probe (re-check on entry) | Bounce → | DeadEnd |
|---|---|---|---|
| Discover | host still selected & reachable | Discover | — |
| Update | host version compatible | Update (run update) | majorMismatch → DeadEnd "too new" |
| WaitPerm | host accepted + AX/SR granted on host | WaitPerm | denied → DeadEnd "host denied" |
| Mappings | ≥1 mapping mounts | Mappings | — |
| Done | all above fresh | first failing | — |

Host:
| Step | Probe | Bounce → | DeadEnd |
|---|---|---|---|
| SinglePerm(login/ax/sr/fda/sharing) | that TCC/sharing pane granted (re-probe after relaunch) | that same perm step | — |
| Engine | ≥1 engine installed+authed on this Mac | Engine | — |
| Broadcast | (soft) client still paired | Broadcast (re-advertise) | deny is soft in-body, not routing |

DeadEnd tones: majorMismatch = danger `ShieldAlert` "This host is too new"
(actions: "Check for client updates" ext link, "Pick another host"); host-denied =
danger `ShieldX` "Host denied the request" (actions: "Try again", "Pick another host").

---

## 6. Pairing control channel (net-new backend) — DRAFT for codex-challenge

Decisions locked by `260701 논의.txt`:
- **No fixed inbound port.** Host advertises via **LAN broadcast/multicast**
  (Bonjour/mDNS + Syncthing-style local discovery). Client only listens. Remote =
  Tailscale. Cross-NAT hole-punching out of scope.
- **Host is fixed; client portable.** Host keeps advertising open.
- **Client roaming safety:** client watches default gateway MAC; on change →
  moved networks → auto-disable. (Client-only; host does no network key-check.)

### 6.1 Pairing flow (HARDENED — post codex-challenge, gpt-5.5 xhigh)

> ⚠️ The demo UI shows a **transported** `keyFingerprint` string and (conceptually)
> installs a pubkey. That is INSECURE as a backend contract: an attacker can send
> the victim's fingerprint for display + their own pubkey → the host user approves
> the familiar fingerprint but the attacker's key gets authorized. The demo is a UI
> mock; the real backend MUST bind display→installed key. Implement as below, not as
> the demo's data model.

1. Host (Broadcast step) advertises `{ hostname, serviceInstanceID, hostNonce }` over mDNS/broadcast on LAN (+ Tailscale name for remote). The host SSH **host key** is the TOFU anchor — the mDNS `host-key-fp` is a hint only, never trust evidence.
2. Client sends a **signed pairing request**: `{ clientPubKey, name, user, sig }` where `sig = Sign(clientPrivKey, hostKeyFP ‖ hostNonce ‖ serviceInstanceID ‖ clientPubKey ‖ timestamp)`. The request carries the **actual client public key**, not a fingerprint string.
3. Host verifies the signature (proof-of-possession, binds to this host + nonce + fresh timestamp; reject stale/replayed). Only then does the host **compute the fingerprint locally from the received `clientPubKey`** and show THAT on the Broadcast/incoming screen. User eyeball-compares against the client's own display of the **full** `SHA256:` fingerprint (or a word/QR SAS over the full transcript — never a 6–8 char short form).
4. **Accept** → host installs ONLY that exact `clientPubKey` into `~/.ssh/authorized_keys`, hardened (see 6.3); notifies client. **Deny** → notify client (→ client DeadEnd).
5. **Final binding proof:** client then connects over SSH using the approved key; host marks paired only after the authenticated SSH key fingerprint == the approved fingerprint. This closes the "approved key A, logged-in key B" gap.
6. Mutual trust, no PIN: client verifies host via TOFU host key; host verifies client via signature + eyeball SAS + final SSH proof.

### 6.2 Pairing request transport
Pre-authorization there is NO SSH application channel (stock OpenSSH) — do NOT pretend SSH carries step 2. Use an **ephemeral host pairing endpoint open only while the Broadcast step is visible** (a pairing window), receiving **signed** UDP/mDNS request messages. Treat the transport as fully hostile: source IP/name/user are spoofable; all security comes from the signature, host nonce, expiry, rate-limit, and the human Accept. Close the endpoint when leaving Broadcast — no permanent open surface.

### 6.3 authorized_keys hardening (host Accept)
- Install a **dedicated xpair key line**, not raw append. Restrict:
  `restrict,command="/usr/local/bin/xpair-ssh-gate <client-id>",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc` — re-enable `pty`/needed forwards only if the product truly requires them.
- **Sanitize:** accept only a well-formed `ssh-ed25519 <base64>`; reconstruct the line yourself; never pass through attacker-controlled options/newlines/comments.
- **Stable comment for revoke:** `xpair:v1 client_id=… fp=… created=… name=…`; de-dupe by key blob; keep `~/.xpair/authorized_clients.json`; support exact revoke.
- **Atomic write:** flock, validate `~/.ssh` perms, write temp + `chmod 600` + atomic rename, preserve unrelated user keys.

### 6.4 Roaming check is NOT a security boundary
Gateway-MAC watch is a convenience trigger only — ARP spoof, evil-twin, same-gateway, VPN/IPv6-RA route changes, dual-NIC all bypass or false-trigger it. Fail **closed** for auto-connect on unknown network state, but never treat it as auth — auth is always SSH host key + approved client key.

### 6.5 UI note (from reference pull)
Accept/Deny live in the WizardShell **footerSlot** (host route), shown only when `broadcast==="incoming"` — not inside StepBroadcast. Onboarding copy is **i18n (KR/EN via `t()` + LangToggle)** — localize the ported onboarding too. LangToggle mounts on the **Welcome step** of each flow (not the shell); locale persists in localStorage `xpair-locale` in the demo → port onto the real webview state stores (extension global state / host app state), not raw localStorage.

### 6.6 Mapping modes (ref 988ee1c — supersedes the old "Mount/Sync Syncthing" model)
Two client mapping modes on the Mappings step:
- **Mount** — Xpair mounts a host folder here. User picks the **host folder ONLY**; the local mount location is **auto-managed** (no client-path picker in mount mode; the `map.mountPoint` key is orphaned — drop it).
- **Third-party sync** — the same folder already exists on both sides via Google Drive/Dropbox/etc. User maps a **pre-existing** folder on the host AND on this Mac. **No Xpair transport / no Syncthing** — pure path-pairing metadata. Local folder captured via the browser directory picker (`showDirectoryPicker`, name-only) + manual `~/path` fallback; the port must decide how the IDE webview gets the real local path (native picker vs text).

### 6.7 Copy security (ref e5d63c0 drift — fix during port)
The KO `bc.incoming.desc` lost the "name alone can be spoofed / 이름만으로는 위조될 수 있습니다" clause while EN kept it. The §6.1 threat model relies on the user comparing the **fingerprint**, not the spoofable name. **Restore the fingerprint-eyeball / name-spoof warning in BOTH locales** during the port (US-004).

---

## 7. Delivery

- Branch `feat/onboarding-redesign` (already open). Big-bang; delete old onboarding dirs after parity reached.
- Order suggested for Codex: (1) shell+design port both apps → (2) client steps+guard → (3) host steps+guard+resume → (4) pairing backend (broadcast/accept-deny/authorize) + gateway-MAC watch.
- Done: both webviews `tsc` + build green; ext test harness green; happy-path e2e (client discover→pair→map→done; host consent→perms→engine→accept→done); quit&reopen resume lands on correct step.

## 8. Non-goals
No PIN. Client has no engine step. No re-pair/revoke management UI (first-run only). No cross-NAT hole-punching.
