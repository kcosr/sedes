package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

/** The live handoff fences native submission ownership across delayed bridge callbacks. */
public class NativeVoiceComposerHandoffTest {
    @Test public void onlyTheVisibleDestinationWithALiveComposerIsEligible() {
        assertTrue(NativeVoiceComposerHandoff.eligible(true, true, true, "destination", "destination"));
        assertFalse(NativeVoiceComposerHandoff.eligible(false, true, true, "destination", "destination"));
        assertFalse(NativeVoiceComposerHandoff.eligible(true, false, true, "destination", "destination"));
        assertFalse(NativeVoiceComposerHandoff.eligible(true, true, false, "destination", "destination"));
        assertFalse(NativeVoiceComposerHandoff.eligible(true, true, true, "another-thread", "destination"));
        assertFalse(NativeVoiceComposerHandoff.eligible(true, true, true, null, null));
    }

    @Test public void claimRequiresTheOriginalBindingGenerationAndUninterruptedRoute() {
        Object route = new Object();
        for (String changed : new String[] { "binding", "generation", "route", "native", "web", "composer", "thread" }) {
            NativeVoiceComposerHandoff offer = offer(route);
            assertCode("composer_handoff_unavailable", () -> offer.claim(
                changed.equals("binding") ? "another-owner" : "owner", changed.equals("generation") ? 8 : 7,
                changed.equals("route") ? new Object() : route, !changed.equals("native"), !changed.equals("web"),
                !changed.equals("composer"), changed.equals("thread") ? "another-thread" : "destination"));
            assertFalse("A rejected claim cannot own sending", offer.claimed);
            offer.complete("owner", 7, false);
            assertTrue("The raw recording may then be retained for manual recovery", offer.finished);
        }
    }

    @Test public void acceptedOwnershipRequiresAClaimAndCannotBeCompletedTwice() {
        Object route = new Object(); NativeVoiceComposerHandoff offer = offer(route);
        assertCode("composer_handoff_unclaimed", () -> offer.complete("owner", 7, true));
        assertFalse(offer.finished);
        offer.claim("owner", 7, route, true, true, true, "destination");
        assertCode("composer_handoff_changed", () -> offer.claim("owner", 7, route, true, true, true, "destination"));
        assertCode("composer_handoff_changed", () -> offer.complete("another-owner", 7, true));
        assertCode("composer_handoff_changed", () -> offer.complete("owner", 8, true));
        assertFalse(offer.finished);
        // Foreground eligibility is intentionally absent here: composer owns the claimed live handoff.
        offer.complete("owner", 7, true);
        assertTrue(offer.finished);
        assertCode("composer_handoff_changed", () -> offer.complete("owner", 7, true));
        assertCode("composer_handoff_changed", () -> offer.complete("owner", 7, false));
    }

    @Test public void declinedClaimedSpeechRemainsTheExactRecordingAndFrozenMode() {
        Object route = new Object(); NativeVoiceComposerHandoff offer = offer(route);
        offer.claim("owner", 7, route, true, true, true, "destination");
        offer.complete("owner", 7, false);
        assertTrue(offer.finished); assertEquals("recording", offer.recordingId);
        assertEquals("  speech\n完整🙂  ", offer.text); assertEquals("steer", offer.mode);
        assertEquals("queue", new NativeVoiceComposerHandoff("handoff", "owner", 7, route,
            "recording", "destination", "speech", false).mode);
        assertCode("composer_handoff_changed", () -> offer.claim("owner", 7, route, true, true, true, "destination"));
    }

    private static NativeVoiceComposerHandoff offer(Object route) {
        return new NativeVoiceComposerHandoff("handoff", "owner", 7, route, "recording", "destination", "  speech\n完整🙂  ", true);
    }
    private static void assertCode(String code, Runnable action) {
        assertEquals(code, assertThrows(IllegalStateException.class, action::run).getMessage());
    }
}
