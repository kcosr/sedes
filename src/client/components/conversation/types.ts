import type { ReactNode } from "react";
import type { PageRevision } from "../../../shared/protocol/pages.js";
import type { PageFrameServices } from "../../lib/page-services.js";
import type {
  ConversationItem,
  ProviderFeatureCapability,
} from "../../../shared/index.js";

export interface ItemRenderContext extends PageFrameServices {
  assistantLabel: string;
  loadAttachmentContent?: (
    attachmentId: string,
    signal: AbortSignal,
  ) => Promise<Blob>;
  loadOutputArtifactContent?: (
    artifactId: string,
    signal: AbortSignal,
  ) => Promise<Blob>;
  openPage?: (page: PageRevision) => void;
  providerFeatureCapabilities?: readonly ProviderFeatureCapability[];
  /** A disclosure already names the image, so the figure omits its caption. */
  omitImageCaption?: boolean;
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
