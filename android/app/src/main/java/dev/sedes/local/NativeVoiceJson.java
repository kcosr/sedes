package dev.sedes.local;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Small strict JSON helpers shared by the bridge, wire protocol and encrypted records. */
final class NativeVoiceJson {
    private NativeVoiceJson() {}
    static JSONObject object(Object... pairs) {
        JSONObject value = new JSONObject();
        for (int i = 0; i < pairs.length; i += 2) put(value, (String) pairs[i], pairs[i + 1]);
        return value;
    }
    static void put(JSONObject value, String name, Object field) {
        try { value.put(name, field == null ? JSONObject.NULL : field); }
        catch (JSONException error) { throw new IllegalArgumentException("invalid_json", error); }
    }
    static JSONObject copy(JSONObject value) {
        try { return new JSONObject(value.toString()); }
        catch (JSONException error) { throw new IllegalArgumentException("invalid_json", error); }
    }
    static void keys(JSONObject value, String... names) {
        Set<String> allowed = new HashSet<>(Arrays.asList(names));
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) {
            if (!allowed.contains(keys.next())) throw new IllegalArgumentException("unknown_field");
        }
    }
    static String string(JSONObject value, String key, int max) {
        Object field = value.opt(key);
        if (!(field instanceof String) || ((String) field).isEmpty() || ((String) field).length() > max)
            throw new IllegalArgumentException("invalid_" + key);
        return (String) field;
    }
    static String nullableString(JSONObject value, String key, int max) {
        if (!value.has(key) || value.isNull(key)) return null;
        return string(value, key, max);
    }
    static boolean bool(JSONObject value, String key) {
        Object field = value.opt(key);
        if (!(field instanceof Boolean)) throw new IllegalArgumentException("invalid_" + key);
        return (Boolean) field;
    }
    static long integer(JSONObject value, String key, long min, long max) {
        Object field = value.opt(key);
        if (!(field instanceof Number)) throw new IllegalArgumentException("invalid_" + key);
        Number number = (Number) field;
        long result = number.longValue();
        if (number.doubleValue() != result || result < min || result > max)
            throw new IllegalArgumentException("invalid_" + key);
        return result;
    }
    static JSONObject requiredObject(JSONObject value, String key) {
        JSONObject result = value.optJSONObject(key);
        if (result == null) throw new IllegalArgumentException("invalid_" + key);
        return result;
    }
    static int bytes(String value) { return value.getBytes(StandardCharsets.UTF_8).length; }
    static JSONArray array(Iterable<JSONObject> values) {
        JSONArray result = new JSONArray();
        for (JSONObject value : values) result.put(copy(value));
        return result;
    }
}
