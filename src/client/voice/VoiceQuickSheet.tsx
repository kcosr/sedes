import "./voice-sheet.css";
import { useId, useState, type ReactNode } from "react";
import { ChevronRight, Ear, ListFilter, Merge, MessageSquare, Mic, MicOff, Settings2, Volume2 } from "lucide-react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { navigate, settingsPath } from "../app/router.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { eyebrowClass } from "../components/ui/floating.js";
import { menuSheetRowClass } from "../components/ui/menu-sheet.js";
import { SegmentedControl, SegmentedControlItem } from "../components/ui/segmented-control.js";
import { Separator } from "../components/ui/separator.js";
import { Switch } from "../components/ui/switch.js";
import { cn } from "../lib/utils.js";
import { useVoiceState } from "./VoiceProvider.js";
import type { NativeVoiceStore } from "./NativeVoiceStore.js";
import { voiceReadiness } from "./VoiceSettingsPage.js";
import { canEnableVoice, resumeVoice } from "./voice-session.js";
import { nativeThreadTitle, type NativeVoiceSettings } from "./native-voice-plugin.js";
import { VoiceThreadPicker } from "./VoiceThreadPicker.js";

const modes = [
  ["off", "Off", MicOff, "pauses voice. Pick Manual or Response to resume."],
  ["manual", "Manual", Mic, "keeps completions silent; the mic can still open afterward."],
  ["response", "Response", Volume2, "speaks selected notices and responses."],
] as const;
// Sheet rows: the menu-sheet recipe at 56px with a description and 48px without; a two-line row's icon sits on its first line.
const rowClass = cn(menuSheetRowClass, "min-h-14 has-[:focus-visible]:bg-(--hover) [&>svg:first-child]:mt-0.5 [&>svg:first-child]:self-start");
const singleRowClass = cn(menuSheetRowClass, "min-h-12");
const trailClass = "size-(--icon-md) text-muted-foreground-2";
const lockedClass = "aria-disabled:cursor-not-allowed aria-disabled:opacity-(--disabled-opacity)";
/** With the card gone (Off while the bar is hidden), closing returns focus to the view the card sat under; not the composer, whose focus raises the keyboard. */
const viewFocus = () => Array.from(document.querySelectorAll<HTMLElement>(".application-workspace, .settings-content")).find(element => !element.closest("[inert], [hidden]"));

/** Quick voice settings from the voice card's caret. Every write goes through the store, as in Settings → Voice. */
export function VoiceQuickSheet({ store, threads, open, onOpenChange }: {
  store: NativeVoiceStore;
  threads: readonly NormalizedApplicationThreadSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const state = useVoiceState(store);
  const [picker, setPicker] = useState(false);
  const native = state.native;
  const settings = native?.settings;
  // A dismissed sheet or lost connection must not reopen its picker on the next visit.
  if (picker && (!open || !native)) setPicker(false);
  // A pending write locks controls with aria-disabled, not disabled: a disabled control drops focus to the page.
  const locked = state.pending || undefined;
  const update = (patch: Partial<NativeVoiceSettings>) => { if (!state.pending) void store.update(patch).catch(() => undefined); };
  const [status, tone] = state.error ? [state.error, "warning"] : !native ? [state.loading ? "Connecting voice to this server…" : "Voice could not connect to this server.", "warning"]
    : native.settings.audioMode === "off" ? ["Voice off", "muted"] : native.ready ? ["Ready", "success"] : [voiceReadiness(native.readiness), "warning"];
  const mode = settings ? modes.find(([value]) => value === settings.audioMode)! : undefined;
  // Enabling voice requires both the speech destination and its native credential.
  const blocked = settings?.audioMode === "off" && !canEnableVoice(settings, native?.speech.credentialConfigured === true);
  const defaultThread = settings?.voiceThreadTitle ?? (settings?.voiceThreadId
    ? threads.find(thread => thread.id === settings.voiceThreadId)?.title.text.trim() || "Untitled thread" : "Choose thread");
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent layout="sheet" className="voice-sheet" fallbackFocus={viewFocus}>
      <DialogHeader>
        <DialogTitle>Voice</DialogTitle>
        <DialogDescription className="voice-sheet-status" data-tone={tone} role="status">{status}</DialogDescription>
      </DialogHeader>
      {settings && mode ? <>
        <div className="grid gap-2">
          <p className={cn(eyebrowClass, "text-muted-foreground")} aria-hidden="true">Audio mode</p>
          <SegmentedControl aria-label="Audio mode" className="voice-sheet-modes h-13 w-full" value={settings.audioMode}
            onValueChange={value => update({ audioMode: value as NativeVoiceSettings["audioMode"] })}>
            {/* Segments rove their tab stop, so the dialog's first-field focus would skip them: start on the selected one. */}
            {modes.map(([value, label, Icon]) => <SegmentedControlItem key={value} value={value} className={cn("gap-2", lockedClass)}
              disabled={blocked && value !== "off"} aria-disabled={locked} data-autofocus={value === settings.audioMode ? "" : undefined}>
              <Icon className="size-(--icon-md)" aria-hidden="true" />{label}</SegmentedControlItem>)}
          </SegmentedControl>
          <p className="voice-sheet-help"><strong>{mode[1]}</strong> {blocked ? "pauses voice. Set up speech in All voice settings first." : mode[3]}</p>
          {settings.audioMode !== "off" && native?.actions.canResume ? <Button className={cn("h-(--control-touch) w-full", lockedClass)} aria-disabled={locked}
            onClick={() => { if (!state.pending) void resumeVoice(store).catch(() => undefined); }}>Resume voice</Button> : null}
        </div>
        <div className="-mx-3 -mt-2 flex flex-col">
          <SwitchRow icon={<Ear aria-hidden="true" />} label="Auto-listen" description="Eligible notifications reopen the mic"
            checked={settings.autoListen} locked={locked} onCheckedChange={autoListen => update({ autoListen })} />
          <SwitchRow icon={<Merge aria-hidden="true" />} label="Follow composer mode" description="Use its Steer or Queue choice"
            checked={settings.followComposerMode} locked={locked} onCheckedChange={followComposerMode => update({ followComposerMode })} />
          <DefaultThreadRow choice={defaultThread} locked={locked} onClick={() => { if (!state.pending) setPicker(true); }} />
          <SwitchRow icon={<ListFilter aria-hidden="true" />} label="Only play from default voice thread" description="Limit automatic playback to this thread"
            checked={settings.onlyVoiceThread} locked={locked} onCheckedChange={onlyVoiceThread => update({ onlyVoiceThread })} />
          <Separator className="mx-3 my-1 data-[orientation=horizontal]:w-auto" />
          <SettingsRow onOpenChange={onOpenChange} />
        </div>
      </> : <div className="-mx-3 -mt-2 flex flex-col"><SettingsRow onOpenChange={onOpenChange} /></div>}
      <VoiceThreadPicker threads={threads} open={picker} onOpenChange={setPicker} title="Choose default voice thread"
        description="Used for recording when no thread is visible." layer="over-dialog"
        pinned={{ threadId: settings?.voiceThreadId ?? null, label: "Current default voice thread" }}
        onSelect={thread => update({ voiceThreadId: thread.id, voiceThreadTitle: nativeThreadTitle(thread.title.text) })} />
    </DialogContent>
  </Dialog>;
}

function DefaultThreadRow({ choice, locked, onClick }: { choice: string; locked?: true; onClick: () => void }) {
  const id = useId();
  return <button type="button" className={cn(rowClass, lockedClass)} aria-disabled={locked} aria-haspopup="dialog"
    aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} onClick={onClick}>
    <MessageSquare aria-hidden="true" /><RowText id={id} label="Default voice thread" description={choice} />
    <ChevronRight className={trailClass} aria-hidden="true" />
  </button>;
}

/** The whole row toggles the switch, which is named by the label alone. */
function SwitchRow({ icon, label, description, checked, locked, onCheckedChange }: {
  icon: ReactNode; label: string; description: string; checked: boolean; locked?: true; onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return <label className={rowClass}>
    {icon}<RowText id={id} label={label} description={description} />
    <Switch className={lockedClass} checked={checked} aria-disabled={locked} onCheckedChange={onCheckedChange} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} />
  </label>;
}
function RowText({ id, label, description }: { id: string; label: string; description: string }) {
  return <span className="flex min-w-0 flex-1 flex-col gap-0.5">
    <span id={`${id}-label`}>{label}</span>
    <span id={`${id}-description`} className="truncate text-(length:--text-ui) leading-[18px] text-muted-foreground">{description}</span>
  </span>;
}
function SettingsRow({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  return <button type="button" className={singleRowClass} onClick={() => { onOpenChange(false); navigate(settingsPath("voice")); }}>
    <Settings2 aria-hidden="true" /><span className="min-w-0 flex-1">All voice settings</span><ChevronRight className={trailClass} aria-hidden="true" />
  </button>;
}
