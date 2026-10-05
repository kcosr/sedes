// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { NativeVoiceStore } from "./NativeVoiceStore.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";
import { fakeVoicePlugin, recordingRecovery, VOICE_CONNECTION, voiceActions, voiceSettings, voiceSnapshot } from "./native-voice-test-fixture.js";
import { inputDeviceLabels, VoiceSettingsPage } from "./VoiceSettingsPage.js";

const thread = (id: string, title: string) => ({ id, title: { text: title }, available: true, inventoryState: "active" }) as unknown as NormalizedApplicationThreadSummary;
const application = { snapshot: { threads: [thread("long", "T".repeat(600)), thread("untitled", ""), thread("named", "Release review")] } };
const applicationStore = { subscribe: () => () => undefined, getSnapshot: () => application } as unknown as ApplicationClientStore;
const actions = voiceActions();
async function renderPage(state: NativeVoiceState | Error, setup?: (fake: ReturnType<typeof fakeVoicePlugin>) => void) {
  const fake = fakeVoicePlugin();
  if (state instanceof Error) fake.plugin.setConnection.mockRejectedValue(state);
  else {
    fake.plugin.setConnection.mockResolvedValue(state);
    fake.plugin.getState.mockResolvedValue(state);
    fake.plugin.refreshSpeechCatalog.mockResolvedValue(state);
  }
  setup?.(fake);
  const store = new NativeVoiceStore(fake.asPlugin, VOICE_CONNECTION, () => undefined);
  const view = render(<VoiceSettingsPage store={store} applicationStore={applicationStore} />);
  await act(async () => { await store.initialize(); });
  return { fake, store, view };
}
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  Object.assign(HTMLElement.prototype, { scrollIntoView: vi.fn() });
});
afterEach(() => {
  cleanup();
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
  localStorage.clear();
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: null })); });
});

describe("voice settings page", () => {
  it("saves the long dictation limit in whole minutes and rejects values outside one minute through one day", async () => {
    const native = voiceSnapshot();
    const { fake, store } = await renderPage(native, fake => fake.plugin.updateSettings.mockResolvedValue({ ...native,
      stateRevision: 2, settingsRevision: 1, settings: { ...native.settings, longDictationTimeoutMs: 120_000 } }));
    const limit = screen.getByRole("spinbutton", { name: "Long dictation timeout (minutes)" });
    const save = screen.getByRole("button", { name: "Save Long dictation timeout (minutes)" });
    expect(limit).toHaveValue(60);
    for (const value of ["0", "1441", "1.5", ""]) {
      fireEvent.change(limit, { target: { value } });
      fireEvent.click(save);
      expect(limit).toHaveAccessibleDescription(/Enter a whole number from 1 to 1440\./);
    }
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    fireEvent.change(limit, { target: { value: "2" } });
    fireEvent.click(save);
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      expectedRevision: 0, patch: { longDictationTimeoutMs: 120_000 } }));
    await waitFor(() => expect(save).toBeDisabled());
    expect(limit).toHaveValue(2);
    store.dispose();
  });
  it.each(["capture", "saved-recognition"])("locks recognition configuration during %s while keeping Audio mode available", async work => {
    const active = { id: "interaction", threadId: "named", threadTitle: "Release review", eventKind: "manual", automatic: false,
      recognitionThreadId: "named", recognitionThreadTitle: "Release review", recording: { id: "recording", keepListening: true, reconnecting: false } };
    const { store } = await renderPage(voiceSnapshot({ phase: work === "capture" ? "listening" : "recognizing",
      settings: voiceSettings({ audioMode: "response", speechProvider: "server", speechEndpoint: "https://voice.test/v1" }), active: work === "capture" ? active : null,
      recordingRecovery: work === "saved-recognition" ? recordingRecovery({ stage: "recognizing", canRetryRecognition: false }) : null }));
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Speech API endpoint" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Manage speech credential" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Recognition model" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Microphone input" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Long dictation timeout (minutes)" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Recognition result timeout (ms)" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Audio mode" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Speech model" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Keep listening by default" })).toBeEnabled();
    store.dispose();
  });
  it("keeps ready saved dictation available in settings while Off with revision-bound Send and Discard", async () => {
    const saved = recordingRecovery({ revision: 8, stage: "ready", hasUnrecognizedAudio: false, canRetryRecognition: false,
      canSend: true, canCopyRecognizedText: true });
    const native = voiceSnapshot({ recordingRecovery: saved });
    const { fake, store } = await renderPage(native, fake => fake.plugin.sendRecoveredRecording.mockResolvedValue({ ...native, stateRevision: 2,
      recordingRecovery: { ...saved, revision: 9, stage: "admitting", canSend: false } }));
    expect(screen.getByRole("heading", { name: "Ready to send · Release review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy recognized text" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send saved dictation" }));
    await waitFor(() => expect(fake.plugin.sendRecoveredRecording).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      recordingId: saved.recordingId, expectedRecoveryRevision: 8, acknowledgeIncomplete: false }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard saved dictation" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Discard saved dictation" }));
    await waitFor(() => expect(fake.plugin.discardRecording).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      recordingId: saved.recordingId, expectedRecoveryRevision: 9 }));
    store.dispose();
  });
  it("offers explicit client reconnect while the native voice binding still exists", async () => {
    const { fake, store } = await renderPage(voiceSnapshot({ clientConnectionToken: null, readiness: "connecting" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry client connection" }));
    await waitFor(() => expect(fake.plugin.setConnection).toHaveBeenLastCalledWith({ ...VOICE_CONNECTION, reconnect: true }));
    store.dispose();
  });
  it("offers storage retry while Off without requiring a missing client connection", async () => {
    const { fake, store } = await renderPage(voiceSnapshot({ readiness: "storageUnavailable", phase: "error" }));
    expect(screen.getByRole("status")).toHaveTextContent("Recording storage is unavailable. Retry the voice connection.");
    fireEvent.click(screen.getByRole("button", { name: "Retry voice connection" }));
    await waitFor(() => expect(fake.plugin.setConnection).toHaveBeenLastCalledWith({ ...VOICE_CONNECTION, reconnect: true }));
    store.dispose();
  });
  it("shows connecting while native hydrates, then the unavailable state with Retry", async () => {
    const fake = fakeVoicePlugin();
    let fail!: (error: Error) => void;
    fake.plugin.setConnection.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const store = new NativeVoiceStore(fake.asPlugin, VOICE_CONNECTION, () => undefined);
    render(<VoiceSettingsPage store={store} applicationStore={applicationStore} />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting voice to this server…");
    const initialized = store.initialize();
    await waitFor(() => expect(fake.plugin.setConnection).toHaveBeenCalled());
    await act(async () => { fail(new Error("Server unavailable")); await initialized; });
    expect(screen.getByText("Server unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry voice connection" })).toBeEnabled();
    store.dispose();
  });
  it("discards or resumes a pending input from the recovery list without a confirmation step", async () => {
    const discarded = "50000000-0000-4000-8000-000000000001", resumed = "50000000-0000-4000-8000-000000000002";
    const remaining = { mutationId: resumed, threadId: "long", status: "uncertain", cancelled: false } as const;
    const { fake, store } = await renderPage(voiceSnapshot({ recovery: [{ mutationId: discarded, threadId: "named", status: "uncertain", cancelled: true }, remaining] }),
      fake => { fake.plugin.discardInput.mockResolvedValue(voiceSnapshot({ stateRevision: 2, recovery: [remaining] })); });
    expect(screen.getAllByRole("button", { name: "Discard" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[0]!);
    await waitFor(() => expect(fake.plugin.discardInput).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, mutationId: discarded }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Release review")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Resume input" }));
    await waitFor(() => expect(fake.plugin.resumeInput).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, mutationId: resumed }));
    store.dispose();
  });
  it.each(["manual", "response"])("enables voice through Audio mode in %s only once speech setup is complete", async audioMode => {
    const { fake, store } = await renderPage(voiceSnapshot({ settings: voiceSettings({ sttModel: "" }) }));
    expect(screen.queryByRole("button", { name: "Enable voice" })).toBeNull();
    expect(screen.getByRole("option", { name: "Manual" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Response" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Audio mode" })).toHaveAccessibleDescription("Add a speech credential below.");
    fireEvent.change(screen.getByRole("combobox", { name: "Audio mode" }), { target: { value: audioMode } });
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    expect(fake.plugin.refreshSpeechCatalog).not.toHaveBeenCalled();
    const configured = voiceSnapshot({ stateRevision: 2, settingsRevision: 1, settings: voiceSettings({ speechProvider: "server", speechEndpoint: "https://voice.test/v1" }), speech: { credentialConfigured: true, catalogStatus: "idle", catalog: null, error: null } });
    fake.plugin.getState.mockResolvedValue(configured);
    fake.plugin.refreshSpeechCatalog.mockResolvedValue(configured);
    act(() => fake.emit("settingsChanged", configured));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Audio mode" })).toBeEnabled());
    expect(screen.getByRole("option", { name: "Manual" })).toBeEnabled();
    expect(screen.getByRole("option", { name: "Response" })).toBeEnabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Audio mode" }), { target: { value: audioMode } });
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 1, patch: { audioMode } }));
    store.dispose();
  });
  it("keeps activation unavailable with a saved credential until the endpoint and models are configured", async () => {
    const native = voiceSnapshot({ settings: voiceSettings({ speechProvider: "server", speechEndpoint: "", ttsVoice: "" }),
      speech: { credentialConfigured: true, catalogStatus: "idle", catalog: null, error: null } });
    const { fake, store } = await renderPage(native);
    expect(screen.getByRole("option", { name: "Manual" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Audio mode" })).toHaveAccessibleDescription("Add a speech endpoint below.");
    expect(fake.plugin.refreshSpeechCatalog).not.toHaveBeenCalled();
    act(() => fake.emit("settingsChanged", { ...native, stateRevision: 2, settings: { ...native.settings, speechEndpoint: "https://voice.test/v1" } }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Audio mode" })).toBeEnabled());
    expect(screen.getByRole("option", { name: "Response" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Audio mode" })).toHaveAccessibleDescription("Choose speech models and a voice below.");
    store.dispose();
  });
  it("keeps Show voice bar when off on this device, without a native write", async () => {
    const { fake, store } = await renderPage(voiceSnapshot());
    const toggle = screen.getByRole("switch", { name: "Show voice bar when off" });
    expect(toggle).toHaveAccessibleDescription("Keep a dimmed bar under the composer.");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(Object.entries(localStorage)).toEqual([[`sedes-voice-bar-when-off:${JSON.stringify(Object.values(VOICE_CONNECTION))}`, "true"]]);
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    store.dispose();
  });
  it("resumes voice with the refreshed native audio mode rather than the rendered one", async () => {
    const { fake, store } = await renderPage(voiceSnapshot({ settings: voiceSettings({ audioMode: "response", speechProvider: "server", speechEndpoint: "https://voice.test/v1" }), actions: { ...actions, canResume: true } }));
    fake.plugin.getState.mockResolvedValue(voiceSnapshot({ stateRevision: 2, settingsRevision: 4, settings: voiceSettings({ audioMode: "manual", speechProvider: "server", speechEndpoint: "https://voice.test/v1" }), actions: { ...actions, canResume: true } }));
    fireEvent.click(screen.getByRole("button", { name: "Resume voice" }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 4, patch: { audioMode: "manual" } }));
    store.dispose();
  });
  it("lists recent distinct native errors and clears them on this device", async () => {
    const error = (message: string) => ({ code: message, message });
    const { fake, store } = await renderPage(voiceSnapshot({ errors: [error("A"), error("B"), error("B"), error("C"), error("D")] }));
    const alert = screen.getByRole("alert");
    expect(within(alert).getAllByRole("listitem").map(item => item.textContent)).toEqual(["D", "C", "B"]);
    fireEvent.click(within(alert).getByRole("button", { name: "Clear errors" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    act(() => fake.emit("stateChanged", voiceSnapshot({ stateRevision: 2, errors: [error("B"), error("B"), error("C"), error("D"), error("E")] })));
    expect(screen.getByRole("alert")).toHaveTextContent("E");
    store.dispose();
  });
  it("labels the default voice thread control with its choice and saves bridge-safe titles", async () => {
    const { fake, store } = await renderPage(voiceSnapshot());
    expect(screen.getByRole("switch", { name: "Only play from default voice thread" })).toHaveAccessibleDescription("Requires a default voice thread.");
    fireEvent.click(screen.getByRole("button", { name: "Default voice thread Choose thread" }));
    expect(await screen.findByRole("dialog", { name: "Default voice thread" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Voice threads" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(list).getByRole("button", { name: "T".repeat(600) }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledTimes(1));
    expect(fake.plugin.updateSettings.mock.lastCall).toEqual([{ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { voiceThreadId: "long", voiceThreadTitle: "T".repeat(512) } }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Default voice thread Choose thread" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Default voice thread Choose thread" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "Voice threads" })).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledTimes(2));
    expect(fake.plugin.updateSettings.mock.lastCall).toEqual([{ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { voiceThreadId: "untitled", voiceThreadTitle: null } }]);
    act(() => fake.emit("settingsChanged", voiceSnapshot({ stateRevision: 3, settingsRevision: 2, settings: voiceSettings({ voiceThreadId: "untitled", voiceThreadTitle: null }) })));
    expect(screen.getByRole("button", { name: "Default voice thread Untitled thread" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Only play from default voice thread" })).toHaveAccessibleDescription("Limit automatic playback to the default voice thread above.");
    // The saved default voice thread leads the picker under its label; the rest keep their order without a duplicate.
    fireEvent.click(screen.getByRole("button", { name: "Default voice thread Untitled thread" }));
    const pinned = await screen.findByRole("list", { name: "Voice threads" });
    expect(within(pinned).getAllByRole("listitem").map(item => item.textContent)).toEqual(["Current default voice threadUntitled thread", "T".repeat(600), "Release review"]);
    expect(within(pinned).getByRole("button", { name: "Untitled thread" })).toHaveAccessibleDescription("Current default voice thread");
    store.dispose();
  });
  it("saves the default recording pin without changing the playback filter", async () => {
    const native = voiceSnapshot({ settings: voiceSettings({ onlyVoiceThread: true }) });
    const { fake, store } = await renderPage(native, fake => fake.plugin.updateSettings.mockResolvedValue({ ...native, stateRevision: 2, settingsRevision: 1,
      settings: { ...native.settings, pinDefaultVoiceThread: true } }));
    const pin = screen.getByRole("switch", { name: "Pin default voice thread" });
    expect(pin).not.toBeChecked();
    expect(pin).toHaveAccessibleDescription("Use this as the initial recording target while viewing other threads.");
    fireEvent.click(pin);
    await waitFor(() => expect(pin).toBeChecked());
    expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { pinDefaultVoiceThread: true } });
    expect(screen.getByRole("switch", { name: "Only play from default voice thread" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Only play from default voice thread" })).toHaveAccessibleDescription("Requires a default voice thread.");
    store.dispose();
  });
  it("saves speech cleanup on this device and reflects the native setting", async () => {
    const native = voiceSnapshot();
    const { fake, store } = await renderPage(native, fake => fake.plugin.updateSettings.mockResolvedValue({ ...native,
      stateRevision: 2, settingsRevision: 1, settings: { ...native.settings, cleanSpeechText: false } }));
    const toggle = screen.getByRole("switch", { name: "Clean up formatting for speech" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { cleanSpeechText: false } });
    store.dispose();
  });
  it.each([false, true])("round-trips the future Keep listening preference while the current recording stays %s", async keepListening => {
    let native = voiceSnapshot({ phase: "listening", settings: voiceSettings({ audioMode: "response" }), active: {
      id: "interaction", threadId: "named", threadTitle: "Release review", eventKind: "manual", automatic: false,
      recognitionThreadId: "named", recognitionThreadTitle: "Release review", recording: { id: "recording", keepListening, reconnecting: false },
    } });
    const { fake, store } = await renderPage(native, fake => {
      fake.plugin.getState.mockImplementation(async () => native);
      vi.mocked(fake.asPlugin.updateSettings).mockImplementation(async ({ patch }) => (native = { ...native,
        stateRevision: native.stateRevision + 1, settingsRevision: native.settingsRevision + 1, settings: { ...native.settings, ...patch } }));
    });
    const preference = screen.getByRole("switch", { name: "Keep listening by default" });
    expect(preference).not.toBeChecked();
    expect(preference).toBeEnabled();
    expect(preference).toHaveAccessibleDescription("Use Keep listening for new manual and auto-listen recordings. The ∞ control changes only the current recording.");
    fireEvent.click(preference);
    await waitFor(() => expect(preference).toBeChecked());
    await waitFor(() => expect(preference).toBeEnabled());
    expect(store.getSnapshot().native?.active?.recording?.keepListening).toBe(keepListening);
    fireEvent.click(preference);
    await waitFor(() => expect(preference).not.toBeChecked());
    expect(vi.mocked(fake.asPlugin.updateSettings).mock.calls.map(([input]) => input)).toEqual([
      { expectedConnectionGeneration: 1, expectedRevision: 0, patch: { keepListeningByDefault: true } },
      { expectedConnectionGeneration: 1, expectedRevision: 1, patch: { keepListeningByDefault: false } },
    ]);
    expect(store.getSnapshot().native?.active?.recording?.keepListening).toBe(keepListening);
    expect(fake.plugin.setKeepListening).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Auto-listen" })).toBeChecked();
    store.dispose();
  });
  it("opens credential management with only a connection fence and never creates a web password field", async () => {
    const { fake, store } = await renderPage(voiceSnapshot());
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage speech credential" }));
    await waitFor(() => expect(fake.plugin.openSpeechCredentialDialog).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1 }));
    store.dispose();
  });
  it("switches providers with an explicit endpoint and model reset", async () => {
    const { fake, store } = await renderPage(voiceSnapshot());
    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "server" } });
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 0,
      patch: { speechProvider: "server", speechEndpoint: "", sttModel: "", ttsModel: "", ttsVoice: "", ttsSpeed: 1 } }));
    store.dispose();
  });
  it("checks catalog freshness on opening, keeps settings usable during refresh, and preserves cached options on failure", async () => {
    const native = voiceSnapshot({ settings: voiceSettings({ speechProvider: "server", speechEndpoint: "https://speech.test/v1", ttsModel: "kokoro", ttsVoice: "af_heart" }),
      speech: { credentialConfigured: true, catalogStatus: "ready", error: null,
        catalog: { source: "server", sttModels: ["parakeet"], ttsModels: ["kokoro"], voices: ["af_heart", "af_sky"], speed: { min: 0.5, max: 2 }, formats: ["pcm"] } } });
    const loading = { ...native, stateRevision: 2, speech: { ...native.speech, catalogStatus: "loading" as const } };
    const { fake, store, view } = await renderPage(native, fake => fake.plugin.refreshSpeechCatalog.mockResolvedValue(loading));
    expect(fake.plugin.refreshSpeechCatalog).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, force: false });
    expect(screen.getByRole("button", { name: "Refresh models and voices" })).toHaveTextContent("Refreshing…");
    expect(screen.getByRole("button", { name: "Refresh models and voices" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Audio mode" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Speech voice" })).toBeEnabled();
    const failed = { ...native, stateRevision: 3, speech: { ...native.speech, catalogStatus: "error" as const, error: "Couldn’t refresh." } };
    act(() => fake.emit("stateChanged", failed));
    expect(screen.getByText("Couldn’t refresh.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Speech voice" }));
    expect(await screen.findByRole("option", { name: "af_sky" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "af_heart" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search speech voice options" }), { key: "Escape" });
    view.rerender(<VoiceSettingsPage store={store} applicationStore={applicationStore} />);
    expect(fake.plugin.refreshSpeechCatalog).toHaveBeenCalledTimes(1);
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    fake.plugin.refreshSpeechCatalog.mockResolvedValue({ ...loading, stateRevision: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh models and voices" }));
    await waitFor(() => expect(fake.plugin.refreshSpeechCatalog).toHaveBeenLastCalledWith({ expectedConnectionGeneration: 1, force: true }));
    expect(fake.plugin.refreshSpeechCatalog).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Speech voice" })).toBeEnabled());
    view.unmount();
    render(<VoiceSettingsPage store={store} applicationStore={applicationStore} />);
    await waitFor(() => expect(fake.plugin.refreshSpeechCatalog).toHaveBeenCalledTimes(3));
    expect(fake.plugin.refreshSpeechCatalog).toHaveBeenLastCalledWith({ expectedConnectionGeneration: 1, force: false });
    store.dispose();
  });
  it("does not overwrite newer native settings with a late catalog refresh reply", async () => {
    const native = voiceSnapshot({ speech: { credentialConfigured: true, catalogStatus: "ready", catalog: null, error: null } });
    let resolve!: (value: NativeVoiceState) => void;
    const { fake, store } = await renderPage(native, fake => fake.plugin.refreshSpeechCatalog.mockImplementationOnce(() => new Promise(done => { resolve = done; })));
    expect(screen.getByRole("combobox", { name: "Audio mode" })).toBeEnabled();
    const newer = { ...native, stateRevision: 3, settingsRevision: 1, settings: { ...native.settings, ttsVoice: "nova" } };
    act(() => fake.emit("settingsChanged", newer));
    await act(async () => { resolve({ ...native, stateRevision: 2 }); });
    expect(screen.getByRole("combobox", { name: "Speech voice" })).toHaveTextContent("nova");
    expect(fake.plugin.refreshSpeechCatalog).toHaveBeenCalledTimes(1);
    store.dispose();
  });
  it("preserves the last action error when reopening settings checks catalog freshness", async () => {
    const native = voiceSnapshot({ speech: { credentialConfigured: true, catalogStatus: "ready", catalog: null, error: null } });
    const { fake, store, view } = await renderPage(native);
    fake.plugin.updateSettings.mockRejectedValue(new Error("Could not save voice."));
    await act(async () => { await store.update({ ttsVoice: "nova" }).catch(() => undefined); });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save voice.");
    view.unmount();
    render(<VoiceSettingsPage store={store} applicationStore={applicationStore} />);
    await waitFor(() => expect(fake.plugin.refreshSpeechCatalog).toHaveBeenCalledTimes(2));
    expect(fake.plugin.refreshSpeechCatalog).toHaveBeenLastCalledWith({ expectedConnectionGeneration: 1, force: false });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save voice.");
    store.dispose();
  });
  it("keeps model IDs editable when catalog discovery fails and validates advertised speed limits", async () => {
    const native = voiceSnapshot({ settings: voiceSettings({ speechProvider: "server", speechEndpoint: "https://speech.test/v1", ttsModel: "custom-tts" }),
      speech: { credentialConfigured: false, catalogStatus: "ready", error: null,
        catalog: { source: "server", sttModels: ["custom-stt"], ttsModels: ["custom-tts"], voices: ["local-voice"], speed: { min: 0.5, max: 2 }, formats: ["pcm"] } } });
    const { fake, store } = await renderPage(native, fake => fake.plugin.updateSettings.mockResolvedValue(native));
    fireEvent.click(screen.getByRole("combobox", { name: "Recognition model" }));
    fireEvent.click(await screen.findByRole("option", { name: "Custom…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Recognition model" }), { target: { value: "my-new-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Recognition model" }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { sttModel: "my-new-model" } }));
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Speech speed" })).toBeEnabled());
    fireEvent.change(screen.getByRole("spinbutton", { name: "Speech speed" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Speech speed" }));
    expect(screen.getByText("Enter a number from 0.5 to 2.")).toBeInTheDocument();
    expect(fake.plugin.updateSettings).toHaveBeenCalledTimes(1);
    act(() => fake.emit("stateChanged", { ...native, stateRevision: 2, speech: { ...native.speech, catalogStatus: "error", catalog: null, error: "Discovery failed." } }));
    expect(screen.getByRole("combobox", { name: "Speech model" })).toHaveTextContent("custom-tts");
    expect(screen.getByText("Discovery failed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Speech model" }));
    fireEvent.click(await screen.findByRole("option", { name: "Custom…" }));
    expect(screen.getByRole("textbox", { name: "Speech model" })).toHaveValue("custom-tts");
    store.dispose();
  });
  it("opens discovered voices in a touch sheet, searches without changing the setting, and saves the chosen voice", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    let native = voiceSnapshot({ settings: voiceSettings({ speechProvider: "server", speechEndpoint: "https://speech.test/v1", ttsModel: "kokoro-local", ttsVoice: "af_heart" }),
      speech: { credentialConfigured: true, catalogStatus: "ready", error: null,
        catalog: { source: "server", sttModels: ["parakeet-local"], ttsModels: ["kokoro-local"], voices: ["af_heart", "af_sky"], speed: { min: 0.5, max: 2 }, formats: ["pcm"] } } });
    const { fake, store } = await renderPage(native, fake => {
      fake.plugin.getState.mockImplementation(async () => native);
      fake.plugin.updateSettings.mockImplementation(async (input?: { patch: Partial<NativeVoiceState["settings"]> }) => {
        if (!input) throw new Error("Missing settings update");
        native = { ...native, stateRevision: 2, settingsRevision: 1, settings: { ...native.settings, ...input.patch } };
        return native;
      });
    });
    expect(document.querySelector("datalist, input[list]")).toBeNull();
    const trigger = screen.getByRole("combobox", { name: "Speech voice" });
    await user.pointer([{ keys: "[TouchA>]", target: trigger }, { keys: "[/TouchA]", target: trigger }]);
    const dialog = screen.getByRole("dialog", { name: "Choose speech voice" });
    const search = within(dialog).getByRole("combobox", { name: "Search speech voice options" });
    expect(search).not.toHaveFocus();
    expect(dialog).toHaveAttribute("data-layout", "sheet");
    expect(within(dialog).getByRole("option", { name: "af_heart" })).toHaveAttribute("aria-selected", "true");
    await user.type(search, "sky");
    expect(within(dialog).queryByRole("option", { name: "af_heart" })).toBeNull();
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("option", { name: "af_sky" }));
    await waitFor(() => expect(trigger).toHaveTextContent("af_sky"));
    expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { ttsVoice: "af_sky" } });
    expect(screen.queryByRole("dialog", { name: "Choose speech voice" })).toBeNull();
    store.dispose();
  });
  it.each([false, true])("cancels custom entry without saving and keeps a failed custom save editable (touch=%s)", async touch => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: touch }));
    const { fake, store } = await renderPage(voiceSnapshot());
    await user.click(screen.getByRole("combobox", { name: "Speech model" }));
    await user.click(screen.getByRole("option", { name: "Custom…" }));
    const input = screen.getByRole("textbox", { name: "Speech model" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(input).toHaveAccessibleDescription("Enter an ID.");
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    await user.type(input, "custom-model");
    await user.click(screen.getByRole("button", { name: "Cancel custom speech model" }));
    expect(screen.getByRole("combobox", { name: "Speech model" })).toHaveTextContent("gpt-4o-mini-tts");
    expect(screen.getByRole("combobox", { name: "Speech model" })).toHaveFocus();
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole("combobox", { name: "Speech model" }));
    await user.click(screen.getByRole("option", { name: "Custom…" }));
    expect(screen.getByRole("textbox", { name: "Speech model" })).toHaveValue("gpt-4o-mini-tts");
    fake.plugin.updateSettings.mockRejectedValue(new Error("Could not save model."));
    await user.clear(screen.getByRole("textbox", { name: "Speech model" }));
    await user.type(screen.getByRole("textbox", { name: "Speech model" }), "custom-model");
    await user.click(screen.getByRole("button", { name: "Save Speech model" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Speech model" })).toHaveAccessibleDescription("Could not save model."));
    expect(screen.getByRole("textbox", { name: "Speech model" })).toHaveValue("custom-model");
    store.dispose();
  });
  it("tells microphones with the same product name apart", async () => {
    const devices = [{ id: "1", label: "Pixel 7", type: 15 }, { id: "2", label: "Pixel 7", type: 15 }, { id: "3", label: "Pixel 7", type: 7 }, { id: "4", label: "USB mic", type: 11 }, { id: "5", label: " ", type: 99 }];
    expect([...inputDeviceLabels(devices).values()]).toEqual(["Pixel 7 (Built-in) #1", "Pixel 7 (Built-in) #2", "Pixel 7 (Bluetooth)", "USB mic", "Microphone"]);
    const { store } = await renderPage(voiceSnapshot(), fake => { fake.plugin.listInputDevices.mockResolvedValue({ devices, selectedId: null }); });
    const select = await screen.findByRole("combobox", { name: "Microphone input" });
    await waitFor(() => expect(within(select).getAllByRole("option").map(option => option.textContent)).toEqual(
      ["System default", "Pixel 7 (Built-in) #1", "Pixel 7 (Built-in) #2", "Pixel 7 (Bluetooth)", "USB mic", "Microphone"]));
    store.dispose();
  });
});
