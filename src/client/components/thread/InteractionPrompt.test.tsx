// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendInteraction } from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { InteractionPrompt } from "./InteractionPrompt.js";

afterEach(cleanup);

describe("InteractionPrompt", () => {
  it("shows generic readonly invocation parameters separately from the JSON response", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const request: BackendInteraction = {
      id: "mcp-approval",
      threadId: "thread-1",
      sourceLabel: { text: "Agent" },
      title: { text: "Allow search?" },
      openedAt: "2026-09-19T14:00:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
      kind: "editor",
      initialValue: { text: "{}" },
      language: "json",
      invocation: {
        arguments: {
          kind: "object",
          entries: [
            { key: { text: "query" }, value: { text: "Llama" } },
            {
              key: { text: "api_key" },
              value: { kind: "redacted", reason: "sensitive_key" },
            },
          ],
        },
      },
    };
    const { rerender } = render(
      <InteractionPrompt
        request={request}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    const parameters = screen.getByRole("region", {
      name: "Invocation parameters",
    });
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-has-invocation",
      "true",
    );
    expect(within(parameters).getByText("Llama")).toBeInTheDocument();
    expect(
      within(parameters).getByText("Sensitive value redacted"),
    ).toBeInTheDocument();
    expect(within(parameters).queryByRole("textbox")).toBeNull();
    const editor = screen.getByRole("textbox", { name: "Allow search?" });
    expect(editor).toHaveValue("{}");
    fireEvent.change(editor, { target: { value: '{"answer":true}' } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledExactlyOnceWith("mcp-approval", {
        kind: "editor",
        value: '{"answer":true}',
      }),
    );
    const { invocation: _invocation, ...withoutInvocation } = request;
    rerender(
      <InteractionPrompt
        request={{ ...withoutInvocation, id: "next" }}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "Invocation parameters" }),
    ).toBeNull();
    expect(screen.getByRole("dialog")).not.toHaveAttribute(
      "data-has-invocation",
    );
  });

  it("focuses the first rejection exactly once and has no approval shortcut without a primary action", async () => {
    const request = decisionRequest();
    if (request.kind !== "decision")
      throw new Error("decision fixture expected");
    const respond = vi.fn().mockResolvedValue(undefined);
    render(
      <InteractionPrompt
        request={{
          ...request,
          actions: [
            { id: "deny", label: { text: "Deny" }, role: "reject" },
            {
              id: "allow-once",
              label: { text: "Allow once" },
              role: "alternative",
            },
          ],
        }}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Deny" })).toHaveLength(1);
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus(),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Deny" }).parentElement!,
      { key: "Enter" },
    );
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(respond).toHaveBeenCalledExactlyOnceWith("decision-one", {
      kind: "decision",
      selectedActionId: "allow-once",
    });
  });

  it("uses a thread-scoped non-modal interaction panel", () => {
    renderPrompt(choiceRequest("approval-one", ["Approve once", "Deny"]));

    const prompt = screen.getByRole("dialog", { name: "Approval required" });
    expect(prompt).toHaveAttribute("data-testid", "interaction-prompt");
    expect(
      prompt.closest('[data-testid="interaction-prompt-container"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-testid="dialog-overlay"]')).toBeNull();
    expect(prompt).not.toHaveAttribute("aria-modal");
    expect(document.querySelector(".interaction-takeover-scrim")).toBeNull();
    expect(screen.queryByText("Codex")).toBeNull();
    const group = screen.getByRole("radiogroup", {
      name: "Approval required",
    });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    // Styled radio-group primitives, not native inputs.
    expect(group.querySelector("input")).toBeNull();
    expect(radios[0]).toHaveAttribute("aria-checked", "false");
  });

  it("keeps all 64 choices and the final action in the mobile prompt contract", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 844,
    });
    const labels = Array.from(
      { length: 64 },
      (_, index) => `Choice ${index + 1}`,
    );
    renderPrompt(choiceRequest("approval-large", labels));

    expect(
      screen.getByRole("radio", { name: "Choice 64" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByTestId("interaction-prompt")
        .querySelector(".interaction-prompt-options"),
    ).toHaveClass("interaction-prompt-options");
  });

  it("does not retain a choice when the active interaction changes", () => {
    const store = {
      respond: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadClientStore;
    const first = choiceRequest("approval-one", ["Approve once", "Deny"]);
    const second = choiceRequest("approval-two", ["Grant for turn", "Deny"]);
    const { rerender } = render(
      <InteractionPrompt key={first.id} request={first} store={store} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Approve once" }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();

    rerender(
      <InteractionPrompt key={second.id} request={second} store={store} />,
    );

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: "Grant for turn" }),
    ).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Deny" })).not.toBeChecked();
  });

  it("renders choice detail beneath the fixed title without heading semantics", () => {
    renderPrompt(
      choiceRequest("approval-detail", ["Approve once", "Deny"], {
        title: "Pi tool approval",
        message: "bash: npm test\ncwd: /workspace",
      }),
    );
    const heading = screen.getByRole("heading", { name: "Pi tool approval" });
    expect(heading.tagName).toBe("H2");
    expect(heading).toHaveTextContent("Pi tool approval");
    expect(heading).not.toHaveTextContent("npm test");
    // Explanatory copy stays prose rather than looking like a command block.
    const detail = screen.getByTestId("interaction-prompt-message");
    expect(detail.tagName).toBe("P");
    expect(detail).toHaveTextContent("bash: npm test");
    expect(detail).toHaveTextContent("cwd: /workspace");
    expect(screen.queryByRole("heading", { name: /npm test/ })).toBeNull();
  });

  it("renders only structured command content in the code inset", () => {
    const request = decisionRequest();
    if (request.kind !== "decision") {
      throw new Error("decision fixture expected");
    }
    renderPrompt({
      ...request,
      message: { text: "The command needs permission to modify files." },
      code: { text: "npm test\n- old line\n+ new line" },
    });
    expect(screen.getByTestId("interaction-prompt-message").tagName).toBe("P");
    const detail = screen.getByTestId("interaction-prompt-code");
    const added = detail.querySelector("tr.diff-add");
    const removed = detail.querySelector("tr.diff-del");
    expect(added?.querySelector(".diff-sg")).toHaveTextContent("+");
    expect(added?.querySelector(".diff-text")?.textContent).toBe(" new line");
    expect(removed?.querySelector(".diff-sg")).toHaveTextContent("−");
    expect(removed?.querySelector(".diff-text")?.textContent).toBe(" old line");
  });

  it("omits empty confirmation body text while retaining approval actions", () => {
    render(
      <InteractionPrompt
        request={{
          id: "empty-confirmation",
          threadId: "thread-one",
          sourceLabel: { text: "Codex" },
          openedAt: "2026-09-19T16:00:00.000Z",
          secret: false,
          destructive: false,
          cancellable: true,
          kind: "confirmation",
          title: { text: "Allow this tool?" },
          message: { text: "" },
          confirmLabel: { text: "Allow" },
          cancelLabel: { text: "Cancel" },
        }}
        store={responseStore()}
      />,
    );
    expect(screen.queryByTestId("interaction-prompt-message")).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("honors confirmation cancel labels instead of hardcoding Cancel", () => {
    render(
      <InteractionPrompt
        key="confirm-one"
        request={{
          id: "confirm-one",
          threadId: "thread-one",
          sourceLabel: { text: "Codex" },
          openedAt: "2026-07-31T20:00:00.000Z",
          secret: false,
          destructive: true,
          cancellable: true,
          kind: "confirmation",
          title: { text: "Apply change?" },
          message: { text: "This will write files." },
          confirmLabel: { text: "Apply" },
          cancelLabel: { text: "Decline" },
        }}
        store={responseStore()}
      />,
    );
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("masks secret text and multiline responses without browser assistance", () => {
    const secretText = secretRequest("secret-text", "text_input");
    const { rerender } = render(
      <InteractionPrompt
        key={secretText.id}
        request={secretText}
        store={responseStore()}
      />,
    );

    const password = document.querySelector("input[type=password]");
    if (!(password instanceof HTMLInputElement)) {
      throw new Error("secret password input expected");
    }
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "off");
    expect(password).toHaveAttribute("spellcheck", "false");

    const secretEditor = secretRequest("secret-editor", "editor");
    rerender(
      <InteractionPrompt
        key={secretEditor.id}
        request={secretEditor}
        store={responseStore()}
      />,
    );
    const editor = document.querySelector("textarea");
    if (!(editor instanceof HTMLTextAreaElement)) {
      throw new Error("secret editor textarea expected");
    }
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor).toHaveAttribute("data-masked", "true");
    expect(editor).toHaveAttribute("autocomplete", "off");
    expect(editor).toHaveAttribute("spellcheck", "false");
    const reveal = screen.getByRole("button", { name: "Show response" });
    expect(reveal).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(reveal);
    expect(editor).toHaveAttribute("data-masked", "false");
    const hide = screen.getByRole("button", { name: "Hide response" });
    expect(hide).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(hide);
    expect(editor).toHaveAttribute("data-masked", "true");
  });

  // The response field carries no visible label of its own; the card title is
  // the request, so it names the field too.
  it("names the response field after the request title", () => {
    const base = {
      threadId: "thread-one",
      sourceLabel: { text: "Codex" },
      openedAt: "2026-07-31T20:00:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
      title: { text: "Name this branch" },
      initialValue: { text: "" },
    };
    const single = {
      ...base,
      id: "value-one",
      kind: "text_input",
      multiline: false,
    } as BackendInteraction;
    const { rerender } = render(
      <InteractionPrompt
        key={single.id}
        request={single}
        store={responseStore()}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Name this branch" }).tagName,
    ).toBe("INPUT");

    const editor = {
      ...base,
      id: "value-two",
      kind: "editor",
    } as BackendInteraction;
    rerender(
      <InteractionPrompt
        key={editor.id}
        request={editor}
        store={responseStore()}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Name this branch" }).tagName,
    ).toBe("TEXTAREA");
  });

  it("submits semantic decision actions in one click and exposes alternatives", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    render(
      <InteractionPrompt
        request={decisionRequest()}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );

    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("decision-primary-menu"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Allow for this session/ }),
    );
    expect(respond).toHaveBeenCalledWith("decision-one", {
      kind: "decision",
      selectedActionId: "allow-session",
    });
  });

  it("bounds long approval alternatives while preserving their full text", async () => {
    const request = decisionRequest();
    if (request.kind !== "decision") {
      throw new Error("decision fixture expected");
    }
    const longLabel =
      "Always allow commands matching the complete reviewed executable prefix";
    const longDescription =
      'Remember commands matching: "npm" "run" "an-intentionally-long-command-name" "--with-a-long-reviewed-argument"';
    render(
      <InteractionPrompt
        request={{
          ...request,
          actions: request.actions.map((action) =>
            action.id === "allow-session"
              ? {
                  ...action,
                  label: { text: longLabel },
                  description: { text: longDescription },
                }
              : action,
          ),
        }}
        store={
          {
            respond: vi.fn().mockResolvedValue(undefined),
          } as unknown as ThreadClientStore
        }
      />,
    );

    fireEvent.pointerDown(screen.getByTestId("decision-primary-menu"), {
      button: 0,
      ctrlKey: false,
    });
    const item = await screen.findByRole("menuitem", {
      name: new RegExp(longLabel),
    });
    expect(item.closest('[data-slot="dropdown-menu-content"]')).toHaveClass(
      "interaction-action-menu",
    );
    expect(within(item).getByText(longLabel)).toHaveAttribute(
      "title",
      longLabel,
    );
    expect(within(item).getByText(longDescription)).toHaveAttribute(
      "title",
      longDescription,
    );
  });

  it("uses Enter for a real primary and Escape for the sole reject", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <InteractionPrompt
        request={decisionRequest()}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    fireEvent.keyDown(document.querySelector(".interaction-decision")!, {
      key: "Enter",
    });
    expect(respond).toHaveBeenLastCalledWith("decision-one", {
      kind: "decision",
      selectedActionId: "allow-once",
    });

    respond.mockClear();
    rerender(
      <InteractionPrompt
        request={{ ...decisionRequest(), id: "decision-two" }}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    fireEvent.keyDown(document.querySelector(".interaction-decision")!, {
      key: "Escape",
    });
    expect(respond).toHaveBeenLastCalledWith("decision-two", {
      kind: "decision",
      selectedActionId: "deny",
    });
  });

  it("rejects response shortcuts while unavailable, including the choice navigator", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <InteractionPrompt
        request={decisionRequest()}
        store={{ respond } as unknown as ThreadClientStore}
        unavailable
      />,
    );
    fireEvent.keyDown(document.querySelector(".interaction-decision")!, {
      key: "Enter",
    });
    fireEvent.click(screen.getByTestId("decision-primary-action"));
    expect(respond).not.toHaveBeenCalled();

    unmount();
    const questionnaire = questionnaireRequest();
    if (questionnaire.kind !== "questionnaire") {
      throw new Error("questionnaire fixture expected");
    }
    render(
      <InteractionPrompt
        request={{
          ...questionnaire,
          questions: [questionnaire.questions[0]!],
        }}
        store={{ respond } as unknown as ThreadClientStore}
        unavailable
      />,
    );
    const navigator = screen.getByTestId("questionnaire-options");
    fireEvent.keyDown(navigator, { key: "1" });
    fireEvent.keyDown(navigator, { key: "Enter" });
    expect(respond).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /Staging/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("blocks repeated response keys before native buttons can activate", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    render(
      <InteractionPrompt
        request={decisionRequest()}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    const primary = screen.getByTestId("decision-primary-action");
    expect(fireEvent.keyDown(primary, { key: "Enter", repeat: true })).toBe(
      false,
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it("preserves repeated typing keys inside text-entry controls", () => {
    render(
      <InteractionPrompt
        request={secretQuestionnaireRequest(true)}
        store={responseStore()}
      />,
    );
    const response = screen.getByLabelText("Enter the token");
    expect(fireEvent.keyDown(response, { key: " ", repeat: true })).toBe(true);
    expect(fireEvent.keyDown(response, { key: "1", repeat: true })).toBe(true);
    expect(fireEvent.keyDown(response, { key: "Enter", repeat: true })).toBe(
      true,
    );
  });

  it("preserves questionnaire drafts across questions and submits every answer", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    render(
      <InteractionPrompt
        request={questionnaireRequest()}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /Staging/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name the branch" }), {
      target: { value: "feature/takeover" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByRole("radio", { name: /Staging/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(
      screen.getByRole("textbox", { name: "Name the branch" }),
    ).toHaveValue("feature/takeover");
    fireEvent.click(screen.getByRole("button", { name: /Submit answers/ }));

    expect(respond).toHaveBeenCalledWith("questions-one", {
      kind: "questionnaire",
      answers: [
        {
          questionId: "environment",
          answer: {
            kind: "single_choice",
            selectedOptionId: "staging",
          },
        },
        {
          questionId: "branch",
          answer: { kind: "text", value: "feature/takeover" },
        },
      ],
    });
  });

  it("retains questionnaire progress while its Chat panel is hidden", () => {
    const request = questionnaireRequest();
    const store = responseStore();
    const { rerender } = render(
      <InteractionPrompt request={request} store={store} visible />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /Staging/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name the branch" }), {
      target: { value: "feature/retained-questionnaire" },
    });

    rerender(
      <InteractionPrompt request={request} store={store} visible={false} />,
    );
    expect(
      screen.getByRole("textbox", { name: "Name the branch" }),
    ).toHaveValue("feature/retained-questionnaire");

    rerender(<InteractionPrompt request={request} store={store} visible />);
    expect(
      screen.getByRole("textbox", { name: "Name the branch" }),
    ).toHaveValue("feature/retained-questionnaire");
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByRole("radio", { name: /Staging/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("reveals Other notes and confirms an intentionally unanswered submission", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    render(
      <InteractionPrompt
        request={questionnaireRequest()}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /None of the above/ }));
    fireEvent.change(screen.getByTestId("questionnaire-note"), {
      target: { value: "Use the local sandbox" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: /Submit answers/ }));
    expect(
      screen.getByRole("alertdialog", { name: "Submit unanswered questions?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    expect(respond).toHaveBeenCalledWith("questions-one", {
      kind: "questionnaire",
      answers: [
        {
          questionId: "environment",
          answer: {
            kind: "single_choice",
            selectedOptionId: "other",
            note: "Use the local sandbox",
          },
        },
        { questionId: "branch", answer: { kind: "unanswered" } },
      ],
    });
  });

  it("preserves earlier choices when Other is replaced by a predefined option", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    render(
      <InteractionPrompt
        request={threeChoiceQuestionnaireRequest()}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /Staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("radio", { name: /Production/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("radio", { name: /None of the above/ }));
    fireEvent.change(screen.getByTestId("questionnaire-note"), {
      target: { value: "Use another environment" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Production/ }));

    expect(screen.queryByTestId("questionnaire-note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(respond).toHaveBeenCalledWith("three-choices", {
      kind: "questionnaire",
      answers: [
        {
          questionId: "first",
          answer: {
            kind: "single_choice",
            selectedOptionId: "first-staging",
          },
        },
        {
          questionId: "second",
          answer: {
            kind: "single_choice",
            selectedOptionId: "second-production",
          },
        },
        {
          questionId: "third",
          answer: {
            kind: "single_choice",
            selectedOptionId: "third-production",
          },
        },
      ],
    });
  });

  it("keeps an explicitly added note when switching predefined options", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const request = threeChoiceQuestionnaireRequest();
    if (request.kind !== "questionnaire") {
      throw new Error("questionnaire fixture expected");
    }
    render(
      <InteractionPrompt
        request={{ ...request, questions: [request.questions[0]!] }}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /Staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    fireEvent.change(screen.getByTestId("questionnaire-note"), {
      target: { value: "Keep this note" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Production/ }));

    expect(screen.getByTestId("questionnaire-note")).toHaveValue(
      "Keep this note",
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(respond).toHaveBeenCalledWith("three-choices", {
      kind: "questionnaire",
      answers: [
        {
          questionId: "first",
          answer: {
            kind: "single_choice",
            selectedOptionId: "first-production",
            note: "Keep this note",
          },
        },
      ],
    });
  });

  it("keeps a secret multiline questionnaire multiline and masks it", () => {
    const request = secretQuestionnaireRequest(true);
    const store = responseStore();
    const { rerender } = render(
      <InteractionPrompt request={request} store={store} queueLength={3} />,
    );
    expect(screen.getByLabelText("Interaction 1 of 3")).toBeInTheDocument();
    const response = screen.getByLabelText("Enter the token");
    expect(response.tagName).toBe("TEXTAREA");
    expect(response).toHaveAttribute("data-masked", "true");
    expect(response).toHaveClass("interaction-secret-input");
    expect(response).toHaveAttribute("autocomplete", "new-password");
    fireEvent.click(screen.getByRole("button", { name: "Show response" }));
    expect(response.tagName).toBe("TEXTAREA");
    expect(response).toHaveAttribute("data-masked", "false");
    expect(response).not.toHaveClass("interaction-secret-input");
    rerender(
      <InteractionPrompt
        request={request}
        store={store}
        queueLength={3}
        externallyPending
      />,
    );
    expect(screen.getByTestId("interaction-pending")).toHaveTextContent(
      "Sending response…",
    );
    expect(
      screen.getByRole("button", { name: /Submit answers/ }),
    ).toBeDisabled();
  });

  it("uses a native password control for a secret choice note", () => {
    const questionnaire = questionnaireRequest();
    if (questionnaire.kind !== "questionnaire") {
      throw new Error("questionnaire fixture expected");
    }
    const secretChoice = {
      ...questionnaire,
      questions: [{ ...questionnaire.questions[0]!, secret: true }],
    };
    render(
      <InteractionPrompt request={secretChoice} store={responseStore()} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /None of the above/ }));
    const note = screen.getByTestId("questionnaire-note");
    expect(note).toHaveAttribute("type", "password");
    expect(note).toHaveAttribute("data-masked", "true");
    expect(note).toHaveAttribute("autocomplete", "new-password");
    expect(note.tagName).toBe("INPUT");
  });

  it("moves focus into the panel, allows focus to leave, and returns it after resolution", async () => {
    const outside = document.createElement("button");
    outside.textContent = "Before interaction";
    document.body.append(outside);
    outside.focus();
    const { unmount } = render(
      <InteractionPrompt
        request={decisionRequest()}
        store={responseStore()}
        returnFocusTarget={outside}
      />,
    );

    await vi.waitFor(() =>
      expect(screen.getByTestId("decision-primary-action")).toHaveFocus(),
    );
    outside.focus();
    expect(outside).toHaveFocus();

    unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("keeps questionnaire options as one tabbable composite", async () => {
    renderPrompt(questionnaireRequest());
    const navigator = screen.getByTestId("questionnaire-options");
    await vi.waitFor(() => expect(navigator).toHaveFocus());
    expect(screen.getByRole("radio", { name: /Staging/ })).not.toHaveFocus();
    expect(screen.getByRole("radio", { name: /Staging/ })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("does not treat a repeated Enter as a questionnaire selection", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const questionnaire = questionnaireRequest();
    if (questionnaire.kind !== "questionnaire") {
      throw new Error("questionnaire fixture expected");
    }
    render(
      <InteractionPrompt
        request={{ ...questionnaire, questions: [questionnaire.questions[0]!] }}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    const navigator = screen.getByTestId("questionnaire-options");
    expect(fireEvent.keyDown(navigator, { key: "Enter", repeat: true })).toBe(
      false,
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it("number-selects and submits the last choice without a stale unanswered draft", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const questionnaire = questionnaireRequest();
    if (questionnaire.kind !== "questionnaire") {
      throw new Error("questionnaire fixture expected");
    }
    const oneQuestion = {
      ...questionnaire,
      questions: [questionnaire.questions[0]!],
    };
    render(
      <InteractionPrompt
        request={oneQuestion}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("questionnaire-options"), {
      key: "1",
    });
    expect(screen.queryByTestId("questionnaire-unanswered-confirm")).toBeNull();
    expect(respond).toHaveBeenCalledWith("questions-one", {
      kind: "questionnaire",
      answers: [
        {
          questionId: "environment",
          answer: { kind: "single_choice", selectedOptionId: "staging" },
        },
      ],
    });
  });

  it("uses one tabbable choice composite and announces the highlighted option", () => {
    renderPrompt(questionnaireRequest());
    const navigator = screen.getByTestId("questionnaire-options");
    const radios = within(navigator).getAllByRole("radio");
    expect(navigator).toHaveAttribute("tabindex", "0");
    expect(
      radios.every((radio) => radio.getAttribute("tabindex") === "-1"),
    ).toBe(true);
    expect(navigator).toHaveAttribute("aria-activedescendant", radios[0]!.id);
    fireEvent.keyDown(navigator, { key: "ArrowDown" });
    expect(navigator).toHaveAttribute("aria-activedescendant", radios[1]!.id);
  });

  it("restores current-question focus after unanswered confirmation", async () => {
    const questionnaire = questionnaireRequest();
    if (questionnaire.kind !== "questionnaire") {
      throw new Error("questionnaire fixture expected");
    }
    renderPrompt({
      ...questionnaire,
      questions: [questionnaire.questions[0]!],
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit answers/ }));
    const confirm = screen.getByTestId("questionnaire-unanswered-confirm");
    const goBack = within(confirm).getByRole("button", { name: "Go back" });
    const proceed = within(confirm).getByRole("button", { name: "Proceed" });
    await vi.waitFor(() => expect(proceed).toHaveFocus());
    fireEvent.click(goBack);
    await vi.waitFor(() =>
      expect(screen.getByTestId("questionnaire-options")).toHaveFocus(),
    );
  });

  it("disables unanswered confirmation actions while a response is pending", () => {
    const questionnaire = questionnaireRequest();
    if (questionnaire.kind !== "questionnaire") {
      throw new Error("questionnaire fixture expected");
    }
    const store = responseStore();
    const request = {
      ...questionnaire,
      questions: [questionnaire.questions[0]!],
    };
    const { rerender } = render(
      <InteractionPrompt request={request} store={store} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Submit answers/ }));
    rerender(
      <InteractionPrompt request={request} store={store} externallyPending />,
    );
    expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Proceed" })).toBeDisabled();
  });

  it("ignores composed and modified text shortcuts", () => {
    const questionnaire = questionnaireRequest();
    if (questionnaire.kind !== "questionnaire") {
      throw new Error("questionnaire fixture expected");
    }
    const request = {
      ...questionnaire,
      questions: [questionnaire.questions[1]!],
    };
    const respond = vi.fn().mockResolvedValue(undefined);
    const stopActiveTurn = vi.fn().mockResolvedValue(undefined);
    render(
      <InteractionPrompt
        request={request}
        canInterrupt
        store={{ respond, stopActiveTurn } as unknown as ThreadClientStore}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Name the branch" });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", metaKey: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(respond).not.toHaveBeenCalled();
    expect(stopActiveTurn).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(stopActiveTurn).toHaveBeenCalledOnce();
  });

  it("preserves each question's option scroll position", async () => {
    renderPrompt(questionnaireRequest());
    const options = screen.getByTestId("questionnaire-options");
    options.scrollTop = 72;
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await vi.waitFor(() =>
      expect(screen.getByTestId("questionnaire-options").scrollTop).toBe(72),
    );
  });

  it("shows progress on the chosen decision action", async () => {
    let finish: () => void = () => undefined;
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const respond = vi.fn().mockReturnValue(response);
    render(
      <InteractionPrompt
        request={decisionRequest()}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    fireEvent.click(screen.getByTestId("decision-primary-action"));
    expect(await screen.findByText("Allowing…")).toBeInTheDocument();
    expect(screen.getByText("Sending response…")).toHaveAttribute(
      "role",
      "status",
    );
    finish();
    await vi.waitFor(() => {
      expect(screen.queryByText("Allowing…")).not.toBeInTheDocument();
      expect(screen.queryByText("Sending response…")).not.toBeInTheDocument();
    });
  });

  it("shows questionnaire submission progress and guards Proceed", async () => {
    let finish: () => void = () => undefined;
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const respond = vi.fn().mockReturnValue(response);
    const questionnaire = questionnaireRequest();
    if (questionnaire.kind !== "questionnaire") {
      throw new Error("questionnaire fixture expected");
    }
    render(
      <InteractionPrompt
        request={{ ...questionnaire, questions: [questionnaire.questions[0]!] }}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Submit answers/ }));
    const proceed = screen.getByRole("button", { name: "Proceed" });
    fireEvent.click(proceed);
    fireEvent.click(proceed);
    expect(respond).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("button", { name: "Submitting…" }),
    ).toBeDisabled();
    finish();
  });
});

function renderPrompt(request: BackendInteraction) {
  return render(
    <InteractionPrompt
      key={request.id}
      request={request}
      store={responseStore()}
    />,
  );
}

function responseStore(): ThreadClientStore {
  return {
    respond: vi.fn().mockResolvedValue(undefined),
  } as unknown as ThreadClientStore;
}

function choiceRequest(
  id: string,
  labels: readonly string[],
  overrides: {
    readonly title?: string;
    readonly message?: string;
  } = {},
): BackendInteraction {
  return {
    id,
    threadId: "thread-one",
    sourceLabel: { text: "Codex" },
    openedAt: "2026-07-31T20:00:00.000Z",
    secret: false,
    destructive: true,
    cancellable: false,
    kind: "choice",
    title: { text: overrides.title ?? "Approval required" },
    ...(overrides.message ? { message: { text: overrides.message } } : {}),
    options: labels.map((label, index) => ({
      id: `option-${index}`,
      label: { text: label },
    })),
    multiple: false,
  };
}

function secretRequest(
  id: string,
  kind: "text_input" | "editor",
): BackendInteraction {
  const base = {
    id,
    threadId: "thread-one",
    sourceLabel: { text: "Codex" },
    openedAt: "2026-07-31T20:00:00.000Z",
    secret: true,
    destructive: false,
    cancellable: true,
    title: { text: "Secret response" },
    initialValue: { text: "" },
  };
  return kind === "text_input"
    ? { ...base, kind, multiline: false }
    : { ...base, kind };
}

function decisionRequest(): BackendInteraction {
  return {
    id: "decision-one",
    threadId: "thread-one",
    sourceLabel: { text: "Codex" },
    openedAt: "2026-07-31T20:00:00.000Z",
    secret: false,
    destructive: true,
    cancellable: false,
    kind: "decision",
    title: { text: "Command approval" },
    message: { text: "This command needs approval." },
    code: { text: "npm test" },
    actions: [
      {
        id: "allow-once",
        label: { text: "Allow once" },
        role: "primary",
      },
      {
        id: "allow-session",
        label: { text: "Allow for this session" },
        description: { text: "Remember the reviewed command scope." },
        role: "alternative",
      },
      { id: "deny", label: { text: "Deny" }, role: "reject" },
    ],
  };
}

function questionnaireRequest(): BackendInteraction {
  return {
    id: "questions-one",
    threadId: "thread-one",
    sourceLabel: { text: "Codex" },
    openedAt: "2026-07-31T20:00:00.000Z",
    secret: false,
    destructive: false,
    cancellable: false,
    kind: "questionnaire",
    title: { text: "Questions" },
    questions: [
      {
        id: "environment",
        header: { text: "Environment" },
        prompt: { text: "Which environment should I use?" },
        secret: false,
        input: {
          kind: "single_choice",
          allowNote: true,
          options: [
            {
              id: "staging",
              label: { text: "Staging" },
              description: { text: "Uses shared staging services." },
            },
            {
              id: "production",
              label: { text: "Production" },
              description: { text: "Uses live services." },
            },
          ],
          other: {
            id: "other",
            label: { text: "None of the above" },
            description: { text: "Add details in a note." },
          },
        },
      },
      {
        id: "branch",
        header: { text: "Branch" },
        prompt: { text: "Name the branch" },
        secret: false,
        input: { kind: "text", multiline: true },
      },
    ],
  };
}

function threeChoiceQuestionnaireRequest(): BackendInteraction {
  const makeQuestion = (id: string, label: string) => ({
    id,
    header: { text: label },
    prompt: { text: `Choose ${label.toLowerCase()}` },
    secret: false,
    input: {
      kind: "single_choice" as const,
      allowNote: true,
      options: [
        {
          id: `${id}-staging`,
          label: { text: "Staging" },
          description: { text: "Use staging." },
        },
        {
          id: `${id}-production`,
          label: { text: "Production" },
          description: { text: "Use production." },
        },
      ],
      other: {
        id: `${id}-other`,
        label: { text: "None of the above" },
        description: { text: "Add details in a note." },
      },
    },
  });
  return {
    id: "three-choices",
    threadId: "thread-one",
    sourceLabel: { text: "Codex" },
    openedAt: "2026-08-07T20:00:00.000Z",
    secret: false,
    destructive: false,
    cancellable: false,
    kind: "questionnaire",
    title: { text: "Questions" },
    questions: [
      makeQuestion("first", "First"),
      makeQuestion("second", "Second"),
      makeQuestion("third", "Third"),
    ],
  };
}

function secretQuestionnaireRequest(multiline = false): BackendInteraction {
  return {
    ...questionnaireRequest(),
    id: "secret-questions",
    questions: [
      {
        id: "token",
        header: { text: "Token" },
        prompt: { text: "Enter the token" },
        secret: true,
        input: { kind: "text", multiline },
      },
    ],
  } as BackendInteraction;
}
