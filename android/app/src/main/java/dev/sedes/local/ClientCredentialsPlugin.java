package dev.sedes.local;

import android.content.Context;
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
            removeProfileCredentials(getContext(), call.getString("profileId"),
                profile -> NativeVoiceRuntime.get(getContext()).profileRemoved(profile));
            call.resolve();
        } catch (Exception error) {
            if (error instanceof VoiceProfileCleanupFailure) call.reject("Saved recordings could not be removed. Retry removing this profile.", "voice_profile_cleanup_failed");
            else call.reject("The credentials could not be removed.", "credential_storage_unavailable");
        }
    }
    interface VoiceProfileCleanup { void remove(String profileId) throws Exception; }
    private static final class VoiceProfileCleanupFailure extends Exception {
        VoiceProfileCleanupFailure(Exception cause) { super("voice_profile_cleanup_failed", cause); }
    }
    static void removeProfileCredentials(Context context, String profileId, VoiceProfileCleanup cleanup) throws Exception {
        // Disconnect fences queued actions; a failed or timed-out recording deletion must reach the caller.
        Exception failure = null;
        try { cleanup.remove(profileId); } catch (Exception error) { failure = new VoiceProfileCleanupFailure(error); }
        // Sedes authentication is removed even when recording cleanup fails. Device-owned speech credentials survive.
        try { new ClientCredentialStore(context).removeProfileCredentials(profileId); }
        catch (Exception error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        if (failure != null) throw failure;
    }
    @PluginMethod public void removeCredential(PluginCall call) {
        try {
            stopVoice(call.getString("profileId"), call.getString("serverUrl"));
            new ClientCredentialStore(getContext()).removeCredential(call.getString("profileId"), call.getString("serverUrl"));
            call.resolve();
        } catch (Exception error) { call.reject("The credential could not be removed.", "credential_storage_unavailable"); }
    }
}
