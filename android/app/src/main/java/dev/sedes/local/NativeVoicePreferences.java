package dev.sedes.local;

import java.util.Iterator;
import org.json.JSONObject;

/** One atomic device record, with thread selections explicitly partitioned by authenticated Sedes binding. */
final class NativeVoicePreferences {
    private final long revision;
    private final JSONObject preferences, threads;
    private NativeVoicePreferences(long revision, JSONObject preferences, JSONObject threads) {
        this.revision = revision; this.preferences = NativeVoiceJson.copy(preferences); this.threads = NativeVoiceJson.copy(threads);
    }
    static NativeVoicePreferences defaults() {
        return new NativeVoicePreferences(0, devicePreferences(NativeVoiceSettings.defaults()), new JSONObject());
    }
    private static JSONObject devicePreferences(NativeVoiceSettings settings) {
        JSONObject value = NativeVoiceJson.copy(settings.value);
        value.remove("voiceThreadId"); value.remove("voiceThreadTitle");
        return value;
    }
    NativeVoiceSettings settings(String binding) {
        validateBinding(binding);
        JSONObject value = NativeVoiceJson.copy(preferences), selection = threads.optJSONObject(binding);
        NativeVoiceJson.put(value, "voiceThreadId", selection == null ? null : selection.opt("voiceThreadId"));
        NativeVoiceJson.put(value, "voiceThreadTitle", selection == null ? null : selection.opt("voiceThreadTitle"));
        return new NativeVoiceSettings(revision, value);
    }
    NativeVoicePreferences update(String binding, NativeVoiceSettings settings) {
        validateBinding(binding);
        JSONObject nextThreads = NativeVoiceJson.copy(threads);
        if (settings.text("voiceThreadId") == null && settings.text("voiceThreadTitle") == null) nextThreads.remove(binding);
        else NativeVoiceJson.put(nextThreads, binding, NativeVoiceJson.object("voiceThreadId", settings.text("voiceThreadId"),
            "voiceThreadTitle", settings.text("voiceThreadTitle")));
        return new NativeVoicePreferences(settings.revision, devicePreferences(settings), nextThreads);
    }
    NativeVoicePreferences removeProfile(String profile) {
        JSONObject nextThreads = NativeVoiceJson.copy(threads);
        for (Iterator<String> keys = nextThreads.keys(); keys.hasNext();) if (keys.next().startsWith(profile + "\n")) keys.remove();
        // Other bindings and their observable settings have not changed.
        return new NativeVoicePreferences(revision, preferences, nextThreads);
    }
    JSONObject record() {
        return NativeVoiceJson.object("version", 1, "settingsVersion", NativeVoiceSettings.RECORD_VERSION,
            "revision", revision, "preferences", NativeVoiceJson.copy(preferences), "threads", NativeVoiceJson.copy(threads));
    }
    static NativeVoicePreferences fromRecord(JSONObject record) {
        NativeVoiceJson.keys(record, "version", "settingsVersion", "revision", "preferences", "threads");
        NativeVoiceJson.integer(record, "version", 1, 1);
        NativeVoiceJson.integer(record, "settingsVersion", NativeVoiceSettings.RECORD_VERSION, NativeVoiceSettings.RECORD_VERSION);
        long revision = NativeVoiceJson.integer(record, "revision", 0, Long.MAX_VALUE);
        JSONObject preferences = NativeVoiceJson.requiredObject(record, "preferences"), threads = NativeVoiceJson.requiredObject(record, "threads");
        if (preferences.has("voiceThreadId") || preferences.has("voiceThreadTitle")) throw new IllegalArgumentException("device_preferences_scope_invalid");
        JSONObject value = NativeVoiceJson.copy(preferences);
        NativeVoiceJson.put(value, "voiceThreadId", null); NativeVoiceJson.put(value, "voiceThreadTitle", null);
        new NativeVoiceSettings(revision, value);
        for (Iterator<String> keys = threads.keys(); keys.hasNext();) {
            String binding = keys.next(); validateBinding(binding);
            JSONObject selection = NativeVoiceJson.requiredObject(threads, binding);
            NativeVoiceJson.keys(selection, "voiceThreadId", "voiceThreadTitle");
            if (!selection.has("voiceThreadId") || !selection.has("voiceThreadTitle")) throw new IllegalArgumentException("thread_selection_invalid");
            NativeVoiceJson.nullableString(selection, "voiceThreadId", 160);
            NativeVoiceJson.nullableString(selection, "voiceThreadTitle", 512);
        }
        return new NativeVoicePreferences(revision, preferences, threads);
    }
    private static void validateBinding(String binding) {
        String[] parts = binding.split("\n", -1);
        if (parts.length != 3 || !binding.equals(NativeVoiceStore.binding(parts[0], parts[1], parts[2])))
            throw new IllegalArgumentException("voice_identity_invalid");
    }
}
