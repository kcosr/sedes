package dev.sedes.local;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.view.KeyEvent;
import android.widget.RemoteViews;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;

/** Non-exported foreground owner, started only while the app is visible. */
public final class NativeVoiceRuntimeService extends Service {
    static final String ACTION_START = "dev.sedes.local.voice.START";
    static final String ACTION_OPEN = "dev.sedes.local.voice.OPEN";
    private static final String CHANNEL = "sedes.voice";
    private static final int NOTIFICATION = 3107;
    private NativeVoiceRuntime runtime;
    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean foreground, working;
    private long connectionGeneration;
    private String sessionStartId;
    private int lastStartId = -1;
    private final Runnable renewWakeLock = new Runnable() {
        @Override public void run() {
            if (!foreground || !working) return;
            wakeLock.acquire(10 * 60 * 1000L);
            main.postDelayed(this, 5 * 60 * 1000L);
        }
    };
    @Override public void onCreate() {
        super.onCreate(); runtime = NativeVoiceRuntime.get(this);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Voice session", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Controls for an enabled Sedes voice session"); channel.setSound(null, null);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        mediaSession = new MediaSession(this, "Sedes voice");
        // API 24-25 deliver headset buttons and transport controls only to sessions that declare these flags.
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public boolean onMediaButtonEvent(Intent intent) {
                KeyEvent event = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (event != null && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 &&
                    (event.getKeyCode() == KeyEvent.KEYCODE_HEADSETHOOK || event.getKeyCode() == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
                        event.getKeyCode() == KeyEvent.KEYCODE_MEDIA_PLAY || event.getKeyCode() == KeyEvent.KEYCODE_MEDIA_PAUSE)) {
                    mediaAction("headset"); return true;
                }
                return super.onMediaButtonEvent(intent);
            }
            @Override public void onPlay() { mediaAction("headset"); }
            @Override public void onPause() { mediaAction("headset"); }
            @Override public void onStop() { mediaAction("headset_stop"); }
            @Override public void onSkipToNext() { mediaAction("headset_skip"); }
        });
        PowerManager power = getSystemService(PowerManager.class);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sedes:voice"); wakeLock.setReferenceCounted(false);
    }
    @Override public int onStartCommand(Intent intent, int flags, int serviceStartId) {
        lastStartId = serviceStartId;
        if (intent == null) { finish(); return START_NOT_STICKY; }
        long expectedGeneration = intent.getLongExtra("voiceGeneration", -1);
        String startId = intent.getStringExtra("voiceStartId");
        boolean start = ACTION_START.equals(intent.getAction()), attachedSession = foreground;
        // startForegroundService requires startForeground even when this launch turns out to be stale.
        if (start && !foreground) {
            try { enterForeground(); }
            catch (SecurityException | IllegalStateException error) { runtime.startFailed(expectedGeneration, startId); finish(); return START_NOT_STICKY; }
        }
        if (expectedGeneration != runtime.snapshot().optLong("connectionGeneration")) {
            if (!attachedSession) finish();
            return START_NOT_STICKY;
        }
        if (start && !runtime.acceptsSessionStart(expectedGeneration, startId)) {
            runtime.deferSessionStart(expectedGeneration, startId);
            if (!attachedSession) finish();
            return START_NOT_STICKY;
        }
        // A notification from an ended session must not cold-start another session.
        if (!start && !foreground) { finish(); return START_NOT_STICKY; }
        if (start) {
            connectionGeneration = expectedGeneration; sessionStartId = startId;
            runtime.attached(this, expectedGeneration, startId);
        } else if (sessionStartId != null && sessionStartId.equals(startId)) {
            runtime.notificationAction(intent.getAction(), expectedGeneration,
                intent.getStringExtra("voiceInteractionId"), intent.getStringExtra("voiceRecordingId"));
        }
        return START_NOT_STICKY;
    }
    private void enterForeground() {
        Notification notification = build(runtime.snapshot());
        if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFICATION, notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIFICATION, notification);
        foreground = true;
    }
    void render(JSONObject state) {
        if (!foreground) return;
        getSystemService(NotificationManager.class).notify(NOTIFICATION, build(state));
        JSONObject settings = state.optJSONObject("settings");
        boolean enabled = settings != null && settings.optBoolean("headsetControls") && !settings.optString("audioMode").equals("off");
        mediaSession.setActive(enabled);
        String phase = state.optString("phase");
        mediaSession.setPlaybackState(new PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE |
            PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP | PlaybackState.ACTION_SKIP_TO_NEXT)
            .setState(phase.equals("speaking") ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, 0, 1f).build());
        boolean nextWorking = wakeLockNeeded(state);
        if (nextWorking != working) {
            working = nextWorking; main.removeCallbacks(renewWakeLock);
            if (working) renewWakeLock.run();
            else if (wakeLock.isHeld()) wakeLock.release();
        }
    }
    static boolean wakeLockNeeded(JSONObject state) {
        String phase = state.optString("phase");
        return state.optJSONObject("active") != null && !phase.equals("recordingRecovery") &&
            !phase.equals("idle") && !phase.equals("off") && !phase.equals("error");
    }
    private void mediaAction(String action) {
        if (!foreground) return;
        JSONObject state = runtime.snapshot(), active = state.optJSONObject("active");
        JSONObject recording = active == null ? null : active.optJSONObject("recording");
        runtime.notificationAction(action, state.optLong("connectionGeneration"),
            active == null ? null : nullable(active, "id"), recording == null ? null : nullable(recording, "id"));
    }
    /** The notification's label, open action and Start eligibility share one target decision. */
    static JSONObject notificationTarget(JSONObject state) {
        JSONObject active = state.optJSONObject("active"), settings = state.optJSONObject("settings");
        String phase = state.optString("phase", "starting"), threadId = null, threadTitle = null;
        if (active != null) {
            boolean recording = phase.equals("validating") || phase.equals("arming") || phase.equals("listening") || phase.equals("recognizing") || phase.equals("submitting") || phase.equals("recovering");
            threadId = nullable(active, recording ? "recognitionThreadId" : "threadId");
            threadTitle = nullable(active, recording ? "recognitionThreadTitle" : "threadTitle");
        } else if (phase.equals("recordingRecovery") && state.optJSONObject("recordingRecovery") != null) {
            JSONObject recovery = state.optJSONObject("recordingRecovery");
            threadId = nullable(recovery, "threadId"); threadTitle = nullable(recovery, "threadTitle");
        } else if (settings != null) {
            return NativeVoiceRuntime.defaultRecordingTarget(settings);
        }
        return NativeVoiceJson.object("threadId", threadId, "threadTitle", threadTitle);
    }
    private Notification build(JSONObject state) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL);
        JSONObject settings = state.optJSONObject("settings"), actions = state.optJSONObject("actions"), target = notificationTarget(state);
        String phase = state.optString("phase", "starting"), threadId = nullable(target, "threadId"), threadTitle = nullable(target, "threadTitle");
        String title = threadTitle == null ? (threadId == null ? "Sedes voice" : threadId) : threadTitle;
        Intent open = new Intent(this, MainActivity.class).setAction(ACTION_OPEN).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("voiceThreadId", threadId).putExtra("voiceProfileId", nullable(state, "profileId"))
            .putExtra("voiceServerOrigin", nullable(state, "serverOrigin")).putExtra("voiceIdentity", nullable(state, "identity"));
        builder.setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle(title).setContentText(label(phase))
            .setContentIntent(PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
            .setOngoing(true).setOnlyAlertOnce(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setCategory(NotificationCompat.CATEGORY_SERVICE);
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        String mode = settings != null && settings.optString("audioMode").equals("manual") ? "Manual" : "Response";
        String rearm = settings != null && settings.optBoolean("autoListen") ? "Rearm on" : "Rearm off";
        JSONObject active = state.optJSONObject("active"), recording = active == null ? null : active.optJSONObject("recording");
        boolean held = recording != null && recording.optBoolean("keepListening");
        if (actions != null && actions.optBoolean("canStop") && actions.optBoolean("canSkip") && settings != null) {
            // Standard templates show at most three actions. The expanded ordinary notification
            // keeps all playback controls accessible; custom content is ineligible for promotion.
            RemoteViews controls = new RemoteViews(getPackageName(), R.layout.notification_voice_controls);
            controls.setTextViewText(R.id.voice_notification_title, title);
            controls.setTextViewText(R.id.voice_notification_status, label(phase));
            controls.setTextViewText(R.id.voice_notification_mode, mode);
            controls.setTextViewText(R.id.voice_notification_rearm, rearm);
            controls.setBoolean(R.id.voice_notification_record, "setEnabled", actions.optBoolean("canRecordDuringPlayback"));
            controls.setOnClickPendingIntent(R.id.voice_notification_record, pending("record", state));
            controls.setOnClickPendingIntent(R.id.voice_notification_stop, pending("stop", state));
            controls.setOnClickPendingIntent(R.id.voice_notification_next, pending("skip", state));
            controls.setOnClickPendingIntent(R.id.voice_notification_mode, pending("mode", state));
            controls.setOnClickPendingIntent(R.id.voice_notification_rearm, pending("rearm", state));
            builder.setCustomBigContentView(controls).setStyle(new NotificationCompat.DecoratedCustomViewStyle());
        } else {
            if (Build.VERSION.SDK_INT >= 36) builder.setRequestPromotedOngoing(true);
            if (actions != null && actions.optBoolean("canStop")) builder.addAction(action(
                phase.equals("listening") || phase.equals("recognizing") ? "Cancel" : "Stop", "stop", android.R.drawable.ic_media_pause, state));
            if (actions != null && actions.optBoolean("canSend")) builder.addAction(action("Send", "send", android.R.drawable.ic_menu_send, state));
            if (actions != null && actions.optBoolean("canStart") && threadId != null) builder.addAction(action("Start", "start", android.R.drawable.ic_btn_speak_now, state));
            if (settings != null && !held) {
                builder.addAction(action(mode, "mode", android.R.drawable.ic_menu_manage, state));
                builder.addAction(action(rearm, "rearm", android.R.drawable.ic_menu_rotate, state));
            }
        }
        return builder.build();
    }
    private NotificationCompat.Action action(String title, String action, int icon, JSONObject state) {
        return new NotificationCompat.Action.Builder(icon, title, pending(action, state)).build();
    }
    private PendingIntent pending(String action, JSONObject state) {
        long generation = state.optLong("connectionGeneration");
        JSONObject active = state.optJSONObject("active"), recording = active == null ? null : active.optJSONObject("recording");
        String interactionId = active == null ? null : nullable(active, "id"), recordingId = recording == null ? null : nullable(recording, "id");
        Uri identity = new Uri.Builder().scheme("sedes-voice").authority("control").appendPath(Long.toString(generation))
            .appendPath(sessionStartId == null ? "starting" : sessionStartId).appendPath(action)
            .appendPath(interactionId == null ? "idle" : interactionId).appendPath(recordingId == null ? "none" : recordingId).build();
        return PendingIntent.getService(this, action.hashCode() ^ Long.hashCode(generation),
            new Intent(this, NativeVoiceRuntimeService.class).setAction(action).setData(identity)
                .putExtra("voiceGeneration", generation).putExtra("voiceStartId", sessionStartId)
                .putExtra("voiceInteractionId", interactionId).putExtra("voiceRecordingId", recordingId),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private static String nullable(JSONObject object, String key) { return object.isNull(key) ? null : object.optString(key, null); }
    private static String label(String phase) {
        switch (phase) {
            case "idle": return "Ready";
            case "synthesizing": return "Preparing speech";
            case "speaking": return "Speaking";
            case "validating": return "Checking the target thread";
            case "arming": return "Preparing microphone";
            case "listening": return "Listening";
            case "recognizing": return "Recognizing speech";
            case "submitting": return "Sending recognized text";
            case "recovering": return "Checking input delivery";
            case "recordingRecovery": return "Saved dictation";
            case "cancelling": return "Stopping audio";
            default: return "Starting voice";
        }
    }
    /** Stops only if no newer start was issued; a pending foreground start must still reach onStartCommand. */
    void finish() {
        if (foreground) { stopForeground(STOP_FOREGROUND_REMOVE); foreground = false; }
        releaseWakeLock(); stopSelf(lastStartId);
    }
    private void releaseWakeLock() {
        working = false; main.removeCallbacks(renewWakeLock);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }
    void finishStart(long generation, String startId) {
        if (generation == connectionGeneration && startId != null && startId.equals(sessionStartId)) finish();
    }
    @Override public void onDestroy() {
        // A render already queued on the main thread must not re-post the notification or reacquire the wake lock.
        foreground = false;
        if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); }
        releaseWakeLock();
        runtime.detached(this); super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
