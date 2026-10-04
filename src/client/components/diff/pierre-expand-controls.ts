import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { PostRenderPhase } from "@pierre/diffs";

/** An expand control as a re-render can find it again. */
interface ExpandControl {
  readonly host: Element;
  readonly index: string | null;
  readonly kind: string | undefined;
}

const EXPAND_KINDS = [
  "data-expand-up",
  "data-expand-down",
  "data-expand-both",
  "data-expand-all-button",
] as const;

const isExpandControl = (
  target: EventTarget | undefined,
): target is HTMLElement =>
  target instanceof HTMLElement && target.hasAttribute("data-expand-button");

const expandControl = (element: HTMLElement): ExpandControl => ({
  host: (element.getRootNode() as ShadowRoot).host,
  index:
    element.closest("[data-expand-index]")?.getAttribute("data-expand-index") ??
    null,
  kind: EXPAND_KINDS.find((kind) => element.hasAttribute(kind)),
});

/**
 * Names a Pierre expand control after the way its chevron points: Pierre's
 * "up" control reveals the lines below the hunk above it.
 */
export function pierreExpandControlLabel(element: Element): string {
  if (element.hasAttribute("data-expand-up")) return "Expand down";
  if (element.hasAttribute("data-expand-down")) return "Expand up";
  return "Expand all";
}

/**
 * Pierre renders its hunk expand controls as `div role="button"` with only an
 * icon: no name and out of the tab order. This names them, makes them
 * focusable, and makes Enter and Space click them. A click re-renders the file
 * and replaces the control, which drops focus to the page, so the next render
 * of that file puts focus back on the control in its place (or on the scroller
 * once the gap is gone).
 *
 * Pass `onPostRender` in the CodeView options and `onKeyDown` on an ancestor of
 * the CodeView.
 */
export function usePierreExpandControls(
  scroller: RefObject<HTMLElement | null>,
): {
  readonly onPostRender: (
    node: HTMLElement,
    instance: unknown,
    phase: PostRenderPhase,
  ) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent) => void;
} {
  const focused = useRef<ExpandControl | null>(null);
  const track = useCallback((event: Event) => {
    const element = event.composedPath().find(isExpandControl);
    focused.current = element ? expandControl(element) : null;
  }, []);
  // pointerdown too: a click that focuses nothing must not bring focus back.
  useEffect(() => {
    document.addEventListener("focusin", track);
    document.addEventListener("pointerdown", track);
    return () => {
      document.removeEventListener("focusin", track);
      document.removeEventListener("pointerdown", track);
    };
  }, [track]);
  // Focus moving inside one shadow root does not reach the document.
  const roots = useRef(new WeakSet<ShadowRoot>());
  const onPostRender = useCallback(
    (node: HTMLElement, _instance: unknown, phase: PostRenderPhase) => {
      const root = node.shadowRoot;
      if (phase === "unmount" || !root) return;
      if (!roots.current.has(root)) {
        roots.current.add(root);
        root.addEventListener("focusin", track);
      }
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-expand-button]:not([tabindex])",
      )) {
        const label = pierreExpandControlLabel(element);
        element.tabIndex = 0;
        element.title = label;
        element.setAttribute("aria-label", label);
      }
      const last = focused.current;
      if (last?.host !== node || document.activeElement !== document.body)
        return;
      // Split view renders each separator in both gutters, one hidden.
      const controls = [
        ...root.querySelectorAll<HTMLElement>(
          `[data-expand-index="${last.index}"] [data-expand-button]`,
        ),
      ].filter((element) => element.getClientRects().length > 0);
      (
        controls.find(
          (element) => last.kind !== undefined && element.hasAttribute(last.kind),
        ) ??
        controls[0] ??
        scroller.current
      )?.focus({ preventScroll: true });
    },
    [scroller, track],
  );
  const onKeyDown = useCallback((event: ReactKeyboardEvent) => {
    const target = event.nativeEvent.composedPath()[0];
    if ((event.key === "Enter" || event.key === " ") && isExpandControl(target)) {
      event.preventDefault();
      target.click();
    }
  }, []);
  return { onPostRender, onKeyDown };
}
