// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { NativeVoiceStore } from "./NativeVoiceStore.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";
import { fakeVoicePlugin, VOICE_CONNECTION, voiceSettings, voiceSnapshot } from "./native-voice-test-fixture.js";
import { inputDeviceLabels, VoiceSettingsPage } from "./VoiceSettingsPage.js";

const thread = (id: string, title: string) => ({ id, title: { text: title }, available: true, inventoryState: "active" }) as unknown as NormalizedApplicationThreadSummary;
const application = { snapshot: { threads: [thread("long", "T".repeat(600)), thread("untitled", ""), thread("named", "Release review")] } };
const applicationStore = { subscribe: () => () => undefined, getSnapshot: () => application } as unknown as ApplicationClientStore;
const actions = { canStart: false, canStop: false, canSkip: false, canRetarget: false, canResume: false };
async function renderPage(state: NativeVoiceState | Error, setup?: (fake: ReturnType<typeof fakeVoicePlugin>) => void) {
  const fake = fakeVoicePlugin();
  if (state instanceof Error) fake.plugin.setConnection.mockRejectedValue(state);
  else { fake.plugin.setConnection.mockResolvedValue(state); fake.plugin.getState.mockResolvedValue(state); }
  setup?.(fake);
  const store = new NativeVoiceStore(fake.asPlugin, VOICE_CONNECTION, () => undefined);
  const view = render(<VoiceSettingsPage store={store} applicationStore={applicationStore} />);
  await act(async () => { await store.initialize(); });
  return { fake, store, view };
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: null })); });
});

describe("voice settings page", () => {
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
  it("enables voice in Response only once an adapter URL is saved", async () => {
    const { fake, store } = await renderPage(voiceSnapshot());
    expect(screen.getByRole("button", { name: "Enable voice" })).toBeDisabled();
    act(() => fake.emit("settingsChanged", voiceSnapshot({ stateRevision: 2, settingsRevision: 1, settings: voiceSettings({ adapterUrl: "https://voice.test" }) })));
    fake.plugin.getState.mockResolvedValue(voiceSnapshot({ stateRevision: 2, settingsRevision: 1, settings: voiceSettings({ adapterUrl: "https://voice.test" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Enable voice" }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 1, patch: { audioMode: "response" } }));
    store.dispose();
  });
  it("keeps Show voice bar when off on this device, without a native write", async () => {
    const { fake, store } = await renderPage(voiceSnapshot());
    const toggle = screen.getByRole("switch", { name: "Show voice bar when off" });
    expect(toggle).toHaveAccessibleDescription("Keep a dimmed bar under the composer while Audio mode is Off. Otherwise Off hides it.");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(Object.entries(localStorage)).toEqual([[`sedes-voice-bar-when-off:${JSON.stringify(Object.values(VOICE_CONNECTION))}`, "true"]]);
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    store.dispose();
  });
  it("resumes voice with the refreshed native audio mode rather than the rendered one", async () => {
    const { fake, store } = await renderPage(voiceSnapshot({ settings: voiceSettings({ audioMode: "response", adapterUrl: "https://voice.test" }), actions: { ...actions, canResume: true } }));
    fake.plugin.getState.mockResolvedValue(voiceSnapshot({ stateRevision: 2, settingsRevision: 4, settings: voiceSettings({ audioMode: "manual", adapterUrl: "https://voice.test" }), actions: { ...actions, canResume: true } }));
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
  it("labels the Voice thread control with its choice and saves bridge-safe titles", async () => {
    const { fake, store } = await renderPage(voiceSnapshot());
    fireEvent.click(screen.getByRole("button", { name: "Voice thread Choose thread" }));
    const list = await screen.findByRole("list", { name: "Voice threads" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(list).getByRole("button", { name: "T".repeat(600) }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledTimes(1));
    expect(fake.plugin.updateSettings.mock.lastCall).toEqual([{ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { voiceThreadId: "long", voiceThreadTitle: "T".repeat(512) } }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Voice thread Choose thread" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Voice thread Choose thread" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "Voice threads" })).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledTimes(2));
    expect(fake.plugin.updateSettings.mock.lastCall).toEqual([{ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { voiceThreadId: "untitled", voiceThreadTitle: null } }]);
    act(() => fake.emit("settingsChanged", voiceSnapshot({ stateRevision: 3, settingsRevision: 2, settings: voiceSettings({ voiceThreadId: "untitled", voiceThreadTitle: null }) })));
    expect(screen.getByRole("button", { name: "Voice thread Untitled thread" })).toBeInTheDocument();
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
