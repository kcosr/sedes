import path from "node:path";
import { app, BrowserWindow, ipcMain, powerMonitor, safeStorage, session } from "electron";
import { SpeechCredentialStore } from "./credential-store.mjs";
import { showCredentialDialog } from "./credential-dialog.mjs";
import { object, providerBinding, speechError } from "./contracts.mjs";
import { SpeechTransport } from "./transport.mjs";

function isAppWindow(window) {
  try {
    const url = new URL(window.webContents.getURL());
    return !window.isDestroyed() && url.protocol === "capacitor-electron:" && url.hostname === "localhost" && !url.port && !url.username && !url.password;
  } catch { return false; }
}

class ElectronSpeechImpl {
  constructor(context, dependencies = {}) {
    this.app = dependencies.app ?? app;
    this.BrowserWindow = dependencies.BrowserWindow ?? BrowserWindow;
    this.notify = (event, data) => context.notifyListeners(event, data);
    this.credentials = dependencies.credentials ?? new SpeechCredentialStore({ directory: path.join(this.app.getPath("userData"), "speech-credentials"), storage: safeStorage });
    this.transport = dependencies.transport ?? new SpeechTransport({ credentials: this.credentials, notify: this.notify });
    this.dialogFactory = dependencies.dialogFactory ?? ((input) => showCredentialDialog({ ...input, BrowserWindow, session, ipcMain }));
    this.mainWindow = null;
    this.dialog = null;
    this.lifecycleGeneration = 0;
    const watch = (window) => {
      if (isAppWindow(window)) this.attachWindow(window);
      else window.webContents.once("did-finish-load", () => { if (isAppWindow(window)) this.attachWindow(window); });
    };
    for (const window of this.BrowserWindow.getAllWindows()) watch(window);
    this.app.on("browser-window-created", (_event, window) => watch(window));
    this.app.on("before-quit", () => { this.transport.cancelAll(); this.invalidateDialog(); });
    (dependencies.powerMonitor ?? powerMonitor).on("suspend", () => {
      this.transport.cancelAll();
      this.invalidateDialog();
      this.setAudioActive({ active: false });
      this.notify("interrupted", { reason: "suspend" });
    });
  }
  attachWindow(window) {
    if (this.mainWindow) return;
    this.mainWindow = window;
    const publish = () => this.notify("windowState", this.getWindowState());
    for (const event of ["show", "hide", "minimize", "restore"]) window.on(event, publish);
    const interrupted = () => {
      this.transport.cancelAll();
      this.setAudioActive({ active: false });
      this.invalidateDialog();
      this.notify("interrupted", { reason: "renderer_closed" });
    };
    window.webContents.on("render-process-gone", interrupted);
    // An application renderer reload destroys its in-memory recording ownership.
    window.webContents.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) interrupted(); });
    window.once("closed", () => { interrupted(); this.mainWindow = null; });
  }
  getWindowState() {
    if (!this.mainWindow) {
      const window = this.BrowserWindow.getAllWindows().find(isAppWindow);
      if (window) this.attachWindow(window);
    }
    return { visible: Boolean(this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isVisible() && !this.mainWindow.isMinimized()) };
  }
  setAudioActive(input) {
    object(input, ["active"]);
    if (typeof input.active !== "boolean") throw speechError("speech_input_invalid", "Audio activity must be a boolean.");
    this.getWindowState();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.webContents.setBackgroundThrottling(!input.active);
  }
  invalidateDialog() {
    this.lifecycleGeneration++;
    const dialog = this.dialog;
    this.dialog = null;
    dialog?.close();
  }
  configure(input) {
    object(input, ["provider", "endpoint"]);
    const binding = providerBinding(input);
    if (binding.provider !== this.transport.provider || binding.endpoint !== this.transport.endpoint) this.invalidateDialog();
    return this.transport.configure(binding);
  }
  getCredentialStatus(input) {
    object(input, ["provider", "endpoint"]);
    return this.credentials.status(providerBinding(input).endpoint);
  }
  async openCredentialDialog(input) {
    object(input, ["provider", "endpoint"]);
    const { provider, endpoint } = providerBinding(input);
    if (provider !== this.transport.provider || endpoint !== this.transport.endpoint)
      throw speechError("speech_configuration_changed", "The speech provider or endpoint changed. Reopen its credential dialog.");
    if (this.dialog) throw speechError("speech_credential_busy", "The speech credential dialog is already open.");
    this.getWindowState();
    if (!this.mainWindow || this.mainWindow.isDestroyed()) throw speechError("speech_credential_dialog_failed", "Open the Sedes application window before configuring speech.");
    this.transport.cancelAll();
    const generation = this.lifecycleGeneration;
    const dialog = this.dialogFactory({ provider, endpoint, parent: this.mainWindow, credentials: this.credentials, onChange: () => {
      if (generation === this.lifecycleGeneration && provider === this.transport.provider && endpoint === this.transport.endpoint) this.transport.cancelAll();
    } });
    this.dialog = dialog;
    try {
      const status = await dialog.result;
      if (generation !== this.lifecycleGeneration || provider !== this.transport.provider || endpoint !== this.transport.endpoint)
        throw speechError("speech_configuration_changed", "The speech connection changed while its credential dialog was open.");
      return status;
    }
    finally { if (this.dialog === dialog) this.dialog = null; }
  }
  getCapabilities(input) { return this.transport.getCapabilities(input); }
  startRecognition(input) { return this.transport.startRecognition(input); }
  appendAudio(input) { return this.transport.appendAudio(input); }
  commitRecognition(input) { return this.transport.commitRecognition(input); }
  speak(input) { return this.transport.speak(input); }
  acknowledgeAudio(input) { return this.transport.acknowledgeAudio(input); }
  cancel(input) { return this.transport.cancel(input); }
  cancelAll() { this.transport.cancelAll(); }
}

ElectronSpeechImpl.__capacitorElectronPlugin = {
  name: "ElectronSpeech",
  methods: ["configure", "getCredentialStatus", "openCredentialDialog", "getCapabilities", "startRecognition", "appendAudio",
    "commitRecognition", "speak", "acknowledgeAudio", "cancel", "cancelAll", "getWindowState", "setAudioActive"],
};

export { ElectronSpeechImpl as ElectronSpeech };
