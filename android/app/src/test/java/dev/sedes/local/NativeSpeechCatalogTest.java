package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

public class NativeSpeechCatalogTest {
    @Test public void openaiAccountListingSuppliesHintsWhileSelectedModelControlsMetadata() {
        JSONObject listing = NativeVoiceJson.object("object", "list", "data", new JSONArray()
            .put(NativeVoiceJson.object("id", "gpt-live-transcribe"))
            .put(NativeVoiceJson.object("id", "gpt-4o-mini-tts"))
            .put(NativeVoiceJson.object("id", "some-future-model")));
        JSONObject catalog = NativeSpeechCatalog.openai(listing, "gpt-4o-mini-tts");
        assertEquals("[\"gpt-live-transcribe\"]", catalog.optJSONArray("sttModels").toString());
        assertEquals("[\"gpt-4o-mini-tts\"]", catalog.optJSONArray("ttsModels").toString());
        assertTrue(catalog.optJSONArray("voices").toString().contains("cedar"));
        assertEquals(0.25, catalog.optJSONObject("speed").optDouble("min"), 0);
        JSONObject unknown = NativeSpeechCatalog.openai(listing, "some-future-model");
        assertEquals(0, unknown.optJSONArray("voices").length()); assertTrue(unknown.isNull("speed"));
        JSONObject legacy = NativeSpeechCatalog.openai(listing, "tts-1");
        assertFalse(legacy.optJSONArray("voices").toString().contains("cedar"));
    }
    @Test public void serverCatalogUsesOnlySelectedModelAdvertisedValues() {
        JSONObject listing = NativeVoiceJson.object("object", "list", "data", new JSONArray()
            .put(NativeVoiceJson.object("id", "local-asr", "task", "transcription"))
            .put(NativeVoiceJson.object("id", "local-tts", "task", "speech", "voices", new JSONArray().put(NativeVoiceJson.object("id", "af_heart")),
                "speed", NativeVoiceJson.object("min", 0.5, "max", 2, "default", 1),
                "output_formats", new JSONArray().put(NativeVoiceJson.object("id", "pcm", "encoding", "pcm_s16le")), "extensions", NativeVoiceJson.object("unsupported", true))));
        JSONObject catalog = NativeSpeechCatalog.server(listing, "local-tts");
        assertEquals("[\"local-asr\"]", catalog.optJSONArray("sttModels").toString());
        assertEquals("[\"af_heart\"]", catalog.optJSONArray("voices").toString());
        assertEquals(2, catalog.optJSONObject("speed").optInt("max"));
        assertFalse(catalog.has("extensions"));
        assertEquals(0, NativeSpeechCatalog.server(listing, "other").optJSONArray("voices").length());
    }
    @Test public void malformedMetadataFailsClosedAndMissingDiscoveryClaimsNoCapabilities() {
        assertThrows(IllegalArgumentException.class, () -> NativeSpeechCatalog.openai(NativeVoiceJson.object(), "tts-1"));
        assertThrows(IllegalArgumentException.class, () -> NativeSpeechCatalog.server(NativeVoiceJson.object("data", new JSONArray().put("wrong")), "tts"));
        JSONObject empty = NativeSpeechCatalog.empty("server");
        assertEquals(0, empty.optJSONArray("voices").length()); assertTrue(empty.isNull("speed"));
    }
    @Test public void missingServerCapabilitiesAndRedirectsFailWithoutFallbackOrSecretResponseText() throws Exception {
        for (int status : new int[] { 404, 302, 401 }) {
            BlockingQueue<String> result = new LinkedBlockingQueue<>();
            try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
                server.setSoTimeout(1000);
                NativeVoiceSettings settings = NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("speechProvider", "server",
                    "speechEndpoint", "http://127.0.0.1:" + server.getLocalPort() + "/proxy/v1"));
                NativeSpeechCatalog.fetch(settings, "test-token", (catalog, error) -> result.add(error == null ? "unexpected_success" : error));
                try (Socket socket = server.accept()) {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                    assertEquals("GET /proxy/v1/audio/capabilities HTTP/1.1", reader.readLine());
                    boolean credential = false;
                    for (String line = reader.readLine(); line != null && !line.isEmpty(); line = reader.readLine())
                        if (line.equals("Authorization: Bearer test-token")) credential = true;
                    assertTrue(credential);
                    socket.getOutputStream().write(("HTTP/1.1 " + status + " Error\r\nLocation: /leak\r\nConnection: close\r\nContent-Length: 14\r\n\r\nsecret-details")
                        .getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush();
                }
                assertEquals(status == 401 ? "speech_authentication_failed" : "speech_discovery_unavailable", result.poll(5, TimeUnit.SECONDS));
                assertThrows(java.net.SocketTimeoutException.class, server::accept);
            }
        }
    }

}
