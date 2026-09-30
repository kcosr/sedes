import { useRef } from "react";

let lastFocused: Element | null = null;
if (typeof document !== "undefined") document.addEventListener("focusin", (event) => { lastFocused = event.target instanceof Element ? event.target : null; }, true);

/** The control a person used to open something: a menu item stands for its menu's trigger. */
export function openerOf(element: Element | null): HTMLElement | null {
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  const labelledBy = element.closest("[role=menu]")?.getAttribute("aria-labelledby");
  return labelledBy ? document.getElementById(labelledBy) : element;
}

/**
 * Returns focus to what opened a controlled dialog, through the dialog's
 * `returnFocusRef`: the control focused when it opened (a menu item stands
 * for its menu's trigger). Assign `returnFocusRef.current` to send focus
 * elsewhere, such as the heading of a location the dialog's action opened.
 */
export function useFocusReturn() {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return {
    returnFocusRef,
    onOpenAutoFocus: () => { returnFocusRef.current = openerOf(document.activeElement) ?? openerOf(lastFocused); },
  };
}
