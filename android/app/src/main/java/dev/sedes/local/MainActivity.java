package dev.sedes.local;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClientCredentialsPlugin.class);
        registerPlugin(OutputImageActionsPlugin.class);
        registerPlugin(WorkspaceFileDownloadPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
