# shared/screen-protocol — Screen Protocol Single Source of Truth (SoT)

Declares the **Host↔IDE wire contract** for Xpair Remote Desktop in one place.
The implementation is split across two locations (rs = host engine, ide = client webview), and this SoT
fixes the constants and formats the two must agree on. Drift is caught by `check-screen-protocol.sh`.

## Data Flow
```
[host/rd/ host]                          [client/ide/ client (webview)]
screen serve  ──JPEG──▶   remote-desktop.js
  ws 127.0.0.1:8889        (binary)   WS→Blob(jpeg)→createImageBitmap→canvas
        ▲ ssh -L 8889 tunnel
serve-webrtc :8890 (v2)   ──H.264──▶  v2 peer connection (WebRTC)
```

Remote Desktop supports authenticated input. The IDE captures pointer, wheel,
keyboard, and composed text only inside the RD webview, then forwards it over
the active WebRTC session. Input is gated by the host helper readiness signal:
`rp-ctl` carries reliable ordered control input and `rp-move` carries lossy
pointer motion.

For v2 WebRTC signaling, new clients send this first WebSocket message before
SDP/ICE:

```json
{"type":"hello","proto":1,"caps":{"negotiatedInput":true}}
```

New hosts reply with `{"type":"hello-ack","negotiatedInput":true}` before the
offer and both peers create negotiated input DataChannels with fixed stream IDs:
`rp-ctl` is `0`, `rp-move` is `1`. If the hello is absent, times out, or is not
recognized, the session remains in legacy in-band DataChannel mode for version
skew compatibility.

## Contract (`constants.json`)
| Area | Value |
|------|-----|
| v1a frame | `ws://127.0.0.1:8889`, binary whole-frame JPEG, `ssh -L` tunnel |
| v2 WebRTC | signaling `127.0.0.1:8890`, H.264/WebRTC |
| v0 fallback | ssh screenshot polling, switches in auto after ~4s with no frame |
| Capture parameters | fps 1–120 · quality 1–100 · scale 0.1–1.0 |
| Remote input | supported; pointer/wheel/keyboard/text forwarding inside the RD webview |
| WebRTC hello | client `hello` proto 1 with `negotiatedInput`; host `hello-ack` |
| WebRTC DataChannels | negotiated `rp-ctl` id 0 reliable ordered input; negotiated `rp-move` id 1 unreliable pointer motion; legacy in-band fallback |
| webview→ext message | ready·v2Error·v2FirstFrame |

## Consumers
| Consumer | Implementation |
|--------|------|
| `host/rd/screen/src/serve.rs` | v1a WS+JPEG server (port 8889 default) |
| `host/rd/screen/src/serve_webrtc.rs` | v2 WebRTC (signaling 8890) |
| `client/ide/remotepair/ext/extension.js` | tunnel · port constants (SIGNAL) · RD status messages |
| `client/ide/remotepair/ext/media/remote-desktop.js` | webview video rendering · input DataChannels · message vocabulary |

## Usage
```bash
shared/screen-protocol/check-screen-protocol.sh   # verify rs↔ide consistency
```
When changing ports or message vocabulary, fix this file first, then align both consumers.

## Future
Using build-time codegen to **generate and inject** these constants into rs (Rust const) / ext (JS const)
would go beyond declare-and-verify and make this a true single source (covered in G004 IdeSelfContainment).
