import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function reportsIn(directory) {
  const reports = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) reports.push(...await reportsIn(filename));
    else if (entry.name === "browser-performance.json") reports.push(filename);
  }
  return reports;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const directories = process.argv.slice(2);
if (directories.length === 0) {
  throw new Error("Usage: node scripts/performance/summarize-browser.mjs RUN_DIRECTORY [RUN_DIRECTORY ...]");
}
for (const directory of directories) {
  const profiles = new Map();
  for (const filename of await reportsIn(path.join(directory, "playwright"))) {
    const report = JSON.parse(await readFile(filename, "utf8"));
    if (report.format !== "sedes-browser-performance-v1") throw new Error("Unsupported benchmark report");
    const diagnostics = JSON.parse(await readFile(path.join(path.dirname(filename), "client-diagnostics.json"), "utf8"));
    const batches = diagnostics.entries.filter((entry) => entry.event === "stream_batch_applied");
    const records = profiles.get(report.profile.name) ?? [];
    records.push({
      report,
      storeMilliseconds: batches.reduce((sum, entry) => sum + entry.details.durationMilliseconds, 0),
      appliedEvents: batches.reduce((sum, entry) => sum + entry.details.applied, 0),
      initialSnapshot: diagnostics.entries.find((entry) => entry.event === "server_snapshot_timing_received")?.details,
    });
    profiles.set(report.profile.name, records);
  }
  const summary = {};
  for (const [profile, records] of profiles) {
    const first = records[0].report;
    const configuration = JSON.stringify([first.profile, first.workload, first.instrumentation]);
    if (records.some(({ report }) => JSON.stringify([report.profile, report.workload, report.instrumentation]) !== configuration)) {
      throw new Error(`Mismatched benchmark configuration within profile ${profile}`);
    }
    const phases = {};
    for (const sample of records[0].report.samples) {
      const samples = records.map((record) => record.report.samples.find((candidate) => candidate.phase === sample.phase));
      phases[sample.phase] = Object.fromEntries(Object.keys(sample)
        .filter((key) => typeof sample[key] === "number")
        .map((key) => [key, median(samples.map((candidate) => candidate[key]))]));
    }
    summary[profile] = {
      trials: records.length,
      profile: first.profile,
      instrumentation: first.instrumentation,
      workload: records[0].report.workload,
      initialSnapshot: {
        bytes: records[0].initialSnapshot?.bytes,
        turns: records[0].initialSnapshot?.turnCount,
        items: records[0].initialSnapshot?.itemCount,
      },
      storeMilliseconds: median(records.map((record) => record.storeMilliseconds)),
      appliedEvents: records.map((record) => record.appliedEvents),
      phases,
    };
  }
  console.log(JSON.stringify({ directory, medianResults: summary }, null, 2));
}
