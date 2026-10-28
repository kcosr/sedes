import type { NativeVoiceSettings } from "./native-voice-plugin.js";
import type { electronSpeech, ElectronSpeechRecognitionReady } from "./electron-speech-plugin.js";

export const VOICE_SAMPLE_RATE = 24_000;
export const VOICE_PACKET_BYTES = 4800;
const SPEECH_ENERGY = 0.012 ** 2;
const MAX_PENDING_PCM = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

export function pcmEnergy(pcm: Uint8Array): number {
  const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let squares = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) squares += (samples.getInt16(offset, true) / 32768) ** 2;
  return pcm.byteLength ? squares / (pcm.byteLength / 2) : 0;
}

/** Sample-clock endpointing does not depend on renderer timer frequency. */
export class ElectronCapturePolicy {
  #samples = 0;
  #intervalStart = 0;
  #firstSpeech: number | null = null;
  #lastSpeech = 0;
  #held: boolean;
  sawSpeech = false;
  constructor(readonly settings: NativeVoiceSettings) { this.#held = settings.keepListeningByDefault; }
  setHeld(held: boolean): void {
    if (this.#held && !held) {
      this.#intervalStart = this.#samples;
      this.#firstSpeech = this.sawSpeech ? this.#samples : null;
      this.#lastSpeech = this.#samples;
    }
    this.#held = held;
  }
  accept(pcm: Uint8Array): "continue" | "no_speech" | "silence" | "duration" {
    this.#samples += pcm.byteLength / 2;
    if (pcmEnergy(pcm) >= SPEECH_ENERGY) {
      this.sawSpeech = true;
      this.#firstSpeech ??= this.#samples;
      this.#lastSpeech = this.#samples;
    }
    if (this.#held) return "continue";
    const milliseconds = (samples: number) => samples * 1000 / VOICE_SAMPLE_RATE;
    if (this.#firstSpeech === null && milliseconds(this.#samples - this.#intervalStart) >= this.settings.recognitionStartTimeoutMs) return "no_speech";
    if (this.#firstSpeech !== null && milliseconds(this.#samples - this.#firstSpeech) >= this.settings.recognitionCompletionTimeoutMs) return "duration";
    if (this.#firstSpeech !== null && milliseconds(this.#samples - this.#lastSpeech) >= this.settings.recognitionEndSilenceMs) return "silence";
    return "continue";
  }
}

interface Frame { pcm: Uint8Array; energy: number; end: number }
/** Every real sample is uploaded exactly once. The one-second unsent tail permits safe retrospective hard cuts. */
export class ElectronVoiceSegmenter {
  #frames: Frame[] = [];
  #partial = new Uint8Array(0);
  #samples = 0;
  #segmentStart = 0;
  #lastSpeech = -1;
  #finished = false;
  readonly hardSamples: number;
  readonly softSamples: number;
  constructor(hardSeconds: number, readonly packet: (pcm: Uint8Array) => void, readonly commit: () => void) {
    const frames = Math.floor(hardSeconds * 10);
    if (frames < 50 || frames > 600) throw new Error("Unsupported speech server recording limit.");
    this.hardSamples = frames * 2400;
    this.softSamples = Math.min(30 * VOICE_SAMPLE_RATE, this.hardSamples / 2);
  }
  accept(pcm: Uint8Array): void {
    if (this.#finished || pcm.byteLength % 2) throw new Error("Invalid microphone audio.");
    let incoming = pcm;
    if (this.#partial.byteLength) {
      incoming = new Uint8Array(this.#partial.byteLength + pcm.byteLength);
      incoming.set(this.#partial); incoming.set(pcm, this.#partial.byteLength); this.#partial = new Uint8Array(0);
    }
    let offset = 0;
    for (; offset + VOICE_PACKET_BYTES <= incoming.byteLength; offset += VOICE_PACKET_BYTES) {
      const frame = incoming.slice(offset, offset + VOICE_PACKET_BYTES);
      this.#samples += 2400;
      const energy = pcmEnergy(frame);
      this.#frames.push({ pcm: frame, energy, end: this.#samples });
      if (energy >= SPEECH_ENERGY) this.#lastSpeech = this.#samples;
      const age = this.#samples - this.#segmentStart;
      const quiet = this.#lastSpeech < this.#segmentStart ? -1 : this.#samples - this.#lastSpeech;
      if (quiet >= (age >= this.softSamples ? 4800 : 28_800)) this.#seal(this.#samples);
      else if (age >= this.hardSamples) {
        const earliest = Math.max(this.#segmentStart + 2400, this.#samples - VOICE_SAMPLE_RATE);
        let best: Frame | undefined;
        for (const candidate of this.#frames) {
          if (candidate.end >= earliest && (!best || candidate.energy <= best.energy)) best = candidate;
        }
        if (!best) throw new Error("Speech segment boundary unavailable.");
        this.#seal(best.end);
      }
      while (this.#frames.length > 10) this.packet(this.#frames.shift()!.pcm);
    }
    this.#partial = incoming.slice(offset);
  }
  #seal(end: number): void {
    if (end <= this.#segmentStart || end - this.#segmentStart > this.hardSamples) throw new Error("Invalid speech segment boundary.");
    while (this.#frames[0] && this.#frames[0].end <= end) this.packet(this.#frames.shift()!.pcm);
    this.commit();
    this.#segmentStart = end;
    this.#lastSpeech = -1;
    for (const frame of this.#frames) if (frame.energy >= SPEECH_ENERGY) this.#lastSpeech = frame.end;
  }
  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    for (const frame of this.#frames) this.packet(frame.pcm);
    this.#frames = [];
    if (this.#partial.byteLength) {
      const realSamples = this.#samples - this.#segmentStart + this.#partial.byteLength / 2;
      // A provider commit requires at least 100 ms. Padding belongs only to this final short segment.
      const tail = realSamples < 2400 ? new Uint8Array(VOICE_PACKET_BYTES) : this.#partial;
      if (tail !== this.#partial) tail.set(this.#partial);
      this.packet(tail); this.#samples += this.#partial.byteLength / 2; this.#partial = new Uint8Array(0);
    }
    if (this.#samples > this.#segmentStart) this.commit();
  }
  clear(): void { this.#finished = true; this.#frames = []; this.#partial = new Uint8Array(0); }
}

export function pcmBase64(pcm: Uint8Array): string {
  let binary = "";
  for (const value of pcm) binary += String.fromCharCode(value);
  return btoa(binary);
}
export function base64Pcm(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

type RecognitionTransport = Pick<typeof electronSpeech, "startRecognition" | "appendAudio" | "commitRecognition" | "cancel">;
export interface MemoryRecordingOptions {
  speech: RecognitionTransport;
  settings: NativeVoiceSettings;
  failed(error: Error): void;
  uuid?: () => string;
  now?: () => number;
}

/** One live recording. No disk writes, resubmission, failed-audio retention or network retries. */
export class MemoryVoiceRecording {
  readonly policy: ElectronCapturePolicy;
  #segmenter: ElectronVoiceSegmenter | undefined;
  #chain: Promise<void> = Promise.resolve();
  #pendingBytes = 0;
  #text: string[] = [];
  #textBytes = 0;
  #requestId: string | undefined;
  #ready: ElectronSpeechRecognitionReady | undefined;
  #expiresAt = 0;
  #boundary = true;
  #ended = false;
  #finishing = false;
  #failure: Error | undefined;
  readonly #uuid: () => string;
  readonly #now: () => number;
  constructor(readonly options: MemoryRecordingOptions) {
    this.policy = new ElectronCapturePolicy(options.settings);
    this.#uuid = options.uuid ?? (() => crypto.randomUUID()); this.#now = options.now ?? Date.now;
  }
  get requestId(): string | undefined { return this.#requestId; }
  get failed(): boolean { return this.#failure !== undefined; }
  async start(): Promise<void> {
    await this.#open();
    if (this.#ended) throw new Error("Recording cancelled.");
    this.#segmenter = new ElectronVoiceSegmenter(this.#ready!.maxRecordingSeconds,
      pcm => this.#packet(pcm), () => this.#commit());
  }
  async #open(): Promise<void> {
    const requestId = this.#uuid(); this.#requestId = requestId;
    const started = this.#now();
    const ready = await this.options.speech.startRecognition({ requestId, provider: this.options.settings.speechProvider,
      endpoint: this.options.settings.speechEndpoint, model: this.options.settings.sttModel });
    if (this.#ended || this.#requestId !== requestId) {
      await this.options.speech.cancel({ requestId }).catch(() => undefined);
      throw new Error("Recording cancelled.");
    }
    if (this.#ready && ready.maxRecordingSeconds < this.#ready.maxRecordingSeconds)
      throw new Error("Speech recording limits changed. Start a new recording.");
    this.#ready = ready; this.#expiresAt = started + ready.maxSessionSeconds * 1000;
  }
  accept(pcm: Uint8Array): ReturnType<ElectronCapturePolicy["accept"]> {
    if (this.#ended || this.#finishing) return "continue";
    if (!this.#segmenter) throw new Error("Recording is not ready.");
    const endpoint = this.policy.accept(pcm);
    this.#segmenter.accept(pcm);
    return endpoint;
  }
  setHeld(value: boolean): void { this.policy.setHeld(value); }
  #enqueue(task: () => Promise<void>): void {
    this.#chain = this.#chain.then(async () => {
      if (this.#ended) return;
      await task();
    }).catch(error => this.fail(error instanceof Error ? error : new Error("Speech recognition failed.")));
  }
  #packet(pcm: Uint8Array): void {
    this.#pendingBytes += pcm.byteLength;
    if (this.#pendingBytes > MAX_PENDING_PCM) throw new Error("Speech recognition cannot keep up with the microphone. Recording stopped.");
    this.#enqueue(async () => {
      try {
        if (this.#boundary) {
          const budget = this.#ready!.maxRecordingSeconds * 1000 + this.options.settings.recognitionResultTimeoutMs + 30_000;
          if (this.#expiresAt - this.#now() < budget) {
            await this.options.speech.cancel({ requestId: this.#requestId! });
            await this.#open();
            if (this.#expiresAt - this.#now() < budget) throw new Error("Speech server session is too short for this recording.");
          }
          this.#boundary = false;
        }
        if (!this.#ended) await this.options.speech.appendAudio({ requestId: this.#requestId!, pcm: pcmBase64(pcm) });
      } finally { this.#pendingBytes -= pcm.byteLength; }
    });
  }
  #commit(): void {
    this.#enqueue(async () => {
      const requestId = this.#requestId!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void this.options.speech.cancel({ requestId }).catch(() => undefined);
          reject(new Error("Speech recognition timed out. The recording was not sent."));
        }, this.options.settings.recognitionResultTimeoutMs);
      });
      try {
        const result = await Promise.race([this.options.speech.commitRecognition({ requestId }), expired]);
        if (this.#ended) return;
        const text = result.transcript.trim();
        if (text) {
          this.#textBytes += new TextEncoder().encode(text).byteLength + (this.#text.length ? 1 : 0);
          if (this.#textBytes > MAX_TEXT_BYTES) throw new Error("The recording exceeds the message text limit. It was not sent.");
          this.#text.push(text);
        }
        this.#boundary = true;
      } finally { clearTimeout(timer); }
    });
  }
  async finish(): Promise<string> {
    if (this.#ended) throw this.#failure ?? new Error("Recording cancelled.");
    if (!this.#finishing) { this.#finishing = true; this.#segmenter!.finish(); }
    await this.#chain;
    if (this.#failure) throw this.#failure;
    if (this.#ended) throw new Error("Recording cancelled.");
    const text = this.#text.join(" ");
    this.cancel();
    return text;
  }
  fail(error: Error): void {
    if (this.#ended) return;
    this.#failure = error; this.cancel(); this.options.failed(error);
  }
  cancel(): void {
    if (this.#ended) return;
    this.#ended = true; this.#segmenter?.clear(); this.#text = [];
    if (this.#requestId) void this.options.speech.cancel({ requestId: this.#requestId }).catch(() => undefined);
  }
}
