package dev.sedes.local;

import androidx.webkit.WebViewFeature;
import java.util.Collections;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PageSafety")
public final class PageSafetyPlugin extends Plugin {
    private boolean supportsFrames() {
        return getBridge().getWebView() instanceof SedesWebView &&
            !((SedesWebView) getBridge().getWebView()).hasRejectedLegacyBridge() &&
            getBridge().getWebViewClient() instanceof SedesWebViewClient &&
            getBridge().getAllowedOriginRules().equals(Collections.singleton("http://localhost")) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            !getBridge().getConfig().isUsingLegacyBridge();
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        // Receiving this call proves that the modern bridge actually registered:
        // SedesWebView denies the raw Java interface fallback from construction.
        JSObject result = new JSObject();
        result.put("safeFrames", supportsFrames());
        call.resolve(result);
    }

}
