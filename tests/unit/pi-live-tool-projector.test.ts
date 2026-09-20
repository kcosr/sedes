import { createHmac } from "node:crypto";
import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  backendConversationEventSchema,
  type BackendConversationEvent,
} from "../../src/shared/protocol/backend.js";
import { PiLiveToolProjector } from "../../src/server/backends/pi/pi-live-tool-projector.js";
import {
  createPiAgentToolInvocationMarker,
  piAgentToolInvocationMarkerType,
} from "../../src/server/backends/pi/pi-agent-tool-invocation-marker.js";
import {
  PiToolIdentityCatalog,
  type PiToolInfoLike,
} from "../../src/server/backends/pi/pi-tool-identities.js";

function tool(name: string): PiToolInfoLike {
  return {
    name,
    sourceInfo: {
      source: "builtin",
      path: `<builtin:${name}>`,
    },
  };
}

function partialWith(
  contentIndex: number,
  block: unknown,
): Record<string, unknown> {
  const content: unknown[] = [];
  content[contentIndex] = block;
  return { role: "assistant", content };
}

function toolCallUpdate(
  type: "toolcall_start" | "toolcall_delta" | "toolcall_end",
  contentIndex: number,
  block: unknown,
  toolCall?: unknown,
): AgentSessionEvent {
  const partial = partialWith(contentIndex, block);
  return {
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type,
      contentIndex,
      partial,
      ...(type === "toolcall_delta" ? { delta: "ignored" } : {}),
      ...(type === "toolcall_end" ? { toolCall } : {}),
    },
  } as unknown as AgentSessionEvent;
}

function executionEvent(event: Record<string, unknown>): AgentSessionEvent {
  return event as unknown as AgentSessionEvent;
}

function messageEnd(): AgentSessionEvent {
  return {
    type: "message_end",
    message: { role: "assistant", content: [] },
  } as unknown as AgentSessionEvent;
}

function expectCanonical(events: readonly BackendConversationEvent[]): void {
  for (const event of events) {
    expect(() => backendConversationEventSchema.parse(event)).not.toThrow();
  }
}

function itemEvent(
  events: readonly BackendConversationEvent[],
): Extract<
  BackendConversationEvent,
  { type: "item_started" | "item_updated" | "item_completed" }
> {
  const event = events[0];
  if (
    !event ||
    (event.type !== "item_started" &&
      event.type !== "item_updated" &&
      event.type !== "item_completed")
  ) {
    throw new Error("expected_item_event");
  }
  return event;
}

function projector(
  names: readonly string[] = ["read", "bash"],
): PiLiveToolProjector {
  return new PiLiveToolProjector({
    identities: new PiToolIdentityCatalog(names.map(tool)),
    now: () => "2026-07-30T15:00:00.000Z",
  });
}

const toolIdentityAuthentication = {
  conversationId: "live-conversation",
  installationKey: new Uint8Array(32).fill(0x51),
} as const;

function agentToolProjector(): PiLiveToolProjector {
  return new PiLiveToolProjector({
    identities: new PiToolIdentityCatalog(
      [
        {
          name: "sedes_reference_check",
          sourceInfo: {
            source: "sdk",
            path: "<sdk:sedes_reference_check>",
          },
        },
      ],
      [],
      [
        {
          toolName: "sedes_reference_check",
          toolId: "reference.check",
          schemaVersion: 3,
        },
      ],
    ),
    now: () => "2026-07-30T15:00:00.000Z",
  });
}

function agentToolBranch(invocationId: string): SessionEntry[] {
  return [
    {
      type: "message",
      id: "assistant-entry",
      parentId: null,
      timestamp: "2026-07-30T15:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "agent-call",
            name: "sedes_reference_check",
            arguments: { reference: "A" },
          },
        ],
      },
    } as unknown as SessionEntry,
    {
      type: "custom",
      id: "invocation-entry",
      parentId: "assistant-entry",
      timestamp: "2026-07-30T15:00:01.000Z",
      customType: piAgentToolInvocationMarkerType,
      data: createPiAgentToolInvocationMarker(
        {
          assistantEntryId: "assistant-entry",
          toolCallId: "agent-call",
          toolName: "sedes_reference_check",
          toolId: "reference.check",
          schemaVersion: 3,
          invocationId,
        },
        toolIdentityAuthentication,
      ),
    } as SessionEntry,
  ];
}

describe("Pi live tool projection", () => {
  it("upgrades a native Harness call only from exact authenticated legacy evidence", () => {
    const live = agentToolProjector();
    live.beginAssistantStream({
      streamEpoch: "legacy-agent-epoch",
      backendTurnId: "legacy-agent-turn",
    });
    live.consume(
      toolCallUpdate("toolcall_start", 0, {
        type: "toolCall",
        id: "legacy-agent-call",
        name: "harness_reference_check",
        arguments: {},
      }),
    );
    const identityType = "harness.tool_identity.v2";
    const invocationType = "harness.agent_tool_invocation.v1";
    const identity = {
      registrationId:
        "harness:agent-tool:reference.check:3:harness_reference_check",
      origin: "harness_agent_tool",
      canonicalKind: "agent_tool",
      displayName: "Reference check",
      agentToolId: "reference.check",
      agentToolSchemaVersion: 3,
    };
    const identityTag = createHmac(
      "sha256",
      toolIdentityAuthentication.installationKey,
    )
      .update(
        JSON.stringify([
          identityType,
          toolIdentityAuthentication.conversationId,
          "legacy-assistant-entry",
          "legacy-agent-call",
          "harness_reference_check",
          [
            identity.registrationId,
            identity.origin,
            identity.canonicalKind,
            identity.displayName,
            null,
            identity.agentToolId,
            identity.agentToolSchemaVersion,
          ],
        ]),
      )
      .digest("base64url");
    const invocationFields = {
      assistantEntryId: "legacy-assistant-entry",
      toolCallId: "legacy-agent-call",
      toolName: "harness_reference_check",
      toolId: "reference.check",
      schemaVersion: 3,
      invocationId: "legacy-live-invocation",
    };
    const invocationTag = createHmac(
      "sha256",
      toolIdentityAuthentication.installationKey,
    )
      .update(
        JSON.stringify([
          invocationType,
          toolIdentityAuthentication.conversationId,
          ...Object.values(invocationFields),
        ]),
      )
      .digest("base64url");
    const branch = [
      {
        type: "message",
        id: "legacy-assistant-entry",
        parentId: null,
        timestamp: "2026-07-30T15:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "legacy-agent-call",
              name: "harness_reference_check",
              arguments: {},
            },
          ],
        },
      },
      {
        type: "custom",
        id: "legacy-identity-entry",
        parentId: "legacy-assistant-entry",
        timestamp: "2026-07-30T15:00:01.000Z",
        customType: identityType,
        data: {
          version: 2,
          assistantEntryId: "legacy-assistant-entry",
          toolCallId: "legacy-agent-call",
          toolName: "harness_reference_check",
          identity,
          authentication: { algorithm: "hmac-sha256", tag: identityTag },
        },
      },
      {
        type: "custom",
        id: "legacy-invocation-entry",
        parentId: "legacy-identity-entry",
        timestamp: "2026-07-30T15:00:02.000Z",
        customType: invocationType,
        data: {
          version: 1,
          ...invocationFields,
          authentication: { algorithm: "hmac-sha256", tag: invocationTag },
        },
      },
    ] as SessionEntry[];
    expect(
      itemEvent(
        live.consumeAgentToolInvocationMarkers(
          branch,
          toolIdentityAuthentication,
        ),
      ),
    ).toMatchObject({
      type: "item_updated",
      item: {
        agentToolInvocation: { invocationId: "legacy-live-invocation" },
      },
    });
  });

  it("adds authenticated agent-tool correlation and invalidates a later duplicate", () => {
    const live = agentToolProjector();
    live.beginAssistantStream({
      streamEpoch: "agent-epoch",
      backendTurnId: "agent-turn",
    });
    live.consume(
      toolCallUpdate("toolcall_start", 0, {
        type: "toolCall",
        id: "agent-call",
        name: "sedes_reference_check",
        arguments: { reference: "A" },
      }),
    );
    const branch = agentToolBranch("inv-live");
    const correlated = live.consumeAgentToolInvocationMarkers(
      branch,
      toolIdentityAuthentication,
    );
    expectCanonical(correlated);
    expect(itemEvent(correlated)).toMatchObject({
      type: "item_updated",
      item: {
        semanticKind: "tool",
        agentToolInvocation: {
          toolId: "reference.check",
          schemaVersion: 3,
          invocationId: "inv-live",
        },
      },
    });
    expect(
      live.consumeAgentToolInvocationMarkers(
        [...branch, { ...branch[1]!, id: "duplicate-entry" }],
        toolIdentityAuthentication,
      ),
    ).toEqual([
      { type: "resnapshot_required", reason: "ambiguous_correlation" },
    ]);
  });

  it("does not project copied or tampered live invocation markers", () => {
    const copied = agentToolProjector();
    copied.beginAssistantStream({
      streamEpoch: "copied-epoch",
      backendTurnId: "copied-turn",
    });
    copied.consume(
      toolCallUpdate("toolcall_start", 0, {
        type: "toolCall",
        id: "agent-call",
        name: "sedes_reference_check",
        arguments: {},
      }),
    );
    expect(
      copied.consumeAgentToolInvocationMarkers(agentToolBranch("inv-copy"), {
        ...toolIdentityAuthentication,
        conversationId: "different-conversation",
      }),
    ).toEqual([]);

    const tamperedBranch = agentToolBranch("inv-original");
    const marker = tamperedBranch[1]!;
    tamperedBranch[1] = {
      ...marker,
      data: {
        ...(marker.type === "custom"
          ? (marker.data as Record<string, unknown>)
          : {}),
        invocationId: "inv-tampered",
      },
    } as SessionEntry;
    expect(
      copied.consumeAgentToolInvocationMarkers(
        tamperedBranch,
        toolIdentityAuthentication,
      ),
    ).toEqual([]);
  });

  it("uses stream epoch plus content index for stable identity and source order", () => {
    const live = projector();
    live.beginAssistantStream({
      streamEpoch: "response/17",
      backendTurnId: "turn-1",
      sourceOrderBase: 10,
    });

    const readStart = live.consume(
      toolCallUpdate("toolcall_start", 2, {
        type: "toolCall",
        id: "call-read",
        name: "read",
        arguments: {},
      }),
    );
    const bashStart = live.consume(
      toolCallUpdate("toolcall_start", 4, {
        type: "toolCall",
        id: "call-bash",
        name: "bash",
        arguments: {},
      }),
    );
    const bashDelta = live.consume(
      toolCallUpdate("toolcall_delta", 4, {
        type: "toolCall",
        id: "call-bash",
        name: "bash",
        arguments: { command: "printf hello" },
      }),
    );
    const readDelta = live.consume(
      toolCallUpdate("toolcall_delta", 2, {
        type: "toolCall",
        id: "call-read",
        name: "read",
        arguments: { path: "README.md" },
      }),
    );
    const readEnd = live.consume(
      toolCallUpdate(
        "toolcall_end",
        2,
        {
          type: "toolCall",
          id: "call-read",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "toolCall",
          id: "call-read",
          name: "read",
          arguments: { path: "README.md" },
        },
      ),
    );

    const all = [
      ...readStart,
      ...bashStart,
      ...bashDelta,
      ...readDelta,
      ...readEnd,
    ];
    expectCanonical(all);
    expect(itemEvent(readStart)).toMatchObject({
      type: "item_started",
      item: {
        backendItemId: "live:ea12301c61458a7483a8db05c3b05d2e:2",
        backendTurnId: "turn-1",
        sourceOrder: 12,
        phase: "arguments_streaming",
      },
    });
    expect(itemEvent(bashStart).item).toMatchObject({
      backendItemId: "live:ea12301c61458a7483a8db05c3b05d2e:4",
      sourceOrder: 14,
    });
    expect(itemEvent(bashDelta)).toMatchObject({
      type: "item_updated",
      item: {
        semanticKind: "command",
        command: { text: "printf hello" },
      },
    });
    expect(itemEvent(readDelta).item).toMatchObject({
      semanticKind: "file_read",
      path: { text: "README.md" },
    });
    expect(itemEvent(readEnd).item).toMatchObject({
      phase: "arguments_complete",
      sourceOrder: 12,
    });
  });

  it("replaces cumulative partial results instead of appending them", () => {
    const live = projector(["bash"]);
    live.beginAssistantStream({
      streamEpoch: "epoch-1",
      backendTurnId: "turn-1",
    });
    live.consume(
      toolCallUpdate(
        "toolcall_end",
        0,
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "printf lines" },
        },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "printf lines" },
        },
      ),
    );

    const started = live.consume(
      executionEvent({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "printf lines" },
      }),
    );
    const first = live.consume(
      executionEvent({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "printf lines" },
        partialResult: {
          content: [{ type: "text", text: "line one" }],
        },
      }),
    );
    const second = live.consume(
      executionEvent({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "printf lines" },
        partialResult: {
          content: [{ type: "text", text: "line one\nline two" }],
        },
      }),
    );
    const completed = live.consume(
      executionEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: {
          content: [{ type: "text", text: "final output" }],
        },
        isError: false,
      }),
    );

    expectCanonical([...started, ...first, ...second, ...completed]);
    expect(itemEvent(started).item).toMatchObject({
      phase: "preflight_or_executing",
    });
    expect(itemEvent(first).item).toMatchObject({
      phase: "result_streaming",
      output: { text: "line one" },
    });
    expect(itemEvent(second).item).toMatchObject({
      output: { text: "line one\nline two" },
    });
    expect(JSON.stringify(itemEvent(second).item)).not.toContain(
      "line oneline one",
    );
    expect(itemEvent(completed)).toMatchObject({
      type: "item_completed",
      item: {
        status: "completed",
        phase: "completed",
        output: { text: "final output" },
      },
    });
  });

  it("projects cumulative partial write arguments as a stable live file preview", () => {
    const live = projector(["write"]);
    live.beginAssistantStream({
      streamEpoch: "write-epoch",
      backendTurnId: "write-turn",
    });

    const started = live.consume(
      toolCallUpdate("toolcall_start", 0, {
        type: "toolCall",
        id: "call-write",
        name: "write",
        arguments: {},
      }),
    );
    const path = live.consume(
      toolCallUpdate("toolcall_delta", 0, {
        type: "toolCall",
        id: "call-write",
        name: "write",
        arguments: {
          path: "notes.md",
          content: "# Notes",
        },
      }),
    );
    const nextLine = live.consume(
      toolCallUpdate("toolcall_delta", 0, {
        type: "toolCall",
        id: "call-write",
        name: "write",
        arguments: {
          path: "notes.md",
          content: "# Notes\nstreamed line",
        },
      }),
    );

    expectCanonical([...started, ...path, ...nextLine]);
    expect(itemEvent(started)).toMatchObject({
      type: "item_started",
      item: {
        semanticKind: "file_change",
        backendItemId: "live:write-epoch:0",
        phase: "arguments_streaming",
      },
    });
    expect(itemEvent(path)).toMatchObject({
      type: "item_updated",
      item: {
        semanticKind: "file_change",
        backendItemId: "live:write-epoch:0",
        path: { text: "notes.md" },
        contentPreview: { text: "# Notes" },
      },
    });
    expect(itemEvent(nextLine)).toMatchObject({
      type: "item_updated",
      item: {
        semanticKind: "file_change",
        backendItemId: "live:write-epoch:0",
        contentPreview: { text: "# Notes\nstreamed line" },
      },
    });
  });

  it("starts a correlated item when execution events arrive without argument events", () => {
    const live = projector(["bash"]);
    live.beginAssistantStream({
      streamEpoch: "epoch-2",
      backendTurnId: "turn-2",
      sourceOrderBase: 5,
    });

    const events = live.consume(
      executionEvent({
        type: "tool_execution_start",
        toolCallId: "late-call",
        toolName: "bash",
        args: { command: "pwd" },
      }),
    );

    expectCanonical(events);
    expect(itemEvent(events)).toMatchObject({
      type: "item_started",
      item: {
        backendItemId: "live:epoch-2:0",
        sourceOrder: 5,
        phase: "preflight_or_executing",
        command: { text: "pwd" },
      },
    });
  });

  it("publishes only after delayed tool identity becomes available", () => {
    const live = projector(["read"]);
    live.beginAssistantStream({
      streamEpoch: "epoch-3",
      backendTurnId: "turn-3",
    });

    expect(
      live.consume(
        toolCallUpdate("toolcall_start", 0, {
          type: "toolCall",
          arguments: {},
        }),
      ),
    ).toEqual([]);
    const events = live.consume(
      toolCallUpdate("toolcall_delta", 0, {
        type: "toolCall",
        id: "delayed-call",
        name: "read",
        arguments: { path: "src/index.ts" },
      }),
    );

    expectCanonical(events);
    expect(itemEvent(events)).toMatchObject({
      type: "item_started",
      item: {
        semanticKind: "file_read",
        path: { text: "src/index.ts" },
      },
    });
  });

  it("requests one resnapshot for ambiguous or regressive correlation", () => {
    const live = projector(["read"]);
    live.beginAssistantStream({
      streamEpoch: "epoch-4",
      backendTurnId: "turn-4",
    });
    live.consume(
      toolCallUpdate("toolcall_start", 0, {
        type: "toolCall",
        id: "duplicate-call",
        name: "read",
        arguments: { path: "one" },
      }),
    );

    const contradiction = live.consume(
      toolCallUpdate("toolcall_start", 1, {
        type: "toolCall",
        id: "duplicate-call",
        name: "read",
        arguments: { path: "two" },
      }),
    );
    expect(contradiction).toEqual([
      { type: "resnapshot_required", reason: "ambiguous_correlation" },
    ]);
    expectCanonical(contradiction);
    expect(
      live.consume(
        executionEvent({
          type: "tool_execution_start",
          toolCallId: "duplicate-call",
          toolName: "read",
          args: { path: "one" },
        }),
      ),
    ).toEqual([]);

    const regressive = projector(["bash"]);
    regressive.beginAssistantStream({
      streamEpoch: "epoch-5",
      backendTurnId: "turn-5",
    });
    regressive.consume(
      executionEvent({
        type: "tool_execution_start",
        toolCallId: "call-5",
        toolName: "bash",
        args: { command: "pwd" },
      }),
    );
    expect(
      regressive.consume(
        toolCallUpdate("toolcall_delta", 0, {
          type: "toolCall",
          id: "call-5",
          name: "bash",
          arguments: { command: "pwd" },
        }),
      ),
    ).toEqual([{ type: "resnapshot_required", reason: "contradictory_state" }]);
  });

  it("finalizes interruption and refuses settlement with partial operations", () => {
    const live = projector(["bash"]);
    live.beginAssistantStream({
      streamEpoch: "epoch-6",
      backendTurnId: "turn-6",
    });
    live.consume(
      executionEvent({
        type: "tool_execution_start",
        toolCallId: "call-6",
        toolName: "bash",
        args: { command: "sleep 30" },
      }),
    );

    expect(live.settlementCheck()).toEqual([
      { type: "resnapshot_required", reason: "persistence_pending" },
    ]);

    const interrupted = projector(["bash"]);
    interrupted.beginAssistantStream({
      streamEpoch: "epoch-7",
      backendTurnId: "turn-7",
    });
    interrupted.consume(
      executionEvent({
        type: "tool_execution_start",
        toolCallId: "call-7",
        toolName: "bash",
        args: { command: "sleep 30" },
      }),
    );
    const events = interrupted.interruptActive();
    expectCanonical(events);
    expect(itemEvent(events)).toMatchObject({
      type: "item_completed",
      item: {
        status: "interrupted",
        phase: "interrupted",
        error: {
          category: "interrupted",
          code: "pi_tool_interrupted",
        },
      },
    });
    expect(interrupted.settlementCheck()).toEqual([]);
  });

  it("rejects argument events after the assistant message has ended", () => {
    const live = projector(["read"]);
    live.beginAssistantStream({
      streamEpoch: "epoch-8",
      backendTurnId: "turn-8",
    });
    live.consume(messageEnd());

    const events = live.consume(
      toolCallUpdate("toolcall_start", 0, {
        type: "toolCall",
        id: "late",
        name: "read",
        arguments: { path: "late" },
      }),
    );
    expect(events).toEqual([
      { type: "resnapshot_required", reason: "contradictory_state" },
    ]);
    expectCanonical(events);
  });

  it("requests resnapshot instead of crashing when interrupted before identity arrives", () => {
    const live = projector(["read"]);
    live.beginAssistantStream({
      streamEpoch: "epoch-no-identity",
      backendTurnId: "turn-no-identity",
    });
    expect(
      live.consume(
        toolCallUpdate("toolcall_start", 0, {
          type: "toolCall",
          arguments: {},
        }),
      ),
    ).toEqual([]);
    expect(live.interruptActive()).toEqual([
      { type: "resnapshot_required", reason: "ambiguous_correlation" },
    ]);
  });
});
