// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDefaultThreadShortcut } from "./default-thread-shortcut.js";
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); document.body.replaceChildren(); });
function press(target: EventTarget, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "H", shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event); return event;
}
describe("default thread shortcut", () => {
  it.each([{ ctrlKey: true }, { ctrlKey: false, metaKey: true }])("opens using either primary modifier (%o)", (modifier) => {
    const open = vi.fn(); cleanups.push(installDefaultThreadShortcut(window, open));
    expect(press(document.body, modifier).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });
  it("leaves dialogs, composition, repeats, and other bindings alone", () => {
    const open = vi.fn(); cleanups.push(installDefaultThreadShortcut(window, open));
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
    press(dialog); press(document.body, { isComposing: true }); press(document.body, { repeat: true });
    press(document.body, { shiftKey: false }); press(document.body, { altKey: true });
    press(document.body, { metaKey: true });
    expect(open).not.toHaveBeenCalled();
  });
  it("claims the shortcut before a terminal consumes it and uninstalls cleanly", () => {
    const terminal = document.createElement("div"); terminal.className = "terminal-panel-emulator"; document.body.append(terminal);
    const open = vi.fn(); const remove = installDefaultThreadShortcut(window, open);
    const receive = vi.fn((event: Event) => event.stopPropagation()); terminal.addEventListener("keydown", receive);
    press(terminal); expect(open).toHaveBeenCalledOnce(); expect(receive).not.toHaveBeenCalled();
    remove(); press(document.body); expect(open).toHaveBeenCalledOnce();
  });
});
