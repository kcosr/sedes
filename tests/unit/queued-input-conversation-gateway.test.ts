import { describe, expect, it, vi } from "vitest";
import type {
  ConversationActor,
  ConversationActorEvent,
} from "../../src/server/conversations/conversation-actor.js";
import type { AcquireConversationActorInput } from "../../src/server/conversations/conversation-actor-manager.js";
import { RuntimeBackedQueuedInputConversationGateway } from "../../src/server/conversations/queued-input-conversation-gateway.js";
import type { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import { ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const applicationThreadId = "thread-1";

function target(): AcquireConversationActorInput {
  return {
    scope,
    binding: {
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId,
      backendConversationId: "backend-thread-1",
      backendInstanceId: "backend-1",
      connectionProfileId: "connection-1",
      executionEnvironmentId: "environment-1",
      createdAt: "2026-07-30T12:00:00.000Z",
    },
    workspace: {
      canonicalPath: "/workspace",
      summary: {
        id: "workspace-1",
        environmentId: "environment-1",
        displayName: "Workspace",
        displayPath: "/workspace",
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    },
    execution: {
      scope,
      environmentId: "environment-1",
      workspaceId: "workspace-1",
    },
    driver: {},
    opaqueBindingDetail: "opaque",
  } as unknown as AcquireConversationActorInput;
}

describe("RuntimeBackedQueuedInputConversationGateway", () => {
  it.each([
    ["idle", true],
    ["failed", true],
    ["running", false],
  ] as const)(
    "reports an authoritative %s actor as settled=%s",
    async (runState, expected) => {
      const actor = {
        timeline: { generation: "generation-1", runState },
        // Background work can forbid cleanup while the next turn is ready.
        canEvict: false,
        authoritativelySettled: runState === "idle" || runState === "failed",
      } as unknown as ConversationActor;
      const release = vi.fn();
      const acquire = vi.fn(async () => ({ actor, release }));
      const gateway = new RuntimeBackedQueuedInputConversationGateway({
        runtimes: { acquire },
        targets: {
          resolve: vi.fn(async () => target()),
        },
      });

      const settled = await gateway.withConversation(
        scope,
        applicationThreadId,
        (conversation) => conversation.authoritativelySettled,
      );

      expect(settled).toBe(expected);
      expect(acquire).toHaveBeenCalledWith(scope, applicationThreadId);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["conversation", true, true, { kind: "conversation" }],
    ["conversation", true, false, null],
    ["conversation", false, true, null],
    ["turn", true, true, null],
  ] as const)(
    "validates settled %s targeting with capability=%s and durable intent=%s",
    async (steerTarget, available, allowSettledConversation, expected) => {
      const actor = {
        timeline: { generation: "generation-1", runState: "idle", activeTurnId: "old-turn" },
        authoritativelySettled: true,
        backendCapabilities: vi.fn(async () => ({ deliveryModes: available ? ["steer"] : [], steerTarget })),
      } as unknown as ConversationActor;
      const gateway = new RuntimeBackedQueuedInputConversationGateway({
        runtimes: { acquire: vi.fn(async () => ({ actor, release: vi.fn() })) },
        targets: { resolve: vi.fn(async () => target()) },
      });
      await expect(gateway.withConversation(scope, applicationThreadId, (conversation) =>
        conversation.steerTarget!({ allowSettledConversation }),
      )).resolves.toEqual(expected);
    },
  );

  it("clears the live actor submission latch when reconciliation proves non-acceptance", async () => {
    const reconcileSubmissionNotAccepted = vi.fn(async () => undefined);
    const actor = {
      timeline: { generation: "generation-1", runState: "idle" },
      authoritativelySettled: false,
      reconcileSubmissionNotAccepted,
    } as unknown as ConversationActor;
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ actor, release }));
    const resolvedTarget = target();
    resolvedTarget.driver.reconcileSubmission = vi.fn(async () => ({
      status: "not_accepted" as const,
      retryable: true,
    }));
    const gateway = new RuntimeBackedQueuedInputConversationGateway({
      runtimes: { acquire },
      targets: {
        resolve: vi.fn(async () => resolvedTarget),
      },
    });

    await expect(
      gateway.reconcileSubmission(scope, applicationThreadId, {
        applicationOperationId: "operation-1",
        reconciliationToken: "operation-1",
      }),
    ).resolves.toEqual({ status: "not_accepted", retryable: true });
    expect(acquire).toHaveBeenCalledWith(scope, applicationThreadId);
    expect(reconcileSubmissionNotAccepted).toHaveBeenCalledOnce();
    expect(reconcileSubmissionNotAccepted).toHaveBeenCalledWith("operation-1");
    expect(release).toHaveBeenCalledOnce();
  });

  it("re-resolves path-free attachment evidence for durable reconciliation", async () => {
    const actor = {
      timeline: { generation: "generation-1", runState: "idle" },
      authoritativelySettled: true,
    } as unknown as ConversationActor;
    const resolvedTarget = target();
    const reconcileSubmission = vi.fn(async () => ({
      status: "accepted" as const,
    }));
    resolvedTarget.driver.reconcileSubmission = reconcileSubmission;
    const descriptor = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "image" as const,
      fileName: "retry.png",
      mediaType: "image/png" as const,
      byteSize: 3,
    };
    const evidence = [{ ...descriptor, sha256: "a".repeat(64) }];
    const resolveCanonicalEvidence = vi.fn(() => evidence);
    const gateway = new RuntimeBackedQueuedInputConversationGateway({
      runtimes: {
        acquire: vi.fn(async () => ({ actor, release: vi.fn() })),
      },
      targets: { resolve: vi.fn(async () => resolvedTarget) },
      attachmentDelivery: { resolveCanonicalEvidence } as never,
    });

    await expect(
      gateway.reconcileSubmission(scope, applicationThreadId, {
        applicationOperationId: "operation-image",
        reconciliationToken: "token-image",
        attachments: [descriptor],
      }),
    ).resolves.toEqual({ status: "accepted" });
    expect(resolveCanonicalEvidence).toHaveBeenCalledWith(
      scope,
      applicationThreadId,
      [descriptor],
    );
    expect(reconcileSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentEvidence: evidence }),
    );
    expect(JSON.stringify(reconcileSubmission.mock.calls)).not.toContain(
      "agentPath",
    );
  });

  it("publishes background run activity without a browser thread subscription", async () => {
    let actorListener: ((event: ConversationActorEvent) => void) | undefined;
    const timeline = {
      generation: "generation-1",
      runState: "idle" as "idle" | "running",
    };
    const actor = {
      timeline,
      authoritativelySettled: true,
      ensureProjectionCurrent: vi.fn(async () => undefined),
      subscribe(listener: (event: ConversationActorEvent) => void) {
        actorListener = listener;
        return () => {
          actorListener = undefined;
        };
      },
      submit: vi.fn(async () => {
        timeline.runState = "running";
        actor.authoritativelySettled = false;
        actorListener?.({
          type: "projection_events",
          generation: timeline.generation,
          events: [
            {
              type: "run_state",
              generation: timeline.generation,
              state: "running",
            },
          ],
        });
        return {
          accepted: true as const,
          reconciliationToken: "reconciliation-1",
          completionCorrelation: "completion-1",
        };
      }),
    } as unknown as ConversationActor & { authoritativelySettled: boolean };
    const observedRunStates: string[] = [];
    const hubListeners = new Set<
      (input: { event: { type: string; state?: string } }) => void
    >();
    const hub = {
      subscriberCount: 0,
      subscribe(
        listener: (input: { event: { type: string; state?: string } }) => void,
      ) {
        hubListeners.add(listener);
        return { close: () => hubListeners.delete(listener) };
      },
      subscribeInternal(
        listener: (input: { event: { type: string; state?: string } }) => void,
      ) {
        hubListeners.add(listener);
        return { close: () => hubListeners.delete(listener) };
      },
      onSubscriberCountChanged: () => () => undefined,
      publish(event: { type: string; state?: string }) {
        for (const listener of hubListeners) listener({ event });
        return {};
      },
    };
    let coordinator!: ThreadRuntimeCoordinator;
    coordinator = new ThreadRuntimeCoordinator({
      actors: {
        acquire: vi.fn(async () => ({
          actor,
          release: vi.fn(),
        })),
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: async (input) => {
          await input.detachCoordinatorRuntime();
          return input.operation();
        },
      },
      targets: {
        resolve: vi.fn(async () => target()),
      },
      bridge: {
        bind(input: Parameters<ConversationEventBridge["bind"]>[0]) {
          const unsubscribe = input.actor.subscribe((event) => {
            if (event.type !== "projection_events") return;
            for (const projected of event.events) {
              input.hub.publish(projected);
            }
          });
          return {
            ready: Promise.resolve(),
            publishAuthoritativeReplacement: vi.fn(),
            release: async () => unsubscribe(),
          };
        },
      } as unknown as ConversationEventBridge,
      interactions: {
        bind: () => ({
          publishPending: vi.fn(),
          release: vi.fn(async () => undefined),
        }),
      } as never,
      hubs: {
        acquire: () => ({ hub, release: vi.fn() }),
      } as never,
      retentionMilliseconds: 60_000,
      onThreadChanged: async (eventScope, threadId) => {
        const loaded = await coordinator.captureLoadedState(
          eventScope,
          threadId,
        );
        if (loaded) observedRunStates.push(loaded.runState);
      },
    });
    const gateway = new RuntimeBackedQueuedInputConversationGateway({
      runtimes: coordinator,
      targets: {
        resolve: vi.fn(async () => target()),
      },
    });

    await gateway.withConversation(scope, applicationThreadId, (conversation) =>
      conversation.submit({
        applicationOperationId: "operation-1",
        source: { kind: "user" },
        mutationId: "mutation-1",
        reconciliationToken: "reconciliation-1",
        text: "Run in the background",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    );

    await vi.waitFor(() => expect(observedRunStates).toContain("running"));
    await coordinator.close();
  });
});
