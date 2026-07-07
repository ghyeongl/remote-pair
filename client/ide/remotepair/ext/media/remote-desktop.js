// Xpair Remote Desktop webview script (v2 WebRTC only).
// Opens a signaling WebSocket to the host `screen serve-webrtc`, negotiates a
// WebRTC peer connection, and renders the H.264 media (decoded natively) into a
// <video>. Host input is forwarded over the v2 RD DataChannels when available
// (rp-ctl = reliable keys/clicks, rp-move = unreliable pointer moves).
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();

  const stage = document.getElementById("stage");
  const video = document.getElementById("screen-video");
  const overlay = document.getElementById("overlay");
  const overlayMsg = document.getElementById("overlay-msg");
  const badge = document.getElementById("badge");

  const V2_FIRST_FRAME_TIMEOUT_MS = 15000;
  const V2_DISCONNECTED_GRACE_MS = 3000;
  const V2_RECONNECT_BASE_MS = 500;
  const V2_RECONNECT_MAX_MS = 4000;
  const V2_RECONNECT_MAX_ATTEMPTS = 5;
  const V2_STATS_INTERVAL_MS = 5000;
  const V2_STATS_MAX_SAMPLES = 120;

  const FAILURE_MESSAGES = Object.freeze({
    reach: "Remote desktop cannot reach the host. Check that XpairHost.app is running, the host is reachable over SSH, and the tunnel can connect.",
    "key-auth": "SSH key authentication is blocked. Unlock or approve your SSH agent or key passphrase, then retry.",
    "host-key": "The host identity changed. Re-confirm the host fingerprint, remove the stale known_hosts entry if this is your Mac, then retry.",
    "capture-failed": "The host could not start screen capture. Grant Screen Recording permission to XpairHost.app on the host, then retry.",
    "peer-failed": "The WebRTC media connection failed. Check LAN/VPN reachability between the client and host, then retry.",
    "no-first-frame": "The media connection opened, but no decoded video frame arrived. Check Screen Recording permission and network reachability, then retry.",
    superseded: "This remote desktop session was replaced by a newer connection. Use the current RD tab or refresh this one.",
  });

  let haveFrame = false;

  // --- remote input state ---
  let inputArmed = false;
  let inputSeq = 0;
  let ctlDC = null;
  let moveDC = null;
  let inputReady = false;
  let inputError = "";
  let activePointerId = null;
  let activePointerButton = null;
  let activePointerPoint = null;
  const pressedKeys = new Map();
  let lastMoveTs = 0;
  const MOVE_MIN_MS = 1000 / 60;
  const BUFFER_LIMIT = 65536;
  const MAC_VK = {
    KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7,
    KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
    KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
    Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27,
    Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32,
    BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38,
    Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44,
    KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50,
    Backspace: 51, Escape: 53, MetaLeft: 55, ShiftLeft: 56, CapsLock: 57,
    AltLeft: 58, ControlLeft: 59, ShiftRight: 60, AltRight: 61, ControlRight: 62,
    NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumpadDivide: 75,
    NumpadEnter: 76, NumpadSubtract: 78, NumpadEqual: 81, Numpad0: 82,
    Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87,
    Numpad6: 88, Numpad7: 89, Numpad8: 91, Numpad9: 92, F5: 96, F6: 97,
    F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F13: 105, F16: 106,
    F14: 107, F10: 109, F12: 111, F15: 113, Home: 115, PageUp: 116,
    Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
    ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  };

  // Hidden contenteditable element that captures IME/text input (beforeinput /
  // compositionend) so non-ASCII and composed text reach the host as t:"x".
  const textCapture = typeof document.createElement === "function"
    ? document.createElement("div")
    : {
        contentEditable: "",
        style: {},
        textContent: "",
        setAttribute() {},
        addEventListener() {},
        focus() {},
      };
  textCapture.contentEditable = "true";
  textCapture.setAttribute("aria-hidden", "true");
  textCapture.style.position = "absolute";
  textCapture.style.left = "0";
  textCapture.style.top = "0";
  textCapture.style.width = "1px";
  textCapture.style.height = "1px";
  textCapture.style.opacity = "0";
  textCapture.style.pointerEvents = "none";
  textCapture.style.overflow = "hidden";
  if (stage && typeof stage.appendChild === "function") {
    stage.appendChild(textCapture);
  }
  video.tabIndex = 0;

  // v2 (WebRTC) state
  let ws = null; // signaling WebSocket
  let pc2 = null;
  let v2Mode = false;
  let v2FirstFrameReported = false;
  let v2ErrorReported = false;
  let v2FirstFrameTimer = null;
  let v2DisconnectedTimer = null;
  let v2ReconnectTimer = null;
  let v2SignalUrl = null;
  let v2ReconnectAttempt = 0;
  let v2Generation = 0;
  let v2StatsTimer = null;
  let v2StatsSamples = 0;
  let v2LastStats = null;

  // -------------------------------------------------------------------------
  // Overlay helpers
  // -------------------------------------------------------------------------

  function showOverlay(msg) {
    overlayMsg.textContent = msg;
    overlay.classList.remove("hidden");
  }
  function hideOverlay() {
    overlay.classList.add("hidden");
  }

  function normalizeFailureKind(kind) {
    const raw = String(kind || "").toLowerCase().replace(/_/g, "-");
    if (raw === "host-key-mismatch" || raw === "hostkey") return "host-key";
    if (raw === "key-auth-blocked" || raw === "auth" || raw === "publickey") return "key-auth";
    if (raw === "unreachable" || raw === "ssh" || raw === "signaling" || raw === "connection") return "reach";
    if (raw === "capture-error" || raw === "capture") return "capture-failed";
    if (raw === "session-superseded" || raw === "replaced") return "superseded";
    if (Object.prototype.hasOwnProperty.call(FAILURE_MESSAGES, raw)) return raw;
    return "reach";
  }

  function failureOverlayMessage(kind, detail) {
    const normalized = normalizeFailureKind(kind);
    const base = FAILURE_MESSAGES[normalized] || FAILURE_MESSAGES.reach;
    const text = detail ? String(detail).trim() : "";
    if (!text) return base;
    return base + "\n\nDetails: " + text;
  }

  function showFailureOverlay(kind, detail) {
    showOverlay(failureOverlayMessage(kind, detail));
  }

  function setBadge() {
    const channelsOpen = ctlDC && ctlDC.readyState === "open" && moveDC && moveDC.readyState === "open";
    const inputOn = channelsOpen && inputReady;
    if (inputOn) {
      badge.textContent = "input on";
      badge.className = "on";
      badge.title = "Remote input ready";
    } else if (inputError) {
      badge.textContent = "input unavailable";
      badge.className = "off";
      badge.title = inputError;
    } else {
      badge.textContent = "input pending";
      badge.className = "off";
      badge.title = "Waiting for remote input helper";
    }
  }

  function clearV2FirstFrameTimer() {
    if (v2FirstFrameTimer && typeof clearTimeout === "function") {
      try { clearTimeout(v2FirstFrameTimer); } catch (_e) {}
    }
    v2FirstFrameTimer = null;
  }

  function clearV2DisconnectedTimer() {
    if (v2DisconnectedTimer && typeof clearTimeout === "function") {
      try { clearTimeout(v2DisconnectedTimer); } catch (_e) {}
    }
    v2DisconnectedTimer = null;
  }

  function clearV2ReconnectTimer() {
    if (v2ReconnectTimer && typeof clearTimeout === "function") {
      try { clearTimeout(v2ReconnectTimer); } catch (_e) {}
    }
    v2ReconnectTimer = null;
  }

  function clearV2StatsTimer() {
    if (v2StatsTimer && typeof clearInterval === "function") {
      try { clearInterval(v2StatsTimer); } catch (_e) {}
    }
    v2StatsTimer = null;
    v2StatsSamples = 0;
    v2LastStats = null;
  }

  function clearV2AttemptTimers() {
    clearV2FirstFrameTimer();
    clearV2DisconnectedTimer();
    clearV2StatsTimer();
  }

  function resetV2AttemptState() {
    clearV2AttemptTimers();
    haveFrame = false;
    v2FirstFrameReported = false;
    v2ErrorReported = false;
  }

  function clearVideo() {
    try { video.srcObject = null; } catch (_e) {}
  }

  function closeWs() {
    if (ws) {
      try { ws.close(); } catch (_e) {}
      ws = null;
    }
  }

  // -------------------------------------------------------------------------
  // Remote input: DataChannel wiring + send helpers
  // -------------------------------------------------------------------------

  function resetInputChannels() {
    ctlDC = null;
    moveDC = null;
    inputReady = false;
    inputError = "";
    activePointerId = null;
    activePointerButton = null;
    activePointerPoint = null;
    pressedKeys.clear();
    inputSeq = 0;
    setBadge();
  }

  function setInputReady(message) {
    inputReady = true;
    inputError = "";
    setBadge();
    if (message && message.helper) {
      console.debug("remote input ready:", message.helper);
    }
  }

  function setInputFailed(reason) {
    inputReady = false;
    inputError = reason || "Remote input helper is unavailable";
    setBadge();
  }

  function wireInputChannel(channel) {
    if (!channel || (channel.label !== "rp-ctl" && channel.label !== "rp-move")) return;
    if (channel.label === "rp-ctl") ctlDC = channel;
    else moveDC = channel;
    if (typeof channel.addEventListener === "function") {
      channel.addEventListener("open", setBadge);
      channel.addEventListener("close", setBadge);
      channel.addEventListener("error", setBadge);
    }
    setBadge();
  }

  function isReleaseInput(input) {
    return !!input && (
      input.t === "u" ||
      input.t === "all-up" ||
      input.t === "reset" ||
      (input.t === "k" && input.action === "up") ||
      input.action === "all-up" ||
      input.action === "reset"
    );
  }

  function sendInput(channel, input, options) {
    const bypassBufferLimit = !!(options && options.bypassBufferLimit);
    if (!inputReady || !channel || channel.readyState !== "open") return false;
    if (!bypassBufferLimit && channel.bufferedAmount > BUFFER_LIMIT) return false;
    input.seq = ++inputSeq;
    try {
      channel.send(JSON.stringify(input));
      return true;
    } catch (_e) {
      return false;
    }
  }

  function sendControlInput(input) {
    return sendInput(ctlDC, input, { bypassBufferLimit: isReleaseInput(input) });
  }

  function sendMoveInput(input) {
    return sendInput(moveDC, input);
  }

  function armInput() {
    inputArmed = true;
    try { textCapture.focus({ preventScroll: true }); } catch (_e) { textCapture.focus(); }
  }

  function relativePoint(ev) {
    const r = video.getBoundingClientRect();
    const rx = r.width ? (ev.clientX - r.left) / r.width : 0;
    const ry = r.height ? (ev.clientY - r.top) / r.height : 0;
    return {
      rx: Math.max(0, Math.min(1, rx)),
      ry: Math.max(0, Math.min(1, ry)),
    };
  }

  function macFlags(ev) {
    let flags = 0;
    if (ev.metaKey) flags |= 0x100000;
    if (ev.shiftKey) flags |= 0x020000;
    if (ev.ctrlKey) flags |= 0x040000;
    if (ev.altKey) flags |= 0x080000;
    return flags;
  }

  function shouldHandleKeyboard(_ev) {
    if (!inputArmed) return false;
    const active = document.activeElement;
    return active === textCapture || active === video || active === document.body;
  }

  function clearCapturedText() {
    textCapture.textContent = "";
  }

  function pointerButton(ev) {
    if (ev.button === 0) return "l";
    if (ev.button === 2) return "r";
    return null;
  }

  function releaseActivePointer() {
    if (activePointerButton && activePointerPoint) {
      sendControlInput({
        t: "u",
        rx: activePointerPoint.rx,
        ry: activePointerPoint.ry,
        btn: activePointerButton,
      });
    }
    activePointerId = null;
    activePointerButton = null;
    activePointerPoint = null;
  }

  function sendKeyEvent(ev, action) {
    const code = MAC_VK[ev.code];
    if (code === undefined) return false;
    return sendControlInput({
      t: "k",
      action,
      code,
      flags: macFlags(ev),
      repeat: !!ev.repeat,
    });
  }

  function releasePressedKeys() {
    for (const entry of pressedKeys.values()) {
      sendControlInput({ t: "k", action: "up", code: entry.code, flags: 0 });
    }
    pressedKeys.clear();
  }

  // -------------------------------------------------------------------------
  // v2 WebRTC stream (UDP/RTP H.264). Signaling over a WS to the sidecar's
  // serve-webrtc; media is decoded natively by the browser/Chromium WebRTC
  // stack into a <video> (cross-platform — no manual decode).
  // -------------------------------------------------------------------------

  function closePc2() {
    releaseActivePointer();
    releasePressedKeys();
    if (pc2) {
      try { pc2.close(); } catch (_e) {}
      pc2 = null;
    }
    resetInputChannels();
  }

  function cancelV2(showConnecting) {
    v2Generation += 1;
    v2Mode = false;
    v2SignalUrl = null;
    v2ReconnectAttempt = 0;
    clearV2ReconnectTimer();
    resetV2AttemptState();
    closeWs();
    closePc2();
    clearVideo();
    if (showConnecting) showOverlay("Connecting to host…");
  }

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function collectVideoStats(report) {
    let inbound = null;
    if (report && typeof report.forEach === "function") {
      report.forEach(function (stat) {
        if (!stat || stat.type !== "inbound-rtp") return;
        if (stat.kind === "video" || stat.mediaType === "video") inbound = stat;
      });
    }
    if (!inbound) return null;
    const now = numberOrNull(inbound.timestamp);
    const bytes = numberOrNull(inbound.bytesReceived);
    let bitrateKbps = 0;
    if (v2LastStats && now !== null && bytes !== null && now > v2LastStats.timestamp) {
      bitrateKbps = Math.max(0, Math.round(((bytes - v2LastStats.bytesReceived) * 8) / (now - v2LastStats.timestamp)));
    }
    if (now !== null && bytes !== null) {
      v2LastStats = { timestamp: now, bytesReceived: bytes };
    }
    const jitter = numberOrNull(inbound.jitter);
    return {
      decoded: numberOrNull(inbound.framesDecoded),
      dropped: numberOrNull(inbound.framesDropped),
      fps: numberOrNull(inbound.framesPerSecond),
      jitterMs: jitter === null ? null : Math.round(jitter * 1000),
      bitrateKbps,
    };
  }

  function startStatsSampler(pc, isCurrent) {
    clearV2StatsTimer();
    if (!pc || typeof pc.getStats !== "function" || typeof setInterval !== "function") return;
    v2StatsTimer = setInterval(async function () {
      if (!isCurrent()) {
        clearV2StatsTimer();
        return;
      }
      if (v2StatsSamples >= V2_STATS_MAX_SAMPLES) {
        clearV2StatsTimer();
        return;
      }
      v2StatsSamples += 1;
      try {
        const stats = collectVideoStats(await pc.getStats());
        if (stats) vscode.postMessage({ type: "v2Stats", ...stats });
      } catch (_e) {
        clearV2StatsTimer();
      }
    }, V2_STATS_INTERVAL_MS);
  }

  // The signaling URL carries the RD session token (?token=…). Never let it reach a
  // log/diagnostic/overlay string — redact the token query param before surfacing.
  function redactToken(url) {
    return String(url == null ? "" : url).replace(/([?&]token=)[^&\s]*/gi, "$1<redacted>");
  }

  function connectV2(signalUrl, reconnectAttempt) {
    const generation = ++v2Generation;
    clearV2ReconnectTimer();
    closeWs();
    closePc2();
    clearVideo();
    resetV2AttemptState();
    v2Mode = true;
    v2SignalUrl = signalUrl;
    v2ReconnectAttempt = reconnectAttempt || 0;

    video.style.display = "block";
    showOverlay(v2ReconnectAttempt ? "reconnecting (WebRTC)…" : "connecting (WebRTC)…");

    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] }); // host candidates (loopback/LAN/VPN)
    } catch (e) {
      vscode.postMessage({
        type: "v2Error",
        detail: "RTCPeerConnection ctor threw: " + String(e),
        failureKind: "peer-failed",
      });
      cancelV2();
      return;
    }
    pc2 = pc;
    pc.addTransceiver("video", { direction: "recvonly" });

    let sock = null;
    const isCurrent = () => v2Mode && generation === v2Generation && pc2 === pc && ws === sock;
    let negotiatedInputChannelsCreated = false;

    const createNegotiatedInputChannels = () => {
      if (
        negotiatedInputChannelsCreated ||
        !isCurrent() ||
        typeof pc.createDataChannel !== "function"
      ) {
        return;
      }
      negotiatedInputChannelsCreated = true;
      wireInputChannel(pc.createDataChannel("rp-ctl", { negotiated: true, id: 0 }));
      wireInputChannel(pc.createDataChannel("rp-move", { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 }));
    };

    const cancelCurrent = () => {
      if (!isCurrent()) return;
      v2Generation += 1;
      v2Mode = false;
      clearV2AttemptTimers();
      clearV2ReconnectTimer();
      closeWs();
      closePc2();
    };

    const reportCurrentError = (detail, failureKind) => {
      if (!isCurrent() || v2ErrorReported) return;
      v2ErrorReported = true;
      clearV2AttemptTimers();
      vscode.postMessage({ type: "v2Error", detail, failureKind: normalizeFailureKind(failureKind) });
    };

    let reconnectScheduled = false;
    const reconnectCurrent = (reason, failureKind) => {
      if (!isCurrent() || reconnectScheduled) return;
      reconnectScheduled = true;
      clearV2AttemptTimers();
      if (v2ReconnectAttempt >= V2_RECONNECT_MAX_ATTEMPTS || !v2SignalUrl) {
        reportCurrentError(reason + " after reconnect window", failureKind);
        cancelCurrent();
        return;
      }
      const nextAttempt = v2ReconnectAttempt + 1;
      const delay = Math.min(
        V2_RECONNECT_BASE_MS * Math.pow(2, nextAttempt - 1),
        V2_RECONNECT_MAX_MS
      );
      if (typeof setTimeout !== "function") {
        reportCurrentError(reason + " (reconnect timer unavailable)", failureKind);
        cancelCurrent();
        return;
      }
      showOverlay("reconnecting (WebRTC)…");
      v2Generation += 1;
      closeWs();
      closePc2();
      clearVideo();
      v2ReconnectTimer = setTimeout(function () {
        v2ReconnectTimer = null;
        if (!v2Mode || v2SignalUrl !== signalUrl) return;
        connectV2(signalUrl, nextAttempt);
      }, delay);
    };

    const armDisconnectedGrace = (reason, failureKind) => {
      if (!isCurrent() || v2DisconnectedTimer || reconnectScheduled) return;
      if (typeof setTimeout !== "function") {
        reconnectCurrent(reason, failureKind);
        return;
      }
      v2DisconnectedTimer = setTimeout(function () {
        v2DisconnectedTimer = null;
        reconnectCurrent(reason, failureKind);
      }, V2_DISCONNECTED_GRACE_MS);
    };

    const clearPeerRecoveryGrace = () => {
      clearV2DisconnectedTimer();
    };

    const markRecoverySucceeded = () => {
      v2ReconnectAttempt = 0;
    };

    const handlePeerState = (state, reason) => {
      if (!isCurrent()) return;
      if (state === "connected" || state === "completed") {
        clearPeerRecoveryGrace();
        if (haveFrame) markRecoverySucceeded();
        return;
      }
      if (state === "disconnected") {
        armDisconnectedGrace(reason, "peer-failed");
        return;
      }
      if (state === "failed") {
        reconnectCurrent(reason, "peer-failed");
      }
    };

    const markFirstFrame = () => {
      if (!isCurrent() || haveFrame) return;
      haveFrame = true;
      markRecoverySucceeded();
      clearV2FirstFrameTimer();
      hideOverlay();
      if (!v2FirstFrameReported) {
        v2FirstFrameReported = true;
        vscode.postMessage({ type: "v2FirstFrame" });
      }
    };

    const waitForDecodedFrame = () => {
      if (video.readyState >= 2) {
        markFirstFrame();
        return;
      }
      if (typeof video.requestVideoFrameCallback === "function") {
        try {
          video.requestVideoFrameCallback(markFirstFrame);
        } catch (_e) {}
      }
      if (typeof video.addEventListener === "function") {
        video.addEventListener("loadeddata", markFirstFrame, { once: true });
        video.addEventListener("timeupdate", markFirstFrame, { once: true });
        video.addEventListener("playing", markFirstFrame, { once: true });
      }
    };

    // Legacy fallback: old hosts still create in-band rp-ctl/rp-move channels.
    pc.ondatachannel = function (ev) {
      if (!isCurrent()) return;
      wireInputChannel(ev.channel);
    };

    pc.ontrack = function (ev) {
      if (!isCurrent()) return;
      video.srcObject = ev.streams[0];
      waitForDecodedFrame();
    };
    pc.onconnectionstatechange = function () {
      handlePeerState(pc.connectionState, "peer connection " + pc.connectionState);
    };
    pc.oniceconnectionstatechange = function () {
      handlePeerState(pc.iceConnectionState, "ICE connection " + pc.iceConnectionState);
    };

    try {
      sock = new WebSocket(signalUrl);
    } catch (e) {
      reportCurrentError("WebSocket ctor threw: " + String(e), "reach");
      cancelCurrent();
      return;
    }
    ws = sock;
    startStatsSampler(pc, isCurrent);

    if (typeof setTimeout === "function") {
      v2FirstFrameTimer = setTimeout(function () {
        v2FirstFrameTimer = null;
        if (!isCurrent() || haveFrame) return;
        reconnectCurrent("timed out waiting for first WebRTC frame", "no-first-frame");
      }, V2_FIRST_FRAME_TIMEOUT_MS);
    }

    pc.onicecandidate = function (ev) {
      if (isCurrent() && ev.candidate && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: "candidate",
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        }));
      }
    };

    sock.addEventListener("open", function () {
      if (!isCurrent()) return;
      sock.send(JSON.stringify({ type: "hello", proto: 1, caps: { negotiatedInput: true } }));
      showOverlay("v2: signaling connected, negotiating…");
    });
    sock.addEventListener("message", async function (ev) {
      if (!isCurrent()) return;
      let m;
      try { m = JSON.parse(ev.data); } catch (_e) { return; }
      if (m.type === "status") {
        if (m.kind === "input-ready") {
          setInputReady(m);
          return;
        }
        if (m.kind === "input-failed") {
          setInputFailed(m.reason || m.detail || "Remote input helper is unavailable");
          return;
        }
        const kind = normalizeFailureKind(m.kind);
        const parts = [];
        if (m.reason || m.detail) parts.push(String(m.reason || m.detail));
        if (m.captureKind) parts.push("capture kind: " + String(m.captureKind));
        const detail = parts.join("\n");
        showFailureOverlay(kind, detail);
        reportCurrentError(detail || "remote desktop status: " + kind, kind);
        return;
      }
      if (m.type === "hello-ack") {
        if (m.negotiatedInput === true) createNegotiatedInputChannels();
        return;
      }
      if (m.type === "offer") {
        try {
          await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
          if (!isCurrent()) return;
          const ans = await pc.createAnswer();
          if (!isCurrent()) return;
          await pc.setLocalDescription(ans);
          if (!isCurrent()) return;
          ws.send(JSON.stringify({ type: "answer", sdp: ans.sdp }));
        } catch (e) {
          if (!isCurrent()) return;
          reportCurrentError("WebRTC negotiation failed: " + String(e), "peer-failed");
          cancelCurrent();
        }
      } else if (m.type === "candidate") {
        try {
          if (isCurrent()) {
            await pc.addIceCandidate({ candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex });
          }
        } catch (_e) { /* non-fatal */ }
      }
    });
    sock.addEventListener("error", function () {
      if (!isCurrent()) return;
      reconnectCurrent("signaling WebSocket error on " + redactToken(signalUrl), "reach");
    });
    sock.addEventListener("close", function (ev) {
      if (isCurrent() && v2Mode && !ev.wasClean) {
        reconnectCurrent("signaling closed (code=" + ev.code + ")", "reach");
      }
    });
  }

  // -------------------------------------------------------------------------
  // Remote input capture: pointer/wheel/keyboard -> rp-ctl/rp-move
  // -------------------------------------------------------------------------

  if (video && typeof video.addEventListener === "function") {
  video.addEventListener("pointerdown", function (ev) {
    const btn = pointerButton(ev);
    if (!btn) return;
    armInput();
    if (typeof video.setPointerCapture === "function") {
      try { video.setPointerCapture(ev.pointerId); } catch (_e) {}
    }
    const p = relativePoint(ev);
    activePointerId = ev.pointerId;
    activePointerButton = btn;
    activePointerPoint = p;
    if (sendControlInput({ t: "d", rx: p.rx, ry: p.ry, btn, flags: macFlags(ev) })) {
      ev.preventDefault();
    }
  });

  video.addEventListener("pointermove", function (ev) {
    if (!inputArmed) return;
    if (activePointerId !== null && ev.pointerId !== activePointerId) return;
    const now = Date.now();
    if (now - lastMoveTs < MOVE_MIN_MS) return;
    const p = relativePoint(ev);
    activePointerPoint = p;
    const msg = { t: "m", rx: p.rx, ry: p.ry, flags: macFlags(ev) };
    if (activePointerButton) msg.btn = activePointerButton;
    if (sendMoveInput(msg)) {
      lastMoveTs = now;
      ev.preventDefault();
    }
  });

  video.addEventListener("pointerup", function (ev) {
    if (activePointerId !== null && ev.pointerId !== activePointerId) return;
    const p = relativePoint(ev);
    const btn = activePointerButton || pointerButton(ev);
    if (!btn) return;
    activePointerPoint = p;
    if (sendControlInput({ t: "u", rx: p.rx, ry: p.ry, btn, flags: macFlags(ev) })) {
      ev.preventDefault();
    }
    if (typeof video.releasePointerCapture === "function") {
      try { video.releasePointerCapture(ev.pointerId); } catch (_e) {}
    }
    activePointerId = null;
    activePointerButton = null;
    activePointerPoint = null;
  });

  video.addEventListener("pointercancel", function () {
    releaseActivePointer();
  });

  video.addEventListener("wheel", function (ev) {
    armInput();
    if (sendControlInput({ t: "w", dx: ev.deltaX, dy: ev.deltaY, mode: ev.deltaMode, flags: macFlags(ev) })) {
      ev.preventDefault();
    }
  }, { passive: false });

  video.addEventListener("contextmenu", function (ev) {
    ev.preventDefault();
  });

  document.addEventListener("keydown", function (ev) {
    if (!shouldHandleKeyboard(ev)) return;
    if (ev.isComposing || ev.keyCode === 229) return;
    const modified = ev.metaKey || ev.ctrlKey || ev.altKey;
    const printable = ev.key && ev.key.length === 1;
    if (printable && !modified) return;
    const code = MAC_VK[ev.code];
    if (code === undefined) return;
    pressedKeys.set(ev.code, { code });
    if (sendKeyEvent(ev, "down")) {
      ev.preventDefault();
    }
  });

  document.addEventListener("keyup", function (ev) {
    if (!pressedKeys.has(ev.code)) return;
    if (ev.isComposing || ev.keyCode === 229) return;
    const entry = pressedKeys.get(ev.code);
    const code = entry ? entry.code : MAC_VK[ev.code];
    if (code === undefined) return;
    pressedKeys.delete(ev.code);
    if (sendControlInput({ t: "k", action: "up", code, flags: macFlags(ev) })) {
      ev.preventDefault();
    }
  });

  textCapture.addEventListener("compositionend", function (ev) {
    if (ev.data) sendControlInput({ t: "x", s: ev.data });
    clearCapturedText();
  });

  textCapture.addEventListener("beforeinput", function (ev) {
    if (ev.isComposing) return;
    const text = ev.data || textCapture.textContent;
    if (text) sendControlInput({ t: "x", s: text });
    clearCapturedText();
  });

  window.addEventListener("blur", function () {
    releaseActivePointer();
    releasePressedKeys();
  });
  }

  // -------------------------------------------------------------------------
  // Messages from the extension
  // -------------------------------------------------------------------------

  window.addEventListener("message", function (e) {
    const m = e.data;
    if (!m || typeof m !== "object") return;

    if (m.type === "v2Connect") {
      // Extension tells webview to open a WebRTC session (signaling URL).
      connectV2(m.signalUrl);
      return;
    }

    if (m.type === "v2Cancel") {
      cancelV2(true);
      return;
    }

    if (m.type === "status") {
      let msg = "Connecting to host…";
      if (m.state === "no-host") {
        msg = "REMOTE_HOST is not set in ~/.xpair/client/client.env";
      } else if (m.state === "error") {
        msg = failureOverlayMessage(m.failureKind || m.kind || "reach", m.detail || "unknown");
      }
      if (m.state === "error" || m.state === "no-host") cancelV2(false);
      if (m.state === "error") showOverlay(msg);
      else if (m.state === "no-host") showOverlay(msg);
      else if (!haveFrame) showOverlay(msg);
    }
  });

  if (typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", function () { cancelV2(false); });
    window.addEventListener("beforeunload", function () { cancelV2(false); });
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  video.style.display = "block";
  setBadge();
  showOverlay("Connecting to host…");
  vscode.postMessage({ type: "ready" });
})();
