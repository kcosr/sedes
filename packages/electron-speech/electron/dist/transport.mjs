import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { enableSystemCertificateTrust } from "./tls-trust.mjs";
import {
  decodePcm, MAX_AUDIO_CHUNK_BYTES, MAX_PLAYBACK_CHUNK_BYTES, MAX_RESPONSE_BYTES,
  httpDateSeconds, object, openAiRecognitionModel, openAiSpeechModel, parseCapabilities, parseOpenAiModels,
  PCM_BYTES_PER_SECOND, providerBinding, REQUEST_TIMEOUT_MS,
  requestId, RESULT_TIMEOUT_MS, safeFailure, speechError, text,
} from "./contracts.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A session may fail before its caller reaches the corresponding await.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function cancelled() { return speechError("speech_cancelled", "Speech was cancelled."); }
function timeout() { return speechError("speech_timeout", "The speech server did not respond in time."); }
function protocolFailure() { return speechError("speech_protocol_invalid", "The speech server returned an invalid recognition response."); }

async function boundedBody(response, signal) {
  if (!response.body) throw speechError("speech_response_invalid", "The speech server returned an empty response.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw speechError("speech_response_invalid", "The speech server response exceeded its size limit.");
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw speechError("speech_response_invalid", "The speech server returned invalid JSON."); }
}

/** Native-owned HTTP/WebSocket transport. No retries, persisted audio, or admission behavior. */
export class SpeechTransport {
  constructor({ credentials, fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, notify = () => {},
    requestTimeoutMs = REQUEST_TIMEOUT_MS, resultTimeoutMs = RESULT_TIMEOUT_MS, audioAckTimeoutMs = 30_000 }) {
    enableSystemCertificateTrust();
    this.credentials = credentials;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.notify = notify;
    this.requestTimeoutMs = requestTimeoutMs;
    this.resultTimeoutMs = resultTimeoutMs;
    this.audioAckTimeoutMs = audioAckTimeoutMs;
    this.provider = null;
    this.endpoint = null;
    this.operations = new Map();
  }

  async configure(input) {
    object(input, ["provider", "endpoint"]);
    const { provider, endpoint } = providerBinding(input);
    if (this.provider !== provider || this.endpoint !== endpoint) { this.cancelAll(); this.provider = provider; this.endpoint = endpoint; }
    const status = await this.credentials.status(endpoint);
    if (this.provider !== provider || this.endpoint !== endpoint) throw speechError("speech_configuration_changed", "The speech connection changed while it was being configured.");
    return { provider, endpoint, ...status };
  }

  begin(input, kind) {
    const id = requestId(input.requestId);
    const { provider, endpoint } = providerBinding(input);
    if (provider !== this.provider || endpoint !== this.endpoint) throw speechError("speech_configuration_changed", "The speech connection changed. Start a new operation.");
    if (this.operations.has(id) || this.operations.size >= 4) throw speechError("speech_busy", "Another speech operation is still active.");
    const operation = { id, provider, endpoint, kind, controller: new AbortController(), timers: new Set(), done: false };
    this.operations.set(id, operation);
    return operation;
  }

  timer(operation, milliseconds, fail = () => this.fail(operation, timeout())) {
    const handle = setTimeout(() => { operation.timers.delete(handle); fail(); }, milliseconds);
    handle.unref?.();
    operation.timers.add(handle);
    return handle;
  }
  clearTimer(operation, handle) { if (handle) { clearTimeout(handle); operation.timers.delete(handle); } }
  check(operation) {
    if (operation.done || operation.controller.signal.aborted || this.operations.get(operation.id) !== operation) throw operation.failure ?? cancelled();
  }
  finish(operation) {
    if (operation.done) return;
    operation.done = true;
    for (const handle of operation.timers) clearTimeout(handle);
    operation.timers.clear();
    if (this.operations.get(operation.id) === operation) this.operations.delete(operation.id);
  }
  fail(operation, error, intentional = false) {
    if (operation.done) return;
    const failure = safeFailure(error);
    operation.failure = failure;
    operation.controller.abort(failure);
    operation.ready?.reject(failure);
    operation.pending?.ack.reject(failure);
    operation.pending?.result.reject(failure);
    operation.audioAck?.reject(failure);
    this.finish(operation);
    // terminate closes connecting and connected sockets, including a pending upgrade.
    operation.socket?.terminate();
    if (!intentional && operation.kind === "recognition" && operation.readyResolved) {
      this.notify("recognitionError", { requestId: operation.id, code: failure.code, message: failure.message });
    }
  }
  cancel(input) {
    object(input, ["requestId"]);
    const operation = this.operations.get(requestId(input.requestId));
    if (operation) this.fail(operation, cancelled(), true);
  }
  cancelAll() { for (const operation of [...this.operations.values()]) this.fail(operation, cancelled(), true); }
  operation(input, kind) {
    const operation = this.operations.get(requestId(input.requestId));
    if (!operation || operation.kind !== kind) throw speechError("speech_request_inactive", "This speech request is no longer active.");
    this.check(operation);
    return operation;
  }

  async token(operation) {
    const token = await this.credentials.read(operation.endpoint);
    this.check(operation);
    if (!token) throw speechError("speech_credential_missing", "Save a token for this speech endpoint first.");
    return token;
  }
  async http(operation, suffix, token, init = {}) {
    this.check(operation);
    const response = await this.fetch(`${operation.endpoint}${suffix}`, { ...init, redirect: "error",
      signal: operation.controller.signal, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    this.check(operation);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) throw speechError("speech_unauthorized", "The speech server rejected this token or model permission.");
      if (response.status === 429) throw speechError("speech_busy", "The speech server is busy. Try again after the current request finishes.");
      throw speechError("speech_request_failed", `The speech server rejected the request (HTTP ${response.status}).`);
    }
    return response;
  }
  async capabilities(operation, token) {
    const response = await this.http(operation, operation.provider === "openai" ? "/models" : "/audio/capabilities", token);
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      throw speechError("speech_response_invalid", "The speech server returned an unsupported capability format.");
    }
    const value = await boundedBody(response, operation.controller.signal);
    return operation.provider === "openai" ? parseOpenAiModels(value) : parseCapabilities(value);
  }
  async getCapabilities(input) {
    object(input, ["provider", "endpoint"]);
    const operation = this.begin({ ...input, requestId: randomUUID() }, "capabilities");
    this.timer(operation, this.requestTimeoutMs);
    try { return await this.capabilities(operation, await this.token(operation)); }
    catch (error) { this.fail(operation, error); throw operation.failure; }
    finally { this.finish(operation); }
  }

  async startRecognition(input) {
    object(input, ["requestId", "provider", "endpoint", "model"]);
    const modelId = text(input.model);
    const operation = this.begin(input, "recognition");
    operation.ready = deferred();
    operation.bufferBytes = 0;
    operation.previousItemId = null;
    operation.seenItemIds = new Set();
    operation.appendChain = Promise.resolve();
    operation.queuedAudioBytes = 0;
    const startupTimer = this.timer(operation, this.requestTimeoutMs);
    try {
      const token = await this.token(operation);
      // Hosted /models is advisory picker data. A fresh accepted session authorizes recognition.
      const model = operation.provider === "openai" ? openAiRecognitionModel(modelId)
        : (await this.capabilities(operation, token)).transcriptionModels.find((candidate) => candidate.id === modelId);
      this.check(operation);
      if (!model?.ready) throw speechError("speech_model_unavailable", "The selected recognition model is unavailable.");
      const limits = model.realtime;
      const maxRecordingSeconds = Math.min(60, Math.floor(limits.maxBufferBytes / PCM_BYTES_PER_SECOND));
      if (maxRecordingSeconds < 5 || limits.maxMessageBytes < 8_192 || limits.maxOutputBytes < MAX_RESPONSE_BYTES ||
          (operation.provider === "server" && limits.idleTimeoutSeconds < 40) ||
          limits.maxSessionSeconds < maxRecordingSeconds + this.resultTimeoutMs / 1000 + 45) {
        throw speechError("speech_limits_unsupported", "The speech server limits are too small for desktop recording.");
      }
      operation.model = modelId;
      operation.limits = limits;
      operation.maxBufferBytes = maxRecordingSeconds * PCM_BYTES_PER_SECOND;
      operation.maxRecordingSeconds = maxRecordingSeconds;
      operation.openedAt = performance.now();
      const url = new URL(`${operation.endpoint}/realtime`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("intent", "transcription");
      const socket = new this.WebSocket(url, { headers: { Authorization: `Bearer ${token}` },
        followRedirects: false, perMessageDeflate: false, maxPayload: MAX_RESPONSE_BYTES, handshakeTimeout: this.requestTimeoutMs });
      operation.socket = socket;
      socket.on("upgrade", (response) => {
        if (operation.done || operation.provider !== "openai") return;
        try { operation.providerDateSeconds = httpDateSeconds(response.headers.date); }
        catch (error) { this.fail(operation, error); }
      });
      socket.on("message", (data, binary) => {
        if (operation.done) return;
        try { this.recognitionMessage(operation, data, binary); }
        catch (error) { this.fail(operation, error); }
      });
      socket.on("error", () => this.fail(operation, speechError("speech_transport_failed", "The speech server recognition connection failed.")));
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        this.fail(operation, response.statusCode === 401 || response.statusCode === 403
          ? speechError("speech_unauthorized", "The speech server rejected this token or model permission.")
          : speechError("speech_transport_failed", "The speech server rejected the recognition connection."));
      });
      socket.on("close", () => this.fail(operation, speechError("speech_connection_closed", "The speech server closed the recognition session.")));
      if (operation.provider === "server") this.sessionDeadline(operation, operation.openedAt + limits.maxSessionSeconds * 1000);
      await operation.ready.promise;
      this.clearTimer(operation, startupTimer);
      this.check(operation);
      return { maxBufferBytes: operation.maxBufferBytes, maxRecordingSeconds,
        maxSessionSeconds: operation.provider === "openai" ? Math.max(0, (operation.expiresAt - performance.now()) / 1000) : limits.maxSessionSeconds };
    } catch (error) {
      this.fail(operation, error);
      throw operation.failure;
    }
  }

  sessionDeadline(operation, expiresAt) {
    // Every update may shorten the original lifetime, never extend it.
    operation.expiresAt = Math.min(operation.expiresAt ?? Infinity, expiresAt);
    this.clearTimer(operation, operation.sessionTimer);
    operation.sessionTimer = this.timer(operation, Math.max(1, Math.floor(operation.expiresAt - performance.now())),
      () => this.fail(operation, speechError("speech_session_expired", "The speech recognition session expired. Start a new recording.")));
  }

  hostedSessionLifetime(operation, session) {
    const expires = session.expires_at, date = operation.providerDateSeconds;
    const duration = expires - date;
    if (!Number.isSafeInteger(expires) || !Number.isFinite(date) || duration <= 1 || duration > 3622) {
      throw speechError("speech_session_lifetime_invalid", "OpenAI did not provide a valid recognition session lifetime.");
    }
    // Anchor to monotonic connection time and provider HTTP Date, independent of local clock skew.
    this.sessionDeadline(operation, operation.openedAt + Math.min(operation.limits.maxSessionSeconds, duration - 1) * 1000);
  }

  send(operation, event) {
    this.check(operation);
    const payload = JSON.stringify(event);
    if (operation.socket.readyState !== 1) throw speechError("speech_connection_closed", "The recognition connection is no longer open.");
    if (Buffer.byteLength(payload) > operation.limits.maxMessageBytes || operation.socket.bufferedAmount + Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) {
      throw speechError("speech_audio_backpressure", "The speech server cannot receive audio quickly enough.");
    }
    operation.socket.send(payload, (error) => { if (error) this.fail(operation, speechError("speech_transport_failed", "Sending speech audio failed.")); });
  }

  recognitionMessage(operation, data, binary) {
    if (binary || data.length > MAX_RESPONSE_BYTES) throw protocolFailure();
    let event;
    try { event = JSON.parse(data.toString("utf8")); } catch { throw protocolFailure(); }
    if (!event || typeof event.type !== "string") throw protocolFailure();
    if (event.type === "session.created") {
      if (operation.sessionId || operation.readyResolved) throw protocolFailure();
      operation.sessionId = text(event.session?.id, 256);
      if (event.session.type !== "transcription") throw protocolFailure();
      if (operation.provider === "openai") this.hostedSessionLifetime(operation, event.session);
      this.send(operation, { type: "session.update", event_id: `configure_${operation.id}`,
        session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24_000 },
          transcription: { model: operation.model }, noise_reduction: null, turn_detection: null } } } });
      return;
    }
    if (event.type === "session.updated") {
      const session = event.session, input = session?.audio?.input;
      if (!operation.sessionId || operation.readyResolved || session?.id !== operation.sessionId || session.type !== "transcription" ||
          input?.format?.type !== "audio/pcm" || input.format.rate !== 24_000 || input.transcription?.model !== operation.model ||
          input.noise_reduction !== null || input.turn_detection !== null) throw protocolFailure();
      if (operation.provider === "openai") {
        if (Object.hasOwn(session, "expires_at")) this.hostedSessionLifetime(operation, session);
        if (operation.expiresAt - performance.now() < (operation.maxRecordingSeconds + this.resultTimeoutMs / 1000 + 45) * 1000) {
          throw speechError("speech_limits_unsupported", "The recognition session is too short for desktop recording.");
        }
      }
      operation.readyResolved = true;
      operation.ready.resolve();
      return;
    }
    if (event.type === "error") throw speechError("speech_recognition_failed", "The speech server rejected recognition. Check the selected model and server limits.");
    if (operation.provider === "openai" && event.type === "conversation.created") {
      if (!operation.sessionId || operation.conversationId || event.conversation?.object !== "realtime.conversation") throw protocolFailure();
      operation.conversationId = text(event.conversation.id, 256);
      return;
    }
    if (!operation.readyResolved) throw protocolFailure();
    const pending = operation.pending;
    if (event.type === "input_audio_buffer.committed") {
      if (!pending || pending.itemId || event.previous_item_id !== operation.previousItemId) throw protocolFailure();
      pending.itemId = text(event.item_id, 256);
      if (operation.seenItemIds.has(pending.itemId)) throw protocolFailure();
      operation.seenItemIds.add(pending.itemId);
      operation.previousItemId = pending.itemId;
      operation.bufferBytes = 0;
      pending.ack.resolve();
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed" || event.type === "conversation.item.input_audio_transcription.failed") {
      if (!pending?.itemId || event.item_id !== pending.itemId || event.content_index !== 0) throw protocolFailure();
      if (event.type.endsWith(".failed")) throw speechError("speech_recognition_failed", "The speech server could not transcribe this recording.");
      if (typeof event.transcript !== "string" || Buffer.byteLength(event.transcript, "utf8") > 262_144 || event.transcript.includes("\u0000")) throw protocolFailure();
      this.clearTimer(operation, pending.timer);
      operation.pending = null;
      pending.result.resolve({ transcript: event.transcript });
      return;
    }
    // Deltas and metadata never become submitted text. Hosted GA and our server have explicit event contracts.
    // https://developers.openai.com/api/reference/resources/realtime/server-events
    const metadata = operation.provider === "openai" ? ["conversation.item.added", "conversation.item.done"] : ["conversation.item.created"];
    if (!["conversation.item.input_audio_transcription.delta", "rate_limits.updated", ...metadata].includes(event.type)) throw protocolFailure();
  }

  async appendAudio(input) {
    object(input, ["requestId", "pcm"]);
    const pcm = decodePcm(input.pcm, MAX_AUDIO_CHUNK_BYTES);
    const operation = this.operation(input, "recognition");
    if (!operation.readyResolved) throw speechError("speech_not_ready", "Wait for speech recognition to be ready.");
    if (operation.queuedAudioBytes + pcm.length > MAX_RESPONSE_BYTES) {
      const error = speechError("speech_audio_backpressure", "The speech server cannot receive audio quickly enough.");
      this.fail(operation, error);
      throw error;
    }
    operation.queuedAudioBytes += pcm.length;
    // Serialize appends so a commit cannot overtake an already accepted packet.
    const append = operation.appendChain.then(async () => {
      if (operation.pending && !operation.pending.itemId) await operation.pending.ack.promise;
      this.check(operation);
      if (operation.bufferBytes + pcm.length > operation.maxBufferBytes) throw speechError("speech_buffer_full", "The recognition segment reached its audio limit.");
      this.send(operation, { type: "input_audio_buffer.append", audio: input.pcm });
      operation.bufferBytes += pcm.length;
    });
    operation.appendChain = append;
    try { await append; }
    catch (error) { this.fail(operation, error); throw operation.failure; }
    finally { operation.queuedAudioBytes -= pcm.length; }
  }

  async commitRecognition(input) {
    object(input, ["requestId"]);
    const operation = this.operation(input, "recognition");
    if (operation.committing || operation.pending) throw speechError("speech_busy", "Wait for the previous recognition result before committing again.");
    operation.committing = true;
    try {
      await operation.appendChain;
      this.check(operation);
      if (!operation.readyResolved || operation.bufferBytes < PCM_BYTES_PER_SECOND / 10) throw speechError("speech_audio_too_short", "Record at least 100 milliseconds of audio before sending.");
      if (operation.seenItemIds.size >= 4096) throw speechError("speech_session_limit", "The speech session reached its segment limit. Start a new recording.");
      const pending = { ack: deferred(), result: deferred(), itemId: null };
      operation.pending = pending;
      pending.timer = this.timer(operation, this.resultTimeoutMs);
      this.send(operation, { type: "input_audio_buffer.commit" });
      return await pending.result.promise;
    } catch (error) {
      this.fail(operation, error);
      throw operation.failure;
    } finally { operation.committing = false; }
  }

  acknowledgeAudio(input) {
    object(input, ["requestId", "sequence"]);
    const operation = this.operation(input, "speech");
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || !operation.audioAck || input.sequence !== operation.sequence) {
      throw speechError("speech_audio_ack_invalid", "The playback acknowledgement is stale.");
    }
    operation.audioAck.resolve();
  }

  async speak(input) {
    object(input, ["requestId", "provider", "endpoint", "model", "voice", "speed", "text"]);
    const modelId = text(input.model), voice = text(input.voice);
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 65_536 ||
        input.text.includes("\u0000") || !Number.isFinite(input.speed) || input.speed <= 0) {
      throw speechError("speech_input_invalid", "Speech text or speed is invalid.");
    }
    const operation = this.begin(input, "speech");
    const initialTimer = this.timer(operation, this.requestTimeoutMs);
    // Limits total streaming time, including a stalled or abandoned renderer.
    this.timer(operation, 600_000);
    try {
      const token = await this.token(operation);
      const model = operation.provider === "openai" ? openAiSpeechModel(modelId)
        : (await this.capabilities(operation, token)).speechModels.find((candidate) => candidate.id === modelId);
      if (!model?.ready || !model.voices.some((candidate) => candidate.id === voice)) throw speechError("speech_model_unavailable", "The selected speech model or voice is unavailable.");
      if (input.text.length > model.maxTextLength || input.speed < model.speed.min || input.speed > model.speed.max) {
        throw speechError("speech_input_invalid", "Speech text or speed exceeds this model's limits.");
      }
      this.clearTimer(operation, initialTimer);
      const firstByteTimer = this.timer(operation, this.resultTimeoutMs);
      const response = await this.http(operation, "/audio/speech", token, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, voice, input: input.text, response_format: "pcm", speed: input.speed }) });
      this.validatePcmType(response.headers.get("content-type"), operation.provider);
      if (!response.body) throw speechError("speech_audio_invalid", "The speech server returned no audio.");
      this.clearTimer(operation, firstByteTimer);
      const reader = response.body.getReader();
      operation.sequence = 0;
      let tail = Buffer.alloc(0), total = 0;
      try {
        while (true) {
          this.check(operation);
          const readTimer = this.timer(operation, 30_000);
          const { value, done } = await reader.read();
          this.clearTimer(operation, readTimer);
          this.check(operation);
          if (done) break;
          total += value.byteLength;
          if (total > 28_800_000) throw speechError("speech_audio_limit", "Speech audio exceeded the ten-minute limit.");
          const bytes = tail.length ? Buffer.concat([tail, Buffer.from(value)]) : Buffer.from(value);
          const whole = bytes.length - bytes.length % 2;
          tail = bytes.subarray(whole);
          for (let offset = 0; offset < whole; offset += MAX_PLAYBACK_CHUNK_BYTES) {
            const chunk = bytes.subarray(offset, Math.min(whole, offset + MAX_PLAYBACK_CHUNK_BYTES));
            this.check(operation);
            operation.audioAck = deferred();
            const ackTimer = this.timer(operation, this.audioAckTimeoutMs);
            this.notify("audioChunk", { requestId: operation.id, sequence: operation.sequence, pcm: chunk.toString("base64") });
            await operation.audioAck.promise;
            this.clearTimer(operation, ackTimer);
            this.check(operation);
            operation.audioAck = null;
            operation.sequence++;
          }
        }
        if (!total || tail.length) throw speechError("speech_audio_invalid", "The speech server returned empty or incomplete PCM audio.");
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      this.finish(operation);
    } catch (error) {
      this.fail(operation, error);
      throw operation.failure;
    }
  }

  validatePcmType(value, provider) {
    const parts = (value ?? "").toLowerCase().split(";").map((part) => part.trim());
    // OpenAI documents raw 24 kHz PCM without parameters. Our server advertises the full contract.
    if (provider === "openai" && parts.length === 1 && ["audio/pcm", "application/octet-stream"].includes(parts[0])) return;
    const parameters = new Map();
    for (const part of parts.slice(1)) {
      const pair = /^([a-z]+)=([^=]+)$/u.exec(part);
      if (!pair || parameters.has(pair[1])) throw speechError("speech_audio_invalid", "The speech server returned an unsupported audio format.");
      parameters.set(pair[1], pair[2]);
    }
    if (parts[0] !== "audio/pcm" || parameters.size !== 3 || parameters.get("rate") !== "24000" ||
        parameters.get("channels") !== "1" || parameters.get("format") !== "s16le") {
      throw speechError("speech_audio_invalid", "The speech server must return mono PCM16LE audio at 24 kHz.");
    }
  }
}
