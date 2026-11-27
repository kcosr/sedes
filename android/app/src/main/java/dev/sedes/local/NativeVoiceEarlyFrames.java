package dev.sedes.local;

import org.json.JSONObject;

/** Wire validation for ephemeral early-reply frames, before they enter the native queue. */
final class NativeVoiceEarlyFrames {
    static final long MAX_REVISION = NativeVoiceJson.MAX_SAFE_INTEGER;
    static final int MAX_PREFIX_BYTES = 8 * 1024;
    private NativeVoiceEarlyFrames() {}

    static void session(JSONObject frame, String streamId) {
        NativeVoiceJson.keys(frame, "voiceStreamId", "token", "revision");
        if (!streamId.equals(NativeVoiceProtocol.uuid(frame, "voiceStreamId"))) throw new IllegalArgumentException("invalid_voiceStreamId");
        token(frame);
        NativeVoiceJson.integer(frame, "revision", 0, MAX_REVISION);
    }

    static void token(JSONObject frame) {
        if (!NativeVoiceJson.string(frame, "token", 43).matches("[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("invalid_token");
    }

    static void reply(JSONObject frame) {
        String kind = NativeVoiceProtocol.choice(frame, "kind", "begin", "append", "yield", "cancel");
        if (!NativeVoiceJson.string(frame, "replyId", 64).matches("[0-9a-f]{64}")) throw new IllegalArgumentException("invalid_replyId");
        NativeVoiceProtocol.uuid(frame, "threadId");
        NativeVoiceJson.string(frame, "turnId", 160);
        NativeVoiceJson.string(frame, "itemId", 512);
        NativeVoiceJson.integer(frame, "generation", 0, MAX_REVISION);
        if (kind.equals("begin")) {
            NativeVoiceJson.keys(frame, "kind", "replyId", "threadId", "turnId", "itemId", "generation", "seq",
                "event", "threadTitle", "userInputRevision", "origin", "rawStart", "rawEnd", "text", "paragraphEnd");
            NativeVoiceProtocol.choice(frame, "event", "turn.completed", "turn.progress");
            NativeVoiceJson.integer(frame, "seq", 0, 0);
            unicode(frame, "threadTitle", 512);
            NativeVoiceJson.integer(frame, "userInputRevision", 0, MAX_REVISION);
            if (frame.has("origin")) {
                JSONObject origin = NativeVoiceJson.requiredObject(frame, "origin");
                NativeVoiceJson.keys(origin, "clientId");
                NativeVoiceProtocol.uuid(origin, "clientId");
            }
            range(frame, true);
        } else if (kind.equals("append")) {
            NativeVoiceJson.keys(frame, "kind", "replyId", "threadId", "turnId", "itemId", "generation", "seq",
                "rawStart", "rawEnd", "text", "paragraphEnd");
            NativeVoiceJson.integer(frame, "seq", 1, 255);
            range(frame, false);
        } else {
            NativeVoiceJson.keys(frame, "kind", "replyId", "threadId", "turnId", "itemId", "generation", "seq", "reason");
            NativeVoiceJson.integer(frame, "seq", 1, 256);
            if (kind.equals("yield")) NativeVoiceProtocol.choice(frame, "reason", "markup", "item_done", "limit", "stall");
            else NativeVoiceProtocol.choice(frame, "reason", "source_changed", "authority_lost", "superseded",
                "policy_changed", "publication_suppressed", "expired");
        }
        if (NativeVoiceJson.serializedBytes(frame) > 65_536) throw new IllegalArgumentException("voice_frame_too_large");
    }

    private static void range(JSONObject frame, boolean begin) {
        long start = NativeVoiceJson.integer(frame, "rawStart", 0, begin ? 0 : MAX_PREFIX_BYTES);
        long end = NativeVoiceJson.integer(frame, "rawEnd", start, MAX_PREFIX_BYTES);
        String text = unicode(frame, "text", MAX_PREFIX_BYTES);
        boolean paragraphEnd = NativeVoiceJson.bool(frame, "paragraphEnd");
        if (end - start != text.length() || NativeVoiceJson.bytes(text) > MAX_PREFIX_BYTES ||
            (text.isEmpty() && (begin || !paragraphEnd))) throw new IllegalArgumentException("invalid_early_range");
    }

    private static String unicode(JSONObject frame, String key, int limit) {
        String text = NativeVoiceProtocol.text(frame, key, limit);
        for (int index = 0; index < text.length(); index++) {
            char c = text.charAt(index);
            if (Character.isHighSurrogate(c)) {
                if (index + 1 >= text.length() || !Character.isLowSurrogate(text.charAt(index + 1)))
                    throw new IllegalArgumentException("invalid_early_unicode");
                index++;
            } else if (Character.isLowSurrogate(c)) throw new IllegalArgumentException("invalid_early_unicode");
        }
        return text;
    }
}
