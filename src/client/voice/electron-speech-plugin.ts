import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { z } from "zod";

const realtimeSchema = z.strictObject({
  maxBufferBytes: z.number().int().nonnegative(),
  maxMessageBytes: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  idleTimeoutSeconds: z.number().positive(),
  maxSessionSeconds: z.number().positive(),
});
const catalogSchema = z.strictObject({
  transcriptionModels: z.array(z.strictObject({
    id: z.string(), label: z.string(), ready: z.boolean(), realtime: realtimeSchema,
  })),
  speechModels: z.array(z.strictObject({
    id: z.string(), label: z.string(), ready: z.boolean(),
    voices: z.array(z.strictObject({ id: z.string(), label: z.string() })),
    speed: z.strictObject({ min: z.number().positive(), max: z.number().positive(), default: z.number().positive() }),
    maxTextLength: z.number().int().positive(), sampleRate: z.literal(24000),
  })),
});
const credentialStatusSchema = z.strictObject({ credentialConfigured: z.boolean() });
const audioChunkSchema = z.strictObject({
  requestId: z.uuid(), sequence: z.number().int().nonnegative(), pcm: z.string().max(12_800),
});
const interruptedSchema = z.strictObject({ reason: z.enum(["suspend", "renderer_closed"]) });
const windowStateSchema = z.strictObject({ visible: z.boolean() });
const recognitionErrorSchema = z.strictObject({ requestId: z.uuid(), code: z.string().max(160), message: z.string().max(1024) });
const recognitionReadySchema = z.strictObject({
  maxBufferBytes: z.number().int().positive(), maxRecordingSeconds: z.number().positive(), maxSessionSeconds: z.number().positive(),
});

export type ElectronSpeechCatalog = z.infer<typeof catalogSchema>;
export type ElectronSpeechAudioChunk = z.infer<typeof audioChunkSchema>;
export type ElectronSpeechInterrupted = z.infer<typeof interruptedSchema>;
export type ElectronSpeechRecognitionReady = z.infer<typeof recognitionReadySchema>;
export type ElectronSpeechRecognitionError = z.infer<typeof recognitionErrorSchema>;

interface ElectronSpeechNativePlugin {
  configure(input: { endpoint: string }): Promise<unknown>;
  getCredentialStatus(input: { endpoint: string }): Promise<unknown>;
  openCredentialDialog(input: { endpoint: string }): Promise<unknown>;
  getCapabilities(input: { endpoint: string }): Promise<unknown>;
  startRecognition(input: { requestId: string; endpoint: string; model: string }): Promise<unknown>;
  appendAudio(input: { requestId: string; pcm: string }): Promise<void>;
  commitRecognition(input: { requestId: string }): Promise<unknown>;
  speak(input: { requestId: string; endpoint: string; model: string; voice: string; speed: number; text: string }): Promise<void>;
  acknowledgeAudio(input: { requestId: string; sequence: number }): Promise<void>;
  cancel(input: { requestId: string }): Promise<void>;
  cancelAll(): Promise<void>;
  getWindowState(): Promise<unknown>;
  setAudioActive(input: { active: boolean }): Promise<void>;
  addListener(event: "audioChunk" | "interrupted" | "recognitionError" | "windowState", listener: (value: unknown) => void): Promise<PluginListenerHandle>;
}

const native = registerPlugin<ElectronSpeechNativePlugin>("ElectronSpeech");

/** Speech credentials never cross this bridge. The isolated native dialog owns them. */
export const electronSpeech = Object.freeze({
  async configure(input: { endpoint: string }) {
    return z.strictObject({ endpoint: z.string(), credentialConfigured: z.boolean() }).parse(await native.configure(input));
  },
  async getCredentialStatus(input: { endpoint: string }) {
    return credentialStatusSchema.parse(await native.getCredentialStatus(input));
  },
  async openCredentialDialog(input: { endpoint: string }) {
    return credentialStatusSchema.parse(await native.openCredentialDialog(input));
  },
  async getCapabilities(input: { endpoint: string }): Promise<ElectronSpeechCatalog> {
    return catalogSchema.parse(await native.getCapabilities(input));
  },
  async startRecognition(input: { requestId: string; endpoint: string; model: string }): Promise<ElectronSpeechRecognitionReady> {
    return recognitionReadySchema.parse(await native.startRecognition(input));
  },
  appendAudio(input: { requestId: string; pcm: string }) { return native.appendAudio(input); },
  async commitRecognition(input: { requestId: string }): Promise<{ transcript: string }> {
    return z.strictObject({ transcript: z.string().max(262_144) }).parse(await native.commitRecognition(input));
  },
  speak(input: { requestId: string; endpoint: string; model: string; voice: string; speed: number; text: string }) {
    return native.speak(input);
  },
  acknowledgeAudio(input: { requestId: string; sequence: number }) { return native.acknowledgeAudio(input); },
  cancel(input: { requestId: string }) { return native.cancel(input); },
  cancelAll() { return native.cancelAll(); },
  async getWindowState() { return windowStateSchema.parse(await native.getWindowState()); },
  setAudioActive(input: { active: boolean }) { return native.setAudioActive(input); },
  addAudioListener(listener: (event: ElectronSpeechAudioChunk) => void) {
    return native.addListener("audioChunk", (event) => listener(audioChunkSchema.parse(event)));
  },
  addInterruptedListener(listener: (event: ElectronSpeechInterrupted) => void) {
    return native.addListener("interrupted", (event) => listener(interruptedSchema.parse(event)));
  },
  addRecognitionErrorListener(listener: (event: ElectronSpeechRecognitionError) => void) {
    return native.addListener("recognitionError", (event) => listener(recognitionErrorSchema.parse(event)));
  },
  addWindowStateListener(listener: (event: { visible: boolean }) => void) {
    return native.addListener("windowState", (event) => listener(windowStateSchema.parse(event)));
  },
});
