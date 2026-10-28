import { mkdtemp, readdir, readFile, copyFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechCredentialStore } from "../../packages/electron-speech/electron/dist/credential-store.mjs";
import { showCredentialDialog } from "../../packages/electron-speech/electron/dist/credential-dialog.mjs";

const directories = [];
const endpoint = "https://speech.example/prefix/v1";
const token = "test-secret-not-for-renderer";
async function storeFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "electron-speech-credentials-"));
  directories.push(directory);
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5),
    decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString(),
  };
  return { directory, storage, store: new SpeechCredentialStore({ directory, storage, platform: "linux" }) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = { url: "" };
    this.webContents.setWindowOpenHandler = vi.fn();
  }
  setMenu = vi.fn();
  show = vi.fn();
  isDestroyed() { return this.destroyed; }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
  destroy() { this.close(); }
  async loadFile(filename) { this.webContents.mainFrame.url = pathToFileURL(filename).href; }
}
function dialogFixture(credentials, binding = { provider: "server", endpoint }) {
  const windows = [], handlers = new Map();
  const isolated = new EventEmitter();
  isolated.setPermissionCheckHandler = vi.fn();
  isolated.setPermissionRequestHandler = vi.fn();
  isolated.webRequest = { onBeforeRequest: vi.fn() };
  class Window extends FakeWindow { constructor(options) { super(options); windows.push(this); } }
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  const session = { fromPartition: vi.fn(() => isolated) };
  const onChange = vi.fn();
  const dialog = showCredentialDialog({ ...binding, parent: {}, credentials, BrowserWindow: Window, session, ipcMain, onChange });
  const window = windows[0];
  const invoke = (input, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }) => [...handlers.values()][0](event, input);
  return { dialog, window, handlers, invoke, isolated, session, onChange };
}

async function preloadFixture(provider, status = { credentialConfigured: false }) {
  const elements = new Map();
  const listeners = new Map();
  const document = { title: "", getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: "", disabled: false, value: "", focus: vi.fn(), addEventListener: vi.fn() });
    return elements.get(id);
  } };
  const invoke = vi.fn(async () => ({ provider, endpoint: provider === "openai" ? "https://api.openai.com/v1" : endpoint, ...status }));
  vm.runInNewContext(await readFile(new URL("../../packages/electron-speech/electron/dist/credential-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ ipcRenderer: { invoke } }), document,
    window: { addEventListener: (event, callback) => listeners.set(event, callback) },
    process: { argv: ["--sedes-speech-channel=sedes-speech-credential-1234abcd", `--sedes-speech-provider=${provider}`] },
  });
  await listeners.get("DOMContentLoaded")();
  return { document, elements, invoke };
}

describe("Electron speech credential storage", () => {
  it("encrypts endpoint-bound secrets, reports only availability and survives store re-creation", async () => {
    const { directory, storage, store } = await storeFixture();
    await store.save(endpoint, token);
    const [filename] = await readdir(directory);
    expect((await readFile(path.join(directory, filename))).includes(Buffer.from(token))).toBe(false);
    expect(await store.status(endpoint)).toEqual({ credentialConfigured: true });
    expect(await store.status("https://speech.example/other/v1")).toEqual({ credentialConfigured: false });
    const recreated = new SpeechCredentialStore({ directory, storage });
    expect(await recreated.read(`${endpoint}/`)).toBe(token);
    await recreated.remove(endpoint);
    expect(await store.status(endpoint)).toEqual({ credentialConfigured: false });
  });

  it("rejects encrypted records copied to another endpoint and never returns the secret in an error", async () => {
    const { store } = await storeFixture();
    const other = "https://other.example/v1";
    await store.save(endpoint, token);
    await copyFile(store.filename(endpoint), store.filename(other));
    const error = await store.read(other).catch((value) => value);
    expect(error.code).toBe("speech_credential_storage_unavailable");
    expect(error.message).not.toContain(token);
  });

  it("fails closed for missing OS encryption and Linux plaintext fallback", async () => {
    const { store, storage, directory } = await storeFixture();
    storage.getSelectedStorageBackend = () => "basic_text";
    await expect(store.save(endpoint, token)).rejects.toMatchObject({ code: "speech_credential_storage_unavailable" });
    storage.getSelectedStorageBackend = () => "gnome_libsecret";
    storage.isEncryptionAvailable = () => false;
    await expect(store.save(endpoint, token)).rejects.toMatchObject({ code: "speech_credential_storage_unavailable" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects malformed tokens and preserves an existing token when encryption fails", async () => {
    const { store, storage } = await storeFixture();
    await store.save(endpoint, token);
    for (const invalid of ["", "secret\r\nAuthorization: injected", "secret token", "x".repeat(5000)]) {
      await expect(store.save(endpoint, invalid)).rejects.toMatchObject({ code: "speech_credential_invalid" });
    }
    storage.encryptString = () => { throw new Error(token); };
    await expect(store.save(endpoint, "replacement")).rejects.toMatchObject({ code: "speech_credential_storage_unavailable" });
    expect(await store.read(endpoint)).toBe(token);
  });
});

describe("isolated speech credential dialog", () => {
  it("uses a private sandboxed session and only accepts its own exact file-origin main frame", async () => {
    const credentials = { status: vi.fn(async () => ({ credentialConfigured: false })), save: vi.fn(), remove: vi.fn() };
    const f = dialogFixture(credentials);
    expect(f.window.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false });
    expect(f.window.options.webPreferences.preload).toMatch(/credential-preload\.cjs$/u);
    expect(f.session.fromPartition.mock.calls[0][0]).not.toMatch(/^persist:/u);
    expect(f.isolated.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    expect(f.window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
    expect(await f.invoke({ action: "save", token }, { sender: {}, senderFrame: f.window.webContents.mainFrame })).toHaveProperty("error");
    expect(await f.invoke({ action: "save", token }, { sender: f.window.webContents, senderFrame: { url: f.window.webContents.mainFrame.url } })).toHaveProperty("error");
    expect(credentials.save).not.toHaveBeenCalled();
    expect(await f.invoke({ action: "status" })).toEqual({ provider: "server", endpoint, credentialConfigured: false });
    const callback = vi.fn();
    f.isolated.webRequest.onBeforeRequest.mock.calls[0][0]({ url: "https://attacker.invalid" }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
    await f.invoke({ action: "cancel" });
    expect(await f.dialog.result).toEqual({ credentialConfigured: false });
    expect(f.handlers.size).toBe(0);
  });

  it("binds an OpenAI API key to the fixed endpoint and keeps it out of the returned status", async () => {
    const { store } = await storeFixture();
    const binding = { provider: "openai", endpoint: "https://api.openai.com/v1" };
    const f = dialogFixture(store, binding);
    expect(f.window.options.title).toBe("OpenAI API key — Sedes");
    expect(f.window.options.webPreferences.additionalArguments).toContain("--sedes-speech-provider=openai");
    expect(await f.invoke({ action: "status" })).toEqual({ ...binding, credentialConfigured: false });
    expect(await f.invoke({ action: "save", token })).toEqual({});
    expect(await f.dialog.result).toEqual({ credentialConfigured: true });
    expect(await store.read(binding.endpoint)).toBe(token);
    expect(await store.read(endpoint)).toBeNull();
  });

  it.each([
    { endpoint },
    { provider: "openai", endpoint },
    { provider: "server", endpoint: "https://api.openai.com/v1" },
  ])("rejects an invalid provider binding before creating a dialog: %j", (binding) => {
    expect(() => dialogFixture({}, binding)).toThrow();
  });

  it("saves through the private handler and returns no token through dialog results", async () => {
    let saved = false;
    const credentials = { status: async () => ({ credentialConfigured: saved }), save: vi.fn(async () => { saved = true; }), remove: vi.fn() };
    const f = dialogFixture(credentials);
    expect(await f.invoke({ action: "save", token })).toEqual({});
    const result = await f.dialog.result;
    expect(credentials.save).toHaveBeenCalledWith(endpoint, token);
    expect(result).toEqual({ credentialConfigured: true });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(f.onChange).toHaveBeenCalledOnce();
  });

  it("waits for a pending write when the window closes and returns its final status", async () => {
    let saved = false, finish;
    const credentials = { status: async () => ({ credentialConfigured: saved }),
      save: vi.fn(() => new Promise((resolve) => { finish = () => { saved = true; resolve(); }; })), remove: vi.fn() };
    const f = dialogFixture(credentials);
    const save = f.invoke({ action: "save", token });
    f.window.close();
    let settled = false;
    const result = f.dialog.result.then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await save;
    expect(await result).toEqual({ credentialConfigured: true });
    expect(f.onChange).toHaveBeenCalledOnce();
  });

  it("returns current status when a pending write fails after the window closes", async () => {
    let fail;
    const credentials = { status: async () => ({ credentialConfigured: false }),
      save: () => new Promise((_resolve, reject) => { fail = reject; }), remove: vi.fn() };
    const f = dialogFixture(credentials);
    const save = f.invoke({ action: "save", token });
    f.window.close(); fail(new Error(token));
    expect(await save).toEqual({ error: expect.not.stringContaining(token) });
    expect(await f.dialog.result).toEqual({ credentialConfigured: false });
  });

  it("returns the saved credential status after an invalid replacement token and Cancel", async () => {
    const { store } = await storeFixture();
    await store.save(endpoint, token);
    const f = dialogFixture(store);
    expect(await f.invoke({ action: "save", token: "invalid token" })).toEqual({ error: "Enter a valid speech API key or server bearer token." });
    expect(f.window.isDestroyed()).toBe(false);
    expect(await f.invoke({ action: "cancel" })).toEqual({});
    expect(await f.dialog.result).toEqual({ credentialConfigured: true });
    expect(await store.read(endpoint)).toBe(token);
  });

  it("returns current status after a failed removal and window close", async () => {
    const credentials = { status: async () => ({ credentialConfigured: true }), save: vi.fn(),
      remove: vi.fn(async () => { throw new Error("removal failed"); }) };
    const f = dialogFixture(credentials);
    expect(await f.invoke({ action: "remove" })).toHaveProperty("error");
    f.window.close();
    expect(await f.dialog.result).toEqual({ credentialConfigured: true });
  });

  it("preserves a current status-read failure after a failed dialog action", async () => {
    const statusError = Object.assign(new Error("Current credential status is unavailable."), { code: "speech_credential_storage_unavailable" });
    const credentials = { status: vi.fn(async () => { throw statusError; }),
      save: vi.fn(async () => { throw new Error("old save failure"); }), remove: vi.fn() };
    const f = dialogFixture(credentials);
    expect(await f.invoke({ action: "save", token })).toHaveProperty("error");
    const result = expect(f.dialog.result).rejects.toMatchObject({ code: statusError.code, message: statusError.message });
    f.window.close();
    await result;
  });
});

describe("credential dialog labels", () => {
  it.each([
    ["openai", "OpenAI API key", "API key", "An API key"],
    ["server", "Speech server token", "Bearer token", "A token"],
  ])("identifies the %s credential without exposing its value", async (provider, title, label, savedMessage) => {
    const f = await preloadFixture(provider, { credentialConfigured: true });
    expect(f.document.title).toBe(`${title} — Sedes`);
    expect(f.elements.get("title").textContent).toBe(title);
    expect(f.elements.get("token-label").textContent).toBe(label);
    expect(f.elements.get("message").textContent).toContain(`${savedMessage} is saved.`);
    expect(f.elements.get("token").value).toBe("");
    expect(f.invoke).toHaveBeenCalledWith("sedes-speech-credential-1234abcd", { action: "status" });
  });

  it("still identifies OpenAI when the saved key cannot be read", async () => {
    const f = await preloadFixture("openai", { error: "Secure storage unavailable." });
    expect(f.elements.get("title").textContent).toBe("OpenAI API key");
    expect(f.elements.get("save").textContent).toBe("Save API key");
    expect(f.elements.get("message").textContent).toContain("The saved API key is unavailable.");
    expect(f.elements.get("remove").disabled).toBe(false);
  });

  it("does not invoke native credential access without a valid provider argument", async () => {
    const f = await preloadFixture("other");
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
