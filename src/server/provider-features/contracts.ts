import type { z } from "zod";
import type { BackendKind } from "../backends/contracts.js";
import type {
  BoundedDisplayText,
  BoundedValue,
} from "../../shared/protocol/payload.js";
import type {
  ProviderFeatureAvailability,
  ProviderFeatureEffects,
  ProviderFeaturePresentationSlot,
  ProviderFeatureRef,
} from "../../shared/protocol/provider-feature.js";

/**
 * Server-only quietness policy for one provider-feature action.
 *
 * Capability composition and mutation enforcement consume the same backend
 * contribution. Concurrent actions bypass only active-turn and queued-input
 * quietness; every other application, provider, scope, and recovery gate
 * remains authoritative.
 */
export type ProviderFeatureConcurrency =
  | { readonly kind: "quiet_thread" }
  | {
      readonly kind: "concurrent";
      readonly activeTurn: true;
      readonly queuedInput: true;
    };

export const QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY = Object.freeze({
  kind: "quiet_thread",
} as const satisfies ProviderFeatureConcurrency);

export const CONCURRENT_PROVIDER_FEATURE_CONCURRENCY = Object.freeze({
  kind: "concurrent",
  activeTurn: true,
  queuedInput: true,
} as const satisfies ProviderFeatureConcurrency);

export interface ProviderFeatureOperationDefinition<Arguments = unknown> {
  readonly actionId: string;
  readonly label: BoundedDisplayText;
  readonly argumentsSchema: z.ZodType<Arguments>;
  readonly effects: ProviderFeatureEffects;
  readonly confirmation: "none" | "explicit";
  readonly execution: "inline" | "durable";
}

export interface ProviderFeatureConversationItemDefinition<Payload = unknown> {
  readonly payloadSchema: z.ZodType<Payload>;
  /** Projects validated provider-private data into the bounded browser form. */
  projectPayload(payload: Payload): BoundedValue;
}

interface ProviderFeatureModuleBase<ItemPayload = unknown> {
  readonly ref: ProviderFeatureRef;
  readonly backendKind: BackendKind;
  readonly label: BoundedDisplayText;
  readonly description?: BoundedDisplayText;
  readonly operations: readonly ProviderFeatureOperationDefinition[];
  readonly presentationSlots: readonly ProviderFeaturePresentationSlot[];
  readonly conversationItem?: ProviderFeatureConversationItemDefinition<ItemPayload>;
}

export type ProviderFeatureModule<State = unknown, ItemPayload = unknown> =
  | (ProviderFeatureModuleBase<ItemPayload> & {
      readonly kind: "stateful";
      readonly stateSchema: z.ZodType<State>;
      /**
       * The only route from provider-owned state to the browser contract.
       * Implementations must deliberately project a typed state into the
       * bounded representation; provider payloads are never forwarded.
       */
      projectState(state: State): BoundedValue;
    })
  | (ProviderFeatureModuleBase<ItemPayload> & {
      readonly kind: "action_only";
    });

export interface ProviderFeatureCapabilityInput {
  readonly revision: number;
  readonly availability: ProviderFeatureAvailability;
  readonly unavailableReason?: BoundedDisplayText;
  /** Deployment-policy subset. Unknown operation IDs fail closed. */
  readonly allowedOperationIds?: readonly string[];
}

export interface RegisteredProviderFeatureAction<Arguments = unknown> {
  readonly module: ProviderFeatureModule;
  readonly definition: ProviderFeatureOperationDefinition<Arguments>;
  readonly arguments: Arguments;
}
