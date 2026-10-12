import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { cx, toneClass } from "../lib/cx";
import type { Tone } from "../lib/cx";
import { isMac, paletteShortcutLabel } from "../lib/hotkeys";
import type { ThemeMode } from "../lib/theme";
import { IconButton } from "./Button";
import { Kbd, StatusDot } from "./Chips";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useLinkComponent } from "./Link";
import { Menu } from "./Popover";

interface TopBarFit {
  /** NavTabs receives the indexes of the tabs moved into its "More" menu. */
  registerNav: (sink: (hidden: readonly number[]) => void) => () => void;
  refit: () => void;
}

const TopBarContext = createContext<TopBarFit | null>(null);

/**
 * Compaction steps, applied in order while the bar is crowded (tabs or the
 * status text clipped, or the bar overflowing). Each is a data attribute
 * on the header that the CSS responds to.
 */
const STEPS: readonly (readonly [string, string])[] = [
  ["wbBrand", "compact"], // brand name visually hidden (still its name)
  ["wbSearch", "icon"], // TopSearch shows only its icon
  ["wbStatus", "short"], // TopStatus shows its shortLabel (or only the dot)
  ["wbNavIcons", "off"], // NavTab icons hidden
];

function isClipped(el: Element | null | undefined): boolean {
  return !!el && el.scrollWidth > el.clientWidth + 1;
}

/**
 * Text cut off with an ellipsis. scrollWidth/clientWidth are rounded, so a
 * sub-pixel overflow (which still shows "…") needs the text's own layout
 * width, measured with a Range.
 */
function isTextClipped(el: Element | null | undefined): boolean {
  if (!el) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  if (typeof range.getBoundingClientRect !== "function") return isClipped(el);
  const text = range.getBoundingClientRect().width;
  const box = el.getBoundingClientRect().width;
  return text > box + 0.01 || isClipped(el);
}

/**
 * Fit the bar's content into its width without silently clipping anything:
 * compact step by step; if tabs still don't fit, move the last ones (never
 * the current tab) into NavTabs' "More" menu. Synchronous DOM work, so it
 * runs before paint. Returns the hidden tab indexes (or null: no NavTabs).
 */
function fitTopBar(bar: HTMLElement): number[] | null {
  const nav = bar.querySelector<HTMLElement>(".wb-nav");
  const tabs = nav
    ? Array.from(
        nav.querySelectorAll<HTMLElement>(
          ":scope > .wb-nav-tab:not(.wb-nav-more-btn)",
        ),
      )
    : [];
  // Tabs can only move into the menu when they map 1:1 to NavTab children.
  const canOverflow =
    !!nav && Number(nav.dataset.wbTabs ?? "-1") === tabs.length;
  for (const t of tabs) t.removeAttribute("data-wb-overflow");
  nav?.removeAttribute("data-wb-more");

  const crowded = () => {
    const status = bar.querySelector(".wb-top-status-text");
    return (
      isClipped(bar) ||
      isClipped(nav) ||
      (bar.dataset.wbStatus !== "short" && isTextClipped(status))
    );
  };

  for (const [key] of STEPS) delete bar.dataset[key];
  for (const [key, value] of STEPS) {
    if (!crowded()) return canOverflow ? [] : null;
    bar.dataset[key] = value;
  }
  if (!crowded() || !nav || !canOverflow) return canOverflow ? [] : null;

  nav.setAttribute("data-wb-more", "");
  const hidden: number[] = [];
  const order = tabs
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.getAttribute("aria-current") !== "page")
    .reverse();
  for (const { t, i } of order) {
    t.setAttribute("data-wb-overflow", "");
    hidden.push(i);
    if (!isClipped(nav) && !isClipped(bar)) break;
  }
  return hidden.sort((a, b) => a - b);
}

/**
 * 52px bar across the top: Brand, NavTabs, spacer, search trigger, status,
 * menus. When it gets crowded (narrow windows, many items) it compacts
 * progressively: the brand name is visually hidden, TopSearch collapses to
 * its icon, TopStatus shows its shortLabel, tab icons go; tabs that still
 * don't fit move into a "More" menu. Nothing is clipped silently.
 */
export function TopBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const navSink = useRef<((hidden: readonly number[]) => void) | null>(null);

  const refit = useCallback(() => {
    const bar = ref.current;
    if (!bar) return;
    const hidden = fitTopBar(bar);
    navSink.current?.(hidden ?? []);
  }, []);

  const ctx = useMemo<TopBarFit>(
    () => ({
      registerNav(sink) {
        navSink.current = sink;
        return () => {
          if (navSink.current === sink) navSink.current = null;
        };
      },
      refit,
    }),
    [refit],
  );

  // Content changes (status text, tabs) arrive as re-renders.
  useLayoutEffect(() => {
    refit();
  });

  useEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    window.addEventListener("resize", refit);
    const resize =
      typeof ResizeObserver === "function" ? new ResizeObserver(refit) : null;
    resize?.observe(bar);
    // Content that changes without re-rendering TopBar (a self-updating
    // status). Fitting only sets attributes, so it doesn't re-trigger this.
    const mutations =
      typeof MutationObserver === "function"
        ? new MutationObserver(refit)
        : null;
    mutations?.observe(bar, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    // Web fonts change text widths when they arrive.
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", refit);
    void fonts?.ready.then(refit);
    return () => {
      window.removeEventListener("resize", refit);
      resize?.disconnect();
      mutations?.disconnect();
      fonts?.removeEventListener?.("loadingdone", refit);
    };
  }, [refit]);

  return (
    <TopBarContext.Provider value={ctx}>
      <header ref={ref} className={cx("wb-topbar", className)}>
        {children}
      </header>
    </TopBarContext.Provider>
  );
}

/** Accent square + app name; a link home when `href` is set. */
export function Brand({
  name,
  icon = "pulse",
  href,
  className,
}: {
  name: string;
  icon?: IconName | undefined;
  href?: string | undefined;
  className?: string | undefined;
}) {
  const Link = useLinkComponent();
  const body = (
    <>
      <span className="wb-brand-mark" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="wb-brand-name">{name}</span>
    </>
  );
  return href ? (
    <Link href={href} className={cx("wb-brand", className)}>
      {body}
    </Link>
  ) : (
    <span className={cx("wb-brand", className)}>{body}</span>
  );
}

function sameIndexes(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Primary view tabs (a <nav>, at most ~6). Inside a TopBar, tabs that don't
 * fit move into a "More" menu at the end (the current tab always stays).
 * Children must be NavTab elements for that; other children disable it.
 */
export function NavTabs({
  label = "Main",
  moreLabel = "More",
  children,
  className,
}: {
  label?: string | undefined;
  /** Text of the overflow menu button (default "More"). */
  moreLabel?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  const bar = useContext(TopBarContext);
  const [hidden, setHidden] = useState<readonly number[]>([]);
  const all = Children.toArray(children);
  const tabs = all.filter(
    (c): c is ReactElement<NavTabProps> =>
      isValidElement(c) && c.type === NavTab,
  );
  const onlyTabs = tabs.length === all.length;

  useLayoutEffect(() => {
    if (!bar) return;
    return bar.registerNav((next) =>
      setHidden((prev) => (sameIndexes(prev, next) ? prev : next)),
    );
  }, [bar]);
  // Tabs changed (labels, counts, current): fit again.
  useLayoutEffect(() => {
    bar?.refit();
  });

  const overflow = hidden
    .map((i) => tabs[i])
    .filter((t): t is ReactElement<NavTabProps> => !!t);
  const attention = overflow.filter((t) => t.props.count !== undefined);

  return (
    <nav
      className={cx("wb-nav", className)}
      aria-label={label}
      data-wb-tabs={bar && onlyTabs ? tabs.length : undefined}
    >
      {children}
      {bar && onlyTabs ? (
        <Menu
          label={moreLabel}
          placement="bottom-start"
          items={overflow.map((t) => ({
            id: t.props.href,
            label: t.props.children,
            icon: t.props.icon,
            href: t.props.href,
            hint:
              t.props.count !== undefined ? (
                <span
                  className={cx("wb-nav-count", toneClass(t.props.countTone))}
                >
                  {t.props.count}
                </span>
              ) : undefined,
          }))}
          trigger={(props) => (
            <button
              {...props}
              type="button"
              className="wb-nav-tab wb-nav-more-btn"
            >
              {moreLabel}
              {attention.length > 0 ? (
                <span
                  className={cx(
                    "wb-nav-more-dot",
                    toneClass(attention[0]?.props.countTone ?? "info"),
                  )}
                  aria-hidden="true"
                />
              ) : null}
              {attention.length > 0 ? (
                <span className="wb-sr-only">
                  {`, ${attention
                    .map((t) => t.props.countLabel ?? String(t.props.count))
                    .join(", ")}`}
                </span>
              ) : null}
              <Icon name="chevron-down" />
            </button>
          )}
        />
      ) : null}
    </nav>
  );
}

export interface NavTabProps {
  href: string;
  current?: boolean | undefined;
  icon?: IconName | undefined;
  /** Attention badge (e.g. unverified credentials). */
  count?: number | string | undefined;
  countTone?: Tone | undefined;
  /** Spoken text for the badge ("2 need attention"). */
  countLabel?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
}

/** One primary view link; `current` sets aria-current="page". */
export function NavTab({
  href,
  current = false,
  icon,
  count,
  countTone,
  countLabel,
  children,
  className,
}: NavTabProps) {
  const Link = useLinkComponent();
  return (
    <Link
      href={href}
      className={cx("wb-nav-tab", className)}
      aria-current={current ? "page" : undefined}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
      {count !== undefined ? " " : null}
      {count !== undefined ? (
        <span className={cx("wb-nav-count", toneClass(countTone))}>
          <span aria-hidden={countLabel ? true : undefined}>{count}</span>
          {countLabel ? <span className="wb-sr-only">{countLabel}</span> : null}
        </span>
      ) : null}
    </Link>
  );
}

/** The Ctrl-K trigger styled as a search field. */
export function TopSearch({
  onClick,
  placeholder = "Search…",
  shortcut = paletteShortcutLabel,
  className,
}: {
  onClick: () => void;
  placeholder?: string | undefined;
  shortcut?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <button
      type="button"
      className={cx("wb-top-search", className)}
      onClick={onClick}
      aria-label={placeholder}
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      aria-haspopup="dialog"
    >
      <Icon name="search" />
      <span className="wb-top-search-text">{placeholder}</span>
      <Kbd>{shortcut}</Kbd>
    </button>
  );
}

/**
 * Status indicator: dot + short text; a link when `href` is set (its
 * details page, through LinkProvider), a button when `onClick` is set (opens
 * details). In a crowded TopBar it shows `shortLabel` (or only the dot);
 * the full label stays available to assistive technology.
 */
export function TopStatus({
  tone = "success",
  label,
  shortLabel,
  detail,
  pulse = false,
  icon,
  href,
  onClick,
  className,
}: {
  tone?: Tone | undefined;
  /** Visible text ("Synced 2 h ago", "r5 active · native on"). */
  label: ReactNode;
  /** Shown instead of `label` when the bar is crowded ("r5"). */
  shortLabel?: ReactNode;
  /** Tooltip with more detail. */
  detail?: string | undefined;
  pulse?: boolean | undefined;
  /** Replaces the dot (e.g. a spinner-like icon). */
  icon?: ReactNode;
  /** Renders a link (e.g. to the sync settings); `onClick` still runs. */
  href?: string | undefined;
  onClick?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const Link = useLinkComponent();
  const body = (
    <>
      {icon ?? <StatusDot tone={tone} pulse={pulse} />}
      <span className="wb-top-status-text">{label}</span>
      {shortLabel !== undefined ? (
        <span className="wb-top-status-short" aria-hidden="true">
          {shortLabel}
        </span>
      ) : null}
    </>
  );
  if (href !== undefined)
    return (
      <Link
        href={href}
        className={cx("wb-top-status", className)}
        title={detail}
        onClick={onClick}
      >
        {body}
      </Link>
    );
  return onClick ? (
    <button
      type="button"
      className={cx("wb-top-status", className)}
      title={detail}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className={cx("wb-top-status", className)} title={detail}>
      {body}
    </div>
  );
}

const THEME_ICON: Record<ThemeMode, IconName> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

/** Theme picker (System / Light / Dark) as an icon-button menu. Pair with useTheme(). */
export function ThemeMenu({
  mode,
  onChange,
  label = "Theme",
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  label?: string | undefined;
}) {
  const option = (value: ThemeMode, text: string) => ({
    id: value,
    label: text,
    checked: mode === value,
    onSelect: () => onChange(value),
  });
  return (
    <Menu
      label={label}
      items={[
        option("system", "System"),
        option("light", "Light"),
        option("dark", "Dark"),
      ]}
      trigger={(props) => (
        <IconButton
          {...props}
          icon={THEME_ICON[mode]}
          label={`${label}: ${mode}`}
        />
      )}
    />
  );
}
