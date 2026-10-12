import {
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { filterPaletteItems, paletteHighlight } from "../lib/paletteSearch";
import {
  OverlayScope,
  useFocusTrap,
  useLayer,
  useOverlayOwner,
} from "../lib/layers";
import { Kbd } from "./Chips";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { Spinner } from "./Spinner";

export interface PaletteItem {
  id: string;
  label: string;
  /** Custom non-interactive label content; label remains the searchable, accessible text. */
  renderLabel?: ((query: string) => ReactNode) | undefined;
  /** Run without closing, for example to enter another application-owned step. */
  keepOpen?: boolean | undefined;
  /** Icon name, or an element (e.g. a coloured status icon). */
  icon?: IconName | ReactElement | undefined;
  /** Right-aligned context ("Service · updated 2h ago"). */
  hint?: ReactNode;
  /** Extra text the built-in filter matches. */
  keywords?: readonly string[] | undefined;
  onSelect: () => void;
}

export interface PaletteSource {
  id: string;
  /** Section heading ("Go to", "Principals", "Actions"). */
  title: string;
  /**
   * Static items, filtered by the palette (label + keywords); or a function
   * that returns already-filtered items for the query.
   */
  items?:
    | readonly PaletteItem[]
    | ((query: string) => readonly PaletteItem[])
    | undefined;
  /** Async search (debounced, aborted when the query changes). */
  search?:
    | ((query: string, signal: AbortSignal) => Promise<readonly PaletteItem[]>)
    | undefined;
  /** Minimum query length for `search` (default 1). */
  minQuery?: number | undefined;
  /** Max items shown (default 6 with a query, 5 without). */
  limit?: number | undefined;
  /** Show this source when the query is empty (default true). */
  showWhenEmpty?: boolean | undefined;
  /** Query-hook status; cached items remain available during loading or errors. */
  loading?: boolean | undefined;
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
}

export interface PaletteStep {
  /** Distinct scope for each step, including a selected entity when relevant. */
  id: string;
  title: ReactNode;
  onBack: () => void;
  backLabel?: string | undefined;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  sources: readonly PaletteSource[];
  placeholder?: string | undefined;
  /** Debounce for async sources (default 160ms). */
  debounceMs?: number | undefined;
  emptyText?: string | undefined;
  /** Controlled query; otherwise the palette manages its own query. */
  query?: string | undefined;
  onQueryChange?: ((query: string) => void) | undefined;
  /** Application-owned drill-down navigation; Backspace on an empty query goes back. */
  step?: PaletteStep | undefined;
}

function Highlight({
  text,
  query,
}: {
  text: string;
  query: string;
}): ReactNode {
  return paletteHighlight(text, query).map((part, index) =>
    part.match ? <mark key={index}>{part.text}</mark> : part.text,
  );
}

interface Remote {
  query: string;
  scope: string;
  items: readonly PaletteItem[];
  loading: boolean;
  error?: string;
}

type PaletteOption = PaletteItem & { control?: "expand" | "retry" };
type Section = {
  source: PaletteSource;
  items: PaletteOption[];
  loading: boolean;
  error?: string | undefined;
};

/** Ctrl/Cmd-K palette: sections of items from sync or async sources. */
export function CommandPalette(props: CommandPaletteProps) {
  if (!props.open) return null;
  return <PaletteSurface {...props} />;
}

function PaletteSurface({
  onClose,
  sources,
  placeholder = "Search or jump to…",
  debounceMs = 160,
  emptyText = "No results",
  query: controlledQuery,
  onQueryChange,
  step,
}: CommandPaletteProps) {
  const [localQuery, setLocalQuery] = useState("");
  const query = controlledQuery ?? localQuery;
  const setQuery = (next: string) => {
    if (controlledQuery === undefined) setLocalQuery(next);
    onQueryChange?.(next);
  };
  const scope = step?.id ?? "";
  const [index, setIndex] = useState(0);
  const [remote, setRemote] = useState<Record<string, Remote>>({});
  const retrySources = useRef(new Map<string, () => void>());
  const [expanded, setExpanded] = useState<{
    query: string;
    scope: string;
    sources: string[];
  }>({ query: "", scope, sources: [] });
  const input = useRef<HTMLInputElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const results = useRef<HTMLDivElement | null>(null);
  const baseId = `wb-pal-${useId()}`;
  const root = useRef<HTMLDivElement | null>(null);
  const layers = useLayer(true, onClose, true, root);
  const owner = useOverlayOwner(root);
  useFocusTrap(box, true, { owner, layers });

  const q = query.trim();
  // Source ids identify searches. Step scope and query isolate data; retries
  // restart only their own source, retaining cached results for that query.
  const searchKey = JSON.stringify(
    sources
      .filter((s) => s.search)
      .map((s) => [s.id, s.minQuery ?? 1, s.showWhenEmpty ?? true]),
  );
  const sourcesRef = useRef(sources);
  useEffect(() => {
    sourcesRef.current = sources;
  });
  useEffect(() => {
    const active = sourcesRef.current.filter(
      (s) =>
        s.search &&
        q.length >= (s.minQuery ?? 1) &&
        (q || s.showWhenEmpty !== false),
    );
    const controllers = new Map<string, AbortController>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const retries = new Map<string, () => void>();
    setRemote({});
    const start = (id: string) => {
      const source = sourcesRef.current.find((s) => s.id === id);
      if (!source?.search) return;
      controllers.get(id)?.abort();
      clearTimeout(timers.get(id));
      const ctrl = new AbortController();
      controllers.set(id, ctrl);
      setRemote((prev) => ({
        ...prev,
        [id]: {
          query: q,
          scope,
          items:
            prev[id]?.query === q && prev[id]?.scope === scope
              ? prev[id]!.items
              : [],
          loading: true,
        },
      }));
      const search = source.search;
      timers.set(
        id,
        setTimeout(() => {
          // Promise wrapping also reports synchronous failures from source adapters.
          Promise.resolve()
            .then(() => search(q, ctrl.signal))
            .then(
              (items) => {
                if (ctrl.signal.aborted) return;
                setRemote((prev) => ({
                  ...prev,
                  [id]: { query: q, scope, items, loading: false },
                }));
              },
              () => {
                if (ctrl.signal.aborted) return;
                setRemote((prev) => ({
                  ...prev,
                  [id]: {
                    query: q,
                    scope,
                    items:
                      prev[id]?.query === q && prev[id]?.scope === scope
                        ? prev[id]!.items
                        : [],
                    loading: false,
                    error: `Could not search ${source.title}. Try again.`,
                  },
                }));
              },
            );
        }, debounceMs),
      );
    };
    for (const source of active) {
      retries.set(source.id, () => start(source.id));
      start(source.id);
    }
    retrySources.current = retries;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      for (const controller of controllers.values()) controller.abort();
      retrySources.current = new Map();
    };
  }, [q, scope, searchKey, debounceMs]);

  const sections = useMemo(() => {
    const out: Section[] = [];
    for (const s of sources) {
      if (!q && s.showWhenEmpty === false) continue;
      const limit = Math.max(1, s.limit ?? (q ? 6 : 5));
      let items: readonly PaletteItem[] = [];
      if (typeof s.items === "function") items = s.items(q);
      else if (s.items) items = filterPaletteItems(s.items, q);
      const searchActive = Boolean(s.search && q.length >= (s.minQuery ?? 1));
      const result =
        remote[s.id]?.query === q && remote[s.id]?.scope === scope
          ? remote[s.id]
          : undefined;
      if (searchActive) items = [...items, ...(result?.items ?? [])];
      const loading = Boolean(
        s.loading || (searchActive && (!result || result.loading)),
      );
      const remoteError = searchActive ? result?.error : undefined;
      const error =
        [s.error, remoteError].filter(Boolean).join(" ") || undefined;
      const showAll =
        expanded.query === q &&
        expanded.scope === scope &&
        expanded.sources.includes(s.id);
      const visible: PaletteOption[] = [
        ...(showAll ? items : items.slice(0, limit)),
      ];
      if (!showAll && items.length > limit) {
        visible.push({
          id: `palette-expand-${s.id}`,
          label: `Show all ${items.length} ${s.title}`,
          keepOpen: true,
          control: "expand",
          onSelect: () =>
            setExpanded((previous) => ({
              query: q,
              scope,
              sources: [
                ...(previous.query === q && previous.scope === scope
                  ? previous.sources
                  : []),
                s.id,
              ],
            })),
        });
      }
      if (!loading && ((s.error && s.onRetry) || remoteError)) {
        visible.push({
          id: `palette-retry-${s.id}`,
          label: `Retry ${s.title}`,
          icon: "refresh",
          keepOpen: true,
          control: "retry",
          onSelect: () => {
            // An external query and remote search can fail independently.
            // Retry only the failed operations, including both when needed.
            if (remoteError) retrySources.current.get(s.id)?.();
            if (s.error) s.onRetry?.();
          },
        });
      }
      if (visible.length || loading || error)
        out.push({ source: s, items: visible, loading, error });
    }
    return out;
  }, [sources, q, scope, remote, expanded]);

  const flat = sections.flatMap((s) => s.items);
  const cur = Math.min(index, Math.max(0, flat.length - 1));
  const loading = sections.some((section) => section.loading);
  const feedback = sections
    .flatMap((section) => [
      ...(section.loading ? [`Loading ${section.source.title}…`] : []),
      ...(section.error ? [section.error] : []),
    ])
    .join(" ");
  const resultCount = flat.filter((item) => !item.control).length;
  const announcement =
    feedback || (resultCount ? `${resultCount} results.` : emptyText);

  useEffect(() => {
    setIndex(0);
    setExpanded({ query: q, scope, sources: [] });
  }, [q, scope]);
  useEffect(() => {
    input.current?.focus();
  }, [scope]);
  useEffect(() => {
    results.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const goBack = () => {
    step?.onBack();
    input.current?.focus();
  };

  const run = (item: PaletteOption | undefined) => {
    if (!item) return;
    if (item.keepOpen) {
      item.onSelect();
      input.current?.focus();
      return;
    }
    onClose();
    // After the palette has closed and restored focus, so a dialog opened by
    // the item returns focus to where the user was.
    setTimeout(() => item.onSelect(), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys during IME composition belong to the IME.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Navigation belongs to the combobox; the step back button keeps native keys.
    if (e.target !== input.current) return;
    if (e.key === "Backspace" && !query && step) {
      e.preventDefault();
      goBack();
      return;
    }
    const n = Math.max(1, flat.length);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((cur + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((cur - 1 + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(flat[cur]);
    }
  };

  let k = 0;
  return createPortal(
    <OverlayScope layers={layers} owner={owner}>
      <div ref={root}>
        <div className="wb-scrim" aria-hidden="true" onClick={onClose} />
        <div
          ref={box}
          className="wb-palette"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onKeyDown={onKeyDown}
        >
          {step ? (
            <div className="wb-palette-step">
              <button
                type="button"
                className="wb-palette-back"
                onClick={goBack}
                aria-label={step.backLabel ?? "Back"}
              >
                <Icon name="arrow-left" />
              </button>
              <span>{step.title}</span>
            </div>
          ) : null}
          <div className="wb-palette-head">
            <Icon name="search" />
            <input
              ref={input}
              className="wb-palette-input"
              value={query}
              placeholder={placeholder}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-label={placeholder}
              aria-expanded="true"
              aria-controls={`${baseId}-list`}
              aria-autocomplete="list"
              aria-activedescendant={flat[cur] ? `${baseId}-${cur}` : undefined}
            />
            {loading ? <Spinner /> : null}
            <Kbd>esc</Kbd>
          </div>
          <div
            className="wb-sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {announcement}
          </div>
          <div
            className="wb-palette-results"
            id={`${baseId}-list`}
            role="listbox"
            ref={results}
            aria-label="Results"
          >
            {sections.map((sec) => (
              <div
                key={sec.source.id}
                role="group"
                aria-labelledby={`${baseId}-sec-${sec.source.id}`}
              >
                <div
                  className="wb-palette-section"
                  id={`${baseId}-sec-${sec.source.id}`}
                  role="presentation"
                >
                  {sec.source.title}
                </div>
                {sec.loading ? (
                  <div className="wb-palette-status" role="presentation">
                    Loading {sec.source.title}…
                  </div>
                ) : null}
                {sec.error ? (
                  <div
                    className="wb-palette-status wb-palette-status-error"
                    id={`${baseId}-error-${sec.source.id}`}
                    role="presentation"
                  >
                    {sec.error}
                  </div>
                ) : null}
                {sec.items.map((item) => {
                  const i = k++;
                  return (
                    <div
                      key={`${item.control ?? "result"}-${item.id}`}
                      id={`${baseId}-${i}`}
                      role="option"
                      aria-selected={i === cur}
                      aria-label={item.renderLabel ? item.label : undefined}
                      aria-describedby={
                        item.control === "retry"
                          ? `${baseId}-error-${sec.source.id}`
                          : undefined
                      }
                      className="wb-palette-item"
                      onMouseMove={() => {
                        if (i !== cur) setIndex(i);
                      }}
                      onMouseDown={(event) => {
                        // Internal actions keep the palette open: retain typing and arrow-key focus.
                        if (item.keepOpen && event.button === 0)
                          event.preventDefault();
                      }}
                      onClick={() => run(item)}
                    >
                      {typeof item.icon === "string" ? (
                        <Icon name={item.icon} />
                      ) : isValidElement(item.icon) ? (
                        <span className="wb-palette-item-icon">
                          {item.icon}
                        </span>
                      ) : (
                        <Icon name="arrow-right" />
                      )}
                      <span className="wb-palette-label">
                        {item.renderLabel ? (
                          item.renderLabel(q)
                        ) : (
                          <Highlight text={item.label} query={q} />
                        )}
                      </span>
                      {item.hint ? (
                        <span className="wb-palette-hint">{item.hint}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {!sections.length ? (
              <div className="wb-palette-empty" role="presentation">
                {emptyText}
              </div>
            ) : null}
          </div>
          <div className="wb-palette-foot" aria-hidden="true">
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate
            </span>
            <span>
              <Kbd>↵</Kbd> open
            </span>
            <span>
              <Kbd>esc</Kbd> close
            </span>
          </div>
        </div>
      </div>
    </OverlayScope>,
    document.body,
  );
}
