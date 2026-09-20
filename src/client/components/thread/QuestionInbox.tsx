import {
  ChevronLeft,
  ChevronRight,
  MessageCircleQuestion,
  X,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AssistantMessageItem } from "../../../shared/index.js";
import type { QuestionRequest, QuestionRequestStatus } from "../../../shared/protocol/questions.js";
import {
  useThreadStore,
  type ThreadClientStore,
} from "../../stores/ThreadClientStore.js";
import { Button } from "../ui/button.js";
import "./question-inbox.css";

const QuestionInboxContext = createContext<{
  store: ThreadClientStore;
  open: boolean;
  selectedSourceId?: string;
  selectionRevision: number;
  focusRevision: number;
  panelId: string;
  trigger: React.RefObject<HTMLButtonElement | null>;
  setOpen(open: boolean): void;
  openQuestion(sourceItemId?: string): void;
} | null>(null);

export function QuestionInboxProvider({
  store,
  visible,
  children,
}: {
  store: ThreadClientStore;
  visible: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [focusRevision, setFocusRevision] = useState(0);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const state = useThreadStore(store);
  // A manual close belongs to the retained thread store, so remounting the
  // panel does not make the same pending questions look newly arrived.
  const observedQuestions = useRef(
    new Set(state.questionInboxClosedQuestionKeys),
  );
  useEffect(() => {
    if (!visible) {
      setOpen(false);
      return;
    }
    const questions = new Set(
      state.questionRequests.flatMap((request) =>
        request.questions.map((question) => `${request.id}:${question.index}`),
      ),
    );
    const hasNewQuestion = [...questions].some(
      (id) => !observedQuestions.current.has(id),
    );
    observedQuestions.current = questions;
    if (questions.size === 0) setOpen(false);
    else if (
      hasNewQuestion && !open &&
      state.questionInboxOpenRevision === state.questionInboxConsumedOpenRevision
    ) {
      store.acknowledgeQuestionInboxOpen();
      setSelectedSourceId(undefined);
      setSelectionRevision((value) => value + 1);
      setOpen(true);
    }
  }, [
    store,
    visible,
    state.questionRequests,
    state.questionInboxOpenRevision,
    state.questionInboxConsumedOpenRevision,
    open,
  ]);
  useEffect(() => {
    if (
      !visible ||
      state.questionRequests.length === 0 ||
      state.questionInboxOpenRevision === state.questionInboxConsumedOpenRevision
    ) return;
    store.acknowledgeQuestionInboxOpen();
    setSelectedSourceId(undefined);
    setSelectionRevision((value) => value + 1);
    setOpen(true);
    setFocusRevision((value) => value + 1);
  }, [
    store,
    visible,
    state.questionRequests,
    state.questionInboxOpenRevision,
    state.questionInboxConsumedOpenRevision,
  ]);
  const value = useMemo(
    () => ({
      store,
      open,
      selectedSourceId,
      selectionRevision,
      focusRevision,
      panelId,
      trigger,
      setOpen(nextOpen: boolean) {
        if (!nextOpen) {
          store.closeQuestionInbox();
          setOpen(false);
        } else {
          store.acknowledgeQuestionInboxOpen();
          setSelectedSourceId(undefined);
          setSelectionRevision((value) => value + 1);
          setFocusRevision((value) => value + 1);
          setOpen(true);
        }
      },
      openQuestion(sourceItemId?: string) {
        store.acknowledgeQuestionInboxOpen();
        setFocusRevision((value) => value + 1);
        setSelectedSourceId(sourceItemId);
        setSelectionRevision((value) => value + 1);
        setOpen(true);
      },
    }),
    [store, open, selectedSourceId, selectionRevision, focusRevision, panelId],
  );
  return (
    <QuestionInboxContext.Provider value={value}>
      {children}
    </QuestionInboxContext.Provider>
  );
}

export function QuestionInboxNotice(): React.JSX.Element | null {
  const inbox = useContext(QuestionInboxContext);
  return inbox ? (
    <QuestionNotice store={inbox.store} onOpen={() => inbox.openQuestion()} />
  ) : null;
}
function QuestionNotice({
  store,
  onOpen,
}: {
  store: ThreadClientStore;
  onOpen(): void;
}) {
  const state = useThreadStore(store);
  const count = state.questionRequests.reduce(
    (sum, request) => sum + request.questions.length,
    0,
  );
  if (!count) {
    if (state.questionStatus !== "error") return null;
    return (
      <aside
        className="thread-attention question-attention"
        data-testid="question-load-error"
      >
        <p role="alert">Questions could not be loaded. {state.questionError}</p>
        <Button
          variant="outline"
          size="xs"
          onClick={() => void store.loadQuestionRequests()}
        >
          Retry
        </Button>
      </aside>
    );
  }
  return (
    <aside
      className="thread-attention question-attention"
      data-testid="question-attention"
    >
      <p role="status">
        {count} open {count === 1 ? "question" : "questions"}
      </p>
      <Button variant="outline" size="xs" onClick={onOpen}>
        Answer
      </Button>
    </aside>
  );
}

export function QuestionInboxButton({
  variant = "tab",
}: {
  variant?: "tab" | "toolbar";
}): React.JSX.Element | null {
  const inbox = useContext(QuestionInboxContext);
  return inbox ? (
    <QuestionTrigger store={inbox.store} variant={variant} />
  ) : null;
}
function QuestionTrigger({
  store,
  variant,
}: {
  store: ThreadClientStore;
  variant: "tab" | "toolbar";
}) {
  const inbox = useContext(QuestionInboxContext)!;
  const state = useThreadStore(store);
  const count = state.questionRequests.reduce(
    (sum, request) => sum + request.questions.length,
    0,
  );
  if (!count) return null;
  return (
    <button
      ref={inbox.trigger}
      type="button"
      className={`composer-prompt-trigger composer-prompt-${variant} thread-questions-trigger`}
      aria-label={`Open questions, ${count} pending`}
      aria-expanded={inbox.open}
      aria-controls={inbox.panelId}
      data-state={inbox.open ? "open" : "closed"}
      onClick={() => inbox.setOpen(!inbox.open)}
    >
      <MessageCircleQuestion size={15} aria-hidden="true" />
      {count === 1 ? "Question" : "Questions"}
      {count > 1 && <span className="thread-questions-count">{count}</span>}
    </button>
  );
}

export function QuestionInboxPanel(): React.JSX.Element | null {
  const inbox = useContext(QuestionInboxContext);
  return inbox ? <QuestionPanel store={inbox.store} /> : null;
}
function QuestionPanel({ store }: { store: ThreadClientStore }) {
  const inbox = useContext(QuestionInboxContext)!;
  const state = useThreadStore(store);
  const requests = state.questionRequests;
  const questionCount = requests.reduce((total, request) => total + request.questions.length, 0);
  const [selectedId, setSelectedId] = useState<string>();
  const previousIndex = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const composerRoot = useRef<Element | null>(null);
  const focusWasInPanel = useRef(false);
  const index = Math.max(
    0,
    requests.findIndex((request) => request.id === selectedId),
  );
  const request = requests[index];
  useEffect(() => {
    const requested = inbox.selectedSourceId === undefined
      ? requests[0]
      : requests.find((item) => item.sourceItemId === inbox.selectedSourceId);
    if (requested) setSelectedId(requested.id);
  }, [inbox.selectedSourceId, inbox.selectionRevision, inbox.open]);
  useEffect(() => {
    if (!requests.some((item) => item.id === selectedId))
      setSelectedId(
        requests[Math.min(previousIndex.current, requests.length - 1)]?.id,
      );
    else previousIndex.current = index;
  }, [requests, selectedId, index]);
  useEffect(() => {
    if (inbox.open && inbox.focusRevision > 0) panel.current?.focus();
  }, [inbox.focusRevision]);
  useEffect(() => {
    if (!focusWasInPanel.current) return;
    if (request && inbox.open) panel.current?.focus();
    else if (!request) {
      composerRoot.current
        ?.querySelector<HTMLTextAreaElement>(".composer textarea")
        ?.focus();
      focusWasInPanel.current = false;
    }
  }, [request?.id, request?.revision]);
  const close = () => {
    inbox.setOpen(false);
    inbox.trigger.current?.focus();
  };
  if (!inbox.open || !request) return null;
  const disabled = !state.authoritative || state.connection !== "connected";
  return (
    <section
      ref={(element) => {
        panel.current = element;
        if (element) composerRoot.current = element.closest(".composer-wrap");
      }}
      onFocusCapture={() => {
        focusWasInPanel.current = true;
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          focusWasInPanel.current = false;
      }}
      tabIndex={-1}
      id={inbox.panelId}
      className="question-inbox-panel"
      aria-label="Open questions"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="question-inbox-navigation">
        <strong>{questionCount === 1 ? "Question" : "Questions"}</strong>
        {requests.length > 1 && <nav aria-label="Question requests">
          <Button
            variant="ghost"
            size="xs"
            aria-label="Previous question request"
            disabled={index === 0}
            onClick={() => setSelectedId(requests[index - 1]!.id)}
          >
            <ChevronLeft size={16} />
          </Button>
          <span aria-live="polite">
            {index + 1} of {requests.length}
          </span>
          <Button
            variant="ghost"
            size="xs"
            aria-label="Next question request"
            disabled={index === requests.length - 1}
            onClick={() => setSelectedId(requests[index + 1]!.id)}
          >
            <ChevronRight size={16} />
          </Button>
        </nav>}
        <Button
          variant="ghost"
          size="xs"
          aria-label="Close questions"
          onClick={close}
        >
          <X size={16} />
        </Button>
      </header>
      {disabled && <p role="status">Reconnect to send or dismiss questions.</p>}
      {state.questionError && (
        <p role="alert">
          {state.questionError}{" "}
          <button onClick={() => void store.loadQuestionRequests()}>
            Try again
          </button>
        </p>
      )}
      <QuestionCard
        key={request.id}
        request={request}
        store={store}
        answers={state.questionDrafts[request.id] ?? []}
        disabled={disabled || state.pendingQuestionIds.includes(request.id)}
        pending={state.pendingQuestionIds.includes(request.id)}
      />
    </section>
  );
}

function QuestionCard({
  request,
  answers,
  store,
  disabled,
  pending,
}: {
  request: QuestionRequest;
  answers: readonly string[];
  store: ThreadClientStore;
  disabled: boolean;
  pending: boolean;
}) {
  const id = useId();
  const [custom, setCustom] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string>();
  const act = async (answer?: { questionIndex: number; answer: string }) => {
    if (disabled) return;
    setError(undefined);
    try {
      if (answer) await store.respondToQuestion(request, [answer]);
      else await store.dismissQuestion(request);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <div className="question-inbox-card" data-question-request-id={request.id}>
      {request.questions.map((question) => {
        const index = question.index;
        const showCustom = custom.has(index) || Boolean(answers[index]);
        return (
          <fieldset
            key={index}
            disabled={disabled}
            className="question-inbox-question"
          >
            <legend>{question.title}</legend>
            {question.options && (
              <div
                className="question-inbox-options"
                aria-label={`Suggestions for ${question.title}`}
              >
                {question.options.map((option, optionIndex) => (
                  <Button
                    key={optionIndex}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void act({ questionIndex: index, answer: option })
                    }
                  >
                    {option}
                  </Button>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-expanded={showCustom}
                  aria-controls={`${id}-${index}`}
                  onClick={() =>
                    setCustom((previous) => new Set([...previous, index]))
                  }
                >
                  Other…
                </Button>
              </div>
            )}
            {!question.options && !showCustom && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setCustom((previous) => new Set([...previous, index]))
                }
              >
                Write an answer…
              </Button>
            )}
            {showCustom && (
              <>
                <label className="sr-only" htmlFor={`${id}-${index}`}>
                  Answer: {question.title}
                </label>
                <textarea
                  id={`${id}-${index}`}
                  autoFocus={custom.has(index)}
                  rows={2}
                  placeholder="Your answer…"
                  value={answers[index] ?? ""}
                  onChange={(event) => {
                    const next = [...answers];
                    next[index] = event.currentTarget.value;
                    store.setQuestionDraft(request.id, next);
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled || !answers[index]?.trim()}
                  onClick={() =>
                    void act({
                      questionIndex: index,
                      answer: answers[index]!.trim(),
                    })
                  }
                >
                  Send reply
                </Button>
              </>
            )}
          </fieldset>
        );
      })}
      {error && (
        <p role="alert" className="question-inbox-error">
          {error}
        </p>
      )}
      <footer className="question-inbox-card-actions">
        {pending && <span role="status">Saving…</span>}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => void act()}
        >
          Dismiss
        </Button>
      </footer>
    </div>
  );
}

export function QuestionTranscriptDisclosure({
  item,
}: {
  item: AssistantMessageItem;
}): React.JSX.Element | null {
  const inbox = useContext(QuestionInboxContext);
  if (!item.nonblockingQuestions) return null;
  return inbox ? (
    <LiveQuestionTranscriptDisclosure item={item} store={inbox.store}
      onOpen={() => inbox.openQuestion(item.nonblockingQuestions!.sourceItemId)} />
  ) : <QuestionDisclosure item={item} />;
}

function LiveQuestionTranscriptDisclosure({ item, store, onOpen }: {
  item: AssistantMessageItem;
  store: ThreadClientStore;
  onOpen(): void;
}) {
  const state = useThreadStore(store);
  const sourceItemId = item.nonblockingQuestions!.sourceItemId;
  const pending = state.questionRequests.find((request) => request.sourceItemId === sourceItemId);
  return <QuestionDisclosure item={item}
    outcomes={state.questionStatuses[sourceItemId]?.questions}
    pendingIndices={pending?.questions.map((question) => question.index)}
    onOpen={onOpen} />;
}

function QuestionDisclosure({ item, outcomes, pendingIndices, onOpen }: {
  item: AssistantMessageItem;
  outcomes?: QuestionRequestStatus["questions"];
  pendingIndices?: readonly number[];
  onOpen?(): void;
}) {
  const questions = item.nonblockingQuestions!.questions;
  const states = questions.map((_, index) => {
    if (pendingIndices?.includes(index)) return "pending";
    const outcome = outcomes?.find((outcome) => outcome.index === index)?.status;
    // Only the current inbox can make a question actionable. A cached status
    // read may still say pending while an answer or dismissal is refreshing.
    return outcome === "pending" ? "unknown" : outcome ?? "unknown";
  });
  const pendingCount = states.filter((status) => status === "pending").length;
  const status = pendingCount > 0 ? "pending"
    : states.every((status) => status === "answered") ? "answered"
    : states.every((status) => status === "dismissed") ? "dismissed"
    : states.every((status) => status !== "unknown") ? "resolved" : "unknown";
  const count = pendingCount || questions.length;
  const noun = count === 1 ? "Question" : "Questions";
  const label = status === "unknown" ? noun : `${noun} ${status}`;
  const preview = questions[Math.max(0, states.indexOf("pending"))]?.title;
  return (
    <details className="agent-input-disclosure question-transcript-disclosure"
      data-question-status={status} data-testid="question-transcript-disclosure">
      <summary className="agent-input-disclosure-summary">
        <ChevronRight aria-hidden="true" className="agent-input-disclosure-chevron" size={12} />
        <MessageCircleQuestion aria-hidden="true" className="question-disclosure-icon" size={14} />
        <span className="agent-input-disclosure-label">{label}</span>
        {count > 1 && <span className="agent-input-disclosure-source question-disclosure-count">{count}</span>}
        <span className="agent-input-disclosure-preview question-disclosure-preview" title={preview}>{preview}</span>
      </summary>
      <div className="agent-input-disclosure-body">
        <ol>
          {questions.map((question, index) => (
            <li key={index}>
              {question.title}
              {states[index] !== "unknown" && <span className="question-inbox-hint"> — {states[index]}</span>}
            </li>
          ))}
        </ol>
        {pendingCount > 0 && onOpen && (
          <Button type="button" variant="outline" size="sm" onClick={onOpen}>Open questions</Button>
        )}
      </div>
    </details>
  );
}
