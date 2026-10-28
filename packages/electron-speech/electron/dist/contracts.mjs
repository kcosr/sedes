export const PCM_BYTES_PER_SECOND = 48_000;
export const MAX_AUDIO_CHUNK_BYTES = 4_800;
export const MAX_PLAYBACK_CHUNK_BYTES = 9_600;
export const MAX_RESPONSE_BYTES = 524_288;
export const REQUEST_TIMEOUT_MS = 15_000;
export const RESULT_TIMEOUT_MS = 180_000;
export const OPENAI_ENDPOINT = "https://api.openai.com/v1";
export const OPENAI_TRANSCRIPTION_MODELS = Object.freeze([
  "gpt-live-transcribe", "gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1",
]);

export function speechError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function object(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    throw speechError("speech_input_invalid", "Speech input is invalid.");
  }
  return value;
}

export function text(value, maximum = 256) {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw speechError("speech_input_invalid", "Speech input is invalid.");
  }
  return value;
}

export function requestId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw speechError("speech_input_invalid", "Speech request identity is invalid.");
  }
  return value;
}

export function normalizeEndpoint(value) {
  try {
    text(value, 2_048);
    if (/[\\?#]/u.test(value) || value !== value.trim()) throw new Error();
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error();
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (!pathname.endsWith("/v1")) throw new Error();
    // Never normalize a supplied traversal into a different credential binding.
    const rawPath = /^https?:\/\/[^/]+(\/.*)?$/iu.exec(value)?.[1] ?? "/";
    if (rawPath.replace(/\/+$/u, "") !== pathname || /%(?:2f|5c)/iu.test(pathname)) throw new Error();
    return `${url.origin}${pathname}`;
  } catch {
    throw speechError("speech_endpoint_invalid", "Enter an HTTP or HTTPS speech API base ending in /v1, without credentials, a query, or a fragment.");
  }
}

/** Providers are explicit. The hosted key can only be used at the fixed OpenAI API base. */
export function providerBinding(input) {
  if (!["openai", "server"].includes(input?.provider)) throw speechError("speech_provider_invalid", "Choose OpenAI or your own speech server.");
  const endpoint = normalizeEndpoint(input.endpoint);
  if (input.provider === "openai" ? endpoint !== OPENAI_ENDPOINT : new URL(endpoint).hostname === "api.openai.com") {
    throw speechError("speech_endpoint_invalid", input.provider === "openai"
      ? "OpenAI speech uses https://api.openai.com/v1. Its endpoint cannot be changed."
      : "Choose OpenAI to connect to the hosted OpenAI speech endpoint.");
  }
  return { provider: input.provider, endpoint };
}

/** Local application limits, not capability claims inferred from the hosted /models catalog. */
export function openAiRecognitionModel(id) {
  if (!OPENAI_TRANSCRIPTION_MODELS.includes(id)) throw speechError("speech_model_unsupported", "This OpenAI recognition model is not supported.");
  return { id, label: id, ready: true, realtime: {
    maxBufferBytes: 60 * PCM_BYTES_PER_SECOND, maxMessageBytes: 1_048_576, maxOutputBytes: 1_048_576,
    idleTimeoutSeconds: 0, maxSessionSeconds: 3600,
  } };
}

export function openAiSpeechModel(id) {
  if (typeof id !== "string" || !/^(?:gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?|tts-1(?:-hd)?(?:-\d{4})?)$/u.test(id)) return undefined;
  // /models supplies availability hints; voices and controls follow the documented families.
  // https://developers.openai.com/api/docs/guides/text-to-speech (reviewed 2026-10-28)
  const voices = id.startsWith("gpt-4o-mini-tts")
    ? ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"]
    : ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];
  return { id, label: id, ready: true, voices: voices.map((voice) => ({ id: voice, label: voice })),
    speed: { min: 0.25, max: 4, default: 1 }, maxTextLength: 4096, sampleRate: 24_000 };
}

export function parseOpenAiModels(value) {
  try {
    if (!value || value.object !== "list" || !Array.isArray(value.data) || value.data.length > 10_000) throw new Error();
    const transcriptionModels = [], speechModels = [], seen = new Set();
    for (const entry of value.data) {
      const id = text(entry?.id);
      if (seen.has(id)) throw new Error();
      seen.add(id);
      if (OPENAI_TRANSCRIPTION_MODELS.includes(id)) transcriptionModels.push(openAiRecognitionModel(id));
      const speech = openAiSpeechModel(id);
      if (speech) speechModels.push(speech);
    }
    return { transcriptionModels, speechModels };
  } catch {
    throw speechError("speech_capabilities_invalid", "OpenAI returned an invalid model catalog.");
  }
}

export function httpDateSeconds(value) {
  if (typeof value !== "string" || !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) {
    throw speechError("speech_session_lifetime_invalid", "OpenAI did not provide a valid recognition session lifetime.");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toUTCString() !== value) {
    throw speechError("speech_session_lifetime_invalid", "OpenAI did not provide a valid recognition session lifetime.");
  }
  return milliseconds / 1000;
}

export function bearerToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~+\/-]{1,4096}={0,2}$/u.test(value)) {
    throw speechError("speech_credential_invalid", "Enter a valid speech API key or server bearer token.");
  }
  return value;
}

function number(value, { integer = false, zero = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (zero ? value < 0 : value <= 0) ||
      value > maximum || (integer && !Number.isSafeInteger(value))) throw new Error();
  return value;
}

export function parseCapabilities(value) {
  try {
    if (!value || value.object !== "list" || !Array.isArray(value.data) || value.data.length > 256) throw new Error();
    const transcriptionModels = [], speechModels = [], ids = new Set();
    for (const model of value.data) {
      if (!model || !["transcription", "speech"].includes(model.task)) throw new Error();
      const id = text(model.id), label = text(model.display_label ?? id, 512);
      if (ids.has(id) || typeof model.ready !== "boolean") throw new Error();
      ids.add(id);
      if (model.task === "transcription") {
        const realtime = model.realtime;
        if (!realtime || typeof realtime !== "object") throw new Error();
        const maxBufferBytes = number(realtime.max_buffer_bytes, { integer: true, zero: true });
        if (maxBufferBytes % 2) throw new Error();
        transcriptionModels.push({ id, label, ready: model.ready, realtime: {
          maxBufferBytes,
          maxMessageBytes: number(realtime.max_message_bytes, { integer: true }),
          maxOutputBytes: number(realtime.max_output_bytes, { integer: true }),
          idleTimeoutSeconds: number(realtime.idle_timeout_seconds, { maximum: 2_147_483 }),
          maxSessionSeconds: number(realtime.max_session_seconds, { maximum: 2_147_483 }),
        } });
      } else {
        if (!Array.isArray(model.voices) || model.voices.length > 512 || !Array.isArray(model.output_formats)) throw new Error();
        // This client has one explicit playback format; unsupported models are not selectable.
        if (model.audio?.sample_rate !== 24_000 || model.audio?.channels !== 1 ||
            !model.output_formats.some((format) => format.id === "pcm" && format.encoding === "pcm_s16le")) continue;
        const seen = new Set();
        const voices = model.voices.map((voice) => {
          const voiceId = text(voice.id);
          if (seen.has(voiceId)) throw new Error();
          seen.add(voiceId);
          return { id: voiceId, label: text(voice.display_label ?? voiceId, 512) };
        });
        const speed = { min: number(model.speed?.min), max: number(model.speed?.max), default: number(model.speed?.default) };
        if (speed.min > speed.default || speed.default > speed.max) throw new Error();
        speechModels.push({ id, label, ready: model.ready, voices, speed,
          maxTextLength: number(model.max_text_length, { integer: true }), sampleRate: 24_000 });
      }
    }
    return { transcriptionModels, speechModels };
  } catch {
    throw speechError("speech_capabilities_invalid", "The speech server returned unsupported capabilities.");
  }
}

export function decodePcm(value, maximum = MAX_AUDIO_CHUNK_BYTES) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw speechError("speech_audio_invalid", "Speech audio must be bounded PCM16LE.");
  }
  const result = Buffer.from(value, "base64");
  if (!result.length || result.length % 2 || result.length > maximum || result.toString("base64") !== value) {
    throw speechError("speech_audio_invalid", "Speech audio must contain complete PCM16LE samples.");
  }
  return result;
}

export function safeFailure(error) {
  if (error?.code?.startsWith("speech_") && typeof error.message === "string") return error;
  return speechError("speech_transport_failed", "The speech service connection failed. Check the endpoint and try again.");
}
