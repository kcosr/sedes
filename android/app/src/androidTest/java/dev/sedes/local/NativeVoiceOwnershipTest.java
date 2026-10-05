package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.Handler;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Cross-store ownership survives manifest corruption and a process restart at either retirement boundary. */
public class NativeVoiceOwnershipTest {
    private static final String IDENTITY = "a".repeat(64), ORIGIN = "https://dictation.example";
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test public void unreadableAdoptedManifestCannotExposeGenericInputOrLeaveAnOrphanAfterDiscard() throws Exception {
        for (boolean crashAfterTerminal : new boolean[] { false, true }) {
            String profile = "voice-ownership-" + UUID.randomUUID(), binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY);
            String recordingId = UUID.randomUUID().toString(), mutation = UUID.randomUUID().toString(), ordinary = UUID.randomUUID().toString();
            String target = UUID.randomUUID().toString();
            NativeVoiceStore inputs = new NativeVoiceStore(context);
            AtomicInteger ownedLookups = new AtomicInteger(), posts = new AtomicInteger();
            NativeVoiceHttp.setTestTransport(new NativeVoiceHttp.TestTransport() {
                public boolean before(String method, String path, JSONObject body, NativeVoiceHttp.Result result) {
                    if (method.equals("POST")) posts.incrementAndGet();
                    if (path.endsWith("/" + mutation)) ownedLookups.incrementAndGet();
                    result.done(200, NativeVoiceJson.object("status", "notObserved"), null); return true;
                }
                public boolean after(String method, String path, JSONObject body, int status, JSONObject response, NativeVoiceHttp.Result result) { return false; }
            });
            try {
                File directory;
                try (NativeDictationStore recordings = new NativeDictationStore(context)) {
                    Method configuration = NativeVoiceRuntime.class.getDeclaredMethod("recordingConfig", NativeVoiceSettings.class);
                    configuration.setAccessible(true);
                    NativeDictationStore.Journal journal = recordings.create(binding, recordingId, target, "Saved target",
                        (JSONObject) configuration.invoke(null, NativeVoiceSettings.defaults()));
                    journal.adopt(true); journal.append(0, new byte[4800]); journal.checkpoint(); journal.seal(0, 0, 2400, 0);
                    journal.complete(0, "Recognized adopted input"); journal.finish("send", 2400);
                    recordings.finishIntent(binding, recordingId, mutation, NativeVoiceJson.object("mode", "queue", "originClientId", "client"));
                    JSONObject request = request(mutation, "Recognized adopted input");
                    recordings.saveFinalRequest(binding, recordingId, request); recordings.markHandedOff(binding, recordingId);
                    JSONObject linked = entry(mutation, target, request); NativeVoiceJson.put(linked, "recordingId", recordingId); inputs.saveEntry(binding, linked);
                    inputs.saveEntry(binding, entry(ordinary, UUID.randomUUID().toString(), request(ordinary, "Independent ordinary input")));
                    Method location = NativeDictationStore.class.getDeclaredMethod("directory", String.class, String.class);
                    location.setAccessible(true); directory = (File) location.invoke(recordings, binding, recordingId);
                }
                Files.write(new File(directory, "manifest.enc").toPath(), new byte[] { 1, 2, 3 });
                for (int restart = 0; restart < 2; restart++) {
                    try (RuntimeFixture runtime = new RuntimeFixture(profile, binding)) {
                        runtime.restore();
                        JSONObject saved = runtime.runtime.snapshot().getJSONObject("recordingRecovery");
                        assertEquals("unavailable", saved.getString("stage")); assertEquals(recordingId, saved.getString("recordingId"));
                        assertEquals(mutation, saved.getJSONObject("admission").getString("mutationId"));
                        assertEquals(target, saved.getString("threadId")); assertTrue(saved.getBoolean("canDiscard")); assertFalse(saved.getBoolean("canSend"));
                        JSONArray generic = runtime.runtime.snapshot().getJSONArray("recovery");
                        assertEquals(1, generic.length()); assertEquals(ordinary, generic.getJSONObject(0).getString("mutationId"));
                        assertEquals("recording_recovery_required", runtime.command("resumeInput", NativeVoiceJson.object("mutationId", mutation)));
                        assertEquals("recording_recovery_required", runtime.command("discardInput", NativeVoiceJson.object("mutationId", mutation)));
                        runtime.onOwner(() -> invoke(runtime.runtime, "recoverOutstanding", new Class<?>[0])); runtime.flush();
                        assertEquals(0, ownedLookups.get()); assertEquals(0, posts.get());
                        assertNotNull(new NativeVoiceStore(context).entry(binding, mutation));
                        if (restart == 1 && !crashAfterTerminal) {
                            assertNull(runtime.command("discardRecording", NativeVoiceJson.object("recordingId", recordingId,
                                "expectedRecoveryRevision", saved.getLong("revision"))));
                            runtime.flush(); assertTrue(runtime.runtime.snapshot().isNull("recordingRecovery"));
                        }
                    }
                }
                if (crashAfterTerminal) {
                    try (NativeDictationStore recordings = new NativeDictationStore(context)) {
                        // Simulate process loss after durable Discard but before its actor callback removes the input.
                        // Recording identity alone must identify the journal link when the old mutation metadata is missing.
                        recordings.beginDiscard(binding, recordingId, null);
                    }
                    assertNotNull(new NativeVoiceStore(context).entry(binding, mutation));
                }
                for (int restart = 0; restart < 2; restart++) {
                    try (RuntimeFixture runtime = new RuntimeFixture(profile, binding)) {
                        runtime.restore(); runtime.flush();
                        assertTrue(runtime.runtime.snapshot().isNull("recordingRecovery"));
                        assertNull(new NativeVoiceStore(context).entry(binding, mutation));
                        JSONObject remaining = new NativeVoiceStore(context).entry(binding, ordinary);
                        assertNotNull(remaining); assertFalse(remaining.has("recordingId")); assertFalse(remaining.getBoolean("cancelled"));
                        assertEquals(1, runtime.runtime.snapshot().getJSONArray("recovery").length());
                    }
                }
                assertFalse(directory.exists()); assertEquals(0, ownedLookups.get()); assertEquals(0, posts.get());
            } finally {
                NativeVoiceHttp.setTestTransport(null); inputs.removeProfile(profile);
                try (NativeDictationStore recordings = new NativeDictationStore(context)) { recordings.removeProfile(profile); }
            }
        }
    }

    private static JSONObject request(String mutation, String text) {
        return NativeVoiceJson.object("mutationId", mutation, "text", text, "origin", NativeVoiceJson.object("clientId", "client"),
            "runningPolicy", NativeVoiceJson.object("mode", "queue"));
    }
    private static JSONObject entry(String mutation, String target, JSONObject request) {
        return NativeVoiceJson.object("mutationId", mutation, "threadId", target, "request", request,
            "stage", "possiblySubmitted", "cancelled", false, "createdAt", System.currentTimeMillis());
    }
    private interface Action { void run() throws Exception; }
    private final class RuntimeFixture implements AutoCloseable {
        final NativeVoiceRuntime runtime;
        final Handler owner;
        final NativeDictationStore recordings;
        RuntimeFixture(String profile, String binding) throws Exception {
            runtime = new NativeVoiceRuntime(context, new NativeVoiceRuntime.RecordingBackend() {
                public okhttp3.Call preflight(NativeVoiceSettings settings, String credential, NativeSpeechCatalog.PreflightResult result) {
                    throw new AssertionError("Recovery must not start recognition");
                }
                public NativeSpeechTransport open(NativeSpeechTransport.Config config) { throw new AssertionError("Recovery must not start recognition"); }
            });
            owner = (Handler) field(runtime, "handler"); recordings = (NativeDictationStore) field(runtime, "dictations");
            onOwner(() -> {
                set(runtime, "profileId", profile); set(runtime, "origin", ORIGIN); set(runtime, "identity", IDENTITY);
                set(runtime, "binding", binding); set(runtime, "csrf", "test-csrf");
                set(runtime, "originId", "client"); set(runtime, "clientConnectionToken", "registered-client");
            });
        }
        void restore() throws Exception {
            CountDownLatch done = new CountDownLatch(1);
            onOwner(() -> invoke(runtime, "restoreDictation", new Class<?>[] { long.class, Runnable.class }, 0L,
                (Runnable) () -> { try { invoke(runtime, "publish", new Class<?>[0]); } catch (Exception error) { throw new AssertionError(error); } finally { done.countDown(); } }));
            assertTrue(done.await(10, TimeUnit.SECONDS)); flush();
        }
        String command(String action, JSONObject args) throws Exception {
            CountDownLatch done = new CountDownLatch(1); AtomicReference<String> error = new AtomicReference<>();
            runtime.command(action, args, true, new NativeVoiceRuntime.Reply() {
                public void done(JSONObject state) { done.countDown(); }
                public void failed(String code, String message) { error.set(code); done.countDown(); }
            });
            assertTrue(done.await(10, TimeUnit.SECONDS)); flush(); return error.get();
        }
        void onOwner(Action action) throws Exception {
            CountDownLatch done = new CountDownLatch(1); AtomicReference<Throwable> error = new AtomicReference<>();
            owner.post(() -> { try { action.run(); } catch (Throwable failure) { error.set(failure); } finally { done.countDown(); } });
            assertTrue(done.await(10, TimeUnit.SECONDS)); if (error.get() != null) throw new AssertionError(error.get());
        }
        void flush() throws Exception {
            for (int pass = 0; pass < 4; pass++) {
                onOwner(() -> {}); CountDownLatch done = new CountDownLatch(1); recordings.executor().execute(done::countDown);
                assertTrue(done.await(10, TimeUnit.SECONDS));
            }
            onOwner(() -> {});
        }
        public void close() throws Exception {
            onOwner(() -> invoke(runtime, "disconnect", new Class<?>[] { boolean.class }, false)); flush();
            recordings.close(); owner.getLooper().quitSafely();
        }
    }
    private static Object field(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target);
    }
    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
    private static void invoke(Object target, String name, Class<?>[] types, Object... args) throws Exception {
        Method method = target.getClass().getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(target, args);
    }
}
