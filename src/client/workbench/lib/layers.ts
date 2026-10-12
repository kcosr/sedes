/**
 * Overlay plumbing, with support for nesting:
 *
 * - A stack of dismissable layers (palette, modal, popover, drawer) so one
 *   document-level Escape handler closes the top-most one. Blocking layers
 *   also disable list shortcuts (j/k/Enter/o) while open. Layers nested in
 *   the React tree always sit above their ancestors, even when both mount in
 *   the same commit.
 * - Portal ownership: an overlay rendered inside another (a combobox listbox
 *   in a popover, a popover in a modal) is portaled to <body> but still
 *   counts as "inside" its parent for outside-click, focus-leave and
 *   focus-trap checks.
 * - A focus trap for modal surfaces.
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";

// ---------------------------------------------------------------- scope

/** Something that can say whether a DOM node belongs to it (including owned portals). */
export interface OverlayOwner {
  contains(target: Node | null | undefined): boolean;
}

interface OwnerNode extends OverlayOwner {
  children: Set<OwnerNode>;
}

interface ScopeValue {
  /** Ids of the enclosing layers, outermost first. */
  layers: readonly number[];
  owner: OwnerNode | null;
}

const ScopeContext = createContext<ScopeValue>({ layers: [], owner: null });

/**
 * Provide the layer chain and/or portal owner of an overlay to its subtree
 * (kit overlays do this; custom overlays built on useLayer/useOverlayOwner
 * should too).
 */
export function OverlayScope({
  layers,
  owner,
  children,
}: {
  layers?: readonly number[] | undefined;
  owner?: OverlayOwner | undefined;
  children?: ReactNode;
}) {
  const parent = useContext(ScopeContext);
  const value = useMemo<ScopeValue>(
    () => ({
      layers: layers ?? parent.layers,
      owner: (owner as OwnerNode | undefined) ?? parent.owner,
    }),
    [layers, owner, parent],
  );
  return createElement(ScopeContext.Provider, { value }, children);
}

/**
 * An owner for the element in `ref`: `contains()` is true for the element's
 * subtree and for every overlay registered below it in the React tree.
 */
export function useOverlayOwner(
  ref: RefObject<HTMLElement | null>,
): OverlayOwner {
  const parent = useContext(ScopeContext).owner;
  const [node] = useState<OwnerNode>(() => {
    const children = new Set<OwnerNode>();
    return {
      children,
      contains(target) {
        if (!target) return false;
        if (ref.current?.contains(target)) return true;
        for (const child of children) if (child.contains(target)) return true;
        return false;
      },
    };
  });
  useEffect(() => {
    if (!parent) return;
    parent.children.add(node);
    return () => {
      parent.children.delete(node);
    };
  }, [parent, node]);
  return node;
}

// ---------------------------------------------------------------- layers

interface Layer {
  id: number;
  ancestors: readonly number[];
  close: () => void;
  blocking: boolean;
  surface: RefObject<HTMLElement | null> | undefined;
}

const stack: Layer[] = [];
let seq = 0;
let listening = false;

function onEscape(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

/**
 * Paint order follows the layer stack: every portaled surface gets
 * --wb-z-depth = its position (1-based), and overlay CSS uses
 * calc(var(--wb-z-overlay) + var(--wb-z-depth)). Set through CSSOM.
 */
function restack(): void {
  stack.forEach((layer, i) => {
    layer.surface?.current?.style.setProperty("--wb-z-depth", String(i + 1));
  });
}

/** Number of open layers; a transient surface (a listbox) opening now paints at this + 1. */
export function layerDepth(): number {
  return stack.length;
}

function syncListener(): void {
  if (typeof document === "undefined") return;
  if (stack.length > 0 && !listening) {
    document.addEventListener("keydown", onEscape);
    listening = true;
  } else if (stack.length === 0 && listening) {
    document.removeEventListener("keydown", onEscape);
    listening = false;
  }
}

/**
 * Register a dismissable layer while `active`. Escape calls `close` when this
 * is the top-most layer. Components that handle Escape themselves (a filter
 * input clearing its text) call `e.stopPropagation()` or `e.preventDefault()`.
 * Pass the portaled root as `surface` to paint it in stack order.
 *
 * Returns a scope chain and a stable isTop() callback for custom shortcuts.
 * Pass scope to <OverlayScope layers={…}> so nested layers stack above it.
 */
export function useLayerHandle(
  active: boolean,
  close: () => void,
  blocking = true,
  surface?: RefObject<HTMLElement | null>,
): LayerHandle {
  const parent = useContext(ScopeContext).layers;
  const [id] = useState(() => ++seq);
  const ref = useRef(close);
  useLayoutEffect(() => {
    ref.current = close;
  });
  // Layout effect: the stack and paint order are right before the first paint.
  useLayoutEffect(() => {
    if (!active) return;
    const layer: Layer = {
      id,
      ancestors: parent,
      close: () => ref.current(),
      blocking,
      surface,
    };
    // Descendants that registered first (same commit: child effects run
    // before parents) must stay above this layer.
    const firstDescendant = stack.findIndex((l) => l.ancestors.includes(id));
    if (firstDescendant >= 0) stack.splice(firstDescendant, 0, layer);
    else stack.push(layer);
    restack();
    syncListener();
    return () => {
      const i = stack.findIndex((l) => l.id === id);
      if (i >= 0) stack.splice(i, 1);
      restack();
      syncListener();
    };
  }, [active, blocking, id, parent, surface]);
  const scope = useMemo(() => [...parent, id], [parent, id]);
  const isTop = useMemo(() => () => stack[stack.length - 1]?.id === id, [id]);
  return useMemo(() => ({ scope, isTop }), [scope, isTop]);
}

export interface LayerHandle {
  /** Pass to <OverlayScope layers={scope}> so nested overlays stack correctly. */
  scope: readonly number[];
  /** Stable callback reading the live registry; false while inactive. */
  isTop: () => boolean;
}

/** Register a layer and return its scope chain. See useLayerHandle for shortcut gating. */
export function useLayer(
  active: boolean,
  close: () => void,
  blocking = true,
  surface?: RefObject<HTMLElement | null>,
): readonly number[] {
  return useLayerHandle(active, close, blocking, surface).scope;
}

/** The top-most open layer, if any. */
export function topLayer():
  | { close: () => void; blocking: boolean }
  | undefined {
  return stack[stack.length - 1];
}

/** True while a modal-like layer (modal, palette, popover, menu) is open. */
export function hasBlockingLayer(): boolean {
  return stack.some((l) => l.blocking);
}

// ---------------------------------------------------------------- focus

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Is `el` a place where single-key shortcuts (j, k, /) would eat typing? */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT")
    return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  const role = el.getAttribute("role");
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  "summary",
].join(", ");

/** Only a <details> element's own (first) summary is focusable. */
function focusableSummary(el: HTMLElement): boolean {
  if (el.tagName !== "SUMMARY") return true;
  const parent = el.parentElement;
  return (
    parent?.tagName === "DETAILS" &&
    Array.from(parent.children).find((c) => c.tagName === "SUMMARY") === el
  );
}

function byDocumentOrder(a: Node, b: Node): number {
  const pos = a.compareDocumentPosition(b);
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function isVisible(el: HTMLElement): boolean {
  // checkVisibility is exact in browsers; environments without layout (jsdom)
  // lack it, and there every element counts as visible.
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}

/** Tabbable elements inside `root`, in DOM order. */
/** Could the element take focus from Tab, ignoring radio-group rules? */
function focusEligible(el: HTMLElement): boolean {
  return (
    el.tabIndex >= 0 &&
    // Also covers controls disabled through a <fieldset disabled>.
    !el.matches(":disabled") &&
    focusableSummary(el) &&
    !el.closest("[inert]") &&
    (isVisible(el) || el === document.activeElement)
  );
}

/**
 * A radio is a Tab stop only as its group's checked radio, or as the
 * group's first radio when none is checked (as browsers do), counting only
 * radios that can take focus.
 */
function radioTabStop(el: HTMLElement, root: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name)
    return true;
  const scope: ParentNode = el.form ?? root;
  const group = Array.from(
    scope.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ).filter((r) => r.name === el.name && r.form === el.form && focusEligible(r));
  const checked = group.find((r) => r.checked);
  return checked ? checked === el : group[0] === el;
}

/** Tabbable elements inside `root`, in native Tab order (document order). */
export function tabbableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => focusEligible(el) && radioTabStop(el, root))
    .sort(byDocumentOrder);
}

/** Root element of the innermost active focus trap (e.g. the top modal). */
export function activeTrapRoot(): HTMLElement | null {
  return traps[traps.length - 1]?.root.current ?? null;
}

// Only the innermost active trap handles Tab (a confirm dialog over a modal).
// Ordered like layers: a trap nested in another stays above it even when both
// activate in the same commit.
interface Trap {
  id: number;
  chain: readonly number[];
  root: RefObject<HTMLElement | null>;
}
const traps: Trap[] = [];
let trapSeq = 0;

function isDescendantChain(
  chain: readonly number[],
  of: readonly number[],
): boolean {
  return chain.length > of.length && of.every((id, i) => chain[i] === id);
}

export interface FocusTrapOptions {
  /** Element to focus on activation; defaults to the first text field, then the first tabbable, then the container. */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  /** Restore focus to the element focused before activation (default true). */
  restoreFocus?: boolean | undefined;
  /** Overlays owned by the trapped surface (portaled popovers) count as inside. */
  owner?: OverlayOwner | undefined;
  /** The surface's layer chain (from useLayer), to order nested traps. */
  layers?: readonly number[] | undefined;
}

/**
 * Modal focus handling: move focus into `ref` when it activates (unless
 * something inside already has it, e.g. an autoFocus input), keep Tab inside
 * while active, and restore focus to the opener on deactivation. The opener
 * is captured on every inactive-to-active transition.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active = true,
  options: FocusTrapOptions = {},
): void {
  // Captured during render: by the time effects run, an autoFocus field
  // inside has already taken focus.
  const [activation, setActivation] = useState<{
    active: boolean;
    opener: HTMLElement | null;
  }>(() => ({
    active,
    opener: active ? currentFocus() : null,
  }));
  if (activation.active !== active) {
    setActivation({ active, opener: active ? currentFocus() : null });
  }
  const opener = activation.opener;
  const scopeLayers = useContext(ScopeContext).layers;
  const { initialFocus, restoreFocus = true, owner } = options;
  const chain = options.layers ?? scopeLayers;

  useEffect(() => {
    if (!active) return;
    const box = ref.current;
    const id = ++trapSeq;
    const trap: Trap = { id, chain, root: ref };
    const firstDescendant = traps.findIndex((t) =>
      isDescendantChain(t.chain, chain),
    );
    if (firstDescendant >= 0) traps.splice(firstDescendant, 0, trap);
    else traps.push(trap);
    const inside = (node: Node | null) =>
      !!node && (!!box?.contains(node) || !!owner?.contains(node));
    if (box && !inside(document.activeElement)) {
      // Prefer the requested element, then the first usable text field,
      // then the first Tab stop, then the container; skip any candidate
      // that can't actually take focus (e.g. inside <fieldset disabled>).
      const textField = Array.from(
        box.querySelectorAll<HTMLElement>(
          "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea",
        ),
      ).find(focusEligible);
      const candidates = [
        initialFocus?.current,
        textField,
        tabbableIn(box)[0],
        box,
      ];
      for (const el of candidates) {
        if (!el) continue;
        el.focus({ preventScroll: true });
        if (document.activeElement === el) break;
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || traps[traps.length - 1]?.id !== id) return;
      const root = ref.current;
      if (!root) return;
      const current = document.activeElement;
      // Focus is in an owned popover: it manages Tab at its own edges.
      if (current && !root.contains(current) && owner?.contains(current))
        return;
      const els = tabbableIn(root);
      const first = els[0];
      const last = els[els.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const within = root.contains(current);
      if (e.shiftKey && (current === first || !within)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !within)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = traps.findIndex((t) => t.id === id);
      if (i >= 0) traps.splice(i, 1);
      if (!restoreFocus || !opener || opener === document.body) return;
      const current = document.activeElement;
      const lost = !current || current === document.body || inside(current);
      if (lost && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref, active, opener, initialFocus, restoreFocus, owner, chain]);
}

function currentFocus(): HTMLElement | null {
  return typeof document !== "undefined"
    ? (document.activeElement as HTMLElement | null)
    : null;
}
