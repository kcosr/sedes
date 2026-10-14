import type { ReactNode } from "react";
import type { PageResponseServices } from "./page-response-services.js";
import type { PageRevision, PageRevisionPage } from "../../../shared/protocol/pages.js";
import type { PageListOptions, PageRenderAdmission } from "../../api/ApiClient.js";
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
  createPageRenderAdmission?: (pageId: string, revision: number, signal?: AbortSignal) => Promise<PageRenderAdmission>;
  listPageRevisions?: (pageId: string, options?: PageListOptions) => Promise<PageRevisionPage>;
  getPageRevision?: (pageId: string, revision: number, signal?: AbortSignal) => Promise<PageRevision>;
  pageResponse?: PageResponseServices;
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
