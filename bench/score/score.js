#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { computeRecovery } = require("./recovery");

const WEIGHTS = Object.freeze({
  freeze: 0.5,
  recovery: 0.3,
  pli: 0.08,
  cpuSlope: 0.04,
  qpDelta: 0.04,
  e2eP95Delta: 0.04,
});

const FIXED_SCALES = Object.freeze({
  recoverySpeed: 1 / 1000,
  pliRate: 1,
  cpuSlope: 1,
  qpDelta: 5,
  e2eP95Delta: 50,
});

const EPSILON = Object.freeze({
  recoverySpeed: 1e-6,
  pliRate: 0.05,
  cpuSlope: 0.01,
  qpDelta: 0.5,
  e2eP95Delta: 5,
});

const SSIM_FLOOR = Number(process.env.SSIM_FLOOR || 0.92);
const COVERAGE_FLOOR = Number(process.env.COVERAGE_FLOOR || 0.5);
const LOSS_EPSILON = 0.001;
const HARD_GATE_SCORE = -1000000000;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function latestNumber(samples, key) {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const value = finiteNumber(samples[i][key]);
    if (value !== null) return value;
  }
  return null;
}

function firstNumber(samples, key) {
  for (const sample of samples) {
    const value = finiteNumber(sample[key]);
    if (value !== null) return value;
  }
  return null;
}

function rateFromCounter(client, key) {
  const samples = Array.isArray(client.samples) ? client.samples : [];
  const first = firstNumber(samples, key);
  const last = latestNumber(samples, key);
  const durationMs = finiteNumber(client.summary && client.summary.durationMs);
  if (first === null || last === null || !durationMs || durationMs <= 0) return null;
  return Math.max(0, last - first) / (durationMs / 1000);
}

function metricStats(baselineVariance, metric) {
  if (!baselineVariance || typeof baselineVariance !== "object") return null;
  const metrics = baselineVariance.metrics || baselineVariance.terms || baselineVariance;
  const stat = metrics[metric];
  return stat && typeof stat === "object" ? stat : null;
}

function norm(metric, value, baselineVariance) {
  const numeric = finiteNumber(value);
  if (numeric === null) return { value: 0, scale: null, source: "missing" };

  const stat = metricStats(baselineVariance, metric);
  const stddev = finiteNumber(stat && stat.stddev);
  const mean = finiteNumber(stat && stat.mean);
  if (stddev !== null || mean !== null) {
    const scale = stddev && stddev > 0
      ? stddev
      : Math.max(Math.abs(mean || 0) + EPSILON[metric], EPSILON[metric]);
    return { value: numeric / scale, scale, source: stddev && stddev > 0 ? "baseline-stddev" : "baseline-epsilon" };
  }

  const scale = FIXED_SCALES[metric] || 1;
  return { value: numeric / scale, scale, source: "fixed" };
}

function htcRtp(proxy) {
  return proxy &&
    proxy.directions &&
    proxy.directions.hostToClient &&
    proxy.directions.hostToClient.classes &&
    proxy.directions.hostToClient.classes.RTP
    ? proxy.directions.hostToClient.classes.RTP
    : {};
}

function injectedLoss(proxy) {
  const rtp = htcRtp(proxy);
  const dropped = finiteNumber(rtp.dropped) ?? 0;
  const total = finiteNumber(rtp.total) ?? 0;
  return {
    hostToClientRtpDropped: dropped,
    hostToClientRtpTotal: total,
    injectedLossRate: total > 0 ? dropped / total : 0,
  };
}

function inputValue(client, key) {
  return finiteNumber(client.summary && client.summary[key]) ?? finiteNumber(client[key]);
}

function scoreRun(client, proxy, baselineVariance = null, options = {}) {
  const summary = client.summary || {};
  const expectedFps =
    finiteNumber(options.expectedFps) ??
    finiteNumber(client.config && client.config.fps) ??
    finiteNumber(client.run && client.run.fps) ??
    30;
  const decodedFps = finiteNumber(summary.decodedFps) ?? finiteNumber(summary.decodedFramesPerSecond) ?? 0;
  // freezeRatio is the PRIMARY freeze metric and a positively-weighted scoring term
  // (freeze: WEIGHTS.freeze * (1 - freezeRatio)). When it is absent/null (e.g. a
  // browser/build where summarizeSamples couldn't compute it), coercing to 0 would
  // award the FULL freeze term to a run that never measured freezes. Track it as
  // missing and hard-gate the run as invalid instead of crediting it.
  const freezeRatioRaw = finiteNumber(summary.freezeRatio);
  const freezeRatio = Math.max(0, Math.min(1, freezeRatioRaw ?? 0));
  const recovery = computeRecovery(client, proxy && proxy.bursts, {
    expectedFps,
    recoverFrac: finiteNumber(options.recoverFrac),
  });
  const pliRate = finiteNumber(inputValue(client, "pliRate")) ?? rateFromCounter(client, "pliCount");
  const cpuSlope = finiteNumber(inputValue(client, "cpuSlope"));
  const qp = finiteNumber(inputValue(client, "qp"));
  const qpBase = finiteNumber(options.qpBase) ?? finiteNumber(inputValue(client, "qpBase"));
  const e2eP95 = finiteNumber(inputValue(client, "e2eP95"));
  const e2eBase = finiteNumber(options.e2eBase) ?? finiteNumber(inputValue(client, "e2eBase"));

  const missing = [];
  if (freezeRatioRaw === null) missing.push("freezeRatio");
  if (pliRate === null) missing.push("pliRate");
  if (cpuSlope === null) missing.push("cpuSlope");
  if (qp === null) missing.push("qp");
  if (e2eP95 === null) missing.push("e2eP95");

  const qpDelta = qp !== null && qpBase !== null ? Math.max(0, qp - qpBase) : null;
  const e2eP95Delta = e2eP95 !== null && e2eBase !== null ? Math.max(0, e2eP95 - e2eBase) : null;
  if (qp !== null && qpBase === null) missing.push("qpBase");
  if (e2eP95 !== null && e2eBase === null) missing.push("e2eBase");

  const normalized = {
    recoverySpeed: norm("recoverySpeed", recovery.recoverySpeed, baselineVariance),
    pliRate: norm("pliRate", pliRate, baselineVariance),
    cpuSlope: norm("cpuSlope", cpuSlope, baselineVariance),
    qpDelta: norm("qpDelta", qpDelta, baselineVariance),
    e2eP95Delta: norm("e2eP95Delta", e2eP95Delta, baselineVariance),
  };
  const normalization = baselineVariance ? "baseline-variance" : "fixed";

  const terms = {
    freeze: WEIGHTS.freeze * (1 - freezeRatio),
    recovery: WEIGHTS.recovery * normalized.recoverySpeed.value,
    pli: -WEIGHTS.pli * normalized.pliRate.value,
    cpuSlope: -WEIGHTS.cpuSlope * normalized.cpuSlope.value,
    qpDelta: -WEIGHTS.qpDelta * normalized.qpDelta.value,
    e2eP95Delta: -WEIGHTS.e2eP95Delta * normalized.e2eP95Delta.value,
  };
  let score = Object.values(terms).reduce((sum, value) => sum + value, 0);

  const ssim = finiteNumber(options.ssim) ?? finiteNumber(client.ssim) ?? finiteNumber(summary.ssim);
  const coverage = expectedFps > 0 ? decodedFps / expectedFps : 0;
  const gates = {
    passed: true,
    freezeTelemetry: freezeRatioRaw !== null,
    ssim: ssim === null ? "absent" : ssim >= SSIM_FLOOR,
    coverage: coverage >= COVERAGE_FLOOR,
    axisA: "not-applicable",
  };
  if (!gates.freezeTelemetry) gates.passed = false;
  if (ssim !== null && ssim < SSIM_FLOOR) gates.passed = false;
  if (!gates.coverage) gates.passed = false;

  const proxyConfig = (proxy && proxy.config) || {};
  const profile = (client.config && client.config.profile) || proxyConfig.profile || "";
  const loss = injectedLoss(proxy);
  const observedLoss = finiteNumber(summary.packetsLost) ?? 0;
  if (profile === "passthrough") {
    // A bandwidth-capped passthrough run (BW_KBPS) intentionally drops host→client
    // RTP at the relay, so the ~0-loss falsification gate must NOT fire — otherwise
    // every congestion experiment scores as invalid. run-impaired.sh skips its own
    // passthrough loss gate in the same case; mirror that here.
    const bwCapped = (finiteNumber(proxyConfig.bwKbps) ?? 0) > 0;
    if (bwCapped) {
      gates.axisA = "bw-capped";
    } else {
      gates.axisA = loss.hostToClientRtpDropped === 0 && observedLoss <= LOSS_EPSILON ? "passed" : "failed";
      if (gates.axisA === "failed") gates.passed = false;
    }
    const climbFields = ["cpuSlope", "encodeSlope", "rssSlope"];
    if (climbFields.some((key) => {
      const value = finiteNumber(inputValue(client, key));
      return value !== null && value > 0;
    })) {
      gates.axisA = "time-based-suspected";
      gates.passed = false;
    }
  }

  if (!gates.passed) score = HARD_GATE_SCORE;

  return {
    score,
    terms,
    gates,
    inputs: {
      freezeRatio,
      recoverySpeed: recovery.recoverySpeed,
      meanRecoverMs: recovery.meanRecoverMs,
      pliRate,
      cpuSlope,
      qp,
      qpBase,
      qpDelta,
      e2eP95,
      e2eBase,
      e2eP95Delta,
      decodedFps,
      expectedFps,
      coverage,
      ssim,
      ...loss,
      clientObservedPacketsLost: observedLoss,
    },
    recovery,
    normalized,
    ssim,
    missing,
    normalization,
    weights: WEIGHTS,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseArgs(argv) {
  const args = { options: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--client") args.client = argv[++i];
    else if (arg === "--proxy") args.proxy = argv[++i];
    else if (arg === "--baseline") args.baseline = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--ssim") args.options.ssim = Number(argv[++i]);
    else if (arg === "--expected-fps") args.options.expectedFps = Number(argv[++i]);
    else if (arg === "--recover-frac") args.options.recoverFrac = Number(argv[++i]);
    else if (!args.client) args.client = arg;
    else if (!args.proxy) args.proxy = arg;
    else if (!args.baseline) args.baseline = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.client || !args.proxy) {
    throw new Error("usage: score.js --client <client.json> --proxy <proxy.json> [--baseline <variance.json>] [--out <score.json>]");
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const record = scoreRun(
    readJson(args.client),
    readJson(args.proxy),
    args.baseline ? readJson(args.baseline) : null,
    args.options,
  );
  const json = `${JSON.stringify(record, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, json);
  process.stdout.write(json);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = {
  COVERAGE_FLOOR,
  EPSILON,
  FIXED_SCALES,
  HARD_GATE_SCORE,
  SSIM_FLOOR,
  WEIGHTS,
  norm,
  rateFromCounter,
  scoreRun,
};
