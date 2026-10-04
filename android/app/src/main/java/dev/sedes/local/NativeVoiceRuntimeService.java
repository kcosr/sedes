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
import android.os.Build;
import android.os.IBinder;
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
    private boolean foreground;
    private long connectionGeneration;
    private String sessionStartId;
    private int lastStartId = -1;
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
                    runtime.notificationAction("headset"); return true;
                }
                return super.onMediaButtonEvent(intent);
            }
            @Override public void onPlay() { runtime.notificationAction("headset"); }
            @Override public void onPause() { runtime.notificationAction("headset"); }
            @Override public void onStop() { runtime.notificationAction("headset_stop"); }
            @Override public void onSkipToNext() { runtime.notificationAction("headset_skip"); }
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
        } else runtime.notificationAction(intent.getAction(), expectedGeneration);
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
        boolean working = state.optJSONObject("active") != null;
        if (working && !wakeLock.isHeld()) wakeLock.acquire(10 * 60 * 1000L);
        if (!working && wakeLock.isHeld()) wakeLock.release();
    }
    /** The notification's label, open action and Start eligibility share one target decision. */
    static JSONObject notificationTarget(JSONObject state) {
        JSONObject active = state.optJSONObject("active"), settings = state.optJSONObject("settings");
        String phase = state.optString("phase", "starting"), threadId = null, threadTitle = null;
        if (active != null) {
            boolean recording = phase.equals("validating") || phase.equals("arming") || phase.equals("listening") || phase.equals("recognizing") || phase.equals("submitting") || phase.equals("recovering");
            threadId = nullable(active, recording ? "recognitionThreadId" : "threadId");
            threadTitle = nullable(active, recording ? "recognitionThreadTitle" : "threadTitle");
        } else if (settings != null) {
            JSONObject foreground = state.optJSONObject("foreground");
            if (!settings.optBoolean("pinDefaultVoiceThread") && foreground != null && foreground.optBoolean("visible")) {
                threadId = nullable(foreground, "threadId"); threadTitle = nullable(foreground, "threadTitle");
            }
            if (threadId == null) { threadId = nullable(settings, "voiceThreadId"); threadTitle = nullable(settings, "voiceThreadTitle"); }
            if (threadId == null) threadTitle = null;
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
        if (actions != null && actions.optBoolean("canStop") && actions.optBoolean("canSkip") && settings != null) {
            // Standard templates show at most three actions. The expanded ordinary notification
            // keeps all four playback controls accessible; custom content is ineligible for promotion.
            RemoteViews controls = new RemoteViews(getPackageName(), R.layout.notification_voice_controls);
            controls.setTextViewText(R.id.voice_notification_title, title);
            controls.setTextViewText(R.id.voice_notification_status, label(phase));
            controls.setTextViewText(R.id.voice_notification_mode, mode);
            controls.setTextViewText(R.id.voice_notification_rearm, rearm);
            controls.setOnClickPendingIntent(R.id.voice_notification_stop, pending("stop"));
            controls.setOnClickPendingIntent(R.id.voice_notification_skip, pending("skip"));
            controls.setOnClickPendingIntent(R.id.voice_notification_mode, pending("mode"));
            controls.setOnClickPendingIntent(R.id.voice_notification_rearm, pending("rearm"));
            builder.setCustomBigContentView(controls).setStyle(new NotificationCompat.DecoratedCustomViewStyle());
        } else {
            if (Build.VERSION.SDK_INT >= 36) builder.setRequestPromotedOngoing(true);
            if (actions != null && actions.optBoolean("canStop")) builder.addAction(action("Stop", "stop", android.R.drawable.ic_media_pause));
            if (actions != null && actions.optBoolean("canStart") && threadId != null) builder.addAction(action("Start", "start", android.R.drawable.ic_btn_speak_now));
            if (settings != null) {
                builder.addAction(action(mode, "mode", android.R.drawable.ic_menu_manage));
                builder.addAction(action(rearm, "rearm", android.R.drawable.ic_menu_rotate));
            }
        }
        return builder.build();
    }
    private NotificationCompat.Action action(String title, String action, int icon) {
        return new NotificationCompat.Action.Builder(icon, title, pending(action)).build();
    }
    private PendingIntent pending(String action) {
        long generation = runtime.snapshot().optLong("connectionGeneration");
        return PendingIntent.getService(this, action.hashCode() ^ Long.hashCode(generation),
            new Intent(this, NativeVoiceRuntimeService.class).setAction(action).putExtra("voiceGeneration", generation),
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
            case "cancelling": return "Stopping audio";
            default: return "Starting voice";
        }
    }
    /** Stops only if no newer start was issued; a pending foreground start must still reach onStartCommand. */
    void finish() { if (foreground) { stopForeground(STOP_FOREGROUND_REMOVE); foreground = false; } stopSelf(lastStartId); }
    void finishStart(long generation, String startId) {
        if (generation == connectionGeneration && startId != null && startId.equals(sessionStartId)) finish();
    }
    @Override public void onDestroy() {
        // A render already queued on the main thread must not re-post the notification or reacquire the wake lock.
        foreground = false;
        if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        runtime.detached(this); super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
