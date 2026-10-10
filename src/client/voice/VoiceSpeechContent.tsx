import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import type { NativeVoiceSettings } from "./native-voice-plugin.js";

/** Automatic speech content; explicit replay always reads the requested reply. */
export function VoiceSpeechContent({ value, pending, onChange }: {
  value: NativeVoiceSettings["speechContent"];
  pending: boolean;
  onChange: (value: NativeVoiceSettings["speechContent"]) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <Select value={value} open={open} onOpenChange={next => { if (!pending || !next) setOpen(next); }}
    onValueChange={next => { if (!pending) onChange(next as NativeVoiceSettings["speechContent"]); }}>
    <SelectTrigger aria-label="Read aloud" aria-disabled={pending || undefined}
      className="min-h-11 w-full aria-disabled:opacity-(--disabled-opacity)">
      <span className="mr-auto">Read aloud</span><span className="text-muted-foreground"><SelectValue /></span>
    </SelectTrigger>
    <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-16px)]">
      <SelectItem value="announcements" description="Event and thread, without message text">Announcements</SelectItem>
      <SelectItem value="messages" description="Message text, without a preamble">Messages</SelectItem>
      <SelectItem value="both" description="Announcement followed by message text">Both</SelectItem>
    </SelectContent>
  </Select>;
}
