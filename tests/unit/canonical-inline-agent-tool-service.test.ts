import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/server/domain/errors.js";
import type { AgentToolDefinition } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import {
  CanonicalAgentToolRequestError,
  CanonicalInlineAgentToolService,
  mapAgentToolDomainError,
} from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { agentContextToolDefinition } from "../../src/server/agent-tools/tools/agent-context-tool.js";
import type { AgentManagementService } from "../../src/server/agent-tools/application/agent-management-service.js";
import { createTaskUpdateToolDefinition } from "../../src/server/agent-tools/tools/task-management-tools.js";
import { AutomationAgentToolService } from "../../src/server/agent-tools/tools/automation-agent-tool-service.js";
import { createAutomationCreateToolDefinition } from "../../src/server/agent-tools/tools/automation-create-tool.js";

const source = {
  scope: { tenantId: "tenant-1", principalId: "principal-1" },
  subject: {
    kind: "thread_agent" as const,
    sourceThreadId: "source-thread",
    backendKind: "pi" as const,
    runtimeGeneration: "runtime-1",
    activeTurnId: "turn-1",
    trigger: "agent_call" as const,
  },
  defaults: {
    kind: "thread_agent" as const,
    environmentId: "environment-1",
    workspaceId: "workspace-1",
    threadId: "source-thread",
  },
  policyIdentity: {
    ownerKind: "thread" as const,
    ownerId: "source-thread",
    revision: 1,
  },
  environmentAuthority: {
    id: "grant-1",
    callerKind: "thread_agent" as const,
    defaults: {
      kind: "thread_agent" as const,
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      threadId: "source-thread",
    },
    policyIdentity: {
      ownerKind: "thread" as const,
      ownerId: "source-thread",
      revision: 1,
    },
    admittedEnvironmentIds: ["environment-1"],
    targetEnvironmentIds: ["environment-1"],
    resolvedResourceRefs: [],
    canonicalInputDigest: "input-digest",
    authorityDigest: "authority-digest",
    display: { targetEnvironmentLabels: [], resourceLabels: [] },
  },
  adapter: "http" as const,
  signal: new AbortController().signal,
};

function writeDefinition(input: {
  readonly execute: AgentToolDefinition["execute"];
  readonly effects?: AgentToolDefinition["effects"];
}): AgentToolDefinition {
  return {
    ...agentContextToolDefinition,
    id: "example.write",
    description: "Writes one bounded example.",
    effects: input.effects ?? {
      application: "write",
      modelUsage: "none",
      external: "none",
    },
    execution: {
      ...agentContextToolDefinition.execution,
      supportsCancellation: false,
      concurrencyClass: "example_write",
      uncertainExternalOutcome: true,
    },
    catalog: { groupId: "tasks", label: "Example write", order: 999 },
    adapters: {
      pi: { name: "sedes_example_write", label: "Sedes example write" },
      mcp: { name: "sedes_example_write" },
      http: { invocation: "inline" },
      cli: { command: "example.write" },
    },
    execute: input.execute,
  };
}

describe("CanonicalInlineAgentToolService", () => {
  it("lists only explicit deterministic deployment exposure", () => {
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
    });
    expect(service.catalog("http", "thread_agent").map(({ id }) => id)).toEqual(
      ["agent.context", "thread.status"],
    );
    expect(
      service
        .catalog("http", "thread_agent")
        .every(({ deployment }) => deployment?.eligible),
    ).toBe(true);
  });

  it("filters and denies tools for a caller kind they do not admit", async () => {
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
    });
    const principalDefaults = {
      kind: "principal_client" as const,
      environmentId: "environment-1",
    };
    const principalPolicyIdentity = {
      ownerKind: "principal_client" as const,
      ownerId: "client-1",
      revision: 1,
      credentialGeneration: 1,
    };
    const principalSource = {
      ...source,
      subject: {
        kind: "principal_client" as const,
        clientId: "client-1",
        credentialGeneration: 1,
      },
      defaults: principalDefaults,
      policyIdentity: principalPolicyIdentity,
      environmentAuthority: {
        ...source.environmentAuthority,
        callerKind: "principal_client" as const,
        defaults: principalDefaults,
        policyIdentity: principalPolicyIdentity,
      },
    };

    expect(
      service.catalog("http", "principal_client").map(({ id }) => id),
    ).toEqual(["thread.status"]);
    expect(
      service.catalogSummaries("http", "principal_client").map(({ id }) => id),
    ).toEqual(["thread.status"]);
    expect(() =>
      service.describeMany("http", "principal_client", ["agent.context"]),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
    await expect(
      service.invoke(
        {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "ineligible-principal-client",
          input: {},
        },
        principalSource,
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("returns resolved source context without accepting identity input", async () => {
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      invocationId: () => "invocation-1",
    });
    await expect(
      service.invoke(
        {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "request-1",
          input: {},
        },
        source,
      ),
    ).resolves.toEqual({
      invocationId: "invocation-1",
      state: "completed",
      output: {
        threadId: "source-thread",
        workspaceId: "workspace-1",
        backend: "pi",
      },
    });
    await expect(
      service.invoke(
        {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "request-2",
          input: { sourceThreadId: "forged" },
        },
        source,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects mismatched caller, defaults, policy, and environment authority", async () => {
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
    });
    await expect(
      service.invoke(
        {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "incoherent-authority",
          input: {},
        },
        {
          ...source,
          policyIdentity: {
            ...source.policyIdentity,
            ownerId: "different-thread",
          },
        },
      ),
    ).rejects.toThrow("trusted_agent_tool_authority_incoherent");
  });

  it("scopes thread status through the injected reader and bounds its output", async () => {
    const readThreadStatus = vi.fn(async () => ({
      threadId: "target-thread",
      backend: "codex_app_server" as const,
      lifecycle: "snoozed" as const,
      activity: "waiting_for_input" as const,
    }));
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus },
      invocationId: () => "invocation-2",
    });
    await expect(
      service.invoke(
        {
          toolId: "thread.status",
          schemaVersion: 2,
          requestId: "request-3",
          input: { threadId: "target-thread" },
        },
        source,
      ),
    ).resolves.toMatchObject({
      state: "completed",
      output: {
        threadId: "target-thread",
        lifecycle: "snoozed",
        activity: "waiting_for_input",
      },
    });
    expect(readThreadStatus).toHaveBeenCalledWith(
      source.scope,
      "target-thread",
      source.environmentAuthority,
      expect.any(AbortSignal),
    );
  });

  it("returns stable not-found and cancellation errors", async () => {
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
    });
    await expect(
      service.invoke(
        {
          toolId: "thread.status",
          schemaVersion: 2,
          requestId: "missing",
          input: { threadId: "missing-thread" },
        },
        source,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CanonicalAgentToolRequestError>>({
        code: "not_found",
        retryable: false,
      }),
    );

    const abort = new AbortController();
    abort.abort();
    await expect(
      service.invoke(
        {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "cancelled",
          input: {},
        },
        { ...source, signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels an in-flight execution through the advertised signal", async () => {
    let executionSignal: AbortSignal | undefined;
    const service = new CanonicalInlineAgentToolService({
      application: {
        readThreadStatus: async (_scope, _threadId, _authority, signal) => {
          executionSignal = signal;
          return new Promise(() => undefined);
        },
      },
    });
    const abort = new AbortController();
    const invocation = service.invoke(
      {
        toolId: "thread.status",
        schemaVersion: 2,
        requestId: "in-flight-cancel",
        input: { threadId: "target-thread" },
      },
      { ...source, signal: abort.signal },
    );

    await vi.waitFor(() => expect(executionSignal).toBeInstanceOf(AbortSignal));
    abort.abort(new Error("caller_cancelled"));
    await expect(invocation).rejects.toMatchObject({ code: "cancelled" });
    expect(executionSignal?.aborted).toBe(true);
  });

  it("aborts active execution signals and drains them before close settles", async () => {
    let executionSignal: AbortSignal | undefined;
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [
        {
          ...agentContextToolDefinition,
          id: "example.shutdown-aware",
          adapters: {
            pi: {
              name: "sedes_example_shutdown_aware",
              label: "Sedes shutdown-aware example",
            },
            mcp: { name: "sedes_example_shutdown-aware" },
            http: { invocation: "inline" },
            cli: { command: "example.shutdown-aware" },
          },
          async execute(_input, context) {
            executionSignal = context.abortSignal;
            await new Promise<void>((resolve) => {
              context.abortSignal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return {
              threadId: context.defaults.threadId!,
              workspaceId: context.defaults.workspaceId!,
              backend:
                context.subject.kind === "thread_agent"
                  ? context.subject.backendKind
                  : "pi",
            };
          },
        },
      ],
    });
    const invocation = service.invoke(
      {
        toolId: "example.shutdown-aware",
        schemaVersion: 2,
        requestId: "shutdown-aware",
        input: {},
      },
      source,
    );
    await vi.waitFor(() => expect(executionSignal).toBeInstanceOf(AbortSignal));

    const firstClose = service.close();
    expect(service.close()).toBe(firstClose);
    await expect(invocation).rejects.toMatchObject({ code: "cancelled" });
    await expect(firstClose).resolves.toBeUndefined();
    expect(executionSignal?.aborted).toBe(true);
  });

  it("bounds an execution that ignores cancellation by its adapter deadline", async () => {
    vi.useFakeTimers();
    try {
      let executionSignal: AbortSignal | undefined;
      const service = new CanonicalInlineAgentToolService({
        application: {
          readThreadStatus: async (_scope, _threadId, _authority, signal) => {
            executionSignal = signal;
            return new Promise(() => undefined);
          },
        },
      });
      const invocation = service.invoke(
        {
          toolId: "thread.status",
          schemaVersion: 2,
          requestId: "deadline",
          input: { threadId: "target-thread" },
        },
        source,
      );

      const rejection = expect(invocation).rejects.toMatchObject({
        code: "timed_out",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(executionSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes admitted writes once with a fresh hidden mutation id", async () => {
    const calls: Array<{ mutationId: string; requestId: string }> = [];
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      invocationId: () => "invocation-write",
      mutationId: (() => {
        let next = 0;
        return () => `mutation-${++next}`;
      })(),
      additionalDefinitions: [
        writeDefinition({
          execute: async (_input, context) => {
            calls.push({
              mutationId: context.mutationId,
              requestId: context.requestId,
            });
            return {
              threadId: context.defaults.threadId!,
              workspaceId: context.defaults.workspaceId!,
              backend:
                context.subject.kind === "thread_agent"
                  ? context.subject.backendKind
                  : "pi",
            };
          },
        }),
      ],
    });

    for (let index = 0; index < 2; index += 1) {
      await expect(
        service.invoke(
          {
            toolId: "example.write",
            schemaVersion: 2,
            requestId: "same-correlation-id",
            input: {},
          },
          source,
        ),
      ).resolves.toMatchObject({ state: "completed" });
    }
    expect(calls).toEqual([
      { mutationId: "mutation-1", requestId: "same-correlation-id" },
      { mutationId: "mutation-2", requestId: "same-correlation-id" },
    ]);
  });

  it("announces invocation identity before entering domain execution", async () => {
    const order: string[] = [];
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      invocationId: () => "invocation-before-write",
      additionalDefinitions: [
        writeDefinition({
          execute: async (_input, context) => {
            order.push(`execute:${context.invocationId}`);
            return {
              threadId: context.defaults.threadId!,
              workspaceId: context.defaults.workspaceId!,
              backend:
                context.subject.kind === "thread_agent"
                  ? context.subject.backendKind
                  : "pi",
            };
          },
        }),
      ],
    });
    await service.invoke(
      {
        toolId: "example.write",
        schemaVersion: 2,
        requestId: "invocation-start-order",
        input: {},
      },
      {
        ...source,
        onInvocationStarted: (invocationId) => {
          order.push(`started:${invocationId}`);
        },
      },
    );
    expect(order).toEqual([
      "started:invocation-before-write",
      "execute:invocation-before-write",
    ]);
  });

  it("never enters a write after shutdown interrupts its invocation-start hook", async () => {
    let releaseStart!: () => void;
    const invocationStarted = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const execute = vi.fn(async (_input, context) => ({
      threadId: context.defaults.threadId!,
      workspaceId: context.defaults.workspaceId!,
      backend:
        context.subject.kind === "thread_agent"
          ? context.subject.backendKind
          : "pi",
    }));
    const onInvocationStarted = vi.fn(() => invocationStarted);
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [writeDefinition({ execute })],
    });
    const invocation = service.invoke(
      {
        toolId: "example.write",
        schemaVersion: 2,
        requestId: "shutdown-before-write",
        input: {},
      },
      { ...source, onInvocationStarted },
    );
    await vi.waitFor(() => expect(onInvocationStarted).toHaveBeenCalledOnce());

    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await expect(invocation).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseStart();
    await closing;
    expect(execute).not.toHaveBeenCalled();
  });

  it("mirrors a source abort raced between admission and boundary setup", async () => {
    const execute = vi.fn(async () => ({}));
    const live = new AbortController();
    const aborted = new AbortController();
    aborted.abort(new Error("raced_source_abort"));
    let signalReads = 0;
    const racedSource = { ...source };
    Object.defineProperty(racedSource, "signal", {
      get: () => (++signalReads === 1 ? live.signal : aborted.signal),
    });
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [writeDefinition({ execute })],
    });

    await expect(
      service.invoke(
        {
          toolId: "example.write",
          schemaVersion: 2,
          requestId: "raced-source-abort",
          input: {},
        },
        racedSource,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("admits the approved durable-effect combinations", async () => {
    const execute = vi.fn(async (_input, context) => ({
      threadId: context.defaults.threadId!,
      workspaceId: context.defaults.workspaceId!,
      backend:
        context.subject.kind === "thread_agent"
          ? context.subject.backendKind
          : "pi",
    }));
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [
        writeDefinition({
          execute,
          effects: {
            application: "write",
            modelUsage: "agent_execution",
            external: "durable_side_effect",
          },
        }),
      ],
    });
    await expect(
      service.invoke(
        {
          toolId: "example.write",
          schemaVersion: 2,
          requestId: "model-start",
          input: {},
        },
        source,
      ),
    ).resolves.toMatchObject({ state: "completed" });
    expect(execute).toHaveBeenCalledTimes(1);

    const externalWrite = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [
        writeDefinition({
          execute,
          effects: {
            application: "write",
            modelUsage: "none",
            external: "durable_side_effect",
          },
        }),
      ],
    });
    await expect(
      externalWrite.invoke(
        {
          toolId: "example.write",
          schemaVersion: 2,
          requestId: "durable-write",
          input: {},
        },
        source,
      ),
    ).resolves.toMatchObject({ state: "completed" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects destructive and unsupported mixed effects before execution", async () => {
    const execute = vi.fn(async () => ({}));
    const destructive = writeDefinition({ execute });
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [
        {
          ...destructive,
          effects: {
            application: "destructive",
            modelUsage: "none",
            external: "durable_side_effect",
          },
        },
      ],
    });
    await expect(
      service.invoke(
        {
          toolId: "example.write",
          schemaVersion: 2,
          requestId: "destructive",
          input: {},
        },
        source,
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("ends only the wait when a write times out and never replays it", async () => {
    vi.useFakeTimers();
    try {
      const committed: string[] = [];
      const execute = vi.fn(
        async (
          _input: unknown,
          context: Parameters<AgentToolDefinition["execute"]>[1],
        ) =>
          new Promise((resolve) => {
            setTimeout(() => {
              committed.push(context.mutationId);
              resolve({
                threadId: context.defaults.threadId!,
                workspaceId: context.defaults.workspaceId!,
                backend:
                  context.subject.kind === "thread_agent"
                    ? context.subject.backendKind
                    : "pi",
              });
            }, 31_000);
          }),
      );
      const service = new CanonicalInlineAgentToolService({
        application: { readThreadStatus: async () => undefined },
        mutationId: () => "late-write-mutation",
        additionalDefinitions: [writeDefinition({ execute })],
      });
      const invocation = service.invoke(
        {
          toolId: "example.write",
          schemaVersion: 2,
          requestId: "late-write",
          input: {},
        },
        source,
      );

      const rejection = expect(invocation).rejects.toMatchObject({
        code: "timed_out",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(execute).toHaveBeenCalledTimes(1);
      expect(committed).toEqual([]);
      let closed = false;
      const closing = service.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await closing;
      expect(committed).toEqual(["late-write-mutation"]);
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(
        service.invoke(
          {
            toolId: "example.write",
            schemaVersion: 2,
            requestId: "after-close",
            input: {},
          },
          source,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps shared Zod refinements to invalid_input", async () => {
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [
        createTaskUpdateToolDefinition({} as AgentManagementService),
      ],
    });

    await expect(
      service.invoke(
        {
          toolId: "task.update",
          schemaVersion: 1,
          requestId: "empty-task-update",
          input: {
            taskId: "0191cfe0-7d51-7a51-ae51-111111111111",
            expectedRevision: 0,
          },
        },
        source,
      ),
    ).rejects.toMatchObject({ code: "invalid_input", retryable: false });
  });

  it("rejects a blank automation prompt as invalid input before domain mutation", async () => {
    const create = vi.fn();
    const automations = new AutomationAgentToolService({
      automations: { create } as never,
      threads: { snapshot: vi.fn() } as never,
      inventory: {
        getThread: vi.fn(() => ({
          thread: {
            id: source.defaults.threadId,
            environmentId: source.defaults.environmentId,
          },
        })),
      } as never,
    });
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [
        createAutomationCreateToolDefinition(automations),
      ],
    });

    await expect(
      service.invoke(
        {
          toolId: "automation.create",
          schemaVersion: 1,
          requestId: "blank-automation-prompt",
          input: {
            prompt: " \n ",
            runMode: "same_thread",
            schedule: {
              kind: "date_time",
              runAt: "2026-08-09T00:00:00.000Z",
            },
          },
        },
        {
          ...source,
          environmentAuthority: {
            ...source.environmentAuthority,
            resolvedResourceRefs: [
              {
                kind: "thread" as const,
                id: source.defaults.threadId,
                environmentId: source.defaults.environmentId,
              },
            ],
          },
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("maps domain failures to bounded stable tool errors", () => {
    expect(
      mapAgentToolDomainError(new DomainError("not_found", "secret")),
    ).toMatchObject({ code: "not_found", retryable: false });
    expect(
      mapAgentToolDomainError(
        new DomainError("task_revision_conflict", "secret"),
      ),
    ).toMatchObject({ code: "conflict", retryable: false });
    expect(
      mapAgentToolDomainError(
        new DomainError("workspace_file_download_too_large", "secret"),
      ),
    ).toMatchObject({ code: "conflict", retryable: false });
    expect(
      mapAgentToolDomainError(new DomainError("cursor_invalid", "secret")),
    ).toMatchObject({ code: "invalid_input", retryable: false });
    expect(
      mapAgentToolDomainError(
        new DomainError("runtime_unavailable", "secret", true),
      ),
    ).toMatchObject({ code: "unavailable", retryable: true });
    expect(
      mapAgentToolDomainError(
        new DomainError("operation_outcome_uncertain", "secret"),
      ),
    ).toMatchObject({ code: "uncertain_outcome", retryable: false });
  });

  it("explains a removed-project write rejection without exposing other database errors", async () => {
    const message = "The project was removed. Restore it before adding saved work.";
    const execute = vi.fn(async () => {
      throw Object.assign(new Error(message), { code: "SQLITE_CONSTRAINT_TRIGGER" });
    });
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      additionalDefinitions: [writeDefinition({ execute })],
    });
    const request = { toolId: "example.write", schemaVersion: 2, requestId: "removed-project", input: {} };
    await expect(service.invoke(request, source)).rejects.toMatchObject({ code: "conflict", message, retryable: false });
    execute.mockRejectedValueOnce(Object.assign(new Error("private database diagnostic"), { code: "SQLITE_CONSTRAINT_TRIGGER" }));
    await expect(service.invoke({ ...request, requestId: "unrelated-database-failure" }, source))
      .rejects.toMatchObject({ code: "internal_error", message: "The tool invocation failed." });
    await service.close();
  });
});
