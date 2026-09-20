// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelChrome, panelContentId } from "./PanelChrome.js";

function FileIcon(): React.JSX.Element {
  return <svg aria-hidden="true" />;
}

let singlePane = false;

beforeEach(() => {
  singlePane = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return singlePane;
    },
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PanelChrome", () => {
  it("renders singleton Files status without tab semantics", () => {
    render(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        status={{ subtitle: "demo", dirty: true, busy: true }}
        controls={{
          onCollapse: () => undefined,
          onClose: () => undefined,
          onDock: () => undefined,
        }}
      />,
    );

    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
    expect(screen.getByLabelText("Busy")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("provides distinct collapse and close controls", () => {
    const onCollapse = vi.fn();
    const onClose = vi.fn();
    render(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        controls={{
          onCollapse,
          onClose,
          onDock: () => undefined,
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Files panel" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Files panel" }));

    expect(onCollapse).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
  });

  it("keeps panel-specific controls to the left of common panel controls", () => {
    render(
      <PanelChrome
        panelTitle="Chat"
        leading={<span>Thread title</span>}
        panelActions={<button>Find</button>}
        controls={{
          onCollapse: () => undefined,
          onClose: () => undefined,
          onDock: () => undefined,
        }}
      />,
    );

    const header = screen.getByRole("banner", { name: "Chat panel header" });
    expect(header.textContent).toContain("Thread titleFind");
    expect(
      screen.getByRole("button", { name: "Chat panel actions" }),
    ).toBeTruthy();
    expect(header.querySelector(".lucide-ellipsis-vertical")).not.toBeNull();
    expect(header.querySelector(".lucide-ellipsis")).toBeNull();
  });

  it("drops the panel menu on single-pane layouts that cannot dock", () => {
    singlePane = true;
    const { rerender } = render(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        controls={{
          onCollapse: () => undefined,
          onClose: () => undefined,
          onDock: () => undefined,
        }}
      />,
    );

    // Collapse and close still apply; only the dock-only menu goes away.
    expect(
      screen.queryByRole("button", { name: "Files panel actions" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Collapse Files panel" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close Files panel" }),
    ).toBeTruthy();

    // A tenant with its own items still needs somewhere to put them.
    rerender(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        controls={{
          onCollapse: () => undefined,
          onClose: () => undefined,
          onDock: () => undefined,
          renderMenuItems: <button>Reveal</button>,
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Files panel actions" }),
    ).toBeTruthy();
  });

  it("keeps content ids safe for DOM use", () => {
    expect(panelContentId("files/a b")).toBe(
      "workspace-panel-content-files_a_b",
    );
  });
});
