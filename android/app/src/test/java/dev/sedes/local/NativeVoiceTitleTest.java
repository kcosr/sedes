package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeVoiceTitleTest {
    @Test public void serverTitlesProjectIntoNullableDurableNativeMetadata() {
        assertNull(NativeVoiceTitle.target(null));
        for (String title : new String[] { "", " \t\r\n", "\u00a0\u1680\u2007\u2028\u202f\u3000\ufeff" })
            assertNull(NativeVoiceTitle.target(title));
        assertEquals("Current title", NativeVoiceTitle.target("\ufeff Current title \u00a0"));
        assertEquals("x".repeat(512), NativeVoiceTitle.target("x".repeat(4096)));
        assertEquals("x".repeat(510), NativeVoiceTitle.target("x".repeat(510) + "  " + "tail"));
        assertEquals("\u200b", NativeVoiceTitle.target("\u200b"));
    }

    @Test public void nativeTitleLimitNeverSplitsASupplementaryCharacter() {
        String emoji = "\ud83d\ude80";
        assertEquals("x".repeat(510) + emoji, NativeVoiceTitle.target("x".repeat(510) + emoji + "tail"));
        assertEquals("x".repeat(511), NativeVoiceTitle.target("x".repeat(511) + emoji + "tail"));
        assertEquals(512, NativeVoiceTitle.target(emoji.repeat(2048)).length());
    }

    @Test public void announcementNamesTheDestinationBrieflyWithoutSpeakingControlCharacters() {
        assertEquals("Replying to Untitled thread.", NativeVoiceTitle.announcement(null));
        assertEquals("Replying to Untitled thread.", NativeVoiceTitle.announcement("\u0000\u0001"));
        assertEquals("Replying to Release review.", NativeVoiceTitle.announcement(" Release\n\t\u00a0review "));
        assertEquals("Replying to " + "x".repeat(160) + "….", NativeVoiceTitle.announcement("x".repeat(4096)));
        String emoji = "\ud83d\ude80";
        assertEquals("Replying to " + emoji.repeat(160) + "….", NativeVoiceTitle.announcement(emoji.repeat(240)));
    }
}
