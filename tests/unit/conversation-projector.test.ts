import { describe, expect, it } from "vitest";
import {
  ConversationProjector,
  projectedThreadForkSourceCapability,
  projectedTurnForkCapability,
} from "../../src/server/conversations/conversation-projector.js";
import type {
  BackendConversationSnapshot,
  BackendItem,
} from "../../src/shared/protocol/backend.js";
import type { DeliveryInputSnapshot } from "../../src/server/db/repositories/delivery-input-snapshot-repository.js";

function snapshot(): BackendConversationSnapshot {
  const item = {
    backendItemId: "assistant-1:0",
    backendTurnId: "user-1",
    semanticKind: "assistant_message",
    status: "completed",
    sourceOrder: 0,
    markdown: { text: "Hello" },
  } as BackendItem;
  return {
    orderedBackendTurnIds: ["user-1"],
    turnsById: {
      "user-1": {
        backendTurnId: "user-1",
        status: "completed",
        endedBy: "agent_settled",
        orderedBackendItemIds: [item.backendItemId],
      },
    },
    itemsById: { [item.backendItemId]: item },
    runState: "idle",
  };
}

describe("ConversationProjector", () => {
  it("retains assistant response classification only on the server across snapshots and updates", () => {
    const projector = new ConversationProjector({ backendInstanceId: "backend", bindingIdentity: "binding" });
    const source = snapshot();
    const item = source.itemsById["assistant-1:0"]!;
    if (item.semanticKind !== "assistant_message") throw new Error("Expected assistant fixture");
    const initial = projector.replace({ ...source, itemsById: {
      [item.backendItemId]: { ...item, responsePhase: "unclassified" },
    } }, -1);
    const browserItem = Object.values(initial.itemsById)[0]!;
    expect(browserItem).toMatchObject({ kind: "assistant_message", markdown: { text: "Hello" } });
    expect(browserItem).not.toHaveProperty("responsePhase");
    expect(projector.assistantItemsForTurn(item.backendTurnId)).toMatchObject([{ responsePhase: "unclassified" }]);

    const updated = projector.apply({ handleSequence: 0, event: {
      type: "item_updated", item: { ...item, responsePhase: "final" },
    } });
    expect(updated).toEqual({ kind: "events", events: [] });
    expect(projector.timeline()).toEqual(initial);
    expect(projector.timeline().itemsById[browserItem.id]).toBe(browserItem);
    expect(projector.assistantItemsForTurn(item.backendTurnId)).toMatchObject([{ responsePhase: "final" }]);

    const changedText = projector.apply({ handleSequence: 1, event: {
      type: "item_updated", item: { ...item, responsePhase: "provisional", markdown: { text: "Changed answer" } },
    } });
    expect(changedText).toMatchObject({ kind: "events", events: [{ type: "item_upsert", item: {
      id: browserItem.id, revision: browserItem.revision + 1, markdown: { text: "Changed answer" },
    } }] });
    expect(projector.timeline().itemsById[browserItem.id]).not.toHaveProperty("responsePhase");
  });

  it("projects live background work independently from turn completion and replaces it on a new generation", () => {
    const projector = new ConversationProjector({ backendInstanceId: "backend", bindingIdentity: "binding" });
    const activity = { state: "known" as const, agents: 1, commands: 1, other: 0 };
    const initial = projector.replace({ ...snapshot(), backgroundActivity: activity }, -1);
    expect(initial.backgroundActivity).toEqual(activity);
    expect(initial.runState).toBe("idle");
    const completed = { ...activity, agents: 0, commands: 0 };
    expect(projector.apply({ handleSequence: 0, event: {
      type: "background_activity_changed", activity: completed,
    } })).toEqual({ kind: "events", events: [{
      type: "background_activity_changed", generation: initial.generation, activity: completed,
    }] });
    expect(projector.timeline().backgroundActivity).toEqual(completed);
    expect(projector.timeline().turnsById).toEqual(initial.turnsById);
    expect(projector.replace(snapshot(), -1)).not.toHaveProperty("backgroundActivity");
  });

  it("preserves a genuine compaction summary and omits an absent one", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "backend",
      bindingIdentity: "binding-compaction",
    });
    const summarized = {
      backendItemId: "compaction-with-summary",
      backendTurnId: "turn-1",
      semanticKind: "compaction" as const,
      status: "completed" as const,
      sourceOrder: 0,
      summary: { text: "A provider-authored summary" },
    };
    const marker = {
      backendItemId: "compaction-marker",
      backendTurnId: "turn-1",
      semanticKind: "compaction" as const,
      status: "completed" as const,
      sourceOrder: 1,
    };
    const projected = projector.replace(
      {
        orderedBackendTurnIds: ["turn-1"],
        turnsById: {
          "turn-1": {
            backendTurnId: "turn-1",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: [
              summarized.backendItemId,
              marker.backendItemId,
            ],
          },
        },
        itemsById: {
          [summarized.backendItemId]: summarized,
          [marker.backendItemId]: marker,
        },
        runState: "idle",
      },
      -1,
    );
    const compactions = Object.values(projected.itemsById).filter(
      (item) => item.kind === "compaction",
    );

    expect(compactions).toHaveLength(2);
    expect(compactions[0]).toMatchObject({
      kind: "compaction",
      summary: { text: "A provider-authored summary" },
    });
    expect(compactions[1]).not.toHaveProperty("summary");
  });

  it("restores image-only and mixed attachment messages from common delivery snapshots", () => {
    const imageDescriptor = {
      id: "2dff386b-2f0a-4cd2-acf1-3fc220b82947",
      kind: "image" as const,
      fileName: "photo.png",
      mediaType: "image/png" as const,
      byteSize: 123,
    };
    const fileDescriptor = {
      id: "2037ec40-5945-4639-889d-e68d1e6a1084",
      kind: "file" as const,
      fileName: "notes.bin",
      mediaType: "application/octet-stream" as const,
      byteSize: 42,
    };
    const snapshots = new Map<string, DeliveryInputSnapshot>([
      [
        "operation-image-only",
        {
          tenantId: "tenant-1",
          principalId: "principal-1",
          threadId: "thread-1",
          deliveryOperationId: "operation-image-only",
          text: "",
          contextExcerpts: [],
          taskContexts: [],
          attachments: [
            { descriptor: imageDescriptor, sha256: "a".repeat(64) },
          ],
          fingerprint: "b".repeat(64),
          createdAt: 1,
        },
      ],
      [
        "operation-mixed",
        {
          tenantId: "tenant-1",
          principalId: "principal-1",
          threadId: "thread-1",
          deliveryOperationId: "operation-mixed",
          text: "Read both",
          origin: {
            kind: "agent_result",
            callbackId: "callback-1",
            sourceThreadId: "worker-thread",
            sourceThreadLabel: { text: "Research agent" },
          },
          contextExcerpts: [],
          taskContexts: [],
          attachments: [
            { descriptor: imageDescriptor, sha256: "a".repeat(64) },
            { descriptor: fileDescriptor, sha256: "c".repeat(64) },
          ],
          fingerprint: "d".repeat(64),
          createdAt: 2,
        },
      ],
    ]);
    const projector = new ConversationProjector({
      backendInstanceId: "local-codex",
      bindingIdentity: "binding-common-delivery",
      resolveDeliveryInputSnapshot: (operationId) => snapshots.get(operationId),
    });
    const imageOnly = {
      backendItemId: "item-image-only",
      backendTurnId: "turn-image-only",
      semanticKind: "user_message" as const,
      deliveryOperationId: "operation-image-only",
      status: "completed" as const,
      sourceOrder: 0,
      content: [
        { kind: "text" as const, text: { text: "coalesced manifest" } },
      ],
    };
    const mixed = {
      backendItemId: "item-mixed",
      backendTurnId: "turn-mixed",
      semanticKind: "user_message" as const,
      deliveryOperationId: "operation-mixed",
      status: "completed" as const,
      sourceOrder: 0,
      content: [{ kind: "image" as const, omitted: true as const }],
    };
    const timeline = projector.replace(
      {
        orderedBackendTurnIds: ["turn-image-only", "turn-mixed"],
        turnsById: {
          "turn-image-only": {
            backendTurnId: "turn-image-only",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: [imageOnly.backendItemId],
          },
          "turn-mixed": {
            backendTurnId: "turn-mixed",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: [mixed.backendItemId],
          },
        },
        itemsById: {
          [imageOnly.backendItemId]: imageOnly,
          [mixed.backendItemId]: mixed,
        },
        runState: "idle",
      },
      -1,
    );
    const userItems = Object.values(timeline.itemsById).filter(
      (item) => item.kind === "user_message",
    );
    expect(userItems[0]).toMatchObject({
      deliveryOperationId: "operation-image-only",
      content: [{ kind: "attachment", attachment: imageDescriptor }],
    });
    expect(userItems[1]).toMatchObject({
      deliveryOperationId: "operation-mixed",
      origin: {
        kind: "agent_result",
        callbackId: "callback-1",
        sourceThreadId: "worker-thread",
        sourceThreadLabel: { text: "Research agent" },
      },
      content: [
        { kind: "attachment", attachment: imageDescriptor },
        { kind: "attachment", attachment: fileDescriptor },
        { kind: "text", text: { text: "Read both" } },
      ],
    });

    const history = projector.projectHistoryPage(
      {
        orderedBackendTurnIds: ["turn-mixed"],
        turnsById: {
          "turn-mixed": {
            backendTurnId: "turn-mixed",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: [mixed.backendItemId],
          },
        },
        itemsById: { [mixed.backendItemId]: mixed },
      },
      {
        branching: {
          availability: "unavailable",
          reason: { text: "Unavailable." },
        },
        sourceRunState: "idle",
      },
    );
    expect(Object.values(history.itemsById)[0]).toMatchObject({
      content: [
        { kind: "attachment", attachment: imageDescriptor },
        { kind: "attachment", attachment: fileDescriptor },
        { kind: "text", text: { text: "Read both" } },
      ],
    });
  });

  it.each(["pi", "codex", "claude", "grok"])(
    "uses the same canonical Sedes-authored history projection for %s",
    (backendName) => {
      const operationId = `operation-${backendName}`;
      const descriptor = {
        id: "74e44bd7-94eb-4a14-8ef7-6ab01d68556f",
        kind: "image" as const,
        fileName: "shared.png",
        mediaType: "image/png" as const,
        byteSize: 77,
      };
      const projector = new ConversationProjector({
        backendInstanceId: `local-${backendName}`,
        bindingIdentity: `binding-${backendName}`,
        resolveDeliveryInputSnapshot: (candidate) =>
          candidate === operationId
            ? {
                tenantId: "tenant-1",
                principalId: "principal-1",
                threadId: "thread-1",
                deliveryOperationId: operationId,
                text: "Canonical prompt",
                contextExcerpts: [],
                taskContexts: [],
                attachments: [{ descriptor, sha256: "a".repeat(64) }],
                fingerprint: "b".repeat(64),
                createdAt: 1,
              }
            : undefined,
      });
      const backendItem: BackendItem = {
        backendItemId: "user-item",
        backendTurnId: "turn-1",
        semanticKind: "user_message",
        deliveryOperationId: operationId,
        status: "completed",
        sourceOrder: 0,
        content: [
          {
            kind: "text",
            text: { text: `provider-specific ${backendName} echo` },
          },
        ],
      };
      const timeline = projector.replace(
        {
          orderedBackendTurnIds: ["turn-1"],
          turnsById: {
            "turn-1": {
              backendTurnId: "turn-1",
              status: "completed",
              endedBy: "agent_settled",
              orderedBackendItemIds: [backendItem.backendItemId],
            },
          },
          itemsById: { [backendItem.backendItemId]: backendItem },
          runState: "idle",
        },
        -1,
      );
      expect(Object.values(timeline.itemsById)[0]).toMatchObject({
        deliveryOperationId: operationId,
        content: [
          { kind: "attachment", attachment: descriptor },
          { kind: "text", text: { text: "Canonical prompt" } },
        ],
      });
      expect(JSON.stringify(timeline)).not.toContain("provider-specific");
    },
  );

  it("offers fork descriptors only for agent-settled completed turns", () => {
    const branching = {
      availability: "available" as const,
      boundaries: [
        "selected_completed_turn" as const,
        "latest_provider_snapshot" as const,
      ],
      method: "provider_native" as const,
      sourceMustBeIdle: true,
      settingsInheritance: "native" as const,
      fidelity: {
        instructions: true,
        messages: true,
        toolCalls: true,
        toolResults: true,
        compaction: true,
        attachments: true,
        settings: true,
        limitations: [],
      },
      childIdentity: "application_reserved" as const,
      creationRecovery: "idempotent" as const,
    };
    for (const [status, endedBy, available] of [
      ["completed", "agent_settled", true],
      ["completed", "steer", false],
      ["completed", undefined, false],
      ["interrupted", "interrupted", false],
      ["in_progress", undefined, false],
    ] as const) {
      expect(
        projectedTurnForkCapability({
          turn: {
            id: "turn-eligibility",
            revision: 0,
            status,
            ...(endedBy ? { endedBy } : {}),
            orderedItemIds: [],
          },
          branching,
          sourceRunState: "idle",
        }).available,
      ).toBe(available);
    }
  });

  it("allows active historical forks but keeps reconciling fail-closed", () => {
    const branching = {
      availability: "available" as const,
      boundaries: [
        "selected_completed_turn" as const,
        "latest_provider_snapshot" as const,
      ],
      method: "provider_native" as const,
      sourceMustBeIdle: false,
      settingsInheritance: "native" as const,
      fidelity: {
        instructions: true,
        messages: true,
        toolCalls: true,
        toolResults: true,
        compaction: true,
        attachments: true,
        settings: true,
        limitations: [],
      },
      childIdentity: "application_reserved" as const,
      creationRecovery: "idempotent" as const,
    };
    const turn = {
      id: "turn-settled-before-active",
      revision: 0,
      status: "completed" as const,
      endedBy: "agent_settled" as const,
      orderedItemIds: [],
    };

    expect(
      projectedTurnForkCapability({
        turn,
        branching,
        sourceRunState: "running",
      }),
    ).toMatchObject({ available: true });
    expect(
      projectedThreadForkSourceCapability({
        branching,
        sourceRunState: "running",
      }),
    ).toEqual({
      selectedCompletedTurn: { available: true },
      latestProviderSnapshot: { available: true },
    });
    expect(
      projectedTurnForkCapability({
        turn,
        branching,
        sourceRunState: "reconciling",
      }),
    ).toMatchObject({
      available: false,
      unavailableReason: {
        text: "The source thread must be idle before it can be forked.",
      },
    });
    expect(
      projectedThreadForkSourceCapability({
        branching,
        sourceRunState: "reconciling",
      }),
    ).toEqual({
      selectedCompletedTurn: {
        available: false,
        unavailableReason: {
          text: "The source thread must be idle before it can be forked.",
        },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "The source thread must be idle before it can be forked.",
        },
      },
    });
  });

  it("preserves authenticated agent-tool correlation in normalized items", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-agent-tool",
    });
    const backendItemId = "assistant-agent-tool:0";
    const timeline = projector.replace(
      {
        orderedBackendTurnIds: ["user-agent-tool"],
        turnsById: {
          "user-agent-tool": {
            backendTurnId: "user-agent-tool",
            status: "completed",
            orderedBackendItemIds: [backendItemId],
          },
        },
        itemsById: {
          [backendItemId]: {
            backendItemId,
            backendTurnId: "user-agent-tool",
            semanticKind: "tool",
            status: "completed",
            sourceOrder: 0,
            phase: "completed",
            toolName: { text: "Reference check" },
            title: { text: "Reference check" },
            category: "other",
            agentToolInvocation: {
              toolId: "reference.check",
              schemaVersion: 3,
              invocationId: "inv-projected",
            },
          },
        },
        runState: "idle",
      },
      -1,
    );
    const item = timeline.itemsById[Object.keys(timeline.itemsById)[0]!];
    expect(item).toMatchObject({
      kind: "tool",
      agentToolInvocation: {
        toolId: "reference.check",
        schemaVersion: 3,
        invocationId: "inv-projected",
      },
    });
  });

  it("preserves ordered reasoning summaries separately from detailed content", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-codex",
      bindingIdentity: "binding-reasoning-summary",
    });
    const backendItemId = "reasoning-1";
    const timeline = projector.replace(
      {
        orderedBackendTurnIds: ["turn-1"],
        turnsById: {
          "turn-1": {
            backendTurnId: "turn-1",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: [backendItemId],
          },
        },
        itemsById: {
          [backendItemId]: {
            backendItemId,
            backendTurnId: "turn-1",
            semanticKind: "reasoning",
            status: "completed",
            sourceOrder: 0,
            summaryParts: [{ text: "First" }, { text: "Second" }],
            markdown: { text: "Detailed reasoning" },
          },
        },
        runState: "idle",
      },
      -1,
    );

    expect(Object.values(timeline.itemsById)[0]).toMatchObject({
      kind: "reasoning",
      summaryParts: [{ text: "First" }, { text: "Second" }],
      markdown: { text: "Detailed reasoning" },
    });
  });

  it("introduces a live user item before later assistant content without requiring a resnapshot", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-1",
    });
    projector.replace(
      {
        orderedBackendTurnIds: [],
        turnsById: {},
        itemsById: {},
        runState: "idle",
      },
      -1,
    );
    const turnStarted = projector.apply({
      handleSequence: 0,
      event: {
        type: "turn_started",
        turn: {
          backendTurnId: "turn-live",
          status: "in_progress",
          orderedBackendItemIds: ["turn-live:user"],
        },
      },
    });
    const user = projector.apply({
      handleSequence: 1,
      event: {
        type: "item_completed",
        item: {
          backendItemId: "turn-live:user",
          backendTurnId: "turn-live",
          semanticKind: "user_message",
          deliveryOperationId: "delivery-operation-1",
          status: "completed",
          sourceOrder: 0,
          content: [{ kind: "text", text: { text: "Question" } }],
        },
      },
    });
    const assistant = projector.apply({
      handleSequence: 2,
      event: {
        type: "item_started",
        item: {
          backendItemId: "turn-live:assistant",
          backendTurnId: "turn-live",
          semanticKind: "assistant_message",
          status: "streaming",
          sourceOrder: 1,
          markdown: { text: "Partial" },
        },
      },
    });
    expect(
      Object.values(projector.timeline().itemsById).find(
        (item) => item.kind === "user_message",
      ),
    ).toMatchObject({ deliveryOperationId: "delivery-operation-1" });

    expect(turnStarted.kind).toBe("events");
    expect(user.kind).toBe("events");
    expect(assistant.kind).toBe("events");
    expect(turnStarted).toMatchObject({
      kind: "events",
      events: [
        {
          type: "turn_upsert",
          turn: { revision: 0, orderedItemIds: [] },
        },
      ],
    });
    expect(
      user.kind === "events" ? user.events.map(({ type }) => type) : [],
    ).toEqual(["item_upsert", "turn_upsert"]);
    if (user.kind === "events") {
      const item = user.events[0];
      const turn = user.events[1];
      expect(item?.type).toBe("item_upsert");
      expect(turn).toMatchObject({
        type: "turn_upsert",
        turn: {
          revision: 1,
          orderedItemIds:
            item?.type === "item_upsert" ? [item.item.id] : undefined,
        },
      });
    }
    const timeline = projector.timeline();
    const turn = timeline.turnsById[timeline.orderedTurnIds[0]!]!;
    expect(
      turn.orderedItemIds.map((itemId) => timeline.itemsById[itemId]?.kind),
    ).toEqual(["user_message", "assistant_message"]);
  });

  it("emits an item before an existing turn first references it", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-codex",
      bindingIdentity: "binding-existing-turn",
    });
    const first = {
      backendItemId: "turn-existing:first",
      backendTurnId: "turn-existing",
      semanticKind: "user_message",
      status: "completed",
      sourceOrder: 0,
      content: [{ kind: "text", text: { text: "Question" } }],
    } as BackendItem;
    projector.replace(
      {
        orderedBackendTurnIds: ["turn-existing"],
        turnsById: {
          "turn-existing": {
            backendTurnId: "turn-existing",
            status: "in_progress",
            orderedBackendItemIds: [first.backendItemId],
          },
        },
        itemsById: { [first.backendItemId]: first },
        runState: "running",
        activeBackendTurnId: "turn-existing",
      },
      -1,
    );

    const expandedTurn = projector.apply({
      handleSequence: 0,
      event: {
        type: "turn_updated",
        turn: {
          backendTurnId: "turn-existing",
          status: "in_progress",
          orderedBackendItemIds: [first.backendItemId, "turn-existing:reply"],
        },
      },
    });
    expect(expandedTurn).toEqual({ kind: "events", events: [] });
    expect(
      projector.timeline().turnsById[projector.timeline().orderedTurnIds[0]!]!,
    ).toMatchObject({ status: "in_progress", revision: 0 });

    const reply = projector.apply({
      handleSequence: 1,
      event: {
        type: "item_completed",
        item: {
          backendItemId: "turn-existing:reply",
          backendTurnId: "turn-existing",
          semanticKind: "assistant_message",
          status: "completed",
          sourceOrder: 1,
          markdown: { text: "Answer" },
        },
      },
    });
    expect(
      reply.kind === "events" ? reply.events.map(({ type }) => type) : [],
    ).toEqual(["item_upsert", "turn_upsert"]);
    if (reply.kind === "events") {
      const item = reply.events[0];
      const turn = reply.events[1];
      expect(item?.type).toBe("item_upsert");
      expect(turn).toMatchObject({
        type: "turn_upsert",
        turn: {
          revision: 1,
          status: "in_progress",
          orderedItemIds:
            item?.type === "item_upsert"
              ? [
                  projector.timeline().turnsById[
                    projector.timeline().orderedTurnIds[0]!
                  ]!.orderedItemIds[0],
                  item.item.id,
                ]
              : undefined,
        },
      });
    }

    const terminalTurn = projector.apply({
      handleSequence: 2,
      event: {
        type: "turn_completed",
        turn: {
          backendTurnId: "turn-existing",
          status: "completed",
          endedBy: "agent_settled",
          orderedBackendItemIds: [first.backendItemId, "turn-existing:reply"],
        },
      },
    });
    expect(terminalTurn).toMatchObject({
      kind: "events",
      events: [
        {
          type: "turn_upsert",
          turn: {
            revision: 2,
            status: "completed",
            endedBy: "agent_settled",
          },
        },
      ],
    });
  });

  it("fails closed when settlement leaves referenced items unresolved", () => {
    const terminal = new ConversationProjector({
      backendInstanceId: "local-codex",
      bindingIdentity: "binding-terminal-gap",
    });
    terminal.replace(
      {
        orderedBackendTurnIds: [],
        turnsById: {},
        itemsById: {},
        runState: "idle",
      },
      -1,
    );
    expect(
      terminal.apply({
        handleSequence: 0,
        event: {
          type: "turn_completed",
          turn: {
            backendTurnId: "turn-terminal-gap",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: ["missing-terminal-item"],
          },
        },
      }),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "backend_turn_items_unresolved_at_settlement",
    });

    const idle = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-idle-gap",
    });
    idle.replace(
      {
        orderedBackendTurnIds: [],
        turnsById: {},
        itemsById: {},
        runState: "idle",
      },
      -1,
    );
    expect(
      idle.apply({
        handleSequence: 0,
        event: {
          type: "turn_started",
          turn: {
            backendTurnId: "turn-idle-gap",
            status: "in_progress",
            orderedBackendItemIds: ["missing-idle-item"],
          },
        },
      }),
    ).toMatchObject({ kind: "events" });
    expect(
      idle.apply({
        handleSequence: 1,
        event: {
          type: "run_state_changed",
          state: "running",
          activeBackendTurnId: "turn-idle-gap",
        },
      }),
    ).toMatchObject({ kind: "events" });
    expect(idle.timeline().runState).toBe("running");
    expect(
      idle.apply({
        handleSequence: 2,
        event: { type: "run_state_changed", state: "idle" },
      }),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "backend_turn_items_unresolved_at_settlement",
    });
    expect(idle.timeline().runState).toBe("running");
  });

  it("uses stable opaque durable identity across authoritative generations", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-1",
    });
    const first = projector.replace(snapshot(), 4);
    const second = projector.replace(snapshot(), 9);

    expect(second.generation).not.toBe(first.generation);
    expect(second.orderedTurnIds).toEqual(first.orderedTurnIds);
    expect(Object.keys(second.itemsById)).toEqual(Object.keys(first.itemsById));
    expect(JSON.stringify(second)).not.toContain("assistant-1");
    expect(JSON.stringify(second)).not.toContain("user-1");
  });

  it("keeps a live completed turn locator stable after reconstruction", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-live-restart",
    });
    projector.replace(
      {
        orderedBackendTurnIds: [],
        turnsById: {},
        itemsById: {},
        runState: "idle",
      },
      -1,
    );
    projector.apply({
      handleSequence: 0,
      event: {
        type: "turn_started",
        turn: {
          backendTurnId: "live-durable-turn",
          status: "in_progress",
          orderedBackendItemIds: [],
        },
      },
    });
    projector.apply({
      handleSequence: 1,
      event: {
        type: "turn_completed",
        turn: {
          backendTurnId: "live-durable-turn",
          status: "completed",
          endedBy: "agent_settled",
          orderedBackendItemIds: [],
        },
      },
    });
    const liveTurnId = projector.timeline().orderedTurnIds[0]!;

    const reconstructed = projector.replace(
      {
        orderedBackendTurnIds: ["live-durable-turn"],
        turnsById: {
          "live-durable-turn": {
            backendTurnId: "live-durable-turn",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: [],
          },
        },
        itemsById: {},
        runState: "idle",
      },
      -1,
    );
    expect(reconstructed.orderedTurnIds).toEqual([liveTurnId]);
  });

  it("normalizes paged history with the same durable identities and no backend IDs", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-1",
    });
    const live = projector.replace(snapshot(), 4);
    const page = projector.projectHistoryPage(
      {
        orderedBackendTurnIds: snapshot().orderedBackendTurnIds,
        turnsById: snapshot().turnsById,
        itemsById: snapshot().itemsById,
        previousCursor: "backend-native-cursor",
      },
      {
        branching: {
          availability: "available",
          boundaries: ["selected_completed_turn"],
          method: "provider_native",
          sourceMustBeIdle: true,
          settingsInheritance: "native",
          fidelity: {
            instructions: true,
            messages: true,
            toolCalls: true,
            toolResults: true,
            compaction: true,
            attachments: true,
            settings: true,
            limitations: [],
          },
          childIdentity: "application_reserved",
          creationRecovery: "idempotent",
        },
        sourceRunState: "idle",
      },
    );

    expect(page.orderedTurnIds).toEqual(live.orderedTurnIds);
    expect(Object.keys(page.itemsById)).toEqual(Object.keys(live.itemsById));
    expect(page.previousCursor).toBe("backend-native-cursor");
    expect(page.forksByTurnId[page.orderedTurnIds[0]!]).toMatchObject({
      available: true,
      expectedTurnRevision: 0,
    });
    expect(JSON.stringify(page.turnsById)).not.toContain("user-1");
    expect(JSON.stringify(page.itemsById)).not.toContain("assistant-1");
  });

  it("keeps one provisional item identity through full replacement updates", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-1",
    });
    projector.replace(
      {
        orderedBackendTurnIds: ["user-1"],
        turnsById: {
          "user-1": {
            backendTurnId: "user-1",
            status: "in_progress",
            orderedBackendItemIds: [],
          },
        },
        itemsById: {},
        runState: "running",
        activeBackendTurnId: "user-1",
      },
      -1,
    );

    const start = projector.apply({
      handleSequence: 0,
      event: {
        type: "item_started",
        item: {
          backendItemId: "stream:0",
          backendTurnId: "user-1",
          semanticKind: "command",
          status: "streaming",
          sourceOrder: 0,
          phase: "arguments_streaming",
          command: { text: "npm" },
        } as BackendItem,
      },
    });
    const update = projector.apply({
      handleSequence: 1,
      event: {
        type: "item_updated",
        item: {
          backendItemId: "stream:0",
          backendTurnId: "user-1",
          semanticKind: "command",
          status: "streaming",
          sourceOrder: 0,
          phase: "result_streaming",
          command: { text: "npm test" },
          output: { text: "passing" },
        } as BackendItem,
      },
    });

    expect(start.kind).toBe("events");
    expect(update.kind).toBe("events");
    const startItem =
      start.kind === "events" && start.events[0]?.type === "item_upsert"
        ? start.events[0].item
        : undefined;
    const updatedItem =
      update.kind === "events" && update.events[0]?.type === "item_upsert"
        ? update.events[0].item
        : undefined;
    expect(updatedItem?.id).toBe(startItem?.id);
    expect(updatedItem?.revision).toBe(1);
    expect(updatedItem).toMatchObject({
      kind: "command",
      output: { text: "passing" },
    });
  });

  it("requests a resnapshot for sequence gaps and state regression", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-1",
    });
    projector.replace(snapshot(), -1);
    expect(
      projector.apply({
        handleSequence: 2,
        event: { type: "resnapshot_required", reason: "sequence_gap" },
      }),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "backend_sequence_gap",
    });
    expect(
      projector.apply({
        handleSequence: 0,
        event: { type: "resnapshot_required", reason: "sequence_gap" },
      }),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "projector_invalidated",
    });
  });

  it("leaves the prior generation intact when replacement validation fails", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-1",
    });
    const installed = projector.replace(snapshot(), 2);
    expect(() =>
      projector.replace(
        {
          ...snapshot(),
          turnsById: {},
        },
        8,
      ),
    ).toThrow("Backend timeline references a missing turn.");
    expect(projector.timeline()).toEqual(installed);
  });

  it("advances a duplicate backend turn event without emitting a new revision", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-1",
    });
    const installed = projector.replace(snapshot(), -1);
    const result = projector.apply({
      handleSequence: 0,
      event: {
        type: "turn_completed",
        turn: snapshot().turnsById["user-1"]!,
      },
    });

    expect(result).toEqual({ kind: "events", events: [] });
    expect(projector.timeline().turnsById).toEqual(installed.turnsById);
    expect(
      projector.apply({
        handleSequence: 1,
        event: { type: "run_state_changed", state: "idle" },
      }),
    ).toMatchObject({ kind: "events" });
  });

  it("invalidates semantic identity changes and turn reordering", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-1",
    });
    projector.replace(snapshot(), -1);
    expect(
      projector.apply({
        handleSequence: 0,
        event: {
          type: "item_updated",
          item: {
            ...snapshot().itemsById["assistant-1:0"]!,
            semanticKind: "reasoning",
            markdown: { text: "Changed kind" },
          } as BackendItem,
        },
      }),
    ).toMatchObject({
      kind: "resnapshot_required",
      reason: "backend_item_identity_changed",
    });

    const ordered = new ConversationProjector({
      backendInstanceId: "local-pi",
      bindingIdentity: "binding-2",
    });
    const first = snapshot().itemsById["assistant-1:0"]!;
    const second = {
      ...first,
      backendItemId: "assistant-1:1",
      sourceOrder: 1,
      markdown: { text: "Second" },
    } as BackendItem;
    ordered.replace(
      {
        ...snapshot(),
        turnsById: {
          "user-1": {
            ...snapshot().turnsById["user-1"]!,
            orderedBackendItemIds: [first.backendItemId, second.backendItemId],
          },
        },
        itemsById: {
          [first.backendItemId]: first,
          [second.backendItemId]: second,
        },
      },
      -1,
    );
    expect(
      ordered.apply({
        handleSequence: 0,
        event: {
          type: "turn_completed",
          turn: {
            ...snapshot().turnsById["user-1"]!,
            status: "completed",
            orderedBackendItemIds: [second.backendItemId, first.backendItemId],
          },
        },
      }),
    ).toMatchObject({
      kind: "resnapshot_required",
      reason: "backend_turn_identity_changed",
    });
  });

  it("accepts an authoritative started-at timestamp after an identity-only turn receipt", () => {
    const initial = snapshot();
    const backendTurn = initial.turnsById["user-1"]!;
    const projector = new ConversationProjector({
      backendInstanceId: "codex-local-uds",
      bindingIdentity: "binding-started-at",
    });
    const identityOnlyTurn = {
      backendTurnId: backendTurn.backendTurnId,
      status: "in_progress" as const,
      orderedBackendItemIds: backendTurn.orderedBackendItemIds,
    };
    projector.replace(
      {
        ...initial,
        runState: "running",
        activeBackendTurnId: backendTurn.backendTurnId,
        turnsById: {
          [backendTurn.backendTurnId]: identityOnlyTurn,
        },
      },
      -1,
    );

    const result = projector.apply({
      handleSequence: 0,
      event: {
        type: "turn_started",
        turn: {
          ...identityOnlyTurn,
          startedAt: "2026-08-04T02:43:54.000Z",
        },
      },
    });

    expect(result).toMatchObject({ kind: "events" });
    expect(Object.values(projector.timeline().turnsById)).toContainEqual(
      expect.objectContaining({
        startedAt: "2026-08-04T02:43:54.000Z",
      }),
    );
    expect(
      projector.apply({
        handleSequence: 1,
        event: { type: "turn_updated", turn: identityOnlyTurn },
      }),
    ).toMatchObject({
      kind: "resnapshot_required",
      reason: "backend_turn_identity_changed",
    });
  });
});
