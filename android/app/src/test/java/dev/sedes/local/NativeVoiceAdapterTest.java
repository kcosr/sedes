package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceAdapterTest {
    private static final class Recorder implements NativeVoiceAdapter.Listener {
        final BlockingQueue<String> events = new LinkedBlockingQueue<>();
        public void ready(long generation) { events.add("ready:" + generation); }
        public void event(long generation, JSONObject event) { events.add("event:" + generation + ":" + event.optString("type") + ":" + event.optString("chunkBase64").length()); }
        public void failed(long generation, String code) { events.add("failed:" + generation + ":" + code); }
        String next() throws InterruptedException { String value = events.poll(3, TimeUnit.SECONDS); assertNotNull("No adapter callback", value); return value; }
    }
    /** Minimal RFC 6455 peer for one connection with unfragmented frames. */
    private static final class Peer implements Closeable {
        final ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        Socket socket; DataInputStream in; OutputStream out;
        Peer() throws IOException {}
        String url() { return "http://127.0.0.1:" + server.getLocalPort(); }
        void accept() throws Exception {
            server.setSoTimeout(5000); socket = server.accept(); socket.setSoTimeout(5000);
            in = new DataInputStream(new BufferedInputStream(socket.getInputStream())); out = socket.getOutputStream();
            String key = null;
            for (String line = line(); !line.isEmpty(); line = line())
                if (line.toLowerCase(Locale.ROOT).startsWith("sec-websocket-key:")) key = line.substring(18).trim();
            String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
            out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
                .getBytes(StandardCharsets.US_ASCII));
            out.flush();
        }
        private String line() throws IOException {
            StringBuilder line = new StringBuilder();
            for (int c = in.read(); c != '\n'; c = in.read()) { if (c < 0) throw new EOFException(); if (c != '\r') line.append((char) c); }
            return line.toString();
        }
        void write(int opcode, byte[] payload) throws IOException {
            ByteArrayOutputStream frame = new ByteArrayOutputStream(); frame.write(0x80 | opcode);
            if (payload.length < 126) frame.write(payload.length);
            else if (payload.length < 65536) { frame.write(126); frame.write(payload.length >> 8); frame.write(payload.length); }
            else { frame.write(127); for (int shift = 56; shift >= 0; shift -= 8) frame.write((int) ((long) payload.length >> shift)); }
            frame.write(payload); out.write(frame.toByteArray()); out.flush();
        }
        void text(String value) throws IOException { write(1, value.getBytes(StandardCharsets.UTF_8)); }
        void text(JSONObject value) throws IOException { text(value.toString()); }
        /** Next client frame as opcode followed by unmasked payload. */
        byte[] frame() throws IOException {
            int first = in.readUnsignedByte(), second = in.readUnsignedByte();
            long length = second & 127;
            if (length == 126) length = in.readUnsignedShort(); else if (length == 127) length = in.readLong();
            byte[] mask = new byte[4]; if ((second & 128) != 0) in.readFully(mask);
            byte[] result = new byte[(int) length + 1]; result[0] = (byte) (first & 15); in.readFully(result, 1, (int) length);
            for (int i = 1; i < result.length; i++) result[i] ^= mask[(i - 1) % 4];
            return result;
        }
        JSONObject json() throws Exception {
            byte[] frame = frame(); assertEquals(1, frame[0]);
            return new JSONObject(new String(frame, 1, frame.length - 1, StandardCharsets.UTF_8));
        }
        public void close() throws IOException { if (socket != null) socket.close(); server.close(); }
    }
    private static long handshake(NativeVoiceAdapter adapter, Recorder recorder, Peer peer) throws Exception {
        adapter.connect(peer.url()); long attempt = adapter.generation();
        peer.accept();
        peer.text(NativeVoiceJson.object("type", "client_identity", "clientId", "client-1"));
        JSONObject state = peer.json();
        assertEquals("client_state_update", state.getString("type")); assertFalse(state.getBoolean("turnModeEnabled")); assertTrue(state.getBoolean("directSttEnabled"));
        JSONObject ping = peer.json(); assertEquals("client_ping", ping.getString("type"));
        assertFalse("Identity alone is not the ordering barrier", adapter.ready());
        assertFalse(adapter.send(NativeVoiceJson.object("type", "media_stt_end", "requestId", "early")));
        peer.text(NativeVoiceJson.object("type", "server_pong", "echoedSentAtMs", ping.getLong("sentAtMs") + 1));
        assertNull("An uncorrelated pong completed the handshake", recorder.events.poll(200, TimeUnit.MILLISECONDS));
        assertFalse(adapter.ready());
        peer.text(NativeVoiceJson.object("type", "server_pong", "echoedSentAtMs", ping.getLong("sentAtMs")));
        assertEquals("ready:" + attempt, recorder.next());
        assertTrue(adapter.ready());
        return attempt;
    }
    @Test public void peerCloseIsAnsweredAndReportedOnceWithoutWaitingForPing() throws Exception {
        Recorder recorder = new Recorder(); NativeVoiceAdapter adapter = new NativeVoiceAdapter(recorder);
        try (Peer peer = new Peer()) {
            long attempt = handshake(adapter, recorder, peer);
            assertTrue(adapter.send(NativeVoiceJson.object("type", "media_stt_end", "requestId", "request-1")));
            assertEquals("media_stt_end", peer.json().getString("type"));
            peer.write(8, new byte[] { 0x03, (byte) 0xe9 });
            assertEquals("failed:" + attempt + ":adapter_disconnected", recorder.next());
            byte[] reply = peer.frame(); assertEquals("Peer Close was not answered", 8, reply[0]);
            assertFalse(adapter.ready());
            assertFalse(adapter.send(NativeVoiceJson.object("type", "media_stt_end", "requestId", "request-1")));
            assertNull("Disconnect was reported twice", recorder.events.poll(500, TimeUnit.MILLISECONDS));
        } finally { adapter.close(); }
    }
    /** Answers one HTTP request on the peer's port after the socket handshake and returns its body. */
    private static String respond(Peer peer, int status) throws Exception {
        try (Socket http = peer.server.accept()) {
            http.setSoTimeout(5000);
            DataInputStream in = new DataInputStream(new BufferedInputStream(http.getInputStream()));
            int length = 0; StringBuilder line = new StringBuilder();
            while (true) {
                int c = in.read(); if (c < 0) throw new EOFException();
                if (c == '\r') continue;
                if (c != '\n') { line.append((char) c); continue; }
                if (line.length() == 0) break;
                if (line.toString().toLowerCase(Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                line.setLength(0);
            }
            byte[] body = new byte[length]; in.readFully(body);
            http.getOutputStream().write(("HTTP/1.1 " + status + " Status\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .getBytes(StandardCharsets.US_ASCII));
            http.getOutputStream().flush();
            return new String(body, StandardCharsets.UTF_8);
        }
    }
    @Test public void ttsReportsTheAdapterHttpStatusAndZeroWhenNotSent() throws Exception {
        Recorder recorder = new Recorder(); NativeVoiceAdapter adapter = new NativeVoiceAdapter(recorder);
        BlockingQueue<Integer> statuses = new LinkedBlockingQueue<>();
        try (Peer peer = new Peer()) {
            handshake(adapter, recorder, peer);
            for (int status : new int[] { 400, 202, 409 }) {
                adapter.tts("request-" + status, "Text", statuses::add);
                JSONObject body = new JSONObject(respond(peer, status));
                assertEquals("client-1", body.getString("clientId")); assertEquals("request-" + status, body.getString("requestId"));
                assertEquals(Integer.valueOf(status), statuses.poll(5, TimeUnit.SECONDS));
            }
            adapter.close();
            adapter.tts("after-close", "Text", statuses::add);
            assertEquals("A request on a closed adapter is reported as not sent", Integer.valueOf(0), statuses.poll(1, TimeUnit.SECONDS));
        } finally { adapter.close(); }
    }
    @Test public void largeProviderChunksAreDeliveredAndOnlyMessagesBeyondTheBoundFail() throws Exception {
        Recorder recorder = new Recorder(); NativeVoiceAdapter adapter = new NativeVoiceAdapter(recorder);
        try (Peer peer = new Peer()) {
            long attempt = handshake(adapter, recorder, peer);
            peer.text(NativeVoiceJson.object("type", "media_tts_audio_chunk", "clientId", "other-client", "requestId", "request-1", "chunkBase64", "AAAA"));
            String chunk = "A".repeat(3 * 1024 * 1024);
            peer.text(NativeVoiceJson.object("type", "media_tts_audio_chunk", "clientId", "client-1", "requestId", "request-1", "chunkBase64", chunk));
            assertEquals("event:" + attempt + ":media_tts_audio_chunk:" + chunk.length(), recorder.next());
            peer.text("{\"type\":\"media_tts_audio_chunk\",\"chunkBase64\":\"" + "A".repeat(NativeVoiceAdapter.MAX_MESSAGE_CHARS) + "\"}");
            assertEquals("failed:" + attempt + ":adapter_message_too_large", recorder.next());
            assertFalse(adapter.ready());
            peer.text(NativeVoiceJson.object("type", "media_tts_end", "clientId", "client-1", "requestId", "request-1", "status", "completed"));
            assertNull("A failed connection delivered media", recorder.events.poll(500, TimeUnit.MILLISECONDS));
        } finally { adapter.close(); }
    }
}
