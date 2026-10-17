package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeVoiceComposerSubmissionsTest {
    @Test public void ownershipAcceptanceDoesNotReleasePendingPresentation() {
        NativeVoiceComposerSubmissions submissions = new NativeVoiceComposerSubmissions();
        NativeVoiceComposerHandoff offer = claimed("one", "owner", 7);
        submissions.claim(offer, 100);
        offer.complete("owner", 7, true);
        assertTrue(submissions.blocks("owner", 7));
        assertFalse(submissions.blocks("another-owner", 7));
        assertFalse(submissions.blocks("owner", 8));
        assertNotNull(submissions.release("one", 7));
        assertFalse(submissions.blocks("owner", 7));
        assertNull(submissions.release("one", 7));
        assertTrue("Presentation settlement must not undo accepted ownership", offer.finished);
    }

    @Test public void overlappingClaimsHaveIndependentLifetimesAndExactGenerationFences() {
        NativeVoiceComposerSubmissions submissions = new NativeVoiceComposerSubmissions();
        submissions.claim(claimed("one", "owner", 7), 100);
        submissions.claim(claimed("two", "owner", 7), 200);
        assertNull(submissions.release("one", 8));
        assertNull(submissions.release("unknown", 7));
        assertNotNull(submissions.release("one", 7));
        assertTrue("An older completion cannot release a newer handoff", submissions.blocks("owner", 7));
        assertNotNull(submissions.release("two", 7));
        assertFalse(submissions.blocks("owner", 7));
    }

    @Test public void elapsedDeadlineReleasesOnlyPresentationWithoutChangingRecordingOwnership() {
        NativeVoiceComposerSubmissions submissions = new NativeVoiceComposerSubmissions();
        NativeVoiceComposerHandoff first = claimed("one", "owner", 7);
        NativeVoiceComposerHandoff second = claimed("two", "owner", 7);
        submissions.claim(first, 100);
        submissions.claim(second, 101);
        assertTrue(submissions.expire(100 + NativeVoiceComposerSubmissions.TIMEOUT_MS - 1).isEmpty());
        var expired = submissions.expire(100 + NativeVoiceComposerSubmissions.TIMEOUT_MS);
        assertEquals(1, expired.size()); assertEquals("one", expired.get(0).id);
        assertTrue(expired.get(0).current("owner", 7));
        assertTrue(first.claimed); assertFalse(first.finished);
        assertTrue(submissions.blocks("owner", 7));
        assertNull("A late settlement is harmless", submissions.release("one", 7));
        assertEquals(1, submissions.expire(101 + NativeVoiceComposerSubmissions.TIMEOUT_MS).size());
        assertFalse(submissions.blocks("owner", 7));
        assertTrue(submissions.expire(Long.MAX_VALUE).isEmpty());
    }

    @Test public void clearingAStoppedSessionCannotReleaseOrExpireItsReplacement() {
        NativeVoiceComposerSubmissions submissions = new NativeVoiceComposerSubmissions();
        NativeVoiceComposerHandoff previous = claimed("old", "old-owner", 7);
        submissions.claim(previous, 100);
        submissions.clear();
        submissions.claim(claimed("new", "new-owner", 8), 200);
        assertNull(submissions.release("old", 7));
        assertTrue(submissions.expire(100 + NativeVoiceComposerSubmissions.TIMEOUT_MS).isEmpty());
        assertTrue(submissions.blocks("new-owner", 8));
        assertFalse(previous.finished);
        previous.complete("old-owner", 7, true);
        assertTrue(submissions.blocks("new-owner", 8));
    }

    @Test public void onlyAnUnfinishedClaimCanReservePresentation() {
        NativeVoiceComposerSubmissions submissions = new NativeVoiceComposerSubmissions();
        NativeVoiceComposerHandoff offer = new NativeVoiceComposerHandoff("one", "owner", 7,
            new Object(), "recording", "thread", "speech", false);
        assertThrows(IllegalStateException.class, () -> submissions.claim(offer, 100));
        NativeVoiceComposerHandoff valid = claimed("two", "owner", 7);
        submissions.claim(valid, 100);
        assertThrows(IllegalStateException.class, () -> submissions.claim(valid, 101));
        NativeVoiceComposerHandoff finished = claimed("three", "owner", 7);
        finished.complete("owner", 7, false);
        assertThrows(IllegalStateException.class, () -> submissions.claim(finished, 100));
    }

    private static NativeVoiceComposerHandoff claimed(String id, String binding, long generation) {
        Object route = new Object();
        NativeVoiceComposerHandoff offer = new NativeVoiceComposerHandoff(id, binding, generation, route,
            "recording-" + id, "thread", "speech", false);
        offer.claim(binding, generation, route, true, true, true, "thread");
        return offer;
    }
}
