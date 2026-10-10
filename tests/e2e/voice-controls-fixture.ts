import type { Page } from "@playwright/test";
import type { NativeVoiceInputSubmitted, NativeVoiceState } from "../../src/client/voice/native-voice-plugin.js";

const profileId = "c61b5d8b-4a77-43c6-bd72-12e23fe42e38";
export function voiceFixtureState(): NativeVoiceState {
  return {
    version: 13, stateRevision: 1, connectionGeneration: 1, profileId, serverOrigin: null, identity: null,
    originClientId: "34612c41-0bbb-455f-a5af-725bfc7ae768", clientConnectionToken: null, settingsRevision: 0,
    settings: { audioMode: "response", autoListen: true, keepListeningByDefault: false, announceRecordingThread: false, ignoreOtherDevices: true, readNotificationContext: true, cleanSpeechText: true,
      speechProvider: "openai", speechEndpoint: "https://api.openai.com/v1", sttModel: "gpt-live-transcribe", ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "coral", ttsSpeed: 1, speechTextLimit: 4096, voiceThreadId: null, voiceThreadTitle: null, pinDefaultVoiceThread: false,
      onlyVoiceThread: false, followComposerMode: false, inputDevice: null, recognitionStartTimeoutMs: 30000, recognitionCompletionTimeoutMs: 60000,
      recognitionResultTimeoutMs: 60000, longDictationTimeoutMs: 3_600_000, recognitionEndSilenceMs: 1200, recognizeStopCommand: true,
      recognitionCues: true, cueGain: 100, startupPreRollMs: 512, ttsGain: 100, headsetControls: true },
    speech: { credentialConfigured: true, catalogStatus: "idle", catalog: null, error: null }, phase: "idle", ready: true, readiness: "ready",
    foreground: { visible: false, threadId: null, threadTitle: null }, nextRecordingTarget: null, retainedVoiceTarget: null, idleTargetRevision: 0, active: null,
    queue: { count: 0, bytes: 0, droppedCount: 0, droppedReasons: {} },
    actions: { canStart: true, canStop: false, canSkip: false, canRecordDuringPlayback: false, canReleaseRetainedTarget: false, canRetarget: false, canResume: false,
      canSetKeepListening: false, canSend: false, keepListeningBlockedReason: "not_capturing" }, recordingRecovery: null, recovery: [], errors: [],
  };
}

type VoiceFixture = {
  state: NativeVoiceState;
  calls: { method: string; args: Record<string, unknown> }[];
  recoveredText: string;
  publish(patch: Partial<NativeVoiceState>): void;
  emitInputSubmitted(event: NativeVoiceInputSubmitted): void;
};
declare global { interface Window { __voiceFixture: VoiceFixture } }

/** Exercise the real packaged-client shell and bridge consumer. Native capture/storage behavior has separate Android tests. */
export async function installVoiceFixture(page: Page): Promise<void> {
  // The isolated E2E server omits pairing. Supply its admitted-client namespace,
  // as production authentication does, so the Android voice binding can hydrate.
  await page.route("**/api/auth/status", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), navigationNamespace: "e".repeat(64) } });
  });
  await page.addInitScript(({ initial, profileId }) => {
    const retainedKey = "sedes-e2e-native-voice";
    const listeners = new Map<string, { plugin: string; event: string; callback: (value: unknown) => void }>();
    let listenerId = 0;
    const emit = (event: string, value: unknown) => {
      for (const listener of listeners.values()) if (listener.plugin === "NativeVoice" && listener.event === event) listener.callback(structuredClone(value));
    };
    const retained = sessionStorage.getItem(retainedKey);
    const fixture: VoiceFixture = window.__voiceFixture = {
      state: retained ? JSON.parse(retained) as NativeVoiceState : initial,
      calls: [],
      recoveredText: "Recovered dictation text.",
      publish(patch) {
        fixture.state = { ...fixture.state, ...patch, stateRevision: fixture.state.stateRevision + 1 };
        const state = fixture.state;
        if (state.phase === "idle" && !state.active && !state.nextRecordingTarget && !state.settings.pinDefaultVoiceThread &&
            state.foreground.visible && state.foreground.threadId) {
          const { threadId, threadTitle } = state.foreground;
          if (state.retainedVoiceTarget?.threadId !== threadId || state.retainedVoiceTarget.threadTitle !== threadTitle) {
            state.idleTargetRevision += 1;
            state.retainedVoiceTarget = { threadId, threadTitle, revision: state.idleTargetRevision };
          }
          state.actions = { ...state.actions, canReleaseRetainedTarget: true };
        }
        sessionStorage.setItem(retainedKey, JSON.stringify(fixture.state));
        emit("stateChanged", fixture.state);
      },
      emitInputSubmitted(event) { emit("inputSubmitted", event); },
    };
    const snapshot = () => structuredClone(fixture.state);
    // Queued replay identities; the fake keeps only the queue count in state, and an emptied queue drops them.
    const queuedReplays = new Set<string>();
    const header = (name: string, methods: readonly string[], events = false) => ({ name,
      methods: [...methods.map(name => ({ name, rtype: "promise" })), ...(events ? [{ name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "promise" }] : [])] });
    Object.assign(window, {
      CapacitorCustomPlatform: { name: "android" },
      Capacitor: {
        PluginHeaders: [
          header("Preferences", ["get", "set", "remove"]), header("ClientCredentials", ["getCredential", "setCredential", "removeCredential", "removeProfileCredentials"]),
          header("App", ["exitApp"], true),
          header("NativeVoice", ["setConnection", "getState", "disconnect", "setForegroundContext", "updateSettings", "startManualListen", "setNextRecordingTarget", "releaseRetainedVoiceTarget",
            "retargetActiveRecognition", "setKeepListening", "sendRecording", "stopCurrentInteraction", "stopPlayback", "skipCurrentPlayback", "recordDuringPlayback", "retryRecordingRecognition",
            "sendRecoveredRecording", "copyRecognizedRecordingText", "readRecognizedRecordingText", "discardRecording", "resumeInput", "discardInput", "listInputDevices",
            "refreshSpeechCatalog", "openSpeechCredentialDialog", "speakReply"], true),
        ],
        nativeCallback(plugin: string, method: string, args: { eventName: string }, callback: (value: unknown) => void) {
          if (method !== "addListener") throw new Error(`Unexpected callback: ${plugin}.${method}`);
          const id = String(++listenerId);
          listeners.set(id, { plugin, event: args.eventName, callback });
          return id;
        },
        async nativePromise(plugin: string, method: string, args: Record<string, unknown> = {}) {
          if (method === "removeListener") { listeners.delete(String(args.callbackId)); return; }
          if (plugin === "Preferences") {
            if (method === "get") return { value: args.key === "sedes.connections.v1" ? JSON.stringify({ version: 1,
              profiles: [{ id: profileId, name: "Voice test", baseUrl: location.origin }], selectedProfileId: profileId }) : null };
            return;
          }
          if (plugin === "ClientCredentials") return method === "getCredential" ? { credential: null } : undefined;
          if (plugin !== "NativeVoice") return;
          if (!["getState", "setForegroundContext", "refreshSpeechCatalog"].includes(method)) fixture.calls.push({ method, args });
          const current = fixture.state;
          if (method === "setConnection") {
            fixture.publish({ profileId: String(args.profileId), serverOrigin: String(args.serverOrigin), identity: String(args.identity) });
          } else if (method === "setForegroundContext") {
            fixture.publish({ foreground: { visible: args.visible === true, threadId: typeof args.threadId === "string" ? args.threadId : null,
              threadTitle: typeof args.threadTitle === "string" ? args.threadTitle : null } });
          } else if (method === "updateSettings") {
            fixture.publish({ settingsRevision: current.settingsRevision + 1, settings: { ...current.settings, ...args.patch as object } });
          } else if (method === "setNextRecordingTarget") {
            if (current.active || current.settings.audioMode === "off" || args.expectedConnectionGeneration !== current.connectionGeneration)
              throw new Error("Voice interaction changed.");
            fixture.publish({ nextRecordingTarget: { threadId: String(args.threadId), threadTitle: typeof args.threadTitle === "string" ? args.threadTitle : null } });
          } else if (method === "releaseRetainedVoiceTarget") {
            if (args.expectedConnectionGeneration !== current.connectionGeneration) throw new Error("Voice connection changed.");
            if (current.actions.canReleaseRetainedTarget && !current.active && args.expectedRetainedRevision === current.retainedVoiceTarget?.revision)
              fixture.publish({ retainedVoiceTarget: null, idleTargetRevision: current.idleTargetRevision + 1,
                actions: { ...current.actions, canReleaseRetainedTarget: false } });
          } else if (method === "setKeepListening" || method === "sendRecording" || method === "retargetActiveRecognition") {
            if (!current.active?.recording || args.recordingId !== current.active.recording.id || args.expectedConnectionGeneration !== current.connectionGeneration)
              throw new Error("The recording changed.");
            if (method === "setKeepListening") fixture.publish({ active: { ...current.active, automatic: false,
              recording: { ...current.active.recording, keepListening: args.enabled === true } } });
            if (method === "sendRecording") fixture.publish({ phase: "recognizing", actions: { ...current.actions,
              canSetKeepListening: false, canSend: false, canRetarget: false, keepListeningBlockedReason: "not_capturing" } });
            if (method === "retargetActiveRecognition") fixture.publish({ active: { ...current.active,
              recognitionThreadId: String(args.threadId), recognitionThreadTitle: typeof args.threadTitle === "string" ? args.threadTitle : null } });
          } else if (method === "speakReply") {
            if (current.settings.audioMode === "off" || !current.ready || args.expectedConnectionGeneration !== current.connectionGeneration)
              throw new Error("Voice is not ready.");
            // As in native, a replay of a thread and turn already playing or queued is a successful no-op.
            const identity = JSON.stringify([args.threadId, args.turnId]);
            if (current.queue.count === 0) queuedReplays.clear();
            const playing = current.active?.eventKind === "replay" && current.active.threadId === args.threadId && current.active.id === `replay:${String(args.turnId)}`;
            if (playing || queuedReplays.has(identity)) return snapshot();
            // A replay queues behind current work; idle voice starts it at once.
            if (current.active) {
              queuedReplays.add(identity);
              fixture.publish({ queue: { ...current.queue, count: current.queue.count + 1 } });
            } else fixture.publish({ phase: "speaking", active: { id: `replay:${String(args.turnId)}`, eventKind: "replay", threadId: String(args.threadId),
              threadTitle: typeof args.threadTitle === "string" ? args.threadTitle : null, recognitionThreadId: null, recognitionThreadTitle: null,
              automatic: false, recording: null },
              actions: { ...current.actions, canStart: false, canStop: true, canSkip: true, canRecordDuringPlayback: true } });
          } else if (method === "recordDuringPlayback") {
            if (!current.actions.canRecordDuringPlayback || !current.active || args.interactionId !== current.active.id || args.expectedConnectionGeneration !== current.connectionGeneration)
              throw new Error("The interaction changed.");
            fixture.publish({ phase: "listening", nextRecordingTarget: null, active: { ...current.active, id: `reply:${current.active.id}`, automatic: false,
              recognitionThreadId: current.active.threadId, recognitionThreadTitle: current.active.threadTitle,
              recording: { id: `recording:${current.active.id}`, keepListening: current.settings.keepListeningByDefault, reconnecting: false } },
              actions: { ...initial.actions, canStart: false, canStop: true, canRetarget: true, canSetKeepListening: true,
                canSend: true, keepListeningBlockedReason: null } });
          } else if (method === "stopPlayback") {
            if (args.interactionId !== current.active?.id || args.expectedConnectionGeneration !== current.connectionGeneration ||
                !["synthesizing", "speaking"].includes(current.phase)) throw new Error("The playback changed.");
            queuedReplays.clear();
            fixture.publish({ phase: "idle", active: null,
              actions: { ...initial.actions, canReleaseRetainedTarget: current.retainedVoiceTarget !== null && !current.settings.pinDefaultVoiceThread },
              queue: { ...current.queue, count: 0, bytes: 0 } });
          } else if (method === "stopCurrentInteraction" || method === "skipCurrentPlayback") {
            if (args.interactionId !== current.active?.id || args.expectedConnectionGeneration !== current.connectionGeneration) throw new Error("The interaction changed.");
            fixture.publish({ phase: "idle", active: null,
              actions: { ...initial.actions, canReleaseRetainedTarget: current.retainedVoiceTarget !== null && !current.settings.pinDefaultVoiceThread } });
          } else if (["retryRecordingRecognition", "sendRecoveredRecording", "discardRecording", "copyRecognizedRecordingText", "readRecognizedRecordingText"].includes(method)) {
            const saved = current.recordingRecovery;
            if (!saved || args.recordingId !== saved.recordingId || args.expectedRecoveryRevision !== saved.revision || args.expectedConnectionGeneration !== current.connectionGeneration)
              throw new Error("The saved dictation changed.");
            if (method === "readRecognizedRecordingText") return { recordingId: saved.recordingId, revision: saved.revision,
              threadId: saved.threadId, text: fixture.recoveredText };
            if (method === "retryRecordingRecognition") fixture.publish({ phase: "recognizing", active: {
              id: "saved-recognition", eventKind: "manual", threadId: saved.threadId, threadTitle: saved.threadTitle,
              recognitionThreadId: saved.threadId, recognitionThreadTitle: saved.threadTitle, automatic: false,
              recording: { id: saved.recordingId, keepListening: false, reconnecting: false } },
              actions: { ...initial.actions, canStart: false, canStop: false },
              recordingRecovery: { ...saved, revision: saved.revision + 1, stage: "recognizing", canRetryRecognition: false,
                canSend: false, canCopyRecognizedText: false, canDiscard: true } });
            if (method === "sendRecoveredRecording") {
              fixture.publish({ phase: "submitting", active: {
                id: "saved-send", eventKind: "manual", threadId: saved.threadId, threadTitle: saved.threadTitle,
                recognitionThreadId: saved.threadId, recognitionThreadTitle: saved.threadTitle, automatic: false,
                recording: { id: saved.recordingId, keepListening: false, reconnecting: false } },
                actions: { ...initial.actions, canStart: false, canStop: false },
                recordingRecovery: { ...saved, revision: saved.revision + 1, stage: "admitting", captureIncomplete: false,
                  canSend: false, canRetryRecognition: false, canCopyRecognizedText: false, canDiscard: true } });
            }
            if (method === "discardRecording") fixture.publish({ recordingRecovery: null,
              ...current.active && current.active.recording?.id !== saved.recordingId ? {} : { active: null,
                phase: current.settings.audioMode === "off" ? "off" : "idle", actions: { ...initial.actions, canStart: current.settings.audioMode !== "off" } } });
          } else if (method === "listInputDevices") return { devices: [] };
          return snapshot();
        },
      },
    });
  }, { initial: voiceFixtureState(), profileId });
}

export async function publishVoiceState(page: Page, patch: Partial<NativeVoiceState>): Promise<void> {
  await page.evaluate(patch => window.__voiceFixture.publish(patch), patch);
}
