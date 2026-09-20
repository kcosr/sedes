import type { BackendConversationEvent } from "../../shared/protocol/backend.js";
import type {
  NormalizedThreadEvent,
  NormalizedThreadSnapshot,
} from "../../shared/protocol/conversation.js";
import type { ThreadApplicationService } from "../conversations/thread-application-service.js";
import type { ConversationActorSnapshotState } from "../conversations/conversation-actor.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ConversationEventBridgeProjection } from "./conversation-event-bridge.js";

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

/**
 * Backend-neutral event presentation used by the production actor bridge.
 * Interaction events are owned by InteractionBroker. Capability changes are
 * composed from an exact actor capture and emitted as targeted events.
 */
export class ThreadEventPresentation implements ConversationEventBridgeProjection {
  constructor(
    readonly application: Pick<
      ThreadApplicationService,
      | "snapshotFromActorCapture"
      | "capabilitiesAndProviderFeaturesFromActorCapture"
      | "forkSourceFromActorCapture"
    >,
  ) {}

  snapshot(
    scope: RequestScope,
    applicationThreadId: string,
    state: ConversationActorSnapshotState,
  ): Promise<NormalizedThreadSnapshot> {
    return this.application.snapshotFromActorCapture(
      scope,
      applicationThreadId,
      state,
    );
  }

  capabilitiesAndProviderFeatures(
    scope: RequestScope,
    applicationThreadId: string,
    state: ConversationActorSnapshotState,
  ): Promise<{
    readonly threadRevision: number;
    readonly capabilities: NormalizedThreadSnapshot["capabilities"];
    readonly providerFeatures: NormalizedThreadSnapshot["providerFeatures"];
    readonly interactions: NormalizedThreadSnapshot["interactions"];
  }> {
    return this.application.capabilitiesAndProviderFeaturesFromActorCapture(
      scope,
      applicationThreadId,
      state,
    );
  }

  forkSource(
    scope: RequestScope,
    applicationThreadId: string,
    state: ConversationActorSnapshotState,
  ): Promise<NormalizedThreadSnapshot["forkSource"]> {
    return this.application.forkSourceFromActorCapture(
      scope,
      applicationThreadId,
      state,
    );
  }

  async ancillary(
    _scope: RequestScope,
    _applicationThreadId: string,
    generation: string,
    event: AncillaryBackendEvent,
  ): Promise<readonly NormalizedThreadEvent[]> {
    switch (event.type) {
      case "usage_changed":
        return [
          {
            type: "usage_changed",
            generation,
            usage: event.usage,
          },
        ];
      case "notice":
        return [
          {
            type: "notice",
            generation,
            notice: event.notice,
          },
        ];
      case "interaction_opened":
      case "interaction_resolved":
        return [];
      case "capabilities_changed":
        // ConversationEventBridge handles this with the exact actor capture.
        return [];
    }
  }
}
