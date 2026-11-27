import Database from "better-sqlite3";
import { MAXIMUM_THREAD_INPUT_BYTES } from "../../src/shared/protocol/context-excerpts.js";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { authenticationStatusSchema } from "../../src/shared/authentication.js";
import { setEndpointCredential, setEndpointProfile } from "../../src/client/authentication/auth-transport.js";
import { configuredSedesServer } from "../../src/client/app/server-endpoint.js";
import { ElectronVoiceConnection } from "../../src/client/voice/electron-voice-connection.js";
import { ElectronVoiceRuntime } from "../../src/client/voice/electron-voice-runtime.js";
import type { NativeEarlyReplyPlaybackMode } from "../../src/client/voice/native-voice-plugin.js";
import { electronSpeech } from "../../src/client/voice/electron-speech-plugin.js";
import { SpeechTransport, type AudioChunk } from "../support/electron-speech-transport.js";
import { OutboundCodexFixture } from "../support/outbound-codex-fixture.js";
import { notificationSettingsSchema, voiceNotificationSchema } from "../../src/shared/protocol/notification.js";
import { directInputReceiptLookupSchema, directInputReceiptSchema, MAX_DIRECT_INPUT_REQUEST_BYTES, threadInputContextSchema } from "../../src/shared/protocol/thread-input.js";
import { clientPollResultSchema, registeredClientSchema } from "../../src/shared/protocol/client-controls.js";
import { startOpenAiSpeechFixture, waitForSpeech } from "../support/openai-speech-fixture.js";
import { OpenCodeProductionFixture } from "../support/opencode-production-fixture.js";

const execFile = promisify(execCallback);
const androidSerial = process.env.SEDES_VOICE_ANDROID_SERIAL;
const adbPath = process.env.SEDES_ADB_EXECUTABLE ?? (process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "platform-tools/adb") : "adb");
function adb(args: string[], timeout = 30_000) {
  if (!androidSerial) throw new Error("An explicit isolated emulator serial is required.");
  return execFile(adbPath, ["-s", androidSerial, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
}

describe("native voice production pipeline with loopback providers", () => {
  let speech: Awaited<ReturnType<typeof startOpenAiSpeechFixture>>;
  let app: OpenCodeProductionFixture;
  let artifactDirectory: string;
  let androidInstalled = false;
  const reversePorts = new Set<number>();
  beforeAll(async () => {
    await mkdir(path.resolve("test-results"), { recursive: true });
    artifactDirectory = await mkdtemp(path.resolve("test-results/voice-run-"));
    console.log(`Voice artifacts: ${artifactDirectory}`);
    speech = await startOpenAiSpeechFixture(artifactDirectory);
    app = await OpenCodeProductionFixture.create("local", "external", { packagedClients: ["android", "electron"] });
    const { revision, silenced: _silenced, ...settings } = notificationSettingsSchema.parse(await app.json("/api/application/notifications"));
    await app.json("/api/application/notifications", "PUT", { ...settings, enabled: true, expectedRevision: revision });
    if (androidSerial) {
      expect((await adb(["shell", "getprop", "ro.kernel.qemu"])).stdout.trim(), "Use a disposable emulator; the harness clears its Sedes application state.").toBe("1");
      await adb(["install", "-r", path.resolve("android/app/build/outputs/apk/debug/app-debug.apk")], 90_000);
      androidInstalled = true;
      await adb(["install", "-r", path.resolve("android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk")], 90_000);
      await adb(["reverse", `tcp:${app.port}`, `tcp:${app.port}`]);
      reversePorts.add(app.port);
      await adb(["reverse", `tcp:${speech.port}`, `tcp:${speech.port}`]);
      reversePorts.add(speech.port);
    }
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try { await action(); } catch (error) { errors.push(error); }
    };
    if (androidSerial) {
      if (androidInstalled) await cleanup(() => adb(["shell", "am", "force-stop", "dev.sedes.local"]));
      for (const port of reversePorts) await cleanup(() => adb(["reverse", "--remove", `tcp:${port}`]));
    }
    if (app) {
      await cleanup(() => writeFile(path.join(artifactDirectory, "sedes.log"), app.logs + "\n" + app.streamErrors.join("\n")));
      await cleanup(() => app.close());
    }
    if (speech) await cleanup(() => speech.close());
    if (errors.length) throw new AggregateError(errors, "Voice fixture cleanup failed");
  });

  it("uses real speech HTTP PCM streaming and an explicitly committed realtime transcription", async () => {
    await speech.configure({ transcripts: ["voice contract input"], asrDelayMs: 0, ttsDurationSeconds: 1, reset: true });
    const response = await fetch(`${speech.endpoint}/audio/speech`, { method: "POST", headers: {
      authorization: `Bearer ${speech.token}`, "content-type": "application/json",
    }, body: JSON.stringify({ model: "kokoro-local", voice: "af_heart", input: "Fixture voice", response_format: "pcm" }), signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/pcm; rate=24000; channels=1; format=s16le");
    const pcm = Buffer.from(await response.arrayBuffer());
    expect(createHash("sha256").update(pcm).digest("hex")).toBe(speech.pcmSha256);
    const result = await transcribeFixtureAudio(speech, pcm);
    expect(result.completed.transcript).toBe("voice contract input");
    const observations = await speech.observations();
    expect(observations.speech.at(-1)?.text).toBe("Fixture voice");
    expect(observations.transcriptions.at(-1)).toMatchObject({ sampleRate: 16000, bytes: 32000 });
  });

  async function withCodexPlayback(scenario: string, speechContent: "messages" | "both", mode: NativeEarlyReplyPlaybackMode, run: (input: {
    threadId: string; codex: OutboundCodexFixture; desktop: ElectronVoiceRuntime;
    pcm: Buffer[]; frames: VoiceFrame[]; holdDrain: () => { until: Promise<void>; release: () => void };
  }) => Promise<void>): Promise<void> {
    await speech.configure({ reset: true, ttsDurationSeconds: 1 });
    const socketPath = path.join(app.directory, `voice-${scenario}.sock`);
    const codex = await OutboundCodexFixture.start(socketPath, { workspacePath: app.workspace });
    const endpoint = configuredSedesServer(app.url);
    const profileId = randomUUID();
    let audioListener: ((chunk: AudioChunk) => void) | undefined;
    const transport = new SpeechTransport({
      credentials: {
        async read(url) { return url === speech.endpoint ? speech.token : null; },
        async status(url) { return { credentialConfigured: url === speech.endpoint }; },
      },
      notify(event, value) { if (event === "audioChunk") audioListener?.(value as AudioChunk); },
    });
    const pcm: Buffer[] = [];
    let releaseOpening: (() => void) | undefined;
    let openingDrain: Promise<void> | undefined;
    const noopListener = async () => ({ remove: async () => {} });
    const frames: VoiceFrame[] = [];
    const desktop = new ElectronVoiceRuntime({
      connection: (binding, callbacks, resumeToken) => new ElectronVoiceConnection(binding, {
        ...callbacks,
        frame(event, value, streamId) {
          frames.push({ event, value });
          callbacks.frame(event, value, streamId);
        },
      }, resumeToken),
      speech: {
        ...electronSpeech,
        configure: input => transport.configure(input), getCapabilities: input => transport.getCapabilities(input),
        speak: input => transport.speak(input), acknowledgeAudio: async input => transport.acknowledgeAudio(input),
        cancel: async input => transport.cancel(input), cancelAll: async () => transport.cancelAll(),
        addAudioListener: async listener => { audioListener = listener; return { remove: async () => { audioListener = undefined; } }; },
        addInterruptedListener: noopListener, addRecognitionErrorListener: noopListener, addWindowStateListener: noopListener,
        getWindowState: async () => ({ visible: false }), setAudioActive: async () => {},
      },
      audio: {
        createPlayback: async () => ({
          append: async bytes => { pcm.push(Buffer.from(bytes)); },
          finish: async () => { await openingDrain; },
          cancel() {},
        }),
        startCapture: async () => { throw new Error("Early reply opened the microphone"); },
        stopCapture: async () => {}, playCue: async () => {}, listInputDevices: async () => [], dispose: async () => {},
      },
    });
    try {
      const threadId = await createVoiceCodexThread(app, socketPath, `early-reply-${scenario}`);

      const { navigationNamespace: identity } = authenticationStatusSchema.parse(await app.json("/api/auth/status"));
      if (!identity) throw new Error("Admitted native client lacks a principal namespace");
      setEndpointProfile(endpoint, profileId);
      setEndpointCredential(endpoint, app.credential);
      const state = await desktop.setConnection({ profileId, serverOrigin: app.url, identity });
      expect(state.errors).toEqual([]);
      const command = { expectedConnectionGeneration: state.connectionGeneration };
      await desktop.setEarlyReplyPlayback({ ...command, expectedEarlyReplyRevision: state.speech.earlyReplyRevision, earlyReplyPlayback: mode });
      await desktop.updateSettings({ ...command, expectedRevision: state.settingsRevision, patch: {
        audioMode: "speak", speechContent, autoListen: false, ignoreOtherDevices: false,
        speechProvider: "server", speechEndpoint: speech.endpoint, sttModel: "parakeet-local", ttsModel: "kokoro-local", ttsVoice: "af_heart",
      } });
      await expect.poll(async () => (await desktop.getState()).readiness, { timeout: 15_000 }).toBe("ready");
      await app.send(threadId, "Describe two stages of speech playback.");
      // Start the assistant item on the established live projection, after Sedes owns the submitted turn.
      await waitForSpeech(async () => {
        const context = threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`));
        return codex.activeTurnConnected && context.sourceTurnId && context.steer.availability === "available";
      });

      await run({ threadId, codex, desktop, pcm, frames, holdDrain: () => {
        openingDrain = new Promise<void>(resolve => { releaseOpening = resolve; });
        return { until: openingDrain, release: releaseOpening! };
      } });
    } finally {
      releaseOpening?.();
      await desktop.disconnect({ expectedConnectionGeneration: (await desktop.getState()).connectionGeneration });
      setEndpointCredential(endpoint, null);
      setEndpointProfile(endpoint, null);
      await codex.close();
    }
  }

  it.each(["after-drain", "while-speaking"] as const)("streams a qualified live Codex sentence through the Electron runtime and seals it %s", async timing => {
    await withCodexPlayback(timing, "messages", "responsive", async ({ threadId, codex, desktop, pcm, frames, holdDrain }) => {
      const opening = "The first sentence reaches the speaker while the response is still running.";
      const ending = "The remaining sentence arrives after completion.";
      const answer = codex.startAnswer("final_answer");
      const held = timing === "while-speaking" ? holdDrain() : undefined;
      const frameNames = () => frames.map(({ event, value }) => event === "voice_early_reply" ? `${event}:${value.kind}` : event);
      answer.append(opening + " The");
      await expect.poll(() => ({ frames: frameNames(), pcmAvailable: pcm.length > 0 }), { timeout: 15_000 }).toMatchObject({
        frames: expect.arrayContaining(["voice_early_reply:begin"]), pcmAvailable: true,
      });
      expect((await app.thread(threadId)).runState).toBe("running");
      expect((await speech.observations()).speech).toEqual([{ text: opening }]);
      const openingPhase = timing === "after-drain" ? "waiting_for_reply_text" : "speaking";
      await expect.poll(async () => (await desktop.getState()).phase, { timeout: 15_000 }).toBe(openingPhase);
      const active = (await desktop.getState()).active;
      expect(active?.threadId).toBe(threadId);
      expect((await desktop.getState()).queue.count).toBe(0);

      if (held) {
        // As on the Pixel, markup ends early publication while the opening is audible.
        // Hold the provider's completion-time history read and keep the physical sink playing.
        answer.append(" **remaining sentence** arrives after completion.");
        await waitForSpeech(() => frameNames().includes("voice_early_reply:yield"));
        codex.holdNextTurnListUntil(held.until);
      } else {
        expect(Buffer.concat(pcm)).toEqual(speech.pcm);
        answer.append(ending.slice(3));
      }
      answer.complete();
      const completionIndex = codex.requests.length;
      codex.completeTurn();
      await waitForSpeech(() => frameNames().includes("notification") && codex.requests.slice(completionIndex)
        .some(request => request.method === "thread/turns/list"));
      expect(frameNames()).not.toContain("voice_early_reply:cancel");
      if (held) {
        expect(await desktop.getState()).toMatchObject({ active: { id: active!.id }, queue: { count: 0 }, phase: "speaking" });
        held.release();
      }
      await expect.poll(async () => (await desktop.getState()).phase, { timeout: 15_000 }).toBe("idle");
      expect((await speech.observations()).speech).toEqual([{ text: opening }, { text: ending }]);
      expect(Buffer.concat(pcm)).toEqual(Buffer.concat([speech.pcm, speech.pcm]));
      expect((await desktop.getState()).errors).toEqual([]);
      if (timing === "after-drain") {
        const historyReads = codex.requests.slice(completionIndex).filter(request =>
          request.method === "thread/turns/list" || request.method === "thread/items/list");
        expect(historyReads.map(request => request.method)).toEqual(["thread/turns/list"]);
      }
    });
  });

  it("synthesizes a short opening with the rest of the completed item in one HTTP request", async () => {
    await withCodexPlayback("short-handoff", "messages", "responsive", async ({ codex, desktop, frames, pcm }) => {
      const body = "Yes. This is a test.";
      const answer = codex.startAnswer("final_answer");
      answer.append("Yes. This");
      await waitForSpeech(async () => (await desktop.getState()).phase === "waiting_for_reply_text");
      expect((await speech.observations()).speech).toEqual([]);
      answer.complete("final_answer", body);
      codex.completeTurn();
      await waitForSpeech(() => frames.some(frame => frame.event === "notification" && frame.value.payload.event === "turn.completed"));
      await waitForSpeech(async () => (await desktop.getState()).phase === "idle");
      expect((await speech.observations()).speech).toEqual([{ text: body }]);
      expect(Buffer.concat(pcm)).toEqual(speech.pcm);
    });
  });

  it.each(["responsive", "balanced", "natural"] as const)("plays the progress and final preambles before the %s body is ready", async mode => {
    await withCodexPlayback(`preamble-${mode}`, "both", mode, async ({ threadId, codex, desktop, pcm, frames }) => {
      const title = "Early playback qualification";
      const requests: string[] = [];
      const spoken = async () => (await speech.observations()).speech.map(request => request.text);
      for (const [phase, label, short] of [
        ["commentary", "Agent progress", "Yes."],
        ["final_answer", "Agent finished", "It passed."],
      ] as const) {
        const item = codex.startAnswer(phase);
        item.append(short + " The");
        requests.push(label + "\n\n" + title);
        await expect.poll(spoken, { timeout: 15_000 }).toEqual(requests);
        await waitForSpeech(async () => (await desktop.getState()).phase === "waiting_for_reply_text");
        expect(Buffer.concat(pcm).length).toBe(requests.length * speech.pcm.length);

        const sentence = mode === "responsive" ? "The first inspection is running."
          : "The first inspection is still running and the remaining files are currently being checked.";
        let opening = short + " " + sentence;
        if (mode === "natural") {
          const firstFrame = frames.length;
          item.append(sentence.slice(3) + " More");
          await waitForSpeech(() => frames.slice(firstFrame).some(({ event, value }) => event === "voice_early_reply" && value.text?.includes(sentence)));
          expect(await spoken()).toEqual(requests);
          item.append(" details follow.\n\nAll");
          opening += " More details follow.";
        } else {
          item.append(sentence.slice(3) + " All");
        }
        requests.push(opening);
        await expect.poll(spoken, { timeout: 15_000 }).toEqual(requests);
        await waitForSpeech(async () => (await desktop.getState()).phase === "waiting_for_reply_text");
        expect((await app.thread(threadId)).runState).toBe("running");

        item.append(" done.");
        item.complete();
        if (phase === "final_answer") codex.completeTurn();
        requests.push("All done.");
        await expect.poll(spoken, { timeout: 15_000 }).toEqual(requests);
        await waitForSpeech(async () => (await desktop.getState()).phase === "idle");
      }
    });
  });

  it("synthesizes the accumulated sentences together when the lookahead slot becomes available", async () => {
    await withCodexPlayback("catch-up", "messages", "responsive", async ({ codex, desktop, frames, holdDrain }) => {
      const answer = codex.startAnswer("final_answer");
      const held = holdDrain();
      const first = "The first group is being spoken.";
      const second = "The second group is available now.";
      const backlog = "Two sentences arrive while playback is busy. They belong in one request.";
      const spoken = async () => (await speech.observations()).speech.map(request => request.text);
      answer.append(first + " The");
      await expect.poll(spoken, { timeout: 15_000 }).toEqual([first]);
      answer.append(second.slice(3) + " Two");
      await expect.poll(spoken, { timeout: 15_000 }).toEqual([first, second]);
      answer.append(backlog.slice(3) + " Done");
      await waitForSpeech(() => frames.some(({ event, value }) => event === "voice_early_reply" && value.text?.includes("one request.")));
      expect(await spoken()).toEqual([first, second]);
      held.release();
      await expect.poll(spoken, { timeout: 15_000 }).toEqual([first, second, backlog]);
      await waitForSpeech(async () => (await desktop.getState()).phase === "waiting_for_reply_text");
      answer.append(".");
      answer.complete();
      codex.completeTurn();
      await expect.poll(spoken, { timeout: 15_000 }).toEqual([first, second, backlog, "Done."]);
      await waitForSpeech(async () => (await desktop.getState()).phase === "idle");
    });
  });

  it("streams Codex commentary before item completion and seals each progress item independently", async () => {
    await withCodexPlayback("commentary", "messages", "responsive", async ({ threadId, codex, desktop, frames, pcm, holdDrain }) => {
      const starts = () => frames.filter(({ event, value }) => event === "voice_early_reply" && value.kind === "begin").map(frame => frame.value);
      const notices = () => frames.filter(frame => frame.event === "notification").map(frame => voiceNotificationSchema.parse(frame.value));
      const spoken = async () => (await speech.observations()).speech.map(request => request.text);
      const waitForIdle = () => waitForSpeech(async () => (await desktop.getState()).phase === "idle");
      const settings = notificationSettingsSchema.parse(await app.json("/api/application/notifications"));
      const changeDelivery = async (delivery: typeof settings.delivery) => {
        const { revision, silenced: _silenced, ...config } = notificationSettingsSchema.parse(await app.json("/api/application/notifications"));
        await app.json("/api/application/notifications", "PUT", { ...config, expectedRevision: revision, delivery });
        await waitForSpeech(() => frames.some(({ event, value }) => event === "notification_policy" && value.settings.revision === revision + 1));
      };
      try {
        expect(settings.assistantResultPhases).not.toContain("provisional");
        await changeDelivery({ ...settings.delivery, "turn.completed": { script: false, voice: "none" } });
        const first = codex.startAnswer("commentary");
        const opening = "I found the first matching file.";
        const remainder = "The rest of the details are here.";
        first.append(opening + " The");
        await expect.poll(async () => ({ pcm: pcm.length > 0, state: (await desktop.getState()).active?.eventKind }), { timeout: 15_000 })
          .toEqual({ pcm: true, state: "turn.progress" });
        expect(starts()).toMatchObject([{ event: "turn.progress", text: opening }]);
        expect(notices()).toEqual([]);
        expect(await spoken()).toEqual([opening]);
        await waitForSpeech(async () => (await desktop.getState()).phase === "waiting_for_reply_text");
        expect(Buffer.concat(pcm)).toEqual(speech.pcm);
        first.append(remainder.slice(3));
        first.complete();
        await waitForSpeech(() => notices().some(notice => notice.sourceEventId === starts()[0].replyId));
        await waitForIdle();
        expect(await spoken()).toEqual([opening, remainder]);
        expect(Buffer.concat(pcm)).toEqual(Buffer.concat([speech.pcm, speech.pcm]));

        const second = codex.startAnswer("commentary");
        const skippedOpening = "I am checking the second file.";
        const hold = holdDrain();
        second.append(skippedOpening + " The");
        const playing = await waitForSpeech(async () => {
          const state = await desktop.getState();
          if (starts().length === 2 && state.phase === "speaking" && state.active?.id === starts()[1].replyId) return state;
        });
        expect(playing.queue.count).toBe(0);
        await desktop.skipCurrentPlayback({ expectedConnectionGeneration: playing.connectionGeneration, interactionId: playing.active!.id });
        hold.release();
        second.append(" later sentences are discarded. Including this one.");
        second.complete();
        await waitForSpeech(() => notices().some(notice => notice.sourceEventId === starts()[1].replyId));

        const late = codex.startAnswer(null);
        const lateText = "This status is classified when the item closes. Read it once.";
        late.append(lateText);
        late.complete("commentary");
        await waitForSpeech(() => notices().some(notice => notice.payload.progress?.text === lateText));
        await waitForIdle();
        expect(starts()).toHaveLength(2);
        expect(await spoken()).toEqual([opening, remainder, skippedOpening, lateText]);

        await changeDelivery({ ...settings.delivery, "turn.progress": { script: false, voice: "none" } });
        const muted = codex.startAnswer("commentary");
        muted.append("This commentary is muted. It should stay silent.");
        muted.complete();
        const final = codex.startAnswer("final_answer");
        const conclusion = "Both configuration files have been checked.";
        const suffix = "They contain the same configuration.";
        final.append(conclusion + " They");
        await waitForSpeech(async () => starts().length === 3 && (await spoken()).includes(conclusion));
        expect((await app.thread(threadId)).runState).toBe("running");
        final.append(suffix.slice(4));
        final.complete();
        codex.completeTurn();
        await waitForSpeech(() => notices().some(notice => notice.payload.event === "turn.completed"));
        await waitForIdle();
        const terminalIds = notices().map(notice => notice.sourceEventId);
        expect(notices().map(notice => notice.payload.event)).toEqual(["turn.progress", "turn.progress", "turn.progress", "turn.completed"]);
        expect(starts().map(frame => [frame.event, frame.replyId])).toEqual([
          ["turn.progress", terminalIds[0]], ["turn.progress", terminalIds[1]], ["turn.completed", terminalIds[3]],
        ]);
        expect(new Set(terminalIds).size).toBe(4);
        expect(await spoken()).toEqual([opening, remainder, skippedOpening, lateText, conclusion, suffix]);
        expect((await desktop.getState()).errors).toEqual([]);
      } finally {
        await changeDelivery(settings.delivery);
      }
    });
  });

  it.each(["on", "off"] as const)("seals a steered Codex turn once for both accepted inputs with early playback %s", async interest => {
    const socketPath = path.join(app.directory, `steer-${interest}.sock`);
    const codex = await OutboundCodexFixture.start(socketPath, { workspacePath: app.workspace });
    const feed = await voiceFeed(app, undefined, { voiceStreamId: randomUUID(), earlyReply: interest });
    const database = new Database(path.join(app.stateDirectory, "overlay.sqlite"), { readonly: true });
    try {
      const threadId = await createVoiceCodexThread(app, socketPath, `steered-${interest}-codex`);
      const registration = registeredClientSchema.parse(await app.json("/api/client-registration", "POST", {
        platform: "browser", capabilities: { navigate: true, voice: false, voiceSettings: false },
        state: { runtime: { foreground: true, voiceReady: false, interactionActive: false }, settings: null },
      }));
      const headers = { "X-Sedes-Client": registration.connectionToken };
      const submit = directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", {
        mutationId: randomUUID(), text: "Explain one change.", runningPolicy: { mode: "queue" },
      }, headers));
      const active = await waitForSpeech(async () => {
        const context = threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`));
        return context.steer.availability === "available" && context.steer.target.kind === "turn" ? context.steer.target : undefined;
      });
      const steer = directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", {
        mutationId: randomUUID(), text: "Include a second change.", runningPolicy: { mode: "steer", target: active, onUnavailable: "queue" },
      }, headers));
      expect(steer.admittedMode).toBe("steer");
      await waitForSpeech(() => codex.requests.some(request => request.method === "turn/steer"));
      codex.materializeSteer();
      await waitForSpeech(async () => {
        const lookup = await app.json(`/api/input-receipts/${steer.mutationId}`) as { receipt?: { status: string } };
        return lookup.receipt?.status === "accepted";
      });
      const text = "One change is ready. Another change is ready.";
      const answer = codex.startAnswer("final_answer");
      answer.append(text);
      const early = () => feed.frames.filter(frame => frame.event === "voice_early_reply" && frame.value.threadId === threadId);
      if (interest === "on") {
        await waitForSpeech(() => early().find(frame => frame.value.kind === "begin"));
        expect(early()[0]!.value).toMatchObject({ kind: "begin", turnId: active.turnId, text: "One change is ready.", userInputRevision: 2 });
      }
      answer.complete();
      codex.completeTurn();
      const completion = await waitForSpeech(() => feed.frames.find(frame => frame.event === "notification" && frame.value.payload?.turn?.id === active.turnId));
      expect(voiceNotificationSchema.parse(completion.value)).toMatchObject({ payload: { event: "turn.completed",
        assistantResult: { final: { text } } }, userInputRevision: 2 });
      if (interest === "on") {
        expect(early()[0]!.value.replyId).toBe(completion.value.sourceEventId);
        expect(early().map(frame => frame.value)).toMatchObject([
          { kind: "begin", text: "One change is ready." },
          { kind: "append", text: " Another change is ready." },
          { kind: "yield", reason: "item_done" },
        ]);
      } else {
        expect(early()).toEqual([]);
      }
      const stored = database.prepare(`SELECT operation_id, completion_outcome FROM submission_completion_observations
        WHERE application_thread_id = ? AND application_turn_id = ? ORDER BY accepted_at, operation_id`);
      await waitForSpeech(() => stored.all(threadId, active.turnId).length === 2);
      expect(stored.all(threadId, active.turnId)).toEqual([
        { operation_id: submit.operationId, completion_outcome: "completed" },
        { operation_id: steer.operationId, completion_outcome: "completed" },
      ]);
      expect(feed.frames.filter(frame => frame.event === "notification" && frame.value.payload?.turn?.id === active.turnId)).toHaveLength(1);
    } finally {
      database.close();
      await feed.close();
      await codex.close();
    }
  });

  it("admits content once without touching drafts, emits a live voice completion, and never replays it", async () => {
    const threadId = await app.createThread();
    const otherThreadId = await app.createThread();
    expect(threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`)).userInputRevision).toBe(0);
    const initial = await app.thread(threadId);
    await app.json(`/api/threads/${threadId}/draft`, "PUT", {
      text: "Keep this unsent composer draft", contextExcerpts: [], attachmentIds: [], taskReferenceIds: [], expectedRevision: initial.draft.revision,
    });
    const savedDraft = (await app.thread(threadId)).draft;
    const feed = await voiceFeed(app);
    try {
      await waitForSpeech(() => feed.frames.find(frame => frame.event === "notification_policy"));
      const registration = registeredClientSchema.parse(await app.json("/api/client-registration", "POST", {
        platform: "browser", capabilities: { navigate: true, voice: false, voiceSettings: false },
        state: { runtime: { foreground: true, voiceReady: false, interactionActive: false }, settings: null },
      }));
      const clientHeaders = { "X-Sedes-Client": registration.connectionToken };
      const input = { mutationId: randomUUID(), text: "First spoken production fixture input", runningPolicy: { mode: "queue" } };
      const receipt = directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", input, clientHeaders));
      expect(receipt, JSON.stringify(receipt)).toMatchObject({ mutationId: input.mutationId, threadId, admittedMode: "submit", status: "accepted" });
      const frame = await waitForSpeech(() => feed.frames.find(frame => frame.event === "notification" && frame.value.payload?.thread?.id === threadId));
      const notification = voiceNotificationSchema.parse(frame.value);
      expect(frame.id).toBeUndefined();
      expect(notification).toMatchObject({ voice: "speakThenListen", userInputRevision: 1,
        origin: { clientId: registration.clientId }, payload: { event: "turn.completed" } });
      expect(notification.recognitionTarget?.threadId).toBe(threadId);
      const context = threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`));
      expect(context).toMatchObject({ authority: "current", userInputRevision: notification.userInputRevision,
        automaticListenEligible: true, activityToken: notification.recognitionTarget?.activityToken });
      expect((await app.thread(threadId)).draft).toEqual(savedDraft);
      expect(directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", input, clientHeaders))).toEqual(receipt);
      expect(await app.json(`/api/input-receipts/${input.mutationId}`)).toEqual({ status: "found", receipt });
      expect((await app.request(`/api/threads/${otherThreadId}/inputs`, "POST", input, clientHeaders)).status).toBe(409);
      expect(threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`)).userInputRevision).toBe(1);
      expect(threadInputContextSchema.parse(await app.json(`/api/threads/${otherThreadId}/input-context`)).userInputRevision).toBe(0);
      expect(app.model.requests.filter(request => request.lastRole === "user" && request.lastText === input.text)).toHaveLength(1);
      const reconnected = await voiceFeed(app);
      try {
        await waitForSpeech(() => reconnected.frames.find(frame => frame.event === "notification_policy"));
        // A later policy frame on the same ordered transient lane is the sentinel: a
        // replay queued for this subscriber would have to arrive before it.
        const { revision, silenced: _silenced, ...settings } = notificationSettingsSchema.parse(await app.json("/api/application/notifications"));
        await app.json("/api/application/notifications", "PUT", { ...settings, expectedRevision: revision });
        await waitForSpeech(() => reconnected.frames.find(frame => frame.event === "notification_policy" &&
          notificationSettingsSchema.safeParse(frame.value.settings).data?.revision === revision + 1));
        expect(reconnected.frames.filter(frame => frame.event === "notification")).toEqual([]);
      } finally { await reconnected.close(); }

      // The full direct-input text limit still fits its dedicated request parser after JSON escaping.
      const escaped = { ...input, mutationId: randomUUID(), text: "\u0001".repeat(MAXIMUM_THREAD_INPUT_BYTES) };
      expect(JSON.stringify(escaped).length).toBeGreaterThan(256 * 1024);
      expect(Buffer.byteLength(escaped.text)).toBe(MAXIMUM_THREAD_INPUT_BYTES);
      expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThan(MAX_DIRECT_INPUT_REQUEST_BYTES);
      const oversizedText = { ...input, mutationId: randomUUID(), text: "é".repeat(MAXIMUM_THREAD_INPUT_BYTES / 2 + 1) };
      expect(Buffer.byteLength(oversizedText.text)).toBeGreaterThan(MAXIMUM_THREAD_INPUT_BYTES);
      expect((await app.request(`/api/threads/${threadId}/inputs`, "POST", oversizedText, clientHeaders)).status).toBe(400);
      const overParser = { ...input, mutationId: randomUUID(), text: "\u0001".repeat(Math.floor(MAX_DIRECT_INPUT_REQUEST_BYTES / 6) + 1) };
      expect(Buffer.byteLength(JSON.stringify(overParser))).toBeGreaterThan(MAX_DIRECT_INPUT_REQUEST_BYTES);
      expect((await app.request(`/api/threads/${threadId}/inputs`, "POST", overParser, clientHeaders)).status).toBe(413);
      expect(threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`)).userInputRevision).toBe(1);
      expect((await app.request(`/api/threads/${threadId}/inputs`, "POST", escaped, clientHeaders)).status).toBe(200);
      expect(threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`)).userInputRevision).toBe(2);
    } finally { await feed.close(); }
  });

  it.each(["text", "voice"] as const)("suppresses an obsolete completion after another client queues a %s follow-up", async source => {
    const threadId = await app.createThread(`Follow-up freshness ${source}`);
    const state = { runtime: { foreground: true, voiceReady: false, interactionActive: false }, settings: null };
    const register = async (credential = app.credential) => registeredClientSchema.parse(await app.json("/api/client-registration", "POST", {
      platform: "browser", capabilities: { navigate: true, voice: false, voiceSettings: false }, state,
    }, {}, credential));
    const initialClient = await register();
    const pairing = app.authentication.createPairing({ kind: "management" });
    const followingIdentity = app.authentication.exchangePairing({ token: pairing.token,
      clientName: `Following ${source} client`, kind: "device" });
    expect(followingIdentity).toBeDefined();
    const followingCredential = followingIdentity!.credential;
    const followingClient = await register(followingCredential);
    expect(followingClient.clientId).not.toBe(initialClient.clientId);
    const initialText = `Held first reply before ${source} follow-up`;
    const followUpText = `New ${source} message from another client`;
    const feed = await voiceFeed(app);
    let held: ReturnType<typeof app.model.holdNextStream> | undefined;
    try {
      await waitForSpeech(() => feed.frames.find(frame => frame.event === "notification_policy"));
      held = app.model.holdNextStream(initialText);
      const first = directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", {
        mutationId: randomUUID(), text: initialText, runningPolicy: { mode: "queue" },
      }, { "X-Sedes-Client": initialClient.connectionToken }));
      expect(first.admittedMode).toBe("submit");
      await held.started;
      await app.waitFor(async () => (await app.thread(threadId)).runState === "running");
      const active = threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`));
      expect(active.userInputRevision).toBe(1);
      expect(active.sourceTurnId).toBeDefined();
      const headers = { "X-Sedes-Client": followingClient.connectionToken };
      if (source === "text") {
        let snapshot = await app.thread(threadId);
        await app.json(`/api/threads/${threadId}/draft`, "PUT", {
          text: followUpText, contextExcerpts: [], attachmentIds: [], taskReferenceIds: [], expectedRevision: snapshot.draft.revision,
        });
        // A saved draft alone is not an admission and must not stale the response.
        expect(threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`)).userInputRevision).toBe(1);
        snapshot = await app.thread(threadId);
        expect(await app.json(`/api/threads/${threadId}/operations`, "POST", {
          kind: "deliver", mode: "queue", mutationId: randomUUID(),
          expectedThreadRevision: snapshot.thread.threadRevision, expectedDraftRevision: snapshot.draft.revision,
        }, headers, followingCredential)).toMatchObject({ status: "delivery_queued" });
      } else {
        await speech.configure({ transcripts: [followUpText], asrDelayMs: 0, reset: true });
        const result = await transcribeFixtureAudio(speech, speech.pcm);
        expect(result.completed.transcript).toBe(followUpText);
        const followUp = directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", {
          mutationId: randomUUID(), text: result.completed.transcript, runningPolicy: { mode: "queue" },
        }, headers, followingCredential));
        expect(followUp).toMatchObject({ admittedMode: "queue", status: "queued" });
        expect((await speech.observations()).transcriptions).toHaveLength(1);
      }
      const queuedContext = threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`));
      expect(queuedContext).toMatchObject({ userInputRevision: 2, sourceTurnId: active.sourceTurnId });
      held.release();
      // The next response on the ordered transient lane proves publication of the
      // earlier completion has finished; no arbitrary delay is needed for absence.
      const frame = await waitForSpeech(() => feed.frames.find(frame => frame.event === "notification" &&
        frame.value.payload?.event === "turn.completed" && frame.value.payload?.thread?.id === threadId &&
        frame.value.payload?.turn?.id !== active.sourceTurnId));
      const latest = voiceNotificationSchema.parse(frame.value);
      expect(latest).toMatchObject({ userInputRevision: 2, origin: { clientId: followingClient.clientId },
        recognitionTarget: { threadId }, payload: { event: "turn.completed" } });
      expect(feed.frames.filter(frame => frame.event === "notification" && frame.value.payload?.event === "turn.completed" &&
        frame.value.payload?.turn?.id === active.sourceTurnId)).toEqual([]);
      await app.waitFor(async () => (await app.thread(threadId)).runState === "idle");
      expect(threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`)).userInputRevision).toBe(latest.userInputRevision);
      expect(app.model.requests.filter(request => request.lastRole === "user" && request.lastText === initialText)).toHaveLength(1);
      expect(app.model.requests.filter(request => request.lastRole === "user" && request.lastText === followUpText)).toHaveLength(1);
    } finally {
      held?.release();
      await feed.close();
    }
  });

  it.each(["browser observer", "native voice stream"] as const)(
    "routes a real native client tool and settles it against its own %s", async recipient => {
    const threadId = await app.createThread("Client control source");
    const destination = await app.createThread("Client control destination");
    const policy = (await app.thread(threadId)).agentTools;
    await app.json(`/api/threads/${threadId}/operations`, "POST", {
      kind: "set_agent_tool_policy", mutationId: randomUUID(), expectedPolicyRevision: policy.revision,
      enabled: true, enabledToolIds: ["client.switch_thread"], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
      presentation: { surface: "native", mode: "progressive" },
    });
    await app.send(threadId, "Discover client controls");
    await app.waitFor(async () => app.model.requests.some(request => request.lastText === "Discover client controls"));
    await app.waitFor(async () => JSON.stringify((await app.thread(threadId)).itemsById).includes("Fixture response"));
    await app.waitFor(async () => (await app.thread(threadId)).runState === "idle");
    const nativeTool = app.model.requests.flatMap(request => request.toolNames).find(name => name.endsWith("_sedes_act"));
    expect(nativeTool).toBeDefined();
    const native = recipient === "native voice stream";
    const state = { runtime: { foreground: true, voiceReady: native, interactionActive: native }, settings: native ? {
      revision: 0, voice: { audioMode: "speak", voiceThreadId: threadId, pinDefaultVoiceThread: false,
        autoListen: false, onlyVoiceThread: false, ignoreOtherDevices: false, followComposerMode: true },
    } : null };
    let registration = registeredClientSchema.parse(await app.json("/api/client-registration", "POST", {
      platform: native ? "android" : "browser", capabilities: { navigate: true, voice: native, voiceSettings: native }, state,
    }));
    const feed = await voiceFeed(app);
    const voiceStreamId = native ? randomUUID() : undefined;
    const peerVoiceStreamId = native ? randomUUID() : undefined;
    let nativeFeed: Awaited<ReturnType<typeof voiceFeed>> | undefined;
    let peerNativeFeed: Awaited<ReturnType<typeof voiceFeed>> | undefined;
    try {
      if (voiceStreamId && peerVoiceStreamId) {
        nativeFeed = await voiceFeed(app, undefined, { voiceStreamId });
        peerNativeFeed = await voiceFeed(app, undefined, { voiceStreamId: peerVoiceStreamId });
      }
      const voiceSubscriber = nativeFeed;
      const peerVoiceSubscriber = peerNativeFeed;
      await waitForSpeech(() => feed.frames.find(frame => frame.event === "notification_policy"));
      if (voiceSubscriber) await waitForSpeech(() => voiceSubscriber.frames.find(frame => frame.event === "notification_policy"));
      if (peerVoiceSubscriber) await waitForSpeech(() => peerVoiceSubscriber.frames.find(frame => frame.event === "notification_policy"));
      if (native) {
        // Replacing the control connection must preserve these authenticated speech streams.
        const initialRegistration = registration;
        registration = registeredClientSchema.parse(await app.json("/api/client-registration", "POST", {
          resumeToken: initialRegistration.resumeToken, platform: "android",
          capabilities: { navigate: true, voice: true, voiceSettings: true }, state,
        }));
        expect(registration.clientId).toBe(initialRegistration.clientId);
        expect(registration.connectionToken).not.toBe(initialRegistration.connectionToken);
      }
      const clientHeaders = { "X-Sedes-Client": registration.connectionToken };
      const marker = `Switch this client after the reply with ${recipient}`;
      app.model.callToolNextStream(marker, nativeTool!, { toolId: "client.switch_thread", schemaVersion: 2,
        input: { threadId: destination, listen: native } });
      const receipt = directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", {
        mutationId: randomUUID(), text: marker, runningPolicy: { mode: "queue" },
      }, clientHeaders));
      expect(["accepted", "queued", "submitting"]).toContain(receipt.status);
      const delivery = clientPollResultSchema.parse(await app.json("/api/client-controls/poll", "POST", { state, acknowledgements: [] }, clientHeaders));
      expect(delivery.commands).toHaveLength(1);
      const command = delivery.commands[0]!;
      expect(command).toMatchObject({ action: "switch_thread", sourceThreadId: threadId, threadId: destination, listen: native });
      expect(feed.frames.some(frame => frame.event === "notification" && frame.value.payload?.turn?.id === command.sourceTurnId)).toBe(false);
      const settlementRequestedAt = Date.now();
      const settlement = clientPollResultSchema.parse(await app.json("/api/client-controls/poll", "POST", {
        state, acknowledgements: [{ id: command.id, result: { status: "accepted", reason: "after_turn_completion", state } }],
      }, clientHeaders));
      expect(settlement.commands).toHaveLength(1);
      const reply = voiceNotificationSchema.parse((await waitForSpeech(() => feed.frames.find(frame =>
        frame.event === "notification" && frame.value.payload?.turn?.id === command.sourceTurnId))).value);
      if (voiceSubscriber) {
        const nativeReply = voiceNotificationSchema.parse((await waitForSpeech(() => voiceSubscriber.frames.find(frame =>
          frame.event === "notification" && frame.value.payload?.turn?.id === command.sourceTurnId))).value);
        expect(nativeReply.sourceEventId).toBe(reply.sourceEventId);
      }
      if (peerVoiceSubscriber) {
        const peerReply = voiceNotificationSchema.parse((await waitForSpeech(() => peerVoiceSubscriber.frames.find(frame =>
          frame.event === "notification" && frame.value.payload?.turn?.id === command.sourceTurnId))).value);
        expect(peerReply.sourceEventId).toBe(reply.sourceEventId);
      }
      expect(settlement.commands[0]).toMatchObject({ ...command, action: "turn_settled",
        replyEventId: native ? reply.sourceEventId : null, expiresAt: expect.any(Number) });
      expect([...settlement.commands[0]!.replyStreamIds!].sort()).toEqual(native ? [voiceStreamId!, peerVoiceStreamId!].sort() : []);
      expect(settlement.commands[0]!.expiresAt).toBeLessThan(command.expiresAt);
      expect(settlement.commands[0]!.expiresAt).toBeGreaterThanOrEqual(settlementRequestedAt + 3_600_000);
      expect(settlement.commands[0]!.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
      expect(reply.origin).toEqual({ clientId: registration.clientId });
      expect(reply.userInputRevision).toBe(2);
      await app.waitFor(async () => (await app.thread(threadId)).runState === "idle");
    } finally {
      await peerNativeFeed?.close();
      await nativeFeed?.close();
      await feed.close();
    }
  });

  it.skipIf(!androidSerial).each(["final", "progress"] as const)("plays a held live Codex reply in the packaged Android background service (%s)", async earlyKind => {
    const progress = earlyKind === "progress";
    const title = "Early playback qualification";
    await adb(["shell", "pm", "clear", "dev.sedes.local"]);
    await speech.configure({ reset: true, ttsDurationSeconds: 1 });
    const socketPath = path.join(app.directory, `android-${earlyKind}.sock`);
    const codex = await OutboundCodexFixture.start(socketPath, { workspacePath: app.workspace });
    let device: ReturnType<typeof adb> | undefined;
    let output = "";
    try {
      const threadId = await createVoiceCodexThread(app, socketPath, `android-early-codex-${earlyKind}`);
      const args = { serverOrigin: app.url, threadId, earlyKind, earlyMode: progress ? "balanced" : "responsive",
        speechEndpoint: speech.endpoint, speechToken: speech.token, pairingCode: app.authentication.createPairing({ kind: "management" }).token,
        initialText: "Describe early and final speech." };
      device = adb(["shell", "am", "instrument", "-w", "-r", "-e", "class", "dev.sedes.local.NativeVoiceE2eTest#nativeBackgroundEarlyReply",
        ...Object.entries(args).flatMap(([key, value]) => ["-e", key, shellArgument(value)]),
        "dev.sedes.local.test/androidx.test.runner.AndroidJUnitRunner"], 300_000);
      device.child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      let finished = false;
      void device.then(() => { finished = true; }, () => { finished = true; });
      const requireRunningDevice = () => {
        if (finished) throw new Error("Android instrumentation ended before its expected playback stage. See the Android early-reply log.");
      };
      await waitForSpeech(async () => {
        requireRunningDevice();
        const admission = /^INSTRUMENTATION_STATUS: voiceAdmission=([0-9a-f-]{36})\r?\n/mu.exec(output)?.[1];
        if (!admission || !codex.activeTurnConnected) return false;
        const receipt = directInputReceiptLookupSchema.parse(await app.json(`/api/input-receipts/${admission}`));
        if (receipt.status !== "found" || receipt.receipt.status !== "accepted") return false;
        const context = threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`));
        return context.sourceTurnId && context.steer.availability === "available";
      }, 180_000);

      const waitForStage = async (stage: "voicePreamble" | "voiceOpening" | "voiceProgressSettled" | "voiceSkipped") => {
        const marker = new RegExp(`^INSTRUMENTATION_STATUS: ${stage}=(.+)$`, "mu");
        return JSON.parse(await waitForSpeech(() => {
          requireRunningDevice();
          return marker.exec(output)?.[1];
        }, 55_000));
      };
      const spoken = async () => (await speech.observations()).speech.map(request => request.text);
      const short = progress ? "Yes." : "It passed.";
      const sentence = progress ? "The first inspection is still running and the remaining files are currently being checked." : "The file passed inspection.";
      const opening = short + " " + sentence;
      const suffix = "All done.";
      const preamble = (progress ? "Agent progress" : "Agent finished") + "\n\n" + title;
      const answer = codex.startAnswer(progress ? "commentary" : "final_answer");
      answer.append(short + " The");
      const announced = await waitForStage("voicePreamble");
      expect(announced.drain).toMatchObject({ sampleRate: 24_000, writtenFrames: 24_000 });
      expect(announced.drain.playedFrames).toBeGreaterThanOrEqual(24_000);
      expect(await spoken()).toEqual([preamble]);
      answer.append(sentence.slice(3) + " All");
      const evidence = await waitForStage("voiceOpening");
      expect(evidence).toMatchObject({ foreground: false, drain: { sampleRate: 24_000, writtenFrames: 24_000 } });
      expect(evidence.drain.playedFrames).toBeGreaterThanOrEqual(24_000);
      expect(evidence.interactionId).toBe(announced.interactionId);
      expect((await app.thread(threadId)).runState).toBe("running");
      expect(await spoken()).toEqual([preamble, opening]);
      answer.append(suffix.slice(3));
      answer.complete();
      const skippedOpening = "I am still examining the second file before I can finish checking the complete response.";
      const finalText = "The final response still reaches the speaker.";
      if (progress) {
        expect(await waitForStage("voiceProgressSettled")).toEqual({ interactionId: evidence.interactionId });
        expect((await app.thread(threadId)).runState).toBe("running");
        expect(await spoken()).toEqual([preamble, opening, suffix]);
        const second = codex.startAnswer("commentary");
        second.append(skippedOpening + " More");
        expect((await waitForStage("voiceSkipped")).interactionId).not.toBe(evidence.interactionId);
        second.append(" text is available now. This sentence must also be discarded.");
        second.complete();
        const final = codex.startAnswer(null);
        final.append(finalText);
        final.complete("final_answer");
      }
      codex.completeTurn();

      const { stdout } = await device;
      expect(stdout).toMatch(/OK \(1 test\)/u);
      const result = JSON.parse(/^INSTRUMENTATION_STATUS: voiceResult=(.+)$/mu.exec(stdout)![1]!);
      expect(result.suffix.writtenFrames).toBe(24_000);
      expect(result.suffix.playedFrames).toBeGreaterThanOrEqual(24_000);
      expect(result.captureChunks).toBe(0);
      expect(result.physicalDrains).toBe(progress ? 6 : 3);
      expect(await spoken()).toEqual(progress
        ? [preamble, opening, suffix, preamble, skippedOpening, `Agent finished\n\n${title}\n\n${finalText}`]
        : [preamble, opening, suffix]);
    } finally {
      await adb(["shell", "am", "force-stop", "dev.sedes.local"]);
      await device?.catch(() => undefined);
      await writeFile(path.join(artifactDirectory, progress ? "android-early-progress.log" : "android-early-reply.log"), output + "\nSpeech requests: " + JSON.stringify((await speech.observations()).speech));
      await codex.close();
    }
  }, 330_000);

  it.skipIf(!androidSerial).each([
    "NativeVoiceStoreTest", "ClientCredentialStoreTest", "SpeechCredentialStoreTest", "NativeVoiceQueueDeviceTest",
    "NativeDictationStoreDeviceTest", "NativeVoiceOwnershipTest", "NativeVoiceRuntimeTest", "NativeVoiceStartupTest", "NativeVoiceAudioTest",
  ])("validates Android native %s", async nativeClass => {
    // Each independent class has its own bounded invocation and log, so one slow or failed class cannot hide the rest.
    let output = "";
    const errors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try { await action(); } catch (error) { errors.push(error); }
    };
    try {
      await adb(["shell", "pm", "clear", "dev.sedes.local"]);
      const result = await adb(["shell", "am", "instrument", "-w", "-r", "-e", "class",
        `dev.sedes.local.${nativeClass}`, "dev.sedes.local.test/androidx.test.runner.AndroidJUnitRunner"], 180_000);
      output = result.stdout + result.stderr;
      expect(result.stdout).toMatch(/OK \([1-9]\d* tests?\)/u);
      expect(result.stdout).not.toMatch(/FAILURES|INSTRUMENTATION_FAILED/u);
    } catch (error) {
      if (!output && error && typeof error === "object") {
        const result = error as { stdout?: unknown; stderr?: unknown };
        output = [result.stdout, result.stderr].filter(value => typeof value === "string").join("");
      }
      errors.push(error);
    } finally {
      await cleanup(() => writeFile(path.join(artifactDirectory, `android-native-${nativeClass}.log`), output));
      await cleanup(async () => {
        const logcat = await adb(["logcat", "-d", "-t", "1500"], 10_000);
        await writeFile(path.join(artifactDirectory, `android-native-${nativeClass}-logcat.log`), logcat.stdout);
      });
      // Killing a timed-out adb client does not stop instrumentation on the emulator.
      await cleanup(() => adb(["shell", "am", "force-stop", "dev.sedes.local"], 10_000));
    }
    if (errors.length) throw new AggregateError(errors, `Android native ${nativeClass} failed`);
  }, 250_000);

  for (const [mode, scenario] of [["speak", "cycle"], ["input", "cycle"], ["speak", "background"], ["speak", "background-switch"],
    ["speak", "startup"], ["input", "startup"],
    ["speak", "record"], ["speak", "next"], ["speak", "stop"], ["speak", "playback-stop"], ["speak", "playback-stop-notification"],
    ["speak", "retarget"], ["speak", "retained-target"],
    ["speak", "lost-ack"], ["speak", "lost-send"], ["speak", "cancel-uncertain"]] as const) {
    it.skipIf(!androidSerial)(`runs packaged Android ${mode}/${scenario} through the actual UI and media stack`, async () => {
      const playbackStop = scenario === "playback-stop" || scenario === "playback-stop-notification";
      await adb(["shell", "pm", "clear", "dev.sedes.local"]);
      const threadTitle = `Voice ${mode} ${scenario}`;
      const threadId = await app.createThread(threadTitle);
      const secondThreadTitle = `${scenario === "record" ? "Pinned default" : scenario === "retained-target" ? "Viewed default" : "Retarget"} ${mode} ${scenario}`;
      const secondThreadId = scenario === "record" || scenario === "retarget" || scenario === "background-switch" || scenario === "retained-target"
        ? await app.createThread(secondThreadTitle) : undefined;
      const initialText = `native voice fixture start ${mode} ${scenario}`;
      if (scenario === "background-switch") {
        const policy = (await app.thread(threadId)).agentTools;
        await app.json(`/api/threads/${threadId}/operations`, "POST", {
          kind: "set_agent_tool_policy", mutationId: randomUUID(), expectedPolicyRevision: policy.revision,
          enabled: true, enabledToolIds: ["client.switch_thread"], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
          presentation: { surface: "native", mode: "progressive" },
        });
        const discovery = `Discover background client controls ${threadId}`;
        await app.send(threadId, discovery);
        await app.waitFor(async () => app.model.requests.some(request => request.lastText === discovery));
        await app.waitFor(async () => JSON.stringify((await app.thread(threadId)).itemsById).includes("Fixture response"));
        await app.waitFor(async () => (await app.thread(threadId)).runState === "idle");
        const nativeTool = app.model.requests.filter(request => request.lastText === discovery)
          .flatMap(request => request.toolNames).find(name => name.endsWith("_sedes_act"));
        expect(nativeTool).toBeDefined();
        // The device submits this prompt only after its real activity is in the background.
        app.model.callToolNextStream(initialText, nativeTool!, { toolId: "client.switch_thread", schemaVersion: 2,
          input: { threadId: secondThreadId, listen: true } });
      }
      const pairingCode = app.authentication.createPairing({ kind: "management" }).token;
      const text = `voice fixture reply ${mode} ${scenario}`;
      // Give the real playback action a usable window even on software emulators.
      // This case uses 100ms fixture speech (reply and announcements) so held announcement PCM fits the 200ms buffer.
      const ttsDurationSeconds = scenario === "retained-target" ? 0.1 : scenario === "record" || scenario === "next" || playbackStop ? 12 : 1;
      await speech.configure({ transcripts: [text, ""], asrDelayMs: 0, ttsDurationSeconds, reset: true });
      const before = app.model.requests.length;
      const ttsBefore = (await speech.observations()).speech.length;
      const args = { serverOrigin: app.url, speechEndpoint: speech.endpoint, speechToken: speech.token, pairingCode, threadId, threadTitle, mode, scenario,
        initialText, recognizedText: text, draftText: `unsent voice fixture draft ${mode} ${scenario}`,
        ...(secondThreadId ? { secondThreadId, secondThreadTitle } : {}),
        ...(scenario === "retained-target" ? { secondDraftText: "unsent draft on the viewed thread after voice navigation" } : {}) };
      const diagnosticPath = path.join(artifactDirectory, `android-${mode}-${scenario}-voice-diagnostics.json`);
      const observer = await observeScenarioVoice(app, [threadId, ...(secondThreadId ? [secondThreadId] : [])]);
      let instrumentationOutput = "";
      let scenarioFailed = false;
      try {
        const run = (extra: Record<string, string> = {}) => adb([
          "shell", "am", "instrument", "-w", "-r", "-e", "class", "dev.sedes.local.NativeVoiceE2eTest#nativeConversationCycle",
          ...Object.entries({ ...args, ...extra }).flatMap(([key, value]) => ["-e", key, shellArgument(value)]),
          "dev.sedes.local.test/androidx.test.runner.AndroidJUnitRunner"], 330_000);
        let restored: Record<string, string> = {};
        if (scenario === "startup") {
          const prepared = await run({ startupStage: "prepare" });
          instrumentationOutput = prepared.stdout + prepared.stderr;
          await writeFile(path.join(artifactDirectory, `android-${mode}-${scenario}-prepare.log`), instrumentationOutput);
          expect(prepared.stdout).toContain("OK (");
          expect(prepared.stdout).not.toMatch(/FAILURES|INSTRUMENTATION_FAILED/u);
          const rawPrepared = /^INSTRUMENTATION_STATUS: voiceStartupPrepared=(.+)$/mu.exec(prepared.stdout)?.[1];
          expect(rawPrepared).toBeDefined();
          const saved = JSON.parse(rawPrepared!);
          restored = { startupStage: "restore", savedSettingsRevision: String(saved.settingsRevision), savedOriginClientId: saved.originClientId };
          await adb(["shell", "am", "force-stop", "dev.sedes.local"]);
          instrumentationOutput = "";
        }
        const result = await run(restored);
        instrumentationOutput = result.stdout + result.stderr;
        await writeFile(path.join(artifactDirectory, `android-${mode}-${scenario}.log`), instrumentationOutput);
        expect(result.stdout).toContain("OK (");
        expect(result.stdout).not.toMatch(/FAILURES|INSTRUMENTATION_FAILED/u);
        const rawResult = /^INSTRUMENTATION_STATUS: voiceResult=(.+)$/mu.exec(result.stdout)?.[1];
        expect(rawResult).toBeDefined();
        const evidence = JSON.parse(rawResult!);
        // Playback Next and Stop exercise speech without opening capture; other scenarios record after a start cue.
        const composerSubmission = scenario === "cycle" || scenario === "startup" || scenario === "record";
        expect(evidence).toMatchObject({ composerDraftMatchesExpected: true, serverDraftMatchesExpected: true,
          audioSource: scenario === "next" || playbackStop ? "none" : "deterministic-pcm", audioSink: "AudioTrack" });
        if (mode === "speak" && scenario !== "stop") expect(evidence.speechPlayback).toBe(true);
        expect(evidence.journalOutstanding).toBe(0);
        if (scenario === "record") {
          expect(evidence.playbackControl).toMatchObject({ action: "Record", sourceThreadId: threadId, autoListen: false,
            recognitionThreadId: threadId, automatic: false, voiceThreadId: secondThreadId, pinDefaultVoiceThread: true });
          expect(evidence.phases).toContain("listening");
        } else if (scenario === "next") {
          expect(evidence.playbackControl).toMatchObject({ action: "Next", sourceThreadId: threadId, autoListen: true, released: true });
          expect(evidence.captureChunks).toBe(0);
          expect(evidence.phases).not.toContain("listening");
          expect(evidence.phases).not.toContain("submitting");
          expect((await speech.observations()).transcriptions).toHaveLength(0);
        } else if (playbackStop) {
          expect(evidence.playbackControl).toMatchObject({ action: "Stop", surface: scenario === "playback-stop-notification" ? "notification" : "card",
            sourceThreadId: threadId, autoListen: true, queuedBeforeStop: 1,
            afterStop: { phase: "idle", active: null, queue: { count: 0 }, retainedVoiceTarget: { threadId }, settings: { audioMode: "speak", autoListen: true } }, inputPresentationEvents: 0 });
          expect(evidence.playbackControl.afterStop.idleTargetRevision).toBeGreaterThan(evidence.playbackControl.idleTargetRevisionBeforeStop);
          if (scenario === "playback-stop-notification") {
            expect(evidence.playbackControl.notification).toEqual({ title: threadTitle, status: "Speaking", stopLabel: "Stop", stopVisible: true, stopEnabled: true });
            expect(evidence.playbackControl.serviceDelivery).toBeGreaterThan(0);
          } else {
            expect(evidence.playbackControl.notification).toBeNull();
            expect(evidence.playbackControl.serviceDelivery).toBeNull();
          }
          expect(evidence.captureChunks).toBe(0);
          expect(evidence.inputAttempts).toBe(0);
          expect(evidence.mutationIds).toEqual([]);
          expect(evidence.phases).not.toContain("listening");
          expect(evidence.phases).not.toContain("announcing");
          expect(evidence.phases).not.toContain("submitting");
          const observations = await speech.observations();
          expect(observations.transcriptions).toHaveLength(0);
          expect(observations.speech).toHaveLength(1);
        }
        if (scenario === "cycle" || scenario === "record" || scenario === "background-switch") {
          expect(evidence.announceRecordingThread).toBe(true);
          const announcements = (await speech.observations()).speech.filter(request => request.text.startsWith("Replying to "));
          if (scenario === "background-switch") {
            expect(evidence.phases).toContain("announcing");
            expect(announcements).toHaveLength(1);
            expect(announcements[0]?.text).toBe(`Replying to ${secondThreadTitle}.`);
          } else {
            expect(evidence.phases).not.toContain("announcing");
            expect(announcements).toHaveLength(0);
          }
        }
        if (scenario === "retained-target") {
          const canonical = threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`));
          const viewedCanonical = threadInputContextSchema.parse(await app.json(`/api/threads/${secondThreadId!}/input-context`));
          expect(evidence.retainedTarget).toMatchObject({
            retainedAfterPlayback: { threadId, threadTitle: canonical.threadTitle },
            idleCardAfterNavigation: { foregroundThreadId: secondThreadId, path: `/threads/${secondThreadId}`, cardTitle: viewedCanonical.threadTitle,
              cardTargetEnabled: false, nativeCanReleaseRetainedTarget: true, retainedThreadId: secondThreadId, notificationThreadId: secondThreadId },
            replyPlayback: { sampleRate: 24_000, writtenFrames: 2400 },
            inputPresentationEvents: 0,
            notification: { title: viewedCanonical.threadTitle, startLabel: "Start", startEnabled: true,
              stopVisible: false, nextLabel: "Next", nextEnabled: true },
          });
          const captures = evidence.retainedTarget.captures;
          expect(captures).toHaveLength(3);
          for (const [index, surface, target, title, announces] of [[0, "notification", secondThreadId, viewedCanonical.threadTitle, true],
            [1, "card", secondThreadId, viewedCanonical.threadTitle, false], [2, "notification", secondThreadId, viewedCanonical.threadTitle, true]] as const) {
            const capture = captures[index];
            expect(capture).toMatchObject({ surface, recognitionThreadId: target, recognitionThreadTitle: title, announcedTitle: announces ? title : null,
              startCuePlayback: { sampleRate: 48_000, writtenFrames: 13_920 },
              afterCancel: { phase: "idle", active: null, recordingRecovery: null, retainedVoiceTarget: { threadId: target, threadTitle: title } } });
            expect(capture.captureChunks).toBeGreaterThan(0);
            if (announces) {
              expect(capture.announcementPlayback).toMatchObject({ requestId: capture.announcementRequestId, sampleRate: 24_000, writtenFrames: 2400 });
              expect(capture.phases.indexOf("announcing")).toBeGreaterThanOrEqual(0);
              expect(capture.phases.indexOf("arming")).toBeGreaterThan(capture.phases.indexOf("announcing"));
            } else {
              expect(capture.announcementRequestId).toBeNull();
              expect(capture.announcementPlayback).toBeNull();
              expect(capture.phases).not.toContain("announcing");
            }
            expect(capture.phases.indexOf("arming")).toBeGreaterThanOrEqual(0);
            expect(capture.phases.indexOf("listening")).toBeGreaterThan(capture.phases.indexOf("arming"));
          }
          expect(new Set(captures.map((capture: { recordingId: string }) => capture.recordingId)).size).toBe(3);
          type PlaybackDrain = { requestId: string; sampleRate: number; writtenFrames: number; playedFrames: number };
          const drains: PlaybackDrain[] = [evidence.retainedTarget.replyPlayback,
            ...captures.flatMap((capture: { announcementPlayback: PlaybackDrain | null; startCuePlayback: PlaybackDrain }) =>
              capture.announcementPlayback ? [capture.announcementPlayback, capture.startCuePlayback] : [capture.startCuePlayback])];
          expect(drains).toHaveLength(6);
          expect(new Set(drains.map(drain => drain.requestId)).size).toBe(6);
          for (const drain of drains) {
            expect(drain.requestId).toMatch(/^[0-9a-f-]{36}$/u);
            expect(drain.writtenFrames).toBeGreaterThan(0);
            expect(drain.playedFrames).toBeGreaterThanOrEqual(drain.writtenFrames);
          }
          const releases = evidence.retainedTarget.releases;
          expect(releases).toHaveLength(2);
          for (const [index, surface, target, title] of [[0, "notification", secondThreadId, viewedCanonical.threadTitle],
            [1, "card", secondThreadId, viewedCanonical.threadTitle]] as const) {
            const release = releases[index];
            expect(release).toMatchObject({ surface, retainedBeforeRelease: { threadId: target, threadTitle: title }, retainedAfterRelease: null,
              foregroundThreadId: null, path: "/settings/voice",
              cardTitle: viewedCanonical.threadTitle, cardTargetEnabled: false,
              voiceThreadId: secondThreadId, pinDefaultVoiceThread: false,
              sourceDraftPreserved: true, secondDraftPreserved: true });
            expect(release.releasedIdleTargetRevision).toBeGreaterThan(release.cancelledIdleTargetRevision);
          }
          for (const stale of [evidence.retainedTarget.afterStaleStart, evidence.retainedTarget.afterStaleNext]) {
            expect(stale).toMatchObject({ phase: "idle", active: null, idleTargetRevision: captures[0].afterCancel.idleTargetRevision,
              retainedVoiceTarget: captures[0].afterCancel.retainedVoiceTarget });
          }
          const deliveries: number[] = evidence.retainedTarget.notificationServiceDeliveries;
          expect(deliveries).toHaveLength(5);
          for (let i = 1; i < deliveries.length; i += 1) expect(deliveries[i]).toBeGreaterThan(deliveries[i - 1]!);
          expect(evidence.inputAttempts).toBe(0);
          expect(evidence.mutationIds).toEqual([]);
          expect(evidence.phases.indexOf("announcing")).toBeGreaterThanOrEqual(0);
          expect(evidence.phases.indexOf("arming")).toBeGreaterThan(evidence.phases.indexOf("announcing"));
          expect(evidence.phases.indexOf("listening")).toBeGreaterThan(evidence.phases.indexOf("arming"));
          expect(evidence.phases).not.toContain("submitting");
          const observations = await speech.observations();
          expect(observations.speech.filter(request => request.text === `Replying to ${canonical.threadTitle}.`)).toHaveLength(0);
          expect(observations.speech.filter(request => request.text === `Replying to ${viewedCanonical.threadTitle}.`)).toHaveLength(2);
          expect(observations.speech.filter(request => request.text.startsWith("Replying to "))).toHaveLength(2);
          expect(observations.transcriptions).toHaveLength(0);
          const source = await app.thread(threadId), viewed = await app.thread(secondThreadId!);
          expect(viewed.draft.text).toBe(args.secondDraftText);
          expect(Object.values(source.itemsById).filter(item => item.kind === "user_message")).toHaveLength(1);
          expect(Object.values(viewed.itemsById).filter(item => item.kind === "user_message")).toHaveLength(0);
        }
        if (scenario === "cycle") {
          expect(evidence.inputUi).toMatchObject({ rowCount: 1, provisional: false, routineLabelCount: 0,
            seekEnabled: mode === "input", source: "composer", threadId });
          expect(evidence.nativeInputPresentationEvents).toBe(0);
          expect(evidence.inputAttempts).toBe(0);
          expect(evidence.inputUi.operationId).toMatch(/^[0-9a-f-]{36}$/u);
          expect(evidence.inputUi.text).toContain(text);
          expect(evidence.inputUi.viewportHeight).toBeGreaterThan(0);
          if (mode === "input") {
            expect(evidence.inputUi.spacerHeight).toBeGreaterThan(0);
            expect(Math.abs(evidence.inputUi.targetInset - 16)).toBeLessThanOrEqual(3);
          } else expect(evidence.inputUi.spacerHeight).toBe(0);
        }
        if (scenario === "background-switch") {
          expect(evidence.backgroundSwitch).toMatchObject({ recognitionThreadId: secondThreadId, foreground: false,
            replyPlayedBeforeRecognition: true, navigationEvents: 0, resumedPath: `/threads/${threadId}`,
            autoListen: false, voiceThreadId: threadId, pinDefaultVoiceThread: true,
            inputPresentationEvents: 0, receipt: { threadId: secondThreadId, admittedMode: "submit" } });
          // Native MCP can wrap the tool result in a text envelope. Recognition after settlement also proves acceptance.
          const toolResults = app.model.requests.slice(before).flatMap(request => request.toolResults).join("\n").replaceAll('\\"', '"');
          expect(toolResults).toMatch(/"foreground"\s*:\s*false/u);
          expect(toolResults).toMatch(/"voiceReady"\s*:\s*true/u);
        }
        // Foreground composer sends consume the whole draft; native routes leave it untouched.
        expect((await app.thread(threadId)).draft.text).toBe(composerSubmission ? "" : args.draftText);
        const deliveredText = composerSubmission ? `${text}\n\n${args.draftText}` : text;
        const submissions = () => app.model.requests.slice(before).filter(request => request.lastRole === "user" && request.lastText === deliveredText);
        // A definitive admission receipt may precede asynchronous provider dispatch.
        const submitsReply = scenario !== "stop" && scenario !== "next" && !playbackStop && scenario !== "retained-target";
        if (submitsReply) await waitForSpeech(() => submissions().length > 0);
        expect(submissions()).toHaveLength(submitsReply ? 1 : 0);
        if (composerSubmission) {
          expect(evidence.nativeInputPresentationEvents).toBe(0);
          expect(evidence.inputAttempts).toBe(0);
          await app.waitFor(async () => Object.values((await app.thread(threadId)).itemsById).some(item =>
            item.kind === "user_message" && (scenario === "cycle" ? item.deliveryOperationId === evidence.inputUi.operationId : item.content.some(part => part.kind === "text" && part.text.text.includes(text)))));
          const userRows = Object.values((await app.thread(threadId)).itemsById).filter(item =>
            item.kind === "user_message" && (scenario === "cycle" ? item.deliveryOperationId === evidence.inputUi.operationId : item.content.some(part => part.kind === "text" && part.text.text.includes(text))));
          expect(userRows).toHaveLength(1);
          expect(userRows[0]).toMatchObject({ content: [{ kind: "text", text: { text: deliveredText } }] });
          if (scenario === "cycle") expect(userRows[0]).toMatchObject({ kind: "user_message", deliveryOperationId: evidence.inputUi.operationId });
        }
        if (mode === "input") expect((await speech.observations()).speech.length).toBe(ttsBefore);
        if (secondThreadId && scenario !== "retained-target") {
          if (scenario === "background-switch") await app.waitFor(async () => Object.values((await app.thread(secondThreadId)).itemsById)
            .some(item => item.kind === "user_message" && item.deliveryOperationId === evidence.backgroundSwitch.receipt.operationId));
          const target = await app.thread(scenario === "record" ? threadId : secondThreadId);
          expect(JSON.stringify(target)).toContain(text);
          expect(JSON.stringify(await app.thread(scenario === "record" ? secondThreadId : threadId))).not.toContain(text);
          if (scenario === "background-switch") expect(Object.values(target.itemsById).filter(item =>
            item.kind === "user_message" && item.deliveryOperationId === evidence.backgroundSwitch.receipt.operationId)).toHaveLength(1);
        }
        await writeFile(diagnosticPath, JSON.stringify({ mode, scenario, ...await observer.report(false) }, null, 2));
      } catch (failure) {
        scenarioFailed = true;
        if (!instrumentationOutput && failure && typeof failure === "object") {
          const output = failure as { stdout?: unknown; stderr?: unknown };
          instrumentationOutput = [output.stdout, output.stderr].filter(value => typeof value === "string").join("");
        }
        const diagnostics = { mode, scenario, native: nativeEvidence(instrumentationOutput), ...await observer.report(true) };
        try {
          await writeFile(path.join(artifactDirectory, `android-${mode}-${scenario}.log`), instrumentationOutput);
          await writeFile(diagnosticPath, JSON.stringify(diagnostics, null, 2));
        } catch (artifactError) { console.error("Could not save Android voice failure artifacts:", artifactError); }
        // Include the useful evidence in the test failure itself, even when artifact collection is unavailable.
        throw new Error(`Android voice ${mode}/${scenario} failed. Voice diagnostics (${diagnosticPath}): ${JSON.stringify(diagnostics)}`, { cause: failure });
      } finally {
        await observer.close();
        try {
          const screenshotDirectory = path.join(artifactDirectory, `android-${mode}-${scenario}-screenshots`);
          await mkdir(screenshotDirectory, { recursive: true });
          await adb(["pull", "/sdcard/Android/data/dev.sedes.local/files/native-voice/", screenshotDirectory], 60_000)
            .catch(async error => { await writeFile(path.join(screenshotDirectory, "capture-error.txt"), String(error)); });
          const logcat = await adb(["logcat", "-d", "-t", "1500"]);
          await writeFile(path.join(artifactDirectory, `android-${mode}-${scenario}-logcat.log`), logcat.stdout);
        } catch (captureFailure) {
          if (!scenarioFailed) throw captureFailure;
          console.error("Android voice failure artifact capture also failed:", captureFailure);
        }
      }
    }, 360_000);
  }
});

// adb shell reparses the remote command; execFile alone cannot protect spaces.
function shellArgument(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

type VoiceFrame = { event: string; id?: string; value: any };
async function transcribeFixtureAudio(speech: Awaited<ReturnType<typeof startOpenAiSpeechFixture>>, pcm: Buffer) {
  const socket = new WebSocket(`${speech.endpoint.replace(/^http/u, "ws")}/realtime?intent=transcription`, {
    headers: { authorization: `Bearer ${speech.token}` },
  });
  const events: Record<string, any>[] = [];
  socket.on("message", data => events.push(JSON.parse(data.toString())));
  let socketError: Error | undefined;
  socket.on("error", error => { socketError = error; });
  const next = (type: string) => waitForSpeech(() => {
    if (socketError) throw socketError;
    return events.find(event => event.type === type);
  });
  try {
    const created = await next("session.created");
    socket.send(JSON.stringify({ type: "session.update", session: { type: "transcription", audio: { input: {
      format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "parakeet-local" }, turn_detection: null, noise_reduction: null,
    } } } }));
    const updated = await next("session.updated");
    expect(updated.session.id).toBe(created.session.id);
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    const committed = await next("input_audio_buffer.committed");
    const completed = await next("conversation.item.input_audio_transcription.completed");
    expect(completed).toMatchObject({ item_id: committed.item_id, content_index: 0 });
    expect(events.filter(event => event.type === "conversation.item.input_audio_transcription.completed")).toHaveLength(1);
    return { completed, events };
  } finally { socket.terminate(); }
}

async function createVoiceCodexThread(app: OpenCodeProductionFixture, socketPath: string, backendId: string): Promise<string> {
  const snapshot = await app.configuration();
  snapshot.configuration.backends.push({ id: backendId, kind: "codex_app_server", label: "Early reply fixture",
    enabled: true, modelPolicy: { type: "catalog" }, moduleConfiguration: {
      connection: { ownership: "external", channel: { type: "unix_websocket", socketPath } },
      policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["never"], allowedApprovalReviewers: ["user"] },
    } });
  snapshot.configuration.targets.push({ id: `${backendId}-target`, kind: "codex_app_server", label: "Early reply",
    backendInstanceId: backendId, enabled: true, executionEnvironmentId: app.environmentId, moduleConfiguration: {
      defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user", model: { type: "catalogDefault" } },
    } });
  await app.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration: snapshot.configuration });
  const target = await waitForSpeech(async () => (await app.snapshot()).executionTargets.find(entry => entry.backendInstanceId === backendId && entry.available));
  const workspace = await app.json("/api/workspaces/open", "POST", { path: app.workspace, environmentId: app.environmentId, project: { kind: "new", name: "workspace" } }) as { id: string };
  const { threadId } = await app.json("/api/threads", "POST", { workspaceId: workspace.id, title: "Early playback qualification",
    executionWorkspace: { kind: "direct" }, configuration: { kind: "custom", targetId: target.id } }) as { threadId: string };
  await app.openStream(threadId);
  return threadId;
}

export async function voiceFeed(app: OpenCodeProductionFixture, onFrame?: (frame: VoiceFrame) => void,
  nativeStream?: { readonly voiceStreamId: string; readonly earlyReply?: "on" | "off" }) {
  const controller = new AbortController();
  const endpoint = new URL("/api/application/events", app.url);
  if (nativeStream) {
    endpoint.searchParams.set("voiceStreamId", nativeStream.voiceStreamId);
    endpoint.searchParams.set("earlyReply", nativeStream.earlyReply ?? "off");
    endpoint.searchParams.set("earlyRevision", "0");
  }
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${app.credential}` }, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`SSE open failed: ${response.status}`);
  const frames: VoiceFrame[] = [];
  const reader = response.body.getReader();
  const done = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/gu, "\n");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event: ?(.+)$/mu.exec(raw)?.[1];
          const data = /^data: ?(.+)$/mu.exec(raw)?.[1];
          const id = /^id: ?(.+)$/mu.exec(raw)?.[1];
          if (event && data) {
            const frame = { event, value: JSON.parse(data), ...(id ? { id } : {}) };
            frames.push(frame); onFrame?.(frame);
          }
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  // Preserve the close() rejection without leaving a failed observer unhandled during a long device run.
  void done.catch(() => undefined);
  return { frames, async close() { controller.abort(); await done; } };
}

function nativeEvidence(output: string): unknown {
  const failure = /^INSTRUMENTATION_STATUS: voiceFailure=(.+)$/mu.exec(output)?.[1];
  const completed = /^INSTRUMENTATION_STATUS: voiceResult=(.+)$/mu.exec(output)?.[1];
  const value = failure ?? completed;
  if (!value) return { unavailable: "Instrumentation did not report its state." };
  try { return { status: failure ? "failed" : "completed", value: JSON.parse(value) }; }
  catch { return { unavailable: "Instrumentation state was invalid JSON." }; }
}

async function inputContextEvidence(app: OpenCodeProductionFixture, threadId: string) {
  const requestedAt = new Date().toISOString();
  try {
    const response = await fetch(`${app.url}/api/threads/${threadId}/input-context`, {
      headers: { Authorization: `Bearer ${app.credential}` }, signal: AbortSignal.timeout(5_000),
    });
    const context = threadInputContextSchema.safeParse(await response.json());
    return { requestedAt, receivedAt: new Date().toISOString(), threadId, httpStatus: response.status,
      ...(context.success ? { inputContext: context.data } : { invalidInputContext: context.error.issues.map(issue => ({ path: issue.path, code: issue.code })) }) };
  } catch (error) {
    return { requestedAt, threadId, readError: error instanceof Error ? error.name : typeof error };
  }
}

async function observeScenarioVoice(app: OpenCodeProductionFixture, threadIds: string[]) {
  type Observation = { receivedAt: string; envelope: unknown; contextAtNotification?: Awaited<ReturnType<typeof inputContextEvidence>> };
  const notifications: Observation[] = [];
  const pending = new Set<Promise<void>>();
  let latestPolicy: unknown = null;
  let streamError: string | undefined;
  let stopped = false;
  const feed = await voiceFeed(app, frame => {
    if (frame.event === "notification_policy") {
      const parsed = notificationSettingsSchema.safeParse(frame.value.settings);
      latestPolicy = parsed.success ? { receivedAt: new Date().toISOString(), generation: frame.value.generation,
        enabled: parsed.data.enabled, silenced: parsed.data.silenced, revision: parsed.data.revision, delivery: parsed.data.delivery }
        : { invalidPolicy: true };
      return;
    }
    if (frame.event !== "notification") return;
    const parsed = voiceNotificationSchema.safeParse(frame.value);
    if (!parsed.success) {
      notifications.push({ receivedAt: new Date().toISOString(), envelope: { invalidNotification: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) } });
      if (notifications.length > 16) notifications.shift();
      return;
    }
    const value = parsed.data;
    const threadId = value.recognitionTarget?.threadId ?? value.payload.thread?.id;
    if (!threadId || !threadIds.includes(threadId)) return;
    const observation: Observation = { receivedAt: new Date().toISOString(), envelope: {
      sourceEventId: value.sourceEventId, generation: value.generation, voice: value.voice,
      notificationId: value.payload.notificationId, event: value.payload.event,
      threadId: value.payload.thread?.id, turnId: value.payload.turn?.id,
      recognitionTarget: value.recognitionTarget ?? null, origin: value.origin ?? null,
    } };
    notifications.push(observation);
    if (notifications.length > 16) notifications.shift();
    // Sample authority when the server emits the notice, without delaying its delivery or the device scenario.
    const read = inputContextEvidence(app, threadId).then(context => { observation.contextAtNotification = context; }).finally(() => { pending.delete(read); });
    pending.add(read);
  });
  const close = async () => {
    if (stopped) return;
    stopped = true;
    try { await feed.close(); } catch (error) { streamError = error instanceof Error ? error.name : typeof error; }
    await Promise.allSettled([...pending]);
  };
  return { close, async report(failed: boolean) {
    const atFailure = failed ? Promise.all(threadIds.map(threadId => inputContextEvidence(app, threadId))) : undefined;
    await close();
    return { latestPolicy, notifications, ...(streamError ? { streamError } : {}),
      ...(atFailure ? { atFailure: await atFailure } : {}) };
  } };
}
