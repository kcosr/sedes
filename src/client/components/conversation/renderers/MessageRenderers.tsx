import { QuestionTranscriptDisclosure } from "../../thread/QuestionInbox.js";
import { useCallback, useState } from "react";
import { ChevronRight, CircleCheck, ListTodo, MessageCircleQuestion, Sparkles } from "lucide-react";
import type {
  AssistantMessageItem,
  ComposerTaskReference,
  DeliveryInputOrigin,
  UserMessageItem,
} from "../../../../shared/index.js";
import { ProgressiveMarkdown } from "../ProgressiveMarkdown";
import { TruncationNotice } from "../StructuredValue";
import type { ConversationItemRenderer, ItemRenderContext } from "../types";
import { ContextExcerptList } from "../../../context-excerpts/ContextExcerptCard.js";
import {
  ConversationMessageSelectionSurface,
  conversationMessageSelectableTextProps,
} from "../../../context-excerpts/ConversationMessageSelectionSurface.js";
import { DurableAttachmentCard } from "../../../attachments/AttachmentCards.js";

export const userMessageRenderer: ConversationItemRenderer<UserMessageItem> = {
  kind: "user_message",
  render(item, context) {
    return (
      <UserMessagePresentation
        content={item.content}
        context={context}
        origin={item.origin}
        selection={{
          enabled: item.status !== "streaming",
          itemId: item.id,
          itemRevision: item.revision,
        }}
      />
    );
  },
};

export type UserMessagePresentationPart =
  | UserMessageItem["content"][number]
  | {
      readonly kind: "task_reference";
      readonly reference: ComposerTaskReference;
    };

/**
 * The visual user-message body shared by provider-authoritative items and
 * client-only delivery presentation. A client presentation deliberately has
 * no selection identity, so it cannot become context or history authority.
 */
export function UserMessagePresentation({
  content,
  context,
  origin,
  selection,
}: {
  readonly content: readonly UserMessagePresentationPart[];
  readonly context: ItemRenderContext;
  readonly origin?: DeliveryInputOrigin;
  readonly selection?: {
    readonly enabled: boolean;
    readonly itemId: string;
    readonly itemRevision: number;
  };
}): React.JSX.Element {
  if (origin?.kind === "question_response") {
    return (
      <details
        className="agent-input-disclosure question-transcript-disclosure"
        data-question-status="answered"
        data-message-origin={origin.kind}
        data-testid="message-row"
      >
        <summary className="agent-input-disclosure-summary">
          <ChevronRight
            aria-hidden="true"
            className="agent-input-disclosure-chevron"
            size={12}
            strokeWidth={1.8}
          />
          <MessageCircleQuestion
            aria-hidden="true"
            className="question-disclosure-icon"
            size={14}
          />
          <span className="agent-input-disclosure-label">
            {origin.answers.length === 1 ? "Question answered" : "Questions answered"}
          </span>
          {origin.answers.length > 1 && (
            <span className="question-disclosure-count">{origin.answers.length}</span>
          )}
          <span className="agent-input-disclosure-preview question-disclosure-preview">
            {origin.answers[0]?.question}
          </span>
        </summary>
        <div className="agent-input-disclosure-body">
          <dl className="question-response-answers">
            {origin.answers.map(({ questionIndex, question, answer }) => (
              <div key={questionIndex}>
                <dt>{question}</dt>
                <dd>{answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
    );
  }
  const body = (
    <>
      {content.some((part) => part.kind === "skill") && (
        <div className="message-skill-badges">
          {content.map((part, index) =>
            part.kind === "skill" ? (
              <span className="message-skill-badge" key={index}>
                <Sparkles aria-hidden="true" size={12} strokeWidth={1.8} />
                <span>{part.name.text}</span>
                <TruncationNotice truncation={part.name.truncation} />
              </span>
            ) : null,
          )}
        </div>
      )}
      <ContextExcerptList
        excerpts={content.flatMap((part) =>
          part.kind === "context_excerpt" ? [part.excerpt] : [],
        )}
      />
      {content.map((part, index) =>
        part.kind === "skill" ||
        part.kind === "context_excerpt" ? null : part.kind === "text" ? (
          <div className="streaming-text" key={index}>
            <span {...conversationMessageSelectableTextProps}>
              {part.text.text}
            </span>
          </div>
        ) : part.kind === "attachment" ? (
          <DurableAttachmentCard
            key={index}
            attachment={part.attachment}
            loadContent={context.loadAttachmentContent}
          />
        ) : part.kind === "task_context" ? (
          <details
            className="message-task-card"
            data-task-id={part.task.id}
            key={index}
          >
            <summary>
              {part.task.completedAt ? (
                <CircleCheck size={14} aria-hidden="true" />
              ) : (
                <ListTodo size={14} aria-hidden="true" />
              )}
              <strong>{part.task.title}</strong>
              <span>{part.task.completedAt ? "Completed" : "Task"}</span>
            </summary>
            {part.task.details && <p>{part.task.details}</p>}
            <dl>
              <dt>Task ID</dt>
              <dd>{part.task.id}</dd>
              <dt>Revision</dt>
              <dd>{part.task.revision}</dd>
            </dl>
          </details>
        ) : part.kind === "task_reference" ? (
          <details
            className="message-task-card"
            data-task-id={part.reference.taskId}
            key={index}
          >
            <summary>
              <ListTodo size={14} aria-hidden="true" />
              <strong>{part.reference.titleSnapshot}</strong>
              <span>Task</span>
            </summary>
            <dl>
              <dt>Task ID</dt>
              <dd>{part.reference.taskId}</dd>
            </dl>
          </details>
        ) : (
          <div className="attachment-note" key={index}>
            {part.fileName?.text ?? part.alt?.text ?? "Image attachment"}
            {part.omitted && " · preview omitted"}
          </div>
        ),
      )}
    </>
  );
  const presentation = selection ? (
    <ConversationMessageSelectionSurface
      className="message-body"
      enabled={selection.enabled}
      itemId={selection.itemId}
      itemRevision={selection.itemRevision}
      selectionKind="plain_text"
    >
      {body}
    </ConversationMessageSelectionSurface>
  ) : (
    <div className="message-body">{body}</div>
  );
  if (origin) {
    const label =
      origin.kind === "agent_message" ? "Agent message" : "Agent result";
    return (
      <details
        className="agent-input-disclosure"
        data-message-origin={origin.kind}
        data-testid="message-row"
      >
        <summary className="agent-input-disclosure-summary">
          <ChevronRight
            aria-hidden="true"
            className="agent-input-disclosure-chevron"
            size={12}
            strokeWidth={1.8}
          />
          <span className="agent-input-disclosure-label">{label}</span>
          <span className="agent-input-disclosure-source">
            {origin.sourceThreadLabel.text}
            <TruncationNotice
              truncation={origin.sourceThreadLabel.truncation}
            />
          </span>
          <span className="agent-input-disclosure-preview">
            {agentInputPreview(content, origin)}
          </span>
        </summary>
        <div className="agent-input-disclosure-body">{presentation}</div>
      </details>
    );
  }
  return (
    <article className="message-row user" data-testid="message-row">
      <header className="sr-only">You</header>
      {presentation}
    </article>
  );
}

function agentInputPreview(
  content: readonly UserMessagePresentationPart[],
  origin: DeliveryInputOrigin,
): string {
  const text = content
    .flatMap((part) =>
      part.kind === "text"
        ? [part.text.text]
        : part.kind === "task_reference"
          ? [part.reference.titleSnapshot]
          : part.kind === "task_context"
            ? [part.task.title]
            : [],
    )
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  const withoutCallbackEnvelope =
    origin.kind === "agent_result"
      ? text.replace(/^Agent result from .+? \([^\n)]+\):\s*/iu, "")
      : text;
  const plainText = withoutCallbackEnvelope
    .replace(/```[^\n]*\n?/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "")
    .replace(/[*_~`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return plainText.length === 0 ? "No text content" : plainText;
}

export const assistantMessageRenderer: ConversationItemRenderer<AssistantMessageItem> =
  {
    kind: "assistant_message",
    render(item, context) {
      return (
        <AssistantMessage item={item} assistantLabel={context.assistantLabel} />
      );
    },
  };

function AssistantMessage({
  item,
  assistantLabel,
}: {
  readonly item: AssistantMessageItem;
  readonly assistantLabel: string;
}): React.JSX.Element | null {
  const [presentationActive, setPresentationActive] = useState(
    item.status === "streaming",
  );
  const presentationChanged = useCallback((active: boolean) => {
    setPresentationActive(active);
  }, []);

  if (item.nonblockingQuestions)
    return <QuestionTranscriptDisclosure item={item} />;
  if (!item.markdown.text && item.status === "streaming") return null;
  return (
    <article className="message-row assistant" data-testid="message-row">
      <header className="sr-only">
        {assistantLabel}
        {item.status === "streaming" && " · responding"}
      </header>
      <ConversationMessageSelectionSurface
        className="message-body"
        enabled={item.status !== "streaming" && !presentationActive}
        itemId={item.id}
        itemRevision={item.revision}
        selectionKind="markdown"
      >
        <ProgressiveMarkdown
          copyCodeBlocks
          onPresentationActiveChange={presentationChanged}
          sourcePositionMetadata={item.status !== "streaming"}
          streaming={item.status === "streaming"}
        >
          {item.markdown.text}
        </ProgressiveMarkdown>
      </ConversationMessageSelectionSurface>
    </article>
  );
}
