import type { ConversationItem, UserMessageItem } from "../../../shared/index.js";

const userPreviewLimit = 220;
export const assistantPreviewLimit = 480;

const userPreviewCache = new WeakMap<UserMessageItem, string>();
const assistantPreviewCache = new WeakMap<
  Extract<ConversationItem, { kind: "assistant_message" }>,
  string
>();

export function collapsePreview(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

function markdownPreview(value: string): string {
  return value
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[*_~`]+/g, "");
}

export function userMessagePreview(item: UserMessageItem): string {
  const cached = userPreviewCache.get(item);
  if (cached !== undefined) return cached;
  const preview = collapsePreview(
    item.origin?.kind === "question_response"
      ? item.origin.answers
          .map(({ question, answer }) => `${question}: ${answer}`)
          .join(" · ")
      : item.content
      .map((part) => {
        if (part.kind === "text") return part.text.text;
        if (part.kind === "skill") return `/${part.name.text}`;
        if (part.kind === "context_excerpt") {
          const source = part.excerpt.source;
          const path =
            source.kind === "conversation_diff"
              ? (source.destinationPath ?? source.path)
              : source.kind === "workspace_diff"
                ? (source.newPath ?? source.oldPath ?? "Changed file")
                : source.kind === "workspace_file"
                  ? source.path
                  : "Conversation message";
          const label = path.split("/").at(-1) ?? path;
          return `Context from ${label}: ${part.excerpt.note ?? part.excerpt.excerpt}`;
        }
        if (part.kind === "attachment") return part.attachment.fileName;
        if (part.kind === "task_context") return `Task: ${part.task.title}`;
        return part.alt?.text ?? part.fileName?.text ?? "Image attachment";
      })
      .join(" "),
    userPreviewLimit,
  );
  const resolved = preview || "Message";
  userPreviewCache.set(item, resolved);
  return resolved;
}

export function assistantMessagePreview(
  item: Extract<ConversationItem, { kind: "assistant_message" }>,
): string {
  const cached = assistantPreviewCache.get(item);
  if (cached !== undefined) return cached;
  const preview = collapsePreview(
    markdownPreview(item.markdown.text),
    assistantPreviewLimit,
  );
  assistantPreviewCache.set(item, preview);
  return preview;
}
