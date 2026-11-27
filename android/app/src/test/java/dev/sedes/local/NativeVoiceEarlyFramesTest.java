package dev.sedes.local;

import static org.junit.Assert.assertThrows;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceEarlyFramesTest {
    static final String STREAM = "2f6b360b-d9f1-4311-a239-6bfa129c2bd6";
    static final String TOKEN = "r".repeat(41) + "-_";

    private static JSONObject frame(String kind, int sequence) {
        return NativeVoiceJson.object("kind", kind, "replyId", "a".repeat(64), "threadId", STREAM,
            "turnId", "turn-id", "itemId", "item-id", "generation", 7, "seq", sequence);
    }

    static JSONObject begin() {
        JSONObject begin = frame("begin", 0);
        NativeVoiceJson.put(begin, "event", "turn.completed");
        NativeVoiceJson.put(begin, "threadTitle", "🦦");
        NativeVoiceJson.put(begin, "userInputRevision", 3);
        NativeVoiceJson.put(begin, "origin", NativeVoiceJson.object("clientId", STREAM));
        NativeVoiceJson.put(begin, "rawStart", 0);
        NativeVoiceJson.put(begin, "rawEnd", 4);
        NativeVoiceJson.put(begin, "text", "🦦. ");
        NativeVoiceJson.put(begin, "paragraphEnd", false);
        return begin;
    }

    private static void rejects(JSONObject source, String key, Object value) {
        JSONObject copy = NativeVoiceJson.copy(source);
        NativeVoiceJson.put(copy, key, value);
        assertThrows(key, IllegalArgumentException.class, () -> NativeVoiceEarlyFrames.reply(copy));
    }

    @Test public void validatesTypedRangesIdentitiesAndMetadata() {
        JSONObject begin = begin();
        NativeVoiceEarlyFrames.reply(begin);
        rejects(begin, "progressParkRevision", 0);
        NativeVoiceJson.put(begin, "event", "turn.progress");
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceEarlyFrames.reply(begin));
        NativeVoiceJson.put(begin, "progressParkRevision", 0);
        rejects(begin, "progressParkRevision", -1);
        NativeVoiceEarlyFrames.reply(begin);
        rejects(begin, "event", "turn.partial");
        JSONObject missingEvent = NativeVoiceJson.copy(begin); missingEvent.remove("event");
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceEarlyFrames.reply(missingEvent));
        rejects(begin, "replyId", "A".repeat(64));
        rejects(begin, "threadId", "thread-id");
        rejects(begin, "turnId", "");
        rejects(begin, "itemId", "x".repeat(513));
        rejects(begin, "seq", 1);
        rejects(begin, "unknown", "field");
        rejects(begin, "rawStart", 1);
        rejects(begin, "rawEnd", 3); // An astral scalar counts as two UTF-16 units.
        rejects(begin, "paragraphEnd", "false");
        rejects(begin, "origin", NativeVoiceJson.object("clientId", STREAM, "message", "extra"));
        rejects(begin, "threadTitle", "x\udc00");
        rejects(begin, "generation", NativeVoiceEarlyFrames.MAX_REVISION + 1);
        rejects(begin, "userInputRevision", 1.1);
        rejects(begin, "text", "bad\ud800");
        begin.remove("origin");
        NativeVoiceEarlyFrames.reply(begin);
        begin.remove("text");
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceEarlyFrames.reply(begin));
    }

    @Test public void appendMayOnlyBeEmptyForABoundaryAndUsesBothByteAndOffsetCaps() {
        JSONObject append = frame("append", 255);
        NativeVoiceJson.put(append, "rawStart", 8192);
        NativeVoiceJson.put(append, "rawEnd", 8192);
        NativeVoiceJson.put(append, "text", "");
        NativeVoiceJson.put(append, "paragraphEnd", true);
        NativeVoiceEarlyFrames.reply(append);
        rejects(append, "event", "turn.progress");
        rejects(append, "seq", 256);
        rejects(append, "paragraphEnd", false);
        rejects(append, "rawEnd", 8193);
        rejects(append, "threadTitle", "");
        NativeVoiceJson.put(append, "rawStart", 0);
        NativeVoiceJson.put(append, "text", "x".repeat(8192));
        NativeVoiceEarlyFrames.reply(append);
        rejects(append, "text", "é".repeat(8192));
        JSONObject empty = begin();
        NativeVoiceJson.put(empty, "rawEnd", 0);
        NativeVoiceJson.put(empty, "paragraphEnd", true);
        rejects(empty, "text", "");
    }

    @Test public void controlFramesOnlyAcceptReasonsForTheirOwnKind() {
        JSONObject yield = frame("yield", 256);
        NativeVoiceJson.put(yield, "reason", "item_done");
        NativeVoiceEarlyFrames.reply(yield);
        rejects(yield, "seq", 0);
        rejects(yield, "reason", "expired");
        rejects(yield, "paragraphEnd", false);
        JSONObject cancel = frame("cancel", 1);
        NativeVoiceJson.put(cancel, "reason", "publication_suppressed");
        NativeVoiceEarlyFrames.reply(cancel);
        rejects(cancel, "reason", "item_done");
    }

    @Test public void handshakeRequiresThisExactStreamAndSafeTokenAndRevision() {
        JSONObject session = NativeVoiceJson.object("voiceStreamId", STREAM, "revision", 0, "token", TOKEN);
        NativeVoiceEarlyFrames.session(session, STREAM);
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceEarlyFrames.session(session, "other"));
        NativeVoiceJson.put(session, "revision", "0");
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceEarlyFrames.session(session, STREAM));
        NativeVoiceJson.put(session, "revision", 0);
        NativeVoiceJson.put(session, "token", "r".repeat(42) + "=");
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceEarlyFrames.session(session, STREAM));
    }
}
