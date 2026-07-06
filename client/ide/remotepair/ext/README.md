# Xpair

Turns the **Xpair IDE** (a VSCodium fork) into a xpair **client** for
a macOS **host** running `XpairHost.app`.

The IDE is the client; the host is a separate Mac reached over SSH
(`REMOTE_HOST` in `~/.xpair/client/client.env`). The IDE Remote Desktop is
an authenticated screen-and-input surface; host-side agent sessions keep
computer-use privileges through `XpairHost.app`.

## Features

- **Remote Desktop** — a live stream of the host screen in a pinned editor tab,
  with pointer, wheel, keyboard, and composed-text input forwarded over the
  active RD session.
- **Connect to Host** — opens the host filesystem over *Open Remote - SSH* in
  one click (uses `REMOTE_HOST`).
- **Host notifications** — surfaces queued host notifications
  (`~/.xpair/host/notifications/queue.jsonl`) as IDE messages, optionally
  filtered by `~/.xpair/host/notify.conf` `ENABLED_TYPES`.
- **First-run bootstrap** — installs Claude Code, ChatGPT and Open Remote - SSH
  from the configured gallery if missing.

## How it works

The extension opens an SSH tunnel for the WebRTC signaling channel. The video
stream and input DataChannels are bound to that authenticated RD session.
`REMOTE_HOST` is validated before SSH use so it cannot inject SSH options or
shell metacharacters.

## Requirements

- Passwordless SSH from this client to `REMOTE_HOST` (`BatchMode=yes` must work).
- `XpairHost.app` running on the host with Screen Recording and Accessibility
  granted for RD video and input.

## Configuration

`~/.xpair/client/client.env`:

```
REMOTE_HOST=gh-mac-m1
```

`~/.xpair/host/notify.conf` (optional):

```
ENABLED_TYPES=approval,error
```

## Commands

- `Xpair: Connect to Host`
- `Xpair: Refresh Remote Desktop`
- `Xpair: Install AI Extensions`

## License

MIT
