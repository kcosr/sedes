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
