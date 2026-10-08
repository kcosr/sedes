import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUp, AudioLines, ChevronDown, Infinity as InfinityIcon, LoaderCircle, Mic, MicOff, RotateCcw, Settings2, SkipForward, TriangleAlert, X } from "lucide-react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { navigate, settingsPath, useRoute } from "../app/router.js";
import { configuredPanelPresentation, openThreadRoute } from "../workspace-panels/thread-panel-navigation.js";
import { useComposerDeliveryMode } from "../app/composer-delivery-mode.js";
import { useNativeVoice, useVoiceState } from "./VoiceProvider.js";
import type { NativeVoiceStore } from "./NativeVoiceStore.js";
import { VoiceQuickSheet } from "./VoiceQuickSheet.js";
import { VoiceThreadPicker } from "./VoiceThreadPicker.js";
import { voiceReadiness } from "./VoiceSettingsPage.js";
import { useShowVoiceBarWhenOff } from "./voice-bar-preference.js";
import { resumeVoice, voiceThreadFilterWarning } from "./voice-session.js";
import { nativeThreadTitle, type NativeRecordingCommandContext, type NativeVoiceState } from "./native-voice-plugin.js";
import { recordingRecoveryContext, recordingRecoveryLabel, recordingRecoveryStatus, recordingRecoveryTitle, savedRecording } from "./VoiceRecordingRecovery.js";
import { voiceRecordingTarget } from "./voice-recording-target.js";
import "./voice.css";

/** Card text: parts joined by dots, a named thread, or a muted placeholder. */
type Tone = "info" | "destructive" | "warning";
type Part = string | { phase: string; tone?: Tone } | { alert: string; tone?: Tone } | { optional: string } | { reconnecting: true };
type Line = { parts: Part[] } | { thread: string; reconnecting?: boolean } | { empty: string } | { saved: { label: string; thread: string } };

export function VoiceControls({ threads }: { threads: readonly NormalizedApplicationThreadSummary[] }) {
  const store = useNativeVoice();
  return store ? <NativeVoiceControls store={store} threads={threads} /> : null;
}
function NativeVoiceControls({ store, threads }: { store: NativeVoiceStore; threads: readonly NormalizedApplicationThreadSummary[] }) {
  const state = useVoiceState(store);
  const route = useRoute();
  const composerMode = useComposerDeliveryMode();
  const [showWhenOff] = useShowVoiceBarWhenOff();
  const [picker, setPicker] = useState<"start" | "retarget" | "next" | null>(null);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const pickerRecording = useRef<NativeRecordingCommandContext | null>(null);
  const pickerGeneration = useRef<number | null>(null);
  const [sheet, setSheet] = useState(false);
  const statusId = useId();
  const threadId = route.name === "thread" ? route.threadId : null;
  const threadTitle = nativeThreadTitle(threads.find(thread => thread.id === threadId)?.title.text ?? "");
  // Native visibility reconciliation can clear the foreground without a document visibility event.
  // A successful settings write (including Resume) or session readiness change re-sends the current context.
  // Foreground replies change neither dependency, so a paused Activity rejecting visible=true cannot loop.
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
  }, [store, threadId, threadTitle, composerMode, state.native?.connectionGeneration, state.native?.settingsRevision, state.native?.readiness]);
  const native = state.native;
  // A lost connection closes the sheet and picker, so neither reopens by itself when voice reconnects.
  if (!native && (sheet || picker)) { setSheet(false); setPicker(null); }
  // Unavailable voice is reported and retried in Settings → Voice; the card appears only for a connected session.
  if (!native) return null;
  const { phase, active, settings } = native;
  const saved = savedRecording(native);
  const showingRecovery = saved !== null && (active === null || saved.recordingId === active.recording?.id);
  const savedElsewhere = saved !== null && !showingRecovery && saved.recordingId !== active?.recording?.id;
  const act = (action: () => ReturnType<typeof store.plugin.getState>) => { void store.run(action).catch(() => undefined); };
  // A chosen next target survives navigation; the saved preference supplies only the initial target.
  const startTarget = voiceRecordingTarget(threads, native, threadId);
  const start = () => {
    // Native decides when explicit recording can start; it does not need the notification stream that `ready` includes.
    if (!native.actions.canStart) { navigate(settingsPath("voice")); return; }
    if (!startTarget) { pickerGeneration.current = native.connectionGeneration; setPicker("start"); return; }
    act(() => store.plugin.startManualListen({ ...store.commandContext(), threadId: startTarget.id, threadTitle: nativeThreadTitle(startTarget.title.text) ?? undefined }));
  };
  const off = settings.audioMode === "off";
  const filterWarning = voiceThreadFilterWarning(settings);
  const startLabel = settings.keepListeningByDefault ? "Start recording with Keep listening" : "Start voice recording";
  const busy = !["off", "idle"].includes(phase);
  const missingRecovery = phase === "recordingRecovery" && saved === null;
  const needsStorageRetry = native.readiness === "storageUnavailable";
  const failed = phase === "error" || missingRecovery;
  const speaking = phase === "synthesizing" || phase === "speaking";
  const recording = phase === "listening";
  const capture = active?.recording;
  const recordingTools = recording && capture != null;
  const retargets = !off && native.actions.canRetarget && capture != null;
  // Voice is on without a session (Android stopped or refused the service): only a user-initiated mode write resumes it.
  const resumable = !off && native.actions.canResume;
  // Native Stop discards a recording that has not been sent yet.
  const cancels = ["validating", "arming", "listening", "recognizing"].includes(phase);
  const showingInput = ["validating", "arming", "listening", "recognizing", "submitting", "recovering"].includes(phase);
  const inputActions = showingInput && active !== null && !showingRecovery;
  const [targetId, targetTitle] = showingInput ? [active?.recognitionThreadId, active?.recognitionThreadTitle]
    : [active?.threadId ?? active?.recognitionThreadId, active?.threadTitle ?? active?.recognitionThreadTitle];
  const activeTitle = targetTitle ?? (targetId ? threads.find(thread => thread.id === targetId)?.title.text.trim() || "Untitled thread" : undefined);
  // A failure stays until the next action, a reconnect or progress; the error phase falls back to native's latest report.
  const latest = native.errors.at(-1);
  const message = state.error ?? (failed ? latest?.message ?? (missingRecovery && !needsStorageRetry ? "Voice storage needs attention. Open voice settings to retry." : cardReadiness(native.readiness)) : undefined);
  const kind = speaking && active?.eventKind ? eventLabels.get(active.eventKind) : undefined;
  const phaseWord: Part = state.error && !recording ? { alert: state.error, tone: "warning" }
    : { phase: phaseLabel(phase), tone: recording ? "destructive" : phase === "speaking" ? "info" : undefined };
  let tile: ReactNode, tone: string | undefined, line1: Line, line2: Line;
  const errorLook = (!off || needsStorageRetry) && (failed || (!busy && message !== undefined));
  // The card's thread: the idle start target, the spoken notice's thread, or the recording target; Off and an error have none.
  const [cardThread, cardTitle] = showingRecovery ? [saved.threadId, recordingRecoveryTitle(saved, threads)]
    : off || errorLook ? [] : busy ? [targetId ?? undefined, activeTitle] : [startTarget?.id, startTarget && (startTarget.title.text.trim() || "Untitled thread")];
  if (showingRecovery) {
    const working = saved.stage === "recognizing" || saved.stage === "admitting";
    const failureReason = ["interrupted", "rejected", "overflow", "unavailable"].includes(saved.stage) ? saved.reason : null;
    tile = working ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <MicOff strokeWidth={1.8} aria-hidden="true" />;
    tone = saved.stage === "ready" ? undefined : "warning";
    line1 = { saved: { label: recordingRecoveryLabel(saved), thread: cardTitle! } };
    line2 = { parts: [state.error ? { alert: state.error, tone: "warning" } : failureReason ? { alert: failureReason, tone: "warning" }
      : needsStorageRetry || (saved.hasUnrecognizedAudio && !saved.canRetryRecognition && !working && !native.ready)
        ? cardReadiness(native.readiness) : recordingRecoveryStatus(saved)] };
  } else if (off && !needsStorageRetry) { tile = <MicOff strokeWidth={1.8} aria-hidden="true" />; tone = "muted"; line1 = { parts: ["Voice off"] }; line2 = { parts: ["Open controls to turn on"] }; }
  else if (errorLook) {
    tile = <TriangleAlert strokeWidth={1.8} aria-hidden="true" />; tone = "warning";
    // Native's start rejection asks to resume "from the visible app"; on the card that is its own Resume. The alert keeps native's words.
    line1 = latest?.code === "foreground_start_rejected" && message === latest.message ? { parts: [cardReadiness("needsResume")] } : { parts: [{ alert: message ?? phaseLabel("error") }] };
    line2 = { parts: [{ phase: phaseLabel("error"), tone: "warning" }] };
  } else {
    // Line 1 always names the card's thread, the visible one included; line 2 carries the state.
    let status: Part[];
    if (!busy) {
      tile = <AudioLines strokeWidth={1.8} aria-hidden="true" />;
      // Readiness replaces the whole state line: with the mode beside it, it would truncate.
      status = !native.ready ? [cardReadiness(native.readiness)] : filterWarning
        ? [{ alert: "Default thread needed", tone: "warning" }]
        : ["Ready", settings.audioMode === "manual" ? "Manual" : "Response", `Auto-listen ${settings.autoListen ? "on" : "off"}`];
      if (native.ready && filterWarning) tone = "warning";
    } else {
      tile = phase === "speaking" ? <span className="voice-card-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        : recording ? <><Mic strokeWidth={1.8} aria-hidden="true" /><span className="voice-card-rec" aria-hidden="true" /></>
          : <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />;
      tone = phase === "speaking" ? "info" : recording ? "destructive" : undefined;
      const queued = speaking && native.queue.count > 0 ? `${native.queue.count} queued` : undefined;
      // A failed action takes the phase word's place. Beside a thread's phase and queue count, the kind gives way first on a narrow card.
      // Thread-less speech puts the phase on its own line, so its kind stays visible with the queue on line 2.
      status = state.error && !recording ? [phaseWord] : [phaseWord, ...kind ? [queued && cardTitle !== undefined ? { optional: kind } : kind] : [], ...queued ? [queued] : []];
      if (recording && capture?.reconnecting) status.push({ reconnecting: true });
    }
    if (cardTitle !== undefined) { line1 = { thread: cardTitle, reconnecting: recording && capture?.reconnecting }; line2 = { parts: status }; }
    else if (!busy || retargets) { line1 = { empty: "Choose a thread" }; line2 = { parts: status }; }
    // Speech without a thread (an automation notice) leads with its phase.
    else { line1 = { parts: status.slice(0, 1) }; line2 = { parts: status.slice(1) }; }
  }
  // Keep Listening and its controls in place; a failed action temporarily uses
  // the existing title line, with the full message in its tooltip and sheet.
  if (recording && state.error) line1 = { parts: [{ alert: state.error, tone: "warning" }] };
  // Settings → Voice announces readiness and errors itself; there the card's regions stay quiet.
  const quiet = route.name === "settings" && route.page === "voice";
  const alerting = message !== undefined && !quiet;
  const threadDescription = !busy && "thread" in line1 ? line1.thread.replace(/\.$/u, "") : undefined;
  const describedBy = [threadDescription !== undefined ? `${statusId}-thread` : undefined, statusId, alerting ? `${statusId}-alert` : undefined].filter(Boolean).join(" ");
  const targetPicker = retargets ? "retarget" : !off && active === null && !showingRecovery ? "next" : null;
  const targetLabel = targetPicker === "retarget" ? "Change recording thread" : "Choose target thread";
  // An open picker belongs to this connection and this recording or idle interval.
  if (picker && (pickerGeneration.current !== native.connectionGeneration || off ||
      (picker === "retarget" ? !retargets || capture?.id !== pickerRecording.current?.recordingId : active !== null))) setPicker(null);
  const opens = cardThread != null && cardThread !== threadId;
  const keepBlocked = state.pending ? "A voice action is in progress" : keepListeningBlockedReason(native.actions.keepListeningBlockedReason);
  const text = <span className="voice-card-text">
    {renderLine(line1, "voice-card-title")}
    {renderLine(line2, "voice-card-sub")}
  </span>;
  return <>
    {!off || showWhenOff || showingRecovery || needsStorageRetry ? <div className="voice-dock">
      <div className="voice-card" role="group" aria-label="Voice controls" data-tone={recording ? "destructive" : undefined}
        data-off={off && !showingRecovery ? "" : undefined} data-input-actions={inputActions ? "" : undefined} data-saved={showingRecovery ? "" : undefined}>
        <button type="button" className="voice-card-tile" data-tone={tone} aria-haspopup="dialog" aria-describedby={describedBy}
          aria-label={savedElsewhere ? "Saved dictation" : "Open voice controls"} title={savedElsewhere ? "Saved dictation" : "Open voice controls"}
          data-saved-access={savedElsewhere ? "" : undefined} onClick={() => setSheet(true)}>{tile}<ChevronDown className="voice-card-menu-mark" aria-hidden="true" />
          {savedElsewhere ? <span className="voice-card-saved-indicator" aria-hidden="true" /> : null}</button>
        <div className="voice-card-body">
          {opens ? <button type="button" className="voice-card-open" aria-label={`Open thread: ${cardTitle ?? "Untitled thread"}`} onClick={() => openThreadRoute(cardThread, configuredPanelPresentation())} /> : null}
          {text}
        </div>
        {targetPicker ? <button ref={pickerAnchor} type="button" className="voice-card-target" aria-haspopup="dialog" aria-expanded={picker !== null}
          aria-label={cardTitle ? `${targetLabel}: ${cardTitle}` : targetLabel} aria-disabled={state.pending || undefined} onClick={() => {
            if (state.pending) return;
            pickerGeneration.current = native.connectionGeneration;
            pickerRecording.current = targetPicker === "retarget" && capture
              ? { expectedConnectionGeneration: native.connectionGeneration, recordingId: capture.id } : null;
            setPicker(current => current === targetPicker ? null : targetPicker);
          }}><ChevronDown aria-hidden="true" /></button> : null}
        {recordingTools ? <button type="button" className="voice-card-keep" aria-label="Keep listening" title={keepBlocked ?? "Keep listening"}
          aria-pressed={capture.keepListening} aria-disabled={state.pending || !native.actions.canSetKeepListening || undefined}
          aria-describedby={keepBlocked ? `${statusId}-keep-blocked` : undefined} onClick={() => {
            if (state.pending || !native.actions.canSetKeepListening) return;
            const command = { expectedConnectionGeneration: native.connectionGeneration, recordingId: capture.id, enabled: !capture.keepListening };
            act(() => store.plugin.setKeepListening(command));
          }}><InfinityIcon strokeWidth={1.8} aria-hidden="true" /></button> : null}
        {showingRecovery ? (saved.hasUnrecognizedAudio || saved.canRetryRecognition) ? resumable ? <button type="button" className="voice-card-retry" aria-label="Resume voice" title="Resume voice" aria-disabled={state.pending || undefined}
          onClick={() => { if (!state.pending) void resumeVoice(store).catch(() => undefined); }}><RotateCcw aria-hidden="true" /><span>Resume</span></button>
          : <button type="button" className="voice-card-retry" aria-label="Retry saved dictation" title={!saved.canRetryRecognition ? cardReadiness(native.readiness) : "Retry recognition"}
          aria-disabled={state.pending || !saved.canRetryRecognition || undefined} onClick={() => {
            if (state.pending || !saved.canRetryRecognition) return;
            const command = recordingRecoveryContext(native, saved);
            act(() => store.plugin.retryRecordingRecognition(command));
          }}><RotateCcw aria-hidden="true" /><span>Retry</span></button>
          : <span className="voice-card-retry voice-card-retry-placeholder" aria-hidden="true"><RotateCcw /><span>Retry</span></span> : null}
        <div className="voice-card-actions">
          {showingRecovery ? <>
            <button type="button" className="voice-card-button" data-variant="ghost" aria-label="Discard saved dictation" title="Discard"
              aria-disabled={state.pending || !saved.canDiscard || undefined} onClick={() => {
                if (state.pending || !saved.canDiscard) return;
                const command = recordingRecoveryContext(native, saved);
                act(() => store.plugin.discardRecording(command));
              }}><X strokeWidth={1.8} aria-hidden="true" /></button>
            {saved.stage === "ready" && !saved.hasUnrecognizedAudio ? <button type="button" className="voice-card-button" aria-label="Send saved dictation" title="Send"
              aria-disabled={state.pending || !saved.canSend || undefined} onClick={() => {
                if (state.pending || !saved.canSend) return;
                const command = recordingRecoveryContext(native, saved);
                act(() => store.plugin.sendRecoveredRecording(command));
              }}><ArrowUp strokeWidth={1.8} aria-hidden="true" /></button>
              : <span className="voice-card-send-slot" aria-hidden="true" />}
          </> : <>
          {needsStorageRetry ? <button type="button" className="voice-card-retry" aria-label="Retry voice connection" aria-disabled={state.pending || undefined}
            onClick={() => { if (!state.pending) void store.reconnect().catch(() => undefined); }}><RotateCcw aria-hidden="true" /><span>Retry</span></button>
            : missingRecovery ? <button type="button" className="voice-card-button" aria-label="Open voice settings" onClick={() => navigate(settingsPath("voice"))}><Settings2 aria-hidden="true" /></button>
            : resumable ? <button type="button" className="voice-card-retry" aria-label="Resume voice" disabled={state.pending}
            onClick={() => { void resumeVoice(store).catch(() => undefined); }}><RotateCcw aria-hidden="true" /><span>Resume</span></button>
            : !busy || failed ? <button type="button" className="voice-card-button" aria-label={startLabel} disabled={off || state.pending} onClick={start}
              title={off ? "Voice is off" : native.actions.canStart ? startLabel : cardReadiness(native.readiness)}>
              {settings.keepListeningByDefault ? <InfinityIcon strokeWidth={1.8} aria-hidden="true" /> : <Mic strokeWidth={1.8} aria-hidden="true" />}</button> : null}
          {native.actions.canSkip ? <button type="button" className="voice-card-button" data-variant="ghost" aria-label="Skip voice playback" title="Skip"
            disabled={state.pending} onClick={() => act(() => store.plugin.skipCurrentPlayback(store.commandContext()))}><SkipForward strokeWidth={1.8} aria-hidden="true" /></button> : null}
          {native.actions.canStop && active ? <button type="button" className="voice-card-button" aria-label={cancels ? "Cancel voice recording" : "Stop voice interaction"}
            title={cancels ? "Cancel" : "Stop"} onClick={() => {
              void store.stopInteraction({ expectedConnectionGeneration: native.connectionGeneration, interactionId: active.id }).catch(() => undefined);
            }}>{cancels ? <X strokeWidth={1.8} aria-hidden="true" /> : <span className="voice-card-stop" aria-hidden="true" />}</button> : null}
          {inputActions ? recordingTools && capture.keepListening ? <button type="button" className="voice-card-button" aria-label="Send voice recording" title="Send"
            disabled={state.pending || !native.actions.canSend} onClick={() => {
              const command = { expectedConnectionGeneration: native.connectionGeneration, recordingId: capture.id };
              act(() => store.plugin.sendRecording(command));
            }}><ArrowUp strokeWidth={1.8} aria-hidden="true" /></button>
            : <span className="voice-card-send-slot" aria-hidden="true" /> : null}
          </>}
        </div>
        {/* Idle navigation stays quiet; active target changes remain live so retargeting is confirmed. */}
        {threadDescription !== undefined ? <span id={`${statusId}-thread`} className="sr-only">{threadDescription}.</span> : null}
        <span id={statusId} className="sr-only" role="status" aria-live={quiet ? "off" : undefined}>
          {[line1, line2].filter(line => busy || !("thread" in line)).map(line => lineText(line, alerting).replace(/\.$/u, "")).filter(Boolean).join(". ")}</span>
        {alerting ? <span id={`${statusId}-alert`} className="sr-only" role="alert">{message}</span> : null}
        {recordingTools && keepBlocked ? <span id={`${statusId}-keep-blocked`} className="sr-only">{keepBlocked}</span> : null}
      </div>
    </div> : null}
    <VoiceThreadPicker threads={threads} open={picker !== null} onOpenChange={open => { if (!open) setPicker(null); }}
      presentation="popover" anchorRef={pickerAnchor} title="Choose target thread"
      selectedThreadId={picker === "retarget" ? targetId : startTarget?.id}
      description={picker === "start" ? "Choose a thread and start recording." : "Recognized text will be sent to the thread you select."}
      pinned={{ threadId, label: "This thread" }} onSelect={thread => {
        const target = { threadId: thread.id, threadTitle: nativeThreadTitle(thread.title.text) ?? undefined };
        const expectedConnectionGeneration = pickerGeneration.current;
        if (expectedConnectionGeneration === null) return;
        if (picker === "retarget") {
          const context = pickerRecording.current;
          if (context) act(() => store.plugin.retargetActiveRecognition({ ...context, ...target }));
        } else if (picker === "next") {
          act(() => store.plugin.setNextRecordingTarget({ expectedConnectionGeneration, ...target }));
        } else if (picker === "start") {
          act(() => store.plugin.startManualListen({ expectedConnectionGeneration, ...target }));
        }
      }} />
    {/* Beside the card, so choosing Off in the sheet keeps it open even when Off hides the card. */}
    <VoiceQuickSheet store={store} threads={threads} open={sheet} onOpenChange={setSheet} />
  </>;
}
function renderLine(line: Line, className: string): ReactNode {
  if ("saved" in line) return <span className={className} data-saved><span className="voice-card-saved-label">{line.saved.label}</span>
    <span className="voice-card-dot" aria-hidden="true">·</span><span className="voice-card-saved-thread">{line.saved.thread}</span></span>;
  if ("thread" in line) return <span className={className} data-thread title={line.reconnecting ? `${line.thread} · Reconnecting` : line.thread}>
    {line.reconnecting ? <LoaderCircle className="voice-card-title-reconnecting motion-safe:animate-spin" aria-hidden="true" /> : null}<span>{line.thread}</span></span>;
  if ("empty" in line) return <span className={className} data-empty>{line.empty}</span>;
  const explanation = line.parts.find((part): part is Extract<Part, { alert: string }> => typeof part !== "string" && "alert" in part)?.alert;
  const dot = <span className="voice-card-dot" aria-hidden="true">·</span>;
  return line.parts.length ? <span className={className} title={explanation}>{line.parts.map((part, index) =>
    <Fragment key={index}>
      {typeof part !== "string" && "optional" in part ? <span className="voice-card-optional">{index ? dot : null}{part.optional}</span> : <>
        {index ? dot : null}
        {typeof part === "string" ? part : "reconnecting" in part ? <span className="voice-card-reconnecting"><LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />Reconnecting</span> : "phase" in part || part.tone
          ? <span className="voice-card-phase" data-tone={part.tone}>{"phase" in part ? part.phase : part.alert}</span> : part.alert}</>}</Fragment>)}</span> : null;
}
/** Plain text for the status region; the alert region already carries an alert part. */
function lineText(line: Line, alerting: boolean): string {
  return "thread" in line ? line.thread : "empty" in line ? line.empty : "saved" in line ? `${line.saved.label} · ${line.saved.thread}`
    : line.parts.flatMap(part => typeof part === "string" ? [part] : "reconnecting" in part ? ["Reconnecting"] : "optional" in part ? [part.optional] : "phase" in part ? [part.phase]
      : alerting ? [] : [part.alert]).join(" · ");
}
/** The card is not Settings → Voice, so its resume hint points at the card's own Resume. */
function cardReadiness(readiness: string): string {
  return readiness === "needsResume" ? "Voice needs to resume" : voiceReadiness(readiness);
}
/** Native `active.eventKind` values that speak; explicit recording ("manual") and unknown kinds get no label. */
const eventLabels = new Map([["turn.completed", "Response"], ["turn.progress", "Progress"], ["turn.failed", "Turn failed"], ["turn.interrupted", "Interrupted"],
  ["thread.woke", "Snooze wake"], ["automation.started", "Automation"], ["automation.failed", "Automation"], ["approval.requested", "Approval"],
  ["input.requested", "Input request"], ["question.requested", "Question"], ["replay", "Replay"]]);
function phaseLabel(phase: string): string {
  return ({ starting: "Starting…", synthesizing: "Preparing speech…", speaking: "Speaking", validating: "Checking thread…", arming: "Preparing microphone…", listening: "Listening", recognizing: "Recognizing…", submitting: "Sending…", cancelling: "Stopping…", recovering: "Checking submission…", recordingRecovery: "Needs attention", error: "Needs attention" } as Record<string, string>)[phase] ?? phase;
}
function keepListeningBlockedReason(reason: NativeVoiceState["actions"]["keepListeningBlockedReason"]): string | undefined {
  if (reason === null) return undefined;
  return ({ not_capturing: "Keep listening is available while recording", operation_pending: "A voice action is in progress",
    saved_recording_pending: "Resolve saved dictation first", configuration_unavailable: "Speech configuration is unavailable",
    storage_unavailable: "Device storage is unavailable" })[reason];
}
