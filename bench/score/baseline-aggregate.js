#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function scoreValue(record) {
  return typeof record.score === "number" && Number.isFinite(record.score) ? record.score : null;
}

function sampleStddev(values, mean) {
  if (values.length <= 1) return 0;
  const variance =
    values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function aggregateScoreRecords(records) {
  const included = records.filter((record) => record.gates && record.gates.passed);
  const excludedRuns = records.length - included.length;
  const scores = included.map(scoreValue).filter((score) => score !== null);
  const mean = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
  return {
    generatedAt: new Date().toISOString(),
    runCount: records.length,
    excludedRuns,
    score: {
      count: scores.length,
      mean,
      stddev: mean === null ? null : sampleStddev(scores, mean),
      values: scores,
    },
    runs: records.map((record) => ({
      path: record.path,
      score: record.score,
      gates: record.gates,
      inputs: record.inputs,
    })),
  };
}

function aggregateScoreFiles(files) {
  return aggregateScoreRecords(files.map((file) => ({
    path: file,
    ...JSON.parse(fs.readFileSync(file, "utf8")),
  })));
}

function main(argv) {
  const [out, ...files] = argv;
  if (!out || files.length === 0) {
    throw new Error("usage: baseline-aggregate.js <out> <score-json>...");
  }
  const aggregate = aggregateScoreFiles(files);
  fs.writeFileSync(out, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.error(out);
  console.log(aggregate.score.mean);
  if (aggregate.excludedRuns > 0) {
    console.error(`excludedRuns=${aggregate.excludedRuns}`);
    process.exitCode = 1;
  }
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
  aggregateScoreFiles,
  aggregateScoreRecords,
};
