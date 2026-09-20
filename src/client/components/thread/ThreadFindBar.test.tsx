// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findThreadTextMatches,
  ThreadFindBar,
} from "./ThreadFindBar.js";

class TestHighlight {
  readonly ranges: readonly AbstractRange[];

  constructor(...ranges: AbstractRange[]) {
    this.ranges = ranges;
  }

  get size(): number {
    return this.ranges.length;
  }
}

const highlights = new Map<string, TestHighlight>();
let rangeTop = 20;

function FindHarness(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const scopeRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <section ref={scopeRef}>
      <button ref={triggerRef} onClick={() => setOpen((current) => !current)}>
        Find in thread
      </button>
      <input
        aria-label="Composer"
        onKeyDown={(event) => {
          if (event.key === "Escape") event.preventDefault();
        }}
      />
      <ThreadFindBar
        id="thread-find-test"
        open={open}
        visible
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        scopeRef={scopeRef}
        viewportRef={viewportRef}
        contentRef={contentRef}
      />
      <div className="message-viewport-frame">
        <div ref={viewportRef} className="message-viewport">
          <div ref={contentRef} className="message-content">
            <div className="conversation-item">
              <p>
                Thread search finds thread text, including a{" "}
                <strong>thread</strong> split across markup.
              </p>
              <p>Threading is not a whole-word thread match.</p>
              <p>Unicode α β γ query.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

beforeEach(() => {
  rangeTop = 20;
  highlights.clear();
  vi.stubGlobal("Highlight", TestHighlight);
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: vi.fn(() => ({
      top: rangeTop,
      bottom: rangeTop + 16,
      left: 0,
      right: 50,
      width: 50,
      height: 16,
      x: 0,
      y: 20,
      toJSON: () => ({}),
    })),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("findThreadTextMatches", () => {
  it("requires three Unicode non-whitespace characters", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="conversation-item">a b α β γ</div>';
    document.body.append(root);

    expect(
      findThreadTextMatches(root, "a b", {
        matchCase: false,
        wholeWord: false,
      }),
    ).toHaveLength(0);
    expect(
      findThreadTextMatches(root, "α β γ", {
        matchCase: false,
        wholeWord: false,
      }).map((range) => range.toString()),
    ).toEqual(["α β γ"]);
  });

  it("finds case-insensitive text across inline markup and honors whole words", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="conversation-item">Find <strong>thread</strong> search in Thread and threading.</div>';
    document.body.append(root);

    expect(
      findThreadTextMatches(root, "thread search", {
        matchCase: false,
        wholeWord: false,
      }).map((range) => range.toString()),
    ).toEqual(["thread search"]);
    expect(
      findThreadTextMatches(root, "thread", {
        matchCase: false,
        wholeWord: true,
      }).map((range) => range.toString()),
    ).toEqual(["thread", "Thread"]);
    expect(
      findThreadTextMatches(root, "Thread", {
        matchCase: true,
        wholeWord: true,
      }).map((range) => range.toString()),
    ).toEqual(["Thread"]);
  });

  it("does not join matches across rendered block boundaries", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="conversation-item"><p>hello</p><p>world</p><p>inline <strong>markup</strong></p></div>';
    document.body.append(root);

    expect(
      findThreadTextMatches(root, "helloworld", {
        matchCase: false,
        wholeWord: false,
      }),
    ).toHaveLength(0);
    expect(
      findThreadTextMatches(root, "inline markup", {
        matchCase: false,
        wholeWord: false,
      }).map((range) => range.toString()),
    ).toEqual(["inline markup"]);
  });

  it("excludes hidden and explicitly non-searchable transcript text", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="conversation-item">visible needle<span aria-hidden="true">hidden needle</span><span data-thread-find-exclude="true">control needle</span></div>';
    document.body.append(root);

    expect(
      findThreadTextMatches(root, "needle", {
        matchCase: false,
        wholeWord: false,
      }),
    ).toHaveLength(1);
  });
});

describe("ThreadFindBar", () => {
  it("retains a short query while clearing stale matches and navigation", async () => {
    render(<FindHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Find in thread" }));
    const search = screen.getByRole("searchbox", { name: "Find in thread" });

    fireEvent.change(search, { target: { value: "thread" } });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("1 of 5"),
    );
    fireEvent.change(search, { target: { value: " t h " } });

    expect(search).toHaveValue(" t h ");
    await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement());
    expect(screen.getByRole("button", { name: "Previous match" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    expect(highlights.has("sedes-thread-find-match")).toBe(false);
    expect(highlights.has("sedes-thread-find-current")).toBe(false);
  });

  it("opens from the toolbar and keyboard shortcut, paints matches, and wraps navigation", async () => {
    render(<FindHarness />);
    const trigger = screen.getByRole("button", { name: "Find in thread" });
    fireEvent.click(trigger);
    const search = screen.getByRole("searchbox", { name: "Find in thread" });
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: "thread" } });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("1 of 5"),
    );
    expect(highlights.get("sedes-thread-find-match")?.size).toBe(5);
    expect(highlights.get("sedes-thread-find-current")?.size).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByRole("status")).toHaveTextContent("5 of 5");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 of 5");

    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("2 of 5");
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("1 of 5");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        document.getElementById("thread-find-test"),
      ).toHaveAttribute("data-open", "false"),
    );
    expect(highlights.has("sedes-thread-find-match")).toBe(false);

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    await waitFor(() => expect(search).toHaveFocus());
    expect(search).toHaveValue("thread");
  });

  it("supports case and whole-word matching without a keyboard-hint label", async () => {
    render(<FindHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Find in thread" }));
    const search = screen.getByRole("searchbox", { name: "Find in thread" });
    fireEvent.change(search, { target: { value: "thread" } });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("1 of 5"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Match whole word" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("1 of 4"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("1 of 3"),
    );
    fireEvent.change(search, { target: { value: "missing result" } });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("0 of 0"),
    );
    expect(screen.queryByText(/Enter next|Shift Enter|Esc close/iu)).toBeNull();
  });

  it("jumps to distant matches, animates nearby navigation, and does not scroll on passive transcript mutations", async () => {
    render(<FindHarness />);
    const viewport = document.querySelector<HTMLElement>(".message-viewport");
    expect(viewport).not.toBeNull();
    Object.defineProperties(viewport!, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    rangeTop = 900;

    fireEvent.click(screen.getByRole("button", { name: "Find in thread" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Find in thread" }),
      { target: { value: "thread" } },
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("1 of 5"),
    );
    expect(viewport!.scrollTo).toHaveBeenLastCalledWith({
      top: 858,
      behavior: "auto",
    });

    rangeTop = 120;
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(viewport!.scrollTo).toHaveBeenLastCalledWith({
      top: 78,
      behavior: "smooth",
    });
    const scrollCallCount = vi.mocked(viewport!.scrollTo).mock.calls.length;

    document
      .querySelector(".message-content .conversation-item p")
      ?.append(" thread");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("2 of 6"),
    );
    expect(viewport!.scrollTo).toHaveBeenCalledTimes(scrollCallCount);
  });

  it("leaves find open when a focused control consumes Escape", async () => {
    render(<FindHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Find in thread" }));
    const search = screen.getByRole("searchbox", { name: "Find in thread" });
    const composer = screen.getByRole("textbox", { name: "Composer" });

    composer.focus();
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(document.getElementById("thread-find-test")).toHaveAttribute(
      "data-open",
      "true",
    );

    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() =>
      expect(document.getElementById("thread-find-test")).toHaveAttribute(
        "data-open",
        "false",
      ),
    );
  });
});
