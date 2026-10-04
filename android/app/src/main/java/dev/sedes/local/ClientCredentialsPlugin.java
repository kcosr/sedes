package dev.sedes.local;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

@CapacitorPlugin(name = "ClientCredentials")
public final class ClientCredentialsPlugin extends Plugin {
    /** Disconnects voice from the old credential first when possible; the credential change itself always proceeds. */
    private void stopVoice(String profileId, String serverUrl) {
        try { NativeVoiceRuntime.get(getContext()).credentialChanging(profileId, serverUrl); } catch (Exception ignored) {}
    }
    @PluginMethod public void getCredential(PluginCall call) {
        try {
            String credential = new ClientCredentialStore(getContext()).getCredential(call.getString("profileId"), call.getString("serverUrl"));
            JSObject result = new JSObject();
            result.put("credential", credential == null ? JSONObject.NULL : credential);
            call.resolve(result);
        } catch (Exception error) { call.reject("Secure credential storage is unavailable.", "credential_storage_unavailable"); }
    }
    @PluginMethod public void setCredential(PluginCall call) {
        try {
            stopVoice(call.getString("profileId"), call.getString("serverUrl"));
            new ClientCredentialStore(getContext()).setCredential(call.getString("profileId"), call.getString("serverUrl"), call.getString("credential"));
            call.resolve();
        } catch (Exception error) { call.reject("The credential could not be saved securely.", "credential_storage_unavailable"); }
    }
    @PluginMethod public void removeProfileCredentials(PluginCall call) {
        try {
            // Removing a profile also deletes its native voice settings, origin IDs and input journals. Voice cleanup is
            // best-effort: it runs on the voice owner thread, which completes it later after a timeout, and never keeps the credential.
            try { NativeVoiceRuntime.get(getContext()).profileRemoved(call.getString("profileId")); } catch (Exception ignored) {}
            new ClientCredentialStore(getContext()).removeProfileCredentials(call.getString("profileId"));
            call.resolve();
        } catch (Exception error) { call.reject("The credentials could not be removed.", "credential_storage_unavailable"); }
    }
    @PluginMethod public void removeCredential(PluginCall call) {
        try {
            stopVoice(call.getString("profileId"), call.getString("serverUrl"));
            new ClientCredentialStore(getContext()).removeCredential(call.getString("profileId"), call.getString("serverUrl"));
            call.resolve();
        } catch (Exception error) { call.reject("The credential could not be removed.", "credential_storage_unavailable"); }
    }
}
