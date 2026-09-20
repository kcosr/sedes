// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessageItem } from "../../../shared/index.js";
import type { QuestionRequest } from "../../../shared/protocol/questions.js";
import type {
  ThreadClientState,
  ThreadClientStore,
} from "../../stores/ThreadClientStore.js";
import {
  QuestionInboxButton,
  QuestionInboxProvider,
  QuestionInboxPanel,
  QuestionInboxNotice,
  QuestionTranscriptDisclosure,
} from "./QuestionInbox.js";

afterEach(cleanup);
function request(id: string, count = 1): QuestionRequest {
  return {
    id,
    threadId: "thread",
    sourceItemId: `source-${id}`,
    revision: 1,
    createdAt: "2026-09-07T12:00:00Z",
    questions: Array.from({ length: count }, (_, index) => ({
      index,
      title: `${id} question ${index + 1}?`,
      options: ["First suggestion", "Second suggestion"],
    })),
  };
}
class FakeQuestionStore {
  listeners = new Set<() => void>();
  state = {
    questionRequests: [request("one", 2), request("two")],
    questionStatuses: {},
    questionRevision: 1,
    questionInboxOpenRevision: 0,
    questionInboxConsumedOpenRevision: 0,
    questionInboxClosedQuestionKeys: [],
    questionStatus: "ready",
    questionDrafts: {},
    pendingQuestionIds: [],
      pendingQuestionReplies: [],
    authoritative: true,
    connection: "connected",
    snapshot: {
      capabilities: { nonblockingQuestions: true },
      runState: "running",
    },
  } as unknown as ThreadClientState;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  replace(patch: Partial<ThreadClientState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  closeQuestionInbox = () => this.replace({
    questionInboxClosedQuestionKeys: this.state.questionRequests.flatMap(
      (request) => request.questions.map((question) => `${request.id}:${question.index}`),
    ),
    questionInboxConsumedOpenRevision: this.state.questionInboxOpenRevision,
  });
  acknowledgeQuestionInboxOpen = () => this.replace({
    questionInboxClosedQuestionKeys: [],
    questionInboxConsumedOpenRevision: this.state.questionInboxOpenRevision,
  });
  setQuestionDraft = (id: string, answers: readonly string[]) =>
    this.replace({
      questionDrafts: { ...this.state.questionDrafts, [id]: answers },
    });
  respondToQuestion = vi.fn(
    async (
      item: QuestionRequest,
      answers: { questionIndex: number; answer: string }[],
    ) => {
      this.replace({
        questionRequests: this.state.questionRequests.flatMap((request) => {
          if (request.id !== item.id) return [request];
          const questions = request.questions.filter(
            (question) =>
              !answers.some(
                (answer) => answer.questionIndex === question.index,
              ),
          );
          return questions.length
            ? [{ ...request, revision: request.revision + 1, questions }]
            : [];
        }),
      });
    },
  );
  dismissQuestion = vi.fn(async (item: QuestionRequest) =>
    this.replace({
      questionRequests: this.state.questionRequests.filter(
        ({ id }) => id !== item.id,
      ),
    }),
  );
  loadQuestionRequests = vi.fn(async () => {});
}
function show(store = new FakeQuestionStore(), item?: AssistantMessageItem) {
  render(
    <QuestionInboxProvider
      store={store as unknown as ThreadClientStore}
      visible
    >
      <div className="composer-wrap">
        <div className="composer">
          <textarea
            aria-label="Message composer"
            defaultValue="Unrelated draft"
          />
        </div>
        <QuestionInboxNotice />
        <QuestionInboxButton />
        <QuestionInboxPanel />
        {item && <QuestionTranscriptDisclosure item={item} />}
      </div>
    </QuestionInboxProvider>,
  );
  return store;
}
describe("QuestionInbox", () => {
  it("styles a single request from pending to answered across remounts without a count badge", () => {
    const item = {
      nonblockingQuestions: {
        sourceItemId: "source-two",
        questions: [{ title: "two question 1?", options: null }],
      },
    } as AssistantMessageItem;
    const store = show(new FakeQuestionStore(), item);
    const disclosure = screen.getByTestId("question-transcript-disclosure");
    expect(disclosure).toHaveAttribute("data-question-status", "pending");
    expect(disclosure.querySelector("summary")).toHaveTextContent("Question pending");
    expect(disclosure.querySelector(".question-disclosure-count")).toBeNull();
    expect(disclosure.querySelector(".question-disclosure-icon")).not.toBeNull();
    act(() => store.replace({
      questionRequests: [],
      questionStatuses: {
        "source-two": { sourceItemId: "source-two", questions: [{ index: 0, status: "answered" }] },
      },
    }));
    expect(disclosure).toHaveAttribute("data-question-status", "answered");
    expect(disclosure.querySelector("summary")).toHaveTextContent("Question answered");
    cleanup();
    show(store, item);
    expect(screen.getByTestId("question-transcript-disclosure")).toHaveAttribute("data-question-status", "answered");
  });

  it("previews the remaining question in a partial batch and distinguishes mixed and unknown outcomes", () => {
    const item = {
      nonblockingQuestions: {
        sourceItemId: "source-one",
        questions: request("one", 2).questions.map(({ title, options }) => ({ title, options })),
      },
    } as AssistantMessageItem;
    const store = new FakeQuestionStore();
    store.replace({
      questionRequests: [{ ...request("one", 2), questions: [request("one", 2).questions[1]!] }],
      questionStatuses: {
        "source-one": { sourceItemId: "source-one", questions: [{ index: 0, status: "answered" }, { index: 1, status: "pending" }] },
      },
    });
    show(store, item);
    const disclosure = screen.getByTestId("question-transcript-disclosure");
    expect(disclosure).toHaveAttribute("data-question-status", "pending");
    expect(disclosure.querySelector(".question-disclosure-preview")).toHaveTextContent("one question 2?");
    expect(disclosure.querySelector(".question-disclosure-count")).toBeNull();
    act(() => store.replace({ questionRequests: [] }));
    expect(disclosure).toHaveAttribute("data-question-status", "unknown");
    expect(disclosure.querySelector("summary")).not.toHaveTextContent("pending");
    expect(screen.queryByRole("button", { name: "Open questions" })).not.toBeInTheDocument();
    act(() => store.replace({
      questionRequests: [],
      questionStatuses: {
        "source-one": { sourceItemId: "source-one", questions: [{ index: 0, status: "answered" }, { index: 1, status: "dismissed" }] },
      },
    }));
    expect(disclosure).toHaveAttribute("data-question-status", "resolved");
    expect(disclosure.querySelector(".question-disclosure-count")).toHaveTextContent("2");
    act(() => store.replace({ questionStatuses: {} }));
    expect(disclosure).toHaveAttribute("data-question-status", "unknown");
    expect(disclosure.querySelector("summary")).not.toHaveTextContent(/answered|dismissed|resolved/);
  });

  it.each(["Message composer", "Another editor"])("does not steal focus from %s when questions arrive", (label) => {
    const store = new FakeQuestionStore();
    store.replace({ questionRequests: [] });
    show(store);
    if (label === "Another editor") render(<input aria-label="Another editor" />);
    const editor = screen.getByRole("textbox", { name: label });
    editor.focus();
    act(() => store.replace({ questionRequests: [request("one")] }));
    expect(screen.getByRole("region", { name: "Open questions" })).toBeVisible();
    expect(editor).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getByRole("region", { name: "Open questions" })).toHaveFocus();
  });

  it("preserves the selected request, Other editor and caret when another request arrives", () => {
    const store = show();
    fireEvent.click(screen.getByRole("button", { name: "Next question request" }));
    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    const editor = screen.getByRole("textbox", { name: "Answer: two question 1?" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Custom answer" } });
    editor.focus();
    editor.setSelectionRange(3, 7);
    act(() => store.replace({
      questionRequests: [...store.state.questionRequests, request("three")],
    }));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Answer: two question 1?" })).toBe(editor);
    expect(editor).toHaveValue("Custom answer");
    expect(editor).toHaveFocus();
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 7]);
  });

  it("expires a manual close after a new arrival even if that new request is later resolved", () => {
    const store = show();
    const originalQuestions = store.state.questionRequests;
    fireEvent.click(screen.getByRole("button", { name: "Close questions" }));
    act(() => store.replace({ questionRequests: [...originalQuestions, request("three")] }));
    expect(store.state.questionInboxClosedQuestionKeys).toEqual([]);
    act(() => store.replace({ questionRequests: originalQuestions }));
    cleanup();
    show(store);
    expect(screen.getByRole("region", { name: "Open questions" })).toBeVisible();
  });

  it("focuses a pending explicit opening when questions load after the request", () => {
    const store = new FakeQuestionStore();
    store.replace({ questionRequests: [], questionInboxOpenRevision: 1 });
    show(store);
    screen.getByRole("textbox", { name: "Message composer" }).focus();
    act(() => store.replace({ questionRequests: [request("one")] }));
    expect(screen.getByRole("region", { name: "Open questions" })).toHaveFocus();
  });

  it("retains manual closure across provider remounts until new questions or explicit opening", () => {
    const store = show();
    fireEvent.click(screen.getByRole("button", { name: "Close questions" }));
    cleanup();
    show(store);
    expect(screen.queryByRole("region", { name: "Open questions" })).toBeNull();
    act(() => store.replace({ questionInboxOpenRevision: 1 }));
    expect(screen.getByRole("region", { name: "Open questions" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Close questions" }));
    cleanup();
    show(store);
    expect(screen.queryByRole("region", { name: "Open questions" })).toBeNull();
    act(() => store.replace({ questionRequests: [...store.state.questionRequests, request("three")] }));
    expect(screen.getByRole("region", { name: "Open questions" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close questions" }));
    cleanup();
    show(new FakeQuestionStore());
    expect(screen.getByRole("region", { name: "Open questions" })).toBeVisible();
  });

  it("opens newly loaded questions and honors repeated sidebar requests", () => {
    const store = new FakeQuestionStore();
    store.replace({ questionRequests: [] });
    show(store);
    expect(screen.queryByRole("region", { name: "Open questions" })).toBeNull();
    act(() => store.replace({ questionRequests: [request("one")] }));
    expect(screen.getByRole("region", { name: "Open questions" })).toBeVisible();
    for (const questionInboxOpenRevision of [1, 2]) {
      fireEvent.click(screen.getByRole("button", { name: "Close questions" }));
      act(() => store.replace({ questionInboxOpenRevision }));
      expect(screen.getByRole("region", { name: "Open questions" })).toBeVisible();
    }
  });

  it("waits for visibility before opening questions received in a hidden panel", () => {
    const store = new FakeQuestionStore();
    store.replace({ questionRequests: [] });
    const view = (visible: boolean) => (
      <QuestionInboxProvider store={store as unknown as ThreadClientStore} visible={visible}>
        <QuestionInboxButton />
        <QuestionInboxPanel />
      </QuestionInboxProvider>
    );
    const rendered = render(view(false));
    act(() => store.replace({ questionRequests: [request("one")] }));
    expect(screen.queryByRole("region", { name: "Open questions" })).toBeNull();
    rendered.rerender(view(true));
    expect(screen.getByRole("region", { name: "Open questions" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close questions" }));
    rendered.rerender(view(false));
    rendered.rerender(view(true));
    expect(screen.queryByRole("region", { name: "Open questions" })).toBeNull();
  });

  it("follows repeated links to the same source and hides resolved transcript actions", async () => {
    const item = {
      id: "item",
      turnId: "turn",
      kind: "assistant_message",
      status: "completed",
      revision: 1,
      markdown: { text: "Questions" },
      nonblockingQuestions: {
        sourceItemId: "source-two",
        questions: [{ title: "two question 1?", options: null }],
      },
    } as AssistantMessageItem;
    const store = show(new FakeQuestionStore(), item);
    fireEvent.click(screen.getByRole("button", { name: "Open questions" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Previous question request" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open questions" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Open questions" }),
      ).toBeNull(),
    );
  });

  it("offers retry after an empty initial load fails and hides the notice after recovery", async () => {
    const store = new FakeQuestionStore();
    store.replace({
      questionRequests: [],
      questionStatus: "error",
      questionError: "Connection failed",
    });
    store.loadQuestionRequests.mockImplementationOnce(async () => {
      store.replace({ questionStatus: "ready", questionError: undefined });
    });
    show(store);
    const composer = screen.getByRole("textbox", { name: "Message composer" });
    composer.focus();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Questions could not be loaded",
    );
    expect(screen.queryByRole("button", { name: /Open questions/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Open questions" })).toBeNull();
    expect(composer).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByTestId("question-load-error")).toBeNull(),
    );
    expect(store.loadQuestionRequests).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("question-attention")).toBeNull();
    expect(composer).toHaveFocus();
  });

  it("hides all entry points without pending questions", () => {
    const store = new FakeQuestionStore();
    store.replace({ questionRequests: [] });
    show(store);
    expect(screen.queryByRole("button", { name: /Open questions/ })).toBeNull();
    expect(screen.queryByTestId("question-attention")).toBeNull();
  });
  it("shows one oldest request, without textareas or a modal, and navigates", () => {
    show();
    expect(
      screen.getByRole("region", { name: "Open questions" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Answer:/ })).toBeNull();
    expect(screen.getByText("one question 1?")).toBeInTheDocument();
    expect(screen.queryByText("two question 1?")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Next question request" }),
    );
    expect(screen.getByText("two question 1?")).toBeInTheDocument();
  });
  it("immediately sends the selected answer and preserves siblings and composer", async () => {
    const store = show();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Second suggestion" })[0]!,
    );
    await waitFor(() =>
      expect(store.respondToQuestion).toHaveBeenCalledWith(request("one", 2), [
        { questionIndex: 0, answer: "Second suggestion" },
      ]),
    );
    expect(screen.queryByText("one question 1?")).toBeNull();
    expect(screen.getByText("one question 2?")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Message composer" }),
    ).toHaveValue("Unrelated draft");
    fireEvent.click(screen.getByRole("button", { name: "First suggestion" }));
    await waitFor(() =>
      expect(screen.getByText("two question 1?")).toBeInTheDocument(),
    );
  });
  it("reveals custom input only on demand, preserves drafts through navigation and partial answers", async () => {
    const store = show();
    fireEvent.click(screen.getAllByRole("button", { name: "Other…" })[1]!);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Answer: one question 2?" }),
      { target: { value: "Keep my draft" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Next question request" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Previous question request" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Answer: one question 2?" }),
    ).toHaveValue("Keep my draft");
    fireEvent.click(
      screen.getAllByRole("button", { name: "First suggestion" })[0]!,
    );
    await waitFor(() =>
      expect(screen.queryByText("one question 1?")).toBeNull(),
    );
    expect(
      screen.getByRole("textbox", { name: "Answer: one question 2?" }),
    ).toHaveValue("Keep my draft");
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(store.respondToQuestion).toHaveBeenLastCalledWith(
        expect.objectContaining({ revision: 2 }),
        [{ questionIndex: 1, answer: "Keep my draft" }],
      ),
    );
  });
  it("dismisses silently, advances, and hides everything after the final request", async () => {
    const store = show();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.getByText("two question 1?")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Open questions" }),
      ).toBeNull(),
    );
    expect(screen.queryByTestId("question-attention")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open questions/ })).toBeNull();
    expect(store.respondToQuestion).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Message composer" }),
    ).toHaveFocus();
  });
  it("keeps failed answers editable and supports text-only questions", async () => {
    const store = new FakeQuestionStore();
    store.replace({
      questionRequests: [
        {
          ...request("one"),
          questions: [{ index: 0, title: "Details?", options: null }],
        },
      ],
    });
    store.respondToQuestion.mockRejectedValueOnce(
      new Error("Connection interrupted"),
    );
    show(store);
    expect(
      screen.queryByRole("textbox", { name: "Answer: Details?" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Write an answer…" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Answer: Details?" }),
      { target: { value: "Keep it" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection interrupted",
    );
    expect(
      screen.getByRole("textbox", { name: "Answer: Details?" }),
    ).toHaveValue("Keep it");
  });
  it("respects closing through refreshes and reopens the oldest request on a new arrival", async () => {
    const store = show();
    fireEvent.keyDown(screen.getByRole("region", { name: "Open questions" }), {
      key: "Escape",
    });
    expect(
      screen.getByRole("button", { name: /Open questions, / }),
    ).toHaveFocus();
    const composer = screen.getByRole("textbox", { name: "Message composer" });
    composer.focus();
    act(() => store.replace({ questionRequests: [...store.state.questionRequests] }));
    expect(screen.queryByRole("region", { name: "Open questions" })).toBeNull();
    expect(composer).toHaveFocus();
    act(() =>
      store.replace({
        questionRequests: [...store.state.questionRequests, request("three")],
      }),
    );
    expect(screen.getByRole("region", { name: "Open questions" })).toBeVisible();
    expect(screen.getByText("one question 1?")).toBeInTheDocument();
  });
});


describe("Question composer trigger counts", () => {
  it("hides the single count while preserving its accessible pending count", () => {
    const store = new FakeQuestionStore();
    store.replace({ questionRequests: [request("one")] });
    show(store);
    const button = screen.getByRole("button", { name: "Open questions, 1 pending" });
    expect(button).toHaveTextContent(/^Question$/);
    expect(button.querySelector(".thread-questions-count")).toBeNull();
    const panel = screen.getByRole("region", { name: "Open questions" });
    expect(panel.querySelector("header strong")).toHaveTextContent(/^Question$/);
    expect(screen.queryByRole("navigation", { name: "Question requests" })).toBeNull();
    act(() => store.replace({ questionRequests: [request("one", 2)] }));
    expect(button).toHaveAccessibleName("Open questions, 2 pending");
    expect(button).toHaveTextContent("Questions");
    expect(button.querySelector(".thread-questions-count")).toHaveTextContent("2");
  });
});
