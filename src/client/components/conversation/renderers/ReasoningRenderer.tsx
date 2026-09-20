import { useId, useState } from "react";
import type { ReasoningItem } from "../../../../shared/index.js";
import { ChevronRight } from "lucide-react";
import { ProgressiveMarkdown } from "../ProgressiveMarkdown";
import { TruncationNotice } from "../StructuredValue";
import type { ConversationItemRenderer } from "../types";

function ReasoningContent({
  item,
}: {
  item: ReasoningItem;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(item.status === "streaming");
  const bodyId = useId();
  const summaryParts = item.summaryParts;
  const summaryText = (summaryParts ?? [])
    .map(({ text }) => text)
    .filter((text) => text.length > 0)
    .join("\n\n");
  if (!summaryText && !item.markdown.text && item.status === "streaming") {
    return null;
  }
  return (
    <section
      aria-label="Reasoning"
      className="reasoning-row"
      data-streaming={item.status === "streaming" ? "true" : "false"}
    >
      <button
        aria-controls={bodyId}
        aria-expanded={open}
        className="meta-row"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRight className="meta-chevron" size={12} strokeWidth={1.8} />
        <span>{reasoningLabel(item)}</span>
      </button>
      <div className={`collapse${open ? " open" : ""}`} id={bodyId}>
        <div>
          <div className="reason-body">
            {summaryText && (
              <div className="reason-summary-parts">
                <ProgressiveMarkdown
                  animationActive={open}
                  streaming={item.status === "streaming"}
                >
                  {summaryText}
                </ProgressiveMarkdown>
                {(summaryParts ?? []).map((part, index) => (
                  <TruncationNotice key={index} truncation={part.truncation} />
                ))}
              </div>
            )}
            {item.markdown.text && (
              <div className="reason-raw-detail">
                <ProgressiveMarkdown
                  animationActive={open}
                  streaming={item.status === "streaming"}
                >
                  {item.markdown.text}
                </ProgressiveMarkdown>
                <TruncationNotice truncation={item.markdown.truncation} />
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function reasoningLabel(item: ReasoningItem): string {
  if (item.status === "streaming") return "Thinking…";
  if (item.startedAt && item.completedAt) {
    const elapsedMs = Date.parse(item.completedAt) - Date.parse(item.startedAt);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
      return `Thought for ${formatThinkingDuration(elapsedMs)}`;
    }
  }
  return "Reasoning";
}

function formatThinkingDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const reasoningRenderer: ConversationItemRenderer<ReasoningItem> = {
  kind: "reasoning",
  render(item) {
    return <ReasoningContent item={item} />;
  },
};
