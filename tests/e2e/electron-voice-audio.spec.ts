import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { build } from "vite";
import type { AppConfig, PackagedClientOrigin } from "../../src/server/config/config.js";
import { ClientControlService } from "../../src/server/domain/client-control-service.js";
import { ApplicationEventHub } from "../../src/server/events/application-event-hub.js";
import { serveApplicationEventStream } from "../../src/server/events/application-sse.js";
import { SseResponseWriter } from "../../src/server/events/sse-response-writer.js";
import { ClientResponseCompression } from "../../src/server/http/response-compression.js";
import { csrfGuard, hostOriginGuard, packagedClientCors } from "../../src/server/security/http-security.js";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../src/shared/protocol/application.js";
import { clientPollRequestSchema, registerClientSchema } from "../../src/shared/protocol/client-controls.js";
import { defaultNotificationDelivery, notificationPolicySchema, voiceNotificationSchema } from "../../src/shared/protocol/notification.js";
import { test, expect } from "./fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("desktop voice receives policy and notifications through the packaged-client CORS boundary", async ({ page }) => {
  const built = await build({
    configFile: false, root: repositoryRoot, base: "./", logLevel: "silent",
    build: { write: false, lib: {
      entry: {
        connection: path.join(repositoryRoot, "src/client/voice/electron-voice-connection.ts"),
        authentication: path.join(repositoryRoot, "src/client/authentication/auth-transport.ts"),
      }, formats: ["es"], fileName: (_format, name) => `${name}.mjs`,
    } },
  });
  const outputs = (Array.isArray(built) ? built : [built]).flatMap(bundle => {
    if (!("output" in bundle)) throw new Error("Expected a browser connection library build.");
    return bundle.output;
  });
  const assets = new Map(outputs.map(asset => [asset.fileName, asset.type === "chunk" ? asset.code : asset.source]));
  // Use a real second HTTP origin: Playwright request routing can suppress
  // Chromium preflights, which are the behavior this regression must exercise.
  const rendererServer = createServer((request, response) => {
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);
    if (!name) { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Desktop voice connection test</title>"); return; }
    const asset = assets.get(name);
    if (asset === undefined) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", "text/javascript"); response.end(typeof asset === "string" ? asset : Buffer.from(asset));
  });
  await new Promise<void>((resolve, reject) => { rendererServer.once("error", reject); rendererServer.listen(0, "127.0.0.1", resolve); });
  const rendererAddress = rendererServer.address();
  if (!rendererAddress || typeof rendererAddress === "string") throw new Error("Voice renderer fixture did not bind a loopback port.");
  const rendererOrigin = `http://127.0.0.1:${rendererAddress.port}`;
  const renderer = `${rendererOrigin}/`;

  const scope = { tenantId: "voice-cors-test", principalId: "voice-cors-test" };
  const identity = "a".repeat(64), token = "voice-cors-fixture-token", csrf = "voice-cors-fixture-csrf";
  const controls = new ClientControlService();
  const hub = new ApplicationEventHub();
  const baseline = hub.publish({ type: "snapshot", generation: hub.generation, snapshot: {
    environments: [], projects: [], workspaces: [], threads: [], forkOrigins: [], lineagePlacements: [], groups: [],
    lineageFamilies: [], executionTargets: [], advisories: [], defaultNewThreadTargetId: null, tasks: [],
  } });
  const policy = notificationPolicySchema.parse({ generation: 1, settings: { enabled: true, silenced: false, revision: 0,
    assistantResultPhases: ["final"], scriptPath: "", arguments: [], timeoutSeconds: 30, delivery: defaultNotificationDelivery() } });
  const notification = voiceNotificationSchema.parse({ generation: 1, sourceEventId: "cors-notice", voice: "speak", payload: {
    schemaVersion: 5, notificationId: "cors-notice", event: "notification.test", occurredAt: new Date().toISOString(),
    title: "Test", message: "Cross-origin voice notification.",
  } });
  const config: AppConfig = { authenticationRequired: true, clientResponseCompression: true, experimentalUsageEnabled: false,
    host: "127.0.0.1", port: 0, stateDirectory: repositoryRoot, allowedTailscaleHosts: [],
    // Test-only exact origin substitutes for Electron's custom scheme, which
    // standalone Chromium cannot load. Production configuration is unchanged.
    packagedClientOrigins: [rendererOrigin as PackagedClientOrigin],
    conversationRetentionMilliseconds: 600_000, conversationRuntimeBudget: 8 };
  const requests: Array<{ method: string; path: string; origin?: string; requestedHeaders?: string; status?: number }> = [];
  const app = express();
  app.use((request, response, next) => {
    const entry = { method: request.method, path: request.path, origin: request.header("Origin"),
      requestedHeaders: request.header("Access-Control-Request-Headers"), status: undefined as number | undefined };
    requests.push(entry); response.on("finish", () => { entry.status = response.statusCode; }); next();
  });
  app.use(hostOriginGuard(config), packagedClientCors(config));
  app.use((request, response, next) => {
    if (request.header("Authorization") !== `Bearer ${token}`) { response.status(401).end(); return; }
    next();
  });
  app.use(express.json(), csrfGuard(csrf));
  app.get("/api/auth/status", (_request, response) => response.json({ required: true, authenticated: true, navigationNamespace: identity }));
  app.get("/api/application/session", (_request, response) => response.json({ csrfToken: csrf, version: "0.2.0",
    clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION, providerPulseEnabled: false, experimentalUsageEnabled: false }));
  app.post("/api/client-registration", (request, response) => response.json(controls.register(scope, undefined, registerClientSchema.parse(request.body))));
  app.post("/api/client-controls/poll", async (request, response) => {
    const abort = new AbortController(); response.once("close", () => abort.abort());
    const result = await controls.poll(scope, request.header("X-Sedes-Client"), undefined, clientPollRequestSchema.parse(request.body), abort.signal);
    if (!abort.signal.aborted) response.json(result);
  });
  app.get("/api/application/events", async (request, response) => {
    controls.authenticate(scope, request.header("X-Sedes-Client"), undefined);
    const writer = new SseResponseWriter(request, response, new ClientResponseCompression(true));
    await serveApplicationEventStream(request, writer, hub, async () => ({ envelope: baseline }), {
      subscribeTransient(listener) {
        listener(`event: notification_policy\ndata: ${JSON.stringify(policy)}\n\n`);
        listener(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
        return () => {};
      },
    });
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Voice connection fixture did not bind a loopback port.");
  const baseURL = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(renderer);
    const result = await page.evaluate(async ({ renderer, baseURL, identity, token }) => {
      const { ElectronVoiceConnection } = await import(`${renderer}connection.mjs`) as typeof import("../../src/client/voice/electron-voice-connection.js");
      const { setEndpointCredential, setEndpointProfile } = await import(`${renderer}authentication.mjs`) as typeof import("../../src/client/authentication/auth-transport.js");
      const endpoint = { baseUrl: baseURL };
      setEndpointCredential(endpoint, token); setEndpointProfile(endpoint, "desktop-cors");
      const state = { runtime: { foreground: true, voiceReady: true, interactionActive: false }, settings: null };
      const frames: Array<{ event: string; value: unknown; streamId: string }> = [];
      const errors: string[] = [];
      let connected = false;
      let resolve!: () => void, reject!: (error: Error) => void;
      const delivered = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void delivered.catch(() => {});
      const connection = new ElectronVoiceConnection({ profileId: "desktop-cors", serverOrigin: baseURL, identity }, {
        state: () => state, command: async () => ({ status: "applied", state }), registered: () => {},
        frame(event, value, streamId) { frames.push({ event, value, streamId }); if (event === "notification") resolve(); },
        notificationsChanged(value) { connected = value; },
        failed(code) { errors.push(code); reject(new Error(code)); },
      });
      const timer = setTimeout(() => reject(new Error("Voice notification did not arrive.")), 5_000);
      try {
        await connection.connect(); connection.notifications(true); await delivered;
        return { frames, errors, connected, streamId: connection.voiceStreamId, registered: connection.registration !== null };
      } finally {
        clearTimeout(timer); connection.close(); setEndpointCredential(endpoint, null); setEndpointProfile(endpoint, null);
      }
    }, { renderer, baseURL, identity, token });
    expect(result).toMatchObject({ errors: [], connected: true, registered: true, streamId: expect.any(String) });
    expect(result.frames).toEqual([
      { event: "notification_policy", value: policy, streamId: result.streamId },
      { event: "notification", value: notification, streamId: result.streamId },
    ]);
    const preflight = requests.find(request => request.path === "/api/application/events" && request.method === "OPTIONS");
    expect(preflight).toMatchObject({ origin: rendererOrigin, status: 204 });
    expect(preflight?.requestedHeaders?.split(",").sort()).toEqual(["authorization", "x-sedes-client"]);
    expect(requests.some(request => request.path === "/api/application/events" && request.method === "GET")).toBe(true);
  } finally {
    hub.close(); controls.close(); server.closeAllConnections(); rendererServer.closeAllConnections();
    await Promise.all([server, rendererServer].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
});

test("desktop voice resamples microphone PCM in a real worklet and drains or cancels streamed playback", async ({ page }) => {
  // Build the production module and its actual worklet, independently of app
  // boot. AudioWorklet module fetches bypass Playwright page routing, so this
  // job owns a small loopback fixture serving only these in-memory assets.
  // No fixed port, shared artifact, native microphone, or provider is involved.
  const built = await build({
    configFile: false,
    root: repositoryRoot,
    base: "./",
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry: path.join(repositoryRoot, "src/client/voice/electron-voice-audio.ts"), formats: ["es"], fileName: "audio" },
    },
  });
  const outputs = (Array.isArray(built) ? built : [built]).flatMap(bundle => {
    if (!("output" in bundle)) throw new Error("Expected a browser audio library build.");
    return bundle.output;
  });
  const assets = new Map(outputs.map(asset => [asset.fileName, asset.type === "chunk" ? asset.code : asset.source]));
  const entry = outputs.find(asset => asset.type === "chunk" && asset.isEntry);
  if (!entry) throw new Error("Missing browser audio test entry.");
  const prefix = "/__electron_voice_audio_test/";
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!pathname.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const assetName = pathname.slice(prefix.length);
    if (!assetName) {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'" });
      response.end('<!doctype html><meta charset="utf-8"><title>Desktop voice audio test</title><button>Enable audio</button>');
      return;
    }
    const body = assets.get(assetName);
    if (body === undefined) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "text/javascript" });
    response.end(typeof body === "string" ? body : Buffer.from(body));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Audio fixture did not bind a loopback port.");
  const baseURL = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(`${baseURL}${prefix}`);
    await page.getByRole("button", { name: "Enable audio" }).click();
    const result = await page.evaluate(async ({ entryUrl }) => {
      const { ElectronVoiceAudio } = await import(entryUrl) as typeof import("../../src/client/voice/electron-voice-audio.js");
      const sourceContext = new AudioContext({ sampleRate: 48_000 });
      const oscillator = sourceContext.createOscillator();
      oscillator.frequency.value = 1_000;
      const gain = sourceContext.createGain();
      gain.gain.value = 0.25;
      const destination = sourceContext.createMediaStreamDestination();
      destination.channelCount = 1;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await sourceContext.resume();
      const contexts: AudioContext[] = [];
      const media = {
        getUserMedia: async () => destination.stream,
        enumerateDevices: async () => [],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as MediaDevices;
      const audio = new ElectronVoiceAudio({
        mediaDevices: media,
        createAudioContext: options => { const context = new AudioContext(options); contexts.push(context); return context; },
      });
      const packets: Uint8Array[] = [];
      const errors: string[] = [];
      let captured!: () => void;
      const enoughAudio = new Promise<void>(resolve => { captured = resolve; });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await audio.startCapture({
          onPcm: packet => { packets.push(packet); if (packets.length >= 6) captured(); },
          onEnded: error => { errors.push(error.message); captured(); },
        }).catch(error => { throw new Error(`${String(error)}; cause=${String(error.cause)}`); });
        await Promise.race([enoughAudio, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("AudioWorklet did not produce microphone PCM.")), 5_000);
        })]);
        clearTimeout(timeout);
        await audio.stopCapture();
        // Ignore the initial packet while the synthetic source establishes its
        // MediaStream clock. Later full packets must contain the resampled tone.
        const pcm = packets.slice(1).filter(packet => packet.byteLength === 4_800);
        const values = pcm.flatMap(packet => {
          const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
          return Array.from({ length: packet.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true) / 32_768);
        });
        const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
        let crossings = 0;
        for (let index = 1; index < values.length; index++) if (values[index - 1]! <= 0 && values[index]! > 0) crossings++;
        const frequency = crossings / (values.length / 24_000);

        const playback = await audio.createPlayback();
        // Split a sample across chunks, as a real streamed HTTP body may do.
        const first = pcm[0]!;
        const began = performance.now();
        await playback.append(first.subarray(0, 1));
        await playback.append(first.subarray(1));
        await playback.append(first);
        await playback.append(first);
        let drained = false;
        const finished = playback.finish().then(() => { drained = true; });
        await Promise.resolve();
        const prematureDrain = drained;
        await finished;
        const playbackMilliseconds = performance.now() - began;

        const controller = new AbortController();
        const interrupted = await audio.createPlayback({ signal: controller.signal });
        await interrupted.append(first);
        const stopped = interrupted.finish().then(() => "unexpected_success", error => String(error.code));
        controller.abort();
        const cancelResult = await stopped;
        return {
          sourceRate: sourceContext.sampleRate, captureRate: contexts[0]!.sampleRate,
          packetLengths: packets.map(packet => packet.length), rms, frequency, errors,
          prematureDrain, playbackMilliseconds, cancelResult,
          microphoneStopped: destination.stream.getAudioTracks().every(track => track.readyState === "ended"),
        };
      } finally {
        clearTimeout(timeout);
        await audio.dispose();
        oscillator.stop();
        destination.stream.getTracks().forEach(track => track.stop());
        await sourceContext.close();
      }
    }, { entryUrl: `${baseURL}${prefix}${entry.fileName}` });
    expect(result.sourceRate).toBe(48_000);
    expect(result.captureRate).toBe(24_000);
    expect(result.errors).toEqual([]);
    expect(result.packetLengths.length).toBeGreaterThanOrEqual(6);
    expect(result.packetLengths.every(length => length > 0 && length <= 4_800 && length % 2 === 0)).toBe(true);
    expect(result.rms).toBeGreaterThan(0.16);
    expect(result.rms).toBeLessThan(0.19);
    expect(result.frequency).toBeGreaterThan(970);
    expect(result.frequency).toBeLessThan(1_030);
    expect(result.microphoneStopped).toBe(true);
    expect(result.prematureDrain).toBe(false);
    expect(result.playbackMilliseconds).toBeGreaterThan(250);
    expect(result.playbackMilliseconds).toBeLessThan(3_000);
    expect(result.cancelResult).toBe("speech_cancelled");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
