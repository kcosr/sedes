// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { navigate, threadPath } from "../app/router.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";
import { disconnectedVoiceSnapshot, fakeVoicePlugin, recordingRecovery, VOICE_CONNECTION, VOICE_IDENTITY, voiceActions, voiceSettings, voiceSnapshot } from "./native-voice-test-fixture.js";

const voice = vi.hoisted(() => ({ fake: undefined as unknown as ReturnType<typeof fakeVoicePlugin> }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })) } }));
vi.mock("./native-voice-plugin.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./native-voice-plugin.js")>(),
  hasNativeVoice: () => true,
  nativeVoice: new Proxy({}, { get: (_target, key) => Reflect.get(voice.fake.plugin, key) }),
}));

import { VoiceProvider } from "./VoiceProvider.js";
import { VoiceControls } from "./VoiceControls.js";
import { useShowVoiceBarWhenOff } from "./voice-bar-preference.js";
import { installThreadPanelOpenRequestListener, type ThreadPanelOpenRequest } from "../workspace-panels/thread-panel-navigation.js";

type Active = NonNullable<NativeVoiceState["active"]>;
const longTitle = "L".repeat(600);
const thread = (id: string, title: string) => ({ id, title: { text: title }, available: true, inventoryState: "active" }) as unknown as NormalizedApplicationThreadSummary;
const threads = [thread("long", longTitle), thread("untitled", "  "), thread("named", "Release review"),
  { ...thread("archived", "Archived notes"), inventoryState: "archived" }, { ...thread("offline", "Offline review"), available: false }] as NormalizedApplicationThreadSummary[];
const idleActions = voiceActions({ canStart: true });
const ready = (patch: Partial<NativeVoiceState> = {}) => voiceSnapshot({ ready: true, readiness: "ready", phase: "idle", settings: voiceSettings({ audioMode: "response" }),
  speech: { ...voiceSnapshot().speech, credentialConfigured: true }, actions: idleActions, ...patch });
const item = (active: Partial<Active>): Active => ({ id: "item", eventKind: null, threadId: null, threadTitle: null, recognitionThreadId: null, recognitionThreadTitle: null, automatic: false, recording: null, ...active });
const listening = (active: Partial<Active>) => ready({ phase: "listening",
  actions: voiceActions({ canStop: true, canRetarget: true, canSetKeepListening: true, keepListeningBlockedReason: null }),
  active: item({ recording: { id: "recording", keepListening: false, reconnecting: false }, ...active }) });
const speaking = (active: Partial<Active>, patch: Partial<NativeVoiceState> = {}) => ready({ phase: "speaking",
  actions: voiceActions({ canStop: true, canSkip: true, canRecordDuringPlayback: active.threadId != null }), active: item({ automatic: true, ...active }), ...patch });
/** Sets the device preference through its hook, as Settings → Voice does. */
function ShowWhenOff({ value }: { value: boolean }) {
  const [, setShow] = useShowVoiceBarWhenOff();
  useEffect(() => { setShow(value); }, [setShow, value]);
  return null;
}
function renderControls(showWhenOff?: boolean) {
  const tree = (show?: boolean) => <VoiceProvider profileId={VOICE_CONNECTION.profileId} endpoint={{ baseUrl: VOICE_CONNECTION.serverOrigin }} identity={VOICE_IDENTITY}>
    {show === undefined ? null : <ShowWhenOff value={show} />}<VoiceControls threads={threads} /></VoiceProvider>;
  const view = render(tree(showWhenOff));
  return { ...view, setShowWhenOff: (show: boolean) => view.rerender(tree(show)) };
}
const card = () => screen.getByRole("group", { name: "Voice controls" });
/** The card's buttons by accessible name, in order. */
const buttons = () => within(card()).getAllByRole("button").map(button => button.getAttribute("aria-label"));
/** The two visible lines, with the separator dots spaced as they read. */
const lines = () => Array.from(card().querySelectorAll(".voice-card-title, .voice-card-sub"), line => line.textContent!.replaceAll("·", " · "));
function clickAtTime(element: HTMLElement, at: number, detail = 1, x = 20) {
  const event = new MouseEvent("click", { bubbles: true, detail, clientX: x, clientY: 20 });
  Object.defineProperty(event, "timeStamp", { value: at });
  fireEvent(element, event);
}
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
    expect(lines()).toEqual(["Voice off", "Open controls to turn on"]);
    // Off has no thread to open: the caret is the way back in, and the Mic is disabled.
    expect(buttons()).toEqual(["Open voice controls", "Start voice recording"]);
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
  it("names the visible thread when idle, with readiness, the mode and Auto-listen on line 2", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Release review", "Ready · Response · Auto-listen on"]);
    expect(card().querySelector(".voice-card-title[data-thread]")).toHaveTextContent("Release review");
    expect(buttons()).toEqual(["Open voice controls", "Choose target thread: Release review", "Start voice recording"]);
    expect(within(card()).getByRole("button", { name: "Open voice controls" })).toHaveAccessibleDescription("Release review. Ready · Response · Auto-listen on");
    act(() => voice.fake.emit("stateChanged", ready({ stateRevision: 2, settings: voiceSettings({ audioMode: "manual", autoListen: false }) })));
    expect(lines()).toEqual(["Release review", "Ready · Manual · Auto-listen off"]);
    // Readiness takes the whole state line while voice is not ready.
    act(() => voice.fake.emit("stateChanged", ready({ stateRevision: 3, ready: false, readiness: "starting" })));
    expect(lines()).toEqual(["Release review", "Voice is starting…"]);
    expect(within(card()).getByRole("button", { name: "Start voice recording" })).toBeEnabled();
    expect(card()).not.toHaveTextContent("This thread");
  });
  it.each(["manual", "response"] as const)("shows the missing default thread on a connection with the device playback filter in %s mode", async audioMode => {
    const settings = voiceSettings({ audioMode, onlyVoiceThread: true });
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ settings }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Release review", "Default thread needed"]);
    // Automatic voice is blocked, but explicit recording in the visible thread remains available.
    expect(within(card()).getByRole("button", { name: "Start voice recording" })).toBeEnabled();
    fireEvent.click(within(card()).getByRole("button", { name: "Open voice controls" }));
    const sheet = await screen.findByRole("dialog", { name: "Voice" });
    expect(within(sheet).getByRole("status")).toHaveTextContent("Automatic playback and listening are paused. Choose a default voice thread for this connection");
    expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).toBeChecked();
    // Choosing this account's default clears the warning without weakening the saved playback filter.
    act(() => voice.fake.emit("settingsChanged", ready({ stateRevision: 2, settingsRevision: 1,
      settings: { ...settings, voiceThreadId: "named", voiceThreadTitle: "Release review" } })));
    expect(within(sheet).getByRole("status")).toHaveTextContent(/^Ready$/u);
    expect(within(sheet).getByRole("switch", { name: "Only play from default voice thread" })).toBeChecked();
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Voice" })).toBeNull());
    expect(lines()[1]).toBe(`Ready · ${audioMode === "manual" ? "Manual" : "Response"} · Auto-listen on`);
  });
  it("describes the thread without live announcements on idle navigation or renames", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    navigate(threadPath("named"), { replace: true });
    const view = renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    const status = within(card()).getByRole("status");
    expect(status).toHaveTextContent(/^Ready · Response · Auto-listen on$/u);
    act(() => navigate(threadPath("long")));
    expect(lines()[0]).toBe(longTitle);
    expect(status).toHaveTextContent(/^Ready · Response · Auto-listen on$/u);
    const renamed = threads.map(value => value.id === "long" ? { ...value, title: { ...value.title, text: "Renamed review" } } : value);
    view.rerender(<VoiceProvider profileId={VOICE_CONNECTION.profileId} endpoint={{ baseUrl: VOICE_CONNECTION.serverOrigin }} identity={VOICE_IDENTITY}>
      <VoiceControls threads={renamed} /></VoiceProvider>);
    expect(lines()[0]).toBe("Renamed review");
    expect(status).toHaveTextContent(/^Ready · Response · Auto-listen on$/u);
    expect(within(card()).getByRole("button", { name: "Open voice controls" })).toHaveAccessibleDescription("Renamed review. Ready · Response · Auto-listen on");
    act(() => voice.fake.emit("stateChanged", { ...listening({ recognitionThreadId: "long", recognitionThreadTitle: "Renamed review" }), stateRevision: 2 }));
    expect(status).toHaveTextContent(/^Renamed review\. Listening$/u);
  });
  it("names the saved default voice thread when no thread is visible, or asks for one", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ settings: voiceSettings({ audioMode: "response", voiceThreadId: "named", voiceThreadTitle: null }) }));
    navigate("/settings/voice", { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Release review", "Ready · Response · Auto-listen on"]);
    expect(card().querySelector(".voice-card-title[data-thread]")).toHaveTextContent("Release review");
    expect(buttons()).toEqual(["Open voice controls", "Open thread: Release review", "Choose target thread: Release review", "Start voice recording"]);
    act(() => voice.fake.emit("stateChanged", ready({ stateRevision: 2, ready: false, readiness: "notificationsConnecting" })));
    expect(lines()).toEqual(["Choose a thread", "Connecting to Sedes notifications…"]);
    expect(card().querySelector(".voice-card-title[data-empty]")).toHaveTextContent("Choose a thread");
    expect(buttons()).toEqual(["Open voice controls", "Choose target thread", "Start voice recording"]);
    // Without a visible or saved thread the Mic asks for a target first.
    fireEvent.click(within(card()).getByRole("button", { name: "Start voice recording" }));
    expect(await screen.findByRole("list", { name: "Voice threads" })).toBeInTheDocument();
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
  });
  it.each([
    { pin: true, visible: "long", target: "named", title: "Release review" },
    { pin: false, visible: "long", target: "long", title: longTitle },
    { pin: false, visible: null, target: "named", title: "Release review" },
  ])("names and starts the recording target with pin=$pin and visible=$visible", async ({ pin, visible, target, title }) => {
    const native = ready({ settings: voiceSettings({ audioMode: "response", pinDefaultVoiceThread: pin, voiceThreadId: "named", voiceThreadTitle: "Release review" }) });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.startManualListen.mockResolvedValue(native);
    navigate(visible ? threadPath(visible) : "/", { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()[0]).toBe(title);
    fireEvent.click(within(card()).getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, threadId: target, threadTitle: title.slice(0, 512) }));
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
  });
  it.each([false, true])("uses the idle start glyph for Keep listening by default=%s without making Start a toggle", async keepListeningByDefault => {
    const native = ready({ settings: voiceSettings({ audioMode: "response", keepListeningByDefault }) });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.startManualListen.mockResolvedValue(native);
    navigate(threadPath("named"), { replace: true });
    renderControls();
    const label = keepListeningByDefault ? "Start recording with Keep listening" : "Start voice recording";
    const start = await screen.findByRole("button", { name: label });
    expect(start).toHaveAttribute("title", label);
    expect(start).not.toHaveAttribute("aria-pressed");
    expect(start.querySelector(keepListeningByDefault ? ".lucide-infinity" : ".lucide-mic")).not.toBeNull();
    fireEvent.click(start);
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenCalledExactlyOnceWith({
      expectedConnectionGeneration: 1, threadId: "named", threadTitle: "Release review" }));
    expect(voice.fake.plugin.setKeepListening).not.toHaveBeenCalled();
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
  });
  it.each([false, true])("chooses the next recording independently of navigation and the saved default (pinned: %s)", async pinDefaultVoiceThread => {
    const initial = ready({ settings: voiceSettings({ audioMode: "response", pinDefaultVoiceThread, voiceThreadId: "named", voiceThreadTitle: "Release review" }) });
    const chosen = { ...initial, stateRevision: 2, nextRecordingTarget: { threadId: "untitled", threadTitle: null } };
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    voice.fake.plugin.setNextRecordingTarget.mockResolvedValue(chosen);
    voice.fake.plugin.startManualListen.mockResolvedValue(chosen);
    navigate(threadPath("named"), { replace: true });
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Choose target thread: Release review" }));
    const picker = await screen.findByRole("dialog", { name: "Choose target thread" });
    fireEvent.click(within(picker).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(voice.fake.plugin.setNextRecordingTarget).toHaveBeenCalledExactlyOnceWith({
      expectedConnectionGeneration: 1, threadId: "untitled", threadTitle: undefined }));
    await screen.findByRole("button", { name: "Choose target thread: Untitled thread" });
    expect(window.location.pathname).toBe(threadPath("named"));
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
    act(() => navigate(threadPath("long")));
    expect(lines()[0]).toBe("Untitled thread");
    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenCalledExactlyOnceWith({
      expectedConnectionGeneration: 1, threadId: "untitled", threadTitle: undefined }));
    // A native admission consumes the one-recording choice; the following idle state uses policy again.
    act(() => voice.fake.emit("stateChanged", { ...initial, stateRevision: 3 }));
    expect(lines()[0]).toBe(pinDefaultVoiceThread ? "Release review" : longTitle);
  });
  it.each(["connection", "interaction", "off"])("closes an idle target picker when the %s changes", async change => {
    const initial = ready();
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Choose target thread" }));
    await screen.findByRole("dialog", { name: "Choose target thread" });
    const changed = change === "connection" ? ready({ connectionGeneration: 2 })
      : change === "interaction" ? { ...listening({ recognitionThreadId: "named" }), stateRevision: 2 }
      : voiceSnapshot({ stateRevision: 2 });
    act(() => voice.fake.emit("stateChanged", changed));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose target thread" })).toBeNull());
    expect(voice.fake.plugin.setNextRecordingTarget).not.toHaveBeenCalled();
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
  });
  it("keeps and records the last voice thread when it is outside the visible inventory", async () => {
    const native = ready({ retainedVoiceTarget: { threadId: "outside-inventory", threadTitle: "Last voice thread", revision: 7 },
      actions: voiceActions({ canStart: true, canReleaseRetainedTarget: true }),
      settings: voiceSettings({ audioMode: "response", voiceThreadId: "untitled", voiceThreadTitle: null }) });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.startManualListen.mockResolvedValue(native);
    navigate("/", { replace: true });
    renderControls();
    const start = await screen.findByRole("button", { name: "Start voice recording" });
    expect(lines()[0]).toBe("Last voice thread");
    expect(screen.getByRole("button", { name: "Next voice interaction" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Choose target thread: Last voice thread" })).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenCalledExactlyOnceWith({
      expectedConnectionGeneration: 1, threadId: "outside-inventory", threadTitle: "Last voice thread" }));
    expect(window.location.pathname).toBe("/");
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
  });
  it.each([false, true])("idle Next releases only the displayed retained fallback (explicit next choice=%s)", async explicit => {
    const native = ready({ retainedVoiceTarget: { threadId: "named", threadTitle: "Release review", revision: 7 },
      actions: voiceActions({ canStart: true, canReleaseRetainedTarget: true }),
      nextRecordingTarget: explicit ? { threadId: "untitled", threadTitle: null } : null,
      settings: voiceSettings({ audioMode: "response", voiceThreadId: "long" }) });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.releaseRetainedVoiceTarget.mockResolvedValue({ ...native, stateRevision: 2, retainedVoiceTarget: null, actions: idleActions });
    navigate("/", { replace: true });
    renderControls();
    await screen.findByRole("button", { name: "Start voice recording" });
    const next = screen.queryByRole("button", { name: "Next voice interaction" });
    expect(lines()[0]).toBe(explicit ? "Untitled thread" : "Release review");
    if (explicit) expect(next).toBeNull(); else { expect(next).toBeEnabled(); fireEvent.click(next!); }
    if (explicit) {
      expect(voice.fake.plugin.releaseRetainedVoiceTarget).not.toHaveBeenCalled();
      expect(lines()[0]).toBe("Untitled thread");
    } else {
      await waitFor(() => expect(voice.fake.plugin.releaseRetainedVoiceTarget).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRetainedRevision: 7 }));
      await waitFor(() => expect(lines()[0]).toBe(longTitle));
    }
    expect(screen.queryByRole("button", { name: "Next voice interaction" })).toBeNull();
    expect(window.location.pathname).toBe("/");
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(voice.fake.plugin.skipCurrentPlayback).not.toHaveBeenCalled();
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
  });
  it.each([1, 2])("fences a stale idle Next click when the same thread is retained again on connection %s", async connectionGeneration => {
    const initial = ready({ retainedVoiceTarget: { threadId: "named", threadTitle: "Release review", revision: 7 },
      actions: voiceActions({ canStart: true, canReleaseRetainedTarget: true }) });
    const newer = { ...initial, stateRevision: 3, connectionGeneration, retainedVoiceTarget: { ...initial.retainedVoiceTarget!, revision: 9 } };
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    voice.fake.plugin.releaseRetainedVoiceTarget.mockResolvedValue(newer);
    navigate("/", { replace: true });
    renderControls();
    const next = await screen.findByRole("button", { name: "Next voice interaction" });
    act(() => {
      voice.fake.emit("stateChanged", newer);
      fireEvent.click(next);
    });
    await waitFor(() => expect(voice.fake.plugin.releaseRetainedVoiceTarget).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRetainedRevision: 7 }));
    expect(lines()[0]).toBe("Release review");
    expect(window.location.pathname).toBe("/");
  });
  it.each(["later pointer", "keyboard", "different position"])("ignores a rapid repeat tap on released Next but allows a %s open", async kind => {
    const native = ready({ retainedVoiceTarget: { threadId: "named", threadTitle: "Release review", revision: 7 },
      actions: voiceActions({ canStart: true, canReleaseRetainedTarget: true }),
      settings: voiceSettings({ audioMode: "response", voiceThreadId: "long" }) });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.releaseRetainedVoiceTarget.mockResolvedValue({ ...native, stateRevision: 2, retainedVoiceTarget: null, actions: idleActions });
    renderControls();
    const next = await screen.findByRole("button", { name: "Next voice interaction" });
    vi.spyOn(next, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 40, bottom: 40 } as DOMRect);
    clickAtTime(next, 1000);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Next voice interaction" })).toBeNull());
    const open = card().querySelector<HTMLButtonElement>(".voice-card-open")!;
    clickAtTime(open, 1100);
    expect(window.location.pathname).toBe("/");
    expect(voice.fake.plugin.releaseRetainedVoiceTarget).toHaveBeenCalledTimes(1);
    clickAtTime(open, kind === "later pointer" ? 1510 : 1200, kind === "keyboard" ? 0 : 1, kind === "different position" ? 50 : 20);
    expect(window.location.pathname).toBe(threadPath("long"));
  });
  it.each(["Stop", "Cancel"])("a rapid repeat of %s cannot release the retained idle destination", async label => {
    const stopped = ready({ stateRevision: 2, retainedVoiceTarget: { threadId: "named", threadTitle: "Release review", revision: 7 },
      actions: voiceActions({ canStart: true, canReleaseRetainedTarget: true }) });
    voice.fake.plugin.setConnection.mockResolvedValue(label === "Stop"
      ? speaking({ threadId: "named", threadTitle: "Release review" })
      : listening({ recognitionThreadId: "named", recognitionThreadTitle: "Release review" }));
    voice.fake.plugin.stopPlayback.mockResolvedValue(stopped);
    voice.fake.plugin.stopCurrentInteraction.mockResolvedValue(stopped);
    renderControls();
    const stop = await screen.findByRole("button", { name: label === "Stop" ? "Stop voice interaction" : "Cancel voice recording" });
    vi.spyOn(stop, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 40, bottom: 40 } as DOMRect);
    clickAtTime(stop, 1000);
    const next = await screen.findByRole("button", { name: "Next voice interaction" });
    await waitFor(() => expect(screen.queryByRole("button", { name: label === "Stop" ? "Stop voice interaction" : "Cancel voice recording" })).toBeNull());
    await waitFor(() => expect(next).toBeEnabled());
    clickAtTime(next, 1100);
    expect(voice.fake.plugin.releaseRetainedVoiceTarget).not.toHaveBeenCalled();
    expect(lines()[0]).toBe("Release review");
    expect(window.location.pathname).toBe("/");
    clickAtTime(next, 1600);
    await waitFor(() => expect(voice.fake.plugin.releaseRetainedVoiceTarget).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRetainedRevision: 7 }));
  });
  it("locks both idle actions during release so repeated Next cannot also start recording", async () => {
    const native = ready({ retainedVoiceTarget: { threadId: "named", threadTitle: "Release review", revision: 7 },
      actions: voiceActions({ canStart: true, canReleaseRetainedTarget: true }) });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    let release!: (value: NativeVoiceState) => void;
    voice.fake.plugin.releaseRetainedVoiceTarget.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    renderControls();
    const next = await screen.findByRole("button", { name: "Next voice interaction" });
    fireEvent.click(next);
    expect(next).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start voice recording" })).toBeDisabled();
    fireEvent.click(next);
    expect(voice.fake.plugin.releaseRetainedVoiceTarget).toHaveBeenCalledOnce();
    await act(async () => release(ready({ stateRevision: 2 })));
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start voice recording" })).toBeEnabled();
  });
  it.each(["interaction", "connection", "off", "pin"])("reclaims idle action space while keeping the primary control last when the %s changes", async change => {
    const initial = ready();
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    renderControls(true);
    await screen.findByRole("button", { name: "Start voice recording" });
    const actions = () => Array.from(card().querySelectorAll(".voice-card-actions > button"));
    expect(actions().map(button => button.getAttribute("aria-label"))).toEqual(["Start voice recording"]);
    expect(actions()).toHaveLength(1);
    const changed = change === "interaction" ? ready({ phase: "validating", active: item({ threadId: "named", recognitionThreadId: "named" }), actions: voiceActions({ canStop: true }) })
      : change === "connection" ? ready({ connectionGeneration: 2 })
      : change === "off" ? voiceSnapshot()
      : ready({ settings: voiceSettings({ audioMode: "response", pinDefaultVoiceThread: true, voiceThreadId: "named" }) });
    act(() => voice.fake.emit("stateChanged", { ...changed, stateRevision: 2 }));
    expect(actions()).toHaveLength(change === "interaction" ? 3 : 1);
    expect(actions().at(-1)).toHaveAccessibleName(change === "interaction" ? "Send voice recording" : "Start voice recording");
    if (change === "interaction") {
      expect(actions()[0]).toHaveAccessibleName("Keep listening");
      expect(actions()[0]).toHaveAttribute("aria-disabled", "true");
      expect(actions()[1]).toHaveAccessibleName("Cancel voice recording");
      expect(actions()[2]).toBeDisabled();
    }
  });
  it("follows navigation for idle recording while keeping background retention untouched", async () => {
    const native = ready({ retainedVoiceTarget: { threadId: "outside-inventory", threadTitle: "Background voice thread", revision: 7 },
      actions: voiceActions({ canStart: true, canReleaseRetainedTarget: true }) });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.startManualListen.mockResolvedValue(native);
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("button", { name: "Start voice recording" });
    expect(lines()[0]).toBe("Release review");
    expect(screen.queryByRole("button", { name: "Next voice interaction" })).toBeNull();
    act(() => navigate(threadPath("long")));
    expect(lines()[0]).toBe(longTitle);
    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, threadId: "long", threadTitle: "L".repeat(512) }));
    expect(voice.fake.plugin.releaseRetainedVoiceTarget).not.toHaveBeenCalled();
  });
  it.each([null, "offline", "archived", "deleted"])("chooses a recording target without saving the unavailable pinned default %s", async voiceThreadId => {
    const native = ready({ settings: voiceSettings({ audioMode: "response", pinDefaultVoiceThread: true, voiceThreadId }) });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.startManualListen.mockResolvedValue(native);
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()[0]).toBe("Choose a thread");
    fireEvent.click(within(card()).getByRole("button", { name: "Start voice recording" }));
    const picker = await screen.findByRole("dialog", { name: "Choose target thread" });
    expect(picker).toHaveAccessibleDescription("Choose a thread and start recording.");
    fireEvent.click(within(picker).getByRole("button", { name: longTitle }));
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, threadId: "long", threadTitle: "L".repeat(512) }));
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(threadPath("named"));
  });
  it("keeps an unavailable explicit target from silently falling back to another thread", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ nextRecordingTarget: { threadId: "offline", threadTitle: "Offline review" } }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Start voice recording" }));
    await screen.findByRole("dialog", { name: "Choose target thread" });
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
  });
  it("keeps the actual active recording target and allows retargeting while the default is pinned", async () => {
    const native = { ...listening({ recognitionThreadId: "long", recognitionThreadTitle: longTitle }),
      settings: voiceSettings({ audioMode: "response", pinDefaultVoiceThread: true, voiceThreadId: "named", voiceThreadTitle: "Release review" }) };
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()[0]).toBe(longTitle);
    fireEvent.click(within(card()).getByRole("button", { name: `Change recording thread: ${longTitle}` }));
    const picker = await screen.findByRole("dialog", { name: "Choose target thread" });
    fireEvent.click(within(picker).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(voice.fake.plugin.retargetActiveRecognition).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, recordingId: "recording", threadId: "untitled", threadTitle: undefined }));
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
  });
  it("asks for an explicit target when the visible thread cannot take a recording, and never names a missing default", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ settings: voiceSettings({ audioMode: "response", voiceThreadId: "named", voiceThreadTitle: "Release review" }) }));
    voice.fake.plugin.startManualListen.mockResolvedValue(ready({ stateRevision: 2 }));
    navigate(threadPath("archived"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Choose a thread", "Ready · Response · Auto-listen on"]);
    expect(within(card()).queryByRole("button", { name: "Open thread: Release review" })).toBeNull();
    expect(card().querySelector(".voice-card-target")).not.toBeNull();
    fireEvent.click(within(card()).getByRole("button", { name: "Start voice recording" }));
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Choose target thread" })).getByRole("button", { name: "Release review" }));
    await waitFor(() => expect(voice.fake.plugin.startManualListen).toHaveBeenCalledWith({ expectedConnectionGeneration: 1, threadId: "named", threadTitle: "Release review" }));
    act(() => navigate("/"));
    // A saved default voice thread that is unavailable or deleted is not a target, so it is not named.
    for (const [index, voiceThreadId] of ["offline", "deleted"].entries()) {
      act(() => voice.fake.emit("stateChanged", ready({ stateRevision: index + 3, settings: voiceSettings({ audioMode: "response", voiceThreadId, voiceThreadTitle: "Saved title" }) })));
      expect(lines()).toEqual(["Choose a thread", "Ready · Response · Auto-listen on"]);
    }
    act(() => navigate(threadPath("offline")));
    expect(lines()).toEqual(["Choose a thread", "Ready · Response · Auto-listen on"]);
    act(() => navigate(threadPath("named")));
    expect(lines()).toEqual(["Release review", "Ready · Response · Auto-listen on"]);
    expect(within(card()).queryByRole("button", { name: /^Open thread/u })).toBeNull();
  });
  it("opens the quick sheet from the restored status tile with a visible menu affordance", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    fireEvent.click(card().querySelector(".voice-card-body")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    const caret = within(card()).getByRole("button", { name: "Open voice controls" });
    expect(caret).toHaveAttribute("aria-haspopup", "dialog");
    expect(caret).toHaveClass("voice-card-tile");
    expect(caret.querySelector(".voice-card-menu-mark")).not.toBeNull();
    fireEvent.click(caret);
    const sheet = await screen.findByRole("dialog", { name: "Voice" });
    expect(within(sheet).getByRole("radiogroup", { name: "Audio mode" })).toBeInTheDocument();
  });
  it("uses the available thread inventory to change the default in the quick sheet without starting or retargeting a recording", async () => {
    const initial = ready();
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    voice.fake.plugin.getState.mockResolvedValue(initial);
    voice.fake.plugin.updateSettings.mockResolvedValue({ ...initial, stateRevision: 2, settingsRevision: 1,
      settings: { ...initial.settings, voiceThreadId: "named", voiceThreadTitle: "Release review" } });
    navigate(threadPath("long"), { replace: true });
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Open voice controls" }));
    const sheet = await screen.findByRole("dialog", { name: "Voice" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Default voice thread" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "Voice threads" })).getByRole("button", { name: "Release review" }));
    await waitFor(() => expect(voice.fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 0,
      patch: { voiceThreadId: "named", voiceThreadTitle: "Release review" } }));
    expect(within(sheet).getByRole("button", { name: "Default voice thread" })).toHaveAccessibleDescription("Release review");
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(voice.fake.plugin.retargetActiveRecognition).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(threadPath("long"));
  });
  it("opens the card's thread from the body when it is not the visible thread", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(speaking({ threadId: "named", threadTitle: "Release review", eventKind: "turn.completed" }));
    navigate(threadPath("long"), { replace: true });
    renderControls();
    // Opening goes through the shell's panel request, so a closed or collapsed Chat panel opens too.
    const requests: ThreadPanelOpenRequest[] = [];
    const stop = installThreadPanelOpenRequestListener(window, request => requests.push(request));
    try {
      fireEvent.click(await screen.findByRole("button", { name: "Open thread: Release review" }));
    } finally { stop(); }
    expect(requests).toEqual([{ threadId: "named" }]);
    expect(window.location.pathname).toBe(threadPath("named"));
    // Now that thread is on screen, the card still names it, but the body is plain text again.
    await waitFor(() => expect(buttons()).not.toContain("Open thread: Release review"));
    expect(lines()).toEqual(["Release review", "Speaking · Response"]);
    expect(buttons()).toEqual(["Open voice controls", "Next voice interaction", "Stop voice interaction", "Record reply"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens a native notification's thread through the shell's panel request", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    navigate(threadPath("long"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    const requests: ThreadPanelOpenRequest[] = [];
    const stop = installThreadPanelOpenRequestListener(window, request => requests.push(request));
    try {
      act(() => voice.fake.emit("openThread", { ...VOICE_CONNECTION, connectionGeneration: 1, threadId: "named" }));
    } finally { stop(); }
    expect(requests).toEqual([{ threadId: "named" }]);
    expect(window.location.pathname).toBe(threadPath("named"));
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
  it("shows speech from the visible thread with the queue, and Next and Stop reach native", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(speaking({ threadId: "named", eventKind: "turn.completed" }, { queue: { count: 2, bytes: 0, droppedCount: 0, droppedReasons: {} } }));
    voice.fake.plugin.skipCurrentPlayback.mockResolvedValue(speaking({ threadId: "named" }, { stateRevision: 2 }));
    voice.fake.plugin.stopPlayback.mockResolvedValue(ready({ stateRevision: 3 }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Release review", "Speaking · Response · 2 queued"]);
    // With a queue count, the kind gives way first when the card is narrow.
    expect(card().querySelector(".voice-card-optional")).toHaveTextContent(/^·Response$/u);
    expect(card()).not.toHaveTextContent("This thread");
    expect(card().querySelector(".voice-card-tile")).toHaveAttribute("data-tone", "info");
    expect(card()).toHaveAttribute("data-tone", "info");
    expect(buttons()).toEqual(["Open voice controls", "Next voice interaction", "Stop voice interaction", "Record reply"]);
    fireEvent.click(within(card()).getByRole("button", { name: "Next voice interaction" }));
    await waitFor(() => expect(voice.fake.plugin.skipCurrentPlayback).toHaveBeenCalledWith({ expectedConnectionGeneration: 1, interactionId: "item" }));
    await waitFor(() => expect(within(card()).getByRole("button", { name: "Stop voice interaction" })).toBeEnabled());
    expect(lines()).toEqual(["Release review", "Speaking"]);
    fireEvent.click(within(card()).getByRole("button", { name: "Stop voice interaction" }));
    await waitFor(() => expect(voice.fake.plugin.stopPlayback).toHaveBeenCalledWith({ expectedConnectionGeneration: 1, interactionId: "item" }));
    expect(await within(card()).findByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
  });
  it.each(["synthesizing", "speaking"] as const)("updates Next during %s as queued playback and Auto-listen change", async phase => {
    const initial = speaking({ threadId: "named" }, {
      phase, settings: voiceSettings({ audioMode: "response", autoListen: false }),
    });
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    voice.fake.plugin.stopPlayback.mockResolvedValue(ready({ stateRevision: 6 }));
    renderControls();
    const stop = await screen.findByRole("button", { name: "Stop voice interaction" });
    const record = screen.getByRole("button", { name: "Record reply" });
    const next = () => screen.queryByRole("button", { name: "Next voice interaction" });
    expect(next()).toBeNull();
    expect(stop).toBeEnabled();
    expect(record).toBeEnabled();

    act(() => voice.fake.emit("stateChanged", { ...initial, stateRevision: 2, queue: { ...initial.queue, count: 1 } }));
    expect(next()).toBeEnabled();
    act(() => voice.fake.emit("stateChanged", { ...initial, stateRevision: 3 }));
    expect(next()).toBeNull();
    act(() => voice.fake.emit("stateChanged", { ...initial, stateRevision: 4, settings: { ...initial.settings, autoListen: true } }));
    expect(next()).toBeEnabled();
    act(() => voice.fake.emit("stateChanged", { ...initial, stateRevision: 5 }));
    expect(next()).toBeNull();
    expect(screen.getByRole("button", { name: "Stop voice interaction" })).toBe(stop);
    expect(screen.getByRole("button", { name: "Record reply" })).toBe(record);
    fireEvent.click(stop);
    await waitFor(() => expect(voice.fake.plugin.stopPlayback).toHaveBeenCalledExactlyOnceWith({
      expectedConnectionGeneration: 1, interactionId: "item",
    }));
    expect(voice.fake.plugin.skipCurrentPlayback).not.toHaveBeenCalled();
  });
  it("names another thread's speech and labels the native event kind", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(speaking({ threadId: "named", threadTitle: "Release review", eventKind: "turn.completed" }));
    navigate(threadPath("long"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Release review", "Speaking · Response"]);
    expect(card().querySelector(".voice-card-title[data-thread]")).toHaveTextContent("Release review");
    expect(buttons()).toEqual(["Open voice controls", "Open thread: Release review", "Next voice interaction", "Stop voice interaction", "Record reply"]);
    const kinds = [["turn.progress", "Speaking · Progress"], ["question.requested", "Speaking · Question"], ["automation.started", "Speaking · Automation"],
      ["replay", "Speaking · Replay"], ["future.kind", "Speaking"], [null, "Speaking"]] as const;
    for (const [index, [eventKind, line]] of kinds.entries()) {
      act(() => voice.fake.emit("stateChanged", speaking({ threadId: "named", threadTitle: "Release review", eventKind }, { stateRevision: index + 2 })));
      expect(lines()).toEqual(["Release review", line]);
    }
    // A failed action takes the phase word's place while the interaction continues.
    voice.fake.plugin.skipCurrentPlayback.mockRejectedValue(new Error("Skip failed."));
    fireEvent.click(within(card()).getByRole("button", { name: "Next voice interaction" }));
    await waitFor(() => expect(lines()).toEqual(["Release review", "Skip failed."]));
    expect(within(card()).getByRole("alert")).toHaveTextContent("Skip failed.");
    expect(card().querySelector(".voice-card-phase")).toHaveAttribute("data-tone", "warning");
    expect(within(card()).getByRole("button", { name: "Stop voice interaction" })).toBeEnabled();
  });
  it.each([
    { phase: "synthesizing", automatic: true, autoListen: false },
    { phase: "speaking", automatic: true, autoListen: true },
    { phase: "synthesizing", automatic: false, autoListen: true },
    { phase: "speaking", automatic: false, autoListen: false },
  ] as const)("records an explicit reply during $phase, automatic=$automatic, Auto-listen=$autoListen", async ({ phase, automatic, autoListen }) => {
    const native = speaking({ threadId: "named", threadTitle: "Release review", automatic, eventKind: automatic ? "turn.completed" : "replay" }, {
      phase, settings: voiceSettings({ audioMode: "response", autoListen, pinDefaultVoiceThread: true, voiceThreadId: "untitled", voiceThreadTitle: null }),
      queue: { count: 2, bytes: 80, droppedCount: 0, droppedReasons: {} },
    });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.recordDuringPlayback.mockResolvedValue({ ...listening({ id: "reply", threadId: "named", recognitionThreadId: "named", recognitionThreadTitle: "Release review" }),
      stateRevision: 2, settings: native.settings, queue: native.queue });
    navigate(threadPath("long"), { replace: true });
    renderControls();
    const record = await screen.findByRole("button", { name: "Record reply" });
    expect(record).toBeEnabled();
    expect(record).toHaveAttribute("title", "Record reply");
    fireEvent.click(record);
    await waitFor(() => expect(voice.fake.plugin.recordDuringPlayback).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, interactionId: "item" }));
    await waitFor(() => expect(lines()).toEqual(["Release review", "Listening"]));
    expect(window.location.pathname).toBe(threadPath("long"));
    expect(screen.queryByRole("button", { name: "Record reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next voice interaction" })).toBeNull();
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
  });
  it("uses native's Record capability, keeping Next and Stop available when recording cannot start", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(speaking({ threadId: "named" }, {
      actions: voiceActions({ canStop: true, canSkip: true }),
    }));
    renderControls();
    await screen.findByRole("button", { name: "Next voice interaction" });
    expect(screen.getByRole("button", { name: "Record reply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop voice interaction" })).toBeEnabled();
  });
  it.each([
    ["Record reply", "recordDuringPlayback"], ["Next voice interaction", "skipCurrentPlayback"], ["Stop voice interaction", "stopPlayback"],
  ] as const)("fences a stale rendered %s click to the original connection and interaction", async (label, method) => {
    const initial = speaking({ id: "original", threadId: "named" });
    const newer = speaking({ id: "newer", threadId: "untitled" }, { connectionGeneration: 2, stateRevision: 2 });
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    voice.fake.plugin[method].mockResolvedValue(newer);
    navigate(threadPath("long"), { replace: true });
    renderControls();
    const button = await screen.findByRole("button", { name: label });
    // Native advanced, but React has not committed its new render when the old target receives this click.
    act(() => {
      voice.fake.emit("stateChanged", newer);
      fireEvent.click(button);
    });
    await waitFor(() => expect(voice.fake.plugin[method]).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, interactionId: "original" }));
    expect(window.location.pathname).toBe(threadPath("long"));
  });
  it("locks repeated Record and Next taps while Record is pending but lets Stop cancel it", async () => {
    const initial = speaking({ threadId: "named" });
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    let release!: (value: NativeVoiceState) => void;
    voice.fake.plugin.recordDuringPlayback.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    voice.fake.plugin.stopPlayback.mockResolvedValue(ready({ stateRevision: 3 }));
    renderControls();
    const record = await screen.findByRole("button", { name: "Record reply" });
    fireEvent.click(record);
    expect(record).toBeDisabled();
    const next = screen.getByRole("button", { name: "Next voice interaction" });
    expect(next).toBeDisabled();
    fireEvent.click(record);
    fireEvent.click(next);
    expect(voice.fake.plugin.recordDuringPlayback).toHaveBeenCalledOnce();
    expect(voice.fake.plugin.skipCurrentPlayback).not.toHaveBeenCalled();
    const stop = screen.getByRole("button", { name: "Stop voice interaction" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await waitFor(() => expect(voice.fake.plugin.stopPlayback).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, interactionId: "item" }));
    await act(async () => release({ ...initial, stateRevision: 2 }));
    expect(screen.queryByRole("button", { name: "Record reply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start voice recording" })).toBeEnabled();
  });
  it("separates body navigation from the recording chevron's independent retarget action", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({ recognitionThreadId: "long", recognitionThreadTitle: "L".repeat(512) }));
    voice.fake.plugin.retargetActiveRecognition.mockResolvedValue(listening({ recognitionThreadId: "untitled" }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    const chip = await screen.findByRole("button", { name: `Change recording thread: ${"L".repeat(512)}` });
    expect(chip.textContent).toBe("");
    expect(chip.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    expect(lines()).toEqual(["L".repeat(512), "Listening"]);
    expect(card().querySelector(".voice-card-title[data-thread]")).toHaveTextContent("L".repeat(512));
    expect(buttons()).toEqual(["Open voice controls", `Open thread: ${"L".repeat(512)}`, `Change recording thread: ${"L".repeat(512)}`, "Keep listening", "Cancel voice recording", "Send voice recording"]);
    expect(within(card()).getByRole("status")).toHaveTextContent("Listening");
    expect(card()).toHaveAttribute("data-tone", "destructive");
    fireEvent.click(within(card()).getByRole("button", { name: `Open thread: ${"L".repeat(512)}` }));
    expect(window.location.pathname).toBe(threadPath("long"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(voice.fake.plugin.retargetActiveRecognition).not.toHaveBeenCalled();
    fireEvent.click(chip);
    const list = await screen.findByRole("list", { name: "Voice threads" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(list).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(voice.fake.plugin.retargetActiveRecognition).toHaveBeenCalledTimes(1));
    expect(voice.fake.plugin.retargetActiveRecognition.mock.lastCall).toEqual([{ expectedConnectionGeneration: 1, recordingId: "recording", threadId: "untitled", threadTitle: undefined }]);
    expect(await screen.findByRole("button", { name: "Change recording thread: Untitled thread" })).toBeInTheDocument();
    expect(window.location.pathname).toBe(threadPath("long"));
    // Once native freezes retargeting, the select affordance disappears and the
    // existing thread navigation remains available without implying a change.
    act(() => voice.fake.emit("stateChanged", { ...listening({ recognitionThreadId: "untitled" }), stateRevision: 3,
      actions: voiceActions({ canStop: true }) }));
    expect(card().querySelector(".voice-card-target")).toBeNull();
    fireEvent.click(within(card()).getByRole("button", { name: "Open thread: Untitled thread" }));
    expect(window.location.pathname).toBe(threadPath("untitled"));
    expect(voice.fake.plugin.retargetActiveRecognition).toHaveBeenCalledTimes(1);
  });
  it("retargets only from the visible recording chevron and Cancel discards", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({ recognitionThreadId: "named", recognitionThreadTitle: "Release review" }));
    voice.fake.plugin.stopCurrentInteraction.mockResolvedValue(ready({ stateRevision: 2 }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    const chip = await screen.findByRole("button", { name: "Change recording thread: Release review" });
    expect(lines()).toEqual(["Release review", "Listening"]);
    expect(chip.textContent).toBe("");
    expect(card().querySelector(".voice-card-title")).toHaveTextContent("Release review");
    expect(buttons()).toEqual(["Open voice controls", "Change recording thread: Release review", "Keep listening", "Cancel voice recording", "Send voice recording"]);
    expect(card()).not.toHaveTextContent("This thread");
    expect(within(card()).getByRole("status")).toHaveTextContent(/^Release review\. Listening$/u);
    expect(card().querySelector(".voice-card-tile")).toHaveAttribute("data-tone", "destructive");
    fireEvent.click(chip);
    // The visible thread leads the picker as This thread; the rest keep their order without a duplicate.
    const list = await screen.findByRole("list", { name: "Voice threads" });
    expect(within(list).getAllByRole("listitem").map(item => item.textContent)).toEqual(["This threadRelease review", "L".repeat(600), "Untitled thread"]);
    expect(within(list).getByRole("button", { name: "Release review" })).toHaveAccessibleDescription("This thread");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Voice threads" })).toBeNull());
    const cancel = within(card()).getByRole("button", { name: "Cancel voice recording" });
    expect(cancel).toHaveAttribute("title", "Cancel");
    fireEvent.click(cancel);
    await waitFor(() => expect(voice.fake.plugin.stopCurrentInteraction).toHaveBeenCalledWith({ expectedConnectionGeneration: 1, interactionId: "item" }));
  });
  it("labels the primary action for each phase", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("button", { name: "Start voice recording" });
    const busy = voiceActions({ canStop: true });
    const phases = [["synthesizing", "Stop voice interaction", "Preparing speech…"], ["announcing", "Cancel voice recording", "Announcing thread…"], ["arming", "Cancel voice recording", "Preparing microphone…"],
      ["recognizing", "Cancel voice recording", "Recognizing…"], ["submitting", "Stop voice interaction", "Sending…"],
      ["recovering", "Stop voice interaction", "Checking submission…"]] as const;
    for (const [index, [phase, primary, label]] of phases.entries()) {
      act(() => voice.fake.emit("stateChanged", ready({ stateRevision: index + 2, phase, actions: busy, active: item({ threadId: "named", recognitionThreadId: "named" }) })));
      expect(buttons()).toEqual(phase === "synthesizing"
        ? ["Open voice controls", "Next voice interaction", primary, "Record reply"]
        : ["Open voice controls", "Keep listening", primary, "Send voice recording"]);
      if (phase !== "synthesizing") {
        expect(screen.getByRole("button", { name: "Keep listening" })).toHaveAttribute("aria-disabled", "true");
        const send = screen.getByRole("button", { name: "Send voice recording" });
        expect(send).toBeDisabled();
        expect(send.querySelector(".lucide-loader-circle")).not.toBeNull();
      }
      expect(lines()).toEqual(["Release review", label]);
      expect(card().querySelector(".voice-card-target")).toBeNull();
    }
  });
  it("announces the recording destination and cancels its preparation without opening another thread", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ phase: "announcing", settings: voiceSettings({ audioMode: "response", announceRecordingThread: true }),
      actions: voiceActions({ canStop: true }), active: item({ id: "announcement", threadId: "untitled", threadTitle: "Previous speech",
        recognitionThreadId: "named", recognitionThreadTitle: "Renamed destination" }) }));
    voice.fake.plugin.stopCurrentInteraction.mockResolvedValue(ready({ stateRevision: 2 }));
    navigate(threadPath("long"), { replace: true });
    renderControls();
    const cancel = await screen.findByRole("button", { name: "Cancel voice recording" });
    expect(lines()).toEqual(["Renamed destination", "Announcing thread…"]);
    expect(buttons()).toEqual(["Open voice controls", "Open thread: Renamed destination", "Keep listening", "Cancel voice recording", "Send voice recording"]);
    expect(card()).toHaveAttribute("data-input-actions");
    expect(card()).not.toHaveAttribute("data-tone", "destructive");
    expect(within(card()).getByRole("status")).toHaveTextContent("Renamed destination. Announcing thread…");
    fireEvent.click(cancel);
    await waitFor(() => expect(voice.fake.plugin.stopCurrentInteraction).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, interactionId: "announcement" }));
    expect(window.location.pathname).toBe(threadPath("long"));
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(voice.fake.plugin.recordDuringPlayback).not.toHaveBeenCalled();
    expect(voice.fake.plugin.skipCurrentPlayback).not.toHaveBeenCalled();
  });
  it("asks for a thread when listening has no target, and leads with the phase for speech without a thread", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({}));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    const chip = await screen.findByRole("button", { name: "Change recording thread" });
    expect(lines()).toEqual(["Choose a thread", "Listening"]);
    expect(card().querySelector(".voice-card-title[data-empty]")).toHaveTextContent("Choose a thread");
    expect(card().querySelector(".voice-card-title")).toHaveTextContent("Choose a thread");
    expect(buttons()).toEqual(["Open voice controls", "Change recording thread", "Keep listening", "Cancel voice recording", "Send voice recording"]);
    act(() => voice.fake.emit("stateChanged", speaking({ eventKind: "automation.started" }, { stateRevision: 2 })));
    expect(lines()).toEqual(["Speaking", "Automation"]);
    expect(buttons()).toEqual(["Open voice controls", "Next voice interaction", "Stop voice interaction", "Record reply"]);
  });
  it("keeps the notice kind before a thread-less speech queue on narrow cards", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(speaking({ eventKind: "automation.started" },
      { queue: { count: 2, bytes: 0, droppedCount: 0, droppedReasons: {} } }));
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Speaking", "Automation · 2 queued"]);
    // The phase already has its own line, so hiding the kind would leave a leading separator before the queue.
    expect(card().querySelector(".voice-card-optional")).toBeNull();
    expect(within(card()).getByRole("status")).toHaveTextContent(/^Speaking\. Automation · 2 queued$/u);
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
    expect(lines()).toEqual(["Release review", "Ready · Response · Auto-listen on"]);
  });
  it("asks to resume a session Android stopped, in the card's own words", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ phase: "off", ready: false, readiness: "needsResume", actions: { ...idleActions, canStart: false, canResume: true } }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Release review", "Voice needs to resume"]);
    expect(within(card()).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["Open voice controls", "Choose target thread: Release review", "Resume voice"]);
  });
  it("keeps a recording failure visible after native settles to idle", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({ recognitionThreadId: "named", recognitionThreadTitle: "Release review" }));
    renderControls();
    await screen.findByRole("button", { name: "Change recording thread: Release review" });
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

describe("Keep listening and saved dictation", () => {
  const capture = (keepListening = false, reconnecting = false) => {
    const state = listening({ recognitionThreadId: "named", recognitionThreadTitle: "Release review",
      recording: { id: "recording", keepListening, reconnecting } });
    return { ...state, actions: { ...state.actions, canSend: true } };
  };
  it.each([false, true])("sends the current recording with Keep listening=%s", async keepListening => {
    const initial = capture(keepListening);
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    voice.fake.plugin.sendRecording.mockResolvedValue({ ...initial, phase: "recognizing", stateRevision: 2,
      actions: voiceActions({ canStop: true }) });
    renderControls();
    const send = await screen.findByRole("button", { name: "Send voice recording" });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(voice.fake.plugin.sendRecording).toHaveBeenCalledExactlyOnceWith({
      expectedConnectionGeneration: 1, recordingId: "recording" }));
    expect(send).toBeDisabled();
    expect(voice.fake.plugin.setKeepListening).not.toHaveBeenCalled();
  });
  it("adopts the current recording only after native confirms, keeps infinity separate from Send, and sends its identity", async () => {
    const initial = capture();
    let adopt!: (state: NativeVoiceState) => void;
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    voice.fake.plugin.setKeepListening.mockImplementationOnce(() => new Promise(resolve => { adopt = resolve; }));
    voice.fake.plugin.sendRecording.mockResolvedValue(ready({ stateRevision: 3, phase: "recognizing", active: item({
      recognitionThreadId: "named", recording: { id: "recording", keepListening: true, reconnecting: false } }), actions: voiceActions({ canStop: true }) }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    const keep = await screen.findByRole("button", { name: "Keep listening" });
    expect(keep).toHaveAttribute("aria-pressed", "false");
    expect(keep).toHaveAttribute("title", "Keep listening");
    expect(within(card()).getByRole("button", { name: "Change recording thread: Release review" })).toHaveClass("voice-card-target");
    expect(within(card()).getByRole("button", { name: "Send voice recording" })).toBeEnabled();
    expect(within(card()).getByRole("button", { name: "Cancel voice recording" }).querySelector("svg.lucide-x")).not.toBeNull();
    keep.focus();
    fireEvent.click(keep);
    expect(voice.fake.plugin.setKeepListening).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, recordingId: "recording", enabled: true });
    expect(keep).toHaveAttribute("aria-pressed", "false");
    expect(keep).toHaveAttribute("aria-disabled", "true");
    expect(keep).toHaveFocus();
    expect(within(card()).getByRole("button", { name: "Cancel voice recording" })).toBeEnabled();
    fireEvent.click(keep);
    expect(voice.fake.plugin.setKeepListening).toHaveBeenCalledTimes(1);
    await act(async () => { adopt({ ...capture(true), stateRevision: 2 }); });
    expect(keep).toHaveAttribute("aria-pressed", "true");
    expect(keep).toHaveFocus();
    expect(buttons()).toEqual(["Open voice controls", "Change recording thread: Release review", "Keep listening", "Cancel voice recording", "Send voice recording"]);
    expect(lines()).toEqual(["Release review", "Listening"]);
    fireEvent.click(within(card()).getByRole("button", { name: "Send voice recording" }));
    await waitFor(() => expect(voice.fake.plugin.sendRecording).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, recordingId: "recording" }));
    expect(within(card()).getByRole("button", { name: "Keep listening" })).toHaveAttribute("aria-disabled", "true");
    expect(within(card()).getByRole("button", { name: "Send voice recording" })).toBeDisabled();
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
  });
  it("switches Keep listening off for the same recording and starts the next recording unselected", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(capture(true));
    voice.fake.plugin.setKeepListening.mockResolvedValue({ ...capture(), stateRevision: 2 });
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Keep listening" }));
    await waitFor(() => expect(voice.fake.plugin.setKeepListening).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, recordingId: "recording", enabled: false }));
    expect(screen.getByRole("button", { name: "Keep listening" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Send voice recording" })).toBeEnabled();
    act(() => voice.fake.emit("stateChanged", { ...capture(true), stateRevision: 3 }));
    act(() => voice.fake.emit("stateChanged", { ...listening({ recognitionThreadId: "long",
      recording: { id: "next-recording", keepListening: false, reconnecting: false } }), stateRevision: 4 }));
    expect(screen.getByRole("button", { name: "Keep listening" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Send voice recording" })).toBeDisabled();
    expect(voice.fake.plugin.updateSettings).not.toHaveBeenCalled();
  });
  it("keeps ordinary Stop during a live held Send admission, preserving any resulting saved dictation", async () => {
    const initial = capture(true);
    voice.fake.plugin.setConnection.mockResolvedValue(initial);
    const submitting = ready({ stateRevision: 2, phase: "submitting", active: initial.active,
      actions: voiceActions({ canStop: true }), recordingRecovery: null });
    voice.fake.plugin.sendRecording.mockResolvedValue(submitting);
    const saved = recordingRecovery({ recordingId: "recording", stage: "admitting", hasUnrecognizedAudio: false,
      canRetryRecognition: false, admission: { mutationId: "original-input", status: "uncertain", cancelled: true } });
    voice.fake.plugin.stopCurrentInteraction.mockResolvedValue(ready({ stateRevision: 3, phase: "recordingRecovery",
      actions: voiceActions(), recordingRecovery: saved }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Send voice recording" }));
    const stop = await screen.findByRole("button", { name: "Stop voice interaction" });
    expect(lines()).toEqual(["Release review", "Sending…"]);
    expect(buttons()).toEqual(["Open voice controls", "Keep listening", "Stop voice interaction", "Send voice recording"]);
    expect(card()).not.toHaveAttribute("data-saved");
    fireEvent.click(stop);
    await waitFor(() => expect(voice.fake.plugin.stopCurrentInteraction).toHaveBeenCalledExactlyOnceWith({
      expectedConnectionGeneration: 1, interactionId: "item" }));
    await waitFor(() => expect(lines()).toEqual(["Saved dictation · Release review", "Stopped; checking delivery"]));
    expect(screen.getByRole("button", { name: "Discard saved dictation" })).not.toHaveAttribute("aria-disabled");
    expect(voice.fake.plugin.discardRecording).not.toHaveBeenCalled();
  });
  it.each(["manual", "response"] as const)("keeps Listening and Send during a transient outage in %s mode without replacing them with recovery", async audioMode => {
    const state = { ...capture(true, true), settings: voiceSettings({ audioMode }) };
    voice.fake.plugin.setConnection.mockResolvedValue(state);
    renderControls();
    await screen.findByRole("button", { name: "Keep listening" });
    expect(lines()).toEqual(["Release review", "Listening · Reconnecting"]);
    expect(card().querySelector(".voice-card-reconnecting")).toHaveTextContent("Reconnecting");
    expect(screen.getByRole("button", { name: "Send voice recording" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel voice recording" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retry saved dictation" })).toBeNull();
    expect(card()).not.toHaveTextContent(/segment|elapsed|\d+:\d+/iu);
    act(() => voice.fake.emit("stateChanged", { ...state, stateRevision: 2, active: { ...state.active!, recording: { ...state.active!.recording!, reconnecting: false } } }));
    expect(lines()).toEqual(["Release review", "Listening"]);
    expect(screen.getByRole("button", { name: "Keep listening" })).toHaveAttribute("aria-pressed", "true");
  });
  it("dismisses a recording picker when a newer recording or connection replaces it", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(capture());
    voice.fake.plugin.retargetActiveRecognition.mockRejectedValue(new Error("That recording has ended."));
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Change recording thread: Release review" }));
    const picker = await screen.findByRole("dialog", { name: "Choose target thread" });
    const next = { ...listening({ recognitionThreadId: "named", recording: { id: "new-recording", keepListening: false, reconnecting: false } }), connectionGeneration: 2 };
    act(() => voice.fake.emit("stateChanged", next));
    expect(picker).not.toBeInTheDocument();
    expect(voice.fake.plugin.retargetActiveRecognition).not.toHaveBeenCalled();
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Change recording thread: Release review" })).toBeInTheDocument();
  });
  it("lets Cancel stop capture while Keep listening awaits durable acknowledgement", async () => {
    let failAdoption!: (error: Error) => void;
    voice.fake.plugin.setConnection.mockResolvedValue(capture());
    voice.fake.plugin.setKeepListening.mockImplementationOnce(() => new Promise((_resolve, reject) => { failAdoption = reject; }));
    voice.fake.plugin.stopCurrentInteraction.mockResolvedValue(ready({ stateRevision: 3 }));
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Keep listening" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice recording" }));
    await waitFor(() => expect(voice.fake.plugin.stopCurrentInteraction).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, interactionId: "item" }));
    expect(await screen.findByRole("button", { name: "Start voice recording" })).toBeDisabled();
    await act(async () => { failAdoption(new Error("That recording has ended.")); });
    expect(screen.getByRole("button", { name: "Start voice recording" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(voice.fake.plugin.sendRecording).not.toHaveBeenCalled();
  });
  it("keeps saved dictation in the same toolbar while Off and after remount, with native recovery eligibility", async () => {
    const saved = recordingRecovery({ canRetryRecognition: false, captureIncomplete: true, reason: "Voice was turned off." });
    const state = voiceSnapshot({ recordingRecovery: saved });
    voice.fake.plugin.setConnection.mockResolvedValue(state);
    const view = renderControls(false);
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Saved dictation · Release review", "Voice was turned off."]);
    expect(card().querySelector(".voice-card-sub")).toHaveAttribute("title", "Voice was turned off.");
    expect(card()).not.toHaveAttribute("data-off");
    expect(screen.getByRole("button", { name: "Retry saved dictation" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Discard saved dictation" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start voice recording" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel voice recording" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open voice controls" }));
    const sheet = await screen.findByRole("dialog", { name: "Voice" });
    expect(sheet).toHaveTextContent("Needs transcription");
    expect(within(sheet).getByRole("button", { name: "Retry recognition" })).toHaveAttribute("aria-disabled", "true");
    expect(within(sheet).queryByRole("button", { name: /restore|composer/iu })).toBeNull();
    view.unmount();
    renderControls(false);
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()[0]).toBe("Saved dictation · Release review");
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(voice.fake.plugin.retryRecordingRecognition).not.toHaveBeenCalled();
  });
  it("retries saved audio with its revision, then offers Send separately when recognition completes", async () => {
    const saved = recordingRecovery({ revision: 7 });
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ phase: "recordingRecovery", actions: voiceActions(), recordingRecovery: saved }));
    const recognizing = ready({ stateRevision: 2, phase: "recognizing", actions: voiceActions(),
      active: item({ recording: { id: saved.recordingId, keepListening: false, reconnecting: false } }),
      recordingRecovery: { ...saved, revision: 8, stage: "recognizing", canRetryRecognition: false, canDiscard: true } });
    voice.fake.plugin.retryRecordingRecognition.mockResolvedValue(recognizing);
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Retry saved dictation" }));
    await waitFor(() => expect(voice.fake.plugin.retryRecordingRecognition).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, recordingId: "saved-recording", expectedRecoveryRevision: 7 }));
    await waitFor(() => expect(lines()).toEqual(["Saved dictation · Release review", "Transcribing…"]));
    expect(screen.queryByRole("button", { name: "Cancel voice recording" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard saved dictation" })).not.toHaveAttribute("aria-disabled");
    expect(voice.fake.plugin.sendRecoveredRecording).not.toHaveBeenCalled();
    const complete = voiceSnapshot({ stateRevision: 3, recordingRecovery: { ...saved, revision: 9, stage: "ready", hasUnrecognizedAudio: false, canRetryRecognition: false, canSend: true } });
    act(() => voice.fake.emit("stateChanged", complete));
    expect(lines()).toEqual(["Ready to send · Release review", "Not sent"]);
    expect(buttons()).toEqual(["Open voice controls", "Open thread: Release review", "Retry saved dictation", "Discard saved dictation", "Send saved dictation"]);
    voice.fake.plugin.sendRecoveredRecording.mockResolvedValue(voiceSnapshot({ stateRevision: 4 }));
    fireEvent.click(screen.getByRole("button", { name: "Send saved dictation" }));
    await waitFor(() => expect(voice.fake.plugin.sendRecoveredRecording).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, recordingId: "saved-recording", expectedRecoveryRevision: 9 }));
    expect(screen.queryByRole("group", { name: "Voice controls" })).toBeNull();
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();
    expect(voice.fake.plugin.resumeInput).not.toHaveBeenCalled();
  });
  it("keeps an older saved dictation accessible during new capture and explains its Keep listening restriction", async () => {
    const saved = recordingRecovery({ stage: "ready", hasUnrecognizedAudio: false, canRetryRecognition: false, canSend: true,
      admission: { mutationId: "original-input", status: "uncertain", cancelled: false } });
    const state = { ...capture(), recordingRecovery: saved,
      actions: { ...capture().actions, canSetKeepListening: false, keepListeningBlockedReason: "saved_recording_pending" as const } };
    voice.fake.plugin.setConnection.mockResolvedValue(state);
    renderControls();
    const keep = await screen.findByRole("button", { name: "Keep listening" });
    expect(keep).toHaveAttribute("aria-disabled", "true");
    expect(keep).toHaveAccessibleDescription("Resolve saved dictation first");
    expect(keep).toHaveAttribute("title", "Resolve saved dictation first");
    fireEvent.click(keep);
    expect(voice.fake.plugin.setKeepListening).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Saved dictation" }));
    const sheet = await screen.findByRole("dialog", { name: "Voice" });
    expect(sheet).toHaveTextContent("Resolve saved dictation first to enable Keep listening for the current recording.");
    voice.fake.plugin.discardRecording.mockResolvedValue({ ...capture(), stateRevision: 2 });
    fireEvent.click(within(sheet).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(voice.fake.plugin.discardRecording).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, recordingId: "saved-recording", expectedRecoveryRevision: 1 }));
    expect(voice.fake.plugin.stopCurrentInteraction).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Keep listening" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "Cancel voice recording" })).toBeEnabled();
  });
  it("sends interrupted saved text directly from the toolbar on an explicit Send", async () => {
    const saved = recordingRecovery({ stage: "ready", revision: 6, captureIncomplete: true, hasUnrecognizedAudio: false,
      canRetryRecognition: false, canSend: true });
    const native = voiceSnapshot({ recordingRecovery: saved });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.sendRecoveredRecording.mockResolvedValue({ ...native, stateRevision: 2,
      recordingRecovery: { ...saved, revision: 7, stage: "admitting", canSend: false } });
    renderControls(false);
    const toolbarSend = await screen.findByRole("button", { name: "Send saved dictation" });
    expect(lines()).toEqual(["Ready to send · Release review", "Recording interrupted"]);
    expect(toolbarSend).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(toolbarSend);
    expect(screen.queryByRole("dialog", { name: "Voice" })).toBeNull();
    await waitFor(() => expect(voice.fake.plugin.sendRecoveredRecording).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      recordingId: saved.recordingId, expectedRecoveryRevision: 6 }));
  });
  it.each(["retry", "send"] as const)("allows explicit Discard during recovered %s without an ordinary Stop or Cancel delete path", async operation => {
    const retry = operation === "retry";
    const saved = recordingRecovery({ stage: retry ? "interrupted" : "ready", revision: 2, hasUnrecognizedAudio: retry,
      canRetryRecognition: retry, canSend: !retry });
    voice.fake.plugin.setConnection.mockResolvedValue(voiceSnapshot({ recordingRecovery: saved }));
    const working = voiceSnapshot({ stateRevision: 2, phase: retry ? "recognizing" : "submitting", active: item({
      recording: { id: saved.recordingId, keepListening: false, reconnecting: false } }),
      actions: voiceActions(), recordingRecovery: { ...saved, revision: 3, stage: retry ? "recognizing" : "admitting",
        canRetryRecognition: false, canSend: false, canDiscard: true } });
    voice.fake.plugin[retry ? "retryRecordingRecognition" : "sendRecoveredRecording"].mockResolvedValue(working);
    voice.fake.plugin.discardRecording.mockResolvedValue(voiceSnapshot({ stateRevision: 3 }));
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: retry ? "Retry saved dictation" : "Send saved dictation" }));
    await waitFor(() => expect(lines()).toEqual(["Saved dictation · Release review", retry ? "Transcribing…" : "Sending…"]));
    expect(screen.queryByRole("button", { name: /Stop voice interaction|Cancel voice recording/ })).toBeNull();
    const discard = screen.getByRole("button", { name: "Discard saved dictation" });
    expect(discard).not.toHaveAttribute("aria-disabled");
    fireEvent.click(discard);
    await waitFor(() => expect(voice.fake.plugin.discardRecording).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      recordingId: saved.recordingId, expectedRecoveryRevision: 3 }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Voice controls" })).toBeNull());
    expect(voice.fake.plugin.stopCurrentInteraction).not.toHaveBeenCalled();
  });
  it("does not invent a navigation target for an unavailable saved recording", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(voiceSnapshot({ recordingRecovery: recordingRecovery({ stage: "unavailable",
      threadId: null, threadTitle: null, hasUnrecognizedAudio: false, canRetryRecognition: false }) }));
    renderControls();
    await screen.findByRole("group", { name: "Voice controls" });
    expect(lines()).toEqual(["Saved dictation · Unknown thread", "Saved dictation unavailable"]);
    expect(screen.queryByRole("button", { name: /^Open thread:/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard saved dictation" })).toBeInTheDocument();
  });
  it("shows storage failure with explicit reconnect instead of a phantom saved-recording spinner while Off", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(voiceSnapshot({ phase: "recordingRecovery", readiness: "storageUnavailable" }));
    renderControls(false);
    const retry = await screen.findByRole("button", { name: "Retry voice connection" });
    expect(card()).not.toHaveTextContent("Saved dictation");
    expect(card().querySelector(".lucide-loader-circle")).toBeNull();
    expect(card()).toHaveTextContent("Needs attention");
    fireEvent.click(retry);
    await waitFor(() => expect(voice.fake.plugin.setConnection).toHaveBeenLastCalledWith({ ...VOICE_CONNECTION, reconnect: true }));
  });
  it("offers Resume and its readiness reason while saved recognition is blocked", async () => {
    const saved = recordingRecovery({ canRetryRecognition: false });
    const native = ready({ phase: "recordingRecovery", ready: false, readiness: "needsResume",
      actions: voiceActions({ canResume: true }), recordingRecovery: saved });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.getState.mockResolvedValue(native);
    voice.fake.plugin.updateSettings.mockResolvedValue({ ...native, stateRevision: 2, settingsRevision: 1, ready: true, readiness: "ready",
      actions: voiceActions(), recordingRecovery: { ...saved, revision: 2, canRetryRecognition: true } });
    renderControls();
    const resume = await screen.findByRole("button", { name: "Resume voice" });
    expect(lines()).toEqual(["Saved dictation · Release review", "Voice needs to resume"]);
    expect(screen.queryByRole("button", { name: "Retry saved dictation" })).toBeNull();
    fireEvent.click(resume);
    await waitFor(() => expect(voice.fake.plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1,
      expectedRevision: 0, patch: { audioMode: "response" } }));
    await screen.findByRole("button", { name: "Retry saved dictation" });
    expect(voice.fake.plugin.retryRecordingRecognition).not.toHaveBeenCalled();
  });
  it("keeps Listening while visibly reporting a failed recording action", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(capture());
    voice.fake.plugin.retargetActiveRecognition.mockRejectedValue(new Error("The recording target could not be changed."));
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Change recording thread: Release review" }));
    const picker = await screen.findByRole("dialog", { name: "Choose target thread" });
    fireEvent.click(within(picker).getByRole("button", { name: "Untitled thread" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The recording target could not be changed.");
    expect(card().querySelector(".voice-card-title")).toHaveTextContent("The recording target could not be changed.");
    expect(card().querySelector(".voice-card-title")).toHaveAttribute("title", "The recording target could not be changed.");
    expect(lines()[1]).toBe("Listening");
    expect(screen.getByRole("button", { name: "Cancel voice recording" })).toBeEnabled();
  });
});

describe("voice controls card lifecycle", () => {
  it("restores the current foreground after Resume without a visibility event and bounds retries while the Activity is paused", async () => {
    let native = ready({ settings: voiceSettings({ audioMode: "response", voiceThreadId: "untitled", pinDefaultVoiceThread: false }) });
    let activityVisible = true;
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.getState.mockImplementation(async () => native);
    vi.mocked(voice.fake.asPlugin.setForegroundContext).mockImplementation(async context => {
      if (activityVisible) {
        native = { ...native, stateRevision: native.stateRevision + 1,
          foreground: { visible: context.visible, threadId: context.threadId ?? null, threadTitle: context.threadTitle ?? null } };
        voice.fake.emit("stateChanged", native);
      }
      return native;
    });
    vi.mocked(voice.fake.asPlugin.updateSettings).mockImplementation(async ({ patch }) => {
      // The explicit user action reconciles Android visibility, but native still has no foreground thread.
      activityVisible = true;
      native = { ...native, stateRevision: native.stateRevision + 1, settingsRevision: native.settingsRevision + 1,
        settings: { ...native.settings, ...patch }, phase: "starting", readiness: "starting", actions: { ...idleActions, canStart: false } };
      return native;
    });
    navigate(threadPath("named"), { replace: true });
    renderControls();
    await waitFor(() => expect(native.foreground).toEqual({ visible: true, threadId: "named", threadTitle: "Release review" }));
    expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalledTimes(1);
    expect(document.visibilityState).toBe("visible");

    // Android clears its context while the WebView still reports visible. The bounded retry is rejected.
    activityVisible = false;
    native = { ...native, stateRevision: native.stateRevision + 1, phase: "off", ready: false, readiness: "needsResume",
      foreground: { visible: false, threadId: null, threadTitle: null }, actions: { ...idleActions, canStart: false, canResume: true } };
    act(() => voice.fake.emit("stateChanged", native));
    await waitFor(() => expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 3; index++) {
      native = { ...native, stateRevision: native.stateRevision + 1 };
      act(() => voice.fake.emit("stateChanged", native));
    }
    expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalledTimes(2);
    expect(native.foreground.visible).toBe(false);

    // Recovery uses the newest route, even if it changed while Android rejected foreground updates.
    act(() => navigate(threadPath("long")));
    await waitFor(() => expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalledTimes(3));
    expect(native.foreground.threadId).toBeNull();
    fireEvent.click(within(card()).getByRole("button", { name: "Resume voice" }));
    await waitFor(() => expect(native.foreground).toEqual({ visible: true, threadId: "long", threadTitle: "L".repeat(512) }));
    expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalledTimes(4);
    expect(voice.fake.plugin.setForegroundContext).toHaveBeenLastCalledWith({ expectedConnectionGeneration: 1, visible: true,
      threadId: "long", threadTitle: "L".repeat(512), composerMode: "steer" });
    // This is the foreground contract native headset/notification Start uses when the recording pin is off.
    expect(native.settings.pinDefaultVoiceThread).toBe(false);
    expect(native.settings.voiceThreadId).toBe("untitled");
    expect(voice.fake.plugin.startManualListen).not.toHaveBeenCalled();

    native = { ...native, stateRevision: native.stateRevision + 1, phase: "idle", ready: true, readiness: "ready", actions: idleActions };
    act(() => voice.fake.emit("stateChanged", native));
    await waitFor(() => expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalledTimes(5));
    native = { ...native, connectionGeneration: 2, stateRevision: 1, foreground: { visible: false, threadId: null, threadTitle: null } };
    act(() => voice.fake.emit("stateChanged", native));
    await waitFor(() => expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalledTimes(6));
    expect(voice.fake.plugin.setForegroundContext).toHaveBeenLastCalledWith({ expectedConnectionGeneration: 2, visible: true,
      threadId: "long", threadTitle: "L".repeat(512), composerMode: "steer" });
  });
  it("resends foreground after a successful mode write even when native readiness stays unchanged", async () => {
    const native = ready({ foreground: { visible: false, threadId: null, threadTitle: null } });
    voice.fake.plugin.setConnection.mockResolvedValue(native);
    voice.fake.plugin.getState.mockResolvedValue(native);
    voice.fake.plugin.updateSettings.mockResolvedValue({ ...native, stateRevision: 2, settingsRevision: 1,
      settings: { ...native.settings, audioMode: "manual" } });
    navigate(threadPath("named"), { replace: true });
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Open voice controls" }));
    expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalledTimes(1);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Voice" })).getByRole("radio", { name: "Manual" }));
    await waitFor(() => expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalledTimes(2));
    expect(voice.fake.plugin.setForegroundContext).toHaveBeenLastCalledWith({ expectedConnectionGeneration: 1, visible: true,
      threadId: "named", threadTitle: "Release review", composerMode: "steer" });
  });
  it("does not reopen the sheet or the picker by itself after voice reconnects", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready());
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Open voice controls" }));
    const sheet = await screen.findByRole("dialog", { name: "Voice" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Default voice thread" }));
    await screen.findByRole("dialog", { name: "Default voice thread" });
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
  it("keeps focus on the separate chevron while retargeting without moving the viewed thread", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({ recognitionThreadId: "named", recognitionThreadTitle: "Release review" }));
    let settle: (state: NativeVoiceState) => void = () => undefined;
    voice.fake.plugin.retargetActiveRecognition.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    navigate(threadPath("named"), { replace: true });
    renderControls();
    const chip = await screen.findByRole("button", { name: "Change recording thread: Release review" });
    chip.focus();
    fireEvent.click(chip);
    fireEvent.click(within(await screen.findByRole("list", { name: "Voice threads" })).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(voice.fake.plugin.retargetActiveRecognition).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Voice threads" })).toBeNull());
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).toHaveFocus();
    // A pending retarget does not open a second picker.
    fireEvent.click(chip);
    expect(screen.queryByRole("list", { name: "Voice threads" })).toBeNull();
    await act(async () => { settle({ ...listening({ recognitionThreadId: "untitled" }), stateRevision: 2 }); });
    expect(lines()).toEqual(["Untitled thread", "Listening"]);
    expect(screen.getByRole("button", { name: "Change recording thread: Untitled thread" })).toBe(chip);
    expect(within(card()).getByRole("status")).toHaveTextContent(/^Untitled thread\. Listening$/u);
    expect(chip).not.toHaveAttribute("aria-disabled");
    expect(chip).toHaveFocus();
    expect(window.location.pathname).toBe(threadPath("named"));
    expect(screen.getByRole("button", { name: "Open thread: Untitled thread" })).toBeInTheDocument();
  });
  it("stays quiet on Settings → Voice, which announces readiness and errors itself", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(ready({ ready: false, readiness: "starting" }));
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
