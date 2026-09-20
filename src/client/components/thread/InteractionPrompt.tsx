import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import type { BackendInteraction } from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { LooseDiffLines } from "@client/components/diff/DiffBlocks";
import { Button } from "@client/components/ui/button";
import { Checkbox } from "@client/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import { RadioGroup, RadioGroupItem } from "@client/components/ui/radio-group";
import { StructuredValue } from "../conversation/StructuredValue";
import { InteractionForm } from "./InteractionForm.js";

type InteractionResponse = Parameters<ThreadClientStore["respond"]>[1];
type DecisionInteraction = Extract<BackendInteraction, { kind: "decision" }>;
type QuestionnaireInteraction = Extract<
  BackendInteraction,
  { kind: "questionnaire" }
>;
type QuestionnaireQuestion = QuestionnaireInteraction["questions"][number];

interface QuestionnaireDraft {
  readonly selectedOptionId?: string;
  readonly note: string;
  readonly text: string;
}

type NoteEditorOrigin = "manual" | "other";

export function InteractionPrompt({
  request,
  store,
  queueLength = 1,
  externallyPending = false,
  actionError,
  onDismissError,
  canInterrupt = false,
  unavailable = false,
  unavailableReason,
  returnFocusTarget,
  visible = true,
}: {
  request: BackendInteraction;
  store: ThreadClientStore;
  queueLength?: number;
  externallyPending?: boolean;
  actionError?: string;
  onDismissError?: () => void;
  canInterrupt?: boolean;
  unavailable?: boolean;
  unavailableReason?: string;
  returnFocusTarget?: HTMLElement | null;
  /** The prompt stays mounted while its containing Chat panel is collapsed. */
  visible?: boolean;
}): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const activeInteractionRef = useRef(request.id);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const pending = submitting || externallyPending;
  const controlsDisabled = pending || unavailable;

  useEffect(() => {
    return () => {
      if (!visibleRef.current) return;
      const target = returnFocusRef.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    if (!visible || returnFocusRef.current) return;
    returnFocusRef.current =
      returnFocusTarget ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
  }, [returnFocusTarget, visible]);

  useEffect(() => {
    activeInteractionRef.current = request.id;
    setSubmitting(false);
    setLocalError(undefined);
  }, [request.id]);

  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const target =
        dialog?.querySelector<HTMLElement>(
          "[data-interaction-autofocus]:not([disabled])",
        ) ??
        dialog?.querySelector<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex='0']",
        );
      (target ?? dialog)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [request.id, visible]);

  const respond = async (response: InteractionResponse) => {
    if (controlsDisabled) return;
    const interactionId = request.id;
    setSubmitting(true);
    setLocalError(undefined);
    onDismissError?.();
    try {
      await store.respond(interactionId, response);
      if (activeInteractionRef.current === interactionId) {
        setSubmitting(false);
      }
    } catch (error: unknown) {
      if (activeInteractionRef.current === interactionId) {
        setSubmitting(false);
        setLocalError(messageFrom(error));
      }
    }
  };

  const guardRepeatedResponseKey = (
    event: React.KeyboardEvent<HTMLElement>,
  ) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.matches("input, textarea, select") ||
        target.isContentEditable ||
        target.closest("[contenteditable='true']"))
    ) {
      return;
    }
    if (
      event.repeat &&
      (event.key === "Enter" ||
        event.key === "Escape" ||
        event.key === " " ||
        /^[1-8]$/.test(event.key))
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const visibleError = localError ?? actionError;
  return (
    <div
      className="interaction-takeover"
      data-testid="interaction-prompt-container"
    >
      <section
        ref={dialogRef}
        className="interaction-prompt-card"
        data-has-invocation={request.invocation ? "true" : undefined}
        data-interaction-kind={request.kind}
        data-testid="interaction-prompt"
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={pending}
        tabIndex={-1}
        onKeyDownCapture={guardRepeatedResponseKey}
      >
        <header className="interaction-prompt-header">
          <span className="interaction-prompt-dot" aria-hidden="true" />
          <h2 id={titleId}>{request.title.text}</h2>
          <p id={descriptionId} className="sr-only">
            This request is waiting for your response.
          </p>
          {/* One meta rail carries queue position and in-flight state. */}
          <div className="interaction-prompt-meta">
            {queueLength > 1 && (
              <span
                className="interaction-prompt-queue"
                data-testid="interaction-queue-position"
                aria-label={`Interaction 1 of ${queueLength}`}
              >
                1 of {queueLength}
              </span>
            )}
            {pending && (
              <p
                className="interaction-prompt-pending"
                data-testid="interaction-pending"
                role="status"
              >
                Sending response…
              </p>
            )}
          </div>
        </header>

        {unavailable && (
          <p className="interaction-prompt-unavailable">
            {unavailableReason ?? "This request cannot be answered right now."}
          </p>
        )}

        {/* Blockers read before the controls they apply to, never after. */}
        {visibleError && (
          <div
            className="interaction-prompt-error"
            data-testid="interaction-error"
            role="alert"
          >
            <span>{visibleError}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setLocalError(undefined);
                onDismissError?.();
              }}
            >
              Dismiss
            </Button>
          </div>
        )}

        {request.invocation && (
          <section
            aria-label="Invocation parameters"
            className="interaction-prompt-invocation"
          >
            <h3>Invocation parameters</h3>
            <StructuredValue value={request.invocation.arguments} />
          </section>
        )}

        {request.kind === "decision" ? (
          <DecisionPrompt
            visible={visible}
            key={request.id}
            request={request}
            pending={controlsDisabled}
            onRespond={(selectedActionId) =>
              void respond({ kind: "decision", selectedActionId })
            }
          />
        ) : request.kind === "questionnaire" ? (
          <QuestionnairePrompt
            key={request.id}
            request={request}
            pending={controlsDisabled}
            canInterrupt={canInterrupt}
            onInterrupt={() => {
              void store
                .stopActiveTurn()
                .catch((error: unknown) => setLocalError(messageFrom(error)));
            }}
            onRespond={(answers) =>
              void respond({ kind: "questionnaire", answers })
            }
          />
        ) : request.kind === "form" ? (
          <InteractionForm
            key={request.id}
            request={request}
            pending={controlsDisabled}
            onRespond={respond}
          />
        ) : (
          <PrimitivePrompt
            key={request.id}
            request={request}
            pending={controlsDisabled}
            onRespond={respond}
          />
        )}
      </section>
    </div>
  );
}

function DecisionPrompt({
  visible,
  request,
  pending,
  onRespond,
}: {
  readonly visible: boolean;
  readonly request: DecisionInteraction;
  readonly pending: boolean;
  readonly onRespond: (actionId: string) => void;
}): React.JSX.Element {
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [rejectionMenuOpen, setRejectionMenuOpen] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState<string>();
  const primary = request.actions.find(({ role }) => role === "primary");
  const alternatives = request.actions.filter(
    ({ role }) => role === "alternative",
  );
  const rejects = request.actions.filter(({ role }) => role === "reject");
  const selectAction = (actionId: string) => {
    if (pending) return;
    setSelectedActionId(actionId);
    onRespond(actionId);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.nativeEvent.isComposing ||
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const interactiveTarget = isInteractiveControl(event.target);
    if (
      event.key === "Enter" &&
      primary &&
      !approvalMenuOpen &&
      !rejectionMenuOpen &&
      !interactiveTarget &&
      !pending
    ) {
      event.preventDefault();
      selectAction(primary.id);
    } else if (event.key === "Escape") {
      if (approvalMenuOpen || rejectionMenuOpen) return;
      if (rejects.length === 1 && !pending) {
        event.preventDefault();
        selectAction(rejects[0]!.id);
      }
    }
  };

  return (
    <div
      className="interaction-decision"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {request.message && (
        <p
          className="interaction-prompt-message"
          data-testid="interaction-prompt-message"
        >
          {request.message.text}
        </p>
      )}
      {request.code && (
        <div
          className="interaction-prompt-detail"
          data-testid="interaction-prompt-code"
        >
          <LooseDiffLines text={request.code.text} />
        </div>
      )}
      <div className="interaction-decision-actions">
        {primary && rejects.length === 1 && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            data-testid="decision-reject-action"
            onClick={() => selectAction(rejects[0]!.id)}
          >
            {pending && selectedActionId === rejects[0]!.id
              ? "Denying…"
              : rejects[0]!.label.text}
          </Button>
        )}
        {primary && rejects.length > 1 && (
          <div className="interaction-split-button">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              data-testid="decision-reject-action"
              onClick={() => selectAction(rejects[0]!.id)}
            >
              {pending && selectedActionId === rejects[0]!.id
                ? "Sending…"
                : rejects[0]!.label.text}
            </Button>
            <ActionMenu
              label="More rejection options"
              actions={rejects.slice(1)}
              pending={pending}
              open={visible && rejectionMenuOpen}
              onOpenChange={setRejectionMenuOpen}
              onSelect={selectAction}
              tone="quiet"
            />
          </div>
        )}
        {primary && (
          <div className="interaction-split-button">
            <Button
              type="button"
              disabled={pending}
              data-interaction-autofocus
              data-testid="decision-primary-action"
              onClick={() => selectAction(primary.id)}
            >
              {pending && selectedActionId === primary.id
                ? "Allowing…"
                : primary.label.text}
            </Button>
            {/* "More options" means options the button does not already offer. */}
            {alternatives.length > 0 && (
              <ActionMenu
                label="More approval options"
                actions={alternatives}
                pending={pending}
                open={visible && approvalMenuOpen}
                onOpenChange={setApprovalMenuOpen}
                onSelect={selectAction}
                tone="primary"
              />
            )}
          </div>
        )}
        {!primary &&
          request.actions.map((action, index) => (
            <Button
              key={action.id}
              type="button"
              variant={action.role === "reject" ? "ghost" : "secondary"}
              disabled={pending}
              data-interaction-autofocus={index === 0 ? true : undefined}
              onClick={() => selectAction(action.id)}
            >
              {pending && selectedActionId === action.id
                ? "Sending…"
                : action.label.text}
            </Button>
          ))}
      </div>
    </div>
  );
}

function ActionMenu({
  label,
  actions,
  pending,
  open,
  onOpenChange,
  onSelect,
  tone,
}: {
  readonly label: string;
  readonly actions: DecisionInteraction["actions"];
  readonly pending: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (actionId: string) => void;
  readonly tone: "primary" | "quiet";
}): React.JSX.Element {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          aria-label={label}
          data-testid={
            label === "More approval options"
              ? "decision-primary-menu"
              : "decision-reject-menu"
          }
          variant={tone === "quiet" ? "ghost" : undefined}
          disabled={pending}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") onOpenChange(true);
          }}
        >
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="interaction-action-menu"
        side="top"
      >
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            onSelect={() => onSelect(action.id)}
          >
            <span className="interaction-action-menu-copy">
              <span title={action.label.text}>{action.label.text}</span>
              {action.description && (
                <small title={action.description.text}>
                  {action.description.text}
                </small>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QuestionnairePrompt({
  request,
  pending,
  canInterrupt,
  onInterrupt,
  onRespond,
}: {
  readonly request: QuestionnaireInteraction;
  readonly pending: boolean;
  readonly canInterrupt: boolean;
  readonly onInterrupt: () => void;
  readonly onRespond: (
    answers: Extract<InteractionResponse, { kind: "questionnaire" }>["answers"],
  ) => void;
}): React.JSX.Element {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, QuestionnaireDraft>>({});
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [noteEditorOrigin, setNoteEditorOrigin] = useState<NoteEditorOrigin>();
  const [confirmUnanswered, setConfirmUnanswered] = useState(false);
  const [secretVisible, setSecretVisible] = useState(false);
  const [submissionStarted, setSubmissionStarted] = useState(false);
  const optionIdBase = useId();
  const noteRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const optionScrollerRef = useRef<HTMLDivElement | null>(null);
  const optionScrollPositionsRef = useRef<Record<string, number>>({});
  const draftsRef = useRef<Record<string, QuestionnaireDraft>>({});
  const questionnaireRef = useRef<HTMLDivElement | null>(null);
  const unansweredConfirmRef = useRef<HTMLDivElement | null>(null);
  const question = request.questions[questionIndex]!;
  const draft = drafts[question.id] ?? EMPTY_DRAFT;
  const choiceOptions =
    question.input.kind === "single_choice"
      ? [
          ...question.input.options,
          ...(question.input.other ? [question.input.other] : []),
        ]
      : [];
  const otherSelected =
    question.input.kind === "single_choice" &&
    question.input.other?.id === draft.selectedOptionId;
  const otherOptionId =
    question.input.kind === "single_choice"
      ? question.input.other?.id
      : undefined;

  const replaceDrafts = (
    update: (
      current: Readonly<Record<string, QuestionnaireDraft>>,
    ) => Record<string, QuestionnaireDraft>,
  ): Record<string, QuestionnaireDraft> => {
    const next = update(draftsRef.current);
    draftsRef.current = next;
    setDrafts(next);
    return next;
  };

  useEffect(() => {
    setHighlightedIndex(0);
    setNoteEditorOrigin(undefined);
    setSecretVisible(false);
    const optionScroller = optionScrollerRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (optionScroller) {
        optionScroller.scrollTop =
          optionScrollPositionsRef.current[question.id] ?? 0;
      }
      questionnaireRef.current
        ?.querySelector<HTMLElement>("[data-question-autofocus]")
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (optionScroller) {
        optionScrollPositionsRef.current[question.id] =
          optionScroller.scrollTop;
      }
    };
  }, [question.id]);

  useEffect(() => {
    if (otherSelected && noteEditorOrigin === undefined) {
      setNoteEditorOrigin("other");
      window.requestAnimationFrame(() => noteRef.current?.focus());
    }
  }, [otherSelected, noteEditorOrigin]);

  useEffect(() => {
    if (!confirmUnanswered) return;
    const frame = window.requestAnimationFrame(() =>
      unansweredConfirmRef.current
        ?.querySelector<HTMLElement>("[data-interaction-autofocus]")
        ?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [confirmUnanswered]);

  const updateDraft = (update: Partial<QuestionnaireDraft>) => {
    replaceDrafts((current) => ({
      ...current,
      [question.id]: {
        ...(current[question.id] ?? EMPTY_DRAFT),
        ...update,
      },
    }));
  };

  const firstUnansweredIndex = (
    candidateDrafts: Readonly<
      Record<string, QuestionnaireDraft>
    > = draftsRef.current,
  ) =>
    request.questions.findIndex((candidate) =>
      isQuestionUnanswered(
        candidate,
        candidateDrafts[candidate.id] ?? EMPTY_DRAFT,
      ),
    );

  const submit = (
    candidateDrafts: Readonly<
      Record<string, QuestionnaireDraft>
    > = draftsRef.current,
  ) => {
    const firstUnanswered = firstUnansweredIndex(candidateDrafts);
    if (firstUnanswered >= 0) {
      setConfirmUnanswered(true);
      return;
    }
    setSubmissionStarted(true);
    onRespond(questionnaireAnswers(request, candidateDrafts));
  };

  const submitConfirmed = () => {
    if (pending) return;
    setSubmissionStarted(true);
    onRespond(questionnaireAnswers(request, draftsRef.current));
  };

  const focusCurrentQuestion = () => {
    window.requestAnimationFrame(() =>
      questionnaireRef.current
        ?.querySelector<HTMLElement>("[data-question-autofocus]")
        ?.focus(),
    );
  };

  const returnToFirstUnanswered = () => {
    const first = firstUnansweredIndex();
    setConfirmUnanswered(false);
    if (first >= 0 && first !== questionIndex) {
      setQuestionIndex(first);
    } else {
      focusCurrentQuestion();
    }
  };

  const advance = () => {
    if (questionIndex < request.questions.length - 1) {
      setQuestionIndex((index) => index + 1);
    } else {
      submit();
    }
  };

  const choose = (optionId: string, advanceAfterSelection: boolean) => {
    const currentDraft = draftsRef.current[question.id] ?? EMPTY_DRAFT;
    const leavingAutoOther =
      currentDraft.selectedOptionId === otherOptionId &&
      optionId !== otherOptionId &&
      noteEditorOrigin === "other";
    const nextDrafts = replaceDrafts((current) => ({
      ...current,
      [question.id]: {
        ...currentDraft,
        selectedOptionId: optionId,
        ...(leavingAutoOther ? { note: "" } : {}),
      },
    }));
    if (optionId === otherOptionId && noteEditorOrigin === undefined) {
      setNoteEditorOrigin("other");
      window.requestAnimationFrame(() => noteRef.current?.focus());
    } else if (leavingAutoOther) {
      setNoteEditorOrigin(undefined);
    }
    if (advanceAfterSelection && optionId !== otherOptionId) {
      if (questionIndex < request.questions.length - 1) {
        setQuestionIndex((index) => index + 1);
      } else {
        submit(nextDrafts);
      }
    }
  };

  const handleNavigatorKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.nativeEvent.isComposing ||
      event.repeat ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    )
      return;
    if (pending) return;
    const count = choiceOptions.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) =>
        event.key === "ArrowDown"
          ? (current + 1) % count
          : (current - 1 + count) % count,
      );
    } else if (event.key === "ArrowLeft" && questionIndex > 0) {
      event.preventDefault();
      setQuestionIndex((index) => index - 1);
    } else if (
      event.key === "ArrowRight" &&
      questionIndex < request.questions.length - 1
    ) {
      event.preventDefault();
      setQuestionIndex((index) => index + 1);
    } else if (/^[1-8]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      const option = choiceOptions[index];
      if (option) {
        event.preventDefault();
        setHighlightedIndex(index);
        choose(option.id, true);
      }
    } else if (event.key === "Enter" && choiceOptions[highlightedIndex]) {
      event.preventDefault();
      choose(choiceOptions[highlightedIndex]!.id, true);
    } else if (event.key === " ") {
      event.preventDefault();
      const option = choiceOptions[highlightedIndex];
      if (option) choose(option.id, false);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      updateDraft({ selectedOptionId: undefined });
    } else if (event.key === "Escape" && canInterrupt && !pending) {
      event.preventDefault();
      onInterrupt();
    }
  };

  const handleTextEscape = (event: React.KeyboardEvent<HTMLElement>) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    if (confirmUnanswered) {
      event.preventDefault();
      returnToFirstUnanswered();
      return;
    }
    if (noteEditorOrigin !== undefined && event.target === noteRef.current) {
      event.preventDefault();
      if (draft.note) updateDraft({ note: "" });
      if (!otherSelected) setNoteEditorOrigin(undefined);
      questionnaireRef.current
        ?.querySelector<HTMLElement>("[data-testid='questionnaire-options']")
        ?.focus();
      return;
    }
    if (canInterrupt && !pending) {
      event.preventDefault();
      onInterrupt();
    }
  };

  return (
    <div
      ref={questionnaireRef}
      className="interaction-questionnaire"
      data-confirming={confirmUnanswered ? "true" : undefined}
      onKeyDown={handleTextEscape}
    >
      <div
        className="interaction-questionnaire-content"
        inert={confirmUnanswered ? true : undefined}
        aria-hidden={confirmUnanswered ? true : undefined}
      >
        <div
          className="interaction-question-progress"
          data-testid="questionnaire-progress"
        >
          <span className="interaction-question-header">
            {question.header.text}
          </span>
          <span className="sr-only">
            Question {questionIndex + 1} of {request.questions.length}
          </span>
          {/* Segments carry position and answered-ness at a glance, so the
              unanswered confirm is never the first warning of a gap. */}
          {request.questions.length > 1 && (
            <span className="interaction-question-steps" aria-hidden="true">
              {request.questions.map((candidate, index) => (
                <span
                  key={candidate.id}
                  data-state={
                    index === questionIndex
                      ? "current"
                      : isQuestionUnanswered(
                            candidate,
                            drafts[candidate.id] ?? EMPTY_DRAFT,
                          )
                        ? "pending"
                        : "answered"
                  }
                />
              ))}
            </span>
          )}
        </div>
        <h3>{question.prompt.text}</h3>
        {request.message && questionIndex === 0 && (
          <p className="interaction-prompt-message">{request.message.text}</p>
        )}

        {question.input.kind === "single_choice" ? (
          <div
            ref={optionScrollerRef}
            className="interaction-question-options"
            data-testid="questionnaire-options"
            role="radiogroup"
            aria-label={question.prompt.text}
            tabIndex={0}
            aria-activedescendant={
              choiceOptions[highlightedIndex]
                ? `${optionIdBase}-option-${highlightedIndex}`
                : undefined
            }
            data-interaction-autofocus
            data-question-autofocus
            onKeyDown={handleNavigatorKey}
          >
            {choiceOptions.map((option, index) => {
              const selected = draft.selectedOptionId === option.id;
              const highlighted = highlightedIndex === index;
              return (
                <button
                  id={`${optionIdBase}-option-${index}`}
                  key={option.id}
                  type="button"
                  role="radio"
                  tabIndex={-1}
                  aria-checked={selected}
                  className="interaction-question-option"
                  data-testid={`questionnaire-option-${option.id}`}
                  data-highlighted={highlighted ? "true" : undefined}
                  disabled={pending}
                  onPointerMove={() => setHighlightedIndex(index)}
                  onClick={() => {
                    choose(option.id, false);
                    optionScrollerRef.current?.focus();
                  }}
                >
                  <span
                    className="interaction-question-number"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <span>
                    <strong>{option.label.text}</strong>
                    {option.description && (
                      <small>{option.description.text}</small>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ) : question.input.multiline ? (
          <textarea
            data-interaction-autofocus
            data-question-autofocus
            className={
              question.secret && !secretVisible
                ? "interaction-secret-input"
                : undefined
            }
            data-masked={question.secret && !secretVisible ? "true" : "false"}
            aria-label={question.prompt.text}
            value={draft.text}
            disabled={pending}
            autoComplete={question.secret ? "new-password" : undefined}
            spellCheck={question.secret ? false : undefined}
            placeholder={question.input.placeholder?.text}
            onChange={(event) => updateDraft({ text: event.target.value })}
          />
        ) : (
          <input
            data-interaction-autofocus
            data-question-autofocus
            type={question.secret && !secretVisible ? "password" : "text"}
            data-masked={question.secret && !secretVisible ? "true" : "false"}
            aria-label={question.prompt.text}
            value={draft.text}
            disabled={pending}
            autoComplete={question.secret ? "new-password" : undefined}
            spellCheck={question.secret ? false : undefined}
            placeholder={question.input.placeholder?.text}
            onChange={(event) => updateDraft({ text: event.target.value })}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.repeat &&
                !event.nativeEvent.isComposing &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                event.preventDefault();
                advance();
              }
            }}
          />
        )}

        {question.input.kind === "single_choice" &&
          question.input.allowNote &&
          (noteEditorOrigin !== undefined || otherSelected ? (
            question.secret ? (
              <input
                ref={(node) => {
                  noteRef.current = node;
                }}
                type="password"
                data-masked="true"
                data-testid="questionnaire-note"
                aria-label={`Note for ${question.header.text}`}
                value={draft.note}
                disabled={pending}
                autoComplete="new-password"
                spellCheck={false}
                placeholder="Add details (optional)"
                onChange={(event) => updateDraft({ note: event.target.value })}
              />
            ) : (
              <textarea
                ref={(node) => {
                  noteRef.current = node;
                }}
                data-testid="questionnaire-note"
                aria-label={`Note for ${question.header.text}`}
                value={draft.note}
                disabled={pending}
                placeholder="Add details (optional)"
                onChange={(event) => updateDraft({ note: event.target.value })}
              />
            )
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setNoteEditorOrigin("manual")}
            >
              Add note
            </Button>
          ))}

        {question.secret && question.input.kind === "text" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="interaction-secret-toggle"
            aria-pressed={secretVisible}
            disabled={pending}
            onClick={() => setSecretVisible((visible) => !visible)}
          >
            {secretVisible ? (
              <EyeOff aria-hidden="true" />
            ) : (
              <Eye aria-hidden="true" />
            )}
            {secretVisible ? "Hide response" : "Show response"}
          </Button>
        )}

        <div className="interaction-question-actions">
          {request.questions.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              disabled={pending || questionIndex === 0}
              onClick={() =>
                setQuestionIndex((index) => Math.max(0, index - 1))
              }
            >
              Back
            </Button>
          )}
          <Button type="button" disabled={pending} onClick={advance}>
            {questionIndex === request.questions.length - 1
              ? submissionStarted && pending
                ? "Submitting…"
                : "Submit answers"
              : "Next"}
          </Button>
        </div>
      </div>

      {confirmUnanswered && (
        <div
          ref={unansweredConfirmRef}
          className="interaction-unanswered-confirm"
          data-testid="questionnaire-unanswered-confirm"
          role="alertdialog"
          aria-label="Submit unanswered questions?"
        >
          <p>Some questions are unanswered. Proceed anyway?</p>
          <div>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={returnToFirstUnanswered}
            >
              Go back
            </Button>
            <Button
              type="button"
              data-interaction-autofocus
              disabled={pending}
              onClick={submitConfirmed}
            >
              {submissionStarted && pending ? "Submitting…" : "Proceed"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PrimitivePrompt({
  request,
  pending,
  onRespond,
}: {
  readonly request: Exclude<
    BackendInteraction,
    { kind: "decision" | "questionnaire" | "form" }
  >;
  readonly pending: boolean;
  readonly onRespond: (response: InteractionResponse) => Promise<void>;
}): React.JSX.Element {
  const optionIdBase = useId();
  const [value, setValue] = useState(
    request.kind === "text_input" || request.kind === "editor"
      ? (request.initialValue?.text ?? "")
      : "",
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [secretEditorVisible, setSecretEditorVisible] = useState(false);
  const submit = () => {
    if (request.kind === "choice") {
      return onRespond({ kind: "choice", selectedOptionIds: selected });
    }
    if (request.kind === "confirmation") {
      return onRespond({ kind: "confirmation", confirmed: true });
    }
    return onRespond({ kind: request.kind, value });
  };
  const optionBody = (option: {
    readonly label: { readonly text: string };
    readonly description?: { readonly text: string };
  }) => (
    <span>
      {option.label.text}
      {option.description && <small>{option.description.text}</small>}
    </span>
  );

  return (
    <>
      {request.kind === "confirmation" &&
        request.message.text.trim() !== "" && (
          <p
            className="interaction-prompt-message"
            data-testid="interaction-prompt-message"
          >
            {request.message.text}
          </p>
        )}
      {request.kind === "choice" && request.message && (
        <p
          className="interaction-prompt-message"
          data-testid="interaction-prompt-message"
        >
          {request.message.text}
        </p>
      )}
      {request.kind === "choice" &&
        (request.multiple ? (
          <div
            className="interaction-prompt-options"
            role="group"
            aria-label={request.title.text}
          >
            {request.options.map((option) => (
              <label key={option.id} htmlFor={`${optionIdBase}-${option.id}`}>
                <Checkbox
                  id={`${optionIdBase}-${option.id}`}
                  checked={selected.includes(option.id)}
                  disabled={pending}
                  onCheckedChange={() =>
                    setSelected((current) =>
                      current.includes(option.id)
                        ? current.filter((id) => id !== option.id)
                        : [...current, option.id],
                    )
                  }
                />
                {optionBody(option)}
              </label>
            ))}
          </div>
        ) : (
          <RadioGroup
            className="interaction-prompt-options"
            aria-label={request.title.text}
            value={selected[0] ?? ""}
            disabled={pending}
            onValueChange={(optionId) => setSelected([optionId])}
          >
            {request.options.map((option) => (
              <label key={option.id} htmlFor={`${optionIdBase}-${option.id}`}>
                <RadioGroupItem
                  id={`${optionIdBase}-${option.id}`}
                  value={option.id}
                />
                {optionBody(option)}
              </label>
            ))}
          </RadioGroup>
        ))}
      {(request.kind === "text_input" || request.kind === "editor") && (
        <div className="interaction-prompt-form">
          {request.kind === "editor" || request.multiline ? (
            <textarea
              className={
                request.secret && !secretEditorVisible
                  ? "interaction-secret-input"
                  : undefined
              }
              data-masked={
                request.secret && !secretEditorVisible ? "true" : "false"
              }
              aria-label={request.title.text}
              value={value}
              disabled={pending}
              autoComplete={request.secret ? "off" : undefined}
              spellCheck={request.secret ? false : undefined}
              placeholder={
                request.kind === "text_input"
                  ? request.placeholder?.text
                  : undefined
              }
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <input
              type={request.secret ? "password" : "text"}
              aria-label={request.title.text}
              value={value}
              disabled={pending}
              autoComplete={request.secret ? "off" : undefined}
              spellCheck={request.secret ? false : undefined}
              placeholder={request.placeholder?.text}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          {request.kind === "editor" && request.secret && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="interaction-secret-toggle"
              aria-pressed={secretEditorVisible}
              disabled={pending}
              onClick={() => setSecretEditorVisible((visible) => !visible)}
            >
              {secretEditorVisible ? "Hide response" : "Show response"}
            </Button>
          )}
        </div>
      )}
      <div className="interaction-prompt-actions">
        {request.cancellable && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => void onRespond({ kind: "cancel" })}
          >
            {request.kind === "confirmation"
              ? (request.cancelLabel?.text ?? "Cancel")
              : "Cancel"}
          </Button>
        )}
        <Button
          type="button"
          disabled={
            pending || (request.kind === "choice" && selected.length === 0)
          }
          onClick={() => void submit()}
        >
          {request.kind === "confirmation"
            ? (request.confirmLabel?.text ?? "Confirm")
            : "Continue"}
        </Button>
      </div>
    </>
  );
}

function questionnaireAnswers(
  request: QuestionnaireInteraction,
  drafts: Readonly<Record<string, QuestionnaireDraft>>,
): Extract<InteractionResponse, { kind: "questionnaire" }>["answers"] {
  return request.questions.map((question) => {
    const draft = drafts[question.id] ?? EMPTY_DRAFT;
    if (question.input.kind === "single_choice" && draft.selectedOptionId) {
      return {
        questionId: question.id,
        answer: {
          kind: "single_choice" as const,
          selectedOptionId: draft.selectedOptionId,
          ...(draft.note ? { note: draft.note } : {}),
        },
      };
    }
    if (question.input.kind === "text" && draft.text) {
      return {
        questionId: question.id,
        answer: { kind: "text" as const, value: draft.text },
      };
    }
    return { questionId: question.id, answer: { kind: "unanswered" as const } };
  });
}

function isQuestionUnanswered(
  question: QuestionnaireQuestion,
  draft: QuestionnaireDraft,
): boolean {
  return question.input.kind === "single_choice"
    ? !draft.selectedOptionId
    : draft.text.length === 0;
}

const EMPTY_DRAFT: QuestionnaireDraft = Object.freeze({ note: "", text: "" });

function isInteractiveControl(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, input, textarea, select, a[href], [role='menuitem']",
    ) !== null
  );
}

function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The response could not be sent.";
}
