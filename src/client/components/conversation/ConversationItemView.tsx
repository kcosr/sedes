import { memo } from "react";
import type { ConversationItem } from "../../../shared/index.js";
import { ProviderFeatureConversationItems } from "../../provider-features/registry.js";
import { renderConversationItem } from "./registry";
import { defaultItemRenderContext, type ItemRenderContext } from "./types";

// Item object references are stable across unrelated store updates (the
// normalized store only replaces the entries that change), so memoization
// keeps unrelated renders — streaming ticks elsewhere in the transcript,
// header/composer churn — from re-rendering (and re-parsing markdown for)
// every message in the thread.
export const ConversationItemView = memo(function ConversationItemView({
  item,
  context = defaultItemRenderContext,
}: {
  item: ConversationItem;
  context?: ItemRenderContext;
}): React.JSX.Element {
  const providerFeatureCapabilities = context.providerFeatureCapabilities ?? [];
  return (
    <div
      className="conversation-item"
      data-item-id={item.id}
      data-item-kind={item.kind}
      data-item-status={item.status}
    >
      {renderConversationItem(item, context)}
      {item.providerFeatures?.length ? (
        <ProviderFeatureConversationItems
          item={item}
          capabilities={providerFeatureCapabilities}
        />
      ) : null}
    </div>
  );
});

export { conversationItemRenderers, renderConversationItem } from "./registry";
export type {
  ConversationItemRenderer,
  ConversationItemRendererRegistry,
  ItemRenderContext,
} from "./types";
