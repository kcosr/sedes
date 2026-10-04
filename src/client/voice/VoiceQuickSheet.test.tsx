// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate, settingsPath } from "../app/router.js";
import { NativeVoiceStore } from "./NativeVoiceStore.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";
import { fakeVoicePlugin, VOICE_CONNECTION, voiceSettings, voiceSnapshot } from "./native-voice-test-fixture.js";
import { useVoiceState } from "./VoiceProvider.js";
import { VoiceQuickSheet } from "./VoiceQuickSheet.js";

const adapterUrl = "https://voice.test";
const actions = { canStart: true, canStop: false, canSkip: false, canRetarget: false, canResume: false };
const ready = (settings: Parameters<typeof voiceSettings>[0] = {}) => voiceSnapshot({ phase: "idle", ready: true, readiness: "ready", actions,
  settings: voiceSettings({ audioMode: "response", adapterUrl, ...settings }) });
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
  render(host ? host(store) : <VoiceQuickSheet store={store} open onOpenChange={onOpenChange} />);
  await act(async () => { await store.initialize(); });
  return { fake, store, onOpenChange, sheet: screen.queryByRole("dialog", { name: "Voice" })! };
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
beforeEach(() => { navigate("/", { replace: true }); });
afterEach(() => { cleanup(); });

describe("voice quick sheet", () => {
  it("names the mode control and every quick setting, with the current values, and leaves the Voice thread to Settings", async () => {
    const { store, sheet } = await renderSheet(ready({ voiceThreadId: "standup", voiceThreadTitle: "Daily standup notes", followComposerMode: true }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Ready");
    expect(within(sheet).getByRole("radiogroup", { name: "Audio mode" })).toBeInTheDocument();
    expect(within(sheet).getByRole("radio", { name: "Response" })).toHaveAttribute("aria-checked", "true");
    expect(sheet).toHaveTextContent("Response speaks selected notices and responses.");
    expect(within(sheet).getByRole("switch", { name: "Auto-listen" })).toHaveAccessibleDescription("Eligible notifications reopen the mic");
    expect(within(sheet).getByRole("switch", { name: "Auto-listen" })).toBeChecked();
    expect(within(sheet).queryByRole("button", { name: "Voice thread" })).toBeNull();
    expect(sheet).not.toHaveTextContent("Daily standup notes");
    expect(within(sheet).getByRole("switch", { name: "Follow composer mode" })).toHaveAccessibleDescription("Use its Steer or Queue choice");
    expect(within(sheet).getByRole("switch", { name: "Follow composer mode" })).toBeChecked();
    expect(within(sheet).getByRole("button", { name: "All voice settings" })).toBeEnabled();
    store.dispose();
  });
  it("reports readiness while a mode is on but voice is not ready", async () => {
    const { store, sheet } = await renderSheet(voiceSnapshot({ phase: "starting", readiness: "adapterConnecting", settings: voiceSettings({ audioMode: "manual", adapterUrl }) }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Connecting to the voice adapter…");
    expect(sheet).toHaveTextContent("Manual keeps completions silent; the mic can still open afterward.");
    store.dispose();
  });
  it("switches modes through the store and locks the control, keeping focus, while a write is pending", async () => {
    const { fake, store, sheet } = await renderSheet(ready());
    const release = holdNextWrite(fake);
    const manual = within(sheet).getByRole("radio", { name: "Manual" });
    act(() => manual.focus());
    fireEvent.click(manual);
    expect(within(sheet).getByRole("radio", { name: "Off" })).toHaveAttribute("aria-disabled", "true");
    expect(manual).toBeEnabled();
    expect(manual).toHaveFocus();
    fireEvent.click(within(sheet).getByRole("radio", { name: "Off" }));
    await release();
    await waitFor(() => expect(within(sheet).getByRole("radio", { name: "Manual" })).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(within(sheet).getByRole("radio", { name: "Off" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(within(sheet).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(within(sheet).getByRole("status")).toHaveTextContent("Voice off"));
    expect(sheet).toHaveTextContent("Off pauses voice. Pick Manual or Response to resume.");
    expect(patches(fake)).toEqual([{ audioMode: "manual" }, { audioMode: "off" }]);
    store.dispose();
  });
  it("turns voice on from Off with the chosen mode, then offers Resume when native could not start a session", async () => {
    const { fake, store, sheet } = await renderSheet(voiceSnapshot({ settings: voiceSettings({ adapterUrl }) }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Voice off");
    expect(within(sheet).queryByRole("button", { name: "Resume voice" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("radio", { name: "Manual" }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { audioMode: "manual" } }));
    // Native saved the mode but has no session; the refreshed mode is what Resume writes back.
    const paused = voiceSnapshot({ stateRevision: 5, settingsRevision: 3, readiness: "needsResume", settings: voiceSettings({ audioMode: "response", adapterUrl }), actions: { ...actions, canStart: false, canResume: true } });
    fake.plugin.getState.mockResolvedValue(paused);
    act(() => fake.emit("stateChanged", { ...paused, settings: voiceSettings({ audioMode: "manual", adapterUrl }) }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Resume voice from this screen to start a new session.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Resume voice" }));
    await waitFor(() => expect(fake.plugin.updateSettings).toHaveBeenLastCalledWith({ expectedConnectionGeneration: 1, expectedRevision: 3, patch: { audioMode: "response" } }));
    store.dispose();
  });
  it("keeps Manual and Response unavailable from Off until an adapter URL is saved", async () => {
    const { fake, store, sheet } = await renderSheet(voiceSnapshot());
    expect(within(sheet).getByRole("radio", { name: "Manual" })).toBeDisabled();
    expect(within(sheet).getByRole("radio", { name: "Response" })).toBeDisabled();
    expect(sheet).toHaveTextContent("Off pauses voice. Save an adapter URL first.");
    fireEvent.click(within(sheet).getByRole("radio", { name: "Response" }));
    expect(fake.plugin.updateSettings).not.toHaveBeenCalled();
    store.dispose();
  });
  it("flips Auto-listen from its switch and Follow composer mode from anywhere on its row", async () => {
    const { fake, store, sheet } = await renderSheet(ready());
    fireEvent.click(within(sheet).getByRole("switch", { name: "Auto-listen" }));
    await waitFor(() => expect(within(sheet).getByRole("switch", { name: "Auto-listen" })).not.toBeChecked());
    await waitFor(() => expect(within(sheet).getByRole("switch", { name: "Follow composer mode" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(within(sheet).getByText("Use its Steer or Queue choice"));
    await waitFor(() => expect(within(sheet).getByRole("switch", { name: "Follow composer mode" })).toBeChecked());
    expect(patches(fake)).toEqual([{ autoListen: false }, { followComposerMode: true }]);
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
        <VoiceQuickSheet store={store} open={open} onOpenChange={setOpen} />
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
});
