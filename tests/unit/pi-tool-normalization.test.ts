import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  backendConversationSnapshotSchema,
  backendItemSchema,
} from "../../src/shared/protocol/backend.js";
import { PiHistoryProjector } from "../../src/server/backends/pi/pi-history-projector.js";
import { DEFAULT_PAYLOAD_LIMITS } from "../../src/server/conversations/payload-policy.js";
import {
  createPiAgentToolInvocationMarker,
  piAgentToolInvocationMarkerType,
  readPiAgentToolInvocationMarker,
  type PiAgentToolInvocationMarker,
} from "../../src/server/backends/pi/pi-agent-tool-invocation-marker.js";
import {
  PiToolIdentityCatalog,
  type PiToolInfoLike,
} from "../../src/server/backends/pi/pi-tool-identities.js";
import { PiToolSemanticMapperRegistry } from "../../src/server/backends/pi/pi-tool-mappers.js";
import {
  createPiSubmissionMarker,
  piSubmissionMarkerType,
  type PiSubmissionMarker,
} from "../../src/server/backends/pi/pi-submission-marker.js";
import {
  createPiSubmissionAttestation,
  piSubmissionAttestationType,
} from "../../src/server/backends/pi/pi-submission-attestation.js";
import {
  createPiContextExcerptMarker,
  piContextExcerptMarkerType,
} from "../../src/server/backends/pi/pi-context-excerpt-marker.js";
import { formatPiContextExcerptPrompt } from "../../src/server/backends/pi/pi-context-excerpt-message.js";
import { formatPiTaskContextPrompt } from "../../src/server/backends/pi/pi-task-context-message.js";
import {
  createPiTaskContextMarker,
  piTaskContextMarkerType,
} from "../../src/server/backends/pi/pi-task-context-marker.js";
import {
  createPiToolIdentityMarker,
  piToolIdentityMarkerType,
  type PiToolIdentityMarker,
} from "../../src/server/backends/pi/pi-tool-identity-marker.js";

const toolIdentityAuthentication = {
  conversationId: "test-conversation",
  installationKey: new Uint8Array(32).fill(0x42),
} as const;

function historyProjector(): PiHistoryProjector {
  return new PiHistoryProjector({ toolIdentityAuthentication });
}

function tool(
  name: string,
  source = "builtin",
  sourcePath = `<builtin:${name}>`,
): PiToolInfoLike {
  return {
    name,
    sourceInfo: {
      source,
      path: sourcePath,
    },
  };
}

function entry(
  id: string,
  message: unknown,
  parentId: string | null = null,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
    message,
  } as SessionEntry;
}

function identityMarker(
  id: string,
  assistantEntryId: string,
  toolCallId: string,
  toolName: string,
  identity: PiToolIdentityMarker["identity"],
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
    customType: piToolIdentityMarkerType,
    data: createPiToolIdentityMarker(
      {
        assistantEntryId,
        toolCallId,
        toolName,
        identity,
      },
      toolIdentityAuthentication,
    ) satisfies PiToolIdentityMarker,
  } as SessionEntry;
}

function invocationMarker(
  id: string,
  assistantEntryId: string,
  toolCallId: string,
  invocationId: string,
  authentication = toolIdentityAuthentication,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
    customType: piAgentToolInvocationMarkerType,
    data: createPiAgentToolInvocationMarker(
      {
        assistantEntryId,
        toolCallId,
        toolName: "sedes_reference_check",
        toolId: "reference.check",
        schemaVersion: 3,
        invocationId,
      },
      authentication,
    ) satisfies PiAgentToolInvocationMarker,
  } as SessionEntry;
}

describe("Pi trusted tool identities", () => {
  it("recognizes exact built-in provenance and refuses a built-in-looking extension", () => {
    const catalog = new PiToolIdentityCatalog([
      tool("read"),
      tool("bash", "project", "/workspace/.pi/extensions/bash.ts"),
    ]);

    expect(catalog.require("read")).toMatchObject({
      origin: "pi_builtin",
      canonicalKind: "read",
      registrationId: "pi:builtin:read",
    });
    expect(catalog.require("bash")).toMatchObject({
      origin: "extension",
      displayName: "bash",
    });
    expect(catalog.require("bash").canonicalKind).toBeUndefined();
  });

  it("requires an exact registration tuple for trusted integrations", () => {
    const catalog = new PiToolIdentityCatalog(
      [tool("lookup", "sedes", "<sdk:sedes-web-search>")],
      [
        {
          sourcePath: "<sdk:sedes-web-search>",
          source: "sedes",
          toolName: "lookup",
          canonicalKind: "web_search",
          displayName: "Web search",
        },
      ],
    );
    expect(catalog.require("lookup")).toMatchObject({
      origin: "sedes_integration",
      canonicalKind: "web_search",
      displayName: "Web search",
    });
  });

  it("reserves Sedes agent tools to exact SDK descriptors", () => {
    const descriptor = {
      toolName: "sedes_reference_check",
      toolId: "reference.check",
      schemaVersion: 3,
      displayName: "Reference check",
    } as const;
    const catalog = new PiToolIdentityCatalog(
      [tool("sedes_reference_check", "sdk", "<sdk:sedes_reference_check>")],
      [],
      [descriptor],
    );
    expect(catalog.require("sedes_reference_check")).toEqual({
      registrationId:
        "sedes:agent-tool:reference.check:3:sedes_reference_check",
      origin: "sedes_agent_tool",
      canonicalKind: "agent_tool",
      displayName: "Reference check",
      agentToolId: "reference.check",
      agentToolSchemaVersion: 3,
    });
    expect(
      () =>
        new PiToolIdentityCatalog([
          tool(
            "sedes_reference_check",
            "project",
            "/workspace/extensions/spoof.ts",
          ),
        ]),
    ).toThrowError("pi_agent_tool_descriptor_missing");
    expect(
      () =>
        new PiToolIdentityCatalog(
          [
            tool(
              "sedes_reference_check",
              "project",
              "/workspace/extensions/spoof.ts",
            ),
          ],
          [],
          [descriptor],
        ),
    ).toThrowError("pi_agent_tool_descriptor_mismatch");
    expect(() => new PiToolIdentityCatalog([], [], [descriptor])).toThrowError(
      "pi_agent_tool_descriptor_unmatched",
    );
  });

  it("authenticates only the three closed progressive gateway identities", () => {
    const gateway = {
      gateway: true,
      toolName: "sedes_catalog",
      displayName: "Sedes tool catalog",
      readOnly: true,
    } as const;
    const identity = new PiToolIdentityCatalog(
      [tool("sedes_catalog", "sdk", "<sdk:sedes_catalog>")],
      [],
      [gateway],
    ).require("sedes_catalog");
    expect(identity).toEqual({
      registrationId: "sedes:agent-tool-gateway:sedes_catalog",
      origin: "sedes_agent_tool_gateway",
      canonicalKind: "agent_tool",
      displayName: "Sedes tool catalog",
    });
    const marker = identityMarker(
      "gateway-marker",
      "assistant-entry",
      "gateway-call",
      "sedes_catalog",
      identity,
    );
    expect((marker as { readonly data: unknown }).data).toMatchObject({
      identity,
    });
    expect(
      () =>
        new PiToolIdentityCatalog(
          [tool("sedes_other", "sdk", "<sdk:sedes_other>")],
          [],
          [{ ...gateway, toolName: "sedes_other" } as never],
        ),
    ).toThrow("pi_agent_tool_descriptor_ambiguous");
  });
});

describe("Pi semantic tool mapping", () => {
  it("maps built-ins to semantic items and excludes unsafe result details", () => {
    const catalog = new PiToolIdentityCatalog([
      tool("bash"),
      tool("edit"),
      tool("write"),
    ]);
    const registry = new PiToolSemanticMapperRegistry();
    const command = registry.map({
      backendItemId: "command-1",
      backendTurnId: "turn-1",
      sourceOrder: 0,
      status: "completed",
      phase: "completed",
      identity: catalog.require("bash"),
      arguments: {
        command: "printf hello",
        timeout: 4,
        apiToken: "do-not-render",
      },
      result: {
        content: [{ type: "text", text: "hello" }],
        details: {
          fullOutputPath: "/tmp/private-output",
          token: "secret",
        },
      },
      isError: false,
    });
    expect(command).toMatchObject({
      semanticKind: "command",
      phase: "completed",
      command: { text: "printf hello" },
      timeoutMs: 4_000,
      output: { text: "hello" },
    });
    expect(JSON.stringify(command)).not.toContain("private-output");
    expect(JSON.stringify(command)).not.toContain("do-not-render");
    expect(() => backendItemSchema.parse(command)).not.toThrow();

    const edit = registry.map({
      backendItemId: "edit-1",
      backendTurnId: "turn-1",
      sourceOrder: 1,
      status: "completed",
      phase: "completed",
      identity: catalog.require("edit"),
      arguments: { path: "src/a.ts" },
      result: {
        content: [{ type: "text", text: "edited" }],
        details: {
          patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new",
        },
      },
    });
    expect(edit).toMatchObject({
      semanticKind: "file_change",
      operation: "edit",
      effect: "applied",
      path: { text: "src/a.ts" },
      additions: 1,
      deletions: 1,
    });
    expect(() => backendItemSchema.parse(edit)).not.toThrow();

    const write = registry.map({
      backendItemId: "write-1",
      backendTurnId: "turn-1",
      sourceOrder: 2,
      status: "completed",
      phase: "completed",
      identity: catalog.require("write"),
      arguments: { path: "src/new.ts", content: "first\nsecond\n" },
      result: {
        content: [{ type: "text", text: "wrote src/new.ts" }],
      },
    });
    expect(write).toMatchObject({
      semanticKind: "file_change",
      operation: "write",
      effect: "applied",
      path: { text: "src/new.ts" },
      contentPreview: { text: "first\nsecond\n" },
      additions: 2,
      deletions: 0,
    });
    expect(() => backendItemSchema.parse(write)).not.toThrow();

    const emptyWrite = registry.map({
      backendItemId: "write-empty",
      backendTurnId: "turn-1",
      sourceOrder: 3,
      status: "completed",
      phase: "completed",
      identity: catalog.require("write"),
      arguments: { path: "src/empty.ts", content: "" },
      result: {
        content: [{ type: "text", text: "wrote src/empty.ts" }],
      },
    });
    expect(emptyWrite).toMatchObject({
      semanticKind: "file_change",
      operation: "write",
      path: { text: "src/empty.ts" },
      contentPreview: { text: "" },
      additions: 0,
      deletions: 0,
    });
    expect(() => backendItemSchema.parse(emptyWrite)).not.toThrow();
  });

  it("counts whole-file writes before bounding their content preview", () => {
    const catalog = new PiToolIdentityCatalog([tool("write")]);
    const registry = new PiToolSemanticMapperRegistry({
      ...DEFAULT_PAYLOAD_LIMITS,
      maximumResultBytes: 16,
    });
    const write = registry.map({
      backendItemId: "write-truncated",
      backendTurnId: "turn-1",
      sourceOrder: 0,
      status: "completed",
      phase: "completed",
      identity: catalog.require("write"),
      arguments: {
        path: "src/large.ts",
        content: `first\r\nsecond\r\nthird\n${"x".repeat(100)}`,
      },
      result: {
        content: [{ type: "text", text: "wrote src/large.ts" }],
      },
    });

    expect(write).toMatchObject({
      semanticKind: "file_change",
      operation: "write",
      additions: 4,
      deletions: 0,
      contentPreview: {
        truncation: {
          truncated: true,
          reason: "byte_limit",
        },
      },
    });
    expect(() => backendItemSchema.parse(write)).not.toThrow();
  });

  it("keeps unknown tools generic and redacts credential-shaped keys", () => {
    const catalog = new PiToolIdentityCatalog([
      tool("bash", "project", "/workspace/ext.ts"),
    ]);
    const item = new PiToolSemanticMapperRegistry().map({
      backendItemId: "generic-1",
      backendTurnId: "turn-1",
      sourceOrder: 0,
      status: "streaming",
      phase: "arguments_streaming",
      identity: catalog.require("bash"),
      arguments: {
        command: "dangerous-looking",
        Authorization: "Bearer secret",
      },
      result: {
        content: [{ type: "text", text: "ok" }],
        details: {
          fullOutputPath: "/tmp/provider-private",
          ordinary: "visible",
        },
      },
    });
    expect(item.semanticKind).toBe("tool");
    expect(JSON.stringify(item)).not.toContain("Bearer secret");
    expect(JSON.stringify(item)).not.toContain("provider-private");
    expect(JSON.stringify(item)).toContain("sensitive_key");
    expect(JSON.stringify(item)).toContain("visible");

    const extensionDelete = new PiToolSemanticMapperRegistry().map({
      backendItemId: "generic-delete",
      backendTurnId: "turn-1",
      sourceOrder: 1,
      status: "completed",
      phase: "completed",
      identity: new PiToolIdentityCatalog([
        tool("delete", "project", "/workspace/delete.ts"),
      ]).require("delete"),
      arguments: { path: "src/old.ts" },
      result: { content: [{ type: "text", text: "deleted" }] },
    });
    expect(extensionDelete.semanticKind).toBe("tool");
    expect(extensionDelete).not.toHaveProperty("additions");
    expect(extensionDelete).not.toHaveProperty("deletions");
  });

  it("bounds multi-part command and read text before joining it", () => {
    const catalog = new PiToolIdentityCatalog([tool("bash"), tool("read")]);
    const limits = {
      ...DEFAULT_PAYLOAD_LIMITS,
      maximumStringBytes: 32,
      maximumResultBytes: 32,
    };
    const registry = new PiToolSemanticMapperRegistry(limits);
    const commandContent: unknown[] = [
      { type: "text", text: "a".repeat(100_000) },
      undefined,
      { type: "text", text: "TAIL-END" },
    ];
    Object.defineProperty(commandContent, "1", {
      configurable: true,
      enumerable: true,
      get(): never {
        throw new Error("tool_result_accessor_evaluated");
      },
    });
    const command = registry.map({
      backendItemId: "command-bounded",
      backendTurnId: "turn-1",
      sourceOrder: 0,
      status: "completed",
      phase: "completed",
      identity: catalog.require("bash"),
      arguments: { command: "produce output" },
      result: {
        content: commandContent,
      },
    });
    const read = registry.map({
      backendItemId: "read-bounded",
      backendTurnId: "turn-1",
      sourceOrder: 1,
      status: "completed",
      phase: "completed",
      identity: catalog.require("read"),
      arguments: { path: "large.txt" },
      result: {
        content: [
          { type: "text", text: `START-${"b".repeat(100_000)}` },
          { type: "text", text: "unreachable tail" },
        ],
      },
    });

    expect(command).toMatchObject({
      semanticKind: "command",
      output: {
        truncation: {
          truncated: true,
          reason: "byte_limit",
        },
      },
    });
    expect(
      command.semanticKind === "command"
        ? command.output?.text.endsWith("TAIL-END")
        : false,
    ).toBe(true);
    expect(
      new TextEncoder().encode(
        command.semanticKind === "command" ? command.output?.text : "",
      ).byteLength,
    ).toBeLessThanOrEqual(32);
    expect(read).toMatchObject({
      semanticKind: "file_read",
      contentPreview: {
        truncation: {
          truncated: true,
          reason: "byte_limit",
        },
      },
    });
    expect(
      read.semanticKind === "file_read"
        ? read.contentPreview?.text.startsWith("START-")
        : false,
    ).toBe(true);
    expect(
      new TextEncoder().encode(
        read.semanticKind === "file_read" ? read.contentPreview?.text : "",
      ).byteLength,
    ).toBeLessThanOrEqual(32);
    expect(() => backendItemSchema.parse(command)).not.toThrow();
    expect(() => backendItemSchema.parse(read)).not.toThrow();
  });
});

describe("Pi persisted history projection", () => {
  it("projects correlation only from one authenticated agent-tool marker", () => {
    const catalog = new PiToolIdentityCatalog(
      [tool("sedes_reference_check", "sdk", "<sdk:sedes_reference_check>")],
      [],
      [
        {
          toolName: "sedes_reference_check",
          toolId: "reference.check",
          schemaVersion: 3,
          displayName: "Reference check",
        },
      ],
    );
    const identity = catalog.require("sedes_reference_check");
    const valid = invocationMarker("18", "12", "valid", "inv-valid");
    const duplicated = invocationMarker(
      "19",
      "12",
      "duplicated",
      "inv-duplicate",
    );
    const duplicate = { ...duplicated, id: "20" } as SessionEntry;
    const tamperedSource = invocationMarker(
      "21",
      "12",
      "tampered",
      "inv-original",
    );
    const tampered = {
      ...tamperedSource,
      data: {
        ...(tamperedSource.type === "custom"
          ? (tamperedSource.data as PiAgentToolInvocationMarker)
          : {}),
        invocationId: "inv-tampered",
      },
    } as SessionEntry;
    const malformed = {
      ...invocationMarker("22", "12", "malformed", "inv-malformed"),
      data: {
        version: 1,
        assistantEntryId: "12",
        toolCallId: "malformed",
        unexpected: true,
      },
    } as SessionEntry;
    const calls = ["valid", "duplicated", "tampered", "malformed", "missing"];
    const projection = historyProjector().project([
      entry("11", { role: "user", content: "Use Sedes tools" }),
      entry(
        "12",
        {
          role: "assistant",
          content: calls.map((id) => ({
            type: "toolCall",
            id,
            name: "sedes_reference_check",
            arguments: { reference: id },
          })),
          stopReason: "toolUse",
        },
        "11",
      ),
      ...calls.map((id, index) =>
        identityMarker(
          String(13 + index),
          "12",
          id,
          "sedes_reference_check",
          identity,
        ),
      ),
      valid,
      duplicated,
      duplicate,
      tampered,
      malformed,
    ]);

    expect(projection.snapshot.itemsById["12:0"]).toMatchObject({
      semanticKind: "tool",
      agentToolInvocation: {
        toolId: "reference.check",
        schemaVersion: 3,
        invocationId: "inv-valid",
      },
    });
    for (const index of [1, 2, 3, 4]) {
      expect(
        "agentToolInvocation" in projection.snapshot.itemsById[`12:${index}`]!,
      ).toBe(false);
    }
    expect(projection.diagnostics).toEqual(
      expect.arrayContaining([
        {
          code: "agent_tool_invocation_marker_conflict",
          entryId: "19",
        },
        {
          code: "agent_tool_invocation_marker_unauthenticated",
          entryId: "21",
        },
        {
          code: "agent_tool_invocation_marker_malformed",
          entryId: "22",
        },
        {
          code: "agent_tool_invocation_marker_missing",
          entryId: "12",
        },
      ]),
    );
    expect(() =>
      backendConversationSnapshotSchema.parse(projection.snapshot),
    ).not.toThrow();
  });

  it("makes a copied agent-tool invocation marker inert", () => {
    const copied = invocationMarker("115", "112", "copied", "inv-copied");
    expect(
      readPiAgentToolInvocationMarker(copied, {
        ...toolIdentityAuthentication,
        conversationId: "different-conversation",
      }),
    ).toEqual({ status: "unauthenticated" });
  });

  it("groups a durable steer into its provider turn but not an unowned user entry", () => {
    const marker = (
      id: string,
      applicationOperationId: string,
      mode: "submit" | "steer",
    ) =>
      ({
        type: "custom",
        id,
        parentId: null,
        timestamp: `2026-01-01T00:00:${id}.000Z`,
        customType: piSubmissionMarkerType,
        data: createPiSubmissionMarker({
          applicationOperationId,
          reconciliationToken: `${applicationOperationId}-token`,
          mutationId: applicationOperationId,
          mode,
          contextExcerpts: [],
          attachments: [],
          taskContexts: [],
          text:
            applicationOperationId === "submit-operation"
              ? "Begin"
              : "Change direction",
        }),
      }) as SessionEntry;
    const attestation = (
      id: string,
      userEntryId: string,
      submission: SessionEntry,
    ) => {
      if (submission.type !== "custom") {
        throw new Error("expected submission marker");
      }
      const markerData = submission.data as PiSubmissionMarker;
      return {
        type: "custom",
        id,
        parentId: null,
        timestamp: `2026-01-01T00:00:${id}.000Z`,
        customType: piSubmissionAttestationType,
        data: createPiSubmissionAttestation(
          {
            applicationOperationId: markerData.applicationOperationId,
            requestFingerprint: markerData.requestFingerprint,
            userEntryId,
          },
          toolIdentityAuthentication,
        ),
      } as SessionEntry;
    };
    const submitMarker = marker("01", "submit-operation", "submit");
    const steerMarker = marker("04", "steer-operation", "steer");
    const projection = historyProjector().project([
      submitMarker,
      entry("02", {
        role: "user",
        content: "Begin",
        timestamp: 2,
      }),
      attestation("09", "02", submitMarker),
      entry(
        "03",
        {
          role: "assistant",
          content: [{ type: "text", text: "First" }],
          stopReason: "stop",
          timestamp: 3,
        },
        "02",
      ),
      steerMarker,
      entry(
        "05",
        {
          role: "user",
          content: "Change direction",
          timestamp: 5,
        },
        "04",
      ),
      attestation("10", "05", steerMarker),
      entry(
        "06",
        {
          role: "assistant",
          content: [{ type: "text", text: "Second" }],
          stopReason: "stop",
          timestamp: 6,
        },
        "05",
      ),
      entry("07", {
        role: "user",
        content: "Legacy unowned follow-up",
        timestamp: 7,
      }),
      entry(
        "08",
        {
          role: "assistant",
          content: [{ type: "text", text: "Separate" }],
          stopReason: "stop",
          timestamp: 8,
        },
        "07",
      ),
    ]);

    expect(projection.snapshot.turnsById["02"]).toMatchObject({
      completionCorrelations: ["submit-operation", "steer-operation"],
      status: "completed",
      orderedBackendItemIds: ["02:user", "03:0", "05:user", "06:0"],
    });
    expect(projection.snapshot.turnsById["05"]).toBeUndefined();
    expect(projection.snapshot.turnsById["07"]).toMatchObject({
      status: "completed",
    });
    expect(projection.snapshot.itemsById["05:user"]).toMatchObject({
      backendTurnId: "02",
      deliveryOperationId: "steer-operation",
      sourceOrder: 2,
    });
    expect(projection.snapshot.itemsById["02:user"]).toMatchObject({
      deliveryOperationId: "submit-operation",
    });
    expect(projection.snapshot.itemsById["07:user"]).not.toHaveProperty(
      "deliveryOperationId",
    );
    expect(projection.snapshot.itemsById["06:0"]).toMatchObject({
      backendTurnId: "02",
      sourceOrder: 3,
    });
    expect(projection.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "unknown_custom_entry" }),
    );
  });

  it("excludes an orphan durable steer from normalized history", () => {
    const projection = historyProjector().project([
      {
        type: "custom",
        id: "01",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        customType: piSubmissionMarkerType,
        data: createPiSubmissionMarker({
          applicationOperationId: "orphan-steer",
          reconciliationToken: "orphan-token",
          mutationId: "orphan-mutation",
          mode: "steer",
          contextExcerpts: [],
          attachments: [],
          taskContexts: [],
          text: "Orphan steer",
        }),
      } as SessionEntry,
      entry("02", {
        role: "user",
        content: "Orphan steer",
        timestamp: 2,
      }),
    ]);

    expect(projection.snapshot.orderedBackendTurnIds).toEqual([]);
    expect(projection.snapshot.itemsById).toEqual({});
    expect(projection.diagnostics).toContainEqual({
      code: "submission_marker_invalid",
      entryId: "02",
    });
  });

  it("omits delivery correlation from an unauthenticated submission attestation", () => {
    const submission = createPiSubmissionMarker({
      applicationOperationId: "forged-operation",
      reconciliationToken: "forged-token",
      mutationId: "forged-mutation",
      mode: "submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Authenticated message",
    });
    const attestation = createPiSubmissionAttestation(
      {
        applicationOperationId: submission.applicationOperationId,
        requestFingerprint: submission.requestFingerprint,
        userEntryId: "02",
      },
      toolIdentityAuthentication,
    );
    const projection = historyProjector().project([
      {
        type: "custom",
        id: "01",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        customType: piSubmissionMarkerType,
        data: submission,
      } as SessionEntry,
      entry("02", {
        role: "user",
        content: "Authenticated message",
        timestamp: 2,
      }),
      {
        type: "custom",
        id: "03",
        parentId: "02",
        timestamp: "2026-01-01T00:00:03.000Z",
        customType: piSubmissionAttestationType,
        data: {
          ...attestation,
          applicationOperationId: "changed-operation",
        },
      } as SessionEntry,
    ]);

    expect(projection.snapshot.itemsById["02:user"]).not.toHaveProperty(
      "deliveryOperationId",
    );
    expect(projection.diagnostics).toContainEqual({
      code: "submission_attestation_unauthenticated",
      entryId: "03",
    });
  });

  it("restores authenticated context excerpt cards from Pi history", () => {
    const contextExcerpt = {
      id: "0d1bfa8b-dc37-4f52-8b0e-f8181ac0a7e9",
      excerpt: "selected text",
      note: "Explain this.",
      source: {
        kind: "conversation_message" as const,
        itemId: "normalized-assistant-item-1",
        itemRevision: 5,
      },
      locator: {
        kind: "text_quote" as const,
        prefix: "Before ",
        suffix: " after.",
      },
    };
    const submission = createPiSubmissionMarker({
      applicationOperationId: "context-operation",
      reconciliationToken: "context-token",
      mutationId: "context-mutation",
      mode: "submit",
      text: "Please explain.",
      contextExcerpts: [contextExcerpt],
      attachments: [],
      taskContexts: [],
    });
    const projection = historyProjector().project([
      {
        type: "custom",
        id: "01",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        customType: piContextExcerptMarkerType,
        data: createPiContextExcerptMarker(
          {
            applicationOperationId: "context-operation",
            requestFingerprint: submission.requestFingerprint,
            contextExcerpts: [contextExcerpt],
          },
          toolIdentityAuthentication,
        ),
      } as SessionEntry,
      {
        type: "custom",
        id: "02",
        parentId: "01",
        timestamp: "2026-01-01T00:00:02.000Z",
        customType: piSubmissionMarkerType,
        data: submission,
      } as SessionEntry,
      entry(
        "03",
        {
          role: "user",
          content: formatPiContextExcerptPrompt(
            [contextExcerpt],
            "Please explain.",
          ),
          timestamp: 3,
        },
        "02",
      ),
    ]);

    expect(projection.snapshot.itemsById["03:user"]).toMatchObject({
      semanticKind: "user_message",
      content: [
        { kind: "context_excerpt", excerpt: contextExcerpt },
        { kind: "text", text: { text: "Please explain." } },
      ],
    });
    expect(projection.diagnostics).toEqual([]);
  });

  it("restores only unambiguous authenticated task-context cards from Pi history", () => {
    const taskContext = {
      id: "10000000-0000-4000-8000-000000000001",
      scope: { kind: "global" as const },
      title: "Historical task snapshot",
      details: "Keep this exact revision.",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 9,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T13:00:00.000Z",
    };
    const submission = createPiSubmissionMarker({
      applicationOperationId: "task-context-operation",
      reconciliationToken: "task-context-token",
      mutationId: "task-context-mutation",
      mode: "submit",
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [taskContext],
    });
    const taskMarker = createPiTaskContextMarker(
      {
        applicationOperationId: submission.applicationOperationId,
        requestFingerprint: submission.requestFingerprint,
        taskContexts: [taskContext],
      },
      toolIdentityAuthentication,
    );
    const attestation = createPiSubmissionAttestation(
      {
        applicationOperationId: submission.applicationOperationId,
        requestFingerprint: submission.requestFingerprint,
        userEntryId: "03",
      },
      toolIdentityAuthentication,
    );
    const taskEntry = (id: string): SessionEntry =>
      ({
        type: "custom",
        id,
        parentId: null,
        timestamp: `2026-01-01T00:00:${id}.000Z`,
        customType: piTaskContextMarkerType,
        data: taskMarker,
      }) as SessionEntry;
    const common = [
      {
        type: "custom",
        id: "02",
        parentId: "01",
        timestamp: "2026-01-01T00:00:02.000Z",
        customType: piSubmissionMarkerType,
        data: submission,
      } as SessionEntry,
      entry(
        "03",
        {
          role: "user",
          content: formatPiTaskContextPrompt([taskContext], ""),
          timestamp: 3,
        },
        "02",
      ),
      {
        type: "custom",
        id: "04",
        parentId: "03",
        timestamp: "2026-01-01T00:00:04.000Z",
        customType: piSubmissionAttestationType,
        data: attestation,
      } as SessionEntry,
    ];

    const authenticated = historyProjector().project([
      taskEntry("01"),
      ...common,
    ]);
    expect(authenticated.snapshot.itemsById["03:user"]).toMatchObject({
      deliveryOperationId: "task-context-operation",
      content: [{ kind: "task_context", task: taskContext }],
    });
    expect(() =>
      backendConversationSnapshotSchema.parse(authenticated.snapshot),
    ).not.toThrow();

    const duplicated = historyProjector().project([
      taskEntry("01"),
      taskEntry("05"),
      ...common,
    ]);
    expect(duplicated.snapshot.itemsById["03:user"]).toMatchObject({
      content: [
        {
          kind: "text",
          text: { text: formatPiTaskContextPrompt([taskContext], "") },
        },
      ],
    });
    expect(duplicated.diagnostics).toContainEqual({
      code: "task_context_marker_conflict",
      entryId: "05",
    });
  });

  it.each([
    {
      stopReason: "aborted",
      status: "interrupted",
      endedBy: "interrupted",
    },
    {
      stopReason: "error",
      status: "failed",
      endedBy: "failed",
    },
  ] as const)(
    "reconstructs a $stopReason assistant outcome as $status",
    ({ stopReason, status, endedBy }) => {
      const projection = historyProjector().project([
        entry("01", {
          role: "user",
          content: "Begin",
          timestamp: 1,
        }),
        entry(
          "02",
          {
            role: "assistant",
            content: [{ type: "text", text: "Partial response" }],
            stopReason,
            timestamp: 2,
          },
          "01",
        ),
      ]);

      expect(projection.snapshot.turnsById["01"]).toMatchObject({
        status,
        endedBy,
        completedAt: "2026-01-01T00:00:02.000Z",
      });
      expect(() =>
        backendConversationSnapshotSchema.parse(projection.snapshot),
      ).not.toThrow();
    },
  );

  it("keeps a failed persisted run terminal instead of reconstructing it as active", () => {
    const projection = new PiHistoryProjector({
      runState: "failed",
      activeUserEntryId: "01",
    }).project([
      entry("01", {
        role: "user",
        content: "Begin",
        timestamp: 1,
      }),
      entry(
        "02",
        {
          role: "assistant",
          content: [{ type: "text", text: "Partial response" }],
          stopReason: "error",
          timestamp: 2,
        },
        "01",
      ),
    ]);

    expect(projection.snapshot.runState).toBe("failed");
    expect(projection.snapshot.activeBackendTurnId).toBeUndefined();
    expect(projection.snapshot.turnsById["01"]).toMatchObject({
      status: "failed",
      endedBy: "failed",
    });
  });

  it("groups a complete tool loop into one turn and one semantic operation", () => {
    const catalog = new PiToolIdentityCatalog([tool("read")]);
    const branch: SessionEntry[] = [
      entry("01", {
        role: "user",
        content: "Inspect the file",
        timestamp: 1,
      }),
      entry(
        "02",
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should read it" },
            {
              type: "toolCall",
              id: "call-read",
              name: "read",
              arguments: { path: "README.md", offset: 2, limit: 3 },
            },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        "01",
      ),
      identityMarker("025", "02", "call-read", "read", catalog.require("read")),
      entry(
        "03",
        {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          content: [{ type: "text", text: "line 2\nline 3\nline 4" }],
          details: { fullOutputPath: "/tmp/never-browser" },
          isError: false,
          timestamp: 3,
        },
        "02",
      ),
      entry(
        "04",
        {
          role: "assistant",
          content: [{ type: "text", text: "The file is clear." }],
          stopReason: "stop",
          timestamp: 4,
        },
        "03",
      ),
    ];

    const projection = historyProjector().project(branch);

    expect(projection.diagnostics).toEqual([]);
    expect(() =>
      backendConversationSnapshotSchema.parse(projection.snapshot),
    ).not.toThrow();
    expect(projection.snapshot.orderedBackendTurnIds).toEqual(["01"]);
    expect(projection.snapshot.turnsById["01"]?.orderedBackendItemIds).toEqual([
      "01:user",
      "02:0",
      "02:1",
      "04:0",
    ]);
    expect(
      Object.values(projection.snapshot.itemsById).map(
        (item) => item.semanticKind,
      ),
    ).toEqual(["user_message", "reasoning", "file_read", "assistant_message"]);
    const reasoning = projection.snapshot.itemsById["02:0"];
    expect(reasoning).toMatchObject({
      semanticKind: "reasoning",
      markdown: { text: "I should read it" },
    });
    expect(reasoning).not.toHaveProperty("summaryParts");
    const read = projection.snapshot.itemsById["02:1"];
    expect(read).toMatchObject({
      semanticKind: "file_read",
      phase: "completed",
      status: "completed",
      path: { text: "README.md" },
      range: { startLine: 2, endLine: 4 },
      contentPreview: { text: "line 2\nline 3\nline 4" },
    });
    expect(JSON.stringify(read)).not.toContain("never-browser");
  });

  it("preserves assistant content order and diagnoses an ambiguous result", () => {
    const catalog = new PiToolIdentityCatalog([tool("read")]);
    const branch: SessionEntry[] = [
      entry("11", { role: "user", content: "Read twice" }),
      entry(
        "12",
        {
          role: "assistant",
          content: [
            { type: "text", text: "First " },
            {
              type: "toolCall",
              id: "duplicate",
              name: "read",
              arguments: { path: "a" },
            },
            { type: "text", text: " second " },
            {
              type: "toolCall",
              id: "duplicate",
              name: "read",
              arguments: { path: "b" },
            },
          ],
          stopReason: "toolUse",
        },
        "11",
      ),
      identityMarker("125", "12", "duplicate", "read", catalog.require("read")),
      entry(
        "13",
        {
          role: "toolResult",
          toolCallId: "duplicate",
          toolName: "read",
          content: [{ type: "text", text: "value" }],
          isError: false,
        },
        "12",
      ),
    ];
    const projection = historyProjector().project(branch);
    expect(
      Object.values(projection.snapshot.itemsById).map(
        ({ backendItemId }) => backendItemId,
      ),
    ).toEqual(["11:user", "12:0", "12:1", "12:2", "12:3"]);
    expect(projection.diagnostics).toContainEqual({
      code: "tool_result_ambiguous",
      entryId: "13",
    });
    expect(
      Object.values(projection.snapshot.itemsById).filter(
        ({ semanticKind }) => semanticKind === "file_read",
      ),
    ).toEqual([
      expect.objectContaining({
        status: "interrupted",
        error: expect.objectContaining({
          code: "pi_tool_result_missing",
        }),
      }),
      expect.objectContaining({
        status: "interrupted",
        error: expect.objectContaining({
          code: "pi_tool_result_missing",
        }),
      }),
    ]);
  });

  it("keeps unmarked legacy calls generic despite a current built-in name collision", () => {
    const currentCatalog = new PiToolIdentityCatalog([tool("read")]);
    expect(currentCatalog.require("read").origin).toBe("pi_builtin");
    const projection = historyProjector().project([
      entry("14", { role: "user", content: "Legacy call" }),
      entry(
        "15",
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "legacy-read",
              name: "read",
              arguments: { path: "secret.txt" },
            },
          ],
          stopReason: "toolUse",
        },
        "14",
      ),
      entry(
        "16",
        {
          role: "toolResult",
          toolCallId: "legacy-read",
          toolName: "read",
          content: [{ type: "text", text: "value" }],
          isError: false,
        },
        "15",
      ),
    ]);

    expect(projection.snapshot.itemsById["15:0"]).toMatchObject({
      semanticKind: "tool",
      phase: "completed",
    });
    expect(projection.diagnostics).toContainEqual({
      code: "tool_identity_marker_missing",
      entryId: "15",
    });
  });

  it("uses each persisted identity instead of a later catalog registration", () => {
    const builtin = new PiToolIdentityCatalog([tool("read")]).require("read");
    const extension = new PiToolIdentityCatalog([
      tool("read", "project", "/workspace/extensions/read.ts"),
    ]).require("read");
    const projection = historyProjector().project([
      entry("31", { role: "user", content: "Built-in then extension" }),
      entry(
        "32",
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "frozen-builtin",
              name: "read",
              arguments: { path: "builtin.txt" },
            },
          ],
          stopReason: "toolUse",
        },
        "31",
      ),
      identityMarker("33", "32", "frozen-builtin", "read", builtin),
      entry(
        "34",
        {
          role: "toolResult",
          toolCallId: "frozen-builtin",
          toolName: "read",
          content: [{ type: "text", text: "builtin result" }],
          isError: false,
        },
        "33",
      ),
      entry(
        "35",
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "frozen-extension",
              name: "read",
              arguments: { path: "extension.txt" },
            },
          ],
          stopReason: "toolUse",
        },
        "34",
      ),
      identityMarker("36", "35", "frozen-extension", "read", extension),
      entry(
        "37",
        {
          role: "toolResult",
          toolCallId: "frozen-extension",
          toolName: "read",
          content: [{ type: "text", text: "extension result" }],
          isError: false,
        },
        "36",
      ),
    ]);

    expect(projection.snapshot.itemsById["32:0"]?.semanticKind).toBe(
      "file_read",
    );
    expect(projection.snapshot.itemsById["35:0"]?.semanticKind).toBe("tool");
    expect(projection.diagnostics).toEqual([]);
  });

  it("rejects a marker copied from another conversation", () => {
    const builtin = new PiToolIdentityCatalog([tool("read")]).require("read");
    const copied = identityMarker("73", "72", "copied", "read", builtin);
    const projection = new PiHistoryProjector({
      toolIdentityAuthentication: {
        ...toolIdentityAuthentication,
        conversationId: "different-conversation",
      },
    }).project([
      entry("71", { role: "user", content: "Read it" }),
      entry(
        "72",
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "copied",
              name: "read",
              arguments: { path: "copied.txt" },
            },
          ],
          stopReason: "toolUse",
        },
        "71",
      ),
      copied,
      entry(
        "74",
        {
          role: "toolResult",
          toolCallId: "copied",
          toolName: "read",
          content: [{ type: "text", text: "value" }],
          isError: false,
        },
        "73",
      ),
    ]);

    expect(projection.snapshot.itemsById["72:0"]?.semanticKind).toBe("tool");
    expect(projection.diagnostics).toContainEqual({
      code: "tool_identity_marker_unauthenticated",
      entryId: "73",
    });
  });

  it("rejects unauthenticated, tampered, and duplicated markers", () => {
    const builtin = new PiToolIdentityCatalog([tool("read")]).require("read");
    const valid = identityMarker("83", "82", "duplicated", "read", builtin);
    const duplicate = {
      ...valid,
      id: "84",
    } as SessionEntry;
    const tamperedMarker = identityMarker(
      "85",
      "82",
      "tampered",
      "read",
      builtin,
    );
    const tampered = {
      ...tamperedMarker,
      data: {
        ...(tamperedMarker.type === "custom"
          ? (tamperedMarker.data as PiToolIdentityMarker)
          : {}),
        authentication: {
          algorithm: "hmac-sha256",
          tag: "A".repeat(43),
        },
      },
    } as SessionEntry;
    const branch = [
      entry("81", { role: "user", content: "Read twice" }),
      entry(
        "82",
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "duplicated",
              name: "read",
              arguments: { path: "duplicate.txt" },
            },
            {
              type: "toolCall",
              id: "tampered",
              name: "read",
              arguments: { path: "tampered.txt" },
            },
          ],
          stopReason: "toolUse",
        },
        "81",
      ),
      valid,
      duplicate,
      tampered,
    ];

    const authenticated = historyProjector().project(branch);
    expect(authenticated.snapshot.itemsById["82:0"]?.semanticKind).toBe("tool");
    expect(authenticated.snapshot.itemsById["82:1"]?.semanticKind).toBe("tool");
    expect(authenticated.diagnostics).toEqual(
      expect.arrayContaining([
        {
          code: "tool_identity_marker_conflict",
          entryId: "83",
        },
        {
          code: "tool_identity_marker_unauthenticated",
          entryId: "85",
        },
      ]),
    );

    const withoutKey = new PiHistoryProjector({}).project([
      entry("81", { role: "user", content: "Read once" }),
      entry(
        "82",
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "duplicated",
              name: "read",
              arguments: { path: "duplicate.txt" },
            },
          ],
          stopReason: "toolUse",
        },
        "81",
      ),
      valid,
    ]);
    expect(withoutKey.snapshot.itemsById["82:0"]?.semanticKind).toBe("tool");
    expect(withoutKey.diagnostics).toContainEqual({
      code: "tool_identity_marker_unauthenticated",
      entryId: "83",
    });
  });

  it("hides malformed and conflicting markers while keeping their calls generic", () => {
    const builtin = new PiToolIdentityCatalog([tool("read")]).require("read");
    const extension = new PiToolIdentityCatalog([
      tool("read", "project", "/workspace/extensions/read.ts"),
    ]).require("read");
    const malformed = {
      type: "custom",
      id: "43",
      parentId: null,
      timestamp: "2026-01-01T00:00:43.000Z",
      customType: piToolIdentityMarkerType,
      data: {
        version: 1,
        assistantEntryId: "42",
        toolCallId: "malformed",
        toolName: "read",
        identity: { ...builtin, unexpected: true },
      },
    } as SessionEntry;
    const projection = historyProjector().project([
      entry("41", { role: "user", content: "Markers" }),
      entry(
        "42",
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "malformed",
              name: "read",
              arguments: { path: "a" },
            },
            {
              type: "toolCall",
              id: "conflict",
              name: "read",
              arguments: { path: "b" },
            },
          ],
          stopReason: "toolUse",
        },
        "41",
      ),
      malformed,
      identityMarker("44", "42", "conflict", "read", builtin),
      identityMarker("45", "42", "conflict", "read", extension),
    ]);

    expect(projection.snapshot.itemsById["42:0"]?.semanticKind).toBe("tool");
    expect(projection.snapshot.itemsById["42:1"]?.semanticKind).toBe("tool");
    expect(projection.diagnostics).toEqual(
      expect.arrayContaining([
        {
          code: "tool_identity_marker_malformed",
          entryId: "43",
        },
        {
          code: "tool_identity_marker_conflict",
          entryId: "44",
        },
      ]),
    );
    expect(projection.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "unknown_custom_entry" }),
    );
  });

  it("preserves complete user text independently of preview limits without evaluating accessors", () => {
    const content: unknown[] = [
      { type: "text", text: "prefix-" },
      undefined,
      { type: "text", text: "z".repeat(100_000) },
    ];
    Object.defineProperty(content, "1", {
      configurable: true,
      enumerable: true,
      get(): never {
        throw new Error("history_content_accessor_evaluated");
      },
    });
    const projection = new PiHistoryProjector({
      limits: {
        ...DEFAULT_PAYLOAD_LIMITS,
        maximumStringBytes: 32,
      },
    }).project([
      entry("21", {
        role: "user",
        content,
      }),
    ]);
    const item = projection.snapshot.itemsById["21:user"];

    expect(item).toMatchObject({
      semanticKind: "user_message",
      content: [
        {
          kind: "text",
          text: {
            text: `prefix-${"z".repeat(100_000)}`,
          },
        },
      ],
    });
    if (item?.semanticKind !== "user_message") {
      throw new Error("expected_user_message");
    }
    expect(item.content[0]?.kind).toBe("text");
    const text =
      item.content[0]?.kind === "text" ? item.content[0].text.text : "";
    expect(text.startsWith("prefix-")).toBe(true);
    expect(text).toBe(`prefix-${"z".repeat(100_000)}`);
    expect(() =>
      backendConversationSnapshotSchema.parse(projection.snapshot),
    ).not.toThrow();
  });

  it("reads assistant content through data descriptors only", () => {
    const content: unknown[] = [
      { type: "text", text: "visible" },
      undefined,
      { type: "text", text: "after getter" },
    ];
    Object.defineProperty(content, "1", {
      configurable: true,
      enumerable: true,
      get(): never {
        throw new Error("assistant_content_accessor_evaluated");
      },
    });

    const projection = historyProjector().project([
      entry("22", { role: "user", content: "request" }),
      entry("23", { role: "assistant", content }),
    ]);

    expect(projection.snapshot.turnsById["22"]?.orderedBackendItemIds).toEqual([
      "22:user",
      "23:0",
      "23:2",
    ]);
    expect(() =>
      backendConversationSnapshotSchema.parse(projection.snapshot),
    ).not.toThrow();
  });
});
