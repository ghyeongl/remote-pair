#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  REQUIRED_SAMPLE_KEYS,
  buildRunRecord,
  buildSample,
  validateRunRecord,
} = require("./stats");
const { aggregateRecords } = require("./variance");

const startedAtMs = Date.parse("2026-06-28T00:00:00.000Z");
const negotiating = buildSample(
  {
    nowMs: startedAtMs,
    inbound: null,
    remoteInbound: null,
  },
  null,
  startedAtMs,
);

const first = buildSample(
  {
    nowMs: startedAtMs + 1000,
    inbound: {
      framesDecoded: 30,
      framesDropped: 0,
      framesPerSecond: 30,
      totalFreezesDuration: 0,
      freezeCount: 0,
      totalPausesDuration: 0,
      pauseCount: 0,
      jitter: 0.002,
      bytesReceived: 500000,
      packetsLost: 0,
      frameWidth: 1920,
      frameHeight: 1080,
      keyFramesDecoded: 1,
    },
    remoteInbound: {
      fractionLost: 0,
    },
  },
  null,
  startedAtMs,
);

const second = buildSample(
  {
    nowMs: startedAtMs + 2000,
    inbound: {
      framesDecoded: 60,
      framesDropped: 1,
      totalFreezesDuration: 0,
      freezeCount: 0,
      totalPausesDuration: 0,
      pauseCount: 0,
      jitter: 0.003,
      bytesReceived: 1000000,
      packetsLost: 2,
      frameWidth: 1920,
      frameHeight: 1080,
      keyFramesDecoded: 2,
    },
    remoteInbound: {
      fractionLost: 0.01,
    },
  },
  first,
  startedAtMs,
);

const record = buildRunRecord(
  {
    fps: 30,
    bitrate: 4000000,
    scale: 1,
    content: "motion",
    duration: 2,
    seed: "parse-check",
    port: 8890,
    useProxy: false,
    proxyPort: 8891,
    profile: "",
    proxyStats: "",
  },
  new Date(startedAtMs).toISOString(),
  new Date(startedAtMs + 2000).toISOString(),
  [negotiating, first, second],
);

validateRunRecord(record);

for (const key of REQUIRED_SAMPLE_KEYS) {
  assert.ok(Object.prototype.hasOwnProperty.call(record.samples[0], key), `sample missing ${key}`);
}

assert.equal(record.run.content, "motion");
assert.equal(record.run.fps, 30);
assert.equal(record.run.bitrate, 4000000);
assert.equal(record.run.scale, 1);
assert.equal(record.run.duration, 2);
assert.equal(record.run.seed, "parse-check");
assert.equal(record.run.port, 8890);
assert.equal(record.samples[2].bitrateKbps, 4000);
assert.equal(record.samples[2].rawFramesPerSecond, null);
assert.equal(record.samples[2].framesPerSecond, 30);
assert.equal(record.samples[2].decodedFramesPerSecond, 30);
assert.equal(record.summary.sampleCount, 3);
assert.equal(record.summary.framesDecoded, 60);
assert.equal(record.summary.decodedFramesPerSecond, 30);
assert.equal(record.summary.decodedFps, 30);
assert.equal(record.summary.packetsLost, 2);
assert.equal(record.summary.fractionLost, 0.01);

const aggregate = aggregateRecords(
  [
    {
      summary: {
        framesDecoded: 60,
        decodedFps: 30,
        bytesReceived: 1000,
        averageBitrateKbps: 100,
        freezeCount: 0,
        totalFreezesDuration: 0,
        packetsLost: 1,
      },
      samples: [{ jitter: 0.002 }],
    },
    {
      summary: {
        framesDecoded: 90,
        decodedFps: 45,
        bytesReceived: 2000,
        averageBitrateKbps: 200,
        freezeCount: 2,
        totalFreezesDuration: 1,
        packetsLost: 3,
      },
      samples: [{ jitter: 0.004 }],
    },
  ],
  "motion",
);

assert.equal(aggregate.metrics.framesDecoded.mean, 75);
assert.equal(Number(aggregate.metrics.framesDecoded.stddev.toFixed(6)), 21.213203);
assert.equal(aggregate.metrics.jitter.mean, 0.003);
assert.equal(Number(aggregate.metrics.jitter.stddev.toFixed(6)), 0.001414);

console.log("parse-check ok");
