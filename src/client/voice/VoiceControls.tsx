import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import { AudioLines, ChevronsUpDown, ChevronUp, LoaderCircle, MessageSquare, Mic, MicOff, RotateCcw, SkipForward, TriangleAlert } from "lucide-react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { navigate, settingsPath, threadPath, useRoute } from "../app/router.js";
import { useComposerDeliveryMode } from "../app/composer-delivery-mode.js";
import { useNativeVoice, useVoiceState } from "./VoiceProvider.js";
import type { NativeVoiceStore } from "./NativeVoiceStore.js";
import { VoiceQuickSheet } from "./VoiceQuickSheet.js";
import { VoiceThreadPicker } from "./VoiceThreadPicker.js";
import { voiceReadiness } from "./VoiceSettingsPage.js";
import { useShowVoiceBarWhenOff } from "./voice-bar-preference.js";
import { resumeVoice } from "./voice-session.js";
import { nativeThreadTitle } from "./native-voice-plugin.js";
import "./voice.css";

/** Card text: parts joined by dots (a phase word carries its tone, an alert part is the error message, a chip retargets), a named thread, or a muted placeholder. */
type Tone = "info" | "destructive" | "warning";
type Part = string | { phase: string; tone?: Tone } | { alert: string; tone?: Tone } | { chip: string; glyph?: boolean };
type Line = { parts: Part[] } | { thread: string } | { empty: string };

export function VoiceControls({ threads }: { threads: readonly NormalizedApplicationThreadSummary[] }) {
  const store = useNativeVoice();
  return store ? <NativeVoiceControls store={store} threads={threads} /> : null;
}
function NativeVoiceControls({ store, threads }: { store: NativeVoiceStore; threads: readonly NormalizedApplicationThreadSummary[] }) {
  const state = useVoiceState(store);
  const route = useRoute();
  const composerMode = useComposerDeliveryMode();
  const [showWhenOff] = useShowVoiceBarWhenOff(store);
  const [picker, setPicker] = useState<"start" | "retarget" | null>(null);
  const [sheet, setSheet] = useState(false);
  const statusId = useId();
  const threadId = route.name === "thread" ? route.threadId : null;
  const threadTitle = nativeThreadTitle(threads.find(thread => thread.id === threadId)?.title.text ?? "");
  useEffect(() => {
    const expectedConnectionGeneration = state.native?.connectionGeneration;
    if (expectedConnectionGeneration === undefined) return;
    let alive = true;
    const publish = () => {
      if (!alive) return;
      void store.plugin.setForegroundContext({ expectedConnectionGeneration, visible: document.visibilityState !== "hidden", threadId, threadTitle, composerMode }).catch(() => undefined);
    };
    publish();
    document.addEventListener("visibilitychange", publish);
    return () => { alive = false; document.removeEventListener("visibilitychange", publish); };
  }, [store, threadId, threadTitle, composerMode, state.native?.connectionGeneration]);
  const native = state.native;
  // A lost connection closes the sheet and picker, so neither reopens by itself when voice reconnects.
  if (!native && (sheet || picker)) { setSheet(false); setPicker(null); }
  // Unavailable voice is reported and retried in Settings → Voice; the card appears only for a connected session.
  if (!native) return null;
  const act = (action: () => ReturnType<typeof store.plugin.getState>) => { void store.run(action).catch(() => undefined); };
  const available = (id: string | null) => threads.find(thread => thread.id === id && thread.available &&
    (thread.inventoryState === "active" || thread.inventoryState === "settled"));
  // Explicit recording targets the visible thread, then the Voice thread, then a picker; the idle card names that target.
  const startTarget = available(threadId) ?? available(native.settings.voiceThreadId);
  const start = () => {
    // Native decides when explicit recording can start; it does not need the notification stream that `ready` includes.
    if (!native.actions.canStart) { navigate(settingsPath("voice")); return; }
    if (!startTarget) { setPicker("start"); return; }
    act(() => store.plugin.startManualListen({ ...store.commandContext(), threadId: startTarget.id, threadTitle: nativeThreadTitle(startTarget.title.text) ?? undefined }));
  };
  const { phase, active, settings } = native;
  const off = settings.audioMode === "off";
  const busy = !["off", "idle"].includes(phase);
  const failed = phase === "error";
  const speaking = phase === "synthesizing" || phase === "speaking";
  const recording = phase === "listening";
  const retargets = !off && native.actions.canRetarget;
  // Voice is on without a session (Android stopped or refused the service): only a user-initiated mode write resumes it.
  const resumable = !off && native.actions.canResume;
  // Native Stop discards a recording that has not been sent yet.
  const cancels = ["validating", "arming", "listening", "recognizing"].includes(phase);
  const showingInput = ["validating", "arming", "listening", "recognizing", "submitting", "recovering"].includes(phase);
  const [targetId, targetTitle] = showingInput ? [active?.recognitionThreadId, active?.recognitionThreadTitle]
    : [active?.threadId ?? active?.recognitionThreadId, active?.threadTitle ?? active?.recognitionThreadTitle];
  const activeTitle = targetTitle ?? (targetId ? threads.find(thread => thread.id === targetId)?.title.text.trim() || "Untitled thread" : undefined);
  // A failure stays until the next action, a reconnect or progress; the error phase falls back to native's latest report.
  const latest = native.errors.at(-1);
  const message = state.error ?? (failed ? latest?.message ?? cardReadiness(native.readiness) : undefined);
  // Line 1 names a thread only when it is not the visible one.
  const visibleTarget = threadId !== null && targetId === threadId;
  const kind = speaking && active?.eventKind ? eventLabels.get(active.eventKind) : undefined;
  const phaseWord: Part = state.error ? { alert: state.error, tone: "warning" }
    : { phase: phaseLabel(phase), tone: recording ? "destructive" : phase === "speaking" ? "info" : undefined };
  let tile: ReactNode, tone: string | undefined, line1: Line, line2: Line;
  const errorLook = !off && (failed || (!busy && message !== undefined));
  if (off) { tile = <MicOff strokeWidth={1.8} aria-hidden="true" />; tone = "muted"; line1 = { parts: ["Voice off"] }; line2 = { parts: ["Open controls to turn on"] }; }
  else if (errorLook) {
    tile = <TriangleAlert strokeWidth={1.8} aria-hidden="true" />; tone = "warning";
    // Native's start rejection asks to resume "from the visible app"; on the card that is its own Resume. The alert keeps native's words.
    line1 = latest?.code === "foreground_start_rejected" && message === latest.message ? { parts: [cardReadiness("needsResume")] } : { parts: [{ alert: message ?? phaseLabel("error") }] };
    line2 = { parts: [{ phase: phaseLabel("error"), tone: "warning" }] };
  } else if (!busy) {
    tile = <AudioLines strokeWidth={1.8} aria-hidden="true" />;
    const mode = [settings.audioMode === "manual" ? "Manual" : "Response", `Auto-listen ${settings.autoListen ? "on" : "off"}`];
    const readiness = native.ready ? undefined : cardReadiness(native.readiness);
    // When the start target is not the visible thread, line 1 names it (or asks for one), so readiness takes line 2.
    if (startTarget && startTarget.id === threadId) { line1 = { parts: [readiness ?? "Ready to record"] }; line2 = { parts: mode }; }
    else { line1 = startTarget ? { thread: startTarget.title.text.trim() || "Untitled thread" } : { empty: "Choose a thread" }; line2 = { parts: readiness ? [readiness] : mode }; }
  } else {
    tile = phase === "speaking" ? <span className="voice-card-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
      : recording ? <><Mic strokeWidth={1.8} aria-hidden="true" /><span className="voice-card-rec" aria-hidden="true" /></>
        : <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />;
    tone = phase === "speaking" ? "info" : recording ? "destructive" : undefined;
    const status = state.error ? phaseWord : phaseLabel(phase);
    // Retargeting stays on its chip, always on line 2, so line 1 reads like every other state and the body around the chip opens the thread.
    if (retargets && visibleTarget) { line1 = { parts: [status] }; line2 = { parts: [{ chip: "This thread", glyph: true }] }; }
    else if (retargets && activeTitle !== undefined) { line1 = { thread: activeTitle }; line2 = { parts: [phaseWord, { chip: "Change thread" }] }; }
    else if (retargets) { line1 = { parts: [status] }; line2 = { parts: [{ chip: "Choose a thread", glyph: true }] }; }
    else if (!visibleTarget && activeTitle !== undefined) { line1 = { thread: activeTitle }; line2 = { parts: state.error || !kind ? [phaseWord] : [phaseWord, kind] }; }
    else {
      const queued = speaking && native.queue.count > 0 ? `${native.queue.count} queued` : undefined;
      line1 = { parts: [status] }; line2 = { parts: [visibleTarget ? "This thread" : kind, queued].filter((part): part is string => part !== undefined) };
    }
  }
  // Settings → Voice announces readiness and errors itself; there the card's regions stay quiet.
  const quiet = route.name === "settings" && route.page === "voice";
  const alerting = message !== undefined && !quiet;
  const describedBy = alerting ? `${statusId} ${statusId}-alert` : statusId;
  // The body opens the card's thread: the spoken notice's, the recording target, or the idle start target. Off, an error and the visible thread have none.
  const [cardThread, cardTitle] = off || errorLook ? [] : busy ? [targetId ?? undefined, activeTitle] : [startTarget?.id, startTarget && (startTarget.title.text.trim() || "Untitled thread")];
  const opens = cardThread !== undefined && cardThread !== threadId;
  // A pending retarget stays focusable, so the picker returns focus to the chip after a selection.
  const chip = ({ chip: label, glyph }: { chip: string; glyph?: boolean }) => <button type="button" className="voice-card-chip" aria-haspopup="dialog" aria-disabled={state.pending || undefined}
    aria-label={visibleTarget ? "Change recording target: this thread" : activeTitle ? `Change recording target: ${activeTitle}` : "Change recording target"}
    onClick={() => { if (!state.pending) setPicker("retarget"); }}>
    {glyph ? <MessageSquare strokeWidth={1.8} aria-hidden="true" /> : null}<span className="voice-card-chip-label">{label}</span><ChevronsUpDown aria-hidden="true" /></button>;
  return <>
    {!off || showWhenOff ? <div className="voice-dock">
      <div className="voice-card" role="group" aria-label="Voice controls" data-tone={recording ? "destructive" : undefined} data-off={off ? "" : undefined}>
        <div className="voice-card-body">
          {opens ? <button type="button" className="voice-card-open" aria-label={`Open thread: ${cardTitle ?? "Untitled thread"}`} onClick={() => navigate(threadPath(cardThread))} /> : null}
          <span className="voice-card-tile" data-tone={tone}>{tile}</span>
          <span className="voice-card-text">{renderLine(line1, "voice-card-title", chip)}{renderLine(line2, "voice-card-sub", chip)}</span>
        </div>
        {/* Only the caret opens the sheet. */}
        <button type="button" className="voice-card-caret" aria-haspopup="dialog" aria-describedby={describedBy} aria-label="Open voice controls"
          onClick={() => setSheet(true)}><ChevronUp aria-hidden="true" /></button>
        <div className="voice-card-actions">
          {resumable ? <button type="button" className="voice-card-retry" aria-label="Resume voice" disabled={state.pending}
            onClick={() => { void resumeVoice(store).catch(() => undefined); }}><RotateCcw aria-hidden="true" /><span>Resume</span></button>
            : !busy || failed ? <button type="button" className="voice-card-button" aria-label="Start voice recording" disabled={off || state.pending} onClick={start}
              title={off ? "Voice is off" : native.actions.canStart ? "Start voice recording" : cardReadiness(native.readiness)}><Mic strokeWidth={1.8} aria-hidden="true" /></button> : null}
          {native.actions.canSkip ? <button type="button" className="voice-card-button" data-variant="ghost" aria-label="Skip voice playback" title="Skip"
            disabled={state.pending} onClick={() => act(() => store.plugin.skipCurrentPlayback(store.commandContext()))}><SkipForward strokeWidth={1.8} aria-hidden="true" /></button> : null}
          {native.actions.canStop ? <button type="button" className="voice-card-button" aria-label={cancels ? "Cancel voice recording" : "Stop voice interaction"}
            title={cancels ? "Cancel" : "Stop"} disabled={state.pending} onClick={() => act(() => store.plugin.stopCurrentInteraction(store.commandContext()))}>
            <span className="voice-card-stop" aria-hidden="true" /></button> : null}
        </div>
        {/* The body's name is its action; the status region describes it and announces phase changes, and the alert carries the error once. */}
        <span id={statusId} className="sr-only" role="status" aria-live={quiet ? "off" : undefined}>
          {[line1, line2].map(line => lineText(line, alerting).replace(/\.$/u, "")).filter(Boolean).join(". ")}</span>
        {alerting ? <span id={`${statusId}-alert`} className="sr-only" role="alert">{message}</span> : null}
      </div>
    </div> : null}
    <VoiceThreadPicker threads={threads} open={picker !== null} onOpenChange={open => { if (!open) setPicker(null); }} pinned={{ threadId, label: "This thread" }} onSelect={thread => {
      const target = { threadId: thread.id, threadTitle: nativeThreadTitle(thread.title.text) ?? undefined };
      act(() => picker === "retarget" ? store.plugin.retargetActiveRecognition({ ...store.commandContext(), ...target })
        : store.plugin.startManualListen({ ...store.commandContext(), ...target }));
    }} />
    {/* Beside the card, so choosing Off in the sheet keeps it open even when Off hides the card. */}
    <VoiceQuickSheet store={store} open={sheet} onOpenChange={setSheet} />
  </>;
}
function renderLine(line: Line, className: string, chip: (part: { chip: string; glyph?: boolean }) => ReactNode): ReactNode {
  if ("thread" in line) return <span className={className} data-thread><MessageSquare strokeWidth={1.8} aria-hidden="true" /><span>{line.thread}</span></span>;
  if ("empty" in line) return <span className={className} data-empty>{line.empty}</span>;
  const chipped = line.parts.some(part => typeof part !== "string" && "chip" in part);
  // The chip keeps one key, so retargeting between this thread and another keeps the focused button.
  return line.parts.length ? <span className={className} data-chip={chipped ? "" : undefined}>{line.parts.map((part, index) =>
    <Fragment key={typeof part !== "string" && "chip" in part ? "chip" : index}>
      {index ? <span className="voice-card-dot" aria-hidden="true">·</span> : null}
      {typeof part === "string" ? part : "chip" in part ? chip(part) : "phase" in part || part.tone
        ? <span className="voice-card-phase" data-tone={part.tone}>{"phase" in part ? part.phase : part.alert}</span> : part.alert}</Fragment>)}</span> : null;
}
/** Plain text for the status region; the alert region already carries an alert part. */
function lineText(line: Line, alerting: boolean): string {
  return "thread" in line ? line.thread : "empty" in line ? line.empty
    : line.parts.flatMap(part => typeof part === "string" ? [part] : "chip" in part ? [part.chip] : "phase" in part ? [part.phase] : alerting ? [] : [part.alert]).join(" · ");
}
/** The card is not Settings → Voice, so its resume hint points at the card's own Resume. */
function cardReadiness(readiness: string): string {
  return readiness === "needsResume" ? "Voice needs to resume" : voiceReadiness(readiness);
}
/** Native `active.eventKind` values that speak; explicit recording ("manual") and unknown kinds get no label. */
const eventLabels = new Map([["turn.completed", "Response"], ["turn.progress", "Progress"], ["turn.failed", "Turn failed"], ["turn.interrupted", "Interrupted"],
  ["thread.woke", "Snooze wake"], ["automation.started", "Automation"], ["automation.failed", "Automation"], ["approval.requested", "Approval"],
  ["input.requested", "Input request"], ["question.requested", "Question"]]);
function phaseLabel(phase: string): string {
  return ({ starting: "Starting…", synthesizing: "Preparing speech…", speaking: "Speaking", validating: "Checking thread…", arming: "Preparing microphone…", listening: "Listening", recognizing: "Recognizing…", submitting: "Sending…", cancelling: "Stopping…", recovering: "Checking submission…", error: "Needs attention" } as Record<string, string>)[phase] ?? phase;
}
