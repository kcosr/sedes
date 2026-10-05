package dev.sedes.local;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/** Disposable discovery metadata. The encrypted store also authenticates the native owner binding. */
final class NativeSpeechCatalogCache {
    static final long FRESH_MS = 60 * 60 * 1000;
    final String scope;
    final long fetchedAt;
    final JSONObject catalog;

    NativeSpeechCatalogCache(String scope, long fetchedAt, JSONObject catalog) {
        if (scope == null || !scope.matches("[a-f0-9]{64}") || fetchedAt < 0) throw new IllegalArgumentException("speech_catalog_invalid");
        validate(catalog);
        this.scope = scope; this.fetchedAt = fetchedAt; this.catalog = NativeVoiceJson.copy(catalog);
    }

    static String scope(String binding, NativeVoiceSettings settings, String credential) {
        // Separate exact recognition/synthesis choices and credentials; this remains advisory, never a preflight.
        JSONArray values = new JSONArray().put(binding).put(settings.text("speechProvider")).put(settings.text("speechEndpoint"))
            .put(settings.text("sttModel")).put(settings.text("ttsModel")).put(credential == null ? JSONObject.NULL : credential);
        try {
            StringBuilder result = new StringBuilder();
            for (byte value : MessageDigest.getInstance("SHA-256").digest(values.toString().getBytes(StandardCharsets.UTF_8)))
                result.append(String.format(Locale.ROOT, "%02x", value & 255));
            return result.toString();
        } catch (NoSuchAlgorithmException error) { throw new IllegalStateException("speech_catalog_unavailable", error); }
    }

    boolean fresh(long now) { return now >= fetchedAt && now - fetchedAt < FRESH_MS; }
    JSONObject record() { return NativeVoiceJson.object("version", 2, "scope", scope, "fetchedAt", fetchedAt, "catalog", NativeVoiceJson.copy(catalog)); }
    static NativeSpeechCatalogCache fromRecord(JSONObject record) {
        NativeVoiceJson.keys(record, "version", "scope", "fetchedAt", "catalog");
        NativeVoiceJson.integer(record, "version", 2, 2);
        return new NativeSpeechCatalogCache(NativeVoiceJson.string(record, "scope", 64),
            NativeVoiceJson.integer(record, "fetchedAt", 0, Long.MAX_VALUE), NativeVoiceJson.requiredObject(record, "catalog"));
    }

    private static void validate(JSONObject catalog) {
        NativeVoiceJson.keys(catalog, "source", "sttModels", "ttsModels", "voices", "speed", "formats", "realtime");
        String source = NativeVoiceJson.string(catalog, "source", 6);
        if (!source.equals("openai") && !source.equals("server")) throw new IllegalArgumentException("speech_catalog_invalid");
        for (String key : new String[] { "sttModels", "ttsModels", "voices", "formats" }) {
            JSONArray values = catalog.optJSONArray(key);
            if (values == null || values.length() > 10000) throw new IllegalArgumentException("speech_catalog_invalid");
            for (int i = 0; i < values.length(); i++) {
                Object item = values.opt(i);
                if (!(item instanceof String)) throw new IllegalArgumentException("speech_catalog_invalid");
                String id = (String) item;
                if (id.isEmpty() || id.length() > 160 || !id.equals(id.trim()) || id.chars().anyMatch(Character::isISOControl))
                    throw new IllegalArgumentException("speech_catalog_invalid");
            }
        }
        JSONObject realtime = NativeVoiceJson.requiredObject(catalog, "realtime");
        java.util.Set<String> models = new java.util.HashSet<>();
        JSONArray stt = catalog.optJSONArray("sttModels");
        for (int index = 0; index < stt.length(); index++) {
            String model = stt.optString(index);
            if (!models.add(model)) throw new IllegalArgumentException("speech_catalog_invalid");
            NativeSpeechCatalog.validateRealtime(realtime.optJSONObject(model), source.equals("openai"));
            if (source.equals("openai")) {
                JSONObject expected = NativeSpeechCapabilities.hosted(model).realtime();
                for (java.util.Iterator<String> keys = expected.keys(); keys.hasNext();) {
                    String key = keys.next();
                    if (expected.optLong(key) != realtime.optJSONObject(model).optLong(key)) throw new IllegalArgumentException("speech_catalog_invalid");
                }
            }
        }
        for (java.util.Iterator<String> keys = realtime.keys(); keys.hasNext();) if (!models.contains(keys.next()))
            throw new IllegalArgumentException("speech_catalog_invalid");
        if (!catalog.has("speed")) throw new IllegalArgumentException("speech_catalog_invalid");
        if (!catalog.isNull("speed")) {
            JSONObject speed = NativeVoiceJson.requiredObject(catalog, "speed");
            NativeVoiceJson.keys(speed, "min", "max");
            Object min = speed.opt("min"), max = speed.opt("max");
            if (!(min instanceof Number) || !(max instanceof Number) || !Double.isFinite(((Number) min).doubleValue()) ||
                !Double.isFinite(((Number) max).doubleValue()) || ((Number) min).doubleValue() <= 0 ||
                ((Number) max).doubleValue() < ((Number) min).doubleValue()) throw new IllegalArgumentException("speech_catalog_invalid");
        }
    }
}
