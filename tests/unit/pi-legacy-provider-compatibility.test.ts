import { createHmac } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createPiActionMarker,
  findPiActionState,
  piActionMarkerType,
} from "../../src/server/backends/pi/pi-action-marker.js";
import {
  createPiInteractionResponseMarker,
  findPiInteractionResponseState,
  piInteractionResponseMarkerType,
} from "../../src/server/backends/pi/pi-interaction-response-marker.js";
import {
  piAgentToolInvocationMarkerType,
  readPiAgentToolInvocationMarker,
} from "../../src/server/backends/pi/pi-agent-tool-invocation-marker.js";
import {
  piBranchMarkerType,
  readPiBranchMarker,
} from "../../src/server/backends/pi/pi-branch-marker.js";
import {
  piToolIdentityMarkerType,
  readPiToolIdentityMarker,
} from "../../src/server/backends/pi/pi-tool-identity-marker.js";
import { isExactPiForkContextBoundary } from "../../src/server/backends/pi/pi-fork-context-boundary.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../../src/server/backends/fork-context-boundary.js";
import { PiHistoryProjector } from "../../src/server/backends/pi/pi-history-projector.js";

const key = new Uint8Array(32).fill(0x42);
const authentication = {
  conversationId: "conversation-1",
  installationKey: key,
};

function custom(
  customType: string,
  data: unknown,
  id = "marker-1",
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType,
    data,
  } as SessionEntry;
}

function tag(values: readonly unknown[]): string {
  return createHmac("sha256", key)
    .update(JSON.stringify(values), "utf8")
    .digest("base64url");
}

describe("Pi historical Harness provider compatibility", () => {
  it("continues lifecycle reads across legacy and current marker types", () => {
    const action = {
      applicationOperationId: "operation-1",
      action: "compact" as const,
    };
    const started = createPiActionMarker(action, "started");
    const completed = createPiActionMarker(action, "completed");
    expect(
      findPiActionState(
        [
          custom("harness.backend_action.v1", started, "start"),
          custom(piActionMarkerType, completed, "complete"),
        ],
        action,
      ).state,
    ).toBe("completed");

    const response = {
      applicationOperationId: "operation-2",
      interactionId: "interaction-1",
      kind: "choice" as const,
      selectedOptionIds: ["yes"],
    };
    expect(
      findPiInteractionResponseState(
        [
          custom(
            "harness.interaction_response.v1",
            createPiInteractionResponseMarker(response, "started"),
            "response-start",
          ),
          custom(
            piInteractionResponseMarkerType,
            createPiInteractionResponseMarker(response, "completed"),
            "response-complete",
          ),
        ],
        response,
      ).state,
    ).toBe("completed");
  });

  it("authenticates a legacy branch only under its exact historical domain", () => {
    const type = "harness.branch_source.v2";
    const fields = {
      sourceBackendConversationId: "source",
      targetBackendConversationId: "target",
      sourceLeafEntryId: "leaf",
      applicationOperationId: "operation",
      inheritedSettingsFingerprint: "a".repeat(64),
    };
    const data = {
      version: 2,
      ...fields,
      authentication: {
        algorithm: "hmac-sha256",
        tag: tag([type, ...Object.values(fields)]),
      },
    };
    expect(readPiBranchMarker(custom(type, data), key).status).toBe(
      "authenticated",
    );
    expect(
      readPiBranchMarker(custom(piBranchMarkerType, data), key).status,
    ).toBe("unauthenticated");
  });

  it("normalizes authenticated legacy agent-tool evidence after verification", () => {
    const invocationType = "harness.agent_tool_invocation.v1";
    const invocationFields = {
      assistantEntryId: "assistant-1",
      toolCallId: "call-1",
      toolName: "harness_reference_check",
      toolId: "reference.check",
      schemaVersion: 3,
      invocationId: "invocation-1",
    };
    const invocation = {
      version: 1,
      ...invocationFields,
      authentication: {
        algorithm: "hmac-sha256",
        tag: tag([
          invocationType,
          authentication.conversationId,
          ...Object.values(invocationFields),
        ]),
      },
    };
    expect(
      readPiAgentToolInvocationMarker(
        custom(invocationType, invocation),
        authentication,
      ),
    ).toMatchObject({
      status: "authenticated",
      marker: { toolName: "sedes_reference_check" },
    });
    expect(
      readPiAgentToolInvocationMarker(
        custom(piAgentToolInvocationMarkerType, invocation),
        authentication,
      ).status,
    ).toBe("malformed");

    const identityType = "harness.tool_identity.v2";
    const identity = {
      registrationId:
        "harness:agent-tool:reference.check:3:harness_reference_check",
      origin: "harness_agent_tool",
      canonicalKind: "agent_tool",
      displayName: "Reference check",
      agentToolId: "reference.check",
      agentToolSchemaVersion: 3,
    };
    const identityData = {
      version: 2,
      assistantEntryId: "assistant-1",
      toolCallId: "call-1",
      toolName: "harness_reference_check",
      identity,
      authentication: {
        algorithm: "hmac-sha256",
        tag: tag([
          identityType,
          authentication.conversationId,
          "assistant-1",
          "call-1",
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
      },
    };
    expect(
      readPiToolIdentityMarker(
        custom(identityType, identityData),
        authentication,
      ),
    ).toMatchObject({
      status: "authenticated",
      marker: {
        toolName: "sedes_reference_check",
        identity: {
          origin: "sedes_agent_tool",
          registrationId:
            "sedes:agent-tool:reference.check:3:sedes_reference_check",
        },
      },
    });
    const forged = {
      ...identityData,
      authentication: { ...identityData.authentication, tag: "A".repeat(43) },
    };
    expect(
      readPiToolIdentityMarker(custom(identityType, forged), authentication)
        .status,
    ).toBe("unauthenticated");
    expect(piToolIdentityMarkerType).toBe("sedes.tool_identity.v2");
  });

  it("correlates direct and gateway history against authenticated native Harness names", () => {
    const assistantEntryId = "assistant-history";
    const marker = (
      id: string,
      toolCallId: string,
      toolName: string,
      identity: Record<string, unknown>,
    ) => {
      const identityFields = [
        identity.registrationId,
        identity.origin,
        identity.canonicalKind ?? null,
        identity.displayName,
        identity.mcpServer ?? null,
        ...(identity.origin === "harness_agent_tool"
          ? [identity.agentToolId, identity.agentToolSchemaVersion]
          : []),
      ];
      return custom(
        "harness.tool_identity.v2",
        {
          version: 2,
          assistantEntryId,
          toolCallId,
          toolName,
          identity,
          authentication: {
            algorithm: "hmac-sha256",
            tag: tag([
              "harness.tool_identity.v2",
              authentication.conversationId,
              assistantEntryId,
              toolCallId,
              toolName,
              identityFields,
            ]),
          },
        },
        id,
      );
    };
    const invocation = (
      id: string,
      toolCallId: string,
      toolName: string,
      toolId: string,
      invocationId: string,
    ) => {
      const fields = {
        assistantEntryId,
        toolCallId,
        toolName,
        toolId,
        schemaVersion: 3,
        invocationId,
      };
      return custom(
        "harness.agent_tool_invocation.v1",
        {
          version: 1,
          ...fields,
          authentication: {
            algorithm: "hmac-sha256",
            tag: tag([
              "harness.agent_tool_invocation.v1",
              authentication.conversationId,
              ...Object.values(fields),
            ]),
          },
        },
        id,
      );
    };
    const message = (
      id: string,
      value: unknown,
      parentId: string | null = null,
    ) =>
      ({
        type: "message",
        id,
        parentId,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: value,
      }) as SessionEntry;
    const projection = new PiHistoryProjector({
      toolIdentityAuthentication: authentication,
    }).project([
      message("user", { role: "user", content: "Use tools" }),
      message(
        assistantEntryId,
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "direct-call",
              name: "harness_reference_check",
              arguments: {},
            },
            {
              type: "toolCall",
              id: "gateway-call",
              name: "harness_read",
              arguments: {},
            },
          ],
          stopReason: "toolUse",
        },
        "user",
      ),
      marker("direct-identity", "direct-call", "harness_reference_check", {
        registrationId:
          "harness:agent-tool:reference.check:3:harness_reference_check",
        origin: "harness_agent_tool",
        canonicalKind: "agent_tool",
        displayName: "Reference check",
        agentToolId: "reference.check",
        agentToolSchemaVersion: 3,
      }),
      invocation(
        "direct-invocation",
        "direct-call",
        "harness_reference_check",
        "reference.check",
        "direct-invocation-id",
      ),
      marker("gateway-identity", "gateway-call", "harness_read", {
        registrationId: "harness:agent-tool-gateway:harness_read",
        origin: "harness_agent_tool_gateway",
        canonicalKind: "agent_tool",
        displayName: "Harness task read",
      }),
      invocation(
        "gateway-invocation",
        "gateway-call",
        "harness_read",
        "task.read",
        "gateway-invocation-id",
      ),
    ]);
    expect(
      projection.snapshot.itemsById[`${assistantEntryId}:0`],
    ).toMatchObject({
      agentToolInvocation: { invocationId: "direct-invocation-id" },
    });
    expect(
      projection.snapshot.itemsById[`${assistantEntryId}:1`],
    ).toMatchObject({
      agentToolInvocation: { invocationId: "gateway-invocation-id" },
    });
    expect(projection.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.stringContaining("mismatch") }),
      ]),
    );
  });

  it("recognizes the exact historical fork boundary without broad lookalikes", () => {
    const boundary = (customType: string) =>
      ({
        type: "custom_message",
        id: "boundary",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType,
        content: USER_FORK_CONTEXT_BOUNDARY.content,
        display: false,
        details: { version: 1, applicationOperationId: "operation-1" },
      }) as SessionEntry;
    expect(
      isExactPiForkContextBoundary(
        boundary("harness.fork_context_boundary.v1"),
        "operation-1",
        USER_FORK_CONTEXT_BOUNDARY,
      ),
    ).toBe(true);
    expect(
      isExactPiForkContextBoundary(
        boundary("harness.fork_context_boundary.v1.extra"),
        "operation-1",
        USER_FORK_CONTEXT_BOUNDARY,
      ),
    ).toBe(false);
  });
});
