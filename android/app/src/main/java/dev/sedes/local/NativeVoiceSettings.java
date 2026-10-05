package dev.sedes.local;

import java.net.URI;
import java.util.Iterator;
import java.util.Locale;
import org.json.JSONObject;

/** One canonical settings contract, owned by native code and updated by revision. */
final class NativeVoiceSettings {
    static final String[] FIELDS = { "audioMode", "autoListen", "ignoreOtherDevices", "readNotificationContext", "cleanSpeechText",
        "speechProvider", "speechEndpoint", "sttModel", "ttsModel", "ttsVoice", "ttsSpeed", "speechTextLimit", "voiceThreadId", "voiceThreadTitle", "pinDefaultVoiceThread", "onlyVoiceThread", "followComposerMode",
        "inputDeviceId", "recognitionStartTimeoutMs", "recognitionCompletionTimeoutMs", "recognitionResultTimeoutMs", "recognitionEndSilenceMs",
        "recognizeStopCommand", "recognitionCues", "cueGain", "startupPreRollMs", "ttsGain", "headsetControls" };
    /**
     * Stored records carry this explicit schema version and validate strictly against it. Adding, removing or changing a
     * field bumps the version. Obsolete records are rejected rather than migrated; there is no silent
     * aliasing or tolerance of missing fields. A record that fails validation is quarantined by the runtime and replaced
     * with defaults, so an unreadable or newer record cannot block voice.
     */
    static final int RECORD_VERSION = 4;
    static final String OPENAI_ENDPOINT = "https://api.openai.com/v1";
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
            "audioMode", "off", "autoListen", true, "ignoreOtherDevices", true, "readNotificationContext", true, "cleanSpeechText", true,
            "speechProvider", "openai", "speechEndpoint", OPENAI_ENDPOINT, "sttModel", "gpt-live-transcribe",
            "ttsModel", "gpt-4o-mini-tts", "ttsVoice", "coral", "ttsSpeed", 1.0, "speechTextLimit", 4096, "voiceThreadId", null, "voiceThreadTitle", null,
            "pinDefaultVoiceThread", false, "onlyVoiceThread", false, "followComposerMode", false, "inputDeviceId", null,
            "recognitionStartTimeoutMs", 30000, "recognitionCompletionTimeoutMs", 60000,
            "recognitionResultTimeoutMs", 60000, "recognitionEndSilenceMs", 1200, "recognizeStopCommand", true, "recognitionCues", true,
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
    double decimal(String key) { return value.optDouble(key); }
    boolean speechConfigured() { return !text("speechEndpoint").isEmpty() && !text("sttModel").isEmpty() &&
        !text("ttsModel").isEmpty() && !text("ttsVoice").isEmpty(); }
    String text(String key) { return value.isNull(key) ? null : value.optString(key); }
    boolean configured(boolean credentialConfigured) {
        return speechConfigured() && credentialConfigured;
    }
    NativeSpeechTransport.Config speechConfig(String credential) {
        return new NativeSpeechTransport.Config(text("speechEndpoint"), credential, text("sttModel"), text("ttsModel"),
            text("ttsVoice"), decimal("ttsSpeed"));
    }
    boolean speechConfigurationEquals(NativeVoiceSettings other) {
        for (String key : new String[] { "speechProvider", "speechEndpoint", "sttModel", "ttsModel", "ttsVoice" })
            if (!value.opt(key).equals(other.value.opt(key))) return false;
        return Double.compare(decimal("ttsSpeed"), other.decimal("ttsSpeed")) == 0;
    }
    JSONObject record() { return NativeVoiceJson.object("version", RECORD_VERSION, "revision", revision, "settings", value); }
    static NativeVoiceSettings fromRecord(JSONObject record) {
        NativeVoiceJson.keys(record, "version", "revision", "settings");
        NativeVoiceJson.integer(record, "version", RECORD_VERSION, RECORD_VERSION);
        return new NativeVoiceSettings(NativeVoiceJson.integer(record, "revision", 0, Long.MAX_VALUE),
            NativeVoiceJson.requiredObject(record, "settings"));
    }
    private static void validate(JSONObject value) {
        NativeVoiceJson.keys(value, FIELDS);
        for (String key : FIELDS) if (!value.has(key)) throw new IllegalArgumentException("missing_" + key);
        String mode = NativeVoiceJson.string(value, "audioMode", 16);
        if (!mode.equals("off") && !mode.equals("manual") && !mode.equals("response")) throw new NativeVoiceJson.InvalidFieldException("audioMode");
        for (String key : new String[] { "autoListen", "ignoreOtherDevices", "readNotificationContext", "cleanSpeechText", "pinDefaultVoiceThread", "onlyVoiceThread",
            "followComposerMode", "recognizeStopCommand", "recognitionCues", "headsetControls" }) NativeVoiceJson.bool(value, key);
        String provider = NativeVoiceJson.string(value, "speechProvider", 16);
        if (!provider.equals("openai") && !provider.equals("server")) throw new NativeVoiceJson.InvalidFieldException("speechProvider");
        Object url = value.opt("speechEndpoint");
        if (!(url instanceof String) || ((String) url).length() > 2048) throw new NativeVoiceJson.InvalidFieldException("speechEndpoint");
        if (!((String) url).isEmpty()) NativeVoiceJson.put(value, "speechEndpoint", speechBaseUrl((String) url));
        if (provider.equals("openai") && !OPENAI_ENDPOINT.equals(value.optString("speechEndpoint")))
            throw new NativeVoiceJson.InvalidFieldException("speechEndpoint");
        for (String key : new String[] { "sttModel", "ttsModel", "ttsVoice" }) {
            Object field = value.opt(key);
            if (!(field instanceof String) || ((String) field).length() > 160 ||
                !((String) field).equals(((String) field).trim()) || ((String) field).chars().anyMatch(Character::isISOControl))
                throw new NativeVoiceJson.InvalidFieldException(key);
        }
        Object speed = value.opt("ttsSpeed");
        if (!(speed instanceof Number) || !Double.isFinite(((Number) speed).doubleValue()) ||
            ((Number) speed).doubleValue() < 0.25 || ((Number) speed).doubleValue() > 4)
            throw new NativeVoiceJson.InvalidFieldException("ttsSpeed");
        NativeVoiceJson.integer(value, "speechTextLimit", 2, 4096);
        NativeVoiceJson.nullableString(value, "voiceThreadId", 160);
        NativeVoiceJson.nullableString(value, "voiceThreadTitle", 512);
        NativeVoiceJson.nullableString(value, "inputDeviceId", 80);
        NativeVoiceJson.integer(value, "recognitionStartTimeoutMs", 1000, 300000);
        NativeVoiceJson.integer(value, "recognitionCompletionTimeoutMs", 1000, 300000);
        NativeVoiceJson.integer(value, "recognitionResultTimeoutMs", 1000, 300000);
        NativeVoiceJson.integer(value, "recognitionEndSilenceMs", 100, 30000);
        NativeVoiceJson.integer(value, "cueGain", 0, 200);
        NativeVoiceJson.integer(value, "ttsGain", 0, 200);
        NativeVoiceJson.integer(value, "startupPreRollMs", 0, 5000);
    }
    static String origin(String input) {
        return httpUrl(input, false);
    }
    static String speechBaseUrl(String input) {
        return httpUrl(input, true);
    }
    private static String httpUrl(String input, boolean allowPath) {
        String field = allowPath ? "speechEndpoint" : "origin";
        if (input == null || input.isEmpty() || input.length() > 2048) throw new NativeVoiceJson.InvalidFieldException(field);
        try {
            URI uri = new URI(input);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String path = uri.getRawPath() == null ? "" : uri.getRawPath();
            if (!(scheme.equals("https") || scheme.equals("http")) || uri.getHost() == null || uri.getRawUserInfo() != null ||
                (!allowPath && !path.isEmpty() && !path.equals("/")) ||
                uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getPort() > 65535)
                throw new NativeVoiceJson.InvalidFieldException(field);
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (host.indexOf(':') >= 0 && !host.startsWith("[")) host = "[" + host + "]";
            int port = uri.getPort();
            while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
            return scheme + "://" + host + (port < 0 || (port == 443 && scheme.equals("https")) ||
                (port == 80 && scheme.equals("http")) ? "" : ":" + port) + path;
        } catch (java.net.URISyntaxException error) { throw new NativeVoiceJson.InvalidFieldException(field, error); }
    }
}
