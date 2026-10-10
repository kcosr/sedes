import type { PanelFocusRequest } from "./region-store.js";
import type { PanelKind } from "./regions.js";

/**
 * DOM helpers for the panel layout: the retained portal targets that keep a
 * panel's content mounted wherever (or whether) its region shows it, and
 * focus placement inside them.
 */

/** Each kind's retained content host; see StablePaneSlot. */
export type PanelTargets = Readonly<Record<PanelKind, HTMLElement>>;

export function createPortalTarget(kind: PanelKind, title: string): HTMLElement {
  const target = document.createElement("div");
  target.className = "workspace-panel-portal-target";
  target.dataset.portalTarget = kind;
  target.tabIndex = -1;
  target.setAttribute("role", "region");
  target.setAttribute("aria-label", `${title} panel content`);
  return target;
}

export function createChromeActionsTarget(): HTMLElement {
  const target = document.createElement("div");
  target.className = "workspace-panel-chrome-actions-target";
  return target;
}

/**
 * Focuses a panel's preferred control (or its first focusable one, or the
 * target itself). Without `preferInteractiveTarget` it focuses the target.
 * True when focus landed.
 */
export function focusInside(
  target: HTMLElement | undefined,
  preferInteractiveTarget = true,
): boolean {
  if (!preferInteractiveTarget) {
    target?.focus();
    return target !== undefined && document.activeElement === target;
  }
  const focusTarget =
    preferredFocusTarget(target) ??
    target?.querySelector<HTMLElement>(
      'button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
    ) ??
    target;
  if (
    (focusTarget instanceof HTMLButtonElement ||
      focusTarget instanceof HTMLInputElement ||
      focusTarget instanceof HTMLSelectElement ||
      focusTarget instanceof HTMLTextAreaElement) &&
    focusTarget.disabled
  )
    return false;
  focusTarget?.focus();
  return focusTarget !== undefined && document.activeElement === focusTarget;
}

export function preferredFocusTarget(
  target: HTMLElement | undefined,
): HTMLElement | undefined {
  return (
    target?.querySelector<HTMLElement>("[data-panel-autofocus]") ??
    target?.querySelector<HTMLElement>(
      '[data-workspace-primary-focus="preferred"]',
    ) ??
    undefined
  );
}

export function focusRequestMatchesThread(
  request: PanelFocusRequest,
  threadId: string,
): boolean {
  return (
    request.scope?.kind !== "thread" || request.scope.threadId === threadId
  );
}

/**
 * Whether a keypress belongs to something that handles Escape itself: an
 * open dialog, menu or listbox, an editable field, or a terminal.
 */
export function escapeBelongsElsewhere(event: KeyboardEvent): boolean {
  if (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
    )
  )
    return true;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return false;
  if (
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [data-portal-target="terminals"]',
    )
  )
    return true;
  return false;
}

export function domIdFragment(value: string): string {
  return [...value]
    .map((character) => character.codePointAt(0)!.toString(16))
    .join("-");
}

export function objectStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

export function objectSafeIntegerField(
  value: unknown,
  key: string,
): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isSafeInteger(field)
    ? field
    : undefined;
}

export function withoutMapKey<K, V>(
  values: ReadonlyMap<K, V>,
  key: K,
): ReadonlyMap<K, V> {
  if (!values.has(key)) return values;
  const next = new Map(values);
  next.delete(key);
  return next;
}
