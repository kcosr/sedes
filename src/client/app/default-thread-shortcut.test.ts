// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDefaultThreadShortcut, openDefaultThread } from "./default-thread-shortcut.js";
import { openThreadRoute } from "../workspace-panels/thread-panel-navigation.js";
import { navigate } from "./router.js";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
vi.mock("../workspace-panels/thread-panel-navigation.js", () => ({ openThreadRoute: vi.fn() }));
vi.mock("./router.js", () => ({ navigate: vi.fn(), settingsPath: (page: string) => `/settings/${page}` }));
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); document.body.replaceChildren(); vi.clearAllMocks(); });
function press(target: EventTarget, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "H", shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event); return event;
}
describe("default thread shortcut", () => {
  it("opens a known target during refresh and waits only when none is resolved", () => {
    const thread = { id: "known", available: true, inventoryState: "active" } as NormalizedApplicationThreadSummary;
    cleanups.push(installDefaultThreadShortcut(window, () => { openDefaultThread({ thread, resolving: true }); }));
    press(document.body);
    expect(openThreadRoute).toHaveBeenCalledExactlyOnceWith("known");
    expect(navigate).not.toHaveBeenCalled();
    expect(openDefaultThread({ resolving: true })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(openDefaultThread({ resolving: false })).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/settings/general");
  });
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
