# M-Mount — Host Folder Mount Option

Mount-based file access is an **alternative** to Syncthing for the Xpair file-access layer.
Instead of syncing a local copy, the client mounts the host folder directly so there is a single
source of truth: no sync daemon, no conflict files, no `.sync-conflict-*` clutter.

**Status:** `client/cli/xpair-mount` is SMB-only. It supports mount, unmount, status, and help.
SMB uses macOS `mount_smbfs`, which is built into macOS and does not require any third-party kernel
extension.

---

## When to use Mount vs Syncthing

| | Mount | Syncthing |
|---|---|---|
| **Source of truth** | Single (host) — no copies | Dual (host + client) — synced |
| **Read latency** | Network round-trip per read (SMB: ~1-5 ms LAN) | Near-zero (local copy) |
| **Write latency** | Network round-trip per write | Near-zero (local), synced async |
| **Offline editing** | Not possible — host must be reachable | Possible, synced on reconnect |
| **Conflict risk** | Zero — only one copy exists | Exists (concurrent edits on both machines) |
| **Daemon required** | No client daemon; host File Sharing must be on | Yes (Syncthing running on both sides) |
| **Best for** | Browsing, reading, occasional edits; zero-conflict CI/build output workflows | Heavy interactive editing with claude running locally |

**Rule of thumb:** if you're using Xpair primarily to run claude on the host, Syncthing's local copy
means claude reads files at disk speed and is the better default. Choose Mount when you want a single
authoritative copy, or when you are viewing large generated artifacts and do not want them synced
locally.

---

## SMB Setup

SMB is the only mount backend. macOS File Sharing runs an SMB server automatically when enabled. No
client-side package or kernel extension is needed.

Host one-time step:

> **System Settings > General > Sharing > File Sharing** — toggle ON, then click the `+` button
> and add the folder(s) you want to share.

The share name is the basename of the shared folder by default. For example:

| Host path | SMB share | Default client mountpoint |
|---|---|---|
| `/Users/alice/Projects/foo` | `foo` | `/Volumes/<device>/Users_alice_Projects_foo` |
| `/Users/alice/work` | `work` | `/Volumes/<device>/Users_alice_work` |

`<device>` is the sanitized `REMOTE_HOST` value. Characters outside `[A-Za-z0-9._-]` are replaced
with `_`. The local mountpoint folder is the full sanitized host path, while the SMB share name
in the mount URL remains the basename of the shared folder. For
`REMOTE_HOST=user@office-mac.local`, the default mountpoint for `/Users/alice/Projects/foo` is:

```
/Volumes/user_office-mac.local/Users_alice_Projects_foo
```

Mounts are read-write by default because `mount_smbfs` defaults to read-write. Xpair does not add
`rdonly`.

---

## Usage

```
# Mount a host path
xpair-mount mount /Users/alice/Projects/foo

# Explicit --backend smb is still accepted for older callers
xpair-mount --backend smb mount /Users/alice/Projects/foo

# List active Xpair SMB mounts
xpair-mount status

# Unmount by mountpoint or host path
xpair-mount unmount /Volumes/user_office-mac.local/Users_alice_Projects_foo
xpair-mount unmount /Users/alice/Projects/foo

# Help
xpair-mount help
```

Default mountpoint:

```
/Volumes/<sanitized-REMOTE_HOST>/<sanitized-full-hostPath>
```

After mounting, point a `FOLDER_MAPS` entry at the mountpoint so path mapping in `xpair-launch`
resolves correctly:

```
FOLDER_MAPS="/Volumes/user_office-mac.local/Users_alice_Projects_foo::/Users/alice/Projects/foo"
FOLDER_MAP_MODES="/Volumes/user_office-mac.local/Users_alice_Projects_foo::mount"
SYNC_BACKEND=mount
MOUNT_BACKEND=smb
```

`xpair-launch` also has a best-effort ensure-mounted guard: before attach, it scans mount-method
folder maps and runs `xpair-mount mount <hostPath>` for any canonical
`/Volumes/<device>/<sanitized-full-hostPath>` path that is not currently mounted. Failures warn but
never block attach.

---

## Doctor Check

When a mapping uses the `mount` method, `xpair doctor` checks the host File Sharing state over SSH
best-effort:

- `on`: SMB mounts can connect.
- `OFF`: turn on File Sharing and share the mapped folder.
- `unknown`: the probe could not confirm the state; the real mount attempt remains authoritative.

For sync-only mappings, the SMB readiness row is omitted.
