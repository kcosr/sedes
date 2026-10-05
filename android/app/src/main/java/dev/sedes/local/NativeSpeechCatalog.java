package dev.sedes.local;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONArray;
import org.json.JSONObject;

/** Picker discovery is advisory. Every server recording separately fetches fresh selected-model limits. */
final class NativeSpeechCatalog {
    interface Result { void done(JSONObject catalog, String errorCode); }
    interface PreflightResult { void done(NativeSpeechCapabilities capabilities, String errorCode); }
    private static final int MAX_BYTES = 1024 * 1024;
    private static final OkHttpClient HTTP = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(45, TimeUnit.SECONDS).build();
    static Call fetch(NativeVoiceSettings settings, String credential, Result callback) {
        return request(settings, credential, settings.text("speechProvider").equals("openai") ? "/models" : "/audio/capabilities", false, callback);
    }
    /** No picker cache participates. Runtime fences this result by binding, configuration and credential revision. */
    static Call preflight(NativeVoiceSettings settings, String credential, PreflightResult callback) {
        if (settings.text("speechProvider").equals("openai")) {
            try { callback.done(NativeSpeechCapabilities.hosted(settings.text("sttModel")), null); }
            catch (IllegalArgumentException unsupported) { callback.done(null, "speech_transcription_model_unsupported"); }
            return null;
        }
        return request(settings, credential, "/audio/capabilities", false, (catalog, error) -> {
            if (error != null) { callback.done(null, error.equals("speech_discovery_invalid") ? "speech_server_configuration_unsupported" : error); return; }
            try { callback.done(serverCapabilities(catalog, settings.text("sttModel")), null); }
            catch (IllegalArgumentException unsupported) { callback.done(null, unsupported.getMessage()); }
        });
    }
    /** Credential tests use a standard authenticated endpoint and do not generate billable audio. */
    static Call test(NativeVoiceSettings settings, String credential, Result callback) {
        return request(settings, credential, "/models", true, callback);
    }
    private static Call request(NativeVoiceSettings settings, String credential, String path, boolean test, Result callback) {
        final Call call;
        try {
            if (settings.text("speechEndpoint").isEmpty()) throw new IllegalArgumentException("speech_configuration_required");
            if (credential != null && !credential.matches("[\\x21-\\x7e]{1,4096}")) throw new IllegalArgumentException("speech_discovery_invalid");
            Request.Builder request = new Request.Builder().url(settings.text("speechEndpoint") + path).get().header("Accept", "application/json");
            if (credential != null) request.header("Authorization", "Bearer " + credential);
            call = HTTP.newCall(request.build());
        } catch (IllegalArgumentException error) { callback.done(null, "speech_discovery_invalid"); return null; }
        call.enqueue(new Callback() {
            public void onFailure(Call call, IOException error) { callback.done(null, call.isCanceled() ? "speech_discovery_cancelled" : "speech_discovery_unavailable"); }
            public void onResponse(Call call, Response response) {
                try (Response owned = response) {
                    int status = response.code();
                    if (status < 200 || status >= 300) {
                        callback.done(null, status == 401 || status == 403 ? "speech_authentication_failed" :
                            status == 404 && path.equals("/audio/capabilities") ? "speech_server_configuration_unsupported" : "speech_discovery_unavailable"); return;
                    }
                    ResponseBody body = response.body();
                    if (body == null || body.contentLength() > MAX_BYTES) throw new IOException("invalid_catalog");
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    InputStream input = body.byteStream(); byte[] chunk = new byte[8192]; int read;
                    while ((read = input.read(chunk)) != -1) {
                        if (buffer.size() + read > MAX_BYTES) throw new IOException("invalid_catalog");
                        buffer.write(chunk, 0, read);
                    }
                    byte[] bytes = buffer.toByteArray();
                    JSONObject value = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                    if (!"list".equals(value.optString("object")) || value.optJSONArray("data") == null) throw new IOException("invalid_catalog");
                    callback.done(test && !settings.text("speechProvider").equals("openai") ? empty("server") :
                        settings.text("speechProvider").equals("openai") ? openai(value, settings.text("ttsModel")) : server(value, settings.text("ttsModel")), null);
                } catch (Exception error) { callback.done(null, "speech_server_configuration_unsupported".equals(error.getMessage()) ?
                    "speech_server_configuration_unsupported" : "speech_discovery_invalid"); }
            }
        });
        return call;
    }
    static JSONObject empty(String source) {
        return NativeVoiceJson.object("source", source, "sttModels", new JSONArray(), "ttsModels", new JSONArray(),
            "voices", new JSONArray(), "speed", null, "formats", new JSONArray(), "realtime", new JSONObject());
    }
    /** The bridge exposes choices only; recognition authority stays in the native fresh-preflight result. */
    static JSONObject picker(JSONObject catalog) {
        if (catalog == null) return null;
        JSONObject result = new JSONObject();
        for (String key : new String[] { "source", "sttModels", "ttsModels", "voices", "speed", "formats" })
            NativeVoiceJson.put(result, key, catalog.opt(key));
        return NativeVoiceJson.copy(result);
    }
    static JSONObject openai(JSONObject listing, String speechModel) {
        JSONObject catalog = empty("openai");
        Set<String> stt = new LinkedHashSet<>(), tts = new LinkedHashSet<>();
        JSONArray data = listing.optJSONArray("data");
        if (data == null || data.length() > 10000) throw new IllegalArgumentException("speech_discovery_invalid");
        for (int i = 0; i < data.length(); i++) {
            JSONObject entry = data.optJSONObject(i);
            if (entry == null) throw new IllegalArgumentException("speech_discovery_invalid");
            String id = identifier(entry, "id");
            if (NativeSpeechCapabilities.HOSTED_MODELS.contains(id)) {
                stt.add(id); NativeVoiceJson.put(catalog.optJSONObject("realtime"), id, NativeSpeechCapabilities.hosted(id).realtime());
            }
            if (knownSpeechModel(id)) tts.add(id);
        }
        NativeVoiceJson.put(catalog, "sttModels", array(stt)); NativeVoiceJson.put(catalog, "ttsModels", array(tts));
        // /models cannot report voices or controls. These are maintained from the documented model families.
        // https://developers.openai.com/api/docs/guides/text-to-speech (reviewed 2026-10-04)
        if (knownSpeechModel(speechModel)) {
            boolean mini = speechModel.startsWith("gpt-4o-mini-tts");
            String[] voices = mini ? new String[] { "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar" } :
                new String[] { "alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer" };
            JSONArray options = new JSONArray(); for (String voice : voices) options.put(voice);
            NativeVoiceJson.put(catalog, "voices", options);
            NativeVoiceJson.put(catalog, "speed", NativeVoiceJson.object("min", 0.25, "max", 4));
            NativeVoiceJson.put(catalog, "formats", new JSONArray().put("pcm"));
        }
        return catalog;
    }
    private static boolean knownSpeechModel(String id) {
        return id.matches("gpt-4o-mini-tts(?:-\\d{4}-\\d{2}-\\d{2})?") || id.matches("tts-1(?:-hd)?(?:-\\d{4})?");
    }
    static JSONObject server(JSONObject listing, String speechModel) {
        JSONObject catalog = empty("server");
        JSONArray data = listing.optJSONArray("data");
        if (data == null || data.length() > 10000) throw new IllegalArgumentException("speech_discovery_invalid");
        Set<String> stt = new LinkedHashSet<>(), tts = new LinkedHashSet<>();
        for (int i = 0; i < data.length(); i++) {
            JSONObject model = data.optJSONObject(i);
            if (model == null) throw new IllegalArgumentException("speech_discovery_invalid");
            String id = identifier(model, "id"), task = model.optString("task");
            if (task.equals("transcription")) {
                if (!stt.add(id)) throw new IllegalArgumentException("speech_server_configuration_unsupported");
                JSONObject realtime = model.optJSONObject("realtime");
                validateRealtime(realtime, false);
                NativeVoiceJson.put(catalog.optJSONObject("realtime"), id, NativeVoiceJson.copy(realtime));
            }
            if (!task.equals("speech")) continue;
            tts.add(id);
            if (!id.equals(speechModel)) continue;
            JSONArray voices = new JSONArray(), formats = new JSONArray();
            JSONArray advertised = model.optJSONArray("voices");
            if (advertised != null) for (int j = 0; j < advertised.length(); j++) voices.put(identifier(advertised.optJSONObject(j), "id"));
            advertised = model.optJSONArray("output_formats");
            if (advertised != null) for (int j = 0; j < advertised.length(); j++) formats.put(identifier(advertised.optJSONObject(j), "id"));
            JSONObject speed = model.optJSONObject("speed");
            if (speed != null) {
                Object min = speed.opt("min"), max = speed.opt("max");
                if (!(min instanceof Number) || !(max instanceof Number) || !Double.isFinite(((Number) min).doubleValue()) ||
                    !Double.isFinite(((Number) max).doubleValue()) || ((Number) min).doubleValue() <= 0 || ((Number) max).doubleValue() < ((Number) min).doubleValue())
                    throw new IllegalArgumentException("speech_discovery_invalid");
                NativeVoiceJson.put(catalog, "speed", NativeVoiceJson.object("min", min, "max", max));
            }
            NativeVoiceJson.put(catalog, "voices", voices); NativeVoiceJson.put(catalog, "formats", formats);
        }
        NativeVoiceJson.put(catalog, "sttModels", array(stt)); NativeVoiceJson.put(catalog, "ttsModels", array(tts));
        return catalog;
    }
    static NativeSpeechCapabilities serverCapabilities(JSONObject catalog, String model) {
        JSONObject realtime = catalog == null ? null : catalog.optJSONObject("realtime");
        if (catalog == null || !"server".equals(catalog.optString("source")) || realtime == null || !realtime.has(model))
            throw new IllegalArgumentException("speech_transcription_model_unsupported");
        return NativeSpeechCapabilities.server(model, realtime.optJSONObject(model));
    }
    /** Preserve truthful low limits for other picker entries; support thresholds apply to the selected model. */
    static void validateRealtime(JSONObject realtime, boolean hosted) {
        try {
            NativeVoiceJson.keys(realtime, "max_buffer_bytes", "max_message_bytes", "max_output_bytes", "idle_timeout_seconds", "max_session_seconds");
            long bytes = NativeVoiceJson.integer(realtime, "max_buffer_bytes", 0, 9007199254740991L);
            if ((bytes & 1) != 0) throw new IllegalArgumentException();
            NativeVoiceJson.integer(realtime, "max_message_bytes", 1, 9007199254740991L);
            NativeVoiceJson.integer(realtime, "max_output_bytes", 1, 9007199254740991L);
            NativeSpeechCapabilities.timeoutMs(realtime, "idle_timeout_seconds", hosted);
            NativeSpeechCapabilities.timeoutMs(realtime, "max_session_seconds", false);
        } catch (Exception invalid) { throw new IllegalArgumentException("speech_server_configuration_unsupported"); }
    }
    private static String identifier(JSONObject entry, String key) {
        if (entry == null) throw new IllegalArgumentException("speech_discovery_invalid");
        String value = NativeVoiceJson.string(entry, key, 160);
        if (!value.equals(value.trim()) || value.chars().anyMatch(Character::isISOControl)) throw new IllegalArgumentException("speech_discovery_invalid");
        return value;
    }
    private static JSONArray array(Set<String> values) { JSONArray result = new JSONArray(); for (String value : values) result.put(value); return result; }
}
