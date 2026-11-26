import type { ElectronSpeechCatalog, ElectronSpeechRecognitionReady } from "../../src/client/voice/electron-speech-plugin.js";

export type AudioChunk = { requestId: string; sequence: number; pcm: string };
type SpeechBinding = { provider: "server" | "openai"; endpoint: string };
type RecognitionInput = SpeechBinding & { requestId: string; model: string };
type SpeechInput = RecognitionInput & { voice: string; speed: number; text: string };
export interface Transport {
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
export const { SpeechTransport } = await import(new URL("../../packages/electron-speech/electron/dist/transport.mjs", import.meta.url).href) as {
  SpeechTransport: new (options: {
    credentials: { read(endpoint: string): Promise<string | null>; status(endpoint: string): Promise<{ credentialConfigured: boolean }> };
    notify(event: string, value: unknown): void;
  }) => Transport;
};
