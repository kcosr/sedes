package dev.sedes.local;

import android.content.Context;
import android.util.AttributeSet;
import com.getcapacitor.CapacitorWebView;

/**
 * Native methods must never be exposed to every frame in this WebView.
 * Capacitor's origin-scoped WebMessageListener is the only admitted bridge.
 * Denying registrations here also denies its legacy fallback, without a race
 * between page loading and removing a previously registered interface.
 */
public final class SedesWebView extends CapacitorWebView {
    private boolean rejectedLegacyBridge;
    public SedesWebView(Context context, AttributeSet attributes) {
        super(context, attributes);
    }

    @Override
    public void addJavascriptInterface(Object object, String name) {
        // Deliberately do not call super, including for unknown future plugins.
        if ("androidBridge".equals(name)) rejectedLegacyBridge = true;
    }

    public boolean hasRejectedLegacyBridge() { return rejectedLegacyBridge; }
}
