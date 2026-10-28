import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronVoiceAudio } from "./electron-voice-audio.js";
import { CapturePcmEncoder, CAPTURE_PACKET_FRAMES } from "./electron-voice-capture-worklet.js";

class FakeTrack extends EventTarget {
  deviceId = "usb-microphone";
  stop = vi.fn();
  getSettings() { return { deviceId: this.deviceId, sampleRate: 48_000 }; }
}
class FakeMedia extends EventTarget {
  track = new FakeTrack();
  stream = { getAudioTracks: () => [this.track], getTracks: () => [this.track] };
  devices = [{ kind: "audioinput", deviceId: "usb-microphone", label: "USB microphone" }];
  enumerateDevices = vi.fn(async () => this.devices);
  getUserMedia = vi.fn(async () => this.stream);
}
class FakeSource {
  buffer?: { samples: Float32Array; length: number };
  onended?: (() => void) | null;
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  end() { this.onended?.(); }
}
class FakeContext extends EventTarget {
  sampleRate = 24_000;
  currentTime = 0;
  baseLatency = 0;
  outputLatency = 0;
  state = "running";
  destination = {};
  sources: FakeSource[] = [];
  input = { connect: vi.fn(), disconnect: vi.fn() };
  gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => { this.state = "closed"; });
  createGain() { return this.gain; }
  createMediaStreamSource() { return this.input; }
  createBuffer(_channels: number, frames: number, rate: number) {
    expect(rate).toBe(24_000);
    const samples = new Float32Array(frames);
    return { samples, length: frames, copyToChannel: (data: Float32Array) => samples.set(data) };
  }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
}
class FakeWorklet extends EventTarget {
  connect = vi.fn();
  disconnect = vi.fn();
  tail?: Uint8Array;
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn((data: { type: string }) => {
      if (data.type === "stop") queueMicrotask(() => {
        if (this.tail) this.packet(this.tail, 99);
        this.port.onmessage?.({ data: { type: "stopped" } } as MessageEvent);
      });
    }),
    close: vi.fn(),
  };
  packet(pcm: Uint8Array, sequence = 0) {
    this.port.onmessage?.({ data: { type: "pcm", sequence, buffer: pcm.buffer } } as MessageEvent);
  }
}
function setup() {
  const context = new FakeContext();
  const media = new FakeMedia();
  const worklet = new FakeWorklet();
  const createAudioContext = vi.fn(() => context as unknown as AudioContext);
  const onDevicesChanged = vi.fn();
  const audio = new ElectronVoiceAudio({
    mediaDevices: media as unknown as MediaDevices,
    createAudioContext,
    createWorkletNode: () => worklet as unknown as AudioWorkletNode,
    workletUrl: "/capture.js", onDevicesChanged,
  });
  return { audio, context, media, worklet, createAudioContext, onDevicesChanged };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Electron microphone PCM", () => {
  it("mixes channels, saturates samples, and writes signed little-endian PCM without losing the final tail", () => {
    const encoder = new CapturePcmEncoder();
    expect(encoder.append([new Float32Array([-1, 1, 0.5, -0.5, 2, NaN]), new Float32Array([-1, 1, -0.5, -0.5, 2, NaN])])).toEqual([]);
    const tail = encoder.flush()!;
    const view = new DataView(tail.buffer);
    expect(Array.from({ length: tail.length / 2 }, (_, index) => view.getInt16(index * 2, true))).toEqual([-32_768, 32_767, 0, -16_384, 32_767, 0]);
    expect([...tail.slice(0, 4)]).toEqual([0, 128, 255, 127]);
    expect(encoder.flush()).toBeUndefined();
  });

  it("retains every frame across irregular worklet boundaries in bounded 100 ms packets", () => {
    const encoder = new CapturePcmEncoder();
    const packets: Uint8Array[] = [];
    for (let index = 0; index < 40; index++) packets.push(...encoder.append([new Float32Array(128).fill(0.25)]));
    expect(packets.map(packet => packet.length)).toEqual([CAPTURE_PACKET_FRAMES * 2, CAPTURE_PACKET_FRAMES * 2]);
    const tail = encoder.flush()!;
    expect(packets.reduce((sum, packet) => sum + packet.length / 2, tail.length / 2)).toBe(40 * 128);
    expect(tail.length / 2).toBe(320);
  });

  it("bounds unacknowledged worklet audio and flushes a partial quantum on explicit stop", async () => {
    vi.resetModules();
    type Processor = { port: { postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null }; process(inputs: Float32Array[][]): boolean };
    let ProcessorClass!: new () => Processor;
    vi.stubGlobal("AudioWorkletProcessor", class {
      port = { postMessage: vi.fn(), onmessage: null };
    });
    vi.stubGlobal("registerProcessor", (_name: string, implementation: new () => Processor) => { ProcessorClass = implementation; });
    vi.stubGlobal("sampleRate", 24_000);
    await import("./electron-voice-capture-worklet.js");
    const processor = new ProcessorClass();
    for (let index = 0; index < 5; index++) expect(processor.process([[new Float32Array(2_400)]])).toBe(true);
    expect(processor.process([[new Float32Array(2_400)]])).toBe(false);
    expect(processor.port.postMessage.mock.calls.filter(([value]) => value.type === "pcm")).toHaveLength(5);
    expect(processor.port.postMessage).toHaveBeenLastCalledWith({ type: "error", code: "microphone_queue_full" });

    const tail = new ProcessorClass();
    expect(tail.process([[new Float32Array(128).fill(0.5)]])).toBe(true);
    tail.port.onmessage!({ data: { type: "stop" } });
    expect(tail.port.postMessage.mock.calls[0]![0]).toMatchObject({ type: "pcm", sequence: 0 });
    expect((tail.port.postMessage.mock.calls[0]![0].buffer as ArrayBuffer).byteLength).toBe(256);
    expect(tail.port.postMessage).toHaveBeenLastCalledWith({ type: "stopped" });
    expect(tail.process([[new Float32Array(128)]])).toBe(false);
  });

  it("requests a 24 kHz processing context even when microphone hardware reports 48 kHz, and flushes before stopping", async () => {
    const { audio, media, context, worklet, createAudioContext } = setup();
    const onPcm = vi.fn(); const onEnded = vi.fn();
    await audio.startCapture({ deviceId: "usb-microphone", onPcm, onEnded });
    expect(media.track.getSettings().sampleRate).toBe(48_000);
    expect(createAudioContext).toHaveBeenCalledWith({ sampleRate: 24_000, latencyHint: "interactive" });
    expect(media.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: false, audio: expect.objectContaining({ deviceId: { exact: "usb-microphone" } }) }));
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith("/capture.js");
    worklet.packet(new Uint8Array([0, 128, 255, 127]));
    worklet.tail = new Uint8Array([1, 0]);
    await audio.stopCapture();
    expect(onPcm.mock.calls.map(([pcm]) => [...pcm])).toEqual([[0, 128, 255, 127], [1, 0]]);
    expect(onEnded).not.toHaveBeenCalled();
    expect(media.track.stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
    await audio.dispose();
  });

  it("rejects an unexpected context format instead of sending device-rate PCM as 24 kHz", async () => {
    const { audio, context, media } = setup();
    context.sampleRate = 44_100;
    await expect(audio.startCapture({ onPcm: vi.fn(), onEnded: vi.fn() })).rejects.toMatchObject({ code: "microphone_format_unavailable" });
    expect(media.track.stop).toHaveBeenCalled();
    await audio.dispose();
  });

  it("reports permission denial and discards a late microphone grant after cancellation", async () => {
    const { audio, media } = setup();
    media.getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    await expect(audio.startCapture({ onPcm: vi.fn(), onEnded: vi.fn() })).rejects.toMatchObject({ code: "microphone_permission_required" });
    let grant!: (stream: typeof media.stream) => void;
    media.getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    const start = audio.startCapture({ onPcm: vi.fn(), onEnded: vi.fn() });
    await audio.stopCapture();
    grant(media.stream);
    await expect(start).rejects.toMatchObject({ code: "speech_cancelled" });
    expect(media.track.stop).toHaveBeenCalled();
    await audio.dispose();
  });

  it("stops a late old permission grant without disturbing a newer recording", async () => {
    const { audio, media, worklet } = setup();
    const oldTrack = new FakeTrack();
    const oldStream = { getAudioTracks: () => [oldTrack], getTracks: () => [oldTrack] };
    let grant!: (stream: typeof oldStream) => void;
    media.getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    const previous = audio.startCapture({ onPcm: vi.fn(), onEnded: vi.fn() });
    await audio.stopCapture();
    const onPcm = vi.fn(); const onEnded = vi.fn();
    await audio.startCapture({ onPcm, onEnded });
    grant(oldStream);
    await expect(previous).rejects.toMatchObject({ code: "speech_cancelled" });
    expect(oldTrack.stop).toHaveBeenCalled();
    expect(media.track.stop).not.toHaveBeenCalled();
    worklet.packet(new Uint8Array([1, 0]));
    expect(onPcm).toHaveBeenCalledTimes(1);
    expect(onEnded).not.toHaveBeenCalled();
    await audio.dispose();
  });

  it("interrupts on device removal and publishes fresh device lists without silently switching microphones", async () => {
    const { audio, media, onDevicesChanged } = setup();
    const onEnded = vi.fn();
    await audio.startCapture({ onPcm: vi.fn(), onEnded });
    media.devices = [];
    media.dispatchEvent(new Event("devicechange"));
    await flush();
    expect(onDevicesChanged).toHaveBeenCalledWith([]);
    expect(onEnded).toHaveBeenCalledWith(expect.objectContaining({ code: "microphone_device_unavailable" }));
    expect(media.track.stop).toHaveBeenCalled();
    await audio.dispose();
  });

  it("fails closed on oversized worklet packets and reports unexpected track interruption once", async () => {
    const { audio, media, worklet } = setup();
    const onPcm = vi.fn(); const onEnded = vi.fn();
    await audio.startCapture({ onPcm, onEnded });
    worklet.packet(new Uint8Array(4_802));
    media.track.dispatchEvent(new Event("ended"));
    expect(onPcm).not.toHaveBeenCalled();
    expect(onEnded).toHaveBeenCalledTimes(1);
    await audio.dispose();
  });
});

describe("Electron streamed PCM playback", () => {
  it("carries partial samples across packets and waits for actual source completion", async () => {
    const { audio, context } = setup();
    const playback = await audio.createPlayback({ gain: 0.5 });
    await playback.append(new Uint8Array([0]));
    await playback.append(new Uint8Array([128, 255, 127, 19]));
    expect([...context.sources[0]!.buffer!.samples]).toEqual([-1, 32_767 / 32_768]);
    expect(context.gain.gain.value).toBe(0.5);
    let drained = false;
    const finished = playback.finish().then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    expect(context.close).not.toHaveBeenCalled();
    context.sources[0]!.end();
    await finished;
    expect(drained).toBe(true);
    expect(context.close).toHaveBeenCalled();
    await audio.dispose();
  });

  it("accounts for output latency after graph completion before resolving drain", async () => {
    vi.useFakeTimers();
    const { audio, context } = setup();
    context.baseLatency = 0.02; context.outputLatency = 0.03;
    const playback = await audio.createPlayback();
    await playback.append(new Uint8Array([1, 0]));
    let drained = false;
    const finished = playback.finish().then(() => { drained = true; });
    context.sources[0]!.end();
    await flush();
    await vi.advanceTimersByTimeAsync(49);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await finished;
    expect(drained).toBe(true);
    await audio.dispose();
  });

  it("backpressures the producer at two seconds and releases capacity only when a source ends", async () => {
    const { audio, context } = setup();
    const playback = await audio.createPlayback();
    await playback.append(new Uint8Array(48_000));
    await playback.append(new Uint8Array(48_000));
    let accepted = false;
    const append = playback.append(new Uint8Array(4_800)).then(() => { accepted = true; });
    await flush();
    expect(accepted).toBe(false);
    expect(context.sources).toHaveLength(2);
    context.sources[0]!.end();
    await append;
    expect(accepted).toBe(true);
    expect(context.sources).toHaveLength(3);
    playback.cancel();
    await audio.dispose();
  });

  it("bounds source-node overhead even when a provider streams individual PCM samples", async () => {
    const { audio, context } = setup();
    const playback = await audio.createPlayback();
    for (let index = 0; index < 64; index++) await playback.append(new Uint8Array([1, 0]));
    let accepted = false;
    const append = playback.append(new Uint8Array([2, 0])).then(() => { accepted = true; });
    await flush();
    expect(accepted).toBe(false);
    expect(context.sources).toHaveLength(64);
    context.sources[0]!.end();
    await append;
    expect(accepted).toBe(true);
    playback.cancel();
    await audio.dispose();
  });

  it("cancels blocked writes and drain, stops scheduled sources, and ignores late onended", async () => {
    const { audio, context } = setup();
    const controller = new AbortController();
    const playback = await audio.createPlayback({ signal: controller.signal });
    await playback.append(new Uint8Array(48_000));
    await playback.append(new Uint8Array(48_000));
    const append = playback.append(new Uint8Array(4_800));
    const rejected = expect(append).rejects.toMatchObject({ code: "speech_cancelled" });
    controller.abort();
    await rejected;
    expect(context.sources.every(source => source.stop.mock.calls.length === 1)).toBe(true);
    context.sources.forEach(source => source.end());
    await expect(playback.finish()).rejects.toMatchObject({ code: "speech_cancelled" });
    await audio.dispose();
  });

  it("times out a stalled device and interrupts on context suspension", async () => {
    vi.useFakeTimers();
    const { audio, context } = setup();
    const playback = await audio.createPlayback();
    await playback.append(new Uint8Array([1, 0]));
    const rejected = expect(playback.finish()).rejects.toMatchObject({ code: "playback_drain_timeout" });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    await audio.dispose();
    const second = setup();
    const suspended = await second.audio.createPlayback();
    second.context.state = "suspended";
    second.context.dispatchEvent(new Event("statechange"));
    await expect(suspended.finish()).rejects.toMatchObject({ code: "playback_interrupted" });
    await second.audio.dispose();
  });

  it("cancels a cue with its interaction signal without retiring the audio instance", async () => {
    const contexts: FakeContext[] = [];
    const audio = new ElectronVoiceAudio({ createAudioContext: () => {
      const context = new FakeContext(); contexts.push(context); return context as unknown as AudioContext;
    } });
    const controller = new AbortController();
    const cue = audio.playCue("start", 0.25, controller.signal);
    const stopped = expect(cue).rejects.toMatchObject({ code: "speech_cancelled" });
    await flush();
    expect(contexts[0]!.sources).toHaveLength(1);
    controller.abort();
    await stopped;
    expect(contexts[0]!.sources[0]!.stop).toHaveBeenCalled();
    const next = await audio.createPlayback();
    await next.finish();
    expect(contexts).toHaveLength(2);
    await audio.dispose();
  });
});
