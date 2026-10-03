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
    @Test public void combinesDataLinesAndDoesNotDispatchIncompleteFrame() {
        List<String> frames = new ArrayList<>(); NativeVoiceSse parser = new NativeVoiceSse((event, data) -> frames.add(data));
        char[] input = "event: notification\ndata: one\ndata: two\n\nevent: notification\ndata: unfinished".toCharArray();
        parser.accept(input, input.length); assertEquals(java.util.Arrays.asList("one\ntwo"), frames);
    }
}
