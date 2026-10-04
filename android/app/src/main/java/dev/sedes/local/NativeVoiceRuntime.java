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
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Call;
import org.json.JSONArray;
import org.json.JSONObject;

/** Single native owner of settings, transient voice work and durable input recovery. */
final class NativeVoiceRuntime implements NativeVoiceAdapter.Listener, NativeVoiceAudio.Listener {
    interface Reply { void done(JSONObject value); void failed(String code, String message); }
    interface Observer { void event(String name, JSONObject value); }
    /** Automatic read-only receipt lookups per uncertain input before waiting for session or stream re-establishment. */
    static final int RECONCILE_ATTEMPTS = 8;
    /**
     * The server flushes the transient lane's queued policy before its application-live marker. A live stream still
     * without valid policy after this bound has no usable lane and fails; slow or silent handshakes are the read timeout's.
     */
    static final long POLICY_AFTER_LIVE_MS = 2000;
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
    private final Map<String, Recovery> recoveries = new HashMap<>();
    private NativeVoiceSettings settings = NativeVoiceSettings.defaults();
    private String profileId, origin, identity, binding, credential, csrf, originId;
    private String phase = "off", foregroundThread, foregroundTitle, composerMode = "queue";
    private boolean foregroundVisible, sessionStarted, policyKnown, streamFailureReported;
    private int adapterFailures, streamFailures;
    private volatile boolean nativeVisible;
    /** Invalidates a queued local UI event even if navigation or visibility changes back before dispatch. */
    private volatile Object inputSubmissionContext = new Object();
    private volatile String sessionStartId;
    interface SessionStarter { void start(Intent intent); }
    private SessionStarter testSessionStarter;
    private long connectionGeneration, stateRevision, policyGeneration = -1, streamGeneration;
    private JSONObject policy;
    private NativeVoiceRuntimeService service;
    private Call stream;
    private Active active;
    private String pendingOpenThread, pendingOpenProfile, pendingOpenOrigin, pendingOpenIdentity;
    private String published;
    private volatile JSONObject state;
    private static final class Active {
        final String id, event, noticeThread, noticeTitle;
        String targetId, targetTitle, ttsId, sttId, cueId;
        String completionCueId;
        Runnable afterCompletionCue;
        boolean automatic, followUp, waitingAfterSkip, stopped, recognitionFinalized, submissionNotified;
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
    /** In-memory read-only reconciliation of one journaled input for the current binding. */
    private static final class Recovery { long token; Call call; int attempts; boolean reported; }
    private NativeVoiceRuntime(Context context) {
        this.context = context; store = new NativeVoiceStore(context);
        HandlerThread thread = new HandlerThread("sedes-native-voice"); thread.start(); handler = new Handler(thread.getLooper());
        adapter = new NativeVoiceAdapter(this); audio = new NativeVoiceAudio(context, this);
        publish();
    }
    JSONObject snapshot() { return NativeVoiceJson.copy(state); }
    void observe(Observer observer) { observers.add(observer); handler.post(this::deliverPendingOpen); }
    void unobserve(Observer observer) { observers.remove(observer); }
    void setTestSessionStarter(SessionStarter starter) {
        if (!BuildConfig.DEBUG) throw new IllegalStateException("test_session_starter_unavailable");
        testSessionStarter = starter;
    }
    void nativeVisibility(boolean visible) {
        boolean becameVisible = visible && !nativeVisible;
        if (visible != nativeVisible) inputSubmissionContext = new Object();
        // Also gate the main-thread service launch immediately when Android pauses the activity.
        nativeVisible = visible;
        handler.post(() -> {
            if (!visible) { foregroundVisible = false; foregroundThread = null; foregroundTitle = null; }
            if (becameVisible && nativeVisible) resumeEnabledSession();
            publish();
        });
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
                    case "stopCurrentInteraction": NativeVoiceJson.keys(args); stopInteraction(); break;
                    case "resumeInput": NativeVoiceJson.keys(args, "mutationId"); resumeInput(NativeVoiceJson.string(args, "mutationId", 160)); break;
                    case "discardInput": NativeVoiceJson.keys(args, "mutationId"); discardInput(NativeVoiceJson.string(args, "mutationId", 160)); break;
                    case "listInputDevices": NativeVoiceJson.keys(args); reply.done(NativeVoiceJson.object("devices", audio.devices(), "selectedId", settings.text("inputDeviceId"))); return;
                    case "getState": NativeVoiceJson.keys(args); reply.done(snapshot()); return;
                    default: throw new IllegalArgumentException("unknown_voice_action");
                }
                publish(); reply.done(snapshot());
            } catch (Exception error) {
                String code = code(error);
                publish();
                reply.failed(code, message(code));
            }
        });
    }
    /** Only stable machine codes cross the bridge; arbitrary platform exception text does not. */
    static String code(Exception error) {
        String code = error.getMessage();
        if (error instanceof NativeVoiceJson.InvalidFieldException && code != null && code.matches("invalid_[a-z][A-Za-z0-9_]{0,71}")) return code;
        return code != null && code.matches("[a-z][a-z0-9_]{0,79}") ? code : "voice_action_failed";
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
        try { credential = new ClientCredentialStore(context).getCredential(profileId, origin); }
        catch (Exception error) { connectionFailed("credential_storage_unavailable", reply); return; }
        publish();
        http.request(origin, credential, null, "GET", "/api/auth/status", null, (status, value, failure) -> handler.post(() -> {
            if (generation != connectionGeneration) { reply.failed("connection_changed", message("connection_changed")); return; }
            String authenticatedIdentity;
            try {
                if (status != 200 || value == null) { connectionFailed(connectionFailure(status), reply); return; }
                if (value.optBoolean("required", true) && !value.optBoolean("authenticated")) { connectionFailed("authentication_required", reply); return; }
                authenticatedIdentity = NativeVoiceJson.string(value, "navigationNamespace", 64);
            } catch (IllegalArgumentException error) { connectionFailed("connection_unavailable", reply); return; }
            if (!authenticatedIdentity.equals(expectedIdentity)) {
                phase = "error"; report("connection_identity_changed");
                reply.failed("connection_identity_changed", message("connection_identity_changed")); return;
            }
            identity = authenticatedIdentity;
            try {
                binding = NativeVoiceStore.binding(profileId, origin, identity);
                final String owner = binding;
                // Unreadable records are quarantined and reset rather than blocking voice for this binding.
                settings = record(owner, () -> store.settings(owner)); originId = record(owner, () -> store.originId(owner));
                audio.configure(settings);
            } catch (Exception error) { connectionFailed("voice_storage_unavailable", reply); return; }
            loadSession(generation, () -> { phase = "off"; resumeEnabledSession(); publish(); recoverOutstanding(); reply.done(snapshot()); deliverPendingOpen(); },
                code -> {
                    if (generation == connectionGeneration) connectionFailed(code, null);
                    reply.failed(code, message(code));
                });
        }));
    }
    private void connectionFailed(String code, Reply reply) {
        inputSubmissionContext = new Object();
        binding = null; identity = null; originId = null; csrf = null; phase = "error"; report(code);
        if (reply != null) reply.failed(code, message(code));
    }
    /** A failed authentication probe: only 401 asks for pairing; transport, server and malformed responses are connectivity. */
    static String connectionFailure(int status) { return status == 401 ? "authentication_required" : "connection_unavailable"; }
    interface Failure { void fail(String code); }
    private boolean authenticationLost(int status, long generation) {
        if (status != 401) return false;
        if (generation == connectionGeneration) { disconnect(true); report("authentication_required"); }
        return true;
    }
    private Call loadSession(long generation, Runnable done, Failure fail) {
        return http.request(origin, credential, null, "GET", "/api/application/session", null, (status, value, failure) -> handler.post(() -> {
            if (generation != connectionGeneration) { fail.fail("connection_changed"); return; }
            if (authenticationLost(status, generation)) { fail.fail("authentication_required"); return; }
            if (status == 0 || status >= 500) { fail.fail("connection_unavailable"); return; }
            if (status != 200 || value == null) { fail.fail("session_unavailable"); return; }
            if (value.optInt("clientProtocolVersion", -1) != BuildConfig.SEDES_CLIENT_PROTOCOL_VERSION) { fail.fail("client_protocol_mismatch"); return; }
            csrf = value.optString("csrfToken", "");
            if (csrf.isEmpty()) { fail.fail("session_unavailable"); return; }
            done.run();
        }));
    }
    private void disconnect(boolean cancelIntended) {
        inputSubmissionContext = new Object();
        // Cancellation intent covers every journaled input, including the active admission.
        if (cancelIntended) cancelOutstanding(false);
        cancelActive(false, "connection_changed");
        for (Recovery recovery : recoveries.values()) if (recovery.call != null) recovery.call.cancel();
        recoveries.clear();
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
            cancelOutstanding(true); cancelActive(true, "voice_off"); queue.clear("voice_off"); stopSession(); phase = "off";
        } else {
            if (!next.flag("autoListen")) { queue.cancelFollowups(); if (active != null) active.followUp = false; }
            if (!previous.mode().equals(next.mode()) && active != null && active.automatic && active.admission == null)
                cancelActive(true, "audio_mode_changed");
            queue.reconfigure(next);
            if (!next.flag("autoListen") && active != null && active.automatic && !phase.equals("submitting") &&
                (phase.equals("validating") || phase.equals("arming") || phase.equals("listening") || phase.equals("recognizing"))) cancelActive(true, "auto_listen_disabled");
            if (active != null && active.automatic && active.notification != null && !eligible(active.notification)) cancelActive(true, "voice_filter_changed");
            if (!previous.text("adapterUrl").equals(next.text("adapterUrl"))) {
                // Media work belongs to the old adapter; a final transcript or admitted input does not.
                if (active != null && !adapterIndependent(active)) cancelActive(true, "adapter_changed");
                adapter.close(); adapterFailures = 0; if (sessionStarted) connectAdapter();
            }
            if (!sessionStarted && userInitiated) requestSessionStart();
        }
        publish(); emit("settingsChanged", snapshot()); drain();
    }
    private static boolean adapterIndependent(Active item) { return item.completionCueId != null || item.recognitionFinalized || item.admission != null; }
    private void resumeEnabledSession() {
        if (nativeVisible && binding != null && csrf != null && settings.active() && audio.hasPermission() &&
            !settings.text("adapterUrl").isEmpty()) scheduleSessionStart();
    }
    private void requestSessionStart() {
        if (sessionStarted || sessionStartId != null) return;
        if (!nativeVisible) throw new IllegalStateException("resume_from_visible_app");
        if (!audio.hasPermission()) throw new IllegalStateException("microphone_permission_required");
        if (settings.text("adapterUrl").isEmpty()) throw new IllegalStateException("adapter_required");
        scheduleSessionStart();
    }
    private void scheduleSessionStart() {
        if (sessionStarted || sessionStartId != null) return;
        errors.removeIf(error -> "foreground_start_rejected".equals(error.optString("code")));
        final String startId = UUID.randomUUID().toString();
        sessionStartId = startId;
        phase = "starting";
        final long generation = connectionGeneration;
        main.post(() -> {
            if (!currentSessionStart(generation, startId)) return;
            if (!nativeVisible) { deferSessionStart(generation, startId); return; }
            Intent intent = new Intent(context, NativeVoiceRuntimeService.class).setAction(NativeVoiceRuntimeService.ACTION_START)
                .putExtra("voiceGeneration", generation).putExtra("voiceStartId", startId);
            try {
                if (BuildConfig.DEBUG && testSessionStarter != null) testSessionStarter.start(intent);
                else ContextCompat.startForegroundService(context, intent);
            } catch (Exception error) { startFailed(generation, startId); }
        });
        handler.postDelayed(() -> startFailed(generation, startId), 15000);
    }
    private boolean currentSessionStart(long generation, String startId) {
        return startId != null && startId.equals(sessionStartId) && snapshot().optLong("connectionGeneration") == generation;
    }
    boolean acceptsSessionStart(long generation, String startId) {
        return nativeVisible && currentSessionStart(generation, startId);
    }
    void deferSessionStart(long generation, String startId) {
        handler.post(() -> {
            if (!currentSessionStart(generation, startId)) return;
            sessionStartId = null; phase = "off";
            // Visibility may have returned while this callback waited for the owner.
            resumeEnabledSession(); publish();
        });
    }
    void attached(NativeVoiceRuntimeService service, long generation, String startId) {
        handler.post(() -> {
            if (!currentSessionStart(generation, startId)) { main.post(() -> service.finishStart(generation, startId)); return; }
            sessionStartId = null;
            this.service = service;
            if (binding == null || !settings.active() || !audio.hasPermission()) { stopSession(); publish(); return; }
            sessionStarted = true; phase = "starting"; connectAdapter(); connectEvents(); publish();
            // Snapshots are published only on change; the new owner still needs its first controls and media session state.
            JSONObject snapshot = snapshot(); main.post(() -> service.render(snapshot));
        });
    }
    void startFailed(long generation, String startId) {
        handler.post(() -> {
            if (!currentSessionStart(generation, startId)) return;
            sessionStartId = null; sessionStarted = false; phase = "error"; report("foreground_start_rejected");
        });
    }
    void detached(NativeVoiceRuntimeService service) {
        handler.post(() -> { if (this.service == service) { this.service = null; sessionStarted = false; cancelActive(false, "service_stopped"); adapter.close(); closeEvents(); phase = "off"; publish(); } });
    }
    private void stopSession() {
        sessionStartId = null; sessionStarted = false; adapter.close(); audio.stop(); closeEvents();
        adapterFailures = 0; streamFailures = 0; streamFailureReported = false;
        NativeVoiceRuntimeService old = service; service = null;
        if (old != null) main.post(old::finish);
    }
    private void foreground(JSONObject args) {
        NativeVoiceJson.keys(args, "visible", "threadId", "threadTitle", "composerMode");
        // Validate every argument before changing any foreground state.
        boolean visible = NativeVoiceJson.bool(args, "visible");
        String thread = NativeVoiceJson.nullableString(args, "threadId", 512), title = NativeVoiceJson.nullableString(args, "threadTitle", 512);
        String mode = args.has("composerMode") ? NativeVoiceJson.string(args, "composerMode", 16) : null;
        if (mode != null && !mode.equals("queue") && !mode.equals("steer")) throw new NativeVoiceJson.InvalidFieldException("composerMode");
        boolean nextVisible = visible && nativeVisible;
        String nextThread = nextVisible ? thread : null;
        if (foregroundVisible != nextVisible || !Objects.equals(foregroundThread, nextThread)) inputSubmissionContext = new Object();
        foregroundVisible = nextVisible;
        foregroundThread = nextThread;
        foregroundTitle = foregroundVisible ? title : null;
        if (mode != null) composerMode = mode;
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
            public void live() { handler.post(() -> streamLive(generation)); }
            public void frame(String event, JSONObject value) { handler.post(() -> { if (generation == streamGeneration && sessionStarted) receive(event, value); }); }
            public void closed(String code) { handler.post(() -> { if (generation == streamGeneration && sessionStarted) streamFailed(code); }); }
        });
    }
    private void streamLive(long generation) {
        if (generation != streamGeneration || !sessionStarted || policyKnown) return;
        handler.postDelayed(() -> { if (generation == streamGeneration && sessionStarted && !policyKnown) streamFailed("notification_policy_missing"); }, POLICY_AFTER_LIVE_MS);
    }
    private void streamFailed(String code) {
        Call old = stream;
        stream = null; policyKnown = false; policy = null; policyGeneration = -1; streamGeneration++;
        if (old != null) old.cancel();
        cancelAutomatic("notification_connection_lost");
        if (code.equals("unauthorized")) { disconnect(true); report("authentication_required"); return; }
        streamFailures++;
        // Persistent rejection or a stream without policy is surfaced once per failure streak; readiness shows the rest.
        if (!streamFailureReported && (code.equals("stream_rejected") || code.equals("notification_policy_missing"))) {
            streamFailureReported = true; report(code.equals("stream_rejected") ? "notification_stream_rejected" : "notification_policy_unavailable");
        }
        publish(); final long current = streamGeneration;
        handler.postDelayed(() -> { if (current == streamGeneration && sessionStarted) connectEvents(); }, backoff(streamFailures));
    }
    private void closeEvents() { streamGeneration++; if (stream != null) stream.cancel(); stream = null; policyKnown = false; policy = null; policyGeneration = -1; }
    private void receive(String event, JSONObject value) {
        try {
            if (event.equals("notification_policy")) {
                NativeVoiceJson.keys(value, "generation", "settings");
                long generation = NativeVoiceJson.integer(value, "generation", 0, Long.MAX_VALUE);
                if (generation < policyGeneration) return;
                JSONObject next = NativeVoiceJson.requiredObject(value, "settings");
                NativeVoiceProtocol.validatePolicy(next);
                boolean established = !policyKnown;
                if (!policyKnown || generation != policyGeneration) cancelAutomatic("notification_policy_changed");
                policy = NativeVoiceJson.copy(next); policyGeneration = generation; policyKnown = true;
                streamFailures = 0; streamFailureReported = false; publish();
                // Re-established Sedes connectivity is the moment an uncertain receipt may have become readable.
                if (established) recoverOutstanding();
                return;
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
        // A finalized transcript or already submitted message keeps its own admission semantics, as when settings change.
        if (active != null && active.automatic && !adapterIndependent(active) && !phase.equals("submitting")) cancelActive(true, reason);
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
        // A chunk with nothing to speak is a no-op rather than a failure of the whole item.
        while (item.chunk < item.chunks.size() && blank(item.chunks.get(item.chunk))) item.chunk++;
        if (item.chunk >= item.chunks.size()) { afterSpeech(item); return; }
        if (!adapter.ready()) { failActive("adapter_disconnected"); return; }
        item.ttsId = UUID.randomUUID().toString(); String request = item.ttsId;
        phase = "synthesizing"; audio.begin(request); publish();
        adapter.tts(request, item.chunks.get(item.chunk), status -> handler.post(() -> {
            if (active != item || !request.equals(item.ttsId)) return;
            // The adapter answers 400 only when its sanitizer leaves nothing to speak; that chunk is a no-op.
            if (status == 400) { audio.stop(); item.ttsId = null; item.chunk++; speakChunk(item); }
            else if (status < 200 || status >= 300) failActive("speech_request_rejected");
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
        if (settings.flag("recognitionCues")) audio.cue(item.cueId, NativeVoiceCue.Kind.START, settings.number("cueGain")); else capture(item);
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
        String target = NativeVoiceJson.nullableString(args, "threadId", 512), title = NativeVoiceJson.nullableString(args, "threadTitle", 512);
        if (!sessionStarted || !adapter.ready() || binding == null) throw new IllegalStateException("voice_not_ready");
        if (active != null) throw new IllegalStateException("voice_busy");
        if (target == null && foregroundVisible) { target = foregroundThread; title = foregroundTitle; }
        if (target == null) { target = settings.text("voiceThreadId"); title = settings.text("voiceThreadTitle"); }
        if (target == null) throw new IllegalStateException("voice_target_required");
        active = new Active(target, title); validateTarget(active, false);
    }
    private void retarget(JSONObject args) {
        NativeVoiceJson.keys(args, "threadId", "threadTitle");
        // Parse both fields first: a rejected title must not leave the capture retargeted.
        String target = NativeVoiceJson.string(args, "threadId", 512), title = NativeVoiceJson.nullableString(args, "threadTitle", 512);
        if (active == null || !phase.equals("listening")) throw new IllegalStateException("voice_not_listening");
        active.targetId = target; active.targetTitle = title;
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
        if (old.admission != null && cancelAdmission) cancelEntry(binding, old.admission.optString("mutationId"), true);
        // Reconnecting releases a live socket's per-client media slot. A failed adapter reconnects only through its backoff.
        boolean release = (old.ttsId != null || old.sttId != null) && sessionStarted && adapter.ready();
        if (old.ttsId != null) adapter.stopTts(old.ttsId);
        if (old.sttId != null) adapter.cancelStt(old.sttId);
        if (release) connectAdapter();
        phase = sessionStarted ? "idle" : "off";
        publish();
    }
    private void finishItem(Active item) { if (active == item) { if (item.notification != null) queue.completed(item.id); active = null; audio.stop(); phase = sessionStarted ? "idle" : "off"; publish(); drain(); } }
    private void stopRecognition(Active item, boolean reconnect) {
        String request = item.sttId;
        item.sttId = null;
        audio.stop();
        if (request != null) { adapter.cancelStt(request); if (reconnect && sessionStarted && adapter.ready()) connectAdapter(); }
    }
    private void stopInteraction() {
        Active item = active;
        if (item != null && item.sttId != null) {
            stopRecognition(item, true);
            recognitionCompletionCue(item, false, () -> { cancelActive(true, "stopped"); drain(); });
        } else { cancelActive(true, "stopped"); drain(); }
    }
    private void failActive(String code) {
        Active item = active;
        if (item != null && item.sttId != null && !code.equals("audio_focus_lost")) {
            stopRecognition(item, true);
            recognitionCompletionCue(item, false, () -> { cancelActive(false, code); report(code); drain(); });
        } else { cancelActive(false, code); report(code); drain(); }
    }
    private void recognitionCompletionCue(Active item, boolean success, Runnable done) {
        if (active != item || item.stopped) return;
        audio.stop();
        if (!settings.flag("recognitionCues")) { done.run(); return; }
        item.completionCueId = UUID.randomUUID().toString(); item.afterCompletionCue = done;
        String cue = item.completionCueId;
        phase = "recognizing"; publish();
        audio.cue(cue, success ? NativeVoiceCue.Kind.SUCCESS : NativeVoiceCue.Kind.FAILURE, settings.number("cueGain"));
        // Feedback is bounded and must not strand otherwise valid recognized input.
        handler.postDelayed(() -> finishCompletionCue(item, cue), 15000);
    }
    private void finishCompletionCue(Active item, String cue) {
        if (active != item || item.stopped || !cue.equals(item.completionCueId)) return;
        Runnable done = item.afterCompletionCue;
        item.completionCueId = null; item.afterCompletionCue = null;
        audio.stop(); done.run();
    }
    public void ready(long generation) { handler.post(() -> {
        if (generation != adapter.generation() || !sessionStarted) return;
        adapterFailures = 0;
        if (active != null && active.waitingAfterSkip) { active.waitingAfterSkip = false; afterSpeech(active); }
        else drain(); publish();
    }); }
    public void failed(long generation, String code) { handler.post(() -> {
        if (generation != adapter.generation() || !sessionStarted) return;
        adapter.close();
        boolean announce = adapterFailures++ == 0;
        Active item = active;
        if (item != null && adapterIndependent(item)) {
            // A final transcript or admitted input no longer depends on the adapter connection.
            if (announce) report(code);
        } else if (item != null && item.sttId != null) {
            stopRecognition(item, false);
            recognitionCompletionCue(item, false, () -> { cancelActive(false, code); report(code); drain(); });
        } else {
            if (item != null) cancelActive(false, code);
            // Repeated failures while reconnecting are reported once per streak; readiness shows the ongoing state.
            if (item != null || announce) report(code);
        }
        // This is the only reconnect after a failure: cancellation above does not reconnect a closed adapter.
        long current = adapter.generation();
        handler.postDelayed(() -> { if (sessionStarted && adapter.generation() == current) connectAdapter(); }, backoff(adapterFailures));
        publish();
    }); }
    public void event(long generation, JSONObject event) { handler.post(() -> {
        if (generation != adapter.generation() || active == null) return;
        Active item = active; String type = event.optString("type"), request = event.optString("requestId");
        if (request.equals(item.ttsId)) {
            if (type.equals("media_tts_audio_chunk")) {
                if (!event.optString("encoding").equals("pcm_s16le")) { failActive("unsupported_pcm_encoding"); return; }
                try {
                    audio.pcm(request, event.optInt("sampleRate"), Base64.decode(event.optString("chunkBase64"), Base64.DEFAULT));
                    if (!phase.equals("speaking")) { phase = "speaking"; publish(); }
                }
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
                String text = event.optString("text", "");
                boolean success = event.optBoolean("success");
                boolean retryEmptyTranscript = shouldRetryEmptyTranscript(success, event.optBoolean("canceled"), event.optString("error", ""));
                // A missing reply is re-armed in place; only a captured transcript makes the item adapter-independent.
                item.recognitionFinalized = !retryEmptyTranscript;
                boolean usable = success && !blank(text) &&
                    !(settings.flag("recognizeStopCommand") && NativeVoiceQueue.isStopCommand(text));
                boolean steer = settings.flag("followComposerMode") && composerMode.equals("steer");
                recognitionCompletionCue(item, usable, () -> {
                    if (retryEmptyTranscript) arm(item);
                    else if (!success) failActive("recognition_failed");
                    else if (!usable) finishItem(item);
                    else finalizeRecognition(item, text, steer);
                });
            }
        }
    }); }
    public void drained(String requestId) { handler.post(() -> {
        if (active == null) return;
        if (requestId.equals(active.completionCueId)) finishCompletionCue(active, requestId);
        else if (requestId.equals(active.cueId)) capture(active);
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
        // A refused send on a replaced or lost socket is a disconnect, not local transport overflow.
        if (!adapter.send(NativeVoiceJson.object("type", "media_stt_chunk", "requestId", requestId,
            "chunkBase64", Base64.encodeToString(pcm, Base64.NO_WRAP)))) failActive(adapter.ready() ? "recognition_transport_overflow" : "adapter_disconnected");
    }); }
    public void captureEnded(String requestId) { handler.post(() -> {
        if (active == null || !requestId.equals(active.sttId) || !phase.equals("listening")) return;
        adapter.send(NativeVoiceJson.object("type", "media_stt_end", "requestId", requestId)); phase = "recognizing"; publish();
    }); }
    public void failed(String requestId, String reason) { handler.post(() -> {
        Active item = active;
        if (item == null) return;
        if (requestId.equals(item.completionCueId)) { finishCompletionCue(item, requestId); return; }
        // A chunk that produced no audio is a no-op; continue with the next chunk or the item's follow-up.
        if (requestId.equals(item.ttsId) && reason.equals("empty_pcm_stream")) { item.ttsId = null; item.chunk++; speakChunk(item); return; }
        if (requestId.equals(item.ttsId) || requestId.equals(item.sttId) || requestId.equals(item.cueId)) failActive(reason);
    }); }
    private void finalizeRecognition(Active item, String text, boolean steer) {
        if (active != item) return;
        if (NativeVoiceJson.bytes(text) > 65536) { failActive("recognized_text_too_large"); return; }
        final String target = item.targetId, frozenText = text, frozenOrigin = originId;
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
        try { saveEntry(binding, entry); item.admission = entry; submit(binding, origin, credential, entry, false); }
        catch (Exception error) { failActive("voice_journal_capacity".equals(error.getMessage()) ? "voice_journal_capacity" : "voice_storage_unavailable"); }
    }
    private interface StoreAction<T> { T run() throws Exception; }
    /** Runs a record operation; an unreadable record is quarantined, reported once, and the operation retried from defaults. */
    private <T> T record(String ownerBinding, StoreAction<T> action) throws Exception {
        try { return action.run(); }
        catch (NativeVoiceStore.CorruptRecord error) {
            store.quarantine(ownerBinding, error.record);
            if (ownerBinding.equals(binding)) report("voice_" + error.record + "_reset");
            return action.run();
        }
    }
    private JSONObject entry(String ownerBinding, String id) throws Exception { return record(ownerBinding, () -> store.entry(ownerBinding, id)); }
    private void saveEntry(String ownerBinding, JSONObject entry) throws Exception { record(ownerBinding, () -> { store.saveEntry(ownerBinding, entry); return null; }); }
    private void removeEntry(String ownerBinding, String id) throws Exception { record(ownerBinding, () -> { store.removeEntry(ownerBinding, id); return null; }); }
    private boolean activeAdmission(String id) { return active != null && active.admission != null && id.equals(active.admission.optString("mutationId")); }
    private void submit(String ownerBinding, String ownerOrigin, String ownerCredential, JSONObject entry, boolean refreshed) {
        String id = entry.optString("mutationId"), key = ownerBinding + "\n" + id;
        final long generation = connectionGeneration;
        try {
            JSONObject current = entry(ownerBinding, id);
            if (current == null || current.optBoolean("cancelled") || cancelledAdmissions.contains(key) || admissions.containsKey(key)) return;
            NativeVoiceJson.put(current, "stage", "possiblySubmitted"); saveEntry(ownerBinding, current);
            Call call = http.request(ownerOrigin, ownerCredential, csrf, "POST", "/api/threads/" + Uri.encode(current.optString("threadId")) + "/inputs",
                current.optJSONObject("request"), (status, value, failure) -> handler.post(() -> {
                    admissions.remove(key);
                    // After a reconnect to the same binding, an unknown outcome still needs read-only reconciliation.
                    if (authenticationLost(status, generation)) { if (ownerBinding.equals(binding)) reconcile(id, false, null); return; }
                    try { admissionResult(ownerBinding, ownerOrigin, ownerCredential, id, generation, refreshed, status, value); }
                    catch (Exception error) { report("voice_storage_unavailable"); }
                }));
            admissions.put(key, call); publish();
        } catch (Exception error) { report("voice_storage_unavailable"); }
    }
    private void admissionResult(String ownerBinding, String ownerOrigin, String ownerCredential, String id, long generation, boolean refreshed,
        int status, JSONObject value) throws Exception {
        String key = ownerBinding + "\n" + id;
        JSONObject remaining = entry(ownerBinding, id); if (remaining == null) return;
        if (status >= 200 && status < 300 && receiptMatches(value, remaining)) { accepted(ownerBinding, id, value, generation); return; }
        JSONObject error = value == null ? null : value.optJSONObject("error");
        boolean csrfRejected = status == 403 && error != null && error.optString("code").equals("csrf_token_invalid");
        boolean cancelled = remaining.optBoolean("cancelled") || cancelledAdmissions.contains(key);
        boolean current = generation == connectionGeneration && ownerBinding.equals(binding);
        // A CSRF rejection admitted nothing; with cancellation intent there is nothing left to deliver.
        if (csrfRejected && cancelled) { rejected(ownerBinding, id, null, false); return; }
        if (csrfRejected && !refreshed && current) {
            // The refresh holds the admission slot, so Stop records intent without a competing receipt read.
            Call refresh = loadSession(connectionGeneration,
                () -> { admissions.remove(key); retryAfterCsrfRefresh(ownerBinding, ownerOrigin, ownerCredential, id); },
                code -> { admissions.remove(key); csrfRefreshFailed(ownerBinding, id); });
            admissions.put(key, refresh); publish();
            return;
        }
        String diagnostic = diagnostic(error);
        if (definitiveRejection(status, error == null ? "" : error.optString("code"))) { rejected(ownerBinding, id, diagnostic, true); return; }
        // Otherwise the outcome is unknown. The current binding reconciles read-only, even after a reconnect that this
        // in-flight attempt outlived; another binding's entry waits until that binding reconnects. Neither resends.
        if (!ownerBinding.equals(binding)) return;
        if (activeAdmission(id)) phase = "recovering";
        reconcile(id, false, diagnostic);
    }
    private void retryAfterCsrfRefresh(String ownerBinding, String ownerOrigin, String ownerCredential, String id) {
        try {
            JSONObject latest = entry(ownerBinding, id); if (latest == null) return;
            if (latest.optBoolean("cancelled") || cancelledAdmissions.contains(ownerBinding + "\n" + id)) { rejected(ownerBinding, id, null, false); return; }
            submit(ownerBinding, ownerOrigin, ownerCredential, latest, true);
        } catch (Exception error) { report("voice_storage_unavailable"); }
    }
    private void csrfRefreshFailed(String ownerBinding, String id) {
        try {
            JSONObject latest = entry(ownerBinding, id); if (latest == null) return;
            if (latest.optBoolean("cancelled") || cancelledAdmissions.contains(ownerBinding + "\n" + id)) { rejected(ownerBinding, id, null, false); return; }
            if (!ownerBinding.equals(binding)) return;
            if (activeAdmission(id)) phase = "recovering";
            reconcile(id, false, null);
        } catch (Exception error) { report("voice_storage_unavailable"); }
    }
    /**
     * A completed 4xx admitted nothing, except authentication, CSRF, timeout and rate-limit responses. A pending
     * uncertain thread operation is resolvable by the user, so that input stays in recovery for an explicit Resume.
     */
    static boolean definitiveRejection(int status, String code) {
        return status >= 400 && status < 500 && status != 401 && status != 408 && status != 429 &&
            !(status == 403 && code.equals("csrf_token_invalid")) && !code.equals("operation_outcome_uncertain");
    }
    private static String diagnostic(JSONObject error) {
        Object message = error == null ? null : error.opt("message");
        if (!(message instanceof String) || blank((String) message)) return null;
        String text = (String) message; int end = Math.min(500, text.length());
        if (end < text.length() && Character.isHighSurrogate(text.charAt(end - 1))) end--;
        return text.substring(0, end);
    }
    private boolean receiptMatches(JSONObject receipt, JSONObject entry) {
        if (receipt == null) return false;
        try { NativeVoiceProtocol.receipt(receipt); }
        catch (IllegalArgumentException error) { return false; }
        return entry.optString("mutationId").equals(receipt.optString("mutationId")) && entry.optString("threadId").equals(receipt.optString("threadId"));
    }
    private void forget(String key) { Recovery recovery = recoveries.remove(key); if (recovery != null && recovery.call != null) recovery.call.cancel(); }
    private void accepted(String ownerBinding, String id, JSONObject receipt, long generation) throws Exception {
        // A found receipt, including queued or submitting, is the definitive admission. Dispatch then belongs to the thread.
        String key = ownerBinding + "\n" + id;
        inputSubmitted(ownerBinding, id, receipt, generation);
        removeEntry(ownerBinding, id); cancelledAdmissions.remove(key); forget(key);
        if (ownerBinding.equals(binding)) {
            if (activeAdmission(id)) finishItem(active);
            else publish();
            String status = receipt.optString("status");
            if (status.equals("failed") || status.equals("recovery_required") || status.equals("cancelled"))
                report("input_" + status, receipt.has("diagnostic") ? receipt.optString("diagnostic") : null);
        }
    }
    /** A current local Send may move its visible transcript; journal recovery and other devices never do. */
    private void inputSubmitted(String ownerBinding, String id, JSONObject receipt, long generation) {
        final Object submittedContext = inputSubmissionContext;
        final String threadId = receipt.optString("threadId"), status = receipt.optString("status");
        if (generation != connectionGeneration || !ownerBinding.equals(binding) || !activeAdmission(id) ||
            active.stopped || active.submissionNotified || active.admission.optBoolean("cancelled") ||
            cancelledAdmissions.contains(ownerBinding + "\n" + id) || !nativeVisible || !foregroundVisible ||
            !threadId.equals(foregroundThread) || !receipt.optString("admittedMode").equals("submit") ||
            !(status.equals("queued") || status.equals("submitting") || status.equals("accepted"))) return;
        active.submissionNotified = true;
        final JSONObject event = NativeVoiceJson.object("profileId", profileId, "serverOrigin", origin, "identity", identity,
            "connectionGeneration", generation, "threadId", threadId, "operationId", receipt.optString("operationId"));
        // Capture recipients now: a WebView opened after admission must not receive this transient event.
        final List<Observer> recipients = new ArrayList<>(observers);
        main.post(() -> {
            JSONObject current = state, foreground = current.optJSONObject("foreground");
            if (submittedContext != inputSubmissionContext || !nativeVisible ||
                current.optLong("connectionGeneration", -1) != generation ||
                !event.optString("profileId").equals(current.optString("profileId")) ||
                !event.optString("serverOrigin").equals(current.optString("serverOrigin")) ||
                !event.optString("identity").equals(current.optString("identity")) || foreground == null ||
                !foreground.optBoolean("visible") || !threadId.equals(foreground.optString("threadId"))) return;
            for (Observer observer : recipients) if (observers.contains(observer)) observer.event("inputSubmitted", event);
        });
    }
    private void rejected(String ownerBinding, String id, String diagnostic, boolean notify) throws Exception {
        String key = ownerBinding + "\n" + id;
        removeEntry(ownerBinding, id); cancelledAdmissions.remove(key); forget(key);
        if (!ownerBinding.equals(binding)) return;
        if (activeAdmission(id)) finishItem(active); else publish();
        if (notify) report("input_rejected", diagnostic == null ? null : "Sedes rejected the input: " + diagnostic);
    }
    private void uncertain(String ownerBinding, String id, String diagnostic, Recovery recovery) {
        // The first reconciliation releases the single active slot; the entry stays visible and reconciles read-only.
        if (activeAdmission(id)) finishItem(active); else publish();
        if (!recovery.reported) {
            recovery.reported = true;
            report("input_outcome_uncertain", diagnostic == null ? null : "Input delivery is uncertain. Server response: " + diagnostic);
        }
        if (recovery.attempts >= RECONCILE_ATTEMPTS) return;
        final String key = ownerBinding + "\n" + id; final long token = recovery.token;
        handler.postDelayed(() -> {
            if (recoveries.get(key) != recovery || recovery.token != token || recovery.call != null || admissions.containsKey(key)) return;
            reconcile(id, false, null);
        }, backoff(++recovery.attempts));
    }
    private void cancelEntry(String ownerBinding, String id, boolean reconcile) {
        if (ownerBinding == null) return;
        String key = ownerBinding + "\n" + id;
        cancelledAdmissions.add(key);
        try {
            JSONObject current = entry(ownerBinding, id); if (current == null) return;
            if (current.optString("stage").equals("prepared")) { removeEntry(ownerBinding, id); forget(key); }
            else {
                if (!current.optBoolean("cancelled")) { NativeVoiceJson.put(current, "cancelled", true); saveEntry(ownerBinding, current); }
                // An in-flight attempt reports its own outcome; reading the receipt concurrently would only race it.
                if (reconcile && ownerBinding.equals(binding) && !admissions.containsKey(key)) reconcile(id, false, null);
            }
        } catch (Exception error) { report("voice_storage_unavailable"); }
    }
    private void cancelOutstanding(boolean reconcile) {
        if (binding == null) return;
        try { JSONArray entries = record(binding, () -> store.summaries(binding)); for (int i = 0; i < entries.length(); i++) cancelEntry(binding, entries.getJSONObject(i).optString("mutationId"), reconcile); }
        catch (Exception error) { report("voice_storage_unavailable"); }
    }
    /** Reads every journaled receipt again with a fresh retry budget; never sends input. */
    private void recoverOutstanding() {
        if (binding == null) return;
        try {
            JSONArray entries = record(binding, () -> store.summaries(binding));
            for (int i = 0; i < entries.length(); i++) {
                String id = entries.getJSONObject(i).optString("mutationId"), key = binding + "\n" + id;
                if (admissions.containsKey(key)) continue;
                Recovery recovery = recoveries.get(key);
                if (recovery != null) { recovery.attempts = 0; if (recovery.call != null) continue; }
                reconcile(id, false, null);
            }
        } catch (Exception error) { report("voice_storage_unavailable"); }
    }
    private void reconcile(String id, boolean allowSubmit, String diagnostic) {
        final String ownerBinding = binding, ownerOrigin = origin, ownerCredential = credential;
        if (ownerBinding == null) return;
        final String key = ownerBinding + "\n" + id;
        Recovery existing = recoveries.get(key);
        if (existing == null) recoveries.put(key, existing = new Recovery());
        if (existing.call != null) { if (!allowSubmit) return; existing.call.cancel(); }
        final Recovery recovery = existing; final long token = ++recovery.token, generation = connectionGeneration;
        recovery.call = http.request(ownerOrigin, ownerCredential, null, "GET", "/api/input-receipts/" + Uri.encode(id), null,
            (status, value, failure) -> handler.post(() -> {
                if (recoveries.get(key) != recovery || recovery.token != token) return;
                recovery.call = null;
                if (authenticationLost(status, generation)) return;
                try {
                    JSONObject current = entry(ownerBinding, id); if (current == null) { recoveries.remove(key); publish(); return; }
                    String lookup = null;
                    if (status == 200 && value != null) {
                        try { lookup = NativeVoiceProtocol.receiptLookup(value); }
                        catch (IllegalArgumentException error) { lookup = null; }
                    }
                    if ("found".equals(lookup) && receiptMatches(value.optJSONObject("receipt"), current)) { accepted(ownerBinding, id, value.optJSONObject("receipt"), generation); return; }
                    if (allowSubmit && "notObserved".equals(lookup) && !current.optBoolean("cancelled")) submit(ownerBinding, ownerOrigin, ownerCredential, current, false);
                    else uncertain(ownerBinding, id, diagnostic, recovery);
                } catch (Exception error) { report("voice_storage_unavailable"); }
            }));
        publish();
    }
    private void resumeInput(String id) throws Exception {
        if (binding == null) throw new IllegalStateException("authentication_required");
        String key = binding + "\n" + id;
        JSONObject current = entry(binding, id);
        if (current == null) throw new IllegalStateException("input_recovery_not_found");
        if (current.optBoolean("cancelled")) { NativeVoiceJson.put(current, "cancelled", false); saveEntry(binding, current); }
        cancelledAdmissions.remove(key);
        // An attempt already in flight reports its own outcome.
        if (admissions.containsKey(key)) return;
        Recovery recovery = recoveries.get(key);
        if (recovery != null) { recovery.attempts = 0; recovery.reported = false; }
        reconcile(id, true, null);
    }
    /** Explicitly resolves a recovery entry: cancels any in-flight request and removes the journaled input. */
    private void discardInput(String id) throws Exception {
        if (binding == null) throw new IllegalStateException("authentication_required");
        String key = binding + "\n" + id;
        if (entry(binding, id) == null) throw new IllegalStateException("input_recovery_not_found");
        Call attempt = admissions.remove(key); if (attempt != null) attempt.cancel();
        forget(key); cancelledAdmissions.remove(key);
        removeEntry(binding, id);
        if (activeAdmission(id)) finishItem(active);
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
                    case "stop": stopInteraction(); break;
                    case "skip": skip(); break;
                    case "mode": updateSettings(NativeVoiceJson.object("expectedRevision", settings.revision,
                        "patch", NativeVoiceJson.object("audioMode", settings.mode().equals("manual") ? "response" : "manual")), false); break;
                    case "rearm": updateSettings(NativeVoiceJson.object("expectedRevision", settings.revision,
                        "patch", NativeVoiceJson.object("autoListen", !settings.flag("autoListen"))), false); break;
                    case "headset":
                        if (!settings.flag("headsetControls")) return;
                        if (active == null) manual(new JSONObject());
                        else if (phase.equals("speaking") || phase.equals("synthesizing")) skip();
                        else stopInteraction();
                        break;
                    case "headset_stop":
                        if (!settings.flag("headsetControls")) return;
                        stopInteraction(); break;
                    case "headset_skip":
                        if (!settings.flag("headsetControls")) return;
                        skip(); break;
                }
                publish();
            } catch (Exception error) { report(code(error)); }
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
    /** Profile removal disconnects that profile and deletes its settings, origin IDs and input journals on the owner thread. */
    void profileRemoved(String profile) throws Exception {
        if (profile == null || !profile.matches("[A-Za-z0-9._:-]{1,160}")) throw new IllegalArgumentException("credential_profile_invalid");
        CountDownLatch done = new CountDownLatch(1); AtomicReference<Exception> failure = new AtomicReference<>();
        handler.post(() -> {
            try { if (profile.equals(profileId)) disconnect(true); store.removeProfile(profile); }
            catch (Exception error) { failure.set(error); }
            finally { done.countDown(); }
        });
        if (!done.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("voice_disconnect_timeout");
        if (failure.get() != null) throw failure.get();
    }
    private JSONArray recoveryState() {
        JSONArray result = new JSONArray();
        if (binding == null) return result;
        try {
            // Served from the store's in-memory journal; snapshots do not decrypt records.
            JSONArray entries = store.summaries(binding);
            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.getJSONObject(i);
                String id = entry.optString("mutationId"), key = binding + "\n" + id;
                Recovery recovery = recoveries.get(key);
                result.put(NativeVoiceJson.object("mutationId", id, "threadId", entry.optString("threadId"),
                    "status", admissions.containsKey(key) ? "possiblySubmitted" : recovery != null && recovery.call != null ? "reconciling" : "uncertain",
                    "cancelled", entry.optBoolean("cancelled") || cancelledAdmissions.contains(key)));
            }
        } catch (Exception ignored) {}
        return result;
    }
    private boolean canListen() {
        return sessionStarted && adapter.ready() && binding != null && csrf != null && settings.active() && audio.hasPermission();
    }
    private String readiness() {
        if (profileId == null) return "disconnected";
        if (binding == null || csrf == null) return phase.equals("error") ? "error" : "connecting";
        if (!settings.active()) return "off";
        if (!audio.hasPermission()) return "permissionRequired";
        if (settings.text("adapterUrl").isEmpty()) return "adapterRequired";
        if (!sessionStarted) return sessionStartId == null ? "needsResume" : "adapterConnecting";
        if (!adapter.ready()) return "adapterConnecting";
        // Notifications require a live stream with known policy; explicit recording does not.
        if (!policyKnown) return streamFailures == 0 ? "notificationsConnecting" : "notificationsUnavailable";
        return "ready";
    }
    private void publish() {
        JSONObject current = active == null ? null : NativeVoiceJson.object("id", active.id, "eventKind", active.event,
            "threadId", active.noticeThread, "threadTitle", active.noticeTitle, "recognitionThreadId", active.targetId,
            "recognitionThreadTitle", active.targetTitle, "automatic", active.automatic);
        String readiness = readiness();
        boolean ready = readiness.equals("ready");
        JSONObject next = NativeVoiceJson.object("version", 1, "connectionGeneration", connectionGeneration,
            "profileId", profileId, "serverOrigin", origin, "identity", identity, "originClientId", originId,
            "settingsRevision", settings.revision, "settings", settings.value, "phase", phase, "ready", ready,
            "readiness", readiness, "foreground", NativeVoiceJson.object("visible", foregroundVisible, "threadId", foregroundThread, "threadTitle", foregroundTitle),
            "active", current, "queue", queue.state(), "actions", NativeVoiceJson.object("canStart", canListen() && active == null,
                "canStop", active != null, "canSkip", active != null && (phase.equals("speaking") || phase.equals("synthesizing")),
                "canRetarget", active != null && phase.equals("listening"), "canResume", binding != null && settings.active() && !sessionStarted && sessionStartId == null),
            "recovery", recoveryState(), "errors", NativeVoiceJson.array(errors));
        // Unchanged state is not republished: no bridge event, notification update or media session churn per PCM chunk.
        String fingerprint = next.toString();
        if (fingerprint.equals(published)) return;
        published = fingerprint;
        NativeVoiceJson.put(next, "stateRevision", ++stateRevision);
        state = next;
        emit("stateChanged", snapshot());
        NativeVoiceRuntimeService currentService = service;
        if (currentService != null) { JSONObject snapshot = snapshot(); main.post(() -> currentService.render(snapshot)); }
    }
    private void emit(String name, JSONObject value) { main.post(() -> { for (Observer observer : observers) observer.event(name, value); }); }
    private void report(String code) {
        report(code, null);
    }
    private void report(String code, String diagnostic) {
        String detail = diagnostic == null || blank(diagnostic) ? message(code) : diagnostic;
        JSONObject error = NativeVoiceJson.object("code", code, "message", detail);
        errors.addLast(error); while (errors.size() > 8) errors.removeFirst(); publish();
        emit("runtimeError", NativeVoiceJson.object("code", code, "message", detail, "connectionGeneration", connectionGeneration,
            "profileId", profileId, "serverOrigin", origin, "identity", identity));
    }
    /** Matches ECMAScript String.prototype.trim(), which the server uses to reject blank input. */
    static boolean blank(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            boolean whitespace = (c >= 0x09 && c <= 0x0d) || c == 0x20 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
                c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
            if (!whitespace) return false;
        }
        return true;
    }
    /** Bounded exponential reconnect and reconciliation delay: 2 s doubling to at most 60 s. */
    static long backoff(int failures) { return Math.min(60000L, 2000L << Math.min(5, Math.max(0, failures - 1))); }
    /**
     * A recognition that captured audio but returned no text is a missing reply, not a failure: re-arm and listen
     * again, matching the Assistant client. Canceled recognition and other failures still surface to the user.
     */
    static boolean shouldRetryEmptyTranscript(boolean success, boolean canceled, String error) {
        return !success && !canceled && "empty_transcript".equals(error);
    }
    static String message(String code) {
        switch (code) {
            case "voice_target_required": return "Choose a thread for voice input.";
            case "voice_busy": return "Stop the current voice interaction before recording.";
            case "voice_not_ready": return "Voice is not ready to record yet.";
            case "voice_not_listening": return "Voice is not recording.";
            case "voice_not_speaking": return "Voice is not speaking.";
            case "connection_changed": return "The Sedes connection changed before the voice action finished.";
            case "authentication_required": return "Pair this Sedes connection before using voice.";
            case "connection_unavailable": return "Sedes could not be reached for voice. Check the connection, then retry.";
            case "session_unavailable": return "Sedes did not start a voice session. Retry the voice connection.";
            case "credential_storage_unavailable": return "This device's secure credential storage could not be read. Retry the voice connection.";
            case "voice_storage_unavailable": return "This device's private voice storage is unavailable.";
            case "voice_settings_reset": return "Saved voice settings could not be read and were reset to defaults.";
            case "voice_origin_reset": return "This device's voice identity could not be read and was replaced.";
            case "voice_journal_reset": return "Pending voice input recovery records could not be read and were cleared.";
            case "voice_journal_capacity": return "Too many voice inputs are awaiting recovery. Resume or discard them in Voice settings.";
            case "connection_identity_changed": return "The Sedes identity changed. Refresh the connection before using voice.";
            case "settings_revision_conflict": return "Voice settings changed. Refresh and try again.";
            case "microphone_permission_required": return "Allow microphone access from the visible app.";
            case "adapter_required": return "Set the voice adapter URL before enabling voice.";
            case "client_protocol_mismatch": return "Update Sedes and this Android app to matching versions.";
            case "notification_stream_rejected": return "Sedes rejected the voice notification stream. Voice keeps retrying; recording remains available.";
            case "notification_policy_unavailable": return "Sedes did not send notification policy. Voice keeps retrying; recording remains available.";
            case "invalid_notification_frame": return "Sedes sent a voice notification this app could not read.";
            case "input_outcome_uncertain": return "Input delivery is uncertain. Sedes keeps checking; Resume retries the same input and Discard removes it.";
            case "input_rejected": return "Sedes rejected the recognized input. It was not delivered.";
            case "input_recovery_not_found": return "That voice input is no longer awaiting recovery.";
            case "input_failed": return "Sedes received the input but could not deliver it to the agent.";
            case "input_recovery_required": return "Sedes received the input, but its delivery requires recovery in the thread.";
            case "input_cancelled": return "The received input was cancelled in Sedes.";
            case "adapter_disconnected": return "The voice adapter disconnected. Voice reconnects automatically.";
            case "adapter_handshake_timeout": return "The voice adapter did not respond. Voice keeps retrying.";
            case "adapter_protocol_error": return "The voice adapter sent a message this app could not read.";
            case "adapter_message_too_large": return "The voice adapter sent an audio message larger than 8 MiB.";
            case "speech_request_rejected": return "The voice adapter rejected the speech request.";
            case "speech_failed": return "The voice adapter could not synthesize speech.";
            case "speech_timeout": return "Speech did not finish in time.";
            case "speech_duration_limit": return "This speech request exceeded the ten-minute audio limit. Reduce the adapter text limit to split it into smaller requests.";
            case "speech_storage_limit": return "This speech request exceeded the bounded audio storage limit.";
            case "speech_storage_unavailable": return "Speech could not be buffered in this device's private cache.";
            case "audio_focus_unavailable": return "Another app is using audio. Voice could not take audio focus.";
            case "audio_focus_lost": return "Another app took audio focus and interrupted voice.";
            case "empty_pcm_stream": return "The voice adapter returned no audio.";
            case "playback_drain_timeout": return "Speech audio did not finish playing in time.";
            case "invalid_pcm": case "unsupported_pcm_encoding": return "The voice adapter sent audio this app cannot play.";
            case "microphone_device_unavailable": return "The selected microphone is unavailable. Choose another input in Voice settings.";
            case "microphone_route_failed": return "Android could not route recording to the selected microphone.";
            case "microphone_limit_reached": return "The recording reached its maximum length.";
            case "recognition_failed": return "Speech could not be recognized.";
            case "recognition_timeout": case "recognition_capture_timeout": case "recognition_result_timeout": return "Speech recognition did not finish in time.";
            case "recognition_cue_timeout": return "The recognition start cue did not finish playing.";
            case "recognition_transport_overflow": return "Recorded audio could not be sent to the voice adapter fast enough.";
            case "recognized_text_too_large": return "The recognized text exceeds the input size limit.";
            case "resume_from_visible_app": case "foreground_start_rejected": return "Resume voice from the visible app.";
            case "target_unavailable": return "The selected thread is unavailable for voice input.";
            case "invalid_input_context": return "Sedes returned thread state this app could not read.";
            default:
                if (code.startsWith("microphone_")) return "The microphone could not record (" + code + ").";
                if (code.startsWith("playback_") || code.startsWith("speech_")) return "Speech playback failed (" + code + ").";
                return "Voice could not complete this action (" + code + ").";
        }
    }
}
