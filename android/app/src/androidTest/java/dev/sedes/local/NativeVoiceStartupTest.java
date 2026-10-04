package dev.sedes.local;

import static org.junit.Assert.*;
import android.Manifest;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.junit.Test;

/** Real encrypted settings, authentication bootstrap, lifecycle and main-thread launch scheduling. */
public class NativeVoiceStartupTest {
    @Test public void savedModesStartOnceAfterAuthenticationWithoutOpeningTheMicrophone() throws Exception {
        for (String mode : new String[] { "manual", "response" }) {
            try (Fixture f = new Fixture(mode, true, true)) {
                f.runtime.nativeVisibility(true);
                Reply connection = f.beginConnection(f.profile);
                f.authenticate(); f.flush(); assertTrue(f.starts.isEmpty());
                f.session(); connection.await();
                Intent start = f.start();
                assertEquals(NativeVoiceRuntimeService.ACTION_START, start.getAction());
                assertTrue(f.accepted(start));
                assertEquals(mode, f.runtime.snapshot().getJSONObject("settings").getString("audioMode"));
                assertEquals(1, f.runtime.snapshot().getLong("settingsRevision"));
                assertEquals("starting", f.runtime.snapshot().getString("phase"));
                assertFalse(f.runtime.snapshot().getJSONObject("actions").getBoolean("canResume"));
                assertTrue(f.runtime.snapshot().isNull("active"));
                f.runtime.nativeVisibility(true); f.runtime.nativeVisibility(true);
                f.beginConnection(f.profile).await(); f.flush();
                assertTrue("Duplicate lifecycle/bootstrap created another service start", f.starts.isEmpty());
            }
        }
    }

    @Test public void restorationWaitsForVisibilityAndRequiredConfiguration() throws Exception {
        for (String mode : new String[] { "off", "manual", "response" }) {
            try (Fixture f = new Fixture(mode, true, true)) {
                f.connect(); f.flush(); assertTrue(f.starts.isEmpty());
                f.runtime.nativeVisibility(true); f.flush();
                if (mode.equals("off")) assertTrue(f.starts.isEmpty());
                else assertTrue(f.accepted(f.start()));
            }
        }
        for (boolean configured : new boolean[] { false, true }) {
            try (Fixture f = new Fixture("response", false, configured)) {
                f.runtime.nativeVisibility(true); f.connect(); f.flush(); assertTrue(f.starts.isEmpty());
                assertEquals("permissionRequired", f.runtime.snapshot().getString("readiness"));
                f.runtime.nativeVisibility(false); f.flush(); f.permissionGranted = true;
                f.runtime.nativeVisibility(true); f.flush();
                if (configured) assertTrue(f.accepted(f.start()));
                else {
                    assertTrue(f.starts.isEmpty());
                    assertEquals("adapterRequired", f.runtime.snapshot().getString("readiness"));
                }
            }
        }
    }

    @Test public void pauseOffAndProfileChangeInvalidateQueuedStarts() throws Exception {
        for (String action : new String[] { "pause", "off", "profile" }) {
            try (Fixture f = new Fixture("response", true, true)) {
                f.connect();
                try (MainBlock blocked = new MainBlock()) {
                    f.runtime.nativeVisibility(true); f.ownerBarrier();
                    assertFalse(f.runtime.snapshot().getJSONObject("actions").getBoolean("canResume"));
                    if (action.equals("pause")) { f.runtime.nativeVisibility(false); f.ownerBarrier(); }
                    else if (action.equals("off")) f.updateMode("off");
                    else {
                        Reply other = f.beginConnection(f.otherProfile);
                        f.authenticate(); f.session(); other.await();
                    }
                }
                f.flush(); assertTrue("An obsolete start reached Android: " + action, f.starts.isEmpty());
                if (action.equals("pause")) {
                    assertEquals("needsResume", f.runtime.snapshot().getString("readiness"));
                    f.runtime.nativeVisibility(true); assertTrue(f.accepted(f.start()));
                } else assertEquals("off", f.runtime.snapshot().getString("readiness"));
            }
        }
    }

    @Test public void failedStartCanRetryWithoutAcceptingStaleCallbacks() throws Exception {
        try (Fixture f = new Fixture("response", true, true)) {
            f.runtime.nativeVisibility(true); f.connect(); Intent first = f.start();
            f.fail(first); f.flush();
            assertTrue(f.runtime.snapshot().getJSONObject("actions").getBoolean("canResume"));
            f.runtime.nativeVisibility(true); f.flush(); assertTrue(f.starts.isEmpty());
            f.updateMode("response"); Intent retry = f.start();
            assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
            assertNotEquals(first.getStringExtra("voiceStartId"), retry.getStringExtra("voiceStartId"));
            assertFalse(f.accepted(first)); assertTrue(f.accepted(retry));
            f.fail(first); f.flush(); assertTrue(f.accepted(retry));
            assertEquals("starting", f.runtime.snapshot().getString("phase"));
            f.updateMode("off"); assertFalse(f.accepted(retry));
            f.runtime.deferSessionStart(retry.getLongExtra("voiceGeneration", -1), retry.getStringExtra("voiceStartId"));
            f.flush(); assertTrue(f.starts.isEmpty()); assertEquals("off", f.runtime.snapshot().getString("readiness"));
        }
    }

    @Test public void oldAuthenticationCannotRestoreVoiceIntoAnotherProfile() throws Exception {
        try (Fixture f = new Fixture("response", true, true)) {
            f.runtime.nativeVisibility(true);
            Reply old = f.beginConnection(f.profile);
            NativeVoiceHttp.Result oldAuth = f.take(f.auth);
            Reply current = f.beginConnection(f.otherProfile);
            f.authenticate(); f.session(); current.await();
            oldAuth.done(200, f.authenticated(), null);
            assertEquals("connection_changed", old.failure()); f.flush();
            assertEquals(f.otherProfile, f.runtime.snapshot().getString("profileId"));
            assertEquals("off", f.runtime.snapshot().getString("readiness"));
            assertTrue(f.starts.isEmpty()); assertTrue(f.sessions.isEmpty());
        }
    }

    @Test public void permissionResultBeforeResumeStartsTheFirstEnable() throws Exception {
        try (Fixture f = new Fixture("off", true, true); ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            f.runtime.nativeVisibility(true); f.connect(); f.flush();
            // A permission dialog covers the activity: it is paused but still STARTED when Android returns the result.
            scenario.moveToState(Lifecycle.State.STARTED);
            f.runtime.nativeVisibility(false); f.flush();
            // The plugin's permission callback path, before it queues the user-initiated enable.
            scenario.onActivity(activity -> NativeVoicePlugin.markVisibleForPermissionResult(activity, f.runtime));
            f.updateMode("response");
            assertTrue(f.accepted(f.start()));
            assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
            // A stopped activity is not visible, so a late result cannot authorize a foreground start.
            scenario.moveToState(Lifecycle.State.CREATED);
            AtomicBoolean visible = new AtomicBoolean(true);
            scenario.onActivity(activity -> visible.set(NativeVoicePlugin.visibleForPermissionResult(activity)));
            assertFalse(visible.get());
        }
    }

    @Test public void enableWithoutVisibilityIsRejectedButPersisted() throws Exception {
        try (Fixture f = new Fixture("off", true, true)) {
            f.connect(); f.flush();
            Reply reply = new Reply(); f.runtime.command("updateSettings", NativeVoiceJson.object("expectedRevision", 1,
                "patch", NativeVoiceJson.object("audioMode", "response")), true, reply);
            assertEquals("resume_from_visible_app", reply.failure()); f.flush();
            assertTrue(f.starts.isEmpty()); assertEquals("response", f.runtime.snapshot().getJSONObject("settings").getString("audioMode"));
        }
    }

    @Test public void corruptSettingsAreQuarantinedAndTheConnectionContinues() throws Exception {
        try (Fixture f = new Fixture("response", true, true)) {
            String binding = NativeVoiceStore.binding(f.profile, f.origin, Fixture.IDENTITY);
            byte[] garbage = new byte[64]; garbage[0] = 1;
            Files.write(new File(f.store.directory(binding), "settings.enc").toPath(), garbage);
            f.runtime.nativeVisibility(true); f.connect(); f.flush();
            JSONObject state = f.runtime.snapshot();
            assertEquals("off", state.getJSONObject("settings").getString("audioMode")); assertFalse(state.isNull("originClientId"));
            assertEquals("voice_settings_reset", state.getJSONArray("errors").getJSONObject(0).getString("code"));
            assertTrue(new File(f.store.directory(binding), "settings.corrupt").exists()); assertTrue(f.starts.isEmpty());
        }
    }

    @Test public void connectionFailuresReportConnectivitySeparatelyFromPairing() throws Exception {
        for (int status : new int[] { 0, 401, 503 }) {
            try (Fixture f = new Fixture("response", true, true)) {
                Reply reply = f.beginConnection(f.profile);
                f.take(f.auth).done(status, null, status == 0 ? "network_unavailable" : null);
                assertEquals(status == 401 ? "authentication_required" : "connection_unavailable", reply.failure());
                f.flush(); assertEquals("error", f.runtime.snapshot().getString("readiness"));
            }
        }
    }

    private static final class Reply implements NativeVoiceRuntime.Reply {
        final CountDownLatch done = new CountDownLatch(1);
        String failure;
        public void done(JSONObject value) { done.countDown(); }
        public void failed(String code, String message) { failure = code; done.countDown(); }
        String failure() throws Exception { assertTrue(done.await(10, TimeUnit.SECONDS)); return failure; }
        void await() throws Exception { assertNull(failure()); }
    }
    private static final class MainBlock implements AutoCloseable {
        final CountDownLatch release = new CountDownLatch(1);
        MainBlock() throws Exception {
            CountDownLatch entered = new CountDownLatch(1);
            new Handler(Looper.getMainLooper()).post(() -> {
                entered.countDown();
                try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            });
            assertTrue(entered.await(10, TimeUnit.SECONDS));
        }
        public void close() { release.countDown(); }
    }
    private static final class Fixture implements AutoCloseable {
        static final String IDENTITY = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        final String profile = "voice-startup-" + UUID.randomUUID(), otherProfile = "voice-startup-" + UUID.randomUUID();
        final String origin = "http://127.0.0.1:65124";
        volatile boolean permissionGranted;
        final Context context = new ContextWrapper(InstrumentationRegistry.getInstrumentation().getTargetContext()) {
            @Override public Context getApplicationContext() { return this; }
            @Override public int checkPermission(String permission, int pid, int uid) {
                return Manifest.permission.RECORD_AUDIO.equals(permission) ? microphonePermission() : super.checkPermission(permission, pid, uid);
            }
            @Override public int checkSelfPermission(String permission) {
                return Manifest.permission.RECORD_AUDIO.equals(permission) ? microphonePermission() : super.checkSelfPermission(permission);
            }
            private int microphonePermission() { return permissionGranted ? PackageManager.PERMISSION_GRANTED : PackageManager.PERMISSION_DENIED; }
        };
        final NativeVoiceRuntime runtime;
        final NativeVoiceStore store;
        final Handler owner;
        final BlockingQueue<NativeVoiceHttp.Result> auth = new LinkedBlockingQueue<>(), sessions = new LinkedBlockingQueue<>();
        final BlockingQueue<Intent> starts = new LinkedBlockingQueue<>();
        Fixture(String mode, boolean permission, boolean configured) throws Exception {
            permissionGranted = permission;
            Constructor<NativeVoiceRuntime> constructor = NativeVoiceRuntime.class.getDeclaredConstructor(Context.class);
            constructor.setAccessible(true); runtime = constructor.newInstance(context);
            Field field = NativeVoiceRuntime.class.getDeclaredField("handler"); field.setAccessible(true); owner = (Handler) field.get(runtime);
            store = new NativeVoiceStore(context);
            store.settings(NativeVoiceStore.binding(profile, origin, IDENTITY), NativeVoiceSettings.defaults().patch(0,
                NativeVoiceJson.object("audioMode", mode, "adapterUrl", configured ? "http://127.0.0.1:65125" : "")));
            runtime.setTestSessionStarter(intent -> starts.add(intent));
            NativeVoiceHttp.setTestTransport(new NativeVoiceHttp.TestTransport() {
                public boolean before(String method, String path, JSONObject body, NativeVoiceHttp.Result result) {
                    if (method.equals("GET") && path.equals("/api/auth/status")) auth.add(result);
                    else if (method.equals("GET") && path.equals("/api/application/session")) sessions.add(result);
                    else throw new AssertionError("Unexpected startup request: " + method + " " + path);
                    return true;
                }
                public boolean after(String method, String path, JSONObject body, int status, JSONObject response, NativeVoiceHttp.Result result) { return false; }
            });
        }
        Reply beginConnection(String selectedProfile) {
            Reply reply = new Reply(); runtime.command("setConnection", NativeVoiceJson.object("profileId", selectedProfile,
                "serverOrigin", origin, "identity", IDENTITY), false, reply); return reply;
        }
        void connect() throws Exception { Reply reply = beginConnection(profile); authenticate(); session(); reply.await(); }
        JSONObject authenticated() { return NativeVoiceJson.object("required", true, "authenticated", true, "navigationNamespace", IDENTITY); }
        void authenticate() throws Exception { take(auth).done(200, authenticated(), null); }
        void session() throws Exception { take(sessions).done(200, NativeVoiceJson.object("clientProtocolVersion", BuildConfig.SEDES_CLIENT_PROTOCOL_VERSION, "csrfToken", "startup-test"), null); }
        void updateMode(String mode) throws Exception {
            Reply reply = new Reply(); runtime.command("updateSettings", NativeVoiceJson.object("expectedRevision", runtime.snapshot().getLong("settingsRevision"),
                "patch", NativeVoiceJson.object("audioMode", mode)), true, reply); reply.await();
        }
        boolean accepted(Intent start) { return runtime.acceptsSessionStart(start.getLongExtra("voiceGeneration", -1), start.getStringExtra("voiceStartId")); }
        void fail(Intent start) { runtime.startFailed(start.getLongExtra("voiceGeneration", -1), start.getStringExtra("voiceStartId")); }
        Intent start() throws Exception { return take(starts); }
        <T> T take(BlockingQueue<T> queue) throws Exception { T value = queue.poll(10, TimeUnit.SECONDS); assertNotNull("Expected startup callback", value); return value; }
        void ownerBarrier() throws Exception { CountDownLatch done = new CountDownLatch(1); owner.post(done::countDown); assertTrue(done.await(10, TimeUnit.SECONDS)); }
        void flush() throws Exception {
            ownerBarrier(); InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {});
            ownerBarrier(); InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {});
        }
        public void close() throws Exception {
            try { Reply reply = new Reply(); runtime.command("disconnect", new JSONObject(), false, reply); reply.await(); flush(); }
            finally {
                NativeVoiceHttp.setTestTransport(null); runtime.setTestSessionStarter(null); owner.getLooper().quitSafely();
                for (String selected : new String[] { profile, otherProfile }) {
                    new ClientCredentialStore(context).removeProfileCredentials(selected);
                    store.removeProfile(selected);
                    assertFalse(store.directory(NativeVoiceStore.binding(selected, origin, IDENTITY)).exists());
                }
            }
        }
    }
}
