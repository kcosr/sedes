import { useRef } from "react";
import { MessagesSquare } from "lucide-react";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import { Popover, PopoverContent, PopoverTrigger } from "@client/components/ui/popover";
import { SearchableSelectSearch } from "@client/components/ui/searchable-select";
import { menuEmptyClass, menuRowClass } from "@client/components/ui/floating";
import { moveListFocus } from "@client/lib/list-focus";
import { usePickerFocus } from "../../lib/use-picker-focus.js";

export function ComposerThreadPicker({ open, onOpenChange, query, onQueryChange, threads, selectedIds, disabled, onSelect, focusSearch }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly threads: readonly NormalizedApplicationThreadSummary[];
  readonly selectedIds: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onSelect: (thread: NormalizedApplicationThreadSummary) => void;
  readonly focusSearch: boolean;
}): React.JSX.Element {
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const focus = usePickerFocus(search);
  const needle = query.trim().toLocaleLowerCase();
  const matching = threads.filter((thread) => !selectedIds.has(thread.id) &&
    (!needle || `${thread.title.text} ${thread.id}`.toLocaleLowerCase().includes(needle))).slice(0, 30);
  const rows = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="skill-button" aria-label="Reference a thread" title="Reference a thread (@)"
          disabled={disabled} onPointerDown={focus.onPointerDown} onKeyDown={focus.onKeyDown}>
          <MessagesSquare size={15} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} role="dialog" aria-label="Reference a thread"
        className="skill-popover max-h-[min(var(--radix-popover-content-available-height),440px,70dvh)] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => { if (focusSearch) focus.requestSearchFocus(); focus.onOpenAutoFocus(event); }}>
        <SearchableSelectSearch ref={search} type="search" value={query} aria-label="Search threads" placeholder="Search active threads"
          onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && moveListFocus(rows(), event.key)) event.preventDefault();
            if (event.key === "Enter" && matching[0]) { event.preventDefault(); onSelect(matching[0]); }
          }} />
        <div ref={list} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-(--menu-panel-padding)"
          onKeyDown={(event) => { if (moveListFocus(rows(), event.key)) event.preventDefault(); }}>
          {matching.map((thread) => (
            <button key={thread.id} type="button" className={menuRowClass} onClick={() => onSelect(thread)}>
              <span className="min-w-0 flex-1 text-left"><span className="block truncate">{thread.title.text}</span>
                <span className="block truncate text-xs text-muted-foreground">{thread.id}</span></span>
            </button>
          ))}
          {matching.length === 0 && <p className={menuEmptyClass} role="status">No matching active threads</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
