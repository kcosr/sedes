import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../lib/cx";
import { tabbableIn } from "../lib/layers";
import { readStorage, writeStorage } from "../lib/storage";
import { usePaneResize } from "../lib/panes";
import { IconButton } from "./Button";

export interface AppShellProps {
  /** <TopBar>. */
  topBar: ReactNode;
  /** <Sidebar>; omit on settings-style pages. */
  sidebar?: ReactNode;
  /**
   * localStorage key for the sidebar width (e.g. "my-app:sidebar-width");
   * the collapsed state is stored under `<key>:collapsed`.
   */
  sidebarStorageKey?: string | undefined;
  sidebarMin?: number | undefined;
  sidebarMax?: number | undefined;
  sidebarDefault?: number | undefined;
  /** <Drawer> when an item is open, else null. Pushes the layout (third column). */
  drawer?: ReactNode;
  /** Enable a pointer/keyboard separator on the drawer's left edge. */
  drawerResizable?: boolean | undefined;
  /** Persist a resizable drawer's width independently of its open/closed state. */
  drawerStorageKey?: string | undefined;
  drawerMin?: number | undefined;
  drawerMax?: number | undefined;
  drawerDefault?: number | undefined;
  /** The main pane (<Main>). */
  children?: ReactNode;
  /**
   * id of the <Main> focus target; Main inside the shell uses it by default
   * (default "wb-main").
   */
  mainId?: string | undefined;
  /**
   * Text of the "Skip to content" link rendered first in the shell, or
   * false to leave it out (default "Skip to content").
   */
  skipLink?: string | false | undefined;
  className?: string | undefined;
}

/** The main pane never gets narrower than this. */
const MAIN_MIN = 360;
/**
 * When an open drawer would leave the main pane less than this next to a
 * minimum-width sidebar, the sidebar collapses automatically (wide drawers
 * below ~1460px, any drawer below ~1160px).
 */
const MAIN_COMFORT = 480;
/** The drawer never narrows below this. */
const DRAWER_MIN = 320;
/** Width of the collapsed-sidebar rail (.wb-sidebar-rail). */
const RAIL_W = 44;

function readWidth(
  key: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!key) return fallback;
  const v = Number(readStorage(key));
  return Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : fallback;
}

export interface ShowSidebarOptions {
  /**
   * Move focus into the sidebar once it is visible: "first" (its first
   * control) or a function returning the element, e.g. its search field:
   * `(pane) => pane.querySelector("input")`.
   */
  focus?:
    | "first"
    | ((pane: HTMLElement) => HTMLElement | null | undefined)
    | undefined;
}

export interface AppShellState {
  /** The shell has a sidebar on this page. */
  hasSidebar: boolean;
  /** The sidebar is collapsed (by the user, or automatically for a drawer). */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /**
   * Expand the sidebar (it stays expanded while a drawer would collapse it
   * automatically); does nothing to one already shown, except focus.
   */
  showSidebar: (options?: ShowSidebarOptions) => void;
  /** Collapse the sidebar; does nothing to one already collapsed. */
  hideSidebar: () => void;
  /** id of the sidebar pane (for aria-controls). */
  sidebarId: string;
  /** id of the main pane (the skip link's target). */
  mainId: string;
}

const AppShellContext = createContext<AppShellState | null>(null);

/**
 * Keyboard skip link: visually hidden until focused, then moves focus to the
 * element with `targetId` (without touching the URL, so hash routers are
 * safe). AppShell renders one; use this outside AppShell.
 */
export function SkipLink({
  targetId = DEFAULT_MAIN_ID,
  children = "Skip to content",
  className,
}: {
  targetId?: string | undefined;
  children?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <a
      className={cx("wb-skip-link", className)}
      href={`#${targetId}`}
      onClick={(e) => {
        e.preventDefault();
        const target = document.getElementById(targetId);
        target?.focus();
        target?.scrollIntoView?.({ block: "nearest" });
      }}
    >
      {children}
    </a>
  );
}

export const DEFAULT_MAIN_ID = "wb-main";

/** Sidebar state of the surrounding AppShell (null outside one). */
export function useAppShell(): AppShellState | null {
  return useContext(AppShellContext);
}

/** Top-bar button that collapses/expands the sidebar; renders nothing without one. */
export function SidebarToggle({
  className,
}: {
  className?: string | undefined;
}) {
  const shell = useAppShell();
  if (!shell?.hasSidebar) return null;
  return (
    <IconButton
      icon="sidebar"
      label={shell.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
      aria-expanded={!shell.sidebarCollapsed}
      aria-controls={shell.sidebarId}
      className={className}
      onClick={shell.toggleSidebar}
    />
  );
}

function cssPx(el: Element, name: string): number {
  const v = parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(v) ? v : 0;
}

/**
 * The app frame: top bar across, then sidebar | main | drawer. The document
 * never scrolls; only panes do. The sidebar is resizable (drag, or arrow keys
 * on the separator; double-click resets), collapsible (SidebarToggle or the
 * rail), and both are persisted. With a drawer open the layout keeps the main
 * pane at least 360px wide: the sidebar narrows or collapses and the drawer
 * narrows.
 */
export function AppShell({
  topBar,
  sidebar,
  sidebarStorageKey,
  sidebarMin = 220,
  sidebarMax = 480,
  sidebarDefault = 268,
  drawer,
  drawerResizable = false,
  drawerStorageKey,
  drawerMin = 380,
  drawerMax: drawerBound = 900,
  drawerDefault = 540,
  children,
  mainId = DEFAULT_MAIN_ID,
  skipLink = "Skip to content",
  className,
}: AppShellProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const drawerSlot = useRef<HTMLDivElement | null>(null);
  const pane = useRef<HTMLDivElement | null>(null);
  const rail = useRef<HTMLDivElement | null>(null);
  // Where focus should go once the sidebar is shown again.
  const focusAfter = useRef<ShowSidebarOptions["focus"]>(undefined);
  // Whether focus was last inside the sidebar (browsers may already have
  // moved a hidden element's focus to <body> when the collapse is handled).
  const focusInPane = useRef(false);
  const paneId = `wb-sidebar-${useId()}`;
  const drawerId = `wb-drawer-pane-${useId()}`;
  const collapsedKey = sidebarStorageKey
    ? `${sidebarStorageKey}:collapsed`
    : undefined;
  const [preferred, setPreferred] = useState(() =>
    readWidth(sidebarStorageKey, sidebarMin, sidebarMax, sidebarDefault),
  );
  const [drawerPreferred, setDrawerPreferred] = useState(() =>
    readWidth(drawerStorageKey, drawerMin, drawerBound, drawerDefault),
  );
  const [userCollapsed, setUserCollapsed] = useState(
    () => !!collapsedKey && readStorage(collapsedKey) === "1",
  );
  const [forceExpanded, setForceExpanded] = useState(false);
  const [geo, setGeo] = useState({ frame: 0, drawer: 0 });
  const hasSidebar =
    sidebar !== undefined && sidebar !== null && sidebar !== false;
  const hasDrawer = drawer !== undefined && drawer !== null && drawer !== false;

  // Measure the frame and the open drawer's preferred width (its CSS token,
  // not its rendered width, which this component may be limiting).
  useLayoutEffect(() => {
    const update = () => {
      const el = frame.current;
      if (!el) return;
      const d = drawerSlot.current?.firstElementChild;
      const drawerWidth = d
        ? d.classList.contains("wb-drawer")
          ? cssPx(
              d,
              d.classList.contains("wb-drawer--wide")
                ? "--wb-drawer-wide-w"
                : "--wb-drawer-w",
            )
          : (d as HTMLElement).offsetWidth
        : 0;
      setGeo((g) =>
        g.frame === el.clientWidth && g.drawer === drawerWidth
          ? g
          : { frame: el.clientWidth, drawer: drawerWidth },
      );
    };
    update();
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    if (frame.current) observer?.observe(frame.current);
    if (drawerSlot.current) observer?.observe(drawerSlot.current);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [hasDrawer]);

  // An explicit "show" while a drawer forced the collapse lasts until it closes.
  useEffect(() => {
    if (!hasDrawer) setForceExpanded(false);
  }, [hasDrawer]);

  const laidOut = geo.frame > 0;
  const drawerDesired = hasDrawer
    ? drawerResizable
      ? drawerPreferred
      : geo.drawer
    : 0;
  const autoCollapsed =
    hasSidebar &&
    hasDrawer &&
    laidOut &&
    geo.frame - drawerDesired - sidebarMin < MAIN_COMFORT;
  const collapsed =
    hasSidebar && (userCollapsed || (autoCollapsed && !forceExpanded));
  const sidebarShown = hasSidebar && !collapsed;

  const limit = laidOut
    ? Math.max(
        sidebarMin,
        Math.min(sidebarMax, geo.frame - drawerDesired - MAIN_MIN),
      )
    : sidebarMax;
  const width = Math.min(preferred, limit);
  const drawerMax =
    laidOut && hasDrawer
      ? Math.max(
          drawerResizable ? drawerMin : DRAWER_MIN,
          geo.frame -
            (sidebarShown ? width : hasSidebar ? RAIL_W : 0) -
            MAIN_MIN,
        )
      : null;

  const sidebarResize = usePaneResize(
    {
      label: "Sidebar width",
      controls: paneId,
      className: "wb-sidebar-resize",
      cssVar: "--wb-side-w",
      min: sidebarMin,
      max: sidebarMax,
      grow: 1,
    },
    frame,
    {
      enabled: sidebarShown,
      preferred,
      width,
      limit,
      save: (value) => {
        setPreferred(value);
        if (sidebarStorageKey) writeStorage(sidebarStorageKey, String(value));
      },
      reset: () => {
        setPreferred(sidebarDefault);
        if (sidebarStorageKey)
          writeStorage(sidebarStorageKey, String(sidebarDefault));
      },
    },
  );
  const drawerLimit = Math.min(drawerBound, drawerMax ?? drawerBound);
  const drawerWidth = Math.min(drawerPreferred, drawerLimit);
  const drawerResize = usePaneResize(
    {
      label: "Details panel width",
      controls: drawerId,
      cssVar: "--wb-resized-drawer-w",
      min: drawerMin,
      max: drawerBound,
      grow: -1,
    },
    frame,
    {
      enabled: hasDrawer && drawerResizable,
      preferred: drawerPreferred,
      width: drawerWidth,
      limit: drawerLimit,
      save: (value) => {
        setDrawerPreferred(value);
        if (drawerStorageKey) writeStorage(drawerStorageKey, String(value));
      },
      reset: () => {
        setDrawerPreferred(drawerDefault);
        if (drawerStorageKey) writeStorage(drawerStorageKey, null);
      },
    },
  );
  const handle = sidebarResize.handle;

  const focusSidebar = useCallback(
    (target: ShowSidebarOptions["focus"]) => {
      const el = pane.current;
      if (!el || !target) return;
      const to =
        target === "first" ? (tabbableIn(el)[0] ?? handle.current) : target(el);
      to?.focus();
    },
    [handle],
  );

  const showSidebar = useCallback(
    (options: ShowSidebarOptions = {}) => {
      if (!hasSidebar) return;
      if (!collapsed) {
        focusSidebar(options.focus);
        return;
      }
      focusAfter.current = options.focus;
      if (userCollapsed) {
        setUserCollapsed(false);
        if (collapsedKey) writeStorage(collapsedKey, null);
      }
      if (autoCollapsed) setForceExpanded(true);
    },
    [
      hasSidebar,
      collapsed,
      userCollapsed,
      autoCollapsed,
      collapsedKey,
      focusSidebar,
    ],
  );

  const hideSidebar = useCallback(() => {
    if (!hasSidebar || collapsed) return;
    focusAfter.current = undefined;
    if (autoCollapsed) {
      setForceExpanded(false);
    } else {
      setUserCollapsed(true);
      if (collapsedKey) writeStorage(collapsedKey, "1");
    }
  }, [hasSidebar, collapsed, autoCollapsed, collapsedKey]);

  const toggleSidebar = useCallback(() => {
    if (collapsed) showSidebar();
    else hideSidebar();
  }, [collapsed, showSidebar, hideSidebar]);

  // Keep keyboard focus alive across collapse/expand, without fighting other
  // focus owners (a closing drawer returning focus to its row): expanding
  // moves focus into the sidebar only when asked (the rail, showSidebar's
  // `focus`); collapsing moves it to the rail only when it was inside.
  const wasCollapsed = useRef(collapsed);
  useLayoutEffect(() => {
    if (wasCollapsed.current === collapsed) return;
    wasCollapsed.current = collapsed;
    const want = focusAfter.current;
    focusAfter.current = undefined;
    if (!collapsed) {
      focusSidebar(want);
    } else if (
      pane.current?.contains(document.activeElement) ||
      (focusInPane.current &&
        (!document.activeElement || document.activeElement === document.body))
    ) {
      rail.current?.querySelector<HTMLElement>("button")?.focus();
    }
  }, [collapsed]);

  const shellState = useMemo<AppShellState>(
    () => ({
      hasSidebar,
      sidebarCollapsed: collapsed,
      toggleSidebar,
      showSidebar,
      hideSidebar,
      sidebarId: paneId,
      mainId,
    }),
    [
      hasSidebar,
      collapsed,
      toggleSidebar,
      showSidebar,
      hideSidebar,
      paneId,
      mainId,
    ],
  );

  const style: Record<string, string> = {};
  if (sidebarShown) style["--wb-side-w"] = `${width}px`;
  if (drawerMax !== null) style["--wb-drawer-max"] = `${drawerMax}px`;
  if (drawerResizable) style["--wb-resized-drawer-w"] = `${drawerWidth}px`;

  return (
    <AppShellContext.Provider value={shellState}>
      <div
        ref={frame}
        className={cx(
          "wb-app",
          (sidebarResize.dragging || drawerResize.dragging) && "is-resizing",
          className,
        )}
        style={style as CSSProperties}
      >
        {skipLink === false ? null : (
          <SkipLink targetId={mainId}>{skipLink}</SkipLink>
        )}
        {topBar}
        {hasSidebar && collapsed ? (
          <div className="wb-sidebar-rail" ref={rail}>
            <IconButton
              icon="sidebar"
              label="Show sidebar"
              aria-expanded={false}
              aria-controls={paneId}
              onClick={() => showSidebar({ focus: "first" })}
            />
          </div>
        ) : null}
        {hasSidebar ? (
          <div
            className="wb-sidebar-pane"
            id={paneId}
            ref={pane}
            hidden={collapsed}
            onFocus={() => {
              focusInPane.current = true;
            }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                focusInPane.current = false;
            }}
          >
            {sidebar}
            {sidebarResize.separator}
          </div>
        ) : null}
        <div className="wb-app-main">{children}</div>
        {hasDrawer ? (
          <div
            className={cx("wb-app-drawer", drawerResizable && "is-resizable")}
            ref={drawerSlot}
            id={drawerId}
            data-wb-drawer-slot=""
          >
            {drawer}
            {drawerResizable ? drawerResize.separator : null}
          </div>
        ) : null}
      </div>
    </AppShellContext.Provider>
  );
}
