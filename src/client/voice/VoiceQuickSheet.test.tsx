// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { navigate, settingsPath, threadPath } from "../app/router.js";
import { NativeVoiceStore } from "./NativeVoiceStore.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";
import { fakeVoicePlugin, recordingRecovery, VOICE_CONNECTION, voiceActions, voiceSettings, voiceSnapshot } from "./native-voice-test-fixture.js";
import { useVoiceState } from "./VoiceProvider.js";
import { VoiceQuickSheet } from "./VoiceQuickSheet.js";

const speechEndpoint = "https://voice.test/v1";
const configuredSpeech: NativeVoiceState["speech"] = { ...voiceSnapshot().speech, credentialConfigured: true };
const actions = voiceActions({ canStart: true });
const thread = (id: string, title: string) => ({ id, title: { text: title }, available: true, inventoryState: "active" }) as unknown as NormalizedApplicationThreadSummary;
const longTitle = "L".repeat(600);
const threads = [thread("long", longTitle), thread("untitled", "  "), thread("standup", "Daily standup notes"),
  { ...thread("archived", "Archived notes"), inventoryState: "archived" }, { ...thread("offline", "Offline review"), available: false }] as NormalizedApplicationThreadSummary[];
const ready = (settings: Parameters<typeof voiceSettings>[0] = {}) => voiceSnapshot({ phase: "idle", ready: true, readiness: "ready", actions,
  speech: configuredSpeech, settings: voiceSettings({ audioMode: "speak", speechProvider: "server", speechEndpoint, ...settings }) });
/** Native as the sheet sees it: refreshes return the current state and writes apply their patch. */
async function renderSheet(state: NativeVoiceState, host?: (store: NativeVoiceStore) => ReactElement) {
  const fake = fakeVoicePlugin();
  let current = state;
  fake.plugin.setConnection.mockResolvedValue(state);
  fake.plugin.getState.mockImplementation(async () => current);
  vi.mocked(fake.asPlugin.updateSettings).mockImplementation(async ({ patch }) => (current = { ...current, stateRevision: current.stateRevision + 1,
    settingsRevision: current.settingsRevision + 1, settings: { ...current.settings, ...patch } }));
  const store = new NativeVoiceStore(fake.asPlugin, VOICE_CONNECTION, () => undefined);
  const onOpenChange = vi.fn();
  const view = render(host ? host(store) : <VoiceQuickSheet store={store} threads={threads} open onOpenChange={onOpenChange} />);
  await act(async () => { await store.initialize(); });
  return { fake, store, view, onOpenChange, sheet: screen.queryByRole("dialog", { name: "Voice" })! };
}
/** Holds the next native write until released, so the sheet stays pending. */
function holdNextWrite(fake: ReturnType<typeof fakeVoicePlugin>) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = vi.mocked(fake.asPlugin.updateSettings);
  const echo = write.getMockImplementation()!;
  write.mockImplementationOnce(async input => { await gate; return echo(input); });
  return () => act(async () => { release(); });
}
const patches = (fake: ReturnType<typeof fakeVoicePlugin>) => vi.mocked(fake.asPlugin.updateSettings).mock.calls.map(([input]) => input.patch);
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  navigate("/", { replace: true });
  Object.assign(HTMLElement.prototype, { scrollIntoView: vi.fn() });
});
afterEach(() => {
  cleanup();
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("voice quick sheet", () => {
  it("names the mode control and every quick setting with their current values", async () => {
    const { store, sheet } = await renderSheet(ready({ voiceThreadId: "standup", voiceThreadTitle: "Daily standup notes", followComposerMode: true }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Ready");
    expect(within(sheet).getByRole("radiogroup", { name: "Audio mode" })).toBeInTheDocument();
    expect(within(sheet).getByRole("radio", { name: "Speak" })).toHaveAttribute("aria-checked", "true");
    expect(sheet).toHaveTextContent("Speak reads selected notifications aloud.");
    expect(within(sheet).getByRole("switch", { name: "Auto-listen" })).toHaveAccessibleDescription("Eligible notifications reopen the mic");
    expect(within(sheet).getByRole("switch", { name: "Auto-listen" })).toBeChecked();
    expect(within(sheet).getByRole("switch", { name: "Keep listening by default" })).toHaveAccessibleDescription("New manual and auto-listen recordings");
    expect(within(sheet).getByRole("switch", { name: "Keep listening by default" })).not.toBeChecked();
    expect(within(sheet).getByRole("button", { name: "Default voice thread" })).toHaveAccessibleDescription("Daily standup notes");
    expect(within(sheet).getByRole("switch", { name: "Pin default voice thread" })).toHaveAccessibleDescription("Use this initial recording target");
    expect(within(sheet).getByRole("switch", { name: "Pin default voice thread" })).not.toBeChecked();
    expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).toHaveAccessibleDescription("Limit automatic playback to this thread");
    expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).not.toBeChecked();
    expect(within(sheet).getByRole("switch", { name: "Follow composer mode" })).toHaveAccessibleDescription("Use its Steer or Queue choice");
    expect(within(sheet).getByRole("switch", { name: "Follow composer mode" })).toBeChecked();
    expect(within(sheet).getByRole("button", { name: "All voice settings" })).toBeEnabled();
    store.dispose();
  });
  it("reports readiness while a mode is on but voice is not ready", async () => {
    const { store, sheet } = await renderSheet(voiceSnapshot({ phase: "starting", readiness: "starting", settings: voiceSettings({ audioMode: "input", speechEndpoint }) }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Voice is starting…");
    expect(sheet).toHaveTextContent("Input keeps speech silent. Auto-listen can still reopen the mic.");
    store.dispose();
  });
  it("remembers Read aloud across Input and Off while keeping auto-listen separate", async () => {
    const { fake, store, sheet } = await renderSheet(ready());
    const choose = async (label: string) => {
      fireEvent.keyDown(within(sheet).getByRole("combobox", { name: "Read aloud" }), { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name: new RegExp(`^${label}`) }));
      await waitFor(() => expect(within(sheet).getByRole("combobox", { name: "Read aloud" })).toHaveTextContent(label));
      await waitFor(() => expect(within(sheet).getByRole("combobox", { name: "Read aloud" })).not.toHaveAttribute("aria-disabled"));
    };
    await choose("Announcements");
    await choose("Messages");
    for (const mode of ["Input", "Off"]) {
      fireEvent.click(within(sheet).getByRole("radio", { name: mode }));
      await waitFor(() => expect(within(sheet).queryByRole("combobox", { name: "Read aloud" })).toBeNull());
      await waitFor(() => expect(within(sheet).getByRole("radio", { name: "Speak" })).not.toHaveAttribute("aria-disabled"));
      fireEvent.click(within(sheet).getByRole("radio", { name: "Speak" }));
      await waitFor(() => expect(within(sheet).getByRole("combobox", { name: "Read aloud" })).toHaveTextContent("Messages"));
      await waitFor(() => expect(within(sheet).getByRole("radio", { name: "Speak" })).not.toHaveAttribute("aria-disabled"));
    }
    await choose("Both");
    expect(within(sheet).getByRole("switch", { name: "Auto-listen" })).toBeChecked();
    expect(patches(fake)).toEqual([{ speechContent: "announcements" }, { speechContent: "messages" },
      { audioMode: "input" }, { audioMode: "speak" }, { audioMode: "off" }, { audioMode: "speak" }, { speechContent: "both" }]);
    store.dispose();
  });
  it("switches modes through the store and locks the control, keeping focus, while a write is pending", async () => {
    const { fake, store, sheet } = await renderSheet(ready());
    const release = holdNextWrite(fake);
    const manual = within(sheet).getByRole("radio", { name: "Input" });
    act(() => manual.focus());
    fireEvent.click(manual);
    expect(within(sheet).getByRole("radio", { name: "Off" })).toHaveAttribute("aria-disabled", "true");
    expect(manual).toBeEnabled();
    expect(manual).toHaveFocus();
    fireEvent.click(within(sheet).getByRole("radio", { name: "Off" }));
    await release();
    await waitFor(() => expect(within(sheet).getByRole("radio", { name: "Input" })).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(within(sheet).getByRole("radio", { name: "Off" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(within(sheet).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(within(sheet).getByRole("status")).toHaveTextContent("Voice off"));
    expect(sheet).toHaveTextContent("Off pauses voice. Pick Input or Speak to resume.");
    expect(patches(fake)).toEqual([{ audioMode: "input" }, { audioMode: "off" }]);
    store.dispose();
  });
  it("turns voice on from Off with the chosen mode, then offers Resume when native could not start a session", async () => {
    const { fake, store, sheet } = await renderSheet(voiceSnapshot({ speech: configuredSpeech, settings: voiceSettings({ speechProvider: "server", speechEndpoint }) }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Voice off");
    expect(within(sheet).queryByRole("button", { name: "Resume voice" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("radio", { name: "Input" }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { audioMode: "input" } }));
    // Native saved the mode but has no session; the refreshed mode is what Resume writes back.
    const paused = voiceSnapshot({ stateRevision: 5, settingsRevision: 3, readiness: "needsResume", speech: configuredSpeech, settings: voiceSettings({ audioMode: "speak", speechProvider: "server", speechEndpoint }), actions: { ...actions, canStart: false, canResume: true } });
    fake.plugin.getState.mockResolvedValue(paused);
    act(() => fake.emit("stateChanged", { ...paused, settings: voiceSettings({ audioMode: "input", speechEndpoint }) }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Resume voice from this screen to start a new session.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Resume voice" }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenLastCalledWith({ expectedConnectionGeneration: 1, expectedRevision: 3, patch: { audioMode: "speak" } }));
    store.dispose();
  });
  it("keeps Input and Speak unavailable from Off until the speech destination is configured", async () => {
    const { fake, store, sheet } = await renderSheet(voiceSnapshot({ speech: configuredSpeech, settings: voiceSettings({ speechProvider: "server", speechEndpoint: "", sttModel: "", ttsModel: "", ttsVoice: "" }) }));
    expect(within(sheet).getByRole("radio", { name: "Input" })).toBeDisabled();
    expect(within(sheet).getByRole("radio", { name: "Speak" })).toBeDisabled();
    expect(sheet).toHaveTextContent("Off pauses voice. Set up speech in All voice settings first.");
    fireEvent.click(within(sheet).getByRole("radio", { name: "Speak" }));
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    store.dispose();
  });
  it("keeps configured speech disabled until its native credential is saved", async () => {
    const { fake, store, sheet } = await renderSheet(voiceSnapshot());
    expect(within(sheet).getByRole("radio", { name: "Input" })).toBeDisabled();
    expect(within(sheet).getByRole("radio", { name: "Speak" })).toBeDisabled();
    fireEvent.click(within(sheet).getByRole("radio", { name: "Speak" }));
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    store.dispose();
  });
  it("explains the missing default before and after enabling playback filtering", async () => {
    const { fake, store, sheet } = await renderSheet(ready());
    fireEvent.click(within(sheet).getByRole("switch", { name: "Auto-listen" }));
    await waitFor(() => expect(within(sheet).getByRole("switch", { name: "Auto-listen" })).not.toBeChecked());
    await waitFor(() => expect(within(sheet).getByRole("switch", { name: "Follow composer mode" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(within(sheet).getByText("Use its Steer or Queue choice"));
    await waitFor(() => expect(within(sheet).getByRole("switch", { name: "Follow composer mode" })).toBeChecked());
    await waitFor(() => expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).not.toHaveAttribute("aria-disabled"));
    expect(within(sheet).getByRole("button", { name: "Default voice thread" })).toHaveAccessibleDescription("Choose thread");
    expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).toHaveAccessibleDescription("Choose a default thread first");
    fireEvent.click(within(sheet).getByText("Choose a default thread first"));
    await waitFor(() => expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).toBeChecked());
    expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).toHaveAccessibleDescription("Choose a default thread first");
    expect(patches(fake)).toEqual([{ autoListen: false }, { followComposerMode: true }, { onlyVoiceThread: true }]);
    store.dispose();
  });
  it("pins the default recording target independently of the playback filter and preserves focus while saving", async () => {
    const { fake, store, sheet } = await renderSheet(ready({ onlyVoiceThread: true }));
    const pin = within(sheet).getByRole("switch", { name: "Pin default voice thread" });
    act(() => pin.focus());
    const release = holdNextWrite(fake);
    fireEvent.click(pin);
    expect(pin).toHaveAttribute("aria-disabled", "true");
    expect(pin).toHaveFocus();
    fireEvent.click(within(sheet).getByRole("switch", { name: "Only play from default voice thread" }));
    await release();
    await waitFor(() => expect(pin).toBeChecked());
    expect(pin).toHaveFocus();
    expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).toBeChecked();
    expect(patches(fake)).toEqual([{ pinDefaultVoiceThread: true }]);
    fireEvent.click(pin);
    await waitFor(() => expect(pin).not.toBeChecked());
    expect(patches(fake)).toEqual([{ pinDefaultVoiceThread: true }, { pinDefaultVoiceThread: false }]);
    expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).toBeChecked();
    store.dispose();
  });
  it.each([false, true])("saves the future Keep listening preference while the current recording stays %s", async keepListening => {
    const native = { ...ready(), phase: "listening" as const, active: { id: "interaction", threadId: "standup", threadTitle: "Daily standup notes",
      eventKind: "manual", automatic: false, recognitionThreadId: "standup", recognitionThreadTitle: "Daily standup notes",
      recording: { id: "recording", keepListening, reconnecting: false } } };
    const { fake, store, sheet } = await renderSheet(native);
    const preference = within(sheet).getByRole("switch", { name: "Keep listening by default" });
    expect(preference).not.toBeChecked();
    expect(preference).not.toHaveAttribute("aria-disabled");
    act(() => preference.focus());
    const release = holdNextWrite(fake);
    fireEvent.click(preference);
    expect(preference).toHaveAttribute("aria-disabled", "true");
    expect(preference).toHaveFocus();
    fireEvent.click(preference);
    await release();
    await waitFor(() => expect(preference).toBeChecked());
    await waitFor(() => expect(preference).not.toHaveAttribute("aria-disabled"));
    expect(preference).toHaveFocus();
    expect(store.getSnapshot().native?.active?.recording?.keepListening).toBe(keepListening);
    fireEvent.click(preference);
    await waitFor(() => expect(preference).not.toBeChecked());
    expect(vi.mocked(fake.asPlugin.updateSettings).mock.calls.map(([input]) => input)).toEqual([
      { expectedConnectionGeneration: 1, expectedRevision: 0, patch: { keepListeningByDefault: true } },
      { expectedConnectionGeneration: 1, expectedRevision: 1, patch: { keepListeningByDefault: false } },
    ]);
    expect(store.getSnapshot().native?.active?.recording?.keepListening).toBe(keepListening);
    expect(fake.plugin.setKeepListening).not.toHaveBeenCalled();
    expect(within(sheet).getByRole("switch", { name: "Auto-listen" })).toBeChecked();
    store.dispose();
  });
  it("chooses a default thread above the sheet, pins the current choice, and keeps focus while its saved title is normalized", async () => {
    const { fake, store, sheet } = await renderSheet(ready({ voiceThreadId: "standup", voiceThreadTitle: "Daily standup notes" }));
    const choice = within(sheet).getByRole("button", { name: "Default voice thread" });
    act(() => choice.focus());
    fireEvent.click(choice);
    const picker = await screen.findByRole("dialog", { name: "Default voice thread" });
    expect(picker).toHaveAttribute("data-layer", "over-dialog");
    expect(picker).toHaveAccessibleDescription("Used when pinned or when no thread is visible.");
    const list = within(picker).getByRole("list", { name: "Voice threads" });
    expect(within(list).getAllByRole("listitem").map(item => item.textContent)).toEqual(["Current default voice threadDaily standup notes", longTitle, "Untitled thread"]);
    expect(within(list).getByRole("button", { name: "Daily standup notes" })).toHaveAccessibleDescription("Current default voice thread");
    const release = holdNextWrite(fake);
    fireEvent.click(within(list).getByRole("button", { name: longTitle }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Default voice thread" })).toBeNull());
    expect(choice).toHaveFocus();
    expect(choice).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(choice);
    expect(screen.queryByRole("dialog", { name: "Default voice thread" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("switch", { name: "Only play from default voice thread" }));
    await release();
    await waitFor(() => expect(choice).toHaveAccessibleDescription("L".repeat(512)));
    expect(choice).toHaveFocus();
    expect(patches(fake)).toEqual([{ voiceThreadId: "long", voiceThreadTitle: "L".repeat(512) }]);
    fireEvent.click(choice);
    fireEvent.click(within(await screen.findByRole("list", { name: "Voice threads" })).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(choice).toHaveAccessibleDescription("Untitled thread"));
    expect(patches(fake).at(-1)).toEqual({ voiceThreadId: "untitled", voiceThreadTitle: null });
    expect(fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(fake.plugin.retargetActiveRecognition).not.toHaveBeenCalled();
    store.dispose();
  });
  it("closes the default picker with its sheet and does not reopen it on the next visit", async () => {
    const { store, view, sheet, onOpenChange } = await renderSheet(ready());
    fireEvent.click(within(sheet).getByRole("button", { name: "Default voice thread" }));
    await screen.findByRole("dialog", { name: "Default voice thread" });
    view.rerender(<VoiceQuickSheet store={store} threads={threads} open={false} onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.rerender(<VoiceQuickSheet store={store} threads={threads} open onOpenChange={onOpenChange} />);
    expect(screen.getByRole("dialog", { name: "Voice" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Default voice thread" })).toBeNull();
    store.dispose();
  });
  it("returns focus to the visible view when choosing Off removes the card that opened the sheet", async () => {
    function Card({ store }: { store: NativeVoiceStore }) {
      const [open, setOpen] = useState(false);
      const off = useVoiceState(store).native?.settings.audioMode === "off";
      return <>
        <div className="application-workspace" tabIndex={-1} inert />
        <section className="settings-content" tabIndex={-1} aria-label="Voice settings page" />
        {off ? null : <button type="button" onClick={() => setOpen(true)}>Open voice controls</button>}
        <VoiceQuickSheet store={store} threads={threads} open={open} onOpenChange={setOpen} />
      </>;
    }
    const { store } = await renderSheet(ready(), store => <Card store={store} />);
    const opener = screen.getByRole("button", { name: "Open voice controls" });
    act(() => opener.focus());
    fireEvent.click(opener);
    const sheet = screen.getByRole("dialog", { name: "Voice" });
    fireEvent.click(within(sheet).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open voice controls" })).toBeNull());
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Voice settings page" })).toHaveFocus());
    store.dispose();
  });
  it("opens all voice settings and closes the sheet", async () => {
    const { store, sheet, onOpenChange } = await renderSheet(ready());
    fireEvent.click(within(sheet).getByRole("button", { name: "All voice settings" }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(window.location.pathname).toBe(settingsPath("voice"));
    store.dispose();
  });
  it("copies saved text while Off only after native succeeds, retaining the recording after copy and failure", async () => {
    const saved = recordingRecovery({ revision: 4, captureIncomplete: true, canRetryRecognition: false, canCopyRecognizedText: true });
    const native = voiceSnapshot({ recordingRecovery: saved });
    const { fake, store, sheet } = await renderSheet(native);
    const copy = within(sheet).getByRole("button", { name: "Copy text" });
    let release!: (value: NativeVoiceState) => void;
    fake.plugin.copyRecognizedRecordingText.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    expect(sheet).toHaveTextContent("Needs transcription");
    expect(within(sheet).getByRole("button", { name: "Retry recognition" })).toHaveAttribute("aria-disabled", "true");
    act(() => copy.focus());
    fireEvent.click(copy);
    expect(copy).toHaveAttribute("aria-disabled", "true");
    expect(copy).toHaveFocus();
    fireEvent.click(copy);
    expect(sheet).not.toHaveTextContent("Copied.");
    expect(fake.plugin.copyRecognizedRecordingText).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, recordingId: saved.recordingId, expectedRecoveryRevision: 4 });
    await act(async () => release({ ...native, stateRevision: 2 }));
    await waitFor(() => expect(sheet).toHaveTextContent("Copied."));
    expect(copy).toHaveFocus();
    expect(store.getSnapshot().native?.recordingRecovery).toEqual(saved);
    fake.plugin.copyRecognizedRecordingText.mockRejectedValueOnce(new Error("Clipboard unavailable."));
    fireEvent.click(copy);
    await waitFor(() => expect(sheet).toHaveTextContent("Clipboard unavailable."));
    expect(sheet).not.toHaveTextContent("Copied.");
    expect(store.getSnapshot().native?.recordingRecovery).toEqual(saved);
    expect(within(sheet).getByRole("button", { name: "Add to composer" })).toHaveAttribute("aria-disabled", "true");
    store.dispose();
  });
  it("does not report a stale copy as a copy of the current saved dictation", async () => {
    const saved = recordingRecovery({ canCopyRecognizedText: true });
    const native = voiceSnapshot({ recordingRecovery: saved });
    const { fake, store, sheet } = await renderSheet(native);
    let release!: (value: NativeVoiceState) => void;
    fake.plugin.copyRecognizedRecordingText.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Copy text" }));
    act(() => fake.emit("stateChanged", { ...native, stateRevision: 3, recordingRecovery: { ...saved, revision: 2 } }));
    await act(async () => release({ ...native, stateRevision: 2 }));
    expect(sheet).not.toHaveTextContent("Copied.");
    expect(store.getSnapshot().native?.recordingRecovery?.revision).toBe(2);
    store.dispose();
  });
  it.each([
    ["unfinished", "Finish transcription to add to the composer."],
    ["unknown", "Original thread unknown."],
    ["archived", "Unarchive the original thread to add text."],
    ["offline", "Original thread unavailable."],
  ])("explains the %s composer restriction visibly and accessibly", async (reason, message) => {
    const saved = recordingRecovery({ canCopyRecognizedText: true, hasUnrecognizedAudio: reason === "unfinished",
      threadId: reason === "unknown" ? null : reason === "unfinished" ? "standup" : reason });
    const { fake, store, sheet } = await renderSheet(voiceSnapshot({ recordingRecovery: saved }));
    const add = within(sheet).getByRole("button", { name: "Add to composer" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription(message);
    expect(within(sheet).getByText(message)).toBeVisible();
    fireEvent.click(add);
    expect(fake.plugin.readRecognizedRecordingText).not.toHaveBeenCalled();
    expect(store.getSnapshot().pending).toBe(false);
    store.dispose();
  });
  it("adds recognized text to the original composer while Off, closes the sheet, and retains recovery", async () => {
    const saved = recordingRecovery({ revision: 4, stage: "ready", hasUnrecognizedAudio: false, captureIncomplete: true,
      canRetryRecognition: false, canCopyRecognizedText: true, canSend: true });
    const { fake, store, sheet, onOpenChange } = await renderSheet(voiceSnapshot({ recordingRecovery: saved }));
    const append = vi.fn();
    store.registerComposer(saved.threadId!, append);
    fake.plugin.readRecognizedRecordingText.mockResolvedValue({ recordingId: saved.recordingId, revision: 4,
      threadId: saved.threadId!, text: "Recovered words" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Add to composer" }));
    await waitFor(() => expect(append).toHaveBeenCalledExactlyOnceWith("Recovered words"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(within(sheet).getByRole("button", { name: "Added to composer" })).toHaveAttribute("aria-disabled", "true");
    expect(store.getSnapshot().native?.recordingRecovery).toEqual(saved);
    expect(fake.plugin.sendRecoveredRecording).not.toHaveBeenCalled();
    expect(fake.plugin.discardRecording).not.toHaveBeenCalled();
    expect(within(sheet).queryByRole("checkbox")).toBeNull();
    store.dispose();
  });
  it("sends interrupted dictation explicitly at the current revision and preserves focus through pending work", async () => {
    const saved = recordingRecovery({ stage: "ready", revision: 4, hasUnrecognizedAudio: false, captureIncomplete: true,
      canRetryRecognition: false, canSend: true });
    const native = voiceSnapshot({ recordingRecovery: saved });
    const { fake, store, sheet } = await renderSheet(native);
    expect(within(sheet).queryByRole("checkbox")).toBeNull();
    expect(sheet).toHaveTextContent("Recording interrupted");
    const send = within(sheet).getByRole("button", { name: "Send" });
    expect(send).not.toHaveAttribute("aria-disabled");
    act(() => fake.emit("stateChanged", { ...native, stateRevision: 2, recordingRecovery: { ...saved, revision: 5 } }));
    let release!: (value: NativeVoiceState) => void;
    fake.plugin.sendRecoveredRecording.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    act(() => send.focus());
    fireEvent.click(send);
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveFocus();
    fireEvent.click(send);
    expect(fake.plugin.sendRecoveredRecording).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      recordingId: saved.recordingId, expectedRecoveryRevision: 5 });
    await act(async () => release({ ...native, stateRevision: 3,
      recordingRecovery: { ...saved, revision: 6, stage: "admitting", captureIncomplete: false, canSend: false, canDiscard: true } }));
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveFocus();
    const discard = within(sheet).getByRole("button", { name: "Discard" });
    expect(discard).not.toHaveAttribute("aria-disabled");
    fake.plugin.discardRecording.mockResolvedValue(voiceSnapshot({ stateRevision: 4 }));
    fireEvent.click(discard);
    await waitFor(() => expect(fake.plugin.discardRecording).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      recordingId: saved.recordingId, expectedRecoveryRevision: 6 }));
    expect(fake.plugin.stopCurrentInteraction).not.toHaveBeenCalled();
    store.dispose();
  });
  it("offers an explicit storage retry while Off even when the client connection is registered", async () => {
    const native = voiceSnapshot({ readiness: "storageUnavailable", phase: "error" });
    const { fake, store, sheet } = await renderSheet(native);
    expect(sheet).toHaveTextContent("Recording storage is unavailable. Retry the voice connection.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Retry voice connection" }));
    await waitFor(() => expect(fake.plugin.setConnection).toHaveBeenLastCalledWith({ ...VOICE_CONNECTION, reconnect: true }));
    store.dispose();
  });
  it.each([false, true])("starts a new recording during older admission using the visible or pinned target (pinned: %s)", async pinned => {
    navigate(threadPath("long"));
    const saved = recordingRecovery({ stage: "admitting", hasUnrecognizedAudio: false, admission: {
      mutationId: "50000000-0000-4000-8000-000000000001", status: "uncertain", cancelled: false } });
    const native = { ...ready({ pinDefaultVoiceThread: pinned, voiceThreadId: "standup" }), recordingRecovery: saved };
    const { fake, store, sheet, onOpenChange } = await renderSheet(native);
    fake.plugin.startManualListen.mockResolvedValue({ ...native, stateRevision: 2 });
    fireEvent.click(within(sheet).getByRole("button", { name: "Start new recording" }));
    await waitFor(() => expect(fake.plugin.startManualListen).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      threadId: pinned ? "standup" : "long", threadTitle: pinned ? "Daily standup notes" : "L".repeat(512) }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    expect(store.getSnapshot().native?.recordingRecovery).toEqual(saved);
    store.dispose();
  });
  it("uses the retained fallback without a viewed thread while older dictation waits for admission", async () => {
    navigate("/");
    const saved = recordingRecovery({ stage: "admitting", hasUnrecognizedAudio: false, admission: {
      mutationId: "50000000-0000-4000-8000-000000000001", status: "uncertain", cancelled: false } });
    const native = { ...ready({ voiceThreadId: "standup" }), recordingRecovery: saved,
      retainedVoiceTarget: { threadId: "outside-inventory", threadTitle: "Retained destination", revision: 3 } };
    const { fake, store, sheet, onOpenChange } = await renderSheet(native);
    fake.plugin.startManualListen.mockResolvedValue({ ...native, stateRevision: 2 });
    fireEvent.click(within(sheet).getByRole("button", { name: "Start new recording" }));
    await waitFor(() => expect(fake.plugin.startManualListen).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      threadId: "outside-inventory", threadTitle: "Retained destination" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(window.location.pathname).toBe("/");
    expect(store.getSnapshot().native?.recordingRecovery).toEqual(saved);
    store.dispose();
  });
  it("explains a retained dictation blocking default Keep listening and updates when the default changes", async () => {
    const saved = recordingRecovery({ stage: "admitting", hasUnrecognizedAudio: false, admission: {
      mutationId: "50000000-0000-4000-8000-000000000001", status: "uncertain", cancelled: false } });
    const native = { ...ready(), recordingRecovery: saved };
    const { fake, store, sheet } = await renderSheet(native);
    const explanation = "Resolve saved dictation first to start with Keep listening.";
    expect(within(sheet).getByRole("button", { name: "Start new recording" })).toBeEnabled();
    expect(within(sheet).queryByText(explanation)).toBeNull();
    act(() => fake.emit("stateChanged", { ...native, stateRevision: 2, settingsRevision: 1,
      settings: { ...native.settings, keepListeningByDefault: true }, actions: { ...native.actions, canStart: false } }));
    expect(within(sheet).getByRole("switch", { name: "Keep listening by default" })).toBeChecked();
    expect(within(sheet).queryByRole("button", { name: "Start new recording" })).toBeNull();
    expect(within(sheet).getByText(explanation)).toBeInTheDocument();
    act(() => fake.emit("stateChanged", { ...native, stateRevision: 3, settingsRevision: 2 }));
    expect(within(sheet).getByRole("switch", { name: "Keep listening by default" })).not.toBeChecked();
    expect(within(sheet).getByRole("button", { name: "Start new recording" })).toBeEnabled();
    expect(within(sheet).queryByText(explanation)).toBeNull();
    expect(fake.plugin.startManualListen).not.toHaveBeenCalled();
    store.dispose();
  });
  it("shows only the current-recording explanation when saved dictation blocks both Keep listening actions", async () => {
    const native: NativeVoiceState = { ...ready({ keepListeningByDefault: true }), phase: "listening", active: {
      id: "current", eventKind: "manual", threadId: "standup", threadTitle: "Daily standup notes",
      recognitionThreadId: "standup", recognitionThreadTitle: "Daily standup notes", automatic: false,
      recording: { id: "current-recording", keepListening: false, reconnecting: false } },
      actions: voiceActions({ canStop: true, keepListeningBlockedReason: "saved_recording_pending" }),
      recordingRecovery: recordingRecovery() };
    const { store, sheet } = await renderSheet(native);
    expect(within(sheet).getAllByText(/^Resolve saved dictation first/u)).toHaveLength(1);
    expect(within(sheet).getByText("Resolve saved dictation first to enable Keep listening for the current recording.")).toBeInTheDocument();
    expect(within(sheet).queryByText("Resolve saved dictation first to start with Keep listening.")).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Start new recording" })).toBeNull();
    store.dispose();
  });
  it("chooses a target without saving an unavailable pin and retains older admission", async () => {
    navigate(threadPath("long"));
    const saved = recordingRecovery({ stage: "admitting", hasUnrecognizedAudio: false, admission: {
      mutationId: "50000000-0000-4000-8000-000000000001", status: "reconciling", cancelled: false } });
    const native = { ...ready({ pinDefaultVoiceThread: true, voiceThreadId: "offline" }), recordingRecovery: saved };
    const { fake, store, sheet, onOpenChange } = await renderSheet(native);
    fake.plugin.startManualListen.mockResolvedValue({ ...native, stateRevision: 3 });
    fireEvent.click(within(sheet).getByRole("button", { name: "Start new recording" }));
    const picker = await screen.findByRole("dialog", { name: "Choose target thread" });
    expect(picker).toHaveAccessibleDescription("Choose a thread and start recording.");
    expect(within(picker).queryByRole("button", { name: "Offline review" })).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: "Daily standup notes" }));
    await waitFor(() => expect(fake.plugin.startManualListen).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      threadId: "standup", threadTitle: "Daily standup notes" }));
    expect(patches(fake)).toEqual([]);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(store.getSnapshot().native?.recordingRecovery).toEqual(saved);
    store.dispose();
  });
});
