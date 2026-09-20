import type { Terminal } from "ghostty-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installGhosttyRenderScheduling } from "./ghostty-render-scheduling.js";

function fixture(windows = true, blink = false) {
  let id = 10;
  const frames = new Map<number, FrameRequestCallback>();
  const cancel = vi.fn((key: number) => frames.delete(key));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", cancel);
  let scroll: (() => void) | undefined;
  const terminal = {
    animationFrameId: 0,
    options: { cursorBlink: blink },
    viewportY: 3,
    scrollbarOpacity: 0.6,
    lastCursorY: 0,
    cursorMoveEmitter: { fire: vi.fn() },
    wasmTerm: { getCursor: () => ({ x: 2, y: 4 }) },
    renderer: { render: vi.fn(), setHoveredHyperlinkId: vi.fn(), setHoveredLinkRange: vi.fn() },
    selectionManager: { requestRender: vi.fn() },
    startRenderLoop: vi.fn(),
    onScroll: vi.fn((callback: () => void) => {
      scroll = callback;
      return { dispose: () => { scroll = undefined; } };
    }),
  };
  const originalSelection = terminal.selectionManager.requestRender;
  const originalLink = terminal.renderer.setHoveredLinkRange;
  const controller = installGhosttyRenderScheduling(terminal as unknown as Terminal, windows);
  const flush = () => {
    const batch = [...frames.values()]; frames.clear(); batch.forEach((cb) => cb(0));
  };
  return { terminal, controller, frames, cancel, flush, originalSelection, originalLink,
    scroll: () => scroll?.() };
}
afterEach(() => vi.unstubAllGlobals());

describe("Ghostty 0.4.0 Windows render scheduling", () => {
  it.each([[false, false], [false, true], [true, true]])(
    "preserves the loop when windows=%s and blink=%s", (windows, blink) => {
      const f = fixture(windows, blink);
      f.controller.request();
      expect(f.cancel).not.toHaveBeenCalled();
      expect(f.frames.size).toBe(0);
      expect(f.terminal.selectionManager.requestRender).toBe(f.originalSelection);
      f.controller.dispose();
    });
  it("cancels the idle frame, coalesces output, and uses current viewport and opacity", () => {
    const f = fixture();
    expect(f.cancel).toHaveBeenCalledWith(0);
    expect(f.terminal.animationFrameId).toBeUndefined();
    f.controller.request(); f.controller.request();
    expect(f.frames.size).toBe(1);
    f.terminal.viewportY = 7; f.terminal.scrollbarOpacity = 0.2;
    f.flush();
    expect(f.terminal.renderer.render).toHaveBeenCalledExactlyOnceWith(
      f.terminal.wasmTerm, false, 7, f.terminal, 0.2);
    expect(f.terminal.cursorMoveEmitter.fire).toHaveBeenCalledTimes(1);
    expect(f.frames.size).toBe(0);
    f.controller.request(); f.flush();
    expect(f.terminal.cursorMoveEmitter.fire).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });
  it("repaints selection, scrolling and asynchronously resolved link highlights", async () => {
    const f = fixture(); f.flush();
    f.terminal.selectionManager.requestRender(); f.scroll();
    await Promise.resolve().then(() => f.terminal.renderer.setHoveredLinkRange());
    f.terminal.renderer.setHoveredHyperlinkId();
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.terminal.renderer.render).toHaveBeenCalledTimes(2);
    expect(f.originalSelection).toHaveBeenCalled();
    expect(f.originalLink).toHaveBeenCalled();
    f.controller.dispose();
    expect(f.terminal.selectionManager.requestRender).toBe(f.originalSelection);
    expect(f.terminal.renderer.setHoveredLinkRange).toBe(f.originalLink);
  });
  it("toggles without duplicate loops and cancels pending work on disposal", () => {
    const f = fixture();
    f.controller.setCursorBlink(true);
    expect(f.frames.size).toBe(0);
    expect(f.terminal.startRenderLoop).toHaveBeenCalledTimes(1);
    f.controller.setCursorBlink(true);
    expect(f.terminal.startRenderLoop).toHaveBeenCalledTimes(1);
    f.terminal.animationFrameId = 42;
    f.controller.setCursorBlink(false);
    expect(f.cancel).toHaveBeenCalledWith(42);
    expect(f.frames.size).toBe(1);
    f.controller.dispose();
    f.controller.request(); f.scroll(); f.controller.setCursorBlink(true);
    expect(f.frames.size).toBe(0);
    expect(f.terminal.startRenderLoop).toHaveBeenCalledTimes(1);
  });
});
