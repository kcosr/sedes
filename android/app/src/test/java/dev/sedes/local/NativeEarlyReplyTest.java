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
    private static String sentence(int words) { return "word ".repeat(words - 1) + "word."; }
    private static void finishLive(NativeEarlyReply reply, int seq) {
        JSONObject marker = common("yield", seq); NativeVoiceJson.put(marker, "reason", "item_done");
        reply.accept(new NativeEarlyReply.Frame(marker), seq);
    }
    private static final class Sentences {
        final NativeEarlyReply reply;
        int end, seq = 1;
        Sentences(String mode, int limit, String first, boolean paragraph) {
            reply = new NativeEarlyReply(span(0, 0, first, paragraph), 0);
            reply.freeze(mode, settings("messages"), limit); end = first.length();
        }
        void append(String text, boolean paragraph) {
            reply.accept(span(seq, end, text, paragraph), seq); end += text.length(); seq++;
        }
        String take() {
            NativeEarlyReply.Part part = reply.next(null); assertNotNull(part); reply.drained(part);
            return part.text;
        }
    }
    @Test public void responsiveAndBalancedTakeEveryAvailableSentenceOnceTheMinimumIsMet() {
        for (String mode : new String[]{"responsive", "balanced"}) {
            String first = sentence(mode.equals("responsive") ? 5 : 14);
            Sentences stream = new Sentences(mode, 4096, first, true);
            assertNull(stream.reply.next(null));
            stream.append(" Good.", false); stream.append(" Yes.", true);
            assertEquals(first + " Good. Yes.", stream.take());
            stream.append(" Short.", true); assertNull(stream.reply.next(null));
            finishLive(stream.reply, stream.seq);
            assertEquals("Short.", stream.take());
        }
    }
    @Test public void naturalCrossesSmallParagraphsAndKeepsCountingALongParagraphAfterDrain() {
        String shortParagraph = sentence(8);
        Sentences stream = new Sentences("natural", 4096, shortParagraph, true);
        stream.append(" " + shortParagraph, false);
        assertNull(stream.reply.next(null)); // The group has 16 words but its last paragraph is still open.
        stream.append("", true);
        String twenty = sentence(20), forty = sentence(40);
        stream.append(" " + twenty, false);
        assertEquals(shortParagraph + " " + shortParagraph, stream.take());
        assertNull(stream.reply.next(null));
        stream.append(" " + forty, false);
        assertEquals(twenty + " " + forty, stream.take());
        String fourteen = sentence(14);
        stream.append(" " + fourteen, false);
        assertNull(stream.reply.next(null));
        stream.append(" Done.", false);
        assertEquals(fourteen + " Done.", stream.take());
        stream.append("", true);
        stream.append(" " + twenty, false);
        assertNull(stream.reply.next(null)); // New paragraph starts its own 60-word count.
        finishLive(stream.reply, stream.seq);
        assertEquals(twenty, stream.take());
    }
    @Test public void requestLimitSplitsOnlyQualifiedTextAndCarriesShortRemaindersForward() {
        String first = "Elaborate words.", second = " I am all set.";
        Sentences stream = new Sentences("responsive", 24, first, false);
        assertNull(stream.reply.next(null));
        stream.append(second, false);
        assertEquals(first, stream.take());
        // Four already-authorized words and two new ones can share the next request.
        stream.append(" Do it.", false);
        assertEquals(second.trim() + " Do it.", stream.take());
        stream.append(" " + first, false); stream.append(second, false);
        assertEquals(first, stream.take());
        assertEquals(second.trim(), stream.take()); // No subsequent append required.
        Sentences oversized = new Sentences("balanced", 5, "Enormous.", false);
        assertNull(oversized.reply.next(null));
        finishLive(oversized.reply, oversized.seq);
        assertEquals("Enorm", oversized.take());
        assertEquals("ous.", oversized.take());
        assertNull(oversized.reply.next(null));
    }
    private static NativeEarlyReply.Part drainBeforeLastWord(Sentences stream, String sentence) {
        int goal = sentence.lastIndexOf(' ') + 1;
        NativeEarlyReply.Part part;
        do {
            part = stream.reply.next(null); assertNotNull(part);
            stream.reply.drained(part);
        } while (part.preparedEnd < goal);
        assertEquals(goal, part.preparedEnd);
        return part;
    }
    @Test public void responsiveCombinesTheUnsubmittedTailOfAnOversizedSentenceWithNewWords() {
        String first = "Supercalifragilistic expialidocious words keep going now.";
        for (String more : new String[]{" A b c d e.", " A b c d e f."}) {
            Sentences stream = new Sentences("responsive", 20, first, false);
            NativeEarlyReply.Part drained = drainBeforeLastWord(stream, first);
            stream.append(more, false);
            NativeEarlyReply.Part combined = stream.reply.next(null);
            assertEquals("now." + more, combined.text);
            NativeVoiceSettings messages = settings("messages");
            NativeVoiceQueue.Item correction = terminal(first + " Replaced.", null, messages);
            assertTrue(stream.reply.agreesWith(drained, correction));
            assertFalse(stream.reply.agreesWith(combined, correction));
            assertEquals("now. Replaced.", stream.reply.terminal(correction, messages, ID));
        }
    }
    @Test public void naturalCombinesAPhysicalTailOnlyAtAQualifiedParagraphEndpoint() {
        String first = "word ".repeat(63) + "now.", next = " a b c d e f g h i j k l m n.";
        for (boolean paragraphBreak : new boolean[]{false, true}) {
            Sentences stream = new Sentences("natural", 35, first, paragraphBreak);
            drainBeforeLastWord(stream, first);
            stream.append(next, false);
            if (paragraphBreak) {
                assertEquals("now.", stream.reply.next(null).text);
                stream.append("", true);
            }
            assertEquals("now." + next, stream.take());
            NativeVoiceSettings messages = settings("messages");
            assertEquals("Afterward.", stream.reply.terminal(terminal(first + next + " Afterward.", null, messages), messages, ID));
        }
    }
    private static NativeVoiceQueue.Item notice(String event, String text, NativeVoiceSettings messages) {
        return event.equals("turn.progress") ? progress(ID, "message", text, messages) : terminal(text, null, messages);
    }
    @Test public void completedSourceCombinesShortOpeningWithTheEntireRemainingMessageOnce() {
        String first = "Yes.";
        String original = " Sedes can show whether a thread is running, idle, or waiting for input, either for one thread or across a list of threads.\n"
            + "The tools I have don’t show whether a thread has an unread or unacknowledged notification, or whether it has an attention badge. "
            + "They do show when an automation needs attention because a run failed or its outcome is uncertain.";
        NativeVoiceSettings messages = settings("messages");
        for (String mode : new String[]{"responsive", "balanced", "natural"})
            for (String event : new String[]{"turn.completed", "turn.progress"})
                for (String rest : new String[]{"", " This is a test.", original}) {
                    NativeEarlyReply reply = new NativeEarlyReply(span(event, 0, 0, first, false), 0);
                    reply.freeze(mode, messages, 4096);
                    assertNull(reply.next(null));
                    if (!rest.isEmpty()) reply.accept(span(event, 1, first.length(), rest, false), 1);
                    NativeEarlyReply.Part part = reply.next(null);
                    finishLive(reply, rest.isEmpty() ? 1 : 2);
                    if (part == null) part = reply.next(null);
                    assertNotNull(part);
                    NativeVoiceQueue.Item seal = notice(event, first + rest, messages);
                    assertEquals(seal.speech, part.text);
                    // Lookahead before physical drain and terminal reconciliation after it both stay silent.
                    assertNull(reply.next(part));
                    reply.drained(part); assertNull(reply.next(null));
                    assertEquals("", reply.terminal(seal, messages, ID));
                }
    }
    @Test public void interruptedSourceLeavesAnUnqualifiedFragmentForTheWholeTerminalText() {
        NativeVoiceSettings messages = settings("messages");
        String opening = sentence(16), fragment = " Yes.", rest = " This is a test.";
        for (String reason : new String[]{"markup", "limit", "stall", "observation_ended"}) {
            for (String mode : new String[]{"responsive", "balanced", "natural"}) {
                Sentences stream = new Sentences(mode, 4096, opening, true);
                assertEquals(opening, stream.take());
                stream.append(fragment, false);
                assertNull(stream.reply.next(null));
                JSONObject marker = common("yield", stream.seq);
                NativeVoiceJson.put(marker, "reason", reason);
                stream.reply.accept(new NativeEarlyReply.Frame(marker), stream.seq);
                assertNull(stream.reply.next(null));
                stream.reply.detach();
                assertEquals(fragment.trim() + rest, stream.reply.terminal(terminal(opening + fragment + rest, null, messages), messages, ID));
            }
        }
    }
    @Test public void interruptedNaturalSourceCanStillSpeakAnOpenParagraphThatMeetsItsWordMinimum() {
        Sentences stream = new Sentences("natural", 4096, sentence(15), false);
        assertNull(stream.reply.next(null));
        JSONObject marker = common("yield", stream.seq); NativeVoiceJson.put(marker, "reason", "markup");
        stream.reply.accept(new NativeEarlyReply.Frame(marker), stream.seq);
        assertEquals(sentence(15), stream.take());
    }
    @Test public void trailingWhitespaceAtItemEndCreatesNoRequestAndAddsNothingToReconcile() {
        NativeVoiceSettings messages = settings("messages");
        String opening = sentence(6), trailing = " \n";
        Sentences stream = new Sentences("responsive", 4096, opening, false);
        assertEquals(opening, stream.take());
        stream.append(trailing, false); finishLive(stream.reply, stream.seq);
        assertNull(stream.reply.next(null));
        assertEquals("", stream.reply.terminal(terminal(opening + trailing, null, messages), messages, ID));
    }
    @Test public void sealedBodyPreviewRequiresSourceAndPresentationAgreementAndOnlyDrainAdvancesIt() {
        NativeVoiceSettings both = settings("both");
        String body = "Yes. This is a test.";
        for (String event : new String[]{"turn.completed", "turn.progress"}) {
            NativeEarlyReply reply = new NativeEarlyReply(span(event, 0, 0, body, true), 0);
            reply.freeze("responsive", both, 4096); finishLive(reply, 1);
            NativeEarlyReply.Part header = reply.next(null), staged = reply.next(header);
            NativeVoiceQueue.Item seal = notice(event, body + " More detail.", both);
            assertTrue(reply.agreesWith(staged, seal));
            assertFalse(reply.agreesWith(staged, notice(event, "Corrected answer.", both)));
            assertFalse(reply.startsWithStaged(staged, seal, both, ID));
            reply.drained(header);
            assertTrue(reply.startsWithStaged(staged, seal, both, ID));
            assertFalse(reply.startsWithStaged(staged, seal, both, "other-speaker"));
            if (event.equals("turn.completed"))
                assertFalse(reply.startsWithStaged(staged, terminal(body, body, both), both, ID));
            assertFalse(reply.startsWithStaged(staged, seal, settings("announcements"), ID));
            assertTrue(reply.startsWithStaged(staged, seal, both, ID)); // A preview is still unplayed.
            reply.drained(staged);
            assertEquals("More detail.", reply.terminal(seal, both, ID));
        }
    }
    @Test public void identicalAnnouncementWordsCannotAuthorizeAStagedBodyInRestrictedModes() {
        NativeVoiceSettings messages = settings("messages");
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "It starts with these six words. ", false), 0);
        reply.freeze("responsive", messages, 4096);
        NativeEarlyReply.Part opening = reply.next(null);
        reply.accept(span(1, opening.rawEnd, "Agent finished", false), 1); finishLive(reply, 2);
        NativeEarlyReply.Part staged = reply.next(opening);
        reply.drained(opening);
        NativeVoiceSettings announcements = settings("announcements");
        NativeVoiceQueue.Item seal = terminal(opening.text + " Agent finished", null, announcements);
        assertTrue(seal.speech.startsWith(staged.text));
        assertFalse(reply.startsWithStaged(staged, seal, announcements, ID));
        NativeVoiceSettings input = messages.patch(messages.revision, NativeVoiceJson.object("audioMode", "input"));
        assertFalse(reply.startsWithStaged(staged, seal, input, ID));
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
        finishLive(reply, 2);
        NativeEarlyReply.Part first = reply.next(null); assertEquals("One.", first.text); reply.drained(first);
        assertNull(reply.next(null));
    }
    @Test public void detachedRawAndRenderedHashesTrackPhysicalSplitsAndNeverSearchRepeatedWords() {
        NativeVoiceSettings settings = settings("messages");
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "echo echo echo.", true), 0);
        reply.freeze("responsive", settings, 5);
        finishLive(reply, 1);
        NativeEarlyReply.Part chunk = reply.next(null); assertEquals("echo ", chunk.text); reply.drained(chunk);
        NativeEarlyReply.Part preview = reply.next(null); assertEquals("echo ", preview.text);
        assertTrue(reply.agreesWith(chunk, terminal("echo new answer.", null, settings)));
        assertFalse(reply.agreesWith(chunk, terminal("Corrected answer.", null, settings)));
        reply.detach(); assertEquals(0, reply.pendingBytes());
        assertEquals("echo echo. End.", reply.terminal(terminal("echo echo echo. End.", null, settings), settings, ID));
        assertEquals("new answer.", reply.terminal(terminal("echo new answer.", null, settings), settings, ID));
        assertEquals("Corrected answer.", reply.terminal(terminal("Corrected answer.", null, settings), settings, ID));
    }
    @Test public void bothUsesAudibleOwnerAtActualContinuationAndFormatsSectionAsAWhole() {
        NativeVoiceSettings both = settings("both");
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "One.", false), 0);
        reply.freeze("balanced", both, 4096);
        finishLive(reply, 1);
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
        finishLive(reply, 1);
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
            finishLive(reply, 1);
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
    @Test public void naturalSpeaksTheRawPreambleImmediatelyAndWaitsForAnEligibleBody() {
        NativeVoiceSettings both = settings("both");
        both = both.patch(both.revision, NativeVoiceJson.object("cleanSpeechText", false));
        NativeEarlyReply reply = new NativeEarlyReply(span(0, 0, "One.", false), 0);
        reply.freeze("natural", both, 4096);
        NativeEarlyReply.Part header = reply.next(null);
        assertEquals("Agent finished\nProject", header.text);
        reply.drained(header);
        assertNull(reply.next(null));
        reply.accept(span(1, 4, " Two.", true), 1);
        assertNull(reply.next(null));
        finishLive(reply, 2);
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
        reply.accept(span(1, 2, " B.", true), 8); finishLive(reply, 2);
        NativeEarlyReply.Part first = reply.next(null); assertEquals("A", first.text); reply.drained(first);
        NativeEarlyReply.Part end = reply.next(null); assertEquals(".", end.text); reply.drained(end);
        assertEquals("B", reply.next(null).text);
    }
    @Test public void prefsAreIndependentVersionedAndCompareAndSwap() {
        NativeEarlyReplyPreferences initial = NativeEarlyReplyPreferences.defaults(); assertEquals("off", initial.mode);
        NativeEarlyReplyPreferences next = initial.patch(0, "responsive");
        assertEquals(1, NativeEarlyReplyPreferences.fromRecord(next.record()).revision);
        assertThrows(IllegalStateException.class, () -> next.patch(0, "off"));
        assertThrows(IllegalArgumentException.class, () -> next.patch(1, "fast"));
    }
}
