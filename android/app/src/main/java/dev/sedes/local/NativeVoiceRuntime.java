package dev.sedes.local;

import android.content.Context;
import android.content.Intent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
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
import java.util.function.BiConsumer;
import okhttp3.Call;
import org.json.JSONArray;
import org.json.JSONObject;

/** Single native owner of settings, transient voice work and durable input recovery. */
final class NativeVoiceRuntime implements NativeVoiceAudio.Listener, NativeClientControls.Owner {
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
    private final NativeDictationStore dictations;
    private NativeDictationStore.Recording retainedDictation;
    private boolean dictationLoading, dictationOperationPending, dictationStorageError;
    private long dictationOperationRevision;
    private final Set<String> discardedDictations = new HashSet<>();
    private final NativeVoiceHttp http = new NativeVoiceHttp();
    private final NativeClientControls clientControls;
    private String clientConnectionToken;
    private final NativeClientActionQueue clientActions = new NativeClientActionQueue();
    interface RecordingBackend {
        Call preflight(NativeVoiceSettings settings, String credential, NativeSpeechCatalog.PreflightResult result);
        NativeSpeechTransport open(NativeSpeechTransport.Config config);
    }
    private final RecordingBackend recordingBackend;
    private NativeSpeechTransport speech;
    private String speechCredential;
    private boolean speechCredentialError;
    private String catalogStatus = "idle", catalogError;
    private JSONObject speechCatalog;
    private NativeSpeechCatalogCache catalogCache;
    private Call catalogCall, credentialTestCall;
    private Reply credentialTestReply;
    private long speechGeneration, catalogGeneration;
    private final NativeVoiceAudio audio;
    private final NativeVoiceQueue queue = new NativeVoiceQueue();
    private final CopyOnWriteArrayList<Observer> observers = new CopyOnWriteArrayList<>();
    private final ArrayDeque<JSONObject> errors = new ArrayDeque<>();
    private final Map<String, Call> admissions = new HashMap<>();
    private final Set<String> cancelledAdmissions = new HashSet<>();
    /** Only live-process inputs proved not to have been admitted may resume automatically on control reconnect. */
    private final Set<String> waitingClientAdmissions = new HashSet<>();
    /** Journal exists, but its first durable handoff still owns the initial Send. */
    private final Set<String> preparingAdmissions = new HashSet<>();
    private final Map<String, Recovery> recoveries = new HashMap<>();
    private NativeVoiceSettings settings = NativeVoiceSettings.defaults();
    private String profileId, origin, identity, binding, credential, csrf, originId;
    private String phase = "off", foregroundThread, foregroundTitle, composerMode = "queue";
    private JSONObject nextRecordingTarget;
    private boolean foregroundVisible, sessionStarted, policyKnown, streamFailureReported;
    private int streamFailures;
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
    /** Audio callbacks submit to the bounded coordinator directly, never an unbounded actor PCM queue. */
    private volatile Active captureOwner;
    private String pendingOpenThread, pendingOpenProfile, pendingOpenOrigin, pendingOpenIdentity;
    private String published;
    private volatile JSONObject state;
    private static final class Active {
        final String id, event, noticeThread, noticeTitle;
        String targetId, targetTitle, ttsId, recordingId, cueId;
        volatile String captureId;
        String lastAudioId;
        String completionCueId;
        boolean retryAfterCompletionCue;
        Runnable afterCompletionCue;
        boolean automatic, followUp, stopped, recognitionFinalized, submissionNotified, clientVoiceOnly;
        long clientVoiceExpiresAt;
        NativeSpeechTransport.Request speechRequest;
        volatile NativeVoiceRecording recording;
        NativeSpeechTransport recognitionTransport;
        NativeDictationStore.Recording record;
        NativeVoiceSettings recordingSettings;
        RecordingStart recordingStart;
        Call preflight;
        volatile NativeVoiceCapturePolicy capturePolicy;
        final Object captureLock = new Object();
        boolean adopted, defaultHeld, keepListening, reconnecting, recordingMutationPending, recoveryRecognition, recoverySend;
        volatile boolean captureStopping, captureEnded, endpointReached;
        boolean finishIntentSaved, finishQueued;
        boolean frozenSteer;
        long lastPcmElapsed, longDictationDeadline;
        String frozenOrigin, mutationId, recordingBinding;
        String completedText;
        boolean completedMaySubmit, completionReceived;
        NativeVoiceRecording.FinishReason finishReason;
        NativeVoiceCapturePolicy.End endpoint;
        /** A server notification; null for manual work and replays, so notification-only paths skip them. */
        final NativeVoiceQueue.Item notification;
        /** A local, user-requested replay: no envelope, follow-up, client turn action, or automatic policy. */
        final NativeVoiceQueue.Item replay;
        final List<String> chunks;
        int chunk;
        JSONObject admission;
        Active(NativeVoiceQueue.Item item, int limit) {
            id = item.id; event = item.event; noticeThread = item.threadId; noticeTitle = item.threadTitle;
            targetId = item.targetId(); targetTitle = targetId != null && targetId.equals(item.threadId) ? item.threadTitle : null;
            automatic = item.automatic; followUp = item.followUp;
            notification = item.isReplay() ? null : item; replay = item.isReplay() ? item : null;
            chunks = NativeVoiceQueue.chunks(item.speech, limit);
        }
        Active(String threadId, String title) {
            id = UUID.randomUUID().toString(); event = "manual"; noticeThread = threadId; noticeTitle = title;
            targetId = threadId; targetTitle = title; notification = null; replay = null; chunks = new ArrayList<>();
        }
    }
    /** In-memory read-only reconciliation of one journaled input for the current binding. */
    private static final class Recovery { long token; Call call; int attempts; boolean reported; }
    private static final class RecordingStart {
        // Journal and adopted snapshot are written/read only by the serial worker until its callback publishes them.
        NativeDictationStore.Journal journal;
        NativeDictationStore.Recording adopted;
        volatile boolean cancelled;
    }
    private NativeVoiceRuntime(Context context) {
        this(context, new RecordingBackend() {
            public Call preflight(NativeVoiceSettings settings, String credential, NativeSpeechCatalog.PreflightResult result) {
                return NativeSpeechCatalog.preflight(settings, credential, result);
            }
            public NativeSpeechTransport open(NativeSpeechTransport.Config config) { return new NativeSpeechTransport(config, SystemClock::elapsedRealtime); }
        });
    }
    NativeVoiceRuntime(Context context, RecordingBackend recordingBackend) {
        this.recordingBackend = recordingBackend;
        this.context = context; store = new NativeVoiceStore(context); dictations = new NativeDictationStore(context);
        HandlerThread thread = new HandlerThread("sedes-native-voice"); thread.start(); handler = new Handler(thread.getLooper());
        audio = new NativeVoiceAudio(context, this);
        clientControls = new NativeClientControls(http, handler, this);
        publish();
        // Retirement does not depend on pairing or configuring voice, and failures remain visible in native state.
        handler.post(() -> {
            try { new SpeechCredentialStore(context); }
            catch (Exception error) { speechCredentialError = true; report("speech_credential_cleanup_failed"); }
        });
    }
    JSONObject snapshot() { return NativeVoiceJson.copy(state); }
    void observe(Observer observer) { observers.add(observer); audio.monitorDevices(true); handler.post(this::deliverPendingOpen); }
    void unobserve(Observer observer) { observers.remove(observer); if (observers.isEmpty()) audio.monitorDevices(false); }
    @Override public void inputDevicesChanged() { handler.post(() -> emit("inputDevicesChanged", NativeVoiceJson.object("devices", audio.devices()))); }
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
                    case "refreshSpeechCatalog":
                        NativeVoiceJson.keys(args, "force");
                        if (binding == null) throw new IllegalStateException("authentication_required");
                        refreshSpeechCatalog(NativeVoiceJson.bool(args, "force")); break;
                    case "setForegroundContext": foreground(args); break;
                    case "setNextRecordingTarget": setNextRecordingTarget(args); break;
                    case "startManualListen": manual(args); break;
                    case "speakReply": speakReply(args); break;
                    case "retargetActiveRecognition": retarget(args, reply); return;
                    case "setKeepListening": setKeepListening(args, reply); return;
                    case "sendRecording": sendRecording(args); break;
                    case "retryRecordingRecognition": retryRecordingRecognition(args, reply); return;
                    case "sendRecoveredRecording": sendRecoveredRecording(args, reply); return;
                    case "readRecognizedRecordingText": readRecognizedRecordingText(args, reply); return;
                    case "copyRecognizedRecordingText": copyRecognizedRecordingText(args, reply); return;
                    case "discardRecording": discardRecording(args, reply); return;
                    case "skipCurrentPlayback": NativeVoiceJson.keys(args); skip(); break;
                    case "stopCurrentInteraction":
                        NativeVoiceJson.keys(args, "interactionId");
                        requireInteraction(NativeVoiceJson.string(args, "interactionId", 160)); stopInteraction(); break;
                    case "resumeInput": NativeVoiceJson.keys(args, "mutationId"); resumeInput(NativeVoiceJson.string(args, "mutationId", 160)); break;
                    case "discardInput": NativeVoiceJson.keys(args, "mutationId"); discardInput(NativeVoiceJson.string(args, "mutationId", 160)); break;
                    case "listInputDevices": NativeVoiceJson.keys(args); reply.done(NativeVoiceJson.object("devices", audio.devices())); return;
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
        NativeVoiceJson.keys(args, "profileId", "serverOrigin", "identity", "reconnect");
        boolean reconnect = args.has("reconnect") && NativeVoiceJson.bool(args, "reconnect");
        String nextProfile = NativeVoiceJson.string(args, "profileId", 160);
        String nextOrigin = NativeVoiceSettings.origin(NativeVoiceJson.string(args, "serverOrigin", 2048));
        String expectedIdentity = NativeVoiceJson.string(args, "identity", 64);
        if (!expectedIdentity.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("voice_identity_invalid");
        if (nextProfile.equals(profileId) && nextOrigin.equals(origin) && expectedIdentity.equals(identity) && binding != null && csrf != null) {
            if (reconnect && dictationStorageError) {
                if (active != null || dictationLoading || dictationOperationPending) throw new IllegalStateException("recording_operation_pending");
                restoreDictation(connectionGeneration, () -> {
                    if (!dictationStorageError) { phase = "off"; clientControls.reconnect(true); recoverOutstanding(); }
                    publish(); reply.done(snapshot());
                });
                return;
            }
            if (clientConnectionToken == null || reconnect) clientControls.reconnect(reconnect);
            reply.done(snapshot()); return;
        }
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
                // Device preferences combine with only this authenticated binding's saved thread selection.
                settings = record(owner, () -> store.settings(owner));
                audio.configure(settings); configureSpeech(true, true); publish();
            } catch (Exception error) { connectionFailed("voice_storage_unavailable", reply); return; }
            loadSession(generation, () -> restoreDictation(generation, () -> {
                phase = "off"; refreshSpeechCatalog(true);
                clientControls.connect(origin, credential);
                publish(); reply.done(snapshot());
            }),
                code -> {
                    if (generation == connectionGeneration) connectionFailed(code, null);
                    reply.failed(code, message(code));
                });
        }));
    }
    private static final String[] CLIENT_VOICE_FIELDS = { "audioMode", "voiceThreadId", "pinDefaultVoiceThread",
        "autoListen", "onlyVoiceThread", "ignoreOtherDevices", "followComposerMode" };
    public JSONObject clientState() {
        JSONObject voice = new JSONObject();
        for (String field : CLIENT_VOICE_FIELDS) NativeVoiceJson.put(voice, field, settings.value.opt(field));
        return NativeVoiceJson.object("runtime", NativeVoiceJson.object("foreground", nativeVisible,
            "voiceReady", canListen(), "interactionActive", active != null),
            "settings", NativeVoiceJson.object("revision", settings.revision, "voice", voice));
    }
    public void clientRegistered(String clientId, String token) {
        originId = clientId; clientConnectionToken = token; publish();
        resumeEnabledSession(); resumeClientAdmissions(); recoverOutstanding(); deliverPendingOpen();
    }
    public String clientCsrf() { return csrf; }
    public void refreshClientSession(Runnable ready, Runnable retry) {
        final long generation = connectionGeneration;
        loadSession(generation, ready, code -> { if (generation == connectionGeneration) retry.run(); });
    }
    public void clientAuthenticationLost() { authenticationLost(401, connectionGeneration); }
    public void clientReplaced() { report("client_connection_replaced"); }
    public void clientDisconnected() {
        clientConnectionToken = null; clientActions.clear();
        // Full disconnect also calls here; let its teardown finish before advancing queued speech.
        if (cancelPreparingClientVoice()) handler.post(this::drain);
        publish();
    }
    private JSONObject clientResult(String status, String reason) {
        JSONObject result = NativeVoiceJson.object("status", status, "state", clientState());
        if (reason != null) NativeVoiceJson.put(result, "reason", reason);
        return result;
    }
    public JSONObject clientCommand(JSONObject command) {
        try {
            NativeVoiceJson.keys(command, "id", "action", "expiresAt", "sourceThreadId", "sourceTurnId", "threadId", "threadTitle",
                "listen", "expectedRevision", "patch", "replyEventId", "turnId", "assistantResult");
            String id = NativeVoiceJson.string(command, "id", 128), action = NativeVoiceJson.string(command, "action", 32);
            NativeVoiceJson.string(command, "sourceThreadId", 128); NativeVoiceJson.string(command, "sourceTurnId", 128);
            long expires = NativeVoiceJson.integer(command, "expiresAt", 0, Long.MAX_VALUE);
            if (expires <= System.currentTimeMillis()) return clientResult("noop", "expired");
            if (action.equals("settings.get")) return clientResult("applied", null);
            if (action.equals("settings.update")) {
                JSONObject patch = NativeVoiceJson.copy(NativeVoiceJson.requiredObject(command, "patch"));
                NativeVoiceJson.keys(patch, CLIENT_VOICE_FIELDS);
                if (patch.has("voiceThreadId")) NativeVoiceJson.put(patch, "voiceThreadTitle",
                    patch.isNull("voiceThreadId") ? null : NativeVoiceJson.nullableString(command, "threadTitle", 512));
                long before = settings.revision;
                try { updateSettings(NativeVoiceJson.object("expectedRevision", NativeVoiceJson.integer(command, "expectedRevision", 0, Long.MAX_VALUE), "patch", patch), true); }
                catch (Exception error) {
                    // Settings persist before permission/foreground/setup gates. Report what actually happened.
                    if (settings.revision != before) { publish(); emit("settingsChanged", snapshot()); }
                    return clientResult(settings.revision != before ? "applied" : "failed", code(error));
                }
                return clientResult("applied", sessionStartId != null ? "voice_starting" : null);
            }
            if (action.equals("turn_settled")) {
                if (!clientActions.settle(id, NativeVoiceJson.nullableString(command, "replyEventId", 128), expires)) return clientResult("noop", "superseded");
                applyClientActions(); return clientResult("accepted", "waiting_for_playback_drain");
            }
            if (action.equals("replay_turn")) {
                // Immediate and never staged: a staged action would suppress its source turn's follow-up listen.
                JSONObject request = clientReplayRequest(command);
                if (!settings.active()) return clientResult("noop", "voice_off");
                String reason;
                try { reason = queueReplay(request).reason; }
                catch (Exception refused) { reason = code(refused); }
                finally { publish(); }
                return clientResult(replayCommandStatus(reason), reason);
            }
            if (!action.equals("end_interaction") && !action.equals("switch_thread")) throw new IllegalArgumentException("invalid_client_action");
            if (action.equals("end_interaction") && (!settings.active() || !sessionStarted)) return clientResult("noop", "no_active_voice_interaction");
            boolean voiceOnly = false;
            if (action.equals("switch_thread")) {
                NativeVoiceJson.string(command, "threadId", 128);
                boolean listen = NativeVoiceJson.bool(command, "listen");
                if (!nativeVisible || observers.isEmpty()) {
                    if (!listen) return clientResult("noop", "client_in_background");
                    if (!settings.active()) return clientResult("noop", "voice_off");
                    if (!canListen()) return clientResult("noop", "voice_not_ready");
                    if (defaultHeldBlocked() || savedDictationBlocks() || active != null && (active.adopted || active.defaultHeld))
                        return clientResult("noop", "saved_recording_pending");
                    if (blockingDictation()) return clientResult("noop", "voice_not_ready");
                    if (active != null && !clientSourcePlayback(command)) return clientResult("noop", "voice_busy");
                    voiceOnly = true;
                }
            }
            clientActions.stage(command, inputSubmissionContext, voiceOnly, System.currentTimeMillis());
            if (active != null && clientSuppressesFollowup(active.notification)) active.followUp = false;
            handler.postDelayed(() -> clientActions.expire(System.currentTimeMillis()), Math.max(0, expires - System.currentTimeMillis()));
            if (voiceOnly) return clientResult("accepted", "voice_only_after_turn_completion_and_playback");
            return clientResult("accepted", action.equals("switch_thread") && command.optBoolean("listen") && !settings.active()
                ? "navigation_accepted_voice_off" : "after_turn_completion_and_playback");
        } catch (Exception error) { return clientResult("failed", code(error)); }
    }
    private static final String[] CLIENT_REPLAY_FIELDS = { "threadId", "turnId", "assistantResult", "threadTitle" };
    /** A replay_turn command's replay, validated exactly as the bridge's speakReply arguments are. */
    static JSONObject clientReplayRequest(JSONObject command) {
        JSONObject args = new JSONObject();
        for (String field : CLIENT_REPLAY_FIELDS) if (command.has(field)) NativeVoiceJson.put(args, field, command.opt(field));
        return NativeVoiceQueue.replayRequest(args);
    }
    /** A replay_turn result status for its reason: a ReplayDisposition reason, voice_off, or a queueReplay refusal code. */
    static String replayCommandStatus(String reason) {
        switch (reason) {
            case "replay_playing": case "replay_queued": return "applied";
            case "replay_already_queued": case "voice_off": case "voice_not_ready": return "noop";
            default: return "failed";
        }
    }
    private static String clientTurn(NativeVoiceQueue.Item item) {
        // A local replay has no server envelope and no client turn actions.
        if (item == null || item.envelope == null) return null;
        JSONObject turn = item.envelope.optJSONObject("payload").optJSONObject("turn");
        return turn == null ? null : turn.optString("id", null);
    }
    private boolean clientSuppressesFollowup(NativeVoiceQueue.Item item) {
        return item != null && clientActions.suppresses(item.threadId, clientTurn(item), System.currentTimeMillis());
    }
    private boolean clientSourcePlayback(JSONObject command) {
        return active != null && active.notification != null && (phase.equals("synthesizing") || phase.equals("speaking")) &&
            active.notification.threadId.equals(command.optString("sourceThreadId")) &&
            Objects.equals(clientTurn(active.notification), command.optString("sourceTurnId"));
    }
    /** Explicit user controls supersede a pending agent start, including its asynchronous target validation. */
    private boolean cancelPreparingClientVoice() {
        if (active == null || !active.clientVoiceOnly || !(phase.equals("validating") || phase.equals("arming"))) return false;
        cancelActive(false, "client_action_superseded"); return true;
    }
    private void clientReplyDrained(String id) { clientActions.drained(id); applyClientActions(); }
    private void applyClientActions() {
        if (active != null && (active.adopted || active.defaultHeld) || blockingDictation()) { clientActions.clear(); return; }
        NativeVoiceQueue.Item notification = active == null ? null : active.notification;
        for (NativeClientActionQueue.Action action : clientActions.takeReady(System.currentTimeMillis(), sessionStarted && settings.active(),
                notification == null ? null : notification.threadId, clientTurn(notification), inputSubmissionContext)) {
            JSONObject command = action.command;
            if (!command.optString("action").equals("switch_thread")) continue;
            if (action.voiceOnly) {
                if (defaultHeldBlocked()) { report("saved_recording_pending"); continue; }
                if (!canListen()) { report("voice_not_ready"); continue; }
                if (active != null) { report("voice_busy"); continue; }
                // Reserve audio ownership before validating the exact target. This action never navigates,
                // even if the activity returned while its source turn or spoken reply was finishing.
                active = new Active(command.optString("threadId"), NativeVoiceJson.nullableString(command, "threadTitle", 512));
                active.clientVoiceOnly = true; active.clientVoiceExpiresAt = command.optLong("expiresAt");
                validateTarget(active, false);
                continue;
            }
            if (!nativeVisible || observers.isEmpty()) continue;
            final long generation = connectionGeneration;
            final String token = clientConnectionToken, target = command.optString("threadId");
            http.request(origin, credential, null, "GET", "/api/threads/" + Uri.encode(target) + "/input-context", null, (status, value, error) -> handler.post(() -> {
                if (generation != connectionGeneration || !nativeVisible || !Objects.equals(token, clientConnectionToken) ||
                    command.optLong("expiresAt") <= System.currentTimeMillis() || inputSubmissionContext != action.navigationContext) return;
                if (status != 200 || value == null || !target.equals(value.optString("threadId"))) { report("target_unavailable"); return; }
                try { NativeVoiceProtocol.inputContext(value); } catch (Exception invalid) { report("invalid_input_context"); return; }
                JSONObject event = NativeVoiceJson.object("threadId", target, "profileId", profileId, "serverOrigin", origin,
                    "identity", identity, "connectionGeneration", connectionGeneration);
                main.post(() -> {
                    if (!nativeVisible || inputSubmissionContext != action.navigationContext || generation != snapshot().optLong("connectionGeneration")) return;
                    for (Observer observer : observers) observer.event("openThread", event);
                    if (command.optBoolean("listen")) handler.post(() -> {
                        if (!nativeVisible || generation != connectionGeneration || !Objects.equals(token, clientConnectionToken)) return;
                        if (defaultHeldBlocked()) { report("saved_recording_pending"); return; }
                        if (!canListen() || active != null || blockingDictation()) { report("voice_not_ready"); return; }
                        // Exact one-shot target; neither autoListen nor the pinned default redirects it.
                        active = new Active(target, NativeVoiceJson.nullableString(command, "threadTitle", 512)); validateTarget(active, false);
                    });
                });
            }));
        }
    }
    private static JSONObject externalInputRequest(JSONObject request) {
        JSONObject body = NativeVoiceJson.copy(request); body.remove("origin"); return body;
    }
    private void connectionFailed(String code, Reply reply) {
        inputSubmissionContext = new Object();
        invalidateSpeechMetadata();
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
        clientControls.disconnect();
        waitingClientAdmissions.clear(); preparingAdmissions.clear();
        inputSubmissionContext = new Object();
        nextRecordingTarget = null;
        // Cancellation intent covers every journaled input, including the active admission.
        if (cancelIntended) cancelOutstanding(false);
        cancelActive(false, "connection_changed");
        for (Recovery recovery : recoveries.values()) if (recovery.call != null) recovery.call.cancel();
        recoveries.clear();
        queue.reset(); connectionGeneration++; stateRevision = 0;
        errors.clear();
        stopSession(); binding = null; identity = null; originId = null; csrf = null; credential = null;
        invalidateSpeechMetadata(); speechCredential = null; speechCredentialError = false;
        profileId = null; origin = null; settings = NativeVoiceSettings.defaults(); phase = "off";
        retainedDictation = null; dictationLoading = false; dictationOperationPending = false; dictationStorageError = false; dictationOperationRevision++;
        policyGeneration = -1;
        foregroundVisible = false; foregroundThread = null; foregroundTitle = null;
        publish();
    }
    private void updateSettings(JSONObject args, boolean userInitiated) throws Exception {
        NativeVoiceJson.keys(args, "expectedRevision", "patch");
        if (binding == null) throw new IllegalStateException("authentication_required");
        NativeVoiceSettings previous = settings;
        NativeVoiceSettings next = settings.patch(NativeVoiceJson.integer(args, "expectedRevision", 0, Long.MAX_VALUE), NativeVoiceJson.requiredObject(args, "patch"));
        if (recordingBusy() && captureSettingsChanged(previous, next)) throw new IllegalStateException("recording_settings_busy");
        store.settings(binding, next); settings = next; audio.configure(next);
        if (!previous.speechConfigurationEquals(next)) configureSpeech(
            !previous.text("speechProvider").equals(next.text("speechProvider")) ||
                !previous.text("speechEndpoint").equals(next.text("speechEndpoint")), catalogConfigurationChanged(previous, next));
        if (catalogConfigurationChanged(previous, next)) refreshSpeechCatalog(true);
        else if (!previous.active() && next.active()) refreshSpeechCatalog(false);
        if (!next.active()) {
            nextRecordingTarget = null;
            clientActions.clear();
            cancelOutstanding(true); cancelActive(true, "voice_off"); queue.clear("voice_off"); stopSession(); phase = "off";
        } else {
            if (!next.flag("autoListen")) { queue.cancelFollowups(); if (active != null) active.followUp = false; }
            if (!previous.mode().equals(next.mode()) && active != null && active.automatic && active.admission == null)
                cancelActive(true, "audio_mode_changed");
            queue.reconfigure(next);
            if (!next.flag("autoListen") && active != null && active.automatic && !phase.equals("submitting") &&
                (phase.equals("validating") || phase.equals("arming") || phase.equals("listening") || phase.equals("recognizing"))) cancelActive(true, "auto_listen_disabled");
            if (active != null && active.automatic && active.notification != null && !eligible(active.notification)) cancelActive(true, "voice_filter_changed");
            if (!sessionStarted && userInitiated) requestSessionStart();
        }
        publish(); emit("settingsChanged", snapshot()); drain();
    }
    private static boolean speechIndependent(Active item) { return item.recognitionFinalized || item.admission != null; }
    private void resumeEnabledSession() {
        if (nativeVisible && binding != null && csrf != null && originId != null && settings.active() && audio.hasPermission() &&
            speechReady()) scheduleSessionStart();
    }
    private void requestSessionStart() {
        if (sessionStarted || sessionStartId != null) return;
        // Cached settings are visible before session bootstrap finishes. Save mode edits now; bootstrap starts voice.
        if (csrf == null) return;
        if (!nativeVisible) throw new IllegalStateException("resume_from_visible_app");
        if (!audio.hasPermission()) throw new IllegalStateException("microphone_permission_required");
        if (!speechReady()) throw new IllegalStateException("speech_configuration_required");
        scheduleSessionStart();
    }
    private void scheduleSessionStart() {
        if (sessionStarted || sessionStartId != null) return;
        errors.removeIf(error -> "foreground_start_rejected".equals(error.optString("code")));
        final String startId = UUID.randomUUID().toString();
        sessionStartId = startId;
        phase = "starting";
        final long generation = connectionGeneration;
        // Registration can schedule a start without another state change before Android launches the service.
        publish();
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
            sessionStarted = true; phase = "idle"; connectEvents(); drain(); publish();
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
        handler.post(() -> {
            if (this.service != service) return;
            this.service = null; sessionStarted = false; clientActions.discardVoiceOnly();
            // A replay is a request for now, not for whenever the service next starts; drain would not filter it later.
            queue.clearReplays(); cancelActive(false, "service_stopped"); closeSpeech(); closeEvents(); phase = "off"; publish();
        });
    }
    private void stopSession() {
        sessionStartId = null; sessionStarted = false; clientActions.discardVoiceOnly(); closeSpeech(); audio.stop(); closeEvents();
        streamFailures = 0; streamFailureReported = false;
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
        boolean cancelledVoice = false;
        if (foregroundVisible && nextVisible && !Objects.equals(foregroundThread, nextThread)) {
            clientActions.discardVoiceOnly(); cancelledVoice = cancelPreparingClientVoice();
        }
        if (foregroundVisible != nextVisible || !Objects.equals(foregroundThread, nextThread)) inputSubmissionContext = new Object();
        foregroundVisible = nextVisible;
        foregroundThread = nextThread;
        foregroundTitle = foregroundVisible ? title : null;
        if (mode != null) composerMode = mode;
        if (cancelledVoice) drain();
    }
    private void closeSpeech() {
        if (speech != null) speech.close();
        speech = null;
    }
    private void configureSpeech(boolean reloadCredential, boolean invalidateCatalog) {
        // Recordings own a frozen transport. Playback-only edits cannot close their socket or erase their audio.
        if (active != null && (active.recordingId == null || active.captureEnded && active.recording == null) && !speechIndependent(active)) cancelActive(true, "speech_configuration_changed");
        closeSpeech(); invalidateCredentialTest();
        if (invalidateCatalog) invalidateSpeechCatalog();
        if (reloadCredential) {
            speechCredential = null; speechCredentialError = false;
            try {
                SpeechCredentialStore credentials = new SpeechCredentialStore(context);
                if (profileId != null && !settings.text("speechEndpoint").isEmpty())
                    speechCredential = credentials.getCredential(settings.text("speechProvider"), settings.text("speechEndpoint"));
            } catch (Exception error) {
                speechCredentialError = true;
                report("speech_credential_cleanup_failed".equals(error.getMessage()) ? "speech_credential_cleanup_failed" : "speech_credential_storage_unavailable");
            }
        }
        if (invalidateCatalog) restoreSpeechCatalog();
    }
    private void invalidateSpeechMetadata() {
        invalidateCredentialTest(); invalidateSpeechCatalog();
    }
    private void invalidateCredentialTest() {
        speechGeneration++;
        if (credentialTestCall != null) credentialTestCall.cancel();
        credentialTestCall = null;
        if (credentialTestReply != null) credentialTestReply.failed("speech_configuration_changed", message("speech_configuration_changed"));
        credentialTestReply = null;
    }
    private void invalidateSpeechCatalog() {
        catalogGeneration++;
        if (catalogCall != null) catalogCall.cancel();
        catalogCall = null;
        speechCatalog = null; catalogCache = null; catalogStatus = "idle"; catalogError = null;
    }
    private void restoreSpeechCatalog() {
        if (binding == null || speechCredentialError) return;
        try {
            catalogCache = store.speechCatalog(binding, NativeSpeechCatalogCache.scope(binding, settings, speechCredential));
            if (catalogCache != null) { speechCatalog = NativeVoiceJson.copy(catalogCache.catalog); catalogStatus = "ready"; }
        } catch (NativeVoiceStore.CorruptRecord error) {
            // Discovery is disposable; a damaged cache must not reset voice settings or prevent authentication.
            try { store.removeSpeechCatalog(binding); } catch (Exception ignored) {}
        } catch (Exception ignored) { /* Keep unreadable records intact and revalidate metadata over the network. */ }
    }
    private void discardStoredSpeechCatalog() {
        try { store.removeSpeechCatalog(binding); }
        catch (Exception ignored) { /* Credential changes must remain available even when disposable cache I/O fails. */ }
    }
    static boolean catalogConfigurationChanged(NativeVoiceSettings previous, NativeVoiceSettings next) {
        for (String key : new String[] { "speechProvider", "speechEndpoint", "sttModel", "ttsModel" })
            if (!previous.text(key).equals(next.text(key))) return true;
        return false;
    }
    /** Native dialog only: the bridge never accepts, returns or publishes provider secrets. */
    void speechCredentialAction(long expectedGeneration, long expectedRevision, String action, String secret, Reply reply) {
        handler.post(() -> {
            try {
                if (connectionGeneration != expectedGeneration) throw new IllegalStateException("connection_changed");
                if (binding == null) throw new IllegalStateException("authentication_required");
                if (settings.revision != expectedRevision) throw new IllegalStateException("settings_revision_conflict");
                if (!action.equals("test") && recordingBusy()) throw new IllegalStateException("recording_settings_busy");
                SpeechCredentialStore credentials = new SpeechCredentialStore(context);
                switch (action) {
                    case "save":
                        discardStoredSpeechCatalog();
                        credentials.setCredential(settings.text("speechProvider"), settings.text("speechEndpoint"), secret); break;
                    case "remove":
                        discardStoredSpeechCatalog();
                        credentials.removeCredential(settings.text("speechProvider"), settings.text("speechEndpoint")); break;
                    case "test":
                        if (secret == null && speechCredentialError) throw new IllegalStateException("speech_credential_storage_unavailable");
                        testSpeechCredential(secret == null ? speechCredential : secret, reply); return;
                    default: throw new IllegalArgumentException("unknown_voice_action");
                }
                configureSpeech(true, true); refreshSpeechCatalog(true); resumeEnabledSession(); publish(); drain(); reply.done(snapshot());
            } catch (Exception error) { String code = code(error); reply.failed(code, message(code)); }
        });
    }
    private void testSpeechCredential(String secret, Reply reply) {
        if (settings.text("speechEndpoint").isEmpty()) { reply.failed("speech_configuration_required", message("speech_configuration_required")); return; }
        if (secret != null) SpeechCredentialStore.validateCredential(secret);
        if (credentialTestCall != null) credentialTestCall.cancel();
        if (credentialTestReply != null) credentialTestReply.failed("speech_test_replaced", message("speech_test_replaced"));
        credentialTestReply = reply;
        long generation = speechGeneration, revision = settings.revision;
        credentialTestCall = NativeSpeechCatalog.test(settings, secret, (catalog, error) -> handler.post(() -> {
            if (generation != speechGeneration || credentialTestReply != reply) return;
            credentialTestReply = null; credentialTestCall = null;
            if (revision != settings.revision) { reply.failed("settings_revision_conflict", message("settings_revision_conflict")); return; }
            if (error != null) reply.failed(error, message(error)); else reply.done(snapshot());
        }));
    }
    /** Advisory only: callers return immediately; matching in-flight requests share one background refresh. */
    private void refreshSpeechCatalog(boolean force) {
        if (binding == null || speechCredentialError || speechCredential == null || settings.text("speechEndpoint").isEmpty()) return;
        if (catalogCall != null || (!force && catalogCache != null && catalogCache.fresh(System.currentTimeMillis()))) return;
        catalogStatus = "loading"; catalogError = null; publish();
        long generation = ++catalogGeneration;
        final String owner = binding, scope = NativeSpeechCatalogCache.scope(binding, settings, speechCredential);
        catalogCall = NativeSpeechCatalog.fetch(settings, speechCredential, (catalog, error) -> handler.post(() -> {
            if (generation != catalogGeneration || !owner.equals(binding)) return;
            catalogCall = null;
            String resultError = error;
            if (error == null) {
                try {
                    NativeSpeechCatalogCache next = new NativeSpeechCatalogCache(scope, System.currentTimeMillis(), catalog);
                    catalogCache = next; speechCatalog = NativeVoiceJson.copy(next.catalog);
                    try { store.speechCatalog(owner, next); }
                    catch (Exception ignored) { /* An unavailable cache never invalidates successful discovery or voice. */ }
                } catch (IllegalArgumentException invalid) { resultError = "speech_discovery_invalid"; }
            } else if (error.equals("speech_authentication_failed")) {
                speechCatalog = null; catalogCache = null; discardStoredSpeechCatalog();
            }
            // Transport/server/malformed replies preserve choices; explicit authentication rejection revokes them.
            catalogError = resultError; catalogStatus = resultError == null ? "ready" : "error";
            publish();
        }));
    }
    private boolean speechReady() { return !speechCredentialError && settings.configured(speechCredential != null); }
    private NativeSpeechTransport speechTransport() {
        if (!speechReady()) throw new IllegalStateException("speech_configuration_required");
        if (speech == null) speech = new NativeSpeechTransport(settings.speechConfig(speechCredential), SystemClock::elapsedRealtime);
        return speech;
    }
    private static boolean captureSettingsChanged(NativeVoiceSettings previous, NativeVoiceSettings next) {
        if (!Objects.equals(NativeVoiceInput.read(previous.value), NativeVoiceInput.read(next.value))) return true;
        for (String key : new String[] { "speechProvider", "speechEndpoint", "sttModel", "recognitionStartTimeoutMs", "recognitionCompletionTimeoutMs",
            "recognitionEndSilenceMs", "recognitionResultTimeoutMs", "longDictationTimeoutMs" })
            if (!Objects.equals(previous.value.opt(key), next.value.opt(key))) return true;
        return false;
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
            if (clientSuppressesFollowup(item)) item.followUp = false;
            if (!eligible(item) || (item.speech.isEmpty() && !item.followUp)) { if (queue.remember(item.id)) queue.drop("ineligible"); clientReplyDrained(item.id); publish(); return; }
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
        queue.clearAutomatic(reason);
        // A finalized transcript or already submitted message keeps its own admission semantics, as when settings change.
        if (active != null && active.automatic && !speechIndependent(active) && !phase.equals("submitting")) cancelActive(true, reason);
    }
    private void drain() {
        if (active != null || !sessionStarted || !speechReady() || binding == null || blockingDictation()) return;
        NativeVoiceQueue.Item item;
        while ((item = queue.take()) != null) {
            // Notification filters and policy govern automatic items only; a replay is the user's explicit request.
            if (item.automatic && !eligible(item)) { queue.drop("ineligible"); continue; }
            active = new Active(item, settings.number("speechTextLimit"));
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
        if (!speechReady()) { failActive("speech_configuration_required"); return; }
        item.ttsId = UUID.randomUUID().toString(); String request = item.ttsId;
        phase = "synthesizing"; item.lastAudioId = request; audio.begin(request); publish();
        item.speechRequest = speechTransport().speak(request, item.chunks.get(item.chunk), new NativeSpeechTransport.SpeechListener() {
            public void started(String id) {}
            public void pcm(String id, int sampleRate, byte[] bytes) { handler.post(() -> {
                if (active != item || !id.equals(item.ttsId)) return;
                audio.pcm(id, sampleRate, bytes);
                if (!phase.equals("speaking")) { phase = "speaking"; publish(); }
            }); }
            public void completed(String id) { handler.post(() -> {
                if (active == item && id.equals(item.ttsId)) { item.speechRequest = null; audio.end(id); }
            }); }
            public void failed(String id, NativeSpeechTransport.Failure failure) { speechFailed(id, failure.code); }
        });
        handler.postDelayed(() -> { if (active == item && request.equals(item.ttsId)) failActive("speech_timeout"); }, NativeVoiceAudio.MAX_STREAM_DURATION_MS + 60000);
    }
    private void afterSpeech(Active item) {
        if (active != item || item.stopped) return;
        item.ttsId = null;
        if (clientSuppressesFollowup(item.notification)) { finishItem(item); return; }
        if (!item.followUp || !settings.flag("autoListen") || item.notification == null || !eligible(item.notification) ||
            (settings.mode().equals("manual") && !item.event.equals("turn.completed"))) { finishItem(item); return; }
        validateTarget(item, true);
    }
    private void validateTarget(Active item, boolean automatic) {
        validateTarget(item, automatic, true);
    }
    private boolean clientVoiceStartCurrent(Active item) {
        if (!item.clientVoiceOnly) return true;
        if (item.clientVoiceExpiresAt <= System.currentTimeMillis()) {
            cancelActive(false, "expired"); drain(); return false;
        }
        if (!canListen()) { failActive("voice_not_ready"); return false; }
        return true;
    }
    private void validateTarget(Active item, boolean automatic, boolean playCue) {
        if (automatic && defaultHeldBlocked()) { finishItem(item); return; }
        phase = "validating"; publish();
        long generation = connectionGeneration;
        http.request(origin, credential, null, "GET", "/api/threads/" + Uri.encode(item.targetId) + "/input-context", null,
            (status, value, failure) -> handler.post(() -> {
                if (active != item || item.stopped || generation != connectionGeneration) return;
                if (!clientVoiceStartCurrent(item)) return;
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
        if (active != item || !sessionStarted || !speechReady() || !audio.hasPermission()) { failActive("voice_not_ready"); return; }
        if (defaultHeldBlocked()) { if (item.automatic) finishItem(item); else failActive("saved_recording_pending"); return; }
        if (item.automatic && (!settings.flag("autoListen") || !eligible(item.notification))) { finishItem(item); return; }
        phase = "arming"; item.cueId = UUID.randomUUID().toString(); publish();
        String cue = item.cueId;
        handler.postDelayed(() -> { if (active == item && cue.equals(item.cueId)) failActive("recognition_cue_timeout"); }, 15000);
        if (settings.flag("recognitionCues")) {
            item.lastAudioId = cue; audio.cue(cue, NativeVoiceCue.Kind.START, settings.number("cueGain"));
        } else capture(item);
    }
    private void capture(Active item) {
        if (active != item || item.stopped || !sessionStarted || !speechReady()) return;
        if (item.automatic && (!settings.flag("autoListen") || !eligible(item.notification))) { finishItem(item); return; }
        item.cueId = null;
        // The cue is asynchronous. A newer server activity epoch during it must prevent recording.
        if (item.automatic) validateTarget(item, true, false); else beginCapture(item);
    }
    private void beginCapture(Active item) {
        if (active != item || item.stopped || !sessionStarted || !speechReady()) return;
        if (!clientVoiceStartCurrent(item)) return;
        if (item.automatic && (!settings.flag("autoListen") || !eligible(item.notification))) { finishItem(item); return; }
        // This preference belongs to the new recording; later edits affect only the next capture.
        final boolean defaultHeld = settings.flag("keepListeningByDefault");
        if (defaultHeldBlocked()) { failActive("saved_recording_pending"); return; }
        item.defaultHeld = defaultHeld;
        if (defaultHeld) { item.automatic = false; clientActions.clear(); inputSubmissionContext = new Object(); }
        item.recordingId = UUID.randomUUID().toString(); item.captureId = UUID.randomUUID().toString();
        item.recordingBinding = binding; item.recordingSettings = settings; phase = "arming";
        item.adopted = false; item.keepListening = false; item.reconnecting = false; item.longDictationDeadline = 0;
        item.captureStopping = false; item.captureEnded = false; item.endpointReached = false; item.endpoint = null;
        item.finishReason = null; item.finishIntentSaved = false; item.finishQueued = false; item.completionReceived = false; item.recognitionFinalized = false;
        item.record = null; item.completedText = null; item.mutationId = null;
        item.capturePolicy = new NativeVoiceCapturePolicy(item.recordingSettings.number("recognitionStartTimeoutMs"),
            item.recordingSettings.number("recognitionCompletionTimeoutMs"), item.recordingSettings.number("recognitionEndSilenceMs"));
        final String id = item.recordingId, owner = binding, secret = speechCredential;
        final long generation = connectionGeneration;
        publish();
        item.preflight = recordingBackend.preflight(item.recordingSettings, secret, (capabilities, error) -> handler.post(() -> {
            if (!ownsRecording(item, id) || generation != connectionGeneration) return;
            item.preflight = null;
            if (error != null) { failActive(error); return; }
            RecordingStart starting = new RecordingStart(); item.recordingStart = starting;
            dictationWork(() -> {
                if (starting.cancelled) return starting;
                starting.journal = dictations.create(owner, id, item.targetId, item.targetTitle, recordingConfig(item.recordingSettings));
                // A held default must own its durable slot before any microphone or recognition transport starts.
                if (defaultHeld && !starting.cancelled) starting.adopted = starting.journal.adopt(true);
                return starting;
            }, (prepared, failure) -> {
                // Cancellation already queued its own cleanup directly behind creation, before any reconnect bootstrap.
                if (starting.cancelled) return;
                NativeDictationStore.Journal journal = prepared == null ? null : prepared.journal;
                if (!ownsRecording(item, id) || generation != connectionGeneration) {
                    if (journal != null) dictationWork(() -> { journal.discard(); return null; }, (ignored, ignoredError) -> {});
                    return;
                }
                if (failure != null) { failActive(code(failure)); return; }
                item.recordingStart = null;
                if (defaultHeld) {
                    item.record = prepared.adopted; acceptDictation(item.record);
                    item.adopted = true; item.keepListening = true;
                    item.capturePolicy.setHeld(true);
                    item.longDictationDeadline = SystemClock.elapsedRealtime() + item.recordingSettings.number("longDictationTimeoutMs");
                    scheduleLongDictationTimeout(item);
                }
                startRecordingCoordinator(item, journal, capabilities, secret, false);
                // Session configuration and microphone routing remain bounded independently of capture duration.
                handler.postDelayed(() -> {
                    if (ownsRecording(item, id) && phase.equals("arming")) failActive("recognition_capture_timeout");
                }, NativeSpeechCapabilities.MICROPHONE_ARMING_MS);
            });
        }));
    }
    private void startRecordingCoordinator(Active item, NativeDictationStore.Journal journal,
        NativeSpeechCapabilities capabilities, String secret, boolean retry) {
        final String id = item.recordingId;
        item.recognitionTransport = recordingBackend.open(item.recordingSettings.speechConfig(secret));
        final NativeSpeechTransport transport = item.recognitionTransport;
        item.recording = new NativeVoiceRecording(id, journal,
            (connectionId, listener) -> transport.openRecognition(connectionId, capabilities,
                item.recordingSettings.number("recognitionResultTimeoutMs"), listener),
            new NativeVoiceRecording.Listener() {
                public void ready(String recordingId) { handler.post(() -> {
                    if (!ownsRecording(item, recordingId) || retry || !phase.equals("arming")) return;
                    if (!clientVoiceStartCurrent(item)) return;
                    item.lastAudioId = item.captureId; captureOwner = item;
                    audio.record(item.captureId, NativeVoiceInput.read(item.recordingSettings.value));
                }); }
                public void changed(String recordingId, boolean reconnecting) { handler.post(() -> {
                    if (!ownsRecording(item, recordingId)) return;
                    item.reconnecting = reconnecting; publish();
                }); }
                public void journalChanged(String recordingId, NativeDictationStore.Recording record) { handler.post(() -> {
                    if (!ownsRecording(item, recordingId)) return;
                    item.record = record; acceptDictation(record); publish();
                }); }
                public void completed(String recordingId, String text, boolean maySubmit) { handler.post(() -> {
                    if (!ownsRecording(item, recordingId)) return;
                    item.completedText = text; item.completedMaySubmit = maySubmit; item.completionReceived = true;
                    maybeCompleteRecording(item);
                }); }
                public void failed(String recordingId, String reason, boolean retained) { handler.post(() -> {
                    if (!ownsRecording(item, recordingId)) return;
                    recordingFailed(item, reason, retained);
                }); }
            }, capabilities.hardSegmentMs(), item.recordingSettings.number("recognitionResultTimeoutMs"));
        if (retry) item.recording.retry(); else item.recording.start(item.adopted);
    }
    private boolean ownsRecording(Active item, String id) {
        return active == item && !item.stopped && id != null && id.equals(item.recordingId);
    }
    private static JSONObject recordingConfig(NativeVoiceSettings settings) {
        JSONObject config = new JSONObject();
        for (String key : new String[] { "speechProvider", "speechEndpoint", "sttModel", "inputDevice", "recognitionStartTimeoutMs",
            "recognitionCompletionTimeoutMs", "recognitionEndSilenceMs", "recognitionResultTimeoutMs", "longDictationTimeoutMs",
            "recognizeStopCommand", "recognitionCues", "cueGain", "followComposerMode" }) NativeVoiceJson.put(config, key, settings.value.opt(key));
        return config;
    }
    private void manual(JSONObject args) {
        NativeVoiceJson.keys(args, "threadId", "threadTitle");
        String target = NativeVoiceJson.nullableString(args, "threadId", 512), title = NativeVoiceJson.nullableString(args, "threadTitle", 512);
        startManualRecording(manualTarget(NativeVoiceJson.object("threadId", target, "threadTitle", title), nextRecordingTarget,
            settings.value, NativeVoiceJson.object("visible", foregroundVisible, "threadId", foregroundThread, "threadTitle", foregroundTitle)), true);
    }
    /** Where queueReplay left a turn's replay; each reason is also the replay_turn client command's result reason. */
    enum ReplayDisposition {
        /** The replay is the active item: voice was idle. */
        PLAYING("replay_playing"),
        /** The replay waits behind current speech, recording, or saved-recording recovery. */
        QUEUED("replay_queued"),
        /** That thread and turn's replay was already active or pending; nothing was added. */
        DUPLICATE("replay_already_queued");
        final String reason;
        ReplayDisposition(String reason) { this.reason = reason; }
    }
    /** The bridge's speakReply: a duplicate is a successful no-op, and refusals fail the bridge call. */
    private void speakReply(JSONObject args) {
        queueReplay(NativeVoiceQueue.replayRequest(args));
    }
    /**
     * Queues one turn's reply behind current voice work for the bridge and the replay_turn client command alike.
     * Readiness matches an explicit Start, without microphone or notification policy. Throws voice_not_ready,
     * voice_reply_empty, or voice_queue_full; the request comes from NativeVoiceQueue.replayRequest.
     */
    private ReplayDisposition queueReplay(JSONObject request) {
        if (!sessionStarted || !settings.active() || !speechReady() || binding == null) throw new IllegalStateException("voice_not_ready");
        NativeVoiceQueue.Item item = NativeVoiceQueue.Item.replay(request, replayTitle(request), settings);
        if (active != null && active.replay != null && active.replay.replayIdentity().equals(item.replayIdentity())) return ReplayDisposition.DUPLICATE;
        if (!queue.addReplay(item)) return ReplayDisposition.DUPLICATE;
        drain();
        return active != null && active.replay == item ? ReplayDisposition.PLAYING : ReplayDisposition.QUEUED;
    }
    /** Display only: the WebView's non-blank title first, otherwise one this device already holds for the thread. */
    private String replayTitle(JSONObject request) {
        String threadId = request.optString("threadId"), provided = NativeVoiceJson.nullableString(request, "threadTitle", 512);
        if (provided != null && !blank(provided)) return provided;
        if (foregroundVisible && threadId.equals(foregroundThread) && foregroundTitle != null) return foregroundTitle;
        return threadId.equals(settings.text("voiceThreadId")) ? settings.text("voiceThreadTitle") : null;
    }
    /** Headset and notification Start always use the saved default, even while the app is visible. */
    private void startDefaultRecording() {
        startManualRecording(defaultRecordingTarget(settings.value), false);
    }
    private void startManualRecording(JSONObject selected, boolean consumeNextTarget) {
        clientActions.clear(); boolean cancelledVoice = cancelPreparingClientVoice(); inputSubmissionContext = new Object();
        try {
            if (!sessionStarted || !speechReady() || binding == null) throw new IllegalStateException("voice_not_ready");
            if (defaultHeldBlocked()) throw new IllegalStateException("saved_recording_pending");
            if (active != null || blockingDictation()) throw new IllegalStateException("voice_busy");
            String target = NativeVoiceJson.nullableString(selected, "threadId", 512), title = NativeVoiceJson.nullableString(selected, "threadTitle", 512);
            if (target == null) throw new IllegalStateException("voice_target_required");
            if (consumeNextTarget) nextRecordingTarget = null;
            active = new Active(target, title); validateTarget(active, false);
        } finally {
            // A successful manual start keeps priority over notifications queued behind the cancelled action.
            if (cancelledVoice && active == null) drain();
        }
    }
    private void setNextRecordingTarget(JSONObject args) {
        NativeVoiceJson.keys(args, "threadId", "threadTitle");
        String target = NativeVoiceJson.string(args, "threadId", 512), title = NativeVoiceJson.nullableString(args, "threadTitle", 512);
        if (binding == null) throw new IllegalStateException("authentication_required");
        if (!settings.active()) throw new IllegalStateException("voice_not_ready");
        clientActions.clear(); boolean cancelledVoice = cancelPreparingClientVoice(); inputSubmissionContext = new Object();
        if (active != null) throw new IllegalStateException("voice_busy");
        nextRecordingTarget = NativeVoiceJson.object("threadId", target, "threadTitle", title);
        if (cancelledVoice) drain();
    }
    /** In-app Start uses an explicit selection before its initial-target policy. */
    static JSONObject manualTarget(JSONObject supplied, JSONObject pending, JSONObject settings, JSONObject foreground) {
        String target = supplied == null ? null : NativeVoiceJson.nullableString(supplied, "threadId", 512);
        String title = supplied == null ? null : NativeVoiceJson.nullableString(supplied, "threadTitle", 512);
        if (target == null && pending != null) {
            target = NativeVoiceJson.nullableString(pending, "threadId", 512); title = NativeVoiceJson.nullableString(pending, "threadTitle", 512);
        }
        if (target == null && settings != null) {
            if (!settings.optBoolean("pinDefaultVoiceThread") && foreground != null && foreground.optBoolean("visible")) {
                target = NativeVoiceJson.nullableString(foreground, "threadId", 512); title = NativeVoiceJson.nullableString(foreground, "threadTitle", 512);
            }
            if (target == null) {
                target = NativeVoiceJson.nullableString(settings, "voiceThreadId", 512); title = NativeVoiceJson.nullableString(settings, "voiceThreadTitle", 512);
            }
        }
        return NativeVoiceJson.object("threadId", target, "threadTitle", target == null ? null : title);
    }
    /** Shared by background Start controls and the idle Android notification label. */
    static JSONObject defaultRecordingTarget(JSONObject settings) {
        String target = settings == null ? null : NativeVoiceJson.nullableString(settings, "voiceThreadId", 512);
        String title = target == null ? null : NativeVoiceJson.nullableString(settings, "voiceThreadTitle", 512);
        return NativeVoiceJson.object("threadId", target, "threadTitle", title);
    }
    private void retarget(JSONObject args, Reply reply) {
        clientActions.clear(); boolean cancelledVoice = cancelPreparingClientVoice(); inputSubmissionContext = new Object();
        try {
            NativeVoiceJson.keys(args, "recordingId", "threadId", "threadTitle");
            // Parse both fields first: a rejected title must not leave the capture retargeted.
            String target = NativeVoiceJson.string(args, "threadId", 512), title = NativeVoiceJson.nullableString(args, "threadTitle", 512);
            Active item = requireRecording(NativeVoiceJson.string(args, "recordingId", 160));
            if (!phase.equals("listening") || item.captureStopping || item.endpointReached) throw new IllegalStateException("voice_not_listening");
            if (item.recordingMutationPending) throw new IllegalStateException("recording_operation_pending");
            synchronized (item.captureLock) {
                if (item.captureStopping || item.endpointReached) throw new IllegalStateException("voice_not_listening");
                item.recordingMutationPending = true;
            }
            publish();
            dictationWork(() -> dictations.retarget(item.recordingBinding, item.recordingId, target, title), (record, error) -> {
                if (active != item || item.stopped) { reply.failed("recording_changed", message("recording_changed")); return; }
                item.recordingMutationPending = false;
                if (error != null) { publish(); reply.failed(code(error), message(code(error))); return; }
                // This edit was accepted before any finishing boundary, even if its durable acknowledgment arrived later.
                item.targetId = target; item.targetTitle = title; item.automatic = false;
                item.record = record; acceptDictation(record); publish(); reply.done(snapshot());
            });
        } finally {
            if (cancelledVoice && active == null) drain();
        }
    }
    private Active requireRecording(String id) {
        if (active == null || id == null || !id.equals(active.recordingId) || active.stopped)
            throw new IllegalStateException("recording_changed");
        return active;
    }
    private void requireInteraction(String id) {
        if (active == null || id == null || !id.equals(active.id) || active.stopped) throw new IllegalStateException("voice_interaction_changed");
    }
    private void setKeepListening(JSONObject args, Reply reply) {
        NativeVoiceJson.keys(args, "recordingId", "enabled");
        Active item = requireRecording(NativeVoiceJson.string(args, "recordingId", 160));
        boolean enabled = NativeVoiceJson.bool(args, "enabled");
        if (!phase.equals("listening") || item.captureStopping || item.endpointReached) throw new IllegalStateException("voice_not_listening");
        if (item.recordingMutationPending) throw new IllegalStateException("recording_operation_pending");
        if (enabled && retainedDictation != null && !retainedDictation.id.equals(item.recordingId))
            throw new IllegalStateException("saved_recording_pending");
        if (enabled == item.keepListening) { reply.done(snapshot()); return; }
        synchronized (item.captureLock) {
            if (item.captureStopping || item.endpointReached) throw new IllegalStateException("voice_not_listening");
            if (enabled) {
                item.capturePolicy.setHeld(true); item.automatic = false; item.adopted = true;
                if (item.longDictationDeadline == 0) item.longDictationDeadline = SystemClock.elapsedRealtime() + item.recordingSettings.number("longDictationTimeoutMs");
            }
            item.recordingMutationPending = true;
        }
        if (enabled) {
            clientActions.clear(); inputSubmissionContext = new Object();
            scheduleLongDictationTimeout(item);
        }
        publish();
        item.recording.setKeepListening(enabled, error -> handler.post(() -> {
            if (active != item || item.stopped) { reply.failed("recording_changed", message("recording_changed")); return; }
            item.recordingMutationPending = false;
            if (error != null) {
                interruptRecording(item, error); reply.failed(error, message(error)); return;
            }
            item.keepListening = enabled;
            if (!enabled && !item.captureStopping) synchronized (item.captureLock) {
                boolean knownSpeech = item.capturePolicy.sawSpeech() || item.record != null && !blank(item.record.text);
                item.capturePolicy.setHeld(false); item.capturePolicy.resetTiming(knownSpeech);
            }
            publish(); reply.done(snapshot());
        }));
    }
    private void sendRecording(JSONObject args) {
        NativeVoiceJson.keys(args, "recordingId");
        Active item = requireRecording(NativeVoiceJson.string(args, "recordingId", 160));
        if (item.finishReason == NativeVoiceRecording.FinishReason.SEND) return;
        if (!phase.equals("listening") || !item.keepListening || item.captureStopping || item.endpointReached) throw new IllegalStateException("voice_not_listening");
        if (item.recordingMutationPending) throw new IllegalStateException("recording_operation_pending");
        finishCapture(item, NativeVoiceRecording.FinishReason.SEND);
    }
    private void scheduleLongDictationTimeout(Active item) {
        final long deadline = item.longDictationDeadline;
        handler.postDelayed(() -> {
            if (active != item || item.stopped || deadline != item.longDictationDeadline || item.captureStopping) return;
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining > 0) { scheduleLongDictationTimeout(item); return; }
            finishCapture(item, NativeVoiceRecording.FinishReason.TIMEOUT);
        }, Math.max(1, deadline - SystemClock.elapsedRealtime()));
    }
    private void skip() {
        if (active == null || !(phase.equals("speaking") || phase.equals("synthesizing"))) throw new IllegalStateException("voice_not_speaking");
        Active item = active; audio.stop(); item.chunk = item.chunks.size();
        if (item.speechRequest != null) item.speechRequest.cancel();
        item.speechRequest = null; item.ttsId = null;
        afterSpeech(item); publish();
    }
    private void cancelActive(boolean cancelAdmission, String reason) {
        Active old = active; if (old == null) return;
        if (old.recordingStart != null) { cancelRecordingStart(old, reason, false); return; }
        if (old.recoveryRecognition || old.recoverySend) {
            if (old.admission != null && cancelAdmission) cancelEntry(old.recordingBinding, old.admission.optString("mutationId"), true);
            interruptRecording(old, reason); return;
        }
        if (old.adopted && old.recordingId != null && old.admission == null && !reason.equals("stopped") && !reason.equals("discarded")) {
            interruptRecording(old, reason);
            if (old.admission != null && cancelAdmission) cancelEntry(old.recordingBinding, old.admission.optString("mutationId"), true);
            return;
        }
        if (old.notification != null) { queue.completed(old.id); clientActions.discardTurn(old.notification.threadId, clientTurn(old.notification)); }
        old.stopped = true; active = null; audio.stop();
        if (captureOwner == old) captureOwner = null;
        if (old.admission != null && cancelAdmission) cancelEntry(binding, old.admission.optString("mutationId"), true);
        if (old.speechRequest != null) old.speechRequest.cancel();
        if (old.preflight != null) old.preflight.cancel();
        if (old.recording != null) old.recording.discard();
        if (old.recordingId != null && old.admission == null) discardStoredRecording(old.recordingBinding, old.recordingId);
        closeRecordingTransport(old);
        old.speechRequest = null; old.recording = null;
        phase = sessionStarted ? "idle" : "off";
        publish();
    }
    private void finishItem(Active item) {
        if (active != item) return;
        if (item.notification != null) queue.completed(item.id);
        if (captureOwner == item) captureOwner = null;
        active = null; audio.stop(); closeRecordingTransport(item);
        phase = sessionStarted ? "idle" : "off";
        if (item.notification != null) clientReplyDrained(item.id);
        publish(); drain();
    }
    private void closeRecordingTransport(Active item) {
        if (item.recognitionTransport != null) item.recognitionTransport.close();
        item.recognitionTransport = null;
    }
    private void stopRecognition(Active item) {
        item.captureId = null;
        if (captureOwner == item) captureOwner = null;
        audio.stop();
        if (item.recording != null) item.recording.discard();
        if (item.recordingId != null && item.admission == null) discardStoredRecording(item.recordingBinding, item.recordingId);
        closeRecordingTransport(item);
        item.recording = null; item.capturePolicy = null;
    }
    private void stopInteraction() {
        clientActions.clear(); inputSubmissionContext = new Object();
        Active item = active;
        if (item != null && (item.recoveryRecognition || item.recoverySend)) {
            cancelActive(true, "stopped"); drain();
        } else if (item != null && item.recording != null && item.admission == null) {
            stopRecognition(item);
            recognitionCompletionCue(item, false, false, () -> { cancelActive(true, "stopped"); drain(); });
        } else { cancelActive(true, "stopped"); drain(); }
    }
    private void failActive(String code) {
        Active item = active;
        if (item != null && item.recordingStart != null) { cancelRecordingStart(item, code, true); return; }
        if (item != null && item.adopted && item.recordingId != null && item.admission == null) {
            interruptRecording(item, code); return;
        }
        if (item != null && item.captureId != null) {
            stopRecognition(item);
            recognitionCompletionCue(item, false, false, () -> { cancelActive(false, code); report(code); drain(); });
        } else { cancelActive(false, code); report(code); drain(); }
    }
    private void recordingFailed(Active item, String reason, boolean retained) {
        if (active != item) return;
        item.recording = null; closeRecordingTransport(item);
        if (retained || item.adopted) interruptRecording(item, reason);
        else failActive(reason);
    }
    /** Settle creation before reconnect/recovery can read its slot. No microphone or input admission exists yet. */
    private void cancelRecordingStart(Active item, String reason, boolean reportFailure) {
        RecordingStart starting = item.recordingStart;
        if (active != item || starting == null || starting.cancelled) return;
        starting.cancelled = true; item.recordingStart = null; item.stopped = true; active = null;
        if (captureOwner == item) captureOwner = null;
        audio.stop(); closeRecordingTransport(item);
        if (item.notification != null) { queue.completed(item.id); clientActions.discardTurn(item.notification.threadId, clientTurn(item.notification)); }
        final String owner = item.recordingBinding;
        final long generation = connectionGeneration, operation = beginDictationOperation();
        final boolean discard = reason.equals("stopped") || reason.equals("discarded");
        phase = sessionStarted ? "idle" : "off"; publish();
        dictationWork(() -> {
            if (starting.journal == null) return null;
            // No transport or microphone ran. Settlement can remove empty creation without an interruption write.
            return dictations.settleInterruption(owner, item.recordingId);
        }, (record, error) -> {
            if (generation != connectionGeneration || !Objects.equals(owner, binding)) return;
            if (error != null) {
                // A terminal marker may already have committed. Reconcile that boundary before showing recovery.
                if (retainedDictation != null && retainedDictation.id.equals(item.recordingId) && retainedDictation.empty()) retainedDictation = null;
                dictationStorageError = true; report(code(error));
                restoreDictation(generation, () -> { endDictationOperation(operation); publish(); drain(); });
                return;
            }
            endDictationOperation(operation);
            if (record != null) acceptDictation(record);
            if (reportFailure || !discard && starting.adopted != null) report(reason);
            publish(); drain();
        });
    }
    /** Stops physical work immediately; the serialized writer publishes the preserved draft when durable. */
    private void interruptRecording(Active item, String reason) {
        if (active != item || item.stopped) return;
        final String owner = item.recordingBinding, id = item.recordingId;
        final long generation = connectionGeneration;
        item.completedMaySubmit = false; item.longDictationDeadline = 0;
        synchronized (item.captureLock) { item.captureStopping = true; }
        if (captureOwner == item) captureOwner = null;
        audio.stop();
        if (item.preflight != null) item.preflight.cancel();
        if (item.recording != null) item.recording.interrupt(reason);
        closeRecordingTransport(item);
        item.recording = null; item.captureId = null; item.stopped = true;
        if (item.notification != null) { queue.completed(item.id); clientActions.discardTurn(item.notification.threadId, clientTurn(item.notification)); }
        active = null;
        if (item.record != null && item.record.adopted) acceptDictation(item.record);
        final long operation = beginDictationOperation();
        phase = settings.active() && sessionStarted ? "recordingRecovery" : "off";
        if (!reason.equals("audio_focus_lost") && !reason.equals("voice_off") && !reason.equals("connection_changed") &&
            !reason.equals("service_stopped") && sessionStarted && settings.flag("recognitionCues"))
            audio.cue(UUID.randomUUID().toString(), NativeVoiceCue.Kind.FAILURE, settings.number("cueGain"));
        report(reason); publish();
        if (id == null || owner == null) { endDictationOperation(operation); publish(); return; }
        dictationWork(() -> dictations.settleInterruption(owner, id), (record, error) -> {
            if (generation != connectionGeneration || !owner.equals(binding)) return;
            if (error != null) {
                if (retainedDictation != null && retainedDictation.id.equals(id) && retainedDictation.empty()) retainedDictation = null;
                dictationStorageError = true; report(code(error));
                restoreDictation(generation, () -> { endDictationOperation(operation); publish(); drain(); });
                return;
            }
            endDictationOperation(operation);
            if (record != null) acceptDictation(record);
            else if (retainedDictation != null && retainedDictation.id.equals(id)) retainedDictation = null;
            publish(); drain();
        });
    }
    private void recognitionCompletionCue(Active item, boolean success, boolean retry, Runnable done) {
        if (active != item || item.stopped) return;
        audio.stop();
        if (!settings.flag("recognitionCues")) { done.run(); return; }
        item.completionCueId = UUID.randomUUID().toString(); item.afterCompletionCue = done;
        item.retryAfterCompletionCue = retry;
        String cue = item.completionCueId;
        phase = "recognizing"; publish();
        item.lastAudioId = cue;
        audio.cue(cue, success ? NativeVoiceCue.Kind.SUCCESS : NativeVoiceCue.Kind.FAILURE, settings.number("cueGain"));
        // Feedback is bounded and must not strand otherwise valid recognized input.
        handler.postDelayed(() -> finishCompletionCue(item, cue), 15000);
    }
    private void finishCompletionCue(Active item, String cue) {
        if (active != item || item.stopped || !cue.equals(item.completionCueId)) return;
        Runnable done = item.afterCompletionCue;
        item.completionCueId = null; item.afterCompletionCue = null; item.retryAfterCompletionCue = false;
        audio.stop(); done.run();
    }
    private void speechFailed(String requestId, String code) { handler.post(() -> {
        Active item = active;
        if (item == null) return;
        if (requestId.equals(item.ttsId)) {
            if (code.equals("empty_pcm_stream")) skipEmptySpeech(item); else failActive(code);
        }
        else if (requestId.equals(item.captureId)) failActive(code);
    }); }
    private void maybeCompleteRecording(Active item) {
        if (active != item || item.stopped || !item.completionReceived || !item.finishIntentSaved) return;
        String text = item.completedText;
        item.recording = null; closeRecordingTransport(item);
        item.captureId = null; item.capturePolicy = null;
        item.reconnecting = false;
        if (!item.completedMaySubmit || item.finishReason == NativeVoiceRecording.FinishReason.TIMEOUT) {
            finishItem(item); return;
        }
        boolean explicit = item.finishReason == NativeVoiceRecording.FinishReason.SEND;
        boolean retryEmptyTranscript = !explicit && item.endpoint != NativeVoiceCapturePolicy.End.NO_SPEECH && blank(text);
        boolean usable = !blank(text) &&
            !(item.recordingSettings.flag("recognizeStopCommand") && !explicit && NativeVoiceQueue.isStopCommand(text));
        // Final text is independent of subsequent provider/credential changes and feedback playback.
        item.recognitionFinalized = usable;
        recognitionCompletionCue(item, usable, retryEmptyTranscript, () -> {
            if (retryEmptyTranscript) {
                String previousId = item.recordingId;
                discardStoredRecording(item.recordingBinding, previousId);
                item.recordingId = null; arm(item);
            } else if (!usable) {
                discardStoredRecording(item.recordingBinding, item.recordingId); finishItem(item);
            } else finalizeRecognition(item, text, item.frozenSteer);
        });
    }
    public void drained(String requestId) { handler.post(() -> {
        if (active == null) return;
        if (requestId.equals(active.completionCueId)) finishCompletionCue(active, requestId);
        else if (requestId.equals(active.cueId)) capture(active);
        else if (requestId.equals(active.ttsId)) { active.ttsId = null; active.chunk++; speakChunk(active); }
    }); }
    public void captureStarted(String requestId) { handler.post(() -> {
        if (active == null || !requestId.equals(active.captureId) || !phase.equals("arming")) return;
        phase = "listening"; publish();
        Active item = active;
        synchronized (item.captureLock) { item.lastPcmElapsed = SystemClock.elapsedRealtime(); }
        captureWatchdog(item, requestId);
    }); }
    private void captureWatchdog(Active item, String captureId) {
        handler.postDelayed(() -> {
            if (active != item || item.stopped || !captureId.equals(item.captureId) || item.captureStopping) return;
            long elapsed;
            synchronized (item.captureLock) { elapsed = SystemClock.elapsedRealtime() - item.lastPcmElapsed; }
            if (elapsed >= 5000) failActive("recognition_capture_timeout");
            else captureWatchdog(item, captureId);
        }, 1000);
    }
    public void captured(String requestId, byte[] pcm) {
        Active item = captureOwner;
        if (item == null || !requestId.equals(item.captureId)) return;
        synchronized (item.captureLock) {
            NativeVoiceRecording recording = item.recording;
            NativeVoiceCapturePolicy capturePolicy = item.capturePolicy;
            if (item.captureStopping || item.endpointReached || recording == null || capturePolicy == null) return;
            long now = SystemClock.elapsedRealtime(); item.lastPcmElapsed = now;
            if (item.longDictationDeadline > 0 && now >= item.longDictationDeadline) {
                item.endpointReached = true;
                handler.post(() -> { if (active == item) finishCapture(item, NativeVoiceRecording.FinishReason.TIMEOUT); });
                return;
            }
            NativeVoiceCapturePolicy.End end;
            long before = capturePolicy.samples();
            try { end = capturePolicy.accept(pcm); }
            catch (IllegalArgumentException | IllegalStateException error) {
                item.endpointReached = true; handler.post(() -> { if (active == item) failActive("microphone_format_unavailable"); }); return;
            }
            int accepted = (int) (capturePolicy.samples() - before) * 2;
            if (accepted > 0 && !recording.accept(accepted == pcm.length ? pcm : Arrays.copyOf(pcm, accepted))) return;
            if (end != NativeVoiceCapturePolicy.End.CONTINUE) {
                item.endpointReached = true; item.endpoint = end;
                handler.post(() -> {
                    if (active != item || item.stopped) return;
                    if (end == NativeVoiceCapturePolicy.End.NO_SPEECH && !item.adopted) finishNoSpeech(item);
                    else finishCapture(item, NativeVoiceRecording.FinishReason.AUTOMATIC);
                });
            }
        }
    }
    public void captureEnded(String requestId) { handler.post(() -> {
        if (active == null || !requestId.equals(active.captureId)) return;
        Active item = active;
        if (!item.captureStopping) {
            if (!item.adopted && item.capturePolicy != null && !item.capturePolicy.sawSpeech()) { finishNoSpeech(item); return; }
            finishCapture(item, NativeVoiceRecording.FinishReason.AUTOMATIC);
        }
        item.captureEnded = true; captureOwner = null; item.captureId = null;
        finishCapturedRecording(item);
    }); }
    private void finishCapture(Active item, NativeVoiceRecording.FinishReason reason) {
        if (active != item || item.stopped || item.captureStopping) return;
        synchronized (item.captureLock) {
            if (item.captureStopping) return;
            if (reason == NativeVoiceRecording.FinishReason.SEND && item.endpointReached) throw new IllegalStateException("voice_not_listening");
            if (item.recording == null) return;
            item.captureStopping = true; item.finishReason = reason;
            item.recording.beginFinish(reason);
        }
        item.frozenSteer = item.recordingSettings.flag("followComposerMode") && composerMode.equals("steer");
        item.frozenOrigin = originId; item.mutationId = UUID.randomUUID().toString();
        phase = "recognizing"; publish();
        String captureId = item.captureId;
        if (captureId != null) audio.finishRecord(captureId);
        else { item.captureEnded = true; finishCapturedRecording(item); }
        handler.postDelayed(() -> {
            if (active == item && !item.stopped && !item.captureEnded) interruptRecording(item, "recognition_capture_timeout");
        }, 5000);
    }
    private void finishCapturedRecording(Active item) {
        if (item.recording == null || item.finishReason == null || item.finishQueued) return;
        item.finishQueued = true;
        item.recording.finish(item.finishReason);
        final String id = item.recordingId;
        JSONObject preference = NativeVoiceJson.object("mode", item.frozenSteer ? "steer" : "queue", "originClientId", item.frozenOrigin);
        dictationWork(() -> dictations.finishIntent(item.recordingBinding, id, item.mutationId, preference), (record, error) -> {
            if (!ownsRecording(item, id)) return;
            if (error != null) { interruptRecording(item, code(error)); return; }
            item.record = record; acceptDictation(record); item.finishIntentSaved = true;
            maybeCompleteRecording(item); publish();
        });
    }
    private void finishNoSpeech(Active item) {
        stopRecognition(item);
        recognitionCompletionCue(item, false, false, () -> finishItem(item));
    }
    public void failed(String requestId, String reason) { handler.post(() -> {
        Active item = active;
        if (item == null) return;
        if (reason.equals("audio_focus_lost")) {
            if (requestId.equals(item.completionCueId) && !item.retryAfterCompletionCue) {
                // Feedback cannot discard already captured text or an unrelated error awaiting reporting.
                finishCompletionCue(item, requestId);
            } else if (requestId.equals(item.completionCueId) || requestId.equals(item.ttsId) ||
                       requestId.equals(item.captureId) || requestId.equals(item.cueId) ||
                       (requestId.equals(item.lastAudioId) && !speechIndependent(item))) {
                if (item.adopted && item.recordingId != null) {
                    if (!item.captureEnded) interruptRecording(item, reason);
                } else { cancelActive(false, reason); drain(); }
            }
            return;
        }
        if (requestId.equals(item.completionCueId)) { finishCompletionCue(item, requestId); return; }
        // A chunk that produced no audio is a no-op; continue with the next chunk or the item's follow-up.
        if (requestId.equals(item.ttsId) && reason.equals("empty_pcm_stream")) { skipEmptySpeech(item); return; }
        if (requestId.equals(item.ttsId) || requestId.equals(item.captureId) || requestId.equals(item.cueId)) failActive(reason);
    }); }
    private void skipEmptySpeech(Active item) {
        if (item.speechRequest != null) item.speechRequest.cancel();
        item.speechRequest = null; item.ttsId = null; audio.stop(); item.chunk++; speakChunk(item);
    }
    private void finalizeRecognition(Active item, String text, boolean steer) {
        if (active != item) return;
        if (NativeVoiceJson.bytes(text) > NativeDictationStore.MAX_TEXT_BYTES) { failActive("recognized_text_too_large"); return; }
        final String target = item.targetId, frozenText = text, frozenOrigin = item.frozenOrigin;
        final long generation = connectionGeneration;
        phase = "submitting"; publish();
        if (item.record != null && item.record.request != null) {
            prepareAdmission(item, target, frozenText, frozenOrigin, item.record.request.optJSONObject("runningPolicy")); return;
        }
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
        final String owner = item.recordingBinding, id = item.mutationId, recordingId = item.recordingId;
        final long generation = connectionGeneration;
        JSONObject request = item.record != null && item.record.request != null ? item.record.request :
            NativeVoiceJson.object("mutationId", id, "text", text, "origin", NativeVoiceJson.object("clientId", originId), "runningPolicy", policy);
        dictationWork(() -> dictations.saveFinalRequest(owner, recordingId, request), (record, error) -> {
            if (!ownsRecording(item, recordingId) || generation != connectionGeneration) return;
            if (error != null) { failActive(code(error)); return; }
            item.record = record; acceptDictation(record);
            JSONObject entry = dictationEntry(record);
            try { saveEntry(owner, entry); item.admission = entry; }
            catch (Exception failure) { failActive(code(failure)); return; }
            if (!record.adopted) {
                // The journal now owns the complete request; ordinary capture has no saved-dictation lifecycle.
                discardStoredRecording(owner, recordingId);
                submit(owner, origin, credential, entry, false); return;
            }
            final String admissionKey = owner + "\n" + id;
            preparingAdmissions.add(admissionKey);
            dictationWork(() -> dictations.markHandedOff(owner, recordingId), (handedOff, failure) -> {
                preparingAdmissions.remove(admissionKey);
                if (failure != null) {
                    if (active == item) { item.admission = null; failActive(code(failure)); }
                    return;
                }
                acceptDictation(handedOff);
                if (!ownsRecording(item, recordingId) || generation != connectionGeneration) {
                    if (generation == connectionGeneration) recoverOutstanding();
                    publish(); return;
                }
                item.record = handedOff;
                submit(owner, origin, credential, entry, false);
            });
        });
    }
    private interface StoreAction<T> { T run() throws Exception; }
    /** Disk/encryption are serialized away from both the microphone thread and runtime actor. */
    private <T> void dictationWork(StoreAction<T> work, BiConsumer<T, Exception> done) {
        dictations.executor().execute(() -> {
            T result = null; Exception failure = null;
            try { result = work.run(); } catch (Exception error) { failure = error; }
            final T value = result; final Exception error = failure;
            handler.post(() -> done.accept(value, error));
        });
    }
    private long beginDictationOperation() { dictationOperationPending = true; return ++dictationOperationRevision; }
    private void endDictationOperation(long revision) { if (revision == dictationOperationRevision) dictationOperationPending = false; }
    private boolean savedDictationBlocks() {
        return retainedDictation != null && !retainedDictation.handedOff && linkedAdmissionSummary(retainedDictation) == null;
    }
    private boolean recordingBusy() {
        return active != null && active.recordingId != null && active.admission == null &&
            (!active.captureEnded || active.recording != null) || dictationOperationPending;
    }
    private boolean blockingDictation() {
        return dictationLoading || dictationOperationPending || dictationStorageError || savedDictationBlocks();
    }
    private boolean defaultHeldBlocked() { return settings.flag("keepListeningByDefault") && retainedDictation != null; }
    private void acceptDictation(NativeDictationStore.Recording record) {
        if (record == null || !record.adopted || !Objects.equals(binding, record.binding) ||
            discardedDictations.contains(record.binding + "\n" + record.id)) return;
        if (retainedDictation == null || retainedDictation.id.equals(record.id) && retainedDictation.revision <= record.revision)
            retainedDictation = record;
    }
    private void discardStoredRecording(String owner, String id) {
        if (owner == null || id == null) return;
        discardedDictations.add(owner + "\n" + id);
        if (retainedDictation != null && retainedDictation.binding.equals(owner) && retainedDictation.id.equals(id)) retainedDictation = null;
        dictationWork(() -> {
            dictations.discard(owner, id);
            for (NativeDictationStore.Retirement retirement : dictations.pendingRetirements(owner))
                if (retirement.recordingId.equals(id)) return retirement;
            return null;
        }, (retirement, error) -> {
            if (error != null) { if (Objects.equals(owner, binding)) report("dictation_storage_unavailable"); return; }
            if (retirement != null) {
                try { removeLinkedAdmissions(owner, id); }
                catch (Exception failure) { if (Objects.equals(owner, binding)) { dictationStorageError = true; report("voice_storage_unavailable"); } return; }
                dictationWork(() -> { dictations.finishDiscard(owner, id); return null; }, (ignored, failure) -> {
                    if (failure != null && Objects.equals(owner, binding)) report("dictation_storage_unavailable");
                });
            }
            publish(); drain();
        });
    }
    /** Presence of recordingId is the authenticated discriminator for an adopted admission entry. */
    private static String recordingOwner(JSONObject entry) {
        return entry != null && entry.has("recordingId") ? entry.optString("recordingId") : null;
    }
    private List<String> linkedAdmissions(String owner, String recordingId) throws Exception {
        JSONArray entries = record(owner, () -> store.summaries(owner));
        List<String> result = new ArrayList<>();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            if (recordingId.equals(recordingOwner(entry))) result.add(entry.optString("mutationId"));
        }
        return result;
    }
    private void removeLinkedAdmissions(String owner, String recordingId) throws Exception {
        for (String mutationId : linkedAdmissions(owner, recordingId)) {
            String key = owner + "\n" + mutationId;
            Call call = admissions.remove(key); if (call != null) call.cancel();
            forget(key); cancelledAdmissions.remove(key); removeEntry(owner, mutationId);
        }
    }
    /** Snapshot reads use content-free cached summaries, including when the recording manifest is unreadable. */
    private JSONObject linkedAdmissionSummary(NativeDictationStore.Recording recording) {
        try {
            JSONArray entries = store.summaries(recording.binding);
            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.getJSONObject(i);
                if (recording.id.equals(recordingOwner(entry))) return entry;
            }
        } catch (Exception ignored) {}
        return null;
    }
    private static JSONObject dictationEntry(NativeDictationStore.Recording record) {
        JSONObject entry = NativeVoiceJson.object("mutationId", record.mutationId, "threadId", record.threadId, "request", record.request,
            "stage", "prepared", "cancelled", false, "createdAt", System.currentTimeMillis());
        if (record.adopted) NativeVoiceJson.put(entry, "recordingId", record.id);
        return entry;
    }
    /** An intact input journal can retain ownership even if the recording directory itself is missing. */
    private NativeDictationStore.Recording orphanedRecording(String owner) throws Exception {
        JSONArray entries = record(owner, () -> store.summaries(owner));
        JSONObject linked = null;
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            if (recordingOwner(entry) == null) continue;
            if (linked != null && !recordingOwner(linked).equals(recordingOwner(entry)))
                throw new IllegalStateException("dictation_finalization_conflict");
            linked = entry;
        }
        if (linked == null) return null;
        return new NativeDictationStore.Recording(owner, recordingOwner(linked), linked.optString("threadId"), null,
            "unavailable", "dictation_storage_unavailable", 0, 0, 0, -1, 0, -1,
            true, false, true, "", new JSONObject(), java.util.Collections.emptyList(), linked.optString("mutationId"), null, null, true);
    }
    private void restoreDictation(long generation, Runnable done) {
        final String owner = binding;
        dictationLoading = true; publish();
        dictationWork(() -> dictations.pendingRetirements(owner), (retirements, retirementError) -> {
            if (generation != connectionGeneration || !Objects.equals(owner, binding)) return;
            if (retirementError != null) { dictationStorageError = true; dictationLoading = false; report(code(retirementError)); done.run(); return; }
            try {
                for (NativeDictationStore.Retirement retirement : retirements) removeLinkedAdmissions(owner, retirement.recordingId);
            } catch (Exception error) { dictationStorageError = true; dictationLoading = false; report("voice_storage_unavailable"); done.run(); return; }
            dictationWork(() -> {
                for (NativeDictationStore.Retirement retirement : retirements) dictations.finishDiscard(owner, retirement.recordingId);
                return dictations.recover(owner);
            }, (record, error) -> {
                if (generation != connectionGeneration || !Objects.equals(owner, binding)) return;
                dictationLoading = false;
                if (error != null) { dictationStorageError = true; report(code(error)); done.run(); return; }
                dictationStorageError = false; retainedDictation = null;
                if (record == null) {
                    try { acceptDictation(orphanedRecording(owner)); }
                    catch (Exception failure) { dictationStorageError = true; report(code(failure)); }
                    done.run(); return;
                }
                acceptDictation(record);
                // A frozen request repairs either side of the journal handoff. Bootstrap never sends it.
                if (record != null && record.request != null && !record.stage.equals("rejected")) {
                    try {
                        List<String> links = linkedAdmissions(owner, record.id);
                        if (!links.isEmpty() && (links.size() != 1 || !record.mutationId.equals(links.get(0))))
                            throw new IllegalStateException("dictation_finalization_conflict");
                        JSONObject existing = entry(owner, record.mutationId);
                        if (existing == null) saveEntry(owner, dictationEntry(record));
                        else if (!record.id.equals(recordingOwner(existing)) || !record.mutationId.equals(existing.optString("mutationId")) ||
                            !record.threadId.equals(existing.optString("threadId")) || !NativeDictationStore.sameJson(record.request, existing.optJSONObject("request")))
                            throw new IllegalStateException("dictation_finalization_conflict");
                    } catch (Exception failure) { dictationStorageError = true; report(code(failure)); done.run(); return; }
                    if (!record.handedOff) {
                        dictationLoading = true;
                        dictationWork(() -> dictations.markHandedOff(owner, record.id), (handedOff, failure) -> {
                            if (generation != connectionGeneration || !Objects.equals(owner, binding)) return;
                            dictationLoading = false;
                            if (failure != null) { dictationStorageError = true; report(code(failure)); } else acceptDictation(handedOff);
                            done.run();
                        });
                        return;
                    }
                }
                done.run();
            });
        });
    }
    private NativeDictationStore.Recording requireRecovery(JSONObject args) { return requireRecovery(args, false); }
    private NativeDictationStore.Recording requireRecovery(JSONObject args, boolean discarding) {
        NativeVoiceJson.keys(args, "recordingId", "expectedRecoveryRevision");
        String id = NativeVoiceJson.string(args, "recordingId", 160);
        long revision = NativeVoiceJson.integer(args, "expectedRecoveryRevision", 0, Long.MAX_VALUE);
        NativeDictationStore.Recording record = retainedDictation;
        if (binding == null || record == null || !record.binding.equals(binding) || !record.id.equals(id))
            throw new IllegalStateException("recording_changed");
        if (record.revision != revision) throw new IllegalStateException("recording_revision_conflict");
        if (discarding ? !canDiscardRecording(record) : dictationLoading || dictationOperationPending || active != null && id.equals(active.recordingId))
            throw new IllegalStateException("recording_operation_pending");
        return record;
    }
    private boolean retryConfigurationMatches(NativeDictationStore.Recording record) {
        if (!speechReady()) return false;
        for (String key : new String[] { "speechProvider", "speechEndpoint", "sttModel" })
            if (!Objects.equals(record.config.opt(key), settings.value.opt(key))) return false;
        return true;
    }
    private void retryRecordingRecognition(JSONObject args, Reply reply) {
        NativeDictationStore.Recording record = requireRecovery(args);
        if (dictationStorageError) throw new IllegalStateException("dictation_storage_unavailable");
        if (active != null || record.complete() || record.handedOff || record.overflow() || record.stage.equals("unavailable"))
            throw new IllegalStateException("recording_retry_unavailable");
        if (!canListen()) throw new IllegalStateException("voice_not_ready");
        if (!retryConfigurationMatches(record)) throw new IllegalStateException("speech_configuration_changed");
        JSONObject frozen = NativeVoiceJson.copy(settings.value);
        java.util.Iterator<String> keys = record.config.keys();
        while (keys.hasNext()) { String key = keys.next(); NativeVoiceJson.put(frozen, key, record.config.opt(key)); }
        Active item = new Active(record.threadId, record.threadTitle);
        item.recordingId = record.id; item.recordingBinding = record.binding; item.record = record; item.adopted = true; item.recoveryRecognition = true;
        item.captureEnded = true; item.captureStopping = true; item.finishQueued = true; item.finishIntentSaved = true;
        item.recordingSettings = new NativeVoiceSettings(settings.revision, frozen);
        item.mutationId = record.mutationId; item.finishReason = NativeVoiceRecording.FinishReason.TIMEOUT;
        active = item; phase = "recognizing";
        final long generation = connectionGeneration; final String secret = speechCredential;
        item.preflight = recordingBackend.preflight(item.recordingSettings, secret, (capabilities, error) -> handler.post(() -> {
            if (!ownsRecording(item, record.id) || generation != connectionGeneration) { reply.failed("recording_changed", message("recording_changed")); return; }
            item.preflight = null;
            if (error != null) { interruptRecording(item, error); reply.failed(error, message(error)); return; }
            dictationWork(() -> dictations.journal(record.binding, record.id), (journal, failure) -> {
                if (!ownsRecording(item, record.id)) { reply.failed("recording_changed", message("recording_changed")); return; }
                if (failure != null) { interruptRecording(item, code(failure)); reply.failed(code(failure), message(code(failure))); return; }
                startRecordingCoordinator(item, journal, capabilities, secret, true); publish(); reply.done(snapshot());
            });
        }));
        publish();
    }
    private void sendRecoveredRecording(JSONObject args, Reply reply) throws Exception {
        NativeDictationStore.Recording record = requireRecovery(args);
        if (dictationStorageError) throw new IllegalStateException("dictation_storage_unavailable");
        if (record.stage.equals("rejected") || record.stage.equals("unavailable") || record.overflow() || !record.complete() || blank(record.text))
            throw new IllegalStateException("recording_send_unavailable");
        if (record.handedOff) {
            String key = record.binding + "\n" + record.mutationId;
            Recovery recovery = recoveries.get(key);
            if (admissions.containsKey(key) || waitingClientAdmissions.contains(key) || recovery != null && recovery.call != null)
                throw new IllegalStateException("recording_operation_pending");
            JSONObject current = entry(binding, record.mutationId);
            if (current == null) throw new IllegalStateException("recording_send_unavailable");
            if (!record.id.equals(recordingOwner(current)) || !record.threadId.equals(current.optString("threadId")) ||
                !NativeDictationStore.sameJson(record.request, current.optJSONObject("request"))) throw new IllegalStateException("dictation_finalization_conflict");
            resumeJournalInput(record.mutationId); publish(); reply.done(snapshot()); return;
        }
        if (active != null) throw new IllegalStateException("voice_busy");
        if (csrf == null || clientConnectionToken == null) throw new IllegalStateException("connection_unavailable");
        Active item = new Active(record.threadId, record.threadTitle);
        item.recordingId = record.id; item.recordingBinding = record.binding; item.record = record; item.adopted = true; item.recoverySend = true;
        item.captureEnded = true; item.captureStopping = true; item.finishIntentSaved = true; item.recognitionFinalized = true;
        item.recordingSettings = settings; item.frozenOrigin = record.preference == null ? originId : record.preference.optString("originClientId");
        item.frozenSteer = record.preference == null ? settings.flag("followComposerMode") && composerMode.equals("steer") : record.preference.optString("mode").equals("steer");
        item.mutationId = record.mutationId == null ? UUID.randomUUID().toString() : record.mutationId;
        active = item; phase = "submitting";
        final long operation = beginDictationOperation(); publish();
        JSONObject preference = NativeVoiceJson.object("mode", item.frozenSteer ? "steer" : "queue", "originClientId", item.frozenOrigin);
        dictationWork(() -> {
            NativeDictationStore.Recording accepted = record.captureIncomplete ? dictations.acknowledgeIncomplete(record.binding, record.id) : record;
            return accepted.mutationId == null ? dictations.finishIntent(record.binding, record.id, item.mutationId, preference) : accepted;
        }, (updated, error) -> {
            endDictationOperation(operation);
            if (!ownsRecording(item, record.id)) { publish(); reply.failed("recording_changed", message("recording_changed")); return; }
            if (error != null) { interruptRecording(item, code(error)); reply.failed(code(error), message(code(error))); return; }
            item.record = updated; acceptDictation(updated); finalizeRecognition(item, record.text, item.frozenSteer); reply.done(snapshot());
        });
    }
    /** Read only on an explicit user action; transcripts never enter routine bridge snapshots. */
    private void readRecognizedRecordingText(JSONObject args, Reply reply) {
        NativeDictationStore.Recording record = requireRecovery(args);
        if (blank(record.text) || record.threadId == null || blank(record.threadId)) throw new IllegalStateException("recording_text_unavailable");
        final long generation = connectionGeneration;
        dictationWork(() -> dictations.transcript(record.binding, record.id), (text, error) -> {
            if (generation != connectionGeneration || binding == null || !record.binding.equals(binding) ||
                retainedDictation == null || !record.id.equals(retainedDictation.id) || record.revision != retainedDictation.revision) {
                reply.failed("recording_changed", message("recording_changed")); return;
            }
            if (error != null) { reply.failed(code(error), message(code(error))); return; }
            try { requireRecovery(args); }
            catch (Exception changed) { reply.failed(code(changed), message(code(changed))); return; }
            reply.done(NativeVoiceJson.object("recordingId", record.id, "revision", record.revision,
                "threadId", record.threadId, "text", text));
        });
    }
    private void copyRecognizedRecordingText(JSONObject args, Reply reply) {
        NativeDictationStore.Recording record = requireRecovery(args);
        if (blank(record.text)) throw new IllegalStateException("recording_text_unavailable");
        final long generation = connectionGeneration;
        // Read only authenticated text; unreadable pending PCM must not prevent copying its valid prefix.
        dictationWork(() -> dictations.transcript(record.binding, record.id), (text, error) -> {
            if (error != null) { reply.failed(code(error), message(code(error))); return; }
            main.post(() -> {
                JSONObject current = state.optJSONObject("recordingRecovery");
                if (state.optLong("connectionGeneration") != generation || current == null || !record.id.equals(current.optString("recordingId")) ||
                    current.optLong("revision") != record.revision || !current.optBoolean("canCopyRecognizedText")) {
                    reply.failed("recording_changed", message("recording_changed")); return;
                }
                try {
                    ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (clipboard == null) throw new IllegalStateException("copy_failed");
                    clipboard.setPrimaryClip(ClipData.newPlainText("Recognized text", text)); reply.done(snapshot());
                } catch (Exception failure) { reply.failed("copy_failed", message("copy_failed")); }
            });
        });
    }
    private boolean activeRecovery(String recordingId) {
        return active != null && recordingId.equals(active.recordingId) && (active.recoveryRecognition || active.recoverySend);
    }
    private boolean canDiscardRecording(NativeDictationStore.Recording record) {
        return !dictationLoading && !discardedDictations.contains(record.binding + "\n" + record.id) &&
            (activeRecovery(record.id) || !dictationOperationPending && (active == null || !record.id.equals(active.recordingId)));
    }
    /** Fence a matching recovery before any asynchronous tombstone write; storage deletion belongs to that write. */
    private void cancelRecoveryForDiscard(String recordingId) {
        if (!activeRecovery(recordingId)) return;
        Active item = active;
        item.stopped = true; item.completedMaySubmit = false; active = null;
        if (captureOwner == item) captureOwner = null;
        if (item.preflight != null) item.preflight.cancel();
        if (item.speechRequest != null) item.speechRequest.cancel();
        if (item.recording != null) item.recording.cancelForDiscard();
        closeRecordingTransport(item); audio.stop();
        item.recording = null; item.captureId = null;
    }
    private void discardRecording(JSONObject args, Reply reply) throws Exception {
        NativeDictationStore.Recording record = requireRecovery(args, true);
        final long generation = connectionGeneration;
        final List<String> linked = linkedAdmissions(record.binding, record.id);
        final String mutation = record.mutationId != null ? record.mutationId : activeRecovery(record.id) && active.mutationId != null ?
            active.mutationId : linked.isEmpty() ? null : linked.get(0);
        final long operation = beginDictationOperation(); discardedDictations.add(record.binding + "\n" + record.id);
        cancelRecoveryForDiscard(record.id);
        for (String id : linked) {
            String key = record.binding + "\n" + id;
            Call call = admissions.remove(key); if (call != null) call.cancel();
            preparingAdmissions.remove(key); forget(key); cancelledAdmissions.add(key);
        }
        publish();
        // The durable terminal identifies the recording independently of a damaged manifest. Bootstrap also removes
        // every journal entry with this recordingId before deleting the marker, even across a crash in this callback.
        dictationWork(() -> { dictations.beginDiscard(record.binding, record.id, mutation); return null; }, (ignored, error) -> {
            if (generation != connectionGeneration || !Objects.equals(binding, record.binding)) { reply.failed("recording_changed", message("recording_changed")); return; }
            if (error != null) {
                discardedDictations.remove(record.binding + "\n" + record.id);
                // Re-read durable state: a failed write may have left either the original draft or a terminal marker.
                // Bootstrap repairs the latter without ever recognizing audio or posting the cancelled Send.
                restoreDictation(generation, () -> {
                    endDictationOperation(operation); report(code(error)); publish(); reply.failed(code(error), message(code(error)));
                });
                return;
            }
            endDictationOperation(operation);
            try { removeLinkedAdmissions(record.binding, record.id); }
            catch (Exception failure) { dictationStorageError = true; report("voice_storage_unavailable"); reply.failed("voice_storage_unavailable", message("voice_storage_unavailable")); return; }
            retainedDictation = null;
            dictationWork(() -> { dictations.finishDiscard(record.binding, record.id); return null; }, (unused, failure) -> {
                if (failure != null && Objects.equals(binding, record.binding)) report(code(failure));
            });
            publish(); reply.done(snapshot()); drain();
        });
    }

    /** Runs a record operation; an unreadable record is quarantined, reported once, and the operation retried from defaults. */
    private <T> T record(String ownerBinding, StoreAction<T> action) throws Exception {
        try { return action.run(); }
        catch (NativeVoiceStore.CorruptRecord error) {
            store.quarantine(ownerBinding, error.record);
            if (ownerBinding.equals(binding)) report(error.record.equals(NativeVoiceStore.PREFERENCES_RECORD) ? "voice_settings_reset" : "voice_" + error.record + "_reset");
            return action.run();
        }
    }
    private JSONObject entry(String ownerBinding, String id) throws Exception { return record(ownerBinding, () -> store.entry(ownerBinding, id)); }
    private void saveEntry(String ownerBinding, JSONObject entry) throws Exception { record(ownerBinding, () -> { store.saveEntry(ownerBinding, entry); return null; }); }
    private void removeEntry(String ownerBinding, String id) throws Exception { record(ownerBinding, () -> { store.removeEntry(ownerBinding, id); return null; }); }
    private boolean activeAdmission(String id) { return active != null && active.admission != null && id.equals(active.admission.optString("mutationId")); }
    private boolean discardedAdmission(String owner, JSONObject entry) {
        String recordingId = recordingOwner(entry);
        return recordingId != null && discardedDictations.contains(owner + "\n" + recordingId);
    }
    private void submit(String ownerBinding, String ownerOrigin, String ownerCredential, JSONObject entry, boolean refreshed) {
        String id = entry.optString("mutationId"), key = ownerBinding + "\n" + id;
        final long generation = connectionGeneration;
        try {
            JSONObject current = entry(ownerBinding, id);
            if (current == null || discardedAdmission(ownerBinding, current) || current.optBoolean("cancelled") || cancelledAdmissions.contains(key) || admissions.containsKey(key)) return;
            if (ownerBinding.equals(binding) && clientConnectionToken == null) {
                waitingClientAdmissions.add(key); publish(); return;
            }
            waitingClientAdmissions.remove(key);
            NativeVoiceJson.put(current, "stage", "possiblySubmitted"); saveEntry(ownerBinding, current);
            Call call = http.request(ownerOrigin, ownerCredential, csrf, "POST", "/api/threads/" + Uri.encode(current.optString("threadId")) + "/inputs",
                externalInputRequest(current.optJSONObject("request")), (status, value, failure) -> handler.post(() -> {
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
        JSONObject remaining = entry(ownerBinding, id); if (remaining == null || discardedAdmission(ownerBinding, remaining)) return;
        if (status >= 200 && status < 300 && receiptMatches(value, remaining)) { accepted(ownerBinding, id, value, generation); return; }
        JSONObject error = value == null ? null : value.optJSONObject("error");
        boolean csrfRejected = status == 403 && error != null && error.optString("code").equals("csrf_token_invalid");
        boolean cancelled = remaining.optBoolean("cancelled") || cancelledAdmissions.contains(key);
        boolean current = generation == connectionGeneration && ownerBinding.equals(binding);
        boolean registrationRejected = status == 409 && error != null && error.optString("code").equals("client_registration_required");
        if (registrationRejected && cancelled) { rejected(ownerBinding, id, null, false); return; }
        if (registrationRejected && current) {
            // This response is produced before the server admits any input. Retry the same journaled request only after registration.
            NativeVoiceJson.put(remaining, "stage", "prepared"); saveEntry(ownerBinding, remaining);
            waitingClientAdmissions.add(key); clientControls.reconnect(false); publish(); return;
        }
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
    private void forget(String key) { waitingClientAdmissions.remove(key); Recovery recovery = recoveries.remove(key); if (recovery != null && recovery.call != null) recovery.call.cancel(); }
    private void accepted(String ownerBinding, String id, JSONObject receipt, long generation) throws Exception {
        // A found receipt, including queued or submitting, is the definitive admission. Dispatch then belongs to the thread.
        JSONObject acceptedEntry = entry(ownerBinding, id); if (acceptedEntry == null) return;
        String recordingId = recordingOwner(acceptedEntry), key = ownerBinding + "\n" + id;
        inputSubmitted(ownerBinding, id, receipt, acceptedEntry, generation); forget(key);
        if (recordingId != null) {
            // The journal authenticates ownership independently of the recording manifest, including damaged or missing PCM.
            dictationWork(() -> { dictations.beginDiscard(ownerBinding, recordingId, id); return null; }, (ignored, error) -> {
                if (error != null) { if (ownerBinding.equals(binding)) report(code(error)); return; }
                try { removeLinkedAdmissions(ownerBinding, recordingId); }
                catch (Exception failure) { if (ownerBinding.equals(binding)) report("voice_storage_unavailable"); return; }
                discardedDictations.add(ownerBinding + "\n" + recordingId);
                if (retainedDictation != null && ownerBinding.equals(retainedDictation.binding) && recordingId.equals(retainedDictation.id)) retainedDictation = null;
                dictationWork(() -> { dictations.finishDiscard(ownerBinding, recordingId); return null; }, (unused, failure) -> {
                    if (failure != null && ownerBinding.equals(binding)) report(code(failure));
                });
                finishAccepted(ownerBinding, id, receipt);
            });
        } else {
            removeEntry(ownerBinding, id); cancelledAdmissions.remove(key);
            String ordinaryId = activeAdmission(id) ? active.recordingId : null;
            if (ordinaryId != null) discardStoredRecording(ownerBinding, ordinaryId);
            finishAccepted(ownerBinding, id, receipt);
        }
    }
    private void finishAccepted(String ownerBinding, String id, JSONObject receipt) {
        if (!ownerBinding.equals(binding)) return;
        if (activeAdmission(id)) finishItem(active); else { publish(); drain(); }
        String status = receipt.optString("status");
        if (status.equals("failed") || status.equals("recovery_required") || status.equals("cancelled"))
            report("input_" + status, receipt.has("diagnostic") ? receipt.optString("diagnostic") : null);
    }
    /** A current local Send may move its visible transcript; journal recovery and other devices never do. */
    private void inputSubmitted(String ownerBinding, String id, JSONObject receipt, JSONObject acceptedEntry, long generation) {
        final Object submittedContext = inputSubmissionContext;
        final String threadId = receipt.optString("threadId"), status = receipt.optString("status");
        if (generation != connectionGeneration || !ownerBinding.equals(binding) || !activeAdmission(id) ||
            active.stopped || active.submissionNotified || active.admission.optBoolean("cancelled") ||
            cancelledAdmissions.contains(ownerBinding + "\n" + id) || !nativeVisible || !foregroundVisible ||
            !threadId.equals(foregroundThread) || !receipt.optString("admittedMode").equals("submit") ||
            !(status.equals("queued") || status.equals("submitting") || status.equals("accepted"))) return;
        // Use the exact authenticated request before admission cleanup removes it; snapshots never carry this text.
        JSONObject request = acceptedEntry.optJSONObject("request");
        Object value = request == null ? null : request.opt("text");
        if (!(value instanceof String) || blank((String) value) || NativeVoiceJson.bytes((String) value) > NativeDictationStore.MAX_TEXT_BYTES) return;
        active.submissionNotified = true;
        final JSONObject event = NativeVoiceJson.object("profileId", profileId, "serverOrigin", origin, "identity", identity,
            "connectionGeneration", generation, "threadId", threadId, "operationId", receipt.optString("operationId"),
            "queuedInputId", receipt.has("queuedInputId") ? receipt.optString("queuedInputId") : null, "text", value);
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
        forget(key); cancelledAdmissions.remove(key);
        final String recordingId = recordingOwner(entry(ownerBinding, id));
        final String ordinaryId = activeAdmission(id) && recordingId == null ? active.recordingId : null;
        // Persist the definitive rejection before removing the input journal. A crash must never turn it into Resume.
        dictationWork(() -> {
            return recordingId == null ? null : dictations.reject(ownerBinding, recordingId, "input_rejected");
        }, (record, error) -> {
            if (error != null) { if (ownerBinding.equals(binding)) report(code(error)); return; }
            try { removeEntry(ownerBinding, id); } catch (Exception failure) { report("voice_storage_unavailable"); return; }
            acceptDictation(record);
            if (ordinaryId != null) discardStoredRecording(ownerBinding, ordinaryId);
            if (!ownerBinding.equals(binding)) return;
            if (activeAdmission(id)) finishItem(active); else publish();
            if (notify) report("input_rejected", diagnostic == null ? null : "Sedes rejected the input: " + diagnostic);
        });
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
            if (current.optString("stage").equals("prepared") && recordingOwner(current) == null) { removeEntry(ownerBinding, id); forget(key); }
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
        if (binding == null || dictationLoading) return;
        try {
            JSONArray entries = record(binding, () -> store.summaries(binding));
            for (int i = 0; i < entries.length(); i++) {
                JSONObject summary = entries.getJSONObject(i);
                String id = summary.optString("mutationId"), key = binding + "\n" + id;
                String recordingId = recordingOwner(summary);
                if (discardedAdmission(binding, summary)) continue;
                if (recordingId != null && (dictationStorageError || retainedDictation == null || !recordingId.equals(retainedDictation.id) || retainedDictation.stage.equals("unavailable"))) continue;
                if (preparingAdmissions.contains(key) || admissions.containsKey(key) || waitingClientAdmissions.contains(key)) continue;
                Recovery recovery = recoveries.get(key);
                if (recovery != null) { recovery.attempts = 0; if (recovery.call != null) continue; }
                reconcile(id, false, null);
            }
        } catch (Exception error) { report("voice_storage_unavailable"); }
    }
    private void resumeClientAdmissions() {
        if (binding == null || clientConnectionToken == null) return;
        for (String key : new ArrayList<>(waitingClientAdmissions)) {
            if (!key.startsWith(binding + "\n")) continue;
            String id = key.substring(binding.length() + 1);
            try {
                JSONObject current = entry(binding, id);
                if (current == null || current.optBoolean("cancelled")) { waitingClientAdmissions.remove(key); continue; }
                submit(binding, origin, credential, current, false);
            } catch (Exception error) { report("voice_storage_unavailable"); }
        }
    }
    private void reconcile(String id, boolean allowSubmit, String diagnostic) {
        final String ownerBinding = binding, ownerOrigin = origin, ownerCredential = credential;
        if (ownerBinding == null) return;
        final String key = ownerBinding + "\n" + id;
        if (preparingAdmissions.contains(key)) return;
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
                    JSONObject current = entry(ownerBinding, id); if (current == null || discardedAdmission(ownerBinding, current)) { recoveries.remove(key); publish(); return; }
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
        if (dictationLoading) throw new IllegalStateException("recording_operation_pending");
        if (binding != null && recordingOwner(entry(binding, id)) != null) throw new IllegalStateException("recording_recovery_required");
        resumeJournalInput(id);
    }
    private void resumeJournalInput(String id) throws Exception {
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
        if (dictationLoading) throw new IllegalStateException("recording_operation_pending");
        if (binding != null && recordingOwner(entry(binding, id)) != null) throw new IllegalStateException("recording_recovery_required");
        if (binding == null) throw new IllegalStateException("authentication_required");
        String key = binding + "\n" + id;
        if (entry(binding, id) == null) throw new IllegalStateException("input_recovery_not_found");
        Call attempt = admissions.remove(key); if (attempt != null) attempt.cancel();
        forget(key); cancelledAdmissions.remove(key);
        removeEntry(binding, id);
        if (activeAdmission(id)) finishItem(active);
    }
    void notificationAction(String action) {
        JSONObject current = snapshot(), item = current.optJSONObject("active"), recording = item == null ? null : item.optJSONObject("recording");
        notificationAction(action, current.optLong("connectionGeneration"), item == null ? null : item.optString("id"), recording == null ? null : recording.optString("id"));
    }
    void notificationAction(String action, long expectedGeneration) {
        JSONObject item = state.optJSONObject("active"), recording = item == null ? null : item.optJSONObject("recording");
        notificationAction(action, expectedGeneration, item == null ? null : item.optString("id"), recording == null ? null : recording.optString("id"));
    }
    void notificationAction(String action, long expectedGeneration, String interactionId, String recordingId) {
        handler.post(() -> {
            try {
                if (!sessionStarted || expectedGeneration != connectionGeneration ||
                    !Objects.equals(interactionId, active == null ? null : active.id) ||
                    !Objects.equals(recordingId, active == null ? null : active.recordingId)) return;
                switch (action) {
                    case "start": startDefaultRecording(); break;
                    case "send": sendRecording(NativeVoiceJson.object("recordingId", recordingId)); break;
                    case "stop": stopInteraction(); break;
                    case "skip": skip(); break;
                    case "mode": updateSettings(NativeVoiceJson.object("expectedRevision", settings.revision,
                        "patch", NativeVoiceJson.object("audioMode", settings.mode().equals("manual") ? "response" : "manual")), false); break;
                    case "rearm": updateSettings(NativeVoiceJson.object("expectedRevision", settings.revision,
                        "patch", NativeVoiceJson.object("autoListen", !settings.flag("autoListen"))), false); break;
                    case "headset":
                        if (!settings.flag("headsetControls")) return;
                        if (active == null) startDefaultRecording();
                        else if (phase.equals("speaking") || phase.equals("synthesizing")) skip();
                        else headsetStop();
                        break;
                    case "headset_stop":
                        if (!settings.flag("headsetControls")) return;
                        headsetStop(); break;
                    case "headset_skip":
                        if (!settings.flag("headsetControls")) return;
                        skip(); break;
                }
                publish();
            } catch (Exception error) { report(code(error)); }
        });
    }
    private void headsetStop() {
        Active item = active;
        if (item != null && item.adopted && item.recordingId != null && item.admission == null)
            interruptRecording(item, "headset_interrupted");
        else stopInteraction();
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
    /** Profile removal disconnects that profile and deletes its thread selections and input journals on the owner thread. */
    void profileRemoved(String profile) throws Exception {
        if (profile == null || !profile.matches("[A-Za-z0-9._:-]{1,160}")) throw new IllegalArgumentException("credential_profile_invalid");
        CountDownLatch done = new CountDownLatch(1); AtomicReference<Exception> failure = new AtomicReference<>();
        handler.post(() -> {
            if (profile.equals(profileId)) disconnect(true);
            dictationWork(() -> { dictations.removeProfile(profile); return null; }, (ignored, diskFailure) -> {
                try {
                    if (diskFailure != null) failure.set(diskFailure);
                    try { store.removeProfile(profile); }
                    catch (Exception error) { if (failure.get() == null) failure.set(error); else failure.get().addSuppressed(error); }
                } finally { done.countDown(); }
            });
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
                if (recordingOwner(entry) != null) continue;
                Recovery recovery = recoveries.get(key);
                result.put(NativeVoiceJson.object("mutationId", id, "threadId", entry.optString("threadId"),
                    "status", waitingClientAdmissions.contains(key) ? "prepared" : preparingAdmissions.contains(key) ? "prepared" : admissions.containsKey(key) ? "possiblySubmitted" : recovery != null && recovery.call != null ? "reconciling" : "uncertain",
                    "cancelled", entry.optBoolean("cancelled") || cancelledAdmissions.contains(key)));
            }
        } catch (Exception ignored) {}
        return result;
    }
    private boolean canListen() {
        return sessionStarted && speechReady() && binding != null && csrf != null && clientConnectionToken != null && settings.active() && audio.hasPermission();
    }
    private String readiness() {
        if (profileId == null) return "disconnected";
        if (dictationStorageError) return "storageUnavailable";
        if (binding == null || csrf == null || clientConnectionToken == null) return phase.equals("error") ? "error" : "connecting";
        if (!settings.active()) return "off";
        if (!audio.hasPermission()) return "permissionRequired";
        if (!speechReady()) return "speechConfigurationRequired";
        if (!sessionStarted) return sessionStartId == null ? "needsResume" : "starting";
        // Notifications require a live stream with known policy; explicit recording does not.
        if (!policyKnown) return streamFailures == 0 ? "notificationsConnecting" : "notificationsUnavailable";
        return "ready";
    }
    private String keepListeningBlockedReason() {
        if (active == null || active.recordingId == null || !phase.equals("listening") || active.captureStopping || active.endpointReached) return "not_capturing";
        if (dictationStorageError) return "storage_unavailable";
        if (active.recordingMutationPending || dictationLoading || dictationOperationPending) return "operation_pending";
        if (retainedDictation != null && !retainedDictation.id.equals(active.recordingId)) return "saved_recording_pending";
        if (!speechReady()) return "configuration_unavailable";
        return null;
    }
    private JSONObject recordingRecoveryState() {
        NativeDictationStore.Recording record = retainedDictation;
        if (record == null || active != null && record.id.equals(active.recordingId) && !active.recoveryRecognition && !active.recoverySend) return null;
        boolean busy = dictationLoading || dictationOperationPending || active != null && record.id.equals(active.recordingId);
        String stage = active != null && record.id.equals(active.recordingId) && (active.recoveryRecognition || active.recoverySend) ?
            active.recoveryRecognition ? "recognizing" : "admitting" : record.stage;
        if (stage.equals("capturing") || stage.equals("finishing") || stage.equals("recognizing") && !activeRecovery(record.id)) stage = "interrupted";
        JSONObject entry = linkedAdmissionSummary(record);
        String mutationId = entry == null ? record.mutationId : entry.optString("mutationId");
        JSONObject admission = null; boolean sendPending = false;
        if ((record.handedOff || entry != null) && mutationId != null) {
            String key = record.binding + "\n" + mutationId;
            Recovery recovery = recoveries.get(key);
            String status = stage.equals("rejected") ? "rejected" : waitingClientAdmissions.contains(key) ? "prepared" :
                preparingAdmissions.contains(key) ? "prepared" : admissions.containsKey(key) ? "possiblySubmitted" : recovery != null && recovery.call != null ? "reconciling" : "uncertain";
            boolean pending = preparingAdmissions.contains(key) || admissions.containsKey(key) || waitingClientAdmissions.contains(key) || recovery != null && recovery.call != null;
            sendPending |= pending;
            if (!stage.equals("rejected") && !stage.equals("unavailable")) stage = pending ? "admitting" : "ready";
            admission = NativeVoiceJson.object("mutationId", mutationId, "status", status,
                "cancelled", cancelledAdmissions.contains(key) || entry != null && entry.optBoolean("cancelled"));
        }
        return NativeVoiceJson.object("recordingId", record.id, "revision", record.revision,
            "threadId", record.config.length() == 0 && entry != null ? entry.optString("threadId") : record.threadId,
            "threadTitle", record.threadTitle, "stage", stage, "reason", recordingReason(record.reason),
            "hasUnrecognizedAudio", !record.complete(), "captureIncomplete", record.captureIncomplete,
            "canRetryRecognition", !busy && !dictationStorageError && active == null && !record.complete() && !record.handedOff && !record.overflow() &&
                !stage.equals("unavailable") && canListen() && retryConfigurationMatches(record),
            "canSend", !busy && !dictationStorageError && !sendPending && (record.handedOff || active == null) && record.complete() && !blank(record.text) && !record.overflow() &&
                !stage.equals("rejected") && !stage.equals("unavailable") && csrf != null && clientConnectionToken != null,
            "canCopyRecognizedText", !busy && !blank(record.text), "canDiscard", canDiscardRecording(record), "admission", admission);
    }
    private void publish() {
        if (active == null && dictationStorageError && !savedDictationBlocks()) phase = "error";
        if (active == null && binding != null && !dictationLoading && !phase.equals("starting") && !phase.equals("error"))
            phase = !settings.active() || !sessionStarted ? "off" : savedDictationBlocks() ? "recordingRecovery" : "idle";
        JSONObject recording = active == null || active.recordingId == null ? null : NativeVoiceJson.object("id", active.recordingId,
            "keepListening", active.keepListening, "reconnecting", active.reconnecting);
        JSONObject current = active == null ? null : NativeVoiceJson.object("id", active.id, "eventKind", active.event,
            "threadId", active.noticeThread, "threadTitle", active.noticeTitle, "recognitionThreadId", active.targetId,
            "recognitionThreadTitle", active.targetTitle, "automatic", active.automatic, "recording", recording);
        String readiness = readiness(), blocked = keepListeningBlockedReason();
        boolean ready = readiness.equals("ready");
        JSONObject next = NativeVoiceJson.object("version", 9, "connectionGeneration", connectionGeneration,
            "profileId", profileId, "serverOrigin", origin, "identity", identity, "originClientId", originId, "clientConnectionToken", clientConnectionToken,
            "settingsRevision", settings.revision, "settings", settings.value, "phase", phase, "ready", ready,
            "speech", NativeVoiceJson.object("credentialConfigured", speechCredential != null, "catalogStatus", catalogStatus,
                "catalog", speechCatalog == null ? null : NativeSpeechCatalog.picker(speechCatalog), "error", catalogError == null ? null : message(catalogError)),
            "readiness", readiness, "foreground", NativeVoiceJson.object("visible", foregroundVisible, "threadId", foregroundThread, "threadTitle", foregroundTitle),
            "active", current, "nextRecordingTarget", nextRecordingTarget, "queue", queue.state(), "actions", NativeVoiceJson.object("canStart", canListen() && active == null && !blockingDictation() && !defaultHeldBlocked(),
                "canStop", active != null && !active.recoveryRecognition && !active.recoverySend, "canSkip", active != null && (phase.equals("speaking") || phase.equals("synthesizing")),
                "canRetarget", active != null && phase.equals("listening") && !active.captureStopping && !active.endpointReached && !active.recordingMutationPending,
                "canSetKeepListening", blocked == null, "keepListeningBlockedReason", blocked,
                "canSend", active != null && active.keepListening && blocked == null,
                "canResume", binding != null && csrf != null && settings.active() && speechReady() && !sessionStarted && sessionStartId == null),
            "recordingRecovery", recordingRecoveryState(), "recovery", recoveryState(), "errors", NativeVoiceJson.array(errors));
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
    /** Successful finishing boundaries are bookkeeping, not user-facing failures. */
    static String recordingReason(String reason) {
        if (reason == null || reason.equals("retry") || reason.equals("send") || reason.equals("automatic")) return null;
        switch (reason) {
            case "microphone_device_unavailable": case "microphone_route_failed": return "Microphone unavailable.";
            case "headset_interrupted": return "Stopped from headset.";
            case "audio_focus_lost": return "Audio interrupted by another app.";
            case "voice_off": return "Voice turned off.";
            case "connection_changed": return "Sedes connection changed.";
            case "service_stopped": case "recording_interrupted": return "Recording interrupted.";
            default: return message(reason);
        }
    }
    static String message(String code) {
        switch (code) {
            case "recording_changed": return "That recording is no longer current.";
            case "voice_interaction_changed": return "That voice interaction has already ended.";
            case "recording_revision_conflict": return "The saved recording changed. Refresh and try again.";
            case "recording_operation_pending": return "Wait for the current recording action to finish.";
            case "recording_settings_busy": return "Finish or cancel the recording before changing recognition settings.";
            case "saved_recording_pending": return "Send or discard the saved recording before using Keep listening again.";
            case "recording_recovery_required": return "Use the saved recording controls to manage this input.";
            case "recording_retry_unavailable": return "This recording has no audio available to retry.";
            case "recording_send_unavailable": return "Complete recognition before sending the saved recording.";
            case "recording_text_unavailable": return "This recording has no recognized text to copy.";
            case "copy_failed": return "The recognized text could not be copied to the clipboard.";
            case "expired": return "The requested voice start expired before recording began.";
            case "client_action_superseded": return "A newer action cancelled the requested voice start.";
            case "stopped": return "Recognition stopped.";
            case "audio_focus_lost": return "Another app took audio focus.";
            case "voice_off": return "Voice was turned off.";
            case "service_stopped": return "Android stopped the voice service.";
            case "auto_listen_disabled": return "Automatic listening was turned off.";
            case "audio_mode_changed": return "The voice mode changed.";
            case "voice_filter_changed": return "Voice notification settings changed.";
            case "notification_connection_lost": return "The notification connection was interrupted.";
            case "notification_policy_changed": return "The notification policy changed.";
            case "invalid_notification_policy": return "The notification policy could not be read.";
            case "headset_interrupted": return "The headset stopped recording.";
            case "recording_interrupted": case "dictation_interrupted": return "Recording stopped.";
            case "dictation_storage_unavailable": case "dictation_storage_corrupt": return "The saved recording could not be read from private storage.";
            case "dictation_storage_full": return "Recording storage is full. Resolve saved recordings in their original profiles or remove an unused profile.";
            case "dictation_storage_capacity": return "The saved recording's metadata exceeds the storage limit.";
            case "dictation_audio_capacity": return "Recording stopped because too much audio is waiting for recognition. Retry the saved audio when the speech service is available.";
            case "dictation_segment_capacity": return "Recording stopped because too many audio segments are waiting for recognition. Retry the saved audio when the speech service is available.";
            case "dictation_capture_backpressure": return "Recording stopped because captured audio could not be saved quickly enough.";
            case "dictation_text_overflow": case "dictation_text_limit": case "dictation_segment_text_limit": return "The recognized text exceeds the input size limit. Copy the text to use it in smaller parts.";
            case "dictation_delete_failed": case "dictation_temporary_cleanup_failed": return "Saved recording files could not be removed. Retry the voice connection to finish cleanup.";
            case "dictation_directory_unavailable": case "dictation_replace_failed": case "dictation_store_closed": return "This device's private recording storage is unavailable. Retry the voice connection.";
            case "dictation_discarded": return "That saved recording has already been discarded.";
            case "dictation_stale": case "dictation_attempt_stale": case "dictation_segment_stale": return "The saved recording changed before this action finished. Refresh and try again.";
            case "dictation_not_capturing": case "dictation_not_finished": case "dictation_finish_invalid": case "dictation_invalid_state":
                return "The recording is not ready for this action. Refresh its saved recording controls.";
            case "dictation_not_deliverable": case "dictation_request_missing": return "The saved recording is not ready to send. Complete recognition first.";
            case "dictation_record_limit": return "A saved recording already occupies this profile. Resolve it before recording again.";
            case "dictation_segment_incompatible": return "The saved audio segment exceeds this speech service's recognition limits.";
            case "dictation_configuration_invalid": case "dictation_config_invalid": case "dictation_limits_invalid":
                return "The saved recording's speech configuration is invalid. Check Voice settings.";
            case "dictation_attempt_invalid": case "dictation_binding_invalid": case "dictation_identity_conflict": case "dictation_identity_invalid":
            case "dictation_intent_invalid": case "dictation_pcm_invalid": case "dictation_capture_invalid": case "dictation_preference_invalid":
            case "dictation_prefix_invalid": case "dictation_read_invalid": case "dictation_reason_invalid": case "dictation_record_invalid":
            case "dictation_request_invalid": case "dictation_retirement_conflict": case "dictation_retirement_missing":
            case "dictation_segment_invalid": case "dictation_segment_order": case "dictation_segments_invalid": case "dictation_stage_invalid":
            case "dictation_target_invalid": case "dictation_terminal_invalid": case "dictation_text_invalid":
                return "The saved recording's data is inconsistent. Copy any available recognized text or discard the recording.";
            case "dictation_flush_timeout": return "Saving the captured audio took too long. The durable audio remains available.";
            case "timeout": return "The listening time limit was reached. Send the saved recording when ready.";
            case "send_interrupted": return "Recognition was interrupted while sending. Review and send the saved recording when complete.";
            case "dictation_reconnect_exhausted": return "Recognition retries stopped. Retry the saved audio when the service is available.";
            case "dictation_reconnect_timeout": return "The speech service remained unavailable for too long. Retry the saved audio when it is available.";
            case "dictation_finalization_conflict": return "The saved recording and its input request do not match.";
            case "speech_transcription_model_unsupported": return "This transcription model does not support Keep listening.";
            case "speech_server_configuration_unsupported": return "This speech server does not provide the recognition limits required for recording.";
            case "recognition_session_timing_unsupported": return "The speech service session limit is too short for the selected recognition timeout.";
            case "voice_target_required": return "Choose a thread for voice input.";
            case "voice_busy": return "Stop the current voice interaction before recording.";
            case "voice_not_ready": return "Voice is not ready yet.";
            case "voice_not_listening": return "Voice is not recording.";
            case "voice_not_speaking": return "Voice is not speaking.";
            case "voice_reply_empty": return "This response has no text to speak.";
            case "voice_queue_full": return "The voice queue is full. Try again after current speech finishes.";
            case "connection_changed": return "The Sedes connection changed before the voice action finished.";
            case "client_connection_replaced": return "Client controls moved to another window. Retry the voice connection to use this device.";
            case "authentication_required": return "Pair this Sedes connection before using voice.";
            case "connection_unavailable": return "Sedes could not be reached for voice. Check the connection, then retry.";
            case "session_unavailable": return "Sedes did not start a voice session. Retry the voice connection.";
            case "credential_storage_unavailable": return "This device's secure credential storage could not be read. Retry the voice connection.";
            case "voice_storage_unavailable": return "This device's private voice storage is unavailable.";
            case "voice_settings_reset": return "Saved voice settings could not be read and were reset to defaults.";
            case "voice_journal_reset": return "Pending voice input recovery records could not be read and were cleared.";
            case "voice_journal_capacity": return "Too many voice inputs are awaiting recovery. Resume or discard them in Voice settings.";
            case "connection_identity_changed": return "The Sedes identity changed. Refresh the connection before using voice.";
            case "settings_revision_conflict": return "Voice settings changed. Refresh and try again.";
            case "microphone_permission_required": return "Allow microphone access from the visible app.";
            case "speech_configuration_required": return "Choose a speech endpoint, models and voice, and add the required credential.";
            case "speech_configuration_changed": return "Speech settings changed before this action finished.";
            case "speech_credential_storage_unavailable": return "This device's secure speech credential storage could not be read.";
            case "speech_credential_cleanup_failed": return "Obsolete speech credentials could not be removed from this device. Retry the voice connection when device storage is available.";
            case "speech_test_replaced": return "A newer speech settings check replaced this one.";
            case "speech_discovery_unavailable": return "The speech service could not be reached for model discovery.";
            case "speech_discovery_invalid": return "The speech service returned an unreadable model catalog.";
            case "speech_discovery_cancelled": return "Speech model discovery was cancelled.";
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
            case "speech_authentication_failed": case "recognition_authentication_failed": return "The speech service rejected its credential. Check the credential in Voice settings.";
            case "speech_rate_limited": case "recognition_rate_limited": return "The speech service is rate limited. Try again shortly.";
            case "speech_quota_exceeded": case "recognition_quota_exceeded": return "The speech service account has no available quota. Update its billing or credits before retrying.";
            case "speech_http_error": case "recognition_http_error": return "The speech service rejected the request. Check its models and configuration.";
            case "speech_network_error": case "recognition_network_error": case "recognition_disconnected": return "The speech service connection was interrupted. Try again.";
            case "recognition_handshake_timeout": return "The speech service did not configure recognition in time.";
            case "recognition_protocol_error": case "recognition_unexpected_binary": return "The speech service sent a recognition message this app could not read.";
            case "recognition_message_limit": return "The speech service sent a recognition message larger than the allowed limit.";
            case "recognition_model_busy": case "recognition_server_busy": return "The speech service is busy. Recognition will retry while audio remains safely saved.";
            case "recognition_session_expired": case "recognition_session_budget": return "The speech session expired. Retry recognition of the saved audio.";
            case "recognition_session_lifetime_invalid": return "The speech service returned an invalid recognition session lifetime.";
            case "recognition_invalid_attempt": case "recognition_invalid_commit": return "The speech service could not match this recognition attempt. Retry the saved audio.";
            case "recognition_invalid_timeout": return "The recognition timeout is outside the supported range.";
            case "recognition_invalid_duration": case "recognition_invalid_pcm": return "The captured audio is not valid for recognition.";
            case "recognition_buffer_limit": return "The audio exceeds the speech service's recognition buffer limit.";
            case "recognition_request_timeout": return "The speech service did not respond to recognition in time.";
            case "recognition_provider_error": return "The speech service could not transcribe this recording.";
            case "speech_invalid_content_type": return "The speech service returned an unsupported audio format.";
            case "speech_timeout": return "Speech did not finish in time.";
            case "speech_duration_limit": return "This speech request exceeded the ten-minute audio limit. Reduce the speech text limit to split it into smaller requests.";
            case "speech_storage_limit": return "This speech request exceeded the bounded audio storage limit.";
            case "speech_storage_unavailable": return "Speech could not be buffered in this device's private cache.";
            case "audio_focus_unavailable": return "Another app is using audio. Voice could not take audio focus.";
            case "empty_pcm_stream": return "The speech service returned no audio.";
            case "playback_drain_timeout": return "Speech audio did not finish playing in time.";
            case "invalid_pcm": return "The speech service sent audio this app cannot play.";
            case "microphone_device_unavailable": return "The selected microphone is unavailable. Choose another input in Voice settings.";
            case "microphone_route_failed": return "Android could not route recording to the selected microphone.";
            case "microphone_format_unavailable": return "The selected microphone could not record 24 kHz mono audio.";
            case "microphone_limit_reached": return "The recording reached its maximum length.";
            case "recognition_failed": return "Speech could not be recognized.";
            case "recognition_timeout": case "recognition_capture_timeout": case "recognition_result_timeout": return "Speech recognition did not finish in time.";
            case "recognition_cue_timeout": return "The recognition start cue did not finish playing.";
            case "recognition_transport_overflow": return "Recorded audio could not be sent to the speech service fast enough.";
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
