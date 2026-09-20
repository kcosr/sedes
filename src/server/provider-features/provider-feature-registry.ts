import {
  providerFeatureActionDescriptorSchema,
  providerFeatureArgumentsSchema,
  providerFeatureCapabilitySchema,
  providerFeatureConversationItemEnvelopeSchema,
  providerFeatureRefSchema,
  providerFeatureStateEnvelopeSchema,
  type ProviderFeatureCapability,
  type ProviderFeatureConversationItemEnvelope,
  type ProviderFeatureRef,
  type ProviderFeatureStateEnvelope,
} from "../../shared/protocol/provider-feature.js";
import type { BackendKind } from "../backends/contracts.js";
import type {
  ProviderFeatureCapabilityInput,
  ProviderFeatureModule,
  ProviderFeatureOperationDefinition,
  RegisteredProviderFeatureAction,
} from "./contracts.js";

export type ProviderFeatureRegistryErrorCode =
  | "feature_not_registered"
  | "feature_version_unsupported"
  | "backend_mismatch"
  | "action_not_registered"
  | "arguments_invalid"
  | "conversation_item_not_supported"
  | "conversation_item_invalid"
  | "state_not_supported"
  | "state_invalid";

export class ProviderFeatureRegistryError extends Error {
  constructor(readonly code: ProviderFeatureRegistryErrorCode) {
    super(code);
    this.name = "ProviderFeatureRegistryError";
  }
}

/**
 * Build-time registry for closed provider features. It owns exact identity,
 * backend, action, argument, and state validation. Persistence and actor
 * serialization remain in the application mutation layer.
 */
export class ProviderFeatureRegistry {
  readonly #modules = new Map<string, ProviderFeatureModule>();
  readonly #versionsByFeatureId = new Map<string, Set<number>>();

  constructor(modules: readonly ProviderFeatureModule[] = []) {
    for (const module of modules) this.register(module);
  }

  register(module: ProviderFeatureModule): void {
    const ref = providerFeatureRefSchema.parse(module.ref);
    assertBackendKind(module.backendKind);
    const key = featureKey(ref);
    if (this.#modules.has(key)) {
      throw new Error(`provider_feature_duplicate:${key}`);
    }
    if (
      !module.label ||
      (module.description !== undefined && !module.description)
    ) {
      throw new Error(`provider_feature_metadata_invalid:${key}`);
    }

    const actions = new Set<string>();
    for (const operation of module.operations) {
      if (actions.has(operation.actionId)) {
        throw new Error(
          `provider_feature_action_duplicate:${key}:${operation.actionId}`,
        );
      }
      actions.add(operation.actionId);
      providerFeatureActionDescriptorSchema.parse(
        operationDescriptor(operation),
      );
      if (typeof operation.argumentsSchema?.safeParse !== "function") {
        throw new Error(
          `provider_feature_arguments_schema_invalid:${key}:${operation.actionId}`,
        );
      }
    }

    providerFeatureCapabilitySchema.parse({
      ref,
      revision: 0,
      label: module.label,
      ...(module.description === undefined
        ? {}
        : { description: module.description }),
      availability: "available",
      operations: module.operations.map(operationDescriptor),
      presentationSlots: [...module.presentationSlots],
    });

    const hasConversationItemSlot =
      module.presentationSlots.includes("conversation_item");
    if (hasConversationItemSlot !== (module.conversationItem !== undefined)) {
      throw new Error(
        `provider_feature_conversation_item_contract_invalid:${key}`,
      );
    }
    if (
      module.conversationItem &&
      (typeof module.conversationItem.payloadSchema?.safeParse !== "function" ||
        typeof module.conversationItem.projectPayload !== "function")
    ) {
      throw new Error(
        `provider_feature_conversation_item_contract_invalid:${key}`,
      );
    }

    if (
      module.kind === "stateful" &&
      (typeof module.stateSchema?.safeParse !== "function" ||
        typeof module.projectState !== "function")
    ) {
      throw new Error(`provider_feature_state_contract_invalid:${key}`);
    }

    this.#modules.set(key, module);
    const versions = this.#versionsByFeatureId.get(ref.featureId) ?? new Set();
    versions.add(ref.schemaVersion);
    this.#versionsByFeatureId.set(ref.featureId, versions);
  }

  refs(backendKind?: BackendKind): readonly ProviderFeatureRef[] {
    return [...this.#modules.values()]
      .filter(
        (module) =>
          backendKind === undefined || module.backendKind === backendKind,
      )
      .map(({ ref }) => ({ ...ref }))
      .sort((left, right) =>
        left.featureId === right.featureId
          ? left.schemaVersion - right.schemaVersion
          : left.featureId.localeCompare(right.featureId),
      );
  }

  module(
    ref: ProviderFeatureRef,
    backendKind: BackendKind,
  ): ProviderFeatureModule {
    const parsedRef = parseRefOrThrow(ref);
    const module = this.#modules.get(featureKey(parsedRef));
    if (!module) {
      if (this.#versionsByFeatureId.has(parsedRef.featureId)) {
        throw new ProviderFeatureRegistryError("feature_version_unsupported");
      }
      throw new ProviderFeatureRegistryError("feature_not_registered");
    }
    if (module.backendKind !== backendKind) {
      throw new ProviderFeatureRegistryError("backend_mismatch");
    }
    return module;
  }

  capability(
    ref: ProviderFeatureRef,
    backendKind: BackendKind,
    input: ProviderFeatureCapabilityInput,
  ): ProviderFeatureCapability {
    const module = this.module(ref, backendKind);
    const allowedOperationIds =
      input.allowedOperationIds === undefined
        ? undefined
        : new Set(input.allowedOperationIds);
    if (
      allowedOperationIds &&
      (allowedOperationIds.size !== input.allowedOperationIds!.length ||
        [...allowedOperationIds].some(
          (actionId) =>
            !module.operations.some(
              (operation) => operation.actionId === actionId,
            ),
        ))
    ) {
      throw new ProviderFeatureRegistryError("action_not_registered");
    }
    return providerFeatureCapabilitySchema.parse({
      ref: module.ref,
      revision: input.revision,
      label: module.label,
      ...(module.description === undefined
        ? {}
        : { description: module.description }),
      availability: input.availability,
      ...(input.unavailableReason === undefined
        ? {}
        : { unavailableReason: input.unavailableReason }),
      operations: module.operations
        .filter(
          ({ actionId }) =>
            allowedOperationIds === undefined ||
            allowedOperationIds.has(actionId),
        )
        .map(operationDescriptor),
      presentationSlots: [...module.presentationSlots],
    });
  }

  validateAction<Arguments = unknown>(input: {
    readonly ref: ProviderFeatureRef;
    readonly backendKind: BackendKind;
    readonly actionId: string;
    readonly arguments: unknown;
  }): RegisteredProviderFeatureAction<Arguments> {
    const module = this.module(input.ref, input.backendKind);
    const definition = module.operations.find(
      ({ actionId }) => actionId === input.actionId,
    );
    if (!definition) {
      throw new ProviderFeatureRegistryError("action_not_registered");
    }
    const bounded = providerFeatureArgumentsSchema.safeParse(input.arguments);
    if (!bounded.success) {
      throw new ProviderFeatureRegistryError("arguments_invalid");
    }
    const parsed = definition.argumentsSchema.safeParse(bounded.data);
    if (!parsed.success) {
      throw new ProviderFeatureRegistryError("arguments_invalid");
    }
    return {
      module,
      definition: definition as ProviderFeatureOperationDefinition<Arguments>,
      arguments: parsed.data as Arguments,
    };
  }

  stateEnvelope(input: {
    readonly ref: ProviderFeatureRef;
    readonly backendKind: BackendKind;
    readonly revision: number;
    readonly providerState: unknown;
  }): ProviderFeatureStateEnvelope {
    const module = this.module(input.ref, input.backendKind);
    if (module.kind !== "stateful") {
      throw new ProviderFeatureRegistryError("state_not_supported");
    }
    const parsed = module.stateSchema.safeParse(input.providerState);
    if (!parsed.success) {
      throw new ProviderFeatureRegistryError("state_invalid");
    }
    let state: unknown;
    try {
      state = module.projectState(parsed.data);
    } catch {
      throw new ProviderFeatureRegistryError("state_invalid");
    }
    const envelope = providerFeatureStateEnvelopeSchema.safeParse({
      ref: module.ref,
      revision: input.revision,
      state,
    });
    if (!envelope.success) {
      throw new ProviderFeatureRegistryError("state_invalid");
    }
    return envelope.data;
  }

  conversationItemEnvelope<Payload = unknown>(input: {
    readonly ref: ProviderFeatureRef;
    readonly backendKind: BackendKind;
    readonly providerPayload: unknown;
  }): ProviderFeatureConversationItemEnvelope {
    const module = this.module(input.ref, input.backendKind);
    const definition = module.conversationItem;
    if (!definition) {
      throw new ProviderFeatureRegistryError("conversation_item_not_supported");
    }
    const parsed = definition.payloadSchema.safeParse(input.providerPayload);
    if (!parsed.success) {
      throw new ProviderFeatureRegistryError("conversation_item_invalid");
    }
    let payload: unknown;
    try {
      payload = definition.projectPayload(parsed.data as Payload);
    } catch {
      throw new ProviderFeatureRegistryError("conversation_item_invalid");
    }
    const envelope = providerFeatureConversationItemEnvelopeSchema.safeParse({
      ref: module.ref,
      payload,
    });
    if (!envelope.success) {
      throw new ProviderFeatureRegistryError("conversation_item_invalid");
    }
    return envelope.data;
  }
}

function operationDescriptor(operation: ProviderFeatureOperationDefinition) {
  return {
    actionId: operation.actionId,
    label: operation.label,
    effects: operation.effects,
    confirmation: operation.confirmation,
    execution: operation.execution,
  };
}

function featureKey(ref: ProviderFeatureRef): string {
  return `${ref.featureId}@${ref.schemaVersion}`;
}

function parseRefOrThrow(ref: ProviderFeatureRef): ProviderFeatureRef {
  const parsed = providerFeatureRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new ProviderFeatureRegistryError("feature_not_registered");
  }
  return parsed.data;
}

function assertBackendKind(value: BackendKind): void {
  if (
    value !== "pi" &&
    value !== "codex_app_server" &&
    value !== "claude_agent_sdk" &&
    value !== "grok_build"
  ) {
    throw new Error("provider_feature_backend_kind_invalid");
  }
}
