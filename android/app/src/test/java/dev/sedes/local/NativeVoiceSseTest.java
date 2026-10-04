package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.InputStreamReader;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class NativeVoiceSseTest {
    @Test public void parsesSplitUtf8NamedFramesWithoutReplayingInventoryIds() throws Exception {
        String stream = "\ufeff: keepalive\r\nevent: application\r\nid: cursor-42\r\ndata: ignored\r\n\r\n" +
            "event: notification_policy\r\ndata: {\"generation\":1}\r\n\r\n" +
            "event: notification\ndata: {\"text\":\"🦦 café\"}\n\n";
        List<String> frames = new ArrayList<>(); NativeVoiceSse parser = new NativeVoiceSse((event, data) -> frames.add(event + ":" + data));
        try (InputStreamReader reader = new InputStreamReader(new ByteArrayInputStream(stream.getBytes(StandardCharsets.UTF_8)), StandardCharsets.UTF_8)) {
            char[] buffer = new char[1]; int count; while ((count = reader.read(buffer)) != -1) parser.accept(buffer, count);
        }
        assertEquals(2, frames.size()); assertEquals("notification_policy:{\"generation\":1}", frames.get(0));
        assertEquals("notification:{\"text\":\"🦦 café\"}", frames.get(1));
    }
    @Test public void passesTheHandshakeLiveMarkerAfterQueuedTransientFrames() {
        // The server's handshake order: inventory snapshot, queued transient frames, then the live marker.
        String stream = "event: application\nid: snapshot-1\ndata: {\"type\":\"snapshot\"}\n\n" +
            "event: notification_policy\ndata: {\"generation\":3}\n\n" + "event: application-live\ndata: {}\n\n" +
            ": heartbeat\n\nevent: application\ndata: {}\n\n";
        for (int chunk : new int[] { 1, 5, stream.length() })
            assertEquals(java.util.Arrays.asList("notification_policy:{\"generation\":3}", "application-live:{}"), parse(stream, chunk));
        assertEquals("application-live", NativeVoiceSse.LIVE);
    }
    @Test public void combinesDataLinesAndDoesNotDispatchIncompleteFrame() {
        List<String> frames = new ArrayList<>(); NativeVoiceSse parser = new NativeVoiceSse((event, data) -> frames.add(data));
        char[] input = "event: notification\ndata: one\ndata: two\n\nevent: notification\ndata: unfinished".toCharArray();
        parser.accept(input, input.length); assertEquals(java.util.Arrays.asList("one\ntwo"), frames);
    }
    private static List<String> parse(String stream, int chunk) {
        List<String> frames = new ArrayList<>(); NativeVoiceSse parser = new NativeVoiceSse((event, data) -> frames.add(event + ":" + data));
        char[] input = stream.toCharArray();
        for (int offset = 0; offset < input.length; offset += chunk) {
            int count = Math.min(chunk, input.length - offset);
            parser.accept(java.util.Arrays.copyOfRange(input, offset, offset + count), count);
        }
        return frames;
    }
    @Test public void crOnlyLineEndingsFrameEventsAcrossChunkBoundaries() {
        String stream = "event: notification\rdata: one\rdata: two\r\r: keepalive\revent: notification_policy\rdata: {}\r\r";
        for (int chunk : new int[] { 1, 2, 7, stream.length() })
            assertEquals(java.util.Arrays.asList("notification:one\ntwo", "notification_policy:{}"), parse(stream, chunk));
    }
    @Test public void lineAtTheCapIsDeliveredAndALongerLineDropsOnlyItsFrame() {
        String fitted = "x".repeat(1024 * 1024 - "data: ".length());
        assertEquals(java.util.Arrays.asList("notification:" + fitted), parse("event: notification\ndata: " + fitted + "\n\n", 4096));
        List<String> frames = parse("event: notification\ndata: " + fitted + "yz\n\nevent: notification\ndata: next\n\n", 4096);
        assertEquals(java.util.Arrays.asList("notification:next"), frames);
    }
    @Test public void dataLinePushingAFrameOverTheCapDropsOnlyThatFrame() {
        String half = "x".repeat(600 * 1024);
        List<String> frames = parse("event: notification\ndata: " + half + "\ndata: " + half + "\n\n" +
            "event: notification\ndata: next\n\n", 4096);
        assertEquals(java.util.Arrays.asList("notification:next"), frames);
    }
}
