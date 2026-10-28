import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, ipcMain: {}, powerMonitor: {}, safeStorage: {}, session: {} }));
const { ElectronSpeech } = await import("../../packages/electron-speech/electron/dist/plugin.mjs");

class FakeWindow extends EventEmitter {
  constructor(url = "capacitor-electron://localhost/") {
    super(); this.visible = true; this.minimized = false; this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.getURL = () => url;
    this.webContents.setBackgroundThrottling = vi.fn();
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
}
function fixture() {
  const window = new FakeWindow();
  const windows = [window];
  const application = new EventEmitter(), monitor = new EventEmitter();
  const notifyListeners = vi.fn();
  const transport = { endpoint: "https://speech.example/v1", cancelAll: vi.fn(),
    configure: vi.fn(async ({ endpoint }) => { transport.endpoint = endpoint; return { endpoint, credentialConfigured: true }; }),
  };
  const dialogs = [];
  const dialogFactory = (input) => {
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const dialog = { input, result, resolve, reject, close: vi.fn() }; dialogs.push(dialog); return dialog;
  };
  const plugin = new ElectronSpeech({ notifyListeners }, { app: application, powerMonitor: monitor,
    BrowserWindow: { getAllWindows: () => windows }, transport, credentials: { status: async () => ({ credentialConfigured: true }) }, dialogFactory });
  return { plugin, transport, window, windows, application, monitor, dialogs, notifyListeners };
}

describe("Electron speech plugin lifecycle", () => {
  it("exposes only narrow methods and never exposes generic secret setters or getters", () => {
    expect(ElectronSpeech.__capacitorElectronPlugin.methods).toContain("openCredentialDialog");
    expect(ElectronSpeech.__capacitorElectronPlugin.methods).not.toEqual(expect.arrayContaining(["read", "save", "getCredential", "setCredential"]));
  });

  it("publishes native visibility and temporarily disables throttling only for the main app window", () => {
    const f = fixture();
    const credential = new FakeWindow("file:///credential-dialog.html");
    f.windows.push(credential); f.application.emit("browser-window-created", {}, credential);
    f.plugin.setAudioActive({ active: true });
    expect(f.window.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    expect(credential.webContents.setBackgroundThrottling).not.toHaveBeenCalled();
    f.window.minimized = true; f.window.emit("minimize");
    expect(f.plugin.getWindowState()).toEqual({ visible: false });
    expect(f.notifyListeners).toHaveBeenLastCalledWith("windowState", { visible: false });
    f.window.minimized = false; f.window.emit("restore");
    expect(f.plugin.getWindowState()).toEqual({ visible: true });
    credential.emit("closed");
    expect(f.transport.cancelAll).not.toHaveBeenCalled();
    f.plugin.setAudioActive({ active: false });
    expect(f.window.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it("cancels transport and restores throttling on suspend and renderer replacement", () => {
    const f = fixture();
    f.monitor.emit("suspend");
    expect(f.transport.cancelAll).toHaveBeenCalledOnce();
    expect(f.notifyListeners).toHaveBeenCalledWith("interrupted", { reason: "suspend" });
    f.window.webContents.emit("did-start-navigation", { isSameDocument: true, isMainFrame: true });
    expect(f.transport.cancelAll).toHaveBeenCalledOnce();
    f.window.webContents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: false });
    expect(f.transport.cancelAll).toHaveBeenCalledOnce();
    f.window.webContents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: true });
    expect(f.transport.cancelAll).toHaveBeenCalledTimes(2);
    expect(f.window.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it("fences an old endpoint's pending credential mutation from a replacement connection", async () => {
    const f = fixture();
    const opening = f.plugin.openCredentialDialog({ endpoint: f.transport.endpoint });
    const rejected = expect(opening).rejects.toMatchObject({ code: "speech_configuration_changed" });
    expect(f.dialogs).toHaveLength(1);
    await f.plugin.configure({ endpoint: "https://replacement.example/v1" });
    const cancellationCount = f.transport.cancelAll.mock.calls.length;
    expect(f.dialogs[0].close).toHaveBeenCalledOnce();
    f.dialogs[0].input.onChange();
    f.dialogs[0].resolve({ credentialConfigured: true });
    await rejected;
    expect(f.transport.cancelAll).toHaveBeenCalledTimes(cancellationCount);
    expect(f.transport.endpoint).toBe("https://replacement.example/v1");
  });

  it("fences a dialog after renderer reload even when the endpoint is unchanged", async () => {
    const f = fixture();
    const opening = f.plugin.openCredentialDialog({ endpoint: f.transport.endpoint });
    const rejected = expect(opening).rejects.toMatchObject({ code: "speech_configuration_changed" });
    f.window.webContents.emit("render-process-gone");
    const cancellations = f.transport.cancelAll.mock.calls.length;
    const next = f.plugin.openCredentialDialog({ endpoint: f.transport.endpoint });
    expect(f.dialogs).toHaveLength(2);
    f.dialogs[0].input.onChange(); f.dialogs[0].resolve({ credentialConfigured: true });
    await rejected;
    expect(f.transport.cancelAll).toHaveBeenCalledTimes(cancellations + 1);
    f.dialogs[1].resolve({ credentialConfigured: false });
    expect(await next).toEqual({ credentialConfigured: false });
  });
});
