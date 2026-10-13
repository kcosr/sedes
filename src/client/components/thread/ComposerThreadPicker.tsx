import { useEffect, useMemo, useRef, type RefObject } from "react";
import { MessagesSquare } from "lucide-react";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@client/components/ui/popover";
import { SearchableSelectSearch } from "@client/components/ui/searchable-select";
import { menuEmptyClass, menuRowClass } from "@client/components/ui/floating";
import { moveListFocus } from "@client/lib/list-focus";
import { usePickerFocus } from "../../lib/use-picker-focus.js";
import { BackendBrandIcon } from "../brand-icons.js";

export function ComposerThreadPicker({ open, onOpenChange, query, onQueryChange, threads, disabled, onSelect, inline, anchor, listId, selectedIndex, onSelectedIndexChange }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly threads: readonly NormalizedApplicationThreadSummary[];
  readonly disabled: boolean;
  readonly onSelect: (thread: NormalizedApplicationThreadSummary) => void;
  readonly inline: boolean;
  readonly anchor: RefObject<HTMLTextAreaElement | null>;
  readonly listId: string;
  readonly selectedIndex: number;
  readonly onSelectedIndexChange: (index: number) => void;
}): React.JSX.Element {
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const restoreComposerFocus = useRef(false);
  const focus = usePickerFocus(search);
  const virtualAnchor = useMemo(() => ({ current: {
    getBoundingClientRect: () => anchor.current?.getBoundingClientRect() ?? new DOMRect(),
    get contextElement() { return anchor.current ?? undefined; },
  } }), [anchor]);
  const rows = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  useEffect(() => {
    if (open) rows()[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, selectedIndex]);
  const chooseThread = (thread: NormalizedApplicationThreadSummary) => {
    restoreComposerFocus.current = true;
    onSelect(thread);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={virtualAnchor} />
      <PopoverTrigger asChild>
        <button type="button" className="skill-button" data-composer-reference-trigger="" aria-label="Reference a thread" title="Reference a thread (@)"
          disabled={disabled} onPointerDown={focus.onPointerDown} onKeyDown={focus.onKeyDown}>
          <MessagesSquare size={15} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} role="dialog" aria-label="Reference a thread"
        className="skill-popover max-h-[min(var(--radix-popover-content-available-height),440px,70dvh)] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => { restoreComposerFocus.current = false; if (inline) event.preventDefault(); else focus.onOpenAutoFocus(event); }}
        onEscapeKeyDown={() => { restoreComposerFocus.current = true; }}
        onInteractOutside={(event) => {
          if (inline && (event.target === anchor.current || event.detail.originalEvent.target === anchor.current)) event.preventDefault();
          else restoreComposerFocus.current = false;
        }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (restoreComposerFocus.current) anchor.current?.focus({ preventScroll: true }); }}>
        <SearchableSelectSearch ref={search} type="search" value={query} aria-label="Search threads" placeholder="Search active threads"
          aria-controls={listId}
          onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && moveListFocus(rows(), event.key)) event.preventDefault();
            if (event.key === "Enter" && threads[selectedIndex]) { event.preventDefault(); chooseThread(threads[selectedIndex]); }
          }} />
        <div ref={list} id={listId} role="listbox" aria-label="Matching threads" className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-(--menu-panel-padding)"
          onKeyDown={(event) => { if (moveListFocus(rows(), event.key)) event.preventDefault(); }}>
          {threads.map((thread, index) => (
            <button key={thread.id} id={`${listId}-${index}`} role="option" aria-selected={index === selectedIndex} type="button"
              className={`${menuRowClass} ${index === selectedIndex ? "bg-accent" : ""}`}
              onFocus={() => onSelectedIndexChange(index)}
              onMouseDown={(event) => { if (inline) event.preventDefault(); }}
              onPointerMove={() => onSelectedIndexChange(index)} onClick={() => chooseThread(thread)}>
              <BackendBrandIcon brand={thread.backend.brand} size={15} className="shrink-0" data-backend-brand={thread.backend.brand} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-left">{thread.title.text.trim() || "Untitled thread"}</span>
            </button>
          ))}
          {threads.length === 0 && <p className={menuEmptyClass} role="status">No matching active threads</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
