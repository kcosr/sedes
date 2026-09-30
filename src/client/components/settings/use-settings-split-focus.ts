import { useLayoutEffect, useRef, type RefObject } from "react";

/** A location of an inventory page: its list (no mode), an entity or an editor. */
export interface SettingsSplitLocation {
  readonly path: string;
  readonly resourceId?: string;
  readonly mode?: string;
}

/** Whether an element is rendered: not hidden by an attribute or by the split/stack layout. */
export function isRendered(element: Element): boolean {
  if (!element.isConnected) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node instanceof HTMLElement && (node.hidden || node.inert)) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

/**
 * Scroll and focus for an inventory page whose selection and editors are
 * routes. On a new location the list gets its scroll position back and
 * anything else starts at the top; focus moves to the row of the entity
 * just left (when the list comes back), otherwise the selection's heading
 * or, at the list, the page heading. Focus on a list row that stays
 * visible beside its selection (the split layout) stays there. Rows carry
 * `data-resource-id`; headings are the kit's page and detail headings.
 */
export function useSettingsSplitFocus({ root, location, onArrive, onDialogFocus }: {
  readonly root: RefObject<HTMLElement | null>;
  /** The current location, or undefined while another settings page is shown. */
  readonly location: SettingsSplitLocation | undefined;
  /** A new location, before scroll and focus move: clear what belonged to the last one. */
  readonly onArrive?: (previous: SettingsSplitLocation | undefined, current: SettingsSplitLocation) => void;
  /** A dialog whose action moved here still has focus: it should hand focus to `target` as it closes. */
  readonly onDialogFocus?: (target: HTMLElement) => void;
}): { readonly requestFocus: () => void; readonly previousPath: () => string | undefined } {
  const previousLocation = useRef<SettingsSplitLocation | undefined>(undefined);
  const previousPath = useRef<string | undefined>(undefined);
  const focusRequest = useRef<{ readonly fromId?: string } | undefined>(undefined);
  const scrollPositions = useRef(new Map<string, number>());
  const latest = useRef({ location, onArrive, onDialogFocus });
  latest.current = { location, onArrive, onDialogFocus };

  useLayoutEffect(() => {
    const previous = previousLocation.current;
    const current = latest.current.location;
    // Another settings page is shown: coming back is a new arrival.
    if (!current) { previousLocation.current = undefined; return; }
    previousLocation.current = current;
    previousPath.current = previous?.path;
    if (previous && previous.path === current.path) return;
    latest.current.onArrive?.(previous, current);
    const scroller = root.current?.closest(".settings-content");
    if (scroller) {
      if (previous) scrollPositions.current.set(previous.path, scroller.scrollTop);
      scroller.scrollTop = !current.mode ? scrollPositions.current.get(current.path) ?? 0 : 0;
    }
    focusRequest.current = { ...(previous?.resourceId && !current.mode ? { fromId: previous.resourceId } : {}) };
  }, [location?.path]);

  // Move focus once the location's content has rendered (an editor renders
  // once its draft exists), so this checks after every render until then.
  useLayoutEffect(() => {
    const request = focusRequest.current;
    const container = root.current;
    const current = latest.current.location;
    if (!request || !current || !container) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest("[data-slot=settings-split-list]") && container.contains(active) && isRendered(active)) {
      focusRequest.current = undefined;
      return;
    }
    const row = request.fromId ? Array.from(container.querySelectorAll<HTMLElement>("[data-resource-id]"))
      .find(entry => entry.dataset.resourceId === request.fromId)?.querySelector<HTMLElement>("[data-slot=entity-row-main]") : undefined;
    const headings = Array.from(container.querySelectorAll<HTMLElement>(current.mode ? "[data-detail-heading]" : "[data-slot=settings-page-title]"));
    const target = (row && isRendered(row) ? row : undefined) ?? headings.find(isRendered);
    if (!target) return;
    focusRequest.current = undefined;
    if (active?.closest("[role=dialog], [role=alertdialog]")) {
      latest.current.onDialogFocus?.(target);
      return;
    }
    target.focus({ preventScroll: true });
  });

  return {
    requestFocus: () => { focusRequest.current = {}; },
    previousPath: () => previousPath.current,
  };
}
