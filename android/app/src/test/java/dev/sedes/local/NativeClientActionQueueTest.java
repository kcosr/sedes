package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;
import org.json.JSONObject;

public class NativeClientActionQueueTest {
    private final Object navigation = new Object();
    private JSONObject command(String id, String action, String turn) {
        return NativeVoiceJson.object("id", id, "action", action, "sourceThreadId", "thread", "sourceTurnId", turn, "expiresAt", 120000);
    }
    @Test public void waitsForBothSettlementAndActualPlaybackDrainInEitherOrder() {
        for (boolean drainFirst : new boolean[] { false, true }) {
            NativeClientActionQueue queue = new NativeClientActionQueue();
            queue.stage(command("action", "switch_thread", "turn"), navigation, 0);
            assertTrue(queue.suppresses("thread", "turn", 1));
            assertFalse(queue.suppresses("thread", "other-turn", 1));
            assertFalse(queue.suppresses("other-thread", "turn", 1));
            if (drainFirst) queue.drained("reply"); else queue.settle("action", "reply", 120000);
            assertTrue(queue.takeReady(2, true, null, null, navigation).isEmpty());
            if (drainFirst) queue.settle("action", "reply", 120000); else queue.drained("reply");
            // A correlated active interaction remains an independent drain gate.
            assertTrue(queue.takeReady(3, true, "thread", "turn", navigation).isEmpty());
            assertEquals(1, queue.takeReady(4, true, null, null, navigation).size());
            assertTrue(queue.takeReady(5, true, null, null, navigation).isEmpty());
        }
    }
    @Test public void noReplyAndVoiceOffDoNotLeaveNavigationWaitingForNonexistentAudio() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(command("silent", "switch_thread", "turn"), navigation, 0);
        queue.settle("silent", null, 120000);
        assertEquals(1, queue.takeReady(1, true, null, null, navigation).size());
        queue.stage(command("off", "switch_thread", "turn"), navigation, 2);
        queue.settle("off", "reply-delivered-to-other-subscriber", 120000);
        assertEquals(1, queue.takeReady(3, false, null, null, navigation).size());
    }
    @Test public void settlementStartsAnIndependentDeadlineForLongReplyPlayback() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        JSONObject command = command("action", "end_interaction", "turn");
        NativeVoiceJson.put(command, "expiresAt", 86400000);
        queue.stage(command, navigation, 0);
        assertTrue(queue.suppresses("thread", "turn", 600000));
        queue.settle("action", "reply", 4200000);
        assertTrue(queue.suppresses("thread", "turn", 1200000));
        queue.drained("reply");
        assertEquals(1, queue.takeReady(1200000, true, null, null, navigation).size());
    }
    @Test public void expiryManualNavigationAndConnectionChangesSupersedePendingActions() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(command("expired", "switch_thread", "turn"), navigation, 0);
        queue.settle("expired", null, 120000);
        assertTrue(queue.takeReady(120000, true, null, null, navigation).isEmpty());
        queue.stage(command("navigated", "switch_thread", "turn"), navigation, 1);
        queue.settle("navigated", null, 120000);
        assertTrue(queue.takeReady(2, true, null, null, new Object()).isEmpty());
        queue.stage(command("reconnected", "end_interaction", "turn"), navigation, 3);
        queue.clear();
        assertFalse(queue.settle("reconnected", "reply", 120000));
        assertFalse(queue.suppresses("thread", "turn", 4));
    }
    @Test public void laterInstructionOnlySupersedesItsOwnTurnAndPlaybackFailureDropsThatTurn() {
        NativeClientActionQueue queue = new NativeClientActionQueue();
        queue.stage(command("first", "switch_thread", "turn"), navigation, 0);
        queue.stage(command("other", "end_interaction", "other"), navigation, 0);
        queue.stage(command("last", "end_interaction", "turn"), navigation, 1);
        assertFalse(queue.settle("first", null, 120000));
        assertTrue(queue.settle("last", null, 120000));
        queue.discardTurn("thread", "turn");
        assertFalse(queue.suppresses("thread", "turn", 2));
        assertTrue(queue.suppresses("thread", "other", 2));
        assertTrue(queue.takeReady(3, true, null, null, navigation).isEmpty());
    }
}
