/** Capture runs in an explicitly 24 kHz AudioContext. Chromium resamples the
 * MediaStreamAudioSource before this worklet; no device-rate samples cross IPC. */
export const CAPTURE_SAMPLE_RATE = 24_000;
export const CAPTURE_PACKET_FRAMES = 2_400;

export class CapturePcmEncoder {
  #buffer = new Uint8Array(CAPTURE_PACKET_FRAMES * 2);
  #frames = 0;

  append(channels: readonly Float32Array[]): Uint8Array[] {
    const frames = channels[0]?.length ?? 0;
    const packets: Uint8Array[] = [];
    for (let frame = 0; frame < frames; frame++) {
      let value = 0;
      for (const channel of channels) value += channel[frame] ?? 0;
      value /= channels.length;
      value = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      const pcm = Math.round(value * (value < 0 ? 32_768 : 32_767));
      this.#buffer[this.#frames * 2] = pcm & 255;
      this.#buffer[this.#frames * 2 + 1] = (pcm >> 8) & 255;
      this.#frames++;
      if (this.#frames === CAPTURE_PACKET_FRAMES) {
        packets.push(this.#buffer);
        this.#buffer = new Uint8Array(CAPTURE_PACKET_FRAMES * 2);
        this.#frames = 0;
      }
    }
    return packets;
  }

  flush(): Uint8Array | undefined {
    if (this.#frames === 0) return undefined;
    const packet = this.#buffer.slice(0, this.#frames * 2);
    this.#frames = 0;
    this.#buffer = new Uint8Array(CAPTURE_PACKET_FRAMES * 2);
    return packet;
  }
}

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

// The guard also lets deterministic unit tests exercise the encoder without an
// AudioWorkletGlobalScope. The bundled worklet always registers here.
if (typeof AudioWorkletProcessor !== "undefined" && typeof registerProcessor !== "undefined") {
  class SedesCaptureProcessor extends AudioWorkletProcessor {
    #encoder = new CapturePcmEncoder();
    #pending = new Set<number>();
    #sequence = 0;
    #stopped = false;

    constructor() {
      super();
      this.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "ack") this.#pending.delete(event.data.sequence);
        if (event.data?.type === "stop" && !this.#stopped) {
          const tail = this.#encoder.flush();
          if (tail) this.#send(tail);
          this.#stopped = true;
          this.port.postMessage({ type: "stopped" });
        }
      };
    }

    #send(pcm: Uint8Array): void {
      // At most half a second can wait for the renderer. A blocked renderer
      // interrupts capture instead of silently dropping audio or growing memory.
      if (this.#pending.size >= 5) {
        this.#stopped = true;
        this.port.postMessage({ type: "error", code: "microphone_queue_full" });
        return;
      }
      const sequence = this.#sequence++;
      this.#pending.add(sequence);
      this.port.postMessage({ type: "pcm", sequence, buffer: pcm.buffer }, [pcm.buffer]);
    }

    process(inputs: Float32Array[][]): boolean {
      if (this.#stopped) return false;
      if (sampleRate !== CAPTURE_SAMPLE_RATE) {
        this.#stopped = true;
        this.port.postMessage({ type: "error", code: "microphone_format_unavailable" });
        return false;
      }
      for (const packet of this.#encoder.append(inputs[0] ?? [])) this.#send(packet);
      return !this.#stopped;
    }
  }
  registerProcessor("sedes-pcm-capture", SedesCaptureProcessor);
}
