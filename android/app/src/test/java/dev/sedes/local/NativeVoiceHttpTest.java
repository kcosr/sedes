package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
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
            Call call = http.events(origin, null, stream, new NativeVoiceHttp.Stream() {
                public void live() { events.add("live"); }
                public void frame(String event, JSONObject value) { events.add(event + ":" + value.optLong("generation")); }
                public void closed(String failure) { events.add("closed:" + failure); }
            });
            try (Socket socket = server.accept()) {
                BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                String request = in.readLine(); assertTrue(request, request.startsWith("GET /api/application/events?voiceStreamId=" + stream + " "));
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
}
