interface SettledSelectionCaptureOptions {
  readonly root: HTMLElement;
  readonly debounceMilliseconds: number;
  readonly capture: () => void;
  readonly onGestureStart?: () => void;
}

/**
 * Runs DOM-selection capture only after the gesture that owns the selection
 * has ended. Native selection dispatches `selectionchange` repeatedly while a
 * mouse drag or Android long-press/handle drag is still active; opening an
 * action overlay during those changes interrupts multi-line selection and
 * edge autoscroll.
 */
export function observeSettledSelection({
  root,
  debounceMilliseconds,
  capture,
  onGestureStart,
}: SettledSelectionCaptureOptions): () => void {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let pointerActive = false;
  let touchActive = false;
  let gestureRelevant = false;
  let selectionChangedDuringGesture = false;
  let actionGesture = false;

  const gestureActive = () => pointerActive || touchActive;
  const cancelScheduledCapture = () => {
    if (timeout === undefined) return;
    globalThis.clearTimeout(timeout);
    timeout = undefined;
  };
  const scheduleCapture = () => {
    cancelScheduledCapture();
    timeout = globalThis.setTimeout(() => {
      timeout = undefined;
      capture();
    }, debounceMilliseconds);
  };
  const startGesture = (target: EventTarget | null) => {
    cancelScheduledCapture();
    const targetNode = target instanceof Node ? target : undefined;
    const targetElement =
      targetNode instanceof Element ? targetNode : targetNode?.parentElement;
    actionGesture ||= Boolean(
      targetElement?.closest("[data-selection-action-overlay]"),
    );
    if (actionGesture) return;
    const wasRelevant = gestureRelevant;
    gestureRelevant ||=
      Boolean(targetNode && root.contains(targetNode)) ||
      selectionTouchesRoot(root);
    if (!wasRelevant && gestureRelevant) onGestureStart?.();
  };
  const finishGesture = () => {
    if (gestureActive()) return;
    if (!actionGesture && (gestureRelevant || selectionChangedDuringGesture)) {
      scheduleCapture();
    }
    gestureRelevant = false;
    selectionChangedDuringGesture = false;
    actionGesture = false;
  };
  const pointerDown = (event: PointerEvent) => {
    if (
      !event.isPrimary ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }
    pointerActive = true;
    startGesture(event.target);
  };
  const pointerFinished = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    pointerActive = false;
    finishGesture();
  };
  const touchStart = (event: TouchEvent) => {
    touchActive = true;
    startGesture(event.target);
  };
  const touchFinished = (event: TouchEvent) => {
    touchActive = event.touches.length > 0;
    finishGesture();
  };
  const selectionChanged = () => {
    if (gestureActive()) {
      cancelScheduledCapture();
      if (!actionGesture) selectionChangedDuringGesture = true;
      return;
    }
    scheduleCapture();
  };
  const windowBlurred = () => {
    pointerActive = false;
    touchActive = false;
    finishGesture();
  };

  window.addEventListener("pointerdown", pointerDown, true);
  window.addEventListener("pointerup", pointerFinished, true);
  window.addEventListener("pointercancel", pointerFinished, true);
  window.addEventListener("touchstart", touchStart, true);
  window.addEventListener("touchend", touchFinished, true);
  window.addEventListener("touchcancel", touchFinished, true);
  window.addEventListener("blur", windowBlurred);
  document.addEventListener("selectionchange", selectionChanged);

  return () => {
    cancelScheduledCapture();
    window.removeEventListener("pointerdown", pointerDown, true);
    window.removeEventListener("pointerup", pointerFinished, true);
    window.removeEventListener("pointercancel", pointerFinished, true);
    window.removeEventListener("touchstart", touchStart, true);
    window.removeEventListener("touchend", touchFinished, true);
    window.removeEventListener("touchcancel", touchFinished, true);
    window.removeEventListener("blur", windowBlurred);
    document.removeEventListener("selectionchange", selectionChanged);
  };
}

function selectionTouchesRoot(root: HTMLElement): boolean {
  const selection = document.getSelection();
  return Boolean(
    selection &&
      ((selection.anchorNode && root.contains(selection.anchorNode)) ||
        (selection.focusNode && root.contains(selection.focusNode))),
  );
}
