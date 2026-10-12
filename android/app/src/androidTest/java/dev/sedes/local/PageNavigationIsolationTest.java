package dev.sedes.local;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebViewClient;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** Proves the CSP navigation boundary on real WebView, without relying on its
 * shouldOverrideUrlLoading callback (which omits HTTP child navigations). */
public final class PageNavigationIsolationTest {
    @Test(timeout = 30_000)
    public void wrapperAllowsLocalScriptsButBlocksChildHttpNavigationBeforeTheRequest() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        CountDownLatch executed = new CountDownLatch(1);
        CountDownLatch policyBlocked = new CountDownLatch(1);
        CountDownLatch leaked = new CountDownLatch(1);
        AtomicBoolean closed = new AtomicBoolean();
        AtomicReference<Throwable> serverFailure = new AtomicReference<>();
        AtomicReference<SedesWebView> view = new AtomicReference<>();
        try (ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))) {
            String origin = "http://127.0.0.1:" + server.getLocalPort();
            Thread responder = new Thread(() -> {
                while (!closed.get()) {
                    try (Socket socket = server.accept()) {
                        BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                        String request = input.readLine();
                        if (request == null) continue;
                        if (request.startsWith("GET /leak ")) leaked.countDown();
                        String line;
                        while ((line = input.readLine()) != null && !line.isEmpty()) { }
                        String child = "<script>console.log('page-script-ran');setTimeout(()=>location.href='" + origin + "/leak',25)</script>";
                        String encoded = child.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;");
                        byte[] body = ("<!doctype html><iframe sandbox=\"allow-scripts\" srcdoc=\"" + encoded + "\"></iframe>").getBytes(StandardCharsets.UTF_8);
                        String headers = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
                            "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts\r\n" +
                            "Content-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
                        socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
                        socket.getOutputStream().write(body);
                        socket.getOutputStream().flush();
                    } catch (Exception failure) {
                        if (!closed.get()) serverFailure.set(failure);
                        return;
                    }
                }
            }, "page-navigation-fixture");
            responder.setDaemon(true);
            responder.start();
            instrumentation.runOnMainSync(() -> {
                SedesWebView web = new SedesWebView(instrumentation.getTargetContext(), null);
                view.set(web);
                web.getSettings().setJavaScriptEnabled(true);
                // Deliberately use the unmodified callback implementation.
                web.setWebViewClient(new WebViewClient());
                web.setWebChromeClient(new WebChromeClient() {
                    @Override public boolean onConsoleMessage(ConsoleMessage message) {
                        if (message.message().contains("page-script-ran")) executed.countDown();
                        if (message.message().contains("frame-src")) policyBlocked.countDown();
                        return true;
                    }
                });
                web.loadUrl(origin + "/wrapper");
            });
            try {
                assertTrue("Local child JavaScript did not execute", executed.await(10, TimeUnit.SECONDS));
                assertTrue("The parent frame policy did not reject HTTP navigation", policyBlocked.await(10, TimeUnit.SECONDS));
                assertFalse("The rejected navigation reached the HTTP server", leaked.await(300, TimeUnit.MILLISECONDS));
                assertNull(serverFailure.get());
            } finally {
                instrumentation.runOnMainSync(() -> view.get().destroy());
                closed.set(true);
                server.close();
                responder.join(1_000);
            }
        }
    }
}
