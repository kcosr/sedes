import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { test, expect } from "./fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("desktop voice resamples microphone PCM in a real worklet and drains or cancels streamed playback", async ({ page }) => {
  // Build the production module and its actual worklet, independently of app
  // boot. AudioWorklet module fetches bypass Playwright page routing, so this
  // job owns a small loopback fixture serving only these in-memory assets.
  // No fixed port, shared artifact, native microphone, or provider is involved.
  const built = await build({
    configFile: false,
    root: repositoryRoot,
    base: "./",
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry: path.join(repositoryRoot, "src/client/voice/electron-voice-audio.ts"), formats: ["es"], fileName: "audio" },
    },
  });
  const outputs = (Array.isArray(built) ? built : [built]).flatMap(bundle => {
    if (!("output" in bundle)) throw new Error("Expected a browser audio library build.");
    return bundle.output;
  });
  const assets = new Map(outputs.map(asset => [asset.fileName, asset.type === "chunk" ? asset.code : asset.source]));
  const entry = outputs.find(asset => asset.type === "chunk" && asset.isEntry);
  if (!entry) throw new Error("Missing browser audio test entry.");
  const prefix = "/__electron_voice_audio_test/";
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!pathname.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const assetName = pathname.slice(prefix.length);
    if (!assetName) {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'" });
      response.end('<!doctype html><meta charset="utf-8"><title>Desktop voice audio test</title><button>Enable audio</button>');
      return;
    }
    const body = assets.get(assetName);
    if (body === undefined) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "text/javascript" });
    response.end(typeof body === "string" ? body : Buffer.from(body));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Audio fixture did not bind a loopback port.");
  const baseURL = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(`${baseURL}${prefix}`);
    await page.getByRole("button", { name: "Enable audio" }).click();
    const result = await page.evaluate(async ({ entryUrl }) => {
      const { ElectronVoiceAudio } = await import(entryUrl) as typeof import("../../src/client/voice/electron-voice-audio.js");
      const sourceContext = new AudioContext({ sampleRate: 48_000 });
      const oscillator = sourceContext.createOscillator();
      oscillator.frequency.value = 1_000;
      const gain = sourceContext.createGain();
      gain.gain.value = 0.25;
      const destination = sourceContext.createMediaStreamDestination();
      destination.channelCount = 1;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await sourceContext.resume();
      const contexts: AudioContext[] = [];
      const media = {
        getUserMedia: async () => destination.stream,
        enumerateDevices: async () => [],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as MediaDevices;
      const audio = new ElectronVoiceAudio({
        mediaDevices: media,
        createAudioContext: options => { const context = new AudioContext(options); contexts.push(context); return context; },
      });
      const packets: Uint8Array[] = [];
      const errors: string[] = [];
      let captured!: () => void;
      const enoughAudio = new Promise<void>(resolve => { captured = resolve; });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await audio.startCapture({
          onPcm: packet => { packets.push(packet); if (packets.length >= 6) captured(); },
          onEnded: error => { errors.push(error.message); captured(); },
        }).catch(error => { throw new Error(`${String(error)}; cause=${String(error.cause)}`); });
        await Promise.race([enoughAudio, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("AudioWorklet did not produce microphone PCM.")), 5_000);
        })]);
        clearTimeout(timeout);
        await audio.stopCapture();
        // Ignore the initial packet while the synthetic source establishes its
        // MediaStream clock. Later full packets must contain the resampled tone.
        const pcm = packets.slice(1).filter(packet => packet.byteLength === 4_800);
        const values = pcm.flatMap(packet => {
          const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
          return Array.from({ length: packet.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true) / 32_768);
        });
        const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
        let crossings = 0;
        for (let index = 1; index < values.length; index++) if (values[index - 1]! <= 0 && values[index]! > 0) crossings++;
        const frequency = crossings / (values.length / 24_000);

        const playback = await audio.createPlayback();
        // Split a sample across chunks, as a real streamed HTTP body may do.
        const first = pcm[0]!;
        const began = performance.now();
        await playback.append(first.subarray(0, 1));
        await playback.append(first.subarray(1));
        await playback.append(first);
        await playback.append(first);
        let drained = false;
        const finished = playback.finish().then(() => { drained = true; });
        await Promise.resolve();
        const prematureDrain = drained;
        await finished;
        const playbackMilliseconds = performance.now() - began;

        const controller = new AbortController();
        const interrupted = await audio.createPlayback({ signal: controller.signal });
        await interrupted.append(first);
        const stopped = interrupted.finish().then(() => "unexpected_success", error => String(error.code));
        controller.abort();
        const cancelResult = await stopped;
        return {
          sourceRate: sourceContext.sampleRate, captureRate: contexts[0]!.sampleRate,
          packetLengths: packets.map(packet => packet.length), rms, frequency, errors,
          prematureDrain, playbackMilliseconds, cancelResult,
          microphoneStopped: destination.stream.getAudioTracks().every(track => track.readyState === "ended"),
        };
      } finally {
        clearTimeout(timeout);
        await audio.dispose();
        oscillator.stop();
        destination.stream.getTracks().forEach(track => track.stop());
        await sourceContext.close();
      }
    }, { entryUrl: `${baseURL}${prefix}${entry.fileName}` });
    expect(result.sourceRate).toBe(48_000);
    expect(result.captureRate).toBe(24_000);
    expect(result.errors).toEqual([]);
    expect(result.packetLengths.length).toBeGreaterThanOrEqual(6);
    expect(result.packetLengths.every(length => length > 0 && length <= 4_800 && length % 2 === 0)).toBe(true);
    expect(result.rms).toBeGreaterThan(0.16);
    expect(result.rms).toBeLessThan(0.19);
    expect(result.frequency).toBeGreaterThan(970);
    expect(result.frequency).toBeLessThan(1_030);
    expect(result.microphoneStopped).toBe(true);
    expect(result.prematureDrain).toBe(false);
    expect(result.playbackMilliseconds).toBeGreaterThan(250);
    expect(result.playbackMilliseconds).toBeLessThan(3_000);
    expect(result.cancelResult).toBe("speech_cancelled");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
