package dev.sedes.local;

import android.os.Bundle;
import android.content.Intent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClientCredentialsPlugin.class);
        registerPlugin(OutputImageActionsPlugin.class);
        registerPlugin(WorkspaceFileDownloadPlugin.class);
        registerPlugin(NativeVoicePlugin.class);
        super.onCreate(savedInstanceState);
        openVoiceThread(getIntent());
    }
    @Override public void onResume() { super.onResume(); NativeVoiceRuntime.get(this).nativeVisibility(true); }
    @Override public void onPause() { NativeVoiceRuntime.get(this).nativeVisibility(false); super.onPause(); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); openVoiceThread(intent); }
    private void openVoiceThread(Intent intent) {
        if (intent != null && NativeVoiceRuntimeService.ACTION_OPEN.equals(intent.getAction()))
            NativeVoiceRuntime.get(this).openThread(intent.getStringExtra("voiceThreadId"), intent.getStringExtra("voiceProfileId"),
                intent.getStringExtra("voiceServerOrigin"), intent.getStringExtra("voiceIdentity"));
    }
}
