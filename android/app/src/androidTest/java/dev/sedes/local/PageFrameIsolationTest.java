package dev.sedes.local;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Assume;
import org.junit.Test;
import org.json.JSONObject;

/** Runs on a real Android System WebView without a server or provider account. */
public final class PageFrameIsolationTest {
    public static final class ForbiddenInterface {
        @JavascriptInterface public String readSecret() { return "must-not-be-readable"; }
    }

    @Test(timeout = 30_000)
    public void actualApplicationRetainsTheMainFramePluginAndCredentialChannels() throws Exception {
        Assume.assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER));
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(new Intent(
            instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        WebView view = activity.getBridge().getWebView();
        assertTrue(view instanceof SedesWebView);
        assertTrue(activity.getBridge().getWebViewClient() instanceof SedesWebViewClient);
        String identifier = UUID.randomUUID().toString();
        String key = "page-isolation-test-" + identifier;
        try {
            long deadline = SystemClock.elapsedRealtime() + 15_000;
            while (!"true".equals(evaluate(instrumentation, view, "typeof window.Capacitor?.nativePromise === 'function'"))) {
                assertTrue("The actual application bridge did not initialize", SystemClock.elapsedRealtime() < deadline);
                SystemClock.sleep(50);
            }
            evaluate(instrumentation, view, "void (async()=>{try{" +
                "const capability=await Capacitor.nativePromise('PageSafety','capabilities',{});" +
                "if(capability.safeFrames!==true)throw new Error('unsafe-frame-host');" +
                "await Capacitor.nativePromise('Preferences','set',{key:'" + key + "',value:'checked'});" +
                "const saved=await Capacitor.nativePromise('Preferences','get',{key:'" + key + "'});" +
                "if(saved.value!=='checked')throw new Error('preference-roundtrip');" +
                "const credentials=await Capacitor.nativePromise('ClientCredentials','getCredential',{profileId:'" + identifier + "',serverUrl:'https://page-safety.invalid'});" +
                "if(credentials.credential!==null)throw new Error('unexpected-credential');" +
                "window.pageIsolationTestResult='passed';" +
                "}catch(error){window.pageIsolationTestResult=String(error.message);}finally{" +
                "await Capacitor.nativePromise('Preferences','remove',{key:'" + key + "'});" +
                "}})()");
            while ("undefined".equals(evaluate(instrumentation, view, "typeof window.pageIsolationTestResult"))) {
                assertTrue("The actual application plugin round-trip timed out", SystemClock.elapsedRealtime() < deadline);
                SystemClock.sleep(50);
            }
            assertEquals("\"passed\"", evaluate(instrumentation, view, "window.pageIsolationTestResult"));
        } finally {
            evaluate(instrumentation, view, "void Capacitor.nativePromise('Preferences','remove',{key:" + JSONObject.quote(key) + "})");
            instrumentation.runOnMainSync(activity::finish);
        }
    }

    private static String evaluate(Instrumentation instrumentation, WebView view, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue("JavaScript evaluation timed out", done.await(5, TimeUnit.SECONDS));
        return result.get();
    }

    @Test(timeout = 30_000)
    public void rawInterfacesAreAbsentAndTheModernChannelIdentifiesSubframes() throws Exception {
        Assume.assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER));
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        AtomicReference<SedesWebView> reference = new AtomicReference<>();
        List<String> accepted = new CopyOnWriteArrayList<>();
        AtomicInteger denied = new AtomicInteger();
        CountDownLatch finished = new CountDownLatch(3);
        instrumentation.runOnMainSync(() -> {
            SedesWebView view = new SedesWebView(instrumentation.getTargetContext(), null);
            reference.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            // Include an unknown future plugin name as well as current hooks.
            for (String name : new String[] { "androidBridge", "CapacitorCookiesAndroidInterface", "CapacitorHttpAndroidInterface", "CapacitorSystemBarsAndroidInterface", "unknownFutureInterface" }) {
                view.addJavascriptInterface(new ForbiddenInterface(), name);
            }
            WebViewCompat.addWebMessageListener(view, "modernBridge", Collections.singleton("https://trusted.invalid"),
                (web, message, origin, isMainFrame, reply) -> {
                    if (isMainFrame && "https://trusted.invalid".equals(origin.toString())) accepted.add(message.getData());
                    else denied.incrementAndGet();
                    finished.countDown();
                });
            String html = "<!doctype html><html><body><script>" +
                "modernBridge.postMessage(['main',typeof androidBridge,typeof CapacitorCookiesAndroidInterface,typeof CapacitorHttpAndroidInterface,typeof CapacitorSystemBarsAndroidInterface,typeof unknownFutureInterface].join(':'));" +
                "addEventListener('message',e=>modernBridge.postMessage(e.data));" +
                "</script>" +
                "<iframe sandbox=\"allow-scripts\" srcdoc=\"&lt;script&gt;parent.postMessage('opaque:'+typeof modernBridge+':'+typeof unknownFutureInterface,'*')&lt;/script&gt;\"></iframe>" +
                "<iframe srcdoc=\"&lt;script&gt;modernBridge.postMessage('child')&lt;/script&gt;\"></iframe>" +
                "</body></html>";
            view.loadDataWithBaseURL("https://trusted.invalid/", html, "text/html", "UTF-8", null);
        });
        try {
            assertTrue("The WebView did not complete its bridge isolation probes", finished.await(20, TimeUnit.SECONDS));
            assertEquals(1, denied.get());
            assertTrue(accepted.contains("main:undefined:undefined:undefined:undefined:undefined"));
            assertTrue(accepted.contains("opaque:undefined:undefined"));
            assertFalse(accepted.contains("child"));
        } finally {
            instrumentation.runOnMainSync(() -> reference.get().destroy());
        }
    }
}
