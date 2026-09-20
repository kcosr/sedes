import type { ConversationItem } from "../../../shared/index.js";
import {
  assistantMessageRenderer,
  userMessageRenderer,
} from "./renderers/MessageRenderers";
import {
  commandRenderer,
  fileChangeRenderer,
  fileReadRenderer,
  mcpRenderer,
  toolRenderer,
  webSearchRenderer,
} from "./renderers/OperationRenderers";
import { reasoningRenderer } from "./renderers/ReasoningRenderer";
import {
  collaborationRenderer,
  compactionRenderer,
  imageRenderer,
  noticeRenderer,
  planRenderer,
  reviewMarkerRenderer,
} from "./renderers/SemanticRenderers";
import {
  defaultItemRenderContext,
  type ConversationItemOfKind,
  type ConversationItemRendererRegistry,
  type ItemRenderContext,
} from "./types";

export const conversationItemRenderers = {
  user_message: userMessageRenderer,
  assistant_message: assistantMessageRenderer,
  reasoning: reasoningRenderer,
  plan: planRenderer,
  command: commandRenderer,
  file_read: fileReadRenderer,
  file_change: fileChangeRenderer,
  tool: toolRenderer,
  mcp: mcpRenderer,
  web_search: webSearchRenderer,
  // Summary descriptors are meaningful only as a consecutive activity run.
  // Transcript groups them before reaching the per-item registry; this
  // fail-closed entry prevents an accidental standalone path from implying
  // that omitted details can be opened or fetched.
  activity_summary: {
    kind: "activity_summary",
    render: () => null,
  },
  collaboration: collaborationRenderer,
  image: imageRenderer,
  review_marker: reviewMarkerRenderer,
  compaction: compactionRenderer,
  notice: noticeRenderer,
} satisfies ConversationItemRendererRegistry;

export function renderConversationItem<Kind extends ConversationItem["kind"]>(
  item: ConversationItemOfKind<Kind>,
  context: ItemRenderContext = defaultItemRenderContext,
): React.ReactNode {
  const renderer = conversationItemRenderers[item.kind] as {
    render(
      renderItem: ConversationItemOfKind<Kind>,
      renderContext: ItemRenderContext,
    ): React.ReactNode;
  };
  return renderer.render(item, context);
}
