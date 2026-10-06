// @vitest-environment jsdom

import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityList, EntityRow } from "./EntityList.js";
import { SettingsSearch } from "./SettingsSearch.js";
import { SettingsBackLink, SettingsBackSlotContext, SettingsPage } from "./SettingsPage.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingsDetailHeader, SettingsEditor, SettingsSplit } from "./SettingsSplit.js";
import { useSettingsSplitFocus, type SettingsSplitLocation } from "./use-settings-split-focus.js";

afterEach(cleanup);

describe("SettingsSplit", () => {
  it("names the list pane and puts the selection in the detail pane", () => {
    render(
      <SettingsPage title="Agents" width="wide" selection="detail">
        <SettingsSplit listLabel="Saved Agents" list={<p>Rows</p>} wide>
          <SettingsDetailHeader back={<SettingsBackLink stackOnly href="/settings/agents" label="Agents" />} title="Reviewer"
            tags={<span>Pi</span>} status={<span>Ready</span>} actions={<button type="button">Edit</button>} />
        </SettingsSplit>
      </SettingsPage>,
    );
    const page = screen.getByRole("heading", { name: "Agents", level: 1 }).closest('[data-slot="settings-page"]');
    expect(page).toHaveAttribute("data-selection", "detail");
    const list = screen.getByRole("region", { name: "Saved Agents" });
    expect(list).toHaveAttribute("data-slot", "settings-split-list");
    expect(list).toHaveTextContent("Rows");
    const split = list.parentElement!;
    expect(split).toHaveAttribute("data-slot", "settings-split");
    expect(split).toHaveAttribute("data-wide", "true");
    const heading = screen.getByRole("heading", { name: "Reviewer", level: 2 });
    expect(heading.closest('[data-slot="settings-split-detail"]')).not.toBeNull();
    expect(heading).toHaveAttribute("data-detail-heading");
    expect(heading).toHaveAttribute("tabindex", "-1");
    // The "‹" link is for the stack only; the list is the way back beside it.
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("data-stack-only", "true");
    expect(within(screen.getByRole("group", { name: "Actions" })).getByRole("button", { name: "Edit" })).toBeVisible();
  });

  it("leaves a page without a split unmarked, and a back link without stackOnly always shown", () => {
    render(
      <SettingsPage title="General" back={{ label: "Settings", href: "/settings" }}>
        <p>Body</p>
      </SettingsPage>,
    );
    expect(screen.getByRole("heading", { name: "General" }).closest('[data-slot="settings-page"]')).not.toHaveAttribute("data-selection");
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("data-stack-only");
  });

  it("marks an empty inventory, whose detail pane holds the empty state", () => {
    const { rerender } = render(<SettingsSplit listLabel="Saved Agents" list={null} empty><p>No Agents yet</p></SettingsSplit>);
    const split = screen.getByRole("region", { name: "Saved Agents" }).parentElement!;
    expect(split).toHaveAttribute("data-empty", "true");
    expect(screen.getByText("No Agents yet").closest('[data-slot="settings-split-detail"]')).not.toBeNull();
    rerender(<SettingsSplit listLabel="Saved Agents" list={<p>Rows</p>}><p>Select an Agent</p></SettingsSplit>);
    expect(split).not.toHaveAttribute("data-empty");
  });

  it("renders a back link in the compact header's slot when one is provided", () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    render(
      <SettingsBackSlotContext.Provider value={slot}>
        <SettingsPage title="Environments"><SettingsBackLink stackOnly href="/settings/environments" label="Environments" /></SettingsPage>
      </SettingsBackSlotContext.Provider>,
    );
    const link = screen.getByRole("link", { name: "Environments" });
    expect(slot).toContainElement(link);
    expect(link.closest('[data-slot="settings-page"]')).toBeNull();
    slot.remove();
  });
});

describe("SettingsEditor", () => {
  it("frames sections with anchors, errors and the save bar in one form", () => {
    const onSubmit = vi.fn();
    render(
      <SettingsEditor label="Agent editor" title="Create Agent" description="Not saved yet."
        sections={[{ id: "one", label: "One" }, { id: "two", label: "Two" }]}
        errors={<p role="alert">Fix it</p>} onSubmit={onSubmit} saveBar={<button type="submit">Save</button>}>
        <SettingsSection id="one" title="One"><p>First</p></SettingsSection>
        <SettingsSection id="two" title="Two"><p>Second</p></SettingsSection>
      </SettingsEditor>,
    );
    const editor = screen.getByRole("region", { name: "Agent editor" });
    expect(within(editor).getByRole("heading", { name: "Create Agent", level: 2 })).toBeVisible();
    expect(within(editor).getByRole("alert")).toHaveTextContent("Fix it");
    const anchors = within(editor).getByRole("navigation", { name: "Editor sections" });
    expect(within(anchors).getAllByRole("button").map(button => button.textContent)).toEqual(["One", "Two"]);
    expect(within(anchors).getByRole("button", { name: "One" })).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("titles a top-level page at level 1 and follows its sections in the page's own scroller", () => {
    const roots: (Element | Document | null | undefined)[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        roots.push(options?.root);
      }
      observe(): void {}
      disconnect(): void {}
    });
    try {
      render(
        <div data-testid="page-scroller" style={{ overflowY: "auto" }}>
          <SettingsEditor label="Automation editor" title="Edit automation" headingLevel={1}
            sections={[{ id: "one", label: "One" }, { id: "two", label: "Two" }]} onSubmit={vi.fn()} saveBar={null}>
            <SettingsSection id="one" title="One"><p>First</p></SettingsSection>
            <SettingsSection id="two" title="Two"><p>Second</p></SettingsSection>
          </SettingsEditor>
        </div>,
      );
      expect(screen.getByRole("heading", { name: "Edit automation", level: 1 })).toBeVisible();
      expect(roots).toEqual([screen.getByTestId("page-scroller"), screen.getByTestId("page-scroller")]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops the anchors for a single section", () => {
    render(
      <SettingsEditor label="Editor" title="Edit" sections={[{ id: "only", label: "Only" }]} onSubmit={vi.fn()} saveBar={null}>
        <SettingsSection id="only" title="Only"><p>Only</p></SettingsSection>
      </SettingsEditor>,
    );
    expect(screen.queryByRole("navigation", { name: "Editor sections" })).toBeNull();
  });
});

describe("SettingsSearch", () => {
  it("is a named search field that reports its value", () => {
    const onValueChange = vi.fn();
    render(<SettingsSearch label="Search Agents" maxLength={160} value="" onValueChange={onValueChange} />);
    const field = screen.getByRole("searchbox", { name: "Search Agents" });
    expect(field).toHaveAttribute("maxlength", "160");
    expect(field).toHaveAttribute("placeholder", "Search…");
    fireEvent.change(field, { target: { value: "review" } });
    expect(onValueChange).toHaveBeenCalledWith("review");
  });
});

describe("useSettingsSplitFocus", () => {
  function Inventory({ initial }: { readonly initial: SettingsSplitLocation }) {
    const root = useRef<HTMLDivElement>(null);
    const [location, setLocation] = useState<SettingsSplitLocation | undefined>(initial);
    const selected = location?.resourceId;
    useSettingsSplitFocus({ root, location });
    return (
      <div className="settings-content" style={{ overflow: "auto" }}>
        <div ref={root}>
          <SettingsPage title="Agents" width="wide" selection={selected ? "editor" : "none"}>
            <SettingsSplit listLabel="Saved Agents" list={
              <EntityList>
                {["a", "b"].map(id => <EntityRow key={id} data-resource-id={id} title={`Agent ${id}`}
                  onSelect={() => setLocation({ path: `/agents/${id}`, resourceId: id, mode: "view" })} />)}
              </EntityList>
            }>
              {selected ? <SettingsDetailHeader title={`Editing ${selected}`} /> : <p>Select one</p>}
            </SettingsSplit>
          </SettingsPage>
          <button type="button" onClick={() => setLocation({ path: "/agents" })}>Up</button>
          <button type="button" onClick={() => setLocation(undefined)}>Elsewhere</button>
        </div>
      </div>
    );
  }

  it("focuses the page heading on arrival and the selection's heading on a route change", () => {
    render(<Inventory initial={{ path: "/agents/b", resourceId: "b", mode: "view" }} />);
    expect(screen.getByRole("heading", { name: "Editing b" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    // Back at the list, focus returns to the row of the entity just left.
    expect(screen.getByRole("button", { name: "Agent b" })).toHaveFocus();
  });

  it("keeps focus on a list row that stays beside the selection", () => {
    render(<Inventory initial={{ path: "/agents" }} />);
    expect(screen.getByRole("heading", { name: "Agents", level: 1 })).toHaveFocus();
    const row = screen.getByRole("button", { name: "Agent a" });
    act(() => row.focus());
    fireEvent.click(row);
    expect(screen.getByRole("heading", { name: "Editing a" })).toBeVisible();
    expect(row).toHaveFocus();
  });

  it("restores the list's scroll position and starts a selection at the top", () => {
    const { container } = render(<Inventory initial={{ path: "/agents" }} />);
    const scroller = container.querySelector<HTMLElement>(".settings-content")!;
    scroller.scrollTop = 120;
    fireEvent.click(screen.getByRole("button", { name: "Agent a" }));
    expect(scroller.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(scroller.scrollTop).toBe(120);
    // Another page in between makes coming back a fresh arrival.
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(screen.getByRole("heading", { name: "Agents", level: 1 })).toHaveFocus();
  });
});
