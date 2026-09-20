import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type { ThreadApplicationService } from "../conversations/thread-application-service.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ThreadRuntimeCoordinator } from "./thread-runtime-coordinator.js";
import { isDeepStrictEqual } from "node:util";
import type {
  NormalizedThreadEvent,
  NormalizedThreadSnapshot,
  ThreadEventEnvelope,
} from "../../shared/protocol/conversation.js";
import { SerializedMailbox } from "../conversations/serialized-mailbox.js";

function publicationKey(
  scope: RequestScope,
  applicationThreadId: string,
): string {
  return `${scope.tenantId}\0${scope.principalId}\0${applicationThreadId}`;
}

interface PublicationMailbox {
  readonly mailbox: SerializedMailbox;
  accepted: number;
}

export class ThreadSnapshotPublisher {
  readonly #publicationMailboxes = new Map<string, PublicationMailbox>();
  readonly #scheduledPublications = new Set<Promise<void>>();
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(
    readonly bindings: ConversationBindingRepository,
    readonly application: Pick<
      ThreadApplicationService,
      "snapshot" | "applicationState" | "applicationStateFromActorCapture"
    >,
    readonly runtimes: ThreadRuntimeCoordinator,
    readonly onThreadChanged?: (
      scope: RequestScope,
      applicationThreadId: string,
    ) => void | Promise<void>,
    readonly onPublicationError?: (error: unknown) => void,
  ) {}

  schedule(scope: RequestScope, applicationThreadId: string): void {
    this.#assertAccepting();
    this.#ownScheduledPublication(this.publish(scope, applicationThreadId));
  }

  scheduleMany(
    scope: RequestScope,
    applicationThreadIds: readonly string[],
  ): void {
    this.#assertAccepting();
    this.#ownScheduledPublication(
      this.publishMany(scope, applicationThreadIds),
    );
  }

  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async publish(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    this.#assertAccepting();
    await this.#publishThread(scope, applicationThreadId);
    await this.onThreadChanged?.(scope, applicationThreadId);
  }

  async publishMany(
    scope: RequestScope,
    applicationThreadIds: readonly string[],
  ): Promise<void> {
    this.#assertAccepting();
    await Promise.all(
      applicationThreadIds.map((applicationThreadId) =>
        this.#publishThread(scope, applicationThreadId),
      ),
    );
    await Promise.all(
      applicationThreadIds.map((applicationThreadId) =>
        this.onThreadChanged?.(scope, applicationThreadId),
      ),
    );
  }

  async publishAuthoritativeReplacementIfLoaded(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<boolean> {
    this.#assertAccepting();
    return this.#serialize(scope, applicationThreadId, async () => {
      if (
        this.bindings.getTarget(scope, applicationThreadId).backingState !==
        "bound"
      ) {
        return false;
      }
      return this.runtimes.publishAuthoritativeReplacementIfLoaded(
        scope,
        applicationThreadId,
      );
    });
  }

  async #publishThread(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    await this.#serialize(scope, applicationThreadId, async () => {
      while (true) {
        const target = this.bindings.getTarget(scope, applicationThreadId);
        if (target.backingState === "bound") {
          let published: boolean;
          try {
            published = await this.runtimes.publishApplicationIncrementalsIfLoaded(
              scope,
              applicationThreadId,
              (actor) =>
                this.application.applicationStateFromActorCapture(
                  scope,
                  applicationThreadId,
                  actor,
                ),
              ThreadSnapshotPublisher.applicationChangeIncrementals,
            );
          } catch (error) {
            if (!isProjectionGuardFailure(error)) throw error;
            const runtime = await this.runtimes.acquire(
              scope,
              applicationThreadId,
            );
            try {
              await runtime.publishAuthoritativeReplacement();
            } finally {
              runtime.release();
            }
            return;
          }
          if (published) return;
          const quiet = this.runtimes.quiet(scope, applicationThreadId);
          const requiresBoundGeneration =
            quiet.hub.subscriberCount > 0 &&
            quiet.hub.snapshot !== undefined &&
            quiet.hub.snapshot.thread.backingState !== "bound";
          quiet.release();
          if (requiresBoundGeneration) {
            const runtime = await this.runtimes.acquire(
              scope,
              applicationThreadId,
            );
            // Runtime establishment waits for the actor bridge's authoritative
            // provider-generation snapshot. Publishing another replacement
            // here would create two baselines for the same generation.
            runtime.release();
          }
          // A dormant bound provider is deliberately not attached merely to
          // project an application-owned overlay. Its next attach captures the
          // durable overlay in the authoritative initial snapshot.
          return;
        }
        const quiet = this.runtimes.quiet(scope, applicationThreadId);
        try {
          const current = this.bindings.getTarget(scope, applicationThreadId);
          if (current.backingState === "bound") continue;
          if (quiet.hub.projectionGeneration && quiet.hub.snapshot) {
            let state: Awaited<
              ReturnType<typeof this.application.applicationState>
            >;
            try {
              state = await this.application.applicationState(
                scope,
                applicationThreadId,
              );
            } catch (error) {
              if (
                error instanceof Error &&
                error.message ===
                  "thread_application_bound_state_requires_actor_capture"
              ) {
                continue;
              }
              throw error;
            }
            if (
              this.bindings.getTarget(scope, applicationThreadId)
                .backingState === "bound"
            ) {
              continue;
            }
            const events =
              ThreadSnapshotPublisher.applicationChangeIncrementals(
                quiet.hub.projectionGeneration,
                quiet.hub.snapshot,
                state,
              );
            for (const event of events) {
              quiet.hub.publish(event);
            }
            return;
          }
          const snapshot = await this.application.snapshot(
            scope,
            applicationThreadId,
          );
          if (quiet.publishIfUnowned(snapshot)) return;
        } finally {
          quiet.release();
        }
      }
    });
  }

  static applicationChangeIncrementals(
    generation: string,
    current: NormalizedThreadSnapshot,
    captured: Extract<
      NormalizedThreadEvent,
      { readonly type: "application_state_changed" }
    >["state"],
  ): readonly Exclude<NormalizedThreadEvent, { readonly type: "snapshot" }>[] {
    const state: Extract<
      NormalizedThreadEvent,
      { readonly type: "application_state_changed" }
    >["state"] = {
      thread: {
        ...captured.thread,
        runState: current.runState,
        queuedInputCount: captured.queue.length,
      },
      executionWorkspace: captured.executionWorkspace,
      ...(captured.createdWithAgent
        ? { createdWithAgent: captured.createdWithAgent }
        : {}),
      workspace: captured.workspace,
      environment: captured.environment,
      draft: captured.draft,
      stashes: captured.stashes,
      composerCommands: captured.composerCommands,
      agentTools: captured.agentTools,
      forkSource: captured.forkSource,
      queue: captured.queue,
      capabilities: {
        ...captured.capabilities,
        runState: current.runState,
      },
      settings: captured.settings,
      providerFeatures: captured.providerFeatures,
      // Blocking interactions are runtime-owned incrementals. Application
      // capture may have started before a newer open or resolution reached
      // the hub, so preserve the latest projection instead of replaying the
      // captured interaction list over it.
      interactions: current.interactions,
      ...(captured.recovery ? { recovery: captured.recovery } : {}),
      attention: captured.attention,
    };
    const currentState: Extract<
      NormalizedThreadEvent,
      { readonly type: "application_state_changed" }
    >["state"] = {
      thread: current.thread,
      executionWorkspace: current.executionWorkspace,
      ...(current.createdWithAgent
        ? { createdWithAgent: current.createdWithAgent }
        : {}),
      workspace: current.workspace,
      environment: current.environment,
      draft: current.draft,
      stashes: current.stashes,
      composerCommands: current.composerCommands,
      agentTools: current.agentTools,
      forkSource: current.forkSource,
      queue: current.queue,
      capabilities: current.capabilities,
      settings: current.settings,
      providerFeatures: current.providerFeatures,
      interactions: current.interactions,
      ...(current.recovery ? { recovery: current.recovery } : {}),
      attention: current.attention,
    };
    return isDeepStrictEqual(currentState, state)
      ? []
      : [{ type: "application_state_changed", generation, state }];
  }

  async publishAuthoritativeReplacement(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ThreadEventEnvelope> {
    this.#assertAccepting();
    return this.#serialize(scope, applicationThreadId, () =>
      this.#captureAndPublish(scope, applicationThreadId),
    );
  }

  async #captureAndPublish(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ThreadEventEnvelope> {
    while (true) {
      const target = this.bindings.getTarget(scope, applicationThreadId);
      if (target.backingState === "bound") {
        const runtime = await this.runtimes.acquire(scope, applicationThreadId);
        try {
          return await runtime.publishAuthoritativeReplacement();
        } finally {
          runtime.release();
        }
      }
      const quiet = this.runtimes.quiet(scope, applicationThreadId);
      try {
        const snapshot = await this.application.snapshot(
          scope,
          applicationThreadId,
        );
        const current = this.bindings.getTarget(scope, applicationThreadId);
        const published =
          current.backingState !== "bound" && quiet.publishIfUnowned(snapshot);
        if (published) return published;
      } finally {
        quiet.release();
      }
    }
  }

  #serialize<T>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    this.#assertAccepting();
    const key = publicationKey(scope, applicationThreadId);
    let entry = this.#publicationMailboxes.get(key);
    if (!entry) {
      entry = { mailbox: new SerializedMailbox(), accepted: 0 };
      this.#publicationMailboxes.set(key, entry);
    }
    entry.accepted += 1;
    const acceptedEntry = entry;
    return entry.mailbox.enqueue(operation).finally(() => {
      acceptedEntry.accepted -= 1;
      if (
        acceptedEntry.accepted === 0 &&
        this.#publicationMailboxes.get(key) === acceptedEntry
      ) {
        this.#publicationMailboxes.delete(key);
      }
    });
  }

  #assertAccepting(): void {
    if (this.#closing) {
      throw new Error("Thread snapshot publisher is closed.");
    }
  }

  #ownScheduledPublication(publication: Promise<void>): void {
    let completion!: Promise<void>;
    completion = publication
      .catch((error) => {
        try {
          this.onPublicationError?.(error);
        } catch {
          // A diagnostic observer must not create another detached rejection.
        }
      })
      .finally(() => this.#scheduledPublications.delete(completion));
    this.#scheduledPublications.add(completion);
  }

  async #performClose(): Promise<void> {
    await Promise.all(
      [...this.#publicationMailboxes.values()].map(({ mailbox }) =>
        mailbox.close(),
      ),
    );
    await Promise.all([...this.#scheduledPublications]);
  }
}

function isProjectionGuardFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("thread_projection_")
  );
}
