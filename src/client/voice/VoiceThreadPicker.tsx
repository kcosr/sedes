import { useId, useState } from "react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, type DialogLayer } from "../components/ui/dialog.js";
import { Button } from "../components/ui/button.js";
import { eyebrowClass } from "../components/ui/floating.js";
import { Input } from "../components/ui/input.js";
import { cn } from "../lib/utils.js";

export function VoiceThreadPicker({ threads, open, onOpenChange, onSelect, pinned, title = "Choose voice thread", description = "Recognized text will be sent to the thread you select.", layer = "dialog" }: {
  threads: readonly NormalizedApplicationThreadSummary[]; open: boolean;
  title?: string;
  description?: string;
  layer?: DialogLayer;
  onOpenChange: (open: boolean) => void;
  onSelect: (thread: NormalizedApplicationThreadSummary) => void;
  /** Listed first under its label when it can be chosen: the visible thread ("This thread") or, without one, the default voice thread. */
  pinned?: { threadId: string | null; label: string };
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const labelId = useId();
  const matching = threads.filter(thread => thread.available && (thread.inventoryState === "active" || thread.inventoryState === "settled") &&
    thread.title.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const first = pinned?.threadId ? matching.find(thread => thread.id === pinned.threadId) : undefined;
  const choices = first ? [first, ...matching.filter(thread => thread !== first)] : matching;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent layer={layer}>
      <DialogHeader><DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription></DialogHeader>
      <Input aria-label="Search voice threads" value={search} onChange={event => setSearch(event.target.value)} />
      {choices.length ? <ul className="grid max-h-80 gap-1 overflow-y-auto" role="list" aria-label="Voice threads">
        {/* The pinned label sits outside the button, so every choice is named by its title alone. */}
        {choices.map(thread => <li key={thread.id} className={cn("grid min-w-0", thread === first && choices.length > 1 && "border-b border-border-soft pb-1")}>
          {thread === first ? <span id={labelId} className={cn(eyebrowClass, "px-2.5 pt-1")}>{pinned!.label}</span> : null}
          <Button variant="ghost" className="min-w-0 justify-start" aria-describedby={thread === first ? labelId : undefined}
            onClick={() => { onSelect(thread); onOpenChange(false); }}><span className="truncate">{thread.title.text.trim() || "Untitled thread"}</span></Button></li>)}
      </ul> : <p>No available threads match.</p>}
    </DialogContent>
  </Dialog>;
}
