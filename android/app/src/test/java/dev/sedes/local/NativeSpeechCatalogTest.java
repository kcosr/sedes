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
            .put(NativeVoiceJson.object("id", "local-asr", "task", "transcription", "realtime", NativeSpeechCapabilitiesTest.policy()))
            .put(NativeVoiceJson.object("id", "local-tts", "task", "speech", "voices", new JSONArray().put(NativeVoiceJson.object("id", "af_heart")),
                "speed", NativeVoiceJson.object("min", 0.5, "max", 2, "default", 1),
                "output_formats", new JSONArray().put(NativeVoiceJson.object("id", "pcm", "encoding", "pcm_s16le")), "extensions", NativeVoiceJson.object("unsupported", true))));
        JSONObject catalog = NativeSpeechCatalog.server(listing, "local-tts");
        assertEquals("[\"local-asr\"]", catalog.optJSONArray("sttModels").toString());
        assertEquals(5760000, catalog.optJSONObject("realtime").optJSONObject("local-asr").optLong("max_buffer_bytes"));
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
                assertEquals(status == 401 ? "speech_authentication_failed" : status == 404 ? "speech_server_configuration_unsupported" : "speech_discovery_unavailable", result.poll(5, TimeUnit.SECONDS));
                assertThrows(java.net.SocketTimeoutException.class, server::accept);
            }
        }
    }

    @Test public void hostedPreflightUsesExactBuiltInModelWithoutNetworkDiscovery() {
        NativeVoiceSettings settings = NativeVoiceSettings.defaults();
        java.util.List<String> callbacks = new java.util.ArrayList<>();
        assertNull(NativeSpeechCatalog.preflight(settings, "dedicated-token", (caps, error) -> callbacks.add(error == null ? caps.model : error)));
        assertEquals(java.util.List.of("gpt-live-transcribe"), callbacks);
        NativeVoiceSettings unsupported = settings.patch(0, NativeVoiceJson.object("sttModel", "gpt-live-transcribe-2026-10-04"));
        NativeSpeechCatalog.preflight(unsupported, "dedicated-token", (caps, error) -> callbacks.add(error));
        assertEquals("speech_transcription_model_unsupported", callbacks.get(1));
    }

    @Test public void selectedModelSupportDoesNotBorrowAnotherModelsLimits() throws Exception {
        JSONObject small = NativeSpeechCapabilitiesTest.policy(); small.put("max_buffer_bytes", 0);
        JSONObject listing = NativeVoiceJson.object("data", new JSONArray()
            .put(NativeVoiceJson.object("id", "usable", "task", "transcription", "realtime", NativeSpeechCapabilitiesTest.policy()))
            .put(NativeVoiceJson.object("id", "too-small", "task", "transcription", "realtime", small)));
        JSONObject catalog = NativeSpeechCatalog.server(listing, "tts");
        assertEquals(60000, NativeSpeechCatalog.serverCapabilities(catalog, "usable").hardSegmentMs());
        assertEquals(0, catalog.getJSONObject("realtime").getJSONObject("too-small").getLong("max_buffer_bytes"));
        NativeSpeechCatalogCache restored = NativeSpeechCatalogCache.fromRecord(new NativeSpeechCatalogCache("b".repeat(64), 100, catalog).record());
        assertEquals(0, restored.catalog.getJSONObject("realtime").getJSONObject("too-small").getLong("max_buffer_bytes"));
        assertEquals("speech_server_configuration_unsupported", assertThrows(IllegalArgumentException.class,
            () -> NativeSpeechCatalog.serverCapabilities(catalog, "too-small")).getMessage());
        assertEquals("speech_transcription_model_unsupported", assertThrows(IllegalArgumentException.class,
            () -> NativeSpeechCatalog.serverCapabilities(catalog, "absent")).getMessage());
        assertFalse(NativeSpeechCatalog.picker(catalog).has("realtime"));
        JSONObject legacy = NativeVoiceJson.object("data", new JSONArray().put(NativeVoiceJson.object("id", "old", "task", "transcription")));
        assertEquals("speech_server_configuration_unsupported", assertThrows(IllegalArgumentException.class,
            () -> NativeSpeechCatalog.server(legacy, "tts")).getMessage());
    }

    private static JSONObject binaryExtension(int version) {
        return NativeVoiceJson.object("binary_audio_input", NativeVoiceJson.object("versions", new JSONArray().put(version),
            "formats", new JSONArray().put(NativeVoiceJson.object("type", "audio/pcm", "rate", 24000))
                .put(NativeVoiceJson.object("type", "audio/ogg", "codec", "opus"))));
    }
    @Test public void binaryAudioRequiresTheSelectedModelsOptionalVersionedAdvertisement() throws Exception {
        JSONObject listing = NativeVoiceJson.object("data", new JSONArray()
            .put(NativeVoiceJson.object("id", "standard", "task", "transcription", "realtime", NativeSpeechCapabilitiesTest.policy()))
            .put(NativeVoiceJson.object("id", "compressed", "task", "transcription", "realtime", NativeSpeechCapabilitiesTest.policy(),
                "realtime_extensions", binaryExtension(1)))
            .put(NativeVoiceJson.object("id", "future", "task", "transcription", "realtime", NativeSpeechCapabilitiesTest.policy(),
                "realtime_extensions", binaryExtension(2)))
            .put(NativeVoiceJson.object("id", "other-extension", "task", "transcription", "realtime", NativeSpeechCapabilitiesTest.policy(),
                "realtime_extensions", NativeVoiceJson.object("some_other_protocol", true))));
        JSONObject catalog = NativeSpeechCatalog.server(listing, "tts");
        NativeSpeechCapabilities supported = NativeSpeechCatalog.serverCapabilities(catalog, "compressed");
        assertTrue(supported.binaryPcm); assertTrue(supported.binaryOpus);
        for (String id : new String[] { "standard", "future", "other-extension" }) {
            NativeSpeechCapabilities standard = NativeSpeechCatalog.serverCapabilities(catalog, id);
            assertFalse(standard.binaryPcm); assertFalse(standard.binaryOpus);
        }
        JSONObject picker = NativeSpeechCatalog.picker(catalog);
        assertTrue(picker.getJSONObject("audioInputFormats").getJSONObject("compressed").getBoolean("binaryOpus"));
        assertFalse(picker.has("realtime"));
        NativeSpeechCatalogCache restored = NativeSpeechCatalogCache.fromRecord(new NativeSpeechCatalogCache("b".repeat(64), 100, catalog).record());
        assertTrue(NativeSpeechCatalog.serverCapabilities(restored.catalog, "compressed").binaryOpus);
        NativeSpeechCapabilities hosted = NativeSpeechCapabilities.hosted("gpt-live-transcribe");
        assertFalse(hosted.binaryPcm); assertFalse(hosted.binaryOpus);
    }
    @Test public void formatSupportIsExactAndMalformedKnownAdvertisementsFailClosed() throws Exception {
        JSONObject extension = binaryExtension(1);
        extension.getJSONObject("binary_audio_input").put("formats", new JSONArray()
            .put(NativeVoiceJson.object("type", "audio/pcm", "rate", 16000))
            .put(NativeVoiceJson.object("type", "audio/ogg", "codec", "vorbis"))
            .put(NativeVoiceJson.object("type", "audio/future", "encoding", "future")));
        JSONObject model = NativeVoiceJson.object("realtime_extensions", extension);
        JSONObject formats = NativeSpeechCapabilities.audioInputFormats(model);
        assertFalse(formats.getBoolean("binaryPcm")); assertFalse(formats.getBoolean("binaryOpus"));
        for (Object malformed : new Object[] { JSONObject.NULL, true, NativeVoiceJson.object("binary_audio_input", true),
            NativeVoiceJson.object("binary_audio_input", NativeVoiceJson.object("versions", new JSONArray().put("1"))),
            NativeVoiceJson.object("binary_audio_input", NativeVoiceJson.object("versions", new JSONArray().put(1), "formats", new JSONArray().put("opus"))),
            NativeVoiceJson.object("binary_audio_input", NativeVoiceJson.object("versions", new JSONArray().put(1), "formats", new JSONArray().put(NativeVoiceJson.object("type", "audio/ogg")))) })
            assertEquals("speech_server_configuration_unsupported", assertThrows(IllegalArgumentException.class,
                () -> NativeSpeechCapabilities.audioInputFormats(NativeVoiceJson.object("realtime_extensions", malformed))).getMessage());
    }

    @Test public void everyServerPreflightFetchesSelectedModelLimitsAfresh() throws Exception {
        BlockingQueue<String> result = new LinkedBlockingQueue<>();
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            server.setSoTimeout(2000);
            NativeVoiceSettings settings = NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("speechProvider", "server",
                "speechEndpoint", "http://127.0.0.1:" + server.getLocalPort() + "/v1", "sttModel", "selected"));
            for (long buffer : new long[] { 5760000, 240000 }) {
                NativeSpeechCatalog.preflight(settings, "fresh-token", (caps, error) -> result.add(error == null ? caps.hardSegmentMs() + ":" + caps.idleTimeoutMs + ":" + caps.maxSessionMs : error));
                try (Socket socket = server.accept()) {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                    assertEquals("GET /v1/audio/capabilities HTTP/1.1", reader.readLine());
                    boolean authenticated = false;
                    for (String line; (line = reader.readLine()) != null && !line.isEmpty();) authenticated |= line.equals("Authorization: Bearer fresh-token");
                    assertTrue(authenticated);
                    JSONObject limits = NativeSpeechCapabilitiesTest.policy(); limits.put("max_buffer_bytes", buffer);
                    limits.put("idle_timeout_seconds", 40.25); limits.put("max_session_seconds", 600.5);
                    byte[] bytes = NativeVoiceJson.object("object", "list", "data", new JSONArray()
                        .put(NativeVoiceJson.object("id", "selected", "task", "transcription", "realtime", limits))
                        .put(NativeVoiceJson.object("id", "tiny-auxiliary", "task", "transcription", "realtime",
                            NativeVoiceJson.copy(limits).put("max_buffer_bytes", 0)))).toString().getBytes(StandardCharsets.UTF_8);
                    socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    socket.getOutputStream().write(bytes); socket.getOutputStream().flush();
                }
                assertEquals((buffer == 240000 ? "5000" : "60000") + ":40250:600500", result.poll(5, TimeUnit.SECONDS));
            }
        }
    }

}
