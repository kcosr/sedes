import { useEffect, useId, useState } from "react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
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
  return ({ interrupted: "Recognition incomplete", recognizing: "Recognizing saved audio…", ready: "Not sent",
    admitting: saved.admission?.status === "reconciling" ? "Checking delivery…" : "Sending…", rejected: "Could not send",
    overflow: "Too long to send", unavailable: "Saved dictation unavailable" })[saved.stage];
}
export function recordingRecoveryContext(native: NativeVoiceState, saved: NativeRecordingRecovery): NativeRecordingRecoveryCommandContext {
  return { expectedConnectionGeneration: native.connectionGeneration, recordingId: saved.recordingId, expectedRecoveryRevision: saved.revision };
}
const actionClass = "min-h-(--control-touch) aria-disabled:cursor-not-allowed aria-disabled:opacity-(--disabled-opacity)";

/** Recovery belongs in the existing voice sheet/settings, without moving text into the composer. */
export function VoiceRecordingRecovery({ store, threads }: { store: NativeVoiceStore; threads: readonly NormalizedApplicationThreadSummary[] }): React.JSX.Element | null {
  const state = useVoiceState(store);
  const native = state.native;
  const saved = native ? savedRecording(native) : null;
  const id = useId();
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { setCopied(false); setAcknowledged(false); }, [native?.connectionGeneration, saved?.recordingId, saved?.revision]);
  if (!native || !saved) return null;
  const context = recordingRecoveryContext(native, saved);
  const run = (enabled: boolean, action: () => Promise<NativeVoiceState>) => {
    if (state.pending || !enabled) return;
    setCopied(false);
    void store.run(action).catch(() => undefined);
  };
  const offersSend = !saved.hasUnrecognizedAudio && !["rejected", "overflow", "unavailable"].includes(saved.stage);
  const canSend = saved.canSend && (!saved.captureIncomplete || acknowledged);
  return <section className="voice-recording-recovery grid gap-3" aria-labelledby={`${id}-title`}>
    <div className="min-w-0">
      <h3 id={`${id}-title`} className="break-words font-medium">{recordingRecoveryLabel(saved)} · {recordingRecoveryTitle(saved, threads)}</h3>
      <p className="text-sm text-muted-foreground" role="status">{recordingRecoveryStatus(saved)}</p>
    </div>
    {saved.reason ? <p className="text-sm">{saved.reason}</p> : null}
    {saved.captureIncomplete ? <p id={`${id}-incomplete`} className="text-sm text-warning">The end of this dictation may be missing. Sending uses the saved portion.</p> : null}
    {saved.hasUnrecognizedAudio ? <p className="text-sm text-muted-foreground">Retry finishes recognizing saved audio. It does not reopen the microphone or send a message.</p> : null}
    {saved.admission && saved.admission.status !== "rejected" ? <p className="text-sm text-muted-foreground">This dictation may have reached Sedes. Send checks delivery before retrying the same message. Discard cannot withdraw a message already received.</p> : null}
    {saved.stage === "overflow" ? <p className="text-sm text-muted-foreground">Copy the recognized text before discarding if you want to keep it.</p> : null}
    {saved.captureIncomplete && offersSend ? <label className="flex min-h-(--control-touch) items-center gap-2 text-sm">
      <Checkbox checked={acknowledged} aria-disabled={state.pending || undefined} aria-describedby={`${id}-incomplete`}
        onCheckedChange={value => { if (!state.pending) setAcknowledged(value === true); }} />
      <span>Send the saved portion even if the end is missing</span>
    </label> : null}
    <div className="flex flex-wrap gap-2">
      {saved.hasUnrecognizedAudio || saved.canRetryRecognition ? <Button variant="outline" className={actionClass} aria-disabled={state.pending || !saved.canRetryRecognition || undefined}
        onClick={() => run(saved.canRetryRecognition, () => store.plugin.retryRecordingRecognition(context))}>Retry recognition</Button> : null}
      {saved.canCopyRecognizedText ? <Button variant="outline" className={actionClass} aria-disabled={state.pending || undefined} onClick={() => {
        if (state.pending) return;
        setCopied(false);
        void store.run(() => store.plugin.copyRecognizedRecordingText(context)).then(() => {
          const current = store.getSnapshot().native;
          if (current?.connectionGeneration === context.expectedConnectionGeneration &&
              current.recordingRecovery?.recordingId === context.recordingId && current.recordingRecovery.revision === context.expectedRecoveryRevision)
            setCopied(true);
        }).catch(() => undefined);
      }}>Copy recognized text</Button> : null}
      <Button variant="outline" className={actionClass} aria-disabled={state.pending || !saved.canDiscard || undefined}
        onClick={() => run(saved.canDiscard, () => store.plugin.discardRecording(context))}>Discard saved dictation</Button>
      {offersSend ? <Button className={actionClass} aria-disabled={state.pending || !canSend || undefined}
        aria-describedby={saved.captureIncomplete ? `${id}-incomplete` : undefined}
        onClick={() => run(canSend, () => store.plugin.sendRecoveredRecording({ ...context, acknowledgeIncomplete: saved.captureIncomplete && acknowledged }))}>Send saved dictation</Button> : null}
    </div>
    {copied ? <p className="text-sm text-muted-foreground" role="status">Recognized text copied. The saved dictation remains on this device.</p> : null}
  </section>;
}
