import { createHash, randomUUID } from "node:crypto";
import { execFile as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { notificationSettingsSchema, voiceNotificationSchema } from "../../src/shared/protocol/notification.js";
import { directInputReceiptSchema, MAX_DIRECT_INPUT_REQUEST_BYTES, MAX_DIRECT_INPUT_TEXT_BYTES, threadInputContextSchema } from "../../src/shared/protocol/thread-input.js";
import { clientPollResultSchema, registeredClientSchema } from "../../src/shared/protocol/client-controls.js";
import { startOpenAiSpeechFixture, waitForSpeech } from "../support/openai-speech-fixture.js";
import { OpenCodeProductionFixture } from "../support/opencode-production-fixture.js";

const execFile = promisify(execCallback);
const androidSerial = process.env.SEDES_VOICE_ANDROID_SERIAL;
const adbPath = process.env.SEDES_ADB_EXECUTABLE ?? (process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "platform-tools/adb") : "adb");
async function adb(args: string[], timeout = 30_000) {
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
    const socket = new WebSocket(`${speech.endpoint.replace(/^http/u, "ws")}/realtime?intent=transcription`, {
      headers: { authorization: `Bearer ${speech.token}` },
    });
    const events: Record<string, any>[] = [];
    socket.on("message", data => events.push(JSON.parse(data.toString())));
    let socketError: Error | undefined;
    socket.on("error", error => { socketError = error; });
    const next = (type: string) => waitForSpeech(() => { if (socketError) throw socketError; return events.find(event => event.type === type); });
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
      expect(completed).toMatchObject({ item_id: committed.item_id, content_index: 0, transcript: "voice contract input" });
      expect(events.filter(event => event.type === "conversation.item.input_audio_transcription.completed")).toHaveLength(1);
      const observations = await speech.observations();
      expect(observations.speech.at(-1)?.text).toBe("Fixture voice");
      expect(observations.transcriptions.at(-1)).toMatchObject({ sampleRate: 16000, bytes: 32000 });
    } finally { socket.terminate(); }
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
      expect(notification).toMatchObject({ voice: "speakThenListen", origin: { clientId: registration.clientId }, payload: { event: "turn.completed" } });
      expect(notification.recognitionTarget?.threadId).toBe(threadId);
      const context = threadInputContextSchema.parse(await app.json(`/api/threads/${threadId}/input-context`));
      expect(context).toMatchObject({ authority: "current", automaticListenEligible: true, activityToken: notification.recognitionTarget?.activityToken });
      expect((await app.thread(threadId)).draft).toEqual(savedDraft);
      expect(directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", input, clientHeaders))).toEqual(receipt);
      expect(await app.json(`/api/input-receipts/${input.mutationId}`)).toEqual({ status: "found", receipt });
      expect((await app.request(`/api/threads/${otherThreadId}/inputs`, "POST", input, clientHeaders)).status).toBe(409);
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
      const escaped = { ...input, mutationId: randomUUID(), text: "\u0001".repeat(MAX_DIRECT_INPUT_TEXT_BYTES) };
      expect(JSON.stringify(escaped).length).toBeGreaterThan(256 * 1024);
      expect(Buffer.byteLength(escaped.text)).toBe(MAX_DIRECT_INPUT_TEXT_BYTES);
      expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThan(MAX_DIRECT_INPUT_REQUEST_BYTES);
      const oversizedText = { ...input, mutationId: randomUUID(), text: "é".repeat(MAX_DIRECT_INPUT_TEXT_BYTES / 2 + 1) };
      expect(Buffer.byteLength(oversizedText.text)).toBeGreaterThan(MAX_DIRECT_INPUT_TEXT_BYTES);
      expect((await app.request(`/api/threads/${threadId}/inputs`, "POST", oversizedText, clientHeaders)).status).toBe(400);
      const overParser = { ...input, mutationId: randomUUID(), text: "\u0001".repeat(Math.floor(MAX_DIRECT_INPUT_REQUEST_BYTES / 6) + 1) };
      expect(Buffer.byteLength(JSON.stringify(overParser))).toBeGreaterThan(MAX_DIRECT_INPUT_REQUEST_BYTES);
      expect((await app.request(`/api/threads/${threadId}/inputs`, "POST", overParser, clientHeaders)).status).toBe(413);
      expect((await app.request(`/api/threads/${threadId}/inputs`, "POST", escaped, clientHeaders)).status).toBe(200);
    } finally { await feed.close(); }
  });

  it("routes a real native client tool to the submitting registration and settles it with the published reply", async () => {
    const threadId = await app.createThread("Client control source");
    const destination = await app.createThread("Client control destination");
    const policy = (await app.thread(threadId)).agentTools;
    await app.json(`/api/threads/${threadId}/operations`, "POST", {
      kind: "set_agent_tool_policy", mutationId: randomUUID(), expectedPolicyRevision: policy.revision,
      enabled: true, enabledToolIds: ["client.switch_thread"], accessBoundary: "environment",
      presentation: { surface: "native", mode: "progressive" },
    });
    await app.send(threadId, "Discover client controls");
    await app.waitFor(async () => app.model.requests.some(request => request.lastText === "Discover client controls"));
    await app.waitFor(async () => JSON.stringify((await app.thread(threadId)).itemsById).includes("Fixture response"));
    await app.waitFor(async () => (await app.thread(threadId)).runState === "idle");
    const nativeTool = app.model.requests.flatMap(request => request.toolNames).find(name => name.endsWith("_sedes_act"));
    expect(nativeTool).toBeDefined();
    const state = { runtime: { foreground: true, voiceReady: false, interactionActive: false }, settings: null };
    const registration = registeredClientSchema.parse(await app.json("/api/client-registration", "POST", {
      platform: "browser", capabilities: { navigate: true, voice: false, voiceSettings: false }, state,
    }));
    const clientHeaders = { "X-Sedes-Client": registration.connectionToken };
    const feed = await voiceFeed(app);
    try {
      await waitForSpeech(() => feed.frames.find(frame => frame.event === "notification_policy"));
      const marker = "Switch this client after the reply";
      app.model.callToolNextStream(marker, nativeTool!, { toolId: "client.switch_thread", schemaVersion: 1,
        input: { threadId: destination, listen: false } });
      const receipt = directInputReceiptSchema.parse(await app.json(`/api/threads/${threadId}/inputs`, "POST", {
        mutationId: randomUUID(), text: marker, runningPolicy: { mode: "queue" },
      }, clientHeaders));
      expect(["accepted", "queued", "submitting"]).toContain(receipt.status);
      const delivery = clientPollResultSchema.parse(await app.json("/api/client-controls/poll", "POST", { state, acknowledgements: [] }, clientHeaders));
      expect(delivery.commands).toHaveLength(1);
      const command = delivery.commands[0]!;
      expect(command).toMatchObject({ action: "switch_thread", sourceThreadId: threadId, threadId: destination, listen: false });
      expect(feed.frames.some(frame => frame.event === "notification" && frame.value.payload?.turn?.id === command.sourceTurnId)).toBe(false);
      const settlementRequestedAt = Date.now();
      const settlement = clientPollResultSchema.parse(await app.json("/api/client-controls/poll", "POST", {
        state, acknowledgements: [{ id: command.id, result: { status: "accepted", reason: "after_turn_completion", state } }],
      }, clientHeaders));
      expect(settlement.commands).toHaveLength(1);
      const reply = voiceNotificationSchema.parse((await waitForSpeech(() => feed.frames.find(frame =>
        frame.event === "notification" && frame.value.payload?.turn?.id === command.sourceTurnId))).value);
      expect(settlement.commands[0]).toMatchObject({ ...command, action: "turn_settled", replyEventId: reply.sourceEventId, expiresAt: expect.any(Number) });
      expect(settlement.commands[0]!.expiresAt).toBeLessThan(command.expiresAt);
      expect(settlement.commands[0]!.expiresAt).toBeGreaterThanOrEqual(settlementRequestedAt + 3_600_000);
      expect(settlement.commands[0]!.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
      expect(reply.origin).toEqual({ clientId: registration.clientId });
      await app.waitFor(async () => (await app.thread(threadId)).runState === "idle");
    } finally { await feed.close(); }
  });

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

  for (const [mode, scenario] of [["response", "cycle"], ["manual", "cycle"], ["response", "background"], ["response", "background-switch"],
    ["response", "startup"], ["manual", "startup"],
    ["response", "record"], ["response", "next"], ["response", "stop"], ["response", "retarget"],
    ["response", "lost-ack"], ["response", "lost-send"], ["response", "cancel-uncertain"]] as const) {
    it.skipIf(!androidSerial)(`runs packaged Android ${mode}/${scenario} through the actual UI and media stack`, async () => {
      await adb(["shell", "pm", "clear", "dev.sedes.local"]);
      const threadTitle = `Voice ${mode} ${scenario}`;
      const threadId = await app.createThread(threadTitle);
      const secondThreadTitle = `${scenario === "record" ? "Pinned default" : "Retarget"} ${mode} ${scenario}`;
      const secondThreadId = scenario === "record" || scenario === "retarget" || scenario === "background-switch" ? await app.createThread(secondThreadTitle) : undefined;
      const initialText = `native voice fixture start ${mode} ${scenario}`;
      if (scenario === "background-switch") {
        const policy = (await app.thread(threadId)).agentTools;
        await app.json(`/api/threads/${threadId}/operations`, "POST", {
          kind: "set_agent_tool_policy", mutationId: randomUUID(), expectedPolicyRevision: policy.revision,
          enabled: true, enabledToolIds: ["client.switch_thread"], accessBoundary: "environment",
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
        app.model.callToolNextStream(initialText, nativeTool!, { toolId: "client.switch_thread", schemaVersion: 1,
          input: { threadId: secondThreadId, listen: true } });
      }
      const pairingCode = app.authentication.createPairing({ kind: "management" }).token;
      const text = `voice fixture reply ${mode} ${scenario}`;
      // Give the real playback action a usable window even on software emulators.
      await speech.configure({ transcripts: [text, ""], asrDelayMs: 0, ttsDurationSeconds: scenario === "record" || scenario === "next" ? 12 : 1, reset: true });
      const before = app.model.requests.length;
      const ttsBefore = (await speech.observations()).speech.length;
      const args = { serverOrigin: app.url, speechEndpoint: speech.endpoint, speechToken: speech.token, pairingCode, threadId, threadTitle, mode, scenario,
        initialText, draftText: `unsent voice fixture draft ${mode} ${scenario}`,
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
        // Next exercises speech playback without opening capture; every other scenario records after a start cue.
        expect(evidence).toMatchObject({ draftPreserved: true, composerDraftPreserved: true, serverDraftPreserved: true,
          audioSource: scenario === "next" ? "none" : "deterministic-pcm", audioSink: "AudioTrack" });
        if (mode === "response" && scenario !== "stop") expect(evidence.speechPlayback).toBe(true);
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
        }
        if (scenario === "cycle") {
          expect(evidence.inputUi).toMatchObject({ rowCount: 1, provisional: false, routineLabelCount: 0,
            seekEnabled: mode === "manual", submitted: { threadId } });
          expect(evidence.inputUi.operationId).toBe(evidence.inputUi.submitted.operationId);
          expect(evidence.inputUi.operationId).toMatch(/^[0-9a-f-]{36}$/u);
          expect(evidence.inputUi.text).toContain(text);
          expect(evidence.inputUi.viewportHeight).toBeGreaterThan(0);
          if (mode === "manual") {
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
        // The device polled Sedes for the autosaved draft; confirm it is still the unsent composer text.
        expect((await app.thread(threadId)).draft.text).toBe(args.draftText);
        const submissions = () => app.model.requests.slice(before).filter(request => request.lastRole === "user" && request.lastText === text);
        // A definitive admission receipt may precede asynchronous provider dispatch.
        const submitsReply = scenario !== "stop" && scenario !== "next";
        if (submitsReply) await waitForSpeech(() => submissions().length > 0);
        expect(submissions()).toHaveLength(submitsReply ? 1 : 0);
        if (mode === "manual") expect((await speech.observations()).speech.length).toBe(ttsBefore);
        if (secondThreadId) {
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
