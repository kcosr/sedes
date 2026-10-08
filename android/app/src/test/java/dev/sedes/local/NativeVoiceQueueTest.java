package dev.sedes.local;

import static org.junit.Assert.*;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceQueueTest {
    private NativeVoiceSettings settings(String mode) {
        return NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("audioMode", mode));
    }
    private JSONObject envelope(String id, String event, String text, String subject) {
        JSONObject result = NativeVoiceJson.object("sourceEventId", id, "generation", 1, "voice", "speakThenListen",
            "recognitionTarget", NativeVoiceJson.object("threadId", "thread-a", "activityToken", "epoch-1"),
            "payload", NativeVoiceJson.object("schemaVersion", 4, "notificationId", id, "event", event,
                "occurredAt", "2026-10-03T00:00:00Z", "title", "Completed", "message", "Workspace: Example",
                "thread", NativeVoiceJson.object("id", "thread-a", "title", "Thread A"),
                "assistantResult", NativeVoiceJson.object("final", NativeVoiceJson.object("text", text))));
        if (subject != null) NativeVoiceJson.put(result, "subjectId", subject);
        if (event.equals("turn.progress") || event.endsWith(".requested")) NativeVoiceJson.put(result, "voice", "speak");
        if (event.equals("turn.progress")) NativeVoiceJson.put(result.optJSONObject("payload"), "progress", NativeVoiceJson.object("itemId", id, "text", text));
        return result;
    }
    @Test public void manualCompletionIsSilentWithOnlyItsEligibleFollowup() {
        NativeVoiceQueue.Item item = new NativeVoiceQueue.Item(envelope("one", "turn.completed", "Answer", null), settings("manual"));
        assertEquals("", item.speech); assertTrue(item.followUp);
        JSONObject notice = envelope("two", "thread.woke", "Answer", "wake-1");
        NativeVoiceQueue.Item standalone = new NativeVoiceQueue.Item(notice, settings("manual"));
        assertFalse(standalone.speech.isEmpty()); assertFalse(standalone.followUp);
        NativeVoiceJson.put(notice, "voice", "speak");
        NativeVoiceQueue.Item speak = new NativeVoiceQueue.Item(notice, settings("response"));
        assertFalse(speak.followUp);
    }
    @Test public void equivalentAttentionIsReplacedAtArrivalPosition() {
        NativeVoiceQueue queue = new NativeVoiceQueue();
        queue.add(new NativeVoiceQueue.Item(envelope("old", "approval.requested", "", "approval-a"), settings("response")));
        queue.add(new NativeVoiceQueue.Item(envelope("middle", "turn.completed", "Middle", null), settings("response")));
        queue.add(new NativeVoiceQueue.Item(envelope("new", "approval.requested", "", "approval-a"), settings("response")));
        assertEquals(2, queue.size()); assertEquals("middle", queue.take().id); assertEquals("new", queue.take().id);
    }
    @Test public void responseOverflowEvictsOnlyOldestProgressAndPreservesOrder() {
        NativeVoiceQueue queue = new NativeVoiceQueue();
        for (int i = 0; i < 64; i++) queue.add(new NativeVoiceQueue.Item(envelope("item-" + i,
            i == 2 ? "turn.progress" : "turn.completed", "Text", null), settings("response")));
        assertTrue(queue.add(new NativeVoiceQueue.Item(envelope("last", "turn.completed", "Text", null), settings("response"))));
        assertEquals(64, queue.size()); assertEquals("item-0", queue.take().id); assertEquals("item-1", queue.take().id); assertEquals("item-3", queue.take().id);
        assertEquals(1, queue.state().optInt("droppedCount"));
    }
    @Test public void exhaustedProgressEvictionNeverDropsTerminalContent() {
        NativeVoiceQueue queue = new NativeVoiceQueue();
        for (int i = 0; i < 64; i++) queue.add(new NativeVoiceQueue.Item(envelope("item-" + i, "turn.completed", "Text", null), settings("response")));
        assertFalse(queue.add(new NativeVoiceQueue.Item(envelope("last", "turn.progress", "Text", null), settings("response"))));
        assertFalse(queue.add(new NativeVoiceQueue.Item(envelope("terminal-overflow", "turn.completed", "Text", null), settings("response"))));
        assertEquals(64, queue.size());
    }
    @Test public void speechBytesIncludeContextAndTerminalParts() {
        NativeVoiceQueue queue = new NativeVoiceQueue();
        for (int i = 0; i < 30; i++) queue.add(new NativeVoiceQueue.Item(envelope("big-" + i, "turn.completed", "é".repeat(7000), null), settings("response")));
        assertTrue(queue.bytes() <= NativeVoiceQueue.MAX_BYTES); assertTrue(queue.size() < 30); assertTrue(queue.state().optInt("droppedCount") > 0);
    }
    @Test public void remembersCompletedAndRejectedSources() {
        NativeVoiceQueue queue = new NativeVoiceQueue();
        for (int i = 0; i < 4096; i++) { assertTrue(queue.remember("event-" + i)); }
        assertFalse(queue.remember("event-0")); assertFalse(queue.remember("event-4095"));
    }
    @Test public void finishingLongActiveSpeechRefreshesItsCompletedDedupPosition() {
        NativeVoiceQueue queue = new NativeVoiceQueue();
        queue.remember("long-active");
        for (int i = 0; i < 5000; i++) queue.remember("later-" + i);
        queue.completed("long-active");
        assertFalse(queue.remember("long-active"));
        for (int i = 0; i < 4096; i++) queue.remember("new-" + i);
        assertFalse(queue.remember("long-active"));
    }
    @Test public void chunksPreserveAllUtf16TextWithoutSplittingSurrogates() {
        String text = "A sentence. " + "🦦".repeat(4000) + " And another sentence.";
        List<String> parts = NativeVoiceQueue.chunks(text, 5000);
        assertEquals(text, String.join("", parts)); assertTrue(parts.size() > 1);
        for (String part : parts) { assertTrue(part.length() <= 5000); assertFalse(Character.isHighSurrogate(part.charAt(part.length() - 1))); }
    }
    @Test public void localStopGrammarDoesNotConsumeNormalCommands() {
        assertTrue(NativeVoiceQueue.isStopCommand(" Stop listening! ")); assertTrue(NativeVoiceQueue.isStopCommand("STOP。"));
        assertFalse(NativeVoiceQueue.isStopCommand("do not stop")); assertFalse(NativeVoiceQueue.isStopCommand("stop the server"));
    }
    @Test public void pendingPresentationReevaluatesModesAndCancelledRearmDoesNotReturn() {
        NativeVoiceQueue queue = new NativeVoiceQueue();
        queue.add(new NativeVoiceQueue.Item(envelope("pending", "turn.completed", "Answer", null), settings("response")));
        queue.reconfigure(settings("manual")); assertEquals(0, queue.bytes());
        queue.reconfigure(settings("response")); assertTrue(queue.bytes() > 0);
        queue.cancelFollowups(); queue.reconfigure(settings("response")); assertFalse(queue.take().followUp);
    }
    @Test public void cleanupPrecedesChunkingAndPreservesTheOriginalNotification() {
        String markdown = "# Answer\n\nRead [the long reference label][ref].\n\n```java\nfoo_bar = a * 2;\n```\n\n[ref]: https://example.test/hidden";
        JSONObject source = envelope("formatted", "turn.completed", markdown, null);
        NativeVoiceSettings clean = settings("response").patch(1, NativeVoiceJson.object("readNotificationContext", false));
        NativeVoiceQueue.Item item = new NativeVoiceQueue.Item(source, clean);
        String expected = "Answer\n\nRead the long reference label.\n\nfoo_bar = a * 2;";
        assertEquals(expected, item.speech);
        List<String> chunks = NativeVoiceQueue.chunks(item.speech, 16);
        assertTrue(chunks.size() > 1); assertEquals(expected, String.join("", chunks));
        assertEquals(markdown, item.envelope.optJSONObject("payload").optJSONObject("assistantResult").optJSONObject("final").optString("text"));
        assertEquals(source.toString(), item.envelope.toString());
        NativeVoiceSettings raw = clean.patch(2, NativeVoiceJson.object("cleanSpeechText", false));
        NativeVoiceQueue queue = new NativeVoiceQueue(); queue.add(item);
        queue.reconfigure(raw); NativeVoiceQueue.Item pending = queue.take();
        assertEquals(markdown, pending.speech); assertEquals(expected, item.speech);
        NativeVoiceQueue restored = new NativeVoiceQueue(); restored.add(pending); restored.reconfigure(clean);
        assertEquals(expected, restored.take().speech);
    }
    @Test public void cleanedEmptyCompletionStillAllowsItsEligibleFollowup() {
        NativeVoiceSettings clean = settings("response").patch(1, NativeVoiceJson.object("readNotificationContext", false));
        NativeVoiceQueue.Item item = new NativeVoiceQueue.Item(envelope("empty", "turn.completed", "---", null), clean);
        assertEquals("", item.speech); assertEquals(0, item.bytes); assertTrue(item.followUp);
        assertTrue(NativeVoiceQueue.chunks(item.speech, 4096).isEmpty());
        NativeVoiceQueue queue = new NativeVoiceQueue(); queue.add(item); queue.reconfigure(clean);
        assertTrue(queue.take().followUp);
    }
    @Test public void preservesContextAndSectionPausesWithoutChangingRawAssembly() {
        JSONObject source = envelope("parts", "turn.completed", "**Final answer.**", null);
        NativeVoiceJson.put(source.optJSONObject("payload").optJSONObject("assistantResult"), "unclassified",
            NativeVoiceJson.object("text", "Earlier text."));
        NativeVoiceSettings clean = settings("response");
        assertEquals("Completed\n\nWorkspace: Example\n\nEarlier text.\n\nFinal answer.", new NativeVoiceQueue.Item(source, clean).speech);
        NativeVoiceSettings raw = clean.patch(1, NativeVoiceJson.object("cleanSpeechText", false));
        assertEquals("Completed\nWorkspace: Example\nEarlier text.\n**Final answer.**", new NativeVoiceQueue.Item(source, raw).speech);
    }
    @Test public void truncatedOpenFenceCannotConsumeTheNoticeOrLaterResult() {
        JSONObject source = envelope("truncated", "turn.completed", "**Done.** See [the PR](https://example.test/hidden?token=abc).", null);
        NativeVoiceJson.put(source.optJSONObject("payload").optJSONObject("assistantResult"), "provisional",
            NativeVoiceJson.object("text", "```js\nconst a = 1;", "truncation",
                NativeVoiceJson.object("truncated", true, "originalBytes", 5000, "retainedBytes", 20, "reason", "byte_limit")));
        String expected = "Completed\n\nWorkspace: Example\n\nconst a = 1;\n\nThe remaining response was truncated.\n\nDone. See the PR.";
        NativeVoiceQueue.Item item = new NativeVoiceQueue.Item(source, settings("response"));
        assertEquals(expected, item.speech);
        assertEquals(expected, String.join("", NativeVoiceQueue.chunks(item.speech, 24)));
        assertEquals(source.toString(), item.envelope.toString());
    }
    @Test public void leadingIndentedCodeKeepsItsSymbolsAndLineBreaks() {
        String markdown = "    x = a*b*c\n    y = foo_bar**2**\n\nDone.";
        JSONObject source = envelope("indented", "turn.completed", markdown, null);
        NativeVoiceSettings clean = settings("response").patch(1, NativeVoiceJson.object("readNotificationContext", false));
        NativeVoiceQueue.Item item = new NativeVoiceQueue.Item(source, clean);
        assertEquals("x = a*b*c\ny = foo_bar**2**\n\nDone.", item.speech);
        assertEquals(source.toString(), item.envelope.toString());
        assertEquals(markdown.trim(), new NativeVoiceQueue.Item(source, clean.patch(2, NativeVoiceJson.object("cleanSpeechText", false))).speech);
    }
    // Server JSON.stringify text. Android org.json adds a byte per '/'; JVM org.json per "</" and U+2014.
    private static final String ESCAPED_PREFIX = "a/b </c> d\u2014e \\\"q\\\" \\\\ \\n\\t\\u0001 \u00e9\u0085 \u20ac\u2000\u2028\u2029 \ud83e\udda6 lone\\ud800 ";
    private static String payloadJson(String escapedText) {
        return "{\"schemaVersion\":4,\"notificationId\":\"notice-1\",\"event\":\"turn.completed\",\"occurredAt\":\"2026-10-03T00:00:00.000Z\"," +
            "\"title\":\"Completed\",\"message\":\"Workspace: a/b\",\"thread\":{\"id\":\"thread-a\",\"title\":\"Thread A\"}," +
            "\"assistantResult\":{\"final\":{\"text\":\"" + escapedText + "\",\"truncation\":{\"truncated\":true,\"originalBytes\":200000," +
            "\"retainedBytes\":65000,\"reason\":\"byte_limit\"}}}}";
    }
    private static int utf8(String value) { return value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length; }
    private static JSONObject wire(String payload) throws Exception {
        return NativeVoiceJson.object("sourceEventId", "fitted", "generation", 1, "voice", "speak", "payload", new JSONObject(payload));
    }
    @Test public void payloadSizeMatchesServerJsonStringifyMeasure() throws Exception {
        String mixed = payloadJson(ESCAPED_PREFIX + "tail");
        assertEquals(utf8(mixed), NativeVoiceJson.serializedBytes(new JSONObject(mixed)));
        String values = "{\"a\":[true,false,null,-12,0,9007199254740991],\"b\":{},\"c\":[],\"d\":\"x\"}";
        assertEquals(utf8(values), NativeVoiceJson.serializedBytes(new JSONObject(values)));
    }
    @Test public void serverFittedPayloadFullOfSlashesIsAcceptedAtTheExactLimit() throws Exception {
        int fill = (int) NativeVoiceQueue.MAX_PAYLOAD_BYTES - utf8(payloadJson(ESCAPED_PREFIX));
        String fitted = payloadJson(ESCAPED_PREFIX + "/".repeat(fill));
        assertEquals(65536, utf8(fitted));
        NativeVoiceQueue.Item item = new NativeVoiceQueue.Item(wire(fitted), settings("response"));
        assertTrue(item.speech.contains("/".repeat(fill)));
        String over = payloadJson(ESCAPED_PREFIX + "/".repeat(fill + 1));
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () -> new NativeVoiceQueue.Item(wire(over), settings("response")));
        assertEquals("voice_payload_too_large", error.getMessage());
    }

    private static JSONObject text(String value) { return NativeVoiceJson.object("text", value); }
    private static JSONObject replayArgs(String thread, String turn, Object result) {
        return NativeVoiceJson.object("threadId", thread, "turnId", turn, "assistantResult", result);
    }
    private static NativeVoiceQueue.Item replay(String thread, String turn, JSONObject result, NativeVoiceSettings settings) {
        return NativeVoiceQueue.Item.replay(NativeVoiceQueue.replayRequest(replayArgs(thread, turn, result)), "Thread A", settings);
    }
    private static NativeVoiceQueue.Item replay(String turn, String text, NativeVoiceSettings settings) {
        return replay("thread-a", turn, NativeVoiceJson.object("final", text(text)), settings);
    }
    @Test public void replaySpeaksTheReplyInNotificationPhaseOrderWithoutContextOrFollowUp() {
        JSONObject result = NativeVoiceJson.object("final", text("**Final answer.**"), "unclassified", text("Earlier text."),
            "provisional", text("Provisional note."));
        NativeVoiceSettings listening = settings("response").patch(1, NativeVoiceJson.object("autoListen", true, "readNotificationContext", true));
        for (NativeVoiceSettings configured : new NativeVoiceSettings[] { listening, settings("manual") }) {
            NativeVoiceQueue.Item item = replay("thread-a", "turn-1", result, configured);
            assertEquals("Provisional note.\n\nEarlier text.\n\nFinal answer.", item.speech);
            assertEquals("replay", item.event); assertTrue(item.isReplay()); assertFalse(item.automatic); assertFalse(item.followUp);
            assertNull(item.envelope); assertNull(item.targetId()); assertNull(item.coalesceKey()); assertFalse(item.progress());
            assertEquals("thread-a", item.threadId); assertEquals("Thread A", item.threadTitle);
            assertEquals("thread-a\nturn-1", item.replayIdentity()); assertEquals(NativeVoiceJson.bytes(item.speech), item.bytes);
        }
        // Identical to the completion notification's assembly of the same sections, minus its context line.
        JSONObject notice = envelope("same", "turn.completed", "", null);
        NativeVoiceJson.put(notice.optJSONObject("payload"), "assistantResult", result);
        NativeVoiceSettings contextFree = settings("response").patch(1, NativeVoiceJson.object("readNotificationContext", false));
        assertEquals(new NativeVoiceQueue.Item(notice, contextFree).speech, replay("thread-a", "turn-1", result, listening).speech);
        assertNotEquals(replay("thread-a", "turn-1", result, listening).id, replay("thread-a", "turn-1", result, listening).id);
    }
    @Test public void replayCleansEachPartAndKeepsTheTruncationNotice() {
        JSONObject result = NativeVoiceJson.object("provisional", NativeVoiceJson.object("text", "```js\nconst a = 1;", "truncation",
                NativeVoiceJson.object("truncated", true, "originalBytes", 5000, "retainedBytes", 20, "reason", "byte_limit")),
            "unclassified", JSONObject.NULL, "final", text("**Done.** See [the PR](https://example.test/hidden?token=abc)."));
        NativeVoiceSettings clean = settings("response");
        assertEquals("const a = 1;\n\nThe remaining response was truncated.\n\nDone. See the PR.", replay("thread-a", "turn-1", result, clean).speech);
        NativeVoiceSettings raw = clean.patch(1, NativeVoiceJson.object("cleanSpeechText", false));
        assertEquals("```js\nconst a = 1;\nThe remaining response was truncated.\n**Done.** See [the PR](https://example.test/hidden?token=abc).",
            replay("thread-a", "turn-1", result, raw).speech);
    }
    @Test public void replyWithoutSpeakableTextIsRejected() {
        NativeVoiceSettings clean = settings("response");
        for (JSONObject result : new JSONObject[] { new JSONObject(), NativeVoiceJson.object("final", JSONObject.NULL),
            NativeVoiceJson.object("unclassified", text(" \n\t ")), NativeVoiceJson.object("final", text("---")) }) {
            RuntimeException error = assertThrows(RuntimeException.class, () -> replay("thread-a", "turn-1", result, clean));
            assertEquals(result.toString(), "voice_reply_empty", NativeVoiceRuntime.code(error));
        }
        assertEquals("---", replay("turn-1", "---", clean.patch(1, NativeVoiceJson.object("cleanSpeechText", false))).speech);
    }
    @Test public void replayRequestIsStrictAndCopied() {
        JSONObject valid = replayArgs("t".repeat(512), "u".repeat(160), NativeVoiceJson.object("final", text("x".repeat(65536))));
        JSONObject request = NativeVoiceQueue.replayRequest(valid);
        NativeVoiceJson.put(valid, "threadId", "changed");
        assertEquals("t".repeat(512), request.optString("threadId"));
        JSONObject falseTruncation = NativeVoiceJson.object("text", "x", "truncation",
            NativeVoiceJson.object("truncated", false, "retainedBytes", 1, "reason", "byte_limit"));
        JSONObject extra = replayArgs("thread-a", "turn-1", new JSONObject()); NativeVoiceJson.put(extra, "threadTitle", "Title");
        JSONObject noThread = replayArgs("thread-a", "turn-1", new JSONObject()); noThread.remove("threadId");
        JSONObject noTurn = replayArgs("thread-a", "turn-1", new JSONObject()); noTurn.remove("turnId");
        JSONObject noResult = replayArgs("thread-a", "turn-1", new JSONObject()); noResult.remove("assistantResult");
        Object[][] cases = {
            { "unknown_field", extra }, { "invalid_threadId", noThread }, { "invalid_threadId", replayArgs("", "turn-1", new JSONObject()) },
            { "invalid_threadId", replayArgs("t".repeat(513), "turn-1", new JSONObject()) }, { "invalid_turnId", noTurn },
            { "invalid_turnId", replayArgs("thread-a", "u".repeat(161), new JSONObject()) }, { "invalid_assistantResult", noResult },
            { "invalid_assistantResult", replayArgs("thread-a", "turn-1", JSONObject.NULL) },
            { "invalid_assistantResult", replayArgs("thread-a", "turn-1", "Final answer") },
            { "unknown_field", replayArgs("thread-a", "turn-1", NativeVoiceJson.object("summary", text("x"))) },
            { "invalid_final", replayArgs("thread-a", "turn-1", NativeVoiceJson.object("final", "Final answer")) },
            { "unknown_field", replayArgs("thread-a", "turn-1", NativeVoiceJson.object("final", NativeVoiceJson.object("text", "x", "itemId", "i"))) },
            { "invalid_text", replayArgs("thread-a", "turn-1", NativeVoiceJson.object("final", text("x".repeat(65537)))) },
            { "invalid_text", replayArgs("thread-a", "turn-1", NativeVoiceJson.object("final", new JSONObject())) },
            { "invalid_truncation", replayArgs("thread-a", "turn-1", NativeVoiceJson.object("final", falseTruncation)) },
        };
        for (Object[] example : cases) {
            RuntimeException error = assertThrows(RuntimeException.class, () -> NativeVoiceQueue.replayRequest((JSONObject) example[1]));
            assertEquals(example[1].toString(), example[0], NativeVoiceRuntime.code(error));
        }
    }
    @Test public void replayStaysOutsideNotificationDedupeAndRepeatsOfAQueuedTurnAreNoOps() {
        NativeVoiceSettings configured = settings("response");
        NativeVoiceQueue queue = new NativeVoiceQueue();
        NativeVoiceQueue.Item first = replay("turn-1", "First", configured);
        assertTrue(queue.addReplay(first));
        assertTrue("A replay ID never enters notification dedupe", queue.remember(first.id));
        assertFalse(queue.addReplay(replay("turn-1", "Different text", configured)));
        assertTrue(queue.addReplay(replay("turn-2", "Other turn", configured)));
        assertTrue(queue.addReplay(replay("thread-b", "turn-1", NativeVoiceJson.object("final", text("Other thread")), configured)));
        assertEquals(3, queue.size()); assertEquals(0, queue.state().optInt("droppedCount"));
        assertEquals(first.id, queue.take().id);
        assertTrue("A turn no longer queued can be replayed again", queue.addReplay(replay("turn-1", "First", configured)));
    }
    @Test public void replayCountsAgainstQueueLimitsAndOverflowIsRefusedExplicitly() {
        NativeVoiceSettings configured = settings("response");
        NativeVoiceQueue queue = new NativeVoiceQueue();
        for (int i = 0; i < 64; i++) queue.add(new NativeVoiceQueue.Item(envelope("item-" + i, i == 5 ? "turn.progress" : "turn.completed", "Text", null), configured));
        assertTrue("Progress yields to a replay as it does to terminal content", queue.addReplay(replay("turn-1", "Replay", configured)));
        assertEquals(64, queue.size()); assertEquals(1, queue.state().optJSONObject("droppedReasons").optInt("progress_evicted"));
        RuntimeException full = assertThrows(RuntimeException.class, () -> queue.addReplay(replay("turn-2", "Replay", configured)));
        assertEquals("voice_queue_full", NativeVoiceRuntime.code(full));
        assertEquals(64, queue.size()); assertEquals("A refused replay is not a silent drop", 1, queue.state().optInt("droppedCount"));
        NativeVoiceQueue large = new NativeVoiceQueue();
        assertTrue(large.addReplay(replay("turn-1", "é".repeat(60000), configured)));
        assertTrue(large.addReplay(replay("turn-2", "é".repeat(60000), configured)));
        assertEquals(240000, large.bytes());
        RuntimeException bytes = assertThrows(RuntimeException.class, () -> large.addReplay(replay("turn-3", "é".repeat(60000), configured)));
        assertEquals("voice_queue_full", NativeVoiceRuntime.code(bytes));
        assertEquals(2, large.size()); assertEquals(240000, large.bytes()); assertEquals(0, large.state().optInt("droppedCount"));
    }
    @Test public void stoppedServiceClearsPendingReplaysAndLeavesAutomaticItems() {
        NativeVoiceSettings configured = settings("response");
        NativeVoiceQueue queue = new NativeVoiceQueue();
        NativeVoiceQueue.Item completed = new NativeVoiceQueue.Item(envelope("completed", "turn.completed", "One", null), configured);
        NativeVoiceQueue.Item progress = new NativeVoiceQueue.Item(envelope("progress", "turn.progress", "Working", null), configured);
        queue.addReplay(replay("turn-1", "First", configured)); queue.add(completed);
        queue.addReplay(replay("turn-2", "Second", configured)); queue.add(progress);
        queue.clearReplays();
        assertEquals(2, queue.size()); assertEquals(completed.bytes + progress.bytes, queue.bytes());
        assertEquals("Cleared replays are not drops", 0, queue.state().optInt("droppedCount"));
        assertEquals(completed.id, queue.take().id); assertEquals(progress.id, queue.take().id);
        assertTrue("A cleared turn can be replayed again", queue.addReplay(replay("turn-1", "First", configured)));
        queue.clearReplays(); assertEquals(0, queue.size()); assertEquals(0, queue.bytes());
    }
    @Test public void reconfigureRebuildsAPendingReplayFromItsRequest() {
        String markdown = "# Answer\n\nRead [the label](https://example.test/hidden).";
        NativeVoiceSettings clean = settings("response");
        NativeVoiceQueue queue = new NativeVoiceQueue();
        NativeVoiceQueue.Item item = replay("turn-1", markdown, clean);
        assertEquals("Answer\n\nRead the label.", item.speech);
        queue.addReplay(item);
        NativeVoiceSettings raw = clean.patch(1, NativeVoiceJson.object("cleanSpeechText", false));
        queue.reconfigure(raw);
        NativeVoiceQueue.Item rebuilt = queue.take();
        assertEquals(markdown, rebuilt.speech); assertEquals(item.id, rebuilt.id); assertEquals("Thread A", rebuilt.threadTitle);
        assertEquals(item.replayIdentity(), rebuilt.replayIdentity()); assertFalse(rebuilt.automatic); assertFalse(rebuilt.followUp);
        assertEquals(markdown, rebuilt.request.optJSONObject("assistantResult").optJSONObject("final").optString("text"));
        // Audio mode and notification context shape notifications only.
        queue.addReplay(rebuilt);
        queue.reconfigure(settings("manual").patch(1, NativeVoiceJson.object("readNotificationContext", true)));
        assertEquals("Answer\n\nRead the label.", queue.take().speech);
        // A replay that new cleanup leaves silent leaves the queue without counting as an automatic drop.
        NativeVoiceQueue silent = new NativeVoiceQueue();
        silent.addReplay(replay("turn-2", "---", raw)); silent.reconfigure(clean);
        assertEquals(0, silent.size()); assertEquals(0, silent.bytes()); assertEquals(0, silent.state().optInt("droppedCount"));
    }
    @Test public void automaticCancellationKeepsReplaysInOrderWhileOffClearsThem() {
        NativeVoiceSettings configured = settings("response");
        NativeVoiceQueue queue = new NativeVoiceQueue();
        NativeVoiceQueue.Item first = replay("turn-1", "First", configured), second = replay("turn-2", "Second", configured);
        queue.add(new NativeVoiceQueue.Item(envelope("completed", "turn.completed", "One", null), configured));
        queue.addReplay(first);
        queue.add(new NativeVoiceQueue.Item(envelope("progress", "turn.progress", "Working", null), configured));
        queue.add(new NativeVoiceQueue.Item(envelope("approval", "approval.requested", "", "approval-a"), configured));
        queue.addReplay(second);
        queue.clearAutomatic("notification_connection_lost");
        assertEquals(2, queue.size()); assertEquals(first.bytes + second.bytes, queue.bytes());
        assertEquals(3, queue.state().optJSONObject("droppedReasons").optInt("notification_connection_lost"));
        assertEquals(first.id, queue.take().id); assertEquals(second.id, queue.take().id);
        queue.addReplay(first); queue.addReplay(second); queue.clear("voice_off");
        assertEquals(0, queue.size()); assertEquals(0, queue.bytes());
        assertFalse(queue.state().optJSONObject("droppedReasons").has("voice_off")); assertEquals(3, queue.state().optInt("droppedCount"));
    }
}
