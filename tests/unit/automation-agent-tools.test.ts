import { describe, expect, it, vi } from "vitest";
import type { ThreadAutomationDefinition } from "../../src/shared/protocol/automation-presentation.js";
import type {
  AgentToolDefinition,
  TrustedToolInvocationContext,
} from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { AutomationAgentToolService } from "../../src/server/agent-tools/tools/automation-agent-tool-service.js";
import { createAutomationCreateToolDefinition } from "../../src/server/agent-tools/tools/automation-create-tool.js";
import { createAutomationGetToolDefinition } from "../../src/server/agent-tools/tools/automation-get-tool.js";
import { createAutomationRunNowToolDefinition } from "../../src/server/agent-tools/tools/automation-run-now-tool.js";
import { createAutomationRunsToolDefinition } from "../../src/server/agent-tools/tools/automation-runs-tool.js";
import { createAutomationSetStateToolDefinition } from "../../src/server/agent-tools/tools/automation-set-state-tool.js";
import { createAutomationUpdateToolDefinition } from "../../src/server/agent-tools/tools/automation-update-tool.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { AutomationService } from "../../src/server/domain/automation-service.js";
import { DomainError } from "../../src/server/domain/errors.js";
import {
  CanonicalAgentToolRequestError,
  CanonicalInlineAgentToolService,
} from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const sourceThreadId = "0191cfe0-7d51-7a51-ae51-111111111111";
const targetThreadId = "0191cfe0-7d51-7a51-ae51-222222222222";
const firstMutationId = "0191cfe0-7d51-7a51-ae51-333333333333";

function definition(
  overrides: Partial<ThreadAutomationDefinition> = {},
): ThreadAutomationDefinition {
  return {
    status: "paused",
    runMode: "same_thread",
    scheduleKind: "interval",
    revision: 4,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    hasPrecheck: true,
    prompt: "Existing prompt",
    schedule: {
      kind: "interval",
      anchorAt: "2026-08-08T01:00:00.000Z",
      everySeconds: 300,
    },
    misfirePolicy: "skip",
    precheck: {
      command: "git status --short",
      timeoutSeconds: 10,
      includeStdout: false,
    },
    ...overrides,
  };
}

function context(mutationId = firstMutationId): TrustedToolInvocationContext {
  return {
    invocationId: "invocation-1",
    mutationId,
    ...scope,
    subject: {
      kind: "thread_agent",
      sourceThreadId,
      backendKind: "pi",
    },
    defaults: {
      kind: "thread_agent",
      environmentId: "environment-1",
      workspaceId: "0191cfe0-7d51-7a51-ae51-444444444444",
      threadId: sourceThreadId,
    },
    policyIdentity: {
      ownerKind: "thread",
      ownerId: sourceThreadId,
      revision: 1,
    },
    environmentAuthority: {
      id: "authority-1",
      callerKind: "thread_agent",
      defaults: {
        kind: "thread_agent",
        environmentId: "environment-1",
        workspaceId: "0191cfe0-7d51-7a51-ae51-444444444444",
        threadId: sourceThreadId,
      },
      policyIdentity: {
        ownerKind: "thread",
        ownerId: sourceThreadId,
        revision: 1,
      },
      admittedEnvironmentIds: ["environment-1", "environment-2"],
      targetEnvironmentIds: ["environment-2"],
      resolvedResourceRefs: [
        { kind: "thread", id: sourceThreadId, environmentId: "environment-1" },
        { kind: "thread", id: targetThreadId, environmentId: "environment-2" },
      ],
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
      canonicalInputDigest: "input-digest",
      authorityDigest: "authority-digest",
    },
    adapter: "http",
    effectiveCapabilities: [],
    hasCapability: () => false,
    requestId: "request-1",
    abortSignal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

function fixture(input?: {
  readonly canCloneOnRun?: boolean;
  readonly definition?: ThreadAutomationDefinition;
}) {
  const current = input?.definition ?? definition();
  const scheduleValidation = new AutomationService({
    repository: {} as never,
    inventory: {} as never,
    publisher: { publish: () => undefined },
    executionPolicy: { assertCanAutomate: () => undefined },
  });
  const automations = {
    get: vi.fn(() => current),
    preview: vi.fn((...args: Parameters<AutomationService["preview"]>) => {
      scheduleValidation.preview(...args);
      return ["2026-08-08T01:05:00.000Z", "2026-08-08T01:10:00.000Z"];
    }),
    create: vi.fn(() => current),
    update: vi.fn(() => current),
    setState: vi.fn(() => current),
    listRuns: vi.fn(() => ({ items: [], nextCursor: null })),
    runNow: vi.fn(async () => ({
      id: firstMutationId,
      occurrence: "manual" as const,
      scheduledFor: "2026-08-08T00:00:00.000Z",
      state: "queued" as const,
      runMode: "same_thread" as const,
      resultThreadId: sourceThreadId,
      coalescedCount: 0,
      claimedAt: "2026-08-08T00:00:00.000Z",
    })),
  };
  const threads = {
    snapshot: vi.fn(async () => ({
      capabilities: {
        automation: { canCloneOnRun: input?.canCloneOnRun ?? true },
      },
    })),
  };
  const inventory = {
    getThread: vi.fn((_scope, threadId: string) => ({
      thread: {
        id: threadId,
        environmentId:
          threadId === targetThreadId ? "environment-2" : "environment-1",
      },
    })),
  };
  const service = new AutomationAgentToolService({
    automations: automations as never,
    threads: threads as never,
    inventory: inventory as never,
    now: () => Date.parse("2026-08-08T00:00:00.000Z"),
  });
  return { automations, threads, inventory, service };
}

describe("automation canonical tool service", () => {
  function canonical(setup: ReturnType<typeof fixture>) {
    return new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      management: {} as never,
      automations: setup.service,
      threadCreation: {} as never,
      savedAgents: {} as never,
      invocationId: () => "0191cfe0-7d51-7a51-ae51-666666666666",
      mutationId: () => firstMutationId,
    });
  }

  const invocationSource = {
    scope,
    subject: context().subject,
    defaults: context().defaults,
    policyIdentity: context().policyIdentity,
    environmentAuthority: context().environmentAuthority,
    adapter: "http" as const,
    signal: new AbortController().signal,
  };

  it("defaults create to the source thread and creates paused, inert definition data", async () => {
    const setup = fixture();
    const result = await setup.service.create(
      {
        prompt: "Run the review",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: "2026-08-09T00:00:00.000Z",
        },
        precheck: {
          command: "npm test",
          timeoutSeconds: 60,
          includeStdout: true,
        },
      },
      context(),
    );

    expect(setup.threads.snapshot).not.toHaveBeenCalled();
    expect(setup.automations.create).toHaveBeenCalledWith(
      scope,
      sourceThreadId,
      expect.objectContaining({
        mutationId: firstMutationId,
        misfirePolicy: "coalesce",
        precheck: expect.objectContaining({ command: "npm test" }),
      }),
      Date.parse("2026-08-08T00:00:00.000Z"),
    );
    expect(result).toMatchObject({
      status: "paused",
      upcoming: ["2026-08-08T01:05:00.000Z", "2026-08-08T01:10:00.000Z"],
    });
  });

  it("read-merges a partial update, preserves omitted precheck, and keeps the caller CAS", async () => {
    const setup = fixture();
    await setup.service.update(
      { expectedRevision: 3, prompt: "  Changed  ", threadId: targetThreadId },
      context(),
    );

    expect(setup.automations.get).toHaveBeenCalledWith(scope, targetThreadId);
    expect(setup.automations.update).toHaveBeenCalledWith(
      scope,
      targetThreadId,
      expect.objectContaining({
        prompt: "Changed",
        runMode: "same_thread",
        misfirePolicy: "skip",
        precheck: expect.objectContaining({ command: "git status --short" }),
        expectedRevision: 3,
        mutationId: firstMutationId,
      }),
      Date.parse("2026-08-08T00:00:00.000Z"),
    );
  });

  it("clears only an explicitly null precheck", async () => {
    const setup = fixture();
    await setup.service.update(
      { expectedRevision: 4, precheck: null },
      context(),
    );
    expect(setup.automations.update).toHaveBeenCalledWith(
      scope,
      sourceThreadId,
      expect.objectContaining({ precheck: null }),
      expect.any(Number),
    );
  });

  it("rejects clone configuration through the shared capability guard", async () => {
    const setup = fixture({ canCloneOnRun: false });
    await expect(
      setup.service.create(
        {
          prompt: "Fork",
          runMode: "clone",
          schedule: {
            kind: "date_time",
            runAt: "2026-08-09T00:00:00.000Z",
          },
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(setup.automations.create).not.toHaveBeenCalled();
  });

  it("owns a cancelled clone snapshot through drain and never later mutates", async () => {
    let resolveSnapshot!: (value: {
      readonly capabilities: {
        readonly automation: { readonly canCloneOnRun: boolean };
      };
    }) => void;
    const snapshot = new Promise<{
      readonly capabilities: {
        readonly automation: { readonly canCloneOnRun: boolean };
      };
    }>((resolve) => {
      resolveSnapshot = resolve;
    });
    const setup = fixture();
    setup.threads.snapshot.mockReturnValue(snapshot);
    const controller = new AbortController();
    const executor = canonical(setup);
    const invocation = executor.invoke(
      {
        toolId: "automation.create",
        schemaVersion: 1,
        requestId: "cancel-clone-read",
        input: {
          prompt: "Fork",
          runMode: "clone",
          schedule: {
            kind: "date_time",
            runAt: "2026-08-09T00:00:00.000Z",
          },
        },
      },
      { ...invocationSource, signal: controller.signal },
    );
    await vi.waitFor(() =>
      expect(setup.threads.snapshot).toHaveBeenCalledOnce(),
    );
    controller.abort();

    await expect(invocation).rejects.toMatchObject({ code: "cancelled" });
    let closed = false;
    const close = executor.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolveSnapshot({
      capabilities: { automation: { canCloneOnRun: true } },
    });
    await close;
    expect(closed).toBe(true);
    expect(setup.automations.create).not.toHaveBeenCalled();
  });

  it("bounds run history defaults and uses each invocation's fresh mutation for run now", async () => {
    const setup = fixture();
    const invocation = context();
    setup.service.listRuns({}, invocation);
    expect(setup.automations.listRuns).toHaveBeenCalledWith(
      scope,
      sourceThreadId,
      {
        pageSize: 50,
        environmentAuthority: {
          sourceEnvironmentId: "environment-1",
          targetEnvironmentIds: ["environment-2"],
          policyRevision: 1,
        },
      },
    );

    const secondMutationId = "0191cfe0-7d51-7a51-ae51-555555555555";
    await setup.service.runNow({}, context(firstMutationId));
    await setup.service.runNow({}, context(secondMutationId));
    expect(setup.automations.runNow).toHaveBeenNthCalledWith(
      1,
      scope,
      sourceThreadId,
      firstMutationId,
      expect.any(Number),
    );
    expect(setup.automations.runNow).toHaveBeenNthCalledWith(
      2,
      scope,
      sourceThreadId,
      secondMutationId,
      expect.any(Number),
    );
  });

  it("rejects every unadmitted target before automation state or model work", async () => {
    const setup = fixture();
    const denied = {
      ...context(),
      environmentAuthority: {
        ...context().environmentAuthority,
        targetEnvironmentIds: [],
        resolvedResourceRefs: [
          {
            kind: "thread" as const,
            id: sourceThreadId,
            environmentId: "environment-1",
          },
        ],
      },
    };
    const target = { threadId: targetThreadId };
    const invocations = [
      setup.service.get(target, denied),
      Promise.resolve().then(() => setup.service.listRuns(target, denied)),
      setup.service.create(
        {
          ...target,
          prompt: "Review",
          runMode: "same_thread",
          schedule: {
            kind: "date_time",
            runAt: "2026-08-09T00:00:00.000Z",
          },
        },
        denied,
      ),
      setup.service.update(
        { ...target, expectedRevision: 4, prompt: "Review" },
        denied,
      ),
      setup.service.setState(
        { ...target, expectedRevision: 4, action: "enable" },
        denied,
      ),
      Promise.resolve().then(() => setup.service.runNow(target, denied)),
    ];
    for (const invocation of invocations) {
      await expect(invocation).rejects.toMatchObject({
        code: "permission_denied",
      });
    }
    for (const operation of [
      setup.automations.get,
      setup.automations.listRuns,
      setup.automations.create,
      setup.automations.update,
      setup.automations.setState,
      setup.automations.runNow,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
    expect(setup.threads.snapshot).not.toHaveBeenCalled();
  });

  it("registers all six closed canonical contracts with truthful effects", () => {
    const setup = fixture();
    const registry = new AgentToolRegistry();
    const definitions = [
      createAutomationGetToolDefinition(setup.service),
      createAutomationRunsToolDefinition(setup.service),
      createAutomationCreateToolDefinition(setup.service),
      createAutomationUpdateToolDefinition(setup.service),
      createAutomationSetStateToolDefinition(setup.service),
      createAutomationRunNowToolDefinition(setup.service),
    ];
    for (const tool of definitions) {
      registry.register(tool as AgentToolDefinition);
    }

    expect(registry.list().map(({ id }) => id)).toEqual([
      "automation.get",
      "automation.runs",
      "automation.create",
      "automation.update",
      "automation.set_state",
      "automation.run_now",
    ]);
    expect(registry.get("automation.run_now", 1).effects).toEqual({
      application: "write",
      modelUsage: "agent_execution",
      external: "durable_side_effect",
    });
    expect(registry.get("automation.run_now", 1).execution).toMatchObject({
      adapterWaitCeilingMilliseconds: { cli: 90_000 },
      uncertainExternalOutcome: true,
    });
    expect(
      registry.validatesInput("automation.update", 1, {
        expectedRevision: 4,
        precheck: null,
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("automation.create", 1, {
        prompt: "Review",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: "2026-08-09T00:00:00.000Z",
        },
        unexpected: true,
      }),
    ).toBe(false);
  });

  it("maps a no-change update to canonical invalid_input even with a target thread", async () => {
    await expect(
      canonical(fixture()).invoke(
        {
          toolId: "automation.update",
          schemaVersion: 1,
          requestId: "no-change",
          input: { expectedRevision: 4, threadId: targetThreadId },
        },
        invocationSource,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CanonicalAgentToolRequestError>>({
        code: "invalid_input",
      }),
    );
  });

  it("maps invalid timestamps and UTF-8 oversized prechecks to canonical invalid_input", async () => {
    const executor = canonical(fixture());
    await expect(
      executor.invoke(
        {
          toolId: "automation.create",
          schemaVersion: 1,
          requestId: "invalid-timestamp",
          input: {
            prompt: "Review",
            runMode: "same_thread",
            schedule: { kind: "date_time", runAt: "not-a-timestamp" },
          },
        },
        invocationSource,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      executor.invoke(
        {
          toolId: "automation.create",
          schemaVersion: 1,
          requestId: "invalid-precheck",
          input: {
            prompt: "Review",
            runMode: "same_thread",
            schedule: {
              kind: "date_time",
              runAt: "2026-08-09T00:00:00.000Z",
            },
            precheck: {
              command: "😀".repeat(1_025),
              timeoutSeconds: 30,
              includeStdout: false,
            },
          },
        },
        invocationSource,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("maps semantic schedule failures to useful bounded invalid_input before create or update", async () => {
    const setup = fixture();
    const executor = canonical(setup);
    const createFailure = executor.invoke(
      {
        toolId: "automation.create",
        schemaVersion: 1,
        requestId: "too-frequent-cron",
        input: {
          prompt: "Review",
          runMode: "same_thread",
          schedule: {
            kind: "cron",
            expression: "* * * * *",
            timeZone: "UTC",
          },
        },
      },
      invocationSource,
    );
    let createError: CanonicalAgentToolRequestError | undefined;
    try {
      await createFailure;
    } catch (error) {
      createError = error as CanonicalAgentToolRequestError;
    }
    expect(createError).toBeDefined();
    expect(createError).toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/schedule.*five minutes/i),
    });
    expect(createError!.message.length).toBeLessThanOrEqual(500);
    expect(setup.automations.create).not.toHaveBeenCalled();

    await expect(
      executor.invoke(
        {
          toolId: "automation.update",
          schemaVersion: 1,
          requestId: "invalid-timezone",
          input: {
            expectedRevision: 4,
            schedule: {
              kind: "cron",
              expression: "0 9 * * *",
              timeZone: "Mars/Olympus",
            },
          },
        },
        invocationSource,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/schedule.*timezone/i),
    });
    expect(setup.automations.get).not.toHaveBeenCalled();
    expect(setup.automations.update).not.toHaveBeenCalled();
  });

  it("admits a semantically valid cron schedule through authoritative validation", async () => {
    const setup = fixture();
    await expect(
      setup.service.create(
        {
          prompt: "Daily review",
          runMode: "same_thread",
          schedule: {
            kind: "cron",
            expression: "0 9 * * MON-FRI",
            timeZone: "America/Chicago",
          },
        },
        context(),
      ),
    ).resolves.toMatchObject({ status: "paused" });
    expect(setup.automations.create).toHaveBeenCalledOnce();
  });

  it("keeps a real update CAS failure on the canonical conflict path", async () => {
    const setup = fixture();
    setup.automations.update.mockImplementation(() => {
      throw new DomainError(
        "conflict",
        "The automation changed in another operation.",
      );
    });
    await expect(
      canonical(setup).invoke(
        {
          toolId: "automation.update",
          schemaVersion: 1,
          requestId: "stale-revision",
          input: { expectedRevision: 3, prompt: "Changed" },
        },
        invocationSource,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("admits a domain-legal prompt at its worst JSON escaping expansion", async () => {
    const setup = fixture();
    const prompt = "\u0001".repeat(65_536);
    await expect(
      canonical(setup).invoke(
        {
          toolId: "automation.create",
          schemaVersion: 1,
          requestId: "escaped-prompt",
          input: {
            prompt,
            runMode: "same_thread",
            schedule: {
              kind: "date_time",
              runAt: "2026-08-09T00:00:00.000Z",
            },
          },
        },
        invocationSource,
      ),
    ).resolves.toMatchObject({ state: "completed" });
    expect(setup.automations.create).toHaveBeenCalledWith(
      scope,
      sourceThreadId,
      expect.objectContaining({ prompt }),
      expect.any(Number),
    );
  });

  it("returns a domain-legal definition at its worst JSON escaping expansion", async () => {
    const escaped = fixture({
      definition: definition({
        prompt: "\u0001".repeat(65_536),
        precheck: {
          command: "\u0001".repeat(4_096),
          timeoutSeconds: 60,
          includeStdout: true,
        },
      }),
    });
    await expect(
      canonical(escaped).invoke(
        {
          toolId: "automation.get",
          schemaVersion: 1,
          requestId: "escaped-definition",
          input: {},
        },
        invocationSource,
      ),
    ).resolves.toMatchObject({ state: "completed" });
  });
});
