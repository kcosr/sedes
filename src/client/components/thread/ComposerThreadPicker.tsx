import { useEffect, useMemo, useRef, type RefObject } from "react";
import { Folder, Server } from "lucide-react";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import { Popover, PopoverAnchor, PopoverContent } from "@client/components/ui/popover";
import { menuEmptyClass, menuRowClass } from "@client/components/ui/floating";
import { BackendBrandIcon } from "../brand-icons.js";
import { flatRowGlyphIcon, flatRowGlyphKind, flatRowGlyphLabel } from "./FlatThreadRow.js";

export interface ThreadReferenceLocation {
  readonly project: string | undefined;
  readonly environment: string | undefined;
}

export function ComposerThreadPicker({ open, onOpenChange, threads, locations, backgroundWorkCurrent, onSelect, anchor, listId, selectedIndex, onSelectedIndexChange }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threads: readonly NormalizedApplicationThreadSummary[];
  readonly locations: ReadonlyMap<string, ThreadReferenceLocation>;
  readonly backgroundWorkCurrent: boolean;
  readonly onSelect: (thread: NormalizedApplicationThreadSummary) => void;
  readonly anchor: RefObject<HTMLTextAreaElement | null>;
  readonly listId: string;
  readonly selectedIndex: number;
  readonly onSelectedIndexChange: (index: number) => void;
}): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  const restoreComposerFocus = useRef(false);
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
      <PopoverContent side="top" align="start" sideOffset={8} role="dialog" aria-label="Reference a thread"
        className="skill-popover composer-thread-picker max-h-[min(var(--radix-popover-content-available-height),440px,70dvh)] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => { restoreComposerFocus.current = false; event.preventDefault(); }}
        onEscapeKeyDown={() => { restoreComposerFocus.current = true; }}
        onInteractOutside={(event) => {
          if (event.target === anchor.current || event.detail.originalEvent.target === anchor.current) event.preventDefault();
          else restoreComposerFocus.current = false;
        }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (restoreComposerFocus.current) anchor.current?.focus({ preventScroll: true }); }}>
        <div ref={list} id={listId} role="listbox" aria-label="Matching threads" className="composer-thread-picker-list flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-(--menu-panel-padding)">
          {threads.map((thread, index) => {
            const glyphKind = flatRowGlyphKind(thread, backgroundWorkCurrent);
            const glyphLabel = glyphKind === "idle" ? undefined : flatRowGlyphLabel(thread, backgroundWorkCurrent);
            const title = thread.title.text.trim() || "Untitled thread";
            const location = locations.get(thread.workspaceId);
            const description = [glyphLabel, location?.project && `Project: ${location.project}`, location?.environment && `Environment: ${location.environment}`].filter(Boolean).join(". ");
            const descriptionId = `${listId}-${index}-description`;
            return <button key={thread.id} id={`${listId}-${index}`} role="option" aria-selected={index === selectedIndex} type="button" tabIndex={-1}
              aria-label={title} aria-describedby={description ? descriptionId : undefined}
              title={[title, location?.project, location?.environment].filter(Boolean).join(" · ")}
              className={`${menuRowClass} composer-thread-picker-row ${index === selectedIndex ? "bg-accent" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={(event) => { if (event.pointerType === "mouse") onSelectedIndexChange(index); }}
              onClick={() => chooseThread(thread)}>
              <span className="flat-row-glyph" data-glyph={glyphLabel ? glyphKind : undefined} aria-hidden="true" title={glyphLabel}>
                {glyphLabel ? flatRowGlyphIcon(glyphKind) : null}
              </span>
              <BackendBrandIcon brand={thread.backend.brand} size={15} className="shrink-0" data-backend-brand={thread.backend.brand} aria-hidden="true" />
              <span className="composer-thread-picker-title truncate">{title}</span>
              <span className="composer-thread-picker-context">
                <span className="composer-thread-picker-project composer-thread-picker-location" title={location?.project}>
                  {location?.project && <><Folder size={13} aria-hidden="true" /><span className="truncate">{location.project}</span></>}
                </span>
                <span className="composer-thread-picker-environment composer-thread-picker-location" title={location?.environment}>
                  {location?.environment && <><Server size={12} aria-hidden="true" /><span className="truncate">{location.environment}</span></>}
                </span>
              </span>
              {description && <span id={descriptionId} className="sr-only">{description}</span>}
            </button>;
          })}
          {threads.length === 0 && <p className={menuEmptyClass} role="status">No matching active threads</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
