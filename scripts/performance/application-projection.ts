/**
 * Offline application-projection benchmark. No providers, database or network.
 * Run: env -u NODE_ENV node --expose-gc --import tsx scripts/performance/application-projection.ts
 * Compare runs on the same idle host and Node version. This measures server
 * JavaScript work, not socket delivery, database capture or Android rendering.
 */
import assert from "node:assert/strict";
import { cpus } from "node:os";
import {
  ApplicationEventHub,
  ScopedApplicationEventHubs,
} from "../../src/server/events/application-event-hub.js";
import {
  normalizedApplicationSnapshotSchema,
  type NormalizedApplicationSnapshot as Snapshot,
  type NormalizedApplicationThreadSummary as Thread,
} from "../../src/shared/protocol/application.js";

const threadCount = 10_000;
const foldCount = 10_000;
const warmupCount = 1_000;
const captureSamples = 20;
const fanoutFoldCount = 1_000;
const timestamp = "2026-09-18T00:00:00.000Z";
const id = (index: number) =>
  `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const round = (value: number) => Math.round(value * 1_000) / 1_000;
const jsonBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
function distribution(samples: number[]) {
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    count: samples.length,
    totalMilliseconds: round(
      samples.reduce((total, value) => total + value, 0),
    ),
    medianMilliseconds: round(ordered[Math.floor(ordered.length / 2)] ?? 0),
    p95Milliseconds: round(
      ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0,
    ),
    maximumMilliseconds: round(ordered.at(-1) ?? 0),
  };
}
function fixture(): Snapshot {
  const base: Thread = {
    id: id(0),
    workspaceId: id(10_001),
    targetId: "target",
    title: { text: "Synthetic thread" },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 0,
    pinned: false,
    pinRevision: 0,
    preferredWorktree: null,
    preferredWorktreeRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    threadRevision: 0,
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    available: true,
    lastActivityAt: timestamp,
    stateChangedAt: timestamp,
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
  };
  return {
    environments: [
      {
        id: "environment",
        kind: "local",
        label: { text: "Synthetic" },
        available: true,
        directoryBrowsing: "available",
      },
    ],
    workspaces: [
      {
        id: base.workspaceId,
        environmentId: "environment",
        label: { text: "Synthetic" },
        displayPath: { text: "/synthetic" },
        available: true,
      },
    ],
    threads: Array.from({ length: threadCount }, (_, index) => ({
      ...base,
      id: id(index),
    })),
    groups: [],
    forkOrigins: [],
    lineagePlacements: [],
    lineageFamilies: [],
    tasks: [],
    advisories: [],
    executionTargets: [
      {
        id: "target",
        environmentId: "environment",
        label: { text: "Synthetic" },
        backend: base.backend,
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
    ],
    defaultNewThreadTargetId: "target",
    counts: { active: threadCount, snoozed: 0, settled: 0, archived: 0 },
  };
}

const seed = fixture();
const gcAvailable = typeof globalThis.gc === "function";
function heap() {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
}
function publishChange(hub: ApplicationEventHub, index: number) {
  const previous = hub.projection!.get("threads", id(index % threadCount))!;
  return hub.publish({
    type: "thread_upsert",
    generation: hub.generation,
    thread: {
      ...previous,
      threadRevision: previous.threadRevision + 1,
      runState: previous.runState === "idle" ? "running" : "idle",
    },
    counts: hub.projection!.counts,
  });
}

function baseline() {
  // Same normalized inventory size; deliberately excludes repository/runtime
  // reads. This is the validation/encoding floor of a complete fresh capture,
  // not an assertion that production capture costs exactly this much.
  const samples: number[] = [];
  for (let index = 0; index < captureSamples + 2; index++) {
    const started = performance.now();
    const captured = normalizedApplicationSnapshotSchema.parse(seed);
    const bytes = jsonBytes(captured);
    const elapsed = performance.now() - started;
    assert(bytes > 0);
    if (index >= 2) samples.push(elapsed);
  }
  return distribution(samples);
}

function burst() {
  const beforeHeap = heap();
  const hub = new ApplicationEventHub();
  const started = performance.now();
  hub.publish({ type: "snapshot", generation: hub.generation, snapshot: seed });
  const seedMilliseconds = performance.now() - started;
  const seededHeap = heap();
  for (let index = 0; index < warmupCount; index++) publishChange(hub, index);
  hub.projection!.materialize();
  const samples: number[] = [];
  const audits: number[] = [];
  const burstStarted = performance.now();
  for (let index = 0; index < foldCount; index++) {
    const foldStarted = performance.now();
    publishChange(hub, index);
    samples.push(performance.now() - foldStarted);
    // The production owner schedules this separately. Keep the complete
    // synchronous audit cost visible without charging it to an ordinary fold.
    if (hub.projection!.auditDue()) {
      const auditStarted = performance.now();
      hub.projection!.materialize();
      audits.push(performance.now() - auditStarted);
    }
  }
  const burstMilliseconds = performance.now() - burstStarted;
  const afterFoldHeap = heap();
  const beforeCheckpointAccountedBytes = hub.accountedBytes;
  const checkpointStarted = performance.now();
  const checkpoint = hub.currentCheckpoint()!;
  const checkpointMilliseconds = performance.now() - checkpointStarted;
  const frame = hub.encoded(checkpoint);
  const afterCheckpointHeap = heap();
  const result = {
    seedMilliseconds: round(seedMilliseconds),
    folds: distribution(samples),
    separatelyMeasuredAudits: distribution(audits),
    burstIncludingAuditsMilliseconds: round(burstMilliseconds),
    checkpointMilliseconds: round(checkpointMilliseconds),
    checkpointFrameBytes: frame.bytes,
    projectionJsonBytes: hub.projection!.serializedBytes,
    retainedReplayEvents: hub.retainedEventCount,
    retainedReplayBytes: hub.retainedBytes,
    beforeCheckpointAccountedBytes,
    afterCheckpointAccountedBytes: hub.accountedBytes,
    heapUsedBytes: {
      beforeHeap,
      seededHeap,
      afterFoldHeap,
      afterCheckpointHeap,
    },
    heapDeltaBytes: {
      seed: seededHeap - beforeHeap,
      afterFold: afterFoldHeap - beforeHeap,
      afterCheckpoint: afterCheckpointHeap - beforeHeap,
    },
  };
  hub.close();
  return result;
}

function fanout(subscriberCount: number) {
  const hub = new ApplicationEventHub();
  let deliveries = 0;
  let currentSequence: string | undefined;
  let currentDelivery: ReturnType<ApplicationEventHub["encoded"]> | undefined;
  let sharingValid = true;
  const subscriptions = Array.from({ length: subscriberCount }, () =>
    hub.subscribe((envelope) => {
      const encoded = hub.encoded(envelope);
      if (currentSequence === envelope.eventId)
        sharingValid &&= encoded === currentDelivery;
      else {
        currentSequence = envelope.eventId;
        currentDelivery = encoded;
      }
      deliveries++;
    }),
  );
  const seedStarted = performance.now();
  hub.publish({ type: "snapshot", generation: hub.generation, snapshot: seed });
  const seedFanoutMilliseconds = performance.now() - seedStarted;
  const samples: number[] = [];
  for (let index = 0; index < fanoutFoldCount; index++) {
    const started = performance.now();
    publishChange(hub, index);
    samples.push(performance.now() - started);
  }
  const checkpointStarted = performance.now();
  const first = hub.currentCheckpoint()!;
  const checkpointMilliseconds = performance.now() - checkpointStarted;
  const cachedReadStarted = performance.now();
  for (let index = 0; index < subscriberCount; index++) {
    const cached = hub.currentCheckpoint()!;
    sharingValid &&=
      cached === first && hub.encoded(cached) === hub.encoded(first);
  }
  const cachedReadsMilliseconds = performance.now() - cachedReadStarted;
  assert(
    sharingValid,
    "Subscribers and checkpoint reads must reuse one prepared frame.",
  );
  assert.equal(deliveries, subscriberCount * (fanoutFoldCount + 1));
  for (const subscription of subscriptions) subscription.close();
  hub.close();
  return {
    subscriberCount,
    seedFanoutMilliseconds: round(seedFanoutMilliseconds),
    foldsIncludingCallbacks: distribution(samples),
    checkpointMilliseconds: round(checkpointMilliseconds),
    cachedReadsMilliseconds: round(cachedReadsMilliseconds),
    deliveries,
    sharingValid,
  };
}

function idleAccounting() {
  const registry = new ScopedApplicationEventHubs();
  const scope = { tenantId: id(20_001), principalId: id(20_002) };
  const hub = registry.application(scope);
  const subscription = hub.subscribe(() => {});
  hub.publish({ type: "snapshot", generation: hub.generation, snapshot: seed });
  for (let index = 0; index < 100; index++) publishChange(hub, index);
  hub.currentCheckpoint();
  subscription.close();
  const result = {
    retainedScopes: registry.retainedHubCount,
    subscriberCount: hub.subscriberCount,
    accountedIdleBytes: hub.accountedBytes,
    projectionJsonBytes: hub.projection!.serializedBytes,
    retainedReplayEvents: hub.retainedEventCount,
    retainedReplayBytes: hub.retainedBytes,
  };
  registry.close();
  return result;
}

const result = {
  measuredAt: new Date().toISOString(),
  host: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpu: cpus()[0]?.model,
    gcAvailable,
  },
  fixture: {
    threadCount,
    snapshotJsonBytes: jsonBytes(seed),
    foldCount,
    warmupCount,
    captureSamples,
    fanoutFoldCount,
  },
  limitations: [
    "Synthetic normalized inventory with 10000 threads; other collections are small.",
    "No database/runtime/provider reads, socket writes, network latency or Android rendering measured.",
    "Full-capture baseline measures only schema validation plus JSON encoding, not total production capture latency.",
    "Subscriber callbacks retrieve shared frames in process; they do not simulate backpressure or network buffers.",
    "Serialized accounting is not actual heap use. Heap deltas include GC/runtime effects and are meaningful only with --expose-gc.",
    "A single run reports host-specific regression evidence, not portable performance guarantees.",
  ],
  completeCaptureValidationAndEncoding: baseline(),
  burst: burst(),
  fanout: [1, 5, 20].map(fanout),
  idleAccounting: idleAccounting(),
};
console.log(JSON.stringify(result, null, 2));
