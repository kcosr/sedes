import { useEffect, useMemo, useRef, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Folder, List, Server } from "lucide-react";
import type { ThreadMentionPickerMenu } from "./useThreadMentionPicker.js";
import { Popover, PopoverAnchor, PopoverContent } from "@client/components/ui/popover";
import { menuEmptyClass, menuRowClass, menuLabelClass } from "@client/components/ui/floating";
import { BackendBrandIcon } from "../brand-icons.js";
import { flatRowGlyphIcon, flatRowGlyphKind, flatRowGlyphLabel } from "./FlatThreadRow.js";

export interface ThreadReferenceLocation {
  readonly project: string | undefined;
  readonly environment: string | undefined;
}

export function ComposerThreadPicker({ open, onOpenChange, menu, locations, backgroundWorkCurrent, anchor, listId }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly menu: ThreadMentionPickerMenu;
  readonly locations: ReadonlyMap<string, ThreadReferenceLocation>;
  readonly backgroundWorkCurrent: boolean;
  readonly anchor: RefObject<HTMLElement | null>;
  readonly listId: string;
}): React.JSX.Element {
  const { selectedIndex } = menu;
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
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={virtualAnchor} />
      <PopoverContent side="top" align="start" sideOffset={8} role="dialog" aria-label="Reference a thread"
        className="skill-popover composer-thread-picker max-h-[min(var(--radix-popover-content-available-height),440px,70dvh)] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => { restoreComposerFocus.current = false; event.preventDefault(); }}
        onEscapeKeyDown={() => { restoreComposerFocus.current = true; }}
        onInteractOutside={(event) => {
          if (anchor.current?.contains(event.target as Node) || anchor.current?.contains(event.detail.originalEvent.target as Node)) event.preventDefault();
          else restoreComposerFocus.current = false;
        }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (restoreComposerFocus.current) anchor.current?.focus({ preventScroll: true }); }}>
        <div className={`${menuLabelClass} flex items-center gap-1`}>
          {menu.scope === "all" && <button type="button" aria-label="Back to current project" title="Back to current project"
            className="inline-flex size-6 items-center justify-center rounded hover:bg-accent"
            onMouseDown={event => event.preventDefault()} onClick={() => { menu.back(); anchor.current?.focus({ preventScroll: true }); }}>
            <ChevronLeft size={15} aria-hidden="true" />
          </button>}
          {menu.scope === "all" ? "All threads" : "Current project"}
        </div>
        <div ref={list} id={listId} role="listbox" aria-label="Matching threads" className="composer-thread-picker-list flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-(--menu-panel-padding)">
          {!menu.rows.some(row => row.kind === "thread") && <p className={menuEmptyClass} role="status">
            {menu.status === "loading" ? "Searching threads…" : menu.status === "failed" ? "Couldn't load threads" : "No matching active threads"}
          </p>}
          {menu.rows.map((row, index) => {
            const selectProps = {
              id: `${listId}-${index}`, role: "option", "aria-selected": index === selectedIndex,
              type: "button" as const, tabIndex: -1,
              onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
              onPointerMove: (event: React.PointerEvent) => { if (event.pointerType === "mouse") menu.setSelectedIndex(index); },
              onClick: () => { restoreComposerFocus.current = true; menu.choose(index); },
            };
            if (row.kind !== "thread") {
              const label = row.kind === "all" ? "All threads…" : row.kind === "more" ? "More threads…" : "Retry search";
              return <button key={row.kind} {...selectProps} className={`${menuRowClass} ${index === selectedIndex ? "bg-accent" : ""}`}>
                {row.kind === "all" && <List size={15} aria-hidden="true" />} {label}
                {row.kind === "all" && <ChevronRight size={15} className="ml-auto" aria-hidden="true" />}
              </button>;
            }
            const { thread } = row;
            const glyphKind = flatRowGlyphKind(thread, backgroundWorkCurrent);
            const glyphLabel = glyphKind === "idle" ? undefined : flatRowGlyphLabel(thread, backgroundWorkCurrent);
            const title = thread.title.text.trim() || "Untitled thread";
            const location = locations.get(thread.workspaceId);
            const description = [glyphLabel, location?.project && `Project: ${location.project}`, location?.environment && `Environment: ${location.environment}`].filter(Boolean).join(". ");
            const descriptionId = `${listId}-${index}-description`;
            return <button key={thread.id} {...selectProps}
              aria-label={title} aria-describedby={description ? descriptionId : undefined}
              title={[title, location?.project, location?.environment].filter(Boolean).join(" · ")}
              className={`${menuRowClass} composer-thread-picker-row ${index === selectedIndex ? "bg-accent" : ""}`}>
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
        </div>
      </PopoverContent>
    </Popover>
  );
}
