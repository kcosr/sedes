// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { navigate, settingsPath } from "../../app/router.js";
import { settingsResourceParent } from "../../app/settings-route.js";
import { ToastProvider, useToast, type ToastControls } from "../ui/toast.js";
import {
  hasOpenLayer,
  isEditingElement,
  settingsEscapeAction,
  settingsUpTarget,
  useSettingsEscape,
  useSettingsEscapeLevel,
  type SettingsEscapeEvent,
} from "./settings-escape.js";

const escape: SettingsEscapeEvent = {
  key: "Escape", isComposing: false, keyCode: 27, altKey: false, ctrlKey: false,
  metaKey: false, shiftKey: false, repeat: false, defaultPrevented: false,
};
const idle = { layerOpen: false, editing: false };

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("settingsEscapeAction", () => {
  it("goes up on a plain Escape with nothing open or edited", () => {
    expect(settingsEscapeAction(escape, idle)).toBe("up");
  });

  it("ignores other keys", () => {
    expect(settingsEscapeAction({ ...escape, key: "Enter" }, idle)).toBe("none");
    expect(settingsEscapeAction({ ...escape, key: "Esc" }, idle)).toBe("none");
  });

  it("leaves an Escape that a layer or control handled alone", () => {
    expect(settingsEscapeAction({ ...escape, defaultPrevented: true }, idle)).toBe("none");
    // Even while a field is focused: the layer or control owns the key.
    expect(settingsEscapeAction({ ...escape, defaultPrevented: true }, { layerOpen: false, editing: true })).toBe("none");
  });

  it("does nothing else while a dialog, menu, picker, popover, sheet or select is open", () => {
    expect(settingsEscapeAction(escape, { layerOpen: true, editing: false })).toBe("none");
    expect(settingsEscapeAction(escape, { layerOpen: true, editing: true })).toBe("none");
  });

  it("only blurs a focused field on the first Escape", () => {
    expect(settingsEscapeAction(escape, { layerOpen: false, editing: true })).toBe("blur");
  });

  it("ignores Escape during composition", () => {
    expect(settingsEscapeAction({ ...escape, isComposing: true }, idle)).toBe("none");
    expect(settingsEscapeAction({ ...escape, keyCode: 229 }, idle)).toBe("none");
    expect(settingsEscapeAction({ ...escape, isComposing: true }, { layerOpen: false, editing: true })).toBe("none");
  });

  it.each(["altKey", "ctrlKey", "metaKey", "shiftKey"] as const)("ignores Escape with %s", (modifier) => {
    expect(settingsEscapeAction({ ...escape, [modifier]: true }, idle)).toBe("none");
    expect(settingsEscapeAction({ ...escape, [modifier]: true }, { layerOpen: false, editing: true })).toBe("none");
  });

  it("never walks several levels while the key is held", () => {
    expect(settingsEscapeAction({ ...escape, repeat: true }, idle)).toBe("none");
    expect(settingsEscapeAction({ ...escape, repeat: true }, { layerOpen: false, editing: true })).toBe("blur");
  });
});

describe("isEditingElement", () => {
  function element(html: string): Element {
    document.body.innerHTML = html;
    return document.body.firstElementChild!;
  }

  it.each([
    "<input>", '<input type="text">', '<input type="search">', '<input type="email">',
    '<input type="number">', '<input type="password">', '<input type="url">', "<textarea></textarea>",
    '<div contenteditable="true"></div>', '<button role="combobox"></button>', '<div role="textbox"></div>',
    '<div role="searchbox"></div>', "<select><option>a</option></select>",
  ])("treats %s as a field", (html) => {
    const target = element(html);
    // jsdom does not implement isContentEditable.
    if (target.hasAttribute("contenteditable")) Object.defineProperty(target, "isContentEditable", { value: true });
    expect(isEditingElement(target)).toBe(true);
  });

  it.each([
    "<button></button>", '<input type="checkbox">', '<input type="radio">', '<input type="range">',
    '<input type="submit">', '<input type="file">', '<a href="/x">x</a>', '<h1 tabindex="-1">x</h1>',
    '<button role="switch"></button>', "<select multiple><option>a</option></select>",
  ])("does not treat %s as a field", (html) => {
    expect(isEditingElement(element(html))).toBe(false);
  });

  it("treats no focus (the body or nothing) as not editing", () => {
    expect(isEditingElement(document.body)).toBe(false);
    expect(isEditingElement(null)).toBe(false);
  });
});

describe("hasOpenLayer", () => {
  it.each([
    '<div role="dialog" data-state="open"></div>',
    '<div role="alertdialog" data-state="open"></div>',
    '<div role="menu" data-state="open"></div>',
    '<div role="listbox" data-state="open"></div>',
    '<div data-slot="popover-content" data-state="open"></div>',
    '<div class="mobile-drawer" data-state="open"></div>',
  ])("sees %s", (html) => {
    document.body.innerHTML = html;
    expect(hasOpenLayer()).toBe(true);
  });

  it("ignores closing layers and layers in the inert workspace under Settings", () => {
    document.body.innerHTML = `
      <div role="menu" data-state="closed"></div>
      <div inert><div class="thread-find-bar" data-open="true"></div><div role="dialog" data-state="open"></div></div>`;
    expect(hasOpenLayer()).toBe(false);
  });
});

describe("settingsUpTarget", () => {
  it("goes from an editor to its entity, from an entity to its list", () => {
    expect(settingsUpTarget({ page: "environments", mode: "edit", resourceId: "e1" }, true))
      .toEqual({ kind: "path", path: "/settings/environments/e1" });
    expect(settingsUpTarget({ page: "backends", mode: "view", resourceId: "b1" }, true))
      .toEqual({ kind: "path", path: "/settings/backends" });
    expect(settingsUpTarget({ page: "backends", mode: "new" }, false))
      .toEqual({ kind: "path", path: "/settings/backends" });
    expect(settingsUpTarget({ page: "environments", mode: "pending", resourceId: "r1" }, true))
      .toEqual({ kind: "path", path: "/settings/environments" });
  });

  it("walks the add flow back through its chooser", () => {
    expect(settingsUpTarget({ page: "environments", mode: "new", resourceId: "ssh" }, true))
      .toEqual({ kind: "path", path: "/settings/environments/~new" });
    expect(settingsUpTarget({ page: "environments", mode: "new" }, true))
      .toEqual({ kind: "path", path: "/settings/environments" });
  });

  it("returns from a page to the workspace with the sidebar nav, like Back to workspace", () => {
    expect(settingsUpTarget({ page: "general" }, true)).toEqual({ kind: "workspace" });
    expect(settingsUpTarget({ page: "environments" }, true)).toEqual({ kind: "workspace" });
    expect(settingsUpTarget({}, true)).toEqual({ kind: "workspace" });
  });

  it("goes from a page to the Settings list, then the workspace, without the sidebar nav", () => {
    expect(settingsUpTarget({ page: "general" }, false)).toEqual({ kind: "path", path: "/settings" });
    expect(settingsUpTarget({ page: "projects" }, false)).toEqual({ kind: "path", path: "/settings" });
    expect(settingsUpTarget({}, false)).toEqual({ kind: "workspace" });
  });

  it("agrees with the resource parent the ‹ links use", () => {
    for (const resource of [{ mode: "edit", resourceId: "x" }, { mode: "view", resourceId: "x" }, { mode: "new", resourceId: "pair" }] as const) {
      expect(settingsUpTarget({ page: "environments", ...resource }, false))
        .toEqual({ kind: "path", path: settingsPath("environments", settingsResourceParent(resource)) });
    }
  });
});

describe("useSettingsEscape", () => {
  function press(target: EventTarget = document.body, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(event); });
    return event;
  }

  it("goes up through the router and marks the event handled", () => {
    navigate("/settings/environments/e1/edit", { replace: true });
    const onReturn = vi.fn();
    renderHook(() => useSettingsEscape({ location: { page: "environments", mode: "edit", resourceId: "e1" }, navInSidebar: true, onReturn }));
    const event = press();
    expect(event.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe("/settings/environments/e1");
    expect(onReturn).not.toHaveBeenCalled();
  });

  it("returns to the workspace from a page with the sidebar nav", () => {
    navigate("/settings/general", { replace: true });
    const onReturn = vi.fn();
    renderHook(() => useSettingsEscape({ location: { page: "general" }, navInSidebar: true, onReturn }));
    press();
    expect(onReturn).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe("/settings/general");
  });

  it("leaves a handled Escape and an open layer alone", () => {
    navigate("/settings/general", { replace: true });
    const onReturn = vi.fn();
    renderHook(() => useSettingsEscape({ location: { page: "general" }, navInSidebar: false, onReturn }));
    // A Radix layer closes on the document in the capture phase and prevents the default.
    const closeLayer = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", closeLayer, { capture: true });
    press();
    document.removeEventListener("keydown", closeLayer, { capture: true });
    document.body.innerHTML = '<div role="menu" data-state="open"></div>';
    const event = press();
    expect(event.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/settings/general");
    expect(onReturn).not.toHaveBeenCalled();
  });

  it("counts a layer the same Escape closes, even when the event cannot be canceled", () => {
    navigate("/settings/general", { replace: true });
    const onReturn = vi.fn();
    renderHook(() => useSettingsEscape({ location: { page: "general" }, navInSidebar: true, onReturn }));
    // Android Back dispatches a non-cancelable Escape; a layer that closes
    // synchronously would be gone by the time the bubble phase runs.
    document.body.innerHTML = '<div role="dialog" data-state="open"></div>';
    const closeLayer = () => document.querySelector('[role="dialog"]')?.remove();
    document.addEventListener("keydown", closeLayer, { capture: true });
    const event = press(document, { cancelable: false });
    document.removeEventListener("keydown", closeLayer, { capture: true });
    expect(event.defaultPrevented).toBe(false);
    expect(onReturn).not.toHaveBeenCalled();
    // The next Escape, with nothing open, goes up.
    press(document, { cancelable: false });
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it("still goes up while a toast is visible, and leaves the Escape a focused toast takes", () => {
    navigate("/settings/general", { replace: true });
    const onReturn = vi.fn();
    let toasts: ToastControls | undefined;
    function SettingsPage() {
      toasts = useToast();
      useSettingsEscape({ location: { page: "general" }, navInSidebar: true, onReturn });
      return null;
    }
    render(createElement(ToastProvider, null, createElement(SettingsPage)));
    act(() => toasts?.show({ message: "Task completed", action: { label: "Undo", onAction: vi.fn() } }));
    const toast = document.querySelector<HTMLElement>('[data-slot="toast"]')!;

    // The toast region is not an open layer, and the toast leaves Escape
    // alone while focus is outside it.
    expect(hasOpenLayer()).toBe(false);
    press();
    expect(onReturn).toHaveBeenCalledOnce();
    expect(toast).toHaveAttribute("data-state", "open");

    // Focused (F8), the toast takes Escape: it closes and Settings stays.
    act(() => toast.focus());
    const event = press(toast);
    expect(event.defaultPrevented).toBe(true);
    expect(onReturn).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-slot="toast"]')).toBeNull();
  });

  it("blurs a focused field first, without preventing its own Escape", () => {
    navigate("/settings/general", { replace: true });
    renderHook(() => useSettingsEscape({ location: { page: "general" }, navInSidebar: false, onReturn: vi.fn() }));
    document.body.innerHTML = '<input type="search" value="query">';
    const input = document.querySelector("input")!;
    input.focus();
    const event = press(input);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
    expect(window.location.pathname).toBe("/settings/general");
    press();
    expect(window.location.pathname).toBe("/settings");
  });

  it("ignores composition and modified Escapes", () => {
    navigate("/settings/general", { replace: true });
    renderHook(() => useSettingsEscape({ location: { page: "general" }, navInSidebar: false, onReturn: vi.fn() }));
    press(document.body, { isComposing: true });
    press(document.body, { shiftKey: true });
    press(document.body, { metaKey: true });
    expect(window.location.pathname).toBe("/settings/general");
  });

  it("closes a page's own open level before leaving the page, innermost first", () => {
    navigate("/settings/prompts", { replace: true });
    const onReturn = vi.fn();
    const outer = vi.fn();
    const inner = vi.fn();
    renderHook(() => useSettingsEscape({ location: { page: "prompts" }, navInSidebar: true, onReturn }));
    const outerLevel = renderHook(({ up }) => useSettingsEscapeLevel(up), { initialProps: { up: outer as (() => void) | undefined } });
    const innerLevel = renderHook(({ up }) => useSettingsEscapeLevel(up), { initialProps: { up: inner as (() => void) | undefined } });
    press();
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    innerLevel.rerender({ up: undefined });
    press();
    expect(outer).toHaveBeenCalledOnce();
    outerLevel.unmount();
    press();
    expect(onReturn).toHaveBeenCalledOnce();
  });
});
