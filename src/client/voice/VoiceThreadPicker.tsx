import { Check } from "lucide-react";
import { useId, useRef, useState, type RefObject } from "react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, type DialogLayer } from "../components/ui/dialog.js";
import { menuCheckIndicatorClass, menuCheckRowClass, menuEmptyClass, menuLabelClass, menuListRowClass, menuRowClass } from "../components/ui/floating.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverTitle } from "../components/ui/popover.js";
import { SearchableSelectSearch } from "../components/ui/searchable-select.js";
import { usePickerFocus } from "../lib/use-picker-focus.js";
import { cn } from "../lib/utils.js";

type VoiceThreadPickerProps = {
  threads: readonly NormalizedApplicationThreadSummary[];
  open: boolean;
  title?: string;
  description?: string;
  layer?: DialogLayer;
  selectedThreadId?: string | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (thread: NormalizedApplicationThreadSummary) => void;
  /** Listed first under its label when it can be chosen. */
  pinned?: { threadId: string | null; label: string };
} & ({ presentation?: "dialog"; anchorRef?: never } | {
  presentation: "popover";
  anchorRef: RefObject<HTMLElement | null>;
});

export function VoiceThreadPicker({ threads, open, onOpenChange, onSelect, pinned, selectedThreadId,
  title = "Choose target thread", description = "Recognized text will be sent to the thread you select.",
  layer = "dialog", presentation = "dialog", anchorRef }: VoiceThreadPickerProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const choiceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const interactedOutside = useRef(false);
  const pickerFocus = usePickerFocus(searchRef);
  const labelId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const matching = threads.filter(thread => thread.available && (thread.inventoryState === "active" || thread.inventoryState === "settled") &&
    thread.title.text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const first = pinned?.threadId ? matching.find(thread => thread.id === pinned.threadId) : undefined;
  const choices = first ? [first, ...matching.filter(thread => thread !== first)] : matching;
  const changeOpen = (next: boolean) => {
    if (!next) setSearch("");
    onOpenChange(next);
  };
  const searchInput = <SearchableSelectSearch ref={searchRef} type="search" aria-label="Search voice threads" placeholder="Search threads"
    value={search} onChange={event => setSearch(event.currentTarget.value)} onKeyDown={event => {
      if (event.key === "ArrowDown" && choices.length) {
        event.preventDefault();
        choiceRefs.current[0]?.focus();
      }
    }} />;
  const list = choices.length ? <ul className="m-0 flex list-none flex-col p-0" aria-label="Voice threads">
    {choices.map((thread, index) => <li key={thread.id} className="min-w-0">
      {thread === first ? <span id={labelId} className={cn(menuLabelClass, "block")}>{pinned!.label}</span> : null}
      <div className={menuListRowClass}>
        <button type="button" ref={element => { choiceRefs.current[index] = element; }}
          className={cn(menuRowClass, menuCheckRowClass, "min-w-0")}
          data-state={thread.id === selectedThreadId ? "checked" : "unchecked"}
          aria-current={thread.id === selectedThreadId ? "true" : undefined}
          aria-describedby={thread === first ? labelId : undefined}
          title={thread.title.text.trim() || "Untitled thread"}
          onClick={() => { onSelect(thread); changeOpen(false); }}
          onKeyDown={event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (event.key === "ArrowUp" && index === 0) searchRef.current?.focus();
              else choiceRefs.current[(index + (event.key === "ArrowDown" ? 1 : -1)) % choices.length]?.focus();
            }
          }}>
          <span className="truncate">{thread.title.text.trim() || "Untitled thread"}</span>
          {thread.id === selectedThreadId ? <span className={menuCheckIndicatorClass}><Check aria-hidden="true" /></span> : null}
        </button>
      </div>
    </li>)}
  </ul> : <p className={cn(menuEmptyClass, "m-0")}>No available threads match.</p>;

  if (presentation === "popover") return <Popover open={open} onOpenChange={changeOpen}>
    <PopoverAnchor virtualRef={anchorRef} />
    <PopoverContent side="top" align="start" aria-labelledby={titleId} aria-describedby={descriptionId}
      className="max-h-[min(520px,var(--radix-popover-content-available-height))] w-[min(500px,calc(100vw-16px))] gap-0 overflow-hidden p-0"
      onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
      onInteractOutside={event => {
        if (event.target instanceof Node && anchorRef?.current?.contains(event.target)) event.preventDefault();
        else interactedOutside.current = true;
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (!interactedOutside.current) anchorRef?.current?.focus({ preventScroll: true });
        interactedOutside.current = false;
      }}>
      <div className="grid min-w-0 shrink-0 gap-0.5 px-3 pt-2.5 pb-2">
        <PopoverTitle id={titleId} className="m-0 leading-5">{title}</PopoverTitle>
        <PopoverDescription id={descriptionId} className="m-0 text-(length:--text-meta) leading-4 text-muted-foreground-2">{description}</PopoverDescription>
      </div>
      {searchInput}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-(--menu-panel-padding)">{list}</div>
    </PopoverContent>
  </Popover>;

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogContent size="md" layer={layer} onOpenAutoFocus={pickerFocus.onOpenAutoFocus}>
      <DialogHeader><DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription></DialogHeader>
      {searchInput}
      <DialogBody>{list}</DialogBody>
    </DialogContent>
  </Dialog>;
}
