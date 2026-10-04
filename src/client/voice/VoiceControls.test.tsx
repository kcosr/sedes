// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { navigate, threadPath } from "../app/router.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";
import { disconnectedVoiceSnapshot, fakeVoicePlugin, VOICE_CONNECTION, VOICE_IDENTITY, voiceSettings, voiceSnapshot } from "./native-voice-test-fixture.js";

const voice = vi.hoisted(() => ({ fake: undefined as unknown as ReturnType<typeof fakeVoicePlugin> }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })) } }));
vi.mock("./native-voice-plugin.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./native-voice-plugin.js")>(),
  hasNativeVoice: () => true,
  nativeVoice: new Proxy({}, { get: (_target, key) => Reflect.get(voice.fake.plugin, key) }),
}));

import { useNativeVoice, VoiceProvider } from "./VoiceProvider.js";
import { VoiceControls } from "./VoiceControls.js";
import { useShowVoiceBarWhenOff } from "./voice-bar-preference.js";

type Active = NonNullable<NativeVoiceState["active"]>;
const longTitle = "L".repeat(600);
const thread = (id: string, title: string) => ({ id, title: { text: title }, available: true, inventoryState: "active" }) as unknown as NormalizedApplicationThreadSummary;
const threads = [thread("long", longTitle), thread("untitled", "  "), thread("named", "Release review"),
  { ...thread("archived", "Archived notes"), inventoryState: "archived" }, { ...thread("offline", "Offline review"), available: false }] as NormalizedApplicationThreadSummary[];
const idleActions = { canStart: true, canStop: false, canSkip: false, canRetarget: false, canResume: false };
const ready = (patch: Partial<NativeVoiceState> = {}) => voiceSnapshot({ ready: true, readiness: "ready", phase: "idle", settings: voiceSettings({ audioMode: "response" }),
  actions: idleActions, ...patch });
const item = (active: Partial<Active>): Active => ({ id: "item", eventKind: null, threadId: null, threadTitle: null, recognitionThreadId: null, recognitionThreadTitle: null, automatic: false, ...active });
const listening = (active: Partial<Active>) => ready({ phase: "listening",
  actions: { canStart: false, canStop: true, canSkip: false, canRetarget: true, canResume: false }, active: item(active) });
const speaking = (active: Partial<Active>, patch: Partial<NativeVoiceState> = {}) => ready({ phase: "speaking",
  actions: { canStart: false, canStop: true, canSkip: true, canRetarget: false, canResume: false }, active: item({ automatic: true, ...active }), ...patch });
/** Sets the device preference through its hook, as Settings → Voice does. */
function ShowWhenOff({ value }: { value: boolean }) {
  const [, setShow] = useShowVoiceBarWhenOff(useNativeVoice()!);
  useEffect(() => { setShow(value); }, [setShow, value]);
  return null;
}
function renderControls(showWhenOff?: boolean) {
  const tree = (show?: boolean) => <VoiceProvider profileId={VOICE_CONNECTION.profileId} serverOrigin={VOICE_CONNECTION.serverOrigin} identity={VOICE_IDENTITY}>
    {show === undefined ? null : <ShowWhenOff value={show} />}<VoiceControls threads={threads} /></VoiceProvider>;
  const view = render(tree(showWhenOff));
  return { ...view, setShowWhenOff: (show: boolean) => view.rerender(tree(show)) };
}
const card = () => screen.getByRole("group", { name: "Voice controls" });
/** The two visible lines, with the separator dots spaced as they read. */
const lines = () => Array.from(card().querySelectorAll(".voice-card-text > *"), line => line.textContent!.replaceAll("·", " · "));
beforeEach(() => {
  voice.fake = fakeVoicePlugin(); navigate("/", { replace: true });
  // Another tab clearing storage resets the preference to its default.
  localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null }));
});
afterEach(() => { cleanup(); });

describe("voice controls card", () => {
  it("renders no card while native voice is unavailable", async () => {
    voice.fake.plugin.setConnection.mockRejectedValue(new Error("Server unavailable"));
    renderControls();
    await waitFor(() => expect(voice.fake.plugin.setConnection).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByRole("group", { name: "Voice controls" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("renders no card while voice is off and shows it once voice is enabled", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(voiceSnapshot());
    renderControls();
    await waitFor(() => expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Voice controls" })).toBeNull();
    act(() => voice.fake.emit("stateChanged", ready({ stateRevision: 2 })));
    expect(card()).toBeInTheDocument();
    expect(card()).not.toHaveAttribute("data-off");
  });
  it("keeps a dimmed card while voice is off when the device preference asks for it", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(voiceSnapshot());
    const { setShowWhenOff } = renderControls(true);
    await screen.findByRole("group", { name: "Voice controls" });
    expect(card()).toHaveAttribute("data-off");
    expect(lines()).toEqual(["Voice off", "Tap to turn on"]);
    const mic = within(card()).getByRole("button", { name: "Start voice recording" });
    expect(mic).toBeDisabled();
    expect(mic).toHaveAttribute("title", "Voice is off");
    fireEvent.click(within(card()).getByRole("button", { name: "Open voice controls" }));
    expect(await screen.findByRole("dialog", { name: "Voice" })).toBeInTheDocument();
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    setShowWhenOff(false);
    expect(screen.queryByRole("group", { name: "Voice controls" })).toBeNull();
    // The sheet stays open over a hidden card, so choosing Off there does not close it.
    expect(screen.getByRole("dialog", { name: "Voice" })).toBeInTheDocument();
  });
  it("states readiness and the mode on the visible thread without naming it", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Ready to record", "Response · Auto-listen on"]);
    expect(card().querySelector("[data-thread]")).toBeNull();
    expect(within(card()).getByRole("button", { name: "Open voice controls" })).toHaveAccessibleDescription("Ready to record. Response · Auto-listen on");
    act(() => voice.fake.emit("stateChanged", ready({ stateRevision: 2, ready: false, readiness: "adapterConnecting",
      settings: voiceSettings({ audioMode: "manual", autoListen: false }) })));
    expect(lines()).toEqual(["Connecting to the voice adapter…", "Manual · Auto-listen off"]);
    expect(within(card()).getByRole("button", { name: "Start voice recording" })).toBeEnabled();
  });
  it("names the saved Voice thread when no thread is visible, or asks for one", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ settings: voiceSettings({ audioMode: "response", voiceThreadId: "named", voiceThreadTitle: null }) }));
    navigate("/settings/voice", { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Release review", "Response · Auto-listen on"]);
    expect(card().querySelector(".voice-card-title[data-thread]")).toHaveTextContent("Release review");
    act(() => voice.fake.emit("stateChanged", ready({ stateRevision: 2, ready: false, readiness: "notificationsConnecting" })));
    expect(lines()).toEqual(["Choose a thread", "Connecting to Sedes notifications…"]);
    expect(card().querySelector(".voice-card-title[data-empty]")).toHaveTextContent("Choose a thread");
    // Without a visible or saved thread the Mic asks for a target first.
    fireEvent.click(within(card()).getByRole("button", { name: "Start voice recording" }));
    expect(await screen.findByRole("list", { name: "Voice threads" })).toBeInTheDocument();
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
  });
  it("names the start target when the visible thread cannot take a recording, and never a missing Voice thread", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ settings: voiceSettings({ audioMode: "response", voiceThreadId: "named", voiceThreadTitle: "Release review" }) }));
    voice.fake.plugin.startManualListen.mockResolvedValue(ready({ stateRevision: 2 }));
    navigate(threadPath("archived"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Release review", "Response · Auto-listen on"]);
    expect(card().querySelector(".voice-card-title[data-thread]")).toHaveTextContent("Release review");
    fireEvent.click(within(card()).getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenCalledWith({ expectedConnectionGeneration: 1, threadId: "named", threadTitle: "Release review" }));
    // A saved Voice thread that is unavailable or deleted is not a target, so it is not named.
    for (const [index, voiceThreadId] of ["offline", "deleted"].entries()) {
      act(() => voice.fake.emit("stateChanged", ready({ stateRevision: index + 3, settings: voiceSettings({ audioMode: "response", voiceThreadId, voiceThreadTitle: "Saved title" }) })));
      expect(lines()).toEqual(["Choose a thread", "Response · Auto-listen on"]);
    }
    act(() => navigate(threadPath("offline")));
    expect(lines()).toEqual(["Choose a thread", "Response · Auto-listen on"]);
    act(() => navigate(threadPath("named")));
    expect(lines()).toEqual(["Ready to record", "Response · Auto-listen on"]);
  });
  it("opens the quick sheet from the card body", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Open voice controls" }));
    const sheet = await screen.findByRole("dialog", { name: "Voice" });
    expect(within(sheet).getByRole("radiogroup", { name: "Audio mode" })).toBeInTheDocument();
  });
  it("sends bridge-safe titles for the visible thread and explicit recording", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    voice.fake.plugin.startManualListen.mockResolvedValue(ready());
    navigate(threadPath("long"), { replace: true });
    renderControls();
    await waitFor(() => expect(voice.fake.plugin.setForegroundContext).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "long", threadTitle: "L".repeat(512) })));
    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenLastCalledWith({ expectedConnectionGeneration: 1, threadId: "long", threadTitle: "L".repeat(512) }));
    act(() => navigate(threadPath("untitled")));
    await waitFor(() => expect(voice.fake.plugin.setForegroundContext).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "untitled", threadTitle: null })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start voice recording" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenCalledTimes(2));
    expect(voice.fake.plugin.startManualListen.mock.lastCall).toEqual([{ expectedConnectionGeneration: 1, threadId: "untitled", threadTitle: undefined }]);
  });
  it("shows speech from the visible thread with the queue, and Skip and Stop reach native", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(speaking({ threadId: "named", eventKind: "turn.completed" }, { queue: { count: 2, bytes: 0, droppedCount: 0, droppedReasons: {} } }));
    voice.fake.plugin.skipCurrentPlayback.mockResolvedValue(speaking({ threadId: "named" }, { stateRevision: 2 }));
    voice.fake.plugin.stopCurrentInteraction.mockResolvedValue(ready({ stateRevision: 3 }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Speaking", "This thread · 2 queued"]);
    expect(card().querySelector(".voice-card-tile")).toHaveAttribute("data-tone", "info");
    expect(within(card()).getByRole("button", { name: "Open voice controls" })).toBeInTheDocument();
    expect(within(card()).queryByRole("button", { name: "Start voice recording" })).toBeNull();
    fireEvent.click(within(card()).getByRole("button", { name: "Skip voice playback" }));
    await waitFor(() => expect(voice.fake.plugin.skipCurrentPlayback).toHaveBeenCalledWith({ expectedConnectionGeneration: 1 }));
    await waitFor(() => expect(within(card()).getByRole("button", { name: "Stop voice interaction" })).toBeEnabled());
    expect(lines()).toEqual(["Speaking", "This thread"]);
    fireEvent.click(within(card()).getByRole("button", { name: "Stop voice interaction" }));
    await waitFor(() => expect(voice.fake.plugin.stopCurrentInteraction).toHaveBeenCalledWith({ expectedConnectionGeneration: 1 }));
    expect(await within(card()).findByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
  });
  it("names another thread's speech and labels the native event kind", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(speaking({ threadId: "named", threadTitle: "Release review", eventKind: "turn.completed" }));
    navigate(threadPath("long"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Release review", "Speaking · Response"]);
    expect(card().querySelector(".voice-card-title[data-thread]")).toHaveTextContent("Release review");
    const kinds = [["turn.progress", "Speaking · Progress"], ["question.requested", "Speaking · Question"], ["automation.started", "Speaking · Automation"],
      ["future.kind", "Speaking"], [null, "Speaking"]] as const;
    for (const [index, [eventKind, line]] of kinds.entries()) {
      act(() => voice.fake.emit("stateChanged", speaking({ threadId: "named", threadTitle: "Release review", eventKind }, { stateRevision: index + 2 })));
      expect(lines()).toEqual(["Release review", line]);
    }
    // A failed action takes the phase word's place while the interaction continues.
    voice.fake.plugin.skipCurrentPlayback.mockRejectedValue(new Error("Skip failed."));
    fireEvent.click(within(card()).getByRole("button", { name: "Skip voice playback" }));
    await waitFor(() => expect(lines()).toEqual(["Release review", "Skip failed."]));
    expect(within(card()).getByRole("alert")).toHaveTextContent("Skip failed.");
    expect(card().querySelector(".voice-card-phase")).toHaveAttribute("data-tone", "warning");
    expect(within(card()).getByRole("button", { name: "Stop voice interaction" })).toBeEnabled();
  });
  it("names the recording target with its visible title and retargets through a list of threads", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({ recognitionThreadId: "long", recognitionThreadTitle: "L".repeat(512) }));
    voice.fake.plugin.retargetActiveRecognition.mockResolvedValue(listening({ recognitionThreadId: "untitled" }));
    renderControls();
    const chip = await screen.findByRole("button", { name: `Change recording target: ${"L".repeat(512)}` });
    expect(chip.querySelector(".voice-card-chip[data-size='lg']")).toHaveTextContent("L".repeat(512));
    expect(lines()).toEqual(["L".repeat(512), "Listening · Tap to change thread"]);
    expect(within(card()).getByRole("status")).toHaveTextContent("Listening");
    expect(card()).toHaveAttribute("data-tone", "destructive");
    fireEvent.click(chip);
    const list = await screen.findByRole("list", { name: "Voice threads" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(list).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(voice.fake.plugin.retargetActiveRecognition).toHaveBeenCalledTimes(1));
    expect(voice.fake.plugin.retargetActiveRecognition.mock.lastCall).toEqual([{ expectedConnectionGeneration: 1, threadId: "untitled", threadTitle: undefined }]);
    expect(await screen.findByRole("button", { name: "Change recording target: Untitled thread" })).toBeInTheDocument();
  });
  it("records for the visible thread through a This thread chip, and Cancel discards", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({ recognitionThreadId: "named", recognitionThreadTitle: "Release review" }));
    voice.fake.plugin.stopCurrentInteraction.mockResolvedValue(ready({ stateRevision: 2 }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    const body = await screen.findByRole("button", { name: "Change recording target: this thread" });
    expect(lines()).toEqual(["Listening", "This thread"]);
    expect(body.querySelector(".voice-card-chip:not([data-size])")).toHaveTextContent("This thread");
    expect(card().querySelector(".voice-card-tile")).toHaveAttribute("data-tone", "destructive");
    fireEvent.click(body);
    expect(await screen.findByRole("list", { name: "Voice threads" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Voice threads" })).toBeNull());
    const cancel = within(card()).getByRole("button", { name: "Cancel voice recording" });
    expect(cancel).toHaveAttribute("title", "Cancel");
    fireEvent.click(cancel);
    await waitFor(() => expect(voice.fake.plugin.stopCurrentInteraction).toHaveBeenCalledWith({ expectedConnectionGeneration: 1 }));
  });
  it("labels the primary action for each phase", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("button", { name: "Start voice recording" });
    const busy = { canStart: false, canStop: true, canSkip: false, canRetarget: false, canResume: false };
    const phases = [["synthesizing", "Stop voice interaction", "Preparing speech…"], ["arming", "Cancel voice recording", "Preparing microphone…"],
      ["recognizing", "Cancel voice recording", "Recognizing…"], ["submitting", "Stop voice interaction", "Sending…"],
      ["recovering", "Stop voice interaction", "Checking submission…"]] as const;
    for (const [index, [phase, primary, label]] of phases.entries()) {
      act(() => voice.fake.emit("stateChanged", ready({ stateRevision: index + 2, phase, actions: busy, active: item({ threadId: "named", recognitionThreadId: "named" }) })));
      expect(within(card()).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["Open voice controls", primary]);
      expect(lines()).toEqual([label, "This thread"]);
    }
  });
  it("resumes a voice session Android refused to start", async () => {
    // Native's start rejection: the binding stays, the session did not start, and only a mode write resumes it.
    const rejected = ready({ phase: "error", ready: false, readiness: "needsResume", actions: { ...idleActions, canStart: false, canResume: true },
      errors: [{ code: "old", message: "Older failure." }, { code: "foreground_start_rejected", message: "Resume voice from the visible app." }] });
    voice.fake.plugin.setConnection.mockResolvedValue(rejected);
    voice.fake.plugin.getState.mockResolvedValue(rejected);
    voice.fake.plugin.updateSettings.mockResolvedValue(ready({ stateRevision: 2, settingsRevision: 1 }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Voice needs to resume", "Needs attention"]);
    expect(within(card()).getByRole("alert")).toHaveTextContent("Resume voice from the visible app.");
    expect(card().querySelector(".voice-card-tile")).toHaveAttribute("data-tone", "warning");
    expect(within(card()).queryByRole("button", { name: "Start voice recording" })).toBeNull();
    fireEvent.click(within(card()).getByRole("button", { name: "Resume voice" }));
    await waitFor(() => expect(voice.fake.plugin.updateSettings).toHaveBeenCalledWith({ expectedConnectionGeneration: 1, expectedRevision: 0, patch: { audioMode: "response" } }));
    expect(voice.fake.plugin.setConnection).toHaveBeenCalledTimes(1);
    expect(await within(card()).findByRole("button", { name: "Start voice recording" })).toBeEnabled();
    expect(lines()).toEqual(["Ready to record", "Response · Auto-listen on"]);
  });
  it("asks to resume a session Android stopped, in the card's own words", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ phase: "off", ready: false, readiness: "needsResume", actions: { ...idleActions, canStart: false, canResume: true } }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Voice needs to resume", "Response · Auto-listen on"]);
    expect(within(card()).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["Open voice controls", "Resume voice"]);
  });
  it("keeps a recording failure visible after native settles to idle", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({ recognitionThreadId: "named", recognitionThreadTitle: "Release review" }));
    renderControls();
    await screen.findByRole("button", { name: "Change recording target: Release review" });
    act(() => {
      voice.fake.emit("runtimeError", { code: "recognition_failed", message: "Recognition failed.", connectionGeneration: 1, ...VOICE_CONNECTION });
      voice.fake.emit("stateChanged", ready({ stateRevision: 2, errors: [{ code: "recognition_failed", message: "Recognition failed." }] }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Recognition failed.");
    expect(lines()).toEqual(["Recognition failed.", "Needs attention"]);
    // The alert announces the message once; the status region and the body's description do not repeat it as status.
    expect(within(card()).getByRole("status")).toHaveTextContent(/^Needs attention$/);
    expect(within(card()).getByRole("button", { name: "Open voice controls" })).toHaveAccessibleDescription("Needs attention Recognition failed.");
    // Recording can start again; Retry is only for a voice session in error.
    expect(within(card()).getByRole("button", { name: "Start voice recording" })).toBeEnabled();
    expect(within(card()).queryByRole("button", { name: "Retry voice connection" })).toBeNull();
  });
});

describe("voice controls card lifecycle", () => {
  it("does not reopen the sheet or the picker by itself after voice reconnects", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Open voice controls" }));
    await screen.findByRole("dialog", { name: "Voice" });
    act(() => voice.fake.emit("stateChanged", disconnectedVoiceSnapshot(2)));
    expect(screen.queryByRole("group", { name: "Voice controls" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => voice.fake.emit("stateChanged", ready({ connectionGeneration: 2 })));
    expect(card()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Without a visible or saved thread the Mic opens the picker.
    fireEvent.click(within(card()).getByRole("button", { name: "Start voice recording" }));
    await screen.findByRole("list", { name: "Voice threads" });
    act(() => voice.fake.emit("stateChanged", disconnectedVoiceSnapshot(3)));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => voice.fake.emit("stateChanged", ready({ connectionGeneration: 3 })));
    expect(card()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps focus on the retarget body while a retarget is pending", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({ recognitionThreadId: "named", recognitionThreadTitle: "Release review" }));
    let settle: (state: NativeVoiceState) => void = () => undefined;
    voice.fake.plugin.retargetActiveRecognition.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    renderControls();
    const body = await screen.findByRole("button", { name: "Change recording target: Release review" });
    body.focus();
    fireEvent.click(body);
    fireEvent.click(within(await screen.findByRole("list", { name: "Voice threads" })).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(voice.fake.plugin.retargetActiveRecognition).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Voice threads" })).toBeNull());
    expect(body).toHaveAttribute("aria-disabled", "true");
    expect(body).toHaveFocus();
    // A pending retarget does not open a second picker.
    fireEvent.click(body);
    expect(screen.queryByRole("list", { name: "Voice threads" })).toBeNull();
    await act(async () => { settle({ ...listening({ recognitionThreadId: "untitled" }), stateRevision: 2 }); });
    expect(screen.getByRole("button", { name: "Change recording target: Untitled thread" })).toBe(body);
    expect(body).not.toHaveAttribute("aria-disabled");
    expect(body).toHaveFocus();
  });
  it("stays quiet on Settings → Voice, which announces readiness and errors itself", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ ready: false, readiness: "adapterConnecting" }));
    navigate("/settings/voice", { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(within(card()).getByRole("status")).toHaveAttribute("aria-live", "off");
    act(() => voice.fake.emit("runtimeError", { code: "recognition_failed", message: "Recognition failed.", connectionGeneration: 1, ...VOICE_CONNECTION }));
    expect(lines()).toEqual(["Recognition failed.", "Needs attention"]);
    expect(within(card()).queryByRole("alert")).toBeNull();
    expect(within(card()).getByRole("status")).toHaveTextContent(/^Recognition failed\. Needs attention$/);
    act(() => navigate(threadPath("named")));
    expect(within(card()).getByRole("status")).not.toHaveAttribute("aria-live");
    expect(within(card()).getByRole("alert")).toHaveTextContent("Recognition failed.");
  });
});
