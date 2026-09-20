import { isDeepStrictEqual } from "node:util";
import type { BackendConversationEvent } from "../../shared/protocol/backend.js";
import type {
  NormalizedThreadEvent,
  NormalizedThreadSnapshot,
  ThreadCapabilityDocument,
  ThreadForkSourceCapability,
  ThreadEventEnvelope,
  TurnForkCapability,
} from "../../shared/protocol/conversation.js";
import type {
  InteractionBrokerPublisher,
} from "../conversations/interaction-broker.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  ConversationActorEvent,
  ConversationActorListener,
  ConversationActorSnapshotState,
} from "../conversations/conversation-actor.js";
import { SerializedMailbox } from "../conversations/serialized-mailbox.js";
import { interactionRunState } from "../conversations/thread-interaction-run-state.js";
import type { ThreadEventHub } from "./thread-event-hub.js";

type AncillaryBackendEvent = Extract<
  BackendConversationEvent,
  {
    readonly type:
      | "interaction_opened"
      | "interaction_resolved"
      | "capabilities_changed"
      | "usage_changed"
      | "notice";
  }
>;

const MAX_CAPABILITY_COMPOSITION_ATTEMPTS = 3;

export interface ConversationEventBridgeSource {
  subscribe(listener: ConversationActorListener): () => void;
}

export interface ConversationEventBridgeProjection {
  snapshot(
    scope: RequestScope,
    applicationThreadId: string,
    state: ConversationActorSnapshotState,
  ): Promise<NormalizedThreadSnapshot>;
  /**
   * Capability document and provider feature envelopes composed together
   * from one targeted-state pass — capabilities_changed is the frequent
   * backend-driven feature transition signal, so each normalized publication
   * carries both values and costs one authorization and one composition.
   */
  capabilitiesAndProviderFeatures(
    scope: RequestScope,
    applicationThreadId: string,
    state: ConversationActorSnapshotState,
  ): Promise<{
    readonly threadRevision: number;
    readonly capabilities: ThreadCapabilityDocument;
    readonly providerFeatures: NormalizedThreadSnapshot["providerFeatures"];
    readonly interactions: NormalizedThreadSnapshot["interactions"];
  }>;
  forkSource(
    scope: RequestScope,
    applicationThreadId: string,
    state: ConversationActorSnapshotState,
  ): Promise<ThreadForkSourceCapability>;
  ancillary(
    scope: RequestScope,
    applicationThreadId: string,
    generation: string,
    event: AncillaryBackendEvent,
  ): Promise<readonly NormalizedThreadEvent[]>;
}

export interface ConversationEventBridgeBinding
  extends InteractionBrokerPublisher {
  readonly ready: Promise<void>;
  publishAuthoritativeReplacement(): Promise<ThreadEventEnvelope>;
  /** Local shutdown detachment; does not wait for provider-facing work. */
  detach(): void;
  release(): Promise<void>;
}

/**
 * Serializes actor callbacks into one validated thread-event publication
 * stream. Projection replacement always publishes a complete snapshot before
 * any incremental event in that generation.
 */
export class ConversationEventBridge {
  readonly #projection: ConversationEventBridgeProjection;
  /**
   * The runtime coordinator owns exactly one binding per process-wide actor,
   * but its release path drains asynchronously: an evicted binding's queued
   * publications can still run while a replacement establishment binds the
   * same actor. Fencing the prior binding at bind time is the fail-closed
   * backstop: without it, the stale backlog drains behind the new binding's
   * freshly captured snapshot and poisons the hub's retained event order
   * (a publication-order inversion every later attach must reject).
   */
  readonly #activeBindings = new WeakMap<
    ConversationEventBridgeSource,
    ConversationEventBridgeBinding
  >();

  constructor(projection: ConversationEventBridgeProjection) {
    this.#projection = projection;
  }

  bind(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly actor: ConversationEventBridgeSource;
    readonly hub: ThreadEventHub;
    readonly captureAuthoritativeState?: () => Promise<ConversationActorSnapshotState>;
    readonly onFailure?: (error: unknown) => void | Promise<void>;
  }): ConversationEventBridgeBinding {
    this.#activeBindings.get(input.actor)?.detach();
    const mailbox = new SerializedMailbox();
    let bindingValid = true;
    let initialSeen = false;
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => undefined);
    const reportFailure = (error: unknown): void => {
      if (!initialSeen) readyReject(error);
      try {
        const reported = input.onFailure?.(error);
        if (reported) void reported.catch(() => undefined);
      } catch {
        // Failure observers cannot poison bridge settlement.
      }
    };
    const publishCurrentControls = async (generation: string): Promise<void> => {
      if (!bindingValid || input.hub.projectionGeneration !== generation) return;
      if (!input.captureAuthoritativeState) {
        throw new Error("conversation_event_bridge_capture_unavailable");
      }
      for (
        let attempt = 0;
        attempt < MAX_CAPABILITY_COMPOSITION_ATTEMPTS;
        attempt += 1
      ) {
        const state = await input.captureAuthoritativeState();
        if (state.timeline.generation !== generation) return;
        const { threadRevision, capabilities, providerFeatures, interactions } =
          await this.#projection.capabilitiesAndProviderFeatures(
            input.scope,
            input.applicationThreadId,
            state,
          );
        // A replacement generation makes this backend event obsolete.
        // Otherwise compare and publish synchronously so another
        // application-owned transition cannot interleave between them.
        if (!bindingValid || input.hub.projectionGeneration !== generation) return;
        const publishedRevision = input.hub.threadSummary?.threadRevision;
        if (publishedRevision === undefined) {
          throw new Error("conversation_event_bridge_snapshot_missing");
        }
        if (threadRevision < publishedRevision) {
          if (attempt + 1 === MAX_CAPABILITY_COMPOSITION_ATTEMPTS) {
            throw new Error("conversation_event_bridge_capability_revision_churn");
          }
          continue;
        }
        const snapshot = input.hub.snapshot!;
        // Publish the gate and the controls from the same composition.
        // Keep capabilities last: clients remain fail-closed while the
        // run-state transition is being delivered.
        if (snapshot.runState !== capabilities.runState) {
          input.hub.publish({
            type: "run_state",
            generation,
            state: capabilities.runState,
            ...(snapshot.activeTurnId
              ? { activeTurnId: snapshot.activeTurnId }
              : {}),
          });
        }
        for (const pending of snapshot.interactions) {
          if (!interactions.some(({ id }) => id === pending.id)) {
            input.hub.publish({
              type: "interaction_resolved",
              generation,
              interactionId: pending.id,
            });
          }
        }
        for (const interaction of interactions) {
          if (
            !isDeepStrictEqual(
              snapshot.interactions.find(({ id }) => id === interaction.id),
              interaction,
            )
          ) {
            input.hub.publish({
              type: "interaction_opened",
              generation,
              interaction,
            });
          }
        }
        input.hub.publish({
          type: "capabilities_changed",
          generation,
          threadRevision,
          capabilities,
          providerFeatures,
        });
        return;
      }
    };

    const accept = (event: ConversationActorEvent): void => {
      const operation = mailbox.enqueue(async () => {
        if (!bindingValid) return;
        if (!initialSeen && event.type !== "projection_replaced") {
          throw new Error("conversation_event_bridge_snapshot_missing");
        }
        switch (event.type) {
          case "authoritative_completion":
            return;
          case "projection_replaced": {
            const snapshot = await this.#projection.snapshot(
              input.scope,
              input.applicationThreadId,
              event.state,
            );
            input.hub.publish({
              type: "snapshot",
              generation: event.state.timeline.generation,
              snapshot,
            });
            if (!initialSeen) {
              initialSeen = true;
              readyResolve();
            }
            return;
          }
          case "projection_events":
            for (const normalizedEvent of event.events) {
              if (normalizedEvent.generation !== event.generation) {
                throw new Error(
                  "conversation_event_bridge_generation_mismatch",
                );
              }
              const currentForkSource = input.hub.snapshot?.forkSource;
              if (!currentForkSource) {
                throw new Error("conversation_event_bridge_snapshot_missing");
              }
              if (normalizedEvent.type === "turn_upsert") {
                input.hub.publish({
                  ...normalizedEvent,
                  fork: clampTurnFork(normalizedEvent.fork, currentForkSource),
                });
                continue;
              }
              if (normalizedEvent.type === "fork_source_state_changed") {
                if (
                  forkSourceBecameAvailable(
                    currentForkSource,
                    normalizedEvent.forkSource,
                  ) &&
                  input.captureAuthoritativeState
                ) {
                  const state = await input.captureAuthoritativeState();
                  if (state.timeline.generation !== event.generation) {
                    throw new Error(
                      "conversation_event_bridge_generation_mismatch",
                    );
                  }
                  const forkSource = await this.#projection.forkSource(
                    input.scope,
                    input.applicationThreadId,
                    state,
                  );
                  input.hub.publish({
                    type: "fork_source_state_changed",
                    generation: event.generation,
                    forkSource,
                  });
                  continue;
                }
                const forkSource = clampForkSourceAvailability(
                  normalizedEvent.forkSource,
                  currentForkSource,
                );
                input.hub.publish({ ...normalizedEvent, forkSource });
                continue;
              }
              input.hub.publish(
                normalizedEvent.type === "run_state"
                  ? {
                      ...normalizedEvent,
                      state: interactionRunState(
                        normalizedEvent.state,
                        input.hub.snapshot!.interactions,
                      ),
                    }
                  : normalizedEvent,
              );
            }
            return;
          case "backend_event": {
            if (event.event.type === "capabilities_changed") {
              await publishCurrentControls(event.generation);
              return;
            }
            const normalizedEvents = await this.#projection.ancillary(
              input.scope,
              input.applicationThreadId,
              event.generation,
              event.event,
            );
            for (const normalizedEvent of normalizedEvents) {
              if (normalizedEvent.generation !== event.generation) {
                throw new Error(
                  "conversation_event_bridge_generation_mismatch",
                );
              }
              input.hub.publish(normalizedEvent);
            }
          }
        }
      });
      void operation.catch(reportFailure);
    };

    let unsubscribe: () => void;
    try {
      unsubscribe = input.actor.subscribe(accept);
    } catch (error) {
      bindingValid = false;
      void mailbox.close().catch(() => undefined);
      throw error;
    }

    let releasePromise: Promise<void> | undefined;
    let detached = false;
    let unsubscribed = false;
    let unsubscribeError: unknown;
    const unsubscribeOnly = (): void => {
      if (unsubscribed) return;
      unsubscribed = true;
      try {
        unsubscribe();
      } catch (error) {
        unsubscribeError = error;
      }
    };
    const detach = (): void => {
      if (detached) return;
      detached = true;
      unsubscribeOnly();
      bindingValid = false;
      if (!initialSeen) {
        readyReject(new Error("conversation_event_bridge_detached"));
      }
      void mailbox.close().catch(() => undefined);
    };
    const binding: ConversationEventBridgeBinding = {
      ready,
      opened: (
        scope,
        applicationThreadId,
        generation,
        _interaction,
      ) => {
        this.#assertPublisherOwner(input, scope, applicationThreadId);
        const operation = mailbox.enqueue(() =>
          publishCurrentControls(generation),
        );
        void operation.catch(reportFailure);
      },
      resolved: (
        scope,
        applicationThreadId,
        generation,
        _interactionId,
      ) => {
        this.#assertPublisherOwner(input, scope, applicationThreadId);
        const operation = mailbox.enqueue(() =>
          publishCurrentControls(generation),
        );
        void operation.catch(reportFailure);
      },
      publishAuthoritativeReplacement: () =>
        mailbox.enqueue(async () => {
          if (!bindingValid || !input.captureAuthoritativeState) {
            throw new Error(
              "conversation_event_bridge_replacement_unavailable",
            );
          }
          const state = await input.captureAuthoritativeState();
          const snapshot = await this.#projection.snapshot(
            input.scope,
            input.applicationThreadId,
            state,
          );
          return input.hub.publish({
            type: "snapshot",
            generation: state.timeline.generation,
            snapshot,
          });
        }),
      detach,
      release: () => {
        releasePromise ??= (async () => {
          unsubscribeOnly();
          await mailbox.close();
          bindingValid = false;
          if (unsubscribeError !== undefined) throw unsubscribeError;
        })();
        return releasePromise;
      },
    };
    this.#activeBindings.set(input.actor, binding);
    return binding;
  }

  #assertPublisherOwner(
    input: {
      readonly scope: RequestScope;
      readonly applicationThreadId: string;
    },
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    if (
      input.scope.tenantId !== scope.tenantId ||
      input.scope.principalId !== scope.principalId ||
      input.applicationThreadId !== applicationThreadId
    ) {
      throw new Error("conversation_event_bridge_publisher_scope_mismatch");
    }
  }
}

function clampTurnFork(
  fork: TurnForkCapability,
  forkSource: ThreadForkSourceCapability,
): TurnForkCapability {
  if (!fork.available || forkSource.selectedCompletedTurn.available) {
    return fork;
  }
  return {
    sourceTurnId: fork.sourceTurnId,
    expectedTurnRevision: fork.expectedTurnRevision,
    available: false,
    unavailableReason: forkSource.selectedCompletedTurn.unavailableReason!,
  };
}

function forkSourceBecameAvailable(
  current: ThreadForkSourceCapability,
  next: ThreadForkSourceCapability,
): boolean {
  return (
    (!current.selectedCompletedTurn.available &&
      next.selectedCompletedTurn.available) ||
    (!current.latestProviderSnapshot.available &&
      next.latestProviderSnapshot.available)
  );
}

function clampForkSourceAvailability(
  next: ThreadForkSourceCapability,
  current: ThreadForkSourceCapability,
): ThreadForkSourceCapability {
  return {
    selectedCompletedTurn:
      !current.selectedCompletedTurn.available &&
      next.selectedCompletedTurn.available
        ? current.selectedCompletedTurn
        : next.selectedCompletedTurn,
    latestProviderSnapshot:
      !current.latestProviderSnapshot.available &&
      next.latestProviderSnapshot.available
        ? current.latestProviderSnapshot
        : next.latestProviderSnapshot,
  };
}
