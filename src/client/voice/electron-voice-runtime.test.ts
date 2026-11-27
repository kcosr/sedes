import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultNotificationDelivery } from "../../shared/protocol/notification.js";
import type { ClientCommand, RegisteredClient } from "../../shared/protocol/client-controls.js";
import type { ThreadInputContext } from "../../shared/protocol/thread-input.js";
import { ElectronVoiceRuntime } from "./electron-voice-runtime.js";
import { nativeVoiceStateSchema, type NativeVoiceComposerHandoff } from "./native-voice-plugin.js";
import { nativeVoiceDiagnosticsSchema } from "./native-voice-diagnostics.js";
import type { ElectronVoiceConnectionCallbacks, ElectronVoiceConnectionLike } from "./electron-voice-connection.js";
import type { ElectronVoiceCaptureOptions } from "./electron-voice-audio.js";
import type { electronSpeech, ElectronSpeechAudioChunk, ElectronSpeechBinding, ElectronSpeechCatalog, ElectronSpeechRecognitionError } from "./electron-speech-plugin.js";
import { pcmBase64 } from "./electron-voice-recording.js";

const THREAD = "109ae9ee-a06b-48df-a1e0-8c44bce72471";
const OTHER = "08fd727c-9100-4954-b86c-76a0735c343e";
const CLIENT = "a58d4200-6c56-430c-be89-02925f35e0ef";
const BINDING = { profileId: "desktop", serverOrigin: "https://sedes.test", identity: "a".repeat(64) };
const OPENAI_SETTINGS = { speechProvider: "openai" as const, speechEndpoint: "https://api.openai.com/v1",
  sttModel: "gpt-live-transcribe", ttsModel: "gpt-4o-mini-tts", ttsVoice: "coral", ttsSpeed: 1 };
const REGISTRATION: RegisteredClient = { clientId: CLIENT, connectionToken: "b".repeat(43), resumeToken: "c".repeat(43) };
const policy = () => ({ generation: 1, settings: { enabled: true, silenced: false, revision: 1,
  scriptPath: "", arguments: [], timeoutSeconds: 30, assistantResultPhases: ["final"], delivery: defaultNotificationDelivery() } });
const context = (threadId = THREAD): ThreadInputContext => ({ threadId, threadTitle: `Thread ${threadId}`, authority: "current",
  activityToken: "activity-1", userInputRevision: 1, runState: null, sourceTurnId: "turn-1", automaticListenEligible: true, manualListenEligible: true,
  steer: { availability: "available", target: { kind: "turn", turnId: "turn-1" } } });
const notification = (id: string) => ({ payload: { schemaVersion: 5, notificationId: id, event: "turn.completed", occurredAt: new Date().toISOString(),
  title: "Done", message: "", thread: { id: THREAD, title: "Thread" }, turn: { id: "turn-1", outcome: "completed" }, assistantResult: { final: { text: "The reply." } } },
  sourceEventId: id, voice: "speakThenListen", generation: 1, origin: { clientId: CLIENT }, userInputRevision: 1,
  recognitionTarget: { threadId: THREAD, activityToken: "activity-1", sourceTurnId: "turn-1" } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const microphonePcm = () => { const values = new Int16Array(2400); values.fill(3000); return new Uint8Array(values.buffer); };
const runtimes: ElectronVoiceRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.disconnect({ expectedConnectionGeneration: (await runtime.getState()).connectionGeneration });
  vi.useRealTimers();
});

function harness() {
  let capture: ElectronVoiceCaptureOptions | undefined;
  let audioListener: (event: ElectronSpeechAudioChunk) => void = () => {};
  let windowListener: (event: { visible: boolean }) => void = () => {};
  let recognitionError: (event: ElectronSpeechRecognitionError) => void = () => {};
  let interrupted: () => void = () => {};
  const handles: Array<{ remove: ReturnType<typeof vi.fn> }> = [];
  const handle = () => { const value = { remove: vi.fn(async () => {}) }; handles.push(value); return value; };
  const speech = {
    configure: vi.fn(async (binding: ElectronSpeechBinding) => ({ ...binding, credentialConfigured: true })),
    getCredentialStatus: vi.fn(async () => ({ credentialConfigured: true })), openCredentialDialog: vi.fn(async () => ({ credentialConfigured: true })),
    getCapabilities: vi.fn(async () => ({ transcriptionModels: [{ id: "stt", label: "STT", ready: true,
      realtime: { maxBufferBytes: 2_880_000, maxMessageBytes: 8192, maxOutputBytes: 524288, idleTimeoutSeconds: 60, maxSessionSeconds: 3600 } }],
    speechModels: [{ id: "tts", label: "TTS", ready: true, voices: [{ id: "voice", label: "Voice" }], speed: { min: 0.25, max: 4, default: 1 }, maxTextLength: 4096, sampleRate: 24000 as const }] })),
    startRecognition: vi.fn(async (_input: { requestId: string }) => ({ maxBufferBytes: 2_880_000, maxRecordingSeconds: 60, maxSessionSeconds: 3600 })),
    appendAudio: vi.fn(async (_input: { requestId: string; pcm: string }) => {}),
    commitRecognition: vi.fn(async () => ({ transcript: "Recognized speech." })),
    speak: vi.fn(async ({ requestId }: { requestId: string; text: string }) => { audioListener({ requestId, sequence: 0, pcm: pcmBase64(microphonePcm()) }); }),
    acknowledgeAudio: vi.fn(async () => {}), cancel: vi.fn(async () => {}), cancelAll: vi.fn(async () => {}),
    setAudioActive: vi.fn(async () => {}), getWindowState: vi.fn(async () => ({ visible: true })),
    addAudioListener: vi.fn(async (listener: typeof audioListener) => { audioListener = listener; return handle(); }),
    addWindowStateListener: vi.fn(async (listener: typeof windowListener) => { windowListener = listener; return handle(); }),
    addRecognitionErrorListener: vi.fn(async (listener: typeof recognitionError) => { recognitionError = listener; return handle(); }),
    addInterruptedListener: vi.fn(async (listener: () => void) => { interrupted = listener; return handle(); }),
  };
  const playback = { append: vi.fn(async (_pcm: Uint8Array) => {}), finish: vi.fn(async () => {}), cancel: vi.fn() };
  const audio = { listInputDevices: vi.fn(async () => [{ id: "mic", label: "Desktop microphone" }]),
    startCapture: vi.fn(async (options: ElectronVoiceCaptureOptions) => { capture = options; }),
    stopCapture: vi.fn(async () => {}), createPlayback: vi.fn(async () => playback), playCue: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  const storage = new Map<string, string>();
  const requests: Array<{ path: string; init: RequestInit }> = [];
  let requestImpl = async (path: string, init: RequestInit): Promise<Response> => {
    if (path.endsWith("/input-context")) return Response.json(context(decodeURIComponent(path.split("/")[3]!)));
    if (path.endsWith("/inputs")) {
      const body = JSON.parse(init.body as string);
      return Response.json({ mutationId: body.mutationId, operationId: body.mutationId, threadId: decodeURIComponent(path.split("/")[3]!),
        admittedMode: "submit", currentMode: "submit", status: "accepted" });
    }
    throw new Error("Unexpected request.");
  };
  const connections: Array<ElectronVoiceConnectionLike & { callbacks: ElectronVoiceConnectionCallbacks }> = [];
  const resumeTokens: Array<string | undefined> = [];
  const runtime = new ElectronVoiceRuntime({ speech: speech as unknown as typeof electronSpeech, audio,
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } },
    connection: (_binding, callbacks, resumeToken) => {
      resumeTokens.push(resumeToken);
      const connection = { callbacks, registration: null as RegisteredClient | null, voiceStreamId: null as string | null,
        async connect() { this.registration = REGISTRATION; callbacks.registered(REGISTRATION); },
        async request(path: string, init: RequestInit = {}) { requests.push({ path, init }); return requestImpl(path, init); },
        earlyReplyInterest: vi.fn(),
        notifications(enabled: boolean) { this.voiceStreamId = enabled ? crypto.randomUUID() : null; if (!enabled) callbacks.notificationsChanged(false); },
        close() { this.registration = null; this.voiceStreamId = null; callbacks.registered(null); callbacks.notificationsChanged(false); },
      };
      connections.push(connection); return connection;
    } });
  runtimes.push(runtime);
  const current = () => connections.at(-1)!;
  const command = async () => ({ expectedConnectionGeneration: (await runtime.getState()).connectionGeneration });
  const enable = async (patch = {}) => {
    await runtime.setConnection(BINDING);
    const state = await runtime.getState();
    return runtime.updateSettings({ expectedConnectionGeneration: state.connectionGeneration, expectedRevision: state.settingsRevision,
      patch: { audioMode: "input", speechProvider: "server", speechEndpoint: "https://speech.test/v1", sttModel: "stt", ttsModel: "tts", ttsVoice: "voice", recognitionCues: false, ...patch } });
  };
  const foreground = async (visible = true, threadId = THREAD, composerAvailable = true, composerMode: "queue" | "steer" = "queue") => runtime.setForegroundContext({ ...await command(), visible, threadId, composerAvailable, composerMode });
  const begin = async (threadId = THREAD) => {
    await runtime.startManualListen({ ...await command(), threadId });
    await vi.waitFor(async () => expect((await runtime.getState()).phase).toBe("listening"));
  };
  const send = async () => { const state = await runtime.getState(); return runtime.sendRecording({ expectedConnectionGeneration: state.connectionGeneration, recordingId: state.active!.recording!.id }); };
  const emitPolicy = () => { current().callbacks.frame("notification_policy", policy(), current().voiceStreamId!); current().callbacks.notificationsChanged(true); };
  return { runtime, speech, audio, playback, handles, storage, requests, connections, resumeTokens, current, command, enable, foreground, begin, send, emitPolicy,
    pcm: (pcm = microphonePcm()) => capture!.onPcm(pcm), window: (visible: boolean) => windowListener({ visible }), interrupted: () => interrupted(),
    recognitionError: (requestId: string) => recognitionError({ requestId, code: "recognition_disconnected", message: "Speech connection stopped." }),
    request: (implementation: typeof requestImpl) => { requestImpl = implementation; } };
}

describe("Electron app-session voice", () => {
  it("keeps desktop PCM unchanged and explicitly rejects Android upload-quality commands", async () => {
    const h = harness(); await h.enable();
    const before = await h.runtime.getState();
    expect(before.speech.audioQuality).toBe("original");
    expect(before.speech.catalog?.audioInputFormats).toEqual({});
    await expect(h.runtime.setSpeechAudioQuality({ ...await h.command(), expectedAudioQualityRevision: 0, audioQuality: "opus_low" }))
      .rejects.toThrow("Upload quality selection is only supported by the Android client.");
    expect((await h.runtime.getState()).speech).toEqual(before.speech);
  });

  it("uses explicit OpenAI bindings for fresh settings, catalog, credentials, recognition and playback", async () => {
    const h = harness(); await h.runtime.setConnection(BINDING);
    const binding = { provider: "openai", endpoint: "https://api.openai.com/v1" };
    expect(h.speech.configure).toHaveBeenCalledExactlyOnceWith(binding);
    expect(h.speech.getCapabilities).toHaveBeenCalledExactlyOnceWith(binding);
    expect((await h.runtime.getState()).speech.catalog?.source).toBe("openai");
    await h.runtime.openSpeechCredentialDialog(await h.command());
    expect(h.speech.openCredentialDialog).toHaveBeenCalledExactlyOnceWith(binding);
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision,
      patch: { audioMode: "speak", autoListen: false, recognitionCues: false } });
    h.emitPolicy(); await h.begin();
    expect(h.speech.startRecognition).toHaveBeenCalledExactlyOnceWith({ ...binding, requestId: expect.any(String), model: "gpt-live-transcribe" });
    await h.runtime.stopCurrentInteraction({ ...await h.command(), interactionId: (await h.runtime.getState()).active!.id });
    await h.runtime.speakReply({ ...await h.command(), threadId: THREAD, turnId: "openai-turn", assistantResult: { final: { text: "OpenAI reply." } } });
    await vi.waitFor(() => expect(h.speech.speak).toHaveBeenCalledExactlyOnceWith({ ...binding, requestId: expect.any(String),
      model: "gpt-4o-mini-tts", voice: "coral", speed: 1, text: "OpenAI reply." }));
  });

  it("cancels capture and queued replies on a provider switch and ignores the previous catalog response", async () => {
    const h = harness(); await h.enable({ audioMode: "speak", autoListen: false }); h.emitPolicy(); await h.begin();
    const previousRequest = h.speech.startRecognition.mock.calls[0]![0].requestId;
    h.current().callbacks.frame("notification", notification("old-provider-queued"), h.current().voiceStreamId!);
    expect((await h.runtime.getState()).queue.count).toBe(1);
    const oldCatalog: ElectronSpeechCatalog = await h.speech.getCapabilities.mock.results.at(-1)!.value;
    const stale = deferred<typeof oldCatalog>();
    h.speech.getCapabilities.mockImplementationOnce(() => stale.promise);
    const refresh = h.runtime.refreshSpeechCatalog({ ...await h.command(), force: true });
    const openAiCatalog = { ...oldCatalog,
      transcriptionModels: oldCatalog.transcriptionModels.map(model => ({ ...model, id: "gpt-live-transcribe" })),
      speechModels: oldCatalog.speechModels.map(model => ({ ...model, id: "gpt-4o-mini-tts", voices: [{ id: "coral", label: "Coral" }] })) };
    h.speech.getCapabilities.mockResolvedValueOnce(openAiCatalog);
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision, patch: OPENAI_SETTINGS });
    expect(h.speech.cancel).toHaveBeenCalledWith({ requestId: previousRequest });
    expect(h.audio.stopCapture).toHaveBeenCalled();
    expect(h.speech.configure).toHaveBeenLastCalledWith({ provider: "openai", endpoint: "https://api.openai.com/v1" });
    expect(h.speech.getCapabilities).toHaveBeenLastCalledWith({ provider: "openai", endpoint: "https://api.openai.com/v1" });
    stale.resolve(oldCatalog); await refresh;
    expect(await h.runtime.getState()).toMatchObject({ active: null, queue: { count: 0 },
      speech: { credentialConfigured: true, catalog: { source: "openai", sttModels: ["gpt-live-transcribe"], ttsModels: ["gpt-4o-mini-tts"], voices: ["coral"] } } });
    expect(h.speech.speak).not.toHaveBeenCalled(); expect(h.speech.startRecognition).toHaveBeenCalledOnce();
    expect(h.requests.some(request => request.path.endsWith("/inputs"))).toBe(false);
  });

  it("cancels playback from the old provider without starting its automatic follow-up", async () => {
    const h = harness(); await h.enable({ audioMode: "speak" }); h.emitPolicy();
    const drained = deferred<void>(); h.playback.finish.mockImplementationOnce(() => drained.promise);
    h.current().callbacks.frame("notification", notification("old-provider-playback"), h.current().voiceStreamId!);
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledOnce());
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision, patch: OPENAI_SETTINGS });
    expect(h.playback.cancel).toHaveBeenCalled(); expect(h.speech.cancel).toHaveBeenCalled();
    drained.resolve(); await Promise.resolve();
    expect((await h.runtime.getState()).active).toBeNull(); expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it.each(["manual", "auto-listen"] as const)("keeps a finalized %s input POST alive across a provider switch without resending or restarting listening", async recording => {
    const h = harness(); await h.enable({ audioMode: "speak" }); h.emitPolicy(); await h.foreground(true, THREAD, false);
    const pending = deferred<Response>();
    h.request(async path => path.endsWith("/input-context") ? Response.json(context()) : pending.promise);
    const submitted = vi.fn(), errors = vi.fn();
    await h.runtime.addListener("inputSubmitted", submitted); await h.runtime.addListener("runtimeError", errors);
    if (recording === "manual") await h.begin();
    else {
      h.current().callbacks.frame("notification", notification("automatic-input-before-provider-change"), h.current().voiceStreamId!);
      await vi.waitFor(async () => expect((await h.runtime.getState()).phase).toBe("listening"));
    }
    h.pcm(); await h.send();
    await vi.waitFor(() => expect(h.requests.filter(request => request.path.endsWith("/inputs"))).toHaveLength(1));
    const request = h.requests.find(request => request.path.endsWith("/inputs"))!;
    const mutationId: string = JSON.parse(request.init.body as string).mutationId;
    const active = (await h.runtime.getState()).active!;
    expect(active.automatic).toBe(recording === "auto-listen");
    expect(request.init.signal?.aborted).toBe(false);
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision, patch: OPENAI_SETTINGS });
    expect(await h.runtime.getState()).toMatchObject({ phase: "submitting", active: { id: active.id }, settings: { speechProvider: "openai" } });
    expect(request.init.signal?.aborted).toBe(false);
    expect(submitted).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
    pending.resolve(Response.json({ mutationId, operationId: mutationId, threadId: THREAD, admittedMode: "submit", currentMode: "submit", status: "accepted" }));
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: mutationId, threadId: THREAD, text: "Recognized speech." })));
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(h.requests.filter(request => request.path.endsWith("/inputs"))).toHaveLength(1);
    expect(h.audio.startCapture).toHaveBeenCalledOnce(); expect(h.speech.startRecognition).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled(); expect((await h.runtime.getState()).errors).toEqual([]);
  });

  it.each(["offered", "accepted"] as const)("preserves an %s composer handoff when its finalized recording's provider changes", async stage => {
    const h = harness(); await h.enable({ audioMode: "speak" }); h.emitPolicy(); await h.foreground();
    const offers: NativeVoiceComposerHandoff[] = [], errors = vi.fn();
    await h.runtime.addListener("composerHandoff", offer => offers.push(offer)); await h.runtime.addListener("runtimeError", errors);
    await h.begin(); h.pcm(); await h.send();
    await vi.waitFor(() => expect(offers).toHaveLength(1));
    const input = { ...await h.command(), handoffId: offers[0]!.handoffId };
    const activeId = (await h.runtime.getState()).active!.id;
    if (stage === "accepted") {
      await h.runtime.claimComposerHandoff(input);
      await h.runtime.completeComposerHandoff({ ...input, outcome: "accepted", submissionPending: true });
    }
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision, patch: OPENAI_SETTINGS });
    expect(await h.runtime.getState()).toMatchObject({ phase: "submitting", active: { id: activeId }, settings: { speechProvider: "openai" } });
    if (stage === "offered") {
      await h.runtime.claimComposerHandoff(input);
      await h.runtime.completeComposerHandoff({ ...input, outcome: "accepted", submissionPending: true });
    }
    await h.runtime.settleComposerSubmission(input);
    expect((await h.runtime.getState()).active).toBeNull();
    expect(offers).toHaveLength(1); expect(errors).not.toHaveBeenCalled();
    expect(h.requests.some(request => request.path.endsWith("/inputs"))).toBe(false);
    expect(h.audio.startCapture).toHaveBeenCalledOnce(); expect(h.speech.startRecognition).toHaveBeenCalledOnce();
  });

  it("does not adopt an old provider's credential status after a later provider configuration", async () => {
    const h = harness(); await h.enable();
    const stale = deferred<ElectronSpeechBinding & { credentialConfigured: boolean }>();
    h.speech.configure.mockImplementationOnce(() => stale.promise);
    const oldUpdate = h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision, patch: OPENAI_SETTINGS });
    await vi.waitFor(() => expect(h.speech.configure).toHaveBeenLastCalledWith({ provider: "openai", endpoint: "https://api.openai.com/v1" }));
    h.speech.configure.mockResolvedValueOnce({ provider: "server", endpoint: "https://other-speech.test/v1", credentialConfigured: false });
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision,
      patch: { speechProvider: "server", speechEndpoint: "https://other-speech.test/v1", sttModel: "stt", ttsModel: "tts", ttsVoice: "voice" } });
    stale.resolve({ provider: "openai", endpoint: "https://api.openai.com/v1", credentialConfigured: true }); await oldUpdate;
    expect(await h.runtime.getState()).toMatchObject({ readiness: "speechConfigurationRequired",
      settings: { speechProvider: "server", speechEndpoint: "https://other-speech.test/v1" }, speech: { credentialConfigured: false, catalog: null } });
  });

  it("rejects a credential dialog result after switching providers without replacing the new provider's status", async () => {
    const h = harness(); await h.enable();
    const stale = deferred<{ credentialConfigured: boolean }>(); h.speech.openCredentialDialog.mockImplementationOnce(() => stale.promise);
    const dialog = h.runtime.openSpeechCredentialDialog(await h.command());
    const rejected = expect(dialog).rejects.toThrow("Speech settings changed while the credential dialog was open");
    await vi.waitFor(() => expect(h.speech.openCredentialDialog).toHaveBeenCalledExactlyOnceWith({ provider: "server", endpoint: "https://speech.test/v1" }));
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision, patch: OPENAI_SETTINGS });
    stale.resolve({ credentialConfigured: false }); await rejected;
    expect(await h.runtime.getState()).toMatchObject({ settings: { speechProvider: "openai" },
      speech: { credentialConfigured: true, catalog: { source: "openai" } } });
  });

  it("restores client controls while voice is Off and keeps the current foreground view", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.runtime.setConnection(BINDING); await h.foreground();
    const old = h.current(), generation = (await h.runtime.getState()).connectionGeneration;
    old.close(); old.callbacks.failed("client_connection_unavailable");
    old.callbacks.failed("client_connection_unavailable");
    await vi.advanceTimersByTimeAsync(4_999); expect(h.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.connections).toHaveLength(2);
    expect(h.resumeTokens).toEqual([undefined, REGISTRATION.resumeToken]);
    const state = nativeVoiceStateSchema.parse(await h.runtime.getState());
    expect(state).toMatchObject({ connectionGeneration: generation + 1, readiness: "off", originClientId: CLIENT,
      foreground: { visible: true, threadId: THREAD, composerAvailable: true } });
    expect(h.current().callbacks.state().runtime.foreground).toBe(true);
    expect(h.current().voiceStreamId).toBeNull(); expect(h.audio.startCapture).not.toHaveBeenCalled();
    old.callbacks.failed("client_connection_unavailable");
    await vi.advanceTimersByTimeAsync(10_000); expect(h.connections).toHaveLength(2);
    h.current().close(); h.current().callbacks.failed("client_connection_unavailable");
    await vi.advanceTimersByTimeAsync(4_999); expect(h.connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(h.connections).toHaveLength(3);
  });

  it.each(["authentication_required", "connection_identity_changed", "client_connection_replaced", "notification_stream_unavailable"])(
    "requires explicit recovery after %s", async code => {
      vi.useFakeTimers();
      const h = harness(); await h.enable();
      if (!code.startsWith("notification_")) h.current().close();
      h.current().callbacks.failed(code);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.connections).toHaveLength(1); expect(h.audio.startCapture).not.toHaveBeenCalled();
      await h.runtime.setConnection({ ...BINDING, reconnect: true });
      expect(h.resumeTokens[1]).toBe(code.startsWith("notification_") ? REGISTRATION.resumeToken : undefined);
    });

  it("discards an expired resume token before retrying registration with a fresh identity", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.runtime.setConnection(BINDING);
    h.current().close(); h.current().callbacks.failed("client_connection_unavailable");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.resumeTokens).toEqual([undefined, REGISTRATION.resumeToken]);
    h.current().close(); h.current().callbacks.failed("client_session_expired");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.resumeTokens).toEqual([undefined, REGISTRATION.resumeToken, undefined]);
    expect([...h.storage.values()].join("")).not.toContain(REGISTRATION.resumeToken);
  });

  it.each(["disconnect", "switch"] as const)("cancels a pending control reconnect on %s", async action => {
    vi.useFakeTimers();
    const h = harness(); await h.runtime.setConnection(BINDING);
    h.current().close(); h.current().callbacks.failed("client_connection_unavailable");
    if (action === "disconnect") await h.runtime.disconnect(await h.command());
    else await h.runtime.setConnection({ ...BINDING, profileId: "other", serverOrigin: "https://other.test", identity: "d".repeat(64) });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.connections).toHaveLength(action === "switch" ? 2 : 1);
    expect((await h.runtime.getState()).serverOrigin).toBe(action === "switch" ? "https://other.test" : null);
    if (action === "switch") expect(h.resumeTokens[1]).toBeUndefined();
    else {
      await h.runtime.setConnection(BINDING);
      expect(h.resumeTokens[1]).toBeUndefined();
    }
  });

  it("does not replay an interrupted send or queued reply when client controls reconnect", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.enable({ audioMode: "speak", autoListen: false }); h.emitPolicy();
    const pending = deferred<Response>();
    h.request(async path => path.endsWith("/input-context") ? Response.json(context()) : pending.promise);
    await h.begin(); h.pcm(); await h.send();
    await vi.waitFor(() => expect(h.requests.some(request => request.path.endsWith("/inputs"))).toBe(true));
    h.current().callbacks.frame("notification", notification("queued-before-reconnect"), h.current().voiceStreamId!);
    expect((await h.runtime.getState()).queue.count).toBe(1);
    // A connection closes before publishing its failure; manual input is still active.
    h.current().close(); h.current().callbacks.failed("client_connection_unavailable");
    expect((await h.runtime.getState()).errors.at(-1)?.code).toBe("input_submission_uncertain");
    pending.reject(new Error("Connection closed after upload"));
    await vi.advanceTimersByTimeAsync(5_000); h.emitPolicy();
    expect(h.connections).toHaveLength(2);
    expect((await h.runtime.getState())).toMatchObject({ active: null, queue: { count: 0 }, recovery: [],
      errors: [{ code: "input_submission_uncertain", message: expect.stringContaining("Nothing will be resent") }] });
    expect(h.requests.filter(request => request.path.endsWith("/inputs"))).toHaveLength(1);
    expect(h.speech.startRecognition).toHaveBeenCalledOnce(); expect(h.speech.speak).not.toHaveBeenCalled();
  });

  it("registers one owner, publishes strict state and keeps tokens/audio out of preference storage", async () => {
    const h = harness(); await h.enable();
    const state = nativeVoiceStateSchema.parse(await h.runtime.getState());
    expect(state.originClientId).toBe(CLIENT); expect(h.connections).toHaveLength(1);
    await h.runtime.setConnection(BINDING); expect(h.connections).toHaveLength(1);
    expect(state.actions.canStart).toBe(true); expect(state.ready).toBe(false);
    expect(state.recovery).toEqual([]); expect(state.recordingRecovery).toBeNull();
    const stored = [...h.storage.values()].join("");
    expect(stored).not.toContain(REGISTRATION.connectionToken);
    expect(await h.runtime.listInputDevices()).toEqual({ devices: [{ platform: "electron", id: "mic", label: "Desktop microphone" }] });
  });

  it("starts notifications despite a speech configuration failure and recovers after corrected speech settings", async () => {
    const h = harness(); await h.enable({ audioMode: "speak", autoListen: false });
    h.speech.configure.mockRejectedValueOnce(new Error("OS keyring is locked."));
    await h.runtime.setConnection({ ...BINDING, reconnect: true });
    expect(h.current().voiceStreamId).not.toBeNull(); h.emitPolicy();
    expect((await h.runtime.getState()).readiness).toBe("speechConfigurationRequired");
    const state = await h.runtime.getState();
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: state.settingsRevision,
      patch: { speechEndpoint: "https://speech.test/corrected/v1" } });
    expect((await h.runtime.getState()).ready).toBe(true);
    h.current().callbacks.frame("notification", notification("after-configuration-fix"), h.current().voiceStreamId!);
    await vi.waitFor(() => expect(h.speech.speak).toHaveBeenCalledOnce());
    expect(h.connections).toHaveLength(2);
  });

  it("drains notifications that arrive while startup speech configuration is pending", async () => {
    const h = harness(); await h.enable({ audioMode: "speak", autoListen: false });
    const configured = deferred<ElectronSpeechBinding & { credentialConfigured: boolean }>();
    h.speech.configure.mockImplementationOnce(() => configured.promise);
    const connecting = h.runtime.setConnection({ ...BINDING, reconnect: true });
    await vi.waitFor(() => expect(h.speech.configure).toHaveBeenCalledTimes(3));
    h.emitPolicy(); h.current().callbacks.frame("notification", notification("during-startup"), h.current().voiceStreamId!);
    await Promise.resolve();
    expect((await h.runtime.getState()).queue.count).toBe(1); expect(h.speech.speak).not.toHaveBeenCalled();
    configured.resolve({ provider: "server", endpoint: "https://speech.test/v1", credentialConfigured: true }); await connecting;
    await vi.waitFor(() => expect(h.speech.speak).toHaveBeenCalledOnce());
    expect((await h.runtime.getState()).queue.count).toBe(0);
  });

  it("preserves active playback when startup catalog refresh completes", async () => {
    const h = harness(); await h.enable({ audioMode: "speak", autoListen: false });
    const catalog = await h.speech.getCapabilities.mock.results.at(-1)!.value;
    const refreshed = deferred<typeof catalog>(), drained = deferred<void>();
    h.speech.getCapabilities.mockImplementationOnce(() => refreshed.promise);
    h.playback.finish.mockImplementationOnce(() => drained.promise);
    const connecting = h.runtime.setConnection({ ...BINDING, reconnect: true });
    await vi.waitFor(() => expect(h.speech.getCapabilities).toHaveBeenCalledTimes(3));
    h.emitPolicy(); h.current().callbacks.frame("notification", notification("during-catalog-refresh"), h.current().voiceStreamId!);
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledOnce());
    refreshed.resolve(catalog); await connecting;
    expect((await h.runtime.getState()).phase).toBe("speaking");
    expect((await h.runtime.getState()).active?.id).toBe("during-catalog-refresh");
    drained.resolve();
  });

  it("recovers the phase and queued playback after credential-dialog configuration fixes a startup failure", async () => {
    const h = harness(); await h.enable({ audioMode: "speak", autoListen: false });
    h.speech.configure.mockRejectedValueOnce(new Error("OS keyring is locked."));
    await h.runtime.setConnection({ ...BINDING, reconnect: true }); h.emitPolicy();
    expect((await h.runtime.getState()).phase).toBe("error");
    const configured = deferred<ElectronSpeechBinding & { credentialConfigured: boolean }>();
    h.speech.configure.mockImplementationOnce(() => configured.promise);
    const recovering = h.runtime.openSpeechCredentialDialog(await h.command());
    await vi.waitFor(() => expect(h.speech.configure).toHaveBeenCalledTimes(4));
    h.current().callbacks.frame("notification", notification("during-credential-recovery"), h.current().voiceStreamId!);
    await Promise.resolve();
    expect((await h.runtime.getState()).queue.count).toBe(1); expect(h.speech.speak).not.toHaveBeenCalled();
    configured.resolve({ provider: "server", endpoint: "https://speech.test/v1", credentialConfigured: true });
    expect((await recovering).phase).toBe("idle");
    await vi.waitFor(() => expect(h.speech.speak).toHaveBeenCalledOnce());
    expect((await h.runtime.getState()).queue.count).toBe(0);
  });

  it("sends one final transcript directly while minimized, with JSON content type and no client-selected origin", async () => {
    const h = harness(); await h.enable(); await h.foreground(); h.window(false);
    const handoff = vi.fn(); await h.runtime.addListener("composerHandoff", handoff);
    await h.begin(); h.pcm(); await h.send(); await h.send();
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    const inputs = h.requests.filter(request => request.path.endsWith("/inputs"));
    expect(inputs).toHaveLength(1);
    expect(new Headers(inputs[0]!.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(inputs[0]!.init.body as string)).toEqual({ mutationId: expect.any(String), text: "Recognized speech.", runningPolicy: { mode: "queue" } });
    expect(handoff).not.toHaveBeenCalled(); expect([...h.storage.values()].join("")).not.toContain("Recognized speech");
  });

  it.each([
    { label: "queues by default", followComposerMode: false, steerAvailable: true, mode: "queue" },
    { label: "steers the current turn when following the composer", followComposerMode: true, steerAvailable: true, mode: "steer" },
    { label: "queues when the selected Steer action is unavailable", followComposerMode: true, steerAvailable: false, mode: "queue" },
  ] as const)("$label and honors the server's admission receipt", async ({ followComposerMode, steerAvailable, mode }) => {
    const h = harness(); await h.enable({ followComposerMode }); await h.foreground(true, THREAD, true, "steer"); h.window(false);
    let contexts = 0;
    h.request(async (path, init) => {
      if (path.endsWith("/input-context")) {
        contexts++;
        return Response.json({ ...context(), steer: steerAvailable
          ? { availability: "available", target: { kind: "turn", turnId: contexts >= 4 ? "current-turn-at-send" : "old-turn" } }
          : { availability: "unavailable" } });
      }
      const body = JSON.parse(init.body as string);
      return Response.json({ mutationId: body.mutationId, operationId: body.mutationId, threadId: THREAD,
        admittedMode: mode, currentMode: mode, status: mode === "queue" ? "queued" : "accepted",
        ...(mode === "queue" ? { queuedInputId: "queued-voice-input" } : {}) });
    });
    const submitted = vi.fn(); await h.runtime.addListener("inputSubmitted", submitted);
    await h.begin(); h.pcm(); await h.send();
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    const requests = h.requests.filter(request => request.path.endsWith("/inputs"));
    expect(requests).toHaveLength(1); expect(contexts).toBe(4);
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ mutationId: expect.any(String), text: "Recognized speech.",
      runningPolicy: mode === "steer" ? { mode: "steer", target: { kind: "turn", turnId: "current-turn-at-send" }, onUnavailable: "queue" } : { mode: "queue" } });
    expect((await h.runtime.getState()).errors).toEqual([]); expect(submitted).not.toHaveBeenCalled();
  });

  it("transfers a visible recording to the composer once and holds playback until its send settles", async () => {
    const h = harness(); await h.enable(); await h.foreground();
    const offers: NativeVoiceComposerHandoff[] = [];
    await h.runtime.addListener("composerHandoff", event => offers.push(event));
    await h.begin(); h.pcm(); await h.send();
    await vi.waitFor(() => expect(offers).toHaveLength(1));
    const input = { ...await h.command(), handoffId: offers[0]!.handoffId };
    await h.runtime.claimComposerHandoff(input);
    await h.runtime.completeComposerHandoff({ ...input, outcome: "accepted", submissionPending: true });
    expect((await h.runtime.getState()).phase).toBe("submitting");
    expect(h.requests.filter(request => request.path.endsWith("/inputs"))).toHaveLength(0);
    await h.runtime.settleComposerSubmission(input);
    expect((await h.runtime.getState()).active).toBeNull();
    await h.runtime.settleComposerSubmission(input);
    expect((await h.runtime.getState()).active).toBeNull();
  });

  it("never changes a chosen composer send into a direct send when minimized during final recognition", async () => {
    const h = harness(); await h.enable(); await h.foreground();
    const result = deferred<{ transcript: string }>(); h.speech.commitRecognition.mockImplementationOnce(() => result.promise);
    await h.begin(); h.pcm(); await h.send();
    await vi.waitFor(() => expect(h.speech.commitRecognition).toHaveBeenCalledOnce());
    h.window(false); result.resolve({ transcript: "Do not send outside my composer." });
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(h.requests.some(request => request.path.endsWith("/inputs"))).toBe(false);
    expect((await h.runtime.getState()).errors.at(-1)?.message).toContain("composer was hidden");
  });

  it("does not retry an uncertain input POST or expose recording recovery", async () => {
    const h = harness(); await h.enable();
    h.request(async path => { if (path.endsWith("/input-context")) return Response.json(context()); throw new Error("reply lost"); });
    await h.begin(); h.pcm(); await h.send();
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.requests.filter(request => request.path.endsWith("/inputs"))).toHaveLength(1);
    expect((await h.runtime.getState()).errors.at(-1)?.code).toBe("input_submission_uncertain");
    expect((await h.runtime.getState()).errors.at(-1)?.message).toContain("Nothing will be resent");
    expect((await h.runtime.getState()).recovery).toEqual([]);
    await expect(h.runtime.resumeInput({ ...await h.command(), mutationId: crypto.randomUUID() })).rejects.toThrow("not supported");
  });

  it.each(["stop", "suspend"] as const)("reports an uncertain send when %s interrupts an in-flight input POST", async interruption => {
    const h = harness(); await h.enable(); const pending = deferred<Response>();
    h.request(async path => path.endsWith("/input-context") ? Response.json(context()) : pending.promise);
    const errors = vi.fn(); await h.runtime.addListener("runtimeError", errors);
    await h.begin(); h.pcm(); await h.send();
    await vi.waitFor(() => expect(h.requests.some(request => request.path.endsWith("/inputs"))).toBe(true));
    if (interruption === "stop") await h.runtime.stopCurrentInteraction({ ...await h.command(), interactionId: (await h.runtime.getState()).active!.id });
    else h.interrupted();
    pending.reject(new Error("Aborted after upload"));
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]![0]).toMatchObject({ code: "input_submission_uncertain", message: expect.stringContaining("Check the thread") });
    expect((await h.runtime.getState()).errors.at(-1)?.message).toContain("Nothing will be resent");
    expect(h.requests.filter(request => request.path.endsWith("/inputs"))).toHaveLength(1);
    expect((await h.runtime.getState()).recovery).toEqual([]);
  });

  it("cancels before the input POST without incorrectly reporting an uncertain send", async () => {
    const h = harness(); await h.enable(); const pending = deferred<Response>(); let contexts = 0;
    h.request(async () => ++contexts === 4 ? pending.promise : Response.json(context()));
    await h.begin(); h.pcm(); await h.send();
    await vi.waitFor(() => expect(contexts).toBe(4));
    await h.runtime.stopCurrentInteraction({ ...await h.command(), interactionId: (await h.runtime.getState()).active!.id });
    pending.resolve(Response.json(context()));
    await Promise.resolve(); await Promise.resolve();
    expect((await h.runtime.getState()).errors).toEqual([]);
    expect(h.requests.some(request => request.path.endsWith("/inputs"))).toBe(false);
  });

  it("keeps composer handoff cancellation separate from direct-send uncertainty", async () => {
    const h = harness(); await h.enable(); await h.foreground();
    const handoff = vi.fn(); await h.runtime.addListener("composerHandoff", handoff);
    await h.begin(); h.pcm(); await h.send();
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    await h.runtime.stopCurrentInteraction({ ...await h.command(), interactionId: (await h.runtime.getState()).active!.id });
    expect((await h.runtime.getState()).errors).toEqual([]);
    expect(h.requests.some(request => request.path.endsWith("/inputs"))).toBe(false);
  });

  it("waits for physical playback drain before starting automatic microphone capture", async () => {
    const h = harness(); await h.enable({ audioMode: "speak" }); h.emitPolicy();
    const drained = deferred<void>(); h.playback.finish.mockImplementationOnce(() => drained.promise);
    h.current().callbacks.frame("notification", notification("reply-1"), h.current().voiceStreamId!);
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledOnce());
    expect(h.audio.startCapture).not.toHaveBeenCalled();
    drained.resolve();
    await vi.waitFor(() => expect(h.audio.startCapture).toHaveBeenCalledOnce());
    expect((await h.runtime.getState()).active?.recognitionThreadId).toBe(THREAD);
  });

  it("Stop cancels playback and cannot be undone by a late audio drain callback", async () => {
    const h = harness(); await h.enable({ audioMode: "speak" }); h.emitPolicy();
    const drained = deferred<void>(); h.playback.finish.mockImplementationOnce(() => drained.promise);
    h.current().callbacks.frame("notification", notification("reply-stop"), h.current().voiceStreamId!);
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledOnce());
    const state = await h.runtime.getState(); await h.runtime.stopPlayback({ ...await h.command(), interactionId: state.active!.id });
    drained.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.audio.startCapture).not.toHaveBeenCalled(); expect(h.playback.cancel).toHaveBeenCalled();
  });

  it("keeps spoken replies in FIFO order and Next advances without listening to the skipped reply", async () => {
    const h = harness(); await h.enable({ audioMode: "speak", speechContent: "messages", autoListen: false }); h.emitPolicy();
    const first = deferred<void>(), second = deferred<void>();
    h.playback.finish.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const reply = (id: string, text: string) => {
      const value = notification(id); value.payload.assistantResult.final.text = text;
      h.current().callbacks.frame("notification", value, h.current().voiceStreamId!);
    };
    reply("first", "First reply.");
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledTimes(1));
    reply("second", "Second reply."); reply("third", "Third reply.");
    expect((await h.runtime.getState()).queue.count).toBe(2);
    await h.runtime.skipCurrentPlayback({ ...await h.command(), interactionId: (await h.runtime.getState()).active!.id });
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledTimes(2));
    expect((await h.runtime.getState()).queue.count).toBe(1);
    first.resolve(); second.resolve();
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(h.speech.speak.mock.calls.map(([call]) => call.text)).toEqual(["First reply.", "Second reply.", "Third reply."]);
    expect((await h.runtime.getState()).queue.count).toBe(0); expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it("suppresses a stale completion before synthesis or automatic listening", async () => {
    const h = harness(); await h.enable({ audioMode: "speak" }); h.emitPolicy();
    h.request(async () => Response.json({ ...context(), userInputRevision: 2 }));
    h.current().callbacks.frame("notification", notification("stale-reply"), h.current().voiceStreamId!);
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(h.speech.speak).not.toHaveBeenCalled(); expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it("cancels a pending recognition handshake without opening the microphone on its late result", async () => {
    const h = harness(); await h.enable(); const ready = deferred<{ maxBufferBytes: number; maxRecordingSeconds: number; maxSessionSeconds: number }>();
    h.speech.startRecognition.mockImplementationOnce(() => ready.promise);
    await h.runtime.startManualListen({ ...await h.command(), threadId: THREAD });
    await vi.waitFor(() => expect(h.speech.startRecognition).toHaveBeenCalledOnce());
    const state = await h.runtime.getState(); await h.runtime.stopCurrentInteraction({ ...await h.command(), interactionId: state.active!.id });
    ready.resolve({ maxBufferBytes: 2_880_000, maxRecordingSeconds: 60, maxSessionSeconds: 3600 });
    await Promise.resolve(); await Promise.resolve();
    expect(h.audio.startCapture).not.toHaveBeenCalled(); expect(h.speech.cancel).toHaveBeenCalled();
  });

  it("continues a held recording through silence and sends literal stop text only after explicit Send", async () => {
    const h = harness(); await h.enable({ keepListeningByDefault: true, recognitionEndSilenceMs: 100, recognizeStopCommand: true });
    h.speech.commitRecognition.mockResolvedValue({ transcript: "stop" });
    await h.begin(); h.pcm(); h.pcm(new Uint8Array(4800)); h.pcm(new Uint8Array(4800));
    expect((await h.runtime.getState()).phase).toBe("listening");
    await h.send();
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(JSON.parse(h.requests.find(request => request.path.endsWith("/inputs"))!.init.body as string).text).toBe("stop");
  });

  it("finalizes a held recording once at its configured maximum duration", async () => {
    const h = harness(); await h.enable({ keepListeningByDefault: true, longDictationTimeoutMs: 60_000 });
    vi.useFakeTimers();
    await h.runtime.startManualListen({ ...await h.command(), threadId: THREAD });
    await vi.advanceTimersByTimeAsync(0);
    expect((await h.runtime.getState()).phase).toBe("listening"); h.pcm();
    await vi.advanceTimersByTimeAsync(59_999);
    expect((await h.runtime.getState()).phase).toBe("listening");
    await vi.advanceTimersByTimeAsync(1);
    expect((await h.runtime.getState()).active).toBeNull();
    expect(h.speech.commitRecognition).toHaveBeenCalledOnce();
    expect(h.requests.filter(request => request.path.endsWith("/inputs"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.speech.startRecognition).toHaveBeenCalledOnce();
    expect(h.requests.filter(request => request.path.endsWith("/inputs"))).toHaveLength(1);
  });

  it("stops a failed live recognition without reopening the microphone or sending partial text", async () => {
    const h = harness(); await h.enable({ keepListeningByDefault: true }); await h.begin(); h.pcm();
    const requestId = h.speech.startRecognition.mock.calls[0]![0].requestId;
    h.recognitionError(requestId);
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(h.audio.stopCapture).toHaveBeenCalled(); expect(h.speech.cancel).toHaveBeenCalledWith({ requestId });
    expect(h.speech.startRecognition).toHaveBeenCalledOnce(); expect(h.audio.startCapture).toHaveBeenCalledOnce();
    expect(h.speech.commitRecognition).not.toHaveBeenCalled();
    expect(h.requests.some(request => request.path.endsWith("/inputs"))).toBe(false);
    expect((await h.runtime.getState()).recordingRecovery).toBeNull();
    expect((await h.runtime.getState()).errors.at(-1)?.message).toBe("Speech connection stopped.");
  });

  it.each(["manual", "automatic"] as const)("ends an unanswered %s recording quietly with its completion cue", async kind => {
    const h = harness(); await h.enable({ recognitionStartTimeoutMs: 100, recognitionCues: true });
    const errors = vi.fn(); await h.runtime.addListener("runtimeError", errors);
    if (kind === "manual") await h.begin();
    else {
      h.emitPolicy(); h.current().callbacks.frame("notification", notification("unanswered-followup"), h.current().voiceStreamId!);
      await vi.waitFor(async () => expect((await h.runtime.getState()).phase).toBe("listening"));
    }
    h.pcm(new Uint8Array(4800));
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(errors).not.toHaveBeenCalled(); expect((await h.runtime.getState()).errors).toEqual([]);
    expect(h.audio.playCue).toHaveBeenCalledWith("failure", 1, expect.any(AbortSignal));
    expect(h.speech.commitRecognition).not.toHaveBeenCalled();
    expect(h.requests.some(request => request.path.endsWith("/inputs"))).toBe(false);
  });

  it("flushes the final microphone tail exactly once at Send", async () => {
    const h = harness(); await h.enable(); await h.begin();
    h.audio.stopCapture.mockImplementationOnce(async () => { h.pcm(microphonePcm().slice(0, 2000)); });
    await h.send();
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(h.speech.appendAudio).toHaveBeenCalledOnce();
    const decoded = Uint8Array.from(atob(h.speech.appendAudio.mock.calls[0]![0].pcm), character => character.charCodeAt(0));
    expect(decoded.byteLength).toBe(4800); expect(decoded.slice(0, 2000)).toEqual(microphonePcm().slice(0, 2000));
    expect(decoded.slice(2000).every(value => value === 0)).toBe(true);
  });

  it("executes registered navigation controls while voice is Off", async () => {
    const h = harness(); await h.runtime.setConnection(BINDING); await h.foreground();
    const opened = vi.fn(); await h.runtime.addListener("openThread", opened);
    const command: ClientCommand = { id: crypto.randomUUID(), action: "switch_thread", sourceThreadId: THREAD, sourceTurnId: "turn-1", threadId: OTHER, listen: false, expiresAt: Date.now() + 60_000 };
    expect((await h.current().callbacks.command(command)).status).toBe("accepted");
    await h.current().callbacks.command({ ...command, action: "turn_settled", replyEventId: null, replyStreamIds: [] });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect(opened.mock.calls[0]![0].threadId).toBe(OTHER); expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it("end_interaction suppresses its source follow-up after reply drain without interrupting unrelated playback", async () => {
    const h = harness(); await h.enable({ audioMode: "speak" }); h.emitPolicy();
    const command: ClientCommand = { id: crypto.randomUUID(), action: "end_interaction", sourceThreadId: THREAD, sourceTurnId: "turn-1", expiresAt: Date.now() + 60_000 };
    expect((await h.current().callbacks.command(command)).status).toBe("accepted");
    h.current().callbacks.frame("notification", notification("end-reply"), h.current().voiceStreamId!);
    await h.current().callbacks.command({ ...command, action: "turn_settled", replyEventId: "end-reply", replyStreamIds: [h.current().voiceStreamId!] });
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it.each(["settings", "credentials"] as const)("releases a settled listen control when %s changes discard its queued reply", async change => {
    const h = harness(); await h.enable({ audioMode: "speak" }); await h.foreground(); h.emitPolicy();
    await h.begin();
    const opened = vi.fn(); await h.runtime.addListener("openThread", opened);
    const command: ClientCommand = { id: crypto.randomUUID(), action: "switch_thread", sourceThreadId: THREAD, sourceTurnId: "turn-1",
      threadId: OTHER, listen: true, expiresAt: Date.now() + 60_000 };
    await h.current().callbacks.command(command);
    h.current().callbacks.frame("notification", notification("discarded-reply-barrier"), h.current().voiceStreamId!);
    await h.current().callbacks.command({ ...command, action: "turn_settled", replyEventId: "discarded-reply-barrier", replyStreamIds: [h.current().voiceStreamId!] });
    expect((await h.runtime.getState()).queue.count).toBe(1); expect(opened).not.toHaveBeenCalled();
    if (change === "settings") await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision, patch: { ttsVoice: "new-voice" } });
    else await h.runtime.openSpeechCredentialDialog(await h.command());
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.audio.startCapture).toHaveBeenCalledTimes(2));
    expect(opened.mock.calls[0]![0].threadId).toBe(OTHER);
    expect((await h.runtime.getState()).active?.recognitionThreadId).toBe(OTHER);
    expect((await h.runtime.getState()).queue.count).toBe(0); expect(h.speech.speak).not.toHaveBeenCalled();
  });

  it("manual navigation supersedes a pending agent listen", async () => {
    const h = harness(); await h.enable(); await h.foreground();
    const command: ClientCommand = { id: crypto.randomUUID(), action: "switch_thread", sourceThreadId: THREAD, sourceTurnId: "turn-1", threadId: THREAD, listen: true, expiresAt: Date.now() + 60_000 };
    await h.current().callbacks.command(command); await h.foreground(true, OTHER);
    expect((await h.current().callbacks.command({ ...command, action: "turn_settled", replyEventId: null, replyStreamIds: [] })).status).toBe("noop");
    expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it("drains queued replies after navigation cancels an agent listen that is still validating", async () => {
    const h = harness(); await h.enable({ audioMode: "speak", autoListen: false }); await h.foreground(); h.emitPolicy();
    const pending = deferred<Response>();
    h.request(async path => path.includes(OTHER) ? pending.promise : Response.json(context()));
    const command: ClientCommand = { id: crypto.randomUUID(), action: "switch_thread", sourceThreadId: THREAD, sourceTurnId: "turn-1",
      threadId: OTHER, listen: true, expiresAt: Date.now() + 60_000 };
    await h.current().callbacks.command(command);
    await h.current().callbacks.command({ ...command, action: "turn_settled", replyEventId: null, replyStreamIds: [] });
    await vi.waitFor(() => expect(h.requests.some(request => request.path.includes(OTHER))).toBe(true));
    await h.foreground(true, OTHER);
    h.current().callbacks.frame("notification", notification("queued-during-listen"), h.current().voiceStreamId!);
    expect((await h.runtime.getState()).queue.count).toBe(1);
    await h.foreground(true, THREAD);
    await vi.waitFor(() => expect(h.speech.speak).toHaveBeenCalledOnce());
    pending.resolve(Response.json(context(OTHER)));
    await vi.waitFor(async () => expect((await h.runtime.getState()).active).toBeNull());
    expect((await h.runtime.getState()).queue.count).toBe(0); expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it("fences a control settings response that finishes after connection replacement", async () => {
    const h = harness(); await h.enable();
    const delayed = deferred<Response>(); h.request(() => delayed.promise);
    const state = await h.runtime.getState();
    const command: ClientCommand = { id: crypto.randomUUID(), action: "settings.update", sourceThreadId: THREAD, sourceTurnId: "turn-1", expiresAt: Date.now() + 60_000,
      expectedRevision: state.settingsRevision, patch: { voiceThreadId: THREAD } };
    const response = h.current().callbacks.command(command);
    await h.runtime.setConnection({ ...BINDING, profileId: "other-profile" });
    delayed.resolve(Response.json(context()));
    expect((await response).status).toBe("failed");
    expect((await h.runtime.getState()).settings.voiceThreadId).toBeNull();
    await expect(h.runtime.startManualListen({ expectedConnectionGeneration: state.connectionGeneration, threadId: THREAD })).rejects.toThrow("connection changed");
  });

  it("keeps explicit input available after a notification outage and never reconnects itself", async () => {
    const h = harness(); await h.enable(); h.emitPolicy();
    h.current().callbacks.notificationsChanged(false); h.current().callbacks.failed("notification_stream_unavailable");
    const state = await h.runtime.getState();
    expect(state.ready).toBe(false); expect(state.actions.canStart).toBe(true); expect(state.actions.canResume).toBe(true);
    await h.begin(); expect(h.connections).toHaveLength(1);
  });

  it("cleans partially registered native listeners before an explicit reconnect", async () => {
    const h = harness(); h.speech.getWindowState.mockRejectedValueOnce(new Error("bridge unavailable"));
    await h.runtime.setConnection(BINDING);
    expect(h.handles).toHaveLength(3); expect(h.handles.every(handle => handle.remove.mock.calls.length === 1)).toBe(true);
    await h.runtime.setConnection({ ...BINDING, reconnect: true });
    expect(h.speech.addAudioListener).toHaveBeenCalledTimes(2);
  });

  it("exports bounded content-free diagnostics in the shared schema", async () => {
    const h = harness(); await h.enable({ audioMode: "speak", autoListen: false });
    await h.runtime.setDiagnosticsEnabled({ enabled: true }); h.emitPolicy();
    h.current().callbacks.frame("notification", notification("diagnostic-notice"), h.current().voiceStreamId!);
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledOnce());
    const diagnostics = nativeVoiceDiagnosticsSchema.parse(await h.runtime.readDiagnostics());
    expect(diagnostics.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostics)).not.toContain("The reply"); expect(JSON.stringify(diagnostics)).not.toContain(REGISTRATION.connectionToken);
  });
});

describe("early Electron reply playback", () => {
  const id = "a".repeat(64);
  const common = { replyId: id, threadId: THREAD, turnId: "turn-1", itemId: "source", generation: 1 };
  const firstBody = "This first sentence opens the reply while the rest of the answer is still streaming.";
  const secondBody = "This second sentence continues the reply while the rest of the answer is still streaming.";
  const completeBody = `${firstBody} ${secondBody} Three.`;
  const opening = { ...common, kind: "begin", event: "turn.completed", seq: 0, userInputRevision: 1, threadTitle: "Thread A", rawStart: 0, rawEnd: firstBody.length + 1, text: firstBody + " ", paragraphEnd: false };
  const commentary = { ...opening, event: "turn.progress" };
  const progressPreamble = "Agent progress\n\nThread A";
  const finalPreamble = "Agent finished\n\nThread A";
  const append = { ...common, kind: "append", seq: 1, rawStart: opening.rawEnd, rawEnd: opening.rawEnd + secondBody.length + 1, text: secondBody + " ", paragraphEnd: false };
  const setup = async (mode: "balanced" | "responsive" | "natural" = "balanced", patch = {}) => {
    const h = harness(); await h.enable({ audioMode: "speak", speechContent: "messages", autoListen: false, ...patch }); h.emitPolicy();
    await h.runtime.setEarlyReplyPlayback({ ...await h.command(), expectedEarlyReplyRevision: 0, earlyReplyPlayback: mode });
    const early = (frame: unknown) => h.current().callbacks.frame("voice_early_reply", frame, h.current().voiceStreamId!);
    const complete = (final = completeBody, identity = id, revision = 1) => {
      const notice = notification(identity); notice.payload.assistantResult.final.text = final; notice.userInputRevision = revision;
      notice.payload.title = "Agent finished"; notice.payload.message = notice.payload.thread.title = "Thread A";
      h.current().callbacks.frame("notification", notice, h.current().voiceStreamId!);
    };
    const progress = (text = completeBody, identity = id, itemId = common.itemId, phase: "provisional" | "partial" = "provisional") => {
      const partial = phase === "partial";
      h.current().callbacks.frame("notification", {
        sourceEventId: identity, voice: "speak", generation: 1, userInputRevision: 1,
        payload: { schemaVersion: 5, notificationId: identity, event: partial ? "turn.partial" : "turn.progress", occurredAt: new Date().toISOString(),
          title: partial ? "Partial answer" : "Agent progress", message: "Thread A", thread: { id: THREAD, title: "Thread A" },
          turn: { id: common.turnId }, progress: { phase, itemId, text } },
      }, h.current().voiceStreamId!);
    };
    const texts = () => h.speech.speak.mock.calls.map(([call]) => call.text);
    const waiting = () => vi.waitFor(async () => expect((await h.runtime.getState()).phase).toBe("waiting_for_reply_text"));
    const idle = () => vi.waitFor(async () => expect(await h.runtime.getState()).toMatchObject({ phase: "idle", active: null, queue: { count: 0 } }));
    return { ...h, early, complete, progress, texts, waiting, idle };
  };

  it("keeps one queue position across starvation, appends and terminal reconciliation", async () => {
    const h = await setup();
    h.early(opening); await h.waiting();
    expect(h.texts()).toEqual([firstBody]);
    h.complete("B reply.", "other"); h.early(append); h.early(append);
    await vi.waitFor(() => expect(h.texts()).toEqual([firstBody, secondBody])); await h.waiting();
    expect((await h.runtime.getState()).queue.count).toBe(1);
    expect(h.audio.startCapture).not.toHaveBeenCalled();
    h.complete(); h.complete(); await h.idle();
    expect(h.texts()).toEqual([firstBody, secondBody, "Three.", "B reply."]);
  });

  it.each([opening, commentary])("speaks the preamble while waiting for six Responsive words, then flushes a short tail on $event seal", async frame => {
    const h = await setup("responsive", { speechContent: "both" });
    const first = "It passed. ", second = "Now we can continue. ", tail = "Done.";
    h.early({ ...frame, text: first, rawEnd: first.length }); await h.waiting();
    const preamble = frame.event === "turn.progress" ? progressPreamble : finalPreamble;
    expect(h.texts()).toEqual([preamble]);
    const end = first.length + second.length;
    h.early({ ...append, text: second, rawStart: first.length, rawEnd: end });
    await vi.waitFor(() => expect(h.texts()).toEqual([preamble, "It passed. Now we can continue."])); await h.waiting();
    h.early({ ...append, seq: 2, text: tail, rawStart: end, rawEnd: end + tail.length });
    if (frame.event === "turn.progress") h.progress(first + second + tail);
    else h.complete(first + second + tail);
    await h.idle();
    expect(h.texts()).toEqual([preamble, "It passed. Now we can continue.", "Done."]);
  });

  it("keeps short Responsive sentences in their own items and flushes each once", async () => {
    const h = await setup("responsive");
    h.early({ ...opening, text: "It passed.", rawEnd: 10 }); await h.waiting();
    const second = { ...commentary, replyId: "c".repeat(64), itemId: "next", text: "Good.", rawEnd: 5 };
    h.early(second);
    h.complete("It passed.");
    await vi.waitFor(async () => expect((await h.runtime.getState()).active?.id).toBe(second.replyId)); await h.waiting();
    expect(h.texts()).toEqual(["It passed."]);
    h.early({ ...common, replyId: second.replyId, itemId: second.itemId, seq: 1, kind: "yield", reason: "item_done" });
    await h.idle();
    h.progress("Good.", second.replyId, second.itemId); await h.idle();
    expect(h.texts()).toEqual(["It passed.", "Good."]);
  });

  it.each(["messages", "both"] as const)("speaks progress once in %s and keeps successive messages distinct", async speechContent => {
    const h = await setup("balanced", { speechContent, autoListen: true });
    const second = { ...commentary, replyId: "b".repeat(64), itemId: "next", text: secondBody, rawEnd: secondBody.length };
    h.early(commentary); await h.waiting();
    expect((await h.runtime.getState()).active).toMatchObject({ id, eventKind: "turn.progress" });
    h.early(second);
    h.early(append); h.early(append);
    expect((await h.runtime.getState()).queue.count).toBe(1);
    await vi.waitFor(() => expect(h.texts().at(-1)).toBe(secondBody)); await h.waiting();
    h.progress(); h.progress();
    await vi.waitFor(async () => expect((await h.runtime.getState()).active?.id).toBe(second.replyId));
    await h.waiting();
    h.progress(secondBody, second.replyId, second.itemId); await h.idle();
    expect(h.texts()).toEqual(speechContent === "both"
      ? [progressPreamble, firstBody, secondBody, "Three.", progressPreamble, secondBody]
      : [firstBody, secondBody, "Three.", secondBody]);
    expect(h.audio.startCapture).not.toHaveBeenCalled();
    const final = { ...opening, replyId: "c".repeat(64), itemId: "answer", text: firstBody, rawEnd: firstBody.length };
    h.early(final); await h.waiting();
    expect((await h.runtime.getState()).active?.eventKind).toBe("turn.completed");
    h.complete(`${firstBody} Answer.`, final.replyId);
    await vi.waitFor(() => expect(h.audio.startCapture).toHaveBeenCalledOnce());
    expect(h.texts().slice(speechContent === "both" ? -3 : -2)).toEqual(speechContent === "both"
      ? [finalPreamble, firstBody, "Answer."] : [firstBody, "Answer."]);
  });

  it.each([opening, commentary])("finishes a limited-size preamble once when $event seals during its first request", async frame => {
    const h = await setup("balanced", { speechContent: "both", speechTextLimit: 9 });
    const drained = deferred<void>(); h.playback.finish.mockImplementationOnce(() => drained.promise);
    h.early({ ...frame, text: "One. ", rawEnd: 5 });
    await vi.waitFor(() => expect(h.speech.speak).toHaveBeenCalledTimes(2));
    expect(h.texts()[0]).toBe("Agent ");
    const prefetched = h.speech.speak.mock.calls[1]![0].requestId;
    if (frame.event === "turn.progress") h.progress("One. Two.");
    else h.complete("One. Two.");
    expect(h.speech.cancel).toHaveBeenCalledWith({ requestId: prefetched });
    expect(h.playback.append).toHaveBeenCalledOnce();
    drained.resolve(); await h.idle();
    // The second request was prefetched but never played. Every other request reached the speaker.
    expect(h.playback.append).toHaveBeenCalledTimes(h.texts().length - 1);
    const spoken = [h.texts()[0], ...h.texts().slice(2)].join(" ").replace(/\s+/gu, " ").trim();
    expect(spoken).toBe(frame.event === "turn.progress" ? "Agent progress Thread A One. Two." : "Agent finished Thread A One. Two.");
  });

  it("speaks only the corrected body when the original preamble already drained", async () => {
    const h = await setup("balanced", { speechContent: "both" });
    h.early(opening); await h.waiting();
    h.complete("Revised answer."); await h.idle();
    expect(h.texts()).toEqual([finalPreamble, firstBody, "Revised answer."]);
  });

  it("remains silent after an intervening item when the complete body was already heard", async () => {
    const h = await setup("balanced", { speechContent: "both" });
    h.early(commentary); await h.waiting();
    h.early({ ...common, seq: 1, kind: "yield", reason: "item_done" });
    h.complete("Other reply.", "other"); await h.idle();
    h.progress(firstBody); await h.idle();
    expect(h.texts()).toEqual([progressPreamble, firstBody, finalPreamble + "\n\nOther reply."]);
  });

  it("applies progress delivery independently of completion voice and completion result phases", async () => {
    const h = await setup();
    const configuration = policy();
    configuration.settings.assistantResultPhases = [];
    configuration.settings.delivery["turn.completed"].voice = "none";
    h.current().callbacks.frame("notification_policy", configuration, h.current().voiceStreamId!);
    h.early(opening); await h.idle(); expect(h.texts()).toEqual([]);
    h.early(commentary); await h.waiting(); expect(h.texts()).toEqual([firstBody]);
    h.progress(firstBody); await h.idle();
    const disabled = policy(); disabled.settings.delivery["turn.progress"].voice = "none";
    h.current().callbacks.frame("notification_policy", disabled, h.current().voiceStreamId!);
    h.early({ ...commentary, replyId: "b".repeat(64) }); await h.idle(); expect(h.texts()).toEqual([firstBody]);
  });

  it.each(["input", "announcements"] as const)("keeps early commentary out of %s", async destination => {
    const h = await setup("responsive", destination === "input" ? { audioMode: "input", autoListen: true } : { speechContent: "announcements" });
    h.early(commentary); await h.idle(); expect(h.texts()).toEqual([]);
    h.progress(); await h.idle();
    expect(h.texts()).toEqual(destination === "input" ? [] : ["Agent progress\n\nThread A"]);
    expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it.each(["turn.progress", "turn.partial"] as const)("skips only the dismissed commentary when its notice is %s", async event => {
    const h = await setup();
    const configuration = policy(); configuration.settings.delivery["turn.partial"].voice = "speak";
    h.current().callbacks.frame("notification_policy", configuration, h.current().voiceStreamId!);
    h.early(commentary); await h.waiting();
    await h.runtime.skipCurrentPlayback({ ...await h.command(), interactionId: id });
    h.early(append);
    h.progress(`${firstBody} Updated.`, id, common.itemId, event === "turn.partial" ? "partial" : "provisional");
    h.complete("Final answer.", "separate-final");
    await h.idle();
    expect(h.texts()).toEqual(event === "turn.partial" ? [firstBody, `${firstBody} Updated.`, "Final answer."] : [firstBody, "Final answer."]);
  });

  it("plays a reclassified partial even when suppressed progress is finishing its submitted audio", async () => {
    const h = await setup(), drain = deferred<void>();
    const configuration = policy(); configuration.settings.delivery["turn.partial"].voice = "speak";
    h.current().callbacks.frame("notification_policy", configuration, h.current().voiceStreamId!);
    h.playback.finish.mockImplementationOnce(() => drain.promise);
    h.early(commentary);
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledOnce());
    h.early({ ...common, seq: 1, kind: "cancel", reason: "superseded" });
    h.early({ ...common, seq: 2, kind: "cancel", reason: "publication_suppressed" });
    expect((await h.runtime.getState()).active?.eventKind).toBe("turn.progress");
    h.progress("This is the partial answer.", id, common.itemId, "partial");
    h.progress("This is the partial answer.", id, common.itemId, "partial");
    drain.resolve(); await h.idle();
    expect(h.texts()).toEqual([firstBody, "This is the partial answer."]);
    expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it.each(["turn.progress", "turn.completed"] as const)("honors queue byte limits and priority when sealing %s", async event => {
    const h = await setup("responsive", { cleanSpeechText: false }); await h.begin();
    for (let index = 0; index < 4; index++) h.complete("x".repeat(61_000), "pending-" + index);
    h.progress("p".repeat(10_000), "prior-progress");
    h.early({ ...opening, event }); expect((await h.runtime.getState()).queue.count).toBe(6);
    if (event === "turn.progress") h.progress("s".repeat(16_000));
    else h.complete("s".repeat(16_000));
    expect((await h.runtime.getState()).queue).toMatchObject({
      count: 5, bytes: event === "turn.progress" ? 254_000 : 260_000,
      droppedReasons: event === "turn.progress" ? { overflow: 1 } : { progress_evicted: 1 },
    });
  });

  it("preserves a deferred turn switch through stale progress until the actual final reply drains", async () => {
    const h = await setup(); await h.foreground();
    const opened = vi.fn(); await h.runtime.addListener("openThread", opened);
    const command: ClientCommand = { id: crypto.randomUUID(), action: "switch_thread", sourceThreadId: THREAD, sourceTurnId: common.turnId,
      threadId: OTHER, listen: false, expiresAt: Date.now() + 60_000 };
    await h.current().callbacks.command(command);
    await h.current().callbacks.command({ ...command, action: "turn_settled", replyEventId: "final-reply", replyStreamIds: [h.current().voiceStreamId!] });
    h.early(commentary); await h.waiting();
    h.request(async () => Response.json({ ...context(), userInputRevision: 2 }));
    h.progress(); await h.idle();
    expect(h.texts()).toEqual([firstBody]); expect(opened).not.toHaveBeenCalled();
    h.complete("Final answer.", "final-reply", 2); await h.idle();
    expect(h.texts()).toEqual([firstBody, "Final answer."]); expect(opened).toHaveBeenCalledOnce();
  });

  it("stages one physical request until the prior speaker drains, then drops staged audio on Skip", async () => {
    const h = await setup(), drain = deferred<void>();
    h.playback.finish.mockImplementationOnce(() => drain.promise);
    h.early(opening);
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledTimes(1));
    h.early(append);
    await vi.waitFor(() => expect(h.texts()).toEqual([firstBody, secondBody]));
    expect(h.audio.createPlayback).toHaveBeenCalledTimes(1);
    expect(h.playback.append).toHaveBeenCalledTimes(1);
    await h.runtime.skipCurrentPlayback({ ...await h.command(), interactionId: id });
    drain.resolve();
    h.complete(); await h.idle(); expect(h.playback.append).toHaveBeenCalledTimes(1);
    expect(h.audio.startCapture).not.toHaveBeenCalled();
  });

  it("renders the authoritative suffix after a gap and reads a corrected prefix in full", async () => {
    const h = await setup(); h.early(opening); await h.waiting();
    h.early({ ...append, seq: 3 }); await h.idle();
    h.early(append); h.complete("Different. Tail."); await h.idle();
    expect(h.texts()).toEqual([firstBody, "Different. Tail."]);
  });

  it("retains the drained frontier across selector Off and same-binding reconnect", async () => {
    const h = await setup();
    h.early(opening); await h.waiting();
    await h.runtime.setEarlyReplyPlayback({ ...await h.command(), expectedEarlyReplyRevision: 1, earlyReplyPlayback: "off" });
    await h.runtime.setConnection({ ...BINDING, reconnect: true });
    h.emitPolicy(); h.complete(); await h.idle();
    expect(h.texts()).toEqual([firstBody, `${secondBody} Three.`]);
    expect((await h.runtime.getState()).speech.earlyReplyRevision).toBe(2);
  });

  it("reintroduces yielded speech in Both when another item reached the speaker first", async () => {
    const h = await setup("balanced", { speechContent: "both" }); h.early(opening); await h.waiting();
    h.early({ ...common, seq: 1, kind: "yield", reason: "item_done" });
    h.complete("B reply.", "other");
    await vi.waitFor(() => expect(h.texts().at(-1)).toContain("B reply."));
    h.complete();
    await h.idle();
    expect(h.texts()).toEqual([finalPreamble, firstBody, finalPreamble + "\n\nB reply.", finalPreamble, `${secondBody} Three.`]);
  });

  it("waits for a closed Natural paragraph and starts its microphone only after the sealed tail drains", async () => {
    const h = await setup("natural", { autoListen: true });
    h.early(opening); await h.waiting(); expect(h.texts()).toEqual([]);
    h.early(append); h.early({ ...append, seq: 2, rawStart: append.rawEnd, rawEnd: append.rawEnd, text: "", paragraphEnd: true });
    await vi.waitFor(() => expect(h.texts()).toEqual([`${firstBody} ${secondBody}`])); await h.waiting();
    expect(h.audio.startCapture).not.toHaveBeenCalled();
    h.complete(); await vi.waitFor(() => expect(h.audio.startCapture).toHaveBeenCalledTimes(1));
    expect(h.texts()).toEqual([`${firstBody} ${secondBody}`, "Three."]);
  });

  it("gives urgent blocking input two seconds of starvation, while ordinary replies wait", async () => {
    vi.useFakeTimers();
    const h = await setup("balanced", { speechContent: "both" }); h.early(opening); await h.waiting();
    h.complete("Other reply.", "ordinary"); await vi.advanceTimersByTimeAsync(4_000);
    expect((await h.runtime.getState()).active?.id).toBe(id);
    h.current().callbacks.frame("notification", { sourceEventId: "blocked", generation: 1, voice: "speak",
      payload: { schemaVersion: 5, notificationId: "blocked", event: "input.requested", title: "Input needed", message: "",
        thread: { id: THREAD, title: "Thread" }, occurredAt: new Date().toISOString() } }, h.current().voiceStreamId!);
    await vi.advanceTimersByTimeAsync(1999); expect((await h.runtime.getState()).active?.id).toBe(id);
    await vi.advanceTimersByTimeAsync(1); await h.idle();
    expect(h.texts().at(-1)).toBe("Input needed");
    h.early(append); h.complete(); await h.idle(); expect(h.texts().at(-1)).toBe(`${secondBody} Three.`);
  });

  it("expires a starved first paragraph and suppresses unheard queued openings explicitly cleared by Stop", async () => {
    vi.useFakeTimers();
    const h = await setup("natural");
    h.early(opening); await h.waiting();
    await vi.advanceTimersByTimeAsync(60_001); await h.idle();
    expect(h.texts()).toEqual([]);
    h.early({ ...opening, replyId: "c".repeat(64) }); await h.waiting();
    h.early({ ...opening, replyId: "b".repeat(64) });
    expect((await h.runtime.getState()).queue.count).toBe(1);
    await h.runtime.stopPlayback({ ...await h.command(), interactionId: "c".repeat(64) });
    h.complete("Stopped.", "b".repeat(64)); h.complete("Stopped.", "c".repeat(64));
    h.complete(); await h.idle(); expect(h.texts()).toEqual([completeBody]);
  });

  it("lets an independently configured failure speak after the user skipped the early reply", async () => {
    const h = await setup("balanced", { speechContent: "both" }); h.early(opening); await h.waiting();
    await h.runtime.skipCurrentPlayback({ ...await h.command(), interactionId: id });
    const failure = { sourceEventId: id, generation: 1, voice: "speak", userInputRevision: 1,
      payload: { schemaVersion: 5, notificationId: id, event: "turn.failed", title: "Agent turn failed", message: "Thread A",
        thread: { id: THREAD, title: "Thread A" }, turn: { id: "turn-1", outcome: "failed" }, occurredAt: new Date().toISOString() } };
    h.current().callbacks.frame("notification", failure, h.current().voiceStreamId!);
    h.current().callbacks.frame("notification", failure, h.current().voiceStreamId!);
    await h.idle(); expect(h.texts()).toEqual([finalPreamble, firstBody, "Agent turn failed\n\nThread A"]);
  });

  it("retries the authoritative completion once when an early request fails while its seal is in flight", async () => {
    const h = await setup();
    const failure = deferred<void>(); h.speech.speak.mockImplementationOnce(() => failure.promise);
    h.early(opening); await vi.waitFor(() => expect(h.speech.speak).toHaveBeenCalledOnce());
    h.complete(); failure.reject(new Error("Transient synthesis error.")); await h.idle();
    expect(h.texts()).toEqual([firstBody, completeBody]);
  });
  it("retires a promoted request that has yet to reach audio when superseded", async () => {
    const h = await setup();
    const drain = deferred<void>(), openingSink = deferred<typeof h.playback>();
    h.playback.finish.mockImplementationOnce(() => drain.promise);
    h.audio.createPlayback.mockResolvedValueOnce(h.playback).mockImplementationOnce(() => openingSink.promise);
    h.early(opening); await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledOnce());
    h.early(append);
    await vi.waitFor(() => expect(h.speech.speak).toHaveBeenCalledTimes(2));
    drain.resolve(); await vi.waitFor(() => expect(h.audio.createPlayback).toHaveBeenCalledTimes(2));
    h.early({ ...common, seq: 2, kind: "cancel", reason: "superseded" });
    openingSink.resolve(h.playback); await h.idle();
    expect(h.playback.append).toHaveBeenCalledOnce();
  });

  it("preserves Record as its own interaction while dropping the later seal of the replaced reply", async () => {
    const h = await setup("balanced", { autoListen: true });
    h.early(opening); await h.waiting();
    await h.runtime.recordDuringPlayback({ ...await h.command(), interactionId: id });
    await vi.waitFor(async () => expect((await h.runtime.getState()).phase).toBe("listening"));
    h.early(append); h.complete();
    expect((await h.runtime.getState()).queue.count).toBe(0);
    expect(h.speech.startRecognition).toHaveBeenCalledOnce(); expect(h.texts()).toEqual([firstBody]);
  });

  it("reclaims a definitive cancellation received while Off, preserving other unresolved receipts at capacity", async () => {
    const h = await setup();
    const key = (n: number) => n.toString(16).padStart(64, "0");
    for (let i = 0; i < 4096; i++) {
      h.early({ ...opening, replyId: key(i) });
      h.early({ ...common, replyId: key(i), seq: 1, kind: "cancel", reason: "authority_lost" });
    }
    h.early({ ...opening, replyId: key(4096) });
    expect((await h.runtime.getState()).queue.count).toBe(0);
    await h.runtime.setEarlyReplyPlayback({ ...await h.command(), expectedEarlyReplyRevision: 1, earlyReplyPlayback: "off" });
    h.early({ ...common, replyId: key(1), seq: 2, kind: "cancel", reason: "publication_suppressed" });
    await h.runtime.setEarlyReplyPlayback({ ...await h.command(), expectedEarlyReplyRevision: 2, earlyReplyPlayback: "responsive" });
    h.early({ ...opening, replyId: key(4096) }); await h.waiting();
    expect((await h.runtime.getState()).active?.id).toBe(key(4096));
  });

  it.each(["yield", "reconnect"] as const)("keeps cleanup and Both attribution frozen across %s", async release => {
    const h = await setup("balanced", { speechContent: "both", cleanSpeechText: true });
    h.early(opening); await h.waiting();
    if (release === "yield") {
      h.early({ ...common, seq: 1, kind: "yield", reason: "markup" }); await h.idle();
    } else {
      await h.runtime.setConnection({ ...BINDING, reconnect: true }); h.emitPolicy();
    }
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision,
      patch: { speechContent: "messages", cleanSpeechText: false } });
    h.complete(`${firstBody} Read [the guide](https://example.test/private).`);
    await h.idle();
    expect(h.texts()).toEqual([finalPreamble, firstBody, "Read the guide."]);
  });

  it("honors announcements-only at seal without repeating an opening preamble that already played", async () => {
    const h = await setup("balanced", { speechContent: "both" });
    h.early(commentary); await h.waiting();
    h.early({ ...common, seq: 1, kind: "yield", reason: "markup" }); await h.idle();
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision,
      patch: { speechContent: "announcements" } });
    h.complete("Other reply.", "other"); await h.idle();
    h.progress(`${firstBody} Unread suffix.`); await h.idle();
    expect(h.texts()).toEqual([progressPreamble, firstBody, finalPreamble]);
  });

  it.each([false, true])("reconciles an announcement interrupted during its split preamble (intervening speaker %s)", async intervening => {
    const h = await setup("balanced", { speechContent: "both", speechTextLimit: 23 });
    const pendingDrain = deferred<void>();
    h.playback.finish.mockResolvedValueOnce(undefined).mockImplementationOnce(() => pendingDrain.promise);
    h.early({ ...commentary, threadTitle: "First draft thread title" });
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledTimes(2));
    expect(h.texts()[0]).toBe("Agent progress\n\nFirst ");
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision,
      patch: { speechContent: "announcements" } });
    pendingDrain.resolve(); await h.idle();
    if (intervening) { h.complete("Other reply.", "other"); await h.idle(); }
    const beforeSeal = h.texts().length;
    h.progress(`${firstBody} Unread suffix.`); await h.idle();
    expect(h.texts().slice(beforeSeal).join("")).toBe(intervening ? progressPreamble : "draft thread title");
  });

  it("honors Input mode at terminal even after an early slice drained in Speak", async () => {
    const h = await setup(); h.early(opening); await h.waiting();
    await h.runtime.updateSettings({ ...await h.command(), expectedRevision: (await h.runtime.getState()).settingsRevision,
      patch: { audioMode: "input", autoListen: true } });
    h.complete(); await vi.waitFor(() => expect(h.audio.startCapture).toHaveBeenCalledOnce());
    expect(h.texts()).toEqual([firstBody]);
  });

  it("retains the terminal barrier when expanded pending speech evicts an unsealed opening", async () => {
    const h = await setup(); await h.foreground(); await h.begin();
    const opened = vi.fn(); await h.runtime.addListener("openThread", opened);
    // Five short cleaned links expand to within four bytes of the pending queue limit.
    const source = "[x](" + "b".repeat(52_423) + ")";
    for (let i = 0; i < 5; i++) h.complete(source, "other-" + i);
    h.early(opening);
    expect((await h.runtime.getState()).queue.count).toBe(6);
    const command: ClientCommand = { id: crypto.randomUUID(), action: "switch_thread", sourceThreadId: THREAD, sourceTurnId: "turn-1",
      threadId: OTHER, listen: false, expiresAt: Date.now() + 60_000 };
    await h.current().callbacks.command(command);
    await h.current().callbacks.command({ ...command, action: "turn_settled", replyEventId: id, replyStreamIds: [h.current().voiceStreamId!] });
    const cleanup = async (cleanSpeechText: boolean) => h.runtime.updateSettings({ ...await h.command(),
      expectedRevision: (await h.runtime.getState()).settingsRevision, patch: { cleanSpeechText } });
    await cleanup(false); expect((await h.runtime.getState()).queue.count).toBe(5);
    await cleanup(true);
    await h.runtime.stopCurrentInteraction({ ...await h.command(), interactionId: (await h.runtime.getState()).active!.id });
    await h.idle(); expect(opened).not.toHaveBeenCalled();
    h.early(append); expect((await h.runtime.getState()).queue.count).toBe(0);
    h.complete(); await h.idle(); await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect(h.texts().at(-1)).toBe(completeBody);
  });

  it.each(["finish", "revoke"] as const)("handles continued delivery after a local formatter yield while the speaker drains (%s)", async action => {
    const h = await setup("responsive"), drain = deferred<void>();
    h.playback.finish.mockImplementationOnce(() => drain.promise);
    // A later definition reinterprets the already prepared, literal [guide].
    // The device must stop submitting new speech even if the server still streams.
    const first = "Read this short note about [guide]. ";
    h.early({ ...opening, text: first, rawEnd: first.length });
    await vi.waitFor(() => expect(h.playback.finish).toHaveBeenCalledOnce());
    const suspect = "\n\n[guide]: https://example.test/private\n\nNext.";
    const end = first.length + suspect.length;
    h.early({ ...append, text: suspect, rawStart: first.length, rawEnd: end });
    h.early({ ...append, seq: 2, text: " More.", rawStart: end, rawEnd: end + 6 });
    h.early({ ...common, seq: 3, kind: "yield", reason: "item_done" });
    expect((await h.runtime.getState()).active?.id).toBe(id);
    expect(h.playback.cancel).not.toHaveBeenCalled();
    expect(h.texts()).toEqual([first.trim()]);
    if (action === "revoke") {
      h.early({ ...common, seq: 4, kind: "cancel", reason: "authority_lost" });
      expect((await h.runtime.getState()).active).toBeNull();
    }
    drain.resolve(); await h.idle();
    h.complete(first + "Authoritative tail."); await h.idle();
    expect(h.texts()).toEqual([first.trim(), action === "finish" ? "Authoritative tail." : first + "Authoritative tail."]);
  });

});
