import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechTransport } from "../../packages/electron-speech/electron/dist/transport.mjs";
import { OPENAI_ENDPOINT, httpDateSeconds, providerBinding } from "../../packages/electron-speech/electron/dist/contracts.mjs";

const binding = { provider: "openai", endpoint: OPENAI_ENDPOINT };
const date = "Wed, 28 Oct 2026 12:00:00 GMT";
const providerSeconds = Date.parse(date) / 1000;
const pcm = Buffer.alloc(4800, 12).toString("base64");
const token = "fixture-openai-secret";
const cleanups = [];

// The production transport sees the fixed hosted URLs. Only the connection target is
// mapped into an isolated loopback fixture; HTTP bodies and WebSocket frames are real.
async function fixture(options = {}) {
  const requests = [], messages = [], notices = [], peers = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body });
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    if (request.url === "/v1/models") {
      if (options.catalogStatus) { response.writeHead(options.catalogStatus).end(); return; }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(options.catalog ?? { object: "list", data: [
        { id: "gpt-4o-mini-transcribe" }, { id: "gpt-4o-mini-tts" }, { id: "tts-1-hd" }, { id: "gpt-irrelevant-model" },
      ] }));
    } else if (request.url === "/v1/audio/speech") {
      if (options.speech) { options.speech(request, response); return; }
      if (options.speechStatus) { response.writeHead(options.speechStatus).end(options.errorBody); return; }
      response.setHeader("Content-Type", options.audioType ?? "application/octet-stream");
      response.end(Buffer.alloc(19_200, 42));
    } else response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on("headers", (headers) => { if (options.date !== null) headers.push(`Date: ${options.date ?? date}`); });
  server.on("upgrade", (request, socket, head) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (options.rejectUpgrade) { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(request, socket, head, (peer) => wss.emit("connection", peer));
  });
  wss.on("connection", (peer) => {
    peers.push(peer); peer.on("error", () => {});
    let previous = null, commits = 0;
    const id = `hosted-${peers.length}`;
    const send = (event) => { if (peer.readyState === 1) peer.send(JSON.stringify(event)); };
    const session = { id, type: "transcription" };
    if (options.expires !== null) session.expires_at = options.expires ?? providerSeconds + 3600;
    send({ type: "session.created", session });
    send({ type: "conversation.created", conversation: { id: `conversation-${id}`, object: "realtime.conversation" } });
    peer.on("message", (data) => {
      const event = JSON.parse(data.toString()); messages.push(event);
      if (options.message?.({ event, send, id }) === false) return;
      if (event.type === "session.update") {
        send({ type: "session.updated", session: { ...event.session, id,
          ...(options.updatedExpires === undefined ? {} : { expires_at: options.updatedExpires }) } });
      } else if (event.type === "input_audio_buffer.commit") {
        const item = `${id}-${++commits}`;
        const metadata = { id: item, type: "message", role: "user", status: "completed", content: [{ type: "input_audio", transcript: "unsubmitted metadata" }] };
        send({ type: "conversation.item.added", item: metadata });
        send({ type: "input_audio_buffer.committed", item_id: item, previous_item_id: previous }); previous = item;
        send({ type: "conversation.item.done", item: metadata });
        send({ type: "conversation.item.input_audio_transcription.delta", item_id: item, content_index: 0, delta: "unsubmitted" });
        send({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: `hosted transcript ${commits}` });
      }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = vi.fn((url, init) => {
    expect(url.startsWith(`${OPENAI_ENDPOINT}/`)).toBe(true);
    expect(init.redirect).toBe("error");
    return fetch(`${origin}${new URL(url).pathname}`, init);
  });
  const websocketCalls = [];
  class FixtureWebSocket extends WebSocket {
    constructor(url, init) {
      websocketCalls.push({ url: url.href, init });
      expect(url.origin).toBe("wss://api.openai.com");
      super(`${origin.replace("http:", "ws:")}${url.pathname}${url.search}`, init);
    }
  }
  const credentials = { read: vi.fn(async () => token), status: vi.fn(async () => ({ credentialConfigured: true })) };
  const transport = new SpeechTransport({ credentials, fetchImpl, WebSocketImpl: FixtureWebSocket,
    notify: (event, value) => {
      notices.push({ event, value });
      if (event === "audioChunk" && !options.holdAudio) transport.acknowledgeAudio({ requestId: value.requestId, sequence: value.sequence });
    } });
  cleanups.push(async () => {
    transport.cancelAll(); for (const peer of peers) peer.terminate();
    await new Promise((resolve) => wss.close(resolve)); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await transport.configure(binding);
  return { transport, requests, messages, notices, peers, credentials, fetchImpl, websocketCalls };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const recognition = (requestId = randomUUID(), model = "gpt-4o-mini-transcribe") => ({ ...binding, requestId, model });
const synthesis = (requestId = randomUUID()) => ({ ...binding, requestId, model: "gpt-4o-mini-tts", voice: "coral", speed: 1, text: "Hello" });

describe("Electron hosted OpenAI speech", () => {
  it("requires an explicit provider with the fixed hosted endpoint and rejects ambiguous server bindings", async () => {
    expect(providerBinding(binding)).toEqual(binding);
    expect(providerBinding({ ...binding, endpoint: `${OPENAI_ENDPOINT}/` })).toEqual(binding);
    for (const input of [
      { endpoint: OPENAI_ENDPOINT }, { provider: "other", endpoint: OPENAI_ENDPOINT },
      { ...binding, endpoint: "http://api.openai.com/v1" }, { ...binding, endpoint: "https://speech.example/v1" },
      { ...binding, endpoint: "https://api.openai.com/prefix/v1" }, { ...binding, endpoint: "https://api.openai.com:444/v1" },
      { provider: "server", endpoint: OPENAI_ENDPOINT },
    ]) expect(() => providerBinding(input)).toThrow();
    const f = await fixture();
    expect(await f.transport.configure(binding)).toEqual({ ...binding, credentialConfigured: true });
    await expect(f.transport.getCapabilities({ endpoint: OPENAI_ENDPOINT })).rejects.toMatchObject({ code: "speech_provider_invalid" });
    await expect(f.transport.startRecognition({ ...recognition(), endpoint: "https://attacker.example/v1" })).rejects.toMatchObject({ code: "speech_endpoint_invalid" });
    expect(f.credentials.read).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });

  it("uses only the authenticated models catalog for picker hints and filters unrelated models", async () => {
    const f = await fixture();
    const catalog = await f.transport.getCapabilities(binding);
    expect(catalog.transcriptionModels.map(({ id }) => id)).toEqual(["gpt-4o-mini-transcribe"]);
    expect(catalog.transcriptionModels[0].realtime.idleTimeoutSeconds).toBe(0);
    expect(catalog.speechModels.map(({ id }) => id)).toEqual(["gpt-4o-mini-tts", "tts-1-hd"]);
    expect(catalog.speechModels[0].voices.some(({ id }) => id === "coral")).toBe(true);
    expect(f.requests).toEqual([{ path: "/v1/models", authorization: `Bearer ${token}`, body: "" }]);
    expect(f.credentials.read).toHaveBeenCalledWith(OPENAI_ENDPOINT);
  });

  it.each([{}, { object: "list", data: [{ id: "gpt-4o-mini-tts" }, { id: "gpt-4o-mini-tts" }] }])("rejects malformed hosted model catalogs", async (catalog) => {
    const f = await fixture({ catalog });
    await expect(f.transport.getCapabilities(binding)).rejects.toMatchObject({ code: "speech_capabilities_invalid" });
  });

  it("allows supported recognition when model discovery is unavailable and validates a fresh GA transcription session", async () => {
    const f = await fixture({ catalogStatus: 403 });
    await expect(f.transport.getCapabilities(binding)).rejects.toMatchObject({ code: "speech_unauthorized" });
    const input = recognition();
    const ready = await f.transport.startRecognition(input);
    expect(ready).toMatchObject({ maxBufferBytes: 2_880_000, maxRecordingSeconds: 60 });
    expect(ready.maxSessionSeconds).toBeGreaterThan(3500); expect(ready.maxSessionSeconds).toBeLessThan(3600);
    expect(f.websocketCalls[0]).toMatchObject({ url: "wss://api.openai.com/v1/realtime?intent=transcription", init: {
      headers: { Authorization: `Bearer ${token}` }, followRedirects: false, perMessageDeflate: false,
    } });
    expect(f.websocketCalls[0].init.headers).not.toHaveProperty("OpenAI-Beta");
    expect(f.messages[0]).toMatchObject({ type: "session.update", session: { type: "transcription", audio: { input: {
      format: { type: "audio/pcm", rate: 24000 }, transcription: { model: input.model }, turn_detection: null, noise_reduction: null,
    } } } });
    for (let segment = 1; segment <= 2; segment++) {
      await f.transport.appendAudio({ requestId: input.requestId, pcm });
      expect(await f.transport.commitRecognition({ requestId: input.requestId })).toEqual({ transcript: `hosted transcript ${segment}` });
    }
    expect(f.requests.map(({ path }) => path)).toEqual(["/v1/models", "/v1/realtime?intent=transcription"]);
  });

  it("rejects arbitrary advertised recognition model IDs before connecting", async () => {
    const f = await fixture({ catalog: { object: "list", data: [{ id: "arbitrary-transcribe" }] } });
    await expect(f.transport.startRecognition(recognition(randomUUID(), "arbitrary-transcribe"))).rejects.toMatchObject({ code: "speech_model_unsupported" });
    expect(f.requests).toEqual([]);
  });

  it.each([
    ["missing Date", { date: null }], ["malformed Date", { date: "not a date" }],
    ["noncanonical Date", { date: "Thu, 28 Oct 2026 12:00:00 GMT" }],
    ["missing expiry", { expires: null }], ["fractional expiry", { expires: providerSeconds + 3600.5 }],
    ["expired session", { expires: providerSeconds }], ["unbounded session", { expires: providerSeconds + 4000 }],
  ])("rejects %s before recording becomes ready", async (_label, options) => {
    const f = await fixture(options);
    await expect(f.transport.startRecognition(recognition())).rejects.toMatchObject({ code: "speech_session_lifetime_invalid" });
    expect(f.messages.some(({ type }) => type === "input_audio_buffer.append")).toBe(false);
  });

  it("validates shortened expiry at acknowledgement and does not extend created lifetime", async () => {
    const short = await fixture({ updatedExpires: providerSeconds + 120 });
    await expect(short.transport.startRecognition(recognition())).rejects.toMatchObject({ code: "speech_limits_unsupported" });
    const extended = await fixture({ expires: providerSeconds + 600, updatedExpires: providerSeconds + 3600 });
    const ready = await extended.transport.startRecognition(recognition());
    expect(ready.maxSessionSeconds).toBeLessThan(600); expect(ready.maxSessionSeconds).toBeGreaterThan(590);
  });

  it("does not use the local wall clock to infer provider session lifetime", async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try { expect((await f.transport.startRecognition(recognition())).maxSessionSeconds).toBeGreaterThan(3500); }
    finally { clock.mockRestore(); }
  });

  it.each(["audio/pcm", "application/octet-stream", "audio/pcm; rate=24000; channels=1; format=s16le"])("accepts hosted PCM %s without capability discovery", async (audioType) => {
    const f = await fixture({ audioType, catalogStatus: 404 });
    await f.transport.speak(synthesis());
    expect(f.requests.map(({ path }) => path)).toEqual(["/v1/audio/speech"]);
    expect(JSON.parse(f.requests[0].body)).toEqual({ model: "gpt-4o-mini-tts", voice: "coral", input: "Hello", response_format: "pcm", speed: 1 });
    expect(Buffer.concat(f.notices.map(({ value }) => Buffer.from(value.pcm, "base64")))).toEqual(Buffer.alloc(19_200, 42));
  });

  it.each(["audio/mpeg", "audio/wav", "audio/pcm; rate=16000; channels=1; format=s16le", "application/octet-stream; rate=16000"])("rejects unsupported hosted audio %s", async (audioType) => {
    const f = await fixture({ audioType });
    await expect(f.transport.speak(synthesis())).rejects.toMatchObject({ code: "speech_audio_invalid" });
    expect(f.notices).toEqual([]);
  });

  it("rejects unsupported TTS models, voices, speeds and text before sending", async () => {
    const f = await fixture();
    for (const invalid of [{ model: "tts-other" }, { voice: "unknown" }, { speed: 4.1 }, { text: "a".repeat(4097) }]) {
      await expect(f.transport.speak({ ...synthesis(), ...invalid })).rejects.toMatchObject({ code: expect.stringMatching(/^speech_(model_unavailable|input_invalid)$/u) });
    }
    expect(f.requests).toEqual([]);
  });

  it("reports rejected credentials without exposing provider bodies or replaying requests", async () => {
    const f = await fixture({ rejectUpgrade: true, speechStatus: 401 });
    await expect(f.transport.startRecognition(recognition())).rejects.toMatchObject({ code: "speech_unauthorized" });
    await expect(f.transport.speak(synthesis())).rejects.toMatchObject({ code: "speech_unauthorized" });
    expect(f.requests).toHaveLength(2); expect(JSON.stringify(f.notices)).not.toContain(token);
  });

  it.each([{ code: "insufficient_quota" }, { type: "insufficient_quota" }, { code: "credit_balance_exhausted" }])("distinguishes exhausted quota from transient HTTP 429 using %j", async (error) => {
    const f = await fixture({ speechStatus: 429, errorBody: JSON.stringify({ error: { ...error, message: token } }) });
    const failure = await f.transport.speak(synthesis()).catch((error) => error);
    expect(failure).toMatchObject({ code: "speech_quota_exceeded", message: expect.stringContaining("billing or credits") });
    expect(failure.message).not.toContain(token);
    expect(f.requests).toHaveLength(1); expect(f.notices).toEqual([]);
  });

  it.each([
    ["rate limit", JSON.stringify({ error: { code: "rate_limit_exceeded", message: token } })],
    ["malformed", `{${token}`],
    ["missing code", JSON.stringify({ error: { message: `insufficient_quota ${token}` } })],
    ["oversized", JSON.stringify({ error: { code: "insufficient_quota", message: token.repeat(1000) } })],
  ])("keeps %s HTTP 429 failures generic and never exposes their bodies", async (_label, errorBody) => {
    const f = await fixture({ speechStatus: 429, errorBody });
    const failure = await f.transport.speak(synthesis()).catch((error) => error);
    expect(failure).toMatchObject({ code: "speech_busy", message: expect.stringContaining("Wait before trying again") });
    expect(failure.message).not.toContain(token); expect(f.notices).toEqual([]);
  });

  it("keeps an unreadable HTTP 429 body generic and honors cancellation while reading it", async () => {
    const unreadable = await fixture({ speech: (_request, response) => {
      response.writeHead(429, { "Content-Length": 1000 }); response.write('{"error":');
      setTimeout(() => response.destroy(), 10);
    } });
    await expect(unreadable.transport.speak(synthesis())).rejects.toMatchObject({ code: "speech_busy" });
    const stalled = await fixture({ speech: (_request, response) => {
      response.writeHead(429); response.write('{"error":');
    } });
    const input = synthesis();
    const speaking = stalled.transport.speak(input);
    const rejected = expect(speaking).rejects.toMatchObject({ code: "speech_cancelled" });
    await vi.waitFor(() => expect(stalled.requests).toHaveLength(1));
    stalled.transport.cancel({ requestId: input.requestId });
    await rejected; expect(stalled.notices).toEqual([]);
  });

  it.each([{ code: "insufficient_quota" }, { type: "insufficient_quota" }, { code: "credit_balance_exhausted" }])("reports realtime quota failure %j without exposing provider details", async (error) => {
    const f = await fixture({ message: ({ event, send }) => {
      if (event.type !== "input_audio_buffer.commit") return;
      send({ type: "error", error: { ...error, message: token } }); return false;
    } });
    const input = recognition(); await f.transport.startRecognition(input);
    await f.transport.appendAudio({ requestId: input.requestId, pcm });
    await expect(f.transport.commitRecognition({ requestId: input.requestId })).rejects.toMatchObject({ code: "speech_quota_exceeded" });
    expect(f.notices).toEqual([{ event: "recognitionError", value: {
      requestId: input.requestId, code: "speech_quota_exceeded", message: expect.stringContaining("billing or credits"),
    } }]);
    expect(JSON.stringify(f.notices)).not.toContain(token);
  });

  it.each([
    ["rate limit", { code: "rate_limit_exceeded" }, "speech_busy"],
    ["missing code", { message: "insufficient_quota" }, "speech_recognition_failed"],
  ])("handles realtime %s without mistaking provider messages for quota codes", async (_label, error, code) => {
    const f = await fixture({ message: ({ event, send }) => {
      if (event.type !== "session.update") return;
      send({ type: "error", error }); return false;
    } });
    await expect(f.transport.startRecognition(recognition())).rejects.toMatchObject({ code });
    expect(f.notices).toEqual([]);
  });

  it("switching providers cancels active hosted work before any replacement credential is read", async () => {
    const f = await fixture({ holdAudio: true }); const input = synthesis();
    const speaking = f.transport.speak(input);
    const rejected = expect(speaking).rejects.toMatchObject({ code: "speech_cancelled" });
    await vi.waitFor(() => expect(f.notices).toHaveLength(1));
    await f.transport.configure({ provider: "server", endpoint: "https://speech.example/v1" });
    await rejected;
    await expect(f.transport.startRecognition(recognition())).rejects.toMatchObject({ code: "speech_configuration_changed" });
    expect(f.credentials.read).toHaveBeenCalledTimes(1);
  });

  it("rejects noncanonical HTTP dates", () => {
    expect(httpDateSeconds(date)).toBe(providerSeconds);
    for (const value of [undefined, `${date} extra`, "Sun, 31 Feb 2026 12:00:00 GMT", "Wed, 28 Oct 2026 12:00:60 GMT"]) {
      expect(() => httpDateSeconds(value)).toThrow();
    }
  });
});
