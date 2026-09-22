import { ChatViewVisibilityContext } from "./chat-view-visibility.js";
import { CircleDollarSign } from "lucide-react";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover.js";
import type { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import { RecordedUsage } from "./RecordedUsage.js";

export function TurnUsagePopover({ cache, turnId, onOpenChange }: {
  cache: UsageQueryCache; turnId: string; onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const visible = useContext(ChatViewVisibilityContext);
  const [mode, setMode] = useState<"closed" | "preview" | "pinned">("closed");
  const modeRef = useRef(mode); modeRef.current = mode;
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovered = useRef(false);
  const dismissed = useRef(false);
  const restoreFocus = useRef(false);
  const contentId = useId();
  const open = visible && mode !== "closed";
  useEffect(() => { if (!visible) setMode("closed"); }, [visible]);
  useEffect(() => { onOpenChange(open); return () => onOpenChange(false); }, [open, onOpenChange]);
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  const change = (next: typeof mode) => { modeRef.current = next; setMode(next); };
  const dismiss = () => { dismissed.current = true; change("closed"); };
  const preview = () => { clearTimeout(timer.current); if (!dismissed.current && modeRef.current === "closed") change("preview"); };
  const scheduleClose = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const focused = trigger.current?.contains(document.activeElement) || content.current?.contains(document.activeElement);
      if (!hovered.current && !focused && modeRef.current === "preview") change("closed");
    }, 140);
  };
  return <Popover open={open} onOpenChange={next => { if (!next) dismiss(); }}>
    <PopoverAnchor asChild><button ref={trigger} className="turn-fork-action" type="button"
      aria-label="Turn usage and cost" aria-expanded={open} aria-controls={open ? contentId : undefined} aria-haspopup="dialog"
      onPointerEnter={event => { if (event.pointerType !== "mouse") return; hovered.current = true; dismissed.current = false; preview(); }}
      onPointerLeave={event => { if (event.pointerType !== "mouse") return; hovered.current = false; scheduleClose(); }}
      onFocus={() => preview()} onBlur={() => { if (!hovered.current) dismissed.current = false; scheduleClose(); }}
      onClick={() => { clearTimeout(timer.current); if (modeRef.current === "pinned") dismiss(); else { dismissed.current = false; change("pinned"); } }}>
      <CircleDollarSign size={16} aria-hidden="true" />
    </button></PopoverAnchor>
    <PopoverContent ref={content} id={contentId} className="context-usage-popover turn-usage-popover" side="top" align="end" sideOffset={10} collisionPadding={12}
      aria-label="Turn usage" onOpenAutoFocus={event => event.preventDefault()}
      onCloseAutoFocus={event => { event.preventDefault(); if (restoreFocus.current) trigger.current?.focus(); restoreFocus.current = false; }}
      onEscapeKeyDown={() => { restoreFocus.current = modeRef.current === "pinned" || Boolean(trigger.current?.contains(document.activeElement) || content.current?.contains(document.activeElement)); dismiss(); }}
      onInteractOutside={event => { if (trigger.current?.contains(event.target as Node)) event.preventDefault(); }}
      onPointerEnter={event => { if (event.pointerType !== "mouse") return; hovered.current = true; clearTimeout(timer.current); }}
      onPointerLeave={event => { if (event.pointerType !== "mouse") return; hovered.current = false; scheduleClose(); }}
      onFocusCapture={() => clearTimeout(timer.current)} onBlurCapture={scheduleClose}>
      <strong className="turn-usage-heading">Turn usage</strong>
      {open && <RecordedUsage cache={cache} turnId={turnId} />}
    </PopoverContent>
  </Popover>;
}
