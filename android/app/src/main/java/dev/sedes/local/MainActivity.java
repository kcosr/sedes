package dev.sedes.local;

import android.os.Bundle;
import android.content.Intent;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClientCredentialsPlugin.class);
        registerPlugin(OutputImageActionsPlugin.class);
        registerPlugin(WorkspaceFileDownloadPlugin.class);
        registerPlugin(NativeVoicePlugin.class);
        registerPlugin(PageSafetyPlugin.class);
        super.onCreate(savedInstanceState);
        openVoiceThread(getIntent());
    }

    @Override
    protected void load() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            CapConfig.loadDefault(this).isUsingLegacyBridge()) {
            showWebViewUpdateRequired();
            return;
        }
        super.load();
        if (!(getBridge().getWebView() instanceof SedesWebView) ||
            ((SedesWebView) getBridge().getWebView()).hasRejectedLegacyBridge()) {
            getBridge().getWebView().stopLoading();
            getBridge().onDestroy();
            getBridge().onDetachedFromWindow();
            bridge = null;
            showWebViewUpdateRequired();
            return;
        }
        getBridge().setWebViewClient(new SedesWebViewClient(getBridge()));
    }

    private void showWebViewUpdateRequired() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        panel.setPadding(padding, padding, padding, padding);
        TextView title = new TextView(this);
        title.setText("Update Android System WebView");
        title.setTextSize(22);
        panel.addView(title);
        TextView explanation = new TextView(this);
        explanation.setText("Sedes requires secure, main-frame WebView messaging. Update Android System WebView or Chrome, then retry. Legacy bridge configuration is unsupported.");
        panel.addView(explanation);
        Button retry = new Button(this);
        retry.setText("Retry");
        retry.setOnClickListener(view -> recreate());
        panel.addView(retry);
        setContentView(panel, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }
    @Override public void onResume() { super.onResume(); NativeVoiceRuntime.get(this).nativeVisibility(true); }
    @Override public void onPause() { NativeVoiceRuntime.get(this).nativeVisibility(false); super.onPause(); }
    // A permission result can mark the activity visible while STARTED; stopping always ends that visibility.
    @Override public void onStop() { NativeVoiceRuntime.get(this).nativeVisibility(false); super.onStop(); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); openVoiceThread(intent); }
    private void openVoiceThread(Intent intent) {
        if (intent != null && NativeVoiceRuntimeService.ACTION_OPEN.equals(intent.getAction()))
            NativeVoiceRuntime.get(this).openThread(intent.getStringExtra("voiceThreadId"), intent.getStringExtra("voiceProfileId"),
                intent.getStringExtra("voiceServerOrigin"), intent.getStringExtra("voiceIdentity"));
    }
}
