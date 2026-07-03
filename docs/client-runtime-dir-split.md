# Client Runtime Dir Split (`~/.xpair/client`)

Status: landed in branch `feat/client-runtime-dir-split`.

Xpair runtime state is physically split by role so uninstalling or reinstalling
one role cannot remove the other role's files. The client runtime now lives in
`~/.xpair/client`; the host runtime stays in `~/.xpair/host` for the Swift host
app; IDE data moved out of the old `client` name.

## Final Layout

```
~/.xpair/
  host/          HOST runtime
  client/        CLIENT runtime
  ide/           IDE user-data
  ide-server/    IDE remote-server data
```

## Ownership

| Item | Owner dir | Notes |
|---|---|---|
| `host.env`, `rules.txt`, `notify.conf`, `notifications/` | `host/` | Host-only, unchanged. |
| `bin/xpair-watchdog.sh`, `xpair-notify.sh`, `manage-claude-hooks.py`, `ocr-find` | `host/bin/` | Host-only. |
| `logs/status.json`, host app logs | `host/logs/` | Host app writes these locally. |
| `clients/<id>.json` heartbeats | `host/clients/` | Rendezvous on the host machine; clients write over SSH. |
| `role` marker | `host/role` | Swift `ROLE_FILE` still points at `~/.xpair/host/role`. |
| `.manifest-host`, `rd-session-token`, `pairing_ed25519` | `host/` | Host-only. The pairing key stays with the host runtime. |
| `client.env`, `.force-onboarding`, `session-names` | `client/` | Client-only runtime state. |
| `bin/xpair-launch`, `hangul-romanize`, `logging.sh` | `client/bin/` | Client launch/runtime helpers. |
| Client logs (`xpair.log`, `code-server.log`, `claude-launch.err.log`, `cli.log`) | `client/logs/` | Client-side logs. |
| `.manifest-client` | `client/` | Client install manifest. |
| `common.env` | `host/common.env`, `client/common.env` | Each role writes its own common env. `AQUA_SOCK` is host-side; client can rely on defaults. |
| `backups/` | `host/backups`, `client/backups` | Backups are scoped to the installing role. |
| IDE user-data | `ide/` | Renamed from the old `~/.xpair/client` IDE data dir. |
| IDE server-data | `ide-server/` | Renamed from `~/.xpair/client-server`. |
| Mount-method folders | `/Volumes/<device>/<sanitized-host-path>` | SMB-only, read-write by default. No `~/.xpair/*/mounts` runtime location. |

## `RP_DIR` Semantics

`shared/config.sh` defines role dirs:

- `RP_HOST_DIR="$HOME/.xpair/host"`
- `RP_CLIENT_DIR="$HOME/.xpair/client"`
- `RP_IDE_DIR="$HOME/.xpair/ide"`
- `RP_IDE_SERVER_DIR="$HOME/.xpair/ide-server"`

Client CLIs (`xpair`, `xpair-launch`, `xpair-mount`, `xpair-desktop`,
`xpair-editor`) use the client runtime dir for client state. Host tooling and
the Swift app continue to use `~/.xpair/host`.

## Mounts

Mount mode is SMB-only. `xpair-mount` resolves the canonical mountpoint as:

```
/Volumes/<sanitized REMOTE_HOST>/<sanitized full hostPath>
```

The local mountpoint folder uses the full sanitized host path, not just the
basename, so two host paths with the same basename do not collide. The SMB
share in the mount URL still uses the basename of the shared folder. The
sanitizer strips a leading slash, converts `/` to `_`, and replaces characters
outside `[A-Za-z0-9._-]` with `_`. For example,
`REMOTE_HOST=user@office-mac.local` and host path `/Users/alice/Projects/foo`
produce:

```
/Volumes/user_office-mac.local/Users_alice_Projects_foo
```

Mounts are read-write by default because `mount_smbfs` defaults to read-write;
Xpair does not add `rdonly`.

Before attach, the client runs an ensure-mounted guard: for mount-method
`FOLDER_MAPS` entries, it checks whether the canonical
`/Volumes/<device>/<sanitized-host-path>` path is mounted and best-effort runs
`xpair-mount mount <hostPath>` if missing. Failures warn but do not block
attach.

## Migration

`migrate_layout()` runs during install/upgrade and is idempotent:

1. Rename IDE data first, freeing the `client` name for runtime:
   `~/.xpair/client` -> `~/.xpair/ide` and
   `~/.xpair/client-server` -> `~/.xpair/ide-server` when the targets do not
   already exist.
2. Move client runtime state from `~/.xpair/host` to `~/.xpair/client`:
   `client.env`, client launch helpers, client logs, `.manifest-client`,
   `session-names`, and `.force-onboarding`.
3. Rewrite stale mount-method mappings in `~/.xpair/client/client.env`.
   Any `FOLDER_MAPS` entry whose client path has explicit
   `FOLDER_MAP_MODES=<clientPath>::mount`, or whose client path is under a
   legacy `~/.xpair/{host,client}/mounts/` root, is rewritten to the canonical
   `/Volumes/<device>/<sanitized-host-path>` path. Matching `FOLDER_MAP_MODES`
   keys are rewritten too. Sync mappings and entries already under `/Volumes/`
   are left unchanged.

If a legacy mountpoint path is still mounted, migration best-effort runs
`umount` and removes empty leftover directories. Migration never fails the
install for mount cleanup or env rewrite failures; attach-time ensure-mounted
will recreate the canonical SMB mount on next attach.

No compatibility symlink is created from `~/.xpair/host/mounts` to
`~/.xpair/client/mounts`; both locations are retired for mount mode.
