import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ElectronSpeechCatalog, ElectronSpeechRecognitionReady } from "../../src/client/voice/electron-speech-plugin.js";
import { startOpenAiSpeechFixture, waitForSpeech } from "../support/openai-speech-fixture.js";

type AudioChunk = { requestId: string; sequence: number; pcm: string };
type SpeechBinding = { provider: "server" | "openai"; endpoint: string };
type RecognitionInput = SpeechBinding & { requestId: string; model: string };
type SpeechInput = RecognitionInput & { voice: string; speed: number; text: string };
interface Transport {
  configure(input: SpeechBinding): Promise<SpeechBinding & { credentialConfigured: boolean }>;
  getCapabilities(input: SpeechBinding): Promise<ElectronSpeechCatalog>;
  startRecognition(input: RecognitionInput): Promise<ElectronSpeechRecognitionReady>;
  appendAudio(input: { requestId: string; pcm: string }): Promise<void>;
  commitRecognition(input: { requestId: string }): Promise<{ transcript: string }>;
  speak(input: SpeechInput): Promise<void>;
  acknowledgeAudio(input: { requestId: string; sequence: number }): void;
  cancel(input: { requestId: string }): void;
  cancelAll(): void;
}

// Load the shipped Node module directly. Only credential persistence is replaced;
// HTTP, WebSocket, protocol parsing, cancellation, and streaming are production.
const { SpeechTransport } = await import(new URL("../../packages/electron-speech/electron/dist/transport.mjs", import.meta.url).href) as {
  SpeechTransport: new (options: {
    credentials: { read(endpoint: string): Promise<string | null>; status(endpoint: string): Promise<{ credentialConfigured: boolean }> };
    notify(event: string, value: unknown): void;
  }) => Transport;
};

describe("Electron transport against the real speech server", () => {
  let primary: Awaited<ReturnType<typeof startOpenAiSpeechFixture>>;
  let replacement: Awaited<ReturnType<typeof startOpenAiSpeechFixture>>;
  let transport: Transport;
  let credentials: Map<string, string>;
  let chunks: AudioChunk[];
  let otherEvents: { event: string; value: unknown }[];
  let acknowledge = true;

  beforeAll(async () => {
    const ffmpeg = process.env.OPENAI_SPEECH_FFMPEG ?? "/usr/bin/ffmpeg";
    await access(ffmpeg, constants.X_OK).catch(() => {
      throw new Error("Set OPENAI_SPEECH_FFMPEG to an executable ffmpeg with audio decoding/resampling support.");
    });
    await mkdir(path.resolve("test-results"), { recursive: true });
    const directory = await mkdtemp(path.resolve("test-results/electron-speech-run-"));
    console.log(`Electron speech artifacts: ${directory}`);
    primary = await startOpenAiSpeechFixture(path.join(directory, "primary"));
    replacement = await startOpenAiSpeechFixture(path.join(directory, "replacement"));
  });
  afterAll(async () => {
    const results = await Promise.allSettled([primary?.close(), replacement?.close()]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Electron speech fixture cleanup failed");
  });
  beforeEach(async () => {
    await Promise.all([
      primary.configure({ reset: true, transcripts: ["desktop dictation"], ttsDurationSeconds: 1 }),
      replacement.configure({ reset: true, transcripts: ["replacement dictation"], ttsDurationSeconds: 1 }),
    ]);
    credentials = new Map([[primary.endpoint, primary.token]]);
    chunks = [];
    otherEvents = [];
    acknowledge = true;
    transport = new SpeechTransport({
      credentials: {
        async read(endpoint) { return credentials.get(endpoint) ?? null; },
        async status(endpoint) { return { credentialConfigured: credentials.has(endpoint) }; },
      },
      notify(event, value) {
        if (event !== "audioChunk") { otherEvents.push({ event, value }); return; }
        const chunk = value as AudioChunk;
        chunks.push(chunk);
        if (acknowledge) transport.acknowledgeAudio({ requestId: chunk.requestId, sequence: chunk.sequence });
      },
    });
    await expect(transport.configure({ provider: "server", endpoint: primary.endpoint })).resolves.toEqual({
      provider: "server", endpoint: primary.endpoint, credentialConfigured: true,
    });
  });
  afterEach(() => { transport?.cancelAll(); });

  async function appendRecording(requestId: string, pcm = primary.pcm) {
    // Exactly 100 ms per packet, matching the native bridge's bounded PCM input.
    for (let offset = 0; offset < pcm.length; offset += 4_800) {
      await transport.appendAudio({ requestId, pcm: pcm.subarray(offset, offset + 4_800).toString("base64") });
    }
  }
  async function startRecording(endpoint = primary.endpoint) {
    const requestId = randomUUID();
    const ready = await transport.startRecognition({ provider: "server", requestId, endpoint, model: "parakeet-local" });
    expect(ready.maxBufferBytes).toBeGreaterThanOrEqual(primary.pcm.length);
    expect(ready.maxRecordingSeconds).toBeGreaterThanOrEqual(5);
    return requestId;
  }
  async function transcribe(endpoint = primary.endpoint) {
    const requestId = await startRecording(endpoint);
    try {
      await appendRecording(requestId);
      return await transport.commitRecognition({ requestId });
    } finally { transport.cancel({ requestId }); }
  }
  function speak(text: string, requestId = randomUUID(), endpoint = primary.endpoint) {
    return { requestId, result: transport.speak({ provider: "server", requestId, endpoint, model: "kokoro-local", voice: "af_heart", speed: 1, text }) };
  }
  function audioFor(requestId: string) {
    return Buffer.concat(chunks.filter(chunk => chunk.requestId === requestId).map(chunk => Buffer.from(chunk.pcm, "base64")));
  }

  it("discovers supported models and streams byte-exact 24 kHz mono PCM in acknowledged chunks", async () => {
    const catalog = await transport.getCapabilities({ provider: "server", endpoint: primary.endpoint });
    expect(catalog.transcriptionModels).toContainEqual(expect.objectContaining({ id: "parakeet-local", ready: true }));
    expect(catalog.speechModels).toContainEqual(expect.objectContaining({
      id: "kokoro-local", ready: true, sampleRate: 24_000,
      voices: expect.arrayContaining([expect.objectContaining({ id: "af_heart" })]),
    }));

    const playback = speak("Desktop fixture speech");
    await playback.result;
    const audio = audioFor(playback.requestId);
    expect(audio).toEqual(primary.pcm);
    expect(createHash("sha256").update(audio).digest("hex")).toBe(primary.pcmSha256);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(chunk => chunk.sequence)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every(chunk => Buffer.from(chunk.pcm, "base64").length <= 9_600)).toBe(true);
    expect((await primary.observations()).speech).toEqual([{ text: "Desktop fixture speech" }]);
    expect(otherEvents).toEqual([]);
  });

  it("waits for the real session acknowledgement and returns only explicitly committed final transcripts", async () => {
    await primary.configure({ transcripts: ["first segment", "second segment"] });
    const requestId = await startRecording();
    await appendRecording(requestId);
    expect((await primary.observations()).transcriptions).toEqual([]);
    await expect(transport.commitRecognition({ requestId })).resolves.toEqual({ transcript: "first segment" });
    await appendRecording(requestId);
    await expect(transport.commitRecognition({ requestId })).resolves.toEqual({ transcript: "second segment" });
    const observations = await primary.observations();
    expect(observations.transcriptions).toHaveLength(2);
    expect(observations.transcriptions[0]).toMatchObject({ sampleRate: 16_000, bytes: 32_000 });
    expect(observations.transcriptions[1]).toEqual(observations.transcriptions[0]);
    expect(otherEvents).toEqual([]);
  });

  it("keeps separate recordings independent instead of replaying a previous final transcript", async () => {
    await primary.configure({ transcripts: ["first recording", "second recording"] });
    await expect(transcribe()).resolves.toEqual({ transcript: "first recording" });
    await expect(transcribe()).resolves.toEqual({ transcript: "second recording" });
    expect((await primary.observations()).transcriptions).toHaveLength(2);
    expect(otherEvents).toEqual([]);
  });

  it("fails authentication without transcription or retry and uses the replaced token on the next request", async () => {
    credentials.set(primary.endpoint, "invalid-fixture-token");
    await expect(transport.getCapabilities({ provider: "server", endpoint: primary.endpoint })).rejects.toMatchObject({ code: "speech_unauthorized" });
    await expect(startRecording()).rejects.toMatchObject({ code: "speech_unauthorized" });
    expect((await primary.observations()).transcriptions).toEqual([]);
    expect(otherEvents).toEqual([]);
    credentials.set(primary.endpoint, primary.token);
    await expect(transcribe()).resolves.toEqual({ transcript: "desktop dictation" });
    expect((await primary.observations()).transcriptions).toHaveLength(1);
  });

  it("cancels pending recognition and lets the next recording complete without an old result", async () => {
    await primary.configure({ transcripts: ["obsolete result"], asrDelayMs: 10_000 });
    const requestId = await startRecording();
    await appendRecording(requestId);
    const result = transport.commitRecognition({ requestId }).catch((error: unknown) => error);
    await waitForSpeech(async () => (await primary.observations()).transcriptions.length === 1);
    transport.cancel({ requestId });
    await expect(result).resolves.toMatchObject({ code: "speech_cancelled" });
    await waitForSpeech(async () => (await primary.observations()).cancelled.transcription === 1);
    await expect(transport.commitRecognition({ requestId })).rejects.toMatchObject({ code: "speech_request_inactive" });

    await primary.configure({ transcripts: ["next recording"], asrDelayMs: 0 });
    await expect(transcribe()).resolves.toEqual({ transcript: "next recording" });
    expect((await primary.observations()).transcriptions).toHaveLength(2);
    expect(otherEvents).toEqual([]);
  });

  it("cancels old work when the endpoint changes and binds the replacement token to its own endpoint", async () => {
    await primary.configure({ asrDelayMs: 10_000 });
    const oldId = await startRecording();
    await appendRecording(oldId);
    const oldResult = transport.commitRecognition({ requestId: oldId }).catch((error: unknown) => error);
    await waitForSpeech(async () => (await primary.observations()).transcriptions.length === 1);
    await expect(transport.configure({ provider: "server", endpoint: replacement.endpoint })).resolves.toEqual({
      provider: "server", endpoint: replacement.endpoint, credentialConfigured: false,
    });
    await expect(oldResult).resolves.toMatchObject({ code: "speech_cancelled" });
    await expect(transport.getCapabilities({ provider: "server", endpoint: primary.endpoint })).rejects.toMatchObject({ code: "speech_configuration_changed" });
    await expect(startRecording(replacement.endpoint)).rejects.toMatchObject({ code: "speech_credential_missing" });
    credentials.set(replacement.endpoint, primary.token);
    await expect(startRecording(replacement.endpoint)).rejects.toMatchObject({ code: "speech_unauthorized" });
    credentials.set(replacement.endpoint, replacement.token);
    await expect(transcribe(replacement.endpoint)).resolves.toEqual({ transcript: "replacement dictation" });
    expect((await replacement.observations()).transcriptions).toHaveLength(1);
    await waitForSpeech(async () => (await primary.observations()).cancelled.transcription === 1);
    expect(otherEvents).toEqual([]);
  });

  it("cancels streaming playback while waiting for acknowledgement and suppresses subsequent audio", async () => {
    acknowledge = false;
    const playback = speak("hold-tts");
    const result = playback.result.catch((error: unknown) => error);
    await waitForSpeech(() => chunks.some(chunk => chunk.requestId === playback.requestId));
    expect(chunks.filter(chunk => chunk.requestId === playback.requestId)).toHaveLength(1);
    transport.cancel({ requestId: playback.requestId });
    await expect(result).resolves.toMatchObject({ code: "speech_cancelled" });
    const cancelledAudio = audioFor(playback.requestId);
    expect(cancelledAudio.length).toBeGreaterThan(0);
    expect(() => transport.acknowledgeAudio({ requestId: playback.requestId, sequence: 0 })).toThrow();
    await waitForSpeech(async () => (await primary.observations()).cancelled.speech === 1);

    acknowledge = true;
    const next = speak("After cancelled playback");
    await next.result;
    expect(audioFor(next.requestId)).toEqual(primary.pcm);
    expect(audioFor(playback.requestId)).toEqual(cancelledAudio);
    expect((await primary.observations()).speech).toEqual([{ text: "hold-tts" }, { text: "After cancelled playback" }]);
  });

  it("reports a worker failure after partial PCM instead of completing successfully or retrying", async () => {
    const failed = speak("fail");
    await expect(failed.result).rejects.toMatchObject({ code: "speech_transport_failed" });
    expect(audioFor(failed.requestId).length).toBeGreaterThan(0);
    expect(audioFor(failed.requestId).length).toBeLessThan(primary.pcm.length);
    expect((await primary.observations()).speech).toEqual([{ text: "fail" }]);

    const next = speak("After failed playback");
    await next.result;
    expect(audioFor(next.requestId)).toEqual(primary.pcm);
    expect((await primary.observations()).speech).toEqual([{ text: "fail" }, { text: "After failed playback" }]);
  });
});
