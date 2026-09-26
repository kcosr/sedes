import { useId, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ImageItem, ViewedImageItem } from "../../../shared/index.js";
import { ConversationItemView } from "../conversation/ConversationItemView.js";
import {
  viewedImageLabel,
  viewedImageRenderer,
} from "../conversation/renderers/SemanticRenderers.js";
import {
  defaultItemRenderContext,
  type ItemRenderContext,
} from "../conversation/types.js";

/**
 * A viewed image shares the activity row presentation. The row discloses its
 * captured image once that separate item arrives; until then, or when capture
 * never succeeds, it stays static with the chevron's space reserved.
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
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const label = viewedImageLabel(item);
  const imageContext = useMemo(
    () => ({ ...context, omitImageCaption: true }),
    [context],
  );
  return (
    <section
      className="activity-group viewed-image-group"
      data-testid="viewed-image-group"
      data-viewed-image-item-id={item.id}
    >
      {image ? (
        <button
          aria-controls={detailsId}
          aria-expanded={open}
          className="activity-group-summary"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <ChevronRight
            aria-hidden="true"
            className="activity-group-chevron"
            size={12}
            strokeWidth={1.8}
          />
          <span className="viewed-image-label">{label}</span>
        </button>
      ) : (
        viewedImageRenderer.render(item, context)
      )}
      {image && open ? (
        <div className="activity-group-disclosure" id={detailsId}>
          <ConversationItemView item={image} context={imageContext} />
        </div>
      ) : null}
    </section>
  );
}
