import { useMemo } from "react";
import type { ImageItem, ViewedImageItem } from "../../../shared/index.js";
import { ConversationItemView } from "../conversation/ConversationItemView.js";
import {
  ViewedImageDisclosure,
  viewedImageStatus,
} from "../conversation/renderers/SemanticRenderers.js";
import {
  defaultItemRenderContext,
  type ItemRenderContext,
} from "../conversation/types.js";

/** The transcript's viewed-image row, paired with its captured image. */
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
      data-testid="viewed-image-group"
      data-viewed-image-item-id={item.id}
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
    </section>
  );
}
