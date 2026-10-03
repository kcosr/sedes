package dev.sedes.local;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/** Sedes-only authenticated HTTP. Redirects cannot carry a device credential elsewhere. */
final class NativeVoiceHttp {
    interface Result { void done(int status, JSONObject value, String failure); }
    interface Stream { void frame(String event, JSONObject value); void closed(String failure); }
    interface TestTransport {
        boolean before(String method, String path, JSONObject body, Result result);
        boolean after(String method, String path, JSONObject body, int status, JSONObject response, Result result);
    }
    private static volatile TestTransport testTransport;
    static void setTestTransport(TestTransport transport) {
        if (!BuildConfig.DEBUG) throw new IllegalStateException("test_transport_unavailable");
        testTransport = transport;
    }
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private final OkHttpClient client = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(45, TimeUnit.SECONDS).build();
    private final OkHttpClient streams = client.newBuilder().readTimeout(0, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build();
    Call request(String origin, String credential, String csrf, String method, String path, JSONObject body, Result result) {
        if (!path.startsWith("/api/")) throw new IllegalArgumentException("voice_api_path_invalid");
        Request.Builder builder = new Request.Builder().url(NativeVoiceSettings.origin(origin) + path).header("Accept", "application/json");
        if (credential != null) builder.header("Authorization", "Bearer " + credential);
        if (csrf != null) builder.header("X-CSRF-Token", csrf);
        if (!method.equals("GET")) builder.method(method, RequestBody.create(body == null ? "{}" : body.toString(), JSON));
        Call call = client.newCall(builder.build());
        TestTransport fixture = BuildConfig.DEBUG ? testTransport : null;
        if (fixture != null && fixture.before(method, path, body, result)) return call;
        call.enqueue(new Callback() {
            public void onFailure(Call call, IOException error) { result.done(0, null, "network_unavailable"); }
            public void onResponse(Call call, Response response) {
                try (Response closed = response) {
                    if (response.body() == null) { result.done(response.code(), null, "empty_response"); return; }
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    InputStream input = response.body().byteStream();
                    byte[] buffer = new byte[4096]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (bytes.size() + count > 1024 * 1024) throw new IOException("response_too_large");
                        bytes.write(buffer, 0, count);
                    }
                    String text = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
                    JSONObject value = new JSONObject(text);
                    if (fixture == null || !fixture.after(method, path, body, response.code(), value, result)) result.done(response.code(), value, null);
                } catch (Exception error) { result.done(response.code(), null, "invalid_response"); }
            }
        });
        return call;
    }
    Call events(String origin, String credential, Stream listener) {
        Request.Builder builder = new Request.Builder().url(NativeVoiceSettings.origin(origin) + "/api/application/events")
            .header("Accept", "text/event-stream").header("Cache-Control", "no-cache");
        if (credential != null) builder.header("Authorization", "Bearer " + credential);
        Call call = streams.newCall(builder.build());
        call.enqueue(new Callback() {
            public void onFailure(Call call, IOException error) { listener.closed("stream_unavailable"); }
            public void onResponse(Call call, Response response) {
                try (Response closed = response) {
                    if (!response.isSuccessful() || response.body() == null) { listener.closed(response.code() == 401 ? "unauthorized" : "stream_rejected"); return; }
                    String type = response.header("Content-Type", "");
                    if (!type.startsWith("text/event-stream")) throw new IOException("invalid_stream_type");
                    NativeVoiceSse parser = new NativeVoiceSse((event, data) -> {
                        try { listener.frame(event, new JSONObject(data)); }
                        catch (Exception error) { listener.closed("invalid_notification_frame"); call.cancel(); }
                    });
                    try (Reader input = new InputStreamReader(response.body().byteStream(), StandardCharsets.UTF_8)) {
                        char[] chars = new char[4096]; int count;
                        while ((count = input.read(chars)) != -1) parser.accept(chars, count);
                    }
                    listener.closed("stream_closed");
                } catch (Exception error) { listener.closed("stream_unavailable"); }
            }
        });
        return call;
    }
}
