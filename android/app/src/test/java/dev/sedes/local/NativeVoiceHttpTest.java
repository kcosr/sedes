package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Writer;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPOutputStream;
import okhttp3.Call;
import org.json.JSONObject;
import org.junit.Test;

/** The application stream reports policy and the end of the inventory handshake in server order. */
public class NativeVoiceHttpTest {
    @Test public void liveMarkerFollowsQueuedPolicyAndPrecedesClose() throws Exception {
        assertLiveMarkerBeforeClose(false);
    }

    @Test public void gzipPolicyAndLiveMarkerArriveBeforeStreamCloses() throws Exception {
        assertLiveMarkerBeforeClose(true);
    }

    private void assertLiveMarkerBeforeClose(boolean gzip) throws Exception {
        BlockingQueue<String> events = new LinkedBlockingQueue<>();
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            server.setSoTimeout(5000);
            String origin = "http://127.0.0.1:" + server.getLocalPort();
            String stream = "2f6b360b-d9f1-4311-a239-6bfa129c2bd6";
            NativeVoiceHttp http = new NativeVoiceHttp();
            http.clientRegistration(origin, null, "native-connection");
            Call call = http.events(origin, null, stream, true, 3, new NativeVoiceHttp.Stream() {
                public void live() { events.add("live"); }
                public void frame(String event, JSONObject value) { events.add(event + ":" + value.optLong("generation")); }
                public void closed(String failure) { events.add("closed:" + failure); }
            });
            try (Socket socket = server.accept()) {
                BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                String request = in.readLine(); assertTrue(request, request.startsWith("GET /api/application/events?voiceStreamId=" + stream + "&earlyReply=on&earlyRevision=3 "));
                boolean registered = false;
                boolean acceptsGzip = false;
                for (String line = in.readLine(); line != null && !line.isEmpty(); line = in.readLine()) {
                    if (line.equals("X-Sedes-Client: native-connection")) registered = true;
                    if (line.equalsIgnoreCase("Accept-Encoding: gzip")) acceptsGzip = true;
                }
                assertFalse("Notification streams must survive control registration loss", registered);
                assertTrue("OkHttp negotiates gzip without an application decoder", acceptsGzip);
                OutputStream socketOut = socket.getOutputStream();
                socketOut.write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\n" +
                    (gzip ? "Content-Encoding: gzip\r\n" : "") + "Connection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                // One continuous gzip member, flushed per event, like the server's SSE writer.
                OutputStream out = gzip ? new GZIPOutputStream(socketOut, true) : socketOut;
                out.write("event: application\nid: 1\ndata: {\"type\":\"snapshot\"}\n\n".getBytes(StandardCharsets.UTF_8)); out.flush();
                assertNull("Headers and inventory alone do not end the handshake", events.poll(300, TimeUnit.MILLISECONDS));
                out.write(("event: notification_policy\ndata: {\"generation\":7}\n\nevent: application-live\ndata: {}\n\n: heartbeat\n\n")
                    .getBytes(StandardCharsets.UTF_8)); out.flush();
                assertEquals("notification_policy:7", events.poll(5, TimeUnit.SECONDS));
                assertEquals("live", events.poll(5, TimeUnit.SECONDS));
                out.write("event: notification_policy\ndata: {\"generation\":8}\n\n".getBytes(StandardCharsets.UTF_8)); out.flush();
                assertEquals("notification_policy:8", events.poll(5, TimeUnit.SECONDS));
                assertNull("The response remains live after the flushed events", events.poll());
                if (gzip) ((GZIPOutputStream) out).finish();
            }
            assertEquals("closed:stream_closed", events.poll(5, TimeUnit.SECONDS));
            call.cancel();
        }
    }
    @Test public void interestUpdateUsesTheCurrentSessionAndAuthenticatesTheEmptyResponse() throws Exception {
        BlockingQueue<Integer> status = new LinkedBlockingQueue<>();
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            server.setSoTimeout(5000);
            String origin = "http://127.0.0.1:" + server.getLocalPort();
            NativeVoiceHttp http = new NativeVoiceHttp();
            http.clientRegistration(origin, "test-account", "test-connection");
            http.setEarlyInterest(origin, "test-account", "test-csrf", NativeVoiceEarlyFramesTest.STREAM,
                NativeVoiceEarlyFramesTest.TOKEN, 8, false, (code, value, failure) -> status.add(value == null && failure == null ? code : 0));
            try (Socket socket = server.accept()) {
                BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                assertEquals("PUT /api/application/voice-streams/" + NativeVoiceEarlyFramesTest.STREAM +
                    "/early-reply HTTP/1.1", input.readLine());
                java.util.Map<String, String> headers = new java.util.TreeMap<>(String.CASE_INSENSITIVE_ORDER);
                for (String line; !(line = input.readLine()).isEmpty();) {
                    int colon = line.indexOf(':');
                    headers.put(line.substring(0, colon), line.substring(colon + 1).trim());
                }
                assertEquals("Bearer test-account", headers.get("Authorization"));
                assertEquals("test-csrf", headers.get("X-CSRF-Token"));
                assertEquals("test-connection", headers.get("X-Sedes-Client"));
                char[] body = new char[Integer.parseInt(headers.get("Content-Length"))];
                int offset = 0;
                while (offset < body.length) {
                    int count = input.read(body, offset, body.length - offset); assertTrue(count > 0); offset += count;
                }
                JSONObject payload = new JSONObject(new String(body));
                assertEquals(3, payload.length());
                assertEquals(NativeVoiceEarlyFramesTest.TOKEN, payload.getString("token"));
                assertEquals(8, payload.getInt("revision")); assertFalse(payload.getBoolean("enabled"));
                socket.getOutputStream().write("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            }
            assertEquals(Integer.valueOf(204), status.poll(5, TimeUnit.SECONDS));
        }
    }

    @Test public void earlyFramesReachTheSubscriberInOrderAndInvalidFramesEndTheStreamOnce() throws Exception {
        BlockingQueue<String> delivered = new LinkedBlockingQueue<>();
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            server.setSoTimeout(5000);
            String stream = NativeVoiceEarlyFramesTest.STREAM;
            new NativeVoiceHttp().events("http://127.0.0.1:" + server.getLocalPort(), null, stream, false, 77, new NativeVoiceHttp.Stream() {
                public void live() { delivered.add("live"); }
                public void frame(String event, JSONObject frame) { delivered.add(event); }
                public void closed(String failure) { delivered.add(failure); }
            });
            try (Socket socket = server.accept()) {
                BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                assertEquals("GET /api/application/events?voiceStreamId=" + stream + "&earlyReply=off&earlyRevision=77 HTTP/1.1", in.readLine());
                while (!in.readLine().isEmpty()) {}
                JSONObject session = NativeVoiceJson.object("voiceStreamId", stream, "revision", 77, "token", NativeVoiceEarlyFramesTest.TOKEN);
                try (Writer out = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8)) {
                    out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                    out.write("event: voice_early_session\ndata: " + session + "\n\nevent: application-live\ndata: {}\n\n");
                    out.write("event: voice_early_reply\ndata: " + NativeVoiceEarlyFramesTest.begin() + "\n\n");
                    out.write("event: voice_early_reply\ndata: {}\n\nevent: notification_policy\ndata: {}\n\n"); out.flush();
                }
            }
            assertEquals(NativeVoiceSse.EARLY_SESSION, delivered.poll(5, TimeUnit.SECONDS));
            assertEquals("live", delivered.poll(5, TimeUnit.SECONDS));
            assertEquals(NativeVoiceSse.EARLY_REPLY, delivered.poll(5, TimeUnit.SECONDS));
            assertEquals("invalid_notification_frame", delivered.poll(5, TimeUnit.SECONDS));
            assertTrue(delivered.isEmpty());
        }
    }
}
