// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import postcss from "postcss";
import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";
import type { MenuPresentation } from "./menu-sheet.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "./dialog.js";

/**
 * jsdom runs no CSS animations, so Radix unmounts closed content at once.
 * Report overlay.css's motion names for the content's state instead, so a
 * closed layer stays mounted "animating out" as it does in a browser.
 */
function simulateExitMotion(): void {
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    if (!(element instanceof HTMLElement) || (!element.dataset.slot?.endsWith("content") && element.dataset.slot !== "dialog-overlay")) {
      return style;
    }
    return new Proxy(style, {
      get(target, property) {
        if (property === "animationName") {
          return element.dataset.state === "closed" ? "ui-pop-out" : "ui-pop-in";
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  });
  simulateExitMotion();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Ends a closed layer's exit motion, as the browser's animationend does. */
function finishExitMotion(element: Element): void {
  const end = new Event("animationend");
  Object.defineProperty(end, "animationName", { value: "ui-pop-out" });
  act(() => {
    element.dispatchEvent(end);
  });
}

/** A primary-button press (Radix dropdowns open on pointer down, popovers on click). */
function press(element: Element): void {
  fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
  fireEvent.click(element, { button: 0 });
}

/** A secondary click, as a context menu opens. */
function secondaryClick(element: Element): void {
  fireEvent.pointerDown(element, { button: 2, pointerType: "mouse" });
  fireEvent.contextMenu(element, { button: 2 });
}

/**
 * Lets timers queued by the last interaction run: Radix attaches a layer's
 * outside-press listener, and restores focus for an unmounted layer, on the
 * next tick.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function ViewOptions({
  modal,
  presentation = "menu",
  onOpenChange,
}: {
  readonly modal?: boolean;
  readonly presentation?: MenuPresentation;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu modal={modal} presentation={presentation} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger>View options</DropdownMenuTrigger>
      <DropdownMenuContent aria-label="View options" sheetTitle="View options">
        <DropdownMenuItem>Compact</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("reopening a floating surface during its exit motion", () => {
  it.each([false, true])("reopens a controlled dialog without a stale dismissal or focus restoration (modal: %s)", async (modal) => {
    // jsdom has no PointerEvent; give Radix a real primary button so it
    // exercises its deferred document-click dismissal path.
    vi.stubGlobal("PointerEvent", MouseEvent);
    const onOpenChange = vi.fn();
    const onInteractOutside = vi.fn();
    const onCloseAutoFocus = vi.fn((event: Event) => {
      event.preventDefault();
      target.current?.focus();
    });
    const target = { current: null as HTMLButtonElement | null };
    const content = { current: null as HTMLDivElement | null };
    function Harness() {
      const [open, setOpen] = useState(false);
      const change = (next: boolean) => {
        onOpenChange(next);
        setOpen(next);
      };
      return <>
        {/* Flush before the native document listener, as a browser's discrete
            React click does, rather than jsdom's whole-event act batching. */}
        <button ref={target} onClick={() => flushSync(() => change(true))}>Resolve conflict</button>
        <Dialog open={open} onOpenChange={change} modal={modal}>
          <DialogContent ref={content} aria-describedby={undefined} onInteractOutside={onInteractOutside} onCloseAutoFocus={onCloseAutoFocus}>
            <DialogTitle>File changed</DialogTitle>
            <input aria-label="Resolution" />
            <DialogClose>Keep editing</DialogClose>
          </DialogContent>
        </Dialog>
      </>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Resolve conflict" });
    press(trigger);
    await settle();
    const closing = screen.getByRole("dialog", { name: "File changed" });
    expect(document.body.style.pointerEvents).toBe(modal ? "none" : "");
    press(screen.getByRole("button", { name: "Keep editing" }));
    expect(closing).toHaveAttribute("data-state", "closed");
    expect(closing.style.pointerEvents).toBe("none");
    expect(document.body.style.pointerEvents).toBe("");
    if (modal) expect(screen.getByTestId("dialog-overlay").style.pointerEvents).toBe("none");

    // The old layer sees this pointerdown outside, then defers dismissal to
    // document click, after the button has reopened the controlled dialog.
    press(trigger);
    await settle();
    const reopened = screen.getByRole("dialog", { name: "File changed" });
    expect(reopened).toHaveAttribute("data-state", "open");
    expect(document.body.style.pointerEvents).toBe(modal ? "none" : "");
    expect(reopened.style.pointerEvents).toBe(modal ? "auto" : "");
    if (modal) expect(screen.getByTestId("dialog-overlay").style.pointerEvents).toBe("auto");
    expect(reopened).not.toBe(closing);
    expect(closing).not.toBeInTheDocument();
    expect(content.current).toBe(reopened);
    expect(screen.getByRole("textbox", { name: "Resolution" })).toHaveFocus();
    expect(onOpenChange.mock.calls).toEqual([[true], [false], [true]]);
    expect(onInteractOutside).not.toHaveBeenCalled();
    expect(onCloseAutoFocus).not.toHaveBeenCalled();

    // The live opening still dismisses normally and runs the caller's focus
    // restoration once its own exit finishes.
    fireEvent.keyDown(reopened, { key: "Escape" });
    finishExitMotion(reopened);
    await settle();
    expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
    expect(content.current).toBeNull();
  });

  it.each([false, true])("reopens an uncontrolled dialog from its trigger (defaultOpen: %s)", async (defaultOpen) => {
    const onOpenChange = vi.fn();
    render(<Dialog defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <DialogTrigger>Open details</DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Details</DialogTitle>
        <input aria-label="Detail name" />
      </DialogContent>
    </Dialog>);
    const trigger = screen.getByRole("button", { name: "Open details", hidden: true });
    if (!defaultOpen) press(trigger);
    await settle();
    const closing = screen.getByRole("dialog", { name: "Details" });
    fireEvent.keyDown(closing, { key: "Escape" });
    expect(closing).toHaveAttribute("data-state", "closed");
    press(trigger);
    await settle();
    const reopened = screen.getByRole("dialog", { name: "Details" });
    expect(reopened).toHaveAttribute("data-state", "open");
    expect(reopened).not.toBe(closing);
    expect(screen.getByRole("textbox", { name: "Detail name" })).toHaveFocus();
    expect(onOpenChange.mock.calls).toEqual(defaultOpen ? [[false], [true]] : [[true], [false], [true]]);
    fireEvent.keyDown(reopened, { key: "Escape" });
    finishExitMotion(reopened);
    await settle();
    expect(trigger).toHaveFocus();
  });

  it("keeps a nested dialog's reopening independent from its non-dismissible parent", async () => {
    const parentChange = vi.fn();
    render(<Dialog defaultOpen onOpenChange={parentChange}>
      <DialogContent dismissible={false} aria-describedby={undefined}>
        <DialogTitle>Editor</DialogTitle>
        <Dialog>
          <DialogTrigger>Resolve conflict</DialogTrigger>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>File changed</DialogTitle>
            <input aria-label="Resolution" />
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>);
    const parent = screen.getByRole("dialog", { name: "Editor" });
    const trigger = screen.getByRole("button", { name: "Resolve conflict" });
    press(trigger);
    await settle();
    const closing = screen.getByRole("dialog", { name: "File changed" });
    fireEvent.keyDown(closing, { key: "Escape" });
    press(trigger);
    await settle();
    const reopened = screen.getByRole("dialog", { name: "File changed" });
    expect(reopened).not.toBe(closing);
    expect(reopened).toHaveAttribute("data-state", "open");
    expect(screen.getByRole("textbox", { name: "Resolution" })).toHaveFocus();
    expect(parent).toHaveAttribute("data-state", "open");
    expect(parentChange).not.toHaveBeenCalled();
    fireEvent.keyDown(reopened, { key: "Escape" });
    finishExitMotion(reopened);
    await settle();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(parent, { key: "Escape" });
    expect(parentChange).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reopens a dropdown menu from its trigger with fresh content (modal: %s)",
    async (modal) => {
      const onOpenChange = vi.fn();
      render(<ViewOptions modal={modal} onOpenChange={onOpenChange} />);
      const trigger = screen.getByRole("button", { name: "View options", hidden: true });
      press(trigger);
      await settle();
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Compact" }), { key: "Enter" });
      const closing = screen.getByRole("menu", { name: "View options", hidden: true });
      expect(closing).toHaveAttribute("data-state", "closed");
      expect(onOpenChange.mock.calls).toEqual([[true], [false]]);

      press(trigger);
      const reopened = screen.getByRole("menu", { name: "View options" });
      expect(reopened).toHaveAttribute("data-state", "open");
      // A new opening mounts its own content and drops the fading one.
      expect(reopened).not.toBe(closing);
      expect(closing).not.toBeInTheDocument();
      expect(reopened).toHaveFocus();
      // The replaced layer neither closed the reopened menu nor pulled focus
      // back to the trigger when it went.
      await settle();
      expect(reopened).toHaveAttribute("data-state", "open");
      expect(reopened).toHaveFocus();
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(onOpenChange.mock.calls).toEqual([[true], [false], [true]]);
    },
  );

  it("still closes an open dropdown menu on an outside press", async () => {
    render(
      <>
        <ViewOptions modal={false} />
        <button type="button">Elsewhere</button>
      </>,
    );
    press(screen.getByRole("button", { name: "View options" }));
    await settle();
    const menu = screen.getByRole("menu", { name: "View options" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }), {
      button: 0,
      pointerType: "mouse",
    });
    expect(menu).toHaveAttribute("data-state", "closed");
  });

  it("returns focus to the trigger when a menu closes without a new opening", async () => {
    render(<ViewOptions />);
    const trigger = screen.getByRole("button", { name: "View options" });
    press(trigger);
    await settle();
    const menu = screen.getByRole("menu", { name: "View options" });
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(menu).toHaveAttribute("data-state", "closed");
    finishExitMotion(menu);
    await settle();
    expect(menu).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("reopens a context menu at its trigger with fresh content", async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Thread row</ContextMenuTrigger>
        <ContextMenuContent aria-label="Thread menu">
          <ContextMenuItem>Rename</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const row = screen.getByText("Thread row");
    secondaryClick(row);
    await settle();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Rename" }), { key: "Enter" });
    const closing = screen.getByRole("menu", { name: "Thread menu", hidden: true });
    expect(closing).toHaveAttribute("data-state", "closed");

    secondaryClick(row);
    await settle();
    const reopened = screen.getByRole("menu", { name: "Thread menu" });
    expect(reopened).toHaveAttribute("data-state", "open");
    expect(reopened).not.toBe(closing);
    expect(reopened).toHaveFocus();
  });

  it("reopens a popover with fresh content that takes focus", async () => {
    render(
      <Popover>
        <PopoverTrigger>Saved prompts</PopoverTrigger>
        <PopoverContent aria-label="Saved prompts">
          <input aria-label="Search saved prompts" />
        </PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole("button", { name: "Saved prompts" });
    press(trigger);
    await settle();
    const search = screen.getByRole("textbox", { name: "Search saved prompts" });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Escape" });
    const closing = screen.getByRole("dialog", { name: "Saved prompts", hidden: true });
    expect(closing).toHaveAttribute("data-state", "closed");

    press(trigger);
    const reopened = screen.getByRole("dialog", { name: "Saved prompts" });
    expect(reopened).toHaveAttribute("data-state", "open");
    expect(reopened).not.toBe(closing);
    await settle();
    expect(screen.getByRole("textbox", { name: "Search saved prompts" })).toHaveFocus();
  });

  it("leaves focus where a press during the exit put it", async () => {
    render(
      <>
        <Popover>
          <PopoverTrigger>Project filter</PopoverTrigger>
          <PopoverContent aria-label="Projects">
            <input aria-label="Search projects" />
          </PopoverContent>
        </Popover>
        <input aria-label="Thread name" />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Project filter" });
    press(trigger);
    await settle();
    const search = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.keyDown(search, { key: "Escape" });
    const closing = screen.getByRole("dialog", { name: "Projects", hidden: true });
    expect(closing).toHaveAttribute("data-state", "closed");
    await settle();
    // While the popover fades out, a press elsewhere moves focus (a dialog
    // opening, a field taking focus).
    const threadName = screen.getByRole("textbox", { name: "Thread name" });
    press(threadName);
    act(() => threadName.focus());
    await settle();
    finishExitMotion(closing);
    await settle();
    expect(closing).not.toBeInTheDocument();
    expect(threadName).toHaveFocus();
  });

  it("reopens a menu sheet from its trigger with fresh content", async () => {
    render(<ViewOptions presentation="sheet" />);
    const trigger = screen.getByRole("button", { name: "View options", hidden: true });
    press(trigger);
    await settle();
    fireEvent.click(screen.getByRole("menuitem", { name: "Compact" }));
    const closing = screen.getByRole("dialog", { name: "View options", hidden: true });
    expect(closing).toHaveAttribute("data-state", "closed");

    press(trigger);
    const reopened = screen.getByRole("dialog", { name: "View options" });
    expect(reopened).toHaveAttribute("data-state", "open");
    expect(reopened).not.toBe(closing);
    await settle();
    expect(reopened).toHaveAttribute("data-state", "open");
    expect(reopened).toContainElement(document.activeElement as HTMLElement);
  });
});

describe("closing surfaces in overlay.css", () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "overlay.css");
  const rules: { selector: string; props: Record<string, string> }[] = [];
  postcss.parse(readFileSync(file, "utf8"), { from: file }).walkRules((rule) => {
    const props: Record<string, string> = {};
    rule.walkDecls((decl) => {
      props[decl.prop] = decl.value;
    });
    for (const selector of rule.selectors) rules.push({ selector, props });
  });
  const declared = (selector: string, prop: string) =>
    rules.find((rule) => rule.selector === selector && prop in rule.props)?.props[prop];

  it("lets the pointer pass through closing dialogs and floating surfaces", () => {
    for (const selector of [
      '[data-slot="dialog-overlay"][data-state="closed"]',
      '[data-slot="dialog-content"][data-state="closed"]',
      '[data-radix-popper-content-wrapper]:has(> [data-state="closed"])',
    ]) {
      expect(declared(selector, "pointer-events"), selector).toBe("none");
    }
  });

  it("gives select content no exit motion, since it holds the page inert until it unmounts", () => {
    expect(
      rules.some(
        (rule) =>
          rule.selector.includes('[data-slot="select-content"][data-state="closed"]') &&
          "animation" in rule.props,
      ),
    ).toBe(false);
    expect(declared('[data-slot="select-content"][data-state="open"]', "animation")).toContain(
      "ui-pop-in",
    );
  });
});
