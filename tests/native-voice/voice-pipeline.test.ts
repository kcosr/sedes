import { randomUUID } from "node:crypto";
import { execFile as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notificationSettingsSchema, voiceNotificationSchema } from "../../src/shared/protocol/notification.js";
import { directInputReceiptSchema, threadInputContextSchema } from "../../src/shared/protocol/thread-input.js";
import { startVoiceAdapterFixture, waitForVoice } from "../support/voice-adapter-fixture.js";
import { OpenCodeProductionFixture } from "../support/opencode-production-fixture.js";

const execFile = promisify(execCallback);
const androidSerial = process.env.SEDES_VOICE_ANDROID_SERIAL;
const adbPath = process.env.SEDES_ADB_EXECUTABLE ?? (process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "platform-tools/adb") : "adb");
async function adb(args: string[], timeout = 30_000) {
  if (!androidSerial) throw new Error("An explicit isolated emulator serial is required.");
  return execFile(adbPath, ["-s", androidSerial, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
}

describe("native voice production pipeline with loopback providers", () => {
  let adapter: Awaited<ReturnType<typeof startVoiceAdapterFixture>>;
  let app: OpenCodeProductionFixture;
  let artifactDirectory: string;
  let androidInstalled = false;
  const reversePorts = new Set<number>();
  beforeAll(async () => {
    await mkdir(path.resolve("test-results"), { recursive: true });
    artifactDirectory = await mkdtemp(path.resolve("test-results/voice-run-"));
    console.log(`Voice artifacts: ${artifactDirectory}`);
    adapter = await startVoiceAdapterFixture(artifactDirectory);
    app = await OpenCodeProductionFixture.create("local", "external", { packagedClients: ["android"] });
    const { revision, silenced: _silenced, ...settings } = notificationSettingsSchema.parse(await app.json("/api/application/notifications"));
    await app.json("/api/application/notifications", "PUT", { ...settings, enabled: true, expectedRevision: revision });
    if (androidSerial) {
      expect((await adb(["shell", "getprop", "ro.kernel.qemu"])).stdout.trim(), "Use a disposable emulator; the harness clears its Sedes application state.").toBe("1");
      await adb(["install", "-r", path.resolve("android/app/build/outputs/apk/debug/app-debug.apk")], 90_000);
      androidInstalled = true;
      await adb(["install", "-r", path.resolve("android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk")], 90_000);
      await adb(["reverse", `tcp:${app.port}`, `tcp:${app.port}`]);
      reversePorts.add(app.port);
      await adb(["reverse", `tcp:${adapter.port}`, `tcp:${adapter.port}`]);
      reversePorts.add(adapter.port);
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
    if (adapter) await cleanup(() => adapter.close());
    if (errors.length) throw new AggregateError(errors, "Voice fixture cleanup failed");
  });

  it("uses real adapter capability negotiation, PCM, ASR finalization cancellation and reconnect", async () => {
    const client = await adapter.connect();
    try {
      expect((await adapter.post("/api/media/tts", { clientId: client.clientId, requestId: "tts-contract", text: "**Fixture:** `voice`" })).status).toBe(202);
      expect(await client.next("media_tts_end", "tts-contract")).toMatchObject({ status: "completed" });
      const chunks = client.messages.filter(message => message.type === "media_tts_audio_chunk" && message.requestId === "tts-contract");
      expect(chunks).toHaveLength(2);
      expect(chunks.every(chunk => chunk.sampleRate === 24_000 && chunk.encoding === "pcm_s16le")).toBe(true);
      expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.chunkBase64 as string, "base64")))).toEqual(adapter.pcm);
      expect(adapter.texts.at(-1)).toBe("Fixture: voice");
      adapter.transcripts.push("voice contract input");
      const recognize = (requestId: string) => {
        client.socket.send(JSON.stringify({ type: "media_stt_start", requestId, sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" }));
        client.socket.send(JSON.stringify({ type: "media_stt_chunk", requestId, chunkBase64: adapter.pcm.toString("base64") }));
        client.socket.send(JSON.stringify({ type: "media_stt_end", requestId }));
      };
      recognize("stt-contract");
      expect(await client.next("media_stt_result", "stt-contract")).toMatchObject({ success: true, text: "voice contract input" });
      expect(adapter.wavs.at(-1)?.subarray(44)).toEqual(adapter.pcm);
      const trace = client.messages.filter(message => message.requestId === "stt-contract").map(message => message.type);
      // Capture stops before provider recognition starts; both must be present for the order to mean anything.
      expect(trace).toContain("media_stt_stopped");
      expect(trace).toContain("media_stt_started");
      expect(trace.indexOf("media_stt_stopped")).toBeLessThan(trace.indexOf("media_stt_started"));
      adapter.setAsrDelay(500);
      adapter.transcripts.push("must not submit after cancel");
      recognize("stt-cancel");
      await client.next("media_stt_started", "stt-cancel");
      expect((await adapter.post("/api/media/stt/cancel", { clientId: client.clientId, requestId: "stt-cancel" })).status).toBe(200);
      expect(await client.next("media_stt_result", "stt-cancel")).toMatchObject({ canceled: true, success: false });
      adapter.setAsrDelay(0);
      const second = await adapter.connect();
      expect(second.clientId).not.toBe(client.clientId);
      second.socket.terminate();
      expect(adapter.errors).toEqual([]);
    } finally { adapter.setAsrDelay(0); client.socket.terminate(); }
  });

  it("admits content once without touching drafts, emits a live voice completion, and never replays it", async () => {
    const threadId = await app.createThread();
    const otherThreadId = await app.createThread();
    const initial = await app.thread(threadId);
    await app.json(`/api/threads/${threadId}/draft`, "PUT", {
      text: "Keep this unsent composer draft", contextExcerpts: [], attachmentIds: [], taskReferenceIds: [], expectedRevision: initial.draft.revision,
    });
    const savedDraft = (await app.thread(threadId)).draft;
    const feed = await voiceFeed(app);
    try {
      await waitForVoice(() => feed.frames.find(frame => frame.event === "notification_policy"));
      const input = { mutationId: randomUUID(), text: "First spoken production fixture input", origin: { clientId: randomUUID() }, runningPolicy: { mode: "queue" } };
      const receipt = directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", input));
      expect(receipt, JSON.stringify(receipt)).toMatchObject({ mutationId: input.mutationId, threadId, admittedMode: "submit", status: "accepted" });
      const frame = await waitForVoice(() => feed.frames.find(frame => frame.event === "notification" && frame.value.payload?.thread?.id === threadId));
      const notification = voiceNotificationSchema.parse(frame.value);
      expect(frame.id).toBeUndefined();
      expect(notification).toMatchObject({ voice: "speakThenListen", origin: input.origin, payload: { event: "turn.completed" } });
      expect(notification.recognitionTarget?.threadId).toBe(threadId);
      const context = threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`));
      expect(context).toMatchObject({ authority: "current", automaticListenEligible: true, activityToken: notification.recognitionTarget?.activityToken });
      expect((await app.thread(threadId)).draft).toEqual(savedDraft);
      expect(directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", input))).toEqual(receipt);
      expect(await app.json(`/api/input-receipts/${input.mutationId}`)).toEqual({ status: "found", receipt });
      expect((await app.request(`/api/threads/${otherThreadId}/inputs`, "POST", input)).status).toBe(409);
      expect(app.model.requests.filter(request => request.lastRole === "user" && request.lastText === input.text)).toHaveLength(1);
      const reconnected = await voiceFeed(app);
      try {
        await waitForVoice(() => reconnected.frames.find(frame => frame.event === "notification_policy"));
        // A later policy frame on the same ordered transient lane is the sentinel: a
        // replay queued for this subscriber would have to arrive before it.
        const { revision, silenced: _silenced, ...settings } = notificationSettingsSchema.parse(await app.json("/api/application/notifications"));
        await app.json("/api/application/notifications", "PUT", { ...settings, expectedRevision: revision });
        await waitForVoice(() => reconnected.frames.find(frame => frame.event === "notification_policy" &&
          notificationSettingsSchema.safeParse(frame.value.settings).data?.revision === revision + 1));
        expect(reconnected.frames.filter(frame => frame.event === "notification")).toEqual([]);
      } finally { await reconnected.close(); }

      // JSON expansion may exceed the application's ordinary 256 KiB parser,
      // while the exact unescaped content still fits the 64 KiB contract.
      const escaped = { ...input, mutationId: randomUUID(), text: "\u0001".repeat(50_000) };
      expect(JSON.stringify(escaped).length).toBeGreaterThan(256 * 1024);
      const oversizedText = { ...input, mutationId: randomUUID(), text: "é".repeat(32_769) };
      expect((await app.request(`/api/threads/${threadId}/inputs`, "POST", oversizedText)).status).toBe(400);
      const overParser = { ...input, mutationId: randomUUID(), text: "\u0001".repeat(90_000) };
      expect((await app.request(`/api/threads/${threadId}/inputs`, "POST", overParser)).status).toBe(413);
      expect((await app.request(`/api/threads/${threadId}/inputs`, "POST", escaped)).status).toBe(200);
    } finally { await feed.close(); }
  });

  it.skipIf(!androidSerial)("validates Android Keystore recovery, cancellation, and real AudioRecord/AudioTrack", async () => {
    const result = await adb(["shell", "am", "instrument", "-w", "-r", "-e", "class",
      "dev.sedes.local.NativeVoiceStoreTest,dev.sedes.local.ClientCredentialStoreTest,dev.sedes.local.NativeVoiceQueueDeviceTest," +
      "dev.sedes.local.NativeVoiceRuntimeTest,dev.sedes.local.NativeVoiceStartupTest,dev.sedes.local.NativeVoiceAudioTest", "dev.sedes.local.test/androidx.test.runner.AndroidJUnitRunner"], 180_000);
    await writeFile(path.join(artifactDirectory, "android-native-smoke.log"), result.stdout + result.stderr);
    expect(result.stdout).toContain("OK (");
    expect(result.stdout).not.toMatch(/FAILURES|INSTRUMENTATION_FAILED/u);
  });

  for (const [mode, scenario] of [["response", "cycle"], ["manual", "cycle"], ["response", "background"],
    ["response", "startup"], ["manual", "startup"],
    ["response", "skip"], ["response", "stop"], ["response", "retarget"],
    ["response", "lost-ack"], ["response", "lost-send"], ["response", "cancel-uncertain"]] as const) {
    it.skipIf(!androidSerial)(`runs packaged Android ${mode}/${scenario} through the actual UI and media stack`, async () => {
      await adb(["shell", "pm", "clear", "dev.sedes.local"]);
      const threadTitle = `Voice ${mode} ${scenario}`;
      const threadId = await app.createThread(threadTitle);
      const secondThreadTitle = `Retarget ${mode} ${scenario}`;
      const secondThreadId = scenario === "retarget" ? await app.createThread(secondThreadTitle) : undefined;
      const pairingCode = app.authentication.createPairing({ kind: "management" }).token;
      const text = `voice fixture reply ${mode} ${scenario}`;
      adapter.transcripts.splice(0, adapter.transcripts.length, text, "");
      // Give the real playback action a usable window even on software emulators.
      adapter.setTtsDurationSeconds(scenario === "skip" ? 12 : 1);
      const before = app.model.requests.length;
      const ttsBefore = adapter.texts.length;
      const args = { serverOrigin: app.url, adapterOrigin: adapter.url, pairingCode, threadId, threadTitle, mode, scenario,
        initialText: `native voice fixture start ${mode} ${scenario}`, draftText: `unsent voice fixture draft ${mode} ${scenario}`,
        ...(secondThreadId ? { secondThreadId, secondThreadTitle } : {}) };
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
        // Every scenario records after a start cue, so a real AudioTrack always plays; Response speech is observed separately.
        expect(evidence).toMatchObject({ draftPreserved: true, composerDraftPreserved: true, serverDraftPreserved: true,
          audioSource: "deterministic-pcm", audioSink: "AudioTrack" });
        if (mode === "response" && scenario !== "stop") expect(evidence.speechPlayback).toBe(true);
        expect(evidence.journalOutstanding).toBe(0);
        // The device polled Sedes for the autosaved draft; confirm it is still the unsent composer text.
        expect((await app.thread(threadId)).draft.text).toBe(args.draftText);
        const submissions = () => app.model.requests.slice(before).filter(request => request.lastRole === "user" && request.lastText === text);
        // A definitive admission receipt may precede asynchronous provider dispatch.
        if (scenario !== "stop") await waitForVoice(() => submissions().length > 0);
        expect(submissions()).toHaveLength(scenario === "stop" ? 0 : 1);
        if (mode === "manual") expect(adapter.texts.length).toBe(ttsBefore);
        if (secondThreadId) {
          const target = await app.thread(secondThreadId);
          expect(JSON.stringify(target)).toContain(text);
          expect(JSON.stringify(await app.thread(threadId))).not.toContain(text);
        }
        expect(adapter.errors).toEqual([]);
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
export async function voiceFeed(app: OpenCodeProductionFixture, onFrame?: (frame: VoiceFrame) => void) {
  const controller = new AbortController();
  const response = await fetch(`${app.url}/api/application/events`, { headers: { Authorization: `Bearer ${app.credential}` }, signal: controller.signal });
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
