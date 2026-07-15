#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { aggregateScoreRecords } = require("./baseline-aggregate");
const { computeRecovery, RECOVER_SPEED_OFFSET_MS } = require("./recovery");
const { HARD_GATE_SCORE, WEIGHTS, norm, rateFromCounter, scoreRun } = require("./score");

function client(overrides = {}) {
  return {
    config: { fps: 30, profile: "loss" },
    samples: [
      { timestamp: "2026-01-01T00:00:00.000Z", elapsedMs: 0, decodedFramesPerSecond: 30, pliCount: 0 },
      { timestamp: "2026-01-01T00:00:01.000Z", elapsedMs: 1000, decodedFramesPerSecond: 30, pliCount: 2 },
      { timestamp: "2026-01-01T00:00:02.000Z", elapsedMs: 2000, decodedFramesPerSecond: 30, pliCount: 4 },
    ],
    summary: {
      durationMs: 2000,
      freezeRatio: 0.2,
      decodedFps: 24,
      packetsLost: 0,
    },
    ...overrides,
  };
}

function proxy(overrides = {}) {
  return {
    config: { profile: "loss" },
    bursts: [],
    directions: {
      hostToClient: {
        classes: {
          RTP: { total: 100, forwarded: 90, dropped: 10 },
        },
      },
    },
    ...overrides,
  };
}

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

function testNormUsesBaselineStddev() {
  const result = norm("pliRate", 3, { metrics: { pliRate: { mean: 100, stddev: 2 } } });
  close(result.value, 1.5);
  assert.equal(result.scale, 2);
  assert.equal(result.source, "baseline-stddev");
}

function testCompositeMathAndMissing() {
  const record = scoreRun(client(), proxy(), {
    metrics: {
      recoverySpeed: { mean: 0, stddev: 0.001 },
      pliRate: { mean: 0, stddev: 2 },
    },
  });

  const expectedFreeze = WEIGHTS.freeze * 0.8;
  const expectedPli = -WEIGHTS.pli * 1;
  close(record.terms.freeze, expectedFreeze);
  close(record.terms.pli, expectedPli);
  close(record.score, expectedFreeze + expectedPli);
  assert.deepEqual(record.missing, ["cpuSlope", "qp", "e2eP95"]);
  assert.equal(record.inputs.hostToClientRtpDropped, 10);
  assert.equal(record.inputs.injectedLossRate, 0.1);
}

function testRateFromCounterExport() {
  assert.equal(rateFromCounter(client(), "pliCount"), 2);
}

function testBaselineAggregateExcludesGateFailures() {
  const records = [
    { path: "score-good-a.json", score: 1, gates: { passed: true }, inputs: { decodedFps: 30 } },
    { path: "score-gate-failed.json", score: HARD_GATE_SCORE, gates: { passed: false }, inputs: { decodedFps: 0 } },
    { path: "score-good-b.json", score: 3, gates: { passed: true }, inputs: { decodedFps: 30 } },
  ];
  const aggregate = aggregateScoreRecords(records);
  assert.equal(aggregate.runCount, 3);
  assert.equal(aggregate.excludedRuns, 1);
  assert.equal(aggregate.score.count, 2);
  assert.equal(aggregate.score.mean, 2);
  close(aggregate.score.stddev, Math.sqrt(2));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xpair-baseline-score-"));
  try {
    const files = records.map((record, index) => {
      const file = path.join(tmp, `score-${index}.json`);
      fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
      return file;
    });
    const out = path.join(tmp, "aggregate.json");
    const result = spawnSync(process.execPath, [path.join(__dirname, "baseline-aggregate.js"), out, ...files], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout.trim(), "2");
    assert.match(result.stderr, /excludedRuns=1/);
    const written = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(written.score.mean, 2);
    assert.deepEqual(written.score.values, [1, 3]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testCoverageHardGate() {
  const record = scoreRun(client({ summary: { durationMs: 2000, freezeRatio: 0, decodedFps: 10, packetsLost: 0 } }), proxy());
  assert.equal(record.gates.coverage, false);
  assert.equal(record.gates.passed, false);
  assert.equal(record.score, HARD_GATE_SCORE);
}

function testFreezeTelemetryHardGate() {
  // decodedFps=30 keeps the coverage gate green so freezeTelemetry is the only fail.
  const record = scoreRun(client({ summary: { durationMs: 2000, decodedFps: 30, packetsLost: 0 } }), proxy());
  assert.equal(record.gates.freezeTelemetry, false);
  assert.equal(record.gates.passed, false);
  assert.equal(record.score, HARD_GATE_SCORE);
  assert.ok(record.missing.includes("freezeRatio"));
}

function testSsimHardGate() {
  const record = scoreRun(client(), proxy(), null, { ssim: 0.9 });
  assert.equal(record.gates.ssim, false);
  assert.equal(record.gates.passed, false);
  assert.equal(record.score, HARD_GATE_SCORE);
}

function testAxisAGatePassthrough() {
  const record = scoreRun(
    client({ config: { fps: 30, profile: "passthrough" } }),
    proxy({
      config: { profile: "passthrough" },
      directions: { hostToClient: { classes: { RTP: { total: 100, forwarded: 99, dropped: 1 } } } },
    }),
  );
  assert.equal(record.gates.axisA, "failed");
  assert.equal(record.score, HARD_GATE_SCORE);
}

function testAxisATimeBasedSuspected() {
  const record = scoreRun(
    client({
      config: { fps: 30, profile: "passthrough" },
      summary: { durationMs: 2000, freezeRatio: 0, decodedFps: 30, packetsLost: 0, cpuSlope: 0.1 },
    }),
    proxy({
      config: { profile: "passthrough" },
      directions: { hostToClient: { classes: { RTP: { total: 100, forwarded: 100, dropped: 0 } } } },
    }),
  );
  assert.equal(record.gates.axisA, "time-based-suspected");
  assert.equal(record.score, HARD_GATE_SCORE);
}

function testRecoveryComputation() {
  const record = {
    config: { fps: 30 },
    samples: [
      { timestamp: "2026-01-01T00:00:00.000Z", decodedFramesPerSecond: 30 },
      { timestamp: "2026-01-01T00:00:01.000Z", decodedFramesPerSecond: 30 },
      { timestamp: "2026-01-01T00:00:02.000Z", decodedFramesPerSecond: 2 },
      { timestamp: "2026-01-01T00:00:03.000Z", decodedFramesPerSecond: 10 },
      { timestamp: "2026-01-01T00:00:04.000Z", decodedFramesPerSecond: 24 },
    ],
  };
  const result = computeRecovery(record, [{
    startAt: "2026-01-01T00:00:01.500Z",
    endAt: "2026-01-01T00:00:02.500Z",
  }]);
  assert.equal(result.burstCount, 1);
  assert.equal(result.recoveredCount, 1);
  assert.equal(result.meanRecoverMs, 1500);
  // recoverySpeed = 1/(meanRecoverMs + offset) so instant recovery beats no-recovery.
  close(result.recoverySpeed, 1 / (1500 + RECOVER_SPEED_OFFSET_MS));
}

const tests = [
  testNormUsesBaselineStddev,
  testCompositeMathAndMissing,
  testRateFromCounterExport,
  testBaselineAggregateExcludesGateFailures,
  testCoverageHardGate,
  testFreezeTelemetryHardGate,
  testSsimHardGate,
  testAxisAGatePassthrough,
  testAxisATimeBasedSuspected,
  testRecoveryComputation,
];

for (const test of tests) test();
console.log(`score-check ok (${tests.length} tests)`);
