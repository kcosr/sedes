package dev.sedes.local;

import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.plugin.SystemBars;

/** Keep child documents from invoking native external-protocol handlers.
 * HTTP child navigation is enforced by the trusted wrapper's frame-src CSP;
 * Android does not report those navigations to shouldOverrideUrlLoading. */
public final class SedesWebViewClient extends BridgeWebViewClient {
    private final Bridge bridge;

    public SedesWebViewClient(Bridge bridge) { super(bridge); this.bridge = bridge; }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame()) {
            String scheme = request.getUrl().getScheme();
            return !("http".equals(scheme) || "https".equals(scheme) || "about".equals(scheme));
        }
        return super.shouldOverrideUrlLoading(view, request);
    }

    @Override
    public void onPageCommitVisible(WebView view, String url) {
        super.onPageCommitVisible(view, url);
        // Replace SystemBars' all-frame raw onDOMReady hook with this native,
        // main-document lifecycle call. The ordinary plugin channel is retained.
        PluginHandle handle = bridge.getPlugin("SystemBars");
        if (handle != null && handle.getInstance() instanceof SystemBars) {
            ((SystemBars) handle.getInstance()).onDOMReady();
        }
    }
}
