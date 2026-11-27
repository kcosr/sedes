import type { ElectronVoicePlayback } from "./electron-voice-audio.js";

const STAGED_PCM_BYTES = 2 * 24_000 * 2;

/** Accept at most two seconds of mono PCM privately. The next IPC packet waits
 * for promotion before its ACK, applying the speech transport's backpressure. */
export class ElectronEarlyOutput implements ElectronVoicePlayback {
  #packets: Uint8Array[] = [];
  #bytes = 0;
  #sink?: ElectronVoicePlayback;
  #cancelled = false;
  #wake?: () => void;
  #flush = Promise.resolve();
  constructor(readonly audible: () => void) {}
  async append(pcm: Uint8Array): Promise<void> {
    if (!this.#sink && !this.#cancelled && this.#bytes + pcm.byteLength > STAGED_PCM_BYTES) {
      await new Promise<void>(resolve => { this.#wake = resolve; });
    }
    if (this.#cancelled) return;
    if (this.#sink) { await this.#flush; await this.#sink.append(pcm); if (!this.#cancelled) this.audible(); }
    else { this.#packets.push(pcm); this.#bytes += pcm.byteLength; }
  }
  promote(sink: ElectronVoicePlayback): void {
    if (this.#cancelled) { sink.cancel(); return; }
    this.#sink = sink;
    const packets = this.#packets; this.#packets = []; this.#bytes = 0;
    this.#flush = (async () => {
      for (const packet of packets) {
        if (this.#cancelled) break;
        await sink.append(packet); if (!this.#cancelled) this.audible();
      }
    })();
    void this.#flush.catch(() => undefined);
    this.#wake?.(); this.#wake = undefined;
  }
  async finish(): Promise<void> { await this.#flush; if (!this.#cancelled) await this.#sink?.finish(); }
  cancel(): void { this.#cancelled = true; this.#packets = []; this.#bytes = 0; this.#sink?.cancel(); this.#wake?.(); this.#wake = undefined; }
}
