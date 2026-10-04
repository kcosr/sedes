// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { navigate, threadPath } from "../app/router.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";
import { fakeVoicePlugin, VOICE_CONNECTION, VOICE_IDENTITY, voiceSettings, voiceSnapshot } from "./native-voice-test-fixture.js";

const voice = vi.hoisted(() => ({ fake: undefined as unknown as ReturnType<typeof fakeVoicePlugin> }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })) } }));
vi.mock("./native-voice-plugin.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./native-voice-plugin.js")>(),
  hasNativeVoice: () => true,
  nativeVoice: new Proxy({}, { get: (_target, key) => Reflect.get(voice.fake.plugin, key) }),
}));

import { VoiceProvider } from "./VoiceProvider.js";
import { VoiceControls } from "./VoiceControls.js";

const longTitle = "L".repeat(600);
const thread = (id: string, title: string) => ({ id, title: { text: title }, available: true, inventoryState: "active" }) as unknown as NormalizedApplicationThreadSummary;
const threads = [thread("long", longTitle), thread("untitled", "  "), thread("named", "Release review")];
const ready = (patch: Partial<NativeVoiceState> = {}) => voiceSnapshot({ ready: true, readiness: "ready", phase: "idle", settings: voiceSettings({ audioMode: "response" }),
  actions: { canStart: true, canStop: false, canSkip: false, canRetarget: false, canResume: false }, ...patch });
const listening = (active: Partial<NonNullable<NativeVoiceState["active"]>>) => ready({ phase: "listening",
  actions: { canStart: false, canStop: true, canSkip: false, canRetarget: true, canResume: false },
  active: { id: "item", eventKind: null, threadId: null, threadTitle: null, recognitionThreadId: null, recognitionThreadTitle: null, automatic: false, ...active } });
function renderControls() {
  return render(<VoiceProvider profileId={VOICE_CONNECTION.profileId} serverOrigin={VOICE_CONNECTION.serverOrigin} identity={VOICE_IDENTITY}>
    <VoiceControls threads={threads} /></VoiceProvider>);
}
beforeEach(() => { voice.fake = fakeVoicePlugin(); navigate("/", { replace: true }); });
afterEach(() => { cleanup(); });

describe("voice controls bar", () => {
  it("renders no bar while native voice is unavailable", async () => {
    voice.fake.plugin.setConnection.mockRejectedValue(new Error("Server unavailable"));
    renderControls();
    await waitFor(() => expect(voice.fake.plugin.setConnection).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByRole("group", { name: "Voice controls" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("renders no bar while voice is off and shows it once voice is enabled", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(voiceSnapshot());
    renderControls();
    await waitFor(() => expect(voice.fake.plugin.setForegroundContext).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Voice controls" })).toBeNull();
    act(() => voice.fake.emit("stateChanged", ready({ stateRevision: 2 })));
    expect(screen.getByRole("group", { name: "Voice controls" })).toBeInTheDocument();
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
  it("names the recording target with its visible title and retargets through a list of threads", async () => {
    voice.fake.plugin.setConnection.mockResolvedValue(listening({ recognitionThreadId: "long", recognitionThreadTitle: "L".repeat(512) }));
    voice.fake.plugin.retargetActiveRecognition.mockResolvedValue(listening({ recognitionThreadId: "untitled" }));
    renderControls();
    const chip = await screen.findByRole("button", { name: `Change recording target: ${"L".repeat(512)}` });
    expect(chip.querySelector(".voice-thread")).toHaveTextContent("L".repeat(512));
    expect(screen.getByRole("status")).toHaveTextContent("Listening");
    fireEvent.click(chip);
    const list = await screen.findByRole("list", { name: "Voice threads" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(list).getByRole("button", { name: "Untitled thread" }));
    await waitFor(() => expect(voice.fake.plugin.retargetActiveRecognition).toHaveBeenCalledTimes(1));
    expect(voice.fake.plugin.retargetActiveRecognition.mock.lastCall).toEqual([{ expectedConnectionGeneration: 1, threadId: "untitled", threadTitle: undefined }]);
    expect(await screen.findByRole("button", { name: "Change recording target: Untitled thread" })).toBeInTheDocument();
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
  });
});
