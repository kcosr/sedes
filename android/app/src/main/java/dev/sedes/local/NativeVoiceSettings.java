package dev.sedes.local;

import java.net.URI;
import java.util.Iterator;
import java.util.Locale;
import org.json.JSONObject;

/** One canonical settings contract, owned by native code and updated by revision. */
final class NativeVoiceSettings {
    static final String[] FIELDS = { "audioMode", "autoListen", "ignoreOtherDevices", "readNotificationContext",
        "adapterUrl", "adapterTextLimit", "voiceThreadId", "voiceThreadTitle", "onlyVoiceThread", "followComposerMode",
        "inputDeviceId", "recognitionStartTimeoutMs", "recognitionCompletionTimeoutMs", "recognitionEndSilenceMs",
        "recognizeStopCommand", "recognitionCues", "cueGain", "startupPreRollMs", "ttsGain", "headsetControls" };
    final long revision;
    final JSONObject value;
    NativeVoiceSettings(long revision, JSONObject value) {
        if (revision < 0) throw new IllegalArgumentException("invalid_settings_revision");
        validate(value);
        this.revision = revision;
        this.value = NativeVoiceJson.copy(value);
    }
    static NativeVoiceSettings defaults() {
        return new NativeVoiceSettings(0, NativeVoiceJson.object(
            "audioMode", "off", "autoListen", true, "ignoreOtherDevices", true, "readNotificationContext", true,
            "adapterUrl", "", "adapterTextLimit", 5000, "voiceThreadId", null, "voiceThreadTitle", null,
            "onlyVoiceThread", false, "followComposerMode", false, "inputDeviceId", null,
            "recognitionStartTimeoutMs", 30000, "recognitionCompletionTimeoutMs", 60000,
            "recognitionEndSilenceMs", 1200, "recognizeStopCommand", true, "recognitionCues", true,
            "cueGain", 100, "startupPreRollMs", 512, "ttsGain", 100, "headsetControls", true));
    }
    NativeVoiceSettings patch(long expectedRevision, JSONObject patch) {
        if (expectedRevision != revision) throw new IllegalStateException("settings_revision_conflict");
        NativeVoiceJson.keys(patch, FIELDS);
        JSONObject next = NativeVoiceJson.copy(value);
        Iterator<String> keys = patch.keys();
        while (keys.hasNext()) { String key = keys.next(); NativeVoiceJson.put(next, key, patch.opt(key)); }
        return new NativeVoiceSettings(revision + 1, next);
    }
    String mode() { return value.optString("audioMode"); }
    boolean active() { return !"off".equals(mode()); }
    boolean flag(String key) { return value.optBoolean(key); }
    int number(String key) { return value.optInt(key); }
    String text(String key) { return value.isNull(key) ? null : value.optString(key); }
    JSONObject record() { return NativeVoiceJson.object("version", 1, "revision", revision, "settings", value); }
    static NativeVoiceSettings fromRecord(JSONObject record) {
        NativeVoiceJson.keys(record, "version", "revision", "settings");
        NativeVoiceJson.integer(record, "version", 1, 1);
        return new NativeVoiceSettings(NativeVoiceJson.integer(record, "revision", 0, Long.MAX_VALUE),
            NativeVoiceJson.requiredObject(record, "settings"));
    }
    private static void validate(JSONObject value) {
        NativeVoiceJson.keys(value, FIELDS);
        for (String key : FIELDS) if (!value.has(key)) throw new IllegalArgumentException("missing_" + key);
        String mode = NativeVoiceJson.string(value, "audioMode", 16);
        if (!mode.equals("off") && !mode.equals("manual") && !mode.equals("response")) throw new IllegalArgumentException("invalid_audioMode");
        for (String key : new String[] { "autoListen", "ignoreOtherDevices", "readNotificationContext", "onlyVoiceThread",
            "followComposerMode", "recognizeStopCommand", "recognitionCues", "headsetControls" }) NativeVoiceJson.bool(value, key);
        Object url = value.opt("adapterUrl");
        if (!(url instanceof String) || ((String) url).length() > 2048) throw new IllegalArgumentException("invalid_adapterUrl");
        if (!((String) url).isEmpty()) NativeVoiceJson.put(value, "adapterUrl", adapterBaseUrl((String) url));
        NativeVoiceJson.integer(value, "adapterTextLimit", 2, 100000);
        NativeVoiceJson.nullableString(value, "voiceThreadId", 160);
        NativeVoiceJson.nullableString(value, "voiceThreadTitle", 512);
        NativeVoiceJson.nullableString(value, "inputDeviceId", 80);
        NativeVoiceJson.integer(value, "recognitionStartTimeoutMs", 1000, 300000);
        NativeVoiceJson.integer(value, "recognitionCompletionTimeoutMs", 1000, 300000);
        NativeVoiceJson.integer(value, "recognitionEndSilenceMs", 100, 30000);
        NativeVoiceJson.integer(value, "cueGain", 0, 200);
        NativeVoiceJson.integer(value, "ttsGain", 0, 200);
        NativeVoiceJson.integer(value, "startupPreRollMs", 0, 5000);
    }
    static String origin(String input) {
        return httpUrl(input, false);
    }
    static String adapterBaseUrl(String input) {
        return httpUrl(input, true);
    }
    private static String httpUrl(String input, boolean allowPath) {
        String errorCode = allowPath ? "invalid_adapterUrl" : "invalid_origin";
        try {
            URI uri = new URI(input);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String path = uri.getRawPath() == null ? "" : uri.getRawPath();
            if (!(scheme.equals("https") || scheme.equals("http")) || uri.getHost() == null || uri.getRawUserInfo() != null ||
                (!allowPath && !path.isEmpty() && !path.equals("/")) ||
                uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getPort() > 65535)
                throw new IllegalArgumentException(errorCode);
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (host.indexOf(':') >= 0 && !host.startsWith("[")) host = "[" + host + "]";
            int port = uri.getPort();
            while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
            return scheme + "://" + host + (port < 0 || (port == 443 && scheme.equals("https")) ||
                (port == 80 && scheme.equals("http")) ? "" : ":" + port) + path;
        } catch (java.net.URISyntaxException error) { throw new IllegalArgumentException(errorCode, error); }
    }
}
