// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkpadAttributionSpan } from "../../shared/protocol/workpads.js";
import { WorkpadDocument } from "./WorkpadDocument.js";
import { applyMarkdownChecklistToggle, type MarkdownChecklistToggle } from "../components/conversation/markdown-checklists.js";
import * as markdownChecklists from "../components/conversation/markdown-checklists.js";

vi.mock("../components/conversation/MermaidDiagram.js", () => ({ MermaidDiagram: () => <div>Diagram</div> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const time = "2026-09-08T12:00:00.000Z";
function span(start: number, end: number, revision: number, name = "API integration"): WorkpadAttributionSpan {
  return { start, end, revision, createdAt: time, author: revision === 2
    ? { kind: "user", threadId: null, clientId: null, name, nameSnapshot: "Original name" }
    : { kind: "agent", threadId: "thread-api", clientId: null, name, nameSnapshot: "Original name" } };
}

describe("WorkpadDocument", () => {
  it.each([
    { source: "🐈\r\n\r\n- [ ] Repeat\r\n- [ ] Repeat\r\n", name: "Repeat", occurrence: 1,
      expected: "🐈\r\n\r\n- [ ] Repeat\r\n- [x] Repeat\r\n" },
    { source: "> 1. [X] **Quoted**\n>    - [ ] nested\n", name: "Quoted", occurrence: 0,
      expected: "> 1. [ ] **Quoted**\n>    - [ ] nested\n" },
    { source: "> 1. [X] **Quoted**\n>    - [ ] nested\n", name: "nested", occurrence: 0,
      expected: "> 1. [X] **Quoted**\n>    - [x] nested\n" },
    { source: "- [ ] First\n\n  More text\n\n- [x] Second\n", name: "Second", occurrence: 0,
      expected: "- [ ] First\n\n  More text\n\n- [ ] Second\n" },
    { source: "-\n  [ ] Following line\n", name: "Following line", occurrence: 0,
      expected: "-\n  [x] Following line\n" },
    { source: "- [\t] Tab marker\n", name: "Tab marker", occurrence: 0,
      expected: "- [x] Tab marker\n" },
    { source: "\uFEFF- [ ] BOM\n- [X] Second\n", name: "BOM", occurrence: 0,
      expected: "\uFEFF- [x] BOM\n- [X] Second\n" },
    { source: "\uFEFF- [ ] BOM\n- [X] Second\n", name: "Second", occurrence: 0,
      expected: "\uFEFF- [ ] BOM\n- [ ] Second\n" },
  ])("changes only the parser-selected marker in $source", ({ source, name, occurrence, expected }) => {
    const onToggle = vi.fn<(change: MarkdownChecklistToggle) => void>();
    render(<WorkpadDocument content={source} attribution={[]} showAttribution={false}
      checklist={{ disabled: false, pending: false, onToggle }} />);
    fireEvent.click(screen.getAllByRole("checkbox", { name })[occurrence]!);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(applyMarkdownChecklistToggle(onToggle.mock.calls[0]![0])).toBe(expected);
  });

  it("ignores code and escaped markers and names checkboxes from visible task text", () => {
    const content = "```md\n- [ ] Example\n```\n\n\\- [ ] Literal\n\n- [ ] **A** &amp; [B](https://example.com) `code`\n";
    const onToggle = vi.fn<(change: MarkdownChecklistToggle) => void>();
    render(<WorkpadDocument content={content} attribution={[]} showAttribution={false}
      checklist={{ disabled: false, pending: false, onToggle }} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "A & B code" }));
    expect(applyMarkdownChecklistToggle(onToggle.mock.calls[0]![0])).toBe(content.replace("- [ ] **A**", "- [x] **A**"));
  });

  it("does not reparse unchanged Markdown when attribution details or equivalent checklist props change", () => {
    const parser = vi.spyOn(markdownChecklists, "rehypeChecklistInputs");
    const content = "- [ ] Verify endpoint";
    const attribution = [span(0, content.length, 1)];
    const onToggle = vi.fn();
    const { rerender } = render(<WorkpadDocument content={content} attribution={attribution} showAttribution
      checklist={{ disabled: false, pending: false, onToggle }} />);
    const parses = parser.mock.calls.length;
    expect(parses).toBeGreaterThan(0);
    const mark = screen.getByRole("button", { name: /Verify endpoint.*last changed/ });
    fireEvent.mouseOver(mark);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.focus(mark);
    fireEvent.click(screen.getByRole("button", { name: "Close attribution details" }));
    rerender(<WorkpadDocument content={content} attribution={attribution} showAttribution
      checklist={{ disabled: false, pending: false, onToggle }} />);
    expect(parser).toHaveBeenCalledTimes(parses);
    rerender(<WorkpadDocument content={`${content}\nNew paragraph`} attribution={attribution} showAttribution
      checklist={{ disabled: false, pending: false, onToggle }} />);
    expect(parser.mock.calls.length).toBeGreaterThan(parses);
  });

  it("preserves focus and native Space activation through pending saves with attribution enabled", async () => {
    const user = userEvent.setup();
    const content = "- [ ] Verify endpoint";
    const attribution = [span(0, content.length, 1)];
    const onToggle = vi.fn<(change: MarkdownChecklistToggle) => void>();
    const controls = { disabled: false, pending: false, onToggle };
    const { rerender } = render(<WorkpadDocument content={content} attribution={attribution} showAttribution checklist={controls} />);
    const checkbox = screen.getByRole("checkbox", { name: "Verify endpoint" });
    checkbox.focus();
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<WorkpadDocument content={content} attribution={attribution} showAttribution checklist={{ ...controls, pending: true }} />);
    expect(checkbox).toHaveFocus();
    expect(checkbox).toHaveAttribute("aria-disabled", "true");
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(1);
    const updated = applyMarkdownChecklistToggle(onToggle.mock.calls[0]![0])!;
    rerender(<WorkpadDocument content={updated} attribution={attribution} showAttribution checklist={controls} />);
    expect(screen.getByRole("checkbox")).toBe(checkbox);
    expect(checkbox).toHaveFocus();
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /Verify endpoint.*last changed/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it.each(["disabled", "inactive"])("keeps %s checklists read-only", mode => {
    const onToggle = vi.fn();
    render(<WorkpadDocument content="- [ ] Read only" attribution={[]} showAttribution={false} active={mode !== "inactive"}
      checklist={{ disabled: mode === "disabled", pending: false, onToggle }} />);
    const checkbox = screen.getByRole("checkbox", { name: "Read only" });
    expect(checkbox).toBeDisabled();
    fireEvent.click(checkbox);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("toggles attribution without changing Markdown structure or visible content", () => {
    const content = "# Decision\n\nUse a **15-minute** timeout.";
    const start = content.indexOf("15-minute");
    const attribution = [span(0, start, 1), span(start, start + 9, 2), span(start + 9, content.length, 1)];
    const { container, rerender } = render(<WorkpadDocument content={content} attribution={attribution} showAttribution={false} />);
    expect(screen.getByRole("heading", { name: "Decision" })).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("15-minute");
    expect(container.querySelector("mark")).toBeNull();
    const clean = container.querySelector(".markdown")!.textContent;
    rerender(<WorkpadDocument content={content} attribution={attribution} showAttribution />);
    expect(container.querySelector(".markdown")!.textContent).toBe(clean);
    const change = screen.getByRole("button", { name: "15-minute — last changed by You, revision 2" });
    expect(change.closest("strong")).not.toBeNull();
    fireEvent.click(change);
    expect(screen.getByRole("status")).toHaveTextContent("You · Revision 2");
    rerender(<WorkpadDocument content={content} attribution={attribution} showAttribution={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows typed lines as line breaks and attributes each line to its own author", () => {
    const content = "Local - Rewrite: eval\nLocal - opencode: eval\n\nLocal - runner: eval\n";
    const second = content.indexOf("Local - opencode");
    const attribution = [span(0, second, 1), span(second, second + "Local - opencode: eval".length, 2), span(second + "Local - opencode: eval".length, content.length, 1)];
    const { container } = render(<WorkpadDocument content={content} attribution={attribution} showAttribution />);
    const paragraphs = container.querySelectorAll(".markdown p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.querySelectorAll("br")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Local - opencode: eval — last changed by You, revision 2" })).toBeInTheDocument();
    expect(paragraphs[0]!.textContent).toBe("Local - Rewrite: eval\nLocal - opencode: eval");
  });

  it("credits repeated text and entity lines to each line's own author", () => {
    const content = "Same & more\nSame\n";
    const second = content.indexOf("\nSame") + 1;
    const attribution = [span(0, second, 1, "First agent"), span(second, content.length, 2)];
    render(<WorkpadDocument content={content} attribution={attribution} showAttribution />);
    expect(screen.getByRole("button", { name: "Same — last changed by You, revision 2" })).toBeInTheDocument();
    const entityContent = "a &amp; b\na";
    const entitySplit = entityContent.indexOf("\n") + 1;
    cleanup();
    render(<WorkpadDocument content={entityContent} attribution={[span(0, entitySplit, 1, "First agent"), span(entitySplit, entityContent.length, 2)]} showAttribution />);
    expect(screen.getByRole("button", { name: "a — last changed by You, revision 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^a & b — last changed by You/u })).toBeNull();
  });

  it("offers resolved names by hover, tap and keyboard and clears details on revision change", () => {
    const attribution = [span(0, 5, 1, "Renamed thread")];
    const { rerender } = render(<WorkpadDocument content="Hello" attribution={attribution} showAttribution />);
    const mark = screen.getByRole("button", { name: /last changed by Renamed thread/ });
    fireEvent.mouseOver(mark);
    expect(screen.getByRole("status")).toHaveTextContent("Renamed thread");
    fireEvent.click(screen.getByRole("button", { name: "Close attribution details" }));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.keyDown(mark, { key: "Enter" });
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.keyDown(mark, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(mark);
    rerender(<WorkpadDocument content="Bye" attribution={[span(0, 3, 2)]} showAttribution />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Hello")).toBeNull();
  });

  it("preserves entities, escaped Markdown, tables, inline code and fenced code", () => {
    const content = "A &amp; B \\*literal\\* `value`\n\n| Key | Value |\n| --- | --- |\n| A | B |\n\n```js\nconst value = 1;\n```";
    const { container, rerender } = render(<WorkpadDocument content={content} attribution={[span(0, content.length, 1)]} showAttribution={false} />);
    const clean = container.querySelector(".markdown")!.textContent;
    rerender(<WorkpadDocument content={content} attribution={[span(0, content.length, 1)]} showAttribution />);
    expect(container.querySelector(".markdown")!.textContent).toBe(clean);
    expect(container.querySelector("table")).toBeInTheDocument();
    expect(container.querySelector("pre code mark")).toHaveTextContent("const value = 1;");
    expect(container.querySelector("code mark")).toHaveTextContent("value");
  });

  it("reserves a distinct user color and overlays details without changing document layout", () => {
    const { container } = render(<WorkpadDocument content="Agent user" attribution={[span(0, 6, 1), span(6, 10, 2)]} showAttribution />);
    const agent = screen.getByRole("button", { name: /Agent.*last changed by API integration/ });
    const user = screen.getByRole("button", { name: /user.*last changed by You/ });
    expect(user).toHaveClass("workpad-attribution-0");
    expect(agent).not.toHaveClass("workpad-attribution-0");
    fireEvent.mouseOver(agent);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(container.querySelector(".workpad-attribution-detail")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(user);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("consumes Escape before containing panels and exposes its overlay to back navigation", () => {
    render(<WorkpadDocument content="Text" attribution={[span(0, 4, 1)]} showAttribution />);
    const mark = screen.getByRole("button", { name: /last changed by API integration/ });
    fireEvent.click(mark);
    expect(screen.getByRole("status")).toHaveAttribute("data-selection-action-overlay");
    const parentKey = vi.fn();
    document.addEventListener("keydown", parentKey);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { mark.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(parentKey).not.toHaveBeenCalled();
    document.removeEventListener("keydown", parentKey);
  });

  it("attributes decoded entities to the latest editor of the encoded character", () => {
    const content = "A &amp; B";
    const attribution = [span(0, 3, 1), span(3, 6, 2), span(6, content.length, 1)];
    render(<WorkpadDocument content={content} attribution={attribution} showAttribution />);
    expect(screen.getByRole("button", { name: "& — last changed by You, revision 2" })).toBeInTheDocument();
  });

  it("never renders untrusted HTML or deleted passages from another revision", () => {
    const content = 'Current text\n\n<script>alert(1)</script>';
    const { container } = render(<WorkpadDocument content={content} attribution={[span(0, content.length, 1)]} showAttribution />);
    expect(container.querySelector("script")).toBeNull();
    expect(container).toHaveTextContent("Current text");
    expect(container).not.toHaveTextContent("alert(1)");
  });
});
