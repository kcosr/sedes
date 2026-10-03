package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.Handler;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Exercises the actual owner-thread cancellation and encrypted admission journal without audio. */
public class NativeVoiceRuntimeTest {
    @Test public void staleBridgeGenerationCannotMutateNewConnectionEvenWhenSettingsRevisionMatches() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.onOwner(() -> set(f.runtime, "connectionGeneration", 2L));
            String[] actions = { "updateSettings", "startManualListen", "retargetActiveRecognition", "skipCurrentPlayback",
                "stopCurrentInteraction", "resumeInput", "disconnect", "setForegroundContext" };
            for (String action : actions) {
                JSONObject args = action.equals("updateSettings") ? NativeVoiceJson.object("expectedRevision", 0,
                    "patch", NativeVoiceJson.object("recognizeStopCommand", false)) : new JSONObject();
                CountDownLatch done = new CountDownLatch(1); AtomicReference<String> error = new AtomicReference<>();
                f.runtime.command(action, args, true, 1L, new NativeVoiceRuntime.Reply() {
                    public void done(JSONObject state) { done.countDown(); }
                    public void failed(String code, String message) { error.set(code); done.countDown(); }
                });
                assertTrue(done.await(10, TimeUnit.SECONDS)); assertEquals(action, "connection_changed", error.get());
                assertEquals(f.binding, field(f.runtime, "binding"));
                assertEquals(0, f.runtime.snapshot().getLong("settingsRevision"));
                assertFalse(f.runtime.snapshot().isNull("active"));
                assertFalse(f.store.journal(f.binding).getJSONObject(0).getBoolean("cancelled"));
            }
            assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.receiptReads.get());
        }
    }

    @Test public void bridgeGenerationRequiresANonnegativeSafeInteger() throws Exception {
        Method parse = NativeVoicePlugin.class.getDeclaredMethod("expectedGeneration", JSONObject.class); parse.setAccessible(true);
        assertEquals(7L, parse.invoke(null, NativeVoiceJson.object("expectedConnectionGeneration", 7)));
        for (Object invalid : new Object[] { JSONObject.NULL, "7", -1, 1.5, 9007199254740992L }) {
            try {
                parse.invoke(null, NativeVoiceJson.object("expectedConnectionGeneration", invalid));
                fail("Accepted invalid generation " + invalid);
            } catch (java.lang.reflect.InvocationTargetException expected) {
                assertTrue(expected.getCause() instanceof IllegalArgumentException);
            }
        }
        try { parse.invoke(null, new JSONObject()); fail("Accepted missing generation"); }
        catch (java.lang.reflect.InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalArgumentException); }
    }

    @Test public void silenceCancelsAutomaticAdmissionBeforeCsrfFailureArrives() throws Exception {
        try (Fixture f = new Fixture(true, false)) {
            NativeVoiceHttp.Result first = f.start();
            f.policy(true, true);
            f.assertCancelled();
            first.done(403, csrfError(), null); f.flush();
            assertEquals(1, f.inputAttempts.get()); assertEquals(0, f.sessionReads.get());
            assertTrue(f.receiptReads.get() > 0); f.assertCancelled();
        }
    }

    @Test public void disablingPolicyCancelsAutomaticAdmissionDuringCsrfRefresh() throws Exception {
        try (Fixture f = new Fixture(true, false)) {
            f.start().done(403, csrfError(), null); f.flush();
            NativeVoiceHttp.Result session = f.sessions.poll(10, TimeUnit.SECONDS); assertNotNull(session);
            f.policy(false, false); f.assertCancelled();
            session.done(200, NativeVoiceJson.object("clientProtocolVersion", BuildConfig.SEDES_CLIENT_PROTOCOL_VERSION,
                "csrfToken", "refreshed-test-token"), null); f.flush();
            assertEquals(1, f.inputAttempts.get()); assertEquals(1, f.sessionReads.get());
            assertTrue(f.receiptReads.get() > 0); f.assertCancelled();
        }
    }

    @Test public void silencePreservesExplicitAdmissionAndSameIdentityCsrfRetry() throws Exception {
        assertExplicitSurvives(false);
    }

    @Test public void silencePreservesRetargetedAdmissionAndSameIdentityCsrfRetry() throws Exception {
        assertExplicitSurvives(true);
    }

    @Test public void recognitionResultPlaysOneCueBeforeAdmittingOnce() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String request = f.recognizing(true);
            f.result(request, true, "Recognized input");
            Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
            assertEquals(NativeVoiceCue.Kind.SUCCESS, cue.kind); assertEquals(45, cue.gain);
            assertEquals(0, f.inputAttempts.get());
            f.result(request, true, "Duplicate input"); assertTrue(f.cues.isEmpty());
            f.runtime.drained(cue.id); f.flush();
            assertEquals(1, f.inputAttempts.get()); assertEquals("Recognized input", f.lastRequest.get().optString("text"));
            f.runtime.drained(cue.id); f.result(request, true, "Late input");
            assertEquals(1, f.inputAttempts.get()); assertTrue(f.cues.isEmpty());
        }
    }
    @Test public void emptyFailedAndSpokenStopResultsUseDescendingCueWithoutInput() throws Exception {
        for (String text : new String[] { "", "stop", "failed" }) {
            try (Fixture f = new Fixture(false, false)) {
                String request = f.recognizing(true);
                f.result(request, !text.equals("failed"), text);
                Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
                assertEquals(NativeVoiceCue.Kind.FAILURE, cue.kind);
                f.runtime.drained(cue.id); f.flush();
                assertEquals(0, f.inputAttempts.get()); assertTrue(f.runtime.snapshot().isNull("active"));
                assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }
    @Test public void disabledCuesAndCuePlaybackFailureDoNotLoseRecognizedInput() throws Exception {
        for (boolean enabled : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                f.result(f.recognizing(enabled), true, "Keep this input");
                if (enabled) {
                    Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
                    f.runtime.failed(cue.id, "playback_failed"); f.flush();
                    f.runtime.drained(cue.id); f.flush();
                }
                assertEquals(1, f.inputAttempts.get()); assertEquals("Keep this input", f.lastRequest.get().optString("text"));
                assertTrue(f.cues.isEmpty());
            }
        }
    }
    @Test public void stopCueRejectsLateRecognitionAndVoiceOffCancelsPendingFeedback() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String request = f.recognizing(true);
            f.onOwner(() -> f.invoke("stopInteraction", new Class<?>[0]));
            Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
            assertEquals(NativeVoiceCue.Kind.FAILURE, cue.kind);
            f.result(request, true, "Must not send");
            f.runtime.drained(cue.id); f.flush(); assertTrue(f.runtime.snapshot().isNull("active"));
            assertEquals(0, f.inputAttempts.get()); assertTrue(f.cues.isEmpty());
        }
        try (Fixture f = new Fixture(false, false)) {
            f.result(f.recognizing(true), true, "Cancelled during cue");
            Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
            f.onOwner(() -> f.invoke("updateSettings", new Class<?>[] { JSONObject.class, boolean.class },
                NativeVoiceJson.object("expectedRevision", 1, "patch", NativeVoiceJson.object("audioMode", "off")), true));
            f.runtime.drained(cue.id); f.flush();
            assertEquals(0, f.inputAttempts.get()); assertTrue(f.runtime.snapshot().isNull("active"));
        }
    }
    @Test public void adapterFailureDuringCompletionCuePreservesTheFinalTranscript() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.result(f.recognizing(true), true, "Already recognized");
            Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
            NativeVoiceAdapter adapter = (NativeVoiceAdapter) field(f.runtime, "adapter");
            f.runtime.failed(adapter.generation(), "adapter_disconnected"); f.flush();
            f.runtime.drained(cue.id); f.flush();
            assertEquals(1, f.inputAttempts.get()); assertEquals("Already recognized", f.lastRequest.get().optString("text"));
        }
    }
    @Test public void recognitionFailurePlaysDescendingCueAndDoesNotSubmit() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String request = f.recognizing(true);
            f.runtime.failed(request, "microphone_failed"); f.flush();
            Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
            assertEquals(NativeVoiceCue.Kind.FAILURE, cue.kind);
            f.result(request, true, "Too late");
            f.runtime.drained(cue.id); f.flush();
            assertEquals(0, f.inputAttempts.get()); assertTrue(f.runtime.snapshot().isNull("active"));
        }
    }
    @Test public void deliveryModeFreezesBeforeFeedbackAndSurvivesAdapterLossDuringSteerLookup() throws Exception {
        for (String selectedMode : new String[] { "queue", "steer" }) {
            try (Fixture f = new Fixture(false, false)) {
                String request = f.recognizing(true);
                f.onOwner(() -> {
                    NativeVoiceSettings settings = (NativeVoiceSettings) field(f.runtime, "settings");
                    set(f.runtime, "settings", settings.patch(settings.revision, NativeVoiceJson.object("followComposerMode", true)));
                    set(f.runtime, "composerMode", selectedMode);
                });
                f.result(request, true, "Keep original delivery mode");
                Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
                f.onOwner(() -> set(f.runtime, "composerMode", selectedMode.equals("queue") ? "steer" : "queue"));
                f.runtime.drained(cue.id); f.flush();
                if (selectedMode.equals("steer")) {
                    NativeVoiceHttp.Result context = f.contexts.poll(10, TimeUnit.SECONDS); assertNotNull(context);
                    NativeVoiceAdapter adapter = (NativeVoiceAdapter) field(f.runtime, "adapter");
                    f.runtime.failed(adapter.generation(), "adapter_disconnected"); f.flush();
                    context.done(200, NativeVoiceJson.object("threadId", f.target, "activityToken", "epoch",
                        "authority", "current", "runState", "running", "automaticListenEligible", false,
                        "steer", NativeVoiceJson.object("availability", "available", "target",
                            NativeVoiceJson.object("kind", "turn", "turnId", "current-turn"))), null);
                    f.flush();
                }
                assertEquals(1, f.inputAttempts.get()); assertTrue(f.contexts.isEmpty());
                assertEquals(selectedMode, f.lastRequest.get().getJSONObject("runningPolicy").getString("mode"));
                assertEquals("Keep original delivery mode", f.lastRequest.get().getString("text"));
            }
        }
    }
    @Test public void completionTimeoutContinuesOnceAndIgnoresLateDrain() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.result(f.recognizing(true), true, "Feedback never drained");
            Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
            assertNotNull("Completion feedback stranded recognized input", f.inputs.poll(25, TimeUnit.SECONDS));
            f.runtime.drained(cue.id); f.flush(); assertEquals(1, f.inputAttempts.get());
        }
    }
    @Test public void disconnectCancelsPendingRecognitionFeedback() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.result(f.recognizing(true), true, "Old connection input");
            Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
            f.onOwner(() -> f.invoke("disconnect", new Class<?>[] { boolean.class }, true));
            f.runtime.drained(cue.id); f.flush();
            assertEquals(0, f.inputAttempts.get()); assertTrue(f.runtime.snapshot().isNull("active"));
            assertEquals(0, f.store.journal(f.binding).length());
        }
    }

    private void assertExplicitSurvives(boolean retargeted) throws Exception {
        try (Fixture f = new Fixture(retargeted, retargeted)) {
            NativeVoiceHttp.Result first = f.start(); f.policy(true, true);
            assertFalse(f.store.journal(f.binding).getJSONObject(0).getBoolean("cancelled"));
            assertFalse(f.runtime.snapshot().isNull("active"));
            first.done(403, csrfError(), null); f.flush();
            NativeVoiceHttp.Result session = f.sessions.poll(10, TimeUnit.SECONDS); assertNotNull(session);
            session.done(200, NativeVoiceJson.object("clientProtocolVersion", BuildConfig.SEDES_CLIENT_PROTOCOL_VERSION,
                "csrfToken", "refreshed-test-token"), null); f.flush();
            assertEquals(2, f.inputAttempts.get()); assertEquals(1, f.sessionReads.get());
            assertEquals(0, f.receiptReads.get());
            assertEquals(f.request.toString(), f.lastRequest.get().toString());
            assertFalse(f.store.journal(f.binding).getJSONObject(0).getBoolean("cancelled"));
        }
    }

    private static JSONObject csrfError() {
        return NativeVoiceJson.object("error", NativeVoiceJson.object("code", "csrf_token_invalid", "message", "Expired token", "retryable", false));
    }

    private interface Action { void run() throws Exception; }
    private static final class Cue {
        final String id; final NativeVoiceCue.Kind kind; final int gain;
        Cue(String id, NativeVoiceCue.Kind kind, int gain) { this.id = id; this.kind = kind; this.gain = gain; }
    }
    private static final class Fixture implements AutoCloseable {
        private static final String IDENTITY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        final String profile = "voice-runtime-test-" + UUID.randomUUID(), origin = "http://127.0.0.1:65124";
        final String binding = NativeVoiceStore.binding(profile, origin, IDENTITY);
        final String mutation = UUID.randomUUID().toString(), target = UUID.randomUUID().toString();
        final JSONObject request = NativeVoiceJson.object("mutationId", mutation, "text", "A deliberate voice input",
            "origin", NativeVoiceJson.object("clientId", UUID.randomUUID().toString()), "runningPolicy", NativeVoiceJson.object("mode", "queue"));
        final JSONObject entry = NativeVoiceJson.object("mutationId", mutation, "threadId", target, "request", request,
            "stage", "prepared", "cancelled", false, "createdAt", System.currentTimeMillis());
        final AtomicInteger inputAttempts = new AtomicInteger(), sessionReads = new AtomicInteger(), receiptReads = new AtomicInteger();
        final AtomicReference<JSONObject> lastRequest = new AtomicReference<>();
        final BlockingQueue<NativeVoiceHttp.Result> inputs = new LinkedBlockingQueue<>(), sessions = new LinkedBlockingQueue<>(), contexts = new LinkedBlockingQueue<>();
        final BlockingQueue<Cue> cues = new LinkedBlockingQueue<>();
        final NativeVoiceRuntime runtime;
        final NativeVoiceStore store;
        final Handler owner;
        Fixture(boolean automatic, boolean retargeted) throws Exception {
            Constructor<NativeVoiceRuntime> constructor = NativeVoiceRuntime.class.getDeclaredConstructor(Context.class);
            constructor.setAccessible(true); runtime = constructor.newInstance(context);
            owner = (Handler) field(runtime, "handler"); store = (NativeVoiceStore) field(runtime, "store");
            NativeVoiceHttp.setTestTransport(new NativeVoiceHttp.TestTransport() {
                public boolean before(String method, String path, JSONObject body, NativeVoiceHttp.Result result) {
                    if (method.equals("POST") && path.endsWith("/inputs")) {
                        inputAttempts.incrementAndGet(); lastRequest.set(NativeVoiceJson.copy(body)); inputs.add(result);
                    } else if (path.equals("/api/application/session")) { sessionReads.incrementAndGet(); sessions.add(result); }
                    else if (path.endsWith("/input-context")) contexts.add(result);
                    else if (path.startsWith("/api/input-receipts/")) {
                        receiptReads.incrementAndGet(); result.done(200, NativeVoiceJson.object("status", "notObserved"), null);
                    } else throw new AssertionError("Unexpected native request: " + method + " " + path);
                    return true;
                }
                public boolean after(String method, String path, JSONObject body, int status, JSONObject response, NativeVoiceHttp.Result result) { return false; }
            });
            onOwner(() -> {
                set(runtime, "profileId", profile); set(runtime, "origin", origin); set(runtime, "identity", IDENTITY);
                set(runtime, "binding", binding); set(runtime, "csrf", "expired-test-token");
                Class<?> activeClass = Class.forName("dev.sedes.local.NativeVoiceRuntime$Active");
                Constructor<?> activeConstructor = activeClass.getDeclaredConstructor(String.class, String.class);
                activeConstructor.setAccessible(true); Object active = activeConstructor.newInstance(target, "Target");
                set(active, "automatic", automatic); set(runtime, "active", active);
                if (retargeted) {
                    set(runtime, "phase", "listening");
                    invoke("retarget", new Class<?>[] { JSONObject.class }, NativeVoiceJson.object("threadId", target, "threadTitle", "Retargeted"));
                }
                set(active, "admission", entry); set(runtime, "phase", "submitting"); store.saveEntry(binding, entry);
            });
        }
        NativeVoiceHttp.Result start() throws Exception {
            onOwner(() -> invoke("submit", new Class<?>[] { String.class, String.class, String.class, JSONObject.class, boolean.class }, binding, origin, null, entry, false));
            NativeVoiceHttp.Result result = inputs.poll(10, TimeUnit.SECONDS); assertNotNull(result); return result;
        }
        String recognizing(boolean cuesEnabled) throws Exception {
            String request = UUID.randomUUID().toString();
            NativeVoiceAudio.setTestCuePlayer((id, kind, gain) -> cues.add(new Cue(id, kind, gain)));
            onOwner(() -> {
                store.removeEntry(binding, mutation);
                Object active = field(runtime, "active"); set(active, "admission", null); set(active, "sttId", request);
                set(runtime, "originId", UUID.randomUUID().toString()); set(runtime, "sessionStarted", true);
                set(runtime, "settings", NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object(
                    "audioMode", "manual", "recognitionCues", cuesEnabled, "cueGain", 45)));
                set(runtime, "phase", "recognizing"); set(field(runtime, "adapter"), "ready", true);
                invoke("publish", new Class<?>[0]);
            });
            return request;
        }
        void result(String request, boolean success, String text) throws Exception {
            NativeVoiceAdapter adapter = (NativeVoiceAdapter) field(runtime, "adapter");
            runtime.event(adapter.generation(), NativeVoiceJson.object("type", "media_stt_result", "requestId", request,
                "success", success, "text", text));
            flush();
        }
        void policy(boolean enabled, boolean silenced) throws Exception {
            JSONObject delivery = new JSONObject();
            for (String event : NativeVoiceProtocol.EVENTS) NativeVoiceJson.put(delivery, event, NativeVoiceJson.object("script", false, "voice", "none"));
            JSONObject value = NativeVoiceJson.object("generation", 1, "settings", NativeVoiceJson.object("enabled", enabled, "silenced", silenced,
                "revision", 1, "delivery", delivery, "assistantResultPhases", new JSONArray(), "scriptPath", "", "arguments", new JSONArray(), "timeoutSeconds", 30));
            onOwner(() -> invoke("receive", new Class<?>[] { String.class, JSONObject.class }, "notification_policy", value)); flush();
        }
        void assertCancelled() throws Exception {
            assertTrue(new NativeVoiceStore(context).journal(binding).getJSONObject(0).getBoolean("cancelled"));
            assertTrue(runtime.snapshot().isNull("active"));
            assertTrue(runtime.snapshot().getJSONArray("recovery").getJSONObject(0).getBoolean("cancelled"));
        }
        void flush() throws Exception { onOwner(() -> {}); onOwner(() -> {}); }
        void onOwner(Action action) throws Exception {
            CountDownLatch done = new CountDownLatch(1); AtomicReference<Throwable> error = new AtomicReference<>();
            owner.post(() -> { try { action.run(); } catch (Throwable failure) { error.set(failure); } finally { done.countDown(); } });
            assertTrue("Native owner did not finish", done.await(10, TimeUnit.SECONDS));
            if (error.get() != null) throw new AssertionError("Native owner failed", error.get());
        }
        void invoke(String name, Class<?>[] types, Object... args) throws Exception {
            Method method = NativeVoiceRuntime.class.getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(runtime, args);
        }
        public void close() throws Exception {
            try { onOwner(() -> { set(runtime, "active", null); invoke("disconnect", new Class<?>[] { boolean.class }, false); }); }
            finally {
                NativeVoiceHttp.setTestTransport(null); NativeVoiceAudio.setTestCuePlayer(null); owner.getLooper().quitSafely();
                StringBuilder name = new StringBuilder();
                for (byte b : MessageDigest.getInstance("SHA-256").digest(binding.getBytes(StandardCharsets.UTF_8))) name.append(String.format("%02x", b & 255));
                File directory = new File(new File(context.getNoBackupFilesDir(), "native-voice"), name.toString());
                File[] files = directory.listFiles(); if (files != null) for (File file : files) assertTrue(file.delete());
                if (directory.exists()) assertTrue(directory.delete());
            }
        }
    }
    private static Object field(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target);
    }
    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
}
