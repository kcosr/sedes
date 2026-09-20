// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installTerminalTouchScroll,
  TOUCH_SCROLL_TOLERANCE_PX,
  type TouchScrollTerminal,
} from "./codex-tui-touch-scroll.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function fakeTerminal(
  overrides: Partial<TouchScrollTerminal> = {},
): TouchScrollTerminal & { textarea: HTMLTextAreaElement } {
  return {
    hasMouseTracking: vi.fn(() => false),
    scrollLines: vi.fn(),
    renderer: { getMetrics: () => ({ height: 10 }) },
    textarea: document.createElement("textarea"),
    ...overrides,
  } as TouchScrollTerminal & { textarea: HTMLTextAreaElement };
}

function touch(
  type: "touchstart" | "touchmove" | "touchend",
  y: number,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    touches: [{ clientY: y, clientX: 0 }],
  });
  return event;
}

describe("installTerminalTouchScroll", () => {
  it("scrolls whole lines and keeps fractional remainders", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const terminal = fakeTerminal();
    const cleanup = installTerminalTouchScroll(container, terminal, vi.fn());

    container.dispatchEvent(touch("touchstart", 100));
    // 4px up (0.4 lines) — below one line, no scroll yet.
    container.dispatchEvent(touch("touchmove", 96));
    expect(terminal.scrollLines).not.toHaveBeenCalled();
    // 11 more px up (1.1 lines) — 1.5 accumulated: one line, 0.5 kept.
    container.dispatchEvent(touch("touchmove", 85));
    expect(terminal.scrollLines).toHaveBeenCalledWith(1);
    // 5px down (−0.5) cancels the remainder; nothing scrolls.
    container.dispatchEvent(touch("touchmove", 90));
    expect(terminal.scrollLines).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("sends capped arrow-key input on the alternate screen", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const terminal = fakeTerminal({
      isAlternateScreen: () => true,
    });
    const emitInput = vi.fn();
    installTerminalTouchScroll(container, terminal, emitInput);

    container.dispatchEvent(touch("touchstart", 200));
    container.dispatchEvent(touch("touchmove", 130));
    expect(terminal.scrollLines).not.toHaveBeenCalled();
    expect(emitInput).toHaveBeenCalledTimes(5);
    expect(emitInput).toHaveBeenLastCalledWith("\u001b[B");
    container.dispatchEvent(touch("touchmove", 155));
    expect(emitInput).toHaveBeenLastCalledWith("\u001b[A");
  });

  it("leaves gestures to mouse-tracking applications", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const terminal = fakeTerminal({
      hasMouseTracking: vi.fn(() => true),
    });
    installTerminalTouchScroll(container, terminal, vi.fn());

    container.dispatchEvent(touch("touchstart", 100));
    const move = touch("touchmove", 40);
    container.dispatchEvent(move);
    expect(terminal.scrollLines).not.toHaveBeenCalled();
    expect(move.defaultPrevented).toBe(false);
  });

  it("suppresses focus after a scroll gesture but lets a tap through", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const terminal = fakeTerminal();
    const blur = vi.spyOn(terminal.textarea, "blur");
    installTerminalTouchScroll(container, terminal, vi.fn());

    // Scroll gesture beyond the tolerance: touchend is intercepted.
    container.dispatchEvent(touch("touchstart", 100));
    container.dispatchEvent(
      touch("touchmove", 100 - TOUCH_SCROLL_TOLERANCE_PX - 5),
    );
    const scrolledEnd = touch("touchend", 0);
    const stopPropagation = vi.spyOn(scrolledEnd, "stopPropagation");
    container.dispatchEvent(scrolledEnd);
    expect(scrolledEnd.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
    expect(blur).toHaveBeenCalled();

    // A true tap: touchend passes through untouched.
    container.dispatchEvent(touch("touchstart", 100));
    container.dispatchEvent(touch("touchmove", 98));
    const tapEnd = touch("touchend", 0);
    const tapStop = vi.spyOn(tapEnd, "stopPropagation");
    container.dispatchEvent(tapEnd);
    expect(tapEnd.defaultPrevented).toBe(false);
    expect(tapStop).not.toHaveBeenCalled();
  });

  it("ignores multi-touch and removes listeners on cleanup", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const terminal = fakeTerminal();
    const cleanup = installTerminalTouchScroll(container, terminal, vi.fn());

    container.dispatchEvent(touch("touchstart", 100));
    const multi = new Event("touchmove", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(multi, {
      touches: [{ clientY: 60, clientX: 0 }, { clientY: 70, clientX: 0 }],
    });
    container.dispatchEvent(multi);
    expect(terminal.scrollLines).not.toHaveBeenCalled();

    cleanup();
    container.dispatchEvent(touch("touchstart", 100));
    container.dispatchEvent(touch("touchmove", 50));
    expect(terminal.scrollLines).not.toHaveBeenCalled();
  });
});
