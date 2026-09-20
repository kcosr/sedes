import type { Terminal } from "ghostty-web";

// Compatibility adapter for the pinned ghostty-web 0.4.0. Re-audit these private
// members and all invalidation paths when upgrading. Do not patch the bundle.
type SchedulingTerminal = Pick<Terminal, keyof Terminal> & {
  animationFrameId?: number;
  scrollbarOpacity?: number;
  lastCursorY: number;
  cursorMoveEmitter: { fire(): void };
  startRenderLoop(): void;
  selectionManager: { requestRender(): void };
};

export function installGhosttyRenderScheduling(
  instance: Terminal,
  windows: boolean,
) {
  const terminal = instance as unknown as SchedulingTerminal;
  let pending: number | undefined;
  let demand = false;
  let disposed = false;
  let undo: (() => void) | undefined;

  const cancelPending = () => {
    if (pending !== undefined) cancelAnimationFrame(pending);
    pending = undefined;
  };
  const request = () => {
    if (!demand || disposed || pending !== undefined) return;
    pending = requestAnimationFrame(() => {
      pending = undefined;
      if (disposed || !demand || !terminal.renderer || !terminal.wasmTerm) return;
      terminal.renderer.render(
        terminal.wasmTerm, false, terminal.viewportY,
        terminal, terminal.scrollbarOpacity ?? 0,
      );
      const cursor = terminal.wasmTerm.getCursor();
      if (cursor.y !== terminal.lastCursorY) {
        terminal.lastCursorY = cursor.y;
        terminal.cursorMoveEmitter.fire();
      }
    });
  };

  const setCursorBlink = (blink: boolean) => {
    if (disposed) return;
    terminal.options.cursorBlink = blink;
    const nextDemand = windows && !blink;
    if (nextDemand === demand) return;
    demand = nextDemand;
    if (demand) {
      if (terminal.animationFrameId !== undefined)
        cancelAnimationFrame(terminal.animationFrameId);
      terminal.animationFrameId = undefined;
      const selection = terminal.selectionManager;
      const renderer = terminal.renderer!;
      const originalSelectionRender = selection.requestRender;
      const originalHyperlink = renderer.setHoveredHyperlinkId;
      const originalLinkRange = renderer.setHoveredLinkRange;
      // In 0.4.0 selection only marks dirty rows; its render request is a stub.
      selection.requestRender = () => {
        originalSelectionRender.call(selection);
        request();
      };
      renderer.setHoveredHyperlinkId = function (...args) {
        originalHyperlink.apply(this, args);
        request();
      };
      // Link detection may resolve asynchronously, after the pointer event.
      renderer.setHoveredLinkRange = function (...args) {
        originalLinkRange.apply(this, args);
        request();
      };
      const scroll = terminal.onScroll(request);
      undo = () => {
        scroll.dispose();
        selection.requestRender = originalSelectionRender;
        renderer.setHoveredHyperlinkId = originalHyperlink;
        renderer.setHoveredLinkRange = originalLinkRange;
      };
      request();
    } else {
      cancelPending();
      undo?.();
      undo = undefined;
      terminal.startRenderLoop();
    }
  };
  setCursorBlink(terminal.options.cursorBlink ?? true);
  return {
    request,
    setCursorBlink,
    dispose() {
      disposed = true;
      cancelPending();
      undo?.();
      undo = undefined;
    },
  };
}
