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
                assertNotEquals(f.mutation, receipt.getString("operationId"));
                NativeVoiceHttp.Result reply = f.start();
                reply.done(200, receipt, null); f.flushEvents();
                assertEquals(1, f.submissions.size());
                JSONObject event = f.submissions.remove();
                assertEquals(6, event.length());
                assertEquals(f.profile, event.getString("profileId"));
                assertEquals(f.origin, event.getString("serverOrigin"));
                assertEquals(Fixture.IDENTITY, event.getString("identity"));
                assertEquals(generation, event.getLong("connectionGeneration"));
                assertEquals(f.target, event.getString("threadId"));
                assertEquals(receipt.getString("operationId"), event.getString("operationId"));
                assertEquals(0, f.store.journal(f.binding).length());
                assertTrue(f.runtime.snapshot().isNull("active"));
                reply.done(200, receipt, null);
                assertNull(f.command("getState", new JSONObject()));
                f.onOwner(() -> f.invoke("recoverOutstanding", new Class<?>[0]));
                f.flushEvents(); assertTrue("Neither duplicate callbacks nor snapshots replay a submission", f.submissions.isEmpty());
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
            try (Fixture f = new Fixture(false, false)) {
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
        try (Fixture f = new Fixture(false, false)) {
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

    @Test public void nativeCredentialSaveCancelsUnfinalizedSpeechAndNeverPublishesTheSecret() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(true);
            TranscriptionJob recording = (TranscriptionJob) field(field(f.runtime, "active"), "transcription");
            String secret = "runtime-private-speech-token";
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
                    if (throughPlugin) ClientCredentialsPlugin.removeProfileCredentials(f.context, f.profile, f.runtime::profileRemoved);
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

    @Test public void voiceSpeedAndTranscriptionEditsKeepCatalogButCancelUnfinalizedMediaAndCredentialTests() throws Exception {
        for (JSONObject patch : new JSONObject[] { NativeVoiceJson.object("ttsVoice", "nova"),
            NativeVoiceJson.object("ttsSpeed", 1.5), NativeVoiceJson.object("sttModel", "other-stt") }) {
            try (Fixture f = new Fixture(false, false)) {
                f.recognizing(false);
                TranscriptionJob recording = (TranscriptionJob) field(field(f.runtime, "active"), "transcription");
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
                f.settings(patch);
                assertTrue(recording.cancelled); assertTrue(f.runtime.snapshot().isNull("active"));
                assertEquals("speech_configuration_changed", cancelledTest.get());
                assertEquals(generation, field(f.runtime, "catalogGeneration"));
                assertEquals(catalog.toString(), f.runtime.snapshot().getJSONObject("speech").getJSONObject("catalog").toString());
                assertEquals("ready", f.runtime.snapshot().getJSONObject("speech").getString("catalogStatus"));
            }
        }
    }

    @Test public void inFlightCatalogSurvivesVoiceEditAndSpeechModelChangeRefetchesItsVoices() throws Exception {
        try (Fixture f = new Fixture(false, false); CatalogPeer peer = new CatalogPeer()) {
            f.recognizing(false);
            new SpeechCredentialStore(f.context).setCredential(f.profile, "server", peer.endpoint(), "catalog-test-token");
            f.settings(NativeVoiceJson.object("speechEndpoint", peer.endpoint()));
            CountDownLatch discovered = new CountDownLatch(1); AtomicReference<String> failure = new AtomicReference<>();
            f.runtime.command("refreshSpeechCatalog", new JSONObject(), true, new NativeVoiceRuntime.Reply() {
                public void done(JSONObject value) { discovered.countDown(); }
                public void failed(String code, String message) { failure.set(code); discovered.countDown(); }
            });
            CountDownLatch firstResponse = peer.next();
            f.settings(NativeVoiceJson.object("ttsVoice", "nova", "ttsSpeed", 1.5, "sttModel", "other-stt"));
            assertEquals("loading", f.runtime.snapshot().getJSONObject("speech").getString("catalogStatus"));
            firstResponse.countDown(); assertTrue(discovered.await(10, TimeUnit.SECONDS)); f.flush(); assertNull(failure.get());
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
                    Object active = field(f.runtime, "active"); set(active, "sttId", null); set(active, "transcription", null);
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
            TranscriptionJob request = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(request);
            assertEquals(90000, request.resultTimeout);
            assertEquals("arming", f.runtime.snapshot().getString("phase"));
            assertEquals("The microphone waits for session.updated", 0, microphoneReads.get());
            request.listener.ready(request.id);
            awaitCommit(f, request);
            assertEquals(1, request.commits);
            assertEquals("100 ms speech plus 300 ms local end silence at 24 kHz", 4 * 4800, request.bytes);
            assertEquals("recognizing", f.runtime.snapshot().getString("phase"));
            f.runtime.captured(request.id, captureFrame(1000)); f.runtime.captureEnded(request.id); f.flush();
            assertEquals(1, request.commits); assertEquals(4 * 4800, request.bytes);
            request.listener.completed(request.id, "One locally finalized utterance"); f.flush();
            assertEquals(1, f.inputAttempts.get());
            assertEquals("One locally finalized utterance", f.lastRequest.get().getString("text"));
            request.listener.completed(request.id, "Late duplicate"); f.flush(); assertEquals(1, f.inputAttempts.get());
        }
    }

    @Test public void noSpeechDeadlineCommitsSilenceAndEmptyStandardTranscriptRearms() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            NativeVoiceAudioTest.grant(f.context, "android.permission.RECORD_AUDIO");
            f.recognizing(false);
            NativeVoiceAudio.setTestSource(() -> captureFrame(0));
            f.onOwner(() -> {
                NativeVoiceSettings settings = (NativeVoiceSettings) field(f.runtime, "settings");
                set(f.runtime, "settings", settings.patch(settings.revision, NativeVoiceJson.object("recognitionStartTimeoutMs", 1000)));
                f.invoke("beginCapture", new Class<?>[] { Class.forName("dev.sedes.local.NativeVoiceRuntime$Active") }, field(f.runtime, "active"));
            });
            TranscriptionJob first = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(first);
            first.listener.ready(first.id); awaitCommit(f, first);
            assertEquals(48000, first.bytes); assertEquals(1, first.commits);
            first.listener.completed(first.id, " \u00a0 "); f.flush();
            TranscriptionJob second = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(second);
            assertNotEquals(first.id, second.id); assertEquals("arming", f.runtime.snapshot().getString("phase"));
            assertEquals(0, f.inputAttempts.get()); assertEquals(0, f.runtime.snapshot().getJSONArray("errors").length());
            first.listener.completed(first.id, "Late transcript"); first.listener.ready(first.id); f.flush();
            assertEquals(0, second.bytes); assertEquals(0, f.inputAttempts.get());
        }
    }

    @Test public void focusLossWhileConfiguringCancelsTheRequestBeforeMicrophoneOwnership() throws Exception {
        try (Fixture f = new Fixture(false, false)) {
            f.recognizing(false);
            AtomicInteger microphoneReads = new AtomicInteger();
            NativeVoiceAudio.setTestSource(() -> { microphoneReads.incrementAndGet(); return captureFrame(0); });
            f.onOwner(() -> f.invoke("beginCapture", new Class<?>[] { Class.forName("dev.sedes.local.NativeVoiceRuntime$Active") }, field(f.runtime, "active")));
            TranscriptionJob request = f.speech.transcriptions.poll(10, TimeUnit.SECONDS); assertNotNull(request);
            f.runtime.failed(request.id, "audio_focus_lost"); f.flush();
            assertTrue(request.cancelled); assertTrue(f.runtime.snapshot().isNull("active"));
            request.listener.ready(request.id); request.listener.completed(request.id, "Too late"); f.flush();
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
                assertNull(field(active, "sttId")); assertNull(field(active, "cueId"));
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
                assertNull("A late valid target response must not start another capture", field(active, "sttId"));
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
                        receiptReads.incrementAndGet(); result.done(200, NativeVoiceJson.copy(receiptResponse.get()), null);
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
            runtime.observe(submissionObserver);
        }
        void foreground(String threadId) throws Exception {
            runtime.nativeVisibility(true);
            assertNull(command("setForegroundContext", NativeVoiceJson.object("visible", true, "threadId", threadId)));
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
                    "audioMode", "manual", "speechProvider", "server", "speechEndpoint", "http://127.0.0.1:9/v1",
                    "recognitionCues", cuesEnabled, "cueGain", 45)));
                set(active, "transcription", new TranscriptionJob(request, null));
                set(runtime, "speechCredential", "fixture-speech-token");
                set(runtime, "speech", speech); set(runtime, "phase", "recognizing");
                invoke("publish", new Class<?>[0]);
            });
            return request;
        }
        String automaticRecognizing(boolean cuesEnabled) throws Exception {
            String request = recognizing(cuesEnabled);
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
                set(active, "sttId", request); set(active, "lastAudioId", request); set(runtime, "active", active);
                invoke("publish", new Class<?>[0]);
            });
            return request;
        }
        void result(String request, boolean success, String text) throws Exception {
            result(request, success, text, false, "");
        }
        void result(String request, boolean success, String text, boolean canceled, String error) throws Exception {
            if (success || (!canceled && error.equals("empty_transcript")))
                onOwner(() -> invoke("transcriptionCompleted", new Class<?>[] { String.class, String.class }, request, text));
            else speechFailure(request, "recognition_failed");
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
                    case "speech": set(active, "sttId", null); set(active, "ttsId", request); set(runtime, "phase", "speaking"); break;
                    case "capture": set(runtime, "phase", "listening"); break;
                    case "start_cue": set(active, "sttId", null); set(active, "cueId", request); set(runtime, "phase", "arming"); break;
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
        void flush() throws Exception { onOwner(() -> {}); onOwner(() -> {}); }
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
            Method method = NativeVoiceRuntime.class.getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(runtime, args);
        }
        public void close() throws Exception {
            runtime.unobserve(submissionObserver);
            try { onOwner(() -> { set(runtime, "active", null); invoke("disconnect", new Class<?>[] { boolean.class }, false); }); }
            finally {
                NativeVoiceHttp.setTestTransport(null); NativeVoiceAudio.setTestCuePlayer(null); NativeVoiceAudio.setTestSource(null); owner.getLooper().quitSafely();
                store.removeProfile(profile); new SpeechCredentialStore(context).removeProfileCredentials(profile);
                assertFalse(store.directory(binding).exists());
            }
        }
    }
    private static final class SpeechFake extends NativeSpeechTransport {
        final BlockingQueue<SpeechJob> speechRequests = new LinkedBlockingQueue<>();
        final BlockingQueue<TranscriptionJob> transcriptions = new LinkedBlockingQueue<>();
        SpeechFake() { super(new Config("http://127.0.0.1:9/v1", null, "fixture-stt", "fixture-tts", "fixture-voice", 1)); }
        @Override Request speak(String id, String text, SpeechListener listener) {
            SpeechJob job = new SpeechJob(id, text, listener); speechRequests.add(job); return job;
        }
        @Override Transcription transcribe(String id, long timeout, TranscriptionListener listener) {
            TranscriptionJob job = new TranscriptionJob(id, listener); job.resultTimeout = timeout; transcriptions.add(job); return job;
        }
    }
    /** Holds real discovery responses so settings edits can race a live OkHttp callback deterministically. */
    private static final class CatalogPeer implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        final BlockingQueue<CountDownLatch> responses = new LinkedBlockingQueue<>();
        final java.util.concurrent.CopyOnWriteArrayList<CountDownLatch> holds = new java.util.concurrent.CopyOnWriteArrayList<>();
        final AtomicInteger requests = new AtomicInteger();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        volatile Socket active;
        CatalogPeer() throws Exception {
            Thread thread = new Thread(() -> {
                while (!server.isClosed()) {
                    try (Socket socket = server.accept()) {
                        active = socket; socket.setSoTimeout(10000);
                        BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                        assertEquals("GET /v1/audio/capabilities HTTP/1.1", input.readLine());
                        boolean authorized = false;
                        for (String line = input.readLine(); line != null && !line.isEmpty(); line = input.readLine())
                            if (line.equals("Authorization: Bearer catalog-test-token")) authorized = true;
                        assertTrue("Discovery request omitted its stored credential", authorized);
                        CountDownLatch release = new CountDownLatch(1); holds.add(release); requests.incrementAndGet(); responses.add(release);
                        if (!release.await(15, TimeUnit.SECONDS)) throw new AssertionError("Discovery response was never released");
                        JSONObject listing = NativeVoiceJson.object("object", "list", "data", new JSONArray()
                            .put(NativeVoiceJson.object("id", "fixture-stt", "task", "transcription"))
                            .put(NativeVoiceJson.object("id", "gpt-4o-mini-tts", "task", "speech", "voices", new JSONArray().put(NativeVoiceJson.object("id", "first-voice"))))
                            .put(NativeVoiceJson.object("id", "second-tts", "task", "speech", "voices", new JSONArray().put(NativeVoiceJson.object("id", "second-voice")))));
                        byte[] body = listing.toString().getBytes(StandardCharsets.UTF_8);
                        socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length +
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
    private static final class TranscriptionJob implements NativeSpeechTransport.Transcription {
        final String id;
        final NativeSpeechTransport.TranscriptionListener listener;
        volatile boolean cancelled;
        volatile int commits, bytes;
        long resultTimeout;
        TranscriptionJob(String id, NativeSpeechTransport.TranscriptionListener listener) { this.id = id; this.listener = listener; }
        public boolean append(byte[] pcm) { bytes += pcm.length; return true; }
        public boolean commit() { commits++; return true; }
        public void cancel() { cancelled = true; }
    }
    private static byte[] captureFrame(int amplitude) {
        byte[] bytes = new byte[4800];
        for (int i = 0; i < bytes.length; i += 2) { bytes[i] = (byte) amplitude; bytes[i + 1] = (byte) (amplitude >> 8); }
        return bytes;
    }
    private static void awaitCommit(Fixture fixture, TranscriptionJob request) throws Exception {
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
