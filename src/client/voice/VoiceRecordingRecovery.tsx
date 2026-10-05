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
  return saved.threadTitle?.trim() || threads.find(thread => thread.id === saved.threadId)?.title.text.trim() || "Untitled thread";
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

/** Recovery belongs in the existing voice sheet/settings, without moving text into the composer. */
export function VoiceRecordingRecovery({ store, threads }: { store: NativeVoiceStore; threads: readonly NormalizedApplicationThreadSummary[] }): React.JSX.Element | null {
  const state = useVoiceState(store);
  const native = state.native;
  const saved = native ? savedRecording(native) : null;
  const id = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [native?.connectionGeneration, saved?.recordingId, saved?.revision]);
  if (!native || !saved) return null;
  const context = recordingRecoveryContext(native, saved);
  const run = (action: () => Promise<NativeVoiceState>) => {
    setCopied(false);
    void store.run(action).catch(() => undefined);
  };
  return <section className="voice-recording-recovery grid gap-3" aria-labelledby={`${id}-title`}>
    <div className="min-w-0">
      <h3 id={`${id}-title`} className="font-medium">{recordingRecoveryLabel(saved)} · {recordingRecoveryTitle(saved, threads)}</h3>
      <p className="text-sm text-muted-foreground" role="status">{recordingRecoveryStatus(saved)}</p>
    </div>
    {saved.reason ? <p className="text-sm">{saved.reason}</p> : null}
    {saved.captureIncomplete ? <p className="text-sm text-warning">The end of this dictation may be missing. Sending uses the saved portion.</p> : null}
    {saved.hasUnrecognizedAudio ? <p className="text-sm text-muted-foreground">Retry finishes recognizing saved audio. It does not reopen the microphone or send a message.</p> : null}
    {saved.admission && saved.admission.status !== "rejected" ? <p className="text-sm text-muted-foreground">This dictation may have reached Sedes. Send checks delivery before retrying the same message. Discard cannot withdraw a message already received.</p> : null}
    {saved.stage === "overflow" ? <p className="text-sm text-muted-foreground">Copy the recognized text before discarding if you want to keep it.</p> : null}
    <div className="flex flex-wrap gap-2">
      {saved.hasUnrecognizedAudio || saved.canRetryRecognition ? <Button variant="outline" disabled={state.pending || !saved.canRetryRecognition}
        onClick={() => run(() => store.plugin.retryRecordingRecognition(context))}>Retry recognition</Button> : null}
      {saved.canCopyRecognizedText ? <Button variant="outline" disabled={state.pending} onClick={() => {
        setCopied(false);
        void store.run(() => store.plugin.copyRecognizedRecordingText(context)).then(() => {
          const current = store.getSnapshot().native;
          if (current?.connectionGeneration === context.expectedConnectionGeneration &&
              current.recordingRecovery?.recordingId === context.recordingId && current.recordingRecovery.revision === context.expectedRecoveryRevision)
            setCopied(true);
        }).catch(() => undefined);
      }}>Copy recognized text</Button> : null}
      <Button variant="outline" disabled={state.pending || !saved.canDiscard} onClick={() => run(() => store.plugin.discardRecording(context))}>Discard saved dictation</Button>
      {!saved.hasUnrecognizedAudio && !["rejected", "overflow", "unavailable"].includes(saved.stage) ? <Button disabled={state.pending || !saved.canSend}
        onClick={() => run(() => store.plugin.sendRecoveredRecording(context))}>Send saved dictation</Button> : null}
    </div>
    {copied ? <p className="text-sm text-muted-foreground" role="status">Recognized text copied. The saved dictation remains on this device.</p> : null}
  </section>;
}
