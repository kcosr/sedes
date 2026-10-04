package dev.sedes.local;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

/** The secret is entered in a native view and is never returned to JavaScript, including on failure. */
final class NativeSpeechCredentialDialog {
    interface Host { void action(String action, String secret, NativeVoiceRuntime.Reply reply); }
    private final AlertDialog dialog;
    private final EditText secret;
    private final TextView status;
    private final Button save, test, remove;
    private final Host host;
    private boolean busy;

    NativeSpeechCredentialDialog(Activity activity, String provider, String endpoint, boolean configured, Host host, Runnable dismissed) {
        this.host = host;
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * activity.getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding / 2, padding, 0);
        TextView destination = new TextView(activity);
        destination.setText(endpoint + "\n" + (configured ? "A credential is saved on this device." : "No credential is saved on this device."));
        content.addView(destination);
        secret = new EditText(activity);
        secret.setHint(provider.equals("openai") ? "OpenAI API key" : "Server bearer token");
        secret.setContentDescription(secret.getHint());
        secret.setSingleLine(true);
        secret.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        secret.setImeOptions(EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        secret.setSaveEnabled(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) secret.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        content.addView(secret);
        status = new TextView(activity);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setText("Test checks access to the model list. It does not generate speech.");
        content.addView(status);
        LinearLayout actions = new LinearLayout(activity);
        save = button(activity, actions, "Save", "save");
        test = button(activity, actions, "Test", "test");
        remove = button(activity, actions, "Remove", "remove");
        remove.setEnabled(configured);
        content.addView(actions);
        dialog = new AlertDialog.Builder(activity).setTitle(provider.equals("openai") ? "OpenAI speech credential" : "Speech server credential")
            .setView(content).setNegativeButton("Close", (ignored, which) -> {}).create();
        dialog.setOnDismissListener(ignored -> { secret.getText().clear(); dismissed.run(); });
    }
    private Button button(Activity activity, LinearLayout row, String label, String action) {
        Button button = new Button(activity); button.setText(label);
        button.setOnClickListener(ignored -> perform(activity, action)); row.addView(button); return button;
    }
    void show() {
        if (dialog.getWindow() != null) dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.show();
    }
    void dismiss() { dialog.dismiss(); }
    private void perform(Activity activity, String action) {
        if (busy) return;
        String entered = secret.getText().toString();
        if (action.equals("save") && entered.isEmpty()) { status.setText("Enter a credential before saving."); return; }
        String submitted = action.equals("remove") || entered.isEmpty() ? null : entered;
        busy = true; save.setEnabled(false); test.setEnabled(false); remove.setEnabled(false);
        secret.setEnabled(false); status.setText(action.equals("test") ? "Testing access…" : "Saving changes…");
        host.action(action, submitted, new NativeVoiceRuntime.Reply() {
            public void done(JSONObject value) { activity.runOnUiThread(() -> {
                if (!dialog.isShowing()) return;
                if (!action.equals("test")) { dialog.dismiss(); return; }
                busy = false; save.setEnabled(true); test.setEnabled(true);
                remove.setEnabled(value.optJSONObject("speech") != null && value.optJSONObject("speech").optBoolean("credentialConfigured"));
                secret.setEnabled(true); status.setText("Connection succeeded. The model list is accessible.");
            }); }
            public void failed(String code, String message) { activity.runOnUiThread(() -> {
                if (!dialog.isShowing()) return;
                busy = false; save.setEnabled(true); test.setEnabled(true); remove.setEnabled(true); secret.setEnabled(true);
                // Runtime only supplies source-defined safe messages, never provider response bodies or secret values.
                status.setText(message);
                if (code.equals("connection_changed") || code.equals("settings_revision_conflict")) {
                    save.setEnabled(false); test.setEnabled(false); remove.setEnabled(false); secret.getText().clear(); secret.setEnabled(false);
                }
            }); }
        });
    }
}
