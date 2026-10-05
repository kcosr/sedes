package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.system.Os;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
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
    @Test public void unsentInputWaitsForRegistrationWithoutBecomingUncertain() throws Exception {
        for (boolean cancel : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                f.onOwner(() -> {
                    f.runtime.clientDisconnected();
                    f.invoke("submit", new Class<?>[] { String.class, String.class, String.class, JSONObject.class, boolean.class }, f.binding, f.origin, null, f.entry, false);
                });
                assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.receiptReads.get());
                assertEquals("prepared", f.store.entry(f.binding, f.mutation).getString("stage"));
                assertEquals("prepared", f.runtime.snapshot().getJSONArray("recovery").getJSONObject(0).getString("status"));
                if (cancel) assertNull(f.command("stopCurrentInteraction", new JSONObject()));
                f.onOwner(() -> f.runtime.clientRegistered(f.request.getJSONObject("origin").getString("clientId"), "renewed-client-token"));
                if (cancel) { assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.store.journal(f.binding).length()); }
                else {
                    NativeVoiceHttp.Result reply = f.inputs.poll(10, TimeUnit.SECONDS); assertNotNull(reply);
                    assertEquals(f.externalRequest().toString(), f.lastRequest.get().toString());
                    reply.done(200, f.receipt("queued"), null); f.flush();
                    assertEquals(1, f.inputAttempts.get()); assertEquals(0, f.receiptReads.get());
                }
            }
        }
    }

    @Test public void knownRegistrationRejectionRetriesSameInputAfterReconnect() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.start().done(409, NativeVoiceJson.object("error", NativeVoiceJson.object("code", "client_registration_required")), null);
            f.flush();
            assertEquals(1, f.inputAttempts.get()); assertEquals(0, f.receiptReads.get());
            assertEquals("prepared", f.store.entry(f.binding, f.mutation).getString("stage"));
            NativeVoiceHttp.Result session = f.sessions.poll(10, TimeUnit.SECONDS); assertNotNull(session); f.refreshed(session);
            NativeVoiceHttp.Result reply = f.inputs.poll(10, TimeUnit.SECONDS); assertNotNull(reply);
            assertEquals(f.externalRequest().toString(), f.lastRequest.get().toString());
            reply.done(200, f.receipt("queued"), null); f.flush();
            assertEquals(2, f.inputAttempts.get()); assertEquals(0, f.receiptReads.get());
        }
    }

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

    @Test public void ordinaryForegroundAdmissionEmitsExactTransientOperationOnce() throws Exception {
        for (String status : new String[] { "queued", "submitting", "accepted" }) {
            try (Fixture f = new Fixture(status.equals("accepted"), false)) {
                f.foreground(f.target);
                long generation = f.runtime.snapshot().getLong("connectionGeneration");
                JSONObject receipt = f.submissionReceipt("submit", status);
                if (!status.equals("accepted")) NativeVoiceJson.put(receipt, "queuedInputId", "input-" + UUID.randomUUID());
                assertNotEquals(f.mutation, receipt.getString("operationId"));
                NativeVoiceHttp.Result reply = f.start();
                reply.done(200, receipt, null); f.flushEvents();
                assertEquals(1, f.submissions.size());
                JSONObject event = f.submissions.remove();
                assertEquals(8, event.length());
                assertEquals(f.profile, event.getString("profileId"));
                assertEquals(f.origin, event.getString("serverOrigin"));
                assertEquals(Fixture.IDENTITY, event.getString("identity"));
                assertEquals(generation, event.getLong("connectionGeneration"));
                assertEquals(f.target, event.getString("threadId"));
                assertEquals(receipt.getString("operationId"), event.getString("operationId"));
                assertEquals(f.request.getString("text"), event.getString("text"));
                assertTrue(event.has("queuedInputId"));
                if (receipt.has("queuedInputId")) assertEquals(receipt.getString("queuedInputId"), event.getString("queuedInputId"));
                else assertTrue(event.isNull("queuedInputId"));
                assertEquals(0, f.store.journal(f.binding).length());
                assertTrue(f.runtime.snapshot().isNull("active"));
                reply.done(200, receipt, null);
                assertNull(f.command("getState", new JSONObject()));
                f.onOwner(() -> f.invoke("recoverOutstanding", new Class<?>[0]));
                f.flushEvents(); assertTrue("Neither duplicate callbacks nor snapshots replay a submission", f.submissions.isEmpty());
            }
        }
    }

    @Test public void foregroundSubmissionHandsOffTheExactFullUtf8TextWithoutPublishingItInSnapshots() throws Exception {
        for (String text : new String[] { "  A long dictation with an intact beginning.\n" + "完整语音🙂 ".repeat(5000) + "\nAnd its exact end.  ", "🙂".repeat(65536) }) {
            try (Fixture f = new Fixture(false, false, false, text)) {
                f.foreground(f.target); NativeVoiceHttp.Result reply = f.start();
                assertEquals(text, f.lastRequest.get().getString("text"));
                assertFalse(f.runtime.snapshot().toString().contains("完整语音"));
                assertFalse(f.runtime.snapshot().has("text"));
                JSONObject receipt = f.submissionReceipt("submit", "accepted");
                reply.done(200, receipt, null); f.flushEvents();
                JSONObject event = f.submissions.poll(10, TimeUnit.SECONDS); assertNotNull(event);
                assertEquals(text, event.getString("text")); assertEquals(NativeVoiceJson.bytes(text), NativeVoiceJson.bytes(event.getString("text")));
                assertEquals(receipt.getString("operationId"), event.getString("operationId"));
                assertEquals(0, f.store.journal(f.binding).length());
                reply.done(200, receipt, null); f.flushEvents(); assertTrue(f.submissions.isEmpty());
            }
        }
    }

    @Test public void mismatchedReceiptCannotExportTheActiveFullText() throws Exception {
        for (String field : new String[] { "threadId", "mutationId" }) {
            try (Fixture f = new Fixture(false, false, false, "Exact private transcript ".repeat(100))) {
                f.foreground(f.target); NativeVoiceHttp.Result reply = f.start();
                JSONObject receipt = f.submissionReceipt("submit", "accepted"); NativeVoiceJson.put(receipt, field, UUID.randomUUID().toString());
                reply.done(200, receipt, null); f.flushEvents();
                assertTrue(f.submissions.isEmpty()); assertEquals(1, f.inputAttempts.get());
                assertNotNull(f.store.entry(f.binding, f.mutation));
            }
        }
    }

    @Test public void admissionDoesNotSignalQueueSteerOrTerminalDispatchFailure() throws Exception {
        String[][] outcomes = { { "queue", "queued" }, { "steer", "accepted" },
            { "submit", "failed" }, { "submit", "recovery_required" }, { "submit", "cancelled" } };
        for (String[] outcome : outcomes) {
            try (Fixture f = new Fixture(false, false)) {
                f.foreground(f.target);
                f.start().done(200, f.submissionReceipt(outcome[0], outcome[1]), null); f.flushEvents();
                assertTrue(outcome[0] + ":" + outcome[1], f.submissions.isEmpty());
                assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }

    @Test public void admissionRequiresCurrentUncancelledForegroundOwnership() throws Exception {
        for (String change : new String[] { "native_hidden", "web_hidden", "other_thread", "generation", "binding", "cancelled" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.foreground(f.target);
                NativeVoiceHttp.Result reply = f.start();
                switch (change) {
                    case "native_hidden": f.runtime.nativeVisibility(false); break;
                    case "web_hidden": assertNull(f.command("setForegroundContext", NativeVoiceJson.object("visible", false))); break;
                    case "other_thread": f.foreground(UUID.randomUUID().toString()); break;
                    case "generation": f.onOwner(() -> {
                        set(f.runtime, "connectionGeneration", f.runtime.snapshot().getLong("connectionGeneration") + 1);
                        f.invoke("publish", new Class<?>[0]);
                    }); break;
                    case "binding": f.onOwner(() -> set(f.runtime, "binding", f.binding + "-other")); break;
                    case "cancelled": assertNull(f.command("stopCurrentInteraction", new JSONObject())); break;
                    default: throw new AssertionError(change);
                }
                reply.done(200, f.submissionReceipt("submit", "accepted"), null); f.flushEvents();
                assertTrue(change, f.submissions.isEmpty());
            }
        }
    }

    @Test public void receiptLookupSignalsOnlyWhileTheOriginalInteractionIsStillActive() throws Exception {
        for (boolean immediatelyFound : new boolean[] { true, false }) {
            try (Fixture f = new Fixture(false, false)) {
                f.foreground(f.target);
                JSONObject receipt = f.submissionReceipt("submit", "accepted");
                if (immediatelyFound) f.receiptResponse.set(NativeVoiceJson.object("status", "found", "receipt", receipt));
                f.start().done(503, null, null); f.flushEvents();
                assertTrue(f.runtime.snapshot().isNull("active"));
                if (!immediatelyFound) {
                    assertTrue(f.submissions.isEmpty());
                    f.receiptResponse.set(NativeVoiceJson.object("status", "found", "receipt", receipt));
                    f.onOwner(() -> f.invoke("recoverOutstanding", new Class<?>[0]));
                    f.flushEvents();
                }
                assertEquals(immediatelyFound ? 1 : 0, f.submissions.size());
                assertEquals("Recovery reads never resend input", 1, f.inputAttempts.get());
                assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }

    @Test public void pendingSubmissionEventExpiresWhenForegroundOwnershipChanges() throws Exception {
        for (String change : new String[] { "visibility_round_trip", "thread_round_trip", "connection" }) {
            try (Fixture f = new Fixture(false, false, false, "Transient full transcript ".repeat(100))) {
                f.foreground(f.target);
                NativeVoiceHttp.Result reply = f.start();
                try (MainBlock ignored = new MainBlock()) {
                    reply.done(200, f.submissionReceipt("submit", "accepted"), null); f.flush();
                    assertTrue(f.runtime.snapshot().isNull("active"));
                    switch (change) {
                        case "visibility_round_trip": f.runtime.nativeVisibility(false); f.foreground(f.target); break;
                        case "thread_round_trip": f.foreground(UUID.randomUUID().toString()); f.foreground(f.target); break;
                        case "connection": f.onOwner(() -> f.invoke("disconnect", new Class<?>[] { boolean.class }, false)); break;
                        default: throw new AssertionError(change);
                    }
                }
                f.flushEvents(); assertTrue(change, f.submissions.isEmpty());
            }
        }
    }

    @Test public void pendingSubmissionEventDoesNotReplayToAReplacementWebViewObserver() throws Exception {
        try (Fixture f = new Fixture(false, false, false, "Only the original WebView may receive this text. ".repeat(100))) {
            f.foreground(f.target);
            NativeVoiceHttp.Result reply = f.start();
            BlockingQueue<JSONObject> replacementEvents = new LinkedBlockingQueue<>();
            NativeVoiceRuntime.Observer replacement = (name, value) -> { if (name.equals("inputSubmitted")) replacementEvents.add(value); };
            try {
                try (MainBlock ignored = new MainBlock()) {
                    reply.done(200, f.submissionReceipt("submit", "accepted"), null); f.flush();
                    f.runtime.unobserve(f.submissionObserver);
                    f.runtime.observe(replacement);
                }
                f.flushEvents();
                assertTrue(f.submissions.isEmpty()); assertTrue(replacementEvents.isEmpty());
                assertNull(f.command("getState", new JSONObject()));
                f.flushEvents(); assertTrue(replacementEvents.isEmpty());
            } finally { f.runtime.unobserve(replacement); }
        }
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
            assertEquals(f.externalRequest().toString(), f.lastRequest.get().toString());
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
            assertEquals(2, f.inputAttempts.get()); assertEquals(f.externalRequest().toString(), f.lastRequest.get().toString());
            retry.done(200, f.receipt("queued"), null); f.flush();
            assertEquals(0, f.store.journal(f.binding).length()); assertEquals(0, f.runtime.snapshot().getJSONArray("recovery").length());
        }
    }

    @Test public void pinnedDefaultOwnsExplicitHeadsetAndNotificationStartsButStillAllowsRetargeting() throws Exception {
        for (String source : new String[] { "app", "headset", "start" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
                f.settings(NativeVoiceJson.object("pinDefaultVoiceThread", true, "voiceThreadId", f.target, "voiceThreadTitle", "Pinned default"));
                String other = UUID.randomUUID().toString(); f.foreground(other);
                if (source.equals("app")) assertNull(f.command("startManualListen", NativeVoiceJson.object("threadId", other, "threadTitle", "Explicit other")));
                else { f.runtime.notificationAction(source, f.runtime.snapshot().getLong("connectionGeneration")); f.flush(); }
                JSONObject active = f.runtime.snapshot().getJSONObject("active");
                assertEquals(source, f.target, active.getString("recognitionThreadId"));
                assertEquals("Pinned default", active.getString("recognitionThreadTitle"));
                assertNotNull("The pinned target still requires server validation", f.contexts.poll(10, TimeUnit.SECONDS));
                f.onOwner(() -> f.invoke("beginCapture", new Class<?>[] { Class.forName("dev.sedes.local.NativeVoiceRuntime$Active") }, field(f.runtime, "active")));
                assertNotNull(f.speech.transcriptions.poll(10, TimeUnit.SECONDS));
                f.onOwner(() -> { set(f.runtime, "phase", "listening"); f.invoke("publish", new Class<?>[0]); });
                assertNull(f.command("retargetActiveRecognition", NativeVoiceJson.object("threadId", other, "threadTitle", "Retargeted")));
                assertEquals(other, f.runtime.snapshot().getJSONObject("active").getString("recognitionThreadId"));
            }
        }
    }

    @Test public void missingPinnedDefaultRefusesAllStartsWithoutFallingBackToForegroundOrExplicitThread() throws Exception {
        for (String source : new String[] { "app", "headset", "start" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
                f.settings(NativeVoiceJson.object("pinDefaultVoiceThread", true)); f.foreground(f.target);
                if (source.equals("app")) assertEquals("voice_target_required",
                    f.command("startManualListen", NativeVoiceJson.object("threadId", f.target, "threadTitle", "Explicit target")));
                else {
                    f.runtime.notificationAction(source, f.runtime.snapshot().getLong("connectionGeneration")); f.flush();
                    assertEquals("voice_target_required", f.lastError().getString("code"));
                }
                assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.contexts.isEmpty());
            }
        }
    }

    @Test public void unpinnedManualStartKeepsForegroundThenDefaultPrecedence() throws Exception {
        for (boolean visible : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
                f.settings(NativeVoiceJson.object("voiceThreadId", f.target, "voiceThreadTitle", "Default"));
                String other = UUID.randomUUID().toString();
                if (visible) f.foreground(other);
                assertNull(f.command("startManualListen", new JSONObject()));
                assertEquals(visible ? other : f.target, f.runtime.snapshot().getJSONObject("active").getString("recognitionThreadId"));
            }
        }
    }

    @Test public void rejectedArgumentsDoNotPartiallyApply() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String other = UUID.randomUUID().toString();
            f.recognizing(false);
            f.onOwner(() -> { set(f.runtime, "phase", "listening"); set(f.runtime, "nativeVisible", true); f.invoke("publish", new Class<?>[0]); });
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

    @Test public void speechFailureEndsOnlyItsRequestAndLateFailuresAreIgnored() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String request = f.media("speech");
            f.speechFailure(request, "speech_network_error");
            assertTrue(f.runtime.snapshot().isNull("active"));
            assertEquals("speech_network_error", f.lastError().getString("code"));
            f.speechFailure(request, "speech_network_error");
            assertEquals(1, f.errors("speech_network_error"));
            assertTrue("Provider failure does not introduce a persistent connection gate", (boolean) f.invokeResult("speechReady"));
        }
    }

    @Test public void providerChangeKeepsAnAdmittedInput() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.start();
            f.onOwner(() -> f.invoke("updateSettings", new Class<?>[] { JSONObject.class, boolean.class }, NativeVoiceJson.object("expectedRevision", 0,
                "patch", NativeVoiceJson.object("audioMode", "response", "speechProvider", "server", "speechEndpoint", "http://127.0.0.1:9/v1")), false));
            assertFalse(f.runtime.snapshot().isNull("active"));
            assertFalse(f.store.journal(f.binding).getJSONObject(0).getBoolean("cancelled"));
        }
    }

    @Test public void nativeCredentialSaveRejectsRecordingThenPersistsWithoutPublishingTheSecret() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(true);
            RecognitionJob recording = f.synthetic;
            String secret = "runtime-private-speech-token";
            assertEquals("recording_settings_busy", f.credentialAction("save", secret, f.runtime.snapshot().getLong("connectionGeneration"), 1));
            assertFalse(recording.cancelled); assertFalse(f.runtime.snapshot().isNull("active"));
            assertNull(new SpeechCredentialStore(f.context).getCredential(f.profile, "server", "http://127.0.0.1:9/v1"));
            assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            Cue stopped = f.cue(NativeVoiceCue.Kind.FAILURE); f.runtime.drained(stopped.id); f.flush();
            assertNull(f.credentialAction("save", secret, f.runtime.snapshot().getLong("connectionGeneration"), 1));
            assertTrue(recording.cancelled); assertTrue(f.runtime.snapshot().isNull("active"));
            assertTrue(f.runtime.snapshot().getJSONObject("speech").getBoolean("credentialConfigured"));
            assertFalse("Secrets never enter snapshots", f.runtime.snapshot().toString().contains(secret));
            assertEquals(secret, new SpeechCredentialStore(f.context).getCredential(f.profile, "server", "http://127.0.0.1:9/v1"));
            assertNull(f.credentialAction("remove", null, f.runtime.snapshot().getLong("connectionGeneration"), 1));
            assertFalse(f.runtime.snapshot().getJSONObject("speech").getBoolean("credentialConfigured"));
            assertNull(new SpeechCredentialStore(f.context).getCredential(f.profile, "server", "http://127.0.0.1:9/v1"));
        }
    }

    @Test public void credentialDialogRevisionAndConnectionChecksPrecedeAnyWrite() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false);
            long generation = f.runtime.snapshot().getLong("connectionGeneration");
            assertEquals("settings_revision_conflict", f.credentialAction("save", "stale-dialog-token", generation, 0));
            assertEquals("connection_changed", f.credentialAction("save", "stale-dialog-token", generation + 1, 1));
            assertNull(new SpeechCredentialStore(f.context).getCredential(f.profile, "server", "http://127.0.0.1:9/v1"));
            assertFalse(f.runtime.snapshot().isNull("active"));
        }
    }

    @Test public void credentialReplacementPreservesTheFinalTranscriptAndItsAdmission() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.result(f.recognizing(true), true, "Final text belongs to the input");
            Cue cue = f.cue(NativeVoiceCue.Kind.SUCCESS);
            assertNull(f.credentialAction("save", "replacement-speech-token", f.runtime.snapshot().getLong("connectionGeneration"), 1));
            assertFalse(f.runtime.snapshot().isNull("active"));
            f.runtime.drained(cue.id); f.flush();
            assertEquals(1, f.inputAttempts.get());
            assertNull(f.credentialAction("remove", null, f.runtime.snapshot().getLong("connectionGeneration"), 1));
            assertFalse(f.runtime.snapshot().isNull("active"));
            assertFalse(f.store.journal(f.binding).getJSONObject(0).getBoolean("cancelled"));
            assertEquals("Final text belongs to the input", f.lastRequest.get().getString("text"));
        }
    }

    @Test public void unreadableStoredCredentialKeepsSpeechUnavailable() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false);
            f.onOwner(() -> set(f.runtime, "speechCredentialError", true));
            assertFalse((boolean) f.invokeResult("speechReady"));
            assertEquals("speech_credential_storage_unavailable", f.credentialAction("test", null,
                f.runtime.snapshot().getLong("connectionGeneration"), 1));
        }
    }

    @Test public void resumeRequiresReadableCredentialsAndCompleteSpeechConfiguration() throws Exception {
        for (String missing : new String[] { "endpoint", "credential", "storage" }) {
            try (Fixture f = new Fixture(false, false)) {
                NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
                f.recognizing(false);
                f.onOwner(() -> { set(f.runtime, "active", null); set(f.runtime, "sessionStarted", false); f.invoke("publish", new Class<?>[0]); });
                assertTrue(f.runtime.snapshot().getJSONObject("actions").getBoolean("canResume"));
                f.onOwner(() -> {
                    if (missing.equals("endpoint")) {
                        NativeVoiceSettings settings = (NativeVoiceSettings) field(f.runtime, "settings");
                        set(f.runtime, "settings", settings.patch(settings.revision, NativeVoiceJson.object("speechEndpoint", "")));
                    } else if (missing.equals("credential")) set(f.runtime, "speechCredential", null);
                    else set(f.runtime, "speechCredentialError", true);
                    f.invoke("publish", new Class<?>[0]);
                });
                assertEquals("speechConfigurationRequired", f.runtime.snapshot().getString("readiness"));
                assertFalse(missing, f.runtime.snapshot().getJSONObject("actions").getBoolean("canResume"));
            }
        }
    }

    @Test public void captureSettingsEditsKeepSpeakingAndApplyToItsAutomaticFollowup() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
            String playback = f.automaticRecognizing(false);
            Object item = field(f.runtime, "active");
            SpeechJob speech = new SpeechJob(playback, "Ready for a reply", null);
            f.onOwner(() -> {
                ((NativeVoiceRecording) field(item, "recording")).discard(); set(item, "recording", null); set(item, "recordingId", null);
                set(item, "captureId", null); set(item, "ttsId", playback); set(item, "speechRequest", speech);
                set(f.runtime, "phase", "speaking"); f.invoke("publish", new Class<?>[0]);
            });
            String activeId = f.runtime.snapshot().getJSONObject("active").getString("id");
            f.settings(NativeVoiceJson.object("recognitionStartTimeoutMs", 1000, "recognitionCompletionTimeoutMs", 2000,
                "recognitionResultTimeoutMs", 90000, "recognitionEndSilenceMs", 100, "inputDeviceId", "changed-microphone"));
            assertEquals(activeId, f.runtime.snapshot().getJSONObject("active").getString("id"));
            assertEquals("speaking", f.runtime.snapshot().getString("phase")); assertFalse(speech.cancelled);
            assertTrue((boolean) field(item, "followUp"));
            f.runtime.drained(playback); f.flush();
            JSONObject context = NativeVoiceJson.object("threadId", f.target, "activityToken", "automatic-retry-epoch",
                "authority", "current", "runState", "idle", "automaticListenEligible", true,
                "steer", NativeVoiceJson.object("availability", "unavailable"));
            for (int validation = 0; validation < 2; validation++) {
                NativeVoiceHttp.Result reply = f.contexts.poll(10, TimeUnit.SECONDS); assertNotNull(reply);
                reply.done(200, context, null); f.flush();
            }
            RecognitionJob capture = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(capture);
            assertEquals(90000, capture.resultTimeout);
            AtomicInteger reads = new AtomicInteger();
            NativeVoiceAudio.setTestSource(() -> captureFrame(reads.getAndIncrement() == 0 ? 1000 : 0));
            capture.ready(); awaitCommit(f, capture);
            assertEquals("The next capture uses the new 100 ms silence deadline", 9600, capture.bytes);
        }
    }

    @Test public void profileRemovalDeletesSpeechSecretsEvenWhenVoiceRecordCleanupFails() throws Exception {
        for (boolean throughPlugin : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                SpeechCredentialStore speech = new SpeechCredentialStore(f.context);
                ClientCredentialStore pairing = new ClientCredentialStore(f.context);
                speech.setCredential(f.profile, "server", "https://speech.example/v1", "profile-speech-token");
                pairing.setCredential(f.profile, f.origin, "profile-pairing-token");
                File directory = f.store.directory(f.binding);
                int mode = Os.stat(directory.getPath()).st_mode & 0777;
                try {
                    Os.chmod(directory.getPath(), 0500);
                    if (throughPlugin) assertThrows(Exception.class, () -> ClientCredentialsPlugin.removeProfileCredentials(f.context, f.profile, f.runtime::profileRemoved));
                    else assertThrows(Exception.class, () -> f.runtime.profileRemoved(f.profile));
                    assertNull(speech.getCredential(f.profile, "server", "https://speech.example/v1"));
                    if (throughPlugin) assertNull(pairing.getCredential(f.profile, f.origin));
                    assertNull("Profile removal disconnects before any cleanup", field(f.runtime, "binding"));
                } finally { Os.chmod(directory.getPath(), mode); pairing.removeProfileCredentials(f.profile); }
            }
        }
    }

    @Test public void mandatorySecretRemovalFailuresReachTheCallerAndDoNotSkipTheOtherStore() throws Exception {
        for (String blockedStore : new String[] { "speech-credentials", "credentials" }) {
            try (Fixture f = new Fixture(false, false)) {
                SpeechCredentialStore speech = new SpeechCredentialStore(f.context);
                ClientCredentialStore pairing = new ClientCredentialStore(f.context);
                speech.setCredential(f.profile, "server", "https://speech.example/v1", "profile-speech-token");
                pairing.setCredential(f.profile, f.origin, "profile-pairing-token");
                File blocked = new File(new File(new File(f.context.getNoBackupFilesDir(), blockedStore), hash(f.profile)), "blocked");
                assertTrue(blocked.mkdir()); File retained = new File(blocked, "retained"); assertTrue(retained.createNewFile());
                try {
                    Exception error = assertThrows(Exception.class,
                        () -> ClientCredentialsPlugin.removeProfileCredentials(f.context, f.profile, f.runtime::profileRemoved));
                    assertEquals("credential_removal_failed", error.getMessage());
                    if (blockedStore.equals("speech-credentials")) assertNull(pairing.getCredential(f.profile, f.origin));
                    else assertNull(speech.getCredential(f.profile, "server", "https://speech.example/v1"));
                    assertNull(field(f.runtime, "binding"));
                } finally {
                    assertTrue(retained.delete()); assertTrue(blocked.delete());
                    pairing.removeProfileCredentials(f.profile);
                }
            }
        }
    }

    @Test public void speechPlaybackEditsPreserveCaptureAndRecognitionEditsAreRejected() throws Exception {
        for (JSONObject patch : new JSONObject[] { NativeVoiceJson.object("ttsVoice", "nova"),
            NativeVoiceJson.object("ttsSpeed", 1.5), NativeVoiceJson.object("sttModel", "other-stt") }) {
            try (Fixture f = new Fixture(false, false)) {
                f.recognizing(false); RecognitionJob recording = f.synthetic;
                JSONObject catalog = NativeSpeechCatalog.empty("server");
                NativeVoiceJson.put(catalog, "voices", new JSONArray().put("coral").put("nova"));
                AtomicReference<String> cancelledTest = new AtomicReference<>();
                f.onOwner(() -> {
                    set(f.runtime, "speechCatalog", catalog); set(f.runtime, "catalogStatus", "ready");
                    set(f.runtime, "credentialTestReply", new NativeVoiceRuntime.Reply() {
                        public void done(JSONObject value) { fail("An obsolete credential test cannot succeed"); }
                        public void failed(String code, String message) { cancelledTest.set(code); }
                    });
                });
                long generation = (long) field(f.runtime, "catalogGeneration");
                String result = f.command("updateSettings", NativeVoiceJson.object("expectedRevision", 1, "patch", patch));
                assertFalse(recording.cancelled); assertFalse(f.runtime.snapshot().isNull("active"));
                if (patch.has("sttModel")) { assertEquals("recording_settings_busy", result); assertNull(cancelledTest.get()); }
                else { assertNull(result); assertEquals("speech_configuration_changed", cancelledTest.get()); }
                assertEquals(generation, field(f.runtime, "catalogGeneration"));
                assertEquals(NativeSpeechCatalog.picker(catalog).toString(), f.runtime.snapshot().getJSONObject("speech").getJSONObject("catalog").toString());
                assertEquals("ready", f.runtime.snapshot().getJSONObject("speech").getString("catalogStatus"));
            }
        }
    }

    @Test public void inFlightCatalogSurvivesVoiceEditAndSpeechModelChangeRefetchesItsVoices() throws Exception {
        try (Fixture f = new Fixture(false, false); CatalogPeer peer = new CatalogPeer("catalog-test-token")) {
            f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            new SpeechCredentialStore(f.context).setCredential(f.profile, "server", peer.endpoint(), "catalog-test-token");
            f.settings(NativeVoiceJson.object("speechEndpoint", peer.endpoint()));
            CountDownLatch discovered = new CountDownLatch(1); AtomicReference<String> failure = new AtomicReference<>();
            f.runtime.command("refreshSpeechCatalog", NativeVoiceJson.object("force", true), false, new NativeVoiceRuntime.Reply() {
                public void done(JSONObject value) { discovered.countDown(); }
                public void failed(String code, String message) { failure.set(code); discovered.countDown(); }
            });
            CountDownLatch firstResponse = peer.next();
            assertTrue("Refresh replies before its network response", discovered.await(1, TimeUnit.SECONDS));
            assertNull(f.command("refreshSpeechCatalog", NativeVoiceJson.object("force", false)));
            assertNull(f.command("refreshSpeechCatalog", NativeVoiceJson.object("force", true)));
            f.settings(NativeVoiceJson.object("ttsVoice", "nova", "ttsSpeed", 1.5));
            assertEquals("loading", f.runtime.snapshot().getJSONObject("speech").getString("catalogStatus"));
            firstResponse.countDown(); awaitCatalog(f); assertNull(failure.get());
            assertEquals("[\"first-voice\"]", f.runtime.snapshot().getJSONObject("speech").getJSONObject("catalog").getJSONArray("voices").toString());
            f.settings(NativeVoiceJson.object("ttsModel", "second-tts"));
            CountDownLatch secondResponse = peer.next();
            assertEquals("loading", f.runtime.snapshot().getJSONObject("speech").getString("catalogStatus"));
            assertTrue(f.runtime.snapshot().getJSONObject("speech").isNull("catalog"));
            secondResponse.countDown();
            long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
            while (f.runtime.snapshot().getJSONObject("speech").getString("catalogStatus").equals("loading") &&
                android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(10);
            f.flush();
            assertEquals("[\"second-voice\"]", f.runtime.snapshot().getJSONObject("speech").getJSONObject("catalog").getJSONArray("voices").toString());
            assertEquals(2, peer.requests.get());
            assertNull(f.command("refreshSpeechCatalog", NativeVoiceJson.object("force", false)));
            peer.assertNoFurtherRequests(2);
        }
    }

    @Test public void failedRefreshRetainsCachedChoicesUntilAuthenticationIsRejected() throws Exception {
        try (Fixture f = new Fixture(false, false); CatalogPeer peer = new CatalogPeer("catalog-test-token")) {
            f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            new SpeechCredentialStore(f.context).setCredential(f.profile, "server", peer.endpoint(), "catalog-test-token");
            f.settings(NativeVoiceJson.object("speechEndpoint", peer.endpoint()));
            discover(f, peer);
            JSONObject catalog = f.runtime.snapshot().getJSONObject("speech").getJSONObject("catalog");
            JSONObject selections = f.runtime.snapshot().getJSONObject("settings");
            for (int response : new int[] { 503, 200, 401 }) {
                peer.status = response; peer.malformed = response == 200;
                assertNull(f.command("refreshSpeechCatalog", NativeVoiceJson.object("force", true)));
                peer.next().countDown(); awaitCatalogStatus(f, "error");
                JSONObject speech = f.runtime.snapshot().getJSONObject("speech");
                if (response == 401) {
                    assertTrue(speech.isNull("catalog"));
                    assertFalse(new File(f.store.directory(f.binding), "speech-catalog.enc").exists());
                } else assertEquals(catalog.toString(), speech.getJSONObject("catalog").toString());
                assertEquals(selections.toString(), f.runtime.snapshot().getJSONObject("settings").toString());
            }
        }
    }

    @Test public void expiredCacheRefreshesWithoutClearingChoicesOrStartingVoice() throws Exception {
        try (Fixture f = new Fixture(false, false); CatalogPeer peer = new CatalogPeer("catalog-test-token")) {
            f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            new SpeechCredentialStore(f.context).setCredential(f.profile, "server", peer.endpoint(), "catalog-test-token");
            f.settings(NativeVoiceJson.object("speechEndpoint", peer.endpoint())); discover(f, peer);
            f.settings(NativeVoiceJson.object("audioMode", "off"));
            NativeSpeechCatalogCache saved = (NativeSpeechCatalogCache) field(f.runtime, "catalogCache");
            f.onOwner(() -> set(f.runtime, "catalogCache", new NativeSpeechCatalogCache(saved.scope,
                System.currentTimeMillis() - NativeSpeechCatalogCache.FRESH_MS, saved.catalog)));
            assertNull(f.command("refreshSpeechCatalog", NativeVoiceJson.object("force", false)));
            CountDownLatch response = peer.next();
            assertEquals("loading", f.runtime.snapshot().getJSONObject("speech").getString("catalogStatus"));
            assertEquals(NativeSpeechCatalog.picker(saved.catalog).toString(), f.runtime.snapshot().getJSONObject("speech").getJSONObject("catalog").toString());
            assertEquals("off", f.runtime.snapshot().getString("phase"));
            assertNull(field(f.runtime, "sessionStartId")); assertFalse((boolean) field(f.runtime, "sessionStarted"));
            response.countDown(); awaitCatalog(f);
        }
    }

    @Test public void switchingDiscoveredEndpointsUsesOnlyTheNewEndpointsStoredToken() throws Exception {
        try (Fixture f = new Fixture(false, false); CatalogPeer first = new CatalogPeer("endpoint-a-token");
             CatalogPeer second = new CatalogPeer("endpoint-b-token")) {
            f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            SpeechCredentialStore credentials = new SpeechCredentialStore(f.context);
            credentials.setCredential(f.profile, "server", first.endpoint(), "endpoint-a-token");
            credentials.setCredential(f.profile, "server", second.endpoint(), "endpoint-b-token");
            f.settings(NativeVoiceJson.object("speechEndpoint", first.endpoint()));
            discover(f, first);
            f.settings(NativeVoiceJson.object("speechEndpoint", second.endpoint()));
            second.next().countDown(); awaitCatalog(f);
            assertEquals(second.endpoint(), f.runtime.snapshot().getJSONObject("settings").getString("speechEndpoint"));
            assertTrue(f.runtime.snapshot().getJSONObject("speech").getBoolean("credentialConfigured"));
            first.assertNoFurtherRequests(1); second.assertNoFurtherRequests(1);
        }
    }

    @Test public void switchingADiscoveredEndpointToOneWithoutACredentialDoesNotSendDiscovery() throws Exception {
        try (Fixture f = new Fixture(false, false); CatalogPeer first = new CatalogPeer("endpoint-a-token");
             CatalogPeer withoutCredential = new CatalogPeer("no-token-was-saved-for-this-endpoint")) {
            f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            new SpeechCredentialStore(f.context).setCredential(f.profile, "server", first.endpoint(), "endpoint-a-token");
            f.settings(NativeVoiceJson.object("speechEndpoint", first.endpoint()));
            discover(f, first);
            f.settings(NativeVoiceJson.object("speechEndpoint", withoutCredential.endpoint()));
            JSONObject speech = f.runtime.snapshot().getJSONObject("speech");
            assertEquals("idle", speech.getString("catalogStatus")); assertTrue(speech.isNull("catalog"));
            assertFalse(speech.getBoolean("credentialConfigured")); assertNull(field(f.runtime, "catalogCall"));
            first.assertNoFurtherRequests(1); withoutCredential.assertNoFurtherRequests(0);
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

    @Test public void allHttpRejectionsFailTheChunkWithoutSendingLaterChunks() throws Exception {
        for (int rejection : new int[] { 400, 409 }) {
            try (Fixture f = new Fixture(false, false)) {
                f.recognizing(false);
                f.onOwner(() -> {
                    Object active = field(f.runtime, "active"); set(active, "captureId", null); set(active, "recording", null);
                    @SuppressWarnings("unchecked") List<String> chunks = (List<String>) field(active, "chunks");
                    chunks.add("```"); chunks.add("Spoken chunk");
                    Method speak = NativeVoiceRuntime.class.getDeclaredMethod("speakChunk", Class.forName("dev.sedes.local.NativeVoiceRuntime$Active"));
                    speak.setAccessible(true); speak.invoke(f.runtime, active);
                });
                SpeechJob request = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(request);
                assertEquals("```", request.text);
                request.listener.failed(request.id, new NativeSpeechTransport.Failure(NativeSpeechTransport.Kind.HTTP, "speech_http_error", rejection));
                f.flush(); assertTrue(f.runtime.snapshot().isNull("active"));
                assertEquals("speech_http_error", f.lastError().getString("code"));
                assertTrue("Failed speech must cancel its request handle", request.cancelled);
                assertTrue("A failed item does not continue to its next chunk", f.speech.speechRequests.isEmpty());
            }
        }
    }

    @Test public void configuredTranscriptionStartsPcm24kCaptureAndLocalSilenceCommitsExactlyOnce() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
            f.recognizing(false);
            AtomicInteger microphoneReads = new AtomicInteger();
            NativeVoiceAudio.setTestSource(() -> captureFrame(microphoneReads.getAndIncrement() == 0 ? 1000 : 0));
            f.onOwner(() -> {
                NativeVoiceSettings settings = (NativeVoiceSettings) field(f.runtime, "settings");
                set(f.runtime, "settings", settings.patch(settings.revision, NativeVoiceJson.object(
                    "recognitionEndSilenceMs", 300, "recognitionResultTimeoutMs", 90000)));
                f.invoke("beginCapture", new Class<?>[] { Class.forName("dev.sedes.local.NativeVoiceRuntime$Active") }, field(f.runtime, "active"));
            });
            RecognitionJob request = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(request);
            assertEquals(90000, request.resultTimeout);
            assertEquals("arming", f.runtime.snapshot().getString("phase"));
            assertEquals("The microphone waits for session.updated", 0, microphoneReads.get());
            request.ready();
            awaitCommit(f, request);
            assertEquals(1, request.commits);
            assertEquals("100 ms speech plus 300 ms local end silence at 24 kHz", 4 * 4800, request.bytes);
            assertEquals("recognizing", f.runtime.snapshot().getString("phase"));
            f.runtime.captured(request.captureId, captureFrame(1000)); f.runtime.captureEnded(request.captureId); f.flush();
            assertEquals(1, request.commits); assertEquals(4 * 4800, request.bytes);
            request.complete("One locally finalized utterance"); f.flush();
            assertEquals(1, f.inputAttempts.get());
            assertEquals("One locally finalized utterance", f.lastRequest.get().getString("text"));
            request.complete("Late duplicate"); f.flush(); assertEquals(1, f.inputAttempts.get());
        }
    }

    @Test public void noSpeechTimeoutAndSourceEndCancelWithoutCommitRetryOrInput() throws Exception {
        for (boolean cues : new boolean[] { false, true }) {
            for (boolean sourceEnds : new boolean[] { false, true }) {
                try (Fixture f = new Fixture(false, false)) {
                    NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
                    f.recognizing(cues);
                    AtomicInteger reads = new AtomicInteger();
                    NativeVoiceAudio.setTestSource(() -> sourceEnds && reads.getAndIncrement() >= 3 ? null : captureFrame(0));
                    f.onOwner(() -> {
                        NativeVoiceSettings settings = (NativeVoiceSettings) field(f.runtime, "settings");
                        set(f.runtime, "settings", settings.patch(settings.revision, NativeVoiceJson.object("recognitionStartTimeoutMs", 1000)));
                        f.invoke("beginCapture", new Class<?>[] { Class.forName("dev.sedes.local.NativeVoiceRuntime$Active") }, field(f.runtime, "active"));
                    });
                    RecognitionJob request = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(request);
                    request.ready();
                    long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
                    while (!request.cancelled && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(10);
                    f.flush(); assertTrue(request.cancelled); assertEquals(0, request.commits);
                    assertEquals("Unsealed quiet audio remains local until the no-speech attempt is discarded", 0, request.bytes);
                    if (cues) { Cue failure = f.cue(NativeVoiceCue.Kind.FAILURE); f.runtime.drained(failure.id); f.flush(); }
                    assertTrue(f.runtime.snapshot().isNull("active"));
                    request.complete(""); request.complete("Late transcript");
                    request.ready(); f.runtime.captureEnded(request.captureId); f.flush();
                    assertEquals(0, request.commits); assertTrue(f.speech.transcriptions.isEmpty()); assertTrue(f.cues.isEmpty());
                    assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
                }
            }
        }
    }

    @Test public void repeatedEmptyTranscriptsAfterDetectedSpeechKeepTheExistingRetryBehavior() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
            f.recognizing(false);
            f.onOwner(() -> {
                NativeVoiceSettings settings = (NativeVoiceSettings) field(f.runtime, "settings");
                set(f.runtime, "settings", settings.patch(settings.revision, NativeVoiceJson.object("recognitionEndSilenceMs", 100)));
                f.invoke("beginCapture", new Class<?>[] { Class.forName("dev.sedes.local.NativeVoiceRuntime$Active") }, field(f.runtime, "active"));
            });
            for (int attempt = 0; attempt < 2; attempt++) {
                RecognitionJob request = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(request);
                AtomicInteger reads = new AtomicInteger();
                NativeVoiceAudio.setTestSource(() -> captureFrame(reads.getAndIncrement() == 0 ? 1000 : 0));
                request.ready(); awaitCommit(f, request);
                assertEquals(9600, request.bytes);
                request.complete(" \u00a0 "); f.flush();
                assertEquals("arming", f.runtime.snapshot().getString("phase"));
                assertTrue(request.cancelled);
            }
            assertNotNull("Each empty result after speech still re-arms", f.speech.transcriptions.poll(10, TimeUnit.SECONDS));
            assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
        }
    }

    @Test public void focusLossWhileConfiguringCancelsTheRequestBeforeMicrophoneOwnership() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false);
            AtomicInteger microphoneReads = new AtomicInteger();
            NativeVoiceAudio.setTestSource(() -> { microphoneReads.incrementAndGet(); return captureFrame(0); });
            f.onOwner(() -> f.invoke("beginCapture", new Class<?>[] { Class.forName("dev.sedes.local.NativeVoiceRuntime$Active") }, field(f.runtime, "active")));
            RecognitionJob request = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(request);
            f.runtime.failed(request.captureId, "audio_focus_lost"); f.flush();
            assertTrue(request.cancelled); assertTrue(f.runtime.snapshot().isNull("active"));
            request.ready(); request.complete("Too late"); f.flush();
            assertEquals(0, microphoneReads.get()); assertEquals(0, f.inputAttempts.get());
            assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
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
    @Test public void failedAndSpokenStopResultsUseDescendingCueWithoutInput() throws Exception {
        for (String text : new String[] { "stop", "failed" }) {
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
    @Test public void emptyTranscriptRetriesOnceAfterCompletionFeedback() throws Exception {
        for (String completion : new String[] { "drained", "playback_failed" }) {
            try (Fixture f = new Fixture(false, false)) {
                NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
                String request = f.recognizing(true);
                String activeId = f.runtime.snapshot().getJSONObject("active").getString("id");
                f.result(request, false, "", false, "empty_transcript");
                Cue failure = f.cue(NativeVoiceCue.Kind.FAILURE);
                f.result(request, false, "", false, "empty_transcript");
                f.result(request, true, "Late result from the completed capture");
                assertTrue("Duplicate results must not play another cue", f.cues.isEmpty());
                if (completion.equals("drained")) f.runtime.drained(failure.id);
                else f.runtime.failed(failure.id, completion);
                f.flush();
                Cue start = f.cue(NativeVoiceCue.Kind.START);
                assertNotEquals(failure.id, start.id);
                assertEquals(activeId, f.runtime.snapshot().getJSONObject("active").getString("id"));
                assertEquals("arming", f.runtime.snapshot().getString("phase"));
                f.runtime.drained(failure.id); f.runtime.failed(failure.id, "playback_failed");
                f.result(request, false, "", false, "empty_transcript");
                f.result(request, true, "Another late result"); f.flush();
                assertTrue("Old callbacks must not restart feedback or another retry", f.cues.isEmpty());
                assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
                assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }
    @Test public void providerNetworkAndTimeoutFailuresDoNotRetry() throws Exception {
        for (String error : new String[] { "recognition_provider_error", "recognition_network_error", "recognition_result_timeout" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.speechFailure(f.recognizing(true), error);
                Cue failure = f.cue(NativeVoiceCue.Kind.FAILURE);
                f.runtime.drained(failure.id); f.flush();
                assertTrue(error, f.runtime.snapshot().isNull("active"));
                assertEquals(error, f.lastError().getString("code"));
                assertTrue(f.cues.isEmpty()); assertEquals(0, f.inputAttempts.get());
                assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }
    @Test public void providerReplacementAndDisconnectCancelPendingEmptyTranscriptRetry() throws Exception {
        for (String interruption : new String[] { "endpoint", "model", "connection" }) {
            try (Fixture f = new Fixture(false, false)) {
                String request = f.recognizing(true);
                f.result(request, false, "", false, "empty_transcript");
                Cue failure = f.cue(NativeVoiceCue.Kind.FAILURE);
                if (interruption.equals("endpoint")) f.settings(NativeVoiceJson.object("speechEndpoint", "http://127.0.0.1:10/v1"));
                else if (interruption.equals("model")) f.settings(NativeVoiceJson.object("sttModel", "replacement-model"));
                else assertNull(f.command("disconnect", new JSONObject()));
                assertTrue("Unrecognized media must be canceled immediately: " + interruption, f.runtime.snapshot().isNull("active"));
                f.runtime.drained(failure.id); f.runtime.failed(failure.id, "playback_failed");
                f.result(request, true, "Late input after disconnect"); f.flush();
                assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.cues.isEmpty());
                assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }
    @Test public void stopOffAndAutomaticSuppressionCancelPendingEmptyTranscriptRetry() throws Exception {
        for (String interruption : new String[] { "stop", "off", "auto_listen", "policy", "stream" }) {
            boolean automatic = !interruption.equals("stop") && !interruption.equals("off");
            try (Fixture f = new Fixture(automatic, false)) {
                String request = f.recognizing(true);
                f.result(request, false, "", false, "empty_transcript");
                Cue failure = f.cue(NativeVoiceCue.Kind.FAILURE);
                switch (interruption) {
                    case "stop": assertNull(f.command("stopCurrentInteraction", new JSONObject())); break;
                    case "off": f.settings(NativeVoiceJson.object("audioMode", "off")); break;
                    case "auto_listen": f.settings(NativeVoiceJson.object("autoListen", false)); break;
                    case "policy": f.policy(true, true); break;
                    case "stream": f.onOwner(() -> f.invoke("streamFailed", new Class<?>[] { String.class }, "stream_closed")); break;
                    default: throw new AssertionError(interruption);
                }
                f.flush(); assertTrue(interruption, f.runtime.snapshot().isNull("active"));
                f.runtime.drained(failure.id); f.runtime.failed(failure.id, "playback_failed");
                f.result(request, true, "Late input after cancellation"); f.flush();
                assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.cues.isEmpty());
                assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
                assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }
    @Test public void focusLossDuringEmptyTranscriptFeedbackCancelsQuietlyWithoutRetry() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String request = f.recognizing(true);
            f.result(request, false, "", false, "empty_transcript");
            Cue failure = f.cue(NativeVoiceCue.Kind.FAILURE);
            f.runtime.failed(failure.id, "audio_focus_lost"); f.flush();
            assertTrue(f.runtime.snapshot().isNull("active"));
            f.runtime.drained(failure.id); f.runtime.failed(failure.id, "audio_focus_lost");
            f.result(request, true, "Late input after focus loss"); f.flush();
            assertTrue(f.cues.isEmpty()); assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
            assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.store.journal(f.binding).length());
        }
    }
    @Test public void focusLossDuringOtherFailureFeedbackPreservesTheOriginalError() throws Exception {
        for (String error : new String[] { "no_usable_speech", "microphone_failed", "audio_focus_unavailable" }) {
            try (Fixture f = new Fixture(false, false)) {
                String request = f.media("capture");
                String expected = error.equals("no_usable_speech") ? "recognition_failed" : error;
                if (error.equals("no_usable_speech")) f.result(request, false, "", false, error);
                else { f.runtime.failed(request, error); f.flush(); }
                Cue failure = f.cue(NativeVoiceCue.Kind.FAILURE);
                assertEquals("The original failure waits for feedback", 0, f.runtime.snapshot().getJSONArray("errors").length());
                f.runtime.failed(failure.id, "audio_focus_lost"); f.flush();
                assertTrue(error, f.runtime.snapshot().isNull("active"));
                assertEquals(expected, f.lastError().getString("code"));
                f.runtime.drained(failure.id); f.runtime.failed(failure.id, "audio_focus_lost");
                f.result(request, true, "Late input after failed recognition"); f.flush();
                assertEquals(1, f.errors(expected)); assertEquals(0, f.errors("audio_focus_lost"));
                assertEquals(1, f.runtime.snapshot().getJSONArray("errors").length());
                assertTrue(f.cues.isEmpty()); assertEquals(0, f.inputAttempts.get());
                assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }
    @Test public void focusLossWhileAwaitingRecognitionResultCancelsQuietly() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String request = f.media("capture");
            f.runtime.captureEnded(request);
            f.flush();
            assertEquals("recognizing", f.runtime.snapshot().getString("phase"));
            assertFalse(f.runtime.snapshot().isNull("active")); assertTrue(f.cues.isEmpty());
            f.runtime.failed(request, "audio_focus_lost"); f.flush();
            assertTrue(f.runtime.snapshot().isNull("active"));
            f.result(request, false, "", false, "empty_transcript");
            f.result(request, true, "Late transcript after focus loss"); f.flush();
            assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.cues.isEmpty());
            assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
            assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.store.journal(f.binding).length());
        }
    }
    @Test public void focusLossDuringAutomaticRetryValidationPreventsCapture() throws Exception {
        for (boolean cuesEnabled : new boolean[] { true, false }) {
            try (Fixture f = new Fixture(false, false)) {
                NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
                String request = f.automaticRecognizing(cuesEnabled);
                Object active = field(f.runtime, "active");
                f.result(request, false, "", false, "empty_transcript");
                String focusOwner = request;
                if (cuesEnabled) {
                    Cue failure = f.cue(NativeVoiceCue.Kind.FAILURE);
                    f.runtime.drained(failure.id); f.flush();
                    Cue start = f.cue(NativeVoiceCue.Kind.START);
                    focusOwner = start.id;
                    f.runtime.drained(start.id); f.flush();
                }
                NativeVoiceHttp.Result validation = f.contexts.poll(10, TimeUnit.SECONDS); assertNotNull(validation);
                assertEquals("validating", f.runtime.snapshot().getString("phase"));
                assertNull(field(active, "captureId")); assertNull(field(active, "cueId"));
                if (cuesEnabled) {
                    f.runtime.failed(request, "audio_focus_lost"); f.flush();
                    assertFalse("The previous capture no longer owns audio focus", f.runtime.snapshot().isNull("active"));
                }
                f.runtime.failed(focusOwner, "audio_focus_lost"); f.flush();
                assertTrue("Held focus loss must cancel pending validation", f.runtime.snapshot().isNull("active"));
                JSONObject context = NativeVoiceJson.object("threadId", f.target, "activityToken", "automatic-retry-epoch",
                    "authority", "current", "runState", "idle", "automaticListenEligible", true,
                    "steer", NativeVoiceJson.object("availability", "unavailable"));
                NativeVoiceProtocol.inputContext(context);
                validation.done(200, context, null); f.flush();
                assertTrue(f.runtime.snapshot().isNull("active"));
                assertNull("A late valid target response must not start another capture", field(active, "captureId"));
                assertTrue(f.cues.isEmpty()); assertTrue(f.contexts.isEmpty());
                assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
                assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }
    @Test public void focusLossDuringSpeechCaptureAndStartCueCancelsQuietly() throws Exception {
        for (String media : new String[] { "speech", "capture", "start_cue" }) {
            try (Fixture f = new Fixture(false, false)) {
                String request = f.media(media);
                f.runtime.failed("stale-" + request, "audio_focus_lost"); f.flush();
                assertFalse("An unrelated focus callback must not cancel current media", f.runtime.snapshot().isNull("active"));
                f.runtime.failed(request, "audio_focus_lost"); f.flush();
                assertTrue(media, f.runtime.snapshot().isNull("active"));
                f.runtime.drained(request); f.runtime.failed(request, "audio_focus_lost");
                f.result(request, true, "Late input after focus loss"); f.flush();
                assertTrue(f.cues.isEmpty()); assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
                assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.store.journal(f.binding).length());
            }
        }
    }
    @Test public void focusLossDuringSuccessfulFeedbackKeepsTheTranscriptOnce() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String request = f.recognizing(true);
            f.result(request, true, "Already recognized before focus changed");
            Cue success = f.cue(NativeVoiceCue.Kind.SUCCESS);
            f.runtime.failed(success.id, "audio_focus_lost"); f.flush();
            assertEquals(1, f.inputAttempts.get());
            assertEquals("Already recognized before focus changed", f.lastRequest.get().getString("text"));
            f.runtime.drained(success.id); f.runtime.failed(success.id, "audio_focus_lost");
            f.result(request, true, "Duplicate transcript"); f.flush();
            assertEquals(1, f.inputAttempts.get()); assertTrue(f.cues.isEmpty());
            assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
        }
    }
    @Test public void unavailableAudioFocusStillReportsTheMediaFailure() throws Exception {
        for (String media : new String[] { "speech", "capture", "start_cue" }) {
            try (Fixture f = new Fixture(false, false)) {
                String request = f.media(media);
                f.runtime.failed(request, "audio_focus_unavailable"); f.flush();
                if (media.equals("capture")) {
                    Cue failure = f.cue(NativeVoiceCue.Kind.FAILURE);
                    f.runtime.drained(failure.id); f.flush();
                }
                assertTrue(media, f.runtime.snapshot().isNull("active"));
                assertEquals("audio_focus_unavailable", f.lastError().getString("code"));
                assertTrue(f.cues.isEmpty()); assertEquals(0, f.inputAttempts.get());
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
    @Test public void providerChangeDuringCompletionCuePreservesTheFinalTranscript() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.result(f.recognizing(true), true, "Already recognized");
            Cue cue = f.cues.poll(10, TimeUnit.SECONDS); assertNotNull(cue);
            f.settings(NativeVoiceJson.object("ttsModel", "replacement-tts"));
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
    @Test public void deliveryModeFreezesBeforeFeedbackAndSurvivesProviderChangeDuringSteerLookup() throws Exception {
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
                    f.settings(NativeVoiceJson.object("ttsModel", "replacement-tts"));
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

    @Test public void defaultHeldIsDurableBeforeManualOrAutomaticMicrophoneReadiness() throws Exception {
        for (boolean automatic : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                if (automatic) f.automaticRecognizing(false, true); else f.recognizing(false, true);
                Object active = field(f.runtime, "active"); String id = (String) field(active, "recordingId");
                assertTrue((boolean) field(active, "adopted")); assertTrue((boolean) field(active, "keepListening"));
                assertFalse((boolean) field(active, "automatic")); assertNull("The transport is not ready, so no mic owner exists", field(f.runtime, "captureOwner"));
                long deadline = (long) field(active, "longDictationDeadline"); assertTrue(deadline > android.os.SystemClock.elapsedRealtime());
                f.onStore(() -> { NativeDictationStore.Recording record = f.dictations.get(f.binding, id); assertTrue(record.adopted); assertTrue(record.keepListening); assertEquals(0, record.acceptedSamples); });
                f.onOwner(() -> {
                    NativeVoiceCapturePolicy policy = (NativeVoiceCapturePolicy) field(active, "capturePolicy");
                    for (int frame = 0; frame < 310; frame++) assertNull("The first silent pause cannot stop held capture", policy.accept(captureFrame(0)));
                    set(f.runtime, "phase", "listening"); f.invoke("publish", new Class<?>[0]);
                });
                assertTrue(f.runtime.snapshot().getJSONObject("actions").getBoolean("canSend"));
                assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
            }
        }
    }

    @Test public void heldStartupCancellationSettlesCreationBeforeRecoveryAndDistinguishesExplicitDiscard() throws Exception {
        for (boolean adoptedBeforeCancellation : new boolean[] { false, true }) {
            for (String action : new String[] { "off", "disconnect", "focus", "cancel" }) {
                try (Fixture f = new Fixture(false, false)) {
                    f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
                    f.settings(NativeVoiceJson.object("keepListeningByDefault", true)); f.holdRecordingPreflight = true;
                    f.onOwner(() -> {
                        Class<?> type = Class.forName("dev.sedes.local.NativeVoiceRuntime$Active");
                        Constructor<?> ctor = type.getDeclaredConstructor(String.class, String.class); ctor.setAccessible(true);
                        Object next = ctor.newInstance(f.target, "Starting held recording"); set(f.runtime, "active", next);
                        f.invoke("beginCapture", new Class<?>[] { type }, next);
                    });
                    NativeSpeechCatalog.PreflightResult preflight = f.preflights.poll(10, TimeUnit.SECONDS); assertNotNull(preflight);
                    Object pending = field(f.runtime, "active"); String id = (String) field(pending, "recordingId");
                    AtomicReference<NativeDictationStore.Recording> restored = new AtomicReference<>();
                    try (WorkerBlock writing = new WorkerBlock(f)) {
                        preflight.done(NativeSpeechCapabilities.hosted("gpt-live-transcribe"), null); f.onOwner(() -> {});
                        assertNotNull(field(pending, "recordingStart"));
                        try (OwnerBlock callbacks = new OwnerBlock(f.owner)) {
                            AsyncCommand cancellation;
                            if (action.equals("off")) cancellation = f.beginCommand("updateSettings", NativeVoiceJson.object("expectedRevision",
                                f.runtime.snapshot().getLong("settingsRevision"), "patch", NativeVoiceJson.object("audioMode", "off")));
                            else if (action.equals("disconnect")) cancellation = f.beginCommand("disconnect", new JSONObject());
                            else if (action.equals("cancel")) cancellation = f.beginCommand("stopCurrentInteraction", NativeVoiceJson.object("interactionId", field(pending, "id")));
                            else {
                                f.runtime.failed((String) field(pending, "captureId"), "audio_focus_lost");
                                cancellation = f.beginCommand("getState", new JSONObject());
                            }
                            if (adoptedBeforeCancellation) {
                                // Disk adoption finishes while the runtime callback is held behind the queued interruption.
                                writing.close(); f.onStore(() -> assertTrue(f.dictations.get(f.binding, id).adopted));
                                try (WorkerBlock cleanup = new WorkerBlock(f)) {
                                    callbacks.close(); assertNull(cancellation.await()); f.onOwner(() -> {});
                                    assertTrue(f.runtime.snapshot().isNull("active"));
                                    if (!action.equals("disconnect")) assertTrue((boolean) field(f.runtime, "dictationOperationPending"));
                                    f.dictations.executor().execute(() -> {
                                        try { restored.set(f.dictations.recover(f.binding)); } catch (Exception error) { throw new AssertionError(error); }
                                    });
                                }
                            } else {
                                callbacks.close(); assertNull(cancellation.await()); f.onOwner(() -> {});
                                assertTrue(f.runtime.snapshot().isNull("active"));
                                // The queued create sees cancellation before writing any draft.
                            }
                        }
                    }
                    f.flush(); assertTrue(f.speech.transcriptions.isEmpty()); assertNull(field(f.runtime, "captureOwner"));
                    if (adoptedBeforeCancellation && !action.equals("cancel")) {
                        assertNotNull("Recovery must run after the durable interruption boundary", restored.get());
                        assertEquals(id, restored.get().id); assertTrue(restored.get().adopted); assertEquals(0, restored.get().endSample);
                        assertEquals(action.equals("off") ? "voice_off" : action.equals("disconnect") ? "connection_changed" : "audio_focus_lost", restored.get().reason);
                        if (!action.equals("disconnect")) assertEquals(id, f.runtime.snapshot().getJSONObject("recordingRecovery").getString("recordingId"));
                    } else {
                        f.onStore(() -> assertNull(f.dictations.recover(f.binding)));
                        assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
                    }
                    assertFalse((boolean) field(f.runtime, "dictationStorageError"));
                    assertFalse((boolean) field(f.runtime, "dictationOperationPending"));
                }
            }
        }
    }

    @Test public void keepListeningPreferenceChangesOnlyFutureCapturesAndPreservesTheLiveOverride() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false, true); Object first = field(f.runtime, "active"); String firstId = (String) field(first, "recordingId");
            f.onOwner(() -> { set(f.runtime, "phase", "listening"); f.invoke("publish", new Class<?>[0]); });
            long deadline = (long) field(first, "longDictationDeadline");
            f.settings(NativeVoiceJson.object("keepListeningByDefault", false));
            assertTrue((boolean) field(first, "keepListening")); assertEquals(deadline, field(first, "longDictationDeadline"));
            assertTrue(((NativeVoiceSettings) field(first, "recordingSettings")).flag("keepListeningByDefault"));
            assertNull(f.command("setKeepListening", NativeVoiceJson.object("recordingId", firstId, "enabled", false)));
            f.settings(NativeVoiceJson.object("keepListeningByDefault", true));
            assertFalse((boolean) field(first, "keepListening")); assertEquals(deadline, field(first, "longDictationDeadline"));
            f.settings(NativeVoiceJson.object("keepListeningByDefault", false));
            assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            for (boolean held : new boolean[] { false, true }) {
                f.settings(NativeVoiceJson.object("keepListeningByDefault", held));
                f.onOwner(() -> {
                    Constructor<?> ctor = first.getClass().getDeclaredConstructor(String.class, String.class); ctor.setAccessible(true);
                    Object next = ctor.newInstance(f.target, "Next recording"); set(f.runtime, "active", next);
                    f.invoke("beginCapture", new Class<?>[] { next.getClass() }, next);
                });
                assertNotNull(f.speech.transcriptions.poll(10, TimeUnit.SECONDS)); f.flush();
                Object next = field(f.runtime, "active"); assertEquals(held, field(next, "keepListening")); assertEquals(held, field(next, "adopted"));
                assertNotEquals(firstId, field(next, "recordingId"));
                assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            }
        }
    }

    @Test public void defaultHeldRefusesAnOccupiedRecoverySlotWithoutStartingNormalCapture() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeDictationStore.Recording saved = f.savedRecording(true, false);
            f.onStore(() -> {
                f.dictations.saveFinalRequest(f.binding, saved.id, NativeVoiceJson.object("mutationId", saved.mutationId, "text", saved.text,
                    "origin", NativeVoiceJson.object("clientId", f.request.getJSONObject("origin").getString("clientId")), "runningPolicy", NativeVoiceJson.object("mode", "queue")));
            });
            AtomicReference<NativeDictationStore.Recording> handedOff = new AtomicReference<>();
            f.onStore(() -> handedOff.set(f.dictations.markHandedOff(f.binding, saved.id)));
            f.onOwner(() -> { set(f.runtime, "retainedDictation", handedOff.get()); f.invoke("publish", new Class<?>[0]); });
            f.settings(NativeVoiceJson.object("keepListeningByDefault", true));
            f.onOwner(() -> {
                Class<?> activeClass = Class.forName("dev.sedes.local.NativeVoiceRuntime$Active");
                Constructor<?> ctor = activeClass.getDeclaredConstructor(String.class, String.class); ctor.setAccessible(true);
                Object next = ctor.newInstance(f.target, "Blocked recording"); set(f.runtime, "active", next);
                f.invoke("beginCapture", new Class<?>[] { activeClass }, next);
            });
            f.flush(); assertTrue(f.runtime.snapshot().isNull("active")); assertNull(field(f.runtime, "captureOwner"));
            assertTrue(f.speech.transcriptions.isEmpty()); assertEquals(1, f.errors("saved_recording_pending"));
            f.onStore(() -> assertEquals(saved.id, f.dictations.get(f.binding, saved.id).id));
        }
    }

    @Test public void keepListeningAdoptsOneRecordingAndNeverResetsItsFirstDeadline() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false);
            f.onOwner(() -> { set(f.runtime, "phase", "listening"); f.invoke("publish", new Class<?>[0]); });
            String recordingId = f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id");
            assertNull(f.command("setKeepListening", NativeVoiceJson.object("recordingId", recordingId, "enabled", true)));
            Object active = field(f.runtime, "active"); long deadline = (long) field(active, "longDictationDeadline");
            assertTrue(deadline > android.os.SystemClock.elapsedRealtime());
            assertFalse((boolean) field(active, "automatic")); assertTrue((boolean) field(active, "adopted"));
            assertTrue(f.runtime.snapshot().getJSONObject("actions").getBoolean("canSend"));
            assertNull(f.command("setKeepListening", NativeVoiceJson.object("recordingId", recordingId, "enabled", false)));
            assertNull(f.command("setKeepListening", NativeVoiceJson.object("recordingId", recordingId, "enabled", true)));
            assertEquals(deadline, field(active, "longDictationDeadline"));
            assertEquals(recordingId, f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id"));
            assertEquals("recording_changed", f.command("sendRecording", NativeVoiceJson.object("recordingId", UUID.randomUUID().toString())));
            assertFalse((boolean) field(active, "captureStopping"));
        }
    }

    @Test public void endpointAcceptedBeforeKeepListeningCannotAdoptOrRetargetTheRecording() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false); Object active = field(f.runtime, "active");
            f.onOwner(() -> {
                set(f.runtime, "phase", "listening");
                synchronized (field(active, "captureLock")) {
                    NativeVoiceCapturePolicy ended = new NativeVoiceCapturePolicy(100, 1000, 100);
                    assertEquals(NativeVoiceCapturePolicy.End.NO_SPEECH, ended.accept(captureFrame(0)));
                    set(active, "capturePolicy", ended); set(active, "endpointReached", true);
                }
                f.invoke("publish", new Class<?>[0]);
            });
            String id = f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id");
            assertEquals("voice_not_listening", f.command("setKeepListening", NativeVoiceJson.object("recordingId", id, "enabled", true)));
            assertEquals("voice_not_listening", f.command("retargetActiveRecognition", NativeVoiceJson.object("recordingId", id,
                "threadId", UUID.randomUUID().toString(), "threadTitle", "Late target")));
            assertFalse((boolean) field(active, "adopted")); assertEquals(0L, field(active, "longDictationDeadline"));
            assertEquals(f.target, field(active, "targetId"));
        }
    }

    @Test public void headsetStopsPreserveAdoptedCaptureAndSendDrainButCancelOrdinaryCapture() throws Exception {
        for (String action : new String[] { "headset", "headset_stop" }) {
            for (String stage : new String[] { "held", "released", "send", "ordinary" }) {
                try (Fixture f = new Fixture(false, false)) {
                    String captureId = f.recognizing(false); Object active = field(f.runtime, "active");
                    f.onOwner(() -> { set(f.runtime, "phase", "listening"); f.invoke("publish", new Class<?>[0]); });
                    String recordingId = f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id");
                    if (!stage.equals("ordinary")) assertNull(f.command("setKeepListening", NativeVoiceJson.object("recordingId", recordingId, "enabled", true)));
                    f.onOwner(() -> assertTrue(((NativeVoiceRecording) field(active, "recording")).accept(captureFrame(1000))));
                    if (stage.equals("released")) assertNull(f.command("setKeepListening", NativeVoiceJson.object("recordingId", recordingId, "enabled", false)));
                    if (stage.equals("send")) {
                        assertNull(f.command("sendRecording", NativeVoiceJson.object("recordingId", recordingId)));
                        f.runtime.captureEnded(captureId); f.flush();
                    }
                    f.runtime.notificationAction(action); f.flush();
                    assertTrue(f.runtime.snapshot().isNull("active")); assertEquals(0, f.inputAttempts.get());
                    if (stage.equals("ordinary")) assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
                    else {
                        JSONObject saved = f.runtime.snapshot().getJSONObject("recordingRecovery");
                        assertEquals(recordingId, saved.getString("recordingId")); assertTrue(saved.getBoolean("hasUnrecognizedAudio"));
                        assertEquals("interrupted", saved.getString("stage"));
                    }
                    f.synthetic.complete("Late result after headset stop"); f.flush(); assertEquals(0, f.inputAttempts.get());
                }
            }
        }
    }

    @Test public void heldTimeoutFinishesRecognitionIntoSavedReadyWithoutSubmitting() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String captureId = f.recognizing(false); Object active = field(f.runtime, "active");
            f.onOwner(() -> { set(f.runtime, "phase", "listening"); f.invoke("publish", new Class<?>[0]); });
            String id = f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id");
            assertNull(f.command("setKeepListening", NativeVoiceJson.object("recordingId", id, "enabled", true)));
            f.onOwner(() -> {
                assertTrue(((NativeVoiceRecording) field(active, "recording")).accept(captureFrame(1000)));
                f.invoke("finishCapture", new Class<?>[] { active.getClass(), NativeVoiceRecording.FinishReason.class }, active, NativeVoiceRecording.FinishReason.TIMEOUT);
            });
            f.runtime.captureEnded(captureId); f.synthetic.ready(); awaitCommit(f, f.synthetic); f.synthetic.complete("Kept after the time limit"); f.flush();
            assertTrue(f.runtime.snapshot().isNull("active")); assertEquals(0, f.inputAttempts.get());
            JSONObject saved = f.runtime.snapshot().getJSONObject("recordingRecovery");
            assertEquals(id, saved.getString("recordingId")); assertEquals("ready", saved.getString("stage"));
            assertTrue(saved.getBoolean("canSend")); assertFalse(saved.getBoolean("hasUnrecognizedAudio"));
            assertFalse("Routine snapshots never carry recognized text", f.runtime.snapshot().toString().contains("Kept after the time limit"));
            assertEquals("recording_revision_conflict", f.command("discardRecording", NativeVoiceJson.object("recordingId", id,
                "expectedRecoveryRevision", saved.getLong("revision") - 1)));
            assertNull(f.command("discardRecording", NativeVoiceJson.object("recordingId", id, "expectedRecoveryRevision", saved.getLong("revision"))));
            assertTrue(f.runtime.snapshot().isNull("recordingRecovery")); assertEquals(0, f.inputAttempts.get());
        }
    }

    @Test public void ownSpeechServerAndSedesDisconnectKeepAdoptedCaptureRunningThroughReconnect() throws Exception {
        try (Fixture f = new Fixture(false, false, true)) {
            String capture = f.recognizing(false); Object active = field(f.runtime, "active");
            f.synthetic.ready(); f.flush();
            f.onOwner(() -> { set(f.runtime, "phase", "listening"); set(f.runtime, "captureOwner", active); f.invoke("publish", new Class<?>[0]); });
            String recordingId = f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id");
            assertNull(f.command("setKeepListening", NativeVoiceJson.object("recordingId", recordingId, "enabled", true)));
            for (int i = 0; i < 15; i++) f.runtime.captured(capture, captureFrame(0));
            f.flush();
            long before = ((NativeVoiceCapturePolicy) field(active, "capturePolicy")).samples();
            f.onOwner(() -> { f.runtime.clientDisconnected(); f.invoke("streamFailed", new Class<?>[] { String.class }, "stream_unavailable"); });
            f.synthetic.listener.failed(f.synthetic.id, null, new NativeSpeechTransport.Failure(NativeSpeechTransport.Kind.NETWORK, "recognition_network_error", 0));
            f.flush();
            JSONObject reconnecting = f.runtime.snapshot();
            assertEquals("listening", reconnecting.getString("phase"));
            assertEquals(recordingId, reconnecting.getJSONObject("active").getJSONObject("recording").getString("id"));
            assertTrue(reconnecting.getJSONObject("active").getJSONObject("recording").getBoolean("reconnecting"));
            assertTrue(reconnecting.getJSONObject("active").getJSONObject("recording").getBoolean("keepListening"));
            for (int i = 0; i < 15; i++) f.runtime.captured(capture, captureFrame(0));
            f.flush();
            assertEquals(before + 15 * 2400, ((NativeVoiceCapturePolicy) field(active, "capturePolicy")).samples());
            assertSame(active, field(f.runtime, "captureOwner")); assertFalse((boolean) field(active, "captureStopping"));
            RecognitionJob retry = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull("Recognition did not reconnect", retry);
            retry.ready(); f.flush();
            f.onOwner(() -> f.runtime.clientRegistered(f.request.getJSONObject("origin").getString("clientId"), "restored-connection-token"));
            JSONObject restored = f.runtime.snapshot();
            assertEquals("listening", restored.getString("phase")); assertEquals(recordingId, restored.getJSONObject("active").getJSONObject("recording").getString("id"));
            assertFalse(restored.getJSONObject("active").getJSONObject("recording").getBoolean("reconnecting"));
            assertTrue(retry.bytes > 0); assertEquals(0, f.inputAttempts.get());
            // A permanent failure must stop safely and publish both its reason and saved audio controls.
            retry.listener.failed(retry.id, null, new NativeSpeechTransport.Failure(NativeSpeechTransport.Kind.AUTHENTICATION, "recognition_authentication_failed", 401));
            f.flush();
            assertTrue(f.runtime.snapshot().isNull("active"));
            JSONObject saved = f.runtime.snapshot().getJSONObject("recordingRecovery");
            assertEquals(recordingId, saved.getString("recordingId")); assertTrue(saved.getBoolean("hasUnrecognizedAudio"));
            assertEquals(NativeVoiceRuntime.message("recognition_authentication_failed"), saved.getString("reason"));
            assertEquals(1, f.errors("recognition_authentication_failed"));
        }
    }

    @Test public void stopDuringRecoveredSendPreservesTheDraftAndReleasesOnlyItsPendingOperation() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeDictationStore.Recording saved = f.savedRecording(true, false);
            AsyncCommand sending;
            try (WorkerBlock blocked = new WorkerBlock(f)) {
                sending = f.beginCommand("sendRecoveredRecording", recoveryArgs(saved, false));
                f.onOwner(() -> {});
                JSONObject state = f.runtime.snapshot();
                assertEquals("admitting", state.getJSONObject("recordingRecovery").getString("stage"));
                assertFalse(state.getJSONObject("actions").getBoolean("canStop"));
                try (WorkerBlock interruptRead = new WorkerBlock(f, false)) {
                    AsyncCommand stop = f.beginCommand("stopCurrentInteraction", NativeVoiceJson.object("interactionId", state.getJSONObject("active").getString("id")));
                    assertNull(stop.await());
                    assertTrue(f.runtime.snapshot().isNull("active"));
                    blocked.close();
                    assertEquals("recording_changed", sending.await());
                    assertTrue("The stale Send callback must not clear the newer interruption operation", (boolean) field(f.runtime, "dictationOperationPending"));
                }
            }
            f.flush();
            assertFalse((boolean) field(f.runtime, "dictationOperationPending"));
            JSONObject restored = f.runtime.snapshot().getJSONObject("recordingRecovery");
            assertEquals(saved.id, restored.getString("recordingId")); assertTrue(restored.getBoolean("canSend"));
            assertEquals(0, f.inputAttempts.get());
            f.onStore(() -> assertEquals("Saved dictated text", f.dictations.get(f.binding, saved.id).text));
        }
    }

    @Test public void notificationCancelDuringRecognitionRetryPreservesSavedAudio() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
            NativeDictationStore.Recording saved = f.savedRecording(false, true);
            assertNull(f.command("retryRecordingRecognition", NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", saved.revision)));
            JSONObject state = f.runtime.snapshot();
            assertEquals("recognizing", state.getJSONObject("recordingRecovery").getString("stage"));
            assertFalse(state.getJSONObject("actions").getBoolean("canStop"));
            f.runtime.notificationAction("stop", state.getLong("connectionGeneration"), state.getJSONObject("active").getString("id"), saved.id);
            f.flush();
            assertTrue(f.runtime.snapshot().isNull("active"));
            JSONObject restored = f.runtime.snapshot().getJSONObject("recordingRecovery");
            assertEquals(saved.id, restored.getString("recordingId")); assertTrue(restored.getBoolean("hasUnrecognizedAudio"));
            assertTrue(restored.getBoolean("canRetryRecognition")); assertEquals(0, f.inputAttempts.get());
            f.onStore(() -> assertTrue(f.dictations.get(f.binding, saved.id).durableSamples > 0));
        }
    }

    @Test public void discardDuringPendingRecoveredSendFencesItsFinishIntentAndNeverPosts() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeDictationStore.Recording saved = f.savedRecording(true, false, false);
            AsyncCommand sending, discarding;
            try (WorkerBlock blocked = new WorkerBlock(f)) {
                sending = f.beginCommand("sendRecoveredRecording", recoveryArgs(saved, false)); f.onOwner(() -> {});
                JSONObject state = f.runtime.snapshot().getJSONObject("recordingRecovery"); assertTrue(state.getBoolean("canDiscard"));
                discarding = f.beginCommand("discardRecording", NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", state.getLong("revision")));
                f.onOwner(() -> {}); assertTrue(f.runtime.snapshot().isNull("active"));
                assertFalse(f.runtime.snapshot().getJSONObject("recordingRecovery").getBoolean("canDiscard"));
            }
            assertEquals("recording_changed", sending.await()); assertNull(discarding.await()); f.flush();
            assertTrue(f.runtime.snapshot().isNull("recordingRecovery")); assertEquals(0, f.store.journal(f.binding).length());
            assertEquals(0, f.inputAttempts.get()); assertFalse((boolean) field(f.runtime, "dictationOperationPending"));
        }
    }

    @Test public void discardFencesARecoveryPreflightThatReturnsAfterItsDraftWasRemoved() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
            NativeDictationStore.Recording saved = f.savedRecording(false, false); f.holdRecordingPreflight = true;
            AsyncCommand retrying = f.beginCommand("retryRecordingRecognition", NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", saved.revision));
            NativeSpeechCatalog.PreflightResult preflight = f.preflights.poll(10, TimeUnit.SECONDS); assertNotNull(preflight);
            f.onOwner(() -> {}); assertTrue(f.runtime.snapshot().getJSONObject("recordingRecovery").getBoolean("canDiscard"));
            assertNull(f.command("discardRecording", NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", saved.revision)));
            preflight.done(NativeSpeechCapabilities.hosted("gpt-live-transcribe"), null);
            assertEquals("recording_changed", retrying.await()); f.flush();
            assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
            assertTrue(f.speech.transcriptions.isEmpty()); assertEquals(0, f.inputAttempts.get());
        }
    }

    @Test public void discardCancelsQueuedRetryResultsAndPreservesTheDraftWhenItsMarkerCannotBeWritten() throws Exception {
        for (boolean failMarker : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
                NativeDictationStore.Recording saved = f.savedRecording(false, false);
                assertNull(f.command("retryRecordingRecognition", NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", saved.revision)));
                RecognitionJob retry = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(retry);
                retry.ready(); awaitCommit(f, retry); f.flush();
                Method directoryMethod = NativeDictationStore.class.getDeclaredMethod("directory", String.class, String.class); directoryMethod.setAccessible(true);
                File directory = (File) directoryMethod.invoke(f.dictations, f.binding, saved.id);
                int mode = Os.stat(directory.getPath()).st_mode & 0777;
                try {
                    if (failMarker) Os.chmod(directory.getPath(), 0500);
                    AsyncCommand discarding;
                    try (WorkerBlock blocked = new WorkerBlock(f)) {
                        retry.complete("Queued stale result");
                        JSONObject current = f.runtime.snapshot().getJSONObject("recordingRecovery"); assertTrue(current.getBoolean("canDiscard"));
                        discarding = f.beginCommand("discardRecording", NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", current.getLong("revision")));
                        f.onOwner(() -> {}); assertTrue(f.runtime.snapshot().isNull("active"));
                    }
                    String failure = discarding.await(); f.flush(); assertTrue(retry.cancelled); assertEquals(0, f.inputAttempts.get());
                    if (failMarker) {
                        assertEquals("dictation_storage_unavailable", failure);
                        JSONObject restored = f.runtime.snapshot().getJSONObject("recordingRecovery");
                        assertEquals("interrupted", restored.getString("stage")); assertTrue(restored.getBoolean("canRetryRecognition")); assertTrue(restored.getBoolean("canDiscard"));
                        f.onStore(() -> { assertEquals("", f.dictations.get(f.binding, saved.id).text); assertEquals(2400, f.dictations.get(f.binding, saved.id).durableSamples); });
                    } else { assertNull(failure); assertTrue(f.runtime.snapshot().isNull("recordingRecovery")); assertFalse(directory.exists()); }
                } finally { if (directory.exists()) Os.chmod(directory.getPath(), mode); }
            }
        }
    }

    @Test public void recoveredPostDiscardIgnoresLateAdmissionAndDoesNotStopANewerOrdinaryInteraction() throws Exception {
        for (boolean newerInteraction : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                NativeDictationStore.Recording saved = f.savedRecording(true, false);
                assertNull(f.command("sendRecoveredRecording", recoveryArgs(saved, false)));
                NativeVoiceHttp.Result post = f.inputs.poll(10, TimeUnit.SECONDS); assertNotNull(post);
                Object[] newer = { null };
                if (newerInteraction) f.onOwner(() -> {
                    Object previous = field(f.runtime, "active"); f.invoke("finishItem", new Class<?>[] { previous.getClass() }, previous);
                    Constructor<?> ctor = previous.getClass().getDeclaredConstructor(String.class, String.class); ctor.setAccessible(true);
                    newer[0] = ctor.newInstance(UUID.randomUUID().toString(), "New target");
                    set(f.runtime, "active", newer[0]); set(f.runtime, "phase", "validating"); f.invoke("publish", new Class<?>[0]);
                });
                JSONObject current = f.runtime.snapshot().getJSONObject("recordingRecovery"); assertTrue(current.getBoolean("canDiscard"));
                assertNull(f.command("discardRecording", NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", current.getLong("revision"))));
                post.done(200, f.receipt("queued"), null); f.flush();
                assertEquals(0, f.store.journal(f.binding).length()); assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
                assertSame(newer[0], field(f.runtime, "active")); assertEquals(1, f.inputAttempts.get()); assertTrue(f.submissions.isEmpty());
            }
        }
    }

    @Test public void successfulRetryHasNoFailureReasonAndLiveSendKeepsItsStopUntilTheSlotIsReleased() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
            NativeDictationStore.Recording saved = f.savedRecording(false, false);
            assertNull(f.command("retryRecordingRecognition", NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", saved.revision)));
            RecognitionJob retry = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(retry);
            retry.ready(); awaitCommit(f, retry); retry.complete("Recognized saved text"); f.flush();
            JSONObject ready = f.runtime.snapshot().getJSONObject("recordingRecovery");
            assertEquals("ready", ready.getString("stage")); assertTrue(ready.isNull("reason"));
        }
        try (Fixture f = new Fixture(false, false)) {
            String capture = f.recognizing(false); Object active = field(f.runtime, "active");
            f.onOwner(() -> { set(f.runtime, "phase", "listening"); f.invoke("publish", new Class<?>[0]); });
            String id = f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id");
            assertNull(f.command("setKeepListening", NativeVoiceJson.object("recordingId", id, "enabled", true)));
            f.onOwner(() -> assertTrue(((NativeVoiceRecording) field(active, "recording")).accept(captureFrame(1000))));
            assertNull(f.command("sendRecording", NativeVoiceJson.object("recordingId", id)));
            f.runtime.captureEnded(capture); f.synthetic.ready(); awaitCommit(f, f.synthetic); f.synthetic.complete("Live dictated input"); f.flush();
            NativeVoiceHttp.Result post = f.inputs.poll(10, TimeUnit.SECONDS); assertNotNull(post);
            JSONObject live = f.runtime.snapshot(); assertEquals("submitting", live.getString("phase"));
            assertTrue(live.isNull("recordingRecovery")); assertTrue(live.getJSONObject("actions").getBoolean("canStop"));
            assertNull(f.command("stopCurrentInteraction", NativeVoiceJson.object("interactionId", live.getJSONObject("active").getString("id"))));
            post.done(0, null, "network_unavailable"); f.flush();
            assertTrue(f.runtime.snapshot().isNull("active"));
            assertEquals(id, f.runtime.snapshot().getJSONObject("recordingRecovery").getString("recordingId"));
        }
    }

    @Test public void incompleteRecoveryRequiresExplicitAcknowledgementBeforeAnySendWork() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeDictationStore.Recording saved = f.savedRecording(true, true);
            assertEquals("recording_incomplete_acknowledgement_required", f.command("sendRecoveredRecording", recoveryArgs(saved, false)));
            assertTrue(f.runtime.snapshot().isNull("active")); assertFalse((boolean) field(f.runtime, "dictationOperationPending"));
            assertEquals(0, f.inputAttempts.get()); assertEquals(saved.revision, f.runtime.snapshot().getJSONObject("recordingRecovery").getLong("revision"));
            assertNull(f.command("sendRecoveredRecording", recoveryArgs(saved, true)));
            assertNotNull(f.inputs.poll(10, TimeUnit.SECONDS)); assertEquals(1, f.inputAttempts.get());
        }
    }

    @Test public void storageRestoreFailureHasAnExplicitRetryAndDoesNotHideOrdinaryRecovery() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.onOwner(() -> { set(f.runtime, "active", null); set(f.runtime, "phase", "idle"); set(f.runtime, "dictationStorageError", true); f.invoke("publish", new Class<?>[0]); });
            JSONObject state = f.runtime.snapshot();
            assertEquals("error", state.getString("phase")); assertEquals("storageUnavailable", state.getString("readiness"));
            assertTrue(state.isNull("recordingRecovery")); assertEquals(1, state.getJSONArray("recovery").length());
            f.onOwner(() -> f.invoke("recoverOutstanding", new Class<?>[0])); f.flush();
            assertTrue(f.receiptReads.get() > 0);
            assertNull(f.command("setConnection", NativeVoiceJson.object("profileId", f.profile, "serverOrigin", f.origin, "identity", Fixture.IDENTITY, "reconnect", true)));
            assertFalse((boolean) field(f.runtime, "dictationStorageError"));
            assertNotEquals("storageUnavailable", f.runtime.snapshot().getString("readiness"));
            assertNotEquals("recordingRecovery", f.runtime.snapshot().getString("phase"));
        }
    }

    @Test public void storageRestoreFailureRejectsBridgeSendAndRetryWhileKeepingSafeRecoveryActions() throws Exception {
        for (boolean complete : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                NativeDictationStore.Recording saved = f.savedRecording(complete, true);
                f.onOwner(() -> { set(f.runtime, "dictationStorageError", true); f.invoke("publish", new Class<?>[0]); });
                JSONObject state = f.runtime.snapshot().getJSONObject("recordingRecovery");
                assertFalse(state.getBoolean("canSend")); assertFalse(state.getBoolean("canRetryRecognition")); assertTrue(state.getBoolean("canDiscard"));
                JSONObject args = complete ? recoveryArgs(saved, true) : NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", saved.revision);
                assertEquals("dictation_storage_unavailable", f.command(complete ? "sendRecoveredRecording" : "retryRecordingRecognition", args));
                assertTrue(f.runtime.snapshot().isNull("active")); assertEquals(0, f.inputAttempts.get());
                assertEquals(0, f.speech.transcriptions.size());
            }
        }
    }

    @Test public void receiptRefreshCannotStealTheFirstSendWhileDurableHandoffIsPending() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeDictationStore.Recording saved = f.savedRecording(true, false);
            AtomicReference<WorkerBlock> blocked = new AtomicReference<>();
            f.onOwner(() -> {
                Constructor<?> constructor = Class.forName("dev.sedes.local.NativeVoiceRuntime$Active").getDeclaredConstructor(String.class, String.class);
                constructor.setAccessible(true); Object active = constructor.newInstance(f.target, "Target");
                set(active, "recordingId", saved.id); set(active, "recordingBinding", f.binding); set(active, "record", saved);
                set(active, "adopted", true); set(active, "recoverySend", true); set(active, "mutationId", f.mutation);
                set(f.runtime, "active", active); set(f.runtime, "phase", "submitting"); f.invoke("publish", new Class<?>[0]);
                f.invoke("prepareAdmission", new Class<?>[] { active.getClass(), String.class, String.class, String.class, JSONObject.class },
                    active, f.target, saved.text, f.request.getJSONObject("origin").getString("clientId"), NativeVoiceJson.object("mode", "queue"));
                blocked.set(new WorkerBlock(f));
            });
            try (WorkerBlock held = blocked.get()) {
                f.onOwner(() -> {});
                assertNotNull(f.store.entry(f.binding, f.mutation));
                f.onOwner(() -> f.invoke("recoverOutstanding", new Class<?>[0]));
                assertEquals(0, f.receiptReads.get()); assertEquals(0, f.inputAttempts.get());
                assertFalse(f.runtime.snapshot().isNull("active"));
            }
            f.flush(); assertNotNull(f.inputs.poll(10, TimeUnit.SECONDS)); assertEquals(1, f.inputAttempts.get());
            assertEquals(0, f.errors("input_outcome_uncertain"));
        }
    }

    @Test public void ordinaryRecordingSpoolIsRemovedAsSoonAsItsRequestBelongsToTheInputJournal() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            String capture = f.recognizing(false);
            String id = f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id");
            f.result(capture, true, "Ordinary journal owned input");
            NativeVoiceHttp.Result post = f.inputs.poll(10, TimeUnit.SECONDS); assertNotNull(post); f.flush();
            assertEquals(1, f.store.journal(f.binding).length());
            f.onStore(() -> {
                Method directory = NativeDictationStore.class.getDeclaredMethod("directory", String.class, String.class); directory.setAccessible(true);
                assertFalse(((File) directory.invoke(f.dictations, f.binding, id)).exists());
            });
            post.done(0, null, "network_unavailable"); f.flush();
            assertTrue(f.runtime.snapshot().isNull("active")); assertEquals(1, f.store.journal(f.binding).length());
        }
    }

    private static JSONObject recoveryArgs(NativeDictationStore.Recording record, boolean acknowledgeIncomplete) {
        return NativeVoiceJson.object("recordingId", record.id, "expectedRecoveryRevision", record.revision, "acknowledgeIncomplete", acknowledgeIncomplete);
    }
    private static final class AsyncCommand implements NativeVoiceRuntime.Reply {
        final CountDownLatch done = new CountDownLatch(1); volatile String error;
        public void done(JSONObject state) { done.countDown(); }
        public void failed(String code, String message) { error = code; done.countDown(); }
        String await() throws Exception { assertTrue(done.await(10, TimeUnit.SECONDS)); return error; }
    }
    private static final class WorkerBlock implements AutoCloseable {
        final CountDownLatch release = new CountDownLatch(1);
        WorkerBlock(Fixture f) throws Exception { this(f, true); }
        WorkerBlock(Fixture f, boolean awaitEntry) throws Exception {
            CountDownLatch entered = new CountDownLatch(1);
            f.dictations.executor().execute(() -> {
                entered.countDown();
                try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            });
            if (awaitEntry) assertTrue(entered.await(10, TimeUnit.SECONDS));
        }
        public void close() { release.countDown(); }
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
            assertEquals(f.externalRequest().toString(), f.lastRequest.get().toString());
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
    /** Deterministically changes ownership after admission but before its queued UI callback can run. */
    private static final class MainBlock implements AutoCloseable {
        final CountDownLatch release = new CountDownLatch(1);
        MainBlock() throws Exception {
            CountDownLatch entered = new CountDownLatch(1);
            new Handler(Looper.getMainLooper()).post(() -> {
                entered.countDown();
                try { release.await(10, TimeUnit.SECONDS); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            });
            assertTrue(entered.await(10, TimeUnit.SECONDS));
        }
        public void close() { release.countDown(); }
    }
    /** Holds startup callbacks so an already queued interruption wins after durable adoption. */
    private static final class OwnerBlock implements AutoCloseable {
        final CountDownLatch release = new CountDownLatch(1);
        OwnerBlock(Handler owner) throws Exception {
            CountDownLatch entered = new CountDownLatch(1);
            owner.post(() -> {
                entered.countDown();
                try { release.await(10, TimeUnit.SECONDS); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            });
            assertTrue(entered.await(10, TimeUnit.SECONDS));
        }
        public void close() { release.countDown(); }
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
        final AtomicReference<JSONObject> receiptResponse = new AtomicReference<>(NativeVoiceJson.object("status", "notObserved"));
        final BlockingQueue<NativeVoiceHttp.Result> inputs = new LinkedBlockingQueue<>(), sessions = new LinkedBlockingQueue<>(), contexts = new LinkedBlockingQueue<>();
        final BlockingQueue<Cue> cues = new LinkedBlockingQueue<>();
        final BlockingQueue<JSONObject> submissions = new LinkedBlockingQueue<>();
        final NativeVoiceRuntime.Observer submissionObserver = (name, value) -> {
            if (name.equals("inputSubmitted")) submissions.add(NativeVoiceJson.copy(value));
        };
        final NativeVoiceRuntime runtime;
        final SpeechFake speech = new SpeechFake();
        final NativeVoiceStore store;
        final NativeDictationStore dictations;
        final Handler owner;
        RecognitionJob synthetic;
        volatile boolean holdRecordingPreflight;
        final BlockingQueue<NativeSpeechCatalog.PreflightResult> preflights = new LinkedBlockingQueue<>();

        Fixture(boolean automatic, boolean retargeted) throws Exception { this(automatic, retargeted, false); }
        Fixture(boolean automatic, boolean retargeted, boolean ownSpeechServer) throws Exception { this(automatic, retargeted, ownSpeechServer, null); }
        Fixture(boolean automatic, boolean retargeted, boolean ownSpeechServer, String exactText) throws Exception {
            if (exactText != null) { NativeVoiceJson.put(request, "text", exactText); NativeVoiceJson.put(entry, "request", request); }
            runtime = new NativeVoiceRuntime(context, new NativeVoiceRuntime.RecordingBackend() {
                public okhttp3.Call preflight(NativeVoiceSettings settings, String credential, NativeSpeechCatalog.PreflightResult result) {
                    if (holdRecordingPreflight) { preflights.add(result); return null; }
                    NativeSpeechCapabilities capabilities = ownSpeechServer ? NativeSpeechCapabilities.server(settings.text("sttModel"), NativeVoiceJson.object(
                        "max_buffer_bytes", 2880000, "max_message_bytes", 1048576, "max_output_bytes", 1048576,
                        "idle_timeout_seconds", 60, "max_session_seconds", 3600)) : NativeSpeechCapabilities.hosted("gpt-live-transcribe");
                    result.done(capabilities, null); return null;
                }
                public NativeSpeechTransport open(NativeSpeechTransport.Config config) { return speech; }
            });
            speech.runtime = runtime;
            owner = (Handler) field(runtime, "handler"); store = (NativeVoiceStore) field(runtime, "store");
            dictations = (NativeDictationStore) field(runtime, "dictations");
            NativeVoiceHttp.setTestTransport(new NativeVoiceHttp.TestTransport() {
                public boolean before(String method, String path, JSONObject body, NativeVoiceHttp.Result result) {
                    if (method.equals("POST") && path.endsWith("/inputs")) {
                        inputAttempts.incrementAndGet(); lastRequest.set(NativeVoiceJson.copy(body)); inputs.add(result);
                    } else if (path.equals("/api/application/session")) { sessionReads.incrementAndGet(); sessions.add(result); }
                    else if (path.equals("/api/client-registration")) result.done(200, NativeVoiceJson.object("clientId", request.optJSONObject("origin").optString("clientId"),
                        "connectionToken", "runtime-registered-connection-token", "resumeToken", "runtime-registered-resume-token-value"), null);
                    else if (path.equals("/api/client-controls/poll")) { /* Retain the idle control poll. */ }
                    else if (path.endsWith("/input-context")) contexts.add(result);
                    else if (path.startsWith("/api/input-receipts/")) {
                        receiptReads.incrementAndGet(); result.done(200, NativeVoiceJson.copy(receiptResponse.get()), null);
                    } else throw new AssertionError("Unexpected native request: " + method + " " + path);
                    return true;
                }
                public boolean after(String method, String path, JSONObject body, int status, JSONObject response, NativeVoiceHttp.Result result) { return false; }
            });
            onOwner(() -> {
                set(runtime, "profileId", profile); set(runtime, "origin", origin); set(runtime, "identity", IDENTITY);
                set(runtime, "binding", binding); set(runtime, "csrf", "expired-test-token");
                set(runtime, "originId", request.getJSONObject("origin").getString("clientId"));
                set(runtime, "clientConnectionToken", "runtime-registered-connection-token");
                set(field(runtime, "clientControls"), "origin", origin);
                Class<?> activeClass = Class.forName("dev.sedes.local.NativeVoiceRuntime$Active");
                Constructor<?> activeConstructor = activeClass.getDeclaredConstructor(String.class, String.class);
                activeConstructor.setAccessible(true); Object active = activeConstructor.newInstance(target, "Target");
                set(active, "automatic", automatic); set(runtime, "active", active);
                if (retargeted) {
                    set(runtime, "phase", "listening");
                    set(active, "targetTitle", "Retargeted"); set(active, "automatic", false);
                }
                set(active, "admission", entry); set(runtime, "phase", "submitting"); store.saveEntry(binding, entry);
            });
            runtime.observe(submissionObserver);
        }
        AsyncCommand beginCommand(String action, JSONObject args) {
            AsyncCommand reply = new AsyncCommand(); runtime.command(action, args, true, reply); return reply;
        }
        void onStore(Action action) throws Exception {
            CountDownLatch done = new CountDownLatch(1); AtomicReference<Throwable> failure = new AtomicReference<>();
            dictations.executor().execute(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } finally { done.countDown(); } });
            assertTrue(done.await(10, TimeUnit.SECONDS)); if (failure.get() != null) throw new AssertionError(failure.get());
        }
        NativeDictationStore.Recording savedRecording(boolean complete, boolean incomplete) throws Exception { return savedRecording(complete, incomplete, true); }
        NativeDictationStore.Recording savedRecording(boolean complete, boolean incomplete, boolean withIntent) throws Exception {
            AtomicReference<NativeDictationStore.Recording> saved = new AtomicReference<>();
            NativeVoiceSettings configured = NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("audioMode", "manual", "speechProvider", "server",
                "speechEndpoint", "http://127.0.0.1:9/v1", "recognitionCues", false));
            Method configMethod = NativeVoiceRuntime.class.getDeclaredMethod("recordingConfig", NativeVoiceSettings.class); configMethod.setAccessible(true);
            JSONObject config = (JSONObject) configMethod.invoke(null, configured);
            onOwner(() -> {
                store.removeEntry(binding, mutation); set(runtime, "active", null); set(runtime, "sessionStarted", true);
                set(runtime, "settings", configured); set(runtime, "speechCredential", "fixture-speech-token"); set(runtime, "speech", speech);
            });
            onStore(() -> {
                String id = UUID.randomUUID().toString(); NativeDictationStore.Journal journal = dictations.create(binding, id, target, "Saved target", config);
                journal.adopt(true); journal.append(0, captureFrame(1000)); journal.checkpoint(); journal.seal(0, 0, 2400, 0);
                if (complete) journal.complete(0, "Saved dictated text");
                if (incomplete) journal.interrupt("recording_interrupted"); else journal.finish("timeout", 2400);
                saved.set(withIntent ? dictations.finishIntent(binding, id, mutation, NativeVoiceJson.object("mode", "queue", "originClientId", request.getJSONObject("origin").getString("clientId"))) : journal.load());
            });
            onOwner(() -> { set(runtime, "retainedDictation", saved.get()); set(runtime, "phase", "idle"); invoke("publish", new Class<?>[0]); });
            return saved.get();
        }
        JSONObject externalRequest() { JSONObject body = NativeVoiceJson.copy(request); body.remove("origin"); return body; }
        void foreground(String threadId) throws Exception {
            runtime.nativeVisibility(true);
            assertNull(command("setForegroundContext", NativeVoiceJson.object("visible", true, "threadId", threadId)));
        }
        NativeVoiceHttp.Result start() throws Exception {
            onOwner(() -> invoke("submit", new Class<?>[] { String.class, String.class, String.class, JSONObject.class, boolean.class }, binding, origin, null, entry, false));
            NativeVoiceHttp.Result result = inputs.poll(10, TimeUnit.SECONDS); assertNotNull(result); return result;
        }
        String recognizing(boolean cuesEnabled) throws Exception { return recognizing(cuesEnabled, false); }
        String recognizing(boolean cuesEnabled, boolean defaultHeld) throws Exception {
            NativeVoiceAudio.setTestCuePlayer((id, kind, gain) -> cues.add(new Cue(id, kind, gain)));
            onOwner(() -> {
                store.removeEntry(binding, mutation);
                Object active = field(runtime, "active"); set(active, "admission", null);
                set(runtime, "originId", UUID.randomUUID().toString()); set(runtime, "sessionStarted", true);
                set(runtime, "settings", NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object(
                    "audioMode", "manual", "speechProvider", "server", "speechEndpoint", "http://127.0.0.1:9/v1",
                    "recognitionCues", cuesEnabled, "cueGain", 45, "keepListeningByDefault", defaultHeld)));
                set(runtime, "speechCredential", "fixture-speech-token"); set(runtime, "speech", speech);
                invoke("beginCapture", new Class<?>[] { Class.forName("dev.sedes.local.NativeVoiceRuntime$Active") }, active);
            });
            synthetic = speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(synthetic);
            onOwner(() -> { set(runtime, "phase", "recognizing"); set(field(runtime, "active"), "lastAudioId", synthetic.captureId); invoke("publish", new Class<?>[0]); });
            return synthetic.captureId;
        }
        String automaticRecognizing(boolean cuesEnabled) throws Exception { return automaticRecognizing(cuesEnabled, false); }
        String automaticRecognizing(boolean cuesEnabled, boolean defaultHeld) throws Exception {
            String request = recognizing(cuesEnabled);
            settings(NativeVoiceJson.object("keepListeningByDefault", defaultHeld));
            policy(true, false, "speakThenListen");
            onOwner(() -> {
                NativeVoiceSettings settings = (NativeVoiceSettings) field(runtime, "settings");
                String id = UUID.randomUUID().toString();
                NativeVoiceQueue.Item notification = new NativeVoiceQueue.Item(NativeVoiceJson.object(
                    "sourceEventId", id, "generation", 1, "voice", "speakThenListen",
                    "recognitionTarget", NativeVoiceJson.object("threadId", target, "activityToken", "automatic-retry-epoch"),
                    "payload", NativeVoiceJson.object("schemaVersion", 4, "notificationId", id, "event", "turn.completed",
                        "occurredAt", "2026-10-04T00:00:00Z", "title", "Completed", "message", "Ready for a reply",
                        "thread", NativeVoiceJson.object("id", target, "title", "Target"))), settings);
                Constructor<?> constructor = Class.forName("dev.sedes.local.NativeVoiceRuntime$Active")
                    .getDeclaredConstructor(NativeVoiceQueue.Item.class, int.class);
                constructor.setAccessible(true);
                Object active = constructor.newInstance(notification, settings.number("speechTextLimit"));
                // Begin after the earlier capture; subsequent audio ownership comes from the real retry path.
                Object previous = field(runtime, "active");
                ((NativeVoiceRecording) field(previous, "recording")).discard();
                set(runtime, "active", active);
                invoke("beginCapture", new Class<?>[] { active.getClass() }, active);
            });
            synthetic = speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(synthetic);
            onOwner(() -> { set(runtime, "phase", "recognizing"); set(field(runtime, "active"), "lastAudioId", synthetic.captureId); invoke("publish", new Class<?>[0]); });
            return synthetic.captureId;
        }
        void result(String request, boolean success, String text) throws Exception {
            result(request, success, text, false, "");
        }
        void result(String request, boolean success, String text, boolean canceled, String error) throws Exception {
            AtomicReference<Object> pending = new AtomicReference<>();
            onOwner(() -> {
                Object active = field(runtime, "active");
                if (active != null && request.equals(field(active, "captureId"))) pending.set(active);
            });
            if (pending.get() == null) return;
            if (success || (!canceled && error.equals("empty_transcript"))) {
                onOwner(() -> {
                    Object active = pending.get(); NativeVoiceRecording recording = (NativeVoiceRecording) field(active, "recording");
                    if (!(boolean) field(active, "captureStopping")) {
                        assertTrue(recording.accept(captureFrame(1000)));
                        set(active, "endpoint", NativeVoiceCapturePolicy.End.SILENCE);
                        invoke("finishCapture", new Class<?>[] { active.getClass(), NativeVoiceRecording.FinishReason.class }, active, NativeVoiceRecording.FinishReason.AUTOMATIC);
                    }
                });
                runtime.captureEnded(request); synthetic.ready(); awaitCommit(this, synthetic); synthetic.complete(text);
            } else speechFailure(request, "recognition_failed");
            flush();
        }
        void speechFailure(String request, String code) throws Exception {
            onOwner(() -> invoke("speechFailed", new Class<?>[] { String.class, String.class }, request, code)); flush();
        }
        Object invokeResult(String name) throws Exception {
            AtomicReference<Object> result = new AtomicReference<>();
            onOwner(() -> { Method method = NativeVoiceRuntime.class.getDeclaredMethod(name); method.setAccessible(true); result.set(method.invoke(runtime)); });
            return result.get();
        }
        Cue cue(NativeVoiceCue.Kind kind) throws Exception {
            Cue cue = cues.poll(10, TimeUnit.SECONDS); assertNotNull("Expected " + kind + " cue", cue);
            assertEquals(kind, cue.kind); return cue;
        }
        void settings(JSONObject patch) throws Exception {
            assertNull(command("updateSettings", NativeVoiceJson.object("expectedRevision", runtime.snapshot().getLong("settingsRevision"), "patch", patch)));
        }
        String media(String kind) throws Exception {
            String request = recognizing(true);
            onOwner(() -> {
                Object active = field(runtime, "active");
                switch (kind) {
                    case "speech": ((NativeVoiceRecording) field(active, "recording")).discard(); set(active, "recording", null); set(active, "recordingId", null); set(active, "captureId", null); set(active, "ttsId", request); set(runtime, "phase", "speaking"); break;
                    case "capture":
                        NativeVoiceCapturePolicy policy = new NativeVoiceCapturePolicy(30000, 60000, 1200);
                        policy.accept(captureFrame(1000)); set(active, "capturePolicy", policy);
                        ((NativeVoiceRecording) field(active, "recording")).accept(captureFrame(1000));
                        set(runtime, "phase", "listening"); break;
                    case "start_cue": ((NativeVoiceRecording) field(active, "recording")).discard(); set(active, "recording", null); set(active, "recordingId", null); set(active, "captureId", null); set(active, "cueId", request); set(runtime, "phase", "arming"); break;
                    default: throw new AssertionError(kind);
                }
                invoke("publish", new Class<?>[0]);
            });
            return request;
        }
        void policy(boolean enabled, boolean silenced) throws Exception {
            policy(enabled, silenced, "none");
        }
        void policy(boolean enabled, boolean silenced, String completionVoice) throws Exception {
            JSONObject delivery = new JSONObject();
            for (String event : NativeVoiceProtocol.EVENTS) NativeVoiceJson.put(delivery, event,
                NativeVoiceJson.object("script", false, "voice", event.equals("turn.completed") ? completionVoice : "none"));
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
        JSONObject submissionReceipt(String mode, String status) {
            JSONObject result = receipt(status);
            NativeVoiceJson.put(result, "admittedMode", mode); NativeVoiceJson.put(result, "currentMode", mode);
            return result;
        }
        String command(String action, JSONObject args) throws Exception {
            JSONObject active = runtime.snapshot().optJSONObject("active"), recording = active == null ? null : active.optJSONObject("recording");
            if (action.equals("stopCurrentInteraction") && !args.has("interactionId")) NativeVoiceJson.put(args, "interactionId", active == null ? UUID.randomUUID().toString() : active.optString("id"));
            if (action.equals("retargetActiveRecognition") && !args.has("recordingId")) NativeVoiceJson.put(args, "recordingId", recording == null ? UUID.randomUUID().toString() : recording.optString("id"));
            CountDownLatch done = new CountDownLatch(1); AtomicReference<String> error = new AtomicReference<>();
            runtime.command(action, args, true, new NativeVoiceRuntime.Reply() {
                public void done(JSONObject state) { done.countDown(); }
                public void failed(String code, String message) { error.set(code); done.countDown(); }
            });
            assertTrue(done.await(10, TimeUnit.SECONDS)); flush(); return error.get();
        }
        String credentialAction(String action, String secret, long generation, long revision) throws Exception {
            CountDownLatch done = new CountDownLatch(1); AtomicReference<String> error = new AtomicReference<>();
            runtime.speechCredentialAction(generation, revision, action, secret, new NativeVoiceRuntime.Reply() {
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
        void flush() throws Exception {
            // The actor and journal worker post to each other; drain both boundaries until admission callbacks settle.
            for (int pass = 0; pass < 8; pass++) {
                onOwner(() -> {});
                CountDownLatch written = new CountDownLatch(1); dictations.executor().execute(written::countDown);
                assertTrue(written.await(10, TimeUnit.SECONDS));
            }
            onOwner(() -> {});
        }
        void flushEvents() throws Exception {
            flush(); InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {});
            flush(); InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {});
        }
        void onOwner(Action action) throws Exception {
            CountDownLatch done = new CountDownLatch(1); AtomicReference<Throwable> error = new AtomicReference<>();
            owner.post(() -> { try { action.run(); } catch (Throwable failure) { error.set(failure); } finally { done.countDown(); } });
            assertTrue("Native owner did not finish", done.await(10, TimeUnit.SECONDS));
            if (error.get() != null) throw new AssertionError("Native owner failed", error.get());
        }
        void invoke(String name, Class<?>[] types, Object... args) throws Exception {
            if (name.equals("beginCapture") && args.length == 1) {
                NativeVoiceRecording previous = (NativeVoiceRecording) field(args[0], "recording");
                if (previous != null) previous.discard();
            }
            Method method = NativeVoiceRuntime.class.getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(runtime, args);
        }
        public void close() throws Exception {
            runtime.unobserve(submissionObserver);
            try { onOwner(() -> {
                Object active = field(runtime, "active");
                NativeVoiceRecording recording = active == null ? null : (NativeVoiceRecording) field(active, "recording");
                if (recording != null) recording.discard();
                set(runtime, "active", null); invoke("disconnect", new Class<?>[] { boolean.class }, false);
            }); }
            finally {
                NativeVoiceHttp.setTestTransport(null); NativeVoiceAudio.setTestCuePlayer(null); NativeVoiceAudio.setTestSource(null); owner.getLooper().quitSafely();
                CountDownLatch cleaned = new CountDownLatch(1);
                dictations.executor().execute(() -> { try { dictations.removeProfile(profile); } catch (Exception error) { throw new RuntimeException(error); } finally { cleaned.countDown(); } });
                assertTrue(cleaned.await(10, TimeUnit.SECONDS)); dictations.close();
                store.removeProfile(profile); new SpeechCredentialStore(context).removeProfileCredentials(profile);
                assertFalse(store.directory(binding).exists());
            }
        }
    }
    private static final class SpeechFake extends NativeSpeechTransport {
        final BlockingQueue<SpeechJob> speechRequests = new LinkedBlockingQueue<>();
        final BlockingQueue<RecognitionJob> transcriptions = new LinkedBlockingQueue<>();
        NativeVoiceRuntime runtime;
        SpeechFake() { super(new Config("http://127.0.0.1:9/v1", null, "fixture-stt", "fixture-tts", "fixture-voice", 1), android.os.SystemClock::elapsedRealtime); }
        @Override Request speak(String id, String text, SpeechListener listener) {
            SpeechJob job = new SpeechJob(id, text, listener); speechRequests.add(job); return job;
        }
        @Override RecognitionSession openRecognition(String id, NativeSpeechCapabilities capabilities, long timeout, RecognitionListener listener) {
            RecognitionJob job = new RecognitionJob(id, listener); job.resultTimeout = timeout;
            try { job.captureId = (String) field(field(runtime, "active"), "captureId"); }
            catch (Exception error) { throw new AssertionError(error); }
            transcriptions.add(job); return job;
        }
        @Override public void close() { /* Each fake job has its own cancellation flag. */ }
    }
    /** Holds real discovery responses so settings edits can race a live OkHttp callback deterministically. */
    private static final class CatalogPeer implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        final BlockingQueue<CountDownLatch> responses = new LinkedBlockingQueue<>();
        final java.util.concurrent.CopyOnWriteArrayList<CountDownLatch> holds = new java.util.concurrent.CopyOnWriteArrayList<>();
        final AtomicInteger requests = new AtomicInteger();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        volatile Socket active;
        volatile int status = 200;
        volatile boolean malformed;
        CatalogPeer(String expectedCredential) throws Exception {
            Thread thread = new Thread(() -> {
                while (!server.isClosed()) {
                    try (Socket socket = server.accept()) {
                        active = socket; socket.setSoTimeout(10000);
                        BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                        assertEquals("GET /v1/audio/capabilities HTTP/1.1", input.readLine());
                        boolean authorized = false;
                        for (String line = input.readLine(); line != null && !line.isEmpty(); line = input.readLine())
                            if (line.equals("Authorization: Bearer " + expectedCredential)) authorized = true;
                        assertTrue("Discovery request omitted its stored credential", authorized);
                        CountDownLatch release = new CountDownLatch(1); holds.add(release); requests.incrementAndGet(); responses.add(release);
                        if (!release.await(15, TimeUnit.SECONDS)) throw new AssertionError("Discovery response was never released");
                        JSONObject listing = NativeVoiceJson.object("object", "list", "data", new JSONArray()
                            .put(NativeVoiceJson.object("id", "fixture-stt", "task", "transcription", "realtime", NativeSpeechCapabilities.hosted("gpt-live-transcribe").realtime()))
                            .put(NativeVoiceJson.object("id", "gpt-4o-mini-tts", "task", "speech", "voices", new JSONArray().put(NativeVoiceJson.object("id", "first-voice"))))
                            .put(NativeVoiceJson.object("id", "second-tts", "task", "speech", "voices", new JSONArray().put(NativeVoiceJson.object("id", "second-voice")))));
                        byte[] body = (malformed ? "{}" : listing.toString()).getBytes(StandardCharsets.UTF_8);
                        socket.getOutputStream().write(("HTTP/1.1 " + status + " Response\r\nContent-Type: application/json\r\nContent-Length: " + body.length +
                            "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                        socket.getOutputStream().write(body); socket.getOutputStream().flush();
                    } catch (Throwable error) { if (!server.isClosed()) { failure.set(error); break; } }
                    finally { active = null; }
                }
            }, "speech-catalog-runtime-test");
            thread.setDaemon(true); thread.start();
        }
        String endpoint() { return "http://127.0.0.1:" + server.getLocalPort() + "/v1"; }
        CountDownLatch next() throws Exception {
            CountDownLatch response = responses.poll(10, TimeUnit.SECONDS);
            if (failure.get() != null) throw new AssertionError("Discovery fixture failed", failure.get());
            assertNotNull("Expected a model discovery request", response); return response;
        }
        void assertNoFurtherRequests(int expectedCount) throws Exception {
            assertNull("Unexpected additional discovery request", responses.poll(250, TimeUnit.MILLISECONDS));
            if (failure.get() != null) throw new AssertionError("Unexpected discovery traffic", failure.get());
            assertEquals(expectedCount, requests.get());
        }
        public void close() throws Exception {
            server.close();
            for (CountDownLatch hold : holds) hold.countDown();
            Socket socket = active; if (socket != null) socket.close();
        }
    }
    private static final class SpeechJob implements NativeSpeechTransport.Request {
        final String id, text;
        final NativeSpeechTransport.SpeechListener listener;
        boolean cancelled;
        SpeechJob(String id, String text, NativeSpeechTransport.SpeechListener listener) { this.id = id; this.text = text; this.listener = listener; }
        public void cancel() { cancelled = true; }
    }
    private static final class RecognitionJob implements NativeSpeechTransport.RecognitionSession {
        final String id;
        String captureId;
        final NativeSpeechTransport.RecognitionListener listener;
        volatile boolean cancelled;
        volatile int commits, bytes;
        volatile String attemptId, itemId;
        long resultTimeout;
        RecognitionJob(String id, NativeSpeechTransport.RecognitionListener listener) { this.id = id; this.listener = listener; }
        public NativeSpeechTransport.SendResult append(String attemptId, byte[] pcm) {
            this.attemptId = attemptId; bytes += pcm.length; return NativeSpeechTransport.SendResult.ACCEPTED;
        }
        public NativeSpeechTransport.SendResult commit(String attemptId) {
            this.attemptId = attemptId; itemId = "item-" + commits; commits++;
            listener.committed(id, attemptId, itemId); return NativeSpeechTransport.SendResult.ACCEPTED;
        }
        public void cancel() { cancelled = true; }
        public boolean ended() { return cancelled; }
        public long deadlineMs() { return android.os.SystemClock.elapsedRealtime() + 3600000; }
        public boolean canAssign(long durationMs) { return !cancelled; }
        void ready() { listener.ready(id, deadlineMs()); }
        void complete(String text) { listener.completed(id, attemptId, itemId, text); }
    }
    private static byte[] captureFrame(int amplitude) {
        byte[] bytes = new byte[4800];
        for (int i = 0; i < bytes.length; i += 2) { bytes[i] = (byte) amplitude; bytes[i + 1] = (byte) (amplitude >> 8); }
        return bytes;
    }
    private static void discover(Fixture fixture, CatalogPeer peer) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<String> error = new AtomicReference<>();
        fixture.runtime.command("refreshSpeechCatalog", NativeVoiceJson.object("force", true), false, new NativeVoiceRuntime.Reply() {
            public void done(JSONObject value) { done.countDown(); }
            public void failed(String code, String message) { error.set(code); done.countDown(); }
        });
        CountDownLatch response = peer.next();
        assertTrue("Refresh must return while metadata is loading", done.await(1, TimeUnit.SECONDS)); assertNull(error.get());
        response.countDown(); awaitCatalog(fixture);
    }
    private static void awaitCatalog(Fixture fixture) throws Exception {
        awaitCatalogStatus(fixture, "ready");
    }
    private static void awaitCatalogStatus(Fixture fixture, String expected) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
        while (fixture.runtime.snapshot().getJSONObject("speech").getString("catalogStatus").equals("loading") &&
            android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(10);
        fixture.flush(); assertEquals(expected, fixture.runtime.snapshot().getJSONObject("speech").getString("catalogStatus"));
    }
    private static void awaitCommit(Fixture fixture, RecognitionJob request) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
        while (request.commits == 0 && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(10);
        fixture.flush(); assertEquals("Local capture never committed: " + fixture.runtime.snapshot(), 1, request.commits);
    }
    private static Object field(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target);
    }
    private static String hash(String text) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
}
