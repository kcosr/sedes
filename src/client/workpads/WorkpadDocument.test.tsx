// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkpadAttributionSpan } from "../../shared/protocol/workpads.js";
import { WorkpadDocument } from "./WorkpadDocument.js";

vi.mock("../components/conversation/MermaidDiagram.js", () => ({ MermaidDiagram: () => <div>Diagram</div> }));
afterEach(cleanup);
const time = "2026-09-08T12:00:00.000Z";
function span(start: number, end: number, revision: number, name = "API integration"): WorkpadAttributionSpan {
  return { start, end, revision, createdAt: time, author: revision === 2
    ? { kind: "user", threadId: null, clientId: null, name, nameSnapshot: "Original name" }
    : { kind: "agent", threadId: "thread-api", clientId: null, name, nameSnapshot: "Original name" } };
}

describe("WorkpadDocument", () => {
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
