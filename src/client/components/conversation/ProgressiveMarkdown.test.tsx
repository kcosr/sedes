// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressiveMarkdown } from "./ProgressiveMarkdown.js";
import { setDiagnosticCategoryEnabled } from "../../app/settings.js";
import { clearDiagnostics, readDiagnostics } from "../../app/diagnostics.js";

const parserRender = vi.hoisted(() => vi.fn());
const highlightCode = vi.hoisted(() => vi.fn(async (source: string) =>
  source.split("\n").map((content) => [{ content, style: { color: "red" } }]),
));
vi.mock("./markdown-code-highlighting.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./markdown-code-highlighting.js")>(),
  cachedMarkdownHighlight: () => undefined,
  highlightMarkdownCode: highlightCode,
}));
vi.mock("react-markdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-markdown")>();
  return {
    ...original,
    default: (props: React.ComponentProps<typeof original.default>) => {
      parserRender();
      return <original.default {...props} />;
    },
  };
});

vi.mock("./MermaidDiagram.js", () => ({
  MermaidDiagram: ({ source }: { source: string }) => (
    <div data-testid="mermaid-diagram">{source}</div>
  ),
}));

let smoothStreaming = true;
let nowMs = 1_000;
let frames: Array<FrameRequestCallback | undefined>;

vi.mock("../../app/use-smooth-streaming.js", () => ({
  isSmoothStreamingEffective: () => smoothStreaming,
  useSmoothStreaming: () => smoothStreaming,
}));

beforeEach(() => {
  smoothStreaming = true;
  nowMs = 1_000;
  frames = [];
  highlightCode.mockClear();
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames[id - 1] = undefined;
  });
});

afterEach(() => {
  cleanup();
  clearDiagnostics();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProgressiveMarkdown", () => {
  it("puts the full text in layout immediately without a duplicate accessible copy", () => {
    const source = "A👨‍👩‍👧‍👦e\u0301";
    const { container } = render(
      <ProgressiveMarkdown streaming>{source}</ProgressiveMarkdown>,
    );

    const animated = container.querySelector(
      ".progressive-markdown-animated",
    );
    expect(animated).toHaveAttribute("data-animated-graphemes", "0");
    expect(animated).toHaveTextContent(source);
    expect(container.querySelector("p")).toHaveTextContent(source);
    expect(container.querySelector("[aria-label]")).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(container.querySelectorAll(".progressive-markdown-grapheme")).toHaveLength(0);
  });

  it("advances opacity on frames without changing text or reparsing the document", () => {
    const { container, rerender } = render(
      <ProgressiveMarkdown streaming>streaming</ProgressiveMarkdown>,
    );
    nowMs += 150;
    rerender(
      <ProgressiveMarkdown streaming>streaming answer</ProgressiveMarkdown>,
    );
    const paragraph = container.querySelector("p")!;
    const beforeText = paragraph.textContent;
    const first = container.querySelector<HTMLElement>(
      ".progressive-markdown-grapheme",
    )!;
    const beforeOpacity = Number(first.style.opacity);
    const parses = parserRender.mock.calls.length;

    nowMs += 200;
    act(() => flushNextFrame(nowMs));

    expect(Number(first.style.opacity)).toBeGreaterThan(beforeOpacity);
    expect(paragraph.textContent).toBe(beforeText);
    expect(container.querySelector("p")).toBe(paragraph);
    expect(container.querySelector("[aria-label]")).toBeNull();
    expect(parserRender.mock.calls.length).toBe(parses);
  });

  it.each([
    ["- one", "- one\n- **two**", "ul > li strong", "two"],
    ["1. one", "1. one\n2. two", "ol > li:last-child", "two"],
    ["- one", "- one\n  - nested", "li > ul > li", "nested"],
    ["- [ ] one", "- [ ] one\n- [x] done", "li:last-child", "done"],
    ["> one", "> one\n> two", "blockquote p", "one two"],
    ["# Head", "# Heading", "h1", "Heading"],
    ["| A | B |\n| - | - |", "| A | B |\n| - | - |\n| one | two |", "td:last-child", "two"],
    ["Prefix", "Prefix `code`", "code", "code"],
  ])("fades text inside parsed Markdown: %s", (initial, source, selector, text) => {
    const { container, rerender } = render(<ProgressiveMarkdown streaming>{initial}</ProgressiveMarkdown>);
    nowMs += 100;
    rerender(<ProgressiveMarkdown streaming>{source}</ProgressiveMarkdown>);
    const element = container.querySelector(selector)!;
    expect(element).toHaveTextContent(text);
    const animated = element.querySelector<HTMLElement>(".progressive-markdown-grapheme")!;
    expect(animated).not.toBeNull();
    expect(Number(animated.style.opacity)).toBeLessThan(1);
    nowMs += 1_200;
    act(() => flushNextFrame(nowMs));
    expect(Number(animated.style.opacity)).toBe(1);
    expect(pendingFrameCount()).toBe(0);
    if (source.includes("[x]")) expect(screen.getAllByRole("checkbox")[1]).toBeChecked();
  });

  it.each([
    ["**", "**", "strong"],
    ["*", "*", "em"],
    ["[", "](https://example.test)", "a"],
    ["`", "`", "code"],
  ])("preserves fade progress when closing %s syntax reparents text", (opener, closer, selector) => {
    const { container, rerender } = render(<ProgressiveMarkdown streaming>Prefix </ProgressiveMarkdown>);
    const partial = `Prefix ${opener}word`;
    rerender(<ProgressiveMarkdown streaming>{partial}</ProgressiveMarkdown>);
    nowMs += 150;
    act(() => flushNextFrame(nowMs));
    const before = [...container.querySelectorAll<HTMLElement>(".progressive-markdown-grapheme")]
      .find((span) => span.textContent === "w")!;
    const opacity = before.style.opacity;
    rerender(<ProgressiveMarkdown streaming>{partial + closer}</ProgressiveMarkdown>);
    expect(container.querySelector(selector)).toHaveTextContent("word");
    const after = container.querySelector<HTMLElement>(`${selector} .progressive-markdown-grapheme`)!;
    expect(after.textContent).toBe("w");
    expect(after.style.opacity).toBe(opacity);
    expect(container.querySelector("p")?.textContent).toBe("Prefix word");
    if (selector === "a") expect(screen.getByRole("link", { name: "word" })).toHaveAttribute("href", "https://example.test/");
  });

  it.each([
    ["- start ", "&amp; &#x1F600; e\u0301", "& 😀 e\u0301"],
    ["- start ", "\\*literal\\*", "*literal*"],
    ["> start", "\n> more", "more"],
    ["- start", "\n  more", "more"],
    ["- start", "\r\n  more", "more"],
    ["- start", " a \n  b", "ab"],
    ["- start", " a&#32;\n  b", "ab"],
    ["- start", " a\t\r\n  b", "ab"],
    ["Prefix", " a \n b", "ab"],
    ["- start ", "`hello\n  world`", "hello world"],
    ["> start ", "`hello\n> world`", "hello world"],
    ["- start ", "`hello\n  world > more`", "hello world > more"],
    ["- start ", "&notanentity;", "&notanentity;"],
    ["Prefix ", "` a\nb `", "a b"],
    ["Prefix ", "`&amp; \\*`", "&amp; \\*"],
    ["- start ", "👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦"],
  ])("maps displayed characters to source through escapes and normalization: %s %s", (initial, append, visible) => {
    const { container, rerender } = render(<ProgressiveMarkdown streaming>{initial}</ProgressiveMarkdown>);
    rerender(<ProgressiveMarkdown streaming>{initial + append}</ProgressiveMarkdown>);
    const spans = [...container.querySelectorAll<HTMLElement>(".progressive-markdown-grapheme")];
    expect(spans.map((span) => span.textContent).join("")).toBe(visible.replace(/\s/gu, ""));
    expect(spans.every((span) => Number(span.style.opacity) < 1)).toBe(true);
  });

  it.each([
    ["- start ", "`hello\n  world"],
    ["> start ", "`hello\n> world"],
  ])("preserves source fade progress when multiline code closes in %s", (initial, code) => {
    const { container, rerender } = render(<ProgressiveMarkdown streaming>{initial}</ProgressiveMarkdown>);
    rerender(<ProgressiveMarkdown streaming>{initial + code}</ProgressiveMarkdown>);
    nowMs += 150;
    act(() => flushNextFrame(nowMs));
    const before = new Map([...container.querySelectorAll<HTMLElement>(".progressive-markdown-grapheme")]
      .map((span) => [span.dataset.streamIndex, span.style.opacity]));
    rerender(<ProgressiveMarkdown streaming>{initial + code + "`"}</ProgressiveMarkdown>);
    const after = [...container.querySelectorAll<HTMLElement>("code .progressive-markdown-grapheme")];
    expect(after.map((span) => span.textContent).join("")).toBe("helloworld");
    for (const span of after) {
      expect(span.style.opacity).toBe(before.get(span.dataset.streamIndex));
      expect(Number(span.style.opacity)).toBeLessThan(1);
    }
  });

  it("does not refade earlier paragraphs when a list begins or a reference resolves", () => {
    const initial = "Earlier [link][ref].";
    const { container, rerender } = render(<ProgressiveMarkdown streaming>{initial}</ProgressiveMarkdown>);
    rerender(<ProgressiveMarkdown streaming>{`${initial}\n\n- new bullet`}</ProgressiveMarkdown>);
    expect(container.querySelector("p .progressive-markdown-grapheme")).toBeNull();
    rerender(<ProgressiveMarkdown streaming>{`${initial}\n\n- new bullet\n\n[ref]: https://example.test`}</ProgressiveMarkdown>);
    expect(screen.getByRole("link", { name: "link" })).toHaveAttribute("href", "https://example.test/");
    expect(container.querySelector("p .progressive-markdown-grapheme")).toBeNull();
    expect(container.querySelector("li .progressive-markdown-grapheme")).not.toBeNull();
  });

  it("records content-free text commits and delayed animation frames", () => {
    setDiagnosticCategoryEnabled("streaming", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const { rerender } = render(
      <ProgressiveMarkdown streaming>streaming</ProgressiveMarkdown>,
    );
    nowMs += 150;
    rerender(
      <ProgressiveMarkdown streaming>streaming response</ProgressiveMarkdown>,
    );
    nowMs += 80;
    act(() => flushNextFrame(nowMs));

    expect(readDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "streaming",
          event: "text_committed",
          details: expect.objectContaining({ textCharacters: 18 }),
        }),
        expect.objectContaining({
          category: "streaming",
          event: "animation_frame_delayed",
          details: expect.objectContaining({ durationMilliseconds: 80 }),
        }),
      ]),
    );
  });

  it("parses a settled prefix while leaving incomplete inline tail literal", () => {
    render(
      <ProgressiveMarkdown streaming>
        {"**Settled bold**\n\nactive *tail"}
      </ProgressiveMarkdown>,
    );

    expect(screen.getByText("Settled bold").tagName).toBe("STRONG");
    expect(screen.getByText("active *tail")).toBeInTheDocument();
  });

  it("renders complete inline Markdown while incomplete syntax stays literal", () => {
    const { container } = render(
      <ProgressiveMarkdown streaming>
        {"**Workspace inspected**\nI found *an active tail"}
      </ProgressiveMarkdown>,
    );

    expect(container.querySelector("strong")).toHaveTextContent("Workspace inspected");
    expect(container.querySelector("em")).not.toBeInTheDocument();
    expect(container).toHaveTextContent("I found *an active tail");
  });

  it("keeps the initial fenced code opaque", () => {
    const { container } = render(
      <ProgressiveMarkdown streaming>
        {"```ts\nconst answer = 42;"}
      </ProgressiveMarkdown>,
    );

    expect(screen.getByText("const answer = 42;").tagName).toBe("CODE");
    expect(
      container.querySelector("pre .progressive-markdown-grapheme"),
    ).not.toBeInTheDocument();
  });

  it.each([true, false])("preserves literal code and copying, then colors after fading (closing fence: %s)", async (closeFence) => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const prefix = "```ts\n";
    const code = 'const value = "<&amp;>";\n  // 👨‍👩‍👧‍👦 e\u0301';
    const { container, rerender } = render(<ProgressiveMarkdown streaming copyCodeBlocks>{prefix}</ProgressiveMarkdown>);
    rerender(<ProgressiveMarkdown streaming copyCodeBlocks>{prefix + code}</ProgressiveMarkdown>);
    expect(container.querySelector("pre code")?.textContent).toBe(code + "\n");
    const first = container.querySelector<HTMLElement>("pre .progressive-markdown-grapheme")!;
    expect(first).not.toBeNull();
    expect(Number(first.style.opacity)).toBeLessThan(1);
    expect(highlightCode).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy code" })));
    expect(writeText).toHaveBeenCalledWith(code);
    nowMs += 150;
    act(() => flushNextFrame(nowMs));
    const opacity = first.style.opacity;
    rerender(<ProgressiveMarkdown streaming={closeFence} copyCodeBlocks>{prefix + code + (closeFence ? "\n```" : "")}</ProgressiveMarkdown>);
    expect(container.querySelector<HTMLElement>("pre .progressive-markdown-grapheme")?.style.opacity).toBe(opacity);
    expect(highlightCode).not.toHaveBeenCalled();
    const parses = parserRender.mock.calls.length;
    nowMs += 1_200;
    await act(async () => flushNextFrame(nowMs));
    expect(highlightCode).toHaveBeenCalledWith(code + "\n", "typescript");
    expect(container.querySelector("code[data-syntax-language='typescript']")?.textContent).toBe(code + "\n");
    expect(container.querySelector("pre .progressive-markdown-grapheme")).toBeNull();
    expect(parserRender.mock.calls.length).toBe(parses);
  });

  it.each(["", "unrecognized"])("fades code without a known language: %s", (language) => {
    const prefix = `~~~${language}\n`;
    const { container, rerender } = render(<ProgressiveMarkdown streaming>{prefix}</ProgressiveMarkdown>);
    rerender(<ProgressiveMarkdown streaming>{prefix + "  raw <tag> &amp;"}</ProgressiveMarkdown>);
    expect(container.querySelector("pre code")?.textContent).toBe("  raw <tag> &amp;\n");
    expect(container.querySelector("pre .progressive-markdown-grapheme")).not.toBeNull();
    rerender(<ProgressiveMarkdown streaming={false}>{prefix + "  raw <tag> &amp;"}</ProgressiveMarkdown>);
    nowMs += 450;
    act(() => vi.advanceTimersByTime(450));
    expect(container.querySelector("pre code")?.textContent).toBe("  raw <tag> &amp;\n");
    expect(container.querySelector("pre .progressive-markdown-grapheme")).toBeNull();
    expect(highlightCode).not.toHaveBeenCalled();
  });

  it("hides an incomplete Mermaid fence and renders it as soon as it closes", () => {
    const incomplete = "Before\n\n```mermaid\nflowchart LR\nA--";
    const { rerender } = render(
      <ProgressiveMarkdown streaming>{incomplete}</ProgressiveMarkdown>,
    );

    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for diagram…",
    );
    expect(screen.queryByTestId("mermaid-diagram")).not.toBeInTheDocument();
    expect(screen.queryByText(/flowchart LR/u)).not.toBeInTheDocument();

    const closed = `${incomplete}>B\n\`\`\``;
    rerender(
      <ProgressiveMarkdown streaming>{closed}</ProgressiveMarkdown>,
    );
    expect(screen.getByTestId("mermaid-diagram")).toHaveTextContent(
      "flowchart LR A-->B",
    );
    expect(screen.queryByText("Waiting for diagram…")).toBeNull();
  });

  it("renders a closed Mermaid prefix while later prose remains active", () => {
    const source = "```mermaid\nflowchart LR\nA-->B\n```\n\nactive tail";
    const { container } = render(
      <ProgressiveMarkdown streaming>{source}</ProgressiveMarkdown>,
    );

    expect(screen.getByTestId("mermaid-diagram")).toHaveTextContent(
      "flowchart LR A-->B",
    );
    expect(screen.getByText("active tail")).toBeInTheDocument();
    expect(container.querySelector(".progressive-markdown")).toHaveAttribute(
      "data-streaming",
      "true",
    );
  });

  it("bounds a replacement snapshot and retained appended tail", () => {
    const { container, rerender } = render(
      <ProgressiveMarkdown streaming>{"a".repeat(200)}</ProgressiveMarkdown>,
    );
    expect(
      container.querySelectorAll(".progressive-markdown-grapheme"),
    ).toHaveLength(0);

    nowMs += 150;
    rerender(
      <ProgressiveMarkdown streaming>{"b".repeat(300)}</ProgressiveMarkdown>,
    );
    expect(
      container.querySelectorAll(".progressive-markdown-grapheme"),
    ).toHaveLength(48);

    nowMs += 150;
    rerender(
      <ProgressiveMarkdown streaming>
        {`${"b".repeat(300)}${"c".repeat(300)}`}
      </ProgressiveMarkdown>,
    );
    expect(
      container.querySelectorAll(".progressive-markdown-grapheme"),
    ).toHaveLength(128);
  });

  it("formats the final append immediately and removes spans at the bounded handoff", () => {
    const { container, rerender } = render(
      <ProgressiveMarkdown streaming sourcePositionMetadata={false}>
        answer **bo
      </ProgressiveMarkdown>,
    );

    nowMs += 150;
    rerender(
      <ProgressiveMarkdown streaming={false} sourcePositionMetadata>
        answer **bold**
      </ProgressiveMarkdown>,
    );
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container).toHaveTextContent("answer bold");
    expect(container.querySelector("strong .progressive-markdown-grapheme")).toBeInTheDocument();
    // Selection metadata signals stable DOM to selection owners. Formatting
    // is immediate, but selection must wait until the fade spans are removed.
    expect(container.querySelector("[data-markdown-block]")).toBeNull();

    act(() => {
      nowMs += 449;
      vi.advanceTimersByTime(449);
    });
    expect(container.querySelector("strong .progressive-markdown-grapheme")).toBeInTheDocument();
    expect(container.querySelector("[data-markdown-block]")).toBeNull();

    act(() => {
      nowMs += 1;
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(container.querySelector("p")).toHaveAttribute(
      "data-markdown-block",
    );
  });

  it("reports the terminal presentation window to its selection owner", () => {
    const presentationChanged = vi.fn();
    const { rerender } = render(
      <ProgressiveMarkdown
        onPresentationActiveChange={presentationChanged}
        streaming
      >
        answer
      </ProgressiveMarkdown>,
    );
    expect(presentationChanged).toHaveBeenLastCalledWith(true);

    rerender(
      <ProgressiveMarkdown
        onPresentationActiveChange={presentationChanged}
        streaming={false}
      >
        answer
      </ProgressiveMarkdown>,
    );
    expect(presentationChanged).toHaveBeenLastCalledWith(true);

    act(() => {
      nowMs += 450;
      vi.advanceTimersByTime(450);
    });
    expect(presentationChanged).toHaveBeenLastCalledWith(false);
  });

  it("cancels terminal handoff when streaming resumes", () => {
    const { container, rerender } = render(
      <ProgressiveMarkdown streaming>first</ProgressiveMarkdown>,
    );
    rerender(
      <ProgressiveMarkdown streaming={false}>first</ProgressiveMarkdown>,
    );
    nowMs += 100;
    rerender(
      <ProgressiveMarkdown streaming>first again</ProgressiveMarkdown>,
    );

    act(() => {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    });
    expect(
      container.querySelector(".progressive-markdown-animated"),
    ).toBeInTheDocument();
  });

  it("uses complete Markdown and owns no frame when smoothing is disabled or hidden", () => {
    smoothStreaming = false;
    const { container, rerender } = render(
      <ProgressiveMarkdown streaming>**bold**</ProgressiveMarkdown>,
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(pendingFrameCount()).toBe(0);

    smoothStreaming = true;
    rerender(
      <ProgressiveMarkdown animationActive={false} streaming>
        hidden reasoning
      </ProgressiveMarkdown>,
    );
    expect(
      container.querySelector(".progressive-markdown-animated"),
    ).not.toBeInTheDocument();
    expect(pendingFrameCount()).toBe(0);
  });

  it("cancels its pending frame on unmount", () => {
    const { rerender, unmount } = render(
      <ProgressiveMarkdown streaming>still</ProgressiveMarkdown>,
    );
    nowMs += 150;
    rerender(
      <ProgressiveMarkdown streaming>still fading</ProgressiveMarkdown>,
    );
    expect(pendingFrameCount()).toBe(1);
    unmount();
    expect(pendingFrameCount()).toBe(0);
  });

  it("does not replay a tail fade when an active stream remounts", () => {
    const source = "already received streaming text";
    const first = render(
      <ProgressiveMarkdown streaming>{source}</ProgressiveMarkdown>,
    );

    expect(first.container.querySelector(".progressive-markdown-animated"))
      .toHaveAttribute("data-animated-graphemes", "0");
    expect(pendingFrameCount()).toBe(0);
    first.unmount();

    const returned = render(
      <ProgressiveMarkdown streaming>{source}</ProgressiveMarkdown>,
    );
    expect(returned.container.querySelector(".progressive-markdown-animated"))
      .toHaveAttribute("data-animated-graphemes", "0");
    expect(returned.container).toHaveTextContent(source);
    expect(pendingFrameCount()).toBe(0);
  });
});

function flushNextFrame(timestamp: number): void {
  const index = frames.findIndex((callback) => callback !== undefined);
  const callback = frames[index];
  frames[index] = undefined;
  callback?.(timestamp);
}

function pendingFrameCount(): number {
  return frames.filter((callback) => callback !== undefined).length;
}
