import { useState } from "react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

export function VoiceThreadPicker({ threads, open, onOpenChange, onSelect }: {
  threads: readonly NormalizedApplicationThreadSummary[]; open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (thread: NormalizedApplicationThreadSummary) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const choices = threads.filter(thread => thread.available && (thread.inventoryState === "active" || thread.inventoryState === "settled") &&
    thread.title.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader><DialogTitle>Choose voice thread</DialogTitle>
        <DialogDescription>Recognized text will be sent to the thread you select.</DialogDescription></DialogHeader>
      <Input aria-label="Search voice threads" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="grid max-h-80 gap-1 overflow-y-auto" role="list" aria-label="Voice threads">
        {choices.map(thread => <Button key={thread.id} variant="ghost" className="justify-start overflow-hidden text-ellipsis"
          onClick={() => { onSelect(thread); onOpenChange(false); }}>{thread.title.text || "Untitled thread"}</Button>)}
        {choices.length === 0 ? <p>No available threads match.</p> : null}
      </div>
    </DialogContent>
  </Dialog>;
}
