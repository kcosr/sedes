package dev.sedes.local;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import android.webkit.WebView;
import android.view.View;
import android.graphics.Bitmap;
import java.io.File;
import java.io.FileOutputStream;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;

/** Opt-in full-system lane. The host starts real Sedes and speech server with loopback model fixtures. */
public class NativeVoiceE2eTest {
    private Instrumentation instrumentation;
    private WebView web;
    private NativeVoiceRuntime runtime;
    private final List<String> phases = new CopyOnWriteArrayList<>();
    private final List<String> screenshots = new CopyOnWriteArrayList<>();
    private String runLabel;

    @Test(timeout = 300000) public void nativeConversationCycle() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String server = args.getString("serverOrigin"), speechEndpoint = args.getString("speechEndpoint"), pairing = args.getString("pairingCode");
        Assume.assumeTrue("Requires the isolated native voice host harness", server != null && speechEndpoint != null && pairing != null);
        String speechToken = required(args, "speechToken");
        String thread = required(args, "threadId"), title = args.getString("threadTitle", "Voice fixture");
        String mode = args.getString("mode", "response"), scenario = args.getString("scenario", "cycle");
        boolean prepareStartup = scenario.equals("startup") && "prepare".equals(args.getString("startupStage"));
        boolean restoreStartup = scenario.equals("startup") && !prepareStartup;
        boolean startupPrepared = false;
        runLabel = scenario + "-" + mode + "-" + System.currentTimeMillis();
        String initial = args.getString("initialText", "native voice fixture start"), draft = args.getString("draftText", "unsent draft preserved by voice");
        instrumentation = InstrumentationRegistry.getInstrumentation(); Context context = instrumentation.getTargetContext();
        NativeVoiceAudioTest.grant(context, "android.permission.RECORD_AUDIO");
        if (Build.VERSION.SDK_INT >= 33) NativeVoiceAudioTest.grant(context, "android.permission.POST_NOTIFICATIONS");
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        instrumentation.runOnMainSync(() -> web = activity.getBridge().getWebView()); runtime = NativeVoiceRuntime.get(context);
        AtomicReference<String> currentPhase = new AtomicReference<>("");
        AtomicBoolean releaseRequested = new AtomicBoolean(), itemReleased = new AtomicBoolean();
        AtomicInteger navigationEvents = new AtomicInteger();
        List<JSONObject> submittedInputs = new CopyOnWriteArrayList<>();
        NativeVoiceRuntime.Observer observer = (event, value) -> {
            if (event.equals("inputSubmitted")) submittedInputs.add(NativeVoiceJson.copy(value));
            if (event.equals("openThread")) navigationEvents.incrementAndGet();
            if (event.equals("stateChanged")) {
                String phase = value.optString("phase"); currentPhase.set(phase);
                if (phases.isEmpty() || !phase.equals(phases.get(phases.size() - 1))) phases.add(phase);
                // Every published state reaches observers, so even a brief release before the next queued item is seen.
                if (releaseRequested.get() && value.isNull("active")) itemReleased.set(true);
            }
        };
        runtime.observe(observer);
        // Evidence for the host: a real AudioTrack owned by the runtime advanced its playback head.
        AtomicBoolean trackPlayed = new AtomicBoolean(), speechPlayed = new AtomicBoolean();
        Thread audioSampler = playbackSampler(runtimeAudio(runtime), currentPhase, trackPlayed, speechPlayed);
        AtomicInteger inputAttempts = new AtomicInteger(), receiptReads = new AtomicInteger();
        AtomicBoolean allowReceipt = new AtomicBoolean(false);
        List<String> mutationIds = new CopyOnWriteArrayList<>();
        List<JSONObject> backgroundReceipts = new CopyOnWriteArrayList<>();
        boolean recoveryScenario = scenario.equals("lost-ack") || scenario.equals("lost-send") || scenario.equals("cancel-uncertain");
        if (recoveryScenario) NativeVoiceHttp.setTestTransport(new NativeVoiceHttp.TestTransport() {
            public boolean before(String method, String path, JSONObject body, NativeVoiceHttp.Result result) {
                if (method.equals("POST") && path.endsWith("/inputs")) {
                    mutationIds.add(body.optString("mutationId"));
                    int attempt = inputAttempts.incrementAndGet();
                    if (scenario.equals("lost-send") && attempt == 1) { result.done(0, null, "test_send_not_delivered"); return true; }
                }
                return false;
            }
            public boolean after(String method, String path, JSONObject body, int status, JSONObject response, NativeVoiceHttp.Result result) {
                if (method.equals("POST") && path.endsWith("/inputs") && !scenario.equals("lost-send")) {
                    result.done(0, null, "test_response_not_delivered"); return true;
                }
                if (method.equals("GET") && path.startsWith("/api/input-receipts/")) {
                    receiptReads.incrementAndGet();
                    if (!allowReceipt.get()) { result.done(0, null, "test_response_not_delivered"); return true; }
                }
                return false;
            }
        });
        else if (scenario.equals("background-switch")) NativeVoiceHttp.setTestTransport(new NativeVoiceHttp.TestTransport() {
            public boolean before(String method, String path, JSONObject body, NativeVoiceHttp.Result result) { return false; }
            public boolean after(String method, String path, JSONObject body, int status, JSONObject response, NativeVoiceHttp.Result result) {
                // Observe the real admission without replacing any transport result. Background admission deliberately
                // emits no inputSubmitted presentation event, because the destination is not the visible transcript.
                if (method.equals("POST") && path.equals("/api/threads/" + args.getString("secondThreadId") + "/inputs") &&
                    status >= 200 && status < 300 && response != null) backgroundReceipts.add(NativeVoiceJson.copy(response));
                return false;
            }
        });
        AtomicInteger supplied = new AtomicInteger(), silenceChunks = new AtomicInteger();
        AtomicBoolean allowCaptureCompletion = new AtomicBoolean();
        NativeVoiceAudio.setTestSource(() -> {
            int speechChunks = scenario.equals("retarget") ? 60 : 10;
            int index = supplied.getAndIncrement();
            // Keep speech present until the UI action under test is applied, regardless of emulator speed.
            boolean speech = index < speechChunks || !allowCaptureCompletion.get();
            if (!speech && silenceChunks.getAndIncrement() >= 20) return null;
            SystemClock.sleep(80);
            byte[] pcm = new byte[4800];
            if (speech) for (int i = 0; i < 2400; i++) {
                short sample = (short) (6000 * Math.sin(2 * Math.PI * 440 * (index * 2400 + i) / 24000));
                pcm[i * 2] = (byte) sample; pcm[i * 2 + 1] = (byte) (sample >> 8);
            }
            return pcm;
        });
        long began = SystemClock.elapsedRealtime();
        JSONObject backgroundSwitch = null, playbackControl = null;
        try {
            if (!restoreStartup) {
                waitJs("document.querySelector('#setting-sedes-name') !== null", 45000);
                input("#setting-sedes-name", "Voice fixture " + System.currentTimeMillis()); input("#setting-sedes-server", server);
                clickText("Add & connect"); waitJs("document.querySelector('#pairing-token') !== null", 45000);
                input("#pairing-token", pairing); clickText("Pair connection");
                await(() -> runtime.snapshot().optString("originClientId", "").length() > 0 && !runtime.snapshot().isNull("originClientId"), 45000, "native authenticated bootstrap");
                waitJs("document.querySelector('button[aria-label=\"Open thread navigation\"], button[aria-label=\"Show sidebar\"], button[aria-label=\"Hide sidebar\"]') !== null", 30000);
                assertEquals("Voice Off hides the bottom bar", "false", js("document.querySelector('[aria-label=\"Voice controls\"]') !== null"));
                screenshot("voice-off");
                if ("true".equals(js("document.querySelector('button[aria-label=\"Open thread navigation\"]') !== null"))) click("button[aria-label=\"Open thread navigation\"]");
                else if ("true".equals(js("document.querySelector('button[aria-label=\"Show sidebar\"]') !== null"))) click("button[aria-label=\"Show sidebar\"]");
                waitJs("document.querySelector('button[aria-label=\"Settings\"]') !== null", 15000);
                click("button[aria-label=\"Settings\"]");
                waitJs("document.querySelector('[data-testid=\"settings-page\"][data-page=\"voice\"]') !== null", 15000);
                screenshot("settings-entry");
                click("[data-testid=\"settings-view\"] [data-testid=\"settings-page\"][data-page=\"voice\"] a[data-slot=\"entity-row-main\"]");
                waitJs("Array.from(document.querySelectorAll('label')).some(x=>x.textContent.trim()==='Provider')", 15000);
                selectByLabel("Provider", "server");
                saveSpeechSetting("Speech API endpoint", "speechEndpoint", speechEndpoint);
                clickText("Manage speech credential");
                // The fixture token goes through the real native dialog. It never
                // enters a WebView form or a Capacitor JavaScript argument.
                // The bridge opens it asynchronously; do not bind Espresso to the activity it covers.
                androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withContentDescription("Server bearer token"))
                    .inRoot(androidx.test.espresso.matcher.RootMatchers.isDialog())
                    .perform(androidx.test.espresso.action.ViewActions.replaceText(speechToken));
                androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withText("Save"))
                    .inRoot(androidx.test.espresso.matcher.RootMatchers.isDialog())
                    .perform(androidx.test.espresso.action.ViewActions.click());
                await(() -> runtime.snapshot().optJSONObject("speech").optBoolean("credentialConfigured"), 15000, "native speech credential saved");
                chooseSpeechSetting("Recognition model", "sttModel", "parakeet-local");
                chooseSpeechSetting("Speech model", "ttsModel", "kokoro-local");
                chooseSpeechSetting("Speech voice", "ttsVoice", "af_heart");
                selectByLabel("Audio mode", mode);
                await(() -> mode.equals(runtime.snapshot().optJSONObject("settings").optString("audioMode")), 15000, "audio mode " + mode + " saved");
            } else {
                await(() -> !runtime.snapshot().isNull("identity"), 45000, "restored authenticated profile");
                assertEquals(mode, runtime.snapshot().getJSONObject("settings").getString("audioMode"));
                assertEquals(Long.parseLong(required(args, "savedSettingsRevision")), runtime.snapshot().getLong("settingsRevision"));
            }
            await(() -> runtime.snapshot().optBoolean("ready"), 45000, "native voice ready");
            waitJs("document.querySelector('[aria-label=\"Voice controls\"]') !== null", 15000);
            screenshot("voice-enabled");
            await(() -> runtime.snapshot().optString("phase").equals("idle"), 10000, "idle after handshake with an empty queue");
            assertTrue("Idle voice must offer explicit recording", runtime.snapshot().optJSONObject("actions").optBoolean("canStart"));
            if (prepareStartup) {
                JSONObject prepared = NativeVoiceJson.object("settingsRevision", runtime.snapshot().getLong("settingsRevision"),
                    "originClientId", runtime.snapshot().getString("originClientId"));
                Bundle status = new Bundle(); status.putString("voiceStartupPrepared", prepared.toString()); instrumentation.sendStatus(0, status);
                startupPrepared = true;
                return;
            }
            if (restoreStartup) {
                // Authentication publishes before registration; verify the preserved client only after readiness.
                assertEquals(required(args, "savedOriginClientId"), runtime.snapshot().getString("originClientId"));
                assertEquals("Restoring readiness must not start recording", 0, supplied.get());
                assertTrue(runtime.snapshot().isNull("active"));
                assertFalse(runtime.snapshot().getJSONObject("actions").getBoolean("canResume"));
                screenshot("startup-restored");
            }
            // Route through the actual bundled application so navigation and draft preservation use the real UI.
            js("(()=>{history.pushState({},''," + JSONObject.quote("/threads/" + thread) + ");window.dispatchEvent(new PopStateEvent('popstate'));return true})()");
            waitJs("document.querySelector('[data-testid=\"composer\"] textarea:not(:disabled)') !== null", 45000);
            if (scenario.equals("cycle")) js("localStorage.setItem('sedes-seek-on-submit', '" + mode.equals("manual") + "')");
            if (scenario.equals("background-switch")) {
                // The agent's explicit listen must work independently of automatic reply recognition and the pinned default.
                command("updateSettings", NativeVoiceJson.object("expectedRevision", runtime.snapshot().getLong("settingsRevision"),
                    "patch", NativeVoiceJson.object("autoListen", false, "voiceThreadId", thread, "pinDefaultVoiceThread", true)));
            } else {
                if (scenario.equals("record")) {
                    // An explicit reply belongs to the spoken thread, even when automatic listening is off
                    // and another thread is pinned for ordinary manual recording.
                    command("updateSettings", NativeVoiceJson.object("expectedRevision", runtime.snapshot().getLong("settingsRevision"),
                        "patch", NativeVoiceJson.object("autoListen", false, "voiceThreadId", required(args, "secondThreadId"), "pinDefaultVoiceThread", true)));
                } else if (scenario.equals("next")) {
                    command("updateSettings", NativeVoiceJson.object("expectedRevision", runtime.snapshot().getLong("settingsRevision"),
                        "patch", NativeVoiceJson.object("autoListen", true)));
                }
                input("[data-testid=\"composer\"] textarea", initial);
                waitJs("!!document.querySelector('[aria-label=\"Send message\"]:not(:disabled)')", 15000); click("[aria-label=\"Send message\"]");
                waitJs("document.querySelector('[data-testid=\"composer\"] textarea')?.value === ''", 15000);
            }
            input("[data-testid=\"composer\"] textarea", draft);
            if (!scenario.equals("background") && !scenario.equals("background-switch") && !scenario.equals("record") && !scenario.equals("next") && !scenario.equals("stop") && !scenario.equals("retarget")) screenshot("active");
            if (scenario.equals("background") || scenario.equals("background-switch")) {
                if (scenario.equals("background-switch")) {
                    assertTrue("Save the source draft before backgrounding", awaitServerDraft(server, thread, draft, 15000));
                    screenshot("before-background-switch");
                }
                instrumentation.runOnMainSync(() -> activity.moveTaskToBack(true));
                await(() -> !runtime.snapshot().optJSONObject("foreground").optBoolean("visible"), 10000, "native background visibility");
                screenshot("background");
                if (scenario.equals("background-switch")) {
                    // Preserve genuine client/turn provenance without racing the UI's pause against the model's tool call.
                    // The loopback model invokes the real Sedes client.switch_thread tool for this submitted prompt.
                    submitRegisteredInput(server, thread, initial);
                    String destination = required(args, "secondThreadId");
                    await(() -> runtime.snapshot().optString("phase").equals("listening"), 60000, "agent-requested background recognition");
                    JSONObject state = runtime.snapshot();
                    assertFalse(state.getJSONObject("foreground").getBoolean("visible"));
                    assertEquals(destination, state.getJSONObject("active").getString("recognitionThreadId"));
                    assertTrue("The source reply must play before target recognition", speechPlayed.get());
                    assertEquals("Background commands must never request navigation", 0, navigationEvents.get());
                    backgroundSwitch = NativeVoiceJson.object("recognitionThreadId", destination, "foreground", false,
                        "replyPlayedBeforeRecognition", speechPlayed.get());
                }
            }
            if (scenario.equals("record") || scenario.equals("next")) {
                boolean record = scenario.equals("record");
                String action = record ? "Record" : "Next";
                await(() -> {
                    JSONObject state = runtime.snapshot();
                    return speechPlayed.get() && state.optString("phase").equals("speaking") &&
                        state.optJSONObject("actions").optBoolean(record ? "canRecordDuringPlayback" : "canSkip");
                }, 45000, "AudioTrack playback before " + action);
                JSONObject beforeAction = runtime.snapshot();
                assertEquals(thread, beforeAction.getJSONObject("active").getString("threadId"));
                assertEquals("Playback must precede recording", 0, supplied.get());
                playbackControl = NativeVoiceJson.object("action", action, "sourceThreadId", thread,
                    "autoListen", beforeAction.getJSONObject("settings").getBoolean("autoListen"));
                if (!record) releaseRequested.set(true);
                notificationAction(context, action);
                if (record) {
                    await(() -> runtime.snapshot().optString("phase").equals("listening"), 45000, "explicit reply after Record");
                    JSONObject state = runtime.snapshot(), active = state.getJSONObject("active"), settings = state.getJSONObject("settings");
                    assertEquals(thread, active.getString("recognitionThreadId"));
                    assertFalse("Record starts a fresh manual interaction", active.getBoolean("automatic"));
                    assertNotEquals(beforeAction.getJSONObject("active").getString("id"), active.getString("id"));
                    assertFalse(settings.getBoolean("autoListen"));
                    assertEquals(required(args, "secondThreadId"), settings.getString("voiceThreadId"));
                    assertTrue(settings.getBoolean("pinDefaultVoiceThread"));
                    NativeVoiceJson.put(playbackControl, "recognitionThreadId", active.getString("recognitionThreadId"));
                    NativeVoiceJson.put(playbackControl, "automatic", active.getBoolean("automatic"));
                    NativeVoiceJson.put(playbackControl, "voiceThreadId", settings.getString("voiceThreadId"));
                    NativeVoiceJson.put(playbackControl, "pinDefaultVoiceThread", settings.getBoolean("pinDefaultVoiceThread"));
                    screenshot("recording-reply");
                } else {
                    await(() -> {
                        JSONObject state = runtime.snapshot();
                        return itemReleased.get() && state.isNull("active") && state.optString("phase").equals("idle") &&
                            state.optJSONObject("queue").optInt("count") == 0;
                    }, 15000, "Next released playback and drained the interaction");
                    assertFalse("Next must skip automatic listening", phases.contains("listening"));
                    assertFalse("Next must not submit input", phases.contains("submitting"));
                    assertTrue(submittedInputs.isEmpty());
                    assertEquals("Next must not start audio capture", 0, supplied.get());
                    NativeVoiceJson.put(playbackControl, "released", itemReleased.get());
                }
            }
            if (scenario.equals("stop")) {
                await(() -> runtime.snapshot().optString("phase").equals("listening"), 45000, "recognition before Stop");
                releaseRequested.set(true); notificationAction(context, "Cancel");
                // A released item can no longer submit; wait for that terminal state instead of a fixed delay.
                await(itemReleased::get, 15000, "stopped recognition released its item");
                assertFalse(phases.contains("submitting"));
            } else if (!scenario.equals("next")) {
                if (scenario.equals("retarget")) {
                    String second = required(args, "secondThreadId");
                    await(() -> runtime.snapshot().optString("phase").equals("listening"), 45000, "recognition before retarget");
                    String retarget = "button[aria-label^=\"Change recording thread\"]:not(:disabled):not([aria-disabled=\"true\"])";
                    waitJs("document.querySelector(" + JSONObject.quote(retarget) + ") !== null", 15000);
                    click(retarget);
                    clickTextIn("[role=\"dialog\"] ul[aria-label=\"Voice threads\"]", args.getString("secondThreadTitle", second));
                    await(() -> second.equals(runtime.snapshot().optJSONObject("active").optString("recognitionThreadId")), 10000, "retarget applied");
                    screenshot("retargeted");
                }
                allowCaptureCompletion.set(true);
                await(() -> phases.contains("submitting"), 60000, "recognized text admission");
                if (recoveryScenario) {
                    // The first failed reconciliation releases the active slot; the journaled input stays in recovery.
                    await(() -> {
                        JSONObject state = runtime.snapshot(); JSONArray recovery = state.optJSONArray("recovery");
                        return state.isNull("active") && receiptReads.get() >= 1 && recovery.length() == 1 &&
                            recovery.optJSONObject(0).optString("status").equals("uncertain");
                    }, 15000, "uncertain input released into recovery after transport loss");
                    assertTrue("Checking submission precedes release", phases.contains("recovering"));
                    assertTrue("Released recovery leaves voice available", runtime.snapshot().optJSONObject("actions").optBoolean("canStart"));
                    String mutation = runtime.snapshot().optJSONArray("recovery").optJSONObject(0).optString("mutationId");
                    assertEquals(mutationIds.get(0), mutation);
                    screenshot("uncertain");
                    if (scenario.equals("cancel-uncertain")) {
                        // Leaving the binding persists cancellation intent; re-entering it reconciles read-only and never resends.
                        JSONObject bound = runtime.snapshot();
                        command("disconnect", new JSONObject());
                        command("setConnection", NativeVoiceJson.object("profileId", bound.optString("profileId"), "serverOrigin", server, "identity", bound.optString("identity")));
                        await(() -> {
                            JSONArray recovery = runtime.snapshot().optJSONArray("recovery");
                            return recovery.length() == 1 && recovery.optJSONObject(0).optBoolean("cancelled") && recovery.optJSONObject(0).optString("status").equals("uncertain");
                        }, 15000, "durable cancellation intent after re-entering the binding");
                        // A completed read-only reconciliation after re-entry is the positive signal that
                        // the runtime has processed the entry again without sending it.
                        int readsAfterReentry = receiptReads.get();
                        await(() -> receiptReads.get() > readsAfterReentry, 15000, "read-only reconciliation after re-entering the binding");
                        assertEquals(1, inputAttempts.get());
                        // Discard is the explicit resolution of an uncertain input.
                        command("discardInput", NativeVoiceJson.object("mutationId", mutation));
                        assertEquals(1, inputAttempts.get());
                    } else if (scenario.equals("lost-ack")) {
                        // The input reached Sedes; automatic read-only reconciliation finds its receipt without Resume.
                        allowReceipt.set(true);
                    } else {
                        // Nothing reached Sedes, so only an explicit Resume may send the same request again.
                        allowReceipt.set(true);
                        int reads = receiptReads.get();
                        await(() -> receiptReads.get() > reads, 15000, "automatic read-only reconciliation");
                        assertEquals(1, inputAttempts.get());
                        // Settings → Voice is reached through the voice card's quick sheet.
                        click("[aria-label=\"Open voice controls\"]"); clickText("All voice settings"); clickText("Resume input");
                    }
                }
                await(() -> runtime.snapshot().optJSONArray("recovery").length() == 0 && !runtime.snapshot().optString("phase").equals("submitting"), 45000, "definitive input receipt");
                if (recoveryScenario) {
                    assertEquals(scenario.equals("lost-send") ? 2 : 1, inputAttempts.get());
                    assertEquals(1, new java.util.HashSet<>(mutationIds).size());
                    js("(()=>{history.pushState({},''," + JSONObject.quote("/threads/" + thread) + ");window.dispatchEvent(new PopStateEvent('popstate'));return true})()");
                }
            }
            if (scenario.equals("background") || scenario.equals("background-switch")) {
                // MainActivity is singleTask: resume the existing instance instead of waiting for a new launch.
                instrumentation.runOnMainSync(() -> context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
                await(() -> runtime.snapshot().optJSONObject("foreground").optBoolean("visible"), 15000, "native foreground visibility after return");
                waitJs("document.visibilityState === 'visible'", 15000);
            }
            waitJs("document.querySelector('[data-testid=\"composer\"] textarea')?.value === " + JSONObject.quote(draft), 15000);
            if (scenario.equals("background-switch")) {
                assertEquals("One real background admission response", 1, backgroundReceipts.size());
                JSONObject receipt = backgroundReceipts.get(0);
                assertEquals(required(args, "secondThreadId"), receipt.getString("threadId"));
                assertEquals("submit", receipt.getString("admittedMode"));
                assertTrue(List.of("accepted", "queued", "submitting").contains(receipt.getString("status")));
                assertTrue("Background admission must not replay a transcript presentation event", submittedInputs.isEmpty());
                JSONObject settings = runtime.snapshot().getJSONObject("settings");
                assertFalse(settings.getBoolean("autoListen"));
                assertEquals(thread, settings.getString("voiceThreadId"));
                assertTrue(settings.getBoolean("pinDefaultVoiceThread"));
                assertEquals("Resuming must preserve the source screen", "true", js("location.pathname === " + JSONObject.quote("/threads/" + thread)));
                assertEquals("Resuming must not replay navigation", 0, navigationEvents.get());
                NativeVoiceJson.put(backgroundSwitch, "navigationEvents", navigationEvents.get());
                NativeVoiceJson.put(backgroundSwitch, "resumedPath", "/threads/" + thread);
                NativeVoiceJson.put(backgroundSwitch, "autoListen", settings.getBoolean("autoListen"));
                NativeVoiceJson.put(backgroundSwitch, "voiceThreadId", settings.getString("voiceThreadId"));
                NativeVoiceJson.put(backgroundSwitch, "pinDefaultVoiceThread", settings.getBoolean("pinDefaultVoiceThread"));
                NativeVoiceJson.put(backgroundSwitch, "inputPresentationEvents", submittedInputs.size());
                NativeVoiceJson.put(backgroundSwitch, "receipt", receipt);
            }
            JSONObject inputUi = null;
            if (scenario.equals("cycle")) {
                await(() -> !submittedInputs.isEmpty(), 15000, "local inputSubmitted event");
                assertEquals("One local voice Send", 1, submittedInputs.size());
                JSONObject submitted = submittedInputs.get(0);
                assertEquals(thread, submitted.getString("threadId"));
                inputUi = awaitSubmittedInputUi(submitted, mode.equals("manual"), 45000);
            }
            screenshot("settled");
            if (scenario.equals("next")) assertEquals("Next must leave capture unused", 0, supplied.get());
            else assertTrue("Capture did not traverse the deterministic audio source", supplied.get() > 0);
            if (mode.equals("response") && !scenario.equals("stop")) assertTrue("No actual AudioTrack playback phase", phases.contains("speaking"));
            // Report observations, not expectations; the host harness asserts them.
            boolean composerDraft = "true".equals(js("document.querySelector('[data-testid=\"composer\"] textarea')?.value === " + JSONObject.quote(draft)));
            boolean serverDraft = awaitServerDraft(server, thread, draft, 15000);
            JSONObject result = NativeVoiceJson.object("scenario", scenario, "mode", mode, "elapsedMs", SystemClock.elapsedRealtime() - began,
                "phases", new JSONArray(phases), "captureChunks", supplied.get(), "audioSource", supplied.get() > 0 ? "deterministic-pcm" : "none",
                "audioSink", trackPlayed.get() ? "AudioTrack" : "none", "speechPlayback", speechPlayed.get(),
                "draftPreserved", composerDraft && serverDraft, "composerDraftPreserved", composerDraft, "serverDraftPreserved", serverDraft,
                "journalOutstanding", runtime.snapshot().optJSONArray("recovery").length(),
                "inputAttempts", inputAttempts.get(), "receiptReads", receiptReads.get(), "mutationIds", new JSONArray(mutationIds),
                "screenshots", new JSONArray(screenshots));
            if (inputUi != null) NativeVoiceJson.put(result, "inputUi", inputUi);
            if (backgroundSwitch != null) NativeVoiceJson.put(result, "backgroundSwitch", backgroundSwitch);
            if (playbackControl != null) NativeVoiceJson.put(result, "playbackControl", playbackControl);
            Bundle resultBundle = new Bundle(); resultBundle.putString("voiceResult", result.toString()); instrumentation.sendStatus(0, resultBundle);
        } catch (Exception | AssertionError failure) {
            // Capture before cleanup turns voice Off and removes the state that explains the failure.
            try {
                JSONObject diagnostic = NativeVoiceJson.object("scenario", scenario, "mode", mode,
                    "threadId", thread, "elapsedMs", SystemClock.elapsedRealtime() - began,
                    "reason", failure.getMessage(), "phases", new JSONArray(phases),
                    "state", diagnosticState(runtime.snapshot()), "captureChunks", supplied.get(),
                    "audioTrackPlayed", trackPlayed.get(), "speechPlayback", speechPlayed.get(),
                    "inputAttempts", inputAttempts.get(), "receiptReads", receiptReads.get(),
                    "mutationIds", new JSONArray(mutationIds), "screenshots", new JSONArray(screenshots));
                try { NativeVoiceJson.put(diagnostic, "ui", diagnosticUiState()); }
                catch (Exception | AssertionError uiFailure) {
                    NativeVoiceJson.put(diagnostic, "ui", NativeVoiceJson.object("available", false));
                    failure.addSuppressed(uiFailure);
                }
                Bundle resultBundle = new Bundle(); resultBundle.putString("voiceFailure", diagnostic.toString());
                instrumentation.sendStatus(0, resultBundle);
            } catch (Exception | AssertionError diagnosticFailure) { failure.addSuppressed(diagnosticFailure); }
            throw failure;
        } finally {
            runtime.unobserve(observer);
            audioSampler.interrupt();
            JSONObject snapshot = runtime.snapshot();
            CountDownLatch stopped = new CountDownLatch(1);
            if (startupPrepared) {
                // Preserve only saved configuration; the host kills the process before the restore stage.
                command("disconnect", new JSONObject()); stopped.countDown();
            } else if (!snapshot.isNull("identity")) runtime.command("updateSettings", NativeVoiceJson.object("expectedRevision", snapshot.optLong("settingsRevision"),
                "patch", NativeVoiceJson.object("audioMode", "off")), false, new NativeVoiceRuntime.Reply() {
                    public void done(JSONObject ignored) { stopped.countDown(); } public void failed(String code, String message) { stopped.countDown(); } });
            else stopped.countDown();
            stopped.await(10, TimeUnit.SECONDS); NativeVoiceAudio.setTestSource(null); NativeVoiceHttp.setTestTransport(null);
            instrumentation.runOnMainSync(activity::finish);
        }
    }
    /** The runtime owns its audio engine privately; its debug-only track accessor exposes real playback. */
    private static NativeVoiceAudio runtimeAudio(NativeVoiceRuntime runtime) throws Exception {
        java.lang.reflect.Field field = NativeVoiceRuntime.class.getDeclaredField("audio");
        field.setAccessible(true);
        return (NativeVoiceAudio) field.get(runtime);
    }
    /** Samples faster than the shortest cue lasts, recording only a track whose playback head advanced. */
    private static Thread playbackSampler(NativeVoiceAudio audio, AtomicReference<String> phase, AtomicBoolean played, AtomicBoolean speech) {
        Thread sampler = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    AudioTrack track = audio.trackForTest();
                    if (track != null && track.getPlayState() == AudioTrack.PLAYSTATE_PLAYING && (track.getPlaybackHeadPosition() & 0xffffffffL) > 0) {
                        played.set(true);
                        if ("speaking".equals(phase.get())) speech.set(true);
                    }
                } catch (IllegalStateException released) { /* Released between reads; the next sample sees its replacement. */ }
                try { Thread.sleep(10); } catch (InterruptedException stopped) { return; }
            }
        }, "native-voice-e2e-playback-sampler");
        sampler.setDaemon(true);
        sampler.start();
        return sampler;
    }
    /** Start a real source turn while backgrounded, retaining this device's authenticated client provenance. */
    private void submitRegisteredInput(String server, String thread, String text) throws Exception {
        JSONObject state = runtime.snapshot();
        String credential = new ClientCredentialStore(instrumentation.getTargetContext()).getCredential(state.getString("profileId"), server);
        assertNotNull("No stored credential for the paired server", credential);
        assertTrue("Background request requires the existing ready service", state.getBoolean("ready"));
        assertFalse("Submit only after the activity has backgrounded", state.getJSONObject("foreground").getBoolean("visible"));
        String csrf = runtime.clientCsrf();
        assertNotNull("The ready native session must have its CSRF token", csrf);
        NativeVoiceHttp http = new NativeVoiceHttp();
        http.clientRegistration(server, credential, state.getString("clientConnectionToken"));
        CountDownLatch done = new CountDownLatch(1); AtomicInteger status = new AtomicInteger();
        AtomicReference<JSONObject> body = new AtomicReference<>(); AtomicReference<String> failure = new AtomicReference<>();
        http.request(server, credential, csrf, "POST", "/api/threads/" + thread + "/inputs",
            NativeVoiceJson.object("mutationId", java.util.UUID.randomUUID().toString(), "text", text, "runningPolicy", NativeVoiceJson.object("mode", "queue")),
            (code, value, error) -> { status.set(code); body.set(value); failure.set(error); done.countDown(); });
        assertTrue("Source prompt admission did not finish", done.await(45, TimeUnit.SECONDS));
        assertNull(failure.get()); assertEquals(200, status.get()); assertNotNull(body.get());
        assertEquals(thread, body.get().getString("threadId"));
        assertTrue("Source prompt must be admitted", List.of("accepted", "queued", "submitting").contains(body.get().getString("status")));
    }
    /** The composer autosaves after a debounce, so poll Sedes itself for the persisted draft. */
    private boolean awaitServerDraft(String server, String thread, String expected, long timeout) throws Exception {
        String credential = new ClientCredentialStore(instrumentation.getTargetContext()).getCredential(runtime.snapshot().optString("profileId"), server);
        assertNotNull("No stored credential for the paired server", credential);
        NativeVoiceHttp http = new NativeVoiceHttp();
        long end = SystemClock.elapsedRealtime() + timeout;
        while (true) {
            CountDownLatch done = new CountDownLatch(1); AtomicReference<JSONObject> body = new AtomicReference<>(); AtomicInteger status = new AtomicInteger();
            AtomicReference<String> readFailure = new AtomicReference<>();
            http.request(server, credential, null, "GET", "/api/threads/" + thread + "?activityDetail=summary", null, (code, value, failure) -> { status.set(code); body.set(value); readFailure.set(failure); done.countDown(); });
            assertTrue("Thread read did not finish", done.await(45, TimeUnit.SECONDS));
            JSONObject draft = status.get() == 200 && body.get() != null ? body.get().optJSONObject("draft") : null;
            boolean matches = draft != null && expected.equals(draft.optString("text"));
            if (matches || SystemClock.elapsedRealtime() >= end) {
                Bundle diagnostic = new Bundle();
                diagnostic.putString("voiceDraftRead", NativeVoiceJson.object("status", status.get(), "failure", readFailure.get(),
                    "hasDraft", draft != null, "matches", matches, "responseCharacters", body.get() == null ? 0 : body.get().toString().length()).toString());
                instrumentation.sendStatus(0, diagnostic);
                return matches;
            }
            SystemClock.sleep(250);
        }
    }
    private JSONObject diagnosticUiState() throws Exception {
        return new JSONObject(js("(()=>{const l=Array.from(document.querySelectorAll('label')).find(x=>x.textContent.trim()==='Audio mode');"
            + "const e=l?document.getElementById(l.htmlFor):null;const present=e instanceof HTMLSelectElement;"
            + "return {available:true,audioMode:{present,disabled:present?e.matches(':disabled'):null,"
            + "value:present&&['off','manual','response'].includes(e.value)?e.value:null},"
            + "alertCount:document.querySelectorAll('[role=alert]').length}})()"));
    }
    /** Observe the real transcript destination and scroll geometry, independently of the native receipt event. */
    private JSONObject awaitSubmittedInputUi(JSONObject submitted, boolean seekEnabled, long timeout) throws Exception {
        String operationId = submitted.getString("operationId");
        String selector = "[role=\"region\"][aria-label=\"Messages\"] [data-message-role=\"user\"][data-delivery-operation-id=\"" + operationId + "\"]";
        String read = "(()=>{const rows=document.querySelectorAll(" + JSONObject.quote(selector) + ");const row=rows[0];"
            + "const viewport=row?.closest('[aria-label=\"Messages\"]');const spacer=viewport?.querySelector('[data-testid=\"seek-spacer\"]');"
            + "return {rowCount:rows.length,operationId:row?.getAttribute('data-delivery-operation-id')??null,"
            + "text:row?.textContent?.trim()??null,provisional:row?.getAttribute('data-client-provisional')==='true',"
            + "routineLabelCount:row?.querySelectorAll('[data-submission-phase]').length??null,"
            + "seekEnabled:localStorage.getItem('sedes-seek-on-submit')==='true',"
            + "spacerHeight:spacer?.getBoundingClientRect().height??null,scrollTop:viewport?.scrollTop??null,"
            + "viewportHeight:viewport?.clientHeight??null,targetInset:row&&viewport?row.getBoundingClientRect().top-viewport.getBoundingClientRect().top:null}})()";
        long end = SystemClock.elapsedRealtime() + timeout;
        JSONObject observed;
        do {
            observed = new JSONObject(js(read));
            boolean matched = observed.optInt("rowCount") == 1 && !observed.optBoolean("provisional") &&
                observed.optInt("routineLabelCount", -1) == 0 && observed.optBoolean("seekEnabled") == seekEnabled;
            boolean positioned = seekEnabled
                ? observed.optDouble("spacerHeight", 0) > 0 && Math.abs(observed.optDouble("targetInset", -1000) - 16) <= 3
                : observed.optDouble("spacerHeight", -1) == 0;
            if (matched && positioned) {
                NativeVoiceJson.put(observed, "submitted", submitted);
                return observed;
            }
            SystemClock.sleep(100);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Local voice Send did not reach its transcript destination: " + observed);
        return null;
    }
    private static JSONObject diagnosticState(JSONObject state) {
        JSONObject result = select(state, "connectionGeneration", "stateRevision", "settingsRevision", "originClientId", "phase", "ready", "readiness", "queue", "actions");
        NativeVoiceJson.put(result, "settings", select(state.optJSONObject("settings"), "audioMode", "autoListen", "ignoreOtherDevices",
            "onlyVoiceThread", "voiceThreadId", "pinDefaultVoiceThread", "followComposerMode", "recognitionCues"));
        NativeVoiceJson.put(result, "active", select(state.optJSONObject("active"), "id", "eventKind", "threadId", "recognitionThreadId", "automatic"));
        NativeVoiceJson.put(result, "foreground", select(state.optJSONObject("foreground"), "visible", "threadId"));
        JSONArray errors = state.optJSONArray("errors"), codes = new JSONArray();
        if (errors != null) for (int i = 0; i < errors.length(); i++) codes.put(select(errors.optJSONObject(i), "code"));
        NativeVoiceJson.put(result, "errors", codes);
        JSONArray recovery = state.optJSONArray("recovery"), pending = new JSONArray();
        if (recovery != null) for (int i = 0; i < recovery.length(); i++) pending.put(select(recovery.optJSONObject(i), "mutationId", "threadId", "status", "cancelled"));
        NativeVoiceJson.put(result, "recovery", pending);
        return result;
    }
    private static JSONObject select(JSONObject source, String... keys) {
        if (source == null) return null;
        JSONObject result = new JSONObject();
        for (String key : keys) if (source.has(key)) NativeVoiceJson.put(result, key, source.opt(key));
        return result;
    }
    private void screenshot(String phase) throws Exception {
        File directory = new File(instrumentation.getTargetContext().getExternalFilesDir(null), "native-voice");
        assertTrue("Screenshot directory unavailable", directory.isDirectory() || directory.mkdirs());
        File output = new File(directory, runLabel + "-" + phase + ".png");
        Bitmap bitmap = instrumentation.getUiAutomation().takeScreenshot(); assertNotNull("Screenshot unavailable", bitmap);
        try (FileOutputStream stream = new FileOutputStream(output)) { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)); }
        finally { bitmap.recycle(); }
        screenshots.add(output.getAbsolutePath());
    }
    private JSONObject command(String action, JSONObject args) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<JSONObject> value = new AtomicReference<>(); AtomicReference<String> error = new AtomicReference<>();
        runtime.command(action, args, true, new NativeVoiceRuntime.Reply() {
            public void done(JSONObject result) { value.set(result); done.countDown(); }
            public void failed(String code, String message) { error.set(code); done.countDown(); }
        });
        assertTrue("Native command did not finish: " + action, done.await(30, TimeUnit.SECONDS)); assertNull(error.get()); return value.get();
    }
    private static String required(Bundle args, String name) { String value = args.getString(name); if (value == null) throw new IllegalArgumentException("Missing instrumentation argument " + name); return value; }
    private static void await(BooleanSupplier condition, long timeout, String description) {
        long end = SystemClock.elapsedRealtime() + timeout;
        while (!condition.getAsBoolean() && SystemClock.elapsedRealtime() < end) SystemClock.sleep(50);
        assertTrue("Timed out waiting for " + description, condition.getAsBoolean());
    }
    private String js(String source) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<String> value = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> web.evaluateJavascript("(()=>{" + "return (" + source + ");})()", result -> { value.set(result); done.countDown(); }));
        assertTrue("WebView JavaScript did not return", done.await(15, TimeUnit.SECONDS)); return value.get();
    }
    private void waitJs(String condition, long timeout) throws Exception {
        long end = SystemClock.elapsedRealtime() + timeout;
        while (SystemClock.elapsedRealtime() < end) { if ("true".equals(js(condition))) return; SystemClock.sleep(100); }
        fail("Timed out waiting for UI: " + condition + "; body=" + js("document.body.innerText.slice(0,1800)"));
    }
    private void click(String selector) throws Exception {
        assertEquals("true", js("(()=>{const e=document.querySelector(" + JSONObject.quote(selector) + ");if(!e||e.disabled)return false;e.click();return true})()"));
    }
    private void clickText(String text) throws Exception {
        clickTextIn("body", text);
    }
    private void clickTextIn(String scopeSelector, String text) throws Exception {
        String buttons = "Array.from(document.querySelector(" + JSONObject.quote(scopeSelector) + ")?.querySelectorAll('button') ?? [])";
        waitJs(buttons + ".some(x=>x.textContent.trim()===" + JSONObject.quote(text) + "&&!x.disabled)", 15000);
        assertEquals("true", js("(()=>{const e=" + buttons + ".find(x=>x.textContent.trim()===" + JSONObject.quote(text) + "&&!x.disabled);if(!e)return false;e.click();return true})()"));
    }
    private void input(String selector, String value) throws Exception {
        assertEquals("true", js("(()=>{const e=document.querySelector(" + JSONObject.quote(selector) + ");if(!e)return false;const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e," + JSONObject.quote(value) + ");e.dispatchEvent(new Event('input',{bubbles:true}));return true})()"));
    }
    private void inputByLabel(String label, String value) throws Exception {
        assertEquals("true", js("(()=>{const l=Array.from(document.querySelectorAll('label')).find(x=>x.textContent.trim()===" + JSONObject.quote(label) + ");const e=document.getElementById(l.htmlFor);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e," + JSONObject.quote(value) + ");e.dispatchEvent(new Event('input',{bubbles:true}));return true})()"));
    }
    private void saveSpeechSetting(String label, String field, String value) throws Exception {
        waitJs("(()=>{const l=Array.from(document.querySelectorAll('label')).find(x=>x.textContent.trim()===" + JSONObject.quote(label)
            + ");const e=l?document.getElementById(l.htmlFor):null;return e instanceof HTMLInputElement&&!e.disabled})()", 15000);
        inputByLabel(label, value); click("[aria-label=\"Save " + label + "\"]");
        await(() -> value.equals(runtime.snapshot().optJSONObject("settings").optString(field)), 15000, "speech setting saved: " + field);
    }
    private void chooseSpeechSetting(String label, String field, String value) throws Exception {
        // Discovery requires the native credential. Model changes refresh the catalog before the next choice.
        await(() -> "ready".equals(runtime.snapshot().optJSONObject("speech").optString("catalogStatus")), 15000, "speech choices ready: " + label);
        String trigger = "button[role=\"combobox\"][aria-label=\"" + label + "\"]";
        waitJs("(()=>{const e=document.querySelector(" + JSONObject.quote(trigger) + ");return e instanceof HTMLButtonElement&&!e.disabled})()", 15000);
        click(trigger);
        String search = "input[role=\"combobox\"][aria-label=\"Search " + label.toLowerCase(java.util.Locale.ROOT) + " options\"]";
        waitJs("document.querySelector(" + JSONObject.quote(search) + ") !== null", 15000);
        input(search, value);
        clickTextIn("[role=\"listbox\"][aria-label=\"" + label + " options\"]", value);
        await(() -> value.equals(runtime.snapshot().optJSONObject("settings").optString(field)), 15000, "speech choice saved: " + field);
        waitJs("document.querySelector(" + JSONObject.quote(trigger) + ")?.getAttribute('aria-expanded') === 'false'", 15000);
    }
    private void selectByLabel(String label, String value) throws Exception {
        String lookup = "const l=Array.from(document.querySelectorAll('label')).find(x=>x.textContent.trim()===" + JSONObject.quote(label)
            + ");const e=l?document.getElementById(l.htmlFor):null;const o=e instanceof HTMLSelectElement?Array.from(e.options).find(x=>x.value==="
            + JSONObject.quote(value) + "):null;";
        String enabled = "e instanceof HTMLSelectElement&&!e.matches(':disabled')&&o&&!o.disabled&&!o.closest('optgroup[disabled]')";
        waitJs("(()=>{" + lookup + "return Boolean(" + enabled + ")})()", 15000);
        // Recheck in the same JavaScript turn as the action; a preceding save may still own the controls.
        assertEquals("true", js("(()=>{" + lookup + "if(!(" + enabled + "))return false;e.value=" + JSONObject.quote(value)
            + ";e.dispatchEvent(new Event('change',{bubbles:true}));return true})()"));
    }
    private static void notificationAction(Context context, String title) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        while (SystemClock.elapsedRealtime() < deadline) {
            for (StatusBarNotification notification : context.getSystemService(NotificationManager.class).getActiveNotifications()) {
                if (notification.getNotification().actions != null) for (Notification.Action action : notification.getNotification().actions)
                    if (title.contentEquals(action.title)) { action.actionIntent.send(); return; }
                if (notification.getNotification().bigContentView != null && (title.equals("Stop") || title.equals("Record") || title.equals("Next"))) {
                    AtomicBoolean clicked = new AtomicBoolean();
                    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                        View view = notification.getNotification().bigContentView.apply(context, null);
                        View button = view.findViewById(title.equals("Stop") ? R.id.voice_notification_stop :
                            title.equals("Record") ? R.id.voice_notification_record : R.id.voice_notification_next);
                        if (button instanceof android.widget.TextView && button.getVisibility() == View.VISIBLE && button.isEnabled() &&
                            title.contentEquals(((android.widget.TextView) button).getText())) clicked.set(button.performClick());
                    });
                    if (clicked.get()) return;
                }
            }
            SystemClock.sleep(50);
        }
        fail("Notification action missing: " + title);
    }
}
