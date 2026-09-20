/**
 * Touch scrolling for the managed terminal (herdr-web policy). ghostty-web
 * only scrolls on wheel; on touch layouts a single-finger vertical drag
 * drives scrolling here instead:
 *
 * - Pixel deltas convert to lines through the font metrics, accumulating
 *   fractions across events so slow drags do not jitter.
 * - Alternate-screen apps receive arrow-key input (desktop wheel parity),
 *   since they have no scrollback.
 * - Mouse-tracking apps keep the gestures for themselves.
 * - A gesture that moves past the tap tolerance is a scroll, not a tap:
 *   the terminal's own touchend→focus listener is intercepted so the soft
 *   keyboard stays closed. A true tap still focuses deliberately.
 */

export interface TouchScrollTerminal {
  hasMouseTracking(): boolean;
  isAlternateScreen?(): boolean;
  scrollLines(amount: number): void;
  readonly renderer?: { getMetrics(): { readonly height: number } } | null;
  readonly textarea?: HTMLTextAreaElement;
}

/** Movement past this turns a tap into a scroll gesture (herdr-web). */
export const TOUCH_SCROLL_TOLERANCE_PX = 10;

/**
 * Installs capture-phase touch handlers on the terminal container and
 * returns the cleanup. The container must be touch-action: none so the
 * browser never claims the drag first.
 */
export function installTerminalTouchScroll(
  container: HTMLElement,
  terminal: TouchScrollTerminal,
  emitInput: (data: string) => void,
): () => void {
  let startY: number | undefined;
  let lastY: number | undefined;
  let pendingLines = 0;
  let touchScrolled = false;

  const hasMouseTracking = (): boolean => {
    try {
      return terminal.hasMouseTracking();
    } catch {
      return true;
    }
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length === 1) {
      startY = event.touches[0]!.clientY;
      lastY = startY;
      pendingLines = 0;
      touchScrolled = false;
    } else {
      startY = undefined;
      lastY = undefined;
    }
  };

  const onTouchMove = (event: TouchEvent) => {
    if (hasMouseTracking() || event.touches.length !== 1 || lastY === undefined)
      return;
    const currentY = event.touches[0]!.clientY;
    const deltaY = currentY - lastY;
    lastY = currentY;
    if (
      startY !== undefined &&
      Math.abs(currentY - startY) > TOUCH_SCROLL_TOLERANCE_PX
    ) {
      touchScrolled = true;
    }
    const cellHeight = terminal.renderer?.getMetrics().height ?? 16;
    pendingLines += -deltaY / cellHeight;
    const lines =
      pendingLines < 0 ? Math.ceil(pendingLines) : Math.floor(pendingLines);
    if (lines === 0) return;
    pendingLines -= lines;
    touchScrolled = true;
    event.preventDefault();
    event.stopPropagation();
    if (terminal.isAlternateScreen?.()) {
      // Desktop wheel parity: arrow keys, capped per gesture event.
      const count = Math.min(Math.abs(lines), 5);
      const arrow = lines > 0 ? "\u001b[B" : "\u001b[A";
      for (let index = 0; index < count; index += 1) emitInput(arrow);
      pendingLines = 0;
      return;
    }
    terminal.scrollLines(lines);
  };

  const onTouchEnd = (event: TouchEvent) => {
    // ghostty's canvas touchend listener focuses the textarea, which pops
    // the soft keyboard after a scroll. Intercepted in the capture phase so
    // it never reaches that listener; preventDefault also suppresses the
    // compat mouse events that would focus through the mousedown path.
    if (touchScrolled) {
      event.preventDefault();
      event.stopPropagation();
      terminal.textarea?.blur();
    }
    startY = undefined;
    lastY = undefined;
    pendingLines = 0;
  };

  container.addEventListener("touchstart", onTouchStart, {
    capture: true,
    passive: true,
  });
  container.addEventListener("touchmove", onTouchMove, {
    capture: true,
    passive: false,
  });
  container.addEventListener("touchend", onTouchEnd, {
    capture: true,
    passive: false,
  });
  container.addEventListener("touchcancel", onTouchEnd, {
    capture: true,
    passive: false,
  });

  return () => {
    container.removeEventListener("touchstart", onTouchStart, {
      capture: true,
    });
    container.removeEventListener("touchmove", onTouchMove, { capture: true });
    container.removeEventListener("touchend", onTouchEnd, { capture: true });
    container.removeEventListener("touchcancel", onTouchEnd, {
      capture: true,
    });
  };
}
