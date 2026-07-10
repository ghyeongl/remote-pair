# M-Mount — Host Folder Mount Option

> **Superseded (0.6.0):** per [`roadmap-0.6.0.md`](roadmap-0.6.0.md) D4, the host filesystem is the
> single source of truth and **Syncthing / two-way sync is banned** — the "Mount vs Syncthing" guidance
> below is retained only for historical context. D5 moves file access to open-remote-ssh (not a mount,
> not a sync). Do not adopt Syncthing.

Mount-based file access is an **alternative** to Syncthing for the Xpair file-access layer.
Instead of syncing a local copy, the client mounts the host folder directly so there is a single
source of truth: no sync daemon, no conflict files, no `.sync-conflict-*` clutter.

**Status:** `client/cli/xpair-mount` is SMB-only. It supports mount, unmount, status, and help.
SMB uses macOS NetFS/Finder-style mounting and does not require any third-party kernel extension.

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

**Rule of thumb (superseded):** the historical advice here recommended Syncthing's local copy as the
default for a host-Claude workflow. That is **no longer the policy** — per roadmap-0.6.0.md D4, Syncthing
is banned and the host is the single source of truth. Mount (and, going forward, open-remote-ssh per D5)
keep one authoritative copy; do not adopt Syncthing.

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
| `/Users/alice/Projects/foo` | `foo` | `/Volumes/foo` |
| `/Users/alice/work` | `work` | `/Volumes/work` |

Xpair does not create directories under `/Volumes`. It asks NetFS to mount
`smb://<smb-user>@<smb-host>/<share>`, then discovers the actual mountpoint from
the `mount` table:

```
//<smb-user>@<smb-host>/<share> on <path> (smbfs...)
```

The first-choice path is usually `/Volumes/<share>`, but macOS may choose
`/Volumes/<share>-1` or another suffix if the name is already taken. Xpair prints
the discovered path as `Mountpoint: <path>`. Mounts are read-write by default;
Xpair does not add `rdonly`.

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
xpair-mount unmount /Volumes/foo
xpair-mount unmount /Users/alice/Projects/foo

# Help
xpair-mount help
```

Default mountpoint:

```
/Volumes/<share>
```

After mounting, point a `FOLDER_MAPS` entry at the mountpoint so path mapping in `xpair-launch`
resolves correctly:

```
FOLDER_MAPS="/Volumes/foo::/Users/alice/Projects/foo"
FOLDER_MAP_MODES="/Volumes/foo::mount"
SYNC_BACKEND=mount
MOUNT_BACKEND=smb
```

`xpair-launch` also has a best-effort ensure-mounted guard: before attach, it scans mount-method
folder maps, checks whether the mapped SMB share is already in the `mount`
table, and runs `xpair-mount mount <hostPath>` when missing. If NetFS chooses a
suffixed mountpoint, the launcher uses the discovered path for that attach.
Failures warn but never block attach.

---

## Doctor Check

When a mapping uses the `mount` method, `xpair doctor` checks the host File Sharing state over SSH
best-effort:

- `on`: SMB mounts can connect.
- `OFF`: turn on File Sharing and share the mapped folder.
- `unknown`: the probe could not confirm the state; the real mount attempt remains authoritative.

For sync-only mappings, the SMB readiness row is omitted.
