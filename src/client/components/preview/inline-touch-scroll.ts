const momentumStoppingInputs = new WeakSet<Event>();

/** Only the input which stopped custom momentum must not activate a preview. */
export function stoppedPreviewScrollMomentum(event: Event): boolean {
  return momentumStoppingInputs.has(event);
}

/** Route one-finger drags at fit to the containing transcript, not the image.
 * Owning the touch from pointerdown keeps Android from cancelling a later pinch.
 */
export function scrollPreviewAncestors(
  element: HTMLElement,
  delta: number,
): number {
  let remaining = delta;
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    if (!/(auto|scroll)/.test(style.overflowY)) continue;
    const before = parent.scrollTop;
    const maximum = Math.max(0, parent.scrollHeight - parent.clientHeight);
    parent.scrollTop = Math.max(0, Math.min(maximum, before + remaining));
    remaining -= parent.scrollTop - before;
    if (
      Math.abs(remaining) < 0.1 ||
      /contain|none/.test(style.overscrollBehaviorY)
    )
      break;
  }
  return delta - remaining;
}

/** Keep a preview fling interruptible by the next interaction, just like native scrolling. */
export function startPreviewScrollMomentum(
  element: HTMLElement,
  initialVelocity: number,
): () => void {
  const ownerDocument = element.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  let velocity = Math.max(-2.5, Math.min(2.5, initialVelocity));
  let last = performance.now();
  let frame: number | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    ownerDocument.removeEventListener("pointerdown", stopForPointer, true);
    ownerDocument.removeEventListener("wheel", stop, true);
    ownerDocument.removeEventListener("keydown", stop, true);
    ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
    ownerWindow?.removeEventListener("blur", stop);
  };
  const stopForPointer = (event: Event) => {
    momentumStoppingInputs.add(event);
    stop();
  };
  const onVisibilityChange = () => {
    if (ownerDocument.hidden) stop();
  };
  const step = (now: number) => {
    if (stopped || !element.isConnected || ownerDocument.hidden) {
      stop();
      return;
    }
    const elapsed = Math.min(32, now - last);
    last = now;
    const moved = scrollPreviewAncestors(element, velocity * elapsed);
    velocity *= Math.pow(0.92, elapsed / 16);
    if (Math.abs(velocity) > 0.03 && Math.abs(moved) > 0.1) {
      frame = requestAnimationFrame(step);
    } else {
      stop();
    }
  };
  if (Math.abs(velocity) <= 0.03) return stop;

  // Capture before another preview or a native scroller handles the new input.
  // These listeners never cancel that input and exist only during the fling.
  ownerDocument.addEventListener("pointerdown", stopForPointer, true);
  ownerDocument.addEventListener("wheel", stop, {
    capture: true,
    passive: true,
  });
  ownerDocument.addEventListener("keydown", stop, true);
  ownerDocument.addEventListener("visibilitychange", onVisibilityChange);
  ownerWindow?.addEventListener("blur", stop);
  frame = requestAnimationFrame(step);
  return stop;
}
