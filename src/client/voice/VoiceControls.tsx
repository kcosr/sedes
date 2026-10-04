import { useEffect, useState } from "react";
import { Mic, SkipForward, Square, Settings2 } from "lucide-react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { navigate, settingsPath, useRoute } from "../app/router.js";
import { useComposerDeliveryMode } from "../app/composer-delivery-mode.js";
import { Button } from "../components/ui/button.js";
import { useNativeVoice, useVoiceState } from "./VoiceProvider.js";
import type { NativeVoiceStore } from "./NativeVoiceStore.js";
import { VoiceThreadPicker } from "./VoiceThreadPicker.js";
import { voiceReadiness } from "./VoiceSettingsPage.js";
import { nativeThreadTitle } from "./native-voice-plugin.js";

export function VoiceControls({ threads }: { threads: readonly NormalizedApplicationThreadSummary[] }) {
  const store = useNativeVoice();
  return store ? <NativeVoiceControls store={store} threads={threads} /> : null;
}
function NativeVoiceControls({ store, threads }: { store: NativeVoiceStore; threads: readonly NormalizedApplicationThreadSummary[] }) {
  const state = useVoiceState(store);
  const route = useRoute();
  const composerMode = useComposerDeliveryMode();
  const [picker, setPicker] = useState<"start" | "retarget" | null>(null);
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
  // Unavailable voice is reported and retried in Settings → Voice; the bar appears only for a connected, enabled session.
  if (!native || native.settings.audioMode === "off") return null;
  const act = (action: () => ReturnType<typeof store.plugin.getState>) => { void store.run(action).catch(() => undefined); };
  const start = () => {
    // Native decides when explicit recording can start; it does not need the notification stream that `ready` includes.
    if (!native.actions.canStart) { navigate(settingsPath("voice")); return; }
    const available = (id: string | null) => threads.find(thread => thread.id === id && thread.available &&
      (thread.inventoryState === "active" || thread.inventoryState === "settled"));
    const target = available(threadId) ?? available(native.settings.voiceThreadId);
    if (!target) { setPicker("start"); return; }
    act(() => store.plugin.startManualListen({ ...store.commandContext(), threadId: target.id, threadTitle: nativeThreadTitle(target.title.text) ?? undefined }));
  };
  const active = native.active;
  const busy = !["off", "idle"].includes(native.phase);
  const canChooseTarget = native.actions.canRetarget && !state.pending;
  const showingInput = ["validating", "arming", "listening", "recognizing", "submitting", "recovering"].includes(native.phase);
  const [targetId, targetTitle] = showingInput ? [active?.recognitionThreadId, active?.recognitionThreadTitle]
    : [active?.threadId ?? active?.recognitionThreadId, active?.threadTitle ?? active?.recognitionThreadTitle];
  const activeTitle = targetTitle ?? (targetId ? threads.find(thread => thread.id === targetId)?.title.text.trim() || "Untitled thread" : undefined);
  return <div className="voice-controls" role="group" aria-label="Voice controls">
    {busy ? <div className="voice-active" role="status">
      {canChooseTarget ? <Button variant="ghost" size="sm" className="min-w-0 shrink" onClick={() => setPicker("retarget")}
        aria-label={activeTitle ? `Change recording target: ${activeTitle}` : "Change recording target"}><span className="voice-thread">{activeTitle ?? "Choose thread"}</span></Button>
        : <span className="voice-thread">{activeTitle ?? "Voice"}</span>}
      <span className="voice-phase">{phaseLabel(native.phase)}</span>
    </div> : null}
    <div className="voice-actions">
      {!busy ? <Button variant="ghost" size="icon" aria-label="Start voice recording"
        title={native.actions.canStart ? "Start voice recording" : voiceReadiness(native.readiness)} disabled={state.pending} onClick={start}><Mic size={18} /></Button> : null}
      {native.actions.canSkip ? <Button variant="ghost" size="icon" disabled={state.pending} aria-label="Skip voice playback" onClick={() => act(() => store.plugin.skipCurrentPlayback(store.commandContext()))}><SkipForward size={18} /></Button> : null}
      {native.actions.canStop ? <Button variant="ghost" size="icon" disabled={state.pending} aria-label="Stop voice interaction" onClick={() => act(() => store.plugin.stopCurrentInteraction(store.commandContext()))}><Square size={16} /></Button> : null}
      <Button variant="ghost" size="icon" aria-label="Voice settings" onClick={() => navigate(settingsPath("voice"))}><Settings2 size={17} /></Button>
    </div>
    {state.error ? <span className="voice-error" role="alert">{state.error}</span> : null}
    <VoiceThreadPicker threads={threads} open={picker !== null} onOpenChange={open => { if (!open) setPicker(null); }} onSelect={thread => {
      const target = { threadId: thread.id, threadTitle: nativeThreadTitle(thread.title.text) ?? undefined };
      act(() => picker === "retarget" ? store.plugin.retargetActiveRecognition({ ...store.commandContext(), ...target })
        : store.plugin.startManualListen({ ...store.commandContext(), ...target }));
    }} />
  </div>;
}
function phaseLabel(phase: string): string {
  return ({ starting: "Starting…", synthesizing: "Preparing speech…", speaking: "Speaking", validating: "Checking thread…", arming: "Preparing microphone…", listening: "Listening", recognizing: "Recognizing…", submitting: "Sending…", cancelling: "Stopping…", recovering: "Checking submission…", error: "Needs attention" } as Record<string, string>)[phase] ?? phase;
}
