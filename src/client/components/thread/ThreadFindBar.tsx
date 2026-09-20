import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { FindBarControl } from "../FindBarControl.js";
import { isSearchQueryReady } from "../../search-query.js";
import { navigationScrollBehavior } from "./navigation-scroll.js";

const matchHighlightName = "sedes-thread-find-match";
const currentHighlightName = "sedes-thread-find-current";
const excludedTextSelector =
  '[aria-hidden="true"], [hidden], [data-thread-find-exclude="true"], script, style';
const textFlowBoundaryTags = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "DD",
  "DETAILS",
  "DIALOG",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HGROUP",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);
const textFlowSeparator = "\u0000";

type HighlightLike = {
  readonly size: number;
};

type HighlightConstructorLike = new (...ranges: AbstractRange[]) => HighlightLike;

type HighlightRegistryLike = {
  delete(name: string): boolean;
  get(name: string): HighlightLike | undefined;
  set(name: string, highlight: HighlightLike): void;
};

export interface ThreadFindOptions {
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
}

export interface ThreadFindBarProps {
  readonly open: boolean;
  readonly visible: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly scopeRef: RefObject<HTMLElement | null>;
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly id: string;
}

interface TextNodeSpan {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

const wordCharacter = /[\p{L}\p{N}_]/u;

function highlightRegistry(): HighlightRegistryLike | undefined {
  return (CSS as unknown as { readonly highlights?: HighlightRegistryLike })
    .highlights;
}

function highlightConstructor(): HighlightConstructorLike | undefined {
  return (
    globalThis as typeof globalThis & {
      readonly Highlight?: HighlightConstructorLike;
    }
  ).Highlight;
}

function clearOwnedHighlight(
  name: string,
  owned: HighlightLike | undefined,
): void {
  if (!owned) return;
  const registry = highlightRegistry();
  if (registry?.get(name) === owned) registry.delete(name);
}

function isSearchableTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || node.data.length === 0) return false;
  return !parent.closest(excludedTextSelector);
}

function searchableSurfaces(root: HTMLElement): readonly HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ".conversation-item, .activity-group-summary",
    ),
  ).filter(
    (surface) =>
      !surface.parentElement?.closest(
        ".conversation-item, .activity-group-summary",
      ),
  );
}

function spansFor(surface: HTMLElement): {
  readonly text: string;
  readonly spans: readonly TextNodeSpan[];
} {
  const spans: TextNodeSpan[] = [];
  let text = "";

  const separateFlow = () => {
    if (text.length > 0 && !text.endsWith(textFlowSeparator)) {
      text += textFlowSeparator;
    }
  };
  const visit = (node: Node): void => {
    if (node instanceof Text) {
      if (!isSearchableTextNode(node)) return;
      const start = text.length;
      text += node.data;
      spans.push({ node, start, end: text.length });
      return;
    }
    if (!(node instanceof Element) || node.matches(excludedTextSelector)) {
      return;
    }
    const separatesFlow = textFlowBoundaryTags.has(node.tagName);
    if (separatesFlow) separateFlow();
    for (const child of node.childNodes) visit(child);
    if (separatesFlow) separateFlow();
  };

  for (const child of surface.childNodes) visit(child);
  return { text, spans };
}

function boundaryAllows(
  text: string,
  start: number,
  end: number,
  wholeWord: boolean,
): boolean {
  if (!wholeWord) return true;
  const preceding = text[start - 1];
  const following = text[end];
  return (
    (preceding === undefined || !wordCharacter.test(preceding)) &&
    (following === undefined || !wordCharacter.test(following))
  );
}

function rangeForMatch(
  spans: readonly TextNodeSpan[],
  start: number,
  end: number,
): Range | undefined {
  const first = spans.find((span) => span.end > start);
  const last = [...spans].reverse().find((span) => span.start < end);
  if (!first || !last) return undefined;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

export function findThreadTextMatches(
  root: HTMLElement,
  query: string,
  options: ThreadFindOptions,
): readonly Range[] {
  if (!isSearchQueryReady(query)) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(escaped, options.matchCase ? "gu" : "giu");
  const ranges: Range[] = [];

  for (const surface of searchableSurfaces(root)) {
    const { text, spans } = spansFor(surface);
    expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (boundaryAllows(text, start, end, options.wholeWord)) {
        const range = rangeForMatch(spans, start, end);
        if (range) ranges.push(range);
      }
    }
  }

  return ranges;
}

function matchPosition(range: Range, viewport: HTMLElement): number {
  const viewportRect = viewport.getBoundingClientRect();
  const matchRect = range.getBoundingClientRect();
  const contentTop = viewport.scrollTop + matchRect.top - viewportRect.top;
  return Math.min(
    99,
    Math.max(1, (contentTop / Math.max(1, viewport.scrollHeight)) * 100),
  );
}

function scrollRangeIntoView(range: Range, viewport: HTMLElement): void {
  const viewportRect = viewport.getBoundingClientRect();
  const matchRect = range.getBoundingClientRect();
  const target =
    viewport.scrollTop +
    matchRect.top -
    viewportRect.top -
    viewport.clientHeight / 2 +
    matchRect.height / 2;
  viewport.scrollTo({
    top: Math.max(0, target),
    behavior: navigationScrollBehavior(viewport, target),
  });
}

export function ThreadFindBar({
  open,
  visible,
  onOpenChange,
  triggerRef,
  scopeRef,
  contentRef,
  viewportRef,
  id,
}: ThreadFindBarProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const allHighlight = useRef<HighlightLike | undefined>(undefined);
  const currentHighlight = useRef<HighlightLike | undefined>(undefined);
  const matchesRef = useRef<readonly Range[]>([]);
  const currentIndexRef = useRef(-1);
  const scrollAfterScan = useRef(false);
  const wasOpen = useRef(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matches, setMatches] = useState<readonly Range[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [contentRevision, setContentRevision] = useState(0);
  const [markerPositions, setMarkerPositions] = useState<readonly number[]>([]);

  const clearHighlights = useCallback(() => {
    clearOwnedHighlight(matchHighlightName, allHighlight.current);
    clearOwnedHighlight(currentHighlightName, currentHighlight.current);
    allHighlight.current = undefined;
    currentHighlight.current = undefined;
  }, []);

  const close = useCallback(() => {
    onOpenChange(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onOpenChange, triggerRef]);

  useEffect(() => {
    if (!visible) return undefined;
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLocaleLowerCase() === "f"
      ) {
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLElement &&
          activeElement !== document.body &&
          !scopeRef.current?.contains(activeElement)
        ) {
          return;
        }
        event.preventDefault();
        onOpenChange(true);
        window.requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      } else if (event.key === "Escape" && open) {
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLElement &&
          activeElement !== document.body &&
          !scopeRef.current?.contains(activeElement)
        ) {
          return;
        }
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [close, onOpenChange, open, scopeRef, visible]);

  useLayoutEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;
    scrollAfterScan.current = true;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  useEffect(() => {
    if (!open || !contentRef.current) return undefined;
    let frame: number | undefined;
    const observer = new MutationObserver(() => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        setContentRevision((current) => current + 1);
      });
    });
    observer.observe(contentRef.current, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [contentRef, open]);

  useLayoutEffect(() => {
    if (!open || !contentRef.current || !isSearchQueryReady(query)) {
      matchesRef.current = [];
      setMatches([]);
      currentIndexRef.current = -1;
      setCurrentIndex(-1);
      setMarkerPositions([]);
      scrollAfterScan.current = false;
      clearHighlights();
      return;
    }
    const nextMatches = findThreadTextMatches(contentRef.current, query, {
      matchCase,
      wholeWord,
    });
    matchesRef.current = nextMatches;
    setMatches(nextMatches);
    const nextIndex =
      nextMatches.length === 0
        ? -1
        : Math.min(
            Math.max(currentIndexRef.current, 0),
            nextMatches.length - 1,
          );
    currentIndexRef.current = nextIndex;
    setCurrentIndex(nextIndex);
    if (scrollAfterScan.current) {
      scrollAfterScan.current = false;
      const currentRange = nextMatches[nextIndex];
      const viewport = viewportRef.current;
      if (currentRange && viewport) scrollRangeIntoView(currentRange, viewport);
    }
  }, [
    clearHighlights,
    contentRef,
    contentRevision,
    matchCase,
    open,
    query,
    viewportRef,
    wholeWord,
  ]);

  useLayoutEffect(() => {
    clearHighlights();
    if (!open || matches.length === 0) return;
    const RegistryHighlight = highlightConstructor();
    const registry = highlightRegistry();
    if (!RegistryHighlight || !registry) return;
    const nextAllHighlight = new RegistryHighlight(...matches);
    const currentRange = matches[currentIndex];
    const nextCurrentHighlight = currentRange
      ? new RegistryHighlight(currentRange)
      : undefined;
    registry.set(matchHighlightName, nextAllHighlight);
    if (nextCurrentHighlight) {
      registry.set(currentHighlightName, nextCurrentHighlight);
    }
    allHighlight.current = nextAllHighlight;
    currentHighlight.current = nextCurrentHighlight;
    return clearHighlights;
  }, [clearHighlights, currentIndex, matches, open]);

  useLayoutEffect(() => {
    if (!open || !viewportRef.current) {
      setMarkerPositions([]);
      return;
    }
    const measure = () => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      setMarkerPositions(
        matchesRef.current.map((range) => matchPosition(range, viewport)),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [contentRef, matches, open, viewportRef]);

  useEffect(() => clearHighlights, [clearHighlights]);

  const selectMatch = (index: number) => {
    const range = matches[index];
    const viewport = viewportRef.current;
    if (!range) return;
    currentIndexRef.current = index;
    setCurrentIndex(index);
    if (viewport) scrollRangeIntoView(range, viewport);
  };

  const move = (direction: -1 | 1) => {
    if (matches.length === 0) return;
    selectMatch(
      (Math.max(0, currentIndexRef.current) + direction + matches.length) %
        matches.length,
    );
  };

  const countLabel =
    !isSearchQueryReady(query)
      ? ""
      : matches.length === 0
        ? "0 of 0"
        : `${currentIndex + 1} of ${matches.length}`;
  const markerHost = viewportRef.current?.parentElement;

  return (
    <>
      <div
        className="thread-find-bar"
        data-open={open ? "true" : "false"}
        id={id}
        role="search"
        aria-label="Find in thread"
        aria-hidden={!open}
      >
        <FindBarControl
          id={id}
          inputRef={inputRef}
          inputLabel="Find in thread"
          placeholder="Find in thread"
          interactive={open}
          query={query}
          countLabel={countLabel}
          canMove={matches.length > 0}
          matchCase={matchCase}
          wholeWord={wholeWord}
          onQueryChange={(nextQuery) => {
            scrollAfterScan.current = true;
            setQuery(nextQuery);
            currentIndexRef.current = -1;
            setCurrentIndex(-1);
          }}
          onMatchCaseChange={(nextMatchCase) => {
            scrollAfterScan.current = true;
            setMatchCase(nextMatchCase);
            currentIndexRef.current = -1;
            setCurrentIndex(-1);
          }}
          onWholeWordChange={(nextWholeWord) => {
            scrollAfterScan.current = true;
            setWholeWord(nextWholeWord);
            currentIndexRef.current = -1;
            setCurrentIndex(-1);
          }}
          onMove={move}
          onClose={close}
        />
      </div>
      {open && markerHost && markerPositions.length > 0
        ? createPortal(
            <div
              className="thread-find-marker-rail"
              aria-label="Search result positions"
            >
              {markerPositions.map((position, index) => (
                <button
                  // Matches are ordered and recreated together after each scan.
                  key={`${position}:${index}`}
                  type="button"
                  className="thread-find-marker"
                  data-current={index === currentIndex ? "true" : undefined}
                  style={{ top: `${position}%` }}
                  aria-label={`Go to match ${index + 1} of ${matches.length}`}
                  onClick={() => selectMatch(index)}
                />
              ))}
            </div>,
            markerHost,
          )
        : null}
    </>
  );
}
