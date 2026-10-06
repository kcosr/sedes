import { useEffect, useId, useState } from "react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { Button } from "../components/ui/button.js";
import { useVoiceState } from "./VoiceProvider.js";
import type { NativeVoiceStore } from "./NativeVoiceStore.js";
import type { NativeRecordingRecovery, NativeRecordingRecoveryCommandContext, NativeVoiceState } from "./native-voice-plugin.js";

/** A saved item is independent of current work; the live recording itself has no recovery controls. */
export function savedRecording(native: NativeVoiceState): NativeRecordingRecovery | null {
  const saved = native.recordingRecovery;
  return saved && native.active?.recording?.id === saved.recordingId &&
    ["validating", "arming", "listening"].includes(native.phase) ? null : saved;
}
export function recordingRecoveryTitle(saved: NativeRecordingRecovery, threads: readonly NormalizedApplicationThreadSummary[]): string {
  return saved.threadTitle?.trim() || threads.find(thread => thread.id === saved.threadId)?.title.text.trim() || (saved.threadId ? "Untitled thread" : "Unknown thread");
}
export function recordingRecoveryLabel(saved: NativeRecordingRecovery): string {
  return saved.stage === "ready" && !saved.hasUnrecognizedAudio ? "Ready to send" : "Saved dictation";
}
export function recordingRecoveryStatus(saved: NativeRecordingRecovery): string {
  if (saved.admission?.cancelled) return "Stopped; checking delivery";
  if (saved.admission?.status === "uncertain") return "Delivery uncertain";
  if (saved.admission?.status === "prepared") return "Waiting to send";
  if (saved.stage === "ready" && saved.captureIncomplete) return "Recording interrupted";
  return ({ interrupted: "Needs transcription", recognizing: "Transcribing…", ready: "Not sent",
    admitting: saved.admission?.status === "reconciling" ? "Checking delivery…" : "Sending…", rejected: "Could not send",
    overflow: "Too long to send", unavailable: "Saved dictation unavailable" })[saved.stage];
}
export function recordingRecoveryContext(native: NativeVoiceState, saved: NativeRecordingRecovery): NativeRecordingRecoveryCommandContext {
  return { expectedConnectionGeneration: native.connectionGeneration, recordingId: saved.recordingId, expectedRecoveryRevision: saved.revision };
}
const actionClass = "min-h-(--control-touch) min-w-0 px-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-(--disabled-opacity)";

/** Recovery stays available after copying text, including an explicit copy into the original thread's composer. */
export function VoiceRecordingRecovery({ store, threads, onAddedToComposer }: {
  store: NativeVoiceStore; threads: readonly NormalizedApplicationThreadSummary[]; onAddedToComposer?: () => void;
}): React.JSX.Element | null {
  const state = useVoiceState(store);
  const native = state.native;
  const saved = native ? savedRecording(native) : null;
  const id = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [native?.connectionGeneration, saved?.recordingId, saved?.revision]);
  if (!native || !saved) return null;
  const context = recordingRecoveryContext(native, saved);
  const run = (enabled: boolean, action: () => Promise<NativeVoiceState>) => {
    if (state.pending || !enabled) return;
    setCopied(false);
    void store.run(action).catch(() => undefined);
  };
  const offersSend = !saved.hasUnrecognizedAudio && !["rejected", "overflow", "unavailable"].includes(saved.stage);
  const added = state.addedRecording?.recordingId === saved.recordingId && state.addedRecording.expectedRecoveryRevision === saved.revision &&
    state.addedRecording.expectedConnectionGeneration === native.connectionGeneration;
  const target = threads.find(thread => thread.id === saved.threadId);
  const addUnavailableReason = saved.threadId === null ? "Original thread unknown."
    : saved.hasUnrecognizedAudio ? "Finish transcription to add to the composer."
      : target?.inventoryState === "archived" ? "Unarchive the original thread to add text."
        : target && !target.available ? "Original thread unavailable." : null;
  const canAdd = saved.canCopyRecognizedText && !addUnavailableReason && !added;
  const status = recordingRecoveryStatus(saved);
  const reason = saved.reason?.replace(/\.$/, "") === status ? null : saved.reason;
  return <section className="voice-recording-recovery grid gap-3 border-y py-3" aria-labelledby={`${id}-title`}>
    <div className="min-w-0">
      <h3 id={`${id}-title`} className="font-medium">Saved dictation</h3>
      <p className="line-clamp-2 break-words text-sm text-muted-foreground">{recordingRecoveryTitle(saved, threads)}</p>
    </div>
    <div className="grid gap-1 text-sm">
      <p role="status" className={saved.captureIncomplete ? "text-warning" : "text-muted-foreground"}>{status}</p>
      {reason ? <p className="text-muted-foreground">{reason}</p> : null}
      {saved.admission && saved.admission.status !== "rejected" ? <p className="text-muted-foreground">Send checks delivery. Discard only removes this saved copy.</p> : null}
    </div>
    {saved.canCopyRecognizedText ? <div className="grid gap-1">
      <Button variant="outline" className={actionClass} aria-disabled={state.pending || !canAdd || undefined}
      aria-describedby={!added && addUnavailableReason ? `${id}-add-reason` : undefined}
      onClick={() => {
        if (state.pending || !canAdd) return;
        void store.addRecordingToComposer(context).then(onAddedToComposer).catch(() => undefined);
      }}>{added ? "Added to composer" : "Add to composer"}</Button>
      {!added && addUnavailableReason ? <p id={`${id}-add-reason`} className="text-sm text-muted-foreground">{addUnavailableReason}</p> : null}
    </div> : null}
    <div className="grid grid-flow-col auto-cols-fr gap-2">
      {saved.canCopyRecognizedText ? <Button variant="outline" className={actionClass} aria-disabled={state.pending || undefined} onClick={() => {
        if (state.pending) return;
        setCopied(false);
        void store.run(() => store.plugin.copyRecognizedRecordingText(context)).then(() => {
          const current = store.getSnapshot().native;
          if (current?.connectionGeneration === context.expectedConnectionGeneration &&
              current.recordingRecovery?.recordingId === context.recordingId && current.recordingRecovery.revision === context.expectedRecoveryRevision)
            setCopied(true);
        }).catch(() => undefined);
      }}>Copy text</Button> : null}
      <Button variant="outline" className={actionClass} aria-disabled={state.pending || !saved.canDiscard || undefined}
        onClick={() => run(saved.canDiscard, () => store.plugin.discardRecording(context))}>Discard</Button>
      {saved.hasUnrecognizedAudio || saved.canRetryRecognition ? <Button variant="outline" className={actionClass} aria-label="Retry recognition" aria-disabled={state.pending || !saved.canRetryRecognition || undefined}
        onClick={() => run(saved.canRetryRecognition, () => store.plugin.retryRecordingRecognition(context))}>Retry</Button> : null}
      {offersSend ? <Button className={actionClass} aria-disabled={state.pending || !saved.canSend || undefined}
        onClick={() => run(saved.canSend, () => store.plugin.sendRecoveredRecording(context))}>Send</Button> : null}
    </div>
    {copied ? <p className="text-sm text-muted-foreground" role="status">Copied.</p> : null}
  </section>;
}
