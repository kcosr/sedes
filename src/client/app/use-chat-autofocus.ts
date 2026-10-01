import { useSyncExternalStore } from "react";
import { useMediaQuery } from "./use-media-query.js";

export const CHAT_AUTOFOCUS_QUERY = "(min-width: 820px) and (pointer: fine)";

// Shared across retained panels and newly mounted ThreadViews, so the tap
// that opened a cold thread remains known when its composer finally mounts.
let touchInteraction = false;
const listeners = new Set<() => void>();

function setTouchInteraction(next: boolean): void {
  if (touchInteraction === next) return;
  touchInteraction = next;
  for (const listener of listeners) listener();
}

function onPointerDown(event: PointerEvent): void {
  setTouchInteraction(event.pointerType === "touch" || event.pointerType === "pen");
}

function onKeyDown(event: KeyboardEvent): void {
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
  setTouchInteraction(false);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      touchInteraction = false;
    }
  };
}

/** Layout width alone must never decide whether to summon a keyboard. */
export function useChatAutofocus(): boolean {
  const desktopPointer = useMediaQuery(CHAT_AUTOFOCUS_QUERY);
  const touched = useSyncExternalStore(subscribe, () => touchInteraction, () => false);
  return desktopPointer && !touched;
}
