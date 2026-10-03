package dev.sedes.local;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import org.json.JSONArray;
import org.json.JSONObject;

/** Single native owner of settings, transient voice work and durable input recovery. */
final class NativeVoiceRuntime implements NativeVoiceAdapter.Listener, NativeVoiceAudio.Listener {
    interface Reply { void done(JSONObject value); void failed(String code, String message); }
    interface Observer { void event(String name, JSONObject value); }
    private static NativeVoiceRuntime instance;
    static synchronized NativeVoiceRuntime get(Context context) {
        if (instance == null) instance = new NativeVoiceRuntime(context.getApplicationContext());
        return instance;
    }
    private final Context context;
    private final Handler handler, main = new Handler(Looper.getMainLooper());
    private final NativeVoiceStore store;
    private final NativeVoiceHttp http = new NativeVoiceHttp();
    private final NativeVoiceAdapter adapter;
    private final NativeVoiceAudio audio;
    private final NativeVoiceQueue queue = new NativeVoiceQueue();
    private final CopyOnWriteArrayList<Observer> observers = new CopyOnWriteArrayList<>();
    private final ArrayDeque<JSONObject> errors = new ArrayDeque<>();
    private final Map<String, Call> admissions = new HashMap<>();
    private final Set<String> cancelledAdmissions = new HashSet<>();
    private NativeVoiceSettings settings = NativeVoiceSettings.defaults();
    private String profileId, origin, identity, binding, credential, csrf, originId;
    private String phase = "off", foregroundThread, foregroundTitle, composerMode = "queue";
    private boolean foregroundVisible, nativeVisible, sessionStarted, policyKnown;
    private long connectionGeneration, stateRevision, policyGeneration = -1, streamGeneration;
    private JSONObject policy;
    private NativeVoiceRuntimeService service;
    private Call stream;
    private Active active;
    private String pendingOpenThread, pendingOpenProfile, pendingOpenOrigin, pendingOpenIdentity;
    private volatile JSONObject state;
    private static final class Active {
        final String id, event, noticeThread, noticeTitle;
        String targetId, targetTitle, ttsId, sttId, cueId;
        boolean automatic, followUp, waitingAfterSkip, stopped;
        final NativeVoiceQueue.Item notification;
        final List<String> chunks;
        int chunk;
        JSONObject admission;
        Active(NativeVoiceQueue.Item item, int limit) {
            id = item.id; event = item.event; noticeThread = item.threadId; noticeTitle = item.threadTitle;
            targetId = item.targetId(); targetTitle = targetId != null && targetId.equals(item.threadId) ? item.threadTitle : null;
            automatic = true; followUp = item.followUp; notification = item;
            chunks = NativeVoiceQueue.chunks(item.speech, limit);
        }
        Active(String threadId, String title) {
            id = UUID.randomUUID().toString(); event = "manual"; noticeThread = threadId; noticeTitle = title;
            targetId = threadId; targetTitle = title; notification = null; chunks = new ArrayList<>();
        }
    }
    private NativeVoiceRuntime(Context context) {
        this.context = context; store = new NativeVoiceStore(context);
        HandlerThread thread = new HandlerThread("sedes-native-voice"); thread.start(); handler = new Handler(thread.getLooper());
        adapter = new NativeVoiceAdapter(this); audio = new NativeVoiceAudio(context, this);
        publish();
    }
    JSONObject snapshot() { return NativeVoiceJson.copy(state); }
    void observe(Observer observer) { observers.add(observer); handler.post(this::deliverPendingOpen); }
    void unobserve(Observer observer) { observers.remove(observer); }
    void nativeVisibility(boolean visible) {
        handler.post(() -> { nativeVisible = visible; if (!visible) { foregroundVisible = false; foregroundThread = null; foregroundTitle = null; publish(); } });
    }
    void command(String action, JSONObject args, boolean userInitiated, Reply reply) {
        command(action, args, userInitiated, state.optLong("connectionGeneration"), reply);
    }
    void command(String action, JSONObject args, boolean userInitiated, long expectedConnectionGeneration, Reply reply) {
        handler.post(() -> {
            try {
                if (!action.equals("setConnection") && !action.equals("getState") && !action.equals("listInputDevices") &&
                    expectedConnectionGeneration != connectionGeneration) throw new IllegalStateException("connection_changed");
                switch (action) {
                    case "setConnection": setConnection(args, reply); return;
                    case "disconnect": NativeVoiceJson.keys(args); disconnect(true); break;
                    case "updateSettings": updateSettings(args, userInitiated); break;
                    case "setForegroundContext": foreground(args); break;
                    case "startManualListen": manual(args); break;
                    case "retargetActiveRecognition": retarget(args); break;
                    case "skipCurrentPlayback": NativeVoiceJson.keys(args); skip(); break;
                    case "stopCurrentInteraction": NativeVoiceJson.keys(args); cancelActive(true, "stopped"); drain(); break;
                    case "resumeInput": NativeVoiceJson.keys(args, "mutationId"); resumeInput(NativeVoiceJson.string(args, "mutationId", 160)); break;
                    case "listInputDevices": NativeVoiceJson.keys(args); reply.done(NativeVoiceJson.object("devices", audio.devices(), "selectedId", settings.text("inputDeviceId"))); return;
                    case "getState": NativeVoiceJson.keys(args); reply.done(snapshot()); return;
                    default: throw new IllegalArgumentException("unknown_voice_action");
                }
                publish(); reply.done(snapshot());
            } catch (Exception error) {
                String code = error.getMessage() == null ? "voice_action_failed" : error.getMessage();
                publish();
                reply.failed(code, message(code));
            }
        });
    }
    private void setConnection(JSONObject args, Reply reply) throws Exception {
        NativeVoiceJson.keys(args, "profileId", "serverOrigin", "identity");
        String nextProfile = NativeVoiceJson.string(args, "profileId", 160);
        String nextOrigin = NativeVoiceSettings.origin(NativeVoiceJson.string(args, "serverOrigin", 2048));
        String expectedIdentity = NativeVoiceJson.string(args, "identity", 64);
        if (!expectedIdentity.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("voice_identity_invalid");
        if (nextProfile.equals(profileId) && nextOrigin.equals(origin) && expectedIdentity.equals(identity) && binding != null && csrf != null) { reply.done(snapshot()); return; }
        disconnect(true);
        profileId = nextProfile; origin = nextOrigin; phase = "starting";
        final long generation = connectionGeneration;
        credential = new ClientCredentialStore(context).getCredential(profileId, origin);
        publish();
        http.request(origin, credential, null, "GET", "/api/auth/status", null, (status, value, failure) -> handler.post(() -> {
            if (generation != connectionGeneration) { reply.failed("connection_changed", message("connection_changed")); return; }
            try {
                if (status != 200 || value == null || (value.optBoolean("required", true) && !value.optBoolean("authenticated")))
                    throw new IllegalStateException("authentication_required");
                String authenticatedIdentity = NativeVoiceJson.string(value, "navigationNamespace", 64);
                if (!authenticatedIdentity.equals(expectedIdentity)) {
                    phase = "error"; report("connection_identity_changed");
                    reply.failed("connection_identity_changed", message("connection_identity_changed")); return;
                }
                identity = authenticatedIdentity;
                binding = NativeVoiceStore.binding(profileId, origin, identity);
                settings = store.settings(binding); originId = store.originId(binding); audio.configure(settings);
                loadSession(generation, () -> { phase = "off"; publish(); recoverOutstanding(); reply.done(snapshot()); deliverPendingOpen(); },
                    code -> {
                        if (generation == connectionGeneration) { binding = null; identity = null; originId = null; csrf = null; phase = "error"; report(code); }
                        reply.failed(code, message(code));
                    });
            } catch (Exception error) { binding = null; phase = "error"; report("authentication_required"); reply.failed("authentication_required", message("authentication_required")); }
        }));
    }
    interface Failure { void fail(String code); }
    private boolean authenticationLost(int status, long generation) {
        if (status != 401) return false;
        if (generation == connectionGeneration) { disconnect(true); report("authentication_required"); }
        return true;
    }
    private void loadSession(long generation, Runnable done, Failure fail) {
        http.request(origin, credential, null, "GET", "/api/application/session", null, (status, value, failure) -> handler.post(() -> {
            if (generation != connectionGeneration) { fail.fail("connection_changed"); return; }
            if (authenticationLost(status, generation)) { fail.fail("authentication_required"); return; }
            if (status != 200 || value == null) { fail.fail("session_unavailable"); return; }
            if (value.optInt("clientProtocolVersion", -1) != BuildConfig.SEDES_CLIENT_PROTOCOL_VERSION) { fail.fail("client_protocol_mismatch"); return; }
            csrf = value.optString("csrfToken", "");
            if (csrf.isEmpty()) { fail.fail("session_unavailable"); return; }
            done.run();
        }));
    }
    private void disconnect(boolean cancelIntended) {
        if (cancelIntended) cancelOutstanding();
        cancelActive(cancelIntended, "connection_changed");
        queue.reset(); connectionGeneration++; stateRevision = 0;
        errors.clear();
        stopSession(); binding = null; identity = null; originId = null; csrf = null; credential = null;
        profileId = null; origin = null; settings = NativeVoiceSettings.defaults(); phase = "off";
        policyGeneration = -1;
        foregroundVisible = false; foregroundThread = null; foregroundTitle = null;
        publish();
    }
    private void updateSettings(JSONObject args, boolean userInitiated) throws Exception {
        NativeVoiceJson.keys(args, "expectedRevision", "patch");
        if (binding == null) throw new IllegalStateException("authentication_required");
        NativeVoiceSettings previous = settings;
        NativeVoiceSettings next = settings.patch(NativeVoiceJson.integer(args, "expectedRevision", 0, Long.MAX_VALUE), NativeVoiceJson.requiredObject(args, "patch"));
        store.settings(binding, next); settings = next; audio.configure(next);
        if (!next.active()) {
            cancelOutstanding(); cancelActive(true, "voice_off"); queue.clear("voice_off"); stopSession(); phase = "off";
        } else {
            if (!next.flag("autoListen")) { queue.cancelFollowups(); if (active != null) active.followUp = false; }
            if (!previous.mode().equals(next.mode()) && active != null && active.automatic && active.admission == null)
                cancelActive(true, "audio_mode_changed");
            queue.reconfigure(next);
            if (!next.flag("autoListen") && active != null && active.automatic && !phase.equals("submitting") &&
                (phase.equals("validating") || phase.equals("arming") || phase.equals("listening") || phase.equals("recognizing"))) cancelActive(true, "auto_listen_disabled");
            if (active != null && active.automatic && active.notification != null && !eligible(active.notification)) cancelActive(true, "voice_filter_changed");
            if (!previous.text("adapterUrl").equals(next.text("adapterUrl"))) { cancelActive(true, "adapter_changed"); adapter.close(); if (sessionStarted) connectAdapter(); }
            if (!sessionStarted && userInitiated) requestSessionStart();
        }
        publish(); emit("settingsChanged", snapshot()); drain();
    }
    private void requestSessionStart() {
        if (!nativeVisible) throw new IllegalStateException("resume_from_visible_app");
        if (!audio.hasPermission()) throw new IllegalStateException("microphone_permission_required");
        if (settings.text("adapterUrl").isEmpty()) throw new IllegalStateException("adapter_required");
        phase = "starting";
        final long generation = connectionGeneration;
        main.post(() -> {
            if (snapshot().optLong("connectionGeneration") != generation) return;
            try { ContextCompat.startForegroundService(context, new Intent(context, NativeVoiceRuntimeService.class).setAction(NativeVoiceRuntimeService.ACTION_START)
                .putExtra("voiceGeneration", generation)); }
            catch (Exception error) { handler.post(() -> { if (generation == connectionGeneration) { phase = "error"; report("foreground_start_rejected"); } }); }
        });
    }
    void attached(NativeVoiceRuntimeService service, long generation) {
        handler.post(() -> {
            if (generation != connectionGeneration) { main.post(service::finish); return; }
            this.service = service;
            if (binding == null || !settings.active() || !audio.hasPermission()) { stopSession(); publish(); return; }
            sessionStarted = true; phase = "starting"; connectAdapter(); connectEvents(); publish();
        });
    }
    void startFailed(long generation) { handler.post(() -> { if (generation == connectionGeneration) { sessionStarted = false; phase = "error"; report("foreground_start_rejected"); } }); }
    void detached(NativeVoiceRuntimeService service) {
        handler.post(() -> { if (this.service == service) { this.service = null; sessionStarted = false; cancelActive(false, "service_stopped"); adapter.close(); closeEvents(); phase = "off"; publish(); } });
    }
    private void stopSession() {
        sessionStarted = false; adapter.close(); audio.stop(); closeEvents();
        NativeVoiceRuntimeService old = service; service = null;
        if (old != null) main.post(old::finish);
    }
    private void foreground(JSONObject args) {
        NativeVoiceJson.keys(args, "visible", "threadId", "threadTitle", "composerMode");
        foregroundVisible = NativeVoiceJson.bool(args, "visible") && nativeVisible;
        foregroundThread = foregroundVisible ? NativeVoiceJson.nullableString(args, "threadId", 512) : null;
        foregroundTitle = foregroundVisible ? NativeVoiceJson.nullableString(args, "threadTitle", 512) : null;
        if (args.has("composerMode")) {
            String mode = NativeVoiceJson.string(args, "composerMode", 16);
            if (!mode.equals("queue") && !mode.equals("steer")) throw new IllegalArgumentException("invalid_composerMode");
            composerMode = mode;
        }
    }
    private void connectAdapter() {
        if (!sessionStarted || settings.text("adapterUrl").isEmpty()) return;
        adapter.connect(settings.text("adapterUrl"));
        long generation = adapter.generation();
        handler.postDelayed(() -> { if (sessionStarted && generation == adapter.generation() && !adapter.ready()) failed(generation, "adapter_handshake_timeout"); }, 20000);
    }
    private void connectEvents() {
        if (!sessionStarted || binding == null) return;
        closeEvents(); final long generation = ++streamGeneration;
        stream = http.events(origin, credential, new NativeVoiceHttp.Stream() {
            public void frame(String event, JSONObject value) { handler.post(() -> { if (generation == streamGeneration && sessionStarted) receive(event, value); }); }
            public void closed(String code) { handler.post(() -> {
                if (generation != streamGeneration || !sessionStarted) return;
                stream = null; policyKnown = false; policy = null; streamGeneration++;
                cancelAutomatic("notification_connection_lost");
                if (code.equals("unauthorized")) { disconnect(true); report("authentication_required"); return; }
                publish(); final long current = streamGeneration;
                handler.postDelayed(() -> { if (current == streamGeneration && sessionStarted) connectEvents(); }, 2000);
            }); }
        });
    }
    private void closeEvents() { streamGeneration++; if (stream != null) stream.cancel(); stream = null; policyKnown = false; policy = null; }
    private void receive(String event, JSONObject value) {
        try {
            if (event.equals("notification_policy")) {
                NativeVoiceJson.keys(value, "generation", "settings");
                long generation = NativeVoiceJson.integer(value, "generation", 0, Long.MAX_VALUE);
                if (generation < policyGeneration) return;
                JSONObject next = NativeVoiceJson.requiredObject(value, "settings");
                NativeVoiceProtocol.validatePolicy(next);
                if (!policyKnown || generation != policyGeneration) cancelAutomatic("notification_policy_changed");
                policy = NativeVoiceJson.copy(next); policyGeneration = generation; policyKnown = true; publish(); return;
            }
            NativeVoiceQueue.Item item = new NativeVoiceQueue.Item(value, settings);
            if (active != null && active.id.equals(item.id)) return;
            if (!eligible(item) || (item.speech.isEmpty() && !item.followUp)) { if (queue.remember(item.id)) queue.drop("ineligible"); publish(); return; }
            queue.add(item); publish(); drain();
        } catch (Exception error) {
            if (event.equals("notification_policy")) { policyKnown = false; policy = null; cancelAutomatic("invalid_notification_policy"); }
            report("invalid_notification_frame");
        }
    }
    private boolean eligible(NativeVoiceQueue.Item item) {
        if (!sessionStarted || !settings.active() || !policyKnown || policy == null || !policy.optBoolean("enabled") ||
            policy.optBoolean("silenced") || item.policyGeneration != policyGeneration) return false;
        if (settings.flag("ignoreOtherDevices") && item.event.startsWith("turn.") && item.origin != null && !item.origin.equals(originId)) return false;
        if (settings.flag("onlyVoiceThread")) {
            String pinned = settings.text("voiceThreadId");
            String target = item.targetId() == null ? item.threadId : item.targetId();
            if (pinned == null || !pinned.equals(target)) return false;
        }
        return true;
    }
    private void cancelAutomatic(String reason) {
        queue.clear(reason);
        if (active != null && active.automatic) cancelActive(true, reason);
    }
    private void drain() {
        if (active != null || !sessionStarted || !adapter.ready() || binding == null) return;
        NativeVoiceQueue.Item item;
        while ((item = queue.take()) != null) {
            if (!eligible(item)) { queue.drop("ineligible"); continue; }
            active = new Active(item, settings.number("adapterTextLimit"));
            if (active.chunks.isEmpty()) afterSpeech(active); else speakChunk(active);
            publish(); return;
        }
        phase = "idle"; publish();
    }
    private void speakChunk(Active item) {
        if (active != item || item.stopped) return;
        if (item.chunk >= item.chunks.size()) { afterSpeech(item); return; }
        if (!adapter.ready()) { failActive("adapter_disconnected"); return; }
        item.ttsId = UUID.randomUUID().toString(); String request = item.ttsId;
        phase = "synthesizing"; audio.begin(request); publish();
        adapter.tts(request, item.chunks.get(item.chunk), accepted -> handler.post(() -> {
            if (active != item || !request.equals(item.ttsId)) return;
            if (!accepted) failActive("speech_request_rejected");
        }));
        handler.postDelayed(() -> { if (active == item && request.equals(item.ttsId)) failActive("speech_timeout"); }, NativeVoiceAudio.MAX_STREAM_DURATION_MS + 60000);
    }
    private void afterSpeech(Active item) {
        if (active != item || item.stopped) return;
        item.ttsId = null;
        if (!item.followUp || !settings.flag("autoListen") || item.notification == null || !eligible(item.notification) ||
            (settings.mode().equals("manual") && !item.event.equals("turn.completed"))) { finishItem(item); return; }
        validateTarget(item, true);
    }
    private void validateTarget(Active item, boolean automatic) {
        validateTarget(item, automatic, true);
    }
    private void validateTarget(Active item, boolean automatic, boolean playCue) {
        phase = "validating"; publish();
        long generation = connectionGeneration;
        http.request(origin, credential, null, "GET", "/api/threads/" + Uri.encode(item.targetId) + "/input-context", null,
            (status, value, failure) -> handler.post(() -> {
                if (active != item || item.stopped || generation != connectionGeneration) return;
                if (authenticationLost(status, generation)) return;
                if (status != 200 || value == null || !item.targetId.equals(value.optString("threadId"))) { failActive("target_unavailable"); return; }
                try { NativeVoiceProtocol.inputContext(value); }
                catch (IllegalArgumentException error) { failActive("invalid_input_context"); return; }
                if (automatic) {
                    JSONObject target = item.notification.target;
                    if (!eligible(item.notification) || !settings.flag("autoListen") || !value.optBoolean("automaticListenEligible") ||
                        !value.optString("authority").equals("current") || !target.optString("activityToken").equals(value.optString("activityToken")) ||
                        (target.has("sourceTurnId") && !target.optString("sourceTurnId").equals(value.optString("sourceTurnId")))) { finishItem(item); return; }
                }
                if (playCue) arm(item); else beginCapture(item);
            }));
    }
    private void arm(Active item) {
        if (active != item || !sessionStarted || !adapter.ready() || !audio.hasPermission()) { failActive("voice_not_ready"); return; }
        if (item.automatic && (!settings.flag("autoListen") || !eligible(item.notification))) { finishItem(item); return; }
        phase = "arming"; item.cueId = UUID.randomUUID().toString(); publish();
        String cue = item.cueId;
        handler.postDelayed(() -> { if (active == item && cue.equals(item.cueId)) failActive("recognition_cue_timeout"); }, 15000);
        if (settings.flag("recognitionCues")) audio.cue(item.cueId, settings.number("cueGain")); else capture(item);
    }
    private void capture(Active item) {
        if (active != item || item.stopped || !sessionStarted || !adapter.ready()) return;
        if (item.automatic && (!settings.flag("autoListen") || !eligible(item.notification))) { finishItem(item); return; }
        item.cueId = null;
        // The cue is asynchronous. A newer server activity epoch during it must prevent recording.
        if (item.automatic) validateTarget(item, true, false); else beginCapture(item);
    }
    private void beginCapture(Active item) {
        if (active != item || item.stopped || !sessionStarted || !adapter.ready()) return;
        if (item.automatic && (!settings.flag("autoListen") || !eligible(item.notification))) { finishItem(item); return; }
        item.sttId = UUID.randomUUID().toString(); phase = "arming";
        audio.record(item.sttId, settings.text("inputDeviceId")); publish();
        String id = item.sttId;
        handler.postDelayed(() -> { if (active == item && id.equals(item.sttId) && (phase.equals("arming") || phase.equals("listening"))) failActive("recognition_capture_timeout"); },
            (long) settings.number("recognitionStartTimeoutMs") + settings.number("recognitionCompletionTimeoutMs") + 5000);
    }
    private void manual(JSONObject args) {
        NativeVoiceJson.keys(args, "threadId", "threadTitle");
        if (!sessionStarted || !adapter.ready() || binding == null) throw new IllegalStateException("voice_not_ready");
        if (active != null) throw new IllegalStateException("voice_busy");
        String target = NativeVoiceJson.nullableString(args, "threadId", 512), title = NativeVoiceJson.nullableString(args, "threadTitle", 512);
        if (target == null && foregroundVisible) { target = foregroundThread; title = foregroundTitle; }
        if (target == null) { target = settings.text("voiceThreadId"); title = settings.text("voiceThreadTitle"); }
        if (target == null) throw new IllegalStateException("voice_target_required");
        active = new Active(target, title); validateTarget(active, false);
    }
    private void retarget(JSONObject args) {
        NativeVoiceJson.keys(args, "threadId", "threadTitle");
        if (active == null || !phase.equals("listening")) throw new IllegalStateException("voice_not_listening");
        active.targetId = NativeVoiceJson.string(args, "threadId", 512); active.targetTitle = NativeVoiceJson.nullableString(args, "threadTitle", 512);
        active.automatic = false;
    }
    private void skip() {
        if (active == null || !(phase.equals("speaking") || phase.equals("synthesizing"))) throw new IllegalStateException("voice_not_speaking");
        Active item = active; audio.stop(); item.chunk = item.chunks.size(); item.waitingAfterSkip = true; phase = "cancelling";
        if (item.ttsId != null) adapter.stopTts(item.ttsId);
        item.ttsId = null;
        // A new socket guarantees release of the old per-client slot, including provider cleanup races.
        connectAdapter(); publish();
    }
    private void cancelActive(boolean cancelAdmission, String reason) {
        Active old = active; if (old == null) return;
        if (old.notification != null) queue.completed(old.id);
        old.stopped = true; active = null; audio.stop();
        if (old.admission != null && cancelAdmission) cancelEntry(binding, old.admission.optString("mutationId"));
        if (old.ttsId != null) { adapter.stopTts(old.ttsId); if (sessionStarted) connectAdapter(); }
        if (old.sttId != null) { adapter.cancelStt(old.sttId); if (sessionStarted) connectAdapter(); }
        phase = sessionStarted ? "idle" : "off";
        publish();
    }
    private void finishItem(Active item) { if (active == item) { if (item.notification != null) queue.completed(item.id); active = null; audio.stop(); phase = sessionStarted ? "idle" : "off"; publish(); drain(); } }
    private void failActive(String code) { cancelActive(false, code); report(code); drain(); }
    public void ready(long generation) { handler.post(() -> {
        if (generation != adapter.generation() || !sessionStarted) return;
        if (active != null && active.waitingAfterSkip) { active.waitingAfterSkip = false; afterSpeech(active); }
        else drain(); publish();
    }); }
    public void failed(long generation, String code) { handler.post(() -> {
        if (generation != adapter.generation() || !sessionStarted) return;
        adapter.close();
        if (active == null || active.admission == null) cancelActive(false, code);
        else { audio.stop(); phase = "recovering"; }
        report(code);
        long current = adapter.generation(); handler.postDelayed(() -> { if (sessionStarted && adapter.generation() == current) connectAdapter(); }, 2000);
    }); }
    public void event(long generation, JSONObject event) { handler.post(() -> {
        if (generation != adapter.generation() || active == null) return;
        Active item = active; String type = event.optString("type"), request = event.optString("requestId");
        if (request.equals(item.ttsId)) {
            if (type.equals("media_tts_audio_chunk")) {
                if (!event.optString("encoding").equals("pcm_s16le")) { failActive("unsupported_pcm_encoding"); return; }
                try { audio.pcm(request, event.optInt("sampleRate"), Base64.decode(event.optString("chunkBase64"), Base64.DEFAULT)); phase = "speaking"; publish(); }
                catch (Exception error) { failActive("invalid_pcm"); }
            } else if (type.equals("media_tts_end")) {
                if (event.optString("status").equals("completed")) audio.end(request); else failActive("speech_failed");
            }
        } else if (request.equals(item.sttId)) {
            if (type.equals("media_stt_stopped") || type.equals("media_stt_started")) {
                audio.stop(); phase = "recognizing"; publish();
                String currentRequest = item.sttId;
                handler.postDelayed(() -> { if (active == item && currentRequest.equals(item.sttId)) failActive("recognition_result_timeout"); }, settings.number("recognitionCompletionTimeoutMs"));
            }
            else if (type.equals("media_stt_result")) {
                audio.stop(); item.sttId = null;
                if (!event.optBoolean("success")) { failActive("recognition_failed"); return; }
                finalizeRecognition(item, event.optString("text", ""));
            }
        }
    }); }
    public void drained(String requestId) { handler.post(() -> {
        if (active == null) return;
        if (requestId.equals(active.cueId)) capture(active);
        else if (requestId.equals(active.ttsId)) { active.ttsId = null; active.chunk++; speakChunk(active); }
    }); }
    public void captureStarted(String requestId) { handler.post(() -> {
        if (active == null || !requestId.equals(active.sttId)) return;
        boolean sent = adapter.send(NativeVoiceJson.object("type", "media_stt_start", "requestId", requestId, "sampleRate", 16000,
            "channels", 1, "encoding", "pcm_s16le", "startTimeoutMs", settings.number("recognitionStartTimeoutMs"),
            "completionTimeoutMs", settings.number("recognitionCompletionTimeoutMs"), "endSilenceMs", settings.number("recognitionEndSilenceMs")));
        if (!sent) { failActive("adapter_disconnected"); return; }
        phase = "listening"; publish();
        Active item = active;
        handler.postDelayed(() -> { if (active == item && requestId.equals(item.sttId)) failActive("recognition_timeout"); },
            (long) settings.number("recognitionStartTimeoutMs") + settings.number("recognitionCompletionTimeoutMs") * 2 + 10000);
    }); }
    public void captured(String requestId, byte[] pcm) { handler.post(() -> {
        if (active == null || !requestId.equals(active.sttId) || !phase.equals("listening")) return;
        if (!adapter.send(NativeVoiceJson.object("type", "media_stt_chunk", "requestId", requestId,
            "chunkBase64", Base64.encodeToString(pcm, Base64.NO_WRAP)))) failActive("recognition_transport_overflow");
    }); }
    public void captureEnded(String requestId) { handler.post(() -> {
        if (active == null || !requestId.equals(active.sttId) || !phase.equals("listening")) return;
        adapter.send(NativeVoiceJson.object("type", "media_stt_end", "requestId", requestId)); phase = "recognizing"; publish();
    }); }
    public void failed(String requestId, String reason) { handler.post(() -> {
        if (active != null && (requestId.equals(active.ttsId) || requestId.equals(active.sttId) || requestId.equals(active.cueId))) failActive(reason);
    }); }
    private void finalizeRecognition(Active item, String text) {
        if (active != item) return;
        if (text.trim().isEmpty() || (settings.flag("recognizeStopCommand") && NativeVoiceQueue.isStopCommand(text))) { finishItem(item); return; }
        if (NativeVoiceJson.bytes(text) > 65536) { failActive("recognized_text_too_large"); return; }
        final String target = item.targetId, frozenText = text, frozenOrigin = originId;
        final boolean steer = settings.flag("followComposerMode") && composerMode.equals("steer");
        final long generation = connectionGeneration;
        phase = "submitting"; publish();
        if (!steer) { prepareAdmission(item, target, frozenText, frozenOrigin, NativeVoiceJson.object("mode", "queue")); return; }
        http.request(origin, credential, null, "GET", "/api/threads/" + Uri.encode(target) + "/input-context", null,
            (status, value, failure) -> handler.post(() -> {
                if (active != item || generation != connectionGeneration) return;
                if (authenticationLost(status, generation)) return;
                if (status != 200 || value == null || !target.equals(value.optString("threadId"))) { failActive("target_unavailable"); return; }
                try { NativeVoiceProtocol.inputContext(value); }
                catch (IllegalArgumentException error) { failActive("invalid_input_context"); return; }
                JSONObject policy = NativeVoiceJson.object("mode", "queue");
                JSONObject targetSteer = value.optJSONObject("steer");
                if (targetSteer != null && targetSteer.optString("availability").equals("available") && targetSteer.optJSONObject("target") != null)
                    policy = NativeVoiceJson.object("mode", "steer", "target", targetSteer.optJSONObject("target"), "onUnavailable", "queue");
                prepareAdmission(item, target, frozenText, frozenOrigin, policy);
            }));
    }
    private void prepareAdmission(Active item, String target, String text, String originId, JSONObject policy) {
        if (active != item || binding == null) return;
        String id = UUID.randomUUID().toString();
        JSONObject request = NativeVoiceJson.object("mutationId", id, "text", text, "origin", NativeVoiceJson.object("clientId", originId), "runningPolicy", policy);
        JSONObject entry = NativeVoiceJson.object("mutationId", id, "threadId", target, "request", request, "stage", "prepared", "cancelled", false, "createdAt", System.currentTimeMillis());
        try { store.saveEntry(binding, entry); item.admission = entry; submit(binding, origin, credential, entry, false); }
        catch (Exception error) { failActive("voice_storage_unavailable"); }
    }
    private JSONObject entry(String binding, String id) throws Exception {
        JSONArray entries = store.journal(binding);
        for (int i = 0; i < entries.length(); i++) { JSONObject value = entries.getJSONObject(i); if (id.equals(value.optString("mutationId"))) return value; }
        return null;
    }
    private void submit(String ownerBinding, String ownerOrigin, String ownerCredential, JSONObject entry, boolean refreshed) {
        String id = entry.optString("mutationId"), key = ownerBinding + "\n" + id;
        final long generation = connectionGeneration;
        try {
            JSONObject current = entry(ownerBinding, id);
            if (current == null || current.optBoolean("cancelled") || cancelledAdmissions.contains(key) || admissions.containsKey(key)) return;
            NativeVoiceJson.put(current, "stage", "possiblySubmitted"); store.saveEntry(ownerBinding, current);
            Call call = http.request(ownerOrigin, ownerCredential, csrf, "POST", "/api/threads/" + Uri.encode(current.optString("threadId")) + "/inputs",
                current.optJSONObject("request"), (status, value, failure) -> handler.post(() -> {
                    admissions.remove(key);
                    if (authenticationLost(status, generation)) return;
                    try {
                        JSONObject remaining = entry(ownerBinding, id); if (remaining == null) return;
                        if (status >= 200 && status < 300 && receiptMatches(value, remaining)) { accepted(ownerBinding, id, value); return; }
                        JSONObject error = value == null ? null : value.optJSONObject("error");
                        if (!refreshed && status == 403 && error != null && error.optString("code").equals("csrf_token_invalid") &&
                            generation == connectionGeneration && ownerBinding.equals(binding) && !remaining.optBoolean("cancelled") && !cancelledAdmissions.contains(key)) {
                            loadSession(connectionGeneration, () -> submit(ownerBinding, ownerOrigin, ownerCredential, remaining, true), code -> uncertain(ownerBinding, id));
                            return;
                        }
                        String diagnostic = null;
                        if (status >= 400 && status < 500 && error != null && error.opt("message") instanceof String)
                            diagnostic = error.optString("message").substring(0, Math.min(500, error.optString("message").length()));
                        if (generation == connectionGeneration && ownerBinding.equals(binding)) reconcile(remaining, false, diagnostic);
                        else uncertain(ownerBinding, id);
                    } catch (Exception error) { report("voice_storage_unavailable"); }
                }));
            admissions.put(key, call); publish();
        } catch (Exception error) { report("voice_storage_unavailable"); }
    }
    private boolean receiptMatches(JSONObject receipt, JSONObject entry) {
        if (receipt == null) return false;
        try { NativeVoiceProtocol.receipt(receipt); }
        catch (IllegalArgumentException error) { return false; }
        return entry.optString("mutationId").equals(receipt.optString("mutationId")) && entry.optString("threadId").equals(receipt.optString("threadId"));
    }
    private void accepted(String ownerBinding, String id, JSONObject receipt) throws Exception {
        store.removeEntry(ownerBinding, id);
        cancelledAdmissions.remove(ownerBinding + "\n" + id);
        if (ownerBinding.equals(binding)) {
            if (active != null && active.admission != null && id.equals(active.admission.optString("mutationId"))) finishItem(active);
            else publish();
            String status = receipt.optString("status");
            if (status.equals("failed") || status.equals("recovery_required") || status.equals("cancelled"))
                report("input_" + status, receipt.has("diagnostic") ? receipt.optString("diagnostic") : null);
        }
    }
    private void uncertain(String ownerBinding, String id) {
        uncertain(ownerBinding, id, null);
    }
    private void uncertain(String ownerBinding, String id, String diagnostic) {
        if (ownerBinding.equals(binding)) {
            if (active != null && active.admission != null && id.equals(active.admission.optString("mutationId"))) phase = "recovering";
            report("input_outcome_uncertain", diagnostic == null ? null : "Input delivery is uncertain. Server response: " + diagnostic);
        }
    }
    private void cancelEntry(String ownerBinding, String id) {
        if (ownerBinding == null) return;
        cancelledAdmissions.add(ownerBinding + "\n" + id);
        try {
            JSONObject current = entry(ownerBinding, id); if (current == null) return;
            if (current.optString("stage").equals("prepared")) store.removeEntry(ownerBinding, id);
            else {
                NativeVoiceJson.put(current, "cancelled", true); store.saveEntry(ownerBinding, current);
                if (ownerBinding.equals(binding)) reconcile(current, false);
            }
        } catch (Exception error) { report("voice_storage_unavailable"); }
    }
    private void cancelOutstanding() {
        if (binding == null) return;
        try { JSONArray entries = store.journal(binding); for (int i = 0; i < entries.length(); i++) cancelEntry(binding, entries.getJSONObject(i).optString("mutationId")); }
        catch (Exception error) { report("voice_storage_unavailable"); }
    }
    private void recoverOutstanding() {
        if (binding == null) return;
        try {
            JSONArray entries = store.journal(binding);
            for (int i = 0; i < entries.length(); i++) reconcile(entries.getJSONObject(i), false);
        } catch (Exception error) { report("voice_storage_unavailable"); }
    }
    private void reconcile(JSONObject entry, boolean allowSubmit) {
        reconcile(entry, allowSubmit, null);
    }
    private void reconcile(JSONObject entry, boolean allowSubmit, String diagnostic) {
        final String ownerBinding = binding, ownerOrigin = origin, ownerCredential = credential, id = entry.optString("mutationId");
        final long generation = connectionGeneration;
        http.request(ownerOrigin, ownerCredential, null, "GET", "/api/input-receipts/" + Uri.encode(id), null,
            (status, value, failure) -> handler.post(() -> {
                if (authenticationLost(status, generation)) return;
                try {
                    JSONObject current = entry(ownerBinding, id); if (current == null) return;
                    if (status == 200 && value != null) {
                        try { NativeVoiceProtocol.receiptLookup(value); }
                        catch (IllegalArgumentException error) { uncertain(ownerBinding, id, diagnostic); return; }
                    }
                    if (status == 200 && value != null && value.optString("status").equals("found") && receiptMatches(value.optJSONObject("receipt"), current)) {
                        accepted(ownerBinding, id, value.optJSONObject("receipt")); return;
                    }
                    if (allowSubmit && generation == connectionGeneration && status == 200 && value != null && value.optString("status").equals("notObserved") && !current.optBoolean("cancelled") && ownerBinding.equals(binding))
                        submit(ownerBinding, ownerOrigin, ownerCredential, current, false);
                    else uncertain(ownerBinding, id, diagnostic);
                } catch (Exception error) { report("voice_storage_unavailable"); }
            }));
    }
    private void resumeInput(String id) throws Exception {
        if (binding == null) throw new IllegalStateException("authentication_required");
        JSONObject current = entry(binding, id);
        if (current == null) throw new IllegalStateException("input_recovery_not_found");
        NativeVoiceJson.put(current, "cancelled", false); store.saveEntry(binding, current);
        cancelledAdmissions.remove(binding + "\n" + id); reconcile(current, true);
    }
    void notificationAction(String action) {
        notificationAction(action, state.optLong("connectionGeneration"));
    }
    void notificationAction(String action, long expectedGeneration) {
        handler.post(() -> {
            try {
                if (!sessionStarted || expectedGeneration != connectionGeneration) return;
                switch (action) {
                    case "start": manual(new JSONObject()); break;
                    case "stop": cancelActive(true, "stopped"); drain(); break;
                    case "skip": skip(); break;
                    case "mode": updateSettings(NativeVoiceJson.object("expectedRevision", settings.revision,
                        "patch", NativeVoiceJson.object("audioMode", settings.mode().equals("manual") ? "response" : "manual")), false); break;
                    case "rearm": updateSettings(NativeVoiceJson.object("expectedRevision", settings.revision,
                        "patch", NativeVoiceJson.object("autoListen", !settings.flag("autoListen"))), false); break;
                    case "headset":
                        if (!settings.flag("headsetControls")) return;
                        if (active == null) manual(new JSONObject());
                        else if (phase.equals("speaking") || phase.equals("synthesizing")) skip();
                        else { cancelActive(true, "headset_stop"); drain(); }
                        break;
                    case "headset_stop":
                        if (!settings.flag("headsetControls")) return;
                        cancelActive(true, "headset_stop"); drain(); break;
                    case "headset_skip":
                        if (!settings.flag("headsetControls")) return;
                        skip(); break;
                }
                publish();
            } catch (Exception error) { report(error.getMessage() == null ? "voice_action_failed" : error.getMessage()); }
        });
    }
    void openThread(String threadId, String profileId, String serverOrigin, String expectedIdentity) {
        handler.post(() -> { pendingOpenThread = threadId; pendingOpenProfile = profileId; pendingOpenOrigin = serverOrigin; pendingOpenIdentity = expectedIdentity; deliverPendingOpen(); });
    }
    private void deliverPendingOpen() {
        if (pendingOpenProfile != null && pendingOpenProfile.equals(profileId) && pendingOpenOrigin != null && pendingOpenOrigin.equals(origin) &&
            pendingOpenIdentity != null && pendingOpenIdentity.equals(identity) && pendingOpenThread != null && !observers.isEmpty() && binding != null) {
            emit("openThread", NativeVoiceJson.object("threadId", pendingOpenThread, "profileId", pendingOpenProfile,
                "serverOrigin", pendingOpenOrigin, "identity", pendingOpenIdentity, "connectionGeneration", connectionGeneration));
            pendingOpenThread = null; pendingOpenProfile = null; pendingOpenOrigin = null; pendingOpenIdentity = null;
        }
    }
    void credentialChanging(String profile, String serverOrigin) throws Exception {
        if (profile == null || !profile.matches("[A-Za-z0-9._:-]{1,160}")) throw new IllegalArgumentException("credential_profile_invalid");
        final String normalizedOrigin = serverOrigin == null ? null : NativeVoiceSettings.origin(serverOrigin);
        CountDownLatch done = new CountDownLatch(1);
        handler.post(() -> {
            try { if (profile.equals(profileId) && (normalizedOrigin == null || normalizedOrigin.equals(origin))) disconnect(true); }
            finally { done.countDown(); }
        });
        if (!done.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("voice_disconnect_timeout");
    }
    private JSONArray recoveryState() {
        JSONArray result = new JSONArray();
        if (binding == null) return result;
        try {
            JSONArray entries = store.journal(binding);
            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.getJSONObject(i);
                String id = entry.optString("mutationId");
                result.put(NativeVoiceJson.object("mutationId", id, "threadId", entry.optString("threadId"),
                    "status", admissions.containsKey(binding + "\n" + id) ? "possiblySubmitted" : "uncertain",
                    "cancelled", entry.optBoolean("cancelled") || cancelledAdmissions.contains(binding + "\n" + id)));
            }
        } catch (Exception ignored) {}
        return result;
    }
    private String readiness() {
        if (profileId == null) return "disconnected";
        if (binding == null || csrf == null) return phase.equals("error") ? "error" : "connecting";
        if (!settings.active()) return "off";
        if (!audio.hasPermission()) return "permissionRequired";
        if (settings.text("adapterUrl").isEmpty()) return "adapterRequired";
        if (!sessionStarted) return "needsResume";
        return adapter.ready() ? "ready" : "adapterConnecting";
    }
    private void publish() {
        JSONObject current = active == null ? null : NativeVoiceJson.object("id", active.id, "eventKind", active.event,
            "threadId", active.noticeThread, "threadTitle", active.noticeTitle, "recognitionThreadId", active.targetId,
            "recognitionThreadTitle", active.targetTitle, "automatic", active.automatic);
        boolean ready = readiness().equals("ready");
        state = NativeVoiceJson.object("version", 1, "connectionGeneration", connectionGeneration, "stateRevision", ++stateRevision,
            "profileId", profileId, "serverOrigin", origin, "identity", identity, "originClientId", originId,
            "settingsRevision", settings.revision, "settings", settings.value, "phase", phase, "ready", ready,
            "readiness", readiness(), "foreground", NativeVoiceJson.object("visible", foregroundVisible, "threadId", foregroundThread, "threadTitle", foregroundTitle),
            "active", current, "queue", queue.state(), "actions", NativeVoiceJson.object("canStart", ready && active == null,
                "canStop", active != null, "canSkip", active != null && (phase.equals("speaking") || phase.equals("synthesizing")),
                "canRetarget", active != null && phase.equals("listening"), "canResume", binding != null && settings.active() && !sessionStarted),
            "recovery", recoveryState(), "errors", NativeVoiceJson.array(errors));
        emit("stateChanged", snapshot());
        NativeVoiceRuntimeService currentService = service;
        if (currentService != null) { JSONObject snapshot = snapshot(); main.post(() -> currentService.render(snapshot)); }
    }
    private void emit(String name, JSONObject value) { main.post(() -> { for (Observer observer : observers) observer.event(name, value); }); }
    private void report(String code) {
        report(code, null);
    }
    private void report(String code, String diagnostic) {
        String detail = diagnostic == null || diagnostic.trim().isEmpty() ? message(code) : diagnostic;
        JSONObject error = NativeVoiceJson.object("code", code, "message", detail);
        errors.addLast(error); while (errors.size() > 8) errors.removeFirst(); publish();
        emit("runtimeError", NativeVoiceJson.object("code", code, "message", detail, "connectionGeneration", connectionGeneration,
            "profileId", profileId, "serverOrigin", origin, "identity", identity));
    }
    private static String message(String code) {
        switch (code) {
            case "voice_target_required": return "Choose a thread for voice input.";
            case "voice_busy": return "Stop the current voice interaction before recording.";
            case "authentication_required": return "Pair this Sedes connection before using voice.";
            case "connection_identity_changed": return "The Sedes identity changed. Refresh the connection before using voice.";
            case "settings_revision_conflict": return "Voice settings changed. Refresh and try again.";
            case "microphone_permission_required": return "Allow microphone access from the visible app.";
            case "adapter_required": return "Set the voice adapter URL before enabling voice.";
            case "client_protocol_mismatch": return "Update Sedes and this Android app to matching versions.";
            case "input_outcome_uncertain": return "Input delivery is uncertain. Reconcile the existing input before trying again.";
            case "input_failed": return "Sedes received the input but could not deliver it to the agent.";
            case "input_recovery_required": return "Sedes received the input, but its delivery requires recovery in the thread.";
            case "input_cancelled": return "The received input was cancelled in Sedes.";
            case "speech_duration_limit": return "This speech request exceeded the ten-minute audio limit. Reduce the adapter text limit to split it into smaller requests.";
            case "speech_storage_limit": return "This speech request exceeded the bounded audio storage limit.";
            case "speech_storage_unavailable": return "Speech could not be buffered in this device's private cache.";
            case "resume_from_visible_app": case "foreground_start_rejected": return "Resume voice from the visible app.";
            case "target_unavailable": return "The selected thread is unavailable for voice input.";
            default: return "Voice could not complete this action (" + code + ").";
        }
    }
}
