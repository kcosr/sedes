// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchableSelect, type SearchableSelectOption } from "./searchable-select.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import { Dialog, DialogContent, DialogTitle } from "./dialog.js";

const options: readonly SearchableSelectOption[] = [
  { value: "all", label: "All", pinned: true },
  { value: "ungrouped", label: "Ungrouped", pinned: true },
  { value: "local", label: "Local project", searchTerms: ["/home/projects/sedes", "Workstation"] },
  { value: "offline", label: "Offline project", disabled: true },
  { value: "remote", label: "Remote project", description: "Build host · Codex", searchTerms: ["/srv/sedes"] },
];

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  });
  Object.assign(window.HTMLElement.prototype, { scrollIntoView: vi.fn() });
});

afterEach(() => {
  cleanup();
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  vi.unstubAllGlobals();
});

function picker(initialOptions = options, value = "local") {
  const onValueChange = vi.fn();
  const view = (catalog: readonly SearchableSelectOption[]) => <>
    <button>Before picker</button>
    <SearchableSelect label="Project" searchLabel="Search projects" emptyLabel="No matching projects" value={value} options={catalog} onValueChange={onValueChange} />
    <button>After picker</button>
  </>;
  const rendered = render(view(initialOptions));
  return { onValueChange, rerenderOptions: (catalog: readonly SearchableSelectOption[]) => rendered.rerender(view(catalog)) };
}

describe("SearchableSelect", () => {
  it.each(["popover", "dialog"] as const)("opens %s for touch browsing and searches only after tapping the input", async (presentation) => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    render(<SearchableSelect presentation={presentation} label="Project" searchLabel="Search projects" emptyLabel="No matching projects" value="local" options={options} onValueChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox", { name: "Project" });
    await user.pointer([{ keys: "[TouchA>]", target: trigger }, { keys: "[/TouchA]", target: trigger }]);
    const search = screen.getByRole("combobox", { name: "Search projects" });
    expect(search).not.toHaveFocus();
    expect(search.closest('[data-slot="popover-content"], [data-slot="dialog-content"]')).toHaveFocus();
    await user.click(search);
    expect(search).toHaveFocus();
    await user.type(search, "remote");
    expect(screen.getByRole("option", { name: /Remote project/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Local project" })).not.toBeInTheDocument();
  });

  it("focuses search for explicit keyboard opening even on a mobile screen", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    picker();
    screen.getByRole("combobox", { name: "Project" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("combobox", { name: "Search projects" })).toHaveFocus();
  });

  it("mounts an initially open nested popover once inside its dialog", async () => {
    const onOpenAutoFocus = vi.fn();
    render(<Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>New thread</DialogTitle>
      <Popover defaultOpen><PopoverTrigger>Open picker</PopoverTrigger><PopoverContent onOpenAutoFocus={onOpenAutoFocus}><input aria-label="Nested search" /></PopoverContent></Popover>
    </DialogContent></Dialog>);
    await waitFor(() => expect(screen.getByLabelText("Nested search")).toHaveFocus());
    expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "New thread" })).toContainElement(screen.getByLabelText("Nested search"));
  });

  it("keeps popover options in the containing modal scroll boundary", async () => {
    const user = userEvent.setup();
    render(<Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>New thread</DialogTitle>
      <SearchableSelect label="Project" searchLabel="Search projects" emptyLabel="No matching projects" value="local" options={options} onValueChange={vi.fn()} />
    </DialogContent></Dialog>);
    const dialog = screen.getByRole("dialog", { name: "New thread" });
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    const list = screen.getByRole("listbox", { name: "Project options" });
    expect(dialog).toContainElement(list);
    Object.defineProperties(list, { scrollHeight: { value: 800 }, clientHeight: { value: 200 } });
    list.style.overflowY = "auto";
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 });
    list.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it("does not move the active option or scroll it into view during touch swipes", async () => {
    const user = userEvent.setup();
    picker();
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
    const remote = screen.getByRole("option", { name: /Remote project/ });
    const event = new Event("pointermove", { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    fireEvent(remote, event);
    expect(remote).not.toHaveAttribute("data-active");
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("uses the visible selection label for its tooltip", () => {
    render(<SearchableSelect label="Project" searchLabel="Search projects" emptyLabel="No matching projects" value="local" selectedLabel="Current project · Local project" options={options} onValueChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox", { name: "Project" });
    expect(trigger).toHaveTextContent("Current project · Local project");
    expect(trigger).toHaveAttribute("title", "Current project · Local project");
  });
  it("searches in a nested modal and returns focus without dismissing the parent", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const onParentOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onParentOpenChange}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Tasks</DialogTitle>
          <SearchableSelect presentation="dialog" label="Task project" searchLabel="Search projects" emptyLabel="No matching projects" value="local" options={options} onValueChange={onValueChange} />
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole("combobox", { name: "Task project" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Choose task project" })).toHaveClass("searchable-select-dialog");
    const search = screen.getByRole("combobox", { name: "Search projects" });
    expect(search).toHaveFocus();
    await user.type(search, "remote");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Tasks" })).toBeVisible();
    expect(onParentOpenChange).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
    await user.click(trigger);
    expect(screen.getByRole("combobox", { name: "Search projects" })).toHaveValue("");
    await user.type(screen.getByRole("combobox", { name: "Search projects" }), "remote");
    await user.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("remote");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onParentOpenChange).not.toHaveBeenCalled();
  });

  it("updates dialog keyboard space as the visual viewport resizes", async () => {
    const user = userEvent.setup();
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    render(<SearchableSelect presentation="dialog" label="Project" searchLabel="Search projects" emptyLabel="No matching projects" value="local" options={options} onValueChange={vi.fn()} />);
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    const dialog = screen.getByRole("dialog", { name: "Choose project" });
    expect(dialog.style.getPropertyValue("--select-keyboard-inset")).toBe("0px");
    act(() => {
      viewport.height = window.innerHeight - 280;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(dialog.style.getPropertyValue("--select-keyboard-inset")).toBe("280px");
    act(() => {
      viewport.height = window.innerHeight;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(dialog.style.getPropertyValue("--select-keyboard-inset")).toBe("0px");
  });

  it("matches case-insensitive tokens across labels, descriptions and context without selecting", async () => {
    const user = userEvent.setup();
    const { onValueChange } = picker();
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    const search = screen.getByRole("combobox", { name: "Search projects" });
    expect(search).toHaveFocus();
    await user.type(search, " CODEX /SRV remote ");
    expect(screen.getByRole("option", { name: /Remote project.*Build host · Codex/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Local project" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent("Local project");
    expect(onValueChange).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveFocus());
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    expect(screen.getByRole("combobox", { name: "Search projects" })).toHaveValue("");
    expect(screen.getByRole("option", { name: "Local project" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves with arrows, skips disabled options and applies only the active choice on Enter", async () => {
    const user = userEvent.setup();
    const { onValueChange } = picker();
    const trigger = screen.getByRole("combobox", { name: "Project" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const search = screen.getByRole("combobox", { name: "Search projects" });
    await user.keyboard("{ArrowDown}");
    const remote = screen.getByRole("option", { name: /Remote project.*Build host · Codex/ });
    expect(search).toHaveAttribute("aria-activedescendant", remote.id);
    expect(onValueChange).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("remote");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps reset choices reachable but never implicitly applies All for an unmatched query", async () => {
    const user = userEvent.setup();
    const { onValueChange } = picker();
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.type(screen.getByRole("combobox", { name: "Search projects" }), "missing");
    expect(screen.getByRole("status")).toHaveTextContent("No matching projects");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["All", "Ungrouped"]);
    await user.keyboard("{Enter}");
    expect(onValueChange).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("ungrouped");
  });

  it("repairs the active choice when a catalog update removes or disables it", async () => {
    const user = userEvent.setup();
    const { onValueChange, rerenderOptions } = picker();
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.type(screen.getByRole("combobox", { name: "Search projects" }), "project");
    rerenderOptions(options.filter(({ value }) => value !== "local").map((option) => option.value === "remote" ? { ...option, disabled: true } : option));
    await user.keyboard("{Enter}");
    expect(onValueChange).not.toHaveBeenCalled();
    rerenderOptions([...options.filter(({ value }) => value !== "local" && value !== "remote"), { value: "new", label: "New project" }]);
    await user.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("new");
  });

  it.each([false, true])("closes on Tab (shift=%s), advances focus and leaves selection unchanged", async (shift) => {
    const user = userEvent.setup();
    const { onValueChange } = picker();
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.type(screen.getByRole("combobox", { name: "Search projects" }), "remote");
    await user.tab({ shift });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: shift ? "Before picker" : "After picker" })).toHaveFocus();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("opens at the last available option with ArrowUp when nothing is selected", async () => {
    const user = userEvent.setup();
    const { onValueChange } = picker(options, "");
    screen.getByRole("combobox", { name: "Project" }).focus();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("remote");
  });

  it("closes on an outside click without applying search or stealing focus", async () => {
    const user = userEvent.setup();
    const { onValueChange } = picker();
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.type(screen.getByRole("combobox", { name: "Search projects" }), "remote");
    const outside = screen.getByRole("button", { name: "After picker" });
    await user.click(outside);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outside).toHaveFocus();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("ignores Enter during IME composition and disabled option clicks", async () => {
    const user = userEvent.setup();
    const { onValueChange } = picker();
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search projects" }), { key: "Enter", isComposing: true });
    await user.click(screen.getByRole("option", { name: "Offline project" }));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
