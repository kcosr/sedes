import type { Page } from "@playwright/test";
import type { NativeVoiceComposerHandoff, NativeVoiceInputSubmitted, NativeVoiceState } from "../../src/client/voice/native-voice-plugin.js";

const profileId = "c61b5d8b-4a77-43c6-bd72-12e23fe42e38";
export function voiceFixtureState(): NativeVoiceState {
  return {
    version: 16, stateRevision: 1, connectionGeneration: 1, profileId, serverOrigin: null, identity: null,
    originClientId: "34612c41-0bbb-455f-a5af-725bfc7ae768", clientConnectionToken: null, settingsRevision: 0,
    settings: { audioMode: "speak", autoListen: true, keepListeningByDefault: false, announceRecordingThread: false, ignoreOtherDevices: true, speechContent: "both", cleanSpeechText: true,
      speechProvider: "openai", speechEndpoint: "https://api.openai.com/v1", sttModel: "gpt-live-transcribe", ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "coral", ttsSpeed: 1, speechTextLimit: 4096, voiceThreadId: null, voiceThreadTitle: null, pinDefaultVoiceThread: false,
      onlyVoiceThread: false, followComposerMode: false, inputDevice: null, recognitionStartTimeoutMs: 30000, recognitionCompletionTimeoutMs: 60000,
      recognitionResultTimeoutMs: 60000, longDictationTimeoutMs: 3_600_000, recognitionEndSilenceMs: 1200, recognizeStopCommand: true,
      recognitionCues: true, cueGain: 100, startupPreRollMs: 512, ttsGain: 100, headsetControls: true },
    speech: { audioQuality: "original", audioQualityRevision: 0, credentialConfigured: true, catalogStatus: "idle", catalog: null, error: null }, phase: "idle", ready: true, readiness: "ready",
    foreground: { visible: false, threadId: null, threadTitle: null, composerAvailable: false }, nextRecordingTarget: null, retainedVoiceTarget: null, idleTargetRevision: 0, active: null,
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
  setForeground(context: NativeVoiceState["foreground"]): void;
  emitInputSubmitted(event: NativeVoiceInputSubmitted): void;
  emitComposerHandoff(event: NativeVoiceComposerHandoff): void;
  emitRecognizedRecording(event: NativeVoiceComposerHandoff): void;
  holdRetarget(): void;
  settleRetarget(error?: string): void;
  holdComposerClaim(): void;
  settleComposerClaim(): void;
  holdForegroundContext(threadId: string): void;
  settleForegroundContext(): void;
};
declare global { interface Window { __voiceFixture: VoiceFixture } }

/** Exercise the real packaged-client shell and bridge consumer. Native capture/storage behavior has separate Android tests. */
export async function installVoiceFixture(page: Page): Promise<void> {
  // The isolated E2E server omits pairing. Supply its admitted-client namespace,
  // as production authentication does, so the Android voice binding can hydrate.
  await page.route("**/api/auth/status", async route => {
    // Each page navigation must hydrate independently of Playwright's pooled
    // proxy socket racing the fixture server's idle keep-alive close.
    const response = await route.fetch({ headers: { ...await route.request().allHeaders(), connection: "close" } });
    await route.fulfill({ response, json: { ...await response.json(), navigationNamespace: "e".repeat(64) } });
  });
  await page.addInitScript(({ initial, profileId }) => {
    const retainedKey = "sedes-e2e-native-voice";
    const viewedKey = "sedes-e2e-native-voice-viewed-thread";
    let lastViewedThread = sessionStorage.getItem(viewedKey);
    const listeners = new Map<string, { plugin: string; event: string; callback: (value: unknown) => void }>();
    let listenerId = 0;
    let diagnosticsEnabled = false;
    let composerHandoff: { event: NativeVoiceComposerHandoff; claimed: boolean } | undefined;
    let frozenComposerRoute: { recordingId: string; threadId: string | null; connectionGeneration: number; eligible: boolean } | undefined;
    let retargetGate: { promise: Promise<void>; resolve(): void; reject(error: Error): void } | undefined;
    let composerClaimGate: { promise: Promise<void>; resolve(): void } | undefined;
    let foregroundContextGate: { threadId: string; promise: Promise<void>; resolve(): void } | undefined;
    const emit = (event: string, value: unknown) => {
      for (const listener of listeners.values()) if (listener.plugin === "NativeVoice" && listener.event === event) listener.callback(structuredClone(value));
    };
    const retained = sessionStorage.getItem(retainedKey);
    const fixture: VoiceFixture = window.__voiceFixture = {
      state: retained ? JSON.parse(retained) as NativeVoiceState : initial,
      calls: [],
      recoveredText: "Recovered dictation text.",
      holdComposerClaim() {
        if (composerClaimGate) throw new Error("A composer claim is already held.");
        let resolve!: () => void;
        const promise = new Promise<void>(accept => { resolve = accept; });
        composerClaimGate = { promise, resolve };
      },
      settleComposerClaim() {
        if (!composerClaimGate) throw new Error("No composer claim is held.");
        const gate = composerClaimGate;
        composerClaimGate = undefined;
        gate.resolve();
      },
      holdForegroundContext(threadId) {
        if (foregroundContextGate) throw new Error("A foreground update is already held.");
        let resolve!: () => void;
        const promise = new Promise<void>(accept => { resolve = accept; });
        foregroundContextGate = { threadId, promise, resolve };
      },
      settleForegroundContext() {
        if (!foregroundContextGate) throw new Error("No foreground update is held.");
        const gate = foregroundContextGate;
        foregroundContextGate = undefined;
        gate.resolve();
      },
      holdRetarget() {
        if (retargetGate) throw new Error("A recording retarget is already held.");
        let resolve!: () => void, reject!: (error: Error) => void;
        const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
        retargetGate = { promise, resolve, reject };
      },
      settleRetarget(error) {
        if (!retargetGate) throw new Error("No recording retarget is held.");
        const gate = retargetGate;
        retargetGate = undefined;
        if (error) gate.reject(new Error(error)); else gate.resolve();
      },
      publish(patch) {
        const previous = fixture.state;
        fixture.state = { ...fixture.state, ...patch, stateRevision: fixture.state.stateRevision + 1 };
        const state = fixture.state;
        // Native activation remembers speech, then accepted input preparation remembers the reply destination.
        if (!Object.hasOwn(patch, "retainedVoiceTarget") && state.active) {
          if (state.active.id !== previous.active?.id) {
            state.idleTargetRevision += 1;
            if (state.retainedVoiceTarget) state.retainedVoiceTarget = { ...state.retainedVoiceTarget, revision: state.idleTargetRevision };
          }
          const recording = ["announcing", "arming", "listening", "recognizing", "submitting", "recovering"].includes(state.phase);
          const threadId = recording ? state.active.recognitionThreadId : ["synthesizing", "speaking"].includes(state.phase) ? state.active.threadId : null;
          const threadTitle = recording ? state.active.recognitionThreadTitle : state.active.threadTitle;
          if (threadId && state.settings.audioMode !== "off" && !state.settings.pinDefaultVoiceThread &&
              (state.retainedVoiceTarget?.threadId !== threadId || state.retainedVoiceTarget.threadTitle !== threadTitle)) {
            state.idleTargetRevision += 1;
            state.retainedVoiceTarget = { threadId, threadTitle, revision: state.idleTargetRevision };
          }
        }
        // Idle release restores the viewed destination for background starts; existing continuity is preserved.
        if (state.phase === "idle" && !state.active && !state.nextRecordingTarget && !state.retainedVoiceTarget &&
            state.foreground.visible && state.foreground.threadId && state.settings.audioMode !== "off" && !state.settings.pinDefaultVoiceThread) {
          state.idleTargetRevision += 1;
          state.retainedVoiceTarget = { threadId: state.foreground.threadId, threadTitle: state.foreground.threadTitle, revision: state.idleTargetRevision };
        }
        state.actions = { ...state.actions, canReleaseRetainedTarget: state.active === null && state.retainedVoiceTarget !== null &&
          state.settings.audioMode !== "off" && !state.settings.pinDefaultVoiceThread };
        sessionStorage.setItem(retainedKey, JSON.stringify(fixture.state));
        emit("stateChanged", fixture.state);
      },
      setForeground({ visible, threadId, threadTitle, composerAvailable }) {
        const current = fixture.state;
        let retainedVoiceTarget = current.retainedVoiceTarget;
        let idleTargetRevision = current.idleTargetRevision;
        const invalidate = () => {
          idleTargetRevision += 1;
          if (retainedVoiceTarget) retainedVoiceTarget = { ...retainedVoiceTarget, revision: idleTargetRevision };
        };
        if (!current.active && (visible !== current.foreground.visible || threadId !== current.foreground.threadId)) invalidate();
        if (visible && threadId) {
          const navigated = threadId !== lastViewedThread;
          lastViewedThread = threadId;
          sessionStorage.setItem(viewedKey, threadId);
          if (!current.active && navigated) { retainedVoiceTarget = null; invalidate(); }
          if ((!current.active && navigated || retainedVoiceTarget?.threadId === threadId && retainedVoiceTarget.threadTitle !== threadTitle) &&
              current.settings.audioMode !== "off" && !current.settings.pinDefaultVoiceThread) {
            invalidate();
            retainedVoiceTarget = { threadId, threadTitle, revision: idleTargetRevision };
          }
        }
        fixture.publish({ foreground: { visible, threadId, threadTitle, composerAvailable }, retainedVoiceTarget, idleTargetRevision });
      },
      emitInputSubmitted(event) { emit("inputSubmitted", event); },
      emitComposerHandoff(event) {
        composerHandoff = { event, claimed: false };
        fixture.publish({ phase: "submitting", active: { id: event.handoffId, eventKind: "manual", threadId: event.threadId,
          threadTitle: fixture.state.foreground.threadTitle, recognitionThreadId: event.threadId,
          recognitionThreadTitle: fixture.state.foreground.threadTitle, automatic: false,
          recording: { id: event.recordingId, keepListening: false, reconnecting: false } },
          recordingRecovery: { recordingId: event.recordingId, revision: 1, threadId: event.threadId,
            threadTitle: fixture.state.foreground.threadTitle, stage: "ready", reason: null, captureIncomplete: false,
            hasUnrecognizedAudio: false, canRetryRecognition: false, canSend: false, canCopyRecognizedText: true,
            canDiscard: true, admission: null }, actions: { ...initial.actions, canStart: false } });
        emit("composerHandoff", event);
      },
      emitRecognizedRecording(event) {
        // The native route is selected at Send, before recognition completes.
        // Do not let a panel regression pass by injecting an impossible handoff.
        if (!frozenComposerRoute?.eligible || frozenComposerRoute.recordingId !== event.recordingId ||
            frozenComposerRoute.threadId !== event.threadId || frozenComposerRoute.connectionGeneration !== event.connectionGeneration)
          throw new Error("The recording did not select a composer handoff at Send.");
        frozenComposerRoute = undefined;
        fixture.emitComposerHandoff(event);
      },
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
          header("NativeVoice", ["setDiagnosticsEnabled", "readDiagnostics", "clearDiagnostics", "setConnection", "getState", "disconnect", "setForegroundContext", "updateSettings", "startManualListen", "setNextRecordingTarget", "releaseRetainedVoiceTarget",
            "retargetActiveRecognition", "setKeepListening", "sendRecording", "stopCurrentInteraction", "stopPlayback", "skipCurrentPlayback", "recordDuringPlayback", "retryRecordingRecognition",
            "sendRecoveredRecording", "copyRecognizedRecordingText", "readRecognizedRecordingText", "discardRecording", "resumeInput", "discardInput", "listInputDevices",
            "refreshSpeechCatalog", "setSpeechAudioQuality", "openSpeechCredentialDialog", "speakReply", "claimComposerHandoff", "completeComposerHandoff", "settleComposerSubmission"], true),
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
          if (method === "setDiagnosticsEnabled") { diagnosticsEnabled = args.enabled === true; return; }
          // Native diagnostic event production is covered by the Android tests.
          if (method === "readDiagnostics") return { enabled: diagnosticsEnabled, maximumEntries: 512, entries: [] };
          if (method === "clearDiagnostics") return;
          if (!["getState", "setForegroundContext", "refreshSpeechCatalog"].includes(method)) fixture.calls.push({ method, args });
          const current = fixture.state;
          if (method === "setConnection") {
            fixture.publish({ profileId: String(args.profileId), serverOrigin: String(args.serverOrigin), identity: String(args.identity) });
          } else if (method === "setForegroundContext") {
            const foregroundGate = foregroundContextGate;
            if (foregroundGate && foregroundGate.threadId === args.threadId) await foregroundGate.promise;
            const visible = args.visible === true;
            const threadId = visible && typeof args.threadId === "string" ? args.threadId : null;
            const threadTitle = visible && typeof args.threadTitle === "string" ? args.threadTitle : null;
            fixture.setForeground({ visible, threadId, threadTitle, composerAvailable: visible && args.composerAvailable === true });
          } else if (method === "claimComposerHandoff" || method === "completeComposerHandoff") {
            if (!composerHandoff || args.expectedConnectionGeneration !== current.connectionGeneration || args.handoffId !== composerHandoff.event.handoffId)
              throw new Error("The voice handoff changed.");
            if (method === "claimComposerHandoff") {
              if (composerClaimGate) await composerClaimGate.promise;
              if (composerHandoff.claimed) throw new Error("The voice handoff was already claimed.");
              composerHandoff.claimed = true;
            } else {
              if (!composerHandoff.claimed) throw new Error("The voice handoff is not claimed.");
              if (typeof args.submissionPending !== "boolean") throw new Error("The composer submission disposition is required.");
              const accepted = args.outcome === "accepted";
              fixture.publish({ active: null, phase: accepted ? "idle" : "recordingRecovery", actions: initial.actions,
                recordingRecovery: accepted ? null : { ...current.recordingRecovery!, canSend: true,
                  reason: typeof args.message === "string" ? args.message : current.recordingRecovery!.reason } });
              composerHandoff = undefined;
            }
          } else if (method === "settleComposerSubmission") {
            if (typeof args.handoffId !== "string" || typeof args.expectedConnectionGeneration !== "number")
              throw new Error("The composer submission identity is required.");
          } else if (method === "updateSettings") {
            const patch = args.patch as Partial<NativeVoiceState["settings"]>;
            const changedProvider = patch.speechProvider !== undefined && patch.speechProvider !== current.settings.speechProvider;
            fixture.publish({ settingsRevision: current.settingsRevision + 1, settings: { ...current.settings, ...patch },
              ...(changedProvider ? { speech: { ...current.speech, catalog: null, catalogStatus: "idle" as const, credentialConfigured: false } } : {}) });
          } else if (method === "setSpeechAudioQuality") {
            if (args.expectedConnectionGeneration !== current.connectionGeneration || args.expectedAudioQualityRevision !== current.speech.audioQualityRevision)
              throw new Error("Upload quality changed.");
            const quality = args.audioQuality;
            if (quality !== "original" && quality !== "opus_high" && quality !== "opus_low") throw new Error("Invalid upload quality.");
            if (quality !== "original" && (current.settings.speechProvider !== "server" ||
                !current.speech.catalog?.audioInputFormats[current.settings.sttModel]?.binaryOpus)) throw new Error("Choose Original upload quality for this server.");
            fixture.publish({ speech: { ...current.speech, audioQuality: quality, audioQualityRevision: current.speech.audioQualityRevision + 1 } });
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
            if (method === "sendRecording") {
              const threadId = current.active.recognitionThreadId;
              frozenComposerRoute = { recordingId: current.active.recording.id, threadId,
                connectionGeneration: current.connectionGeneration, eligible: current.foreground.visible &&
                  current.foreground.composerAvailable && threadId !== null && current.foreground.threadId === threadId };
              fixture.publish({ phase: "recognizing", actions: { ...current.actions,
                canSetKeepListening: false, canSend: false, canRetarget: false, keepListeningBlockedReason: "not_capturing" } });
            }
            if (method === "retargetActiveRecognition") {
              // Native persists the new destination before acknowledging it;
              // tests can hold that write while exercising the live controls.
              if (retargetGate) await retargetGate.promise;
              const latest = fixture.state;
              if (latest.phase !== "listening" || args.recordingId !== latest.active?.recording?.id ||
                  args.expectedConnectionGeneration !== latest.connectionGeneration) throw new Error("The recording changed.");
              fixture.publish({ active: { ...latest.active!, automatic: false,
                recognitionThreadId: String(args.threadId), recognitionThreadTitle: typeof args.threadTitle === "string" ? args.threadTitle : null } });
            }
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
            // Playback Stop releases continuity before idle uses the normal
            // explicit choice, pin, viewed thread, or default policy.
            fixture.publish({ phase: "idle", active: null, retainedVoiceTarget: null,
              idleTargetRevision: current.idleTargetRevision + 1, actions: initial.actions,
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
