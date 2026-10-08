// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectedAssistantResultSchema } from "../../../shared/protocol/notification.js";
import { PAYLOAD_LIMITS } from "../../../shared/protocol/payload.js";
import type { TurnReplySpeech } from "../../../shared/protocol/turn-reply-speech.js";
import { ApiError } from "../../api/ApiClient.js";
import { NativeVoiceStore } from "../../voice/NativeVoiceStore.js";
import type { NativeVoiceState } from "../../voice/native-voice-plugin.js";
import { fakeVoicePlugin, recordingRecovery, VOICE_CONNECTION, voiceActions, voiceSettings, voiceSnapshot } from "../../voice/native-voice-test-fixture.js";

const voiceContext = vi.hoisted(() => ({ store: null as NativeVoiceStore | null }));
vi.mock("../../voice/VoiceProvider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../voice/VoiceProvider.js")>(),
  useNativeVoice: () => voiceContext.store,
}));

import { TurnSpeakAction } from "./TurnSpeakAction.js";

const ready = (patch: Partial<NativeVoiceState> = {}) => voiceSnapshot({ ready: true, readiness: "ready", phase: "idle",
  settings: voiceSettings({ audioMode: "response" }), speech: { ...voiceSnapshot().speech, credentialConfigured: true },
  actions: voiceActions({ canStart: true }), ...patch });
const stored: TurnReplySpeech = { assistantResult: { final: { text: "Stored final answer." }, unclassified: null } };

async function connect(native: NativeVoiceState = ready()) {
  const fake = fakeVoicePlugin();
  fake.plugin.setConnection.mockResolvedValue(native);
  fake.plugin.speakReply.mockResolvedValue(ready({ stateRevision: 2 }));
  const store = new NativeVoiceStore(fake.asPlugin, VOICE_CONNECTION, vi.fn());
  await store.initialize();
  voiceContext.store = store;
  return { fake, store };
}
function renderAction(read: (turnId: string) => Promise<TurnReplySpeech> = async () => stored, ...text: [copyText?: string | undefined]) {
  const copyText = text.length ? text[0] : "Whole reply text.";
  const thread = { title: { text: "Release review" } };
  const source = { threadId: "thread-1", readTurnReplySpeech: vi.fn(read), getSnapshot: () => ({ snapshot: { thread } }) };
  const view = render(<TurnSpeakAction store={source} turnId="turn-1" copyText={copyText} />);
  return { ...view, read: source.readTurnReplySpeech, thread };
}
const button = () => screen.getByRole("button", { name: "Play response aloud" });
const icon = () => button().querySelector("svg")!.getAttribute("class");
const status = () => screen.getByRole("status");

afterEach(() => {
  cleanup();
  voiceContext.store?.dispose();
  voiceContext.store = null;
  vi.useRealTimers();
});

describe("TurnSpeakAction", () => {
  it("renders only with native voice and reply text", async () => {
    const { container } = renderAction();
    expect(container).toBeEmptyDOMElement();
    cleanup();
    await connect();
    expect(renderAction(undefined, undefined).container).toBeEmptyDOMElement();
    cleanup();
    expect(renderAction(undefined, "").container).toBeEmptyDOMElement();
    cleanup();
    renderAction();
    expect(button()).toHaveAttribute("title", "Play response aloud");
    expect(button()).not.toHaveAttribute("aria-disabled");
    expect(icon()).toContain("lucide-volume-2");
    expect(status()).toBeEmptyDOMElement();
  });

  it.each([
    ["while voice is Off", ready({ settings: voiceSettings({ audioMode: "off" }) })],
    ["without a speech credential", ready({ speech: { ...voiceSnapshot().speech, credentialConfigured: false } })],
    ["without a speech voice", ready({ settings: voiceSettings({ audioMode: "manual", ttsVoice: "" }) })],
  ])("takes no space %s and appears once voice can speak", async (_name, native) => {
    const { fake } = await connect(native);
    const { container } = renderAction();
    expect(container).toBeEmptyDOMElement();
    act(() => fake.emit("stateChanged", ready({ stateRevision: 5, settings: voiceSettings({ audioMode: "manual" }) })));
    expect(button()).not.toHaveAttribute("aria-disabled");
    act(() => fake.emit("stateChanged", ready({ stateRevision: 6, settings: voiceSettings({ audioMode: "off" }) })));
    expect(container).toBeEmptyDOMElement();
  });

  it("takes no space before native voice state loads", () => {
    const fake = fakeVoicePlugin();
    voiceContext.store = new NativeVoiceStore(fake.asPlugin, VOICE_CONNECTION, vi.fn());
    expect(renderAction().container).toBeEmptyDOMElement();
  });

  it("speaks the server's stored completion text, then restores the speaker after 1800 ms", async () => {
    const { fake } = await connect();
    const { read } = renderAction();
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(button()); });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(read).toHaveBeenCalledExactlyOnceWith("turn-1");
    expect(fake.plugin.speakReply).toHaveBeenCalledExactlyOnceWith({
      expectedConnectionGeneration: 1, threadId: "thread-1", turnId: "turn-1", threadTitle: "Release review", assistantResult: stored.assistantResult,
    });
    expect(status()).toHaveTextContent(/^Queued to play$/u);
    expect(icon()).toContain("lucide-check");
    expect(button()).not.toHaveAttribute("aria-busy");
    await act(() => vi.advanceTimersByTimeAsync(1799));
    expect(icon()).toContain("lucide-check");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(icon()).toContain("lucide-volume-2");
    expect(status()).toBeEmptyDOMElement();
  });

  const speaking = (eventKind: string, threadId: string) => ready({ phase: "speaking", actions: voiceActions({ canStop: true, canSkip: true }),
    active: { id: "item", eventKind, threadId, threadTitle: null, recognitionThreadId: null, recognitionThreadTitle: null,
      automatic: eventKind !== "replay", recording: null } });
  it.each([
    ["behind current speech", speaking("turn.completed", "other"), { queue: { count: 1, bytes: 40, droppedCount: 0, droppedReasons: {} } }],
    // Idle-looking voice can still hold the queue: the replay waits until the saved dictation is resolved.
    ["behind a saved dictation", ready({ phase: "recordingRecovery", recordingRecovery: recordingRecovery() }),
      { queue: { count: 1, bytes: 40, droppedCount: 0, droppedReasons: {} } }],
    // Native keeps the replay already queued or playing for this turn and adds nothing.
    ["when this turn's replay is already playing", speaking("replay", "thread-1"), {}],
  ])("announces only Queued to play %s", async (_name, native, after) => {
    const { fake } = await connect(native);
    fake.plugin.speakReply.mockResolvedValue({ ...native, ...after, stateRevision: native.stateRevision + 1 });
    renderAction();
    fireEvent.click(button());
    await waitFor(() => expect(status()).toHaveTextContent(/^Queued to play$/u));
    expect(icon()).toContain("lucide-check");
    expect(fake.plugin.speakReply).toHaveBeenCalledOnce();
  });

  it.each([
    ["trimmed", "  Renamed review \n", "Renamed review"],
    ["cut to 512 UTF-16 units without splitting a code point", `${"t".repeat(511)}😀 tail`, "t".repeat(511)],
    ["omitted when blank", " \n", undefined],
  ])("sends the thread's current title %s", async (_name, title, sent) => {
    const { fake } = await connect();
    const { thread } = renderAction();
    // A rename after the footer rendered still reaches native: the title is read when tapped.
    thread.title.text = title;
    fireEvent.click(button());
    await waitFor(() => expect(fake.plugin.speakReply).toHaveBeenCalledOnce());
    const input = fake.plugin.speakReply.mock.lastCall![0];
    expect(input.threadTitle).toBe(sent);
    expect("threadTitle" in input).toBe(sent !== undefined);
  });

  it.each([
    ["no stored result", null],
    ["only blank stored sections", { provisional: { text: " \n" }, unclassified: null, final: { text: "" } }],
    ["no selected phases", {}],
  ])("falls back to the whole reply with %s", async (_name, assistantResult) => {
    const { fake } = await connect();
    renderAction(async () => ({ assistantResult }));
    fireEvent.click(button());
    await waitFor(() => expect(status()).toHaveTextContent("Queued to play"));
    expect(fake.plugin.speakReply.mock.lastCall?.[0].assistantResult).toEqual({ unclassified: { text: "Whole reply text." } });
  });

  it("bounds a long fallback reply like bounded text without splitting a code point", async () => {
    const { fake } = await connect();
    const limit = PAYLOAD_LIMITS.textCharacters;
    // The emoji's high surrogate sits at the last code unit before the ellipsis.
    const copyText = `${"a".repeat(limit - 2)}😀${"b".repeat(100)}`;
    renderAction(async () => ({ assistantResult: null }), copyText);
    fireEvent.click(button());
    await waitFor(() => expect(fake.plugin.speakReply).toHaveBeenCalledOnce());
    const result = fake.plugin.speakReply.mock.lastCall![0].assistantResult;
    const text = `${"a".repeat(limit - 2)}…`;
    expect(result).toEqual({ unclassified: { text, truncation: { truncated: true, retainedBytes: new TextEncoder().encode(text).byteLength, reason: "byte_limit" } } });
    expect(selectedAssistantResultSchema.parse(result)).toEqual(result);
  });

  it("shows a failed read without reading the fallback", async () => {
    const { fake } = await connect();
    renderAction(async () => { throw new ApiError(503, "service_unavailable", "Sedes is unavailable.", true); });
    fireEvent.click(button());
    await waitFor(() => expect(status()).toHaveTextContent(/^Couldn't load the response to play$/u));
    expect(icon()).toContain("lucide-x");
    expect(fake.plugin.speakReply).not.toHaveBeenCalled();
  });

  it.each([
    ["voice_not_ready", "Voice is not ready to record yet.", "Voice isn't ready"],
    ["voice_reply_empty", "Nothing to speak.", "This response has nothing to read aloud"],
    ["voice_queue_full", "Queue full.", "The voice queue is full"],
    ["connection_changed", "The Sedes connection changed before the voice action finished.", "The Sedes connection changed before the voice action finished."],
  ])("shows native %s as the failure reason", async (code, message, reason) => {
    const { fake, store } = await connect();
    fake.plugin.speakReply.mockRejectedValue(Object.assign(new Error(message), { code }));
    renderAction();
    fireEvent.click(button());
    await waitFor(() => expect(status()).toHaveTextContent(reason));
    expect(icon()).toContain("lucide-x");
    // The voice card reports the failed action as it does for every voice action.
    expect(store.getSnapshot().error).toBe(message);
  });

  it("sends one request while a tap is pending", async () => {
    const { fake } = await connect();
    let release!: (value: TurnReplySpeech) => void;
    const { read } = renderAction(() => new Promise(resolve => { release = resolve; }));
    const target = button();
    fireEvent.click(target);
    fireEvent.click(target);
    await waitFor(() => expect(button()).toHaveAttribute("aria-busy", "true"));
    expect(button().querySelector(".turn-fork-spinner")).not.toBeNull();
    fireEvent.click(button());
    expect(read).toHaveBeenCalledOnce();
    release(stored);
    await waitFor(() => expect(status()).toHaveTextContent("Queued to play"));
    expect(fake.plugin.speakReply).toHaveBeenCalledOnce();
  });
});
