/**
 * Offline accumulated-thread catch-up benchmark; no provider or network access.
 * Run: env -u NODE_ENV npm run measure:catchup
 * Compare medians on the same idle host. Timings exclude publication, the SSE
 * byte parser, React and network latency; they are evidence, not test gates.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { NormalizedThreadStore } from "../../src/client/stores/NormalizedThreadStore.js";
import {
  threadEventEnvelopeSchema,
  type NormalizedThreadSnapshot,
  type ThreadEventEnvelope,
} from "../../src/shared/protocol/conversation.js";
import { ThreadEventHub } from "../../src/server/events/thread-event-hub.js";
import { serveThreadEventStream } from "../../src/server/events/thread-sse.js";
import { projectThreadEventEnvelopeActivity } from "../../src/server/conversations/thread-activity-projection.js";
import { assertBoundedSseFrame } from "../../src/server/events/sse-frame.js";

function snapshot(title = "Thread"): NormalizedThreadSnapshot {
  return {
    executionWorkspace: { kind: "direct" },
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "Latest provider snapshot forking is unavailable in this fixture.",
        },
      },
    },
    forksByTurnId: {},
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: title },
      backend: { label: { text: "Pi" }, brand: "pi" },
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 0,
      threadRevision: 0,
      runState: "idle",
      queuedInputCount: 0,
      available: true,
      lastActivityAt: "2026-07-30T15:00:00.000Z",
      stateChangedAt: "2026-07-30T15:00:00.000Z",
      automation: null,
    },
    workspace: {
      id: "workspace-1",
      environmentId: "environment-1",
      label: { text: "Workspace" },
      displayPath: { text: "/workspace" },
      available: true,
    },
    environment: {
      id: "environment-1",
      kind: "local" as const,
      label: { text: "Machine" },
      available: true,
      directoryBrowsing: "available" as const,
    },
    draft: {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 0,
    },
    stashes: [],
    composerCommands: [],
    agentTools: {
      enabled: false,
      accessBoundary: "environment",
      groups: [],
      presentation: { surface: "native", mode: "individual" },
      presentationOptions: [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    orderedTurnIds: [],
    turnsById: {},
    itemsById: {},
    history: { hasOlder: false },
    runState: "idle",
    queue: [],
    capabilities: {
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      composerAttachments: {
        fileStaging: {
          availability: "unavailable",
          reason: { text: "Unavailable." },
        },
        nativeImage: {
          availability: "unavailable",
          reason: { text: "Unavailable." },
        },
        policy: {
          maximumAttachments: 8,
          maximumImages: 4,
          maximumAggregateBytes: 67_108_864,
          maximumFileBytes: 26_214_400,
          maximumImageBytes: 16_777_216,
          maximumImagePixels: 40_000_000,
          maximumImageDimension: 16_384,
          imageMediaTypes: [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
          ],
        },
      },
      revision: "capabilities-1",
      backend: { label: { text: "Backend" } },
      interactionMode: "interactive",
      runState: "idle",
      operations: [],
      deliveryModes: [],
      settings: [],
      composerActions: [],
      interactions: [],
      providerFeatures: [],
      history: { available: true, paginated: true },
      automation: {
        available: true,
        canAttach: true,
        canRunNow: true,
        canCloneOnRun: true,
      },
    },
    settings: { revision: 0, values: [] },
    providerFeatures: [],
    usage: {},
    interactions: [],
    attention: {},
  };
}


class CaptureRequest extends EventEmitter {
  header(): undefined { return undefined; }
}
class CaptureResponse extends EventEmitter {
  readonly writes: string[] = [];
  readonly writableLength = 0;
  readonly writableHighWaterMark = 16_384;
  status(): this { return this; }
  setHeader(): void {}
  flushHeaders(): void {}
  end(): void {}
  write(value: string): boolean { this.writes.push(value); return true; }
}

// Reproduce the prior contiguous replay encoding path, including validation
// and the production activity projection. The optimized path calls the real
// stream server below; neither comparison recaptures provider history.
function encodeReplay(envelope: ThreadEventEnvelope): string {
  const projected = projectThreadEventEnvelopeActivity(
    threadEventEnvelopeSchema.parse(envelope), "full",
  );
  return assertBoundedSseFrame(
    `id: ${projected.eventId}\nevent: thread\ndata: ${JSON.stringify(projected)}\n\n`,
  );
}
function consume(frames: readonly string[], baseline: readonly ThreadEventEnvelope[]) {
  const store = new NormalizedThreadStore();
  for (const envelope of baseline) assert.equal(store.apply(envelope).kind, "applied");
  store.prepareForReconnect();
  const startedAt = performance.now();
  for (const frame of frames) {
    const name = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (name === "thread" && data) {
      assert.equal(store.apply(JSON.parse(data)).kind, "applied");
    } else if (name === "thread-checkpoint" && data) {
      assert.equal(store.applyCheckpoint(JSON.parse(data)).kind, "applied");
    } else if (name === "thread-live") {
      store.confirmReplayCaughtUp();
    }
  }
  const milliseconds = performance.now() - startedAt;
  assert.equal(store.state.authoritative, true);
  return { store, milliseconds };
}
const trials = 5;
const eventCount = 640;
const generation = "benchmark-projection";
const hub = new ThreadEventHub();
const currentTurn = {
  id: "turn-current", revision: 0, status: "in_progress" as const,
  orderedItemIds: ["assistant-current"],
};
const currentItem = {
  id: "assistant-current", turnId: currentTurn.id, kind: "assistant_message" as const,
  status: "streaming" as const, revision: 0, markdown: { text: "" },
};
const base = snapshot();
const anchor = hub.publish({
  type: "snapshot", generation,
  snapshot: {
    ...base, runState: "running", activeTurnId: currentTurn.id,
    thread: { ...base.thread, runState: "running" },
    capabilities: { ...base.capabilities, runState: "running" },
    orderedTurnIds: [currentTurn.id],
    turnsById: { [currentTurn.id]: currentTurn },
    itemsById: { [currentItem.id]: currentItem },
    forksByTurnId: {
      [currentTurn.id]: { sourceTurnId: currentTurn.id, expectedTurnRevision: 0,
        available: false, unavailableReason: { text: "Still running." } },
    },
    history: { hasOlder: true, olderCursor: "older-before-prepend" },
  },
});
const older = hub.publish({
  type: "history_prepend", generation,
  page: {
    orderedTurnIds: ["turn-older"], forkSource: base.forkSource,
    turnsById: {
      "turn-older": { id: "turn-older", revision: 1, status: "completed",
        endedBy: "agent_settled", orderedItemIds: ["assistant-older"] },
    },
    itemsById: {
      "assistant-older": { id: "assistant-older", turnId: "turn-older",
        kind: "assistant_message", revision: 1, status: "completed",
        markdown: { text: "An explicitly loaded older turn stays available. 界 🌍" } },
    },
    forksByTurnId: {
      "turn-older": { sourceTurnId: "turn-older", expectedTurnRevision: 1,
        available: false, unavailableReason: { text: "Unavailable in this fixture." } },
    },
    previousCursor: "older-after-prepend",
  },
});
const cursor = older.eventId;
const chunk = "Retained assistant output from the background stream. ".padEnd(63, ".") + "\n";
assert.equal(Buffer.byteLength(chunk, "utf8"), 64);
for (let revision = 1; revision <= eventCount; revision += 1) {
  hub.publish({
    type: "item_upsert", generation,
    item: { ...currentItem, revision, markdown: { text: chunk.repeat(revision) } },
  });
}
assert.equal(hub.canReplay(cursor), true, "workload must exercise valid replay");
const expected = hub.snapshot;
const watermark = hub.watermark;
const observed: ThreadEventEnvelope[] = [];
const observer = hub.subscribe((event) => observed.push(event), hub.eventIdAt(watermark));
const samples: { replayEncodeMilliseconds: number; checkpointEncodeMilliseconds: number;
  replayApplyMilliseconds: number; checkpointApplyMilliseconds: number }[] = [];
let replayBytes = 0;
let checkpointBytes = 0;
let replayEvents = 0;
let checkpointEvents = 0;
try {
  for (let trial = 0; trial < trials; trial += 1) {
    const replayStarted = performance.now();
    const replay = hub.subscribe(() => {}, cursor);
    const replayFrames = replay.replay.map(encodeReplay);
    replayEvents = replay.replay.length;
    replay.close();
    replayFrames.push("event: thread-live\ndata: {}\n\n");
    const replayEncodeMilliseconds = performance.now() - replayStarted;
    const request = new CaptureRequest();
    const response = new CaptureResponse();
    const checkpointStarted = performance.now();
    try {
      await serveThreadEventStream(
        request as unknown as Request, response as unknown as Response, hub,
        { publishAuthoritativeReplacement: async () => {
          throw new Error("benchmark_must_not_recapture_or_publish");
        } },
        { explicitReplayCursor: cursor },
      );
    } finally {
      request.emit("close");
    }
    const checkpointEncodeMilliseconds = performance.now() - checkpointStarted;
    checkpointEvents = response.writes.filter((frame) =>
      frame.includes("\nevent: thread-checkpoint\n") || frame.startsWith("event: thread-checkpoint\n"),
    ).length;
    assert.equal(checkpointEvents, 1);
    assert.equal(response.writes.filter((frame) => frame.includes("\nevent: thread\n")).length, 0);
    assert.equal(hub.watermark, watermark, "catch-up must not publish into the hub");
    assert.equal(observed.length, 0, "catch-up must not replace another viewer's state");
    replayBytes = replayFrames.reduce((sum, frame) => sum + Buffer.byteLength(frame, "utf8"), 0);
    checkpointBytes = response.writes.reduce((sum, frame) => sum + Buffer.byteLength(frame, "utf8"), 0);
    const replayResult = consume(replayFrames, [anchor, older]);
    const checkpointResult = consume(response.writes, [anchor, older]);
    assert.deepEqual(replayResult.store.state.snapshot, expected);
    assert.deepEqual(checkpointResult.store.state.snapshot, expected);
    assert.deepEqual(checkpointResult.store.state.snapshot?.orderedTurnIds, ["turn-older", "turn-current"]);
    const history = checkpointResult.store.state.snapshot?.history;
    assert.ok(history?.hasOlder);
    assert.equal(history.olderCursor, "older-after-prepend");
    assert.equal(checkpointResult.store.replayCursor, hub.eventIdAt(watermark));
    samples.push({ replayEncodeMilliseconds, checkpointEncodeMilliseconds,
      replayApplyMilliseconds: replayResult.milliseconds,
      checkpointApplyMilliseconds: checkpointResult.milliseconds });
  }
} finally {
  observer.close();
}
const rounded = (value: number) => Math.round(value * 10) / 10;
const medians = Object.fromEntries(Object.keys(samples[0]!).map((key) => [
  key, rounded(samples.map((sample) => sample[key as keyof typeof sample]).sort((a, b) => a - b)[Math.floor(trials / 2)]!),
]));
console.log(JSON.stringify({
  nodeVersion: process.version, trials, eventCount, finalMessageBytes: eventCount * 64,
  replayEvents, checkpointEvents, replayBytes, checkpointBytes,
  transferReduction: rounded(replayBytes / checkpointBytes),
  medians, samples: samples.map((sample) => Object.fromEntries(
    Object.entries(sample).map(([key, value]) => [key, rounded(value)]),
  )),
}, null, 2));
