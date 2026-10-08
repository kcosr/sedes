// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSidebarSearchShortcut } from "./sidebar-search-shortcut.js";

const shown = new WeakSet<Element>();
const show = (element: Element) => shown.add(element);

function searchInput(container: HTMLElement, value = "previous query"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "search";
  input.setAttribute("data-sidebar-search", "");
  input.value = value;
  container.append(input);
  return input;
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("installSidebarSearchShortcut", () => {
  let uninstall: () => void;
  let reveal: ReturnType<typeof vi.fn<() => void>>;
  let available: boolean;

  beforeEach(() => {
    // jsdom has no layout; elements the test marks as shown report a box.
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      return { length: shown.has(this) ? 1 : 0 } as DOMRectList;
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(0));
      return 0;
    });
    available = true;
    reveal = vi.fn<() => void>();
    uninstall = installSidebarSearchShortcut(window, {
      isAvailable: () => available,
      reveal,
      drawerId: "drawer",
    });
  });

  afterEach(() => {
    uninstall();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])("focuses and selects the visible sidebar search (%o)", (modifier) => {
    const hidden = searchInput(document.body, "hidden copy");
    const visible = searchInput(document.body);
    show(visible);
    const event = press(document.body, { key: "F", shiftKey: true, ...modifier });
    expect(event.defaultPrevented).toBe(true);
    expect(reveal).toHaveBeenCalledOnce();
    expect(visible).toHaveFocus();
    expect(hidden).not.toHaveFocus();
    expect([visible.selectionStart, visible.selectionEnd]).toEqual([0, visible.value.length]);
  });

  it("waits for a revealed sidebar or drawer to render its search", async () => {
    const input = searchInput(document.body);
    reveal.mockImplementation(() => queueMicrotask(() => show(input)));
    press(document.body, { key: "f", ctrlKey: true, shiftKey: true });
    expect(input).not.toHaveFocus();
    await vi.waitFor(() => expect(input).toHaveFocus());
  });

  it("skips inert or hidden copies", () => {
    const inert = document.createElement("div");
    inert.setAttribute("inert", "");
    document.body.append(inert);
    const retained = searchInput(inert);
    show(retained);
    const visible = searchInput(document.body);
    show(visible);
    press(document.body, { key: "F", ctrlKey: true, shiftKey: true });
    expect(visible).toHaveFocus();
  });

  it("leaves plain Ctrl+F, other chords, and handled keys alone", () => {
    const input = searchInput(document.body);
    show(input);
    for (const init of [
      { key: "f", ctrlKey: true },
      { key: "F", shiftKey: true },
      { key: "F", ctrlKey: true, metaKey: true, shiftKey: true },
      { key: "F", ctrlKey: true, altKey: true, shiftKey: true },
      { key: "F", ctrlKey: true, shiftKey: true, repeat: true },
    ]) {
      expect(press(document.body, init).defaultPrevented).toBe(false);
    }
    const handled = new KeyboardEvent("keydown", { key: "F", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(reveal).not.toHaveBeenCalled();
    expect(input).not.toHaveFocus();
  });

  it("does nothing while the sidebar shows something other than the inventory", () => {
    available = false;
    const input = searchInput(document.body);
    show(input);
    expect(press(document.body, { key: "F", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
    expect(input).not.toHaveFocus();
  });

  it("lets dialogs keep the key, except the navigation drawer", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const field = document.createElement("input");
    dialog.append(field);
    const drawer = document.createElement("div");
    drawer.setAttribute("role", "dialog");
    drawer.id = "drawer";
    const input = searchInput(drawer);
    show(input);
    document.body.append(dialog, drawer);

    expect(press(field, { key: "F", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(reveal).not.toHaveBeenCalled();

    expect(press(input, { key: "F", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(input).toHaveFocus();
  });
});
