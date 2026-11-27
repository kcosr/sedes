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
        String one = "Here is one.", two = " Here is two.", three = " Here is three.";
        for (String mode : new String[]{"responsive", "balanced", "natural"}) {
            NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, one, false), 5);
            reply.freeze(mode, settings("messages"), 4096);
            if (mode.equals("natural")) assertNull(reply.next(null)); else assertEquals(one, reply.next(null).text);
            reply.accept(span(1, one.length(), two, false), 6); reply.accept(span(2, one.length() + two.length(), three, false), 7);
            NativeEarlyReply.Part first;
            if (mode.equals("natural")) {
                assertNull(reply.next(null)); JSONObject control = common("yield", 3); NativeVoiceJson.put(control, "reason", "markup");
                reply.accept(new NativeEarlyReply.Frame(control), 8); first = reply.next(null);
                assertEquals(one + two + three, first.text); reply.drained(first); assertNull(reply.next(null));
            } else {
                first = reply.next(null); assertEquals(one, first.text);
                String secondGroup = mode.equals("balanced") ? (two + three).trim() : two.trim();
                assertEquals(secondGroup, reply.next(first).text);
                // Preview/lookahead doesn't commit either utterance.
                assertEquals(one, reply.next(null).text); reply.drained(first);
                assertEquals(secondGroup, reply.next(null).text);
            }
        }
    }
    @Test public void responsiveStartsEveryGroupAtThreeWordsAndReleasesTheTailOnYieldOrSeal() {
        NativeVoiceSettings messages = settings("messages");
        for (String event : new String[]{"turn.progress", "turn.completed"}) {
            String first = "It passed.", next = " Good.", tail = " More soon.";
            NativeEarlyReply reply = new NativeEarlyReply(span(event, 0, 0, first, true), 0);
            reply.freeze("responsive", messages, 4096);
            assertNull(reply.next(null));
            reply.accept(span(event, 1, first.length(), next, false), 1);
            NativeEarlyReply.Part group = reply.next(null);
            assertEquals(first + next, group.text);
            reply.accept(span(event, 2, first.length() + next.length(), tail, true), 2);
            assertNull(reply.next(group)); reply.drained(group);
            assertNull(reply.next(null));
            NativeVoiceQueue.Item notice = event.equals("turn.progress") ? progress(ID, "message", first + next + tail, messages)
                : terminal(first + next + tail, null, messages);
            if (event.equals("turn.progress")) {
                JSONObject yield = common("yield", 3);
                NativeVoiceJson.put(yield, "reason", "markup"); reply.accept(new NativeEarlyReply.Frame(yield), 3);
                NativeEarlyReply.Part remainder = reply.next(null); assertEquals(tail.trim(), remainder.text);
                reply.drained(remainder); assertNull(reply.next(null));
                assertEquals("", reply.terminal(notice, messages, ID));
            } else {
                assertEquals(tail.trim(), reply.terminal(notice, messages, ID));
            }
            NativeEarlyReply shortReply = new NativeEarlyReply(span(event, 0, 0, first, false), 0);
            shortReply.freeze("responsive", messages, 4096);
            assertNull(shortReply.next(null));
            NativeVoiceQueue.Item shortNotice = event.equals("turn.progress") ? progress(ID, "message", first, messages) : terminal(first, null, messages);
            assertEquals(first, shortReply.terminal(shortNotice, messages, ID));
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
        reply.freeze("balanced", both, 4096);
        NativeEarlyReply.Part header = reply.next(null); assertEquals("Agent finished\n\nProject", header.text);
        reply.drained(header);
        NativeEarlyReply.Part first = reply.next(null); reply.drained(first); reply.detach();
        NativeVoiceQueue.Item terminal = terminal("One. **Two.**", "Status.", both);
        assertEquals("Two.\n\nStatus.", reply.terminal(terminal, both, ID));
        assertEquals("Agent finished\n\nProject\n\nTwo.\n\nStatus.", reply.terminal(terminal, both, "other"));
        assertEquals("Status.\n\nCorrected.",
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
        reply.freeze("balanced", both, 4096);
        assertTrue(new NativeVoiceQueue.Item(reply).progress());
        assertThrows(IllegalArgumentException.class, () -> reply.accept(span(0, 0, "First.", true), 1));
        NativeEarlyReply.Part header = reply.next(null);
        assertEquals("Agent progress\n\nProject", header.text); reply.drained(header);
        NativeEarlyReply.Part first = reply.next(null);
        NativeVoiceQueue.Item notice = progress(ID, "message", "First. **Tail.**", both);
        assertTrue(reply.matchesNotice(notice));
        assertFalse(reply.matchesNotice(progress(ID, "other", "First.", both)));
        assertFalse(reply.matchesNotice(terminal("First.", null, both)));
        assertTrue(reply.agreesWith(first, notice));
        assertFalse(reply.agreesWith(first, progress(ID, "message", "Corrected.", both)));
        reply.drained(first);
        assertEquals("Tail.", reply.terminal(notice, both, ID));
        assertEquals("Agent progress\n\nProject\n\nTail.", reply.terminal(notice, both, "other"));
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
    @Test public void sealFinishesOnlyTheDrainedHeaderRemainderBeforeTheOrdinaryBody() {
        for (String event : new String[]{"turn.progress", "turn.completed"}) {
            NativeVoiceSettings both = settings("both");
            NativeEarlyReply reply = new NativeEarlyReply(span(event, 0, 0, "One.", true), 0);
            NativeVoiceQueue.Item notice = event.equals("turn.progress") ? progress(ID, "message", "One. End.", both)
                : terminal("One. End.", null, both);
            JSONObject payload = notice.envelope.optJSONObject("payload");
            NativeVoiceJson.put(payload, "message", "Renamed");
            NativeVoiceJson.put(payload.optJSONObject("thread"), "title", "Renamed");
            notice = new NativeVoiceQueue.Item(notice.envelope, both);
            reply.freeze("balanced", both, 6);
            NativeEarlyReply.Part header = reply.next(null);
            assertEquals("Agent ", header.text);
            NativeEarlyReply.Part preview = reply.next(header);
            assertTrue(preview.preambleEnd > header.preambleEnd);
            reply.drained(header);
            String label = payload.optString("title");
            assertEquals(label.substring(6) + "\n\nProject\n\nOne. End.", reply.terminal(notice, both, ID));
            assertEquals(label + "\n\nRenamed\n\nOne. End.", reply.terminal(notice, both, "other"));
            NativeEarlyReply unplayed = new NativeEarlyReply(span(event, 0, 0, "One.", true), 0);
            unplayed.freeze("balanced", both, 6);
            assertEquals("Agent ", unplayed.next(null).text);
            assertEquals(notice.speech, unplayed.terminal(notice, both, ID));
        }
    }
    @Test public void matchingSealAfterTheWholeBodyIsSilentIncludingAfterAnotherOwner() {
        NativeVoiceSettings both = settings("both");
        for (String event : new String[]{"turn.progress", "turn.completed"}) {
            NativeEarlyReply reply = new NativeEarlyReply(span(event, 0, 0, "One.", true), 0);
            reply.freeze("balanced", both, 4096);
            reply.drained(reply.next(null));
            reply.drained(reply.next(null));
            NativeVoiceQueue.Item notice = event.equals("turn.progress") ? progress(ID, "message", "One.", both)
                : terminal("One.", null, both);
            assertEquals("", reply.terminal(notice, both, ID));
            assertEquals("", reply.terminal(notice, both, "other"));
        }
    }
    @Test public void switchingToAnnouncementsReintroducesAnUnfinishedPreambleAfterAnotherOwner() {
        NativeVoiceSettings both = settings("both"), announcements = settings("announcements");
        JSONObject envelope = progress(ID, "message", "One. Tail.", both).envelope;
        JSONObject payload = envelope.optJSONObject("payload");
        NativeVoiceJson.put(payload, "message", "Renamed project");
        NativeVoiceJson.put(payload.optJSONObject("thread"), "title", "Renamed project");
        NativeVoiceQueue.Item notice = new NativeVoiceQueue.Item(envelope, both);
        for (int limit : new int[]{6, 4096}) {
            NativeEarlyReply reply = new NativeEarlyReply(span("turn.progress", 0, 0, "One.", true), 0);
            reply.freeze("balanced", both, limit);
            NativeEarlyReply.Part part;
            do {
                part = reply.next(null);
                reply.drained(part);
            } while (part.preambleEnd <= "Agent progress\n\n".length());
            reply.detach();
            assertEquals(limit == 6 ? "t" : "", reply.terminal(notice, announcements, ID));
            assertEquals(limit == 6 ? "Agent progress\n\nRenamed project" : "", reply.terminal(notice, announcements, "other"));
        }
        NativeEarlyReply reply = new NativeEarlyReply(span("turn.progress", 0, 0, "One.", true), 0);
        reply.freeze("balanced", settings("messages"), 4096);
        reply.drained(reply.next(null));
        assertEquals("Agent progress\n\nRenamed project", reply.terminal(notice, announcements, ID));
    }
    @Test public void unflushedNaturalGroupsWaitBeforeSpeakingThePreambleAndRawSpeechKeepsItsSeparator() {
        NativeVoiceSettings both = settings("both");
        both = both.patch(both.revision, NativeVoiceJson.object("cleanSpeechText", false));
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "One.", false), 0);
        reply.freeze("natural", both, 4096);
        assertNull(reply.next(null));
        reply.accept(span(1, 4, " Two.", true), 1);
        NativeEarlyReply.Part header = reply.next(null);
        assertEquals("Agent finished\nProject", header.text);
        reply.drained(header);
        assertEquals("One. Two.", reply.next(null).text);
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
        reply.freeze("balanced", settings("messages"), 1);
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
