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
    private final ConcurrentHashMap<String, Long> permissionGenerations = new ConcurrentHashMap<>();
    private final NativeVoiceRuntime.Observer observer = (event, value) -> {
        try { notifyListeners(event, new JSObject(value.toString()), event.equals("openThread")); }
        catch (Exception ignored) {}
    };
    @Override public void load() { runtime = NativeVoiceRuntime.get(getContext()); runtime.observe(observer); }
    // MainActivity owns resume/pause/stop visibility; the permission callback below is the only other visibility source.
    @Override protected void handleOnDestroy() { permissionGenerations.clear(); runtime.nativeVisibility(false); runtime.unobserve(observer); }
    @PluginMethod public void setConnection(PluginCall call) { run("setConnection", call, false); }
    @PluginMethod public void disconnect(PluginCall call) { run("disconnect", call, false); }
    @PluginMethod public void getState(PluginCall call) { run("getState", call, false); }
    @PluginMethod public void listInputDevices(PluginCall call) { run("listInputDevices", call, false); }
    @PluginMethod public void setForegroundContext(PluginCall call) { run("setForegroundContext", call, false); }
    @PluginMethod public void retargetActiveRecognition(PluginCall call) { run("retargetActiveRecognition", call, false); }
    @PluginMethod public void skipCurrentPlayback(PluginCall call) { run("skipCurrentPlayback", call, false); }
    @PluginMethod public void stopCurrentInteraction(PluginCall call) { run("stopCurrentInteraction", call, false); }
    @PluginMethod public void resumeInput(PluginCall call) { run("resumeInput", call, true); }
    @PluginMethod public void discardInput(PluginCall call) { run("discardInput", call, true); }
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
            run("updateSettings", call, true); return;
        }
        run("updateSettings", call, false);
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
