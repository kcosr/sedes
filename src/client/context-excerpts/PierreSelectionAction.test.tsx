// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerDraftCoordinator, type ContextExcerptStagingSnapshot } from "./coordinator.js";
import { PierreSelectionAction } from "./PierreSelectionAction.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PierreSelectionAction", () => {
  it("offers explicit ordered stage and immediate-send actions in note mode", () => {
    const onStage = vi
      .fn()
      .mockReturnValueOnce({
        ok: false,
        reason: "Wait for attachment uploads to finish before sending.",
      })
      .mockReturnValue({ ok: true });
    render(
      <PierreSelectionAction
        copyText="selected"
        label="selected text"
        onCancel={vi.fn()}
        onStage={onStage}
        stageWithNoteLabel="Add note"
      />,
    );

    const toolbar = screen.getByRole("toolbar");
    const initialButtons = within(toolbar).getAllByRole("button");
    expect(initialButtons.map((button) => button.textContent)).toEqual([
      "Add note…",
      "Add to message",
      "Copy",
      "Cancel",
    ]);
    expect(initialButtons[0]).toHaveAttribute("data-variant", "default");
    expect(initialButtons[1]).toHaveAttribute("data-variant", "outline");

    fireEvent.click(initialButtons[0]!);
    expect(screen.queryByRole("checkbox")).toBeNull();
    const noteButtons = within(toolbar).getAllByRole("button");
    expect(noteButtons.map((button) => button.textContent)).toEqual([
      "Add note",
      "Add note & send",
      "Copy",
      "Cancel",
    ]);
    expect(noteButtons[0]).toHaveAttribute("data-variant", "default");
    expect(noteButtons[1]).toHaveAttribute("data-variant", "outline");
    expect(noteButtons[1]).toHaveAccessibleDescription("Includes this selection, note, and any existing composer content.");
    expect(
      noteButtons[0]?.querySelector(".lucide-message-square-text"),
    ).not.toBeNull();
    expect(noteButtons[1]?.querySelector(".lucide-send")).not.toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Note for agent" }), {
      target: { value: "Please explain this." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note & send" }));

    expect(onStage).toHaveBeenCalledWith("Please explain this.", true);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Wait for attachment uploads to finish before sending.",
    );
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
  });

  it("updates the send label while the note stays open and describes the combined draft", () => {
    const target = new ComposerDraftCoordinator("thread-1");
    let status: ContextExcerptStagingSnapshot = { available: true, deliveryMode: "submit" };
    target.registerConsumer({
      getSnapshot: () => status,
      stage: () => ({ ok: true }),
      attachAndSubmit: () => ({ ok: true }),
      stageTaskReference: () => ({ ok: true }),
    });
    const onStage = vi.fn();
    render(<PierreSelectionAction label="selected text" stagingTarget={target} onCancel={vi.fn()} onStage={onStage} />);
    fireEvent.click(screen.getByRole("button", { name: "Add note…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note for agent" }), { target: { value: "Keep this note" } });
    for (const mode of ["submit", "steer", "queue"] as const) {
      act(() => {
        status = { available: true, deliveryMode: mode };
        target.notify();
      });
      const button = screen.getByRole("button", { name: `Add note & ${mode === "submit" ? "send" : mode}` });
      expect(button).toHaveAccessibleDescription("Includes this selection, note, and any existing composer content.");
      expect(screen.getByRole("textbox", { name: "Note for agent" })).toHaveValue("Keep this note");
      fireEvent.click(button);
      expect(onStage).toHaveBeenLastCalledWith("Keep this note", true);
    }
  });

  it("portals into the nearest dialog and flips and clamps at viewport edges", async () => {
    Object.defineProperties(document.documentElement, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("pierre-selection-action")) {
          return rect({ left: 0, top: 0, width: 240, height: 100 });
        }
        if (this.dataset.slot === "dialog-content") {
          return rect({ left: 100, top: 50, width: 600, height: 500 });
        }
        return rect({ left: 0, top: 0, width: 0, height: 0 });
      },
    );

    render(
      <div data-slot="dialog-content">
        <div>
          <PierreSelectionAction
            anchor={{ left: 780, right: 800, top: 560, bottom: 580 }}
            copyText="selected"
            label="selected lines"
            onCancel={vi.fn()}
            onStage={vi.fn()}
          />
        </div>
      </div>,
    );

    const toolbar = screen.getByRole("toolbar");
    const dialog = document.querySelector<HTMLElement>(
      '[data-slot="dialog-content"]',
    )!;
    await waitFor(() => expect(toolbar.parentElement).toBe(dialog));
    // Global clamped position is 548,452. A dialog-local absolute position
    // accounts for the portal offset without mixing it with viewport-fixed
    // coordinates.
    expect(toolbar).toHaveStyle({
      left: "448px",
      position: "absolute",
      top: "402px",
    });
  });

  it("keeps the selected-line edge anchored while the note card expands", async () => {
    Object.defineProperties(document.documentElement, {
      clientWidth: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 700 },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("pierre-selection-action")) {
          return rect({
            left: 0,
            top: 0,
            width: 360,
            height: this.querySelector("textarea") ? 260 : 100,
          });
        }
        if (this.hasAttribute("data-selected-line")) {
          return rect({ left: 240, top: 400, width: 420, height: 24 });
        }
        return rect({ left: 0, top: 0, width: 900, height: 700 });
      },
    );

    render(
      <div aria-label="selection owner">
        <span data-selected-line="single">Selected line</span>
        <PierreSelectionAction
          copyText="selected"
          label="diff line 42"
          onCancel={vi.fn()}
          onStage={vi.fn()}
        />
      </div>,
    );

    const toolbar = screen.getByRole("toolbar");
    await waitFor(() =>
      expect(toolbar).toHaveStyle({ position: "fixed", top: "292px" }),
    );
    const collapsedBottom =
      Number.parseFloat(toolbar.style.top) +
      toolbar.getBoundingClientRect().height;
    fireEvent.click(screen.getByRole("button", { name: "Add note…" }));
    await waitFor(() => expect(toolbar).toHaveStyle({ top: "132px" }));
    // Both layouts retain the same lower edge eight pixels above the line.
    const expandedBottom =
      Number.parseFloat(toolbar.style.top) +
      toolbar.getBoundingClientRect().height;
    expect(expandedBottom).toBe(collapsedBottom);
  });

  it("copies without staging and reports a persistent failure", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onStage = vi.fn();
    const onCopySuccess = vi.fn();
    render(
      <PierreSelectionAction
        copyText="exact selected text"
        label="selected text"
        onCancel={vi.fn()}
        onCopySuccess={onCopySuccess}
        onStage={onStage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Copy failed. The selection is still available.",
    );
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("exact selected text");
    expect(onStage).not.toHaveBeenCalled();
    expect(onCopySuccess).not.toHaveBeenCalled();
  });

  it("dismisses after a successful copy and exposes an announcement hook", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    function CopyHarness(): React.JSX.Element {
      const [visible, setVisible] = useState(true);
      const [status, setStatus] = useState("");
      return (
        <>
          <span aria-live="polite" role="status">
            {status}
          </span>
          {visible && (
            <PierreSelectionAction
              copyText="copy me"
              label="selected text"
              onCancel={() => setVisible(false)}
              onCopySuccess={() => {
                setVisible(false);
                setStatus("Copied selected text.");
              }}
              onStage={vi.fn()}
            />
          )}
        </>
      );
    }

    render(<CopyHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Copied selected text.");
  });

  it("restores focus and lets document Escape leave note mode before dismissing", async () => {
    const underlyingEscape = vi.fn();
    document.addEventListener("keydown", underlyingEscape);
    function FocusHarness(): React.JSX.Element {
      const [visible, setVisible] = useState(true);
      return (
        <div aria-label="selection owner" tabIndex={-1}>
          {visible && (
            <PierreSelectionAction
              copyText="selected"
              label="selected text"
              onCancel={() => setVisible(false)}
              onStage={vi.fn()}
            />
          )}
        </div>
      );
    }

    render(<FocusHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Add note…" }));
    const textarea = screen.getByRole("textbox", { name: "Note for agent" });
    expect(textarea).toHaveFocus();
    // Android Back emits Escape on document instead of a focused descendant.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add note…" })).toHaveFocus(),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByLabelText("selection owner")).toHaveFocus(),
    );
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(underlyingEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", underlyingEscape);
  });
});

function rect({
  left,
  top,
  width,
  height,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => undefined,
  } as DOMRect;
}
