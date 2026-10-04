package dev.sedes.local;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;

/**
 * The JVM unit tests use the reference org.json artifact; this runs the same
 * server-fitted payloads through Android's built-in org.json, whose escaping
 * differs (for example, it escapes every '/').
 */
public class NativeVoiceQueueDeviceTest {
    // Server JSON.stringify text, kept identical to NativeVoiceQueueTest.
    private static final String ESCAPED_PREFIX = "a/b </c> d—e \\\"q\\\" \\\\ \\n\\t\\u0001 é\u0085 €    🦦 lone\\ud800 ";
    private static String payloadJson(String escapedText) {
        return "{\"schemaVersion\":4,\"notificationId\":\"notice-1\",\"event\":\"turn.completed\",\"occurredAt\":\"2026-10-03T00:00:00.000Z\"," +
            "\"title\":\"Completed\",\"message\":\"Workspace: a/b\",\"thread\":{\"id\":\"thread-a\",\"title\":\"Thread A\"}," +
            "\"assistantResult\":{\"final\":{\"text\":\"" + escapedText + "\",\"truncation\":{\"truncated\":true,\"originalBytes\":200000," +
            "\"retainedBytes\":65000,\"reason\":\"byte_limit\"}}}}";
    }
    private static int utf8(String value) { return value.getBytes(StandardCharsets.UTF_8).length; }
    private static JSONObject wire(String payload) throws Exception {
        return NativeVoiceJson.object("sourceEventId", "fitted", "generation", 1, "voice", "speak", "payload", new JSONObject(payload));
    }
    private static NativeVoiceSettings response() {
        return NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("audioMode", "response"));
    }

    @Test public void payloadSizeMatchesServerJsonStringifyMeasureWithPlatformJson() throws Exception {
        String mixed = payloadJson(ESCAPED_PREFIX + "tail");
        assertEquals(utf8(mixed), NativeVoiceJson.serializedBytes(new JSONObject(mixed)));
        String values = "{\"a\":[true,false,null,-12,0,9007199254740991],\"b\":{},\"c\":[],\"d\":\"x\"}";
        assertEquals(utf8(values), NativeVoiceJson.serializedBytes(new JSONObject(values)));
    }

    @Test public void serverFittedPayloadFullOfSlashesIsAcceptedAtTheExactLimitWithPlatformJson() throws Exception {
        int fill = (int) NativeVoiceQueue.MAX_PAYLOAD_BYTES - utf8(payloadJson(ESCAPED_PREFIX));
        String fitted = payloadJson(ESCAPED_PREFIX + "/".repeat(fill));
        assertEquals(65536, utf8(fitted));
        NativeVoiceQueue.Item item = new NativeVoiceQueue.Item(wire(fitted), response());
        assertTrue(item.speech.contains("/".repeat(fill)));
        String over = payloadJson(ESCAPED_PREFIX + "/".repeat(fill + 1));
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () -> new NativeVoiceQueue.Item(wire(over), response()));
        assertEquals("voice_payload_too_large", error.getMessage());
    }
}
