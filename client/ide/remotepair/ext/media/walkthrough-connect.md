# Connect to your host

Xpair drives a remote macOS **host** machine. The client (this IDE) talks
to the host over SSH using the `REMOTE_HOST` value in `~/.xpair/client/client.env`.

- **Connect to Host** opens the host filesystem in a new window via *Open Remote - SSH*.
- The **Remote Desktop** opens as a pinned editor tab (**RD**) in the main editor
  area — it streams and drives the host screen over the authenticated RD session.
  Reopen it anytime with **Xpair: Open Remote Desktop** from the Command Palette.

If nothing happens, confirm you can `ssh <REMOTE_HOST>` from a terminal without a
password prompt.
