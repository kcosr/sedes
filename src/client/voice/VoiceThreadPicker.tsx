import { useState } from "react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, type DialogLayer } from "../components/ui/dialog.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

export function VoiceThreadPicker({ threads, open, onOpenChange, onSelect, layer }: {
  threads: readonly NormalizedApplicationThreadSummary[]; open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (thread: NormalizedApplicationThreadSummary) => void;
  /** `over-dialog` when opened from a sheet or another dialog. */
  layer?: DialogLayer;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const choices = threads.filter(thread => thread.available && (thread.inventoryState === "active" || thread.inventoryState === "settled") &&
    thread.title.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent layer={layer}>
      <DialogHeader><DialogTitle>Choose voice thread</DialogTitle>
        <DialogDescription>Recognized text will be sent to the thread you select.</DialogDescription></DialogHeader>
      <Input aria-label="Search voice threads" value={search} onChange={event => setSearch(event.target.value)} />
      {choices.length ? <ul className="grid max-h-80 gap-1 overflow-y-auto" role="list" aria-label="Voice threads">
        {choices.map(thread => <li key={thread.id} className="grid min-w-0"><Button variant="ghost" className="min-w-0 justify-start"
          onClick={() => { onSelect(thread); onOpenChange(false); }}><span className="truncate">{thread.title.text.trim() || "Untitled thread"}</span></Button></li>)}
      </ul> : <p>No available threads match.</p>}
    </DialogContent>
  </Dialog>;
}
