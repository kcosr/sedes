package dev.sedes.local;

import java.math.BigDecimal;
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
    /** Field names are source-defined schema keys; field values never enter bridge error codes. */
    static final class InvalidFieldException extends IllegalArgumentException {
        InvalidFieldException(String field) { super("invalid_" + field); }
        InvalidFieldException(String field, Throwable cause) { super("invalid_" + field, cause); }
    }
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
            throw new InvalidFieldException(key);
        return (String) field;
    }
    static String nullableString(JSONObject value, String key, int max) {
        if (!value.has(key) || value.isNull(key)) return null;
        return string(value, key, max);
    }
    static boolean bool(JSONObject value, String key) {
        Object field = value.opt(key);
        if (!(field instanceof Boolean)) throw new InvalidFieldException(key);
        return (Boolean) field;
    }
    static long integer(JSONObject value, String key, long min, long max) {
        Object field = value.opt(key);
        if (!(field instanceof Number)) throw new InvalidFieldException(key);
        Number number = (Number) field;
        long result = number.longValue();
        if (number.doubleValue() != result || result < min || result > max)
            throw new InvalidFieldException(key);
        return result;
    }
    static JSONObject requiredObject(JSONObject value, String key) {
        JSONObject result = value.optJSONObject(key);
        if (result == null) throw new InvalidFieldException(key);
        return result;
    }
    static int bytes(String value) { return value.getBytes(StandardCharsets.UTF_8).length; }
    /**
     * UTF-8 size of ECMAScript JSON.stringify output, the server's payload measure. Unlike toString(), it does not
     * depend on this platform's org.json escaping (Android writes every '/' as "\/").
     */
    static long serializedBytes(Object value) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; long total = 2;
            for (Iterator<String> keys = object.keys(); keys.hasNext();) {
                String key = keys.next(); total += serializedBytes(key) + 1 + serializedBytes(object.opt(key)) + (keys.hasNext() ? 1 : 0);
            }
            return total;
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value; long total = 2 + Math.max(0, array.length() - 1);
            for (int i = 0; i < array.length(); i++) total += serializedBytes(array.opt(i));
            return total;
        }
        if (value instanceof String) {
            String text = (String) value; long total = 2;
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (c == '"' || c == '\\' || c == '\b' || c == '\f' || c == '\n' || c == '\r' || c == '\t') total += 2;
                else if (c < 0x20) total += 6;
                else if (c < 0x80) total += 1;
                else if (c < 0x800) total += 2;
                else if (Character.isHighSurrogate(c) && i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) { total += 4; i++; }
                else total += Character.isSurrogate(c) ? 6 : 3;
            }
            return total;
        }
        if (value instanceof Boolean) return (Boolean) value ? 4 : 5;
        if (value instanceof Number) {
            // Payload numbers are bounded integers, which ECMAScript prints without exponent or fraction.
            double number = ((Number) value).doubleValue();
            return number == Math.rint(number) && Math.abs(number) < 1e21 ? new BigDecimal(number).toBigInteger().toString().length() : value.toString().length();
        }
        return 4;
    }
    static JSONArray array(Iterable<JSONObject> values) {
        JSONArray result = new JSONArray();
        for (JSONObject value : values) result.put(copy(value));
        return result;
    }
}
