import { describe, expect, it } from "vitest";
import type { SequencedBackendEvent } from "../../src/shared/protocol/backend.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBinding,
  CreateConversationResult,
} from "../../src/server/backends/contracts.js";
import {
  InMemoryConformanceDriver,
  type InMemoryConformanceDriverOptions,
} from "../../src/server/backends/testing/in-memory-conformance-driver.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../../src/server/backends/fork-context-boundary.js";
import {
  describeBackendDriverConformance,
  type BackendDriverConformanceFixture,
} from "../support/backend-driver-conformance.js";

const instance: AgentBackendInstance = {
  id: "conformance-backend",
  tenantId: "tenant-1",
  kind: "pi",
  label: "In-memory conformance backend",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "conformance-v1",
};

const connection: AgentConnectionProfile = {
  id: "conformance-connection",
  tenantId: "tenant-1",
  ownerPrincipalId: "principal-1",
  templateId: "conformance-template",
  kind: "pi_sdk",
  backendInstanceId: instance.id,
  executionEnvironmentId: "10000000-0000-4000-8000-000000000001",
  label: "In-memory conformance connection",
  enabled: true,
  configurationRevision: 1,
};

const workspace: ValidatedWorkspace = {
  authorityRevision: 1,
  summary: {
    id: "20000000-0000-4000-8000-000000000001",
    environmentId: connection.executionEnvironmentId,
    displayName: "Conformance workspace",
    displayPath: "/work/conformance",
    availability: "available",
    trustState: "trusted",
    revision: 1,
  },
  canonicalPath: "/work/conformance",
};

async function fixture(
  options: Pick<
    InMemoryConformanceDriverOptions,
    | "interactionMode"
    | "maximumProjectionBufferEvents"
    | "scriptedResponses"
    | "uncertainSubmissionOperationIds"
  > = {},
): Promise<BackendDriverConformanceFixture> {
  let clock = Date.parse("2026-07-30T18:00:00.000Z");
  const driver = new InMemoryConformanceDriver({
    instance,
    connection,
    now: () => new Date(clock++).toISOString(),
    ...options,
  });
  return {
    driver,
    scope: {
      tenantId: connection.tenantId,
      principalId: connection.ownerPrincipalId,
    },
    workspace,
    binding(
      created: CreateConversationResult,
      applicationThreadId = "30000000-0000-4000-8000-000000000001",
    ): ConversationBinding {
      return {
        tenantId: connection.tenantId,
        ownerPrincipalId: connection.ownerPrincipalId,
        applicationThreadId,
        backendInstanceId: instance.id,
        connectionProfileId: connection.id,
        executionEnvironmentId: connection.executionEnvironmentId,
        backendConversationId: created.backendConversationId,
        createdAt: new Date(clock++).toISOString(),
      };
    },
  };
}

describeBackendDriverConformance("in-memory reference", (options) =>
  fixture(
    options?.completeTurns
      ? { scriptedResponses: { stepDelayMilliseconds: 10 } }
      : {},
  ),
);

describe("in-memory conformance fault boundaries", () => {
  it("rejects an unadvertised provider-snapshot checkpoint directly", async () => {
    const current = await fixture();
    const created = await current.driver.create({
      scope: current.scope,
      workspace: current.workspace,
      applicationThreadId: "snapshot-unsupported-create",
      applicationOperationId: "snapshot-unsupported-create",
      source: { kind: "user" },
    });
    const handle = await current.driver.attach({
      scope: current.scope,
      binding: current.binding(created),
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const capabilities = await handle.backendCapabilities();
    expect(capabilities.branching).toMatchObject({
      availability: "available",
      boundaries: ["latest_completed", "selected_completed_turn"],
    });

    await expect(
      current.driver.resolveBranchCheckpoint({
        scope: current.scope,
        binding: current.binding(created),
        workspace: current.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
        selection: { kind: "latest_provider_snapshot" },
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "memory_provider_snapshot_fork_unsupported",
      retryable: false,
      crossedSubmissionBoundary: false,
    });
    await handle.close();
  });

  it("can project an import-only capability surface for normalized journeys", async () => {
    const current = await fixture({ interactionMode: "read_only" });
    const created = await current.driver.create({
      scope: current.scope,
      workspace: current.workspace,
      applicationThreadId: "read-only-create",
      applicationOperationId: "read-only-create",
      source: { kind: "user" },
    });
    const handle = await current.driver.attach({
      scope: current.scope,
      binding: current.binding(created),
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      actions: [],
      deliveryModes: [],
      steerTarget: null,
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      composerAttachments: {
        fileStaging: false,
        nativeImage: false,
      },
      supportsHistory: true,
      branching: {
        availability: "unavailable",
        reason: { text: "This connection is read-only." },
      },
      interactionKinds: [],
    });
    await handle.close();
  });

  it("forks an explicit completed checkpoint while a later source turn remains active", async () => {
    const current = await fixture({
      scriptedResponses: { stepDelayMilliseconds: 10 },
    });
    const created = await current.driver.create({
      scope: current.scope,
      workspace: current.workspace,
      applicationThreadId: "active-fork-create",
      applicationOperationId: "active-fork-create",
      source: { kind: "user" },
    });
    const sourceBinding = current.binding(created, "active-fork-source");
    const handle = await current.driver.attach({
      scope: current.scope,
      binding: sourceBinding,
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      branching: { availability: "available", sourceMustBeIdle: false },
    });
    await handle.submit({
      applicationOperationId: "active-fork-first-submit",
      source: { kind: "user" },
      mutationId: "active-fork-first-mutation",
      reconciliationToken: "active-fork-first-mutation",
      text: "Complete this turn first.",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
    });
    await expect
      .poll(async () => {
        const page = await handle.history({ limit: 10 });
        const first = page.orderedBackendTurnIds[0];
        return first ? page.turnsById[first]?.endedBy : undefined;
      })
      .toBe("agent_settled");
    const settled = await handle.history({ limit: 10 });
    const selectedBackendTurnId = settled.orderedBackendTurnIds[0]!;
    const active = await handle.submit({
      applicationOperationId: "active-fork-second-submit",
      source: { kind: "user" },
      mutationId: "active-fork-second-mutation",
      reconciliationToken: "active-fork-second-mutation",
      text: "Remain active while the earlier checkpoint is copied.",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
    });
    const latest = (backendTurnId: string) => current.driver.resolveBranchCheckpoint({
      scope: current.scope,
      binding: sourceBinding,
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
      selection: { kind: "latest_completed", backendTurnId },
    });
    // The backend forks exactly the latest completed turn the actor recorded.
    await expect(latest(active.backendTurnId!)).rejects.toMatchObject({
      retryable: true, backendCode: "memory_checkpoint_latest_turn_changed",
    });
    await expect(latest(selectedBackendTurnId)).resolves.toMatchObject({ kind: "conversation_leaf" });
    const checkpoint = await current.driver.resolveBranchCheckpoint({
      scope: current.scope,
      binding: sourceBinding,
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
      selection: {
        kind: "selected_completed_turn",
        backendTurnId: selectedBackendTurnId,
        boundary: "completed_turn_inclusive",
      },
    });
    const child = await current.driver.branchConversation({
      scope: current.scope,
      applicationOperationId: "active-fork-branch",
      childApplicationThreadId: "active-fork-child",
      source: { kind: "user" },
      sourceBinding,
      sourceOpaqueBindingDetail: created.opaqueBindingDetail,
      workspace: current.workspace,
      sourceCheckpoint: checkpoint,
      requestedBackendConversationId: "active-fork-native-child",
      inheritedSettings: {},
    });
    const childRead = await current.driver.read({
      scope: current.scope,
      binding: current.binding(child, "active-fork-child"),
      workspace: current.workspace,
      opaqueBindingDetail: child.opaqueBindingDetail,
    });
    expect(childRead.snapshot).toMatchObject({
      orderedBackendTurnIds: [selectedBackendTurnId],
      runState: "idle",
    });
    const sourceRead = await current.driver.read({
      scope: current.scope,
      binding: sourceBinding,
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    expect(sourceRead.snapshot).toMatchObject({
      runState: "running",
      activeBackendTurnId: active.backendTurnId,
    });
    expect(sourceRead.snapshot.orderedBackendTurnIds).toHaveLength(2);

    await handle.interrupt({
      applicationOperationId: "active-fork-cleanup",
      expectedBackendTurnId: active.backendTurnId!,
    });
    await handle.close();
  });

  it("bounds projection buffering, invalidates once, and supports authoritative replacement", async () => {
    const current = await fixture({ maximumProjectionBufferEvents: 2 });
    const created = await current.driver.create({
      scope: current.scope,
      workspace: current.workspace,
      applicationThreadId: "overflow-create",
      applicationOperationId: "overflow-create",
      source: { kind: "user" },
    });
    const binding = current.binding(created);
    const handle = await current.driver.attach({
      scope: current.scope,
      binding,
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const initial = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(initial.history).toEqual({ operational: true });
    await handle.submit({
      applicationOperationId: "overflow-submit",
      source: { kind: "user" },
      mutationId: "overflow-mutation",
      reconciliationToken: "overflow-mutation",
      text: "Generate more events than the detached projection can retain.",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
    });
    const invalidations: SequencedBackendEvent[] = [];
    const unsubscribe = initial.subscribeFromNext((event) => {
      invalidations.push(event);
    });
    expect(invalidations).toEqual([
      {
        handleSequence: initial.handleSequence + 1,
        event: {
          type: "resnapshot_required",
          reason: "buffer_overflow",
        },
      },
    ]);
    unsubscribe();

    const replacement = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(replacement.history).toEqual({ operational: true });
    expect(replacement.snapshot.runState).toBe("running");
    const afterReplacement: SequencedBackendEvent[] = [];
    replacement.subscribeFromNext((event) => afterReplacement.push(event));
    await handle.interrupt({
      applicationOperationId: "overflow-interrupt",
      expectedBackendTurnId: replacement.snapshot.activeBackendTurnId!,
    });
    expect(
      afterReplacement.map(({ handleSequence }) => handleSequence),
    ).toEqual(
      afterReplacement.map(
        (_, index) => replacement.handleSequence + index + 1,
      ),
    );
    expect(
      afterReplacement.some(
        ({ event }) =>
          event.type === "run_state_changed" && event.state === "idle",
      ),
    ).toBe(true);
    await handle.close();
  });

  it("classifies post-acceptance uncertainty and reconciles the terminal result", async () => {
    const current = await fixture({
      uncertainSubmissionOperationIds: ["uncertain-submit"],
    });
    const created = await current.driver.create({
      scope: current.scope,
      workspace: current.workspace,
      applicationThreadId: "uncertain-create",
      applicationOperationId: "uncertain-create",
      source: { kind: "user" },
    });
    const binding = current.binding(created);
    const handle = await current.driver.attach({
      scope: current.scope,
      binding,
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    let failure: unknown;
    try {
      await handle.submit({
        applicationOperationId: "uncertain-submit",
        source: { kind: "user" },
        mutationId: "uncertain-mutation",
        reconciliationToken: "uncertain-mutation",
        text: "Accept this before reporting uncertainty.",
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      category: "submission_unknown",
      retryable: true,
      crossedSubmissionBoundary: true,
    });

    const replay = await handle.submit({
      applicationOperationId: "uncertain-submit",
      source: { kind: "user" },
      mutationId: "uncertain-mutation",
      reconciliationToken: "uncertain-mutation",
      text: "Accept this before reporting uncertainty.",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
    });
    expect(
      await current.driver.reconcileSubmission({
        scope: current.scope,
        binding,
        workspace: current.workspace,
        applicationOperationId: "uncertain-submit",
        reconciliationToken: replay.reconciliationToken,
      }),
    ).toMatchObject({
      status: "accepted",
      backendTurn: { status: "in_progress" },
    });
    await handle.interrupt({
      applicationOperationId: "uncertain-interrupt",
      expectedBackendTurnId: replay.backendTurnId!,
    });
    expect(
      await current.driver.reconcileSubmission({
        scope: current.scope,
        binding,
        workspace: current.workspace,
        applicationOperationId: "uncertain-submit",
        reconciliationToken: replay.reconciliationToken,
      }),
    ).toMatchObject({
      status: "accepted",
      backendTurn: { status: "interrupted" },
      completionIdentity: expect.any(String),
    });
    const read = await current.driver.read({
      scope: current.scope,
      binding,
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    expect(read.snapshot.orderedBackendTurnIds).toHaveLength(1);
    await handle.close();
  });

  it("rejects a history cursor after the authoritative timeline changes", async () => {
    const current = await fixture();
    const created = await current.driver.create({
      scope: current.scope,
      workspace: current.workspace,
      applicationThreadId: "stale-history-create",
      applicationOperationId: "stale-history-create",
      source: { kind: "user" },
    });
    const handle = await current.driver.attach({
      scope: current.scope,
      binding: current.binding(created),
      workspace: current.workspace,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    for (const index of [1, 2]) {
      const submitted = await handle.submit({
        applicationOperationId: `stale-history-submit-${index}`,
        source: { kind: "user" },
        mutationId: `stale-history-mutation-${index}`,
        reconciliationToken: `stale-history-mutation-${index}`,
        text: `Turn ${index}`,
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
      });
      await handle.interrupt({
        applicationOperationId: `stale-history-interrupt-${index}`,
        expectedBackendTurnId: submitted.backendTurnId!,
      });
    }
    const page = await handle.history({ limit: 1 });
    expect(page.previousCursor).toBeTypeOf("string");
    const submitted = await handle.submit({
      applicationOperationId: "stale-history-submit-3",
      source: { kind: "user" },
      mutationId: "stale-history-mutation-3",
      reconciliationToken: "stale-history-mutation-3",
      text: "Turn 3",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
    });
    await handle.interrupt({
      applicationOperationId: "stale-history-interrupt-3",
      expectedBackendTurnId: submitted.backendTurnId!,
    });
    await expect(
      handle.history({ cursor: page.previousCursor, limit: 1 }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "memory_history_cursor_invalid",
    });
    await handle.close();
  });
});
