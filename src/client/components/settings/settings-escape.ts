import { useEffect, useRef } from "react";
import { OPEN_OVERLAY_SELECTOR } from "../../app/android-back.js";
import { navigateUp, settingsPath } from "../../app/router.js";
import {
  isSettingsResourcePage,
  settingsResourceParent,
  type SettingsPage,
  type SettingsResourceRoute,
} from "../../app/settings-route.js";

/**
 * Escape in Settings goes up one level, like the "‹" links: an editor to its
 * entity, an entity to its list, a page to the Settings list (compact) or to
 * the workspace (the sidebar nav's "Back to workspace"). Open layers and
 * focused text fields take Escape first.
 */
export type SettingsEscapeAction = "none" | "blur" | "up";

export interface SettingsEscapeEvent {
  readonly key: string;
  readonly isComposing: boolean;
  readonly keyCode: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly defaultPrevented: boolean;
}

/**
 * What an Escape keydown does in Settings. A handled event (a Radix layer
 * closing, a control's own Escape) and any open layer win; a field keeps the
 * first Escape (it only loses focus); a held key never walks several levels.
 */
export function settingsEscapeAction(
  event: SettingsEscapeEvent,
  state: { readonly layerOpen: boolean; readonly editing: boolean },
): SettingsEscapeAction {
  if (event.key !== "Escape") return "none";
  // 229 is the keyCode of a keydown an input method editor consumes.
  if (event.isComposing || event.keyCode === 229) return "none";
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return "none";
  if (event.defaultPrevented || state.layerOpen) return "none";
  if (state.editing) return "blur";
  if (event.repeat) return "none";
  return "up";
}

const nonTextInputTypes = new Set([
  "button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit",
]);
const editingRoles = new Set(["combobox", "searchbox", "textbox"]);

/** Whether focus is in a place that edits text or picks from a combobox. */
export function isEditingElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return !nonTextInputTypes.has(element.type);
  // A single-choice select is a combobox; a list box is not.
  if (element instanceof HTMLSelectElement) return !element.multiple && element.size <= 1;
  if (element.isContentEditable) return true;
  return editingRoles.has(element.getAttribute("role") ?? "");
}

/**
 * Whether a dialog, menu, picker, popover, sheet or select is open. Layers in
 * an inert region (the workspace retained under Settings) are not in play.
 */
export function hasOpenLayer(root: ParentNode = document): boolean {
  return Array.from(root.querySelectorAll(OPEN_OVERLAY_SELECTOR)).some(
    (layer) => layer.closest("[inert]") === null,
  );
}

export type SettingsUpTarget =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "workspace" };

/**
 * One level up from a settings location, the target of its "‹" link: an
 * entity route's parent, then (without the sidebar nav) the Settings list,
 * then the workspace, as "Back to workspace" does.
 */
export function settingsUpTarget(
  location: { readonly page?: SettingsPage } & SettingsResourceRoute,
  navInSidebar: boolean,
): SettingsUpTarget {
  const { page } = location;
  if (page && isSettingsResourcePage(page) && location.mode) {
    return { kind: "path", path: settingsPath(page, settingsResourceParent(location)) };
  }
  if (page && !navInSidebar) return { kind: "path", path: settingsPath() };
  return { kind: "workspace" };
}

interface EscapeLevel {
  readonly up: () => void;
}

/** Levels a page keeps in its own state (an open editor), innermost last. */
const levels: EscapeLevel[] = [];

/**
 * Registers a level a settings page keeps in its own state rather than in
 * the route, such as an open editor beside its list. While `onUp` is set,
 * Escape calls it (the page's own "‹") instead of leaving the page.
 */
export function useSettingsEscapeLevel(onUp: (() => void) | undefined): void {
  const handler = useRef(onUp);
  handler.current = onUp;
  const open = onUp !== undefined;
  useEffect(() => {
    if (!open) return undefined;
    const level: EscapeLevel = { up: () => handler.current?.() };
    levels.push(level);
    return () => {
      const index = levels.indexOf(level);
      if (index >= 0) levels.splice(index, 1);
    };
  }, [open]);
}

/**
 * Installs Escape-to-go-up while Settings is shown. The open layers and the
 * focused element are read in the window's capture phase, before any
 * handler runs, so a layer that this Escape closes still counts (also for
 * the non-cancelable Escape Android Back dispatches). The decision runs in
 * the window's bubble phase, after Radix's document-level handling and
 * every control's own handlers, so a handled event is already marked.
 * Navigation goes through `navigateUp` (or the return callback), so the
 * dirty guards run as they do for the "‹" links.
 */
export function useSettingsEscape({
  location,
  navInSidebar,
  onReturn,
}: {
  readonly location: { readonly page?: SettingsPage } & SettingsResourceRoute;
  readonly navInSidebar: boolean;
  readonly onReturn: () => void;
}): void {
  const current = useRef({ location, navInSidebar, onReturn });
  current.current = { location, navInSidebar, onReturn };
  useEffect(() => {
    let arrival: { readonly event: Event; readonly layerOpen: boolean; readonly active: Element | null } | undefined;
    const onArrival = (event: KeyboardEvent) => {
      arrival = event.key === "Escape"
        ? { event, layerOpen: hasOpenLayer(), active: document.activeElement }
        : undefined;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const state = arrival?.event === event ? arrival : { layerOpen: hasOpenLayer(), active: document.activeElement };
      arrival = undefined;
      const { active } = state;
      const action = settingsEscapeAction(event, {
        layerOpen: state.layerOpen,
        editing: isEditingElement(active),
      });
      if (action === "none") return;
      if (action === "blur") {
        // Not prevented: a control's native Escape (a search field clearing) still runs.
        if (active === document.activeElement) (active as HTMLElement).blur();
        return;
      }
      event.preventDefault();
      const level = levels.at(-1);
      if (level) {
        level.up();
        return;
      }
      const target = settingsUpTarget(current.current.location, current.current.navInSidebar);
      if (target.kind === "workspace") current.current.onReturn();
      else navigateUp(target.path);
    };
    window.addEventListener("keydown", onArrival, { capture: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onArrival, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
