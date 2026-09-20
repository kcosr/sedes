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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "./MermaidDiagram.js";
import { MarkdownContent } from "./MarkdownContent.js";

const { renderMermaid, subscribeResolvedAppearance } = vi.hoisted(() => ({
  renderMermaid: vi.fn(),
  subscribeResolvedAppearance: vi.fn(),
}));

vi.mock("./mermaid-renderer.js", () => ({ renderMermaid }));
vi.mock("../../app/appearance.js", () => ({
  getResolvedAppearance: () => "light",
  subscribeResolvedAppearance,
}));

let appearanceListener: ((appearance: "light" | "dark") => void) | undefined;
const createObjectURL = vi.fn(() => "blob:mermaid-preview");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  renderMermaid.mockReset();
  subscribeResolvedAppearance.mockReset();
  subscribeResolvedAppearance.mockImplementation((listener) => {
    appearanceListener = listener;
    return vi.fn();
  });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
});

afterEach(() => {
  appearanceListener = undefined;
  cleanup();
  vi.unstubAllGlobals();
});

describe("MermaidDiagram", () => {
  it("renders SVG and keeps Markdown source-position metadata on its block", async () => {
    renderMermaid.mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>',
    );
    const { container } = render(
      <MermaidDiagram
        source="flowchart LR\nA-->B"
        sourcePositionAttributes={
          {
            "data-markdown-block": "",
            "data-markdown-source-start-line": "3",
            "data-markdown-source-end-line": "6",
          } as React.HTMLAttributes<HTMLDivElement>
        }
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Rendering diagram");
    expect(await screen.findByText("Rendered")).toBeInTheDocument();
    const diagram = screen.getByRole("img", { name: "Mermaid diagram" });
    const block = diagram.closest(".mermaid-diagram");
    expect(block).toHaveAttribute("data-markdown-block");
    expect(block).toHaveAttribute("data-markdown-source-start-line", "3");
    expect(block).toHaveAttribute("data-markdown-source-end-line", "6");
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand Mermaid diagram" }),
    ).toBeVisible();
  });

  it("opens the validated SVG in the shared zoomable preview", async () => {
    renderMermaid.mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>',
    );
    render(
      <MermaidDiagram
        source="flowchart LR\nA-->B"
        sourcePositionAttributes={{}}
      />,
    );

    const expand = await screen.findByRole("button", {
      name: "Expand Mermaid diagram",
    });
    const diagram = screen.getByRole("img", { name: "Mermaid diagram" });
    expect(expand).toContainElement(diagram);
    fireEvent.click(diagram);

    const dialog = screen.getByRole("dialog", {
      name: "Mermaid diagram preview",
    });
    const viewport = within(dialog).getByRole("region", {
      name: "Mermaid diagram preview",
    });
    expect(
      within(dialog).getByRole("group", { name: "Diagram zoom controls" }),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        dialog.querySelector(".zoomable-preview-content > img"),
      ).toHaveAttribute("src", "blob:mermaid-preview");
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    expect(within(dialog).getByLabelText("Zoom level")).toHaveTextContent(
      "125%",
    );
    fireEvent.keyDown(viewport, { key: "+" });
    expect(within(dialog).getByLabelText("Zoom level")).toHaveTextContent(
      "150%",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset diagram view" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Zoom out" }));
    expect(within(dialog).getByLabelText("Zoom level")).toHaveTextContent(
      "75%",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mermaid-preview");
    await waitFor(() => expect(expand).toHaveFocus());
  });

  it("shows the literal definition when Mermaid rejects it", async () => {
    renderMermaid.mockRejectedValue(new Error("bad syntax"));
    render(
      <MermaidDiagram source="not a diagram" sourcePositionAttributes={{}} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not render this Mermaid diagram.",
    );
    expect(screen.getByText("not a diagram").tagName).toBe("CODE");
    expect(
      screen.queryByRole("button", { name: "Expand Mermaid diagram" }),
    ).toBeNull();
  });

  it("reveals invalid source only after a streaming Mermaid fence closes", async () => {
    renderMermaid.mockRejectedValue(new Error("bad syntax"));
    const view = render(
      <MarkdownContent streaming>
        {"```mermaid\nnot a diagram"}
      </MarkdownContent>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for diagram…",
    );
    expect(screen.queryByText("not a diagram")).toBeNull();
    expect(renderMermaid).not.toHaveBeenCalled();

    view.rerender(
      <MarkdownContent streaming>
        {"```mermaid\nnot a diagram\n```"}
      </MarkdownContent>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not render this Mermaid diagram.",
    );
    expect(screen.getByText("not a diagram").tagName).toBe("CODE");
    expect(renderMermaid).toHaveBeenCalledOnce();
  });

  it("ignores stale work and rerenders with the resolved app theme", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    renderMermaid
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = render(
      <MermaidDiagram
        source={"flowchart LR\nA-->B"}
        sourcePositionAttributes={{}}
      />,
    );

    act(() => appearanceListener?.("dark"));
    expect(renderMermaid).toHaveBeenLastCalledWith(
      "flowchart LR\nA-->B",
      "dark",
    );
    await act(() =>
      second.resolve(
        '<svg xmlns="http://www.w3.org/2000/svg"><text>Dark</text></svg>',
      ),
    );
    expect(screen.getByText("Dark")).toBeInTheDocument();

    await act(() =>
      first.resolve(
        '<svg xmlns="http://www.w3.org/2000/svg"><text>Stale</text></svg>',
      ),
    );
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(screen.getByText("Dark")).toBeInTheDocument();
    view.unmount();
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
