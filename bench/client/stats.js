"use strict";

const REQUIRED_SAMPLE_KEYS = [
  "timestamp",
  "elapsedMs",
  "framesDecoded",
  "framesDropped",
  "rawFramesPerSecond",
  "framesPerSecond",
  "decodedFramesPerSecond",
  "totalFreezesDuration",
  "freezeCount",
  "totalPausesDuration",
  "pauseCount",
  "jitter",
  "bytesReceived",
  "bitrateKbps",
  "packetsLost",
  "nackCount",
  "pliCount",
  "firCount",
  "framesReceived",
  "totalInterFrameDelay",
  "fractionLost",
  "frameWidth",
  "frameHeight",
  "keyFramesDecoded",
];

const REQUIRED_CONFIG_KEYS = [
  "fps",
  "bitrate",
  "scale",
  "content",
  "duration",
  "seed",
  "port",
];

const REQUIRED_RUN_KEYS = [
  "config",
  "run",
  "startedAt",
  "endedAt",
  "samples",
  "summary",
];

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildSample(stats, previous, startedAtMs) {
  const inbound = stats.inbound || {};
  const remoteInbound = stats.remoteInbound || {};
  const nowMs = stats.nowMs;
  const bytesReceived = numberOrNull(inbound.bytesReceived);
  const rawFramesPerSecond = numberOrNull(inbound.framesPerSecond);

  let bitrateKbps = null;
  let decodedFramesPerSecond = null;
  if (
    previous &&
    typeof previous.bytesReceived === "number" &&
    typeof bytesReceived === "number" &&
    typeof previous._nowMs === "number" &&
    nowMs > previous._nowMs
  ) {
    bitrateKbps = ((bytesReceived - previous.bytesReceived) * 8) / (nowMs - previous._nowMs);
  }
  if (
    previous &&
    typeof previous.framesDecoded === "number" &&
    typeof inbound.framesDecoded === "number" &&
    typeof previous._nowMs === "number" &&
    nowMs > previous._nowMs
  ) {
    decodedFramesPerSecond = ((inbound.framesDecoded - previous.framesDecoded) * 1000) / (nowMs - previous._nowMs);
  }

  return {
    timestamp: new Date(nowMs).toISOString(),
    elapsedMs: nowMs - startedAtMs,
    framesDecoded: numberOrNull(inbound.framesDecoded),
    framesDropped: numberOrNull(inbound.framesDropped),
    rawFramesPerSecond,
    framesPerSecond: rawFramesPerSecond ?? decodedFramesPerSecond,
    decodedFramesPerSecond,
    totalFreezesDuration: numberOrNull(inbound.totalFreezesDuration),
    freezeCount: numberOrNull(inbound.freezeCount),
    totalPausesDuration: numberOrNull(inbound.totalPausesDuration),
    pauseCount: numberOrNull(inbound.pauseCount),
    jitter: numberOrNull(inbound.jitter),
    bytesReceived,
    bitrateKbps,
    packetsLost: numberOrNull(inbound.packetsLost ?? remoteInbound.packetsLost),
    nackCount: numberOrNull(inbound.nackCount),
    pliCount: numberOrNull(inbound.pliCount),
    firCount: numberOrNull(inbound.firCount),
    framesReceived: numberOrNull(inbound.framesReceived),
    totalInterFrameDelay: numberOrNull(inbound.totalInterFrameDelay),
    fractionLost: numberOrNull(remoteInbound.fractionLost ?? inbound.fractionLost),
    frameWidth: numberOrNull(inbound.frameWidth),
    frameHeight: numberOrNull(inbound.frameHeight),
    keyFramesDecoded: numberOrNull(inbound.keyFramesDecoded),
    _nowMs: nowMs,
  };
}

function publicSample(sample) {
  const cleaned = {};
  for (const key of REQUIRED_SAMPLE_KEYS) cleaned[key] = sample[key];
  return cleaned;
}

function latestNumber(samples, key) {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (typeof samples[i][key] === "number") return samples[i][key];
  }
  return null;
}

function firstSampleWithNumber(samples, key) {
  for (const sample of samples) {
    if (typeof sample[key] === "number") return sample;
  }
  return null;
}

function lastSampleWithNumber(samples, key) {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (typeof samples[i][key] === "number") return samples[i];
  }
  return null;
}

function summarizeSamples(samples) {
  const first = samples[0] || {};
  const last = samples[samples.length - 1] || {};
  const durationMs =
    typeof first.elapsedMs === "number" && typeof last.elapsedMs === "number"
      ? Math.max(0, last.elapsedMs - first.elapsedMs)
      : null;

  const freezeDuration = latestNumber(samples, "totalFreezesDuration");
  const pauseDuration = latestNumber(samples, "totalPausesDuration");
  const firstDecodedSample = firstSampleWithNumber(samples, "framesDecoded") || {};
  const lastDecodedSample = lastSampleWithNumber(samples, "framesDecoded") || {};
  const firstFramesDecoded = firstDecodedSample.framesDecoded;
  const lastFramesDecoded = lastDecodedSample.framesDecoded;
  const decodedDurationMs =
    typeof firstDecodedSample.elapsedMs === "number" && typeof lastDecodedSample.elapsedMs === "number"
      ? Math.max(0, lastDecodedSample.elapsedMs - firstDecodedSample.elapsedMs)
      : null;
  const decodedFps =
    typeof firstFramesDecoded === "number" &&
    typeof lastFramesDecoded === "number" &&
    typeof decodedDurationMs === "number" &&
    decodedDurationMs > 0
      ? ((lastFramesDecoded - firstFramesDecoded) * 1000) / decodedDurationMs
      : null;

  return {
    sampleCount: samples.length,
    firstTimestamp: first.timestamp || null,
    lastTimestamp: last.timestamp || null,
    durationMs,
    framesDecoded: latestNumber(samples, "framesDecoded"),
    framesDropped: latestNumber(samples, "framesDropped"),
    bytesReceived: latestNumber(samples, "bytesReceived"),
    packetsLost: latestNumber(samples, "packetsLost"),
    nackCount: latestNumber(samples, "nackCount"),
    pliCount: latestNumber(samples, "pliCount"),
    firCount: latestNumber(samples, "firCount"),
    framesReceived: latestNumber(samples, "framesReceived"),
    totalInterFrameDelay: latestNumber(samples, "totalInterFrameDelay"),
    fractionLost: latestNumber(samples, "fractionLost"),
    freezeCount: latestNumber(samples, "freezeCount"),
    totalFreezesDuration: freezeDuration,
    pauseCount: latestNumber(samples, "pauseCount"),
    totalPausesDuration: pauseDuration,
    freezeRatio:
      typeof freezeDuration === "number" && typeof durationMs === "number" && durationMs > 0
        ? freezeDuration / (durationMs / 1000)
        : null,
    averageBitrateKbps: average(samples, "bitrateKbps"),
    lastRawFramesPerSecond: latestNumber(samples, "rawFramesPerSecond"),
    lastFramesPerSecond: latestNumber(samples, "framesPerSecond"),
    lastDecodedFramesPerSecond: latestNumber(samples, "decodedFramesPerSecond"),
    decodedFramesPerSecond: decodedFps,
    decodedFps,
    frameWidth: latestNumber(samples, "frameWidth"),
    frameHeight: latestNumber(samples, "frameHeight"),
    keyFramesDecoded: latestNumber(samples, "keyFramesDecoded"),
  };
}

function average(samples, key) {
  const values = samples.map((sample) => sample[key]).filter((value) => typeof value === "number");
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildRunRecord(config, startedAt, endedAt, samples) {
  const publicSamples = samples.map(publicSample);
  return {
    config,
    run: { ...config },
    startedAt,
    endedAt,
    samples: publicSamples,
    summary: summarizeSamples(publicSamples),
  };
}

function assertKeys(object, keys, label) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new Error(`${label} is missing required key: ${key}`);
    }
  }
}

function validateRunRecord(record) {
  assertKeys(record, REQUIRED_RUN_KEYS, "run record");
  assertKeys(record.config, REQUIRED_CONFIG_KEYS, "config");
  assertKeys(record.run, REQUIRED_CONFIG_KEYS, "run");
  if (!Array.isArray(record.samples)) throw new Error("samples must be an array");
  for (const [index, sample] of record.samples.entries()) {
    assertKeys(sample, REQUIRED_SAMPLE_KEYS, `samples[${index}]`);
  }
  if (typeof record.summary !== "object" || record.summary === null) {
    throw new Error("summary must be an object");
  }
}

module.exports = {
  REQUIRED_SAMPLE_KEYS,
  REQUIRED_CONFIG_KEYS,
  REQUIRED_RUN_KEYS,
  buildSample,
  buildRunRecord,
  publicSample,
  summarizeSamples,
  validateRunRecord,
};
