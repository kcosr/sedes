package dev.sedes.local;

import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceDiagnosticsTest {
    private static final String SOURCE = "0123456789abcdef".repeat(4);
    private void record(NativeVoiceDiagnostics log, String source, String kind, String reason) {
        log.record(NativeVoiceDiagnostics.Event.RECEIVED, source, kind, 2, 4, 3, 1, 32, -1, reason);
    }
    @Test public void optInRetainsBoundedCopiesAfterDisableUntilExplicitClear() throws Exception {
        AtomicLong elapsed = new AtomicLong(10);
        NativeVoiceDiagnostics log = new NativeVoiceDiagnostics(() -> 123456, elapsed::getAndIncrement);
        record(log, SOURCE, "turn.completed", null);
        assertEquals(0, log.read().getJSONArray("entries").length());
        assertEquals(10, elapsed.get());
        log.enabled(true);
        for (int i = 0; i < NativeVoiceDiagnostics.MAX_ENTRIES + 3; i++) record(log, SOURCE, "turn.completed", null);
        JSONObject read = log.read();
        JSONArray entries = read.getJSONArray("entries");
        assertEquals(NativeVoiceDiagnostics.MAX_ENTRIES, entries.length());
        assertEquals(4, entries.getJSONObject(0).getLong("sequence"));
        assertEquals(13, entries.getJSONObject(0).getLong("elapsedMilliseconds"));
        entries.getJSONObject(0).put("sourceEventId", "changed");
        assertEquals(SOURCE, log.read().getJSONArray("entries").getJSONObject(0).getString("sourceEventId"));
        log.enabled(false);
        record(log, SOURCE, "turn.failed", null);
        assertFalse(log.read().getBoolean("enabled"));
        assertEquals(NativeVoiceDiagnostics.MAX_ENTRIES, log.read().getJSONArray("entries").length());
        log.clear();
        assertEquals(0, log.read().getJSONArray("entries").length());
    }
    @Test public void exportsOnlyOpaqueSourceHashesAndKnownKindsAndReasons() throws Exception {
        NativeVoiceDiagnostics log = new NativeVoiceDiagnostics(() -> 123456, () -> 10);
        log.enabled(true);
        record(log, SOURCE, "turn.completed", "overflow");
        JSONObject safe = log.read().getJSONArray("entries").getJSONObject(0);
        assertEquals(SOURCE, safe.getString("sourceEventId"));
        assertEquals("overflow", safe.getString("reason"));
        assertEquals(2, safe.getLong("connectionGeneration"));
        assertEquals(4, safe.getLong("streamGeneration"));
        assertEquals(3, safe.getLong("policyGeneration"));
        record(log, "private thread id or bearer secret", "private speech", "private exception");
        JSONObject unsafe = log.read().getJSONArray("entries").getJSONObject(1);
        assertFalse(unsafe.has("sourceEventId")); assertFalse(unsafe.has("eventKind"));
        assertEquals("other", unsafe.getString("reason"));
        assertFalse(log.read().toString().contains("private"));
        record(log, "a".repeat(65), "turn.completed", null);
        assertFalse(log.read().getJSONArray("entries").getJSONObject(2).has("sourceEventId"));
    }
    @Test public void diagnosticFailureDoesNotEscape() throws Exception {
        NativeVoiceDiagnostics log = new NativeVoiceDiagnostics(() -> { throw new IllegalStateException("private failure"); }, () -> 10);
        log.enabled(true);
        record(log, SOURCE, "turn.completed", null);
        assertEquals(0, log.read().getJSONArray("entries").length());
    }
    @Test public void queueReportsAdmissionDuplicateEvictionAndStopWithoutChangingQueueSemantics() throws Exception {
        NativeVoiceDiagnostics log = new NativeVoiceDiagnostics(() -> 123456, () -> 10);
        log.enabled(true);
        NativeVoiceQueue[] owner = new NativeVoiceQueue[1];
        owner[0] = new NativeVoiceQueue((event, item, reason) -> log.record(event, item.id, item.event, 1, 2, 3,
            owner[0].size(), owner[0].bytes(), -1, reason));
        NativeVoiceQueue queue = owner[0];
        NativeVoiceQueue.Item progress = item(SOURCE, "turn.progress");
        assertTrue(queue.add(progress)); assertFalse(queue.add(progress));
        for (int i = 1; i < NativeVoiceQueue.MAX_ITEMS; i++) assertTrue(queue.add(item(String.format("%064x", i), "turn.completed")));
        assertTrue(queue.add(item("f".repeat(64), "turn.completed")));
        assertEquals(NativeVoiceQueue.MAX_ITEMS, queue.size());
        assertFalse(queue.add(item("e".repeat(64), "turn.completed")));
        queue.clearPending(); assertEquals(0, queue.size()); assertEquals(0, queue.bytes());
        String output = log.read().toString();
        for (String marker : new String[] { "queued", "duplicate", "progress_evicted", "overflow", "stopped" }) assertTrue(marker, output.contains(marker));
        assertFalse(output.contains("private"));
        NativeVoiceQueue failing = new NativeVoiceQueue((event, item, reason) -> { throw new IllegalStateException("sink failed"); });
        assertTrue(failing.add(progress)); assertSame(progress, failing.take());
    }
    private NativeVoiceQueue.Item item(String id, String event) {
        JSONObject payload = NativeVoiceJson.object("schemaVersion", 5, "notificationId", id, "event", event,
            "occurredAt", "2026-10-10T00:00:00Z", "title", "private title", "message", "private speech");
        if (event.equals("turn.progress")) NativeVoiceJson.put(payload, "progress", NativeVoiceJson.object("itemId", "private item", "phase", "provisional", "text", "private response"));
        NativeVoiceJson.put(payload, "thread", NativeVoiceJson.object("id", "private-thread", "title", "Private title"));
        return new NativeVoiceQueue.Item(NativeVoiceJson.object("sourceEventId", id, "generation", 3, "voice", "speak", "userInputRevision", 0, "payload", payload),
            NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("audioMode", "speak")));
    }
}
