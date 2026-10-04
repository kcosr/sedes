package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.Handler;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Exercises the actual owner-thread cancellation and encrypted admission journal without audio. */
public class NativeVoiceRuntimeTest {
    @Test public void staleBridgeGenerationCannotMutateNewConnectionEvenWhenSettingsRevisionMatches() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.onOwner(() -> set(f.runtime, "connectionGeneration", 2L));
            String[] actions = { "updateSettings", "startManualListen", "retargetActiveRecognition", "skipCurrentPlayback",
                "stopCurrentInteraction", "resumeInput", "discardInput", "disconnect", "setForegroundContext" };
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

    @Test public void silencePreservesSubmittedAutomaticAdmissionAndSameIdentityCsrfRetry() throws Exception {
        assertAdmissionSurvivesPolicy(true, false);
    }

    @Test public void disablingPolicyDuringCsrfRefreshKeepsSubmittedAutomaticAdmission() throws Exception {
        try (Fixture f = new Fixture(true, false)) {
            f.start().done(403, csrfError(), null); f.flush();
            NativeVoiceHttp.Result session = f.sessions.poll(10, TimeUnit.SECONDS); assertNotNull(session);
            f.policy(false, false);
            assertFalse(f.runtime.snapshot().isNull("active"));
            assertFalse(f.store.journal(f.binding).getJSONObject(0).getBoolean("cancelled"));
            f.refreshed(session);
            assertEquals(2, f.inputAttempts.get()); assertEquals(1, f.sessionReads.get()); assertEquals(0, f.receiptReads.get());
            assertEquals(f.request.toString(), f.lastRequest.get().toString());
        }
    }

    @Test public void stopBeforeCsrfFailureResolvesTheUnadmittedInputWithoutRetry() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceHttp.Result first = f.start();
            f.onOwner(() -> f.invoke("stopInteraction", new Class<?>[0])); f.flush();
            f.assertCancelled(); assertEquals(0, f.receiptReads.get());
            first.done(403, csrfError(), null); f.flush();
            assertEquals(1, f.inputAttempts.get()); assertEquals(0, f.sessionReads.get()); assertEquals(0, f.receiptReads.get());
            assertEquals(0, f.store.journal(f.binding).length()); assertEquals(0, f.runtime.snapshot().getJSONArray("recovery").length());
        }
    }

    @Test public void stopDuringCsrfRefreshPreventsTheRetryAndResolvesTheInput() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.start().done(403, csrfError(), null); f.flush();
            NativeVoiceHttp.Result session = f.sessions.poll(10, TimeUnit.SECONDS); assertNotNull(session);
            f.onOwner(() -> f.invoke("stopInteraction", new Class<?>[0])); f.flush();
            assertEquals("A refresh holds the admission; Stop must not race it with a receipt read", 0, f.receiptReads.get());
            f.refreshed(session);
            assertEquals(1, f.inputAttempts.get()); assertEquals(0, f.receiptReads.get());
            assertEquals(0, f.store.journal(f.binding).length()); assertTrue(f.runtime.snapshot().isNull("active"));
        }
    }

    @Test public void definitiveRejectionFinishesTheItemAndRemovesItsInput() throws Exception {
        for (int status : new int[] { 400, 404, 409, 413 }) {
            try (Fixture f = new Fixture(false, false)) {
                f.start().done(status, NativeVoiceJson.object("error", NativeVoiceJson.object("code", "invalid_transition",
                    "message", "Thread is archived.", "retryable", false)), null); f.flush();
                assertTrue(f.runtime.snapshot().isNull("active"));
                assertEquals(0, f.store.journal(f.binding).length()); assertEquals(0, f.runtime.snapshot().getJSONArray("recovery").length());
                assertEquals("A definitive rejection needs no receipt lookup", 0, f.receiptReads.get());
                JSONObject error = f.lastError(); assertEquals("input_rejected", error.getString("code"));
                assertTrue(error.getString("message").contains("Thread is archived."));
            }
        }
    }

    @Test public void uncertainOutcomeReleasesTheSlotAndReconcilesReadOnlyWithBackoff() throws Exception {
        for (int status : new int[] { 0, 408, 429, 503 }) {
            try (Fixture f = new Fixture(false, false)) {
                f.start().done(status, null, status == 0 ? "network_unavailable" : null); f.flush();
                assertEquals(1, f.receiptReads.get());
                assertTrue("The first reconciliation must release the active slot", f.runtime.snapshot().isNull("active"));
                JSONArray recovery = f.runtime.snapshot().getJSONArray("recovery");
                assertEquals(1, recovery.length()); assertEquals("uncertain", recovery.getJSONObject(0).getString("status"));
                assertFalse(recovery.getJSONObject(0).getBoolean("cancelled"));
                assertEquals(1, f.errors("input_outcome_uncertain"));
                if (status == 503) {
                    long deadline = System.currentTimeMillis() + 10000;
                    while (f.receiptReads.get() < 2 && System.currentTimeMillis() < deadline) Thread.sleep(50);
                    f.flush();
                    assertTrue("Uncertain input is reconciled again automatically", f.receiptReads.get() >= 2);
                    assertEquals("Automatic recovery never sends input", 1, f.inputAttempts.get());
                    assertEquals("Automatic retries do not repeat the report", 1, f.errors("input_outcome_uncertain"));
                    assertEquals(1, f.store.journal(f.binding).length());
                }
            }
        }
    }

    @Test public void discardRemovesAnUncertainInputWithoutSendingIt() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.start().done(503, null, null); f.flush();
            assertEquals(1, f.runtime.snapshot().getJSONArray("recovery").length());
            assertNull(f.command("discardInput", NativeVoiceJson.object("mutationId", f.mutation)));
            assertEquals(0, f.runtime.snapshot().getJSONArray("recovery").length()); assertEquals(0, f.store.journal(f.binding).length());
            assertEquals("input_recovery_not_found", f.command("discardInput", NativeVoiceJson.object("mutationId", f.mutation)));
            assertEquals(1, f.inputAttempts.get());
        }
    }

    @Test public void discardCancelsAnInFlightAdmissionAndIgnoresItsLateReply() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceHttp.Result first = f.start();
            assertEquals("possiblySubmitted", f.runtime.snapshot().getJSONArray("recovery").getJSONObject(0).getString("status"));
            assertNull(f.command("discardInput", NativeVoiceJson.object("mutationId", f.mutation)));
            assertTrue(f.runtime.snapshot().isNull("active")); assertEquals(0, f.store.journal(f.binding).length());
            first.done(200, f.receipt("queued"), null); f.flush();
            assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length()); assertEquals(0, f.receiptReads.get());
        }
    }

    @Test public void resumeRetriesTheSameRequestOnlyWhenExplicitlyRequested() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.start().done(0, null, "network_unavailable"); f.flush();
            assertEquals(1, f.inputAttempts.get());
            assertNull(f.command("resumeInput", NativeVoiceJson.object("mutationId", f.mutation)));
            NativeVoiceHttp.Result retry = f.inputs.poll(10, TimeUnit.SECONDS); assertNotNull(retry);
            assertEquals(2, f.inputAttempts.get()); assertEquals(f.request.toString(), f.lastRequest.get().toString());
            retry.done(200, f.receipt("queued"), null); f.flush();
            assertEquals(0, f.store.journal(f.binding).length()); assertEquals(0, f.runtime.snapshot().getJSONArray("recovery").length());
        }
    }

    @Test public void rejectedArgumentsDoNotPartiallyApply() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String other = UUID.randomUUID().toString();
            f.onOwner(() -> { set(f.runtime, "phase", "listening"); set(f.runtime, "nativeVisible", true); set(field(f.runtime, "active"), "admission", null); });
            assertEquals("invalid_threadTitle", f.command("retargetActiveRecognition", NativeVoiceJson.object("threadId", other, "threadTitle", "")));
            JSONObject active = f.runtime.snapshot().getJSONObject("active");
            assertEquals(f.target, active.getString("recognitionThreadId")); assertEquals("Target", active.getString("recognitionThreadTitle"));
            String longTitle = new String(new char[513]).replace('\0', 'x');
            assertEquals("invalid_threadTitle", f.command("setForegroundContext", NativeVoiceJson.object("visible", true, "threadId", other,
                "threadTitle", longTitle, "composerMode", "steer")));
            assertEquals("invalid_composerMode", f.command("setForegroundContext", NativeVoiceJson.object("visible", true, "threadId", other,
                "threadTitle", "Title", "composerMode", "interrupt")));
            assertEquals("queue", field(f.runtime, "composerMode")); assertTrue(f.runtime.snapshot().getJSONObject("foreground").isNull("threadId"));
            assertNull(f.command("retargetActiveRecognition", NativeVoiceJson.object("threadId", other, "threadTitle", JSONObject.NULL)));
            assertEquals(other, f.runtime.snapshot().getJSONObject("active").getString("recognitionThreadId"));
        }
    }

    @Test public void adapterFailureReconnectsOnlyThroughItsBackoff() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAdapter adapter = (NativeVoiceAdapter) field(f.runtime, "adapter");
            f.onOwner(() -> {
                Object active = field(f.runtime, "active"); set(active, "admission", null); set(active, "ttsId", UUID.randomUUID().toString());
                set(f.runtime, "settings", NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("audioMode", "response", "adapterUrl", "http://127.0.0.1:9")));
                set(f.runtime, "sessionStarted", true); set(f.runtime, "phase", "speaking"); adapterReady(adapter);
            });
            long generation = adapter.generation();
            f.runtime.failed(generation, "adapter_disconnected"); f.flush();
            assertTrue(f.runtime.snapshot().isNull("active"));
            assertEquals("Cancellation must not reconnect before the delayed reconnect", generation + 1, adapter.generation());
            assertEquals("adapter_disconnected", f.lastError().getString("code"));
        }
    }

    @Test public void adapterUrlChangeKeepsAnAdmittedInput() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.start();
            f.onOwner(() -> f.invoke("updateSettings", new Class<?>[] { JSONObject.class, boolean.class }, NativeVoiceJson.object("expectedRevision", 0,
                "patch", NativeVoiceJson.object("audioMode", "response", "adapterUrl", "http://127.0.0.1:9")), false));
            assertFalse(f.runtime.snapshot().isNull("active"));
            assertFalse(f.store.journal(f.binding).getJSONObject(0).getBoolean("cancelled"));
        }
    }

    @Test public void finalizedAutomaticTranscriptSurvivesPolicyChangeAndStreamLoss() throws Exception {
        for (String interruption : new String[] { "policy", "stream" }) {
            try (Fixture f = new Fixture(true, false)) {
                f.result(f.recognizing(true), true, "Finalized before the interruption");
                Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
                if (interruption.equals("policy")) f.policy(true, true);
                else { f.onOwner(() -> f.invoke("streamFailed", new Class<?>[] { String.class }, "stream_closed")); f.flush(); }
                assertFalse("A finalized transcript keeps its admission semantics", f.runtime.snapshot().isNull("active"));
                f.runtime.drained(cue.id); f.flush();
                assertEquals(1, f.inputAttempts.get()); assertEquals("Finalized before the interruption", f.lastRequest.get().getString("text"));
            }
        }
    }

    @Test public void automaticRecordingBeforeFinalizationIsStillCancelledByPolicyChange() throws Exception {
        try (Fixture f = new Fixture(true, false)) {
            String request = f.recognizing(true);
            f.policy(true, true);
            assertTrue(f.runtime.snapshot().isNull("active"));
            f.result(request, true, "Too late");
            assertEquals(0, f.inputAttempts.get());
        }
    }

    @Test public void liveStreamWithoutPolicyFailsOnceAndRetries() throws Exception {
        for (boolean policyKnown : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                long[] generation = new long[1];
                f.onOwner(() -> {
                    set(f.runtime, "sessionStarted", true); set(f.runtime, "policyKnown", policyKnown);
                    generation[0] = (long) field(f.runtime, "streamGeneration");
                    f.invoke("streamLive", new Class<?>[] { long.class }, generation[0]);
                });
                Thread.sleep(NativeVoiceRuntime.POLICY_AFTER_LIVE_MS + 500); f.flush();
                if (policyKnown) {
                    assertEquals(generation[0], field(f.runtime, "streamGeneration")); assertEquals(0, field(f.runtime, "streamFailures"));
                } else {
                    assertEquals(1, field(f.runtime, "streamFailures"));
                    assertEquals("notification_policy_unavailable", f.lastError().getString("code"));
                    assertEquals(1, f.errors("notification_policy_unavailable"));
                }
            }
        }
    }

    @Test public void inFlightAdmissionOutlivingAReconnectToTheSameBindingReconcilesReadOnly() throws Exception {
        for (boolean sameBinding : new boolean[] { true, false }) {
            try (Fixture f = new Fixture(false, false)) {
                NativeVoiceHttp.Result first = f.start();
                f.onOwner(() -> {
                    set(f.runtime, "active", null); set(f.runtime, "phase", "idle");
                    set(f.runtime, "connectionGeneration", (long) field(f.runtime, "connectionGeneration") + 1);
                    if (!sameBinding) set(f.runtime, "binding", NativeVoiceStore.binding(f.profile + "-other", f.origin, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
                });
                first.done(503, null, null); f.flush();
                assertEquals("Recovery never resends", 1, f.inputAttempts.get());
                if (sameBinding) {
                    assertEquals(1, f.receiptReads.get()); assertEquals(1, f.errors("input_outcome_uncertain"));
                    assertEquals("uncertain", f.runtime.snapshot().getJSONArray("recovery").getJSONObject(0).getString("status"));
                } else {
                    assertEquals(0, f.receiptReads.get());
                    assertEquals("The old binding keeps its entry for its next connection", 1, f.store.journal(f.binding).length());
                }
            }
        }
    }

    @Test public void sanitizedEmptyChunkContinuesWhileOtherAdapterRejectionsFail() throws Exception {
        for (int rejection : new int[] { 400, 409 }) {
            try (Fixture f = new Fixture(false, false); AdapterHttp adapterHttp = new AdapterHttp(rejection, 202)) {
                NativeVoiceAdapter adapter = (NativeVoiceAdapter) field(f.runtime, "adapter");
                f.onOwner(() -> {
                    Object active = field(f.runtime, "active"); set(active, "admission", null);
                    @SuppressWarnings("unchecked") List<String> chunks = (List<String>) field(active, "chunks");
                    chunks.add("```"); chunks.add("Spoken chunk");
                    adapterReady(adapter, adapterHttp.url());
                    Method speak = NativeVoiceRuntime.class.getDeclaredMethod("speakChunk", Class.forName("dev.sedes.local.NativeVoiceRuntime$Active"));
                    speak.setAccessible(true); speak.invoke(f.runtime, active);
                });
                assertEquals("```", adapterHttp.tts().getString("text"));
                if (rejection == 400) {
                    assertEquals("Spoken chunk", adapterHttp.tts().getString("text")); f.flush();
                    Object active = field(f.runtime, "active"); assertNotNull(active);
                    assertEquals(1, field(active, "chunk")); assertNotNull(field(active, "ttsId"));
                    assertEquals("synthesizing", f.runtime.snapshot().getString("phase"));
                    assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
                } else {
                    long deadline = System.currentTimeMillis() + 10000;
                    while (!f.runtime.snapshot().isNull("active") && System.currentTimeMillis() < deadline) Thread.sleep(50);
                    f.flush(); assertTrue(f.runtime.snapshot().isNull("active"));
                    assertEquals("speech_request_rejected", f.lastError().getString("code"));
                    assertNull("A failed item does not continue to its next chunk", adapterHttp.ttsBodies.poll(500, TimeUnit.MILLISECONDS));
                }
            }
        }
    }

    @Test public void silentOrBlankSpeechChunksContinueTheItem() throws Exception {
        for (String reason : new String[] { "empty_pcm_stream", "playback_failed" }) {
            try (Fixture f = new Fixture(false, false)) {
                String request = UUID.randomUUID().toString();
                f.onOwner(() -> {
                    Object active = field(f.runtime, "active"); set(active, "admission", null); set(active, "ttsId", request);
                    @SuppressWarnings("unchecked") List<String> chunks = (List<String>) field(active, "chunks");
                    chunks.add("Spoken chunk"); chunks.add("\u00a0 \u3000"); set(f.runtime, "phase", "speaking");
                });
                f.runtime.failed(request, reason); f.flush();
                assertTrue(f.runtime.snapshot().isNull("active"));
                if (reason.equals("empty_pcm_stream")) assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
                else assertEquals(reason, f.lastError().getString("code"));
            }
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
        assertAdmissionSurvivesPolicy(retargeted, retargeted);
    }
    private void assertAdmissionSurvivesPolicy(boolean automatic, boolean retargeted) throws Exception {
        try (Fixture f = new Fixture(automatic, retargeted)) {
            NativeVoiceHttp.Result first = f.start(); f.policy(true, true);
            assertFalse(f.store.journal(f.binding).getJSONObject(0).getBoolean("cancelled"));
            assertFalse(f.runtime.snapshot().isNull("active"));
            first.done(403, csrfError(), null); f.flush();
            NativeVoiceHttp.Result session = f.sessions.poll(10, TimeUnit.SECONDS); assertNotNull(session);
            f.refreshed(session);
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
                set(runtime, "phase", "recognizing"); adapterReady((NativeVoiceAdapter) field(runtime, "adapter"));
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
        void refreshed(NativeVoiceHttp.Result session) throws Exception {
            session.done(200, NativeVoiceJson.object("clientProtocolVersion", BuildConfig.SEDES_CLIENT_PROTOCOL_VERSION,
                "csrfToken", "refreshed-test-token"), null); flush();
        }
        JSONObject receipt(String status) {
            return NativeVoiceJson.object("mutationId", mutation, "threadId", target, "operationId", UUID.randomUUID().toString(),
                "admittedMode", "queue", "currentMode", "queue", "status", status);
        }
        String command(String action, JSONObject args) throws Exception {
            CountDownLatch done = new CountDownLatch(1); AtomicReference<String> error = new AtomicReference<>();
            runtime.command(action, args, true, new NativeVoiceRuntime.Reply() {
                public void done(JSONObject state) { done.countDown(); }
                public void failed(String code, String message) { error.set(code); done.countDown(); }
            });
            assertTrue(done.await(10, TimeUnit.SECONDS)); flush(); return error.get();
        }
        JSONObject lastError() throws Exception {
            JSONArray errors = runtime.snapshot().getJSONArray("errors"); assertTrue("Expected a reported error", errors.length() > 0);
            return errors.getJSONObject(errors.length() - 1);
        }
        int errors(String code) throws Exception {
            JSONArray errors = runtime.snapshot().getJSONArray("errors"); int count = 0;
            for (int i = 0; i < errors.length(); i++) if (code.equals(errors.getJSONObject(i).getString("code"))) count++;
            return count;
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
                store.removeProfile(profile); assertFalse(store.directory(binding).exists());
            }
        }
    }
    /** Installs a handshaken adapter connection without a client ID, so no adapter media request leaves the test. */
    private static void adapterReady(NativeVoiceAdapter adapter) throws Exception { adapterReady(adapter, null); }
    /** With a base URL, the connection also has a client ID so media requests reach that loopback responder. */
    private static void adapterReady(NativeVoiceAdapter adapter, String baseUrl) throws Exception {
        Constructor<?> constructor = Class.forName("dev.sedes.local.NativeVoiceAdapter$Connection").getDeclaredConstructor(NativeVoiceAdapter.class, long.class);
        constructor.setAccessible(true);
        synchronized (adapter) {
            Object connection = constructor.newInstance(adapter, adapter.generation());
            set(connection, "socket", new OkHttpClient().newWebSocket(new Request.Builder().url("ws://127.0.0.1:9/ws").build(), new WebSocketListener() {}));
            set(connection, "ready", true); set(adapter, "connection", connection);
            if (baseUrl != null) { set(connection, "clientId", "runtime-test-client"); set(adapter, "baseUrl", baseUrl); }
        }
        assertTrue(adapter.ready());
    }
    /** Loopback adapter HTTP endpoint: answers TTS requests with scripted statuses and everything else with 200. */
    private static final class AdapterHttp implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
        final BlockingQueue<String> ttsBodies = new LinkedBlockingQueue<>();
        AdapterHttp(int... ttsStatuses) throws Exception {
            BlockingQueue<Integer> statuses = new LinkedBlockingQueue<>(); for (int status : ttsStatuses) statuses.add(status);
            Thread thread = new Thread(() -> {
                while (!server.isClosed()) {
                    try (Socket socket = server.accept()) {
                        socket.setSoTimeout(5000);
                        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                        String request = in.readLine(); int length = 0;
                        for (String line = in.readLine(); line != null && !line.isEmpty(); line = in.readLine())
                            if (line.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                        char[] body = new char[length]; int read = 0;
                        while (read < length) { int count = in.read(body, read, length - read); if (count < 0) break; read += count; }
                        int status = 200;
                        if (request != null && request.startsWith("POST /api/media/tts ")) { Integer next = statuses.poll(); status = next == null ? 202 : next; ttsBodies.add(new String(body, 0, read)); }
                        OutputStream out = socket.getOutputStream();
                        out.write(("HTTP/1.1 " + status + " Status\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    } catch (Exception ignored) {}
                }
            }, "adapter-http-test");
            thread.setDaemon(true); thread.start();
        }
        String url() { return "http://127.0.0.1:" + server.getLocalPort(); }
        JSONObject tts() throws Exception { String body = ttsBodies.poll(10, TimeUnit.SECONDS); assertNotNull("Expected an adapter TTS request", body); return new JSONObject(body); }
        public void close() throws Exception { server.close(); }
    }
    private static Object field(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target);
    }
    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
}
