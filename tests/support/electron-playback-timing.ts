import { defaultNotificationDelivery } from "../../src/shared/protocol/notification.js";
import { ElectronVoiceAudio } from "../../src/client/voice/electron-voice-audio.js";
import { electronSpeech, type ElectronSpeechAudioChunk } from "../../src/client/voice/electron-speech-plugin.js";
import type { ElectronVoiceConnectionCallbacks } from "../../src/client/voice/electron-voice-connection.js";
import { ElectronVoiceRuntime } from "../../src/client/voice/electron-voice-runtime.js";
import type { NativeVoiceState } from "../../src/client/voice/native-voice-plugin.js";

declare global {
  interface Window {
    runDesktopTiming: typeof runDesktopTiming;
    timingSpeak: typeof electronSpeech.speak;
    timingAck: typeof electronSpeech.acknowledgeAudio;
    timingCatalog: typeof electronSpeech.getCapabilities;
    timingCancel: typeof electronSpeech.cancel;
    timingAudio?: (chunk: ElectronSpeechAudioChunk) => void;
  }
}

// Tap each request on its own input of one continuous Web Audio render graph.
// currentFrame is the common sample clock, even though production creates and
// closes a separate playback AudioContext for each physical request.
const meterSource = `
class RangeMeter extends AudioWorkletProcessor {
  first = null;
  last = null;
  constructor() {
    super();
    this.port.onmessage = () => this.port.postMessage({ first: this.first, last: this.last });
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i]) > 0.001) {
        this.first ??= currentFrame + i;
        this.last = currentFrame + i;
      }
    }
    return true;
  }
}
registerProcessor("range-meter", RangeMeter);
`;

export async function runDesktopTiming(endpoint: string, mode: "responsive" | "off", count: number) {
  const meter = new AudioContext({ sampleRate: 24_000, latencyHint: "interactive" });
  const url = URL.createObjectURL(new Blob([meterSource], { type: "text/javascript" }));
  try { await meter.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  await meter.resume();
  const probes: AudioWorkletNode[] = [], tracks: MediaStreamTrack[] = [];
  const audio = new ElectronVoiceAudio({ createAudioContext(options) {
    const context = new AudioContext(options), createGain = context.createGain.bind(context);
    const tap = context.createMediaStreamDestination();
    const source = meter.createMediaStreamSource(tap.stream);
    const probe = new AudioWorkletNode(meter, "range-meter");
    source.connect(probe).connect(meter.destination);
    probes.push(probe); tracks.push(...tap.stream.getTracks());
    context.createGain = () => {
      const gain = createGain(); gain.connect(tap);
      return gain;
    };
    return context;
  } });
  const clientId = crypto.randomUUID(), threadId = crypto.randomUUID(), replyId = "a".repeat(64);
  let callbacks!: ElectronVoiceConnectionCallbacks;
  let stream = "";
  const requestedAt: number[] = [], receivedAt: number[] = [], texts: string[] = [];
  const noopListener = async () => ({ remove: async () => {} });
  const stateListeners = new Set<(state: NativeVoiceState) => void>();
  const runtime = new ElectronVoiceRuntime({
    storage: { getItem: () => null, setItem: () => {} }, audio,
    connection: (_binding, observer) => {
      callbacks = observer;
      const registration = { clientId, connectionToken: "b".repeat(43), resumeToken: "c".repeat(43) };
      return {
        registration, get voiceStreamId() { return stream || null; },
        async connect() { callbacks.registered(registration); },
        notifications(enabled) { stream = enabled ? crypto.randomUUID() : ""; }, earlyReplyInterest() {}, close() {},
        async request(path) {
          if (!path.endsWith("/input-context")) throw new Error("Unexpected desktop timing request.");
          return Response.json({ threadId, threadTitle: "Timing", authority: "current", userInputRevision: 1,
            activityToken: "live", sourceTurnId: "turn", runState: null, automaticListenEligible: false,
            manualListenEligible: true, steer: { availability: "unavailable" } });
        },
      };
    },
    speech: { ...electronSpeech,
      configure: async binding => ({ ...binding, credentialConfigured: binding.provider === "server" }),
      getCapabilities: binding => window.timingCatalog(binding),
      async speak(input) {
        const index = texts.push(input.text.trim()) - 1;
        requestedAt[index] = meter.currentTime * meter.sampleRate;
        await window.timingSpeak(input);
        // The production transport resolves only after the final IPC packet's ACK.
        receivedAt[index] = meter.currentTime * meter.sampleRate;
      },
      acknowledgeAudio: input => window.timingAck(input), cancel: input => window.timingCancel(input), cancelAll: async () => {},
      addAudioListener: async listener => { window.timingAudio = listener; return { remove: async () => { delete window.timingAudio; } }; },
      addInterruptedListener: noopListener, addRecognitionErrorListener: noopListener, addWindowStateListener: noopListener,
      getWindowState: async () => ({ visible: false }), setAudioActive: async () => {},
    },
  });
  const waitState = (predicate: (state: NativeVoiceState) => boolean) => new Promise<void>((resolve, reject) => {
    const listener = (state: NativeVoiceState) => {
      if (!predicate(state) && !state.errors.length) return;
      stateListeners.delete(listener); clearTimeout(timer);
      if (state.errors.length) reject(new Error(state.errors.map(error => error.message).join(", ")));
      else resolve();
    };
    const timer = setTimeout(() => { stateListeners.delete(listener); reject(new Error("Desktop timing playback stalled.")); }, 70_000);
    stateListeners.add(listener);
  });
  const subscription = await runtime.addListener("stateChanged", (state: NativeVoiceState) => {
    for (const listener of stateListeners) listener(state);
  });
  try {
    const initial = await runtime.setConnection({ profileId: "timing", serverOrigin: location.origin, identity: "0".repeat(64) });
    const command = { expectedConnectionGeneration: initial.connectionGeneration };
    await runtime.setEarlyReplyPlayback({ ...command, expectedEarlyReplyRevision: 0, earlyReplyPlayback: mode });
    await runtime.updateSettings({ ...command, expectedRevision: initial.settingsRevision, patch: { audioMode: "speak",
      speechContent: "messages", autoListen: false, speechProvider: "server", speechEndpoint: endpoint, sttModel: "parakeet-local",
      ttsModel: "kokoro-local", ttsVoice: "af_heart", speechTextLimit: 12 } });
    callbacks.frame("notification_policy", { generation: 1, settings: { enabled: true, silenced: false, revision: 1,
      scriptPath: "", arguments: [], timeoutSeconds: 30, assistantResultPhases: ["final"], delivery: defaultNotificationDelivery() } }, stream);
    callbacks.notificationsChanged(true);
    const sentences = Array.from({ length: count }, (_, i) => `Go to ${String(i + 1).padStart(2, "0")}.`);
    const began = meter.currentTime * meter.sampleRate;
    if (mode === "responsive") {
      const waiting = waitState(state => state.phase === "waiting_for_reply_text" && receivedAt.length === count);
      let start = 0;
      for (const [seq, text] of sentences.entries()) {
        const segment = text + " ";
        callbacks.frame("voice_early_reply", { replyId, threadId, turnId: "turn", itemId: "final", generation: 1, seq,
          ...(seq ? { kind: "append" } : { kind: "begin", event: "turn.completed", threadTitle: "Timing", userInputRevision: 1 }),
          rawStart: start, rawEnd: start + segment.length, text: segment, paragraphEnd: false }, stream);
        start += segment.length;
      }
      await waiting;
    }
    const completed = waitState(state => state.phase === "idle" && state.active === null && state.queue.count === 0 && receivedAt.length === count);
    callbacks.frame("notification", { sourceEventId: replyId, generation: 1, userInputRevision: 1, voice: "speak",
      payload: { schemaVersion: 5, notificationId: replyId, event: "turn.completed", title: "Agent finished", message: "Timing",
        thread: { id: threadId, title: "Timing" }, turn: { id: "turn", outcome: "completed" }, occurredAt: new Date().toISOString(),
        assistantResult: { final: { text: sentences.join(" ") } } } }, stream);
    await completed;
    // Allow the last mirrored MediaStream packet to reach the observation graph.
    await new Promise(resolve => setTimeout(resolve, 150));
    const ranges = await Promise.all(probes.map(probe => new Promise<{ first: number | null; last: number | null }>(resolve => {
      probe.port.onmessage = event => resolve(event.data);
      probe.port.postMessage("range");
    })));
    const gapMs: number[] = [], readyLeadMs: number[] = [], requestLeadMs: number[] = [];
    for (const [index, range] of ranges.entries()) {
      if (range.first === null || range.last === null || range.last - range.first < meter.sampleRate * 0.8)
        throw new Error(`Missing one-second PCM marker in request ${index + 1}: ${JSON.stringify(range)}`);
      const previous = ranges[index - 1];
      if (previous) {
        gapMs.push((range.first - previous.last! - 1) * 1000 / meter.sampleRate);
        requestLeadMs.push((previous.last! + 1 - requestedAt[index]!) * 1000 / meter.sampleRate);
        readyLeadMs.push((previous.last! + 1 - receivedAt[index]!) * 1000 / meter.sampleRate);
      }
    }
    return { sampleRate: meter.sampleRate, requests: texts, sentences, gapMs, readyLeadMs, requestLeadMs,
      firstFromEligibleMs: (ranges[0]!.first! - began) * 1000 / meter.sampleRate };
  } finally {
    await subscription.remove(); await runtime.disconnect({ expectedConnectionGeneration: (await runtime.getState()).connectionGeneration });
    await audio.dispose(); for (const track of tracks) track.stop(); await meter.close();
  }
}
