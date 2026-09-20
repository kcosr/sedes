import { describe, expect, it, vi } from "vitest";
import {
  LateBoundBackendAgentToolFacade,
  type BackendAgentToolFacade,
  type TrustedAgentToolSource,
} from "../../src/server/agent-tools/adapters/backend-facade.js";
import type { SedesToolInvocationResult } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";

const source = Object.freeze({
  scope: { tenantId: "tenant-1", principalId: "principal-1" },
  sourceThreadId: "thread-1",
  sourceWorkspaceId: "workspace-1",
  sourceEnvironmentId: "environment-1",
  backendKind: "pi",
} satisfies TrustedAgentToolSource);

describe("LateBoundBackendAgentToolFacade", () => {
  it("fails closed before binding and after close", async () => {
    const facade = new LateBoundBackendAgentToolFacade();
    expect(() => facade.eligibleCatalog("pi_sdk")).toThrow(
      "agent_tool_facade_unavailable",
    );
    expect(() => facade.catalogSummaries(source, "pi_sdk")).toThrow(
      "agent_tool_facade_unavailable",
    );
    expect(() =>
      facade.describeMany(source, "pi_sdk", ["agent.context"]),
    ).toThrow("agent_tool_facade_unavailable");
    expect(() => facade.readPolicy(source)).toThrow(
      "agent_tool_facade_unavailable",
    );
    await expect(
      facade.invoke({
        source,
        adapter: "pi_sdk",
        request: {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "request-1",
          input: {},
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("agent_tool_facade_unavailable");
    facade.close();
    expect(() => facade.eligibleCatalog("pi_sdk")).toThrow(
      "agent_tool_facade_closed",
    );
    expect(() => facade.bind({} as BackendAgentToolFacade)).toThrow(
      "agent_tool_facade_closed",
    );
  });

  it("binds exactly one delegate and clears it on close", async () => {
    const facade = new LateBoundBackendAgentToolFacade();
    const invoke = vi.fn(async () => ({
      invocationId: "invocation-1",
      state: "completed" as const,
      output: { ok: true },
    }));
    const delegate: BackendAgentToolFacade = {
      eligibleCatalog: vi.fn(() => []),
      catalogSummaries: vi.fn(() => []),
      describeMany: vi.fn(() => []),
      readPolicy: vi.fn(() => ({
        enabled: true,
        presentation: {
          surface: "native" as const,
          mode: "progressive" as const,
        },
        accessBoundary: "environment" as const,
        enabledToolIds: ["agent.context"],
      })),
      async invoke<Output = unknown>() {
        return (await invoke()) as SedesToolInvocationResult<Output>;
      },
    };
    facade.bind(delegate);
    expect(facade.eligibleCatalog("pi_sdk")).toEqual([]);
    expect(facade.catalogSummaries(source, "pi_sdk")).toEqual([]);
    expect(facade.describeMany(source, "pi_sdk", ["agent.context"])).toEqual(
      [],
    );
    expect(facade.readPolicy(source).enabled).toBe(true);
    await expect(
      facade.invoke({
        source,
        adapter: "pi_sdk",
        request: {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "request-1",
          input: {},
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ state: "completed" });
    expect(() => facade.bind(delegate)).toThrow(
      "agent_tool_facade_already_bound",
    );
    facade.close();
    await expect(
      facade.invoke({
        source,
        adapter: "pi_sdk",
        request: {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "request-2",
          input: {},
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("agent_tool_facade_closed");
  });
});
