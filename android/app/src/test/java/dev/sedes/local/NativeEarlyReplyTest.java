package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class NativeEarlyReplyTest {
    private static final String THREAD = "962d794f-b1b4-44bd-b8fa-c1701a606652", ID = "a".repeat(64);
    private static JSONObject common(String kind, int seq) {
        return NativeVoiceJson.object("kind", kind, "replyId", ID, "threadId", THREAD, "itemId", "message",
            "turnId", "turn", "seq", seq, "generation", 5);
    }
    private static NativeEarlyReply.Frame span(int seq, int start, String text, boolean paragraphEnd) {
        return span("turn.completed", seq, start, text, paragraphEnd);
    }
    private static NativeEarlyReply.Frame span(String event, int seq, int start, String text, boolean paragraphEnd) {
        JSONObject value = common(seq == 0 ? "begin" : "append", seq);
        if (seq == 0) {
            NativeVoiceJson.put(value, "event", event);
            NativeVoiceJson.put(value, "threadTitle", "Project"); NativeVoiceJson.put(value, "userInputRevision", 2);
        }
        NativeVoiceJson.put(value, "text", text); NativeVoiceJson.put(value, "rawStart", start);
        NativeVoiceJson.put(value, "rawEnd", start + text.length()); NativeVoiceJson.put(value, "paragraphEnd", paragraphEnd);
        return new NativeEarlyReply.Frame(value);
    }
    private static NativeVoiceSettings settings(String content) {
        return NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("audioMode", "speak", "speechContent", content, "cleanSpeechText", true));
    }
    private static NativeVoiceQueue.Item terminal(String raw, String late, NativeVoiceSettings settings) {
        JSONObject result = NativeVoiceJson.object("final", NativeVoiceJson.object("text", raw));
        if (late != null) NativeVoiceJson.put(result, "partial", NativeVoiceJson.object("text", late));
        return new NativeVoiceQueue.Item(NativeVoiceJson.object("sourceEventId", ID, "generation", 5, "voice", "speak", "userInputRevision", 2,
            "payload", NativeVoiceJson.object("schemaVersion", 5, "notificationId", ID, "event", "turn.completed",
                "occurredAt", "2026-11-26T14:00:00Z", "title", "Agent finished", "message", "Project",
                "thread", NativeVoiceJson.object("id", THREAD, "title", "Project"),
                "turn", NativeVoiceJson.object("id", "turn", "outcome", "completed"), "assistantResult", result)), settings);
    }
    @Test public void modesGroupOnlyAvailableSentencesAndNaturalYieldFlushesRemainder() {
        for (String mode : new String[]{"responsive", "balanced", "natural"}) {
            NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "One.", false), 5);
            reply.freeze(mode, settings("messages"), 4096);
            if (mode.equals("natural")) assertNull(reply.next(null)); else assertEquals("One.", reply.next(null).text);
            reply.accept(span(1, 4, " Two.", false), 6); reply.accept(span(2, 9, " Three.", false), 7);
            NativeEarlyReply.Part first;
            if (mode.equals("natural")) {
                assertNull(reply.next(null)); JSONObject control = common("yield", 3); NativeVoiceJson.put(control, "reason", "markup");
                reply.accept(new NativeEarlyReply.Frame(control), 8); first = reply.next(null);
                assertEquals("One. Two. Three.", first.text); reply.drained(first); assertNull(reply.next(null));
            } else {
                first = reply.next(null); assertEquals("One.", first.text);
                assertEquals(mode.equals("balanced") ? "Two. Three." : "Two.", reply.next(first).text.trim());
                // Preview/lookahead doesn't commit either utterance.
                assertEquals("One.", reply.next(null).text); reply.drained(first);
                assertEquals(mode.equals("balanced") ? "Two. Three." : "Two.", reply.next(null).text.trim());
            }
        }
    }
    @Test public void paragraphMarkerAndAbsoluteSequenceRangeHaveNoDuplicateOutput() {
        NativeEarlyReply.Frame begin = span(0, 0, "One.", false);
        NativeEarlyReply reply = new NativeEarlyReply(begin, 0); reply.freeze("natural", settings("messages"), 4);
        assertFalse(reply.accept(begin, 1));
        assertThrows(IllegalArgumentException.class, () -> reply.accept(span(0, 0, "Two.", false), 1));
        assertThrows(IllegalArgumentException.class, () -> reply.accept(span(2, 4, " Tail", true), 2));
        assertThrows(IllegalArgumentException.class, () -> reply.accept(span(1, 5, " Tail", true), 2));
        NativeEarlyReply.Frame close = span(1, 4, "", true);
        assertTrue(reply.accept(close, 2)); assertFalse(reply.accept(close, 3));
        assertThrows(IllegalArgumentException.class, () -> reply.accept(span(2, 4, "", true), 4));
        NativeEarlyReply.Part first = reply.next(null); assertEquals("One.", first.text); reply.drained(first);
        assertNull(reply.next(null));
    }
    @Test public void detachedRawAndRenderedHashesTrackPhysicalSplitsAndNeverSearchRepeatedWords() {
        NativeVoiceSettings settings = settings("messages");
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "echo echo echo.", true), 0);
        reply.freeze("responsive", settings, 5);
        NativeEarlyReply.Part chunk = reply.next(null); assertEquals("echo ", chunk.text); reply.drained(chunk);
        NativeEarlyReply.Part preview = reply.next(null); assertEquals("echo ", preview.text);
        reply.detach(); assertEquals(0, reply.pendingBytes());
        assertEquals("echo echo. End.", reply.terminal(terminal("echo echo echo. End.", null, settings), settings, ID));
        assertEquals("echo new answer.", reply.terminal(terminal("echo new answer.", null, settings), settings, ID));
    }
    @Test public void bothUsesAudibleOwnerAtActualContinuationAndFormatsSectionAsAWhole() {
        NativeVoiceSettings both = settings("both");
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "One.", false), 0);
        reply.freeze("responsive", both, 4096);
        NativeEarlyReply.Part title = reply.next(null); assertEquals("Project", title.text);
        reply.submitted(title); reply.drained(title);
        NativeEarlyReply.Part first = reply.next(null); reply.drained(first); reply.detach();
        NativeVoiceQueue.Item terminal = terminal("One. **Two.**", "Status.", both);
        assertEquals("Two.\n\nAgent finished\n\nStatus.", reply.terminal(terminal, both, ID));
        assertEquals("Project\n\nAgent finished\n\nTwo.\n\nStatus.", reply.terminal(terminal, both, "other"));
        assertEquals(terminal("Corrected.", "Status.", both).speech,
            reply.terminal(terminal("Corrected.", "Status.", both), both, ID));
    }
    private static NativeVoiceQueue.Item progress(String id, String itemId, String raw, NativeVoiceSettings settings) {
        JSONObject notice = NativeVoiceJson.copy(terminal(raw, null, settings).envelope);
        NativeVoiceJson.put(notice, "sourceEventId", id);
        JSONObject payload = notice.optJSONObject("payload"); payload.remove("assistantResult");
        NativeVoiceJson.put(payload, "event", "turn.progress");
        NativeVoiceJson.put(payload, "title", "Agent progress");
        NativeVoiceJson.put(payload, "turn", NativeVoiceJson.object("id", "turn"));
        NativeVoiceJson.put(payload, "progress", NativeVoiceJson.object("itemId", itemId, "phase", "provisional", "text", raw));
        return new NativeVoiceQueue.Item(notice, settings);
    }
    @Test public void progressSealsOnlyItsOwnItemAndKeepsDrainedAttributionAndPrefix() {
        NativeVoiceSettings both = settings("both");
        NativeEarlyReply reply = new NativeEarlyReply(span("turn.progress", 0, 0, "First.", true), 0);
        reply.freeze("responsive", both, 4096);
        assertTrue(new NativeVoiceQueue.Item(reply).progress());
        assertThrows(IllegalArgumentException.class, () -> reply.accept(span(0, 0, "First.", true), 1));
        NativeEarlyReply.Part title = reply.next(null);
        assertEquals("Project", title.text); reply.submitted(title); reply.drained(title);
        NativeEarlyReply.Part first = reply.next(null);
        NativeVoiceQueue.Item notice = progress(ID, "message", "First. **Tail.**", both);
        assertTrue(reply.matchesNotice(notice));
        assertFalse(reply.matchesNotice(progress(ID, "other", "First.", both)));
        assertFalse(reply.matchesNotice(terminal("First.", null, both)));
        assertTrue(reply.agreesWith(first, notice));
        assertFalse(reply.agreesWith(first, progress(ID, "message", "Corrected.", both)));
        reply.drained(first);
        assertEquals("Tail.\n\nAgent progress", reply.terminal(notice, both, ID));
        assertEquals("Project\n\nAgent progress\n\nTail.", reply.terminal(notice, both, "other"));
    }
    @Test public void sealingProgressUnderPressureDropsIncomingItemAndPreservesOlderProgress() {
        NativeVoiceSettings settings = settings("messages");
        NativeVoiceQueue queue = new NativeVoiceQueue();
        NativeEarlyReply reply = new NativeEarlyReply(span("turn.progress", 0, 0, "First.", true), 0);
        assertTrue(queue.addOpening(new NativeVoiceQueue.Item(reply)));
        for (int n = 0; n < 5; n++)
            assertTrue(queue.add(progress("other-" + n, "other-" + n, "P".repeat(50_000), settings)));
        NativeVoiceQueue.Item notice = progress(ID, "message", "X".repeat(20_000), settings);
        notice.early = reply;
        assertTrue(queue.sealPending(notice)); assertFalse(queue.contains(ID)); assertFalse(queue.add(notice));
        assertEquals(5, queue.size()); assertEquals(250_000, queue.bytes());
    }
    @Test public void onlyAttributionAndNoOutputChooseDifferentTerminalOrdering() {
        NativeVoiceSettings both = settings("both"); NativeVoiceQueue.Item terminal = terminal("One. End.", "Late", both);
        NativeEarlyReply fresh = new NativeEarlyReply(span(0, 0, "One.", true), 0); fresh.freeze("balanced", both, 4096);
        assertEquals(terminal.speech, fresh.terminal(terminal, both, ID));
        NativeEarlyReply attributed = new NativeEarlyReply(span(0, 0, "One.", true), 0); attributed.freeze("balanced", both, 4096);
        attributed.submitted(attributed.next(null)); attributed.detach();
        assertEquals("One. End.\n\nAgent finished\n\nLate", attributed.terminal(terminal, both, ID));
    }
    @Test public void openPendingSealsInOriginalQueuePositionAndTerminalDedupIsIndependent() {
        NativeVoiceSettings settings = settings("messages");
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "One.", false), 0);
        NativeVoiceQueue queue = new NativeVoiceQueue();
        assertTrue(queue.addOpening(new NativeVoiceQueue.Item(reply)));
        assertEquals(4, queue.bytes());
        reply.accept(span(1, 4, " Two.", true), 5); assertTrue(queue.accountOpening(reply)); assertEquals(9, queue.bytes());
        NativeVoiceQueue.Item terminal = terminal("One. Two. Three.", null, settings); terminal.early = reply;
        NativeVoiceQueue.Item replay = NativeVoiceQueue.Item.replay(NativeVoiceJson.object("threadId", THREAD, "turnId", "other",
            "assistantResult", NativeVoiceJson.object("final", NativeVoiceJson.object("text", "Next"))), "Next", settings);
        assertTrue(queue.addReplay(replay)); assertTrue(queue.sealPending(terminal));
        assertEquals(2, queue.size()); assertSame(terminal, queue.take()); assertSame(replay, queue.take());
        assertEquals(0, queue.bytes()); assertFalse(queue.add(terminal));
    }
    @Test public void sealEvictsProvisionalProgressUnderTheSamePressureAsOrdinaryCompletion() {
        NativeVoiceSettings settings = settings("messages");
        NativeVoiceQueue queue = new NativeVoiceQueue();
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "One.", false), 0);
        assertTrue(queue.addOpening(new NativeVoiceQueue.Item(reply)));
        JSONObject progress = NativeVoiceJson.copy(terminal("Progress.", null, settings).envelope);
        NativeVoiceJson.put(progress, "sourceEventId", "progress");
        JSONObject payload = progress.optJSONObject("payload");
        NativeVoiceJson.put(payload, "event", "turn.progress");
        NativeVoiceJson.put(payload, "progress", NativeVoiceJson.object("itemId", "progress", "phase", "provisional", "text", "P".repeat(12000)));
        assertTrue(queue.add(new NativeVoiceQueue.Item(progress, settings)));
        for (int n = 0; n < 16; n++) {
            NativeVoiceQueue.Item replay = NativeVoiceQueue.Item.replay(NativeVoiceJson.object("threadId", THREAD, "turnId", "other" + n,
                "assistantResult", NativeVoiceJson.object("final", NativeVoiceJson.object("text", "X".repeat(15100)))), "Next", settings);
            assertTrue(queue.addReplay(replay));
        }
        NativeVoiceQueue.Item terminal = terminal("Z".repeat(15000), null, settings); terminal.early = reply;
        assertTrue(queue.sealPending(terminal)); assertSame(terminal, queue.take());
        assertFalse(queue.contains("progress")); assertEquals(16, queue.size());
    }
    @Test public void beforeHandshakeOrDuringAnUpdateOffRevokesExistingEntitlementFirst() {
        NativeEarlyInterest interest = new NativeEarlyInterest();
        interest.open(7, true); assertFalse(interest.needsUpdate());
        interest.update(false); interest.update(true);
        assertTrue(interest.owesDisable()); assertFalse(interest.nextEnabled()); assertEquals(8, interest.nextRevision());
        interest.acknowledge(8); assertTrue(interest.nextEnabled()); assertEquals(9, interest.nextRevision());
        // More toggles while the PUT for revision 9 is still outstanding.
        interest.update(false); interest.update(true); interest.acknowledge(9);
        assertFalse(interest.nextEnabled()); assertEquals(10, interest.nextRevision());
        interest.acknowledge(10); assertTrue(interest.nextEnabled()); assertEquals(11, interest.nextRevision());
        interest.acknowledge(11); assertFalse(interest.needsUpdate());
    }
    @Test public void oneCodeUnitProviderLimitHandlesBmpAndRefusesUnrepresentableCodePoint() {
        assertEquals(java.util.Arrays.asList("a", "b"), NativeVoiceQueue.chunks("ab", 1));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceQueue.chunks("🎧", 1));
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "A.", true), 0);
        reply.freeze("responsive", settings("messages"), 1);
        NativeEarlyReply.Part first = reply.next(null); assertEquals("A", first.text); reply.drained(first);
        NativeEarlyReply.Part end = reply.next(null); assertEquals(".", end.text); reply.drained(end);
        reply.accept(span(1, 2, " B.", true), 8); assertEquals("B", reply.next(null).text);
    }
    @Test public void prefsAreIndependentVersionedAndCompareAndSwap() {
        NativeEarlyReplyPreferences initial = NativeEarlyReplyPreferences.defaults(); assertEquals("off", initial.mode);
        NativeEarlyReplyPreferences next = initial.patch(0, "responsive");
        assertEquals(1, NativeEarlyReplyPreferences.fromRecord(next.record()).revision);
        assertThrows(IllegalStateException.class, () -> next.patch(0, "off"));
        assertThrows(IllegalArgumentException.class, () -> next.patch(1, "fast"));
    }
}
