package dev.sedes.local;

import org.json.JSONObject;

/** A separately versioned device preference, independent of recording configuration and recovery. */
final class NativeEarlyReplyPreferences {
    static final long MAX_REVISION = 9007199254740991L;
    final long revision;
    final String mode;

    private NativeEarlyReplyPreferences(long revision, String mode) {
        if (!mode.equals("off") && !mode.equals("responsive") && !mode.equals("balanced") && !mode.equals("natural"))
            throw new IllegalArgumentException("early_reply_playback_invalid");
        this.revision = revision;
        this.mode = mode;
    }

    static NativeEarlyReplyPreferences defaults() { return new NativeEarlyReplyPreferences(0, "off"); }

    NativeEarlyReplyPreferences patch(long expected, String next) {
        if (expected != revision || revision == MAX_REVISION) throw new IllegalStateException("early_reply_revision_conflict");
        return new NativeEarlyReplyPreferences(revision + 1, next);
    }

    JSONObject record() { return NativeVoiceJson.object("version", 1, "revision", revision, "earlyReplyPlayback", mode); }

    static NativeEarlyReplyPreferences fromRecord(JSONObject value) {
        NativeVoiceJson.keys(value, "version", "revision", "earlyReplyPlayback");
        NativeVoiceJson.integer(value, "version", 1, 1);
        return new NativeEarlyReplyPreferences(NativeVoiceJson.integer(value, "revision", 0, MAX_REVISION),
            NativeVoiceJson.string(value, "earlyReplyPlayback", 16));
    }
}
