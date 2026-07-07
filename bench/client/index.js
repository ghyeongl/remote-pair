#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { buildRunRecord, buildSample, validateRunRecord } = require("./stats");

function envNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric, got ${value}`);
  return parsed;
}

function defaultOutPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(__dirname, "..", "out", `baseline-${stamp}.json`);
}

function readConfig() {
  const token = process.env.TOKEN;
  if (!token) throw new Error("TOKEN is required");

  return {
    port: envNumber("PORT", 8890),
    proxyPort: envNumber("PROXY_PORT", 8891),
    useProxy: process.env.USE_PROXY === "1",
    duration: envNumber("DURATION", 60),
    fps: envNumber("FPS", 30),
    bitrate: envNumber("BITRATE", 4000000),
    scale: envNumber("SCALE", 1),
    content: process.env.CONTENT || "motion",
    seed: process.env.SEED || "",
    profile: process.env.PROFILE || "",
    proxyStats: process.env.PROXY_STATS || "",
    token,
    out: process.env.OUT ? path.resolve(process.env.OUT) : defaultOutPath(),
  };
}

async function collectRawSamplesInBrowser({ port, token, duration, useProxy, proxyPort }) {
  // Use system Google Chrome (channel:'chrome'), NOT Playwright's bundled
  // open-source Chromium — the latter lacks the proprietary H.264 decoder, so
  // framesDecoded would stay 0 and the baseline would be meaningless. Override
  // with BROWSER_CHANNEL='' to force bundled Chromium (e.g. for VP8 tests).
  const channel = process.env.BROWSER_CHANNEL === undefined ? "chrome" : process.env.BROWSER_CHANNEL;
  const launchOpts = { headless: true };
  if (channel) launchOpts.channel = channel;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();

  try {
    return await page.evaluate(
      async ({ port, token, duration, useProxy, proxyPort }) => {
        const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
        const video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        document.body.appendChild(video);

        const pc = new RTCPeerConnection({ iceServers: [] });
        const ws = new WebSocket(url);
        const queuedCandidates = [];
        // Local ICE candidates can trickle out during setLocalDescription(answer),
        // i.e. BEFORE we send the answer below. If sent first they reach the host
        // before it has our remote description and get silently discarded (the host
        // ignores add_ice_candidate errors), which on a forced-relay run can drop the
        // only rewritten relay candidate and produce a zero-traffic flake. Buffer them
        // until the answer is on the wire, then flush.
        let answerSent = false;
        const pendingLocalCandidates = [];
        const samples = [];
        const shouldUseProxy = Boolean(useProxy);
        const relayPort = proxyPort;

        function rewriteCandidateLine(candidate) {
          if (!shouldUseProxy || typeof candidate !== "string") return candidate;
          const parts = candidate.trim().split(/\s+/);
          const typIndex = parts.indexOf("typ");
          if (parts.length < 8 || typIndex < 0 || typIndex + 1 >= parts.length) return null;
          const protocol = parts[2] ? parts[2].toLowerCase() : "";
          const candidateType = parts[typIndex + 1];
          if (protocol !== "udp" || candidateType !== "host") return null;
          parts[4] = "127.0.0.1";
          parts[5] = String(relayPort);
          return parts.join(" ");
        }

        function rewriteSdpCandidates(sdp) {
          if (!shouldUseProxy || typeof sdp !== "string") return sdp;
          const lines = sdp.split(/\r\n|\n/);
          const rewritten = [];
          for (const line of lines) {
            if (!line.startsWith("a=candidate:")) {
              rewritten.push(line);
              continue;
            }
            const candidate = rewriteCandidateLine(line.slice(2));
            if (candidate) rewritten.push(`a=${candidate}`);
          }
          return rewritten.join("\r\n");
        }

        pc.addTransceiver("video", { direction: "recvonly" });

        pc.ontrack = (event) => {
          video.srcObject = event.streams && event.streams[0]
            ? event.streams[0]
            : new MediaStream([event.track]);
          video.play().catch(() => {});
        };

        pc.onicecandidate = (event) => {
          if (event.candidate && ws.readyState === WebSocket.OPEN) {
            // Host expects flat top-level fields (serve_webrtc.rs reads
            // v["candidate"].as_str(), v["sdpMid"], v["sdpMLineIndex"]).
            const c = event.candidate.toJSON();
            const candidate = rewriteCandidateLine(c.candidate);
            if (!candidate) return;
            const payload = {
              type: "candidate",
              candidate,
              sdpMid: c.sdpMid,
              sdpMLineIndex: c.sdpMLineIndex,
            };
            if (!answerSent) {
              pendingLocalCandidates.push(payload);
              return;
            }
            ws.send(JSON.stringify(payload));
          }
        };

        function isVideoStat(stat) {
          return stat.kind === "video" || stat.mediaType === "video";
        }

        function plainStat(stat) {
          const copy = {};
          for (const key in stat) copy[key] = stat[key];
          return copy;
        }

        async function sampleStats() {
          const report = await pc.getStats();
          let inbound = null;
          let remoteInbound = null;

          report.forEach((stat) => {
            if (stat.type === "inbound-rtp" && isVideoStat(stat) && !stat.isRemote) {
              if (!inbound || (stat.framesDecoded || 0) >= (inbound.framesDecoded || 0)) {
                inbound = plainStat(stat);
              }
            }
            if (stat.type === "remote-inbound-rtp" && isVideoStat(stat)) {
              remoteInbound = plainStat(stat);
            }
          });

          samples.push({
            nowMs: Date.now(),
            inbound,
            remoteInbound,
          });
        }

        async function addRemoteCandidate(message) {
          // Host sends flat fields: {candidate:<str>, sdpMid, sdpMLineIndex}.
          if (!message || typeof message.candidate !== "string") return;
          const candidate = rewriteCandidateLine(message.candidate);
          if (!candidate) return;
          const init = {
            candidate,
            sdpMid: message.sdpMid != null ? message.sdpMid : undefined,
            sdpMLineIndex: message.sdpMLineIndex != null ? message.sdpMLineIndex : undefined,
          };
          if (!pc.remoteDescription) {
            queuedCandidates.push(init);
            return;
          }
          await pc.addIceCandidate(init);
        }

        async function flushQueuedCandidates() {
          while (queuedCandidates.length > 0) {
            await pc.addIceCandidate(queuedCandidates.shift());
          }
        }

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timed out waiting for WebSocket open")), 10000);
          ws.onopen = () => {
            clearTimeout(timeout);
            resolve();
          };
          ws.onerror = () => reject(new Error("WebSocket error before open"));
        });

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timed out waiting for host offer")), 15000);

          ws.onmessage = async (event) => {
            try {
              const message = JSON.parse(event.data);
              if (message.type === "offer") {
                await pc.setRemoteDescription({ type: "offer", sdp: rewriteSdpCandidates(message.sdp) });
                await flushQueuedCandidates();
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ type: "answer", sdp: rewriteSdpCandidates(pc.localDescription.sdp) }));
                answerSent = true;
                for (const payload of pendingLocalCandidates.splice(0)) {
                  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
                }
                clearTimeout(timeout);
                resolve();
                return;
              }
              if (message.type === "candidate") {
                await addRemoteCandidate(message);
              }
            } catch (error) {
              clearTimeout(timeout);
              reject(error);
            }
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error while waiting for offer"));
          };
        });

        await new Promise((resolve, reject) => {
          ws.onmessage = async (event) => {
            try {
              const message = JSON.parse(event.data);
              if (message.type === "candidate") {
                await addRemoteCandidate(message);
              }
            } catch (error) {
              reject(error);
            }
          };

          const interval = setInterval(() => {
            sampleStats().catch(reject);
          }, 1000);

          setTimeout(async () => {
            clearInterval(interval);
            try {
              await sampleStats();
              ws.close();
              pc.close();
              resolve();
            } catch (error) {
              reject(error);
            }
          }, duration * 1000);
        });

        return samples;
      },
      { port, token, duration, useProxy, proxyPort },
    );
  } finally {
    await browser.close();
  }
}

async function main() {
  const config = readConfig();
  const startedAt = new Date().toISOString();
  const rawSamples = await collectRawSamplesInBrowser(config);
  const startedAtMs = Date.parse(startedAt);

  let previous = null;
  const samples = rawSamples.map((raw) => {
    const sample = buildSample(raw, previous, startedAtMs);
    previous = sample;
    return sample;
  });

  const endedAt = new Date().toISOString();
  const record = buildRunRecord(
    {
      fps: config.fps,
      bitrate: config.bitrate,
      scale: config.scale,
      content: config.content,
      duration: config.duration,
      seed: config.seed,
      port: config.port,
      useProxy: config.useProxy,
      proxyPort: config.proxyPort,
      profile: config.profile,
      proxyStats: config.proxyStats,
    },
    startedAt,
    endedAt,
    samples,
  );

  validateRunRecord(record);
  fs.mkdirSync(path.dirname(config.out), { recursive: true });
  fs.writeFileSync(config.out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(config.out);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
