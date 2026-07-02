# Client runtime dir split (`~/.xpair/client`)

Physically separate CLIENT-role runtime state from HOST-role runtime state so
uninstalling one role can never touch the other's files. Closes the class of
bugs found reviewing the #54 uninstallers (a client uninstall wiping shared
`~/.xpair` and breaking a co-located host).

Role-separation epic Stage 3 (`feat/client-host-role-separation`). Blocks the
develop→main release (#61) per decision.

## Today (single shared namespace)

Everything for both roles lives under `~/.xpair/host` (`RP_DIR`), split only by
file: `host.env` (host), `client.env` (client), `common.env`/`role`/manifests
(shared). Two IDE data dirs already sit beside it:

```
~/.xpair/
  host/            both-role runtime (host.env, client.env, role, common.env,
                   .manifest-*, bin/, logs/, mounts/, backups/, rules.txt, …)
  client/          IDE (VSCodium fork) user-data     — identity.json dataFolderName
  client-server/   IDE remote-server data            — identity.json serverDataFolderName
```

## Target (role-separated)

```
~/.xpair/
  host/          HOST runtime — unchanged location (Swift app depends on it)
  client/        CLIENT runtime — MOVED here from host/
  ide/           IDE user-data      — RENAMED from client/
  ide-server/    IDE server-data    — RENAMED from client-server/
```

### Ownership

| Item | Owner dir | Notes |
|---|---|---|
| `host.env`, `rules.txt`, `notify.conf`, `notifications/` | `host/` | host-only, unchanged |
| `bin/xpair-watchdog.sh`, `xpair-notify.sh`, `manage-claude-hooks.py`, `ocr-find` | `host/bin/` | host-only |
| `logs/status.json`, host app logs | `host/logs/` | host app writes; unchanged |
| `clients/<id>.json` heartbeats | `host/clients/` | rendezvous on the HOST machine (client writes over ssh, host app reads locally) — stays |
| `role` marker (host app) | `host/role` | Swift `ROLE_FILE` hardcodes `~/.xpair/host/role`; keep for the host app |
| `.manifest-host`, `rd-session-token` | `host/` | host-only |
| `client.env`, `.force-onboarding` | `client/` | MOVED |
| `mounts/<slug>` | `client/mounts/` | MOVED — see migration (active mounts) |
| `bin/xpair-launch`, `hangul-romanize`, `logging.sh` | `client/bin/` | MOVED |
| client logs (`xpair.log`, `code-server.log`, `claude-launch.err.log`), `session-names` | `client/logs/`, `client/` | MOVED |
| `.manifest-client` | `client/` | MOVED |
| `common.env` (LOCAL_BIN, AQUA_SOCK) | each role writes its own | client can rely on defaults; AQUA_SOCK is host-only. Client gets `client/common.env` (LOCAL_BIN only) |
| `backups/` | per role (`host/backups`, `client/backups`) | `install_file`/`write_file` back up into the installing role's dir |
| IDE user-data | `ide/` | rename `client/` → `ide/` |
| IDE server-data | `ide-server/` | rename `client-server/` → `ide-server/` |

### `RP_DIR` semantics

`shared/config.sh` gains role dirs:
- `RP_HOST_DIR="$HOME/.xpair/host"`, `RP_CLIENT_DIR="$HOME/.xpair/client"`.
- `RP_DIR` resolves to the **role-appropriate** dir. Client CLIs (`xpair`,
  `xpair-launch`, `xpair-mount`, `xpair-desktop`, `xpair-editor`) → `RP_CLIENT_DIR`.
  Host tooling / Swift app → `~/.xpair/host` (Swift unchanged).
- The ~8 CLIs that re-declare `RP_DIR="$HOME/.xpair/host"` inline flip to the
  client dir.

## Migration (existing installs, at install/upgrade time)

Idempotent, one-time, guarded by "old layout present & new absent". Runs when
the IDE / CLIs are not live (installer step).

1. **IDE data rename FIRST** (frees the `client` name for runtime):
   `mv ~/.xpair/client ~/.xpair/ide`, `mv ~/.xpair/client-server ~/.xpair/ide-server`
   (skip if target exists; only if source looks like IDE data, i.e. not our runtime).
2. **Client runtime move**: create `~/.xpair/client`, move `client.env`,
   `session-names`, `.force-onboarding`, client `bin/` tools, client logs, and
   `.manifest-client` from `~/.xpair/host` → `~/.xpair/client`.
3. **Mounts**: existing active mountpoints at `~/.xpair/host/mounts/<slug>` are
   live (SMB/SSHFS) and referenced by `FOLDER_MAPS`. Do NOT move a live mount.
   Strategy: leave existing mounts in place, rewrite new mountpoints under
   `~/.xpair/client/mounts`, and drop a compat symlink `~/.xpair/host/mounts ->
   ~/.xpair/client/mounts` only if `host/mounts` is empty. `FOLDER_MAPS` paths are
   rewritten `host/mounts` → `client/mounts` only for entries not currently mounted;
   mounted entries are left until next remount. (Detail refined in Phase 3.)

## Uninstall (the original driver)

- `shared/uninstall.sh` gains `--role <host|client>` to revert only that role's
  `.manifest-<role>` (default: all, preserving today's behavior).
- `uninstall-client.sh`: revert `--role client`, then `rm -rf ~/.xpair/client`
  (+ `~/.xpair/ide`, `~/.xpair/ide-server` if wiping the client IDE). Never touches
  `~/.xpair/host`. No co-located-host special-casing needed — the dirs are disjoint.
- `uninstall-host.sh`: revert `--role host`, `rm -rf ~/.xpair/host`. Keeps the
  existing legacy-app refuse-gate; also removes the legacy `RemotePairHost.app`
  bundle on `--force` (#64 P2). Never touches `~/.xpair/client`.

## Phases

- **P1 — Foundation (no rebuild):** `config.sh` role dirs; `install.sh`
  role-scoped subpaths + `role`/manifest/common.env placement; `uninstall.sh`
  `--role`; rewrite the two uninstallers to disjoint wipes; migration shim.
  Shell `t_*.sh` tests (harness `--dry-run`). ← testable without VSCodium.
- **P2 — Client CLIs:** flip the ~8 inline `RP_DIR` decls + `reset-onboarding.sh`
  + `xpair-mount`/`xpair-launch`/`xpair-desktop`/`xpair-editor` to the client dir.
- **P3 — IDE extension:** flip the ~6 base-dir constants + 3 inline paths in
  `ext/*.js`/`*.cjs`; `StepFileAccess.tsx` mount-detection string; cosmetic
  strings; `identity.json` + `product.overlay.json` `client`→`ide`,
  `client-server`→`ide-server`. Then VSCodium dist rebuild.
- **P4 — Migration hardening + docs:** finalize the mounts strategy, add
  migration tests, update README/onboarding copy.

Each phase → its own review pass; the whole lands as PR(s) into develop, earns
Codex 👍, then the release (#61) unblocks.
