/** Offline store benchmark; run with node --import tsx scripts/performance/normalized-turn-upsert.ts. */
import { NormalizedThreadStore } from "../../src/client/stores/NormalizedThreadStore.js";
import type {
  NormalizedThreadSnapshot,
  ConversationTurn,
  ConversationItem,
  ThreadEventEnvelope,
} from "../../src/shared/index.js";
function snapshot(): NormalizedThreadSnapshot {
  return {
    executionWorkspace: { kind: "direct" },
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
    },
    forksByTurnId: {
      "turn-1": {
        sourceTurnId: "turn-1",
        expectedTurnRevision: 0,
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
    },
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: "Thread" },
      backend: { label: { text: "Pi" }, brand: "pi" },
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 0,
      threadRevision: 0,
      runState: "running",
      queuedInputCount: 0,
      available: true,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      stateChangedAt: "2026-01-01T00:00:00.000Z",
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
    orderedTurnIds: ["turn-1"],
    turnsById: {
      "turn-1": {
        id: "turn-1",
        revision: 0,
        status: "in_progress",
        orderedItemIds: [],
      },
    },
    itemsById: {},
    history: { hasOlder: false },
    runState: "running",
    activeTurnId: "turn-1",
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
      revision: "cap-1",
      backend: { label: { text: "Assistant" } },
      interactionMode: "interactive",
      runState: "running",
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

const base = snapshot();
const orderedTurnIds: string[] = [];
const turnsById: Record<string, ConversationTurn> = {};
const itemsById: Record<string, ConversationItem> = {};
const forksByTurnId: Record<
  string,
  NormalizedThreadSnapshot["forksByTurnId"][string]
> = {};
for (let index = 0; index < 100; index += 1) {
  const id = `turn-${index}`;
  const itemId = `item-${index}`;
  orderedTurnIds.push(id);
  turnsById[id] = {
    id,
    revision: 0,
    status: "in_progress",
    orderedItemIds: [itemId],
  };
  forksByTurnId[id] = {
    sourceTurnId: id,
    expectedTurnRevision: 0,
    available: false,
    unavailableReason: { text: "Forking is unavailable in this fixture." },
  };
  itemsById[itemId] = {
    id: itemId,
    turnId: id,
    kind: "assistant_message",
    status: "streaming",
    revision: 0,
    markdown: { text: "a".repeat(32_768) },
  };
}
const initial = {
  ...base,
  orderedTurnIds,
  turnsById,
  itemsById,
  forksByTurnId,
};
const store = new NormalizedThreadStore();
function apply(sequence: number, event: ThreadEventEnvelope["event"]): void {
  const result = store.apply({
    eventId: `00000000-0000-4000-8000-000000000001.${sequence}`,
    projectionGeneration: "projection-1",
    event,
  });
  if (result.kind !== "applied") throw new Error(JSON.stringify(result));
}
apply(0, { type: "snapshot", generation: "projection-1", snapshot: initial });
let sequence = 0;
const timingsMilliseconds: number[] = [];
for (let run = 0; run < 6; run += 1) {
  const start = performance.now();
  for (let index = 0; index < 100; index += 1) {
    sequence += 1;
    apply(sequence, {
      type: "turn_upsert",
      generation: "projection-1",
      turn: { ...turnsById["turn-1"]!, revision: sequence },
      fork: { ...forksByTurnId["turn-1"]!, expectedTurnRevision: sequence },
    });
  }
  timingsMilliseconds.push(performance.now() - start);
}
const measured = timingsMilliseconds.slice(1).sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      turnCount: 100,
      snapshotBytes: store.snapshotSerializedBytes,
      updatesPerRun: 100,
      warmupRuns: 1,
      timingsMilliseconds,
      medianMilliseconds: measured[2],
    },
    null,
    2,
  ),
);
