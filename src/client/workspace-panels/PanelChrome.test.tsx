// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import { PanelChrome, panelContentId } from "./PanelChrome.js";

function FileIcon(): React.JSX.Element {
  return <svg aria-hidden="true" />;
}

function NotepadIcon(): React.JSX.Element {
  return <svg data-testid="tenant-icon" aria-hidden="true" />;
}

const noControls = {
  onCollapse: () => undefined,
  onClose: () => undefined,
  onDock: () => undefined,
};

/** Each row of an open menu in order, separators included. */
function menuRows(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll("[role^=menuitem], [role=separator]")].map(
    (row) => (row.getAttribute("role") === "separator" ? "—" : row.textContent ?? ""),
  );
}

let singlePane = false;
let coarsePointer = false;

beforeEach(() => {
  singlePane = false;
  coarsePointer = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return singlePane || (coarsePointer && query.includes("(pointer: coarse)"));
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

  it("checks the current dock edge and docks only at another edge", () => {
    const onDock = vi.fn();
    render(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        controls={{
          onCollapse: () => undefined,
          onClose: () => undefined,
          onDock,
          dockEdge: "right",
        }}
      />,
    );

    const openMenu = () =>
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Files panel actions" }),
        { button: 0, ctrlKey: false },
      );
    openMenu();
    const dock = screen.getByRole("group", { name: "Dock" });
    const edges = within(dock).getAllByRole("menuitemradio");
    expect(edges.map((edge) => edge.textContent)).toEqual([
      "Left",
      "Right",
      "Top",
      "Bottom",
    ]);
    expect(
      edges.map((edge) => edge.getAttribute("aria-checked")),
    ).toEqual(["false", "true", "false", "false"]);
    expect(edges[1]).toHaveAttribute("data-state", "checked");

    // The current edge is a no-op; another edge docks there.
    fireEvent.click(within(dock).getByRole("menuitemradio", { name: "Right" }));
    expect(onDock).not.toHaveBeenCalled();
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Bottom" }));
    expect(onDock).toHaveBeenCalledExactlyOnceWith("bottom");
  });

  it("checks no edge for a panel that is not docked at one", () => {
    render(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        controls={{
          onCollapse: () => undefined,
          onClose: () => undefined,
          onDock: () => undefined,
        }}
      />,
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Files panel actions" }),
      { button: 0, ctrlKey: false },
    );
    expect(
      screen
        .getAllByRole("menuitemradio")
        .map((edge) => edge.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "false", "false"]);
  });

  it("presents the Dock group with panel items as a sheet on touch", () => {
    coarsePointer = true;
    const onDock = vi.fn();
    render(
      <PanelChrome
        panelTitle="Terminals"
        leading={<span>Terminals</span>}
        controls={{
          onCollapse: () => undefined,
          onClose: () => undefined,
          onDock,
          dockEdge: "bottom",
          renderMenuItems: <button>Transcript</button>,
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Terminals panel actions" }),
    );
    const sheet = screen.getByRole("dialog", { name: "Terminals panel" });
    expect(
      within(sheet).getByRole("menuitemradio", { name: "Bottom" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(sheet).getByRole("menuitemradio", { name: "Left" }));
    expect(onDock).toHaveBeenCalledExactlyOnceWith("left");
    cleanup();

    // Four Dock rows alone stay a menu.
    render(
      <PanelChrome
        panelTitle="Chat"
        leading={<span>Chat</span>}
        controls={{
          onCollapse: () => undefined,
          onClose: () => undefined,
          onDock: () => undefined,
        }}
      />,
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Chat panel actions" }),
      { button: 0, ctrlKey: false },
    );
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
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

  it("lists a tenant's own menu items after the Dock group", () => {
    const onRename = vi.fn();
    render(
      <PanelChrome
        tenant={{ id: "workpads", title: "Workpads", icon: NotepadIcon }}
        controls={{
          ...noControls,
          renderMenuItems: (
            <>
              <DropdownMenuItem onSelect={onRename}>Rename…</DropdownMenuItem>
              <DropdownMenuItem>Archive</DropdownMenuItem>
            </>
          ),
        }}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Workpads panel actions" }),
      { button: 0, ctrlKey: false },
    );
    expect(menuRows(screen.getByRole("menu"))).toEqual([
      "Left",
      "Right",
      "Top",
      "Bottom",
      "—",
      "Rename…",
      "Archive",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the panel menu for tenant items on single-pane layouts, as a sheet without docking", () => {
    singlePane = true;
    const onRename = vi.fn();
    render(
      <PanelChrome
        tenant={{ id: "workpads", title: "Workpads", icon: NotepadIcon }}
        controls={{
          ...noControls,
          renderMenuItems: (
            <DropdownMenuItem onSelect={onRename}>Rename…</DropdownMenuItem>
          ),
        }}
      />,
    );

    // A sheet opens on click, as a button does.
    fireEvent.click(screen.getByRole("button", { name: "Workpads panel actions" }));
    // Nothing to dock beside, so no Dock group or separator: just the items,
    // in the touch sheet a single-pane layout always uses.
    expect(menuRows(screen.getByRole("dialog", { name: "Workpads panel" }))).toEqual(["Rename…"]);
    expect(screen.queryByRole("group", { name: "Dock" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("keeps content ids safe for DOM use", () => {
    expect(panelContentId("files/a b")).toBe(
      "workspace-panel-content-files_a_b",
    );
  });
});
