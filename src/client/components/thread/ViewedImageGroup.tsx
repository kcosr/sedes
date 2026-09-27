import { useMemo } from "react";
import type { ImageItem, ViewedImageItem } from "../../../shared/index.js";
import { ProviderFeatureConversationItems } from "../../provider-features/registry.js";
import { ConversationItemView } from "../conversation/ConversationItemView.js";
import {
  ViewedImageDisclosure,
  viewedImageStatus,
} from "../conversation/renderers/SemanticRenderers.js";
import {
  defaultItemRenderContext,
  type ItemRenderContext,
} from "../conversation/types.js";

/**
 * The transcript's viewed-image row, paired with its captured image. The row
 * itself carries the viewed item's identity and provider features, as
 * ConversationItemView would, so the disclosed image item is never nested in
 * another conversation-item wrapper.
 */
export function ViewedImageGroup({
  item,
  image,
  context = defaultItemRenderContext,
}: {
  readonly item: ViewedImageItem;
  readonly image?: ImageItem;
  readonly context?: ItemRenderContext;
}): React.JSX.Element {
  const imageContext = useMemo(
    () => ({ ...context, omitImageCaption: true }),
    [context],
  );
  return (
    <section
      className="activity-group viewed-image-group"
      data-item-id={item.id}
      data-item-kind={item.kind}
      data-item-status={item.status}
      data-testid="viewed-image-group"
      data-viewed-image-status={viewedImageStatus(item)}
    >
      <ViewedImageDisclosure
        item={item}
        image={
          image ? (
            <ConversationItemView item={image} context={imageContext} />
          ) : undefined
        }
      />
      {item.providerFeatures?.length ? (
        <ProviderFeatureConversationItems
          item={item}
          capabilities={context.providerFeatureCapabilities ?? []}
        />
      ) : null}
    </section>
  );
}
