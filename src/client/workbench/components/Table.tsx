import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { cx } from "../lib/cx";
import { hasTextSelection, isPlainClick } from "../lib/dom";
import { findRow, ROW_ID_ATTR, useListCursor } from "../lib/listCursor";
import { Icon } from "./Icon";
import { useLinkComponent } from "./Link";
import { Banner, Skeleton } from "./States";

// ---------------------------------------------------------------- sorting

export type SortDir = "asc" | "desc";

export interface SortState {
  key: string;
  dir: SortDir;
}

/**
 * The sort after activating column `key`: unsorted → `firstDir` → the other
 * direction → unsorted.
 */
export function nextSort(
  current: SortState | null | undefined,
  key: string,
  firstDir: SortDir = "asc",
): SortState | null {
  if (!current || current.key !== key) return { key, dir: firstDir };
  if (current.dir === firstDir)
    return { key, dir: firstDir === "asc" ? "desc" : "asc" };
  return null;
}

/**
 * A sortable column header: a button cycling unsorted → first direction →
 * other direction → unsorted. Only the sorted column carries aria-sort.
 */
export function SortHeader({
  label,
  sortKey,
  sort,
  onSortChange,
  firstDir = "asc",
  align = "start",
  className,
  style,
  children,
}: {
  label: ReactNode;
  sortKey: string;
  sort: SortState | null | undefined;
  onSortChange: (sort: SortState | null) => void;
  /** First direction when activated (e.g. "desc" for counts and dates). */
  firstDir?: SortDir | undefined;
  align?: "start" | "center" | "end" | undefined;
  className?: string | undefined;
  /** Column width etc. (e.g. { width: 120 }). */
  style?: CSSProperties | undefined;
  /** More header content after the sort button. */
  children?: ReactNode;
}) {
  const dir = sort?.key === sortKey ? sort.dir : null;
  return (
    <th
      scope="col"
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined
      }
      className={cx(alignClass(align), className)}
      style={style}
    >
      <button
        type="button"
        className="wb-th-sort"
        onClick={() => onSortChange(nextSort(sort, sortKey, firstDir))}
      >
        <span className="wb-th-sort-label">{label}</span>
        <Icon name="arrow-down" />
      </button>
      {children}
    </th>
  );
}

function alignClass(align: "start" | "center" | "end" | undefined) {
  return align === "end"
    ? "wb-cell-num"
    : align === "center"
      ? "wb-cell-center"
      : undefined;
}

// ---------------------------------------------------------------- states

/** Placeholder rows while a table loads (put them in a <tbody>). */
export function TableSkeletonRows({
  columns,
  rows = 6,
  cellClassNames,
  filler = false,
}: {
  /** Number of columns. */
  columns: number;
  rows?: number | undefined;
  /** Per-column classes (e.g. priority classes, so the same columns hide). */
  cellClassNames?: readonly (string | undefined)[] | undefined;
  /** Add an empty trailing filler cell (DataTable fill="end"). */
  filler?: boolean | undefined;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="wb-table-skel" aria-hidden="true">
          {Array.from({ length: columns }, (_, c) => (
            <td key={c} className={cellClassNames?.[c]}>
              <Skeleton
                width={
                  c === 0
                    ? `${70 - (r % 3) * 12}%`
                    : `${45 + ((r + c) % 3) * 15}%`
                }
              />
            </td>
          ))}
          {filler ? <td className="wb-cell-filler" /> : null}
        </tr>
      ))}
    </>
  );
}

/** A full-width row for an empty or error state (put EmptyState/ErrorState inside). */
export function TableEmpty({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <tr className="wb-table-empty">
      <td colSpan={colSpan}>{children}</td>
    </tr>
  );
}

/** Content of a group row: title, subtitle, rule, count (like GroupHeader). */
export function TableGroupHeader({
  title,
  sub,
  count,
}: {
  title: ReactNode;
  sub?: ReactNode;
  count?: ReactNode;
}) {
  return (
    <div className="wb-table-group-h">
      <span className="wb-group-title">{title}</span>
      {sub ? <span className="wb-group-sub">{sub}</span> : null}
      <span className="wb-group-rule" />
      {count !== undefined && count !== null ? (
        <span className="wb-group-count">{count}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- DataTable

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Header becomes a sort button (needs `sort`/`onSortChange` on the table). */
  sortable?: boolean | undefined;
  /** First direction when this column is sorted (default "asc"). */
  firstSortDir?: SortDir | undefined;
  /** "end" for numbers (right-aligned, tabular). */
  align?: "start" | "center" | "end" | undefined;
  /**
   * 1 (default) never hides; 2, 3, 4 hide as the main pane narrows (below
   * 520, 700, 940px; see the README table). The primary column never hides.
   */
  priority?: 1 | 2 | 3 | 4 | undefined;
  /** The row's name column: renders the row link (default: the first column). */
  primary?: boolean | undefined;
  /**
   * Cells are one line. A truncated column still sizes to its content but
   * gives way first when space runs out, ending in an ellipsis ("start"
   * keeps the end visible, for paths).
   */
  truncate?: boolean | "start" | undefined;
  /** Let this column's cells wrap instead of staying on one line. */
  wrap?: boolean | undefined;
  /**
   * Hug the content (width: 1%), leaving spare width to the columns that
   * can use it. Default: on for every column except the primary one and
   * truncating, wrapping or fixed-width columns, so short fixed-shape
   * columns (state, IDs, dates, counts) stay tight and small tables don't
   * spread out. `fit: false` lets a column share the spare width.
   */
  fit?: boolean | undefined;
  /**
   * Share of the spare width (a weight; 0 never takes any). Default: 2 for
   * the primary column, 1 for truncating or wrapping columns, 0 otherwise
   * and for columns with a `width`. Growing columns split the width left
   * after the others by weight, whatever their text length, so a long
   * Description doesn't squeeze the name. Weights are relative (0.2:0.1
   * is 2:1). A truncating or wrapping column with grow 0 hugs its minimum.
   */
  grow?: number | undefined;
  /**
   * Cap the cell content at this width with an ellipsis (CSS length or
   * px): with `fit`, short values show in full and long ones (UUIDs) stop
   * at the cap. Pair with `title` for the full value on hover. With
   * `wrap`, the text wraps within the cap instead.
   */
  maxWidth?: number | string | undefined;
  /**
   * Tooltip for the cell (e.g. the full value of a capped or truncated
   * cell). Default for capped columns (`hug`, `maxWidth`): the cell text,
   * when the cell renders a string or number.
   */
  title?: ((row: T) => string | undefined) | undefined;
  /**
   * Identifier column shorthand: `fit` + `grow: 0` + `maxWidth` (true =
   * 32ch; or a CSS length / px). Short values show in full, long ones end
   * in an ellipsis with the full value on hover. Use it for grant IDs,
   * action and token names; leave titles (the primary name) to `grow`.
   */
  hug?: boolean | string | number | undefined;
  /**
   * Leave the column out (header and cells) when every row is empty: the
   * cell renders null, undefined, "" or false, or the predicate says empty.
   * Judged on `rows` only; with no rows the column stays, so headers don't
   * jump for empty or filtered results. Never hides the primary column.
   */
  hideWhenEmpty?: boolean | ((row: T) => boolean) | undefined;
  /**
   * Extra content after the cell content, outside the row link on the
   * primary column (badges beside a name, not part of the link's name).
   */
  extra?: ((row: T) => ReactNode) | undefined;
  /**
   * Narrowest the column gets (CSS length, or px). Truncated columns
   * default to 10ch so they stay legible when several compete for a narrow
   * pane; 0 lets them shrink freely.
   */
  minWidth?: number | string | undefined;
  /** Column width (CSS length or px). */
  width?: number | string | undefined;
  /** Extra classes for this column's cells and header (e.g. "wb-cell-mono"). */
  className?: string | undefined;
}

export interface DataTableProps<T> {
  /** Accessible name of the table ("Grants"). */
  label: string;
  rows: readonly T[];
  rowId: (row: T) => string;
  columns: readonly DataColumn<T>[];
  /** Controlled sort; sorting the rows stays with the app. */
  sort?: SortState | null | undefined;
  onSortChange?: ((sort: SortState | null) => void) | undefined;
  /**
   * Group consecutive rows by this key (sort rows by group first): each
   * group is a <tbody> with a sticky header row.
   */
  groupBy?: ((row: T) => string) | undefined;
  /** Group row content (default: the key and a count). Use TableGroupHeader. */
  groupHeader?:
    | ((group: { key: string; rows: readonly T[] }) => ReactNode)
    | undefined;
  /** The open item (drawer): highlighted, aria-current on its link, cursor snaps to it. */
  activeId?: string | null | undefined;
  /** URL of a row (drawer or page); rendered as the primary cell's link through LinkProvider. */
  rowHref?: ((row: T) => string) | undefined;
  /** Open a row (plain click on the row or its link, Enter on the cursor). */
  onRowOpen?: ((row: T) => void) | undefined;
  /**
   * The j/k cursor moved while a row is open: follow it (typically a
   * history-replace navigation). Default: open the row.
   */
  onRowFollow?: ((row: T) => void) | undefined;
  /** "o" on the cursor row (open elsewhere, e.g. upstream). */
  onRowExternal?: ((row: T) => void) | undefined;
  /**
   * j/k/Enter/o keyboard cursor (default: on when rows open). One per view:
   * turn it off for secondary tables.
   */
  cursor?: boolean | undefined;
  /** Reset the cursor when this changes (filters, sort). */
  cursorResetKey?: unknown;
  /**
   * The cursor row changed (null: none). Live lists use it to hold new rows
   * while the user is on one instead of shifting rows under them.
   */
  onCursorChange?: ((id: string | null) => void) | undefined;
  /** First load: skeleton rows (rows already shown stay during refetches). */
  loading?: boolean | undefined;
  skeletonRows?: number | undefined;
  /** Shown when there are no rows (typically <EmptyState compact …/>). */
  empty?: ReactNode;
  /**
   * Loading failed (typically <ErrorState compact error onRetry />). With no
   * rows it fills the table; with rows (a failed refetch or secondary read)
   * it becomes a slim alert row above them, keeping its Retry, and the rows
   * stay visible but dimmed as stale. Plain text becomes a danger Banner.
   */
  error?: ReactNode;
  rowClassName?: ((row: T) => string | undefined) | undefined;
  /** Dimmed rows (disabled, expired). */
  rowDim?: ((row: T) => boolean) | undefined;
  /** Denser padding and font size, for charts' data tables and dense panels. */
  compact?: boolean | undefined;
  /** Cell padding hangs outside the column (text aligns with the pane). */
  bleed?: boolean | undefined;
  /**
   * Where spare width goes when no column grows. "spread" (default): the
   * columns share it. "end": an empty filler column after the last one
   * takes it, so a table of hugging columns stays packed to the left on
   * wide panes (row lines still run the full width). Growing columns
   * (grow > 0, the primary column by default) still take spare width
   * first; give the name column `hug` or `grow: 0` for a packed table.
   */
  fill?: "spread" | "end" | undefined;
  className?: string | undefined;
}

/** A cell rendered nothing (hideWhenEmpty). */
function isEmptyCell(v: ReactNode): boolean {
  return v === null || v === undefined || v === "" || v === false;
}

/** Internal column: `hug` resolved into fit/grow/maxWidth/title. */
type ResolvedColumn<T> = DataColumn<T> & {
  capStart?: boolean | undefined;
  hugged?: boolean | undefined;
};

const px = (v: number | string) => (typeof v === "number" ? `${v}px` : v);

const HUG_CAP = "32ch";

function resolveColumn<T>(col: DataColumn<T>): ResolvedColumn<T> {
  let c: ResolvedColumn<T> = col;
  if (col.hug !== undefined && col.hug !== false) {
    c = {
      ...col,
      fit: col.fit ?? true,
      grow: col.grow ?? 0,
      maxWidth: col.maxWidth ?? (col.hug === true ? HUG_CAP : col.hug),
      // capped with an ellipsis (at the start for "start"), not clipped
      truncate: undefined,
      capStart: col.truncate === "start",
      hugged: true,
    };
  }
  if (c.title === undefined && c.maxWidth !== undefined && !c.wrap) {
    const cell = c.cell;
    c = {
      ...c,
      title: (row: T) => {
        const v = cell(row);
        return typeof v === "string" || typeof v === "number"
          ? String(v)
          : undefined;
      },
    };
  }
  return c;
}

// Clicks on these inside a row belong to them, not to "open the row".
const INTERACTIVE =
  'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="combobox"], [role="textbox"], [role="slider"], [role="spinbutton"], [contenteditable="true"], [data-wb-no-row-open]';

/** A pointer click that ends a text selection (keyboard clicks never do). */
function selecting(e: { detail: number }): boolean {
  return e.detail > 0 && hasTextSelection();
}

/*
 * Truncated cells: a one-track grid (minmax(0, max-content)) sizes the
 * column by its content yet lets it shrink to nothing, so these columns
 * give way before one-line columns overflow the table.
 */
function clip<T>(col: DataColumn<T>, item: ReactNode): ReactNode {
  return (
    <div
      className={cx(
        "wb-cell-clip",
        col.truncate === "start" && "wb-cell-clip--start",
      )}
      style={
        col.minWidth !== undefined || col.maxWidth !== undefined
          ? { minWidth: col.minWidth, maxWidth: col.maxWidth }
          : undefined
      }
    >
      {item}
    </div>
  );
}

/**
 * A controlled, router-agnostic table for record lists: sticky header,
 * sortable headers, sticky group rows, column priorities, a primary link
 * per row (LinkProvider, aria-current for the open row), whole-row click,
 * and the j/k cursor (focus and an open drawer follow it). Sorting,
 * filtering, URL state and fetching stay in the app.
 */
export function DataTable<T>({
  label,
  rows,
  rowId,
  columns,
  sort,
  onSortChange,
  groupBy,
  groupHeader,
  activeId = null,
  rowHref,
  onRowOpen,
  onRowFollow,
  onRowExternal,
  cursor,
  cursorResetKey,
  onCursorChange,
  loading = false,
  skeletonRows = 6,
  empty,
  error,
  rowClassName,
  rowDim,
  compact = false,
  bleed = false,
  fill = "spread",
  className,
}: DataTableProps<T>) {
  const Link = useLinkComponent();
  const table = useRef<HTMLTableElement | null>(null);
  const opens = rowHref !== undefined || onRowOpen !== undefined;
  const cursorOn = cursor ?? opens;

  const byId = useMemo(() => {
    const map = new Map<string, T>();
    for (const r of rows) map.set(rowId(r), r);
    return map;
  }, [rows, rowId]);
  const ids = useMemo(() => rows.map(rowId), [rows, rowId]);

  /** Open a row: through its link when it has one (router navigation), else onRowOpen. */
  const open = useCallback(
    (id: string) => {
      const row = byId.get(id);
      if (row === undefined) return;
      const link =
        rowHref !== undefined
          ? findRow(id, table.current)?.querySelector<HTMLElement>(
              ".wb-row-link",
            )
          : null;
      if (link) link.click();
      else onRowOpen?.(row);
    },
    [byId, rowHref, onRowOpen],
  );

  const cursorState = useListCursor({
    ids,
    activeId,
    enabled: cursorOn && !loading,
    resetKey: cursorResetKey,
    rootRef: table,
    onOpen: open,
    onFollow: (id) => {
      const row = byId.get(id);
      if (row === undefined) return;
      if (onRowFollow) onRowFollow(row);
      else open(id);
    },
    onExternal: onRowExternal
      ? (id) => {
          const row = byId.get(id);
          if (row !== undefined) onRowExternal(row);
        }
      : undefined,
  });

  const cursorChange = useRef(onCursorChange);
  useLayoutEffect(() => {
    cursorChange.current = onCursorChange;
  });
  const cursorId = cursorOn ? cursorState.cursorId : null;
  useEffect(() => {
    cursorChange.current?.(cursorId);
  }, [cursorId]);

  // Columns: drop all-empty hideWhenEmpty columns (judged on the rows; the
  // primary column always stays), then resolve `hug`.
  const declaredPrimary = Math.max(
    0,
    columns.findIndex((c) => c.primary),
  );
  const cols: ResolvedColumn<T>[] = columns
    .filter((col, i) => {
      const hide = col.hideWhenEmpty;
      if (!hide || i === declaredPrimary || rows.length === 0) return true;
      return !rows.every((r) =>
        typeof hide === "function" ? hide(r) : isEmptyCell(col.cell(r)),
      );
    })
    .map(resolveColumn);
  const primaryIndex = Math.max(
    0,
    cols.findIndex((c) => c.primary),
  );
  const filler = fill === "end";
  // Spare width: the auto table layout hands out width beyond the columns'
  // needs in proportion to their max-content widths. Growing columns get a
  // header sizer whose max-content is 10000px per smallest weight (min-content 0);
  // their cells can't contribute more than 5000px (see table.css), so the
  // sizer decides and they split the spare width by weight, not by text
  // length, after fixed-width and hugging columns are satisfied.
  const grows = cols.map((col, i) => {
    const g =
      col.grow ??
      (col.width !== undefined
        ? 0
        : i === primaryIndex
          ? 2
          : col.truncate || col.wrap
            ? 1
            : 0);
    return Number.isFinite(g) && g > 0 ? g : 0;
  });
  // Non-growing columns hug their content; a non-growing truncating column
  // thereby sits at its minimum width.
  const fits = (col: ResolvedColumn<T>, i: number) =>
    col.fit ?? (grows[i] === 0 && col.width === undefined);
  // Weights are relative: the smallest positive weight gets 10000px, so
  // 0.2:0.1 lays out like 2:1 and every sizer outweighs the 5000px content
  // cap (sizers are clamped to 1,000,000px: ratios up to 100:1).
  const minGrow = Math.min(...grows.filter((g) => g > 0), Infinity);
  // fill="end": with nothing growing, the filler takes the spare width
  const fillerGrows = filler && minGrow === Infinity;
  const sizerPx = (g: number) =>
    Math.min(1_000_000, Math.round((g / minGrow) * 10000));
  const cellClass = (col: ResolvedColumn<T>, i: number) =>
    cx(
      alignClass(col.align),
      i === primaryIndex && "wb-cell-primary",
      !col.wrap && !col.truncate && "wb-cell-nowrap",
      fits(col, i) && "wb-cell-fit",
      col.hugged && "wb-cell-hugcol",
      i !== primaryIndex &&
        col.priority !== undefined &&
        col.priority > 1 &&
        `wb-cell-p${col.priority}`,
      col.className,
    ) || undefined;
  const cellClasses = cols.map(cellClass);

  const groups = useMemo(() => {
    if (!groupBy)
      return [{ key: null as string | null, reactKey: "rows", rows }];
    const out: { key: string | null; reactKey: string; rows: T[] }[] = [];
    // React keys by group identity (plus which run of that key, if a key
    // repeats), so groups keep their DOM when earlier groups come and go.
    const runs = new Map<string, number>();
    for (const r of rows) {
      const key = groupBy(r);
      const last = out[out.length - 1];
      if (last && last.key === key) last.rows.push(r);
      else {
        const run = runs.get(key) ?? 0;
        runs.set(key, run + 1);
        out.push({ key, reactKey: `g:${key}\u0000${run}`, rows: [r] });
      }
    }
    return out;
  }, [rows, groupBy]);

  // Hug columns show full values (up to their caps) while the table fits.
  // When that would overflow its container, the table goes "tight"
  // (data-wb-tight): hug columns become shrinkable clips (down to their
  // minimum, with an ellipsis) and growing sizers step aside, so every
  // shrinkable column gives way in proportion instead of overflowing.
  const hasHug = cols.some((c) => c.hugged);
  const fitTight = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    fitTight.current = fitNow;
  });
  /** The width the table may use: its container's content box. */
  const available = (parent: HTMLElement) => {
    const cs = getComputedStyle(parent);
    return (
      parent.clientWidth -
      (parseFloat(cs.paddingLeft) || 0) -
      (parseFloat(cs.paddingRight) || 0)
    );
  };
  const fitNow = () => {
    const t = table.current;
    const parent = t?.parentElement;
    if (!t || !parent) return;
    t.removeAttribute("data-wb-tight");
    if (!hasHug) return;
    const avail = available(parent);
    const want = avail + (bleed ? 20 : 0);
    if (avail > 0 && t.getBoundingClientRect().width > want + 0.5)
      t.setAttribute("data-wb-tight", "");
  };
  // Re-fit whenever what the table renders may have changed: rows, columns
  // (renderers, headers, widths, classes), density, fill, groups, states.
  // (Pass stable `columns` to skip re-measuring on unrelated re-renders.)
  useLayoutEffect(() => {
    fitTight.current();
  }, [
    rows,
    columns,
    hasHug,
    bleed,
    compact,
    fill,
    groupBy,
    loading,
    error,
    empty,
    className,
  ]);
  // …and when the container's content width changes or fonts load.
  useLayoutEffect(() => {
    const parent = table.current?.parentElement;
    if (!hasHug || !parent) return;
    let width = available(parent);
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            // our own switch changes the table, not this width
            const next = available(parent);
            if (next === width) return;
            width = next;
            fitTight.current();
          });
    ro?.observe(parent);
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    const refit = () => fitTight.current();
    fonts?.addEventListener?.("loadingdone", refit);
    return () => {
      ro?.disconnect();
      fonts?.removeEventListener?.("loadingdone", refit);
    };
  }, [hasHug]);

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, id: string) => {
    if (!isPlainClick(e) || selecting(e)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(INTERACTIVE) || target?.closest(".wb-cell-filler"))
      return;
    open(id);
  };

  const renderRow = (row: T) => {
    const id = rowId(row);
    const active = activeId === id;
    return (
      <tr
        key={id}
        {...{ [ROW_ID_ATTR]: id }}
        className={
          cx(
            opens && "is-clickable",
            cursorOn && cursorState.cursorId === id && "is-cursor",
            active && "is-active",
            rowDim?.(row) && "is-dim",
            rowClassName?.(row),
          ) || undefined
        }
        onClick={opens ? (e) => onRowClick(e, id) : undefined}
      >
        {cols.map((col, i) => {
          const raw = col.cell(row);
          const content =
            col.truncate === "start" || col.capStart ? <bdi>{raw}</bdi> : raw;
          const primary = i === primaryIndex;
          let item: ReactNode = content;
          let control = false;
          if (primary && rowHref !== undefined) {
            control = true;
            item = (
              <Link
                href={rowHref(row)}
                className="wb-row-link"
                aria-current={active ? "true" : undefined}
                onClick={(e) => {
                  // A click that ends a text selection selects, not opens.
                  if (isPlainClick(e) && selecting(e)) {
                    e.preventDefault();
                    return;
                  }
                  if (onRowOpen && isPlainClick(e)) onRowOpen(row);
                }}
              >
                {content}
              </Link>
            );
          } else if (primary && onRowOpen !== undefined) {
            control = true;
            item = (
              <button
                type="button"
                className="wb-row-link"
                aria-current={active ? "true" : undefined}
                onClick={(e) => {
                  if (isPlainClick(e) && !selecting(e)) onRowOpen(row);
                }}
              >
                {content}
              </button>
            );
          }
          if (col.hugged) {
            // Full value up to the cap; in a tight table (see data-wb-tight)
            // it shrinks with an ellipsis down to its minimum.
            const cap = px(col.maxWidth ?? HUG_CAP);
            const min =
              col.minWidth !== undefined
                ? px(col.minWidth)
                : `min(10ch, ${cap})`;
            item = (
              <div
                className={cx(
                  "wb-cell-hug",
                  col.capStart && "wb-cell-hug--start",
                )}
                style={
                  {
                    maxWidth: cap,
                    // an explicit minimum holds in both modes
                    minWidth:
                      col.minWidth !== undefined ? px(col.minWidth) : undefined,
                    "--wb-hug-min": min,
                  } as CSSProperties
                }
              >
                {control ? item : <span>{item}</span>}
              </div>
            );
          } else if (col.truncate) {
            item = clip(col, control ? item : <span>{item}</span>);
          } else if (col.wrap) {
            // capped like clips, so long text can't outweigh the sizers;
            // maxWidth caps it further (the text wraps within it)
            item = (
              <div
                className="wb-cell-flow"
                style={
                  col.maxWidth !== undefined
                    ? { maxWidth: col.maxWidth }
                    : undefined
                }
              >
                {item}
              </div>
            );
          } else if (col.maxWidth !== undefined) {
            item = (
              <span className="wb-cell-cap" style={{ maxWidth: col.maxWidth }}>
                {item}
              </span>
            );
          }
          const extra = col.extra?.(row);
          if (extra !== undefined && extra !== null && extra !== false) {
            item = (
              <div className="wb-cell-line">
                {item}
                <span className="wb-cell-extra">{extra}</span>
              </div>
            );
          }
          const title = col.title?.(row);
          return primary ? (
            <th
              key={col.key}
              scope="row"
              className={cellClasses[i]}
              title={title}
            >
              {item}
            </th>
          ) : (
            <td key={col.key} className={cellClasses[i]} title={title}>
              {item}
            </td>
          );
        })}
        {filler ? <td className="wb-cell-filler" aria-hidden="true" /> : null}
      </tr>
    );
  };

  // every full-width row spans the filler too
  const n = cols.length + (filler ? 1 : 0);
  const showSkeleton = loading && rows.length === 0;
  const hasError =
    error !== undefined && error !== null && error !== false && error !== "";
  const errorContent =
    typeof error === "string" || typeof error === "number" ? (
      <Banner tone="danger" slim live>
        {String(error)}
      </Banner>
    ) : (
      error
    );
  // Rows shown under an error are stale (the refetch that failed).
  const stale = hasError && rows.length > 0 && !showSkeleton;
  let body: ReactNode;
  if (showSkeleton) {
    body = (
      <tbody>
        <TableSkeletonRows
          columns={cols.length}
          rows={skeletonRows}
          cellClassNames={cellClasses}
          filler={filler}
        />
      </tbody>
    );
  } else if (rows.length === 0) {
    body = (
      <tbody>
        {hasError ? (
          <TableEmpty colSpan={n}>{errorContent}</TableEmpty>
        ) : empty ? (
          <TableEmpty colSpan={n}>{empty}</TableEmpty>
        ) : null}
      </tbody>
    );
  } else {
    const alert = hasError ? (
      <tbody key="wb-alert" className="wb-table-alert-body">
        <tr className="wb-table-alert">
          <td colSpan={n}>{errorContent}</td>
        </tr>
      </tbody>
    ) : null;
    body = [
      alert,
      ...groups.map((g) => (
        <tbody key={g.reactKey}>
          {g.key !== null ? (
            <tr className="wb-table-group">
              <th scope="rowgroup" colSpan={n}>
                {groupHeader ? (
                  groupHeader({ key: g.key, rows: g.rows })
                ) : (
                  <TableGroupHeader title={g.key} count={g.rows.length} />
                )}
              </th>
            </tr>
          ) : null}
          {g.rows.map(renderRow)}
        </tbody>
      )),
    ];
  }

  return (
    <>
      <table
        ref={table}
        aria-label={label}
        aria-busy={loading || undefined}
        className={cx(
          "wb-table",
          compact && "wb-table--compact",
          bleed && "wb-table--bleed",
          groupBy && "wb-table--grouped",
          filler && "wb-table--fill-end",
          stale && "is-stale",
          className,
        )}
      >
        <thead>
          <tr>
            {cols.map((col, i) => {
              // Truncated columns carry their minimum on the clipped content
              // (in the cell font, so `ch` means body characters).
              const min = col.truncate || col.hugged ? undefined : col.minWidth;
              const style: CSSProperties | undefined =
                col.width !== undefined || min !== undefined
                  ? { width: col.width, minWidth: min }
                  : undefined;
              const g = grows[i] ?? 0;
              const sizer =
                g > 0 ? (
                  <span
                    className="wb-th-grow"
                    aria-hidden="true"
                    style={{
                      gridTemplateColumns: `minmax(0, ${sizerPx(g)}px)`,
                    }}
                  />
                ) : null;
              return col.sortable && onSortChange ? (
                <SortHeader
                  key={col.key}
                  label={col.header}
                  sortKey={col.key}
                  sort={sort}
                  onSortChange={onSortChange}
                  firstDir={col.firstSortDir}
                  className={cellClasses[i]}
                  style={style}
                >
                  {sizer}
                </SortHeader>
              ) : (
                <th
                  key={col.key}
                  scope="col"
                  className={cellClasses[i]}
                  style={style}
                >
                  {col.header}
                  {sizer}
                </th>
              );
            })}
            {filler ? (
              <th className="wb-cell-filler" aria-hidden="true">
                {fillerGrows ? (
                  <span
                    className="wb-th-grow"
                    style={{ gridTemplateColumns: "minmax(0, 10000px)" }}
                  />
                ) : null}
              </th>
            ) : null}
          </tr>
        </thead>
        {body}
      </table>
      {/* Kept mounted so the loading message is announced when it appears. */}
      <div className="wb-sr-only" role="status">
        {showSkeleton ? `Loading ${label}…` : null}
      </div>
    </>
  );
}
