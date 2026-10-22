import type { PageItem } from "../../../../shared/protocol/conversation.js";
import { PagePreview } from "../PagePreview.js";
import type { ConversationItemRenderer } from "../types.js";

export const pageRenderer: ConversationItemRenderer<PageItem> = {
  kind: "page",
  render(item, context) {
    return <PagePreview page={item.page} services={context} onOpenPage={context.openPage} />;
  },
};
