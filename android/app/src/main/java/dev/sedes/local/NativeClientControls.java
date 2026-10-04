package dev.sedes.local;

import android.os.Handler;
import okhttp3.Call;
import org.json.JSONArray;
import org.json.JSONObject;

/** Live control transport, independent of the foreground voice service. All owner calls run on its handler. */
final class NativeClientControls {
    interface Owner {
        JSONObject clientState();
        JSONObject clientCommand(JSONObject command);
        void clientRegistered(String clientId, String token);
        void clientDisconnected();
    }
    private final NativeVoiceHttp http;
    private final Handler handler;
    private final Owner owner;
    private long generation;
    private Call call;
    private String origin, credential, csrf;
    NativeClientControls(NativeVoiceHttp http, Handler handler, Owner owner) {
        this.http = http; this.handler = handler; this.owner = owner;
    }
    void connect(String origin, String credential, String csrf, Runnable ready) {
        disconnect(); this.origin = origin; this.credential = credential; this.csrf = csrf;
        register(generation, ready);
    }
    void disconnect() {
        generation++; if (call != null) call.cancel(); call = null;
        http.clientRegistration(null, null, null); owner.clientDisconnected();
    }
    private void register(long expected, Runnable ready) {
        if (expected != generation) return;
        JSONObject body = NativeVoiceJson.object("platform", "android", "capabilities",
            NativeVoiceJson.object("navigate", true, "voice", true, "voiceSettings", true), "state", owner.clientState());
        call = http.request(origin, credential, csrf, "POST", "/api/client-registration", body, (status, value, error) -> handler.post(() -> {
            if (expected != generation) return;
            call = null;
            try {
                if (status != 200 || value == null) throw new IllegalStateException("client_registration_unavailable");
                NativeVoiceJson.keys(value, "clientId", "connectionToken");
                String id = NativeVoiceJson.string(value, "clientId", 128), token = NativeVoiceJson.string(value, "connectionToken", 128);
                http.clientRegistration(origin, credential, token); owner.clientRegistered(id, token);
                if (ready != null) ready.run();
                poll(expected, new JSONArray());
            } catch (Exception failure) {
                owner.clientDisconnected();
                // Authentication/session refresh belongs to the main runtime, never credential fallback here.
                if (status == 401 || status == 403) return;
                handler.postDelayed(() -> register(expected, ready), 5000);
            }
        }));
    }
    private void poll(long expected, JSONArray acknowledgements) {
        if (expected != generation) return;
        call = http.request(origin, credential, csrf, "POST", "/api/client-controls/poll",
            NativeVoiceJson.object("state", owner.clientState(), "acknowledgements", acknowledgements), (status, value, error) -> handler.post(() -> {
                if (expected != generation) return;
                call = null;
                if (status != 200 || value == null) {
                    http.clientRegistration(null, null, null); owner.clientDisconnected();
                    if (status == 401 || status == 403 || status == 409) return;
                    handler.postDelayed(() -> register(expected, null), 5000); return;
                }
                JSONArray next = new JSONArray();
                try {
                    NativeVoiceJson.keys(value, "commands");
                    JSONArray commands = value.getJSONArray("commands");
                    if (commands.length() > 64) throw new IllegalArgumentException("invalid_client_commands");
                    for (int i = 0; i < commands.length(); i++) {
                        JSONObject command = commands.getJSONObject(i);
                        String id = NativeVoiceJson.string(command, "id", 128);
                        next.put(NativeVoiceJson.object("id", id, "result", owner.clientCommand(command)));
                    }
                } catch (Exception failure) {
                    http.clientRegistration(null, null, null); owner.clientDisconnected();
                    handler.postDelayed(() -> register(expected, null), 5000); return;
                }
                poll(expected, next);
            }));
    }
}
