import { describe, expect, it, vi } from "vitest";
import { base64Pcm, ElectronCapturePolicy, ElectronVoiceSegmenter, MemoryVoiceRecording, VOICE_PACKET_BYTES } from "./electron-voice-recording.js";
import { electronVoiceDefaults } from "./electron-voice-state.js";
import type { ElectronSpeechBinding } from "./electron-speech-plugin.js";

function pcm(samples = 2400, amplitude = 3000): Uint8Array {
  const bytes = new Uint8Array(samples * 2), view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index++) view.setInt16(index * 2, amplitude, true);
  return bytes;
}
function join(values: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(values.reduce((sum, item) => sum + item.byteLength, 0));
  let offset = 0; for (const item of values) { bytes.set(item, offset); offset += item.byteLength; } return bytes;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function transport(hardSeconds = 60, sessionSeconds = 3600) {
  return { startRecognition: vi.fn(async (_input: ElectronSpeechBinding & { requestId: string; model: string }) => ({
    maxBufferBytes: hardSeconds * 48_000, maxRecordingSeconds: hardSeconds, maxSessionSeconds: sessionSeconds })),
  appendAudio: vi.fn(async (_input: { requestId: string; pcm: string }) => {}),
  commitRecognition: vi.fn(async (_input: { requestId: string }) => ({ transcript: " word " })),
  cancel: vi.fn(async (_input: { requestId: string }) => {}) };
}

describe("in-memory speech segmentation", () => {
  it("streams stable PCM while retaining one second for a possible hard boundary", () => {
    const packets: Uint8Array[] = [], commits: number[] = [];
    const segmenter = new ElectronVoiceSegmenter(60, packet => packets.push(packet), () => commits.push(packets.length));
    for (let index = 0; index < 12; index++) segmenter.accept(pcm());
    expect(packets).toHaveLength(2); expect(commits).toEqual([]);
    segmenter.finish(); expect(packets).toHaveLength(12); expect(commits).toEqual([12]);
  });

  it("cuts at quiet energy near a hard limit without dropping or overlapping any real sample", () => {
    const packets: Uint8Array[] = [], commits: number[] = [], original: Uint8Array[] = [];
    const segmenter = new ElectronVoiceSegmenter(5, packet => packets.push(packet), () => commits.push(packets.length));
    for (let index = 0; index < 60; index++) {
      const packet = pcm(2400, index === 45 ? 500 : 3000 + index); original.push(packet); segmenter.accept(packet);
    }
    segmenter.finish();
    expect(commits).toEqual([46, 60]); expect(join(packets)).toEqual(join(original));
    expect(packets.every(packet => packet.byteLength <= VOICE_PACKET_BYTES)).toBe(true);
  });

  it("pads only the final short segment and supports capture callbacks that split frames", () => {
    const packets: Uint8Array[] = [], committed = vi.fn();
    const segmenter = new ElectronVoiceSegmenter(5, packet => packets.push(packet), committed);
    const original = pcm(1250);
    segmenter.accept(original.slice(0, 500)); segmenter.accept(original.slice(500)); segmenter.finish(); segmenter.finish();
    expect(packets).toHaveLength(1); expect(packets[0]!.byteLength).toBe(4800);
    expect(packets[0]!.slice(0, original.byteLength)).toEqual(original);
    expect(packets[0]!.slice(original.byteLength).every(value => value === 0)).toBe(true);
    expect(committed).toHaveBeenCalledOnce();
  });

  it("seals at a detected pause and never sends an empty commit", () => {
    const packets: Uint8Array[] = [], commits: number[] = [];
    const segmenter = new ElectronVoiceSegmenter(60, packet => packets.push(packet), () => commits.push(packets.length));
    segmenter.accept(pcm()); for (let index = 0; index < 12; index++) segmenter.accept(pcm(2400, 0));
    expect(commits).toEqual([13]); segmenter.finish(); expect(commits).toEqual([13]);
    const empty = new ElectronVoiceSegmenter(60, () => { throw new Error("empty packet"); }, () => { throw new Error("empty commit"); });
    empty.finish();
  });
});

describe("sample-clock recording endpoints", () => {
  it("separates no-speech timeouts from trailing silence after speech", () => {
    const settings = { ...electronVoiceDefaults(), recognitionStartTimeoutMs: 200, recognitionEndSilenceMs: 200 };
    const quiet = new ElectronCapturePolicy(settings);
    expect(quiet.accept(pcm(2400, 0))).toBe("continue"); expect(quiet.accept(pcm(2400, 0))).toBe("no_speech");
    const spoken = new ElectronCapturePolicy(settings);
    expect(spoken.accept(pcm())).toBe("continue"); expect(spoken.accept(pcm(2400, 0))).toBe("continue");
    expect(spoken.accept(pcm(2400, 0))).toBe("silence");
  });
  it("disabling Keep listening starts fresh endpoint clocks without forgetting speech", () => {
    const capture = new ElectronCapturePolicy({ ...electronVoiceDefaults(), keepListeningByDefault: true, recognitionEndSilenceMs: 200 });
    capture.accept(pcm()); for (let index = 0; index < 30; index++) expect(capture.accept(pcm(2400, 0))).toBe("continue");
    capture.setHeld(false);
    expect(capture.accept(pcm(2400, 0))).toBe("continue"); expect(capture.accept(pcm(2400, 0))).toBe("silence");
  });
});

describe("live recording coordinator", () => {
  it.each(["openai", "server"] as const)("binds every recognition session explicitly to %s", async provider => {
    let now = 0;
    const speech = transport(5, 180);
    const settings = { ...electronVoiceDefaults(), speechProvider: provider,
      speechEndpoint: provider === "openai" ? "https://api.openai.com/v1" : "https://speech.test/v1", recognitionResultTimeoutMs: 1000 };
    const recording = new MemoryVoiceRecording({ speech, settings, failed: vi.fn(), now: () => now });
    await recording.start();
    for (let index = 0; index < 50; index++) recording.accept(pcm());
    await vi.waitFor(() => expect(speech.commitRecognition).toHaveBeenCalledOnce());
    now = 160_000;
    recording.accept(pcm()); await recording.finish();
    expect(speech.startRecognition).toHaveBeenCalledTimes(2);
    for (const [call] of speech.startRecognition.mock.calls)
      expect(call).toEqual({ requestId: expect.any(String), provider, endpoint: settings.speechEndpoint, model: settings.sttModel });
    expect(speech.startRecognition.mock.calls[0]![0].requestId).not.toBe(speech.startRecognition.mock.calls[1]![0].requestId);
  });

  it("uploads while capturing, waits for every committed result, and preserves repeated words across segments", async () => {
    const speech = transport(5), failure = vi.fn();
    const recording = new MemoryVoiceRecording({ speech, settings: electronVoiceDefaults(), failed: failure });
    await recording.start();
    for (let index = 0; index < 100; index++) recording.accept(pcm());
    expect(await recording.finish()).toBe("word word");
    expect(speech.startRecognition).toHaveBeenCalledOnce(); expect(speech.commitRecognition).toHaveBeenCalledTimes(2);
    expect(join(speech.appendAudio.mock.calls.map(([call]) => base64Pcm(call.pcm)))).toEqual(join(Array.from({ length: 100 }, () => pcm())));
    expect(failure).not.toHaveBeenCalled();
  });

  it("waits for in-flight transcription on Send instead of submitting a partial result", async () => {
    const speech = transport(5), result = deferred<{ transcript: string }>();
    speech.commitRecognition.mockImplementationOnce(() => result.promise);
    const recording = new MemoryVoiceRecording({ speech, settings: electronVoiceDefaults(), failed: vi.fn() });
    await recording.start(); recording.accept(pcm());
    const finished = vi.fn(); const waiting = recording.finish().then(finished);
    await vi.waitFor(() => expect(speech.commitRecognition).toHaveBeenCalledOnce());
    expect(finished).not.toHaveBeenCalled(); result.resolve({ transcript: "Complete transcript" }); await waiting;
    expect(finished).toHaveBeenCalledWith("Complete transcript");
  });

  it("cancels on a failed upload without reconnecting or replaying accepted audio", async () => {
    const speech = transport(), failed = vi.fn(); speech.appendAudio.mockRejectedValueOnce(new Error("network lost"));
    const recording = new MemoryVoiceRecording({ speech, settings: electronVoiceDefaults(), failed });
    await recording.start(); for (let index = 0; index < 12; index++) recording.accept(pcm());
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    await expect(recording.finish()).rejects.toThrow("network lost");
    expect(speech.startRecognition).toHaveBeenCalledOnce(); expect(speech.appendAudio).toHaveBeenCalledOnce();
    expect(speech.commitRecognition).not.toHaveBeenCalled(); expect(speech.cancel).toHaveBeenCalledOnce();
  });

  it("rotates expiring sessions at a normal segment boundary without replaying a resolved segment", async () => {
    let now = 0;
    const speech = transport(5, 180), failed = vi.fn();
    const recording = new MemoryVoiceRecording({ speech, settings: { ...electronVoiceDefaults(), recognitionResultTimeoutMs: 1000 }, failed, now: () => now });
    await recording.start(); for (let index = 0; index < 50; index++) recording.accept(pcm());
    await vi.waitFor(() => expect(speech.commitRecognition).toHaveBeenCalledOnce());
    now = 160_000;
    recording.accept(pcm()); expect(await recording.finish()).toBe("word word");
    expect(speech.startRecognition).toHaveBeenCalledTimes(2); expect(speech.commitRecognition).toHaveBeenCalledTimes(2);
    expect(speech.appendAudio).toHaveBeenCalledTimes(51); expect(failed).not.toHaveBeenCalled();
  });

  it("cancellation fences a late final transcript and never invokes failure/retry", async () => {
    const speech = transport(), result = deferred<{ transcript: string }>(), failed = vi.fn();
    speech.commitRecognition.mockImplementationOnce(() => result.promise);
    const recording = new MemoryVoiceRecording({ speech, settings: electronVoiceDefaults(), failed });
    await recording.start(); recording.accept(pcm());
    const finishing = recording.finish(); const rejected = expect(finishing).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(speech.commitRecognition).toHaveBeenCalledOnce());
    recording.cancel(); result.resolve({ transcript: "Late transcript" }); await rejected;
    expect(failed).not.toHaveBeenCalled(); expect(speech.startRecognition).toHaveBeenCalledOnce();
  });
});
