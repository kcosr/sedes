import { useEffect, useState } from "react";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { useApplicationStore } from "../stores/ApplicationClientStore.js";
import { SettingsPage } from "../components/settings/SettingsPage.js";
import { SettingsSection } from "../components/settings/SettingsSection.js";
import { SettingsField, SwitchField } from "../components/settings/SettingsField.js";
import { Button } from "../components/ui/button.js";
import { Callout } from "../components/ui/callout.js";
import { useFieldControl } from "../components/ui/control.js";
import { Input } from "../components/ui/input.js";
import { NativeSelect } from "../components/ui/native-select.js";
import { useVoiceState } from "./VoiceProvider.js";
import { recentVoiceErrors, type NativeVoiceStore } from "./NativeVoiceStore.js";
import { nativeThreadTitle, type NativeVoiceSettings } from "./native-voice-plugin.js";
import { VoiceThreadPicker } from "./VoiceThreadPicker.js";

const toggles = [
  ["autoListen", "Auto-listen", "Allow eligible notifications to reopen the microphone. Explicit recording stays available."],
  ["ignoreOtherDevices", "Ignore voice started on other devices", "Filter progress and completion for turns started by another device. Automations are still eligible."],
  ["readNotificationContext", "Read notification title and context", "Speak the notice, project and thread before the response."],
  ["onlyVoiceThread", "Only play from Voice thread", "Suppress automatic items for other threads. Choose a Voice thread first."],
  ["followComposerMode", "Follow composer's selected mode", "Use its Steer or Queue preference. Otherwise recognized input always queues while a thread is running."],
  ["recognizeStopCommand", "Recognize stop command", "Consume only “stop” and “stop listening” locally."],
  ["recognitionCues", "Recognition cues", "Play tones when recording starts and when recognition succeeds, fails, or is cancelled."],
  ["headsetControls", "Headset controls", "During an active voice session, start recording, skip speech or stop recording using the headset control."],
] as const;
const numbers = [
  ["adapterTextLimit", "Adapter text limit", 2, 100000, "Must not exceed the adapter's configured sanitizer limit. Long speech is split into ordered chunks."],
  ["recognitionStartTimeoutMs", "Recognition start timeout (ms)", 1000, 300000, "Maximum capture startup wait."],
  ["recognitionCompletionTimeoutMs", "Recognition completion timeout (ms)", 1000, 300000, "Maximum wait for the recognized result."],
  ["recognitionEndSilenceMs", "Recognition end silence (ms)", 100, 30000, "Silence before ending capture."],
  ["startupPreRollMs", "Startup pre-roll (ms)", 0, 5000, "Playback and cue warmup silence before recording."],
  ["cueGain", "Cue gain (%)", 0, 200, "Volume of recognition cues."],
  ["ttsGain", "Speech gain (%)", 0, 200, "Volume of spoken notifications and responses."],
] as const;

export function VoiceSettingsPage({ store, applicationStore }: { store: NativeVoiceStore; applicationStore: ApplicationClientStore }): React.JSX.Element {
  const state = useVoiceState(store);
  const application = useApplicationStore(applicationStore);
  const [picker, setPicker] = useState(false);
  const [devices, setDevices] = useState<Array<{ id: string; label: string; type: number }>>([]);
  useEffect(() => { void store.plugin.listInputDevices().then(result => setDevices(result.devices)).catch(() => undefined); }, [store]);
  const native = state.native;
  if (!native && state.loading) return <SettingsPage title="Voice"><p role="status">Connecting voice to this server…</p></SettingsPage>;
  if (!native || !native.identity) return <SettingsPage title="Voice"><Callout tone="danger">{state.error ?? "Voice could not connect to this server."}</Callout>
    <Button disabled={state.pending} onClick={() => { void store.reconnect().catch(() => undefined); }}>Retry voice connection</Button></SettingsPage>;
  const settings = native.settings;
  const update = (patch: Partial<NativeVoiceSettings>) => { void store.update(patch).catch(() => undefined); };
  const errors = recentVoiceErrors(state);
  const deviceLabels = inputDeviceLabels(devices);
  const voiceThreadLabel = settings.voiceThreadTitle ?? (settings.voiceThreadId
    ? application.snapshot?.threads.find(thread => thread.id === settings.voiceThreadId)?.title.text.trim() || "Untitled thread" : "Choose thread");
  return <SettingsPage title="Voice" description="Android speech and recording for this server profile. Changes are saved on this device.">
    {errors.length ? <Callout tone="danger" role="alert" action={<Button variant="outline" size="sm" onClick={() => store.dismissErrors()}>Clear errors</Button>}>
      {errors.length === 1 ? errors[0] : <ul className="grid gap-1">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
    </Callout> : null}
    <SettingsSection title="Voice session" card>
      <SettingsField label="Audio mode" description="Manual keeps completions silent but can listen afterward. Response speaks selected notices and responses.">
        <NativeSelect value={settings.audioMode} disabled={state.pending} onChange={event => update({ audioMode: event.target.value as NativeVoiceSettings["audioMode"] })}>
          <option value="off">Off</option><option value="manual">Manual</option><option value="response">Response</option>
        </NativeSelect>
      </SettingsField>
      <VoiceTextSetting label="Adapter URL" value={settings.adapterUrl} disabled={state.pending}
        description="Address of your agent-voice-adapter on a trusted network. It is separate from the Sedes server."
        onSave={adapterUrl => store.update({ adapterUrl })} />
      {settings.audioMode === "off" ? <Button disabled={state.pending || !settings.adapterUrl} onClick={() => update({ audioMode: "response" })}>Enable voice</Button>
        : native.actions.canResume ? <Button disabled={state.pending} onClick={() => { void store.update(current =>
          current.settings.audioMode !== "off" && current.actions.canResume ? { audioMode: current.settings.audioMode } : null).catch(() => undefined); }}>Resume voice</Button> : null}
      <p role="status">{voiceReadiness(native.readiness)}</p>
    </SettingsSection>
    <SettingsSection title="Targets and behavior" card>
      <SettingsField label="Voice thread" description="Used for explicit recording when no thread is visible.">
        <div className="flex flex-wrap gap-2"><VoiceThreadButton disabled={state.pending} onClick={() => setPicker(true)}>{voiceThreadLabel}</VoiceThreadButton>
          {settings.voiceThreadId ? <Button variant="ghost" disabled={state.pending} onClick={() => update({ voiceThreadId: null, voiceThreadTitle: null })}>Clear</Button> : null}</div>
      </SettingsField>
      {toggles.map(([key, label, description]) => <SwitchField key={key} label={label} description={description} checked={settings[key]} disabled={state.pending}
        onCheckedChange={value => update({ [key]: value })} />)}
    </SettingsSection>
    <SettingsSection title="Audio and timing" card>
      <SettingsField label="Microphone input">
        <NativeSelect value={settings.inputDeviceId ?? ""} disabled={state.pending} onChange={event => update({ inputDeviceId: event.target.value || null })}>
          <option value="">System default</option>
          {devices.map(device => <option key={device.id} value={device.id}>{deviceLabels.get(device.id)}</option>)}
          {settings.inputDeviceId && !devices.some(device => device.id === settings.inputDeviceId) ? <option value={settings.inputDeviceId}>Selected input (unavailable)</option> : null}
        </NativeSelect>
      </SettingsField>
      {numbers.map(([key, label, min, max, description]) => <VoiceTextSetting key={key} label={label} description={description} value={String(settings[key])} min={min} max={max}
        disabled={state.pending} onSave={value => store.update({ [key]: Number(value) })} />)}
    </SettingsSection>
    {native.recovery.length ? <SettingsSection title="Pending input recovery" card>
      <p>These submissions may have reached Sedes. Resume retries the same input identity; it never creates a replacement message.
        Discard deletes the saved input from this device and stops checking it; it cannot withdraw input Sedes already received.</p>
      {native.recovery.map(input => <div key={input.mutationId} className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words">{application.snapshot?.threads.find(thread => thread.id === input.threadId)?.title.text.trim() || input.threadId}</p>
          <p className="text-sm text-muted-foreground">{input.status === "uncertain" ? "Outcome uncertain" : "Reconciling input"}
            {input.cancelled ? " · Cancelled; checking receipt only" : ""} · {input.mutationId.slice(0, 8)}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" disabled={state.pending} onClick={() => { void store.run(() => store.plugin.discardInput({ ...store.commandContext(), mutationId: input.mutationId })).catch(() => undefined); }}>Discard</Button>
          <Button disabled={state.pending} onClick={() => { void store.run(() => store.plugin.resumeInput({ ...store.commandContext(), mutationId: input.mutationId })).catch(() => undefined); }}>Resume input</Button>
        </div>
      </div>)}
    </SettingsSection> : null}
    {native.queue.droppedCount ? <Callout>{native.queue.droppedCount} automatic voice items were dropped because the queue was full or the item became ineligible.</Callout> : null}
    <VoiceThreadPicker threads={application.snapshot?.threads ?? []} open={picker} onOpenChange={setPicker}
      onSelect={thread => update({ voiceThreadId: thread.id, voiceThreadTitle: nativeThreadTitle(thread.title.text) })} />
  </SettingsPage>;
}

function VoiceTextSetting({ label, description, value, disabled, onSave, min, max }: {
  label: string; description?: string; value: string; disabled: boolean; onSave: (value: string) => Promise<void>; min?: number; max?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  useEffect(() => { setDraft(value); setError(undefined); }, [value]);
  const save = async () => {
    if (min !== undefined && (!/^\d+$/.test(draft) || Number(draft) < min || Number(draft) > max!)) { setError(`Enter a whole number from ${min} to ${max}.`); return; }
    try { await onSave(draft.trim()); setError(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save."); }
  };
  return <SettingsField label={label} description={description} error={error}>
    <div className="flex min-w-0 gap-2"><Input value={draft} disabled={disabled} type={min === undefined ? "url" : "number"} min={min} max={max} step={min === undefined ? undefined : 1}
      onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} />
      <Button variant="outline" aria-label={`Save ${label}`} disabled={disabled || draft === value} onClick={() => void save()}>Save</Button></div>
  </SettingsField>;
}
/** The Field's label names this button together with its current choice. */
function VoiceThreadButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: string }) {
  const control = useFieldControl<{ id?: string; "aria-describedby"?: string; "aria-labelledby"?: string }>({}, { labelledBy: true });
  const valueId = control.id ? `${control.id}-value` : undefined;
  return <Button variant="outline" className="min-w-0 max-w-full" id={control.id} aria-describedby={control["aria-describedby"]}
    aria-labelledby={valueId && control["aria-labelledby"] ? `${control["aria-labelledby"]} ${valueId}` : undefined} disabled={disabled} onClick={onClick}>
    <span id={valueId} className="truncate">{children}</span></Button>;
}
const inputTypes: Record<number, string> = { 3: "Wired headset", 5: "Line in", 6: "Digital line in", 7: "Bluetooth", 9: "HDMI", 11: "USB", 12: "USB accessory",
  13: "Dock", 15: "Built-in", 16: "FM tuner", 17: "TV tuner", 18: "Telephony", 19: "Aux line", 20: "IP", 21: "Bus", 22: "USB headset", 23: "Hearing aid",
  25: "Remote submix", 26: "Bluetooth LE", 31: "Dock" };
/** Android often reports several inputs under one product name; add the input type, then a number, until each label is distinct. */
export function inputDeviceLabels(devices: readonly { id: string; label: string; type: number }[]): Map<string, string> {
  const count = (values: readonly string[], value: string) => values.filter(entry => entry === value).length;
  const names = devices.map(device => device.label.trim() || "Microphone");
  const typed = devices.map((device, index) => count(names, names[index]!) > 1 && inputTypes[device.type] ? `${names[index]} (${inputTypes[device.type]})` : names[index]!);
  const seen = new Map<string, number>();
  return new Map(devices.map((device, index) => {
    const label = typed[index]!;
    if (count(typed, label) === 1) return [device.id, label];
    const number = (seen.get(label) ?? 0) + 1;
    seen.set(label, number);
    return [device.id, `${label} #${number}`];
  }));
}
export function voiceReadiness(readiness: string): string {
  return ({ disconnected: "Connect to Sedes to use voice.", connecting: "Connecting to Sedes…", off: "Voice is off.", needsResume: "Resume voice from this screen to start a new session.",
    permissionRequired: "Microphone permission is required to start voice.", adapterRequired: "Save an adapter URL before enabling voice.", adapterConnecting: "Connecting to the voice adapter…",
    notificationsConnecting: "Connecting to Sedes notifications…", notificationsUnavailable: "Sedes notifications are unavailable. Explicit recording still works.",
    ready: "Voice is ready.", error: "Voice needs attention." } as Record<string, string>)[readiness] ?? "Voice is starting…";
}
