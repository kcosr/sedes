import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechTransport } from "../../packages/electron-speech/electron/dist/transport.mjs";
import { normalizeEndpoint } from "../../packages/electron-speech/electron/dist/contracts.mjs";

const cleanups = [];
const token = "fixture-speech-token";
const pcm = Buffer.alloc(4800, 12).toString("base64");
function catalog() {
  return { object: "list", data: [
    { id: "stt", display_label: "Recognition", task: "transcription", ready: true,
      realtime: { max_buffer_bytes: 5_760_000, max_message_bytes: 1_048_576, max_output_bytes: 1_048_576, idle_timeout_seconds: 60, max_session_seconds: 3600 } },
    { id: "tts", display_label: "Speech", task: "speech", ready: true,
      audio: { sample_rate: 24000, channels: 1 }, output_formats: [{ id: "pcm", encoding: "pcm_s16le" }],
      voices: [{ id: "voice", display_label: "Voice" }], speed: { min: 0.5, max: 2, default: 1 }, max_text_length: 4096 },
  ] };
}
async function fixture(options = {}) {
  const requests = [], messages = [], peers = [], notices = [];
  let capabilities = catalog();
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    if (request.url === "/prefix/v1/audio/capabilities") {
      if (options.capabilities) { options.capabilities(request, response); return; }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(capabilities));
    } else if (request.url === "/prefix/v1/audio/speech") {
      if (options.speech) { options.speech(request, response); return; }
      response.setHeader("Content-Type", "audio/pcm; channels=1; rate=24000; format=s16le");
      response.end(Buffer.alloc(19_200, 42));
    } else response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${token}` || options.rejectUpgrade) { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(request, socket, head, (peer) => wss.emit("connection", peer, request));
  });
  wss.on("connection", (peer) => {
    peers.push(peer);
    peer.on("error", () => {});
    const id = `sess-${peers.length}`;
    let previous = null;
    let commits = 0;
    const send = (event) => { if (peer.readyState === 1) peer.send(JSON.stringify(event)); };
    send({ type: "session.created", session: { id, type: "transcription" } });
    peer.on("message", (data) => {
      const event = JSON.parse(data.toString());
      messages.push(event);
      if (options.message?.({ event, peer, send, id }) === false) return;
      if (event.type === "session.update") {
        send({ type: "session.updated", session: { ...event.session, id } });
      } else if (event.type === "input_audio_buffer.commit") {
        commits++;
        const item = `${id}-item-${commits}`;
        send({ type: "input_audio_buffer.committed", item_id: item, previous_item_id: previous });
        previous = item;
        setTimeout(() => send({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: `result ${commits}` }), 15);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/prefix/v1`;
  const credentials = { read: vi.fn(async () => token), status: vi.fn(async () => ({ credentialConfigured: true })) };
  const transport = new SpeechTransport({ credentials, notify: (event, value) => { notices.push({ event, value }); options.notify?.(event, value, transport); }, ...options.transportOptions });
  await transport.configure({ endpoint });
  cleanups.push(async () => {
    transport.cancelAll();
    for (const peer of peers) peer.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { endpoint, transport, requests, messages, peers, notices, credentials, setCapabilities: (value) => { capabilities = value; } };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("Electron native speech transport", () => {
  it("uses authenticated reverse-proxy routes and fresh selected-model limits before opening each recording", async () => {
    const f = await fixture();
    const discovery = await f.transport.getCapabilities({ endpoint: f.endpoint });
    expect(discovery.speechModels[0]).toMatchObject({ id: "tts", sampleRate: 24000, voices: [{ id: "voice", label: "Voice" }] });
    const id = randomUUID();
    expect(await f.transport.startRecognition({ requestId: id, endpoint: f.endpoint, model: "stt" })).toEqual({ maxBufferBytes: 2_880_000, maxRecordingSeconds: 60, maxSessionSeconds: 3600 });
    expect(f.requests.map((request) => request.url)).toEqual(["/prefix/v1/audio/capabilities", "/prefix/v1/audio/capabilities", "/prefix/v1/realtime?intent=transcription"]);
    expect(f.requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
    expect(f.messages[0]).toMatchObject({ type: "session.update", session: { audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "stt" }, turn_detection: null, noise_reduction: null } } } });
    f.transport.cancel({ requestId: id });
    const changed = catalog(); changed.data[0].realtime.max_buffer_bytes = 48_000;
    f.setCapabilities(changed);
    await expect(f.transport.startRecognition({ requestId: randomUUID(), endpoint: f.endpoint, model: "stt" })).rejects.toMatchObject({ code: "speech_limits_unsupported" });
    expect(f.peers).toHaveLength(1);
  });

  it("waits for matching session configuration and never accepts audio before readiness", async () => {
    let respond;
    const f = await fixture({ message: ({ event, send, id }) => {
      if (event.type !== "session.update") return;
      respond = () => send({ type: "session.updated", session: { ...event.session, id } });
      return false;
    } });
    const id = randomUUID();
    const ready = f.transport.startRecognition({ requestId: id, endpoint: f.endpoint, model: "stt" });
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    await expect(f.transport.appendAudio({ requestId: id, pcm })).rejects.toMatchObject({ code: "speech_not_ready" });
    expect(f.messages).toHaveLength(1);
    respond(); await ready;
  });

  it("correlates repeated commits and allows the following buffer only after commit acknowledgement", async () => {
    let acknowledge;
    let commitNumber = 0;
    const f = await fixture({ message: ({ event, send }) => {
      if (event.type !== "input_audio_buffer.commit") return;
      commitNumber++;
      acknowledge = () => send({ type: "input_audio_buffer.committed", item_id: `item-${commitNumber}`, previous_item_id: commitNumber === 1 ? null : `item-${commitNumber - 1}` });
      return false;
    } });
    const id = randomUUID();
    await f.transport.startRecognition({ requestId: id, endpoint: f.endpoint, model: "stt" });
    await f.transport.appendAudio({ requestId: id, pcm });
    const first = f.transport.commitRecognition({ requestId: id });
    await vi.waitFor(() => expect(commitNumber).toBe(1));
    const next = f.transport.appendAudio({ requestId: id, pcm });
    await Promise.resolve();
    expect(f.messages.filter((event) => event.type === "input_audio_buffer.append")).toHaveLength(1);
    acknowledge(); await next;
    await expect(f.transport.commitRecognition({ requestId: id })).rejects.toMatchObject({ code: "speech_busy" });
    f.peers[0].send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1", content_index: 0, transcript: "first" }));
    expect(await first).toEqual({ transcript: "first" });
    const second = f.transport.commitRecognition({ requestId: id });
    await vi.waitFor(() => expect(commitNumber).toBe(2));
    acknowledge();
    f.peers[0].send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-2", content_index: 0, transcript: "second" }));
    expect(await second).toEqual({ transcript: "second" });
  });

  it.each(["wrong-session", "wrong-model", "wrong-format"])("rejects mismatched configuration: %s", async (kind) => {
    const f = await fixture({ message: ({ event, send, id }) => {
      if (event.type !== "session.update") return;
      const session = { ...event.session, id };
      if (kind === "wrong-session") session.id = "other";
      if (kind === "wrong-model") session.audio.input.transcription.model = "other";
      if (kind === "wrong-format") session.audio.input.format.rate = 16000;
      send({ type: "session.updated", session }); return false;
    } });
    await expect(f.transport.startRecognition({ requestId: randomUUID(), endpoint: f.endpoint, model: "stt" })).rejects.toMatchObject({ code: "speech_protocol_invalid" });
    expect(f.messages.some((event) => event.type === "input_audio_buffer.append")).toBe(false);
  });

  it("rejects an uncorrelated transcript and reports a terminal capture error once", async () => {
    const f = await fixture({ message: ({ event, send }) => {
      if (event.type !== "input_audio_buffer.commit") return;
      send({ type: "input_audio_buffer.committed", item_id: "item", previous_item_id: null });
      send({ type: "conversation.item.input_audio_transcription.completed", item_id: "other", content_index: 0, transcript: token });
      return false;
    } });
    const id = randomUUID();
    await f.transport.startRecognition({ requestId: id, endpoint: f.endpoint, model: "stt" });
    await f.transport.appendAudio({ requestId: id, pcm });
    await expect(f.transport.commitRecognition({ requestId: id })).rejects.toMatchObject({ code: "speech_protocol_invalid" });
    expect(f.notices).toHaveLength(1);
    expect(JSON.stringify(f.notices)).not.toContain(token);
  });

  it("rejects nonconsecutive reused item IDs so a late old result cannot satisfy new audio", async () => {
    let commit = 0;
    const f = await fixture({ message: ({ event, send }) => {
      if (event.type !== "input_audio_buffer.commit") return;
      const items = ["item-A", "item-B", "item-A"];
      const item = items[commit];
      send({ type: "input_audio_buffer.committed", item_id: item, previous_item_id: commit ? items[commit - 1] : null });
      commit++;
      send({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: `old ${item}` });
      return false;
    } });
    const id = randomUUID();
    await f.transport.startRecognition({ requestId: id, endpoint: f.endpoint, model: "stt" });
    for (const item of ["item-A", "item-B"]) {
      await f.transport.appendAudio({ requestId: id, pcm });
      expect(await f.transport.commitRecognition({ requestId: id })).toEqual({ transcript: `old ${item}` });
    }
    await f.transport.appendAudio({ requestId: id, pcm });
    await expect(f.transport.commitRecognition({ requestId: id })).rejects.toMatchObject({ code: "speech_protocol_invalid" });
  });

  it("bounds queued appends while waiting for commit acknowledgement", async () => {
    const f = await fixture({ message: ({ event }) => event.type === "input_audio_buffer.commit" ? false : undefined });
    const id = randomUUID();
    await f.transport.startRecognition({ requestId: id, endpoint: f.endpoint, model: "stt" });
    await f.transport.appendAudio({ requestId: id, pcm });
    const committed = f.transport.commitRecognition({ requestId: id });
    const commitRejected = expect(committed).rejects.toMatchObject({ code: "speech_audio_backpressure" });
    await vi.waitFor(() => expect(f.messages.some((event) => event.type === "input_audio_buffer.commit")).toBe(true));
    const pending = Array.from({ length: 110 }, () => f.transport.appendAudio({ requestId: id, pcm }));
    const results = await Promise.allSettled(pending);
    await commitRejected;
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(f.notices.filter((event) => event.event === "recognitionError")).toHaveLength(1);
  });

  it("cancels an outstanding capability fetch before WebSocket setup and does not retry", async () => {
    let closed = false;
    const f = await fixture({ capabilities: (request) => request.on("close", () => { closed = true; }) });
    const id = randomUUID();
    const ready = f.transport.startRecognition({ requestId: id, endpoint: f.endpoint, model: "stt" });
    const rejected = expect(ready).rejects.toMatchObject({ code: "speech_cancelled" });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.transport.cancel({ requestId: id });
    await rejected;
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(f.peers).toHaveLength(0);
  });

  it("cancels after commit and ignores late speech without affecting a subsequent request", async () => {
    let committed = false;
    const f = await fixture({ message: ({ event }) => { if (event.type === "input_audio_buffer.commit") { committed = true; return false; } } });
    const id = randomUUID();
    await f.transport.startRecognition({ requestId: id, endpoint: f.endpoint, model: "stt" });
    await f.transport.appendAudio({ requestId: id, pcm });
    const result = f.transport.commitRecognition({ requestId: id });
    const rejected = expect(result).rejects.toMatchObject({ code: "speech_cancelled" });
    await vi.waitFor(() => expect(committed).toBe(true));
    f.transport.cancel({ requestId: id }); await rejected;
    expect(f.notices).toEqual([]);
    const next = randomUUID();
    await f.transport.startRecognition({ requestId: next, endpoint: f.endpoint, model: "stt" });
    f.transport.cancel({ requestId: id });
    await expect(f.transport.appendAudio({ requestId: next, pcm })).resolves.toBeUndefined();
  });

  it("fences endpoint replacement and keeps secrets scoped to the requested endpoint", async () => {
    const first = await fixture(), second = await fixture();
    const id = randomUUID();
    await first.transport.startRecognition({ requestId: id, endpoint: first.endpoint, model: "stt" });
    await first.transport.configure({ endpoint: second.endpoint });
    await expect(first.transport.appendAudio({ requestId: id, pcm })).rejects.toMatchObject({ code: "speech_request_inactive" });
    await expect(first.transport.getCapabilities({ endpoint: first.endpoint })).rejects.toMatchObject({ code: "speech_configuration_changed" });
    await first.transport.getCapabilities({ endpoint: second.endpoint });
    expect(first.credentials.read).toHaveBeenLastCalledWith(second.endpoint);
  });

  it("enforces canonical complete PCM samples and bounded incoming chunks", async () => {
    const f = await fixture(); const id = randomUUID();
    await f.transport.startRecognition({ requestId: id, endpoint: f.endpoint, model: "stt" });
    for (const invalid of ["", "AQ==", "AB==", `${pcm}\n`, Buffer.alloc(4802).toString("base64")]) {
      await expect(f.transport.appendAudio({ requestId: id, pcm: invalid })).rejects.toMatchObject({ code: "speech_audio_invalid" });
    }
    await expect(f.transport.commitRecognition({ requestId: id })).rejects.toMatchObject({ code: "speech_audio_too_short" });
    expect(f.messages).toHaveLength(1);
  });

  it("streams exact bounded PCM and waits for each renderer acknowledgement", async () => {
    const f = await fixture(); const id = randomUUID();
    let finished = false;
    const speaking = f.transport.speak({ requestId: id, endpoint: f.endpoint, model: "tts", voice: "voice", speed: 1, text: "Hello" }).then(() => { finished = true; });
    await vi.waitFor(() => expect(f.notices).toHaveLength(1));
    expect(Buffer.from(f.notices[0].value.pcm, "base64")).toEqual(Buffer.alloc(9600, 42));
    expect(finished).toBe(false);
    f.transport.acknowledgeAudio({ requestId: id, sequence: 0 });
    await vi.waitFor(() => expect(f.notices).toHaveLength(2));
    expect(() => f.transport.acknowledgeAudio({ requestId: id, sequence: 0 })).toThrow("stale");
    f.transport.acknowledgeAudio({ requestId: id, sequence: 1 });
    await speaking;
    expect(finished).toBe(true);
  });

  it("joins arbitrary HTTP sample boundaries and rejects trailing half-samples", async () => {
    const chunks = [];
    const f = await fixture({ speech: (_request, response) => {
      response.writeHead(200, { "Content-Type": "audio/pcm; rate=24000; channels=1; format=s16le" });
      response.write(Buffer.from([1]));
      setTimeout(() => response.end(Buffer.from([2, 3])), 10);
    } });
    f.transport.notify = (event, value) => { if (event === "audioChunk") { chunks.push(Buffer.from(value.pcm, "base64")); f.transport.acknowledgeAudio({ requestId: value.requestId, sequence: value.sequence }); } };
    await expect(f.transport.speak({ requestId: randomUUID(), endpoint: f.endpoint, model: "tts", voice: "voice", speed: 1, text: "Hello" })).rejects.toMatchObject({ code: "speech_audio_invalid" });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2]));
  });

  it("aborts synthesis while awaiting playback acknowledgement", async () => {
    const f = await fixture(); const id = randomUUID();
    const speaking = f.transport.speak({ requestId: id, endpoint: f.endpoint, model: "tts", voice: "voice", speed: 1, text: "Hello" });
    const rejected = expect(speaking).rejects.toMatchObject({ code: "speech_cancelled" });
    await vi.waitFor(() => expect(f.notices).toHaveLength(1));
    f.transport.cancel({ requestId: id }); await rejected;
    expect(f.notices).toHaveLength(1);
    expect(() => f.transport.acknowledgeAudio({ requestId: id, sequence: 0 })).toThrow("no longer active");
  });

  it("does not treat a truncated synthesis stream as successful or replay it", async () => {
    const f = await fixture({ speech: (_request, response) => {
      response.writeHead(200, { "Content-Type": "audio/pcm; rate=24000; channels=1; format=s16le", "Content-Length": 9600 });
      response.write(Buffer.alloc(2400));
      setTimeout(() => response.destroy(), 15);
    }, notify: (event, value, transport) => { if (event === "audioChunk") transport.acknowledgeAudio({ requestId: value.requestId, sequence: value.sequence }); } });
    await expect(f.transport.speak({ requestId: randomUUID(), endpoint: f.endpoint, model: "tts", voice: "voice", speed: 1, text: "Hello" })).rejects.toMatchObject({ code: "speech_transport_failed" });
    expect(f.requests.filter((request) => request.url.endsWith("/speech"))).toHaveLength(1);
  });

  it("rejects authentication before audio and rejects redirects without forwarding credentials", async () => {
    const destination = await fixture();
    const f = await fixture({ capabilities: (_request, response) => response.writeHead(302, { Location: `${destination.endpoint}/audio/capabilities` }).end() });
    await expect(f.transport.getCapabilities({ endpoint: f.endpoint })).rejects.toMatchObject({ code: "speech_transport_failed" });
    expect(destination.requests).toHaveLength(0);
    const unauthorized = await fixture(); unauthorized.credentials.read.mockResolvedValue("wrong-secret");
    await expect(unauthorized.transport.startRecognition({ requestId: randomUUID(), endpoint: unauthorized.endpoint, model: "stt" })).rejects.toMatchObject({ code: "speech_unauthorized" });
    expect(unauthorized.peers).toHaveLength(0);
  });

  it("rejects incompatible HTTP audio content types", async () => {
    const f = await fixture({ speech: (_request, response) => response.writeHead(200, { "Content-Type": "audio/pcm; rate=16000; channels=1; format=s16le" }).end(Buffer.alloc(100)) });
    await expect(f.transport.speak({ requestId: randomUUID(), endpoint: f.endpoint, model: "tts", voice: "voice", speed: 1, text: "Hello" })).rejects.toMatchObject({ code: "speech_audio_invalid" });
    expect(f.notices).toEqual([]);
  });

  it("normalizes only valid endpoint bases without credentials, query strings or traversal", () => {
    expect(normalizeEndpoint("https://speech.example:443/prefix/v1/")).toBe("https://speech.example/prefix/v1");
    for (const endpoint of ["https://speech.example", "https://user:secret@speech.example/v1", "https://speech.example/v1?token=secret", "https://speech.example/v1#x", "file:///v1", "https://speech.example/a/../v1", "https://speech.example/a/%2e%2e/v1", "https://speech.example/a%2fv1", "https://speech.example\\v1"]) expect(() => normalizeEndpoint(endpoint)).toThrow();
  });
});
