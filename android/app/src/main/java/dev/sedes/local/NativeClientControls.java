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
        String clientCsrf();
        void refreshClientSession(Runnable ready, Runnable retry);
        void clientAuthenticationLost();
        void clientReplaced();
    }
    private final NativeVoiceHttp http;
    private final Handler handler;
    private final Owner owner;
    private long generation;
    private Call call;
    private String origin, credential, resumeToken;
    private boolean replaced;
    NativeClientControls(NativeVoiceHttp http, Handler handler, Owner owner) {
        this.http = http; this.handler = handler; this.owner = owner;
    }
    void connect(String origin, String credential) {
        disconnect(); this.origin = origin; this.credential = credential;
        register(generation);
    }
    void disconnect() {
        generation++; if (call != null) call.cancel(); call = null;
        resumeToken = null; replaced = false;
        http.clientRegistration(null, null, null); owner.clientDisconnected();
    }
    /** A view reattachment speeds up retry; only an explicit user retry may reclaim another window's client. */
    void reconnect(boolean takeover) {
        if (origin == null || replaced && !takeover) return;
        if (replaced) resumeToken = null;
        replaced = false;
        generation++; if (call != null) call.cancel(); call = null;
        http.clientRegistration(null, null, null); owner.clientDisconnected();
        final long expected = generation;
        owner.refreshClientSession(() -> register(expected), () -> retry(expected, 0));
    }
    private void retry(long expected, int status) {
        if (expected != generation) return;
        http.clientRegistration(null, null, null); owner.clientDisconnected();
        if (status == 401) { owner.clientAuthenticationLost(); return; }
        if (status == 409) { replaced = true; owner.clientReplaced(); return; }
        if (status == 404) resumeToken = null;
        handler.postDelayed(() -> {
            if (expected != generation) return;
            owner.refreshClientSession(() -> register(expected), () -> retry(expected, 0));
        }, 5000);
    }
    private void register(long expected) {
        if (expected != generation) return;
        JSONObject body = NativeVoiceJson.object("platform", "android", "capabilities",
            NativeVoiceJson.object("navigate", true, "voice", true, "voiceSettings", true), "state", owner.clientState());
        if (resumeToken != null) NativeVoiceJson.put(body, "resumeToken", resumeToken);
        call = http.request(origin, credential, owner.clientCsrf(), "POST", "/api/client-registration", body, (status, value, error) -> handler.post(() -> {
            if (expected != generation) return;
            call = null;
            try {
                if (status != 200 || value == null) throw new IllegalStateException("client_registration_unavailable");
                NativeVoiceJson.keys(value, "clientId", "connectionToken", "resumeToken");
                String id = NativeVoiceJson.string(value, "clientId", 128), token = NativeVoiceJson.string(value, "connectionToken", 128);
                resumeToken = NativeVoiceJson.string(value, "resumeToken", 128);
                http.clientRegistration(origin, credential, token); owner.clientRegistered(id, token);
                poll(expected, new JSONArray());
            } catch (Exception failure) {
                retry(expected, status);
            }
        }));
    }
    private void poll(long expected, JSONArray acknowledgements) {
        if (expected != generation) return;
        call = http.request(origin, credential, owner.clientCsrf(), "POST", "/api/client-controls/poll",
            NativeVoiceJson.object("state", owner.clientState(), "acknowledgements", acknowledgements), (status, value, error) -> handler.post(() -> {
                if (expected != generation) return;
                call = null;
                if (status != 200 || value == null) {
                    retry(expected, status); return;
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
                    retry(expected, 0); return;
                }
                poll(expected, next);
            }));
    }
}
