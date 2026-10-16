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
const automationId = "0191cfe0-7d51-7a51-ae51-555555555555";
const targetAutomationId = "0191cfe0-7d51-7a51-ae51-777777777777";
const firstMutationId = "0191cfe0-7d51-7a51-ae51-333333333333";

function definition(
  overrides: Partial<ThreadAutomationDefinition> = {},
): ThreadAutomationDefinition {
  return {
    id: automationId,
    threadId: sourceThreadId,
    name: "Review",
    source: {
      title: "Assistant",
      workspaceId: "workspace-1",
      environmentId: "environment-1",
      targetId: "target-1",
      groupId: null,
      backendLabel: "Pi",
      available: true,
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 1,
    },
    status: "paused",
    runMode: "same_thread",
    scheduleKind: "interval",
    revision: 4,
    runsRevision: 0,
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
      projectId: "project-1",
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
        projectId: "project-1",
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
        {
          kind: "automation",
          id: automationId,
          environmentId: "environment-1",
        },
        {
          kind: "automation",
          id: targetAutomationId,
          environmentId: "environment-2",
        },
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
    get: vi.fn((_scope, id) =>
      id === targetAutomationId
        ? { ...current, id: targetAutomationId, threadId: targetThreadId }
        : current,
    ),
    list: vi.fn(() => ({ items: [current], nextCursor: null })),
    delete: vi.fn(),
    preview: vi.fn((...args: Parameters<AutomationService["preview"]>) => {
      scheduleValidation.preview(...args);
      return ["2026-08-08T01:05:00.000Z", "2026-08-08T01:10:00.000Z"];
    }),
    replayCreate: vi.fn(
      () => undefined as ThreadAutomationDefinition | undefined,
    ),
    create: vi.fn(() => current),
    update: vi.fn(() => current),
    setState: vi.fn(() => current),
    listRuns: vi.fn(() => ({ items: [], nextCursor: null })),
    runNow: vi.fn(async () => ({
      automationId,
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
    automationCapability: vi.fn(async () => ({
      canCloneOnRun: input?.canCloneOnRun ?? true,
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
        name: "Review",
        initialState: "paused",
        mutationId: firstMutationId,
        misfirePolicy: null,
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

    expect(setup.threads.automationCapability).not.toHaveBeenCalled();
    expect(setup.automations.create).toHaveBeenCalledWith(
      scope,
      sourceThreadId,
      expect.objectContaining({
        mutationId: firstMutationId,
        misfirePolicy: null,
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
      {
        expectedRevision: 3,
        prompt: "  Changed  ",
        automationId: targetAutomationId,
      },
      context(),
    );

    expect(setup.automations.get).toHaveBeenCalledWith(
      scope,
      targetAutomationId,
    );
    expect(setup.automations.update).toHaveBeenCalledWith(
      scope,
      targetAutomationId,
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
      { automationId, expectedRevision: 4, precheck: null },
      context(),
    );
    expect(setup.automations.update).toHaveBeenCalledWith(
      scope,
      automationId,
      expect.objectContaining({ precheck: null }),
      expect.any(Number),
    );
  });

  it("rejects clone configuration through the shared capability guard", async () => {
    const setup = fixture({ canCloneOnRun: false });
    await expect(
      setup.service.create(
        {
          name: "Review",
          initialState: "paused",
          mutationId: firstMutationId,
          misfirePolicy: null,
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

  it("owns a cancelled clone capability read through drain and never later mutates", async () => {
    let resolveCapability!: (value: {
      readonly canCloneOnRun: boolean;
    }) => void;
    const capability = new Promise<{ readonly canCloneOnRun: boolean }>(
      (resolve) => {
        resolveCapability = resolve;
      },
    );
    const setup = fixture();
    setup.threads.automationCapability.mockReturnValue(capability);
    const controller = new AbortController();
    const executor = canonical(setup);
    const invocation = executor.invoke(
      {
        toolId: "automation.create",
        schemaVersion: 2,
        requestId: "cancel-clone-read",
        input: {
          name: "Review",
          initialState: "paused",
          mutationId: firstMutationId,
          misfirePolicy: null,
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
      expect(setup.threads.automationCapability).toHaveBeenCalledOnce(),
    );
    controller.abort();

    await expect(invocation).rejects.toMatchObject({ code: "cancelled" });
    let closed = false;
    const close = executor.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolveCapability({ canCloneOnRun: true });
    await close;
    expect(closed).toBe(true);
    expect(setup.automations.create).not.toHaveBeenCalled();
  });

  it("bounds run history defaults and uses each invocation's fresh mutation for run now", async () => {
    const setup = fixture();
    const invocation = context();
    setup.service.listRuns({ automationId }, invocation);
    expect(setup.automations.listRuns).toHaveBeenCalledWith(
      scope,
      automationId,
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
    await setup.service.runNow(
      { automationId, mutationId: firstMutationId },
      context(firstMutationId),
    );
    await setup.service.runNow(
      { automationId, mutationId: secondMutationId },
      context(secondMutationId),
    );
    expect(setup.automations.runNow).toHaveBeenNthCalledWith(
      1,
      scope,
      automationId,
      firstMutationId,
      expect.any(Number),
    );
    expect(setup.automations.runNow).toHaveBeenNthCalledWith(
      2,
      scope,
      automationId,
      secondMutationId,
      expect.any(Number),
    );
  });

  it("keeps the frozen run tool shape by stripping browser run detail", async () => {
    const setup = fixture();
    const detailed = {
      id: firstMutationId,
      automationId,
      occurrence: "manual" as const,
      scheduledFor: "2026-08-08T00:00:00.000Z",
      state: "failed" as const,
      runMode: "same_thread" as const,
      definitionRevision: 3,
      coalescedCount: 0,
      forceResetAt: "2026-08-08T00:05:00.000Z",
      turn: {
        id: "turn_settled",
        outcome: "failed" as const,
        settledAt: "2026-08-08T00:04:00.000Z",
        startedAt: "2026-08-08T00:01:00.000Z",
        endedAt: "2026-08-08T00:03:59.000Z",
      },
      precheck: {
        status: "failed" as const,
        command: "exit 3",
        timeoutSeconds: 10,
        durationMilliseconds: 12,
        stdoutBytes: 0,
        stdoutIncluded: false,
        exitCode: 3,
      },
    };
    const frozen = {
      id: firstMutationId,
      automationId,
      occurrence: "manual",
      scheduledFor: "2026-08-08T00:00:00.000Z",
      state: "failed",
      runMode: "same_thread",
      coalescedCount: 0,
      precheck: {
        status: "failed",
        durationMilliseconds: 12,
        stdoutBytes: 0,
        stdoutIncluded: false,
        exitCode: 3,
      },
    };
    setup.automations.listRuns.mockReturnValue({
      items: [detailed],
      nextCursor: null,
      counts: { all: 1, problems: 1, skipped: 0 },
    } as never);
    setup.automations.runNow.mockResolvedValue(detailed as never);

    expect(setup.service.listRuns({ automationId }, context())).toEqual({
      items: [frozen],
      nextCursor: null,
    });
    await expect(
      setup.service.runNow(
        { automationId, mutationId: firstMutationId },
        context(),
      ),
    ).resolves.toEqual(frozen);
    // The current v2 contracts retain bounded run details and require identity.
    await expect(
      canonical(setup).invoke(
        {
          toolId: "automation.runs",
          schemaVersion: 2,
          requestId: "frozen-run-shape",
          input: { automationId },
        },
        invocationSource,
      ),
    ).resolves.toMatchObject({
      state: "completed",
      output: { items: [frozen], nextCursor: null },
    });
  });

  it("keeps the frozen definition shape by stripping the last run's turn", async () => {
    const lastRun = {
      id: firstMutationId,
      state: "completed" as const,
      occurrence: "scheduled" as const,
      scheduledFor: "2026-08-08T00:00:00.000Z",
      finishedAt: "2026-08-08T00:00:02.000Z",
      resultThreadId: sourceThreadId,
    };
    const setup = fixture({
      definition: definition({
        lastRun: {
          ...lastRun,
          turn: { outcome: "failed", endedAt: "2026-08-08T00:09:00.000Z" },
        },
      }),
    });

    await expect(
      setup.service.get({ automationId }, context()),
    ).resolves.toMatchObject({
      lastRun,
    });
    await expect(
      setup.service.get({ automationId }, context()),
    ).resolves.not.toHaveProperty("runsRevision");
    for (const result of [
      await setup.service.get({ automationId }, context()),
      await setup.service.setState(
        { automationId, expectedRevision: 4, action: "pause" },
        context(),
      ),
    ]) {
      expect(result.lastRun).toEqual(lastRun);
    }
    // The current v2 contracts retain bounded run details and require identity.
    await expect(
      canonical(setup).invoke(
        {
          toolId: "automation.get",
          schemaVersion: 2,
          requestId: "frozen-definition-shape",
          input: { automationId },
        },
        invocationSource,
      ),
    ).resolves.toMatchObject({ state: "completed", output: { lastRun } });
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
    const target = { automationId: targetAutomationId };
    const invocations = [
      setup.service.get(target, denied),
      Promise.resolve().then(() => setup.service.listRuns(target, denied)),
      setup.service.create(
        {
          name: "Review",
          initialState: "paused",
          mutationId: firstMutationId,
          misfirePolicy: null,
          threadId: targetThreadId,
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
      Promise.resolve().then(() =>
        setup.service.runNow(
          { ...target, mutationId: firstMutationId },
          denied,
        ),
      ),
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
    expect(setup.threads.automationCapability).not.toHaveBeenCalled();
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
    expect(registry.get("automation.run_now", 2).effects).toEqual({
      application: "write",
      modelUsage: "agent_execution",
      external: "durable_side_effect",
    });
    expect(registry.get("automation.run_now", 2).execution).toMatchObject({
      adapterWaitCeilingMilliseconds: { cli: 90_000 },
      uncertainExternalOutcome: true,
    });
    expect(
      registry.validatesInput("automation.update", 2, {
        automationId,
        expectedRevision: 4,
        precheck: null,
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("automation.create", 2, {
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
          schemaVersion: 2,
          requestId: "no-change",
          input: { expectedRevision: 4, automationId: targetAutomationId },
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
          schemaVersion: 2,
          requestId: "invalid-timestamp",
          input: {
            name: "Review",
            initialState: "paused",
            mutationId: firstMutationId,
            misfirePolicy: null,
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
          schemaVersion: 2,
          requestId: "invalid-precheck",
          input: {
            name: "Review",
            initialState: "paused",
            mutationId: firstMutationId,
            misfirePolicy: null,
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
        schemaVersion: 2,
        requestId: "too-frequent-cron",
        input: {
          name: "Review",
          initialState: "paused",
          mutationId: firstMutationId,
          misfirePolicy: null,
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
          schemaVersion: 2,
          requestId: "invalid-timezone",
          input: {
            automationId,
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
    expect(setup.automations.update).not.toHaveBeenCalled();
  });

  it("admits a semantically valid cron schedule through authoritative validation", async () => {
    const setup = fixture();
    await expect(
      setup.service.create(
        {
          name: "Review",
          initialState: "paused",
          mutationId: firstMutationId,
          misfirePolicy: "coalesce",
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
          schemaVersion: 2,
          requestId: "stale-revision",
          input: { automationId, expectedRevision: 3, prompt: "Changed" },
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
          schemaVersion: 2,
          requestId: "escaped-prompt",
          input: {
            name: "Review",
            initialState: "paused",
            mutationId: firstMutationId,
            misfirePolicy: null,
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
          schemaVersion: 2,
          requestId: "escaped-definition",
          input: { automationId },
        },
        invocationSource,
      ),
    ).resolves.toMatchObject({ state: "completed" });
  });
  it("lists independent identities on the current thread without leaking full prompt or precheck", async () => {
    const setup = fixture();
    const executor = canonical(setup);
    const result = await executor.invoke(
      {
        toolId: "automation.list",
        schemaVersion: 1,
        requestId: "list",
        input: {},
      },
      invocationSource,
    );
    expect(setup.automations.list).toHaveBeenCalledWith(scope, {
      threadId: sourceThreadId,
      pageSize: 50,
    });
    expect(result).toMatchObject({
      state: "completed",
      output: {
        items: [
          {
            id: automationId,
            name: "Review",
            threadId: sourceThreadId,
            promptPreview: "Existing prompt",
          },
        ],
        nextCursor: null,
      },
    });
    const output = (result as { output: { items: unknown[] } }).output;
    expect(output.items[0]).not.toHaveProperty("prompt");
    expect(output.items[0]).not.toHaveProperty("precheck");
  });

  it("requires explicit entity identity and rejects the retired version", async () => {
    const executor = canonical(fixture());
    await expect(
      executor.invoke(
        {
          toolId: "automation.get",
          schemaVersion: 2,
          requestId: "missing-id",
          input: {},
        },
        invocationSource,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      executor.invoke(
        {
          toolId: "automation.get",
          schemaVersion: 1,
          requestId: "old-version",
          input: { threadId: sourceThreadId },
        },
        invocationSource,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("requires caller keys for create and run now and preserves keys across invocation retries", async () => {
    const setup = fixture(),
      executor = canonical(setup);
    const input = {
      name: "Reminder",
      initialState: "enabled",
      prompt: "Remind me",
      runMode: "same_thread",
      schedule: { kind: "date_time", runAt: "2026-08-09T00:00:00.000Z" },
      misfirePolicy: null,
    };
    await expect(
      executor.invoke(
        {
          toolId: "automation.create",
          schemaVersion: 2,
          requestId: "no-key",
          input,
        },
        invocationSource,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      executor.invoke(
        {
          toolId: "automation.run_now",
          schemaVersion: 2,
          requestId: "run-no-key",
          input: { automationId },
        },
        invocationSource,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    for (const requestId of ["first", "retry"]) {
      await executor.invoke(
        {
          toolId: "automation.create",
          schemaVersion: 2,
          requestId,
          input: { ...input, mutationId: firstMutationId },
        },
        invocationSource,
      );
      await executor.invoke(
        {
          toolId: "automation.run_now",
          schemaVersion: 2,
          requestId,
          input: { automationId, mutationId: firstMutationId },
        },
        invocationSource,
      );
    }
    expect(setup.automations.create).toHaveBeenCalledTimes(2);
    expect(
      setup.automations.create.mock.calls.every(
        (call: any[]) =>
          call[2].mutationId === firstMutationId &&
          call[2].initialState === "enabled",
      ),
    ).toBe(true);
    expect(
      setup.automations.runNow.mock.calls.every(
        (call: any[]) =>
          call[1] === automationId && call[2] === firstMutationId,
      ),
    ).toBe(true);
  });

  it("does not reuse another automation's admitted resource", async () => {
    const setup = fixture();
    const authority = {
      ...context(),
      environmentAuthority: {
        ...context().environmentAuthority,
        resolvedResourceRefs:
          context().environmentAuthority.resolvedResourceRefs.filter(
            (ref) => ref.id !== targetAutomationId,
          ),
      },
    };
    await expect(
      setup.service.setState(
        {
          automationId: targetAutomationId,
          expectedRevision: 4,
          action: "pause",
        },
        authority,
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(setup.automations.get).not.toHaveBeenCalled();
    expect(setup.automations.setState).not.toHaveBeenCalled();
  });

  it("replays an existing create receipt before checking mutable fork capability", async () => {
    const setup = fixture({ canCloneOnRun: false });
    setup.automations.replayCreate.mockReturnValue(
      definition({ runMode: "clone" }),
    );
    await expect(
      setup.service.create(
        {
          name: "Review",
          initialState: "paused",
          mutationId: firstMutationId,
          prompt: "Review",
          runMode: "clone",
          schedule: { kind: "date_time", runAt: "2026-08-09T00:00:00.000Z" },
          misfirePolicy: null,
        },
        context(),
      ),
    ).resolves.toMatchObject({ id: automationId, runMode: "clone" });
    expect(setup.threads.automationCapability).not.toHaveBeenCalled();
    expect(setup.automations.create).not.toHaveBeenCalled();
  });
  it.each([undefined, "clone"] as const)("edits an existing clone without rechecking current Fork eligibility (requested mode %s)", async (requestedMode) => {
    const setup = fixture({definition: definition({runMode:"clone"}),canCloneOnRun:false});
    await setup.service.update({automationId,expectedRevision:4,name:"Renamed Fork",prompt:"Updated Fork prompt",...(requestedMode ? {runMode:requestedMode}: {})},context());
    expect(setup.threads.automationCapability).not.toHaveBeenCalled();
    expect(setup.automations.update).toHaveBeenCalledWith(scope,automationId,expect.objectContaining({name:"Renamed Fork",prompt:"Updated Fork prompt",runMode:"clone"}),expect.any(Number));
  });

  it("still checks Fork eligibility when an existing automation changes to clone", async () => {
    const setup = fixture({canCloneOnRun:false});
    await expect(setup.service.update({automationId,expectedRevision:4,runMode:"clone"},context())).rejects.toMatchObject({code:"invalid_transition"});
    expect(setup.threads.automationCapability).toHaveBeenCalledOnce();
    expect(setup.automations.update).not.toHaveBeenCalled();
  });

  it("uses the persisted 160-character name bound on create, update, and output schemas", async () => {
    const setup=fixture(), executor=canonical(setup), longName="n".repeat(160);
    const input={name:longName,initialState:"paused",prompt:"Review",runMode:"same_thread",schedule:{kind:"date_time",runAt:"2026-08-09T00:00:00.000Z"},misfirePolicy:null,mutationId:firstMutationId};
    expect(executor.registry.validatesInput("automation.create",2,input)).toBe(true);
    expect(executor.registry.validatesInput("automation.create",2,{...input,name:longName+"n"})).toBe(false);
    expect(executor.registry.validatesInput("automation.update",2,{automationId,expectedRevision:4,name:longName})).toBe(true);
    expect(executor.registry.validatesInput("automation.update",2,{automationId,expectedRevision:4,name:longName+"n"})).toBe(false);
    const result=await setup.service.get({automationId},context());
    expect(executor.registry.validatesOutput("automation.get",2,{...result,name:longName})).toBe(true);
    expect(executor.registry.validatesOutput("automation.get",2,{...result,name:longName+"n"})).toBe(false);
  });

});
