import type {
  ConversationItem,
  NormalizedThreadSnapshot,
  ProviderFeatureCapability,
  ProviderFeatureConversationItemEnvelope,
  ProviderFeatureRef,
  ProviderFeatureStateEnvelope,
} from "../../shared/index.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import { codexExecutionClientFeature } from "./codex-execution.js";
import { codexFastModeClientFeature } from "./codex-fast-mode.js";
import { codexGoalClientFeature } from "./codex-goal.js";
import { claudePermissionsClientFeature } from "./claude-permissions.js";

export interface ClientProviderFeatureModule {
  readonly ref: ProviderFeatureRef;
  renderThreadDetails(input: {
    readonly store: ThreadClientStore;
    readonly snapshot: NormalizedThreadSnapshot;
    readonly capability: ProviderFeatureCapability;
    readonly featureState?: ProviderFeatureStateEnvelope;
    readonly disabled: boolean;
    readonly mobile: boolean;
  }): React.ReactNode;
  /**
   * Optional compact composer-action presentation. Generic layout hosts
   * call this; modules that only use thread_details omit it.
   */
  renderComposerAction?(input: {
    readonly store: ThreadClientStore;
    readonly snapshot: NormalizedThreadSnapshot;
    readonly capability: ProviderFeatureCapability;
    readonly featureState?: ProviderFeatureStateEnvelope;
    readonly disabled: boolean;
    readonly mobile: boolean;
  }): React.ReactNode;
  /** Optional immutable presentation attached to one normalized history item. */
  renderConversationItem?(input: {
    readonly item: ConversationItem;
    readonly capability: ProviderFeatureCapability;
    readonly feature: ProviderFeatureConversationItemEnvelope;
  }): React.ReactNode;
}

function featureKey(ref: ProviderFeatureRef): string {
  return `${ref.featureId}@${ref.schemaVersion}`;
}

export class ClientProviderFeatureRegistry {
  readonly #modules = new Map<string, ClientProviderFeatureModule>();

  constructor(modules: readonly ClientProviderFeatureModule[]) {
    for (const module of modules) {
      const key = featureKey(module.ref);
      if (this.#modules.has(key)) {
        throw new Error(`duplicate_client_provider_feature:${key}`);
      }
      this.#modules.set(key, Object.freeze(module));
    }
  }

  module(ref: ProviderFeatureRef): ClientProviderFeatureModule | undefined {
    return this.#modules.get(featureKey(ref));
  }
}

export const clientProviderFeatures = new ClientProviderFeatureRegistry([
  claudePermissionsClientFeature,
  codexExecutionClientFeature,
  codexGoalClientFeature,
  codexFastModeClientFeature,
]);

/**
 * Renders immutable provider-feature presentation directly beneath its owning
 * conversation item. Mutable thread feature state is deliberately not used:
 * history, paging, and replay carry the complete bounded item envelope.
 */
export function ProviderFeatureConversationItems({
  item,
  capabilities,
}: {
  readonly item: ConversationItem;
  readonly capabilities: readonly ProviderFeatureCapability[];
}): React.JSX.Element | null {
  if (!item.providerFeatures?.length) return null;
  return (
    <ProviderFeatureConversationItemList
      item={item}
      capabilities={capabilities}
    />
  );
}

function ProviderFeatureConversationItemList({
  item,
  capabilities,
}: {
  readonly item: ConversationItem;
  readonly capabilities: readonly ProviderFeatureCapability[];
}): React.JSX.Element {
  const features = item.providerFeatures!;
  return (
    <div className="provider-feature-conversation-items">
      {features.map((feature) => {
        const key = featureKey(feature.ref);
        const capability = capabilities.find(
          (candidate) => featureKey(candidate.ref) === key,
        );
        if (
          !capability ||
          !capability.presentationSlots.includes("conversation_item")
        ) {
          return null;
        }
        const module = clientProviderFeatures.module(feature.ref);
        if (!module?.renderConversationItem) {
          return (
            <p className="provider-feature-unavailable" key={key} role="status">
              {capability.label.text} is unavailable in this client version.
            </p>
          );
        }
        return (
          <div className="provider-feature-conversation-item" key={key}>
            {module.renderConversationItem({
              item,
              capability,
              feature,
            })}
          </div>
        );
      })}
    </div>
  );
}

export function ProviderFeatureThreadDetails({
  store,
  snapshot,
  disabled,
  mobile,
}: {
  readonly store: ThreadClientStore;
  readonly snapshot: NormalizedThreadSnapshot;
  readonly disabled: boolean;
  readonly mobile: boolean;
}): React.JSX.Element {
  return (
    <>
      {snapshot.capabilities.providerFeatures
        .filter(({ presentationSlots }) =>
          presentationSlots.includes("thread_details"),
        )
        .map((capability) => {
          const key = featureKey(capability.ref);
          const featureState = snapshot.providerFeatures.find(
            ({ ref }) => featureKey(ref) === key,
          );
          const module = clientProviderFeatures.module(capability.ref);
          if (!module) {
            return (
              <p
                className="provider-feature-unavailable"
                key={key}
                role="status"
              >
                {capability.label.text} is unavailable in this client version.
              </p>
            );
          }
          return (
            <div className="provider-feature-control" key={key}>
              {module.renderThreadDetails({
                store,
                snapshot,
                capability,
                ...(featureState ? { featureState } : {}),
                disabled,
                mobile,
              })}
            </div>
          );
        })}
    </>
  );
}

/**
 * Generic composer-action provider-feature host. Does not import provider
 * modules directly — registry renderers own closed feature UI.
 */
export function ProviderFeatureComposerActions({
  store,
  snapshot,
  disabled,
  mobile,
}: {
  readonly store: ThreadClientStore;
  readonly snapshot: NormalizedThreadSnapshot;
  readonly disabled: boolean;
  readonly mobile: boolean;
}): React.JSX.Element {
  return (
    <>
      {snapshot.capabilities.providerFeatures
        .filter(({ presentationSlots }) =>
          presentationSlots.includes("composer_action"),
        )
        .map((capability) => {
          const key = featureKey(capability.ref);
          const featureState = snapshot.providerFeatures.find(
            ({ ref }) => featureKey(ref) === key,
          );
          const module = clientProviderFeatures.module(capability.ref);
          if (!module?.renderComposerAction) {
            return null;
          }
          return (
            <div className="provider-feature-composer-slot" key={key}>
              {module.renderComposerAction({
                store,
                snapshot,
                capability,
                ...(featureState ? { featureState } : {}),
                disabled,
                mobile,
              })}
            </div>
          );
        })}
    </>
  );
}
