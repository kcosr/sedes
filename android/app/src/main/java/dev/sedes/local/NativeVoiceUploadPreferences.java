package dev.sedes.local;

import org.json.JSONObject;

/** Device-local transfer quality, independent of semantic recording settings and saved PCM. */
final class NativeVoiceUploadPreferences {
    final long revision;
    final String audioQuality;

    private NativeVoiceUploadPreferences(long revision, String audioQuality) {
        if (revision < 0) throw new IllegalArgumentException("speech_audio_quality_invalid");
        this.revision = revision;
        this.audioQuality = validateQuality(audioQuality);
    }

    static NativeVoiceUploadPreferences defaults() { return new NativeVoiceUploadPreferences(0, "original"); }

    NativeVoiceUploadPreferences patch(long expectedRevision, String audioQuality) {
        if (expectedRevision != revision) throw new IllegalStateException("audio_quality_revision_conflict");
        if (revision == Long.MAX_VALUE) throw new IllegalStateException("audio_quality_revision_conflict");
        return new NativeVoiceUploadPreferences(revision + 1, audioQuality);
    }

    static String validateQuality(String audioQuality) {
        if (!"original".equals(audioQuality) && !"opus_high".equals(audioQuality) && !"opus_low".equals(audioQuality))
            throw new IllegalArgumentException("speech_audio_quality_invalid");
        return audioQuality;
    }

    JSONObject record() { return NativeVoiceJson.object("version", 1, "revision", revision, "audioQuality", audioQuality); }

    static NativeVoiceUploadPreferences fromRecord(JSONObject record) {
        NativeVoiceJson.keys(record, "version", "revision", "audioQuality");
        NativeVoiceJson.integer(record, "version", 1, 1);
        return new NativeVoiceUploadPreferences(NativeVoiceJson.integer(record, "revision", 0, Long.MAX_VALUE),
            NativeVoiceJson.string(record, "audioQuality", 16));
    }
}
