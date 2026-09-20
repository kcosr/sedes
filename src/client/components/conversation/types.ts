import type { ReactNode } from "react";
import type {
  ConversationItem,
  ProviderFeatureCapability,
} from "../../../shared/index.js";

export interface ItemRenderContext {
  assistantLabel: string;
  loadAttachmentContent?: (
    attachmentId: string,
    signal: AbortSignal,
  ) => Promise<Blob>;
  loadOutputArtifactContent?: (
    artifactId: string,
    signal: AbortSignal,
  ) => Promise<Blob>;
  providerFeatureCapabilities?: readonly ProviderFeatureCapability[];
}

export const defaultItemRenderContext: ItemRenderContext = {
  assistantLabel: "Assistant",
};

export type ConversationItemOfKind<Kind extends ConversationItem["kind"]> =
  Extract<ConversationItem, { kind: Kind }>;

export interface ConversationItemRenderer<
  Item extends ConversationItem = ConversationItem,
> {
  kind: Item["kind"];
  render(item: Item, context: ItemRenderContext): ReactNode;
}

export type ConversationItemRendererRegistry = {
  [Kind in ConversationItem["kind"]]: ConversationItemRenderer<
    ConversationItemOfKind<Kind>
  >;
};
