// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import {
  PanelChrome,
  panelContentId,
  type PanelChromeControls,
  type PanelRegionControls,
} from "./PanelChrome.js";
import type { RegionId } from "./regions.js";

function FileIcon(): React.JSX.Element {
  return <svg aria-hidden="true" />;
}

function NotepadIcon(): React.JSX.Element {
  return <svg data-testid="tenant-icon" aria-hidden="true" />;
}

function regionControls(
  region: RegionId,
  overrides: Partial<PanelRegionControls> = {},
): PanelRegionControls {
  return {
    region,
    maximized: false,
    onMaximize: vi.fn(),
    onRestore: vi.fn(),
    onMove: vi.fn(),
    onExtend: vi.fn(),
    ...overrides,
  };
}

function controls(overrides: Partial<PanelChromeControls> = {}): PanelChromeControls {
  return { onClose: () => undefined, ...overrides };
}

/** Each row of an open menu in order, separators included. */
function menuRows(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll("[role^=menuitem], [role=separator]")].map(
    (row) => (row.getAttribute("role") === "separator" ? "—" : row.textContent ?? ""),
  );
}

function openActions(title: string): void {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `${title} panel actions` }),
    { button: 0, ctrlKey: false },
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
        controls={controls()}
      />,
    );

    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
    expect(screen.getByLabelText("Busy")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("offers Maximize, ⋯ and ✕, and no collapse button", () => {
    const onClose = vi.fn();
    const region = regionControls("right");
    render(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        controls={controls({ onClose, region })}
      />,
    );

    const header = screen.getByRole("banner", { name: "Files panel header" });
    expect(
      within(header).getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Maximize Files panel", "Files panel actions", "Close Files panel"]);
    expect(screen.queryByRole("button", { name: /Collapse/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Maximize Files panel" }));
    expect(region.onMaximize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close Files panel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
  });

  it("turns Maximize into Restore while maximized", () => {
    const region = regionControls("middle", { maximized: true });
    render(
      <PanelChrome
        panelTitle="Chat"
        leading={<span>Thread title</span>}
        controls={controls({ region })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore Chat panel" }));
    expect(region.onRestore).toHaveBeenCalledOnce();
    expect(region.onMaximize).not.toHaveBeenCalled();
  });

  it("names Chat's ✕ for what it does: it hides Chat", () => {
    const onClose = vi.fn();
    render(
      <PanelChrome
        panelTitle="Chat"
        leading={<span>Thread title</span>}
        controls={controls({ onClose, closeAction: "hide" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide Chat panel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Close Chat panel" })).toBeNull();
  });

  it("keeps panel-specific controls to the left of common panel controls", () => {
    render(
      <PanelChrome
        panelTitle="Chat"
        leading={<span>Thread title</span>}
        panelActions={<button>Find</button>}
        controls={controls({ region: regionControls("middle") })}
      />,
    );

    const header = screen.getByRole("banner", { name: "Chat panel header" });
    expect(header.textContent).toContain("Thread titleFind");
    expect(screen.getByRole("button", { name: "Chat panel actions" })).toBeTruthy();
    expect(header.querySelector(".lucide-ellipsis-vertical")).not.toBeNull();
    expect(header.querySelector(".lucide-ellipsis")).toBeNull();
  });

  it("checks the current region in Move to and moves only to another", () => {
    const region = regionControls("right");
    render(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        controls={controls({ region })}
      />,
    );

    openActions("Files");
    const moveTo = screen.getByRole("group", { name: "Move to" });
    const regions = within(moveTo).getAllByRole("menuitemradio");
    expect(regions.map((item) => item.textContent)).toEqual([
      "Middle",
      "Left",
      "Right",
      "Top",
      "Bottom",
    ]);
    expect(regions.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
      "false",
      "false",
    ]);

    // The current region is a no-op; another moves the panel there.
    fireEvent.click(within(moveTo).getByRole("menuitemradio", { name: "Right" }));
    expect(region.onMove).not.toHaveBeenCalled();
    openActions("Files");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Bottom" }));
    expect(region.onMove).toHaveBeenCalledExactlyOnceWith("bottom");
  });

  it.each([
    ["left", "Full height", true],
    ["right", "Full height", false],
    ["top", "Full width", false],
    ["bottom", "Full width", true],
  ] as const)(
    "offers the %s region's corner toggle as %s",
    (edge, label, extended) => {
      const region = regionControls(edge, { extended });
      render(
        <PanelChrome
          tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
          controls={controls({ region })}
        />,
      );
      openActions("Files");
      const toggle = screen.getByRole("menuitemcheckbox", { name: label });
      expect(toggle).toHaveAttribute("aria-checked", String(extended));
      fireEvent.click(toggle);
      expect(region.onExtend).toHaveBeenCalledExactlyOnceWith(!extended);
    },
  );

  it("offers no corner toggle in the Middle", () => {
    render(
      <PanelChrome
        panelTitle="Chat"
        leading={<span>Chat</span>}
        controls={controls({ region: regionControls("middle") })}
      />,
    );
    openActions("Chat");
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
    expect(menuRows(screen.getByRole("menu"))).toEqual([
      "Middle",
      "Left",
      "Right",
      "Top",
      "Bottom",
    ]);
  });

  it("lists a tenant's own menu items after Move to and the corner toggle", () => {
    const onRename = vi.fn();
    render(
      <PanelChrome
        tenant={{ id: "workpads", title: "Workpads", icon: NotepadIcon }}
        controls={controls({
          region: regionControls("right", { extended: true }),
          renderMenuItems: (
            <>
              <DropdownMenuItem onSelect={onRename}>Rename…</DropdownMenuItem>
              <DropdownMenuItem>Archive</DropdownMenuItem>
            </>
          ),
        })}
      />,
    );

    openActions("Workpads");
    expect(menuRows(screen.getByRole("menu"))).toEqual([
      "Middle",
      "Left",
      "Right",
      "Top",
      "Bottom",
      "—",
      "Full height",
      "—",
      "Rename…",
      "Archive",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("presents Move to with panel items as a sheet on touch, and alone as a menu", () => {
    coarsePointer = true;
    const region = regionControls("bottom");
    render(
      <PanelChrome
        panelTitle="Terminals"
        leading={<span>Terminals</span>}
        controls={controls({
          region,
          renderMenuItems: <DropdownMenuItem>Transcript</DropdownMenuItem>,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Terminals panel actions" }));
    const sheet = screen.getByRole("dialog", { name: "Terminals panel" });
    expect(
      within(sheet).getByRole("menuitemradio", { name: "Bottom" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(sheet).getByRole("menuitemradio", { name: "Left" }));
    expect(region.onMove).toHaveBeenCalledExactlyOnceWith("left");
    cleanup();

    render(
      <PanelChrome
        panelTitle="Chat"
        leading={<span>Chat</span>}
        controls={controls({ region: regionControls("middle") })}
      />,
    );
    openActions("Chat");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("drops Maximize and Move to on single-pane layouts", () => {
    singlePane = true;
    const { rerender } = render(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        controls={controls({ region: regionControls("right") })}
      />,
    );

    // Close still applies; Maximize and the Move to-only menu go away.
    expect(screen.queryByRole("button", { name: "Files panel actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Maximize Files panel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close Files panel" })).toBeTruthy();

    // A tenant with its own items still needs somewhere to put them.
    rerender(
      <PanelChrome
        tenant={{ id: "workspace-files", title: "Files", icon: FileIcon }}
        controls={controls({
          region: regionControls("right"),
          renderMenuItems: <DropdownMenuItem>Reveal</DropdownMenuItem>,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Files panel actions" }));
    // Nothing to place beside, so no Move to or separator: just the items,
    // in the touch sheet a single-pane layout always uses.
    expect(menuRows(screen.getByRole("dialog", { name: "Files panel" }))).toEqual([
      "Reveal",
    ]);
    expect(screen.queryByRole("group", { name: "Move to" })).toBeNull();
  });

  it("keeps content ids safe for DOM use", () => {
    expect(panelContentId("files/a b")).toBe("workspace-panel-content-files_a_b");
  });
});
