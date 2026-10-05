package dev.sedes.local;

import android.Manifest;
import android.app.Activity;
import android.os.Build;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONObject;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "NativeVoice", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public final class NativeVoicePlugin extends Plugin {
    private NativeVoiceRuntime runtime;
    private NativeSpeechCredentialDialog credentialDialog;
    private final ConcurrentHashMap<String, Long> permissionGenerations = new ConcurrentHashMap<>();
    private final NativeVoiceRuntime.Observer observer = (event, value) -> {
        try { notifyListeners(event, new JSObject(value.toString()), event.equals("openThread")); }
        catch (Exception ignored) {}
    };
    @Override public void load() { runtime = NativeVoiceRuntime.get(getContext()); runtime.observe(observer); }
    // MainActivity owns lifecycle visibility; explicit enable/Resume and permission results reconcile their current Activity.
    @Override protected void handleOnDestroy() { permissionGenerations.clear(); if (credentialDialog != null) { credentialDialog.dismiss(); credentialDialog = null; } runtime.nativeVisibility(false); runtime.unobserve(observer); }
    @PluginMethod public void setConnection(PluginCall call) { run("setConnection", call, false); }
    @PluginMethod public void disconnect(PluginCall call) { run("disconnect", call, false); }
    @PluginMethod public void getState(PluginCall call) { run("getState", call, false); }
    @PluginMethod public void listInputDevices(PluginCall call) { run("listInputDevices", call, false); }
    @PluginMethod public void setForegroundContext(PluginCall call) { run("setForegroundContext", call, false); }
    @PluginMethod public void retargetActiveRecognition(PluginCall call) { run("retargetActiveRecognition", call, false); }
    @PluginMethod public void setKeepListening(PluginCall call) { run("setKeepListening", call, false); }
    @PluginMethod public void sendRecording(PluginCall call) { run("sendRecording", call, false); }
    @PluginMethod public void retryRecordingRecognition(PluginCall call) { run("retryRecordingRecognition", call, true); }
    @PluginMethod public void sendRecoveredRecording(PluginCall call) { run("sendRecoveredRecording", call, true); }
    @PluginMethod public void copyRecognizedRecordingText(PluginCall call) { run("copyRecognizedRecordingText", call, true); }
    @PluginMethod public void discardRecording(PluginCall call) { run("discardRecording", call, true); }
    @PluginMethod public void skipCurrentPlayback(PluginCall call) { run("skipCurrentPlayback", call, false); }
    @PluginMethod public void stopCurrentInteraction(PluginCall call) { run("stopCurrentInteraction", call, false); }
    @PluginMethod public void resumeInput(PluginCall call) { run("resumeInput", call, true); }
    @PluginMethod public void discardInput(PluginCall call) { run("discardInput", call, true); }
    @PluginMethod public void refreshSpeechCatalog(PluginCall call) { run("refreshSpeechCatalog", call, false); }
    @PluginMethod public void openSpeechCredentialDialog(PluginCall call) {
        final long generation;
        try {
            NativeVoiceJson.keys(call.getData(), "expectedConnectionGeneration");
            generation = expectedGeneration(call.getData());
        } catch (IllegalArgumentException error) { rejectInvalidGeneration(call); return; }
        getActivity().runOnUiThread(() -> {
            JSONObject current = runtime.snapshot();
            if (generation != current.optLong("connectionGeneration") || current.isNull("identity")) {
                call.reject("The Sedes connection changed before the voice action arrived.", "connection_changed"); return;
            }
            if (credentialDialog != null) { call.reject("Close the open credential dialog first.", "credential_dialog_open"); return; }
            final long revision = current.optLong("settingsRevision");
            JSONObject settings = current.optJSONObject("settings"), speech = current.optJSONObject("speech");
            credentialDialog = new NativeSpeechCredentialDialog(getActivity(), settings.optString("speechProvider"),
                settings.optString("speechEndpoint"), speech != null && speech.optBoolean("credentialConfigured"),
                (action, secret, reply) -> runtime.speechCredentialAction(generation, revision, action, secret, reply), () -> {
                    credentialDialog = null;
                    JSONObject latest = runtime.snapshot();
                    if (generation != latest.optLong("connectionGeneration")) {
                        call.reject("The Sedes connection changed while editing credentials.", "connection_changed"); return;
                    }
                    try { call.resolve(new JSObject(latest.toString())); }
                    catch (Exception error) { call.reject("Voice returned an invalid state.", "voice_state_invalid"); }
                });
            credentialDialog.show();
        });
    }
    @PluginMethod public void updateSettings(PluginCall call) {
        final long generation;
        try {
            generation = expectedGeneration(call.getData());
            if (generation != runtime.snapshot().optLong("connectionGeneration")) {
                call.reject("The Sedes connection changed before the voice action arrived.", "connection_changed"); return;
            }
        } catch (IllegalArgumentException error) { rejectInvalidGeneration(call); return; }
        JSONObject patch = call.getObject("patch");
        if (patch != null && patch.has("audioMode") && !patch.optString("audioMode").equals("off")) {
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                permissionGenerations.put(call.getCallbackId(), generation);
                if (Build.VERSION.SDK_INT >= 33) requestPermissionForAliases(new String[] { "microphone", "notifications" }, call, "voicePermission");
                else requestPermissionForAlias("microphone", call, "voicePermission");
                return;
            }
            if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) {
                permissionGenerations.put(call.getCallbackId(), generation);
                requestPermissionForAlias("notifications", call, "voicePermission"); return;
            }
            runVisibleSettings(call); return;
        }
        run("updateSettings", call, false);
    }
    /** Existing grants skip the permission callback, so ordinary enable/Resume must refresh activity visibility too. */
    private void runVisibleSettings(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("Resume voice from the visible app.", "resume_from_visible_app"); return; }
        activity.runOnUiThread(() -> {
            final long generation;
            try { generation = expectedGeneration(call.getData()); }
            catch (IllegalArgumentException error) { rejectInvalidGeneration(call); return; }
            if (!reconcileUserActionVisibility(activity, runtime, generation)) {
                call.reject("The Sedes connection changed before the voice action arrived.", "connection_changed"); return;
            }
            run("updateSettings", call, true);
        });
    }
    /** Called on main immediately before dispatch; a subsequent pause still clears the volatile native gate. */
    static boolean reconcileUserActionVisibility(Activity activity, NativeVoiceRuntime runtime, long generation) {
        if (generation != runtime.snapshot().optLong("connectionGeneration")) return false;
        boolean visible = activity instanceof LifecycleOwner && !activity.isFinishing() && !activity.isDestroyed() &&
            ((LifecycleOwner) activity).getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
        runtime.nativeVisibility(visible);
        return true;
    }
    @PermissionCallback private void voicePermission(PluginCall call) {
        Long generation = permissionGenerations.remove(call.getCallbackId());
        if (generation == null || generation != runtime.snapshot().optLong("connectionGeneration")) {
            call.reject("The Sedes connection changed while requesting permission.", "connection_changed"); return;
        }
        markVisibleForPermissionResult(getActivity(), runtime);
        // Persist the selected mode even when permission is denied; readiness explains the required action.
        run("updateSettings", call, true);
    }
    @PluginMethod public void startManualListen(PluginCall call) { run("startManualListen", call, true); }
    /**
     * Android delivers permission results before onResume, while the activity is already visible (at least STARTED).
     * Marking it visible synchronously keeps the user-initiated enable from being queued ahead of the resume notification.
     */
    static void markVisibleForPermissionResult(Activity activity, NativeVoiceRuntime runtime) {
        if (visibleForPermissionResult(activity)) runtime.nativeVisibility(true);
    }
    static boolean visibleForPermissionResult(Activity activity) {
        return activity instanceof LifecycleOwner && !activity.isFinishing() &&
            ((LifecycleOwner) activity).getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED);
    }
    private static long expectedGeneration(JSONObject data) {
        return NativeVoiceJson.integer(data, "expectedConnectionGeneration", 0, 9007199254740991L);
    }
    private static void rejectInvalidGeneration(PluginCall call) {
        call.reject("Voice actions require a valid expected connection generation.", "invalid_expectedConnectionGeneration");
    }
    private void run(String action, PluginCall call, boolean userInitiated) {
        JSONObject args = NativeVoiceJson.copy(call.getData());
        final long generation;
        if (action.equals("setConnection") || action.equals("getState") || action.equals("listInputDevices")) generation = 0;
        else {
            try { generation = expectedGeneration(args); }
            catch (IllegalArgumentException error) { rejectInvalidGeneration(call); return; }
            args.remove("expectedConnectionGeneration");
        }
        runtime.command(action, args, userInitiated, generation, new NativeVoiceRuntime.Reply() {
            public void done(JSONObject value) { try { call.resolve(new JSObject(value.toString())); } catch (Exception error) { call.reject("Voice returned an invalid state.", "voice_state_invalid"); } }
            public void failed(String code, String message) { call.reject(message, code); }
        });
    }
}
