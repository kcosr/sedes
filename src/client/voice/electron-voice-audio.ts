import captureWorkletUrl from "./electron-voice-capture-worklet.ts?worker&url";

const SAMPLE_RATE = 24_000;
const MAX_CAPTURE_PACKET_BYTES = 4_800;
const MAX_PLAYBACK_PACKET_BYTES = 48_000;
const MAX_QUEUED_PLAYBACK_FRAMES = SAMPLE_RATE * 2;
const MAX_QUEUED_PLAYBACK_SOURCES = 64;

export interface ElectronVoiceInputDevice { id: string; label: string }
export interface ElectronVoiceCaptureOptions {
  deviceId?: string;
  /** Always mono PCM16LE at 24 kHz, in packets of at most 100 ms. */
  onPcm(pcm: Uint8Array): void;
  /** Unexpected interruption only; an explicit stop never calls this callback. */
  onEnded(error: Error): void;
}
export interface ElectronVoicePlaybackOptions { gain?: number; signal?: AbortSignal }
export interface ElectronVoicePlayback {
  /** Await each append: this bounds scheduled playback to two seconds. */
  append(pcm: Uint8Array): Promise<void>;
  /** Resolves after source completion and the output-latency drain allowance. */
  finish(): Promise<void>;
  cancel(): void;
}
export interface ElectronVoiceAudioOptions {
  onDevicesChanged?: (devices: ElectronVoiceInputDevice[]) => void;
  mediaDevices?: MediaDevices;
  createAudioContext?: (options: AudioContextOptions) => AudioContext;
  createWorkletNode?: (context: AudioContext, name: string, options: AudioWorkletNodeOptions) => AudioWorkletNode;
  workletUrl?: string;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
function cancelled(): Error { return failure("speech_cancelled", "Voice audio was stopped."); }
function microphoneFailure(error: unknown): Error {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return failure("microphone_permission_required", "Allow microphone access in the operating system settings, then try again.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return failure("microphone_device_unavailable", "The selected microphone is unavailable. Choose an available input device.");
  return Object.assign(new Error("The microphone could not be opened. Check its connection and access settings.", { cause: error }), { code: "microphone_failed" });
}
function validateGain(gain = 1): number {
  if (!Number.isFinite(gain) || gain < 0 || gain > 16) throw failure("audio_gain_invalid", "Voice audio gain must be between 0 and 16.");
  return gain;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

type Capture = {
  context: AudioContext; stream: MediaStream; options: ElectronVoiceCaptureOptions;
  node?: AudioWorkletNode; source?: MediaStreamAudioSourceNode;
  deviceId?: string; deviceGroupId?: string; stopping: boolean; stopped: ReturnType<typeof deferred<void>>;
  cleanup: (() => void)[]; stopPromise?: Promise<void>; failure?: Error;
};

function inputDevices(devices: readonly MediaDeviceInfo[]): ElectronVoiceInputDevice[] {
  // The shared picker already represents the OS default with a null preference.
  return devices.filter(device => device.kind === "audioinput" && !["", "default", "communications"].includes(device.deviceId)).map((device, index) => ({
    id: device.deviceId, label: device.label || `Microphone ${index + 1}`,
  }));
}

/** App-session audio only. Network state, transcription segmentation and input
 * submission remain with the voice runtime. Nothing here persists recordings. */
export class ElectronVoiceAudio {
  readonly #options: ElectronVoiceAudioOptions;
  readonly #media: MediaDevices | undefined;
  readonly #playbacks = new Set<PcmPlayback>();
  #capture?: Capture;
  #captureGeneration = 0;
  #starting = false;
  #disposed = false;

  constructor(options: ElectronVoiceAudioOptions = {}) {
    this.#options = options;
    this.#media = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    this.#media?.addEventListener("devicechange", this.#devicesChanged);
  }

  async listInputDevices(): Promise<ElectronVoiceInputDevice[]> {
    this.#requireAvailable();
    const devices = await this.#media!.enumerateDevices();
    return inputDevices(devices);
  }

  async startCapture(options: ElectronVoiceCaptureOptions): Promise<void> {
    this.#requireAvailable();
    if (this.#capture || this.#starting) throw failure("microphone_busy", "A recording is already active.");
    const generation = ++this.#captureGeneration;
    this.#starting = true;
    let stream: MediaStream | undefined;
    let capture: Capture | undefined;
    try {
      stream = await this.#media!.getUserMedia({ video: false, audio: {
        channelCount: { ideal: 1 }, sampleRate: { ideal: SAMPLE_RATE },
        ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      } });
      if (generation !== this.#captureGeneration || this.#disposed) throw cancelled();
      const context = this.#newContext();
      const trackSettings = stream.getAudioTracks()[0]?.getSettings();
      capture = { context, stream, options, stopping: false, stopped: deferred<void>(), cleanup: [],
        deviceId: trackSettings?.deviceId, deviceGroupId: trackSettings?.groupId };
      this.#capture = capture;
      if (context.sampleRate !== SAMPLE_RATE) throw failure("microphone_format_unavailable", "The audio system cannot provide 24 kHz microphone audio.");
      await context.audioWorklet.addModule(this.#options.workletUrl ?? captureWorkletUrl);
      if (generation !== this.#captureGeneration || capture.stopping) throw cancelled();
      const node = (this.#options.createWorkletNode ?? ((ctx, name, settings) => new AudioWorkletNode(ctx, name, settings)))(context, "sedes-pcm-capture", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
      });
      capture.node = node;
      const owned = capture;
      node.port.onmessage = (event: MessageEvent) => {
        if (this.#capture !== owned) return;
        const data: unknown = event.data;
        if (!data || typeof data !== "object" || !("type" in data)) return;
        if (data.type === "stopped") { owned.stopped.resolve(); return; }
        if (data.type === "error") {
          const code = "code" in data && data.code === "microphone_queue_full" ? data.code : "microphone_format_unavailable";
          this.#captureFailed(owned, failure(code, "Microphone audio was interrupted before it could be processed."));
          return;
        }
        if (data.type !== "pcm" || !("buffer" in data) || !(data.buffer instanceof ArrayBuffer) ||
            data.buffer.byteLength === 0 || data.buffer.byteLength > MAX_CAPTURE_PACKET_BYTES || data.buffer.byteLength % 2 !== 0 ||
            !("sequence" in data) || !Number.isSafeInteger(data.sequence)) {
          this.#captureFailed(owned, failure("microphone_format_unavailable", "The microphone returned an invalid audio packet."));
          return;
        }
        try {
          options.onPcm(new Uint8Array(data.buffer));
          node.port.postMessage({ type: "ack", sequence: data.sequence });
        } catch {
          this.#captureFailed(owned, failure("microphone_queue_full", "The recording could not accept more microphone audio."));
        }
      };
      const processorFailed = () => this.#captureFailed(owned, failure("microphone_failed", "The microphone audio processor stopped."));
      node.addEventListener("processorerror", processorFailed);
      owned.cleanup.push(() => node.removeEventListener("processorerror", processorFailed));
      for (const track of stream.getAudioTracks()) {
        const ended = () => this.#captureFailed(owned, failure("microphone_device_unavailable", "The microphone disconnected or stopped providing audio."));
        track.addEventListener("ended", ended);
        track.addEventListener("mute", ended);
        owned.cleanup.push(() => { track.removeEventListener("ended", ended); track.removeEventListener("mute", ended); });
      }
      owned.source = context.createMediaStreamSource(stream);
      owned.source.connect(node);
      // The processor outputs silence; connecting it keeps capture processing
      // active without feeding the microphone back into the speakers.
      node.connect(context.destination);
      await context.resume();
      if (generation !== this.#captureGeneration || owned.stopping) throw cancelled();
      const stateChanged = () => {
        if (context.state !== "running") this.#captureFailed(owned, failure("microphone_interrupted", "Microphone capture was interrupted by the audio system."));
      };
      context.addEventListener("statechange", stateChanged);
      owned.cleanup.push(() => context.removeEventListener("statechange", stateChanged));
      if (context.state !== "running") throw failure("microphone_interrupted", "The audio system did not start microphone capture.");
    } catch (error) {
      if (capture) await this.#releaseCapture(capture);
      else stream?.getTracks().forEach(track => track.stop());
      throw microphoneFailure(error);
    } finally {
      if (generation === this.#captureGeneration) this.#starting = false;
    }
  }

  async stopCapture(): Promise<void> {
    ++this.#captureGeneration;
    this.#starting = false;
    const capture = this.#capture;
    if (!capture) return;
    if (capture.stopPromise) return capture.stopPromise;
    capture.stopping = true;
    capture.stopPromise = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (capture.node && capture.context.state === "running") {
          capture.node.port.postMessage({ type: "stop" });
          await Promise.race([capture.stopped.promise, new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(failure("microphone_flush_timeout", "The microphone did not finish delivering its recording.")), 1_000);
          })]);
        }
        if (capture.failure) throw capture.failure;
      } finally {
        clearTimeout(timeout);
        await this.#releaseCapture(capture);
      }
    })();
    return capture.stopPromise;
  }

  async createPlayback(options: ElectronVoicePlaybackOptions = {}): Promise<ElectronVoicePlayback> {
    if (this.#disposed) throw cancelled();
    const gain = validateGain(options.gain);
    if (options.signal?.aborted) throw cancelled();
    const context = this.#newContext();
    try {
      await context.resume();
      if (this.#disposed || options.signal?.aborted) throw cancelled();
      if (context.state !== "running") throw failure("playback_failed", "The audio system did not start playback.");
      const playback = new PcmPlayback(context, gain, options.signal, () => this.#playbacks.delete(playback));
      this.#playbacks.add(playback);
      return playback;
    } catch (error) { await context.close().catch(() => undefined); throw error; }
  }

  async playCue(kind: "start" | "success" | "failure", gain = 0.25, signal?: AbortSignal): Promise<void> {
    const playback = await this.createPlayback({ gain, signal });
    const duration = kind === "failure" ? 0.14 : 0.09;
    const frequency = kind === "start" ? 660 : kind === "success" ? 880 : 220;
    const pcm = new Uint8Array(Math.round(duration * SAMPLE_RATE) * 2);
    const view = new DataView(pcm.buffer);
    for (let frame = 0; frame < pcm.length / 2; frame++) {
      const time = frame / SAMPLE_RATE;
      const envelope = Math.min(1, time / 0.008, (duration - time) / 0.012);
      view.setInt16(frame * 2, Math.round(Math.sin(2 * Math.PI * frequency * time) * envelope * 12_000), true);
    }
    try { await playback.append(pcm); await playback.finish(); }
    catch (error) { playback.cancel(); throw error; }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#media?.removeEventListener("devicechange", this.#devicesChanged);
    for (const playback of this.#playbacks) playback.cancel();
    await this.stopCapture();
  }

  #newContext(): AudioContext {
    return (this.#options.createAudioContext ?? (options => new AudioContext(options)))({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  }
  #requireAvailable(): void {
    if (this.#disposed) throw cancelled();
    if (!this.#media) throw failure("microphone_unavailable", "Microphone capture is unavailable in this application.");
  }
  #devicesChanged = (): void => {
    const capture = this.#capture;
    void this.#media!.enumerateDevices().then(devices => {
      if (this.#disposed) return;
      this.#options.onDevicesChanged?.(inputDevices(devices));
      const current = capture?.stream.getAudioTracks()[0]?.getSettings();
      if (capture && this.#capture === capture && !capture.stopping && capture.deviceId &&
          (!devices.some(device => device.kind === "audioinput" && device.deviceId === capture.deviceId &&
            (!capture.deviceGroupId || device.groupId === capture.deviceGroupId)) || current?.deviceId !== capture.deviceId ||
            (capture.deviceGroupId && current?.groupId !== capture.deviceGroupId))) {
        this.#captureFailed(capture, failure("microphone_device_unavailable", "The active microphone changed or disconnected."));
      }
    }).catch(() => {
      if (capture) this.#captureFailed(capture, failure("microphone_device_unavailable", "The active microphone could not be checked."));
    });
  };
  #captureFailed(capture: Capture, error: Error): void {
    if (this.#capture !== capture || capture.failure) return;
    capture.failure = error;
    const unexpected = !capture.stopping;
    capture.stopping = true;
    capture.stopped.resolve();
    void this.#releaseCapture(capture);
    if (unexpected) capture.options.onEnded(error);
  }
  async #releaseCapture(capture: Capture): Promise<void> {
    if (this.#capture === capture) this.#capture = undefined;
    capture.stopping = true;
    for (const cleanup of capture.cleanup.splice(0)) cleanup();
    capture.stream.getTracks().forEach(track => track.stop());
    if (capture.node) { capture.node.port.onmessage = null; capture.node.port.close(); capture.node.disconnect(); }
    capture.source?.disconnect();
    await capture.context.close().catch(() => undefined);
  }
}

class PcmPlayback implements ElectronVoicePlayback {
  readonly #gain: GainNode;
  readonly #sources = new Set<AudioBufferSourceNode>();
  readonly #waiters = new Set<() => void>();
  #frames = 0;
  #nextTime = 0;
  #oddByte?: number;
  #error?: Error;
  #ending = false;
  #closed = false;
  #write?: Promise<void>;
  #finish?: Promise<void>;

  constructor(readonly context: AudioContext, gain: number, readonly signal: AbortSignal | undefined, readonly onClosed: () => void) {
    this.#gain = context.createGain();
    this.#gain.gain.value = gain;
    this.#gain.connect(context.destination);
    signal?.addEventListener("abort", this.#abort, { once: true });
    context.addEventListener("statechange", this.#stateChanged);
  }

  async append(pcm: Uint8Array): Promise<void> {
    this.#check();
    if (this.#ending) throw failure("playback_finished", "Speech playback has already finished receiving audio.");
    if (this.#write) throw failure("playback_write_pending", "Wait for the previous audio chunk before appending another.");
    if (pcm.byteLength > MAX_PLAYBACK_PACKET_BYTES) throw failure("playback_packet_too_large", "A speech audio packet exceeded its size limit.");
    const pending = this.#append(pcm);
    this.#write = pending;
    try { await pending; } finally { this.#write = undefined; this.#wake(); }
  }

  async #append(pcm: Uint8Array): Promise<void> {
    const previous = this.#oddByte;
    const count = Math.floor((pcm.length + (previous === undefined ? 0 : 1)) / 2);
    const samples = new Float32Array(count);
    let offset = 0;
    for (let frame = 0; frame < count; frame++) {
      const low = frame === 0 && previous !== undefined ? previous : pcm[offset++]!;
      const high = pcm[offset++]!;
      const value = low | (high << 8);
      samples[frame] = (value >= 0x8000 ? value - 0x10000 : value) / 32_768;
    }
    this.#oddByte = offset < pcm.length ? pcm[offset] : (count === 0 ? previous : undefined);
    while (count > 0 && (this.#frames + count > MAX_QUEUED_PLAYBACK_FRAMES || this.#sources.size >= MAX_QUEUED_PLAYBACK_SOURCES)) await this.#waitForProgress();
    this.#check();
    if (count === 0) return;
    const buffer = this.context.createBuffer(1, count, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gain);
    this.#sources.add(source);
    this.#frames += count;
    source.onended = () => {
      if (!this.#sources.delete(source)) return;
      this.#frames -= count;
      source.disconnect();
      this.#wake();
    };
    const start = Math.max(this.context.currentTime + 0.015, this.#nextTime);
    this.#nextTime = start + count / SAMPLE_RATE;
    try { source.start(start); }
    catch { this.#fail(failure("playback_failed", "The audio system could not play speech.")); this.#check(); }
  }

  finish(): Promise<void> {
    if (this.#finish) return this.#finish;
    this.#ending = true;
    this.#finish = (async () => {
      try {
        await this.#write;
        this.#check();
        this.#oddByte = undefined; // A provider's trailing half-sample has no audio value.
        while (this.#sources.size) await this.#waitForProgress();
        // onended confirms graph consumption. Account for frames still between
        // the graph and the output device before enabling follow-up recording.
        const latency = (this.context.baseLatency || 0) + (this.context.outputLatency || 0);
        if (latency > 0) await this.#waitForDrain(Math.min(latency, 2) * 1_000);
        this.#check();
      } finally { this.#close(); }
    })();
    return this.#finish;
  }

  cancel(): void { this.#fail(cancelled()); }
  #abort = (): void => this.cancel();
  #stateChanged = (): void => {
    if (!this.#closed && this.context.state !== "running") this.#fail(failure("playback_interrupted", "Speech playback was interrupted by the audio system."));
  };
  #check(): void {
    if (this.#error) throw this.#error;
    if (this.#closed) throw cancelled();
  }
  #wake(): void { for (const wake of [...this.#waiters]) wake(); }
  async #waitForProgress(): Promise<void> {
    this.#check();
    await new Promise<void>((resolve, reject) => {
      const wake = () => { clearTimeout(timer); this.#waiters.delete(wake); resolve(); };
      const timer = setTimeout(() => {
        this.#waiters.delete(wake);
        const error = failure("playback_drain_timeout", "The audio system stopped consuming speech.");
        this.#fail(error);
        reject(error);
      }, 5_000);
      this.#waiters.add(wake);
    });
    this.#check();
  }
  async #waitForDrain(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const wake = () => { clearTimeout(timer); this.#waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, milliseconds);
      this.#waiters.add(wake);
    });
    this.#check();
  }
  #fail(error: Error): void { this.#error ??= error; this.#close(); }
  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.signal?.removeEventListener("abort", this.#abort);
    this.context.removeEventListener("statechange", this.#stateChanged);
    for (const source of this.#sources) {
      source.onended = null;
      try { source.stop(); } catch { /* A failed start has no active source to stop. */ }
      source.disconnect();
    }
    this.#sources.clear();
    this.#gain.disconnect();
    this.#wake();
    void this.context.close().catch(() => undefined);
    this.onClosed();
  }
}
