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
            String[] actions = { "updateSettings", "startManualListen", "setNextRecordingTarget", "retargetActiveRecognition", "skipCurrentPlayback",
                "stopCurrentInteraction", "resumeInput", "discardInput", "disconnect", "setForegroundContext", "speakReply" };
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

    @Test public void appSelectionStaysIndependentOfHeadsetAndNotificationDefaultStarts() throws Exception {
        for (boolean pinned : new boolean[] { false, true }) for (String source : new String[] { "app", "headset", "start" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
                f.settings(NativeVoiceJson.object("pinDefaultVoiceThread", pinned, "voiceThreadId", f.target, "voiceThreadTitle", "Pinned default"));
                String other = UUID.randomUUID().toString(); f.foreground(other);
                assertNull(f.command("setNextRecordingTarget", NativeVoiceJson.object("threadId", other, "threadTitle", "Chosen in app")));
                if (source.equals("app")) assertNull(f.command("startManualListen", NativeVoiceJson.object("threadId", other, "threadTitle", "Explicit other")));
                else { f.runtime.notificationAction(source, f.runtime.snapshot().getLong("connectionGeneration")); f.flush(); }
                JSONObject active = f.runtime.snapshot().getJSONObject("active");
                if (source.equals("app")) assertTrue(f.runtime.snapshot().isNull("nextRecordingTarget"));
                else assertEquals(other, f.runtime.snapshot().getJSONObject("nextRecordingTarget").getString("threadId"));
                assertEquals(source, source.equals("app") ? other : f.target, active.getString("recognitionThreadId"));
                assertEquals(source.equals("app") ? "Explicit other" : "Pinned default", active.getString("recognitionThreadTitle"));
                assertNotNull("The selected target still requires server validation", f.contexts.poll(10, TimeUnit.SECONDS));
                f.onOwner(() -> f.invoke("beginCapture", new Class<?>[] { Class.forName("dev.sedes.local.NativeVoiceRuntime$Active") }, field(f.runtime, "active")));
                assertNotNull(f.speech.transcriptions.poll(10, TimeUnit.SECONDS));
                f.onOwner(() -> { set(f.runtime, "phase", "listening"); f.invoke("publish", new Class<?>[0]); });
                assertNull(f.command("retargetActiveRecognition", NativeVoiceJson.object("threadId", other, "threadTitle", "Retargeted")));
                assertEquals(other, f.runtime.snapshot().getJSONObject("active").getString("recognitionThreadId"));
            }
        }
    }

    @Test public void backgroundClientSwitchRequiresListenAndAnExistingReadySession() throws Exception {
        for (String gate : new String[] { "no_listen", "off", "service", "credential", "registration", "expired" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("manual");
                if (gate.equals("off")) f.settings(NativeVoiceJson.object("audioMode", "off"));
                f.onOwner(() -> {
                    if (gate.equals("service")) set(f.runtime, "sessionStarted", false);
                    if (gate.equals("credential")) set(f.runtime, "speechCredential", null);
                    if (gate.equals("registration")) set(f.runtime, "clientConnectionToken", null);
                });
                JSONObject command = f.clientSwitch(UUID.randomUUID().toString(), !gate.equals("no_listen"));
                if (gate.equals("expired")) NativeVoiceJson.put(command, "expiresAt", 0);
                JSONObject result = f.clientCommand(command);
                assertEquals(gate, "noop", result.getString("status"));
                String reason = gate.equals("no_listen") ? "client_in_background" : gate.equals("off") ? "voice_off"
                    : gate.equals("expired") ? "expired" : "voice_not_ready";
                assertEquals(gate, reason, result.getString("reason"));
                assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.contexts.isEmpty());
                assertTrue(f.speech.transcriptions.isEmpty()); assertNull(field(f.runtime, "sessionStartId"));
                assertEquals(gate.equals("off") ? "off" : "manual", f.runtime.snapshot().getJSONObject("settings").getString("audioMode"));
            }
        }
    }

    @Test public void backgroundClientSwitchUsesExactTargetWithoutNavigatingOnResume() throws Exception {
        for (String mode : new String[] { "manual", "response" }) for (boolean resumeBeforeSettlement : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice(mode);
                // Exercise held and ordinary startup in both audio modes and across both resume timings.
                boolean held = mode.equals("manual") == resumeBeforeSettlement;
                f.settings(NativeVoiceJson.object("keepListeningByDefault", held));
                f.runtime.unobserve(f.submissionObserver);
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                JSONObject accepted = f.clientCommand(command);
                assertEquals("accepted", accepted.getString("status"));
                assertEquals("voice_only_after_turn_completion_and_playback", accepted.getString("reason"));
                assertTrue(f.contexts.isEmpty()); assertTrue(f.runtime.snapshot().isNull("active"));
                if (resumeBeforeSettlement) { f.runtime.observe(f.submissionObserver); f.foreground(f.target); }
                assertEquals("accepted", f.settleClientSwitch(command, null).getString("status"));
                f.completeClientTarget(target); f.flushEvents();
                JSONObject state = f.runtime.snapshot();
                assertEquals(target, state.getJSONObject("active").getString("recognitionThreadId"));
                assertEquals("Agent target", state.getJSONObject("active").getString("recognitionThreadTitle"));
                JSONObject recording = state.getJSONObject("active").getJSONObject("recording");
                assertEquals(held, recording.getBoolean("keepListening"));
                f.onStore(() -> {
                    NativeDictationStore.Recording durable = f.dictations.get(f.binding, recording.getString("id"));
                    assertEquals(held, durable.adopted); assertEquals(held, durable.keepListening);
                    assertEquals(target, durable.threadId); assertEquals(0, durable.acceptedSamples);
                });
                assertFalse(state.getJSONObject("settings").getBoolean("autoListen"));
                assertEquals(f.target, state.getJSONObject("settings").getString("voiceThreadId"));
                assertTrue(f.openThreads.isEmpty());
                if (!resumeBeforeSettlement) { f.runtime.observe(f.submissionObserver); f.foreground(f.target); }
                f.flushEvents();
                assertEquals(f.target, f.runtime.snapshot().getJSONObject("foreground").getString("threadId"));
                assertEquals(target, f.runtime.snapshot().getJSONObject("active").getString("recognitionThreadId"));
                assertTrue("Returning to the app must not replay navigation", f.openThreads.isEmpty());
                assertEquals("noop", f.settleClientSwitch(command, null).getString("status"));
                assertTrue("Settlement cannot start a second recording", f.speech.transcriptions.isEmpty());
            }
        }
    }

    @Test public void backgroundClientSwitchWaitsForSourceSettlementAndReplyPlaybackInEitherOrder() throws Exception {
        for (boolean drainFirst : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("response"); f.settings(NativeVoiceJson.object("autoListen", true));
                String reply = f.clientReply();
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                assertEquals("accepted", f.clientCommand(command).getString("status"));
                assertFalse("The explicit destination replaces automatic follow-up to the source", (boolean) field(field(f.runtime, "active"), "followUp"));
                if (drainFirst) { f.runtime.drained(reply); f.flush(); }
                else assertEquals("accepted", f.settleClientSwitch(command, reply).getString("status"));
                assertTrue(f.contexts.isEmpty()); assertTrue(f.speech.transcriptions.isEmpty());
                if (drainFirst) assertEquals("accepted", f.settleClientSwitch(command, reply).getString("status"));
                else { f.runtime.drained(reply); f.flush(); }
                f.completeClientTarget(target);
                assertTrue("Only the destination was validated", f.contexts.isEmpty());
                assertTrue(f.openThreads.isEmpty());
            }
        }
    }

    @Test public void backgroundClientSwitchCannotReplaceBusyOrSavedRecording() throws Exception {
        for (boolean saved : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("manual");
                if (saved) f.savedRecording(false, true, false);
                else {
                    assertNull(f.command("startManualListen", NativeVoiceJson.object("threadId", f.target)));
                    f.completeClientTarget(f.target);
                }
                JSONObject before = f.runtime.snapshot();
                JSONObject result = f.clientCommand(f.clientSwitch(UUID.randomUUID().toString(), true));
                assertEquals("noop", result.getString("status"));
                assertEquals(saved ? "saved_recording_pending" : "voice_busy", result.getString("reason"));
                assertEquals(before.opt("active").toString(), f.runtime.snapshot().opt("active").toString());
                assertTrue(f.contexts.isEmpty()); assertTrue(f.speech.transcriptions.isEmpty());
            }
        }
    }

    @Test public void backgroundClientSwitchRechecksBusyAndSavedStateAtSettlement() throws Exception {
        for (String blocker : new String[] { "busy", "saved", "held_slot" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("response"); f.policy(true, false, "speak");
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                assertEquals("accepted", f.clientCommand(command).getString("status"));
                String queued = null;
                NativeDictationStore.Recording saved = null;
                if (blocker.equals("busy")) {
                    queued = f.receiveReply(); assertNotNull(f.speech.speechRequests.poll(10, TimeUnit.SECONDS));
                } else {
                    saved = f.savedRecording(blocker.equals("held_slot"), blocker.equals("saved"), blocker.equals("held_slot"));
                    if (blocker.equals("held_slot")) {
                        NativeDictationStore.Recording record = saved;
                        AtomicReference<NativeDictationStore.Recording> handedOff = new AtomicReference<>();
                        f.onStore(() -> {
                            f.dictations.saveFinalRequest(f.binding, record.id, NativeVoiceJson.object("mutationId", record.mutationId, "text", record.text,
                                "origin", NativeVoiceJson.object("clientId", f.request.getJSONObject("origin").getString("clientId")),
                                "runningPolicy", NativeVoiceJson.object("mode", "queue")));
                            handedOff.set(f.dictations.markHandedOff(f.binding, record.id));
                        });
                        f.onOwner(() -> set(f.runtime, "retainedDictation", handedOff.get()));
                        f.settings(NativeVoiceJson.object("keepListeningByDefault", true));
                    }
                }
                assertEquals("accepted", f.settleClientSwitch(command, null).getString("status")); f.flushEvents();
                assertTrue(f.contexts.isEmpty()); assertTrue(f.speech.transcriptions.isEmpty()); assertTrue(f.openThreads.isEmpty());
                if (blocker.equals("busy")) {
                    assertEquals(queued, f.runtime.snapshot().getJSONObject("active").getString("id"));
                    assertEquals("voice_busy", f.lastError().getString("code"));
                } else {
                    assertTrue(f.runtime.snapshot().isNull("active"));
                    assertEquals(saved.id, f.runtime.snapshot().getJSONObject("recordingRecovery").getString("recordingId"));
                    if (blocker.equals("held_slot")) assertEquals("saved_recording_pending", f.lastError().getString("code"));
                    else assertEquals("Blocked dictation quietly retires pending actions", 0, f.runtime.snapshot().getJSONArray("errors").length());
                }
            }
        }
    }

    @Test public void backgroundClientSwitchRejectsUnavailableOrMalformedTargetsBeforeRecognition() throws Exception {
        for (String failure : new String[] { "missing", "mismatched", "malformed" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("manual");
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                assertEquals("accepted", f.clientCommand(command).getString("status")); f.settleClientSwitch(command, null);
                NativeVoiceHttp.Result validation = f.takeClientTarget(target);
                JSONObject context = failure.equals("malformed") ? NativeVoiceJson.object("threadId", target)
                    : Fixture.inputContext(failure.equals("mismatched") ? f.target : target);
                validation.done(failure.equals("missing") ? 404 : 200, context, null); f.flushEvents();
                assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.speech.transcriptions.isEmpty());
                assertEquals(failure.equals("malformed") ? "invalid_input_context" : "target_unavailable", f.lastError().getString("code"));
                assertTrue(f.openThreads.isEmpty());
            }
        }
    }

    @Test public void cancelledBackgroundClientSwitchCannotStartFromSettlementOrLateValidation() throws Exception {
        for (boolean validating : new boolean[] { false, true }) {
            for (String cancellation : new String[] { "off", "stop", "disconnect", "registration", "service", "manual_target", "navigation" }) {
                try (Fixture f = new Fixture(false, false)) {
                    f.readyClientVoice("manual");
                    String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                    assertEquals("accepted", f.clientCommand(command).getString("status"));
                    NativeVoiceHttp.Result validation = null;
                    if (validating) { f.settleClientSwitch(command, null); validation = f.takeClientTarget(target); }
                    f.cancelClientSwitch(cancellation);
                    if (validation == null) assertEquals(cancellation, "noop", f.settleClientSwitch(command, null).getString("status"));
                    else validation.done(200, Fixture.inputContext(target), null);
                    f.flushEvents();
                    assertTrue(cancellation, f.runtime.snapshot().isNull("active"));
                    assertTrue(cancellation, f.speech.transcriptions.isEmpty()); assertTrue(cancellation, f.contexts.isEmpty());
                    assertTrue(cancellation, f.openThreads.isEmpty());
                }
            }
        }
    }

    @Test public void cancellingBackgroundClientValidationStartsQueuedReplySpeech() throws Exception {
        for (String cancellation : new String[] { "registration", "manual_target", "navigation", "manual_missing_target", "retarget" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("response"); f.policy(true, false, "speak");
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                assertEquals("accepted", f.clientCommand(command).getString("status")); f.settleClientSwitch(command, null);
                NativeVoiceHttp.Result validation = f.takeClientTarget(target);
                String queued = f.receiveReply();
                assertEquals(1, f.runtime.snapshot().getJSONObject("queue").getInt("count"));
                assertTrue("Validation owns the slot until cancelled", f.speech.speechRequests.isEmpty());
                f.cancelClientSwitch(cancellation);
                SpeechJob speaking = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(cancellation, speaking);
                assertEquals(queued, f.runtime.snapshot().getJSONObject("active").getString("id"));
                assertTrue(speaking.text.contains("Queued reply"));
                assertEquals(0, f.runtime.snapshot().getJSONObject("queue").getInt("count"));
                validation.done(200, Fixture.inputContext(target), null); f.flushEvents();
                assertEquals("Late validation cannot replace queued speech", queued, f.runtime.snapshot().getJSONObject("active").getString("id"));
                assertTrue(f.speech.transcriptions.isEmpty()); assertTrue(f.openThreads.isEmpty());
            }
        }
    }

    @Test public void disconnectingDuringBackgroundValidationDoesNotStartQueuedSpeech() throws Exception {
        for (boolean authenticationLost : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("response"); f.policy(true, false, "speak");
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                assertEquals("accepted", f.clientCommand(command).getString("status")); f.settleClientSwitch(command, null);
                NativeVoiceHttp.Result validation = f.takeClientTarget(target);
                f.receiveReply();
                assertEquals(1, f.runtime.snapshot().getJSONObject("queue").getInt("count"));
                if (authenticationLost) f.onOwner(f.runtime::clientAuthenticationLost);
                else f.cancelClientSwitch("disconnect");
                validation.done(200, Fixture.inputContext(target), null); f.flushEvents();
                assertTrue("Disconnect must not start even a subsequently cancelled speech request", f.speech.speechRequests.isEmpty());
                assertTrue(f.runtime.snapshot().isNull("active"));
                assertEquals(0, f.runtime.snapshot().getJSONObject("queue").getInt("count"));
                assertTrue(f.speech.transcriptions.isEmpty()); assertTrue(f.openThreads.isEmpty());
            }
        }
    }

    @Test public void manualStartSupersedesBackgroundValidationBeforeQueuedReplySpeech() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.readyClientVoice("response"); f.policy(true, false, "speak");
            String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
            assertEquals("accepted", f.clientCommand(command).getString("status")); f.settleClientSwitch(command, null);
            NativeVoiceHttp.Result validation = f.takeClientTarget(target);
            String queued = f.receiveReply();
            assertNull(f.command("startManualListen", NativeVoiceJson.object("threadId", f.target)));
            assertEquals(f.target, f.runtime.snapshot().getJSONObject("active").getString("recognitionThreadId"));
            assertTrue("The user's Start owns the slot before queued speech", f.speech.speechRequests.isEmpty());
            assertEquals(1, f.runtime.snapshot().getJSONObject("queue").getInt("count"));
            validation.done(200, Fixture.inputContext(target), null); f.flush();
            f.completeClientTarget(f.target);
            assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            assertNotNull(f.speech.speechRequests.poll(10, TimeUnit.SECONDS));
            assertEquals(queued, f.runtime.snapshot().getJSONObject("active").getString("id"));
            assertTrue(f.speech.transcriptions.isEmpty());
        }
    }

    @Test public void backgroundClientSwitchRechecksExpiryAndReadinessAfterValidation() throws Exception {
        for (String change : new String[] { "expiry", "credential" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("manual");
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                assertEquals("accepted", f.clientCommand(command).getString("status")); f.settleClientSwitch(command, null);
                NativeVoiceHttp.Result validation = f.takeClientTarget(target);
                f.onOwner(() -> {
                    if (change.equals("expiry")) set(field(f.runtime, "active"), "clientVoiceExpiresAt", System.currentTimeMillis() - 1);
                    else set(f.runtime, "speechCredential", null);
                });
                validation.done(200, Fixture.inputContext(target), null); f.flushEvents();
                assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.speech.transcriptions.isEmpty());
                assertTrue(f.openThreads.isEmpty());
            }
        }
    }

    @Test public void cancelledHeldBackgroundStartReleasesItsEmptySlotAndIgnoresLateCallbacks() throws Exception {
        for (String stage : new String[] { "preflight", "creating", "adopted" }) for (String cancellation : new String[] { "navigation", "registration" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("manual"); f.settings(NativeVoiceJson.object("keepListeningByDefault", true));
                AtomicInteger microphoneReads = new AtomicInteger();
                NativeVoiceAudio.setTestSource(() -> { microphoneReads.incrementAndGet(); return captureFrame(0); });
                f.holdRecordingPreflight = !stage.equals("adopted");
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                assertEquals("accepted", f.clientCommand(command).getString("status")); f.settleClientSwitch(command, null);
                f.takeClientTarget(target).done(200, Fixture.inputContext(target), null); f.flush();
                String recordingId = f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id");
                NativeSpeechCatalog.PreflightResult preflight = null; RecognitionJob recognition = null;
                if (stage.equals("adopted")) {
                    recognition = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(recognition);
                    f.onStore(() -> assertTrue(f.dictations.get(f.binding, recordingId).adopted));
                } else { preflight = f.preflights.poll(10, TimeUnit.SECONDS); assertNotNull(preflight); }
                if (stage.equals("creating")) {
                    try (WorkerBlock writing = new WorkerBlock(f)) {
                        preflight.done(NativeSpeechCapabilities.hosted("gpt-live-transcribe"), null); f.onOwner(() -> {});
                        if (cancellation.equals("registration")) f.onOwner(f.runtime::clientDisconnected);
                        else {
                            f.runtime.nativeVisibility(true);
                            assertNull(f.beginCommand("setForegroundContext", NativeVoiceJson.object("visible", true, "threadId", f.target)).await());
                            assertNull(f.beginCommand("setForegroundContext", NativeVoiceJson.object("visible", true, "threadId", UUID.randomUUID().toString())).await());
                        }
                        assertTrue("Cancellation releases the active slot while its writer is pending", f.runtime.snapshot().isNull("active"));
                    }
                } else f.cancelClientSwitch(cancellation);
                if (stage.equals("preflight")) preflight.done(NativeSpeechCapabilities.hosted("gpt-live-transcribe"), null);
                if (recognition != null) recognition.ready();
                f.flushEvents();
                assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
                assertNull(field(f.runtime, "captureOwner")); assertEquals(0, microphoneReads.get());
                assertTrue(f.speech.transcriptions.isEmpty()); assertTrue(f.openThreads.isEmpty());
                f.onStore(() -> assertNull("Empty held startup must not occupy recovery", f.dictations.recover(f.binding)));
                if (cancellation.equals("registration")) f.onOwner(() -> f.runtime.clientRegistered(
                    f.request.getJSONObject("origin").getString("clientId"), "restored-client-token"));
                f.runtime.nativeVisibility(false); f.flush(); f.holdRecordingPreflight = false;
                assertTrue("An empty cancellation must not block later recording", f.runtime.snapshot().getJSONObject("actions").getBoolean("canStart"));
                JSONObject next = f.clientSwitch(target, true);
                assertEquals("accepted", f.clientCommand(next).getString("status")); f.settleClientSwitch(next, null); f.completeClientTarget(target);
                assertNotEquals(recordingId, f.runtime.snapshot().getJSONObject("active").getJSONObject("recording").getString("id"));
                assertEquals(f.target, f.runtime.snapshot().getJSONObject("settings").getString("voiceThreadId"));
            }
        }
    }

    @Test public void backgroundClientSwitchRechecksReadinessBeforeOpeningTheMicrophone() throws Exception {
        for (boolean held : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("manual"); f.settings(NativeVoiceJson.object("keepListeningByDefault", held));
                AtomicInteger microphoneReads = new AtomicInteger();
                NativeVoiceAudio.setTestSource(() -> { microphoneReads.incrementAndGet(); return captureFrame(0); });
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, true);
                assertEquals("accepted", f.clientCommand(command).getString("status")); f.settleClientSwitch(command, null);
                RecognitionJob recognition = f.completeClientTarget(target);
                f.onOwner(() -> set(f.runtime, "speechCredential", null));
                recognition.ready(); f.flushEvents();
                assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
                assertTrue(recognition.cancelled); assertEquals(0, microphoneReads.get()); assertNull(field(f.runtime, "captureOwner"));
                assertEquals("voice_not_ready", f.lastError().getString("code"));
                f.onStore(() -> assertNull(f.dictations.recover(f.binding)));
            }
        }
    }

    @Test public void foregroundClientSwitchStillNavigatesAndOptionallyListens() throws Exception {
        for (String action : new String[] { "navigate", "listen", "voice_off" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("manual"); f.foreground(f.target);
                if (action.equals("voice_off")) f.settings(NativeVoiceJson.object("audioMode", "off"));
                String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, !action.equals("navigate"));
                JSONObject accepted = f.clientCommand(command);
                assertEquals("accepted", accepted.getString("status"));
                if (action.equals("voice_off")) assertEquals("navigation_accepted_voice_off", accepted.getString("reason"));
                f.settleClientSwitch(command, null);
                f.takeClientTarget(target).done(200, Fixture.inputContext(target), null); f.flushEvents();
                JSONObject opened = f.openThreads.poll(10, TimeUnit.SECONDS); assertNotNull(opened);
                assertEquals(target, opened.getString("threadId")); assertTrue(f.openThreads.isEmpty());
                if (action.equals("listen")) f.completeClientTarget(target);
                else { assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.contexts.isEmpty()); }
                assertTrue(f.speech.transcriptions.isEmpty());
            }
        }
    }

    @Test public void foregroundNavigationStillSettlesAfterTheVoiceServiceDetaches() throws Exception {
        for (String teardown : new String[] { "service", "stop_session" }) try (Fixture f = new Fixture(false, false)) {
            f.readyClientVoice("manual"); f.foreground(f.target);
            String target = UUID.randomUUID().toString(); JSONObject command = f.clientSwitch(target, false);
            assertEquals("accepted", f.clientCommand(command).getString("status"));
            f.cancelClientSwitch(teardown);
            assertEquals("accepted", f.settleClientSwitch(command, "reply-never-played").getString("status"));
            f.takeClientTarget(target).done(200, Fixture.inputContext(target), null); f.flushEvents();
            JSONObject opened = f.openThreads.poll(10, TimeUnit.SECONDS); assertNotNull(opened);
            assertEquals(target, opened.getString("threadId")); assertTrue(f.openThreads.isEmpty());
            assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.speech.transcriptions.isEmpty());
        }
    }

    @Test public void foregroundClientSwitchIsDiscardedWhenHiddenAndNeverReplaysOnResume() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.readyClientVoice("manual"); f.foreground(f.target);
            JSONObject command = f.clientSwitch(UUID.randomUUID().toString(), true);
            assertEquals("accepted", f.clientCommand(command).getString("status"));
            f.runtime.nativeVisibility(false); f.flush(); f.settleClientSwitch(command, null);
            f.foreground(f.target); f.flushEvents();
            assertTrue(f.openThreads.isEmpty()); assertTrue(f.runtime.snapshot().isNull("active"));
            assertTrue(f.contexts.isEmpty()); assertTrue(f.speech.transcriptions.isEmpty());
        }
    }

    @Test public void missingDefaultAllowsAppSelectionButRefusesBackgroundStarts() throws Exception {
        for (boolean pinned : new boolean[] { false, true }) for (String source : new String[] { "app", "headset", "start" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.recognizing(false); assertNull(f.command("stopCurrentInteraction", new JSONObject()));
                f.settings(NativeVoiceJson.object("pinDefaultVoiceThread", pinned)); f.foreground(f.target);
                assertNull(f.command("setNextRecordingTarget", NativeVoiceJson.object("threadId", f.target)));
                if (source.equals("app")) {
                    assertNull(f.command("startManualListen", NativeVoiceJson.object("threadId", f.target, "threadTitle", "Explicit target")));
                    assertEquals(f.target, f.runtime.snapshot().getJSONObject("active").getString("recognitionThreadId"));
                    assertNotNull(f.contexts.poll(10, TimeUnit.SECONDS));
                }
                else {
                    f.runtime.notificationAction(source, f.runtime.snapshot().getLong("connectionGeneration")); f.flush();
                    assertEquals("voice_target_required", f.lastError().getString("code"));
                    assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.contexts.isEmpty());
                }
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
            assertNull(new SpeechCredentialStore(f.context).getCredential("server", "http://127.0.0.1:9/v1"));
            assertNull(f.command("stopCurrentInteraction", new JSONObject()));
            Cue stopped = f.cue(NativeVoiceCue.Kind.FAILURE); f.runtime.drained(stopped.id); f.flush();
            assertNull(f.credentialAction("save", secret, f.runtime.snapshot().getLong("connectionGeneration"), 1));
            assertTrue(recording.cancelled); assertTrue(f.runtime.snapshot().isNull("active"));
            assertTrue(f.runtime.snapshot().getJSONObject("speech").getBoolean("credentialConfigured"));
            assertFalse("Secrets never enter snapshots", f.runtime.snapshot().toString().contains(secret));
            assertEquals(secret, new SpeechCredentialStore(f.context).getCredential("server", "http://127.0.0.1:9/v1"));
            assertNull(f.credentialAction("remove", null, f.runtime.snapshot().getLong("connectionGeneration"), 1));
            assertFalse(f.runtime.snapshot().getJSONObject("speech").getBoolean("credentialConfigured"));
            assertNull(new SpeechCredentialStore(f.context).getCredential("server", "http://127.0.0.1:9/v1"));
        }
    }

    @Test public void credentialDialogRevisionAndConnectionChecksPrecedeAnyWrite() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false);
            long generation = f.runtime.snapshot().getLong("connectionGeneration");
            assertEquals("settings_revision_conflict", f.credentialAction("save", "stale-dialog-token", generation, 0));
            assertEquals("connection_changed", f.credentialAction("save", "stale-dialog-token", generation + 1, 1));
            assertNull(new SpeechCredentialStore(f.context).getCredential("server", "http://127.0.0.1:9/v1"));
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
                "recognitionResultTimeoutMs", 90000, "recognitionEndSilenceMs", 100, "inputDevice", NativeVoiceJson.object("type", 7, "address", null, "name", "Changed headset")));
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

    @Test public void profileRemovalPreservesDeviceSpeechSecretsEvenWhenVoiceRecordCleanupFails() throws Exception {
        for (boolean throughPlugin : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                SpeechCredentialStore speech = new SpeechCredentialStore(f.context);
                ClientCredentialStore pairing = new ClientCredentialStore(f.context);
                speech.setCredential("server", "https://speech.example/v1", "profile-speech-token");
                pairing.setCredential(f.profile, f.origin, "profile-pairing-token");
                File directory = f.store.directory(f.binding);
                int mode = Os.stat(directory.getPath()).st_mode & 0777;
                try {
                    Os.chmod(directory.getPath(), 0500);
                    if (throughPlugin) assertThrows(Exception.class, () -> ClientCredentialsPlugin.removeProfileCredentials(f.context, f.profile, f.runtime::profileRemoved));
                    else assertThrows(Exception.class, () -> f.runtime.profileRemoved(f.profile));
                    assertEquals("profile-speech-token", speech.getCredential("server", "https://speech.example/v1"));
                    if (throughPlugin) assertNull(pairing.getCredential(f.profile, f.origin));
                    assertNull("Profile removal disconnects before any cleanup", field(f.runtime, "binding"));
                } finally { Os.chmod(directory.getPath(), mode); pairing.removeProfileCredentials(f.profile); }
            }
        }
    }

    @Test public void pairingRemovalFailureReachesTheCallerWithoutDeletingDeviceSpeechCredentials() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            SpeechCredentialStore speech = new SpeechCredentialStore(f.context);
            ClientCredentialStore pairing = new ClientCredentialStore(f.context);
            speech.setCredential("server", "https://speech.example/v1", "device-speech-token");
            pairing.setCredential(f.profile, f.origin, "profile-pairing-token");
            File blocked = new File(new File(new File(f.context.getNoBackupFilesDir(), "credentials"), hash(f.profile)), "blocked");
            assertTrue(blocked.mkdir()); File retained = new File(blocked, "retained"); assertTrue(retained.createNewFile());
            try {
                Exception error = assertThrows(Exception.class,
                    () -> ClientCredentialsPlugin.removeProfileCredentials(f.context, f.profile, f.runtime::profileRemoved));
                assertEquals("credential_removal_failed", error.getMessage());
                assertEquals("device-speech-token", speech.getCredential("server", "https://speech.example/v1"));
                assertNull(field(f.runtime, "binding"));
            } finally {
                assertTrue(retained.delete()); assertTrue(blocked.delete()); pairing.removeProfileCredentials(f.profile);
            }
        }
    }

    @Test public void equivalentMicrophonePreferenceCanBeSavedDuringRecordingButChangingItIsRejected() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false); RecognitionJob recording = f.synthetic;
            f.onOwner(() -> {
                NativeVoiceSettings previous = (NativeVoiceSettings) field(f.runtime, "settings");
                NativeVoiceSettings selected = previous.patch(previous.revision, NativeVoiceJson.object("inputDevice",
                    NativeVoiceJson.object("type", 7, "address", null, "name", "Headset")));
                set(f.runtime, "settings", selected); set(field(f.runtime, "active"), "recordingSettings", selected); f.invoke("publish", new Class<?>[0]);
            });
            f.settings(NativeVoiceJson.object("ttsGain", 80, "inputDevice", NativeVoiceJson.object("name", "Headset", "address", null, "type", 7)));
            assertEquals("recording_settings_busy", f.command("updateSettings", NativeVoiceJson.object("expectedRevision",
                f.runtime.snapshot().getLong("settingsRevision"), "patch", NativeVoiceJson.object("inputDevice", null))));
            assertFalse(recording.cancelled); assertFalse(f.runtime.snapshot().isNull("active"));
            assertEquals("Headset", f.runtime.snapshot().getJSONObject("settings").getJSONObject("inputDevice").getString("name"));
        }
    }

    @Test public void audioDeviceCallbacksPublishFreshInventoryWithoutStartingOrReplacingCapture() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false);
            JSONObject before = f.runtime.snapshot();
            BlockingQueue<JSONObject> inventories = new LinkedBlockingQueue<>();
            NativeVoiceRuntime.Observer observer = (name, value) -> { if (name.equals("inputDevicesChanged")) inventories.add(value); };
            f.runtime.observe(observer);
            try {
                NativeVoiceAudio audio = (NativeVoiceAudio) field(f.runtime, "audio");
                android.media.AudioDeviceCallback callback = (android.media.AudioDeviceCallback) field(audio, "deviceCallback");
                callback.onAudioDevicesRemoved(new android.media.AudioDeviceInfo[0]);
                JSONObject removed = inventories.poll(10, TimeUnit.SECONDS); assertNotNull(removed);
                assertEquals(audio.devices().toString(), removed.getJSONArray("devices").toString());
                callback.onAudioDevicesAdded(new android.media.AudioDeviceInfo[0]);
                JSONObject added = inventories.poll(10, TimeUnit.SECONDS); assertNotNull(added);
                assertEquals(audio.devices().toString(), added.getJSONArray("devices").toString());
                f.flush(); JSONObject after = f.runtime.snapshot();
                assertEquals(before.getJSONObject("active").getString("id"), after.getJSONObject("active").getString("id"));
                assertEquals(before.getString("phase"), after.getString("phase"));
                assertEquals(before.getJSONObject("settings").toString(), after.getJSONObject("settings").toString());
                assertNull(field(audio, "recorder"));
            } finally { f.runtime.unobserve(observer); }
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
            new SpeechCredentialStore(f.context).setCredential("server", peer.endpoint(), "catalog-test-token");
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
            new SpeechCredentialStore(f.context).setCredential("server", peer.endpoint(), "catalog-test-token");
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
            new SpeechCredentialStore(f.context).setCredential("server", peer.endpoint(), "catalog-test-token");
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
            credentials.setCredential("server", first.endpoint(), "endpoint-a-token");
            credentials.setCredential("server", second.endpoint(), "endpoint-b-token");
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
            new SpeechCredentialStore(f.context).setCredential("server", first.endpoint(), "endpoint-a-token");
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
            try (Fixture f = new Fixture(false, false)) {
                f.result(f.automaticRecognizing(true), true, "Finalized before the interruption");
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
        try (Fixture f = new Fixture(false, false)) {
            String request = f.automaticRecognizing(true);
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
            try (Fixture f = new Fixture(false, false)) {
                String request = automatic ? f.automaticRecognizing(true) : f.recognizing(true);
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
                // The preference belongs to the recording; the composer's selected mode freezes when capture ends.
                String request = f.recognizing(true, false, true);
                f.onOwner(() -> set(f.runtime, "composerMode", selectedMode));
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
                    for (int frame = 0; frame < 310; frame++) assertEquals("The first silent pause cannot stop held capture",
                        NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(captureFrame(0)));
                    set(f.runtime, "phase", "listening"); f.invoke("publish", new Class<?>[0]);
                });
                assertTrue(f.runtime.snapshot().getJSONObject("actions").getBoolean("canSend"));
                assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
            }
        }
    }

    @Test public void heldStartupCancellationSettlesCreationBeforeRecoveryAndDistinguishesExplicitDiscard() throws Exception {
        for (boolean adoptedBeforeCancellation : new boolean[] { false, true }) {
            for (String action : new String[] { "off", "disconnect", "focus", "cancel" }) for (String fault : new String[] { "none", "manifest", "terminal" }) {
                if (!adoptedBeforeCancellation && !fault.equals("none")) continue;
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
                    StorageFaults storage = f.storageFaults();
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
                                writing.close(); f.onStore(() -> {
                                    assertTrue(f.dictations.get(f.binding, id).adopted);
                                    if (!fault.equals("none")) storage.arm("before_write", fault + ".enc");
                                });
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
                    assertNull("Empty startup has no work for reconnect recovery", restored.get());
                    f.onStore(() -> assertNull(f.dictations.recover(f.binding)));
                    assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
                    assertEquals(fault.equals("terminal") ? 1 : 0, storage.failures.get());
                    if (adoptedBeforeCancellation && !action.equals("disconnect")) {
                        if (fault.equals("terminal")) assertEquals(1, f.errors("dictation_storage_unavailable"));
                        else if (!action.equals("cancel")) {
                            String reason = action.equals("off") ? "voice_off" : "audio_focus_lost";
                            assertEquals(1, f.errors(reason)); assertFalse(f.lastError().getString("message").contains("saved"));
                        }
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

    @Test public void defaultHeldOwnershipSurvivesPolicyChangesWhilePreflightIsBlocked() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.automaticRecognizing(false); Object active = field(f.runtime, "active");
            f.settings(NativeVoiceJson.object("keepListeningByDefault", true)); f.holdRecordingPreflight = true;
            Object navigation = field(f.runtime, "inputSubmissionContext");
            f.onOwner(() -> {
                ((NativeVoiceRecording) field(active, "recording")).discard(); set(active, "recording", null);
                f.invoke("closeRecordingTransport", new Class<?>[] { active.getClass() }, active);
                f.invoke("beginCapture", new Class<?>[] { active.getClass() }, active);
            });
            NativeSpeechCatalog.PreflightResult preflight = f.preflights.poll(10, TimeUnit.SECONDS); assertNotNull(preflight);
            assertFalse((boolean) field(active, "automatic")); assertTrue((boolean) field(active, "defaultHeld"));
            assertFalse((boolean) field(active, "adopted")); assertNotSame(navigation, field(f.runtime, "inputSubmissionContext"));
            f.settings(NativeVoiceJson.object("autoListen", false));
            f.onOwner(() -> f.invoke("streamFailed", new Class<?>[] { String.class }, "network_unavailable"));
            assertSame(active, field(f.runtime, "active")); assertFalse((boolean) field(active, "stopped"));
            preflight.done(NativeSpeechCapabilities.hosted("gpt-live-transcribe"), null);
            assertNotNull(f.speech.transcriptions.poll(10, TimeUnit.SECONDS)); f.flush();
            assertSame(active, field(f.runtime, "active")); assertTrue((boolean) field(active, "keepListening"));
        }
    }

    @Test public void startupRecognitionFailureReleasesEmptyAdoptionButKeepsTheFirstAcceptedPacket() throws Exception {
        for (boolean captured : new boolean[] { false, true }) {
            try (Fixture f = new Fixture(false, false)) {
                f.recognizing(false, true); Object active = field(f.runtime, "active");
                if (captured) f.onOwner(() -> assertTrue(((NativeVoiceRecording) field(active, "recording")).accept(captureFrame(1000))));
                f.synthetic.listener.failed(f.synthetic.id, null, new NativeSpeechTransport.Failure(NativeSpeechTransport.Kind.AUTHENTICATION, "recognition_authentication_failed", 401));
                f.flush(); assertTrue(f.runtime.snapshot().isNull("active")); assertEquals(1, f.errors("recognition_authentication_failed"));
                assertEquals(captured, !f.runtime.snapshot().isNull("recordingRecovery"));
                f.onStore(() -> {
                    NativeDictationStore.Recording restored = f.dictations.recover(f.binding);
                    if (captured) { assertNotNull(restored); assertEquals(2400, restored.durableSamples); }
                    else assertNull(restored);
                });
            }
        }
    }

    @Test public void failedFirstAudioWriteReportsStorageErrorWithoutLeavingAnEmptyRecoveryCard() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
            f.recognizing(false, true); Object active = field(f.runtime, "active");
            StorageFaults storage = f.storageFaults(); storage.failPcm = true;
            f.onOwner(() -> assertTrue(((NativeVoiceRecording) field(active, "recording")).accept(new byte[NativeDictationStore.SAMPLE_RATE * 2])));
            f.flush(); assertTrue(storage.failures.get() > 0); assertEquals(1, f.errors("dictation_storage_unavailable"));
            assertTrue(f.runtime.snapshot().isNull("active")); assertTrue(f.runtime.snapshot().isNull("recordingRecovery"));
            assertTrue(f.runtime.snapshot().getJSONObject("actions").getBoolean("canStart"));
            assertFalse((boolean) field(f.runtime, "dictationOperationPending")); assertFalse((boolean) field(f.runtime, "dictationStorageError"));
            f.onStore(() -> assertNull(f.dictations.recover(f.binding)));
            try (NativeDictationStore reopened = new NativeDictationStore(f.context)) {
                f.onStore(() -> assertNull(reopened.recover(f.binding)));
            }
        }
    }

    @Test public void defaultHeldRefusesAnOccupiedRecoverySlotWithoutStartingNormalCapture() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
            NativeDictationStore.Recording saved = f.savedRecording(true, false);
            f.onStore(() -> {
                f.dictations.saveFinalRequest(f.binding, saved.id, NativeVoiceJson.object("mutationId", saved.mutationId, "text", saved.text,
                    "origin", NativeVoiceJson.object("clientId", f.request.getJSONObject("origin").getString("clientId")), "runningPolicy", NativeVoiceJson.object("mode", "queue")));
            });
            AtomicReference<NativeDictationStore.Recording> handedOff = new AtomicReference<>();
            f.onStore(() -> handedOff.set(f.dictations.markHandedOff(f.binding, saved.id)));
            f.onOwner(() -> { set(f.runtime, "retainedDictation", handedOff.get()); f.invoke("publish", new Class<?>[0]); });
            assertTrue(f.runtime.snapshot().getJSONObject("actions").getBoolean("canStart"));
            f.settings(NativeVoiceJson.object("keepListeningByDefault", true));
            assertFalse(f.runtime.snapshot().getJSONObject("actions").getBoolean("canStart"));
            assertEquals("saved_recording_pending", f.command("startManualListen", NativeVoiceJson.object("threadId", f.target)));
            assertTrue(f.contexts.isEmpty()); assertTrue(f.cues.isEmpty());
            for (String boundary : new String[] { "validateTarget", "arm" }) f.onOwner(() -> {
                Class<?> type = Class.forName("dev.sedes.local.NativeVoiceRuntime$Active");
                Constructor<?> ctor = type.getDeclaredConstructor(String.class, String.class); ctor.setAccessible(true);
                Object next = ctor.newInstance(f.target, "Automatic follow-up"); set(next, "automatic", true); set(f.runtime, "active", next);
                if (boundary.equals("validateTarget")) f.invoke(boundary, new Class<?>[] { type, boolean.class }, next, true);
                else f.invoke(boundary, new Class<?>[] { type }, next);
                assertTrue(f.runtime.snapshot().isNull("active"));
            });
            assertTrue(f.contexts.isEmpty()); assertTrue(f.cues.isEmpty());
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
                sending = f.beginCommand("sendRecoveredRecording", recoveryArgs(saved));
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
                sending = f.beginCommand("sendRecoveredRecording", recoveryArgs(saved)); f.onOwner(() -> {});
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
                assertNull(f.command("sendRecoveredRecording", recoveryArgs(saved)));
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

    @Test public void incompleteRecoveryUsesExplicitSendWithoutAnAdditionalAcknowledgement() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeDictationStore.Recording saved = f.savedRecording(true, true);
            assertEquals("recording_revision_conflict", f.command("sendRecoveredRecording", NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", saved.revision + 1)));
            assertTrue(f.runtime.snapshot().isNull("active")); assertFalse((boolean) field(f.runtime, "dictationOperationPending"));
            assertEquals(0, f.inputAttempts.get()); assertEquals(saved.revision, f.runtime.snapshot().getJSONObject("recordingRecovery").getLong("revision"));
            assertNull(f.command("sendRecoveredRecording", recoveryArgs(saved)));
            assertNotNull(f.inputs.poll(10, TimeUnit.SECONDS)); assertEquals(1, f.inputAttempts.get());
        }
    }

    @Test public void explicitTranscriptReadPreservesRecoveryAndRejectsStaleIdentityOrRevision() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeDictationStore.Recording saved = f.savedRecording(true, true);
            AsyncCommand read = f.beginCommand("readRecognizedRecordingText", recoveryArgs(saved));
            assertNull(read.await());
            assertEquals(saved.text, read.value.getString("text"));
            assertEquals(saved.threadId, read.value.getString("threadId"));
            assertEquals(saved.id, read.value.getString("recordingId"));
            assertEquals(saved.revision, read.value.getLong("revision"));
            assertEquals(saved.revision, f.runtime.snapshot().getJSONObject("recordingRecovery").getLong("revision"));
            assertEquals(0, f.inputAttempts.get());
            assertEquals("recording_revision_conflict", f.command("readRecognizedRecordingText",
                NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", saved.revision + 1)));
            assertEquals("recording_changed", f.command("readRecognizedRecordingText",
                NativeVoiceJson.object("recordingId", UUID.randomUUID().toString(), "expectedRecoveryRevision", saved.revision)));
            AsyncCommand stale;
            try (WorkerBlock blocked = new WorkerBlock(f)) {
                stale = f.beginCommand("readRecognizedRecordingText", recoveryArgs(saved));
                f.onOwner(() -> {});
                f.onOwner(() -> f.invoke("disconnect", new Class<?>[] { boolean.class }, false));
            }
            assertEquals("recording_changed", stale.await());
            assertNull(stale.value);
            assertEquals(saved.text, f.dictations.transcript(f.binding, saved.id));
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
                JSONObject args = complete ? recoveryArgs(saved) : NativeVoiceJson.object("recordingId", saved.id, "expectedRecoveryRevision", saved.revision);
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

    private static JSONObject recoveryArgs(NativeDictationStore.Recording record) {
        return NativeVoiceJson.object("recordingId", record.id, "expectedRecoveryRevision", record.revision);
    }
    private static final class AsyncCommand implements NativeVoiceRuntime.Reply {
        final CountDownLatch done = new CountDownLatch(1); volatile String error; volatile JSONObject value;
        public void done(JSONObject state) { value = state; done.countDown(); }
        public void failed(String code, String message) { error = code; done.countDown(); }
        String await() throws Exception { assertTrue(done.await(10, TimeUnit.SECONDS)); return error; }
    }
    private static final class StorageFaults extends NativeDictationStore.Disk {
        final NativeDictationStore.Disk delegate;
        final AtomicInteger failures = new AtomicInteger();
        volatile String phase, name;
        volatile boolean failPcm;
        StorageFaults(NativeDictationStore.Disk delegate) { this.delegate = delegate; }
        void arm(String phase, String name) { this.phase = phase; this.name = name; }
        @Override void fault(String phase, File file) throws java.io.IOException {
            if (failPcm && phase.equals("before_write") && file.getName().startsWith("pcm-")) {
                failures.incrementAndGet(); throw new java.io.IOException("injected_pcm_write_failure");
            }
            if (phase.equals(this.phase) && file.getName().equals(name)) {
                this.phase = null; failures.incrementAndGet(); throw new java.io.IOException("injected_startup_storage_failure");
            }
        }
        @Override void syncDirectory(File directory) throws Exception { delegate.syncDirectory(directory); }
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

    @Test public void replayRequiresAStartedReadySessionAndValidatesArgumentsFirst() throws Exception {
        for (String gate : new String[] { "off", "service", "credential", "binding" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("response");
                if (gate.equals("off")) f.settings(NativeVoiceJson.object("audioMode", "off"));
                f.onOwner(() -> {
                    if (gate.equals("service")) set(f.runtime, "sessionStarted", false);
                    if (gate.equals("credential")) set(f.runtime, "speechCredential", null);
                    if (gate.equals("binding")) set(f.runtime, "binding", null);
                });
                assertEquals(gate, "invalid_turnId", f.command("speakReply", NativeVoiceJson.object("threadId", f.target, "assistantResult", new JSONObject())));
                assertEquals(gate, "voice_not_ready", f.speakReply(f.target, "turn-1", "Reply text"));
                assertTrue(gate, f.runtime.snapshot().isNull("active")); assertEquals(gate, 0, f.queued());
                assertTrue(gate, f.speech.speechRequests.isEmpty());
            }
        }
        try (Fixture f = new Fixture(false, false)) {
            f.readyClientVoice("response");
            JSONObject extra = NativeVoiceJson.object("threadId", f.target, "turnId", "turn-1", "threadTitle", "Title", "assistantResult", new JSONObject());
            assertEquals("unknown_field", f.command("speakReply", extra));
            assertEquals("invalid_assistantResult", f.command("speakReply", NativeVoiceJson.object("threadId", f.target, "turnId", "turn-1")));
            assertEquals("unknown_field", f.command("speakReply", NativeVoiceJson.object("threadId", f.target, "turnId", "turn-1",
                "assistantResult", NativeVoiceJson.object("summary", NativeVoiceJson.object("text", "Reply")))));
            assertEquals("voice_reply_empty", f.speakReply(f.target, "turn-1", "---"));
            assertTrue(f.runtime.snapshot().isNull("active")); assertEquals(0, f.queued()); assertTrue(f.speech.speechRequests.isEmpty());
        }
    }

    @Test public void manualModePlaysAReplayWithoutContextAndNeverListensAfterwards() throws Exception {
        for (String end : new String[] { "drain", "skip", "stop" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("manual");
                f.settings(NativeVoiceJson.object("autoListen", true, "readNotificationContext", true));
                f.runtime.nativeVisibility(true);
                assertNull(f.command("setForegroundContext", NativeVoiceJson.object("visible", true, "threadId", f.target, "threadTitle", "Visible thread")));
                assertNull(f.speakReply(f.target, "turn-1", "**Replayed** reply."));
                SpeechJob job = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(end, job);
                assertEquals("Replayed reply.", job.text);
                JSONObject state = f.runtime.snapshot(), active = state.getJSONObject("active");
                assertEquals("replay", active.getString("eventKind")); assertFalse(active.getBoolean("automatic"));
                assertEquals(f.target, active.getString("threadId")); assertEquals("Visible thread", active.getString("threadTitle"));
                assertTrue(active.isNull("recognitionThreadId")); assertTrue(active.isNull("recording"));
                assertTrue(state.getJSONObject("actions").getBoolean("canSkip")); assertTrue(state.getJSONObject("actions").getBoolean("canStop"));
                switch (end) {
                    case "drain": f.runtime.drained(job.id); f.flush(); break;
                    case "skip": assertNull(f.command("skipCurrentPlayback", new JSONObject())); break;
                    case "stop": assertNull(f.command("stopCurrentInteraction", new JSONObject())); assertTrue(job.cancelled); break;
                    default: throw new AssertionError(end);
                }
                assertTrue(end, f.runtime.snapshot().isNull("active"));
                assertTrue("A replay never validates a listen target", f.contexts.isEmpty());
                assertTrue(f.speech.transcriptions.isEmpty());
                assertEquals(end, 0, f.runtime.snapshot().getJSONArray("errors").length());
            }
        }
    }

    @Test public void replayIgnoresAutomaticVoiceFiltersAndNotificationPolicy() throws Exception {
        for (String filter : new String[] { "only_voice_thread", "ignore_other_devices", "disabled", "silenced", "no_policy" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("response");
                // The saved default is f.target; the replay is for another thread.
                f.settings(NativeVoiceJson.object("onlyVoiceThread", filter.equals("only_voice_thread"), "ignoreOtherDevices", true));
                if (filter.equals("disabled")) f.policy(false, false, "speak");
                else if (filter.equals("silenced")) f.policy(true, true, "speak");
                else if (!filter.equals("no_policy")) f.policy(true, false, "speak");
                String other = UUID.randomUUID().toString();
                f.receiveNotice(filter.equals("only_voice_thread") ? other : f.target, filter.equals("ignore_other_devices") ? UUID.randomUUID().toString() : null);
                assertTrue(filter + " filters the automatic notice", f.speech.speechRequests.isEmpty());
                assertEquals(filter, 1, f.runtime.snapshot().getJSONObject("queue").getJSONObject("droppedReasons").getInt("ineligible"));
                assertNull(filter, f.speakReply(other, "turn-1", "Replayed elsewhere"));
                SpeechJob job = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(filter, job);
                assertEquals("Replayed elsewhere", job.text);
                assertEquals(other, f.runtime.snapshot().getJSONObject("active").getString("threadId"));
            }
        }
    }

    @Test public void endingAReplayNeverDiscardsClientActionsForItsTurn() throws Exception {
        for (String end : new String[] { "drain", "skip", "failure", "focus_loss" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("response");
                JSONObject command = f.clientSwitch(UUID.randomUUID().toString(), true);
                assertEquals("accepted", f.clientCommand(command).getString("status"));
                // The replayed turn is the staged action's source turn.
                assertNull(f.speakReply(f.target, command.getString("sourceTurnId"), "Replay of the source turn"));
                SpeechJob job = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(end, job);
                switch (end) {
                    case "drain": f.runtime.drained(job.id); f.flush(); break;
                    case "skip": assertNull(f.command("skipCurrentPlayback", new JSONObject())); break;
                    case "failure": job.listener.failed(job.id, new NativeSpeechTransport.Failure(NativeSpeechTransport.Kind.HTTP, "speech_http_error", 500)); f.flush(); break;
                    case "focus_loss": f.runtime.failed(job.id, "audio_focus_lost"); f.flush(); break;
                    default: throw new AssertionError(end);
                }
                assertTrue(end, f.runtime.snapshot().isNull("active"));
                assertEquals(end, 1, ((java.util.Map<?, ?>) field(field(f.runtime, "clientActions"), "pending")).size());
                assertTrue(f.contexts.isEmpty()); assertTrue(f.speech.transcriptions.isEmpty());
            }
        }
    }

    @Test public void streamLossPolicyChangeAndModeSwitchKeepReplaysButOffClearsThem() throws Exception {
        for (String interruption : new String[] { "stream", "policy", "mode", "off" }) {
            try (Fixture f = new Fixture(false, false)) {
                f.readyClientVoice("response"); f.policy(true, false, "speak");
                assertNull(f.speakReply(f.target, "turn-1", "First replay"));
                SpeechJob first = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(interruption, first);
                String playing = f.runtime.snapshot().getJSONObject("active").getString("id");
                assertNull(f.speakReply(f.target, "turn-2", "Second replay"));
                f.receiveReply();
                assertEquals(2, f.queued());
                switch (interruption) {
                    case "stream": f.onOwner(() -> f.invoke("streamFailed", new Class<?>[] { String.class }, "stream_closed")); f.flush(); break;
                    case "policy": f.policy(true, true); break;
                    case "mode": f.settings(NativeVoiceJson.object("audioMode", "manual")); break;
                    case "off": f.settings(NativeVoiceJson.object("audioMode", "off")); break;
                    default: throw new AssertionError(interruption);
                }
                if (interruption.equals("off")) {
                    assertTrue(f.runtime.snapshot().isNull("active")); assertEquals(0, f.queued()); assertTrue(first.cancelled);
                } else {
                    assertEquals(interruption, playing, f.runtime.snapshot().getJSONObject("active").getString("id"));
                    assertFalse(interruption, first.cancelled);
                    assertEquals("Only the automatic notice leaves the queue", 1, f.queued());
                    f.runtime.drained(first.id); f.flush();
                    SpeechJob second = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(interruption, second);
                    assertEquals("Second replay", second.text);
                    assertEquals("replay", f.runtime.snapshot().getJSONObject("active").getString("eventKind"));
                    assertEquals(0, f.queued());
                }
            }
        }
    }

    @Test public void stoppedServiceClearsPendingReplaysSoNoneSpeaksAfterARestart() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.readyClientVoice("response"); f.policy(true, false, "speak");
            assertNull(f.speakReply(f.target, "turn-1", "First replay"));
            SpeechJob first = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(first);
            assertNull(f.speakReply(f.target, "turn-2", "Second replay"));
            f.receiveReply();
            assertEquals(2, f.queued());
            int dropped = f.runtime.snapshot().getJSONObject("queue").getInt("droppedCount");
            // Android destroys the service while the process survives.
            NativeVoiceRuntimeService service = new NativeVoiceRuntimeService();
            f.onOwner(() -> set(f.runtime, "service", service)); f.runtime.detached(service); f.flush();
            JSONObject state = f.runtime.snapshot();
            assertTrue(state.isNull("active")); assertTrue(first.cancelled);
            assertEquals("Only the automatic notice stays queued", 1, f.queued());
            assertEquals("Cleared replays are not drops", dropped, state.getJSONObject("queue").getInt("droppedCount"));
            // The service starts again much later: drain judges the automatic notice, and no stale replay plays.
            f.onOwner(() -> { set(f.runtime, "sessionStarted", true); set(f.runtime, "speech", f.speech); f.invoke("drain", new Class<?>[0]); });
            f.flush();
            assertTrue(f.runtime.snapshot().isNull("active")); assertEquals(0, f.queued());
            assertTrue("No replay outlives the stopped service", f.speech.speechRequests.isEmpty());
            assertEquals(1, f.runtime.snapshot().getJSONObject("queue").getJSONObject("droppedReasons").getInt("ineligible"));
            assertNull("A cleared turn can be replayed again", f.speakReply(f.target, "turn-2", "Second replay"));
            SpeechJob again = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(again);
            assertEquals("Second replay", again.text);
        }
    }

    @Test public void replayingAQueuedOrPlayingTurnIsANoOpAndAFullQueueRefusesIt() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.readyClientVoice("response");
            assertNull(f.speakReply(f.target, "turn-0", "Playing"));
            SpeechJob playing = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(playing);
            String id = f.runtime.snapshot().getJSONObject("active").getString("id");
            assertNull(f.speakReply(f.target, "turn-0", "Playing"));
            assertEquals(id, f.runtime.snapshot().getJSONObject("active").getString("id"));
            assertEquals(0, f.queued()); assertTrue(f.speech.speechRequests.isEmpty());
            for (int i = 1; i <= NativeVoiceQueue.MAX_ITEMS; i++) assertNull(f.speakReply(f.target, "turn-" + i, "Queued " + i));
            assertNull("A queued turn is a no-op even when the queue is full", f.speakReply(f.target, "turn-1", "Queued 1"));
            assertEquals("voice_queue_full", f.speakReply(f.target, "turn-overflow", "Too many"));
            assertEquals(NativeVoiceQueue.MAX_ITEMS, f.queued());
            assertEquals(0, f.runtime.snapshot().getJSONObject("queue").getInt("droppedCount"));
            f.runtime.drained(playing.id); f.flush();
            SpeechJob next = f.speech.speechRequests.poll(10, TimeUnit.SECONDS); assertNotNull(next);
            assertEquals("Queued 1", next.text);
            assertNull("A finished turn can be replayed again", f.speakReply(f.target, "turn-0", "Playing"));
            assertEquals(NativeVoiceQueue.MAX_ITEMS, f.queued());
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
        final NativeVoiceTestContext context = new NativeVoiceTestContext();
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
        final BlockingQueue<String> contextTargets = new LinkedBlockingQueue<>();
        final BlockingQueue<Cue> cues = new LinkedBlockingQueue<>();
        final BlockingQueue<JSONObject> submissions = new LinkedBlockingQueue<>(), openThreads = new LinkedBlockingQueue<>();
        final NativeVoiceRuntime.Observer submissionObserver = (name, value) -> {
            if (name.equals("inputSubmitted")) submissions.add(NativeVoiceJson.copy(value));
            if (name.equals("openThread")) openThreads.add(NativeVoiceJson.copy(value));
        };
        final NativeVoiceRuntime runtime;
        final SpeechFake speech = new SpeechFake();
        final NativeVoiceStore store;
        final NativeDictationStore dictations;
        final Handler owner;
        RecognitionJob synthetic;
        long policyGeneration;
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
                    else if (path.endsWith("/input-context")) {
                        contextTargets.add(path.substring("/api/threads/".length(), path.length() - "/input-context".length())); contexts.add(result);
                    }
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
        StorageFaults storageFaults() throws Exception {
            AtomicReference<StorageFaults> result = new AtomicReference<>();
            onStore(() -> { StorageFaults disk = new StorageFaults((NativeDictationStore.Disk) field(dictations, "disk")); set(dictations, "disk", disk); result.set(disk); });
            return result.get();
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
        void readyClientVoice(String mode) throws Exception {
            NativeVoiceAudioTest.grant(context, "android.permission.RECORD_AUDIO");
            onOwner(() -> {
                store.removeEntry(binding, mutation); set(runtime, "active", null); set(runtime, "sessionStarted", true);
                set(runtime, "settings", NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("audioMode", mode,
                    "speechProvider", "server", "speechEndpoint", "http://127.0.0.1:9/v1", "recognitionCues", false,
                    "autoListen", false, "pinDefaultVoiceThread", true, "voiceThreadId", target, "voiceThreadTitle", "Other default")));
                set(runtime, "speechCredential", "fixture-speech-token"); set(runtime, "speech", speech);
                invoke("publish", new Class<?>[0]);
            });
            assertTrue(runtime.snapshot().getJSONObject("actions").getBoolean("canStart"));
        }
        JSONObject clientSwitch(String selected, boolean listen) {
            return NativeVoiceJson.object("id", UUID.randomUUID().toString(), "action", "switch_thread", "sourceThreadId", target,
                "sourceTurnId", "client-source-turn", "threadId", selected, "threadTitle", "Agent target", "listen", listen,
                "expiresAt", System.currentTimeMillis() + 60000);
        }
        JSONObject clientCommand(JSONObject command) throws Exception {
            AtomicReference<JSONObject> result = new AtomicReference<>();
            onOwner(() -> result.set(runtime.clientCommand(command))); flush(); return result.get();
        }
        JSONObject settleClientSwitch(JSONObject command, String reply) throws Exception {
            return clientCommand(NativeVoiceJson.object("id", command.getString("id"), "action", "turn_settled",
                "sourceThreadId", command.getString("sourceThreadId"), "sourceTurnId", command.getString("sourceTurnId"),
                "replyEventId", reply, "expiresAt", command.getLong("expiresAt")));
        }
        static JSONObject inputContext(String target) {
            return NativeVoiceJson.object("threadId", target, "activityToken", "client-switch-epoch", "authority", "current",
                "runState", "idle", "automaticListenEligible", false, "steer", NativeVoiceJson.object("availability", "unavailable"));
        }
        NativeVoiceHttp.Result takeClientTarget(String target) throws Exception {
            NativeVoiceHttp.Result validation = contexts.poll(10, TimeUnit.SECONDS); assertNotNull("Expected target validation", validation);
            assertEquals(target, contextTargets.poll(10, TimeUnit.SECONDS)); return validation;
        }
        RecognitionJob completeClientTarget(String target) throws Exception {
            takeClientTarget(target).done(200, inputContext(target), null); flush();
            RecognitionJob recognition = speech.transcriptions.poll(10, TimeUnit.SECONDS);
            assertNotNull("The validated target must open one recognition session", recognition);
            assertTrue("Only one recognition session starts", speech.transcriptions.isEmpty());
            return recognition;
        }
        String clientReply() throws Exception {
            String id = UUID.randomUUID().toString();
            onOwner(() -> {
                NativeVoiceSettings configured = (NativeVoiceSettings) field(runtime, "settings");
                NativeVoiceQueue.Item notification = new NativeVoiceQueue.Item(NativeVoiceJson.object("sourceEventId", id,
                    "generation", 1, "voice", "speakThenListen",
                    "recognitionTarget", NativeVoiceJson.object("threadId", target, "activityToken", "source-epoch", "sourceTurnId", "client-source-turn"),
                    "payload", NativeVoiceJson.object("schemaVersion", 4, "notificationId", id, "event", "turn.completed",
                        "occurredAt", "2026-10-06T00:00:00Z", "title", "Completed", "message", "Ready for the next thread",
                        "thread", NativeVoiceJson.object("id", target, "title", "Source"),
                        "turn", NativeVoiceJson.object("id", "client-source-turn", "outcome", "completed"))), configured);
                Constructor<?> constructor = Class.forName("dev.sedes.local.NativeVoiceRuntime$Active")
                    .getDeclaredConstructor(NativeVoiceQueue.Item.class, int.class);
                constructor.setAccessible(true); Object active = constructor.newInstance(notification, configured.number("speechTextLimit"));
                set(active, "ttsId", id); set(runtime, "active", active); set(runtime, "phase", "speaking"); invoke("publish", new Class<?>[0]);
            });
            return id;
        }
        String receiveReply() throws Exception {
            String id = UUID.randomUUID().toString();
            JSONObject frame = NativeVoiceJson.object("sourceEventId", id, "generation", policyGeneration, "voice", "speak",
                "payload", NativeVoiceJson.object("schemaVersion", 4, "notificationId", id, "event", "turn.completed",
                    "occurredAt", "2026-10-06T00:00:00Z", "title", "Queued reply", "message", "Speak after the current interaction",
                    "thread", NativeVoiceJson.object("id", target, "title", "Other thread"),
                    "turn", NativeVoiceJson.object("id", "unrelated-turn", "outcome", "completed")));
            onOwner(() -> invoke("receive", new Class<?>[] { String.class, JSONObject.class }, "notification", frame)); flush();
            return id;
        }
        /** A completion notice on any thread, optionally started by another device. */
        void receiveNotice(String threadId, String originClientId) throws Exception {
            String id = UUID.randomUUID().toString();
            JSONObject frame = NativeVoiceJson.object("sourceEventId", id, "generation", policyGeneration, "voice", "speak",
                "payload", NativeVoiceJson.object("schemaVersion", 4, "notificationId", id, "event", "turn.completed",
                    "occurredAt", "2026-10-08T00:00:00Z", "title", "Automatic notice", "message", "Filtered by automatic voice",
                    "thread", NativeVoiceJson.object("id", threadId, "title", "Notice thread"),
                    "turn", NativeVoiceJson.object("id", "notice-turn", "outcome", "completed")));
            if (originClientId != null) NativeVoiceJson.put(frame, "origin", NativeVoiceJson.object("clientId", originClientId));
            onOwner(() -> invoke("receive", new Class<?>[] { String.class, JSONObject.class }, "notification", frame)); flush();
        }
        /** The bridge's speakReply through the owner-thread command path; returns its error code or null. */
        String speakReply(String threadId, String turnId, String text) throws Exception {
            return command("speakReply", NativeVoiceJson.object("threadId", threadId, "turnId", turnId,
                "assistantResult", NativeVoiceJson.object("final", NativeVoiceJson.object("text", text))));
        }
        int queued() throws Exception { return runtime.snapshot().getJSONObject("queue").getInt("count"); }
        void cancelClientSwitch(String cancellation) throws Exception {
            switch (cancellation) {
                case "off": settings(NativeVoiceJson.object("audioMode", "off")); break;
                case "stop": runtime.notificationAction("stop"); break;
                case "disconnect": assertNull(command("disconnect", new JSONObject())); break;
                case "registration": onOwner(runtime::clientDisconnected); break;
                case "service":
                    NativeVoiceRuntimeService service = new NativeVoiceRuntimeService();
                    onOwner(() -> set(runtime, "service", service)); runtime.detached(service); break;
                case "stop_session": onOwner(() -> invoke("stopSession", new Class<?>[0])); break;
                case "manual_target": assertNull(command("setNextRecordingTarget", NativeVoiceJson.object("threadId", target))); break;
                case "manual_missing_target":
                    settings(NativeVoiceJson.object("voiceThreadId", null));
                    assertEquals("voice_target_required", command("startManualListen", new JSONObject())); break;
                case "retarget": assertEquals("recording_changed", command("retargetActiveRecognition", NativeVoiceJson.object("threadId", target))); break;
                case "navigation": foreground(target); foreground(UUID.randomUUID().toString()); break;
                default: throw new AssertionError(cancellation);
            }
            flush();
        }
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
            return recognizing(cuesEnabled, defaultHeld, false);
        }
        String recognizing(boolean cuesEnabled, boolean defaultHeld, boolean followComposerMode) throws Exception {
            NativeVoiceAudio.setTestCuePlayer((id, kind, gain) -> cues.add(new Cue(id, kind, gain)));
            onOwner(() -> {
                store.removeEntry(binding, mutation);
                Object active = field(runtime, "active"); set(active, "admission", null);
                set(runtime, "originId", UUID.randomUUID().toString()); set(runtime, "sessionStarted", true);
                set(runtime, "settings", NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object(
                    "audioMode", "manual", "speechProvider", "server", "speechEndpoint", "http://127.0.0.1:9/v1",
                    "recognitionCues", cuesEnabled, "cueGain", 45, "keepListeningByDefault", defaultHeld, "followComposerMode", followComposerMode)));
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
                    "sourceEventId", id, "generation", policyGeneration, "voice", "speakThenListen",
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
            long generation = ++policyGeneration;
            JSONObject delivery = new JSONObject();
            for (String event : NativeVoiceProtocol.EVENTS) NativeVoiceJson.put(delivery, event,
                NativeVoiceJson.object("script", false, "voice", event.equals("turn.completed") ? completionVoice : "none"));
            JSONObject value = NativeVoiceJson.object("generation", generation, "settings", NativeVoiceJson.object("enabled", enabled, "silenced", silenced,
                "revision", generation, "delivery", delivery, "assistantResultPhases", new JSONArray(), "scriptPath", "", "arguments", new JSONArray(), "timeoutSeconds", 30));
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
                store.removeProfile(profile);
                assertFalse(store.directory(binding).exists());
                context.close();
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
                            .put(NativeVoiceJson.object("id", "fixture-stt", "task", "transcription", "realtime",
                                NativeSpeechCapabilities.server("fixture-stt", NativeVoiceJson.object(
                                    "max_buffer_bytes", 2880000, "max_message_bytes", 1048576, "max_output_bytes", 1048576,
                                    "idle_timeout_seconds", 60, "max_session_seconds", 3600)).realtime()))
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
