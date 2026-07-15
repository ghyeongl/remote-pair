"use strict";

const DEFAULT_RECOVER_FRAC = 0.8;
const PRE_BURST_WINDOW_MS = 3000;
// One sample period. Offsets recoverySpeed so an instant recovery (0ms) maps to the
// fastest finite speed (1/SAMPLE) instead of collapsing to the no-recovery value (0).
const RECOVER_SPEED_OFFSET_MS = 1000;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sampleTimeMs(sample) {
  const parsed = Date.parse(sample.timestamp || "");
  if (Number.isFinite(parsed)) return parsed;
  return finiteNumber(sample.elapsedMs);
}

function sampleFps(sample) {
  return finiteNumber(sample.decodedFramesPerSecond)
    ?? finiteNumber(sample.framesPerSecond)
    ?? finiteNumber(sample.rawFramesPerSecond);
}

function burstStartMs(burst) {
  return finiteNumber(burst.startMs) ?? Date.parse(burst.startAt || "");
}

function burstEndMs(burst) {
  return finiteNumber(burst.endMs) ?? Date.parse(burst.endAt || "");
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function preBurstRate(samples, startMs, expectedFps) {
  const rates = samples
    .map((sample) => ({ timeMs: sampleTimeMs(sample), fps: sampleFps(sample) }))
    .filter(({ timeMs, fps }) => (
      finiteNumber(timeMs) !== null &&
      finiteNumber(fps) !== null &&
      timeMs < startMs &&
      timeMs >= startMs - PRE_BURST_WINDOW_MS
    ))
    .map(({ fps }) => fps);
  return average(rates) ?? finiteNumber(expectedFps) ?? 0;
}

function computeRecovery(clientRecord, bursts, options = {}) {
  const samples = Array.isArray(clientRecord && clientRecord.samples) ? clientRecord.samples : [];
  const expectedFps =
    finiteNumber(options.expectedFps) ??
    finiteNumber(clientRecord && clientRecord.config && clientRecord.config.fps) ??
    finiteNumber(clientRecord && clientRecord.run && clientRecord.run.fps);
  const recoverFrac = finiteNumber(options.recoverFrac) ?? DEFAULT_RECOVER_FRAC;
  const recoveries = [];

  for (const burst of Array.isArray(bursts) ? bursts : []) {
    const startMs = burstStartMs(burst);
    const endMs = burstEndMs(burst);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    const beforeFps = preBurstRate(samples, startMs, expectedFps);
    const threshold = beforeFps * recoverFrac;
    let recoveredAtMs = null;

    if (threshold > 0) {
      for (const sample of samples) {
        const timeMs = sampleTimeMs(sample);
        const fps = sampleFps(sample);
        if (finiteNumber(timeMs) === null || finiteNumber(fps) === null) continue;
        if (timeMs >= endMs && fps >= threshold) {
          recoveredAtMs = timeMs;
          break;
        }
      }
    }

    recoveries.push({
      burst,
      preBurstFps: beforeFps,
      thresholdFps: threshold,
      recoveredAtMs,
      recoverMs: recoveredAtMs === null ? null : Math.max(0, recoveredAtMs - endMs),
    });
  }

  const recoveredMs = recoveries
    .map((entry) => finiteNumber(entry.recoverMs))
    .filter((value) => value !== null);
  const allRecovered = recoveries.length > 0 && recoveredMs.length === recoveries.length;
  const meanRecoverMs = allRecovered ? average(recoveredMs) : null;

  return {
    recoverFrac,
    burstCount: recoveries.length,
    recoveredCount: recoveredMs.length,
    allRecovered,
    meanRecoverMs,
    // Reward recovery speed; an instant recovery (meanRecoverMs===0, e.g. a burst
    // ending on a sample already back above threshold) must still beat no recovery
    // (null => 0). The one-sample offset maps 0ms to the fastest finite speed.
    recoverySpeed: meanRecoverMs !== null ? 1 / (meanRecoverMs + RECOVER_SPEED_OFFSET_MS) : 0,
    recoveries,
  };
}

module.exports = {
  DEFAULT_RECOVER_FRAC,
  RECOVER_SPEED_OFFSET_MS,
  computeRecovery,
};
