import type {
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type {
  BackendAgentToolFacade,
  BackendAgentToolInvocationInput,
  TrustedAgentToolSource,
} from "../../src/server/agent-tools/adapters/backend-facade.js";
import type { SedesToolInvocationResult } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { agentContextToolDefinition } from "../../src/server/agent-tools/tools/agent-context-tool.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import {
  assertNoPiAgentToolExtensionCollisions,
  createPiAgentToolSet,
  resolvePiProgressiveAgentToolEnvelope,
} from "../../src/server/backends/pi/pi-agent-tool-adapter.js";
import {
  piAgentToolInvocationMarkerType,
  readPiAgentToolInvocationMarker,
} from "../../src/server/backends/pi/pi-agent-tool-invocation-marker.js";
import { PiToolAccessController } from "../../src/server/backends/pi/pi-tool-access.js";

const authentication = {
  conversationId: "pi-agent-tool-conversation",
  installationKey: new Uint8Array(32).fill(0x61),
} as const;

function artifact() {
  const registry = new AgentToolRegistry();
  registry.register(agentContextToolDefinition);
  return registry.artifact(
    agentContextToolDefinition.id,
    agentContextToolDefinition.schemaVersion,
  );
}

const source: TrustedAgentToolSource = Object.freeze({
  scope: { tenantId: "tenant", principalId: "principal" },
  sourceThreadId: "thread-1",
  sourceWorkspaceId: "workspace-1",
  sourceEnvironmentId: "environment-1",
  backendKind: "pi",
});

const enabledPolicy = Object.freeze({
  enabled: true,
  presentation: { surface: "native" as const, mode: "individual" as const },
  accessBoundary: "environment" as const,
  enabledToolIds: ["agent.context"],
});

const emptyDiscovery = {
  catalogSummaries: () => [],
  describeMany: () => [],
} as const;

function sessionManager(toolName = "sedes_agent_context"): {
  readonly manager: SessionManager;
  readonly entries: SessionEntry[];
} {
  const entries = [
    {
      type: "message",
      id: "user-entry",
      parentId: null,
      timestamp: "2026-07-31T00:00:00.000Z",
      message: { role: "user", content: "Use the Sedes tool" },
    },
    {
      type: "message",
      id: "assistant-entry",
      parentId: "user-entry",
      timestamp: "2026-07-31T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "pi-call-1",
            name: toolName,
            arguments: {},
          },
        ],
      },
    },
  ] as unknown as SessionEntry[];
  let nextId = 1;
  const manager = {
    getBranch: () => entries,
    appendCustomEntry(customType: string, data: unknown) {
      const id = `custom-${nextId++}`;
      entries.push({
        type: "custom",
        id,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-07-31T00:00:02.000Z",
        customType,
        data,
      } as SessionEntry);
      return id;
    },
  } as unknown as SessionManager;
  return { manager, entries };
}

function completedOutput() {
  return {
    status: "ok" as const,
    sourceThreadId: "thread-1",
    sourceWorkspaceId: "workspace-1",
    backendKind: "pi" as const,
    trigger: "agent_call" as const,
    effectiveCapabilities: ["execution.context.read"],
  };
}

describe("Pi agent-tool adapter", () => {
  it("progressively discovers and invokes one exact read with a v1 marker", async () => {
    const contract = artifact();
    const description = {
      id: contract.id,
      schemaVersion: contract.schemaVersion,
      label: contract.adapters.pi!.label,
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      effects: contract.effects,
      execution: {
        form: contract.execution.form,
        waitCeilingMilliseconds:
          contract.execution.adapterWaitCeilingMilliseconds.pi_sdk ?? 30_000,
        supportsCancellation: contract.execution.supportsCancellation,
        idempotency: contract.execution.idempotency,
        progress: contract.execution.progress,
        maximumInputBytes: contract.execution.maximumInputBytes,
        maximumOutputBytes: contract.execution.maximumOutputBytes,
        uncertainExternalOutcome: contract.execution.uncertainExternalOutcome,
      },
    } as const;
    const summary = {
      id: contract.id,
      schemaVersion: contract.schemaVersion,
      label: contract.adapters.pi!.label,
      description: contract.description,
      group: {
        id: contract.catalog.groupId,
        order: contract.catalog.order,
      },
      effects: contract.effects,
    } as const;
    const progressivePolicy = {
      enabled: true,
      presentation: {
        surface: "native" as const,
        mode: "progressive" as const,
      },
      accessBoundary: "environment" as const,
      enabledToolIds: [contract.id],
    };
    const toolAccess = new PiToolAccessController("full");
    const { manager, entries } = sessionManager("sedes_read");
    const facade: BackendAgentToolFacade = {
      eligibleCatalog: () => [contract],
      catalogSummaries: () => [summary],
      describeMany: (_source, _adapter, ids) => ids.map(() => description),
      readPolicy: () => progressivePolicy,
      async invoke<Output>(input: BackendAgentToolInvocationInput) {
        await input.onInvocationStarted?.("progressive-read-invocation");
        return {
          invocationId: "progressive-read-invocation",
          state: "completed",
          output: completedOutput() as Output,
        };
      },
    };
    const set = createPiAgentToolSet({
      facade,
      source,
      manager,
      authentication,
      toolAccess,
      providerTurnCorrelation: () => "user-entry",
    });
    set.refreshProgressiveSnapshot(progressivePolicy, toolAccess.mode);
    expect(set.tools.map(({ name }) => name)).toEqual([
      "sedes_agent_context",
      "sedes_catalog",
      "sedes_read",
      "sedes_act",
    ]);
    const catalog = set.tools.find(({ name }) => name === "sedes_catalog")!;
    expect(catalog.description).toContain("list it first, then describe");
    expect(catalog.promptGuidelines).toEqual([
      expect.stringContaining(
        "tool ID, schema version, effects, and input schema",
      ),
      expect.stringContaining("side-effect-free read through sedes_read"),
      expect.stringContaining(
        "principal-global within this Sedes installation",
      ),
    ]);
    expect(catalog.promptGuidelines?.[2]).toContain(
      "there is no cross-server discovery bus",
    );
    await expect(
      catalog.execute(
        "catalog-call",
        { action: "list" },
        undefined,
        undefined,
        {} as never,
      ),
    ).resolves.toMatchObject({
      details: { discovery: { action: "list", tools: [summary] } },
    });
    const read = set.tools.find(({ name }) => name === "sedes_read")!;
    expect(read.description).toContain(
      "exact described tool ID, schema version, and input schema",
    );
    expect(read.promptGuidelines).toEqual([
      expect.stringContaining("list the current catalog and describe"),
      expect.stringContaining(
        "application=read, modelUsage=none, and external=none",
      ),
    ]);
    const action = set.tools.find(({ name }) => name === "sedes_act")!;
    expect(action.description).toContain(
      "write, destructive, model-usage, or external-side-effect operation",
    );
    expect(action.promptGuidelines).toEqual([
      expect.stringContaining("Do not guess a tool ID, schema version"),
      expect.stringContaining("change application state, use a model"),
    ]);
    await expect(
      read.execute(
        "pi-call-1",
        {
          toolId: contract.id,
          schemaVersion: contract.schemaVersion,
          input: {},
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).resolves.toMatchObject({
      details: { invocation: { invocationId: "progressive-read-invocation" } },
    });
    const invocationEntries = entries.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === piAgentToolInvocationMarkerType,
    );
    expect(invocationEntries).toHaveLength(1);
    expect(
      readPiAgentToolInvocationMarker(invocationEntries[0]!, authentication),
    ).toMatchObject({
      status: "authenticated",
      marker: {
        toolName: "sedes_read",
        toolId: contract.id,
        schemaVersion: contract.schemaVersion,
      },
    });

    const actionDescription = {
      ...description,
      effects: { ...description.effects, application: "write" as const },
    };
    const actionFacade = {
      ...facade,
      describeMany: () => [actionDescription],
    };
    expect(() =>
      resolvePiProgressiveAgentToolEnvelope(
        { facade: actionFacade, source, toolAccess },
        "sedes_act",
        {
          toolId: contract.id,
          schemaVersion: contract.schemaVersion,
          input: {},
        },
      ),
    ).not.toThrow();
    toolAccess.setMode("read_only");
    expect(() =>
      resolvePiProgressiveAgentToolEnvelope(
        { facade: actionFacade, source, toolAccess },
        "sedes_act",
        {
          toolId: contract.id,
          schemaVersion: contract.schemaVersion,
          input: {},
        },
      ),
    ).toThrow("The requested Sedes tool is unavailable.");
  });

  it("consumes an action approval on the first execution attempt", async () => {
    const contract = artifact();
    const parameters = {
      toolId: contract.id,
      schemaVersion: contract.schemaVersion,
      input: {},
    };
    const description = {
      id: contract.id,
      schemaVersion: contract.schemaVersion,
      label: contract.adapters.pi!.label,
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      effects: { ...contract.effects, application: "write" as const },
      execution: {
        form: contract.execution.form,
        waitCeilingMilliseconds: 30_000,
        supportsCancellation: contract.execution.supportsCancellation,
        idempotency: contract.execution.idempotency,
        progress: contract.execution.progress,
        maximumInputBytes: contract.execution.maximumInputBytes,
        maximumOutputBytes: contract.execution.maximumOutputBytes,
        uncertainExternalOutcome: contract.execution.uncertainExternalOutcome,
      },
    } as const;
    const enabled = {
      enabled: true,
      presentation: {
        surface: "native" as const,
        mode: "progressive" as const,
      },
      accessBoundary: "environment" as const,
      enabledToolIds: [contract.id],
    };
    const disabled = { ...enabled, enabled: false };
    let policy = enabled;
    const invoke = vi.fn();
    const { manager } = sessionManager("sedes_act");
    const set = createPiAgentToolSet({
      facade: {
        eligibleCatalog: () => [contract],
        catalogSummaries: () => [],
        describeMany: () => [description],
        readPolicy: () => policy,
        invoke,
      },
      source,
      manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("ask"),
    });
    const approval = set.resolveApproval({
      toolCallId: "pi-call-1",
      toolName: "sedes_act",
      parameters,
    })!;
    set.recordApproval({
      toolCallId: "pi-call-1",
      toolName: "sedes_act",
      fingerprint: approval.fingerprint,
    });
    const action = set.tools.find(({ name }) => name === "sedes_act")!;

    policy = disabled;
    await expect(
      action.execute(
        "pi-call-1",
        parameters,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ name: "SedesAgentToolError:not_found" });

    policy = enabled;
    await expect(
      action.execute(
        "pi-call-1",
        parameters,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ name: "SedesAgentToolError:not_found" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("denies stale individual calls after mode or access changes", async () => {
    const contract = artifact();
    const progressiveInvoke = vi.fn();
    const progressive = createPiAgentToolSet({
      facade: {
        ...emptyDiscovery,
        eligibleCatalog: () => [contract],
        readPolicy: () => ({
          enabled: true,
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
          enabledToolIds: [contract.id],
        }),
        invoke: progressiveInvoke,
      },
      source,
      manager: sessionManager().manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("full"),
    });
    await expect(
      progressive.tools[0]!.execute(
        "pi-call-1",
        {},
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ name: "SedesAgentToolError:not_found" });
    expect(progressiveInvoke).not.toHaveBeenCalled();

    const actionContract = {
      ...contract,
      effects: { ...contract.effects, application: "write" as const },
    };
    const readOnlyInvoke = vi.fn();
    const readOnly = createPiAgentToolSet({
      facade: {
        ...emptyDiscovery,
        eligibleCatalog: () => [actionContract],
        readPolicy: () => ({
          enabled: true,
          presentation: { surface: "native", mode: "individual" },
          accessBoundary: "environment",
          enabledToolIds: [actionContract.id],
        }),
        invoke: readOnlyInvoke,
      },
      source,
      manager: sessionManager().manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("read_only"),
    });
    await expect(
      readOnly.tools[0]!.execute(
        "pi-call-1",
        {},
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ name: "SedesAgentToolError:not_found" });
    expect(readOnlyInvoke).not.toHaveBeenCalled();
  });

  it("records invocation identity at start before canonical execution continues", async () => {
    const { manager, entries } = sessionManager();
    const set = createPiAgentToolSet({
      facade: {
        ...emptyDiscovery,
        eligibleCatalog: () => [artifact()],
        readPolicy: () => enabledPolicy,
        async invoke<Output>(input: BackendAgentToolInvocationInput) {
          await input.onInvocationStarted?.("invocation-started");
          expect(
            entries.some(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === piAgentToolInvocationMarkerType,
            ),
          ).toBe(true);
          return {
            invocationId: "invocation-started",
            state: "completed",
            output: completedOutput() as Output,
          };
        },
      },
      source,
      manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("full"),
    });

    await expect(
      set.tools[0]!.execute(
        "pi-call-1",
        {},
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).resolves.toMatchObject({
      details: { invocation: { invocationId: "invocation-started" } },
    });
    expect(
      entries.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === piAgentToolInvocationMarkerType,
      ),
    ).toHaveLength(1);
  });

  it("validates with shared Ajv and invokes through trusted session context", async () => {
    const { manager, entries } = sessionManager();
    let observed: BackendAgentToolInvocationInput | undefined;
    const facade: BackendAgentToolFacade = {
      ...emptyDiscovery,
      eligibleCatalog: () => [artifact()],
      readPolicy: () => enabledPolicy,
      async invoke<Output>(input: BackendAgentToolInvocationInput) {
        observed = input;
        await input.onProgress?.({
          invocationId: "invocation-1",
          revision: 1,
          phase: "checking",
          message: "Checking trusted context.",
          percent: 50,
          boundedData: { status: "checking" },
        });
        return {
          invocationId: "invocation-1",
          state: "completed",
          output: completedOutput() as Output,
        };
      },
    };
    const set = createPiAgentToolSet({
      facade,
      source,
      manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("full"),
    });
    expect(set.descriptors).toContainEqual({
      toolName: "sedes_agent_context",
      toolId: "agent.context",
      schemaVersion: 2,
      displayName: "Sedes agent context",
      readOnly: true,
    });
    const tool = set.tools[0]!;
    expect(tool.prepareArguments?.({})).toEqual({});
    expect(() =>
      tool.prepareArguments?.({ modelSuppliedAuthority: true }),
    ).toThrow("pi_agent_tool_input_invalid");

    const abort = new AbortController();
    const updates: unknown[] = [];
    const result = await tool.execute(
      "pi-call-1",
      {},
      abort.signal,
      (update) => {
        expect(
          entries.some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === piAgentToolInvocationMarkerType,
          ),
        ).toBe(true);
        updates.push(update);
      },
      {} as never,
    );

    expect(observed).toMatchObject({
      source,
      adapter: "pi_sdk",
      request: {
        toolId: "agent.context",
        schemaVersion: 2,
        requestId: "pi-call-1",
        input: {},
      },
      signal: abort.signal,
    });
    expect(updates).toMatchObject([
      {
        content: [{ type: "text", text: "Checking trusted context." }],
        details: {
          progress: {
            invocationId: "invocation-1",
            revision: 1,
            phase: "checking",
          },
        },
      },
    ]);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          backendKind: "pi",
          effectiveCapabilities: ["execution.context.read"],
          sourceThreadId: "thread-1",
          sourceWorkspaceId: "workspace-1",
          status: "ok",
          trigger: "agent_call",
        }),
      },
    ]);
    const markerEntry = entries.find(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === piAgentToolInvocationMarkerType,
    )!;
    expect(
      readPiAgentToolInvocationMarker(markerEntry, authentication),
    ).toMatchObject({
      status: "authenticated",
      marker: {
        assistantEntryId: "assistant-entry",
        toolCallId: "pi-call-1",
        toolName: "sedes_agent_context",
        toolId: "agent.context",
        schemaVersion: 2,
        invocationId: "invocation-1",
      },
    });
  });

  it("rejects invalid direct execution before the facade is invoked", async () => {
    const { manager } = sessionManager();
    const invoke = vi.fn();
    const set = createPiAgentToolSet({
      facade: {
        ...emptyDiscovery,
        eligibleCatalog: () => [artifact()],
        readPolicy: () => enabledPolicy,
        invoke,
      },
      source,
      manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("full"),
    });
    await expect(
      set.tools[0]!.execute(
        "pi-call-1",
        { extra: true } as never,
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("pi_agent_tool_input_invalid");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("records failed invocation identity before surfacing a safe tool error", async () => {
    const { manager, entries } = sessionManager();
    const failed: SedesToolInvocationResult<never> = {
      invocationId: "invocation-failed",
      state: "failed",
      error: {
        code: "permission_denied",
        message: "This invocation is not permitted.",
        retryable: false,
      },
    };
    const set = createPiAgentToolSet({
      facade: {
        ...emptyDiscovery,
        eligibleCatalog: () => [artifact()],
        readPolicy: () => enabledPolicy,
        invoke: async () => failed,
      },
      source,
      manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("full"),
    });
    await expect(
      set.tools[0]!.execute(
        "pi-call-1",
        {},
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({
      name: "SedesAgentToolError:permission_denied",
      message: "This invocation is not permitted.",
    });
    expect(
      entries.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === piAgentToolInvocationMarkerType,
      ),
    ).toHaveLength(1);
  });

  it("redacts unexpected facade rejection diagnostics", async () => {
    const { manager, entries } = sessionManager();
    const set = createPiAgentToolSet({
      facade: {
        ...emptyDiscovery,
        eligibleCatalog: () => [artifact()],
        readPolicy: () => enabledPolicy,
        invoke: async () => {
          throw new Error("sqlite /secret/path token=do-not-persist");
        },
      },
      source,
      manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("full"),
    });
    await expect(
      set.tools[0]!.execute(
        "pi-call-1",
        {},
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({
      name: "SedesAgentToolError:internal_error",
      message: "The Sedes tool invocation could not be started.",
    });
    expect(JSON.stringify(entries)).not.toContain("do-not-persist");
    expect(
      entries.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === piAgentToolInvocationMarkerType,
      ),
    ).toHaveLength(0);
  });

  it("keeps the original assistant and provider turn when the branch advances", async () => {
    const { manager, entries } = sessionManager();
    const facade: BackendAgentToolFacade = {
      ...emptyDiscovery,
      eligibleCatalog: () => [artifact()],
      readPolicy: () => enabledPolicy,
      async invoke<Output>(input: BackendAgentToolInvocationInput) {
        await input.onProgress?.({
          invocationId: "invocation-steered",
          revision: 1,
          phase: "checking",
        });
        entries.push({
          type: "message",
          id: "steer-user-entry",
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "2026-07-31T00:00:03.000Z",
          message: { role: "user", content: "Steer while the tool runs" },
        } as SessionEntry);
        return {
          invocationId: "invocation-steered",
          state: "completed",
          output: completedOutput() as Output,
        };
      },
    };
    const set = createPiAgentToolSet({
      facade,
      source,
      manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("full"),
    });
    await expect(
      set.tools[0]!.execute(
        "pi-call-1",
        {},
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).resolves.toMatchObject({
      details: { invocation: { state: "completed" } },
    });
    const marker = entries.find(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === piAgentToolInvocationMarkerType,
    )!;
    expect(
      readPiAgentToolInvocationMarker(marker, authentication),
    ).toMatchObject({
      status: "authenticated",
      marker: {
        assistantEntryId: "assistant-entry",
        invocationId: "invocation-steered",
      },
    });
  });

  it("uses the captured turn-start correlation when a steer precedes the tool call", async () => {
    const { manager, entries } = sessionManager();
    const assistantEntry = entries.pop()!;
    entries.push(
      {
        type: "message",
        id: "steer-user-entry",
        parentId: "user-entry",
        timestamp: "2026-07-31T00:00:01.000Z",
        message: { role: "user", content: "Steer before the tool call" },
      } as SessionEntry,
      {
        ...assistantEntry,
        parentId: "steer-user-entry",
      } as SessionEntry,
    );
    let observed: BackendAgentToolInvocationInput | undefined;
    const set = createPiAgentToolSet({
      facade: {
        ...emptyDiscovery,
        eligibleCatalog: () => [artifact()],
        readPolicy: () => enabledPolicy,
        async invoke<Output>(input: BackendAgentToolInvocationInput) {
          observed = input;
          return {
            invocationId: "invocation-after-steer",
            state: "completed",
            output: completedOutput() as Output,
          };
        },
      },
      source,
      manager,
      authentication,
      providerTurnCorrelation: () => "user-entry",
      toolAccess: new PiToolAccessController("full"),
    });

    await expect(
      set.tools[0]!.execute(
        "pi-call-1",
        {},
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).resolves.toMatchObject({
      details: { invocation: { state: "completed" } },
    });
    expect(observed?.source).toBe(source);
    expect(
      entries.findLast(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )?.id,
    ).toBe("steer-user-entry");
  });

  it("fails closed on ambiguous catalogs and reserved extension collisions", () => {
    const { manager } = sessionManager();
    expect(() =>
      createPiAgentToolSet({
        facade: {
          ...emptyDiscovery,
          eligibleCatalog: () => [artifact(), artifact()],
          readPolicy: () => enabledPolicy,
          invoke: vi.fn(),
        },
        source,
        manager,
        authentication,
        providerTurnCorrelation: () => "user-entry",
        toolAccess: new PiToolAccessController("full"),
      }),
    ).toThrow("pi_agent_tool_catalog_ambiguous");
    expect(() =>
      assertNoPiAgentToolExtensionCollisions([
        { tools: new Map([["sedes_agent_context", {}]]) },
      ]),
    ).toThrow("pi_agent_tool_reserved_name_collision");
    expect(() =>
      assertNoPiAgentToolExtensionCollisions([
        { tools: new Map([["ordinary_extension", {}]]) },
      ]),
    ).not.toThrow();
  });
});
