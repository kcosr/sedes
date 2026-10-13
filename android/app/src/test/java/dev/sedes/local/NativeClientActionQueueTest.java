package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;
import org.json.JSONObject;

public class NativeClientActionQueueTest {
    private final Object navigation = new Object();
    private JSONObject command(String id, String action, String turn) {
        return NativeVoiceJson.object("id", id, "action", action, "sourceThreadId", "thread", "sourceTurnId", turn, "expiresAt", 120000);
    }
    private JSONObject listen(String id, String turn) {
        JSONObject command = command(id, "switch_thread", turn);
        NativeVoiceJson.put(command, "listen", true); return command;
    }
    @Test public void waitsForBothSettlementAndActualPlaybackDrainInEitherOrder() {
        for (boolean voiceOnly : new boolean[] { false, true }) for (boolean drainFirst : new boolean[] { false, true }) {
            NativeClientActionQueue queue = new NativeClientActionQueue();
            queue.stage(command("action", "switch_thread", "turn"), navigation, voiceOnly, 0);
            assertTrue(queue.suppresses("thread", "turn", 1));
            assertFalse(queue.suppresses("thread", "other-turn", 1));
            assertFalse(queue.suppresses("other-thread", "turn", 1));
            if (drainFirst) queue.drained("reply"); else queue.settle("action", "reply", "stream", 120000);
            assertTrue(queue.takeReady(2, true, "stream", false, null, null, navigation, id -> false).isEmpty());
            if (drainFirst) queue.settle("action", "reply", "stream", 120000); else queue.drained("reply");
            // A correlated active interaction remains an independent drain gate.
            assertTrue(queue.takeReady(3, true, "stream", false, "thread", "turn", navigation, id -> false).isEmpty());
            assertEquals(1, queue.takeReady(4, true, "stream", false, null, null, navigation, id -> false).size());
            assertTrue(queue.takeReady(5, true, "stream", false, null, null, navigation, id -> false).isEmpty());
        }
    }
    @Test public void noReplyAndVoiceOffDoNotLeaveNavigationWaitingForNonexistentAudio() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(command("silent", "switch_thread", "turn"), navigation, false, 0);
        queue.settle("silent", null, null, 120000);
        assertEquals(1, queue.takeReady(1, true, "stream", false, null, null, navigation, id -> false).size());
        queue.stage(command("off", "switch_thread", "turn"), navigation, false, 2);
        queue.settle("off", "reply-delivered-to-other-subscriber", "stream", 120000);
        assertEquals(1, queue.takeReady(3, false, "stream", false, null, null, navigation, id -> false).size());
    }
    @Test public void settlementStartsAnIndependentDeadlineForLongReplyPlayback() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        JSONObject command = command("action", "end_interaction", "turn");
        NativeVoiceJson.put(command, "expiresAt", 86400000);
        queue.stage(command, navigation, false, 0);
        assertTrue(queue.suppresses("thread", "turn", 600000));
        queue.settle("action", "reply", "stream", 4200000);
        assertTrue(queue.suppresses("thread", "turn", 1200000));
        queue.drained("reply");
        assertEquals(1, queue.takeReady(1200000, true, "stream", false, null, null, navigation, id -> false).size());
    }
    @Test public void expiryManualNavigationAndConnectionChangesSupersedePendingActions() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(command("expired", "switch_thread", "turn"), navigation, false, 0);
        queue.settle("expired", null, null, 120000);
        assertTrue(queue.takeReady(120000, true, "stream", false, null, null, navigation, id -> false).isEmpty());
        queue.stage(command("navigated", "switch_thread", "turn"), navigation, false, 1);
        queue.settle("navigated", null, null, 120000);
        assertTrue(queue.takeReady(2, true, "stream", false, null, null, new Object(), id -> false).isEmpty());
        queue.stage(command("reconnected", "end_interaction", "turn"), navigation, false, 3);
        queue.clear();
        assertFalse(queue.settle("reconnected", "reply", "stream", 120000));
        assertFalse(queue.suppresses("thread", "turn", 4));
    }
    @Test public void laterInstructionOnlySupersedesItsOwnTurnAndPlaybackFailureDropsThatTurn() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(command("first", "switch_thread", "turn"), navigation, true, 0);
        queue.stage(command("other", "end_interaction", "other"), navigation, false, 0);
        queue.stage(command("last", "end_interaction", "turn"), navigation, false, 1);
        assertFalse(queue.settle("first", null, null, 120000));
        assertTrue(queue.settle("last", null, null, 120000));
        queue.discardTurn("thread", "turn");
        assertFalse(queue.suppresses("thread", "turn", 2));
        assertTrue(queue.suppresses("thread", "other", 2));
        assertTrue(queue.takeReady(3, true, "stream", false, null, null, navigation, id -> false).isEmpty());
    }
    @Test public void backgroundVoiceIntentSurvivesVisibilityContextChangesWithoutBecomingNavigation() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        JSONObject voice = command("voice", "switch_thread", "voice-turn");
        NativeVoiceJson.put(voice, "listen", true);
        queue.stage(voice, navigation, true, 0);
        queue.stage(command("navigate", "switch_thread", "navigate-turn"), navigation, false, 0);
        assertTrue(queue.settle("voice", null, null, 120000));
        assertTrue(queue.settle("navigate", null, null, 120000));
        java.util.List<NativeClientActionQueue.Action> ready = queue.takeReady(1, true, "stream", false, null, null, new Object(), id -> false);
        assertEquals(1, ready.size());
        assertEquals("voice", ready.get(0).command.optString("id"));
        assertTrue(ready.get(0).voiceOnly);
    }
    @Test public void deliberateNavigationDiscardsVoiceIntentButPreservesOtherTurnControls() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(listen("voice", "voice-turn"), navigation, true, 0);
        queue.stage(command("end", "end_interaction", "end-turn"), navigation, false, 0);
        queue.discardListens();
        assertFalse(queue.settle("voice", null, null, 120000));
        assertFalse(queue.suppresses("thread", "voice-turn", 1));
        assertTrue(queue.settle("end", null, null, 120000));
        assertEquals("end", queue.takeReady(2, true, "stream", false, null, null, new Object(), id -> false).get(0).command.optString("id"));
    }
    @Test public void expiryAndSessionTeardownStillRetireBackgroundVoiceIntent() {
        for (boolean expired : new boolean[] { false, true }) {
            NativeClientActionQueue queue = new NativeClientActionQueue();
            queue.stage(command("voice", "switch_thread", "turn"), navigation, true, 0);
            assertTrue(queue.settle("voice", "reply", "stream", 120000));
            if (!expired) queue.clear();
            queue.drained("reply");
            assertTrue(queue.takeReady(expired ? 120000 : 1, true, "stream", false, null, null, new Object(), id -> false).isEmpty());
            assertFalse(queue.settle("voice", null, null, 240000));
        }
    }
    @Test public void acceptedListensWaitForUnrelatedAudioAndReserveOneStartAtATime() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        for (String id : new String[] { "first", "second" }) {
            queue.stage(listen(id, id), navigation, true, 0);
            queue.settle(id, null, null, 120000);
        }
        assertTrue(queue.takeReady(1, true, "stream", true, "elsewhere", "other", navigation, id -> false).isEmpty());
        assertEquals("first", queue.takeReady(2, true, "stream", false, null, null, navigation, id -> false).get(0).command.optString("id"));
        assertTrue(queue.suppresses("thread", "second", 2));
        assertEquals("second", queue.takeReady(3, true, "stream", false, null, null, navigation, id -> false).get(0).command.optString("id"));
    }
    @Test public void lostStreamDoesNotHoldSettlementButQueuedSourcePlaybackStillDoes() {
        for (String currentStream : new String[] { "new-stream", null }) {
            NativeClientActionQueue queue = new NativeClientActionQueue();
            queue.stage(listen("action", "turn"), navigation, true, 0);
            queue.settle("action", "reply", "lost-stream", 120000);
            assertTrue(queue.takeReady(1, true, currentStream, false, null, null, navigation, "reply"::equals).isEmpty());
            assertTrue(queue.takeReady(2, true, currentStream, false, "thread", "turn", navigation, id -> false).isEmpty());
            assertEquals(1, queue.takeReady(3, true, currentStream, false, null, null, navigation, id -> false).size());
        }
    }
    @Test public void noMatchingLocalStreamDoesNotCreateANullIdentityBarrier() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(listen("action", "turn"), navigation, true, 0);
        queue.settle("action", "delivered-elsewhere", null, 120000);
        assertTrue(queue.takeReady(1, true, null, false, null, null, navigation, "delivered-elsewhere"::equals).isEmpty());
        assertEquals(1, queue.takeReady(2, true, null, false, null, null, navigation, id -> false).size());
    }
    @Test public void foregroundListenSurvivesVisibilityButManualNavigationCancelsIt() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(listen("listen", "turn"), navigation, false, 0);
        queue.settle("listen", null, null, 120000);
        assertEquals(1, queue.takeReady(1, true, "stream", false, null, null, new Object(), id -> false).size());
        queue.stage(listen("cancelled", "turn"), navigation, false, 0);
        queue.discardListens();
        assertFalse(queue.settle("cancelled", null, null, 120000));
    }
    @Test public void sourceCancellationRevokesOnlyTheMatchingAcceptedAction() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(listen("cancelled", "turn"), navigation, true, 0);
        queue.stage(listen("other", "other-turn"), navigation, true, 0);
        assertFalse(queue.cancel("cancelled", "other-thread", "turn"));
        assertFalse(queue.cancel("cancelled", "thread", "other-turn"));
        assertTrue(queue.hasListen(1)); assertTrue(queue.cancel("cancelled", "thread", "turn"));
        assertFalse(queue.settle("cancelled", "reply", "stream", 120000));
        assertTrue(queue.suppresses("thread", "other-turn", 1));
        assertTrue(queue.cancel("other", "thread", "other-turn")); assertFalse(queue.hasListen(1));
    }
}
