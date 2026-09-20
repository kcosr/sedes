/**
 * Offline replay-eviction CPU benchmark; no provider, disk, or network access.
 * Run: env -u NODE_ENV node --import tsx scripts/performance/event-hub-replay.ts
 * Compare medians on the same idle host and Node version. Timings are evidence,
 * not a test gate or an estimate of end-to-end browser latency.
 */
import { EventHub } from "../../src/server/events/event-hub.js";

const trials = 5;
const eventCount = 2_000;
const replayByteLimit = 32 * 1_024 * 1_024;
// Streaming upserts carry retained output, not just the newest token. This
// synthetic ~68 KiB item exercises steady eviction after the replay cap fills.
const payload = { text: "synthetic output ".repeat(4_096) };
const samples = [];
for (let trial = 0; trial < trials; trial += 1) {
  const hub = new EventHub<typeof payload>({ replayByteLimit });
  const startedAt = performance.now();
  for (let event = 0; event < eventCount; event += 1) {
    hub.publish("item_upsert", payload);
  }
  samples.push({
    milliseconds: Math.round((performance.now() - startedAt) * 10) / 10,
    retainedEvents: hub.retainedEventCount,
    retainedBytes: hub.retainedBytes,
  });
}
console.log(JSON.stringify({
  eventCount,
  payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
  replayByteLimit,
  samples,
  medianMilliseconds: samples.map(({ milliseconds }) => milliseconds)
    .sort((left, right) => left - right)[Math.floor(trials / 2)],
}, null, 2));
