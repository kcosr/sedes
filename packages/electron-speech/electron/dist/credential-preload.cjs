// This sandboxed preload is used only by the isolated file-origin token dialog.
// It exposes no API to the application renderer and loads no Capacitor bridge.
const { ipcRenderer } = require("electron");
const argument = process.argv.find((value) => value.startsWith("--sedes-speech-channel="));
const channel = argument?.slice("--sedes-speech-channel=".length);

window.addEventListener("DOMContentLoaded", async () => {
  const field = document.getElementById("token");
  const message = document.getElementById("message");
  const remove = document.getElementById("remove");
  const save = document.getElementById("save");
  let busy = false;
  const invoke = async (input) => {
    if (!channel || !/^sedes-speech-credential-[0-9a-f-]+$/u.test(channel)) throw new Error();
    const result = await ipcRenderer.invoke(channel, input);
    if (result?.error) throw new Error(result.error);
    return result;
  };
  async function change(action) {
    if (busy) return;
    busy = true; save.disabled = true; remove.disabled = true;
    const token = field.value;
    field.value = "";
    try { await invoke(action === "save" ? { action, token } : { action }); }
    catch (error) {
      message.textContent = error instanceof Error && error.message ? error.message : "The speech credential could not be changed.";
      busy = false; save.disabled = false;
      try { remove.disabled = !(await invoke({ action: "status" })).credentialConfigured; } catch { /* Keep removal disabled when status is unavailable. */ }
      field.focus();
    }
  }
  document.getElementById("token-form").addEventListener("submit", (event) => { event.preventDefault(); void change("save"); });
  remove.addEventListener("click", () => void change("remove"));
  document.getElementById("cancel").addEventListener("click", () => { field.value = ""; void invoke({ action: "cancel" }).catch(() => undefined); });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") { field.value = ""; void invoke({ action: "cancel" }).catch(() => undefined); } });
  try {
    const state = await invoke({ action: "status" });
    document.getElementById("endpoint").textContent = state.endpoint;
    remove.disabled = !state.credentialConfigured;
    message.textContent = state.credentialConfigured ? "A token is saved. Enter a new token to replace it." : "No token is saved for this endpoint.";
    field.focus();
  } catch {
    message.textContent = "The saved token is unavailable. You can replace or remove it; saving requires a working OS keyring.";
    // Removal needs no decryption. A replacement still has to pass native secure-storage checks.
    remove.disabled = false;
    field.focus();
  }
});
